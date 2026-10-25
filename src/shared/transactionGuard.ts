import type { DbEngine } from './types'

/**
 * Statements that commit the current transaction on their own.
 *
 * MySQL, MariaDB, and Oracle commit implicitly before and after DDL, so a
 * transaction cannot protect a migration on those engines. PostgreSQL is fully
 * transactional (including CREATE TABLE), so it is excluded. Detecting this
 * before the statement runs is the only way to warn the user instead of letting
 * the transaction quietly disappear.
 */
const IMPLICIT_COMMIT = /^\s*(create|alter|drop|truncate|rename|grant|revoke)\b/i

/**
 * Strips leading comments so the first keyword is visible. Generated SQL often
 * starts with a `--` note.
 */
function firstKeyword(sql: string): string {
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

/** True when this statement would silently commit an open transaction. */
export function commitsImplicitly(engine: DbEngine, sql: string): boolean {
  if (engine === 'postgres' || engine === 'sqlite' || engine === 'mongodb') return false
  const statement = firstKeyword(sql)
  if (!statement) return false
  return IMPLICIT_COMMIT.test(statement)
}

/**
 * The first statement in a script that would commit implicitly, so the UI can
 * name it instead of asking about the whole script.
 */
export function firstImplicitCommit(
  engine: DbEngine,
  statements: readonly string[]
): string | null {
  for (const statement of statements) {
    if (commitsImplicitly(engine, statement)) return statement.trim()
  }
  return null
}
