import type { DbEngine, FilterOperator } from './types'
import { isMysqlFamily, qualifiedTable, quoteIdent } from './ddl'
import { FILTER_OPERATOR_LABELS, operatorNeedsValue } from './filter'

export type BuilderJoinType = 'inner' | 'left' | 'right' | 'full' | 'cross'

export type BuilderAggregate =
  | 'none'
  | 'count'
  | 'countDistinct'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'

export interface BuilderColumnMeta {
  name: string
  dataType: string
  isPrimaryKey: boolean
}

export interface BuilderTable {
  id: string
  database: string
  schema?: string
  table: string
  // Every table gets an alias so a self-join and a same-named column stay
  // unambiguous in the generated SQL.
  alias: string
  columns: BuilderColumnMeta[]
}

export interface BuilderJoin {
  id: string
  type: BuilderJoinType
  leftTableId: string
  leftColumn: string
  rightTableId: string
  rightColumn: string
}

export interface BuilderProjection {
  id: string
  kind: 'column' | 'expression'
  tableId?: string
  column?: string
  expression?: string
  alias?: string
  aggregate: BuilderAggregate
}

export interface BuilderFilter {
  id: string
  tableId?: string
  column?: string
  op: FilterOperator
  value: string
  conjunction: 'and' | 'or'
}

export interface BuilderSort {
  id: string
  tableId?: string
  column?: string
  direction: 'asc' | 'desc'
}

export interface BuilderGroup {
  id: string
  tableId?: string
  column?: string
}

export interface BuilderState {
  tables: BuilderTable[]
  joins: BuilderJoin[]
  projections: BuilderProjection[]
  filters: BuilderFilter[]
  groups: BuilderGroup[]
  sorts: BuilderSort[]
  distinct: boolean
  limit?: number
}

export interface BuildResult {
  sql: string
  errors: string[]
}

export const EMPTY_BUILDER_STATE: BuilderState = {
  tables: [],
  joins: [],
  projections: [],
  filters: [],
  groups: [],
  sorts: [],
  distinct: false
}

export const JOIN_LABELS: Record<BuilderJoinType, string> = {
  inner: 'INNER JOIN',
  left: 'LEFT JOIN',
  right: 'RIGHT JOIN',
  full: 'FULL OUTER JOIN',
  cross: 'CROSS JOIN'
}

export const AGGREGATE_LABELS: Record<BuilderAggregate, string> = {
  none: '(tanpa agregat)',
  count: 'COUNT',
  countDistinct: 'COUNT DISTINCT',
  sum: 'SUM',
  avg: 'AVG',
  min: 'MIN',
  max: 'MAX'
}

export function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
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

// A text column can legitimately contain the word "true", so boolean literals
// are only inferred for non-text columns.
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

