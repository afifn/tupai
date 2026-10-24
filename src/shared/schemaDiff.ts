import type {
  ColumnInfo,
  DdlColumnDef,
  DdlOperation,
  DbEngine,
  ForeignKeyInfo,
  IndexInfo,
  StructureChange,
  StructureSyncOptions,
  TableStructure
} from './types'
import { mapColumnType } from './typeMap'

// Structure diff is pure: it takes two metadata snapshots and returns changes
// whose `operations` feed the shared DDL builder. No SQL is written here, so the
// quoting and per-engine rules stay in one place (ddl.ts) and the planner can be
// unit tested without Electron or a live database.

interface ColumnPair {
  source: ColumnInfo
  target: ColumnInfo
  sourceName: string
  targetName: string
}

function normalizeType(type: string): string {
  return type.trim().toLowerCase().replace(/\s+/g, ' ')
}

function typeShape(type: string): string {
  const match = /\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/.exec(type)
  if (!match) return ''
  return match[2] !== undefined ? `(${match[1]},${match[2]})` : `(${match[1]})`
}

// Cross-engine type families that are safe to treat as the same shape. The
// planner never alters a column across engines; this list only decides whether
// an existing target column is reported as compatible.
const FAMILY_COMPATIBLE: Record<string, string[]> = {
  boolean: ['boolean', 'smallint', 'int'],
  smallint: ['smallint', 'int', 'boolean'],
  int: ['int', 'smallint', 'bigint', 'boolean'],
  bigint: ['bigint', 'int', 'decimal'],
  decimal: ['decimal', 'float', 'bigint'],
  float: ['float', 'decimal'],
  text: ['text', 'longtext', 'uuid', 'json'],
  longtext: ['longtext', 'text', 'json'],
  blob: ['blob'],
  date: ['date'],
  time: ['time'],
  datetime: ['datetime', 'timestamp', 'timestamptz'],
  timestamp: ['timestamp', 'datetime', 'timestamptz'],
  timestamptz: ['timestamptz', 'timestamp', 'datetime'],
  json: ['json', 'text', 'longtext'],
  uuid: ['uuid', 'text'],
  unknown: ['unknown']
}

export function typeFamily(type: string): string {
  const t = normalizeType(type)
  if (!t) return 'unknown'
  // Longer names first: `timestamp with time zone` contains `timestamp`, and
  // `datetime` contains `date`.
  if (t.includes('timestamptz') || t.includes('timestamp with time zone'))
    return 'timestamptz'
  if (t.includes('timestamp')) return 'timestamp'
  if (t.includes('datetime')) return 'datetime'
  if (t.includes('time')) return 'time'
  if (t.includes('bool') || /^tinyint\(\s*1\s*\)$/.test(t) || t === 'bit(1)')
    return 'boolean'
  if (t.includes('uuid') || t.includes('uniqueidentifier')) return 'uuid'
  if (t.includes('json')) return 'json'
  if (
    t.includes('blob') ||
    t.includes('bytea') ||
    t.includes('binary') ||
    t.includes('image')
  ) {
    return 'blob'
  }
  if (
    t.includes('clob') ||
    t.includes('longtext') ||
    t.includes('mediumtext') ||
    t.includes('ntext')
  ) {
    return 'longtext'
  }
  if (
    t.includes('char') ||
    t.includes('text') ||
    t.includes('varchar') ||
    t.includes('enum') ||
    t.includes('xml')
  ) {
    return 'text'
  }
  if (t.includes('bigint') || t.includes('bigserial') || t.includes('int8'))
    return 'bigint'
  if (t.includes('smallint') || t.includes('tinyint') || t.includes('int2'))
    return 'smallint'
  if (t.includes('int') || t.includes('serial')) return 'int'
  if (
    t.includes('numeric') ||
    t.includes('decimal') ||
    t.includes('number') ||
    t.includes('money')
  ) {
    return 'decimal'
  }
  if (
    t.includes('double') ||
    t.includes('float') ||
    t.includes('real') ||
    t.includes('binary_float') ||
    t.includes('binary_double')
  ) {
    return 'float'
  }
  if (t.includes('date')) return 'date'
  return 'unknown'
}

function typeCompatible(sourceType: string, targetType: string): boolean {
  const source = typeFamily(sourceType)
  const target = typeFamily(targetType)
  return source === target || (FAMILY_COMPATIBLE[source] ?? []).includes(target)
}

