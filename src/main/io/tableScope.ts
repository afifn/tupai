import type { DbEngine, TableInfo } from '@shared/types'
import { quoteIdent } from '@shared/ddl'
import { DbWorkerClient } from '../workers/dbWorkerClient'

// Backup and dump used to call listTables(database) without a schema. On
// PostgreSQL that silently dumps only the `public` schema, so every table in
// another schema was missing from the file with no warning.
//
// Only PostgreSQL gets the per-schema walk. MySQL/MariaDB have no schema level
// (the database is the qualifier), SQLite has a single `main`, and Oracle's
// `listSchemas` returns every database user, not just the connected one, so
// iterating it would try to read tables the user may not own.
export async function listScopedTables(
  client: DbWorkerClient,
  connectionId: string,
  database: string,
  engine: DbEngine
): Promise<TableInfo[]> {
  if (engine !== 'postgres') {
    return client.call<TableInfo[]>('listTables', { connectionId, database })
  }

  const schemas = await client.call<string[]>('listSchemas', {
    connectionId,
    database
  })
  if (schemas.length === 0) {
    return client.call<TableInfo[]>('listTables', { connectionId, database })
  }

  const tables: TableInfo[] = []
  const seen = new Set<string>()
  for (const schema of schemas) {
    const found = await client.call<TableInfo[]>('listTables', {
      connectionId,
      database,
      schema
    })
    for (const table of found) {
      const key = `${table.schema ?? ''}.${table.name}`
      if (seen.has(key)) continue
      seen.add(key)
      tables.push(table)
    }
  }
  return tables
}

// A dump that contains tables from a non-public schema is not restorable unless
// the schema itself is created first: CREATE TABLE "smoke_extra"."x" fails with
// "schema does not exist". Only PostgreSQL needs this; MySQL qualifies with the
// database name and Oracle's schema is the owning user.
export function schemaPrelude(engine: DbEngine, tables: TableInfo[]): string[] {
  if (engine !== 'postgres') return []
  const schemas = new Set<string>()
  for (const table of tables) {
    const schema = table.schema
    if (schema && schema !== 'public') schemas.add(schema)
  }
  return [...schemas].map(
    (schema) => `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(engine, schema)};`
  )
}
