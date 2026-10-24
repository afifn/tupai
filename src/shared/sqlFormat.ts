import { format, type SqlLanguage } from 'sql-formatter'
import type { DbEngine } from './types'

// sql-formatter dialect names differ from our engine ids, and Oracle is only
// supported through its PL/SQL grammar.
const DIALECT: Record<DbEngine, SqlLanguage> = {
  mysql: 'mysql',
  mariadb: 'mariadb',
  postgres: 'postgresql',
  sqlite: 'sqlite',
  oracle: 'plsql',
  mongodb: 'sql'
}

export interface FormatOptions {
  tabWidth?: number
  keywordCase?: 'upper' | 'lower' | 'preserve'
}

export interface FormatResult {
  sql: string
  // True when the formatter rejected the input and the original text was kept.
  fellBack: boolean
  error?: string
}

const MAX_ERROR_LENGTH = 240

// The library documents that it does not support stored procedures, and its
// MySQL parser only understands the `;` delimiter. Formatting such a script
// silently produces broken SQL, so it is detected up front and left untouched.
const ROUTINE_PATTERN =
  /\bcreate\s+(or\s+replace\s+)?(procedure|function|trigger|event|package|type\s+body)\b/i
const DELIMITER_PATTERN = /^\s*delimiter\s+\S+/im
const DOLLAR_QUOTE_PATTERN = /\$[A-Za-z_]*\$/

export function shouldSkipFormatting(sql: string): string | null {
  if (DELIMITER_PATTERN.test(sql)) {
    return 'skrip memakai DELIMITER (stored procedure), yang tidak didukung sql-formatter'
  }
  if (ROUTINE_PATTERN.test(sql)) {
    return 'skrip membuat procedure/function/trigger, yang tidak didukung sql-formatter'
  }
  if (DOLLAR_QUOTE_PATTERN.test(sql)) {
    return 'skrip memakai dollar-quoting PostgreSQL, yang tidak didukung sql-formatter'
  }
  return null
}

function trimError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const firstLine = raw.split(/\r?\n/)[0] ?? raw
  return firstLine.length > MAX_ERROR_LENGTH
    ? `${firstLine.slice(0, MAX_ERROR_LENGTH)}...`
    : firstLine
}

// Formats SQL locally with sql-formatter. No network call and no model: a
// formatter must be deterministic and must never change statement semantics.
export function formatSql(
  sql: string,
  engine: DbEngine,
  options: FormatOptions = {}
): FormatResult {
  if (!sql.trim()) return { sql, fellBack: false }

  const skipReason = shouldSkipFormatting(sql)
  if (skipReason) return { sql, fellBack: true, error: skipReason }

  try {
    return {
      sql: format(sql, {
        language: DIALECT[engine],
        tabWidth: options.tabWidth ?? 2,
        keywordCase: options.keywordCase ?? 'upper',
        linesBetweenQueries: 1
      }),
      fellBack: false
    }
  } catch (err) {
    // Parse failures return the original text so a broken statement is never
    // rewritten into something that looks valid.
    return { sql, fellBack: true, error: trimError(err) }
  }
}

export function isFormatterSupported(engine: DbEngine): boolean {
  return engine !== 'mongodb'
}
