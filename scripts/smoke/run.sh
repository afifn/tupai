#!/usr/bin/env bash
# Builds and runs the database smoke tests against a real local server.
#
#   scripts/smoke/run.sh postgres   # needs a reachable PostgreSQL
#   scripts/smoke/run.sh mysql      # starts a throwaway server on port 33061
#   scripts/smoke/run.sh sqlite     # no server needed
#   scripts/smoke/run.sh sync       # structure/data sync + profiles (SQLite)
#   scripts/smoke/run.sh app        # drives the packaged .app over CDP
#   scripts/smoke/run.sh p1         # row limits, bulk delete, chunked insert,
#                                   # streaming import/restore, client cache
#   scripts/smoke/run.sh p2-cancel  # cancel a long statement
#   scripts/smoke/run.sh p2-ssh     # strict SSH host key mode
#   scripts/smoke/run.sh p2-ai      # streaming assistant (local SSE server)
#   scripts/smoke/run.sh p2-ui      # unsaved-tab guard, in-app dialogs
#   scripts/smoke/run.sh p2-preview # assistant row preview against SQLite
#   scripts/smoke/run.sh menu       # native application menu items reach the UI
#   scripts/smoke/run.sh worker     # the db worker loads as ESM outside the project
#   scripts/smoke/run.sh p2-tx      # manual transactions through the real UI
#   scripts/smoke/run.sh atomic     # atomic store writes
#   scripts/smoke/run.sh p1-app     # p1 limits through the packaged app
#   scripts/smoke/run.sh provision  # create user/database/tables/seed data
#
# All temporary data (MySQL datadir, Electron profiles, logs) is created under
# .smoke/ inside this project instead of the system temp directory. The project
# lives on an external SSD, so a stray MySQL datadir cannot fill the internal
# disk. Node's os.tmpdir() honours TMPDIR, so the bundled test scripts inherit
# the same location.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

TARGET="${1:-sqlite}"
SMOKE_DIR="$ROOT/.smoke"
RUN_DIR="$SMOKE_DIR/tmp"
LOG_DIR="$SMOKE_DIR/logs"
mkdir -p "$RUN_DIR" "$LOG_DIR"
export TMPDIR="$RUN_DIR"
export TMP="$RUN_DIR"
export TEMP="$RUN_DIR"

BUNDLE="out/main/smoke-${TARGET}.mjs"

build() {
  npx esbuild "scripts/smoke/${TARGET}.ts" \
    --bundle --platform=node --format=esm \
    --external:electron --external:better-sqlite3 --external:oracledb \
    --external:mysql2 --external:pg --external:pg-cursor --external:mongodb \
    --external:ssh2 --external:sql-formatter \
    --external:electron-updater --external:builder-util-runtime --external:lazy-val \
    --alias:@shared="$PWD/src/shared" \
    --outfile="$BUNDLE" --log-level=error
}

# Every process this script starts is recorded here so the exit trap can stop
# it even when the script is interrupted.
PIDS=()
MYSQL_PID=""
APP_PID=""
AI_PID=""
RUN_TMPD=""