// A nextval() default belongs to a serial/identity column. Comparing it as text
// against an IDENTITY column would flag every Postgres primary key as changed.
function isSequenceDefault(value: string | null | undefined): boolean {
  if (!value) return false
  return /nextval\(|IDENTITY|GENERATED/i.test(value)
}

function normalizedDefault(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = value.trim()
  return text === '' ? null : text
}

function sameDefault(
  source: ColumnInfo,
  target: ColumnInfo,
  sameEngine: boolean
): boolean {
  // Defaults are engine expressions, not portable text. Across engines the
  // planner leaves them alone rather than copying a MySQL CURDATE() into Oracle.
  if (!sameEngine) return true
  if (source.autoIncrement && target.autoIncrement) return true
  if (isSequenceDefault(source.defaultValue) || isSequenceDefault(target.defaultValue)) {
    return Boolean(source.autoIncrement) === Boolean(target.autoIncrement)
  }
  return normalizedDefault(source.defaultValue) === normalizedDefault(target.defaultValue)
}

export function columnDefinition(
  targetEngine: DbEngine,
  sourceEngine: DbEngine,
  column: ColumnInfo,
  primaryKey: boolean
): DdlColumnDef {
  const sameEngine = targetEngine === sourceEngine
  return {
    name: column.name,
    // A source type is only valid in its own engine. Across engines the closest
    // target type is used; within one engine the declared length/precision is
    // preserved verbatim.
    dataType: sameEngine
      ? column.dataType
      : mapColumnType(sourceEngine, targetEngine, column.dataType),
    nullable: column.nullable,
    primaryKey,
    autoIncrement: column.autoIncrement === true,
    // Default expressions are engine-specific; copying one across engines can
    // produce invalid DDL. The column is created without a default instead.
    defaultValue:
      sameEngine && !column.autoIncrement
        ? (normalizedDefault(column.defaultValue) ?? undefined)
        : undefined
  }
}

function pkColumns(structure: TableStructure): string[] {
  return (
    structure.primaryKey?.columns ??
    structure.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
  )
}

function indexSignature(index: IndexInfo): string {
  return `${index.unique ? 'unique' : 'plain'}:${index.columns.join('|')}`
}

function fkSignature(fk: ForeignKeyInfo): string {
  return `${fk.columns.join('|')}>${fk.refTable}.${fk.refColumns.join('|')}:${fk.onDelete ?? ''}:${fk.onUpdate ?? ''}`
}

// Index and constraint names are unique per schema. Reusing a source name that
// the target already gives to a different object would make the CREATE fail, so
// a free name is derived instead.
function freeName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}_${i}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
  const fallback = `${base}_${Date.now()}`
  used.add(fallback)
  return fallback
}

function changeId(table: string, kind: string, object: string): string {
  return `${table}:${kind}:${object}`
}

function makeChange(
  table: string,
  kind: StructureChange['kind'],
  object: string,
  detail: string,
  severity: StructureChange['severity'],
  operations: DdlOperation[]
): StructureChange {
  return {
    id: changeId(table, kind, object),
    table,
    kind,
    object,
    detail,
    severity,
    operations
  }
}

interface PlanContext {
  sourceEngine: DbEngine
  targetEngine: DbEngine
  targetDatabase: string
  targetSchema?: string
  options: StructureSyncOptions
}

interface TableLocation {
  database: string
  schema?: string
  table: string
}

function tableLocation(ctx: PlanContext, table: string): TableLocation {
  return { database: ctx.targetDatabase, schema: ctx.targetSchema, table }
}

function createTableOperations(
  ctx: PlanContext,
  structure: TableStructure
): DdlOperation[] {
  const pk = pkColumns(structure)
  const operations: DdlOperation[] = [
    {
      kind: 'createTable',
      ...tableLocation(ctx, structure.name),
      columns: structure.columns.map((column) =>
        columnDefinition(
          ctx.targetEngine,
          ctx.sourceEngine,
          column,
          pk.includes(column.name)
        )
      )
    }
  ]

  if (ctx.options.syncIndexes) {
    // Only the implicit PK index is skipped, so its name is the only one that
    // must be avoided. Seeding the set with the source's own non-primary names
    // would make every index collide with itself.
    const used = new Set(structure.indexes.filter((i) => i.primary).map((i) => i.name))
    for (const index of structure.indexes) {
      if (index.primary) continue
      operations.push({
        kind: 'createIndex',
        ...tableLocation(ctx, structure.name),
        indexName: freeName(index.name, used),
        columns: index.columns,
        unique: index.unique
      })
    }
  }

  if (ctx.options.syncForeignKeys) {
    const used = new Set(structure.foreignKeys.map((f) => f.name))
    for (const fk of structure.foreignKeys) {
      operations.push({
        kind: 'createForeignKey',
        ...tableLocation(ctx, structure.name),
        name: freeName(fk.name, used),
        columns: fk.columns,
        refSchema: fk.refSchema,
        refTable: fk.refTable,
        refColumns: fk.refColumns,
        onUpdate: fk.onUpdate,
        onDelete: fk.onDelete
      })
    }
  }

  return operations
}

