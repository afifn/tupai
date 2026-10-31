import type { DbEngine } from './types'

// MariaDB shares MySQL's SQL dialect: backtick identifiers, `db`.`table`
// qualification and the same DDL/privilege grammar.
//
// Kept in its own module so the type catalog and the DDL builder can both use it
// without importing each other.
export function isMysqlFamily(engine: DbEngine): boolean {
  return engine === 'mysql' || engine === 'mariadb'
}
