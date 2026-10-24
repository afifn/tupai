import type { DbEngine } from './types'

// Cross-engine transfers cannot reuse the source column type verbatim: MySQL has
// DATETIME and TINYINT, PostgreSQL has TIMESTAMP and BOOLEAN, and SQLite has no
// strict types at all. This maps a source type into the closest target type.
type Family =
  | 'boolean'
  | 'smallint'
  | 'int'
  | 'bigint'
  | 'decimal'
  | 'float'
  | 'text'
  | 'longtext'
  | 'blob'
  | 'date'
  | 'time'
  | 'datetime'
  | 'timestamp'
  | 'timestamptz'
  | 'json'
  | 'uuid'
  | 'unknown'

function familyOf(sourceType: string): Family {
  const t = sourceType.toLowerCase().trim()

  if (t.includes('bool') || /^tinyint\(1\)$/.test(t) || t === 'bit(1)') return 'boolean'
  if (t.includes('uuid') || t.includes('uniqueidentifier')) return 'uuid'
  if (t.includes('json')) return 'json'
  if (t.includes('timestamp with time zone') || t.includes('timestamptz')) return 'timestamptz'
  if (t.includes('timestamp')) return 'timestamp'
  if (t.includes('datetime')) return 'datetime'
  if (t.includes('date')) return 'date'
  if (t.includes('time')) return 'time'
  if (t.includes('blob') || t.includes('bytea') || t.includes('binary') || t.includes('image')) {
    return 'blob'
  }
  if (t.includes('clob') || t.includes('longtext') || t.includes('mediumtext') || t.includes('ntext')) {
    return 'longtext'
  }
  if (
    t.includes('char') ||
    t.includes('text') ||
    t.includes('varchar') ||
    t.includes('enum') ||
    t.includes('xml')
  ) {
    return 'text'
  }
  if (t.includes('bigint') || t.includes('bigserial') || t.includes('int8')) return 'bigint'
  if (t.includes('smallint') || t.includes('tinyint') || t.includes('int2')) return 'smallint'
  if (t.includes('int') || t.includes('serial')) return 'int'
  if (t.includes('numeric') || t.includes('decimal') || t.includes('number') || t.includes('money')) {
    return 'decimal'
  }
  if (
    t.includes('double') ||
    t.includes('float') ||
    t.includes('real') ||
    t.includes('binary_float') ||
    t.includes('binary_double')
  ) {
    return 'float'
  }
  return 'unknown'
}

// Keeps the declared precision/scale of a decimal-ish source type so the target
// does not silently widen or truncate values.
function numericShape(sourceType: string): string {
  const match = /\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/.exec(sourceType)
  if (!match) return ''
  return match[2] !== undefined ? `(${match[1]},${match[2]})` : `(${match[1]})`
}

function textLength(sourceType: string): number | null {
  const match = /\(\s*(\d+)\s*\)/.exec(sourceType)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

export function mapColumnType(
  sourceEngine: DbEngine,
  targetEngine: DbEngine,
  sourceType: string
): string {
  if (sourceEngine === targetEngine) return sourceType
  const family = familyOf(sourceType)

  if (targetEngine === 'sqlite') {
    // SQLite has type affinity, not real types. INTEGER/TEXT/REAL/BLOB are the
    // four useful choices.
    if (family === 'boolean' || family === 'smallint' || family === 'int' || family === 'bigint') {
      return 'INTEGER'
    }
    if (family === 'decimal' || family === 'float') return 'REAL'
    if (family === 'blob') return 'BLOB'
    return 'TEXT'
  }

  if (targetEngine === 'postgres') {
    switch (family) {
      case 'boolean':
        return 'boolean'
      case 'smallint':
        return 'smallint'
      case 'int':
        return 'integer'
      case 'bigint':
        return 'bigint'
      case 'decimal':
        return `numeric${numericShape(sourceType)}`
      case 'float':
        return 'double precision'
      case 'text': {
        const length = textLength(sourceType)
        // PostgreSQL VARCHAR without a length is fine; keep an explicit short
        // length so a tighter source constraint is not silently lost.
        return length && length <= 10485760 ? `varchar(${length})` : 'text'
      }
      case 'longtext':
        return 'text'
      case 'blob':
        return 'bytea'
      case 'date':
        return 'date'
      case 'time':
        return 'time'
      case 'datetime':
      case 'timestamp':
        return 'timestamp'
      case 'timestamptz':
        return 'timestamptz'
      case 'json':
        return 'jsonb'
      case 'uuid':
        return 'uuid'
      default:
        return 'text'
    }
  }

  if (targetEngine === 'oracle') {
    switch (family) {
      case 'boolean':
        return 'NUMBER(1)'
      case 'smallint':
      case 'int':
        return 'NUMBER(10)'
      case 'bigint':
        return 'NUMBER(19)'
      case 'decimal':
        return `NUMBER${numericShape(sourceType) || '(10,2)'}`
      case 'float':
        return 'BINARY_DOUBLE'
      case 'text': {
        const length = textLength(sourceType)
        return length && length <= 4000 ? `VARCHAR2(${length})` : 'CLOB'
      }
      case 'longtext':
        return 'CLOB'
      case 'blob':
        return 'BLOB'
      case 'date':
      case 'datetime':
      case 'timestamp':
      case 'timestamptz':
        return 'TIMESTAMP'
      case 'time':
        return 'VARCHAR2(20)'
      case 'json':
        return 'CLOB'
      case 'uuid':
        return 'RAW(16)'
      default:
        return 'VARCHAR2(4000)'
    }
  }

  // MySQL / MariaDB target.
  switch (family) {
    case 'boolean':
      return 'TINYINT(1)'
    case 'smallint':
      return 'SMALLINT'
    case 'int':
      return 'INT'
    case 'bigint':
      return 'BIGINT'
    case 'decimal':
      return `DECIMAL${numericShape(sourceType) || '(10,2)'}`
    case 'float':
      return 'DOUBLE'
    case 'text': {
      const length = textLength(sourceType)
      return length && length <= 16383 ? `VARCHAR(${length})` : 'TEXT'
    }
    case 'longtext':
      return 'LONGTEXT'
    case 'blob':
      return 'LONGBLOB'
    case 'date':
      return 'DATE'
    case 'time':
      return 'TIME'
    case 'datetime':
    case 'timestamp':
      return 'DATETIME'
    case 'timestamptz':
      return 'DATETIME'
    case 'json':
      return 'JSON'
    case 'uuid':
      return 'CHAR(36)'
    default:
      return 'TEXT'
  }
}
