/**
 * Keywords that change the catalogue rather than the data. After one of these
 * runs, any cached table list is stale: the sidebar and the assistant's @mention
 * picker both have to reload.
 *
 * This is a heuristic on purpose. A false positive only costs one extra refresh,
 * while a false negative leaves a table the user just created invisible until
 * the app restarts.
 */
const SCHEMA_KEYWORDS = [
  'create',
  'alter',
  'drop',
  'rename',
  'truncate',
  'comment',
  'grant',
  'revoke'
]

// Statements that mention the keywords above but never change the catalogue.
// `CREATE TEMPORARY TABLE` is deliberately not excluded: it still adds a table
// the user may want to see.
const READ_ONLY = /^(select|with|values|explain|show|describe|desc)\b/i

/**
 * Strips comments and string literals so a keyword inside `'drop me'` or after
 * `-- create` does not count as a statement.
 */
function stripNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
}

/**
 * True when the script can change the catalogue, so callers should refresh the
 * tree and the assistant's table list.
 */
export function changesSchema(sql: string): boolean {
  const clean = stripNoise(sql).trim()
  if (!clean) return false
  const pattern = new RegExp(`(^|[^\\w])(${SCHEMA_KEYWORDS.join('|')})\\b`, 'i')
  if (!pattern.test(clean)) return false
  // A plain SELECT that happens to read a column named "create" is not a change.
  return !READ_ONLY.test(clean)
}
