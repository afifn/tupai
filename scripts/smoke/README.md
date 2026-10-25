# Smoke tests

Checks that exercise the real driver, IPC, and worker code against real
databases. These are not unit tests: each one opens a connection, runs the
operations a user would, and compares the result.

```
npm run smoke:sqlite     # no server needed
npm run smoke:postgres   # needs a reachable PostgreSQL (127.0.0.1:5432)
npm run smoke:mysql      # starts a throwaway MySQL on port 33061
npm run smoke:app        # drives the packaged .app over CDP
npm run smoke:provision  # creates a user, database, tables, and seed data
npm run smoke:p1         # row limits, bulk delete, chunked insert, streaming
npm run smoke:p1-app     # the same limits through the packaged app's IPC
npm run smoke:p2         # query cancellation against a real server
npm run smoke:p2-ssh     # strict host key mode (needs github.com:22)
npm run smoke:p2-ai      # streaming assistant via a local SSE server
npm run smoke:p2-ui      # unsaved-tab guard and in-app confirmations
npm run smoke:p2-preview # assistant row preview against a real SQLite file
npm run smoke:menu      # native menu items reach the UI and follow the keymap
npm run smoke:worker    # the db worker loads as an ES module outside the project
npm run smoke:p2-tx     # manual transactions: commit, rollback, close guard
npm run smoke:atomic     # store writes are atomic and keep a backup
```

All temporary data lives under `.smoke/` inside the project (git-ignored), not in
the system temp directory:

```
.smoke/tmp/     MySQL datadir and Electron profiles, removed after each run
.smoke/logs/    MySQL init/server, fake AI server, and app logs, kept for debugging
```

The project usually lives on an external SSD, so a stray MySQL datadir cannot
fill the internal disk. `TMPDIR` is exported to `.smoke/tmp`, which also makes
Node's `os.tmpdir()` (used by the bundled test scripts) resolve there.

Every process the script starts is stopped by an exit trap that also fires on
INT/TERM/HUP, so interrupting a run does not leave a server behind. At startup
the script also reaps any `mysqld` left by an earlier interrupted run, and it
refuses to start if port 33061 is held by a process it does not own.

The app-driven suites (`app`, `p1-app`, `p2-ui`, `provision`) connect over a
fixed DevTools port. `npx electron` is a wrapper around the real Electron
process, which in turn starts helper processes, so stopping only the wrapper
leaves the app running and the port busy. Cleanup therefore also stops every
process started with the run's profile directory, and startup reaps apps left by
an earlier interrupted run. If the port is still held by something else, the
script stops and prints the owning PID instead of attaching to the wrong window.

PostgreSQL uses the `$USER` from the environment and connects to `postgres`
with no password, matching a default Homebrew install. Each run creates
uniquely named databases (`tupai_smoke_*_<timestamp>`) and removes them at the
end, so an interrupted run never blocks the next one.

`smoke:app` expects `release/mac-arm64/Tupai.app`; pass another path as the
second argument to `scripts/smoke/run.sh app <path>`.

What they cover:

| Script          | Coverage                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres.ts`   | schema/column/PK metadata, paging, filters, row CRUD, EXPLAIN, export SQL literals (backslash, apostrophe, boolean, numeric, timestamptz, jsonb, bytea), export -> restore equality, headerless CSV, dump/backup across schemas, DDL routing, search_path reset |
| `mysql.ts`      | same surface plus `AUTO_INCREMENT`, `listTableStats`, `searchObjects`, `listSessions`, `listUsers`, `listRoutines`, rename, truncate, system databases visible                                                                                                  |
| `sqlite.ts`     | literal values, blob, AUTOINCREMENT detection, backup/restore to a second file, DELETE-based truncate, clear rejection of user management                                                                                                                       |
| `cdp.mjs`       | packaged app: renderer mount, preload bridge, Cmd glyph labels, real IPC chain, structured errors, no uncaught renderer errors                                                                                                                                  |
| `p1.ts`         | `maxRows` enforced by the driver (200k candidate rows), transactional bulk delete with rollback, chunked multi-row insert, streaming CSV parse/import/preview, streaming restore boundary, and the Postgres client cache limit                                  |
| `p1-app.mjs`    | packaged app: `maxRows` through IPC, bulk delete over IPC, index listing, and no renderer errors                                                                                                                                                                |
| `p2-cancel.ts`  | cancel a 30 s statement in under a second, keep the connection usable, report unsupported engines honestly                                                                                                                                                      |
| `p2-ssh.ts`     | strict mode refuses unknown hosts, TOFU records them, a changed fingerprint is blocked                                                                                                                                                                          |
| `p2-ai.ts`      | streamed deltas, cancel keeps partial text, no false timeout                                                                                                                                                                                                    |
| `p2-ui.mjs`     | sidebar connect, unsaved marker, close confirmation with cancel/discard, no native dialogs                                                                                                                                                                      |
| `atomic.ts`     | atomic JSON writes, failed write keeps old content, backup file                                                                                                                                                                                                 |
| `provision.mjs` | creates a login role, a database, two related tables, a foreign key, and seed rows on PostgreSQL and MySQL through the app's own IPC; then grants privileges and checks the grant is visible                                                                    |

`provision.mjs` uses the saved connections from your real profile (names
`Local MySql` and `Local Postgre`). It drops and recreates `tupai_demo` and
`tupai_demo_user` on both engines (the password is defined once at the top of
`provision.mjs`), so it is safe to re-run and must not be
pointed at a database you care about. Verify the
result independently with:

```
PGPASSWORD='<fixture password>' psql -h 127.0.0.1 -U tupai_demo_user -d tupai_demo \
  -c 'select count(*) from public.products'
mysql -h 127.0.0.1 -u tupai_demo_user -p'<fixture password>' \
  -e 'select count(*) from tupai_demo.orders'
```

The scripts are bundled with esbuild on demand (see `run.sh`), so there is no
extra test dependency in `package.json`.
