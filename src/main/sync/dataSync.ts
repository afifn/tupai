import type {
  DataSyncRequest,
  DataSyncResult,
  DataTableDiff,
  DbEngine,
  PageQuery,
  SyncProgress,
  TableInfo
} from '@shared/types'
import { comparableColumns, diffRows, type DiffColumn } from '@shared/dataDiff'
import { DbWorkerClient } from '../workers/dbWorkerClient'
import { getConnectionConfig } from '../connection/store'
import type { SyncContext } from './structureSync'

interface EndpointInfo {
  engine: DbEngine
  database: string
  schema?: string
}

async function resolveEndpoint(
  connectionId: string,
  database: string,
  schema: string | undefined
): Promise<EndpointInfo> {
  const cfg = await getConnectionConfig(connectionId)
  if (!cfg) throw new Error(`Koneksi tidak ditemukan: ${connectionId}`)
  return { engine: cfg.engine, database, schema }
}

async function listTableNames(
  client: DbWorkerClient,
  connectionId: string,
  database: string,
  schema?: string
): Promise<string[]> {
  const tables = await client.call<TableInfo[]>('listTables', {
    connectionId,
    database,
    schema
  })
  return tables
    .filter((t) => t.type === 'table')
    .map((t) => t.name)
    .sort()
}

async function primaryKeysOf(
  client: DbWorkerClient,
  connectionId: string,
  database: string,
  table: string,
  schema?: string
): Promise<string[]> {
  const pk = await client.call<{ columns: string[] } | null>('getPrimaryKey', {
    connectionId,
    database,
    table,
    schema
  })
  return pk?.columns ?? []
}

// Reads one table in ordered batches. `orderByColumns` is the primary key so
// two batches never overlap or skip rows; paging by offset without a total
// order is exactly how a sync silently duplicates data.
async function readAllRows(
  client: DbWorkerClient,
  endpoint: { connectionId: string; database: string; schema?: string },
  table: string,
  orderByColumns: string[],
  limit: number,
  batchSize: number
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const rows: Record<string, unknown>[] = []
  let offset = 0
  // Read one row past the cap: a table whose row count equals the cap is not
  // truncated, and reporting it as truncated would hide the last page.
  const max = limit + 1
  for (;;) {
    const batch = await client.call<Record<string, unknown>[]>('fetchBatch', {
      connectionId: endpoint.connectionId,
      database: endpoint.database,
      schema: endpoint.schema,
      table,
      limit: batchSize,
      offset,
      orderByColumns
    } satisfies PageQuery)
    if (batch.length === 0) break
    rows.push(...batch)
    offset += batch.length
    if (rows.length >= max) {
      return { rows: rows.slice(0, limit), truncated: rows.length > limit }
    }
    if (batch.length < batchSize) break
  }
  return { rows, truncated: false }
}

interface TablePlan {
  table: string
  diff: DataTableDiff
  columns: DiffColumn[]
  primaryKeys: string[]
  inserts: Record<string, unknown>[]
  updates: { primaryKeys: Record<string, unknown>; changes: Record<string, unknown> }[]
  deletes: Record<string, unknown>[]
}

function emptyDiff(table: string, status: DataTableDiff['status']): DataTableDiff {
  return {
    table,
    status,
    inserts: 0,
    updates: 0,
    deletes: 0,
    unchanged: 0,
    primaryKeys: [],
    truncated: false
  }
}