function planNewTable(ctx: PlanContext, structure: TableStructure): StructureChange[] {
  if (!ctx.options.createMissingTables) {
    return [
      makeChange(
        structure.name,
        'createTable',
        structure.name,
        'Tabel hanya ada di sumber; opsi "buat tabel" nonaktif.',
        'warning',
        []
      )
    ]
  }
  const changes: StructureChange[] = [
    makeChange(
      structure.name,
      'createTable',
      structure.name,
      `Tabel dibuat dengan ${structure.columns.length} kolom.`,
      'info',
      createTableOperations(ctx, structure)
    )
  ]
  // Index and FK operations ride along in the same change so a partial deploy
  // never leaves a created table without the keys the user asked for.
  return changes
}

function planDroppedTable(ctx: PlanContext, structure: TableStructure): StructureChange {
  if (!ctx.options.dropExtraTables) {
    return makeChange(
      structure.name,
      'dropTable',
      structure.name,
      'Tabel hanya ada di target; opsi "hapus tabel" nonaktif.',
      'warning',
      []
    )
  }
  return makeChange(
    structure.name,
    'dropTable',
    structure.name,
    'Tabel dihapus dari target. Semua barisnya hilang.',
    'destructive',
    [{ kind: 'dropTable', ...tableLocation(ctx, structure.name) }]
  )
}

function pairColumns(
  source: TableStructure,
  target: TableStructure
): { pairs: ColumnPair[]; sourceOnly: ColumnInfo[]; targetOnly: ColumnInfo[] } {
  const targetByName = new Map(target.columns.map((c) => [c.name, c]))
  const targetLower = new Map(target.columns.map((c) => [c.name.toLowerCase(), c]))
  const pairs: ColumnPair[] = []
  const sourceOnly: ColumnInfo[] = []
  const matchedTargets = new Set<string>()

  for (const column of source.columns) {
    const exact = targetByName.get(column.name)
    const loose = exact ?? targetLower.get(column.name.toLowerCase())
    if (!loose) {
      sourceOnly.push(column)
      continue
    }
    matchedTargets.add(loose.name)
    pairs.push({
      source: column,
      target: loose,
      sourceName: column.name,
      targetName: loose.name
    })
  }

  const targetOnly = target.columns.filter((c) => !matchedTargets.has(c.name))
  return { pairs, sourceOnly, targetOnly }
}

