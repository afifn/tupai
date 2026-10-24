import type { DbEngine } from './types'

/**
 * How many rows the assistant panel renders under an answer. Kept small on
 * purpose: the panel is narrow, and a wide result is better opened in the data
 * grid than squeezed into a chat bubble.
 */
export const AI_PREVIEW_ROWS = 5

export interface PreviewStatement {
  sql: string
  /** Row limit the reply asked for, when it named one. */
  requested: number | null
}

const READ_ONLY = /^(select|with)\b/i

// Anything that can change state, take a lock, or run for a long time. A reply
// is untrusted text, so the preview only ever runs a plain read.
const FORBIDDEN =
  /\b(insert|update|delete|merge|drop|create|alter|truncate|grant|revoke|call|exec|execute|copy|vacuum|analyze|attach|detach|pragma|set|lock|into|begin|commit|rollback|savepoint|replace)\b/i

// Functions that exist only to burn time. A plain SELECT is not automatically
// cheap: `SELECT pg_sleep(600)` is a read that holds the connection for ten
// minutes, and the preview runs on the connection the user is working with.
const SLOW_FUNCTIONS =
  /\b(pg_sleep|pg_sleep_for|pg_sleep_until|sleep|benchmark|waitfor)\b/i

/**
 * Strips a leading comment block so the first keyword is visible. SQL Server
 * style `--` and C style `/* *\/` are both common in generated answers.
 */
function stripLeadingComments(sql: string): string {
  let rest = sql.trimStart()
  for (;;) {
    if (rest.startsWith('--')) {
      const newline = rest.indexOf('\n')
      if (newline < 0) return ''
      rest = rest.slice(newline + 1).trimStart()
      continue
    }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/')
      if (end < 0) return ''
      rest = rest.slice(end + 2).trimStart()
      continue
    }
    return rest
  }
}

/**
 * Reads the row count the user asked for from the question, so a request for 10
 * rows does not produce a misleading 5-row preview. Returns null when the
 * question names no number.
 */
export function requestedRowCount(question: string): number | null {
  const patterns = [
    /\b(?:top|limit|first|ambil|tampilkan|tunjukkan|berikan|show|get|return)\D{0,12}(\d{1,6})\b/i,
    /\b(\d{1,6})\s*(?:baris|row|rows|record|records|data)\b/i
  ]
  for (const pattern of patterns) {
    const match = question.match(pattern)
    if (!match) continue
    const value = Number(match[1])
    if (Number.isFinite(value) && value > 0) return value
  }
  return null
}

/**
 * Decides whether a reply's SQL may be executed for the inline preview. Only a
 * single read-only statement qualifies; everything else is left as text for the
 * user to run themselves.
 */
export function previewableStatement(
  sql: string,
  question: string
): PreviewStatement | null {
  const cleaned = stripLeadingComments(sql).replace(/;\s*$/, '').trim()
  if (!cleaned) return null
  if (!READ_ONLY.test(cleaned)) return null
  if (FORBIDDEN.test(cleaned)) return null
  if (SLOW_FUNCTIONS.test(cleaned)) return null
  // Two statements mean a batch; the preview only shows one result table.
  if (cleaned.includes(';')) return null
  // Guard against an unterminated literal swallowing the rest of the statement.
  if ((cleaned.match(/'/g)?.length ?? 0) % 2 !== 0) return null

  return { sql: cleaned, requested: requestedRowCount(question) }
}

/**
 * True when the reply should be previewed inline: the setting is on, the
 * statement is safe, and the user did not ask for more rows than the panel
 * shows. A larger request keeps only the SQL block, which is the point of the
 * cap.
 */
export function shouldPreview(sql: string, question: string, enabled: boolean): boolean {
  if (!enabled) return false
  const statement = previewableStatement(sql, question)
  if (!statement) return false
  if (statement.requested !== null && statement.requested > AI_PREVIEW_ROWS) {
    return false
  }
  return true
}

// Every SQL engine the app supports can run the same read-only SELECT. MongoDB
// has no SQL, so the panel falls back to the plain SQL block there.
const PREVIEW_ENGINES: DbEngine[] = ['postgres', 'mysql', 'mariadb', 'sqlite', 'oracle']

export function supportsPreview(engine: DbEngine | undefined): boolean {
  return engine !== undefined && PREVIEW_ENGINES.includes(engine)
}
