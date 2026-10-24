// P2 checks that need a real server: cancelling a long statement must stop it
// without closing the connection, and the cancel must not affect the next query.
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

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tupai-p2-'))
  app.setPath('userData', dir)
  process.env.TUPAI_USER_DATA = dir
  const client = new DbWorkerClient()
  const call = <T>(op: string, payload: unknown): Promise<T> => client.call<T>(op, payload)

  // ---------- PostgreSQL ----------
  const pg: ConnectionConfig = {
    id: 'p2-pg', name: 'p2 pg', engine: 'postgres',
    host: '127.0.0.1', port: 5432, user: process.env.USER, database: 'postgres'
  }
  await saveConnection(pg)
  await call('connect', await getConnectionConfig(pg.id))

  // The rejection is captured immediately: awaiting the cancel first would let
  // the cancelled query's rejection escape as an unhandled rejection.
  let pgError = ''
  const pgQuery = call<unknown[]>('runQuery', {
    connectionId: pg.id,
    sql: 'SELECT pg_sleep(30)',
    maxRows: 10
  }).catch((err: unknown) => {
    // The worker rejects with a plain DbErrorShape, not an Error instance.
    const shape = err as { message?: string }
    pgError = err instanceof Error ? err.message : (shape?.message ?? String(err))
    return []
  })
  // Give the statement time to start before cancelling it.
  await new Promise((resolve) => setTimeout(resolve, 700))
  const pgStart = Date.now()
  const pgCancelled = await call<boolean>('cancelQuery', { connectionId: pg.id })
  await pgQuery
  const pgMs = Date.now() - pgStart
  check('pg cancel reports success', pgCancelled === true)
  check('pg cancel stops the statement early', pgMs < 5000, `${pgMs} ms (query was 30 s)`)
  check(
    'pg cancel surfaces a cancellation error',
    /cancel/i.test(pgError),
    pgError.slice(0, 70)
  )
  const pgAfter = await call<{ rows: { ok: number }[] }[]>('runQuery', {
    connectionId: pg.id, sql: 'SELECT 1 AS ok', maxRows: 5
  })
  check('pg connection usable after cancel', pgAfter[0].rows[0].ok === 1)
  const pgIdleCancel = await call<boolean>('cancelQuery', { connectionId: pg.id })
  check('pg cancel with nothing running returns false', pgIdleCancel === false)
  await call('disconnect', { connectionId: pg.id })

  // ---------- SQLite ----------
  const dbFile = join(dir, 'p2.db')
  const Database = (await import('better-sqlite3')).default as unknown as new (
    path: string
  ) => { exec(sql: string): void; close(): void }
  const seed = new Database(dbFile)
  seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
  seed.close()
  const lite: ConnectionConfig = { id: 'p2-lite', name: 'p2 lite', engine: 'sqlite', file: dbFile }
  await saveConnection(lite)
  await call('connect', await getConnectionConfig(lite.id))
  const liteCancel = await call<boolean>('cancelQuery', { connectionId: lite.id })
  check('sqlite reports cancel as unsupported', liteCancel === false)
  const liteStillWorks = await call<{ rows: { n: number }[] }[]>('runQuery', {
    connectionId: lite.id, sql: 'SELECT COUNT(*) AS n FROM t', maxRows: 5
  })
  check('sqlite still usable after a refused cancel', liteStillWorks[0].rows[0].n === 0)
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