function planExistingTable(
  ctx: PlanContext,
  source: TableStructure,
  target: TableStructure
): StructureChange[] {
  const changes: StructureChange[] = []
  const table = source.name
  const sameEngine = ctx.sourceEngine === ctx.targetEngine
  const { pairs, sourceOnly, targetOnly } = pairColumns(source, target)

  if (ctx.options.addMissingColumns) {
    for (const column of sourceOnly) {
      const required = !column.nullable && !column.autoIncrement
      const hasDefault =
        normalizedDefault(column.defaultValue) !== null || column.autoIncrement === true
      changes.push(
        makeChange(
          table,
          'addColumn',
          column.name,
          required && !hasDefault
            ? `Kolom "${column.name}" wajib diisi tanpa default; ALTER bisa gagal bila tabel berisi data.`
            : `Kolom "${column.name}" (${column.dataType}) ditambahkan.`,
          required && !hasDefault ? 'warning' : 'info',
          [
            {
              kind: 'addColumn',
              ...tableLocation(ctx, table),
              column: columnDefinition(
                ctx.targetEngine,
                ctx.sourceEngine,
                column,
                pkColumns(source).includes(column.name)
              )
            }
          ]
        )
      )
    }
  } else {
    for (const column of sourceOnly) {
      changes.push(
        makeChange(
          table,
          'addColumn',
          column.name,
          `Kolom "${column.name}" hanya ada di sumber; opsi "tambah kolom" nonaktif.`,
          'warning',
          []
        )
      )
    }
  }

  // A column that exists in both but with a different case is not renamed:
  // renaming would break every query that uses the old spelling, and most
  // engines are case-insensitive anyway. It is only reported.
  for (const pair of pairs) {
    if (pair.sourceName !== pair.targetName) {
      changes.push(
        makeChange(
          table,
          'modifyColumn',
          pair.sourceName,
          `Nama kolom berbeda kapitalisasi ("${pair.targetName}" → "${pair.sourceName}"); tidak diubah otomatis.`,
          'warning',
          []
        )
      )
    }
  }

  if (ctx.options.alterColumns) {
    for (const pair of pairs) {
      const { source: from, target: to } = pair
      const typeSame = sameEngine
        ? normalizeType(from.dataType) === normalizeType(to.dataType)
        : typeCompatible(from.dataType, to.dataType)
      const nullableSame = from.nullable === to.nullable
      const autoSame = Boolean(from.autoIncrement) === Boolean(to.autoIncrement)
      const defaultSame = sameDefault(from, to, sameEngine)

      if (typeSame && nullableSame && autoSame && defaultSame) continue

      const details: string[] = []
      if (!typeSame) {
        details.push(`tipe ${to.dataType} → ${from.dataType}`)
      } else if (sameEngine && typeShape(from.dataType) !== typeShape(to.dataType)) {
        details.push(`ukuran ${to.dataType} → ${from.dataType}`)
      }
      if (!nullableSame) details.push(from.nullable ? 'boleh NULL' : 'wajib diisi')
      if (!autoSame)
        details.push(from.autoIncrement ? 'auto increment' : 'bukan auto increment')
      if (!defaultSame) details.push('default berubah')

      if (!sameEngine) {
        // Types and defaults are engine-specific. Altering across engines is
        // exactly the operation that silently truncates or reformats data.
        changes.push(
          makeChange(
            table,
            'modifyColumn',
            pair.targetName,
            `Beda lintas engine (${to.dataType} → ${from.dataType}); tidak diubah otomatis.`,
            'unsupported',
            []
          )
        )
        continue
      }

      if (ctx.targetEngine === 'sqlite') {
        changes.push(
          makeChange(
            table,
            'modifyColumn',
            pair.targetName,
            `SQLite tidak bisa mengubah kolom (${details.join(', ')}).`,
            'unsupported',
            []
          )
        )
        continue
      }

      changes.push(
        makeChange(
          table,
          'modifyColumn',
          pair.targetName,
          `Kolom "${pair.targetName}": ${details.join(', ')}.`,
          from.nullable === false && to.nullable ? 'warning' : 'info',
          [
            {
              kind: 'alterTable',
              ...tableLocation(ctx, table),
              alterations: [
                {
                  type: 'modifyColumn',
                  column: columnDefinition(
                    ctx.targetEngine,
                    ctx.sourceEngine,
                    { ...from, name: pair.targetName },
                    pkColumns(source).includes(pair.sourceName)
                  ),
                  previous: {
                    dataType: to.dataType,
                    nullable: to.nullable,
                    defaultValue: to.defaultValue,
                    autoIncrement: to.autoIncrement
                  }
                }
              ]
            }
          ]
        )
      )
    }
  } else {
    for (const pair of pairs) {
      const { source: from, target: to } = pair
      const typeSame = sameEngine
        ? normalizeType(from.dataType) === normalizeType(to.dataType)
        : typeCompatible(from.dataType, to.dataType)
      const differs =
        !typeSame ||
        from.nullable !== to.nullable ||
        Boolean(from.autoIncrement) !== Boolean(to.autoIncrement) ||
        !sameDefault(from, to, sameEngine)
      if (!differs) continue
      changes.push(
        makeChange(
          table,
          'modifyColumn',
          pair.targetName,
          `Kolom "${pair.targetName}" berbeda (${to.dataType} → ${from.dataType}); opsi "ubah kolom" nonaktif.`,
          'warning',
          []
        )
      )
    }
  }

  // Primary key: compared as an ordered list so a composite key with swapped
  // columns is still reported.
  const sourcePk = pkColumns(source)
  const targetPk = pkColumns(target)
  const pkSame =
    sourcePk.length === targetPk.length && sourcePk.every((c, i) => c === targetPk[i])
  if (!pkSame) {
    if (!sameEngine) {
      changes.push(
        makeChange(
          table,
          'primaryKey',
          table,
          `Primary key berbeda (${targetPk.join(',') || 'tidak ada'} → ${sourcePk.join(',') || 'tidak ada'}); tidak diubah lintas engine.`,
          'unsupported',
          []
        )
      )
    } else if (ctx.targetEngine === 'sqlite') {
      changes.push(
        makeChange(
          table,
          'primaryKey',
          table,
          'SQLite tidak bisa mengubah primary key tanpa membangun ulang tabel.',
          'unsupported',
          []
        )
      )
    } else {
      const alterations: NonNullable<
        Extract<DdlOperation, { kind: 'alterTable' }>['alterations']
      > = []
      if (targetPk.length > 0) {
        alterations.push({
          type: 'dropPrimaryKey',
          constraintName: target.primaryKey?.name ?? null
        })
      }
      if (sourcePk.length > 0) {
        alterations.push({
          type: 'setPrimaryKey',
          columns: sourcePk,
          constraintName: source.primaryKey?.name ?? null
        })
      }
      changes.push(
        makeChange(
          table,
          'primaryKey',
          table,
          `Primary key: ${targetPk.join(', ') || 'tidak ada'} → ${sourcePk.join(', ') || 'tidak ada'}.`,
          sourcePk.length === 0 ? 'destructive' : 'info',
          [{ kind: 'alterTable', ...tableLocation(ctx, table), alterations }]
        )
      )
    }
  }

  if (ctx.options.syncIndexes) {
    const targetUsed = new Set(target.indexes.map((i) => i.name))
    const targetBySignature = new Map(
      target.indexes.filter((i) => !i.primary).map((i) => [indexSignature(i), i])
    )
    const sourceSignatures = new Set<string>()

    for (const index of source.indexes) {
      if (index.primary) continue
      const signature = indexSignature(index)
      sourceSignatures.add(signature)
      if (targetBySignature.has(signature)) continue
      changes.push(
        makeChange(
          table,
          'createIndex',
          index.name,
          `${index.unique ? 'Unique index' : 'Index'} (${index.columns.join(', ')}) ditambahkan.`,
          'info',
          [
            {
              kind: 'createIndex',
              ...tableLocation(ctx, table),
              indexName: freeName(index.name, targetUsed),
              columns: index.columns,
              unique: index.unique
            }
          ]
        )
      )
    }

    for (const index of target.indexes) {
      if (index.primary) continue
      if (sourceSignatures.has(indexSignature(index))) continue
      if (ctx.options.dropExtraIndexes) {
        changes.push(
          makeChange(
            table,
            'dropIndex',
            index.name,
            `Index "${index.name}" dihapus dari target.`,
            'warning',
            [
              {
                kind: 'dropIndex',
                ...tableLocation(ctx, table),
                indexName: index.name
              }
            ]
          )
        )
      } else {
        changes.push(
          makeChange(
            table,
            'dropIndex',
            index.name,
            `Index "${index.name}" hanya ada di target; opsi "hapus index" nonaktif.`,
            'warning',
            []
          )
        )
      }
    }
  }

  if (ctx.options.syncForeignKeys) {
    const targetUsed = new Set(target.foreignKeys.map((f) => f.name))
    const targetBySignature = new Map(target.foreignKeys.map((f) => [fkSignature(f), f]))
    const sourceSignatures = new Set<string>()

    for (const fk of source.foreignKeys) {
      const signature = fkSignature(fk)
      sourceSignatures.add(signature)
      if (targetBySignature.has(signature)) continue
      if (!sameEngine || ctx.targetEngine === 'sqlite') {
        changes.push(
          makeChange(
            table,
            'createForeignKey',
            fk.name,
            `Foreign key "${fk.name}" tidak bisa ditambahkan lintas engine atau di SQLite.`,
            'unsupported',
            []
          )
        )
        continue
      }
      changes.push(
        makeChange(
          table,
          'createForeignKey',
          fk.name,
          `Foreign key (${fk.columns.join(', ')}) → ${fk.refTable} ditambahkan.`,
          'info',
          [
            {
              kind: 'createForeignKey',
              ...tableLocation(ctx, table),
              name: freeName(fk.name, targetUsed),
              columns: fk.columns,
              refSchema: fk.refSchema,
              refTable: fk.refTable,
              refColumns: fk.refColumns,
              onUpdate: fk.onUpdate,
              onDelete: fk.onDelete
            }
          ]
        )
      )
    }

    for (const fk of target.foreignKeys) {
      if (sourceSignatures.has(fkSignature(fk))) continue
      if (!ctx.options.dropExtraForeignKeys) {
        changes.push(
          makeChange(
            table,
            'dropForeignKey',
            fk.name,
            `Foreign key "${fk.name}" hanya ada di target; opsi "hapus foreign key" nonaktif.`,
            'warning',
            []
          )
        )
      } else if (!sameEngine || ctx.targetEngine === 'sqlite') {
        changes.push(
          makeChange(
            table,
            'dropForeignKey',
            fk.name,
            `Foreign key "${fk.name}" tidak bisa dihapus lintas engine atau di SQLite.`,
            'unsupported',
            []
          )
        )
      } else {
        changes.push(
          makeChange(
            table,
            'dropForeignKey',
            fk.name,
            `Foreign key "${fk.name}" dihapus dari target.`,
            'warning',
            [
              {
                kind: 'dropForeignKey',
                ...tableLocation(ctx, table),
                name: fk.name
              }
            ]
          )
        )
      }
    }
  }

  if (ctx.options.dropExtraColumns) {
    for (const column of targetOnly) {
      changes.push(
        makeChange(
          table,
          'dropColumn',
          column.name,
          `Kolom "${column.name}" dihapus dari target. Datanya hilang.`,
          'destructive',
          [
            {
              kind: 'dropColumn',
              ...tableLocation(ctx, table),
              column: column.name
            }
          ]
        )
      )
    }
  } else {
    for (const column of targetOnly) {
      changes.push(
        makeChange(
          table,
          'dropColumn',
          column.name,
          `Kolom "${column.name}" hanya ada di target; opsi "hapus kolom" nonaktif.`,
          'warning',
          []
        )
      )
    }
  }

  return changes
}

