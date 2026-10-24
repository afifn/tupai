import type {
  DbEngine,
  StructureChange,
  StructureSyncRequest,
  StructureSyncResult,
  SyncProgress,
  TableInfo,
  TableStructure
} from '@shared/types'
import { buildDdl } from '@shared/ddl'
import {
  planDroppedTableStructure,
  planTableStructure,
  sortChanges
} from '@shared/schemaDiff'
import { DbWorkerClient } from '../workers/dbWorkerClient'
import { getConnectionConfig } from '../connection/store'

export interface SyncContext {
  // Called between tables and between statements. Returning false cancels the
  // deploy after the current table, leaving already-applied changes in place.
  onProgress?: (progress: SyncProgress) => boolean | void
}

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
  // Views are not structure-synced in v1: their definition depends on routines
  // and ordering that the DDL builder does not model.
  return tables
    .filter((t) => t.type === 'table')
    .map((t) => t.name)
    .sort()
}

async function loadStructure(
  client: DbWorkerClient,
  connectionId: string,
  database: string,
  table: string,
  schema?: string
): Promise<TableStructure> {
  return client.call<TableStructure>('getTableStructure', {
    connectionId,
    database,
    table,
    schema
  })
}

function tableLocation(
  database: string,
  schema: string | undefined
): {
  database: string
  schema?: string
} {
  return schema ? { database, schema } : { database }
}

export interface StructurePreviewResult {
  sourceEngine: DbEngine
  targetEngine: DbEngine
  tables: {
    table: string
    status: 'missing' | 'extra' | 'different' | 'same'
    changeCount: number
  }[]
  changes: StructureChange[]
  warnings: string[]
}

// Builds the change list the panel shows. The same function is used for the
// deploy step, so what the user previews is exactly what runs.
export async function previewStructureSync(
  client: DbWorkerClient,
  request: Omit<StructureSyncRequest, 'syncId' | 'dryRun'>
): Promise<StructurePreviewResult> {
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
    throw new Error('Sinkronisasi struktur tidak berlaku untuk MongoDB.')
  }

  const [sourceTables, targetTables] = await Promise.all([
    listTableNames(client, request.source.connectionId, source.database, source.schema),
    listTableNames(client, request.target.connectionId, target.database, target.schema)
  ])

  const sourceSet = new Set(sourceTables)
  const targetSet = new Set(targetTables)
  // An explicit table list limits the run to what the user selected. Without a
  // selection every source table is compared, which is the useful default.
  const selected =
    request.tables.length > 0
      ? request.tables.filter((t) => sourceSet.has(t))
      : sourceTables
  const extraTables =
    request.tables.length > 0 ? [] : targetTables.filter((t) => !sourceSet.has(t))

  const changes: StructureChange[] = []
  const warnings: string[] = []
  const tables: StructurePreviewResult['tables'] = []

  for (const table of selected) {
    const sourceStructure = await loadStructure(
      client,
      request.source.connectionId,
      source.database,
      table,
      source.schema
    )
    const targetStructure = targetSet.has(table)
      ? await loadStructure(
          client,
          request.target.connectionId,
          target.database,
          table,
          target.schema
        )
      : null

    const plan = planTableStructure(
      source.engine,
      target.engine,
      sourceStructure,
      targetStructure,
      target.database,
      target.schema,
      request.options
    )
    for (const warning of plan.warnings) {
      if (!warnings.includes(warning)) warnings.push(warning)
    }
    changes.push(...plan.changes)
    tables.push({
      table,
      status: targetStructure
        ? plan.changes.length > 0
          ? 'different'
          : 'same'
        : 'missing',
      changeCount: plan.changes.length
    })
  }

  for (const table of extraTables) {
    const structure = await loadStructure(
      client,
      request.target.connectionId,
      target.database,
      table,
      target.schema
    )
    const change = planDroppedTableStructure(
      target.engine,
      structure,
      target.database,
      target.schema,
      request.options
    )
    changes.push(change)
    tables.push({ table, status: 'extra', changeCount: 1 })
  }

  // Deploy order is fixed regardless of how the diff was discovered: creating
  // and widening before dropping means a failure midway never leaves the target
  // with less data than it started with.
  const ordered = sortChanges(changes)

  return {
    sourceEngine: source.engine,
    targetEngine: target.engine,
    tables: tables.sort((a, b) => a.table.localeCompare(b.table)),
    changes: ordered,
    warnings
  }
}