async function planTable(
  client: DbWorkerClient,
  request: Pick<DataSyncRequest, 'source' | 'target' | 'options'>,
  table: string,
  targetTables: Set<string>
): Promise<TablePlan> {
  const sourcePk = await primaryKeysOf(
    client,
    request.source.connectionId,
    request.source.database,
    table,
    request.source.schema
  )
  if (sourcePk.length === 0) {
    return {
      table,
      diff: {
        ...emptyDiff(table, 'unsupported'),
        reason: 'Tabel sumber tidak punya primary key, jadi baris tidak bisa dipasangkan.'
      },
      columns: [],
      primaryKeys: [],
      inserts: [],
      updates: [],
      deletes: []
    }
  }

  const sourceColumns = await client.call<{ name: string; dataType: string }[]>(
    'listColumns',
    {
      connectionId: request.source.connectionId,
      database: request.source.database,
      table,
      schema: request.source.schema
    }
  )

  if (!targetTables.has(table)) {
    return {
      table,
      diff: {
        ...emptyDiff(table, 'missing'),
        primaryKeys: sourcePk,
        reason: 'Tabel belum ada di target; jalankan Structure Sync dulu.'
      },
      columns: [],
      primaryKeys: sourcePk,
      inserts: [],
      updates: [],
      deletes: []
    }
  }

  const targetColumns = await client.call<{ name: string; dataType: string }[]>(
    'listColumns',
    {
      connectionId: request.target.connectionId,
      database: request.target.database,
      table,
      schema: request.target.schema
    }
  )
  const targetPk = await primaryKeysOf(
    client,
    request.target.connectionId,
    request.target.database,
    table,
    request.target.schema
  )
  if (targetPk.length === 0) {
    return {
      table,
      diff: {
        ...emptyDiff(table, 'unsupported'),
        primaryKeys: sourcePk,
        reason: 'Tabel target tidak punya primary key.'
      },
      columns: [],
      primaryKeys: sourcePk,
      inserts: [],
      updates: [],
      deletes: []
    }
  }

  const columns = comparableColumns(sourceColumns, targetColumns)
  const targetColumnNames = new Set(targetColumns.map((c) => c.name.toLowerCase()))
  const missingPk = sourcePk.filter((key) => !targetColumnNames.has(key.toLowerCase()))
  if (missingPk.length > 0) {
    return {
      table,
      diff: {
        ...emptyDiff(table, 'unsupported'),
        primaryKeys: sourcePk,
        reason: `Kolom primary key tidak ada di target: ${missingPk.join(', ')}.`
      },
      columns,
      primaryKeys: sourcePk,
      inserts: [],
      updates: [],
      deletes: []
    }
  }

  const limit = request.options.maxRowsPerTable
  const batchSize = request.options.batchSize
  const [sourceRead, targetRead] = await Promise.all([
    readAllRows(client, request.source, table, sourcePk, limit, batchSize),
    readAllRows(client, request.target, table, targetPk, limit, batchSize)
  ])

  const diff = diffRows({
    sourceRows: sourceRead.rows,
    targetRows: targetRead.rows,
    columns,
    primaryKeys: sourcePk,
    options: request.options
  })

  const truncated = sourceRead.truncated || targetRead.truncated
  const reasons: string[] = []
  if (truncated) {
    reasons.push(
      `Dibatasi ${limit} baris per tabel; perbesar "Maks baris" atau sinkronkan per tabel.`
    )
  }
  if (diff.duplicateKeys.length > 0) {
    reasons.push(
      `${diff.duplicateKeys.length} primary key duplikat di sumber/target; baris duplikat dilewati.`
    )
  }

  const status: DataTableDiff['status'] =
    diff.inserts.length === 0 && diff.updates.length === 0 && diff.deletes.length === 0
      ? 'same'
      : 'different'

  return {
    table,
    diff: {
      table,
      status,
      inserts: diff.inserts.length,
      updates: diff.updates.length,
      deletes: diff.deletes.length,
      unchanged: diff.unchanged,
      primaryKeys: sourcePk,
      truncated,
      reason: reasons.length > 0 ? reasons.join(' ') : undefined
    },
    columns,
    primaryKeys: sourcePk,
    inserts: diff.inserts,
    updates: diff.updates,
    deletes: diff.deletes
  }
}

function tableSelection(
  request: Pick<DataSyncRequest, 'tables'>,
  sourceTables: string[],
  targetTables: string[]
): string[] {
  const sourceSet = new Set(sourceTables)
  const targetSet = new Set(targetTables)
  if (request.tables.length > 0) {
    return request.tables.filter((t) => sourceSet.has(t) || targetSet.has(t))
  }
  return [...new Set([...sourceTables, ...targetTables])].sort()
}

export interface DataPreviewResult {
  sourceEngine: DbEngine
  targetEngine: DbEngine
  tables: DataTableDiff[]
  warnings: string[]
}

export async function previewDataSync(
  client: DbWorkerClient,
  request: Omit<DataSyncRequest, 'syncId' | 'dryRun'>
): Promise<DataPreviewResult> {
  const source = await resolveEndpoint(
    request.source.connectionId,
    request.source.database,
    request.source.schema
  )
  const target = await resolveEndpoint(
    request.target.connectionId,
    request.target.database,
    request.target.schema
  )
  if (source.engine === 'mongodb' || target.engine === 'mongodb') {
    throw new Error('Sinkronisasi data tidak berlaku untuk MongoDB.')
  }

  const [sourceTables, targetTables] = await Promise.all([
    listTableNames(client, request.source.connectionId, source.database, source.schema),
    listTableNames(client, request.target.connectionId, target.database, target.schema)
  ])
  const tables = tableSelection(request, sourceTables, targetTables)
  if (tables.length === 0) {
    throw new Error('Tidak ada tabel untuk dibandingkan. Pilih minimal satu tabel.')
  }

  const warnings: string[] = []
  if (source.engine !== target.engine) {
    warnings.push(
      `Beda engine (${source.engine} → ${target.engine}): nilai dibandingkan setelah normalisasi tipe, tetapi kolom biner dan tanggal eksotis tetap perlu diperiksa.`
    )
  }

  const targetSet = new Set(targetTables)
  const plans: DataTableDiff[] = []
  for (const table of tables) {
    const plan = await planTable(client, request, table, targetSet)
    plans.push(plan.diff)
    if (plan.diff.truncated) {
      warnings.push(
        `${table}: perbandingan dibatasi ${request.options.maxRowsPerTable} baris.`
      )
    }
  }

  return {
    sourceEngine: source.engine,
    targetEngine: target.engine,
    tables: plans,
    warnings
  }
}

