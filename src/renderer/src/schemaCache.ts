import type { ColumnInfo } from '@shared/types'
import { unwrap } from './api'

export interface CachedTable {
  database: string
  schema?: string
  name: string
  columns: ColumnInfo[]
}

interface Cache {
  connectionId: string
  tables: CachedTable[]
}

let cache: Cache | null = null
const listeners = new Set<() => void>()
let priming: Promise<void> | null = null

const MAX_TABLES = 400
const MAX_COLUMNS = 4000

export function onSchemaChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify(): void {
  for (const fn of listeners) fn()
}

export function getTables(connectionId: string): CachedTable[] {
  if (!cache || cache.connectionId !== connectionId) return []
  return cache.tables
}

export function clearSchemaCache(): void {
  cache = null
  notify()
}

export async function primeSchemaCache(connectionId: string): Promise<void> {
  if (cache?.connectionId === connectionId) return
  if (priming) await priming
  if (cache?.connectionId === connectionId) return

  priming = (async () => {
    const tables: CachedTable[] = []
    let succeeded = false
    try {
      const databases = await unwrap(window.dbApi.listDatabases(connectionId))
      let columnBudget = MAX_COLUMNS
      for (const db of databases) {
        if (tables.length >= MAX_TABLES) break
        let schemas: (string | undefined)[] = [undefined]
        try {
          const found = await unwrap(window.dbApi.listSchemas(connectionId, db))
          if (found.length > 0) schemas = found
        } catch {
          schemas = [undefined]
        }
        for (const schema of schemas) {
          if (tables.length >= MAX_TABLES || columnBudget <= 0) break
          const dbTables = await unwrap(
            window.dbApi.listTables(connectionId, db, schema)
          )
          for (const t of dbTables) {
            if (tables.length >= MAX_TABLES || columnBudget <= 0) break
            let columns: ColumnInfo[] = []
            try {
              columns = await unwrap(
                window.dbApi.listColumns(connectionId, db, t.name, schema)
              )
            } catch {
              columns = []
            }
            columnBudget -= columns.length
            tables.push({ database: db, schema, name: t.name, columns })
          }
        }
        cache = { connectionId, tables: [...tables] }
        notify()
      }
      succeeded = true
    } catch {
      // Leave the cache empty so the next attempt retries instead of being
      // pinned to an empty result for this connection.
      succeeded = false
    } finally {
      if (succeeded) cache = { connectionId, tables }
      notify()
      priming = null
    }
  })()

  await priming
}