export interface StructurePlanResult {
  changes: StructureChange[]
  warnings: string[]
}

// Phase order for deploy. Creating and widening comes before dropping, so a
// rename-like change (add new + drop old) never removes data before the new
// shape exists.
const CHANGE_PHASE: Record<StructureChange['kind'], number> = {
  createTable: 0,
  addColumn: 1,
  modifyColumn: 2,
  primaryKey: 3,
  createIndex: 4,
  createForeignKey: 5,
  dropIndex: 6,
  dropForeignKey: 7,
  dropColumn: 8,
  dropTable: 9
}

export function sortChanges(changes: StructureChange[]): StructureChange[] {
  return [...changes].sort((a, b) => {
    const phase = CHANGE_PHASE[a.kind] - CHANGE_PHASE[b.kind]
    if (phase !== 0) return phase
    if (a.table !== b.table) return a.table.localeCompare(b.table)
    return a.id.localeCompare(b.id)
  })
}

export function planTableStructure(
  sourceEngine: DbEngine,
  targetEngine: DbEngine,
  source: TableStructure,
  target: TableStructure | null,
  targetDatabase: string,
  targetSchema: string | undefined,
  options: StructureSyncOptions
): StructurePlanResult {
  const ctx: PlanContext = {
    sourceEngine,
    targetEngine,
    targetDatabase,
    targetSchema,
    options
  }
  const warnings: string[] = []

  if (targetEngine === 'sqlite') {
    warnings.push(
      'SQLite: ubah tipe/constraint kolom dan primary key dilaporkan sebagai tidak didukung, bukan dibangun ulang otomatis.'
    )
  }
  if (sourceEngine !== targetEngine) {
    warnings.push(
      `Beda engine (${sourceEngine} → ${targetEngine}): hanya tabel/kolom/index yang hilang yang dibuat; perubahan kolom dilaporkan, tidak diterapkan.`
    )
  }

  if (!target) {
    return { changes: planNewTable(ctx, source), warnings }
  }
  return { changes: planExistingTable(ctx, source, target), warnings }
}

export function planDroppedTableStructure(
  targetEngine: DbEngine,
  target: TableStructure,
  targetDatabase: string,
  targetSchema: string | undefined,
  options: StructureSyncOptions
): StructureChange {
  return planDroppedTable(
    {
      sourceEngine: targetEngine,
      targetEngine,
      targetDatabase,
      targetSchema,
      options
    },
    target
  )
}
