import type {
  ColumnInfo,
  DbEngine,
  TransferColumnMapping,
  TransferProgress,
  TransferRequest,
  TransferResult
} from '@shared/types'
import { buildDdl } from '@shared/ddl'
import { mapColumnType } from '@shared/typeMap'
import { DbWorkerClient } from '../workers/dbWorkerClient'
import { getConnectionConfig } from '../connection/store'

const MAX_BATCH = 2000
const MIN_BATCH = 1

export interface TransferContext {
  // Called between batches so the caller can surface progress. Returning false
  // cancels the transfer after the current batch.
  onProgress?: (progress: TransferProgress) => boolean | void
}

function clampBatch(size: number): number {
  if (!Number.isFinite(size)) return 500
  return Math.min(MAX_BATCH, Math.max(MIN_BATCH, Math.floor(size)))
}

function isNumericType(dataType: string): boolean {
  const t = dataType.toLowerCase()
  return (
    t.includes('int') ||
    t.includes('serial') ||
    t.includes('numeric') ||
    t.includes('decimal') ||
    t.includes('number') ||
    t.includes('real') ||
    t.includes('double') ||
    t.includes('float') ||
    t.includes('money')
  )
}

function isBooleanType(dataType: string): boolean {
  return dataType.toLowerCase().includes('bool')
}

function isTextType(dataType: string): boolean {
  const t = dataType.toLowerCase()
  return (
    t.includes('char') ||
    t.includes('text') ||
    t.includes('clob') ||
    t.includes('json') ||
    t.includes('enum') ||
    t.includes('uuid') ||
    t.includes('xml')
  )
}

// Copying between engines means the destination type is the authority for how a
// value must be encoded. A boolean from Postgres (true/false) becomes 1/0 for a
// SQLite INTEGER column, and a numeric string becomes a number where needed.
export function coerceForTarget(
  value: unknown,
  targetType: string,
  targetEngine: DbEngine
): unknown {
  if (value === null || value === undefined) return null

  if (typeof value === 'boolean') {
    if (isBooleanType(targetType)) return targetEngine === 'sqlite' ? (value ? 1 : 0) : value
    if (isNumericType(targetType)) return value ? 1 : 0
    return value ? 'true' : 'false'
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value as Uint8Array)
  }

  if (typeof value === 'object') {
    // JSON/array values from Postgres and Mongo arrive as objects. Text targets
    // get JSON text; SQLite gets the same because it has no native type.
    if (isTextType(targetType) || targetEngine === 'sqlite' || isNumericType(targetType)) {
      return JSON.stringify(value)
    }
    return value
  }

  if (typeof value === 'string') {
    if (isBooleanType(targetType)) {
      if (/^(true|1)$/i.test(value)) return targetEngine === 'sqlite' ? 1 : true
      if (/^(false|0)$/i.test(value)) return targetEngine === 'sqlite' ? 0 : false
    }
    if (isNumericType(targetType) && /^-?\d+(\.\d+)?$/.test(value)) {
      return Number(value)
    }
    if (targetEngine === 'sqlite' && isBooleanType(targetType)) {
      return value ? 1 : 0
    }
  }

  if (typeof value === 'number' && isTextType(targetType)) {
    return String(value)
  }

  return value
}

function activeMappings(mapping: TransferColumnMapping[]): TransferColumnMapping[] {
  return mapping.filter((m) => m.include && m.source.trim() && m.target.trim())
}