function executableChanges(changes: StructureChange[]): StructureChange[] {
  return changes.filter((c) => c.operations.length > 0 && c.severity !== 'unsupported')
}

export async function structureSync(
  client: DbWorkerClient,
  request: StructureSyncRequest,
  context: SyncContext = {}
): Promise<StructureSyncResult> {
  const started = Date.now()
  const warnings: string[] = []
  const errors: string[] = []

  const preview = await previewStructureSync(client, request)
  warnings.push(...preview.warnings)
  const runnable = executableChanges(preview.changes)
  const skipped = preview.changes.length - runnable.length

  const total = runnable.length
  const emit = (phase: SyncProgress['phase'], done: number, table?: string): boolean => {
    const keepGoing = context.onProgress?.({
      syncId: request.syncId,
      mode: 'structure',
      phase,
      table,
      tablesDone: done,
      tablesTotal: total,
      statements: 0,
      inserted: 0,
      updated: 0,
      deleted: 0
    })
    return keepGoing !== false
  }

  if (request.dryRun) {
    emit('done', total)
    return {
      applied: 0,
      failed: 0,
      skipped,
      statements: 0,
      durationMs: Date.now() - started,
      dryRun: true,
      warnings: [
        ...warnings,
        `Dry run: ${total} perubahan siap dijalankan, ${skipped} dilewati (tidak didukung atau opsi nonaktif).`
      ],
      errors
    }
  }

  if (!emit('preparing', 0)) {
    return {
      applied: 0,
      failed: 0,
      skipped,
      statements: 0,
      durationMs: Date.now() - started,
      dryRun: false,
      warnings: [...warnings, 'Dibatalkan sebelum ada perubahan dijalankan.'],
      errors
    }
  }

  const engine = preview.targetEngine
  let applied = 0
  let failed = 0
  let statements = 0
  let cancelled = false

  for (const [index, change] of runnable.entries()) {
    try {
      for (const operation of change.operations) {
        for (const statement of buildDdl(engine, operation)) {
          await client.call('runQuery', {
            connectionId: request.target.connectionId,
            sql: statement,
            maxRows: 1,
            ...tableLocation(request.target.database, request.target.schema)
          })
          statements += 1
        }
      }
      applied += 1
    } catch (err) {
      failed += 1
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`${change.table} (${change.kind}): ${message}`)
      // A failure stops the run: continuing could drop a column the failed
      // statement was supposed to replace.
      warnings.push(`Dihentikan pada "${change.table}" setelah ${applied} perubahan.`)
      break
    }

    const keepGoing = context.onProgress?.({
      syncId: request.syncId,
      mode: 'structure',
      phase: 'deploying',
      table: change.table,
      tablesDone: index + 1,
      tablesTotal: total,
      statements,
      inserted: 0,
      updated: 0,
      deleted: 0
    })
    if (keepGoing === false) {
      cancelled = true
      break
    }
  }

  if (cancelled) warnings.push(`Dibatalkan setelah ${applied} perubahan.`)

  context.onProgress?.({
    syncId: request.syncId,
    mode: 'structure',
    phase: 'done',
    tablesDone: applied,
    tablesTotal: total,
    statements,
    inserted: 0,
    updated: 0,
    deleted: 0
  })

  return {
    applied,
    failed,
    skipped,
    statements,
    durationMs: Date.now() - started,
    dryRun: false,
    warnings,
    errors
  }
}
