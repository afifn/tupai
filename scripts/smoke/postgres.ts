import { app } from 'electron'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DbWorkerClient } from '../../src/main/workers/dbWorkerClient'
import { saveConnection, getConnectionConfig } from '../../src/main/connection/store'
import { exportTable, importCsv, importSql, previewImport } from '../../src/main/io/handlers'
import { backupDatabase, restoreDatabase } from '../../src/main/io/backup'
import { dumpDatabase } from '../../src/main/io/databaseDump'
import { buildDdl } from '../../src/shared/ddl'
import type { ConnectionConfig } from '../../src/shared/types'

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`)
}

// Unique per run so a leftover database from an interrupted run can never make
// the next run fail on "already exists".
const RUN = Date.now().toString(36)
const SRC = `tupai_smoke_src_${RUN}`
const DST = `tupai_smoke_dst_${RUN}`

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tupai-smoke-'))
  app.setPath('userData', dir)
  process.env.TUPAI_USER_DATA = dir

  const conn: ConnectionConfig = {
    id: 'smoke-pg',
    name: 'Smoke Postgres',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    user: process.env.USER,
    database: 'postgres'
  }
  await saveConnection(conn)
  const loaded = await getConnectionConfig(conn.id)
  check('connection config round-trip', loaded?.host === '127.0.0.1' && loaded?.user === conn.user)

  const client = new DbWorkerClient()
  const call = <T>(op: string, payload: unknown): Promise<T> => client.call<T>(op, payload)

  // Reset the scratch databases so repeated runs are deterministic.
  for (const db of [SRC, DST]) {
    await call('runQuery', {
      connectionId: conn.id,
      sql: `DROP DATABASE IF EXISTS ${db}`,
      maxRows: 1
    }).catch(() => undefined)
  }

  check('connect', (await call<boolean>('connect', loaded)) === true)
  const dbs = await call<string[]>('listDatabases', { connectionId: conn.id })
  check('listDatabases', dbs.includes('postgres'), `${dbs.length} databases`)

  for (const db of [SRC, DST]) {
    // The driver keeps one client per database, so a DROP right before the
    // CREATE can race its own cached client. CREATE is idempotent here via a
    // catalog check instead.
    const exists = await call<{ rows: { n: number }[] }[]>('runQuery', {
      connectionId: conn.id,
      sql: `SELECT 1 AS n FROM pg_database WHERE datname = '${db}'`,
      maxRows: 1
    })
    if ((exists[0]?.rows.length ?? 0) === 0) {
      await call('runQuery', {
        connectionId: conn.id,
        sql: `CREATE DATABASE ${db}`,
        maxRows: 1
      })
    }
  }

  const schemas = await call<string[]>('listSchemas', { connectionId: conn.id, database: SRC })
  check('listSchemas', schemas.includes('public'), schemas.join(','))

  // Table with every value shape that used to be mangled by the exporters.
  await call('runQuery', {
    connectionId: conn.id,
    database: SRC,
    sql: `CREATE TABLE public.tricky (
      id integer PRIMARY KEY,
      txt text,
      note varchar(100),
      flag boolean,
      amount numeric(12,2),
      created timestamptz,
      payload jsonb,
      blob bytea
    )`,
    maxRows: 1
  })
  await call('runQuery', {
    connectionId: conn.id,
    database: SRC,
    sql: `INSERT INTO public.tricky VALUES
      (1, E'back\\\\slash', 'O''Brien', true, 1234.50, '2024-01-02 03:04:05.678+00', '{"a":1,"b":[2,3]}', '\\x0102ff'),
      (2, E'line1\\nline2', NULL, false, -0.01, '2023-12-31 23:59:59+00', 'null', '\\x'),
      (3, NULL, 'plain', NULL, NULL, NULL, NULL, NULL)`,
    maxRows: 1
  })

  const columns = await call<{ name: string; isPrimaryKey: boolean }[]>('listColumns', {
    connectionId: conn.id,
    database: SRC,
    table: 'tricky',
    schema: 'public'
  })
  check('listColumns', columns.length === 8 && columns[0].isPrimaryKey, `${columns.length} columns`)

  const pk = await call<{ name: string; columns: string[] } | null>('getPrimaryKey', {
    connectionId: conn.id,
    database: SRC,
    table: 'tricky',
    schema: 'public'
  })
  check('getPrimaryKey', pk?.columns.join(',') === 'id')

  const page = await call<{ rows: Record<string, unknown>[]; total: number; primaryKeys: string[] }>(
    'selectRows',
    { connectionId: conn.id, database: SRC, schema: 'public', table: 'tricky', limit: 10, offset: 0 }
  )
  check('selectRows', page.total === 3 && page.primaryKeys.join(',') === 'id')
  const row1 = page.rows.find((r) => r.id === 1) as Record<string, unknown>
  check('selectRows keeps backslash', row1.txt === 'back\\slash', JSON.stringify(row1.txt))
  check('selectRows keeps quote', row1.note === "O'Brien")
  check('selectRows boolean is boolean', row1.flag === true)
  check('selectRows bytea is buffer-ish', row1.blob !== null && typeof row1.blob === 'object')

  const filtered = await call<{ rows: Record<string, unknown>[]; total: number }>('selectRows', {
    connectionId: conn.id,
    database: SRC,
    schema: 'public',
    table: 'tricky',
    limit: 10,
    offset: 0,
    filters: [{ column: 'note', op: 'contains', value: "'" }]
  })
  check('filter with quote matches', filtered.total === 1, `${filtered.total} rows`)

  const nulls = await call<{ total: number }>('selectRows', {
    connectionId: conn.id,
    database: SRC,
    schema: 'public',
    table: 'tricky',
    limit: 10,
    offset: 0,
    filters: [{ column: 'note', op: 'isNull' }]
  })
  check('filter isNull', nulls.total === 1, `${nulls.total} rows`)

  // Row CRUD through the same code path the grid uses.
  await call('insertRow', {
    connectionId: conn.id,
    database: SRC,
    schema: 'public',
    table: 'tricky',
    values: { id: 4, txt: 'inserted', note: 'x', flag: true, amount: 1, created: null, payload: null, blob: null }
  })
  await call('updateRow', {
    connectionId: conn.id,
    database: SRC,
    schema: 'public',
    table: 'tricky',
    primaryKeys: { id: 4 },
    changes: { txt: 'updated' }
  })
  const afterUpdate = await call<{ rows: Record<string, unknown>[] }>('selectRows', {
    connectionId: conn.id,
    database: SRC,
    schema: 'public',
    table: 'tricky',
    limit: 10,
    offset: 0,
    filters: [{ column: 'id', op: 'equals', value: '4' }]
  })
  check('insertRow + updateRow', afterUpdate.rows[0]?.txt === 'updated')
  await call('deleteRow', {
    connectionId: conn.id,
    database: SRC,
    schema: 'public',
    table: 'tricky',
    primaryKeys: { id: 4 }
  })
  const afterDelete = await call<{ total: number }>('selectRows', {
    connectionId: conn.id,
    database: SRC,
    schema: 'public',
    table: 'tricky',
    limit: 10,
    offset: 0
  })
  check('deleteRow', afterDelete.total === 3)

  const plan = await call<{ format: string; raw: string }>('explainQuery', {
    connectionId: conn.id,
    database: SRC,
    schema: 'public',
    sql: 'SELECT * FROM public.tricky WHERE id = 1'
  })
  check('explainQuery', plan.format === 'json' && plan.raw.length > 10)

  const ddl = await call<string | null>('getTableDdl', {
    connectionId: conn.id,
    database: SRC,
    table: 'tricky',
    schema: 'public'
  })
  check('getTableDdl', Boolean(ddl && ddl.includes('CREATE TABLE')))

  // --- P0: export SQL literals round-trip ---
  const sqlFile = join(dir, 'tricky.sql')
  const exported = await exportTable(client, {
    connectionId: conn.id,
    database: SRC,
    schema: 'public',
    table: 'tricky',
    format: 'sql',
    filePath: sqlFile
  })
  const sqlText = await readFile(sqlFile, 'utf-8')
  check('exportTable sql wrote rows', exported.rowsWritten === 3, `${exported.rowsWritten} rows`)
  check(
    'export does not double backslash for postgres',
    sqlText.includes("'back\\slash'") && !sqlText.includes("'back\\\\slash'"),
    sqlText.split('\n').find((l) => l.includes('back')) ?? 'not found'
  )
  check('export quotes apostrophe', sqlText.includes("'O''Brien'"))
  check('export boolean as TRUE', sqlText.includes('TRUE'))
  check('export bytea cast', sqlText.includes('::bytea'))

  // Restore into the destination database and compare every value.
  await call('runQuery', {
    connectionId: conn.id,
    database: DST,
    sql: `CREATE TABLE public.tricky (
      id integer PRIMARY KEY, txt text, note varchar(100), flag boolean,
      amount numeric(12,2), created timestamptz, payload jsonb, blob bytea
    )`,
    maxRows: 1
  })
  const restored = await importSql(client, {
    connectionId: conn.id,
    database: DST,
    filePath: sqlFile
  })
  check('importSql accepts export file', restored.statements >= 1, `${restored.statements} statements`)

  const srcRows = await call<{ rows: Record<string, unknown>[] }>('selectRows', {
    connectionId: conn.id, database: SRC, schema: 'public', table: 'tricky', limit: 10, offset: 0, orderBy: 'id'
  })
  const dstRows = await call<{ rows: Record<string, unknown>[] }>('selectRows', {
    connectionId: conn.id, database: DST, schema: 'public', table: 'tricky', limit: 10, offset: 0, orderBy: 'id'
  })
  const norm = (rows: Record<string, unknown>[]): string =>
    JSON.stringify(
      rows.map((r) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [
            k,
            v instanceof Uint8Array ? `hex:${Buffer.from(v).toString('hex')}` : v
          ])
        )
      )
    )
  check(
    'export -> restore preserves every value',
    norm(srcRows.rows) === norm(dstRows.rows),
    norm(srcRows.rows) === norm(dstRows.rows) ? undefined : `src=${norm(srcRows.rows)} dst=${norm(dstRows.rows)}`
  )

  // --- P0: headerless CSV keeps the first row ---
  const csvFile = join(dir, 'noheader.csv')
  await writeFile(csvFile, '10,alpha\n20,beta\n30,gamma\n', 'utf-8')
  await call('runQuery', {
    connectionId: conn.id,
    database: SRC,
    sql: 'CREATE TABLE public.csv_import (id integer, label text)',
    maxRows: 1
  })
  const preview = await previewImport(csvFile, ',', false)
  check('previewImport headerless', preview.rows.length === 3 && preview.headers[0] === 'column_1')
  const imported = await importCsv(client, {
    connectionId: conn.id,
    database: SRC,
    schema: 'public',
    table: 'csv_import',
    filePath: csvFile,
    delimiter: ',',
    hasHeader: false,
    mapping: { column_1: 'id', column_2: 'label' }
  })
  const csvCount = await call<{ total: number }>('selectRows', {
    connectionId: conn.id, database: SRC, schema: 'public', table: 'csv_import', limit: 10, offset: 0
  })
  check(
    'headerless import keeps all rows',
    imported.rowsInserted === 3 && csvCount.total === 3,
    `inserted=${imported.rowsInserted} stored=${csvCount.total}`
  )

  // --- P0: dump/backup walk every schema, not only public ---
  await call('runQuery', {
    connectionId: conn.id,
    database: SRC,
    sql: 'CREATE SCHEMA smoke_extra',
    maxRows: 1
  })
  await call('runQuery', {
    connectionId: conn.id,
    database: SRC,
    sql: 'CREATE TABLE smoke_extra.other (id integer PRIMARY KEY, v text)',
    maxRows: 1
  })
  await call('runQuery', {
    connectionId: conn.id,
    database: SRC,
    sql: "INSERT INTO smoke_extra.other VALUES (1, 'in-other-schema')",
    maxRows: 1
  })

  const dumpFile = join(dir, 'dump.sql')
  const dump = await dumpDatabase(client, conn.id, SRC, dumpFile)
  const dumpText = await readFile(dumpFile, 'utf-8')
  check('dump includes public table', dumpText.includes('tricky'))
  check('dump includes non-public schema table', dumpText.includes('other'), `${dump.tables} tables`)

  const backupFile = join(dir, 'backup.sql')
  const backup = await backupDatabase(client, conn.id, SRC, backupFile, {
    structure: true,
    data: true
  })
  const backupText = await readFile(backupFile, 'utf-8')
  check('backup includes both schemas', backupText.includes('tricky') && backupText.includes('other'))
  check('backup history entry', backup.database === SRC && backup.rows > 0, `${backup.rows} rows`)

  // Restore the backup into a fresh database: DST already holds the table the
  // export/import round-trip created, so restoring there would collide.
  const RESTORE = `tupai_smoke_restore_${RUN}`
  await call('runQuery', {
    connectionId: conn.id,
    sql: `DROP DATABASE IF EXISTS ${RESTORE}`,
    maxRows: 1
  }).catch(() => undefined)
  await call('runQuery', {
    connectionId: conn.id,
    sql: `CREATE DATABASE ${RESTORE}`,
    maxRows: 1
  })
  const restore = await restoreDatabase(client, conn.id, RESTORE, backupFile)
  check('restore runs the backup file', restore.statements > 0, `${restore.statements} statements`)

  // --- DDL routing still works after the session-context change ---
  await call('runQuery', {
    connectionId: conn.id,
    database: SRC,
    sql: 'CREATE TABLE public.ddl_target (id integer)',
    maxRows: 1
  })
  const ddlStatements = buildDdl('postgres', {
    kind: 'renameTable',
    database: SRC,
    schema: 'public',
    table: 'ddl_target',
    newName: 'ddl_renamed'
  })
  await call('runQuery', {
    connectionId: conn.id,
    database: SRC,
    schema: 'public',
    sql: ddlStatements.join('\n'),
    maxRows: 1
  })
  const tables = await call<{ name: string }[]>('listTables', {
    connectionId: conn.id, database: SRC, schema: 'public'
  })
  check('DDL routed to the right schema', tables.some((t) => t.name === 'ddl_renamed'))

  // A query without a schema must not inherit the previous search_path.
  await call('runQuery', {
    connectionId: conn.id,
    database: SRC,
    schema: 'smoke_extra',
    sql: 'SELECT 1',
    maxRows: 1
  })
  const afterScoped = await call<
    { rows: Record<string, unknown>[]; columns: { name: string }[] }[]
  >('runQuery', {
    connectionId: conn.id,
    database: SRC,
    sql: 'SHOW search_path',
    maxRows: 1
  })
  const searchPath = String(afterScoped[0]?.rows[0]?.search_path ?? '')
  check(
    'search_path resets when no schema is given',
    !searchPath.includes('smoke_extra'),
    searchPath
  )

  // Drop the scratch databases so a successful run leaves the server as it
  // found it. RESTORE only exists when the backup section ran.
  for (const db of [SRC, DST, `tupai_smoke_restore_${RUN}`]) {
    await call('runQuery', {
      connectionId: conn.id,
      sql: `DROP DATABASE IF EXISTS ${db}`,
      maxRows: 1
    }).catch(() => undefined)
  }

  await client.terminate()
  await rm(dir, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
    console.log('FAILED:')
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ` | ${f.detail}` : ''}`)
  }
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('SMOKE ERROR', err)
    app.exit(1)
  })
})