// Values are emitted inline because the builder output is meant to be read and
// edited by a person, not executed through a parameterised driver call.
function sqlLiteral(engine: DbEngine, raw: string, dataType: string): string {
  const value = raw.trim()
  if (value === '') return "''"
  if (/^null$/i.test(value)) return 'NULL'

  const wantsBoolean = /^(true|false)$/i.test(value)
  const truthy = /^true$/i.test(value)
  if (wantsBoolean && (isBooleanType(dataType) || !isTextType(dataType))) {
    // Oracle has no boolean SQL literal, so it gets the numeric form.
    if (engine === 'oracle' || engine === 'sqlite') return truthy ? '1' : '0'
    return truthy ? 'TRUE' : 'FALSE'
  }

  if (isNumericType(dataType) && /^-?\d+(\.\d+)?$/.test(value)) {
    return value
  }
  const escaped = isMysqlFamily(engine)
    ? value.replace(/\\/g, '\\\\').replace(/'/g, "''")
    : value.replace(/'/g, "''")
  return `'${escaped}'`
}

// A dedicated escape character avoids the MySQL backslash-in-string rules
// entirely: '!' is literal in every supported engine, so the pattern survives
// both string parsing and LIKE matching.
const LIKE_ESCAPE = '!'

function likePattern(op: FilterOperator, raw: string): string {
  const escaped = raw.replace(/([!%_])/g, `${LIKE_ESCAPE}$1`)
  if (op === 'startsWith') return `${escaped}%`
  if (op === 'endsWith') return `%${escaped}`
  return `%${escaped}%`
}

export function tableAlias(state: BuilderState, tableId: string): string {
  const table = state.tables.find((t) => t.id === tableId)
  return table ? table.alias : ''
}

function columnRef(
  engine: DbEngine,
  state: BuilderState,
  tableId: string | undefined,
  column: string | undefined
): string | null {
  if (!tableId || !column) return null
  const alias = tableAlias(state, tableId)
  if (!alias) return null
  return `${quoteIdent(engine, alias)}.${quoteIdent(engine, column)}`
}

function columnType(state: BuilderState, tableId: string | undefined, column: string): string {
  if (!tableId) return ''
  const table = state.tables.find((t) => t.id === tableId)
  return table?.columns.find((c) => c.name === column)?.dataType ?? ''
}

function projectionExpression(
  engine: DbEngine,
  state: BuilderState,
  projection: BuilderProjection
): string | null {
  if (projection.kind === 'expression') {
    const expression = projection.expression?.trim()
    if (!expression) return null
    return projection.aggregate === 'none'
      ? expression
      : `${aggregateSql(projection.aggregate, expression)}`
  }
  const ref = columnRef(engine, state, projection.tableId, projection.column)
  if (!ref) return null
  if (projection.aggregate === 'none') return ref
  return aggregateSql(projection.aggregate, ref)
}

function aggregateSql(aggregate: BuilderAggregate, expression: string): string {
  switch (aggregate) {
    case 'count':
      return `COUNT(${expression})`
    case 'countDistinct':
      return `COUNT(DISTINCT ${expression})`
    case 'sum':
      return `SUM(${expression})`
    case 'avg':
      return `AVG(${expression})`
    case 'min':
      return `MIN(${expression})`
    case 'max':
      return `MAX(${expression})`
    default:
      return expression
  }
}

function filterSql(
  engine: DbEngine,
  state: BuilderState,
  filter: BuilderFilter
): string | null {
  const ref = columnRef(engine, state, filter.tableId, filter.column)
  if (!ref) return null
  const dataType = columnType(state, filter.tableId, filter.column ?? '')
  switch (filter.op) {
    case 'isNull':
      return `${ref} IS NULL`
    case 'isNotNull':
      return `${ref} IS NOT NULL`
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      const pattern = likePattern(filter.op, filter.value)
      const literal = sqlLiteral(engine, pattern, 'text')
      return `${ref} LIKE ${literal} ESCAPE '${LIKE_ESCAPE}'`
    }
    case 'equals':
      return `${ref} = ${sqlLiteral(engine, filter.value, dataType)}`
    case 'notEquals':
      return `${ref} <> ${sqlLiteral(engine, filter.value, dataType)}`
    case 'gt':
      return `${ref} > ${sqlLiteral(engine, filter.value, dataType)}`
    case 'gte':
      return `${ref} >= ${sqlLiteral(engine, filter.value, dataType)}`
    case 'lt':
      return `${ref} < ${sqlLiteral(engine, filter.value, dataType)}`
    case 'lte':
      return `${ref} <= ${sqlLiteral(engine, filter.value, dataType)}`
    default:
      return null
  }
}

function limitSql(engine: DbEngine, limit: number | undefined): string {
  if (!limit || limit <= 0) return ''
  if (engine === 'oracle') return ` FETCH FIRST ${Math.floor(limit)} ROWS ONLY`
  return ` LIMIT ${Math.floor(limit)}`
}

// Builds one SELECT statement. Every problem that would produce invalid SQL is
// reported instead of silently dropped, so the UI can disable execution.
export function buildQuerySql(engine: DbEngine, state: BuilderState): BuildResult {
  const errors: string[] = []

  if (state.tables.length === 0) {
    return { sql: '', errors: ['Tambahkan minimal satu tabel.'] }
  }

  const aliases = new Set<string>()
  for (const table of state.tables) {
    const alias = table.alias.trim()
    if (!alias) {
      errors.push(`Alias untuk tabel ${table.table} masih kosong.`)
      continue
    }
    if (aliases.has(alias.toLowerCase())) {
      errors.push(`Alias "${alias}" dipakai lebih dari satu tabel.`)
    }
    aliases.add(alias.toLowerCase())
  }

  const selectParts: string[] = []
  for (const projection of state.projections) {
    const expression = projectionExpression(engine, state, projection)
    if (!expression) {
      if (projection.kind === 'expression') {
        errors.push('Ada kolom terhitung yang ekspresinya kosong.')
      } else {
        errors.push('Ada kolom output yang belum dipilih lengkap.')
      }
      continue
    }
    const alias = projection.alias?.trim()
    selectParts.push(alias ? `${expression} AS ${quoteIdent(engine, alias)}` : expression)
  }

  if (selectParts.length === 0) {
    errors.push('Pilih minimal satu kolom di panel Output.')
    return { sql: '', errors }
  }

  const first = state.tables[0]
  const firstAlias = quoteIdent(engine, first.alias)
  const fromParts = [
    `${qualifiedTable(engine, first.table, first.schema, first.database)} AS ${firstAlias}`
  ]

  // A table with no join to the first one would silently become a cross join,
  // which is almost never what the user meant.
  const joined = new Set<string>([first.id])
  for (const join of state.joins) {
    const right = state.tables.find((t) => t.id === join.rightTableId)
    const left = state.tables.find((t) => t.id === join.leftTableId)
    if (!right || !left) {
      errors.push('Ada join yang menunjuk tabel yang sudah dihapus.')
      continue
    }
    if (!joined.has(join.leftTableId)) {
      errors.push(
        `Join ke ${right.alias} belum tersambung ke tabel pertama (${first.alias}).`
      )
      continue
    }
    if (joined.has(join.rightTableId)) {
      errors.push(`Tabel ${right.alias} di-join lebih dari sekali.`)
      continue
    }
    const rightAlias = quoteIdent(engine, right.alias)
    const leftAlias = quoteIdent(engine, left.alias)
    const source = `${qualifiedTable(engine, right.table, right.schema, right.database)} AS ${rightAlias}`
    if (join.type === 'cross') {
      fromParts.push(`CROSS JOIN ${source}`)
    } else {
      if (!join.leftColumn || !join.rightColumn) {
        errors.push(`Join ke ${right.alias} belum memilih kolom.`)
        continue
      }
      const on = `${leftAlias}.${quoteIdent(engine, join.leftColumn)} = ${rightAlias}.${quoteIdent(engine, join.rightColumn)}`
      fromParts.push(`${JOIN_LABELS[join.type]} ${source} ON ${on}`)
    }
    joined.add(join.rightTableId)
  }

  for (const table of state.tables) {
    if (joined.has(table.id)) continue
    // A table the user added but never referenced is simply not part of the
    // query. One that is referenced but unreachable would silently become a
    // cross join, so that is an error.
    const referenced =
      state.projections.some((p) => p.tableId === table.id) ||
      state.filters.some((f) => f.tableId === table.id) ||
      state.sorts.some((s) => s.tableId === table.id)
    if (referenced) {
      errors.push(`Tabel ${table.alias} dipakai tapi belum di-join ke tabel pertama.`)
    }
  }

  const whereParts: string[] = []
  for (const filter of state.filters) {
    if (!filter.tableId || !filter.column) {
      errors.push('Ada filter yang belum memilih kolom.')
      continue
    }
    if (operatorNeedsValue(filter.op) && filter.value.trim() === '') {
      errors.push(
        `Filter ${filter.column} (${FILTER_OPERATOR_LABELS[filter.op]}) belum diisi nilainya.`
      )
      continue
    }
    const clause = filterSql(engine, state, filter)
    if (!clause) {
      errors.push(`Filter pada ${filter.column} tidak valid.`)
      continue
    }
    if (whereParts.length === 0) whereParts.push(clause)
    else whereParts.push(`${filter.conjunction === 'or' ? 'OR' : 'AND'} ${clause}`)
  }

  const orderParts: string[] = []
  for (const sort of state.sorts) {
    const ref = columnRef(engine, state, sort.tableId, sort.column)
    if (!ref) {
      errors.push('Ada pengurutan yang belum memilih kolom.')
      continue
    }
    orderParts.push(`${ref} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}`)
  }

  const groupParts: string[] = []
  for (const group of state.groups) {
    const ref = columnRef(engine, state, group.tableId, group.column)
    if (!ref) {
      errors.push('Ada GROUP BY yang belum memilih kolom.')
      continue
    }
    groupParts.push(ref)
  }

  // An aggregate mixed with a plain column is invalid SQL without GROUP BY.
  // Report it here instead of letting the server reject the statement.
  const hasAggregate = state.projections.some((p) => p.aggregate !== 'none')
  const plainProjections = state.projections.filter(
    (p) => p.aggregate === 'none' && projectionExpression(engine, state, p)
  )
  if (hasAggregate && plainProjections.length > 0 && groupParts.length === 0) {
    errors.push(
      'Ada agregat bersama kolom biasa. Tambahkan kolom itu ke GROUP BY, atau ubah agregatnya.'
    )
  }

  const selectKeyword = state.distinct ? 'SELECT DISTINCT' : 'SELECT'
  const lines = [
    `${selectKeyword} ${selectParts.join(',\n       ')}`,
    `FROM ${fromParts.join('\n     ')}`
  ]
  if (whereParts.length > 0) lines.push(`WHERE ${whereParts.join('\n  ')}`)
  if (groupParts.length > 0) lines.push(`GROUP BY ${groupParts.join(', ')}`)
  if (orderParts.length > 0) lines.push(`ORDER BY ${orderParts.join(', ')}`)

  const sql = `${lines.join('\n')}${limitSql(engine, state.limit)};`
  return { sql, errors }
}

// Suggests joins from foreign keys between the tables already on the canvas.
export interface JoinSuggestion {
  leftTableId: string
  leftColumn: string
  rightTableId: string
  rightColumn: string
}

export function suggestJoins(
  state: BuilderState,
  foreignKeys: {
    tableId: string
    columns: string[]
    refTable: string
    refSchema?: string
    refColumns: string[]
  }[]
): JoinSuggestion[] {
  const suggestions: JoinSuggestion[] = []
  const seen = new Set<string>()
  // The builder anchors every join on the first table, so orient the suggestion
  // that way when one side is the anchor. Otherwise keep the FK direction.
  const anchorId = state.tables[0]?.id
  for (const fk of foreignKeys) {
    const right = state.tables.find((t) => {
      if (t.table.toLowerCase() !== fk.refTable.toLowerCase()) return false
      // The canvas may be opened without an explicit schema (the engine's
      // default search path). Only reject a schema mismatch when both sides
      // actually declare one.
      const tableSchema = (t.schema ?? '').toLowerCase()
      const refSchema = (fk.refSchema ?? '').toLowerCase()
      if (!tableSchema || !refSchema) return true
      return tableSchema === refSchema
    })
    if (!right || right.id === fk.tableId) continue
    for (let i = 0; i < fk.columns.length; i += 1) {
      const localColumn = fk.columns[i]
      const refColumn = fk.refColumns[i]
      if (!localColumn || !refColumn) continue
      let leftTableId = fk.tableId
      let leftColumn = localColumn
      let rightTableId = right.id
      let rightColumn = refColumn
      if (anchorId && rightTableId === anchorId && leftTableId !== anchorId) {
        leftTableId = right.id
        leftColumn = refColumn
        rightTableId = fk.tableId
        rightColumn = localColumn
      }
      const key = `${leftTableId}:${leftColumn}:${rightTableId}:${rightColumn}`
      if (seen.has(key)) continue
      seen.add(key)
      suggestions.push({ leftTableId, leftColumn, rightTableId, rightColumn })
    }
  }
  return suggestions
}

// Picks a unique alias for a newly added table.
export function nextAlias(state: BuilderState, table: string): string {
  const base = table.replace(/[^A-Za-z0-9_]/g, '_') || 't'
  const used = new Set(state.tables.map((t) => t.alias.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  let index = 2
  while (used.has(`${base}${index}`.toLowerCase())) index += 1
  return `${base}${index}`
}
