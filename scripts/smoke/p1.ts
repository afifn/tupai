// P1 checks: server-side row limits, transactional bulk delete, chunked multi
// row inserts, and the Postgres client cache limit.
import { app } from 'electron'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DbWorkerClient } from '../../src/main/workers/dbWorkerClient'
import { saveConnection, getConnectionConfig } from '../../src/main/connection/store'
import { chunkRows } from '../../src/shared/insertChunks'
import { CsvRowParser, parseCsv } from '../../src/main/io/csv'
import { lastSafeStatementBoundary } from '../../src/shared/sqlBoundary'
import { importCsv, previewImport } from '../../src/main/io/handlers'
import { backupDatabase, restoreDatabase } from '../../src/main/io/backup'
import type { ConnectionConfig } from '../../src/shared/types'

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`)
}

const BIG = 200_000

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tupai-p1-'))
  app.setPath('userData', dir)
  process.env.TUPAI_USER_DATA = dir
  const client = new DbWorkerClient()
  const call = <T>(op: string, payload: unknown): Promise<T> => client.call<T>(op, payload)

  // ---------- chunkRows (pure) ----------
  // 20k tiny rows exceed the 512 KB budget, so the batch must be split.
  const narrow = chunkRows(Array.from({ length: 20000 }, (_, i) => ({ id: i })), 1)
  check('chunkRows splits large batches', narrow.length > 1 && narrow.every((c) => c.length > 0), `${narrow.length} chunks`)
  const wide = chunkRows(Array.from({ length: 100 }, () => ({ a: 'x'.repeat(5000), b: 'y' })), 2)
  check('chunkRows respects payload size', wide.length > 1, `${wide.length} chunks for wide rows`)
  check('chunkRows keeps every row', narrow.reduce((n, c) => n + c.length, 0) === 20000)
  check('chunkRows handles empty input', chunkRows([], 3).length === 0)

  // ---------- streaming CSV parser ----------
  // The streaming parser must agree with the whole-file parser at every chunk
  // size, including a quote or newline split across two chunks.
  const csvCases = [
    'a,b\n1,2\n3,4\n',
    'a,b\n"x,y",2\n"he said ""hi""",4\n',
    'a,b\n"line1\nline2",2\n',
    'a,b\r\n1,2\r\n',
    'a,b\n1,2',
    'a,b\n"multi\nline, comma",2\n',
    'a,b\n"",2\n',
    'a,b\n,2\n',
    'single\nvalue\n'
  ]
  let csvMismatch = 0
  for (const text of csvCases) {
    const whole = parseCsv(text, ',')
    const expected = JSON.stringify([whole.headers, ...whole.rows])
    for (const size of [1, 2, 3, 7, 1000]) {
      const parser = new CsvRowParser(',')
      const got: string[][] = []
      for (let i = 0; i < text.length; i += size) got.push(...parser.push(text.slice(i, i + size)))
      got.push(...parser.end())
      if (JSON.stringify(got) !== expected) csvMismatch += 1
    }
  }
  check(
    'streaming CSV parser matches the whole-file parser',
    csvMismatch === 0,
    `${csvCases.length} inputs x 5 chunk sizes`
  )

  // ---------- restore chunk boundary ----------
  const boundaryCases: [string, number][] = [
    ["INSERT INTO t VALUES ('a;b');\n", 29],
    ["SELECT ';'; SELECT 2;\n", 21],
    ["SELECT 1; -- comment ; not a terminator\n", 9],
    ["SELECT 'it''s; fine';\n", 21]
  ]
  let boundaryMismatch = 0
  for (const [sql, expected] of boundaryCases) {
    const got = lastSafeStatementBoundary(sql)
    if (got !== expected) {
      boundaryMismatch += 1
      console.log(`  boundary mismatch for ${JSON.stringify(sql)}: got ${got}, expected ${expected}`)
    }
  }
  check(
    'restore boundary ignores quotes and comments',
    boundaryMismatch === 0,
    `${boundaryCases.length} cases`
  )

  // ---------- PostgreSQL ----------
  const pg: ConnectionConfig = {
    id: 'p1-pg', name: 'p1 pg', engine: 'postgres',
    host: '127.0.0.1', port: 5432, user: process.env.USER, database: 'postgres'
  }
  await saveConnection(pg)
  await call('connect', await getConnectionConfig(pg.id))

  await call('runQuery', { connectionId: pg.id, sql: 'CREATE TEMP TABLE p1_rows (id int primary key, v text, n numeric)', maxRows: 1 })
  await call('runQuery', {
    connectionId: pg.id,
    sql: `INSERT INTO p1_rows SELECT g, 'row-' || g, g * 1.5 FROM generate_series(1, ${BIG}) g`,
    maxRows: 1
  })

  const pgStart = Date.now()
  const pgLimit = await call<{ rows: unknown[]; truncated: boolean }[]>('runQuery', {
    connectionId: pg.id, sql: 'SELECT * FROM p1_rows', maxRows: 500
  })
  const pgMs = Date.now() - pgStart
  check('pg maxRows exact', pgLimit[0].rows.length === 500, `${pgLimit[0].rows.length}`)
  check('pg truncation flagged', pgLimit[0].truncated)
  check('pg limit is cheap', pgMs < 3000, `${pgMs} ms over ${BIG} candidates`)

  // Bulk delete in one transaction.
  const pks = Array.from({ length: 300 }, (_, i) => ({ id: i + 1 }))
  const delStart = Date.now()
  const deleted = await call<number>('deleteRows', {
    dels: pks.map((primaryKeys) => ({
      connectionId: pg.id, database: 'postgres', table: 'p1_rows', primaryKeys
    }))
  })
  const delMs = Date.now() - delStart
  check('pg bulk delete count', deleted === 300, `${deleted} rows in ${delMs} ms`)
  const pgRemaining = await call<{ rows: { n: string }[] }[]>('runQuery', {
    connectionId: pg.id, sql: 'SELECT COUNT(*) AS n FROM p1_rows', maxRows: 5
  })
  check('pg bulk delete applied atomically', pgRemaining[0].rows[0].n === String(BIG - 300), pgRemaining[0].rows[0].n)

  // A failing row rolls the whole batch back.
  const before = await call<{ rows: { n: string }[] }[]>('runQuery', {
    connectionId: pg.id, sql: 'SELECT COUNT(*) AS n FROM p1_rows', maxRows: 5
  })
  let rollbackError = ''
  try {
    await call('deleteRows', {
      dels: [
        { connectionId: pg.id, database: 'postgres', table: 'p1_rows', primaryKeys: { id: 1000 } },
        { connectionId: pg.id, database: 'postgres', table: 'no_such_table', primaryKeys: { id: 1 } }
      ]
    })
  } catch (err) {
    rollbackError = err instanceof Error ? err.message : String(err)
  }
  const after = await call<{ rows: { n: string }[] }[]>('runQuery', {
    connectionId: pg.id, sql: 'SELECT COUNT(*) AS n FROM p1_rows', maxRows: 5
  })
  check('pg failed batch rolls back', rollbackError.length > 0 && after[0].rows[0].n === before[0].rows[0].n, `${before[0].rows[0].n} -> ${after[0].rows[0].n}`)

  // Chunked insert of a batch that would be one huge statement otherwise.
  await call('runQuery', { connectionId: pg.id, sql: 'CREATE TEMP TABLE p1_ins (id int, v text)', maxRows: 1 })
  const wideRows = Array.from({ length: 4000 }, (_, i) => ({ id: i, v: 'z'.repeat(400) }))
  const insStart = Date.now()
  const inserted = await call<number>('insertRows', {
    connectionId: pg.id, database: 'postgres', schema: undefined, table: 'p1_ins', rows: wideRows
  })
  const insMs = Date.now() - insStart
  check('pg chunked insert count', inserted === wideRows.length, `${inserted} rows in ${insMs} ms`)
  const insCount = await call<{ rows: { n: string }[] }[]>('runQuery', {
    connectionId: pg.id, sql: 'SELECT COUNT(*) AS n FROM p1_ins', maxRows: 5
  })
  check('pg chunked insert stored', insCount[0].rows[0].n === String(wideRows.length), insCount[0].rows[0].n)

  // Streaming import: a 50k-row CSV must import without loading the whole file.
  await call('runQuery', {
    connectionId: pg.id,
    sql: 'CREATE TEMP TABLE p1_csv (id int, label text)',
    maxRows: 1
  })
  const csvPath = join(dir, 'bulk.csv')
  const csvRows = ['id,label']
  for (let i = 0; i < 50_000; i++) {
    csvRows.push(`${i},"label, with comma ${i}"`)
  }
  await writeFile(csvPath, csvRows.join('\n') + '\n', 'utf-8')
  const preview = await previewImport(csvPath, ',', true, 5)
  check('preview reads only the sample', preview.rows.length === 5, `${preview.rows.length} rows`)

  const importStart = Date.now()
  const imported = await importCsv(client, {
    connectionId: pg.id,
    database: 'postgres',
    table: 'p1_csv',
    filePath: csvPath,
    delimiter: ',',
    hasHeader: true,
    mapping: { id: 'id', label: 'label' }
  })
  const importMs = Date.now() - importStart
  check(
    'streaming CSV import inserts every row',
    imported.rowsInserted === 50_000 && imported.failed === 0,
    `${imported.rowsInserted} rows in ${importMs} ms`
  )
  const csvCount = await call<{ rows: { n: string }[] }[]>('runQuery', {
    connectionId: pg.id,
    sql: 'SELECT COUNT(*) AS n FROM p1_csv',
    maxRows: 5
  })
  check('streaming CSV import stored every row', csvCount[0].rows[0].n === '50000', csvCount[0].rows[0].n)
  const quoted = await call<{ rows: { label: string }[] }[]>('runQuery', {
    connectionId: pg.id,
    sql: 'SELECT label FROM p1_csv WHERE id = 42',
    maxRows: 5
  })
  check(
    'streaming CSV keeps quoted commas',
    quoted[0].rows[0]?.label === 'label, with comma 42',
    String(quoted[0].rows[0]?.label)
  )

  // Streaming restore: a file with a multi-line string and a function body must
  // be split only at real statement boundaries.
  await call('runQuery', {
    connectionId: pg.id,
    sql: 'CREATE TEMP TABLE p1_restore (id int primary key, note text)',
    maxRows: 1
  })
  const restorePath = join(dir, 'restore.sql')
  await writeFile(
    restorePath,
    [
      "INSERT INTO p1_restore VALUES (1, 'semicolon ; inside');",
      "INSERT INTO p1_restore VALUES (2, 'line one",
      "line two');",
      "INSERT INTO p1_restore VALUES (3, 'it''s fine; really');",
      'CREATE OR REPLACE FUNCTION p1_probe() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;',
      ''
    ].join('\n'),
    'utf-8'
  )
  const restoreResult = await restoreDatabase(client, pg.id, 'postgres', restorePath)
  const restoredRows = await call<{ rows: { n: string }[] }[]>('runQuery', {
    connectionId: pg.id,
    sql: 'SELECT COUNT(*) AS n FROM p1_restore',
    maxRows: 5
  })
  check(
    'streaming restore runs every statement',
    restoredRows[0].rows[0].n === '3',
    `${restoreResult.statements} statements, ${restoredRows[0].rows[0].n} rows`
  )
  const multiLine = await call<{ rows: { note: string }[] }[]>('runQuery', {
    connectionId: pg.id,
    sql: 'SELECT note FROM p1_restore WHERE id = 2',
    maxRows: 5
  })
  check(
    'streaming restore preserves multi-line values',
    multiLine[0].rows[0]?.note === 'line one\nline two',
    JSON.stringify(multiLine[0].rows[0]?.note)
  )
  const fn = await call<{ rows: { p1_probe: number }[] }[]>('runQuery', {
    connectionId: pg.id,
    sql: 'SELECT p1_probe()',
    maxRows: 5
  })
  check('streaming restore keeps a function body intact', fn[0].rows[0]?.p1_probe === 1)

  // Backup still round-trips through the streaming restore path.
  const backupPath = join(dir, 'p1-backup.sql')
  await backupDatabase(client, pg.id, 'postgres', backupPath, { structure: false, data: true })
  const restoreTarget = `p1_restore_${Date.now()}`
  await call('runQuery', { connectionId: pg.id, sql: `CREATE DATABASE ${restoreTarget}`, maxRows: 1 })
  const fromBackup = await restoreDatabase(client, pg.id, restoreTarget, backupPath)
  check('backup restores through the streaming path', fromBackup.statements > 0, `${fromBackup.statements} statements`)
  await call('runQuery', {
    connectionId: pg.id,
    sql: `DROP DATABASE IF EXISTS ${restoreTarget}`,
    maxRows: 1
  }).catch(() => undefined)

  // Client cache: browsing many databases must not keep them all open. Twelve
  // throwaway databases are created so the limit is actually exceeded, then the
  // app's own backends are counted from pg_stat_activity.
  const cacheDbs = Array.from({ length: 12 }, (_, i) => `p1_cache_${Date.now()}_${i}`)
  for (const db of cacheDbs) {
    await call('runQuery', { connectionId: pg.id, sql: `CREATE DATABASE ${db}`, maxRows: 1 })
  }
  for (const db of cacheDbs) {
    await call('listSchemas', { connectionId: pg.id, database: db })
  }
  const appConns = await call<{ rows: { n: string }[] }[]>('runQuery', {
    connectionId: pg.id,
    sql: "SELECT COUNT(*) AS n FROM pg_stat_activity WHERE application_name = 'Tupai'",
    maxRows: 5
  })
  const openClients = Number(appConns[0].rows[0].n)
  check(
    'pg client cache stays bounded',
    openClients <= 9,
    `${openClients} open clients after browsing ${cacheDbs.length} databases (limit 8)`
  )
  // Drops run after disconnect: an evicted client may still be closing, and
  // DROP DATABASE refuses while any backend is attached. Each drop is retried
  // once after terminating leftover backends, so an interrupted run does not
  // leave databases behind.
  await call('disconnect', { connectionId: pg.id })
  await call('connect', await getConnectionConfig(pg.id))
  for (const db of cacheDbs) {
    const drop = (): Promise<unknown> =>
      call('runQuery', { connectionId: pg.id, sql: `DROP DATABASE IF EXISTS ${db}`, maxRows: 1 })
    try {
      await drop()
    } catch {
      await call('runQuery', {
        connectionId: pg.id,
        sql: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}'`,
        maxRows: 5
      }).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 100))
      await drop().catch(() => undefined)
    }
  }
  await call('disconnect', { connectionId: pg.id })

  // ---------- SQLite ----------
  const dbFile = join(dir, 'p1.db')
  const Database = (await import('better-sqlite3')).default as unknown as new (
    path: string
  ) => { exec(sql: string): void; close(): void }
  const seed = new Database(dbFile)
  seed.exec('CREATE TABLE p1 (id INTEGER PRIMARY KEY, v TEXT)')
  seed.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${BIG}) INSERT INTO p1 (id, v) SELECT n, 'row-' || n FROM seq`)
  seed.close()

  const lite: ConnectionConfig = { id: 'p1-lite', name: 'p1 lite', engine: 'sqlite', file: dbFile }
  await saveConnection(lite)
  await call('connect', await getConnectionConfig(lite.id))

  const liteStart = Date.now()
  const liteLimit = await call<{ rows: unknown[]; truncated: boolean }[]>('runQuery', {
    connectionId: lite.id, sql: 'SELECT * FROM p1', maxRows: 500
  })
  const liteMs = Date.now() - liteStart
  check('sqlite maxRows exact', liteLimit[0].rows.length === 500, `${liteLimit[0].rows.length}`)
  check('sqlite limit is cheap', liteMs < 3000, `${liteMs} ms over ${BIG} candidates`)

  const liteDeleted = await call<number>('deleteRows', {
    dels: Array.from({ length: 200 }, (_, i) => ({
      connectionId: lite.id, database: 'main', table: 'p1', primaryKeys: { id: i + 1 }
    }))
  })
  check('sqlite bulk delete count', liteDeleted === 200, String(liteDeleted))
  const liteCount = await call<{ rows: { n: number }[] }[]>('runQuery', {
    connectionId: lite.id, sql: 'SELECT COUNT(*) AS n FROM p1', maxRows: 5
  })
  check('sqlite bulk delete applied', liteCount[0].rows[0].n === BIG - 200, String(liteCount[0].rows[0].n))

  let liteRollback = ''
  try {
    await call('deleteRows', {
      dels: [
        { connectionId: lite.id, database: 'main', table: 'p1', primaryKeys: { id: 500 } },
        { connectionId: lite.id, database: 'main', table: 'missing_table', primaryKeys: { id: 1 } }
      ]
    })
  } catch (err) {
    liteRollback = err instanceof Error ? err.message : String(err)
  }
  const liteAfter = await call<{ rows: { n: number }[] }[]>('runQuery', {
    connectionId: lite.id, sql: 'SELECT COUNT(*) AS n FROM p1', maxRows: 5
  })
  check('sqlite failed batch rolls back', liteRollback.length > 0 && liteAfter[0].rows[0].n === BIG - 200, String(liteAfter[0].rows[0].n))

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