function validateMapping(
  mapping: TransferColumnMapping[],
  sourceColumns: ColumnInfo[],
  targetColumns: ColumnInfo[] | null
): string[] {
  const warnings: string[] = []
  const active = activeMappings(mapping)
  if (active.length === 0) {
    throw new Error('Pilih minimal satu kolom untuk dipindahkan.')
  }

  const sourceNames = new Set(sourceColumns.map((c) => c.name))
  const targetNames = new Set((targetColumns ?? []).map((c) => c.name))
  const usedTargets = new Set<string>()

  for (const m of active) {
    if (!sourceNames.has(m.source)) {
      throw new Error(`Kolom sumber "${m.source}" tidak ada di tabel sumber.`)
    }
    if (usedTargets.has(m.target)) {
      throw new Error(`Kolom tujuan "${m.target}" dipakai lebih dari sekali.`)
    }
    usedTargets.add(m.target)
    if (targetColumns && !targetNames.has(m.target)) {
      throw new Error(`Kolom tujuan "${m.target}" tidak ada di tabel tujuan.`)
    }
  }

  if (targetColumns) {
    for (const column of targetColumns) {
      if (column.nullable || column.autoIncrement) continue
      if (column.defaultValue !== null && column.defaultValue !== '') continue
      if (!usedTargets.has(column.name)) {
        warnings.push(
          `Kolom tujuan "${column.name}" wajib diisi tapi tidak dipetakan; insert bisa gagal.`
        )
      }
    }
  }

  return warnings
}

function buildCreateTable(
  engine: DbEngine,
  sourceEngine: DbEngine,
  target: TransferRequest['target'],
  columns: ColumnInfo[]
): string[] {
  return buildDdl(engine, {
    kind: 'createTable',
    database: target.database,
    schema: target.schema,
    table: target.table,
    columns: columns.map((c) => ({
      name: c.name,
      // The source type is only valid in the source engine; a cross-engine
      // transfer needs the closest target type instead.
      dataType: mapColumnType(sourceEngine, engine, c.dataType),
      nullable: c.nullable,
      // The primary key is not copied: transferring into a fresh table should
      // not inherit identity/uniqueness that the source happened to have.
      primaryKey: false,
      autoIncrement: false,
      defaultValue: undefined
    }))
  })
}

async function tableExists(
  client: DbWorkerClient,
  req: TransferRequest['target']
): Promise<boolean> {
  const tables = await client.call<{ name: string }[]>('listTables', {
    connectionId: req.connectionId,
    database: req.database,
    schema: req.schema
  })
  return tables.some((t) => t.name === req.table)
}

export interface TransferPreviewResult {
  sourceEngine: DbEngine
  targetEngine: DbEngine
  sourceColumns: ColumnInfo[]
  targetColumns: ColumnInfo[] | null
  targetExists: boolean
  suggestedMapping: TransferColumnMapping[]
  rowCount: number
  warnings: string[]
  // Type each source column will get in a newly created target table. Empty
  // when the target already exists (its own types are authoritative then).
  plannedTypes: Record<string, string>
}

// Builds the mapping table the UI shows before a transfer starts. Matching is
// by exact name only; a fuzzy guess could silently put data in the wrong column.
export async function previewTransfer(
  client: DbWorkerClient,
  request: {
    source: TransferRequest['source']
    target: TransferRequest['target']
  }
): Promise<TransferPreviewResult> {
  const sourceCfg = await getConnectionConfig(request.source.connectionId)
  const targetCfg = await getConnectionConfig(request.target.connectionId)
  if (!sourceCfg) throw new Error('Koneksi sumber tidak ditemukan.')
  if (!targetCfg) throw new Error('Koneksi tujuan tidak ditemukan.')

  const sourceColumns = await client.call<ColumnInfo[]>('listColumns', {
    connectionId: request.source.connectionId,
    database: request.source.database,
    table: request.source.table,
    schema: request.source.schema
  })

  const targetExists = await tableExists(client, request.target)
  const targetColumns = targetExists
    ? await client.call<ColumnInfo[]>('listColumns', {
        connectionId: request.target.connectionId,
        database: request.target.database,
        table: request.target.table,
        schema: request.target.schema
      })
    : null

  const targetNames = new Set((targetColumns ?? sourceColumns).map((c) => c.name))
  const suggestedMapping: TransferColumnMapping[] = sourceColumns.map((column) => ({
    source: column.name,
    target: targetNames.has(column.name) ? column.name : column.name,
    // Unmapped target columns stay off by default when the target already exists
    // and does not have that name.
    include: targetColumns ? targetNames.has(column.name) : true
  }))

  const warnings: string[] = []
  if (targetColumns) {
    for (const column of targetColumns) {
      if (column.nullable || column.autoIncrement) continue
      if (column.defaultValue !== null && column.defaultValue !== '') continue
      if (!suggestedMapping.some((m) => m.include && m.target === column.name)) {
        warnings.push(`Kolom tujuan "${column.name}" wajib diisi dan belum dipetakan.`)
      }
    }
    if (sourceCfg.engine !== targetCfg.engine) {
      warnings.push(
        `Beda engine (${sourceCfg.engine} → ${targetCfg.engine}): tipe data disesuaikan otomatis, periksa kolom biner dan tanggal.`
      )
    }
  }

  const counted = await client.call<{ rows: Record<string, unknown>[]; total: number }>(
    'selectRows',
    {
      connectionId: request.source.connectionId,
      database: request.source.database,
      schema: request.source.schema,
      table: request.source.table,
      limit: 1,
      offset: 0
    }
  )

  return {
    sourceEngine: sourceCfg.engine,
    targetEngine: targetCfg.engine,
    sourceColumns,
    targetColumns,
    targetExists,
    suggestedMapping,
    rowCount: counted.total,
    warnings,
    plannedTypes: targetColumns
      ? {}
      : Object.fromEntries(
          sourceColumns.map((c) => [c.name, mapColumnType(sourceCfg.engine, targetCfg.engine, c.dataType)])
        )
  }
}

