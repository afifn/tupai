import { app } from 'electron'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DbWorkerClient } from '../../src/main/workers/dbWorkerClient'
import { saveConnection, getConnectionConfig } from '../../src/main/connection/store'
import { exportTable, importCsv } from '../../src/main/io/handlers'
import { backupDatabase } from '../../src/main/io/backup'
import { dumpDatabase } from '../../src/main/io/databaseDump'
import { buildDdl } from '../../src/shared/ddl'
import { catalogColumnName, catalogColumns } from './typeCatalog'
import type { ConnectionConfig } from '../../src/shared/types'

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`)
}

const RUN = Date.now().toString(36)
const DB = `tupai_smoke_${RUN}`

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tupai-mysql-'))
  app.setPath('userData', dir)
  process.env.TUPAI_USER_DATA = dir

  const conn: ConnectionConfig = {
    id: 'smoke-mysql',
    name: 'Smoke MySQL',
    engine: 'mysql',
    host: '127.0.0.1',
    port: 33061,
    user: 'root',
    password: ''
  }
  await saveConnection(conn)
  const loaded = await getConnectionConfig(conn.id)

  const client = new DbWorkerClient()
  const call = <T>(op: string, payload: unknown): Promise<T> =>
    client.call<T>(op, payload)

  check('connect', (await call<boolean>('connect', loaded)) === true)
  await call('runQuery', {
    connectionId: conn.id,
    sql: `CREATE DATABASE ${DB}`,
    maxRows: 1
  })
  const dbs = await call<string[]>('listDatabases', { connectionId: conn.id })
  check('listDatabases', dbs.includes(DB), `${dbs.length} databases`)
  check(
    'MySQL keeps system databases visible',
    dbs.includes('mysql') && dbs.includes('information_schema'),
    dbs
      .filter((d) =>
        ['mysql', 'sys', 'information_schema', 'performance_schema'].includes(d)
      )
      .join(',')
  )

  await call('runQuery', {
    connectionId: conn.id,
    database: DB,
    sql: `CREATE TABLE tricky (
      id int PRIMARY KEY AUTO_INCREMENT,
      txt varchar(100),
      note varchar(100),
      flag boolean,
      amount decimal(12,2),
      created datetime,
      payload json,
      bin_data blob
    )`,
    maxRows: 1
  })
  await call('runQuery', {
    connectionId: conn.id,
    database: DB,
    sql: `INSERT INTO tricky (txt, note, flag, amount, created, payload, bin_data) VALUES
      ('back\\\\slash', 'O''Brien', true, 1234.50, '2024-01-02 03:04:05', '{"a":1}', x'0102ff'),
      ('line1\\nline2', NULL, false, -0.01, '2023-12-31 23:59:59', NULL, x''),
      (NULL, 'plain', NULL, NULL, NULL, NULL, NULL)`,
    maxRows: 1
  })

  const page = await call<{
    rows: Record<string, unknown>[]
    total: number
    primaryKeys: string[]
  }>('selectRows', {
    connectionId: conn.id,
    database: DB,
    table: 'tricky',
    limit: 10,
    offset: 0,
    orderBy: 'id'
  })
  check('selectRows', page.total === 3 && page.primaryKeys.join(',') === 'id')
  const row1 = page.rows[0] as Record<string, unknown>
  check('MySQL keeps backslash', row1.txt === 'back\\slash', JSON.stringify(row1.txt))
  check('MySQL keeps quote', row1.note === "O'Brien")
  check(
    'MySQL boolean normalized',
    row1.flag === 1 || row1.flag === true,
    String(row1.flag)
  )

  const filters = await call<{ total: number }>('selectRows', {
    connectionId: conn.id,
    database: DB,
    table: 'tricky',
    limit: 10,
    offset: 0,
    filters: [{ column: 'note', op: 'contains', value: "'" }]
  })
  check('filter with apostrophe', filters.total === 1, `${filters.total} rows`)

  const orFilters = await call<{ total: number }>('selectRows', {
    connectionId: conn.id,
    database: DB,
    table: 'tricky',
    limit: 10,
    offset: 0,
    filters: [
      { column: 'id', op: 'equals', value: '1' },
      { column: 'id', op: 'equals', value: '3' }
    ],
    filterLogic: 'or'
  })
  check('OR filter logic', orFilters.total === 2, `${orFilters.total} rows`)

  const columns = await call<{ name: string; autoIncrement?: boolean }[]>('listColumns', {
    connectionId: conn.id,
    database: DB,
    table: 'tricky'
  })
  check(
    'listColumns marks AUTO_INCREMENT',
    columns[0].autoIncrement === true,
    String(columns[0].autoIncrement)
  )

  const pk = await call<{ columns: string[] } | null>('getPrimaryKey', {
    connectionId: conn.id,
    database: DB,
    table: 'tricky'
  })
  check('getPrimaryKey', pk?.columns.join(',') === 'id')

  const plan = await call<{ format: string }>('explainQuery', {
    connectionId: conn.id,
    database: DB,
    sql: 'SELECT * FROM tricky WHERE id = 1'
  })
  check('explainQuery', plan.format === 'json')

  const ddl = await call<string | null>('getTableDdl', {
    connectionId: conn.id,
    database: DB,
    table: 'tricky'
  })
  check('getTableDdl', Boolean(ddl?.includes('CREATE TABLE')))

  const stats = await call<
    { name: string; rows: number | null; sizeBytes: number | null }[]
  >('listTableStats', { connectionId: conn.id, database: DB })
  check(
    'listTableStats',
    stats.some((s) => s.name === 'tricky'),
    `${stats.length} tables`
  )

  const sqlFile = join(dir, 'tricky.sql')
  const exported = await exportTable(client, {
    connectionId: conn.id,
    database: DB,
    table: 'tricky',
    format: 'sql',
    filePath: sqlFile
  })
  const sqlText = await readFile(sqlFile, 'utf-8')
  check('exportTable sql', exported.rowsWritten === 3)
  check(
    'MySQL export escapes backslash',
    sqlText.includes("'back\\\\slash'"),
    sqlText.split('\n').find((l) => l.includes('back')) ?? 'n/a'
  )
  check('MySQL export blob literal', sqlText.includes("x'0102ff'"))
  check(
    'MySQL export boolean as 1/0',
    sqlText.includes('(1,') || sqlText.includes(', 1,')
  )

  const csvFile = join(dir, 'rows.csv')
  await writeFile(csvFile, '1,alpha\n2,beta\n', 'utf-8')
  await call('runQuery', {
    connectionId: conn.id,
    database: DB,
    sql: 'CREATE TABLE csv_import (id int, label varchar(50))',
    maxRows: 1
  })
  const imported = await importCsv(client, {
    connectionId: conn.id,
    database: DB,
    table: 'csv_import',
    filePath: csvFile,
    delimiter: ',',
    hasHeader: false,
    mapping: { column_1: 'id', column_2: 'label' }
  })
  const csvCount = await call<{ total: number }>('selectRows', {
    connectionId: conn.id,
    database: DB,
    table: 'csv_import',
    limit: 10,
    offset: 0
  })
  check(
    'headerless CSV import',
    imported.rowsInserted === 2 && csvCount.total === 2,
    `${imported.rowsInserted}/${csvCount.total}`
  )

  const dumpFile = join(dir, 'dump.sql')
  const dump = await dumpDatabase(client, conn.id, DB, dumpFile)
  const dumpText = await readFile(dumpFile, 'utf-8')
  check('dump contains table', dumpText.includes('tricky'), `${dump.tables} tables`)
  check('dump has no CREATE SCHEMA for MySQL', !dumpText.includes('CREATE SCHEMA'), 'ok')

  const backupFile = join(dir, 'backup.sql')
  const backup = await backupDatabase(client, conn.id, DB, backupFile, {
    structure: true,
    data: true
  })
  check(
    'backup entry',
    backup.rows > 0 && backup.tables >= 2,
    `${backup.tables} tables, ${backup.rows} rows`
  )

  // DDL routing and the rename syntax this engine uses.
  await call('runQuery', {
    connectionId: conn.id,
    database: DB,
    sql: 'CREATE TABLE rename_me (id int)',
    maxRows: 1
  })
  const rename = buildDdl('mysql', {
    kind: 'renameTable',
    database: DB,
    table: 'rename_me',
    newName: 'renamed_ok'
  })
  await call('runQuery', {
    connectionId: conn.id,
    database: DB,
    sql: rename.join('\n'),
    maxRows: 1
  })
  const tables = await call<{ name: string }[]>('listTables', {
    connectionId: conn.id,
    database: DB
  })
  check(
    'renameTable works',
    tables.some((t) => t.name === 'renamed_ok')
  )

  // Search, routines, users, sessions are all part of the engine surface.
  const found = await call<{ name: string; kind: string }[]>('searchObjects', {
    connectionId: conn.id,
    database: DB,
    term: 'tricky'
  })
  check(
    'searchObjects',
    found.some((f) => f.name === 'tricky'),
    `${found.length} hits`
  )

  const sessions = await call<{ id: string }[]>('listSessions', {
    connectionId: conn.id,
    database: DB
  })
  check('listSessions', sessions.length >= 1, `${sessions.length} sessions`)

  const users = await call<{ name: string }[]>('listUsers', { connectionId: conn.id })
  check('listUsers', users.length >= 1, `${users.length} users`)

  const routines = await call<unknown[]>('listRoutines', {
    connectionId: conn.id,
    database: DB
  })
  check('listRoutines', Array.isArray(routines))

  // Truncate path: DELETE + no sequence table in MySQL.
  const truncate = buildDdl('mysql', {
    kind: 'truncateTable',
    database: DB,
    table: 'csv_import'
  })
  await call('runQuery', {
    connectionId: conn.id,
    database: DB,
    sql: truncate.join('\n'),
    maxRows: 1
  })
  const afterTruncate = await call<{ total: number }>('selectRows', {
    connectionId: conn.id,
    database: DB,
    table: 'csv_import',
    limit: 10,
    offset: 0
  })
  check('truncateTable', afterTruncate.total === 0)

  // maxRows must be enforced by the row stream, not by slicing a buffered
  // result set. 200k candidate rows make the difference measurable.
  await call('runQuery', {
    connectionId: conn.id,
    database: DB,
    sql: 'CREATE TABLE big_rows (id int primary key auto_increment, v varchar(200))',
    maxRows: 1
  })
  for (let batch = 0; batch < 4; batch++) {
    const values = Array.from({ length: 50000 }, (_, i) => `row-${batch}-${i}`)
    await call('runQuery', {
      connectionId: conn.id,
      database: DB,
      sql: `INSERT INTO big_rows (v) VALUES ${values.map((v) => `('${v}')`).join(',')}`,
      maxRows: 1
    })
  }
  const bigStart = Date.now()
  const bigRes = await call<{ rows: unknown[]; truncated: boolean }[]>('runQuery', {
    connectionId: conn.id,
    database: DB,
    sql: 'SELECT * FROM big_rows',
    maxRows: 1000
  })
  const bigMs = Date.now() - bigStart
  check(
    'mysql returns exactly maxRows',
    bigRes[0].rows.length === 1000,
    `${bigRes[0].rows.length} rows`
  )
  check('mysql flags truncation', bigRes[0].truncated === true)
  check(
    'mysql stays fast on a large table',
    bigMs < 5000,
    `${bigMs} ms for 200000 candidate rows`
  )
  const bigAfter = await call<{ rows: { n: number }[] }[]>('runQuery', {
    connectionId: conn.id,
    database: DB,
    sql: 'SELECT COUNT(*) AS n FROM big_rows',
    maxRows: 10
  })
  check(
    'mysql connection still usable',
    Number(bigAfter[0].rows[0].n) === 200000,
    String(bigAfter[0].rows[0].n)
  )

  const bigCommand = await call<{ kind: string; rowCount: number }[]>('runQuery', {
    connectionId: conn.id,
    database: DB,
    sql: 'UPDATE big_rows SET v = v WHERE id <= 4',
    maxRows: 10
  })
  check(
    'mysql command rowCount preserved',
    bigCommand[0].kind === 'command' && bigCommand[0].rowCount === 4,
    JSON.stringify(bigCommand[0])
  )

  const bigSmall = await call<{ rows: unknown[]; truncated: boolean }[]>('runQuery', {
    connectionId: conn.id,
    database: DB,
    sql: 'SELECT * FROM big_rows WHERE id <= 3',
    maxRows: 1000
  })
  check(
    'mysql exact result not truncated',
    bigSmall[0].rows.length === 3 && !bigSmall[0].truncated
  )

  // Cancel: KILL QUERY must stop a long statement and keep the connection.
  let cancelError = ''
  const slowQuery = call<unknown[]>('runQuery', {
    connectionId: conn.id,
    database: DB,
    sql: 'SELECT SLEEP(30)',
    maxRows: 5
  }).catch((err: unknown) => {
    const shape = err as { message?: string }
    cancelError = err instanceof Error ? err.message : (shape?.message ?? String(err))
    return []
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  const cancelStart = Date.now()
  const cancelled = await call<boolean>('cancelQuery', { connectionId: conn.id })
  await slowQuery
  const cancelMs = Date.now() - cancelStart
  check('mysql cancel reports success', cancelled === true)
  check(
    'mysql cancel stops the statement early',
    cancelMs < 5000,
    `${cancelMs} ms (query was 30 s)`
  )
  const afterCancel = await call<{ rows: { ok: number }[] }[]>('runQuery', {
    connectionId: conn.id,
    database: DB,
    sql: 'SELECT 1 AS ok',
    maxRows: 5
  })
  check(
    'mysql connection usable after cancel',
    afterCancel[0].rows[0].ok === 1,
    cancelError.slice(0, 40)
  )
  const idleCancel = await call<boolean>('cancelQuery', { connectionId: conn.id })
  check('mysql cancel with nothing running returns false', idleCancel === false)

  // ---------- manual transaction ----------
  const txQuery = (sql: string, transactionId?: string): Promise<unknown> =>
    call('runQuery', {
      connectionId: conn.id,
      database: DB,
      sql,
      maxRows: 20,
      transactionId
    })
  const txCount = async (): Promise<number> => {
    const sets = (await txQuery(`SELECT COUNT(*) AS n FROM ${DB}.tx_rows`)) as {
      rows: { n: number }[]
    }[]
    return Number(sets[0].rows[0].n)
  }
  await txQuery(`CREATE TABLE ${DB}.tx_rows (id INT PRIMARY KEY, note TEXT)`)
  await txQuery(`INSERT INTO ${DB}.tx_rows VALUES (1, 'seed')`)

  await call('beginTransaction', {
    connectionId: conn.id,
    transactionId: 'tx-1',
    database: DB
  })
  await txQuery(`INSERT INTO ${DB}.tx_rows VALUES (2, 'in-tx')`, 'tx-1')
  const txInside = (await txQuery(`SELECT COUNT(*) AS n FROM ${DB}.tx_rows`, 'tx-1')) as {
    rows: { n: number }[]
  }[]
  check(
    'mysql transaction sees its own write',
    Number(txInside[0].rows[0].n) === 2,
    String(txInside[0].rows[0].n)
  )
  check('mysql other session does not see it', (await txCount()) === 1)
  await call('rollbackTransaction', { connectionId: conn.id, transactionId: 'tx-1' })
  check('mysql rollback discards the write', (await txCount()) === 1)

  await call('beginTransaction', {
    connectionId: conn.id,
    transactionId: 'tx-2',
    database: DB
  })
  await txQuery(`INSERT INTO ${DB}.tx_rows VALUES (3, 'kept')`, 'tx-2')
  await call('commitTransaction', { connectionId: conn.id, transactionId: 'tx-2' })
  check('mysql commit keeps the write', (await txCount()) === 2)

  // A DDL statement commits implicitly in MySQL. The transaction must not claim
  // to be open afterwards, or a later rollback would look successful while the
  // CREATE TABLE stays.
  await call('beginTransaction', {
    connectionId: conn.id,
    transactionId: 'tx-3',
    database: DB
  })
  await txQuery(`CREATE TABLE ${DB}.tx_ddl (id INT)`, 'tx-3')
  const afterDdl = await call<{ transactionId: string }[]>('listTransactions', {
    connectionId: conn.id
  })
  check(
    'mysql reports the implicit commit caused by DDL',
    afterDdl.every((tx) => tx.transactionId !== 'tx-3'),
    JSON.stringify(afterDdl.map((tx) => tx.transactionId))
  )
  await txQuery(`DROP TABLE ${DB}.tx_ddl`)

  // --- every type the designer offers can build a real table ---
  const catalogCols = catalogColumns('mysql')
  const catalogSql = buildDdl('mysql', {
    kind: 'createTable',
    database: DB,
    table: 'type_catalog',
    columns: catalogCols
  })
  await call('runQuery', {
    connectionId: conn.id,
    database: DB,
    sql: catalogSql.join('\n'),
    maxRows: 1
  })
  const catalogCreated = await call<{ name: string; dataType: string }[]>('listColumns', {
    connectionId: conn.id,
    database: DB,
    table: 'type_catalog'
  })
  check(
    'every catalog type creates a column',
    catalogCreated.length === catalogCols.length,
    `${catalogCreated.length}/${catalogCols.length}`
  )
  const catalogTypeOf = (type: string): string =>
    catalogCreated.find((c) => c.name === catalogColumnName('mysql', type))?.dataType ??
    ''
  check(
    'VARCHAR keeps its length',
    catalogTypeOf('VARCHAR').toLowerCase() === 'varchar(255)',
    catalogTypeOf('VARCHAR')
  )
  check(
    'DECIMAL carries precision and scale',
    catalogTypeOf('DECIMAL').toLowerCase() === 'decimal(10,2)',
    catalogTypeOf('DECIMAL')
  )
  check(
    'ENUM stores its value list',
    catalogTypeOf('ENUM').toLowerCase() === "enum('a','b')",
    catalogTypeOf('ENUM')
  )

  await call('runQuery', {
    connectionId: conn.id,
    sql: `DROP DATABASE ${DB}`,
    maxRows: 1
  })
  await client.terminate()
  await rm(dir, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0)
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ` | ${f.detail}` : ''}`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('SMOKE ERROR', err)
    app.exit(1)
  })
})
