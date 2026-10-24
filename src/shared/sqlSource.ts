// Conservative detection of a query result that maps 1:1 to one table.
// Editing a result row is only safe when the SELECT reads a single table with
// no joins, grouping, aggregates, or set operations, because the primary key
// must identify exactly one stored row.
export interface SingleTableSource {
  table: string
  schema?: string
}

const FORBIDDEN = /\b(join|group\s+by|having|union|intersect|except|distinct|window|over\s*\()\b/i

export function parseSingleTableSelect(sql: string): SingleTableSource | null {
  const text = sql.trim().replace(/;\s*$/, '')
  // Must start with SELECT (a CTE can hide joins, so WITH is rejected).
  if (!/^select\b/i.test(text)) return null
  if (FORBIDDEN.test(text)) return null
  // A subquery anywhere means the result may not map to one table.
  if (/\(\s*select\b/i.test(text)) return null

  // Find the outermost FROM clause.
  const fromMatch = /\bfrom\s+([^\s,()]+)/i.exec(text)
  if (!fromMatch) return null
  const raw = fromMatch[1].trim()

  // Reject subqueries and anything that is not a plain (optionally qualified)
  // identifier list. Values may be quoted with ", `, or [ ].
  if (raw.includes('(')) return null

  const parts = splitQualified(raw)
  if (!parts) return null

  // Reject a trailing WHERE/ORDER clause accidentally captured (no spaces
  // should survive the identifier split, so this is a sanity check).
  if (parts.some((p) => /\s/.test(p))) return null

  // Reject a second table in the FROM list: `FROM a, b` or `FROM a AS x, b`.
  const afterFrom = text.slice(fromMatch.index + fromMatch[0].length)
  if (/^\s*,/.test(afterFrom)) return null

  // Reject aggregates in the select list.
  const selectList = text.slice(0, fromMatch.index)
  if (/\b(count|sum|avg|min|max)\s*\(/i.test(selectList)) return null

  if (parts.length === 1) return { table: parts[0] }
  if (parts.length === 2) return { schema: parts[0], table: parts[1] }
  // db.schema.table is more than this conservative parser will accept.
  return null
}

function splitQualified(raw: string): string[] | null {
  const parts: string[] = []
  let current = ''
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '"' || ch === '`') {
      const close = raw.indexOf(ch, i + 1)
      if (close === -1) return null
      current += raw.slice(i + 1, close).replace(new RegExp(ch + ch, 'g'), ch)
      i = close + 1
      continue
    }
    if (ch === '[') {
      const close = raw.indexOf(']', i + 1)
      if (close === -1) return null
      current += raw.slice(i + 1, close)
      i = close + 1
      continue
    }
    if (ch === '.') {
      parts.push(current)
      current = ''
      i += 1
      continue
    }
    current += ch
    i += 1
  }
  parts.push(current)
  if (parts.some((p) => p === '')) return null
  return parts
}
