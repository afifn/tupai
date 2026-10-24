import type { ColumnInfo } from '@shared/types'

// A table the user explicitly attached to the conversation with @.
export interface MentionedTable {
  database: string
  schema?: string
  name: string
  columns: ColumnInfo[]
}

// The @ token being typed, so the popup knows what to filter on and where the
// replacement starts.
export interface MentionQuery {
  start: number
  query: string
}

const MAX_COLUMNS = 60

// Deliberately narrow: a mention is an identifier, optionally schema-qualified.
// Anything else (spaces, punctuation) closes the popup instead of swallowing the
// rest of the sentence.
const MENTION_RE = /@([\w$]*)$/

export function matchMentionQuery(textBeforeCaret: string): MentionQuery | null {
  const match = MENTION_RE.exec(textBeforeCaret)
  if (!match) return null
  // `@` glued to a word is an email address or a handle, not a mention.
  const at = textBeforeCaret.length - match[0].length
  if (at > 0 && /[\w$]/.test(textBeforeCaret[at - 1])) return null
  return { start: at, query: match[1] }
}

// MySQL and SQLite report the database as the schema. Joining both would produce
// "db.db.table", which is invalid SQL, so a schema equal to the database is
// dropped.
export function tablePath(table: { database: string; schema?: string; name: string }): string {
  const schema =
    table.schema && table.schema.toLowerCase() !== table.database.toLowerCase()
      ? `.${table.schema}`
      : ''
  return `${table.database}${schema}.${table.name}`
}

export function formatTableContext(table: MentionedTable): string {
  const path = tablePath(table)
  const columns = table.columns
    .slice(0, MAX_COLUMNS)
    .map((c) => `${c.name} ${c.dataType}${c.isPrimaryKey ? ' PK' : ''}${c.nullable ? '' : ' NOT NULL'}`)
    .join(', ')
  const more =
    table.columns.length > MAX_COLUMNS
      ? `, ... (${table.columns.length - MAX_COLUMNS} kolom lain)`
      : ''
  return columns ? `${path}(${columns}${more})` : path
}

export function tableKey(table: { database: string; schema?: string; name: string }): string {
  return `${table.database}::${table.schema ?? ''}::${table.name}`.toLowerCase()
}

export const MAX_MENTIONS = 8

// The open table already arrives through the panel props. Mentions are merged
// into the same block, so naming the current table twice does not duplicate it
// in the prompt.
export function mergeSchemaContext(
  base: string | undefined,
  mentions: MentionedTable[]
): string | undefined {
  if (mentions.length === 0) return base
  const text = base?.trim() ?? ''
  const seen = new Set<string>()
  const lines: string[] = []
  if (text) lines.push(text)
  lines.push('Tabel yang dirujuk pengguna:')
  for (const table of mentions) {
    const key = tableKey(table)
    if (seen.has(key)) continue
    seen.add(key)
    // The panel context describes the open table as "Table: <name>", so its
    // columns are already present and repeating them only wastes tokens.
    if (text.includes(`Table: ${table.name}`)) continue
    lines.push(formatTableContext(table))
  }
  if (lines.length === 1) return text
  lines.push('Token @nama di pesan merujuk ke tabel yang tercantum di atas.')
  return lines.join('\n')
}

export function filterTables<T extends { database: string; schema?: string; name: string }>(
  tables: T[],
  query: string,
  limit = 12
): T[] {
  const needle = query.toLowerCase()
  if (!needle) return tables.slice(0, limit)
  const scored: { table: T; score: number }[] = []
  for (const table of tables) {
    const name = table.name.toLowerCase()
    let score = -1
    if (name === needle) score = 0
    else if (name.startsWith(needle)) score = 1
    else if (name.includes(needle)) score = 2
    if (score >= 0) scored.push({ table, score })
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      // Among prefix matches the shortest name is the closest one, so typing
      // "@ord" offers "orders" before "order_items".
      a.table.name.length - b.table.name.length ||
      a.table.name.localeCompare(b.table.name)
  )
  return scored.slice(0, limit).map((s) => s.table)
}

export function replaceMentionToken(
  draft: string,
  mention: MentionQuery,
  table: MentionedTable
): { text: string; caret: number } {
  const before = draft.slice(0, mention.start)
  const after = draft.slice(mention.start + 1 + mention.query.length)
  const token = `@${table.name} `
  return { text: `${before}${token}${after}`, caret: before.length + token.length }
}
