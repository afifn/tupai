import { app } from 'electron'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DbWorkerClient } from '../../src/main/workers/dbWorkerClient'
import { getConnectionConfig, saveConnection } from '../../src/main/connection/store'
import { previewStructureSync, structureSync } from '../../src/main/sync/structureSync'
import { dataSync, previewDataSync } from '../../src/main/sync/dataSync'
import {
  deleteSyncProfile,
  listSyncProfiles,
  saveSyncProfile
} from '../../src/main/sync/profiles'
import { DEFAULT_DATA_OPTIONS, DEFAULT_STRUCTURE_OPTIONS } from '../../src/shared/types'
import type { ConnectionConfig, SyncProgress } from '../../src/shared/types'

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tupai-sync-'))
  app.setPath('userData', dir)
  process.env.TUPAI_USER_DATA = dir

  const Database = (await import('better-sqlite3')).default as unknown as new (
    path: string
  ) => {
    exec(sql: string): void
    close(): void
    prepare(sql: string): { all(): unknown[] }
  }

  const sourceFile = join(dir, 'source.db')
  const source = new Database(sourceFile)
  source.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_customers_name ON customers (name);
    INSERT INTO customers (name, email, active) VALUES
      ('Ani', 'ani@example.test', 1),
      ('Budi', 'budi@example.test', 0),
      ('Citra', NULL, 1);

    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      total REAL NOT NULL,
      note TEXT
    );
    INSERT INTO orders (id, customer_id, total, note) VALUES
      (1, 1, 120.5, 'first'),
      (2, 2, 80, NULL);

    CREATE TABLE audit_log (
      message TEXT,
      created_at TEXT
    );
    INSERT INTO audit_log (message, created_at) VALUES ('tanpa pk', '2026-01-01');

    CREATE TABLE only_in_source (id INTEGER PRIMARY KEY, label TEXT);

    CREATE TABLE type_change (
      id INTEGER PRIMARY KEY,
      amount INTEGER
    );
  `)
  source.close()

  const targetFile = join(dir, 'target.db')
  const target = new Database(targetFile)
  target.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO customers (id, name, email, active) VALUES
      (1, 'Ani', 'ani@example.test', 1),
      (2, 'Budi lama', 'budi@example.test', 0),
      (9, 'Hanya target', NULL, 1);

    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      total REAL NOT NULL,
      note TEXT
    );
    INSERT INTO orders (id, customer_id, total, note) VALUES
      (1, 1, 120.5, 'first');

    CREATE TABLE audit_log (
      message TEXT,
      created_at TEXT
    );
    INSERT INTO audit_log (message, created_at) VALUES ('target', '2026-01-01');

    CREATE TABLE extra_in_target (id INTEGER PRIMARY KEY);

    CREATE TABLE type_change (
      id INTEGER PRIMARY KEY,
      amount TEXT
    );
  `)
  target.close()

  const sourceConn: ConnectionConfig = {
    id: 'sync-source',
    name: 'Sync Source',
    engine: 'sqlite',
    file: sourceFile
  }
  const targetConn: ConnectionConfig = {
    id: 'sync-target',
    name: 'Sync Target',
    engine: 'sqlite',
    file: targetFile
  }
  await saveConnection(sourceConn)
  await saveConnection(targetConn)

  const client = new DbWorkerClient()
  await client.call('connect', await getConnectionConfig(sourceConn.id))
  await client.call('connect', await getConnectionConfig(targetConn.id))

  const endpoints = {
    source: { connectionId: sourceConn.id, database: 'main' },
    target: { connectionId: targetConn.id, database: 'main' }
  }

  // Structure preview: new table, added index, extra table, unchanged table.
  const structurePreview = await previewStructureSync(client, {
    ...endpoints,
    tables: [],
    options: { ...DEFAULT_STRUCTURE_OPTIONS, dropExtraTables: true }
  })
  const kinds = structurePreview.changes.map((c) => c.kind)
  check(
    'structure preview finds missing table',
    structurePreview.changes.some(
      (c) => c.kind === 'createTable' && c.table === 'only_in_source'
    ),
    kinds.join(',')
  )
  check(
    'structure preview finds missing index',
    structurePreview.changes.some(
      (c) => c.kind === 'createIndex' && c.object === 'idx_customers_name'
    )
  )
  check(
    'structure preview finds extra table',
    structurePreview.changes.some(
      (c) => c.kind === 'dropTable' && c.table === 'extra_in_target'
    )
  )
  check(
    'structure preview leaves identical table alone',
    !structurePreview.changes.some((c) => c.table === 'orders'),
    structurePreview.changes
      .filter((c) => c.table === 'orders')
      .map((c) => c.kind)
      .join(',')
  )
  check(
    'structure preview reports target engine',
    structurePreview.targetEngine === 'sqlite',
    structurePreview.targetEngine
  )

  const structureDry = await structureSync(
    client,
    {
      syncId: 'dry-structure',
      ...endpoints,
      tables: [],
      options: { ...DEFAULT_STRUCTURE_OPTIONS, dropExtraTables: true },
      dryRun: true
    },
    {}
  )
  check(
    'structure dry run writes nothing',
    structureDry.dryRun && structureDry.applied === 0 && structureDry.statements === 0,
    `${structureDry.applied}/${structureDry.statements}`
  )
  const stillMissing = await client.call<{ name: string }[]>('listTables', {
    connectionId: targetConn.id,
    database: 'main'
  })
  check(
    'structure dry run leaves target untouched',
    !stillMissing.some((t) => t.name === 'only_in_source')
  )

  const progressEvents: SyncProgress[] = []
  const structureRun = await structureSync(
    client,
    {
      syncId: 'run-structure',
      ...endpoints,
      tables: [],
      options: { ...DEFAULT_STRUCTURE_OPTIONS, dropExtraTables: true },
      dryRun: false
    },
    { onProgress: (progress) => void progressEvents.push(progress) }
  )
  check(
    'structure deploy applies changes',
    structureRun.failed === 0 && structureRun.applied > 0,
    `${structureRun.applied} applied, ${structureRun.statements} statements, ${structureRun.failed} failed`
  )
  check(
    'structure deploy emits progress',
    progressEvents.some((p) => p.phase === 'deploying') &&
      progressEvents.some((p) => p.phase === 'done'),
    progressEvents.map((p) => p.phase).join(',')
  )

  const afterStructure = await client.call<{ name: string }[]>('listTables', {
    connectionId: targetConn.id,
    database: 'main'
  })
  check(
    'structure deploy created the table',
    afterStructure.some((t) => t.name === 'only_in_source')
  )
  check(
    'structure deploy dropped the extra table',
    !afterStructure.some((t) => t.name === 'extra_in_target')
  )
  const targetIndexes = await client.call<{ name: string }[]>('listIndexes', {
    connectionId: targetConn.id,
    database: 'main',
    table: 'customers'
  })
  check(
    'structure deploy created the index',
    targetIndexes.some((i) => i.name === 'idx_customers_name'),
    targetIndexes.map((i) => i.name).join(',')
  )

  // SQLite column changes must be reported, never applied by rebuilding.
  const sqliteAlter = await previewStructureSync(client, {
    ...endpoints,
    tables: ['type_change'],
    options: { ...DEFAULT_STRUCTURE_OPTIONS, alterColumns: true }
  })
  check(
    'SQLite reports alter as unsupported instead of rebuilding',
    sqliteAlter.changes.some(
      (c) => c.kind === 'modifyColumn' && c.severity === 'unsupported'
    ),
    sqliteAlter.changes.map((c) => `${c.kind}:${c.severity}`).join(',')
  )

  // Data preview: insert, update, delete counts; table without PK unsupported.
  // A table that appears only after the structure deploy proves data sync does
  // not invent a target table: it must be reported, not written.
  await client.call('runQuery', {
    connectionId: sourceConn.id,
    database: 'main',
    sql: 'CREATE TABLE late_source (id INTEGER PRIMARY KEY, label TEXT)'
  })
  const dataPreview = await previewDataSync(client, {
    ...endpoints,
    tables: [],
    options: { ...DEFAULT_DATA_OPTIONS, deleteExtra: true }
  })
  const customers = dataPreview.tables.find((t) => t.table === 'customers')
  check(
    'data preview counts insert/update/delete',
    customers?.inserts === 1 && customers?.updates === 1 && customers?.deletes === 1,
    JSON.stringify(customers)
  )
  const audit = dataPreview.tables.find((t) => t.table === 'audit_log')
  check(
    'data preview rejects table without primary key',
    audit?.status === 'unsupported' && Boolean(audit.reason),
    audit?.reason
  )
  const orders = dataPreview.tables.find((t) => t.table === 'orders')
  check(
    'data preview finds one missing order',
    orders?.inserts === 1 && orders?.updates === 0 && orders?.deletes === 0,
    JSON.stringify(orders)
  )
  const lateSource = dataPreview.tables.find((t) => t.table === 'late_source')
  check(
    'data preview reports a source-only table instead of writing it',
    lateSource?.status === 'missing' && lateSource.inserts === 0,
    JSON.stringify(lateSource)
  )

  const dataDry = await dataSync(
    client,
    {
      syncId: 'dry-data',
      ...endpoints,
      tables: ['orders'],
      options: { ...DEFAULT_DATA_OPTIONS, deleteExtra: true },
      dryRun: true
    },
    {}
  )
  check(
    'data dry run writes nothing',
    dataDry.dryRun && dataDry.inserted === 0,
    `${dataDry.inserted} inserted`
  )
  const ordersBefore = await client.call<{ total: number }>('selectRows', {
    connectionId: targetConn.id,
    database: 'main',
    table: 'orders',
    limit: 10,
    offset: 0
  })
  check(
    'data dry run leaves rows untouched',
    ordersBefore.total === 1,
    String(ordersBefore.total)
  )

  const dataRun = await dataSync(
    client,
    {
      syncId: 'run-data',
      ...endpoints,
      tables: [],
      options: { ...DEFAULT_DATA_OPTIONS, deleteExtra: true },
      dryRun: false
    },
    {}
  )
  check(
    'data deploy applies insert/update/delete',
    dataRun.failed === 0 &&
      dataRun.inserted === 2 &&
      dataRun.updated === 1 &&
      dataRun.deleted === 1,
    JSON.stringify({
      inserted: dataRun.inserted,
      updated: dataRun.updated,
      deleted: dataRun.deleted,
      failed: dataRun.failed,
      errors: dataRun.errors
    })
  )
  check(
    'data deploy warns about the table it cannot create',
    dataRun.warnings.some((w) => w.includes('late_source')),
    dataRun.warnings.join(' | ')
  )

  const afterData = await client.call<{
    rows: Record<string, unknown>[]
    total: number
  }>('selectRows', {
    connectionId: targetConn.id,
    database: 'main',
    table: 'customers',
    limit: 10,
    offset: 0,
    orderBy: 'id'
  })
  check(
    'data deploy updated the changed row',
    afterData.rows.some((r) => r.id === 2 && r.name === 'Budi'),
    JSON.stringify(afterData.rows.map((r) => r.name))
  )
  check('data deploy removed the extra row', !afterData.rows.some((r) => r.id === 9))

  const secondPreview = await previewDataSync(client, {
    ...endpoints,
    tables: ['customers', 'orders'],
    options: { ...DEFAULT_DATA_OPTIONS, deleteExtra: true }
  })
  check(
    'second preview reports no differences',
    secondPreview.tables.every((t) => t.status === 'same'),
    secondPreview.tables.map((t) => `${t.table}:${t.status}`).join(',')
  )

  // Cancellation lands between tables: the first progress callback returns false.
  const cancelRun = await dataSync(
    client,
    {
      syncId: 'cancel-data',
      ...endpoints,
      tables: ['customers'],
      options: { ...DEFAULT_DATA_OPTIONS, deleteExtra: true },
      dryRun: false
    },
    { onProgress: () => false }
  )
  check(
    'data sync honours cancellation before writing',
    cancelRun.inserted === 0 &&
      cancelRun.updated === 0 &&
      cancelRun.deleted === 0 &&
      cancelRun.warnings.some((w) => w.includes('Dibatalkan')),
    cancelRun.warnings.join(' | ')
  )

  // Profiles: save, list, update in place, delete.
  const savedProfile = await saveSyncProfile({
    name: 'Source ke Target',
    mode: 'structure',
    source: endpoints.source,
    target: endpoints.target,
    tables: ['customers'],
    structureOptions: DEFAULT_STRUCTURE_OPTIONS
  })
  const listed = await listSyncProfiles()
  check(
    'profile save and list',
    listed.some((p) => p.id === savedProfile.id && p.name === 'Source ke Target'),
    `${listed.length} profiles`
  )
  const updated = await saveSyncProfile({
    id: savedProfile.id,
    name: 'Source ke Target (data)',
    mode: 'data',
    source: endpoints.source,
    target: endpoints.target,
    tables: [],
    dataOptions: DEFAULT_DATA_OPTIONS
  })
  const listedAgain = await listSyncProfiles()
  check(
    'profile update keeps one entry',
    listedAgain.length === 1 && listedAgain[0].name === updated.name,
    `${listedAgain.length} profiles`
  )
  await deleteSyncProfile(savedProfile.id)
  check('profile delete', (await listSyncProfiles()).length === 0)

  await client.call('disconnect', { connectionId: sourceConn.id })
  await client.call('disconnect', { connectionId: targetConn.id })
  await client.terminate()
  await rm(dir, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
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
