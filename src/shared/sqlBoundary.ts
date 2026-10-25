// Finds the position just after the last statement terminator that is outside
// strings, quoted identifiers, comments, and PostgreSQL dollar-quoted bodies.
//
// Restore streams a file in chunks and needs a safe place to cut it. Splitting
// on the literal text ";\n" is wrong: a string value may contain a newline
// after a semicolon, and a function body contains many semicolons. Cutting
// inside either corrupts the statement.
export function lastSafeStatementBoundary(sql: string): number {
  let boundary = -1
  let i = 0
  let quote: string | null = null
  let dollarTag: string | null = null
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
      i += 2
      continue
    }
    if (ch === '$') {
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
    if (ch === ';') boundary = i + 1
    i += 1
  }
  return boundary
}

export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let i = 0
  let quote: string | null = null
  // Postgres dollar-quoting: $$ ... $$ or $tag$ ... $tag$. Bodies often contain
  // semicolons, so the terminator must be matched before splitting.
  let dollarTag: string | null = null
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag
        i += dollarTag.length
        dollarTag = null
        continue
      }
      current += ch
      i += 1
      continue
    }
    if (quote) {
      current += ch
      if (ch === quote) {
        if (next === quote) {
          current += next
          i += 2
          continue
        }
        quote = null
      }
      i += 1
      continue
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        current += sql[i]
        i += 1
      }
      continue
    }
    if (ch === '/' && next === '*') {
      current += ch + next
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        current += sql[i]
        i += 1
      }
      if (i < sql.length) {
        current += '*/'
        i += 2
      }
      continue
    }
    if (ch === '$') {
      // A dollar-quote tag is $ followed by an optional identifier then $.
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
      if (match) {
        dollarTag = match[0]
        current += dollarTag
        i += dollarTag.length
        continue
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      current += ch
      i += 1
      continue
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim())
      current = ''
      i += 1
      continue
    }
    current += ch
    i += 1
  }
  if (current.trim()) statements.push(current.trim())
  return statements
}
