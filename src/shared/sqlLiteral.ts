import type { DbEngine } from './types'
import { isMysqlFamily } from './ddl'

// SQL literal encoding for the export/dump/backup writers. Three copies of this
// logic used to live in io/handlers.ts, io/backup.ts, and io/databaseDump.ts,
// and all three doubled backslashes unconditionally. With
// standard_conforming_strings=on (the PostgreSQL default) that turns a single
// backslash into two stored characters, so an export followed by a restore
// silently changed the data.
export function sqlStringLiteral(engine: DbEngine, value: string): string {
  // MySQL/MariaDB treat backslash as an escape character inside string
  // literals, so it must be doubled there. PostgreSQL, SQLite, and Oracle
  // treat it literally; doubling would corrupt the value.
  const body = isMysqlFamily(engine)
    ? value.replace(/\\/g, '\\\\').replace(/'/g, "''")
    : value.replace(/'/g, "''")
  return `'${body}'`
}

// Dates are written as engine-native literals. A bare ISO string works in most
// engines, but MySQL rejects the "T" separator in strict datetime columns and
// Oracle formats the value according to NLS settings unless the type is
// explicit, so each engine gets its own spelling.
function dateLiteral(engine: DbEngine, value: Date): string {
  const iso = value.toISOString()
  const date = `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
  if (engine === 'oracle') {
    return `TO_TIMESTAMP(${sqlStringLiteral(engine, `${date}.${iso.slice(20, 23)}`)}, 'YYYY-MM-DD HH24:MI:SS.FF3')`
  }
  if (engine === 'postgres') {
    return sqlStringLiteral(engine, `${date}.${iso.slice(20, 23)}+00`)
  }
  if (engine === 'sqlite') {
    return sqlStringLiteral(engine, `${date}.${iso.slice(20, 23)}`)
  }
  // MySQL/MariaDB: "YYYY-MM-DD HH:MM:SS.mmm".
  return sqlStringLiteral(engine, `${date}.${iso.slice(20, 23)}`)
}

function binaryLiteral(engine: DbEngine, bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex')
  switch (engine) {
    case 'postgres':
      // Hex input format for bytea; safe because backslash is literal here.
      return `'\\x${hex}'::bytea`
    case 'oracle':
      return `hextoraw('${hex}')`
    case 'mongodb':
      throw new Error('MongoDB does not use SQL literals.')
    default:
      // MySQL, MariaDB, and SQLite all accept x'..' blob literals.
      return `x'${hex}'`
  }
}

// Turns a value from a driver result into a SQL literal that round-trips. The
// engine matters: booleans, binary data, and dates have no portable spelling.
export function sqlLiteral(engine: DbEngine, value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') {
    // NaN and Infinity have no SQL literal and would be written as invalid SQL.
    return Number.isFinite(value) ? String(value) : 'NULL'
  }
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') {
    if (engine === 'postgres') return value ? 'TRUE' : 'FALSE'
    // Oracle has no boolean SQL type; NUMBER(1) is the conventional mapping.
    // MySQL and SQLite store booleans as 1/0.
    return value ? '1' : '0'
  }
  if (value instanceof Date) return dateLiteral(engine, value)
  if (value instanceof Uint8Array) return binaryLiteral(engine, value)
  if (typeof value === 'object') {
    // JSON/array columns arrive as objects. Text targets store the JSON text.
    return sqlStringLiteral(engine, JSON.stringify(value))
  }
  return sqlStringLiteral(engine, String(value))
}