export async function transferData(
  client: DbWorkerClient,
  request: TransferRequest,
  context: TransferContext = {}
): Promise<TransferResult> {
  const started = Date.now()
  const batchSize = clampBatch(request.batchSize)
  const warnings: string[] = []

  const sourceCfg = await getConnectionConfig(request.source.connectionId)
  const targetCfg = await getConnectionConfig(request.target.connectionId)
  if (!sourceCfg) throw new Error('Koneksi sumber tidak ditemukan.')
  if (!targetCfg) throw new Error('Koneksi tujuan tidak ditemukan.')

  context.onProgress?.({
    phase: 'preparing',
    rowsRead: 0,
    rowsWritten: 0,
    batches: 0,
    tableCreated: false,
    truncated: false,
    totalRows: null
  })

  const sourceColumns = await client.call<ColumnInfo[]>('listColumns', {
    connectionId: request.source.connectionId,
    database: request.source.database,
    table: request.source.table,
    schema: request.source.schema
  })

  const exists = await tableExists(client, request.target)
  let targetColumns: ColumnInfo[] | null = null
  if (exists) {
    targetColumns = await client.call<ColumnInfo[]>('listColumns', {
      connectionId: request.target.connectionId,
      database: request.target.database,
      table: request.target.table,
      schema: request.target.schema
    })
  } else if (!request.target.createTable) {
    throw new Error(
      `Tabel tujuan "${request.target.table}" tidak ada. Aktifkan "buat tabel" bila ingin dibuatkan.`
    )
  }

  warnings.push(...validateMapping(request.mapping, sourceColumns, targetColumns))
  const mapping = activeMappings(request.mapping)

  // A truncate followed by a failed insert destroys data. Refuse the run when a
  // NOT NULL target column without a default is left unmapped.
  if (request.target.truncateFirst && targetColumns) {
    const mapped = new Set(mapping.map((m) => m.target))
    const missing = targetColumns.filter(
      (column) =>
        !column.nullable &&
        !column.autoIncrement &&
        (column.defaultValue === null || column.defaultValue === '') &&
        !mapped.has(column.name)
    )
    if (missing.length > 0) {
      throw new Error(
        `Tidak bisa mengosongkan tabel tujuan: kolom wajib belum dipetakan (${missing
          .map((c) => c.name)
          .join(', ')}). Data lama tidak dihapus.`
      )
    }
  }


  // Dry run: validate and count only. Nothing is created, truncated, or written.
  if (request.dryRun) {
    const counted = await client.call<{ rows: Record<string, unknown>[]; total: number }>(
      'selectRows',
      {
        connectionId: request.source.connectionId,
        database: request.source.database,
        schema: request.source.schema,
        table: request.source.table,
        limit: 1,
        offset: 0
      }
    )
    return {
      rowsRead: counted.total,
      rowsWritten: 0,
      batches: 0,
      tableCreated: false,
      truncated: false,
      durationMs: Date.now() - started,
      dryRun: true,
      warnings: [
        ...warnings,
        `Dry run: ${counted.total} baris akan dipindahkan, ${mapping.length} kolom dipetakan.`
      ]
    }
  }

  let tableCreated = false
  if (!exists) {
    const statements = buildCreateTable(
      targetCfg.engine,
      sourceCfg.engine,
      request.target,
      sourceColumns
    )
    for (const statement of statements) {
      await client.call('runQuery', {
        connectionId: request.target.connectionId,
        sql: statement,
        maxRows: 1,
        database: request.target.database,
        schema: request.target.schema
      })
    }
    tableCreated = true
  }

  // A created table has no rows yet, so a truncate is redundant there. When the
  // table already existed, only truncate after the mapping was validated above.
  let truncated = false
  if (request.target.truncateFirst && !tableCreated) {
    // Engine-aware quoting/schema qualification comes from the shared DDL
    // builder; a hand-written DELETE would break on MySQL backticks or a
    // schema-qualified Postgres table.
    const statements = buildDdl(targetCfg.engine, {
      kind: 'emptyTable',
      database: request.target.database,
      schema: request.target.schema,
      table: request.target.table
    })
    for (const statement of statements) {
      await client.call('runQuery', {
        connectionId: request.target.connectionId,
        sql: statement,
        maxRows: 1,
        database: request.target.database,
        schema: request.target.schema
      })
    }
    truncated = true
  }

  // Read the destination types once; a created table inherits the source types.
  const effectiveTargetColumns =
    targetColumns ??
    (await client.call<ColumnInfo[]>('listColumns', {
      connectionId: request.target.connectionId,
      database: request.target.database,
      table: request.target.table,
      schema: request.target.schema
    }))
  const targetTypeByName = new Map(effectiveTargetColumns.map((c) => [c.name, c.dataType]))

  let offset = 0
  let rowsRead = 0
  let rowsWritten = 0
  let batches = 0
  let cancelled = false

  for (;;) {
    const batch = await client.call<Record<string, unknown>[]>('fetchBatch', {
      connectionId: request.source.connectionId,
      database: request.source.database,
      schema: request.source.schema,
      table: request.source.table,
      limit: batchSize,
      offset
    })
    if (batch.length === 0) break

    rowsRead += batch.length
    const prepared = batch.map((row) => {
      const out: Record<string, unknown> = {}
      for (const m of mapping) {
        out[m.target] = coerceForTarget(
          row[m.source],
          targetTypeByName.get(m.target) ?? '',
          targetCfg.engine
        )
      }
      return out
    })

    const written = await client.call<number>('insertRows', {
      connectionId: request.target.connectionId,
      database: request.target.database,
      schema: request.target.schema,
      table: request.target.table,
      rows: prepared
    })
    rowsWritten += written
    batches += 1
    offset += batchSize

    const keepGoing = context.onProgress?.({
      phase: 'transferring',
      rowsRead,
      rowsWritten,
      batches,
      tableCreated,
      truncated,
      totalRows: null
    })
    if (keepGoing === false) {
      cancelled = true
      break
    }
    if (batch.length < batchSize) break
  }

  if (cancelled) {
    warnings.push(`Transfer dihentikan setelah ${rowsWritten} baris.`)
  }

  const result: TransferResult = {
    rowsRead,
    rowsWritten,
    batches,
    tableCreated,
    truncated,
    durationMs: Date.now() - started,
    dryRun: false,
    warnings
  }

  context.onProgress?.({
    phase: 'done',
    rowsRead,
    rowsWritten,
    batches,
    tableCreated,
    truncated,
    totalRows: rowsRead
  })

  return result
}
