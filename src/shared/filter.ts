import type { ColumnFilter, DbEngine, FilterOperator } from './types'

export const FILTER_OPERATORS: FilterOperator[] = [
  'contains',
  'equals',
  'notEquals',
  'startsWith',
  'endsWith',
  'gt',
  'gte',
  'lt',
  'lte',
  'isNull',
  'isNotNull'
]

export const FILTER_OPERATOR_LABELS: Record<FilterOperator, string> = {
  contains: 'mengandung',
  equals: 'sama dengan',
  notEquals: 'tidak sama',
  startsWith: 'diawali',
  endsWith: 'diakhiri',
  gt: 'lebih besar',
  gte: 'lebih besar atau sama',
  lt: 'lebih kecil',
  lte: 'lebih kecil atau sama',
  isNull: 'kosong (NULL)',
  isNotNull: 'tidak kosong'
}

export function operatorNeedsValue(op: FilterOperator): boolean {
  return op !== 'isNull' && op !== 'isNotNull'
}

// The placeholder syntax differs per engine. MySQL/SQLite use '?', Postgres
// numbers its parameters, Oracle names them.
function placeholderFor(engine: DbEngine, index: number): string {
  if (engine === 'postgres') return `$${index}`
  if (engine === 'oracle') return `:f${index}`
  return '?'
}

function likeValue(op: FilterOperator, raw: string): string {
  // Escape LIKE metacharacters so a literal % or _ in user input stays literal.
  const escaped = raw.replace(/([\\%_])/g, '\\$1')
  if (op === 'startsWith') return `${escaped}%`
  if (op === 'endsWith') return `%${escaped}`
  return `%${escaped}%`
}

export interface FilterSql {
  // Empty when no filter applies.
  where: string
  params: unknown[]
}

// Builds a WHERE clause from column filters. Values are always parameterised;
// only the column identifier is interpolated, and the caller must pass it
// through quoteIdent first.
export function buildFilterWhere(
  engine: DbEngine,
  filters: ColumnFilter[] | undefined,
  logic: 'and' | 'or' = 'and',
  quote: (identifier: string) => string
): FilterSql {
  if (!filters || filters.length === 0) return { where: '', params: [] }

  const params: unknown[] = []
  const clauses: string[] = []

  for (const filter of filters) {
    const column = quote(filter.column)
    switch (filter.op) {
      case 'isNull':
        clauses.push(`${column} IS NULL`)
        break
      case 'isNotNull':
        clauses.push(`${column} IS NOT NULL`)
        break
      case 'contains':
      case 'startsWith':
      case 'endsWith': {
        params.push(likeValue(filter.op, filter.value ?? ''))
        // Postgres needs an explicit cast for non-text columns.
        const target = engine === 'postgres' ? `${column}::text` : column
        clauses.push(`${target} LIKE ${placeholderFor(engine, params.length)}`)
        break
      }
      case 'equals':
      case 'notEquals': {
        const target = engine === 'postgres' ? `${column}::text` : column
        const op = filter.op === 'equals' ? '=' : '<>'
        params.push(filter.value ?? '')
        clauses.push(`${target} ${op} ${placeholderFor(engine, params.length)}`)
        break
      }
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const op =
          filter.op === 'gt' ? '>' : filter.op === 'gte' ? '>=' : filter.op === 'lt' ? '<' : '<='
        params.push(filter.value ?? '')
        clauses.push(`${column} ${op} ${placeholderFor(engine, params.length)}`)
        break
      }
      default:
        break
    }
  }

  if (clauses.length === 0) return { where: '', params: [] }
  const joiner = logic === 'or' ? ' OR ' : ' AND '
  return { where: ` WHERE ${clauses.join(joiner)}`, params }
}

// Oracle binds by name, so the caller needs the same ordered values keyed.
export function toOracleBinds(params: unknown[]): Record<string, unknown> {
  const binds: Record<string, unknown> = {}
  params.forEach((value, index) => {
    binds[`f${index + 1}`] = value
  })
  return binds
}
