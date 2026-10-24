import type { DbEngine } from './types'
import type { ColumnInputKind } from './columnType'

/** Column kinds that can be set from the database clock. */
export type NowKind = 'date' | 'datetime' | 'time'

/**
 * SQL that means "the current time" for one engine and one column kind.
 *
 * The value is computed by the database, not by the app: a server in another
 * timezone or with a clock correction should write its own now, and a desktop
 * client's clock is not authoritative for an audit column. The kind matters
 * because each engine has a separate function per type; MySQL stores a datetime
 * in a DATE column by truncating and emitting a warning, which is avoidable.
 *
 * MongoDB has no SQL, so the driver uses a JS Date instead and this returns null.
 */
export function nowExpression(engine: DbEngine, kind: NowKind): string | null {
  switch (engine) {
    case 'mysql':
    case 'mariadb':
      if (kind === 'date') return 'CURDATE()'
      if (kind === 'time') return 'CURTIME()'
      return 'NOW()'
    case 'postgres':
      if (kind === 'date') return 'CURRENT_DATE'
      if (kind === 'time') return 'CURRENT_TIME'
      return 'NOW()'
    case 'oracle':
      // CURRENT_TIMESTAMP keeps the session time zone, which is what a DATE or
      // TIMESTAMP column expects from SYSDATE-style defaults.
      if (kind === 'date') return 'TRUNC(CURRENT_TIMESTAMP)'
      if (kind === 'time') return "TO_CHAR(CURRENT_TIMESTAMP, 'HH24:MI:SS')"
      return 'CURRENT_TIMESTAMP'
    case 'sqlite':
      // CURRENT_TIMESTAMP is UTC. SQLite has no server time zone, so the local
      // clock is what the user expects to see in the grid.
      if (kind === 'date') return "date('now','localtime')"
      if (kind === 'time') return "time('now','localtime')"
      return "datetime('now','localtime')"
    case 'mongodb':
      return null
  }
}

/** The column kinds the "set to now" menu item applies to. */
export function isNowKind(kind: ColumnInputKind): kind is NowKind {
  return kind === 'date' || kind === 'datetime' || kind === 'time'
}