export async function dataSync(
  client: DbWorkerClient,
  request: DataSyncRequest,
  context: SyncContext = {}
): Promise<DataSyncResult> {
  const started = Date.now()
  const warnings: string[] = []
  const errors: string[] = []

  const preview = await previewDataSync(client, request)
  warnings.push(...preview.warnings)

  // A table that exists only at the source is not created by data sync; saying so
  // once is clearer than counting it as a table that will be written.
  const missingTables = preview.tables.filter((t) => t.status === 'missing')
  if (missingTables.length > 0) {
    warnings.push(
      `${missingTables.length} tabel belum ada di target dan dilewati (${missingTables
        .map((t) => t.table)
        .join(', ')}). Jalankan Structure Sync dulu.`
    )
  }
  const runnable = preview.tables.filter((t) => t.status === 'different')
  const total = runnable.length

  const emit = (phase: SyncProgress['phase'], table?: string, index = 0): boolean => {
    const keepGoing = context.onProgress?.({
      syncId: request.syncId,
      mode: 'data',
      phase,
      table,
      tablesDone: index,
      tablesTotal: total,
      statements: 0,
      inserted: 0,
      updated: 0,
      deleted: 0
    })
    return keepGoing !== false
  }

  if (request.dryRun) {
    const totals = preview.tables.reduce(
      (sum, t) => ({
        inserts: sum.inserts + t.inserts,
        updates: sum.updates + t.updates,
        deletes: sum.deletes + t.deletes
      }),
      { inserts: 0, updates: 0, deletes: 0 }
    )
    emit('done')
    return {
      tables: preview.tables,
      inserted: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      durationMs: Date.now() - started,
      dryRun: true,
      warnings: [
        ...warnings,
        `Dry run: ${totals.inserts} insert, ${totals.updates} update, ${totals.deletes} delete pada ${total} tabel.`
      ],
      errors
    }
  }

  if (!emit('preparing')) {
    return {
      tables: preview.tables,
      inserted: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      durationMs: Date.now() - started,
      dryRun: false,
      warnings: [...warnings, 'Dibatalkan sebelum ada data ditulis.'],
      errors
    }
  }

  const sourceTables = new Set(
    await listTableNames(
      client,
      request.source.connectionId,
      request.source.database,
      request.source.schema
    )
  )
  const targetTables = new Set(
    await listTableNames(
      client,
      request.target.connectionId,
      request.target.database,
      request.target.schema
    )
  )

  let inserted = 0
  let updated = 0
  let deleted = 0
  let failed = 0
  let cancelled = false

  for (const [index, table] of runnable.entries()) {
    if (!sourceTables.has(table.table) || !targetTables.has(table.table)) continue

    try {
      const plan = await planTable(client, request, table.table, targetTables)
      if (plan.columns.length === 0) {
        warnings.push(`${table.table}: tidak ada kolom yang bisa dibandingkan, dilewati.`)
        continue
      }

      // Values are written through the driver, so each engine encodes its own
      // booleans, dates, and binary data. No SQL literals are built here.
      const result = await client.call<{
        deleted: number
        updated: number
        inserted: number
      }>('applyRowChanges', {
        connectionId: request.target.connectionId,
        database: request.target.database,
        schema: request.target.schema,
        table: table.table,
        deletes: plan.deletes,
        updates: plan.updates,
        inserts: plan.inserts
      })
      deleted += result.deleted
      updated += result.updated
      inserted += result.inserted

      const keepGoing = context.onProgress?.({
        syncId: request.syncId,
        mode: 'data',
        phase: 'deploying',
        table: table.table,
        tablesDone: index + 1,
        tablesTotal: total,
        statements: 0,
        inserted,
        updated,
        deleted
      })
      if (keepGoing === false) {
        cancelled = true
        break
      }
    } catch (err) {
      failed += 1
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`${table.table}: ${message}`)
      if (!request.options.continueOnError) {
        warnings.push(`Dihentikan pada "${table.table}" karena opsi berhenti saat gagal.`)
        break
      }
    }
  }

  if (cancelled)
    warnings.push(`Dibatalkan setelah ${inserted + updated + deleted} baris.`)

  context.onProgress?.({
    syncId: request.syncId,
    mode: 'data',
    phase: 'done',
    tablesDone: total,
    tablesTotal: total,
    statements: 0,
    inserted,
    updated,
    deleted
  })

  return {
    tables: preview.tables,
    inserted,
    updated,
    deleted,
    failed,
    durationMs: Date.now() - started,
    dryRun: false,
    warnings,
    errors
  }
}
