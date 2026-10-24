import { app } from 'electron'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DbWorkerClient } from '../../src/main/workers/dbWorkerClient'
import { saveConnection, getConnectionConfig } from '../../src/main/connection/store'
import { exportTable, importCsv } from '../../src/main/io/handlers'
import { backupDatabase, restoreDatabase } from '../../src/main/io/backup'
import { buildDdl } from '../../src/shared/ddl'
import type { ConnectionConfig } from '../../src/shared/types'

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tupai-sqlite-'))
  app.setPath('userData', dir)
  process.env.TUPAI_USER_DATA = dir
  const dbFile = join(dir, 'smoke.db')

  // Seed with better-sqlite3 directly so the file exists before the adapter
  // opens it with fileMustExist.
  const Database = (await import('better-sqlite3')).default as unknown as new (
    path: string
  ) => { exec(sql: string): void; close(): void }
  const seed = new Database(dbFile)
  seed.exec(`
    CREATE TABLE tricky (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      txt TEXT,
      note TEXT,
      flag INTEGER,
      amount REAL,
      payload TEXT,
      bin_data BLOB
    );
    INSERT INTO tricky (txt, note, flag, amount, payload, bin_data) VALUES
      ('back\\slash', 'O''Brien', 1, 1234.5, '{"a":1}', x'0102ff'),
      ('line1' || char(10) || 'line2', NULL, 0, -0.01, NULL, x''),
      (NULL, 'plain', NULL, NULL, NULL, NULL);
  `)
  seed.close()

  const conn: ConnectionConfig = {
    id: 'smoke-sqlite',
    name: 'Smoke SQLite',
    engine: 'sqlite',
    file: dbFile
  }
  await saveConnection(conn)
  const loaded = await getConnectionConfig(conn.id)

  const client = new DbWorkerClient()
  const call = <T>(op: string, payload: unknown): Promise<T> => client.call<T>(op, payload)

  check('connect', (await call<boolean>('connect', loaded)) === true)
  check('listDatabases', (await call<string[]>('listDatabases', { connectionId: conn.id }))[0] === 'main')
  const tables = await call<{ name: string }[]>('listTables', { connectionId: conn.id, database: 'main' })
  check('listTables', tables.some((t) => t.name === 'tricky'))

  const page = await call<{ rows: Record<string, unknown>[]; total: number; primaryKeys: string[] }>(
    'selectRows', { connectionId: conn.id, database: 'main', table: 'tricky', limit: 10, offset: 0, orderBy: 'id' }
  )
  check('selectRows', page.total === 3 && page.primaryKeys.join(',') === 'id')
  check('SQLite keeps backslash', page.rows[0].txt === 'back\\slash', JSON.stringify(page.rows[0].txt))
  check('SQLite keeps quote', page.rows[0].note === "O'Brien")
  check('SQLite blob is buffer-ish', page.rows[0].bin_data !== null && typeof page.rows[0].bin_data === 'object')

  const filtered = await call<{ total: number }>('selectRows', {
    connectionId: conn.id, database: 'main', table: 'tricky', limit: 10, offset: 0,
    filters: [{ column: 'note', op: 'isNull' }]
  })
  check('filter isNull', filtered.total === 1, `${filtered.total} rows`)

  const columns = await call<{ name: string; isPrimaryKey: boolean; autoIncrement?: boolean }[]>(
    'listColumns', { connectionId: conn.id, database: 'main', table: 'tricky' }
  )
  check('listColumns detects AUTOINCREMENT', columns[0].autoIncrement === true, String(columns[0].autoIncrement))

  const pk = await call<{ columns: string[] } | null>('getPrimaryKey', {
    connectionId: conn.id, database: 'main', table: 'tricky'
  })
  check('getPrimaryKey', pk?.columns.join(',') === 'id')

  const plan = await call<{ format: string; raw: string }>('explainQuery', {
    connectionId: conn.id, database: 'main', sql: 'SELECT * FROM tricky WHERE id = 1'
  })
  check('explainQuery', plan.format === 'text' && plan.raw.length > 0)

  const ddl = await call<string | null>('getTableDdl', { connectionId: conn.id, database: 'main', table: 'tricky' })
  check('getTableDdl', Boolean(ddl?.includes('CREATE TABLE')))

  const indexes = await call<unknown[]>('listIndexes', { connectionId: conn.id, database: 'main', table: 'tricky' })
  check('listIndexes', Array.isArray(indexes))

  const fks = await call<unknown[]>('listForeignKeys', { connectionId: conn.id, database: 'main', table: 'tricky' })
  check('listForeignKeys', Array.isArray(fks))

  const stats = await call<{ name: string; rows: number | null }[]>('listTableStats', {
    connectionId: conn.id, database: 'main'
  })
  check('listTableStats', stats.some((s) => s.name === 'tricky' && s.rows === 3), `${stats.length} tables`)

  const sqlFile = join(dir, 'tricky.sql')
  await exportTable(client, {
    connectionId: conn.id, database: 'main', table: 'tricky', format: 'sql', filePath: sqlFile
  })
  const sqlText = await readFile(sqlFile, 'utf-8')
  check('SQLite export literal backslash', sqlText.includes("'back\\slash'") && !sqlText.includes("'back\\\\slash'"), sqlText.split('\n').find((l) => l.includes('back')) ?? 'n/a')
  check('SQLite export blob literal', sqlText.includes("x'0102ff'"))
  check('SQLite export boolean as 1/0', /\b1\b/.test(sqlText))

  const csvFile = join(dir, 'rows.csv')
  await writeFile(csvFile, '1,alpha\n2,beta\n', 'utf-8')
  await call('runQuery', { connectionId: conn.id, database: 'main', sql: 'CREATE TABLE csv_import (id INTEGER, label TEXT)', maxRows: 1 })
  const imported = await importCsv(client, {
    connectionId: conn.id, database: 'main', table: 'csv_import', filePath: csvFile,
    delimiter: ',', hasHeader: false, mapping: { column_1: 'id', column_2: 'label' }
  })
  const csvCount = await call<{ total: number }>('selectRows', {
    connectionId: conn.id, database: 'main', table: 'csv_import', limit: 10, offset: 0
  })
  check('headerless CSV import', imported.rowsInserted === 2 && csvCount.total === 2, `${imported.rowsInserted}/${csvCount.total}`)

  const backupFile = join(dir, 'backup.sql')
  const backup = await backupDatabase(client, conn.id, 'main', backupFile, { structure: true, data: true })
  check('backup entry', backup.rows >= 3, `${backup.tables} tables, ${backup.rows} rows`)

  // Restore into a second file: CREATE TABLE would collide in the same one.
  const restoreFile = join(dir, 'restore.db')
  const restoreSeed = new Database(restoreFile)
  restoreSeed.close()
  const restoreConn: ConnectionConfig = { id: 'smoke-sqlite-restore', name: 'restore', engine: 'sqlite', file: restoreFile }
  await saveConnection(restoreConn)
  const restoreCfg = await getConnectionConfig(restoreConn.id)
  await call('connect', restoreCfg)
  const restore = await restoreDatabase(client, restoreConn.id, 'main', backupFile)
  const restoredRows = await call<{ total: number }>('selectRows', {
    connectionId: restoreConn.id, database: 'main', table: 'tricky', limit: 10, offset: 0
  })
  check('restore runs and loads rows', restore.statements > 0 && restoredRows.total === 3, `${restore.statements} statements, ${restoredRows.total} rows`)
  await call('disconnect', { connectionId: restoreConn.id })

  // Truncate path: SQLite uses DELETE + sqlite_sequence reset.
  const truncate = buildDdl('sqlite', { kind: 'truncateTable', database: 'main', table: 'tricky' })
  check('SQLite truncate uses DELETE', truncate[0].startsWith('DELETE FROM'), truncate[0])
  await call('runQuery', { connectionId: conn.id, database: 'main', sql: truncate.join('\n'), maxRows: 1 })
  const afterTruncate = await call<{ total: number }>('selectRows', {
    connectionId: conn.id, database: 'main', table: 'tricky', limit: 10, offset: 0
  })
  check('truncateTable', afterTruncate.total === 0)

  // Users are unsupported and must say so instead of returning an empty list.
  let usersError = ''
  try {
    await call('listUsers', { connectionId: conn.id })
  } catch (err) {
    usersError = String((err as { message?: string }).message ?? err)
  }
  check('listUsers rejects clearly', usersError.length > 0, usersError.slice(0, 60))

  await call('disconnect', { connectionId: conn.id })
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
