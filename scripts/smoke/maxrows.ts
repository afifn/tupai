// Verifies that maxRows is enforced by the server/driver instead of slicing an
// already-materialised result set. A large table makes the difference visible:
// the row count is exact, the extra row proves truncation, and the connection
// stays usable afterwards.
import { app } from 'electron'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DbWorkerClient } from '../../src/main/workers/dbWorkerClient'
import { saveConnection, getConnectionConfig } from '../../src/main/connection/store'
import type { ConnectionConfig } from '../../src/shared/types'

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`)
}

const ROWS = 200_000

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tupai-maxrows-'))
  app.setPath('userData', dir)
  process.env.TUPAI_USER_DATA = dir
  const client = new DbWorkerClient()
  const call = <T>(op: string, payload: unknown): Promise<T> => client.call<T>(op, payload)

  // ---------- PostgreSQL ----------
  const pg: ConnectionConfig = {
    id: 'maxrows-pg', name: 'maxrows pg', engine: 'postgres',
    host: '127.0.0.1', port: 5432, user: process.env.USER, database: 'postgres'
  }
  await saveConnection(pg)
  const pgCfg = await getConnectionConfig(pg.id)
  await call('connect', pgCfg)
  await call('runQuery', { connectionId: pg.id, sql: 'CREATE TEMP TABLE big (id int, v text)', maxRows: 1 })
  await call('runQuery', {
    connectionId: pg.id,
    sql: `INSERT INTO big SELECT g, 'row-' || g FROM generate_series(1, ${ROWS}) g`,
    maxRows: 1
  })
  const pgStart = Date.now()
  const pgRes = await call<{ rows: unknown[]; truncated: boolean; rowCount: number }[]>('runQuery', {
    connectionId: pg.id, sql: 'SELECT * FROM big', maxRows: 1000
  })
  const pgMs = Date.now() - pgStart
  check('postgres returns exactly maxRows', pgRes[0].rows.length === 1000, `${pgRes[0].rows.length} rows`)
  check('postgres flags truncation', pgRes[0].truncated === true)
  check('postgres stays fast on a large table', pgMs < 5000, `${pgMs} ms for ${ROWS} candidate rows`)
  const pgAfter = await call<{ rows: { n: string }[] }[]>('runQuery', {
    connectionId: pg.id, sql: 'SELECT COUNT(*) AS n FROM big', maxRows: 10
  })
  check('postgres connection still usable', pgAfter[0].rows[0].n === String(ROWS), pgAfter[0].rows[0].n)

  const pgSmall = await call<{ rows: unknown[]; truncated: boolean }[]>('runQuery', {
    connectionId: pg.id, sql: 'SELECT * FROM big WHERE id <= 7', maxRows: 1000
  })
  check('postgres exact result not truncated', pgSmall[0].rows.length === 7 && !pgSmall[0].truncated)

  const pgCommand = await call<{ kind: string; rowCount: number; command?: string }[]>('runQuery', {
    connectionId: pg.id, sql: 'UPDATE big SET v = v WHERE id <= 5', maxRows: 10
  })
  check('postgres command rowCount preserved', pgCommand[0].kind === 'command' && pgCommand[0].rowCount === 5, JSON.stringify(pgCommand[0]))

  const pgDdl = await call<{ kind: string }[]>('runQuery', {
    connectionId: pg.id, sql: 'CREATE TEMP TABLE after_stream (x int)', maxRows: 10
  })
  check('postgres DDL works through the cursor', pgDdl[0].kind === 'command')
  await call('disconnect', { connectionId: pg.id })

  // ---------- SQLite ----------
  const dbFile = join(dir, 'big.db')
  const Database = (await import('better-sqlite3')).default as unknown as new (
    path: string
  ) => { exec(sql: string): void; close(): void }
  const seed = new Database(dbFile)
  seed.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)')
  seed.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${ROWS}) INSERT INTO big (id, v) SELECT n, 'row-' || n FROM seq`)
  seed.close()

  const lite: ConnectionConfig = { id: 'maxrows-lite', name: 'maxrows lite', engine: 'sqlite', file: dbFile }
  await saveConnection(lite)
  await call('connect', await getConnectionConfig(lite.id))
  const liteStart = Date.now()
  const liteRes = await call<{ rows: unknown[]; truncated: boolean }[]>('runQuery', {
    connectionId: lite.id, sql: 'SELECT * FROM big', maxRows: 1000
  })
  const liteMs = Date.now() - liteStart
  check('sqlite returns exactly maxRows', liteRes[0].rows.length === 1000, `${liteRes[0].rows.length} rows`)
  check('sqlite flags truncation', liteRes[0].truncated === true)
  check('sqlite stays fast on a large table', liteMs < 5000, `${liteMs} ms for ${ROWS} candidate rows`)
  const liteAfter = await call<{ rows: { n: number }[] }[]>('runQuery', {
    connectionId: lite.id, sql: 'SELECT COUNT(*) AS n FROM big', maxRows: 10
  })
  check('sqlite connection still usable', liteAfter[0].rows[0].n === ROWS, String(liteAfter[0].rows[0].n))
  await call('disconnect', { connectionId: lite.id })

  await client.terminate()
  await rm(dir, { recursive: true, force: true })
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) for (const f of failed) console.log(` - ${f.name}${f.detail ? ` | ${f.detail}` : ''}`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('SMOKE ERROR', err)
    app.exit(1)
  })
})