cleanup() {
  local code=$?
  # A trap runs on INT/TERM too; stopping children first keeps the ports free
  # for the next run.
  if [ -n "$MYSQL_PID" ] && kill -0 "$MYSQL_PID" 2>/dev/null; then
    kill -TERM "$MYSQL_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$MYSQL_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL "$MYSQL_PID" 2>/dev/null || true
  fi
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null || true
  done
  # `npx electron` is a node wrapper that spawns the real Electron process, and
  # Electron spawns helpers. Killing the wrapper leaves those alive holding the
  # DevTools port, so match every process started with this run's profile.
  pkill -TERM -f "user-data-dir=$RUN_DIR" 2>/dev/null || true
  sleep 1
  pkill -KILL -f "user-data-dir=$RUN_DIR" 2>/dev/null || true
  [ -n "$RUN_TMPD" ] && rm -rf "$RUN_TMPD"
  # Remove leftover datadirs from earlier interrupted runs. Logs are kept.
  find "$RUN_DIR" -maxdepth 1 -mindepth 1 -exec rm -rf {} + 2>/dev/null || true
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Kills mysqld processes that were started by an earlier smoke run and never
# stopped (the old script only cleaned up on a normal exit, so an interrupted
# run left the server and its datadir behind).
reap_orphans() {
  local pids
  # grep exits 1 when nothing matches; with `set -e` that would abort the whole
  # script on the normal case of "no orphans".
  pids="$(ps -Ao pid=,command= | grep -F "mysqld --datadir=$RUN_DIR" | grep -v grep | awk '{print $1}' || true)"
  if [ -n "$pids" ]; then
    echo "Stopping orphaned smoke MySQL instances: $pids" >&2
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    sleep 3
    # shellcheck disable=SC2086
    kill -KILL $pids 2>/dev/null || true
  fi

  # Same for apps: an interrupted run can leave Electron alive with its helpers,
  # and it keeps the fixed DevTools port busy for every later run.
  local apps
  apps="$(ps -Ao pid=,command= | grep -F "user-data-dir=$RUN_DIR" | grep -v grep | awk '{print $1}' || true)"
  if [ -n "$apps" ]; then
    echo "Stopping orphaned smoke app instances: $apps" >&2
    # shellcheck disable=SC2086
    kill -TERM $apps 2>/dev/null || true
    sleep 2
    # shellcheck disable=SC2086
    kill -KILL $apps 2>/dev/null || true
  fi
}
reap_orphans

# A port still held after reaping means something outside this script owns it.
port_busy() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

require_port_free() {
  if port_busy "$1"; then
    echo "Port $1 is already in use, so the test would attach to another process." >&2
    echo "Owner:" >&2
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >&2 || true
    echo "Stop it (kill <pid>) and rerun." >&2
    exit 1
  fi
}

case "$TARGET" in
  postgres|sqlite|sync|p1|p2-cancel|p2-ssh|atomic)
    build
    npx electron "$BUNDLE"
    ;;
  mysql)
    if port_busy 33061; then
      echo "Port 33061 is already in use by a process this script does not own." >&2
      echo "Stop it first, then rerun. See: lsof -nP -iTCP:33061 -sTCP:LISTEN" >&2
      exit 1
    fi
    RUN_TMPD="$(mktemp -d "$RUN_DIR/mysql-XXXXXX")"
    mysqld --initialize-insecure --datadir="$RUN_TMPD/data" --user="$(whoami)" \
      >"$LOG_DIR/mysql-init.log" 2>&1
    mysqld --datadir="$RUN_TMPD/data" --port=33061 --socket="$RUN_TMPD/mysql.sock" \
      --pid-file="$RUN_TMPD/mysqld.pid" --mysqlx=OFF --user="$(whoami)" \
      >"$LOG_DIR/mysql-server.log" 2>&1 &
    MYSQL_PID=$!
    disown "$MYSQL_PID" 2>/dev/null || true
    for _ in $(seq 1 40); do
      mysqladmin --protocol=tcp -h 127.0.0.1 -P 33061 -u root ping >/dev/null 2>&1 && break
      sleep 1
    done
    if ! mysqladmin --protocol=tcp -h 127.0.0.1 -P 33061 -u root ping >/dev/null 2>&1; then
      echo "MySQL did not start. See $LOG_DIR/mysql-server.log" >&2
      exit 1
    fi
    build
    npx electron "$BUNDLE"
    ;;
  p2-ai)
    # Starts the local OpenAI-compatible SSE server the test talks to.
    node scripts/smoke/fake-ai-server.mjs >"$LOG_DIR/fake-ai.log" 2>&1 &
    AI_PID=$!
    PIDS+=("$AI_PID")
    disown "$AI_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      curl -sf http://127.0.0.1:8799/v1/models >/dev/null 2>&1 && break
      sleep 0.3
    done
    build
    npx electron "$BUNDLE"
    ;;
  app)
    APP="${2:-release/mac-arm64/Tupai.app}"
    PROFILE="$(mktemp -d "$RUN_DIR/profile-XXXXXX")"
    require_port_free 9333
    "$APP/Contents/MacOS/Tupai" --user-data-dir="$PROFILE" --remote-debugging-port=9333 \
      >"$LOG_DIR/app.log" 2>&1 &
    APP_PID=$!
    PIDS+=("$APP_PID")
    disown "$APP_PID" 2>/dev/null || true
    node scripts/smoke/cdp.mjs
    ;;
  p1-app)
    APP="${2:-release/mac-arm64/Tupai.app}"
    PORT=9337
    require_port_free "$PORT"
    "$APP/Contents/MacOS/Tupai" --remote-debugging-port=$PORT >"$LOG_DIR/p1-app.log" 2>&1 &
    APP_PID=$!
    PIDS+=("$APP_PID")
    disown "$APP_PID" 2>/dev/null || true
    node scripts/smoke/p1-app.mjs
    ;;
  p2-preview)
    # Assistant row preview: real SQLite file, real worker, local fake AI server.
    node scripts/smoke/fake-ai-server.mjs >"$LOG_DIR/fake-ai.log" 2>&1 &
    AI_PID=$!
    PIDS+=("$AI_PID")
    disown "$AI_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      curl -sf http://127.0.0.1:8799/v1/models >/dev/null 2>&1 && break
      sleep 0.3
    done
    # No build() here: this check is plain JS and runs against the app bundle,
    # not through esbuild like the .ts smoke files.
    npm run build >/dev/null 2>&1
    PORT=9340
    require_port_free "$PORT"
    PROFILE="$(mktemp -d "$RUN_DIR/profile-XXXXXX")"
    PREVIEW_DB="$RUN_DIR/preview.db"
    : >"$PREVIEW_DB"
    # The connection has to exist before the app mounts: the sidebar only reads
    # connections.json on load, and its reload button refreshes the tree, not
    # the connection list.
    PREVIEW_DB="$PREVIEW_DB" node -e '
      const { writeFileSync } = require("fs")
      writeFileSync(process.argv[1], JSON.stringify([{
        id: "smoke-preview",
        name: "Smoke Preview",
        engine: "sqlite",
        file: process.env.PREVIEW_DB
      }]))
    ' "$PROFILE/connections.json"
    npx electron . --user-data-dir="$PROFILE" --remote-debugging-port=$PORT \
      >"$LOG_DIR/p2-preview.log" 2>&1 &
    APP_PID=$!
    PIDS+=("$APP_PID")
    disown "$APP_PID" 2>/dev/null || true
    PREVIEW_DB="$PREVIEW_DB" PORT=$PORT node scripts/smoke/p2-preview.mjs
    ;;
  p2-tx)
    # Manual transactions through the real UI. Needs a local PostgreSQL and the
    # fixture table the runner creates below.
    npm run build >/dev/null 2>&1
    PORT=9392
    require_port_free "$PORT"
    PROFILE="$(mktemp -d "$RUN_DIR/profile-XXXXXX")"
    printf '[{"id":"tx-smoke","name":"Tx Smoke","engine":"postgres","host":"127.0.0.1","port":5432,"user":"%s","database":"postgres"}]' "$USER" >"$PROFILE/connections.json"
    psql -h 127.0.0.1 -d postgres -q -c 'DROP TABLE IF EXISTS tx_smoke_notes' >/dev/null 2>&1 || true
    psql -h 127.0.0.1 -d postgres -q -c 'CREATE TABLE tx_smoke_notes (id serial primary key, body text)' >/dev/null
    npx electron . --user-data-dir="$PROFILE" --remote-debugging-port=$PORT \
      >"$LOG_DIR/p2-tx.log" 2>&1 &
    APP_PID=$!
    PIDS+=("$APP_PID")
    disown "$APP_PID" 2>/dev/null || true
    PORT=$PORT node scripts/smoke/p2-tx.mjs
    psql -h 127.0.0.1 -d postgres -q -c 'DROP TABLE IF EXISTS tx_smoke_notes' >/dev/null 2>&1 || true
    ;;
  worker)
    # Spawns the built worker from outside the project, under Electron's own Node
    # (20.x), because that is what decides the module type in the packaged app.
    # Node 22 detects ES module syntax on its own and would hide the bug.
    npm run build >/dev/null 2>&1
    ELECTRON_RUN_AS_NODE=1 npx electron scripts/smoke/worker-esm.mjs
    ;;
  menu)
    # The native menu lives in main, so this check builds the real window and
    # clicks menu items, then reads the DOM. It needs the app bundle too, not
    # just the compiled test script.
    npm run build >/dev/null 2>&1
    build
    npx electron "$BUNDLE"
    ;;
  p2-ui)
    # Runs the built out/ bundle through electron instead of the packaged .app,
    # so UI changes can be verified before a dmg is built. Needs a real saved
    # connection, so the user profile is copied into a temp directory.
    npm run build >/dev/null 2>&1
    PORT=9338
    require_port_free "$PORT"
    PROFILE="$(mktemp -d "$RUN_DIR/profile-XXXXXX")"
    cp "$HOME/Library/Application Support/Tupai/connections.json" "$PROFILE/connections.json" 2>/dev/null || true
    npx electron . --user-data-dir="$PROFILE" --remote-debugging-port=$PORT \
      >"$LOG_DIR/p2-ui.log" 2>&1 &
    APP_PID=$!
    PIDS+=("$APP_PID")
    disown "$APP_PID" 2>/dev/null || true
    node scripts/smoke/p2-ui.mjs
    ;;
  provision)
    # Needs the real saved connections (Local MySql / Local Postgre) and a
    # debugging port, so it reuses the user profile instead of a temp one.
    APP="${2:-release/mac-arm64/Tupai.app}"
    PORT=9336
    require_port_free "$PORT"
    "$APP/Contents/MacOS/Tupai" --remote-debugging-port=$PORT >"$LOG_DIR/provision.log" 2>&1 &
    APP_PID=$!
    PIDS+=("$APP_PID")
    disown "$APP_PID" 2>/dev/null || true
    node scripts/smoke/provision.mjs
    ;;
  *)
    echo "unknown target: $TARGET" >&2
    exit 1
    ;;
esac
