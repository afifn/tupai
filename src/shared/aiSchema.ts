import type { ColumnInfo } from './types'

// Builds the schema summary the assistant receives for the database the user is
// looking at. It is a pure function so the budget rules can be tested without a
// database: a prompt that silently grows past the model's window is worse than a
// short one, and the truncation has to be predictable.

export interface SchemaTable {
  name: string
  schema?: string
  type: 'table' | 'view'
  columns: ColumnInfo[]
}

export interface SchemaSummaryOptions {
  /** Hard cap on characters, including the header line. */
  maxChars?: number
  /** Tables listed with their columns before the rest are only named. */
  maxDetailedTables?: number
  /** Columns shown per table before the rest are counted. */
  maxColumnsPerTable?: number
}

const DEFAULTS = {
  maxChars: 6000,
  maxDetailedTables: 24,
  maxColumnsPerTable: 40
}

function tableHeading(table: SchemaTable, engine: string): string {
  // MySQL and SQLite report the database as the schema; repeating it produces
  // "db.db.table", which is not valid SQL.
  if (engine === 'postgres' || engine === 'oracle') {
    return table.schema ? `${table.schema}.${table.name}` : table.name
  }
  return table.name
}

function columnLine(column: ColumnInfo): string {
  const flags = [
    column.isPrimaryKey ? 'PK' : '',
    column.nullable ? '' : 'NOT NULL',
    column.autoIncrement ? 'auto' : ''
  ].filter(Boolean)
  return `${column.name} ${column.dataType}${flags.length ? ` ${flags.join(' ')}` : ''}`
}

/**
 * Renders a compact, deterministic description of a database: every table name,
 * with columns for the first few. Truncation is stated in the text so the model
 * knows the list is partial instead of assuming it is complete.
 */
export function buildSchemaSummary(
  engine: string,
  database: string,
  tables: SchemaTable[],
  options: SchemaSummaryOptions = {}
): string {
  const maxChars = options.maxChars ?? DEFAULTS.maxChars
  const maxDetailed = options.maxDetailedTables ?? DEFAULTS.maxDetailedTables
  const maxColumns = options.maxColumnsPerTable ?? DEFAULTS.maxColumnsPerTable

  if (tables.length === 0) {
    return `Engine: ${engine}\nDatabase: ${database}\nTabel: belum ada atau belum dimuat.`
  }

  const header = `Engine: ${engine}\nDatabase: ${database}\nTabel (${tables.length}):`
  const lines: string[] = []
  let used = header.length

  // The truncation notice is reserved up front. Without this the final line that
  // announces "N tables not loaded" could itself push the text past the budget.
  const notice = `- ... (${tables.length} tabel lain tidak dimuat)`
  const budget = maxChars - notice.length - 1

  for (const [index, table] of tables.entries()) {
    const name = tableHeading(table, engine)
    const kind = table.type === 'view' ? ' [view]' : ''
    if (index >= maxDetailed) {
      // Only the name still fits; columns would push the prompt over budget.
      const line = `- ${name}${kind}`
      if (used + line.length + 1 > budget) {
        lines.push(notice)
        break
      }
      lines.push(line)
      used += line.length + 1
      continue
    }

    const shown = table.columns.slice(0, maxColumns).map(columnLine)
    const hidden = table.columns.length - shown.length
    const columns = shown.length
      ? `${shown.join(', ')}${hidden > 0 ? `, ... (${hidden} kolom lain)` : ''}`
      : 'kolom belum dimuat'
    const line = `- ${name}${kind}: ${columns}`
    if (used + line.length + 1 > budget) {
      lines.push(notice)
      break
    }
    lines.push(line)
    used += line.length + 1
  }

  return [header, ...lines].join('\n')
}

/** Orders tables so the ones a user is most likely to ask about come first. */
export function sortForPrompt(tables: SchemaTable[]): SchemaTable[] {
  return [...tables].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'table' ? -1 : 1
    const schemaA = a.schema ?? ''
    const schemaB = b.schema ?? ''
    if (schemaA !== schemaB) return schemaA.localeCompare(schemaB)
    return a.name.localeCompare(b.name)
  })
}
