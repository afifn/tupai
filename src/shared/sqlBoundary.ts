// Statement boundaries for scripts.
//
// Two callers need the same scan: the restore streamer needs a safe place to cut
// a chunk, and the drivers need one statement per call. They share one scanner
// so a quoting rule can never drift between them.

interface StatementRange {
  /** First character of the statement, leading whitespace excluded. */
  start: number
  /** One past the last character, trailing whitespace excluded. */
  end: number
}

interface ScanResult {
  ranges: StatementRange[]
  /** Index just after the last terminator outside quotes and comments, or -1. */
  lastBoundary: number
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
}

function scanStatements(sql: string): ScanResult {
  const ranges: StatementRange[] = []
  let lastBoundary = -1
  let start = 0
  let i = 0
  let quote: string | null = null
  // Postgres dollar-quoting: $$ ... $$ or $tag$ ... $tag$. Bodies often contain
  // semicolons, so the terminator must be matched before splitting.
  let dollarTag: string | null = null

  const close = (end: number): void => {
    let from = start
    let to = end
    while (from < to && isSpace(sql[from])) from += 1
    while (to > from && isSpace(sql[to - 1])) to -= 1
    if (to > from) ranges.push({ start: from, end: to })
  }

  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        i += dollarTag.length
        dollarTag = null
        continue
      }
      i += 1
      continue
    }
    if (quote) {
      if (ch === quote) {
        if (next === quote) {
          i += 2
          continue
        }
        quote = null
      }
      i += 1
      continue
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      if (i < sql.length) i += 2
      continue
    }
    if (ch === '$') {
      // A dollar-quote tag is $ followed by an optional identifier then $.
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
      if (match) {
        dollarTag = match[0]
        i += dollarTag.length
        continue
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      i += 1
      continue
    }
    if (ch === ';') {
      close(i)
      lastBoundary = i + 1
      start = i + 1
      i += 1
      continue
    }
    i += 1
  }
  close(sql.length)
  return { ranges, lastBoundary }
}

// Finds the position just after the last statement terminator that is outside
// strings, quoted identifiers, comments, and PostgreSQL dollar-quoted bodies.
//
// Restore streams a file in chunks and needs a safe place to cut it. Splitting
// on the literal text ";\n" is wrong: a string value may contain a newline
// after a semicolon, and a function body contains many semicolons. Cutting
// inside either corrupts the statement.
export function lastSafeStatementBoundary(sql: string): number {
  return scanStatements(sql).lastBoundary
}

export function splitStatements(sql: string): string[] {
  return scanStatements(sql).ranges.map((range) => sql.slice(range.start, range.end))
}
