import { useEffect, useRef, useState } from 'react'
import type { DbEngine } from '@shared/types'
import { unwrap } from './api'
import type { MentionedTable } from './aiMention'

export interface MentionCatalogTable {
  database: string
  schema?: string
  name: string
  type: 'table' | 'view'
}

interface CatalogState {
  tables: MentionCatalogTable[]
  loading: boolean
  error: string | null
}

// Lists the tables of one database and loads a table's columns on demand. The
// sidebar cache is not used here: it enumerates every database on the
// connection, which is both slow and wrong for this feature, since mentions are
// scoped to the database the user is working in.
//
// Loading waits for `enabled` (the user typed @) so opening the assistant does
// not query the server for a list the user may never ask for.
export function useMentionCatalog(
  connectionId: string | undefined,
  engine: DbEngine | undefined,
  database: string | undefined,
  schemaName: string | undefined,
  enabled: boolean,
  // Bumped whenever the catalogue may have changed (a table was created,
  // dropped, or renamed). The cache is keyed on it so the picker reloads
  // instead of keeping a list from before the change.
  catalogVersion = 0
): CatalogState & {
  loadColumns: (table: MentionCatalogTable) => Promise<MentionedTable>
} {
  const [state, setState] = useState<CatalogState>({
    tables: [],
    loading: false,
    error: null
  })
  const loadedKey = useRef<string | null>(null)

  const scopeKey =
    connectionId && database && engine
      ? `${connectionId}|${engine}|${database}|${schemaName ?? ''}|${catalogVersion}`
      : null

  useEffect(() => {
    if (!enabled || !scopeKey || !connectionId || !database || !engine) return
    if (engine === 'mongodb') return
    if (loadedKey.current === scopeKey) return
    let cancelled = false
    setState((prev) => ({ ...prev, loading: true, error: null }))
    // Only Postgres and Oracle have a real schema level. Passing one on MySQL
    // would be ignored at best, so the empty value is dropped.
    const schema =
      (engine === 'postgres' || engine === 'oracle') && schemaName
        ? schemaName
        : undefined
    unwrap(window.dbApi.listTables(connectionId, database, schema))
      .then((found) => {
        if (cancelled) return
        loadedKey.current = scopeKey
        setState({
          tables: found.map((t) => ({
            database,
            schema: t.schema,
            name: t.name,
            type: t.type
          })),
          loading: false,
          error: null
        })
      })
      .catch((err) => {
        if (cancelled) return
        // The key stays unset so the next @ retries instead of caching a failure.
        setState({
          tables: [],
          loading: false,
          error: err instanceof Error ? err.message : String(err)
        })
      })
    return () => {
      cancelled = true
    }
  }, [enabled, scopeKey, connectionId, database, engine, schemaName])

  async function loadColumns(table: MentionCatalogTable): Promise<MentionedTable> {
    if (!connectionId) return { ...table, columns: [] }
    try {
      const columns = await unwrap(
        window.dbApi.listColumns(connectionId, table.database, table.name, table.schema)
      )
      return { ...table, columns }
    } catch {
      // A mention without columns still names the table, which is better than
      // blocking the user on a permissions error for one table.
      return { ...table, columns: [] }
    }
  }

  // Between "popup opened" and "effect ran" the list is empty but not loading,
  // which would flash "no matching table". Treat that gap as loading.
  const pending = Boolean(
    enabled && scopeKey && loadedKey.current !== scopeKey && !state.error
  )
  return { ...state, loading: state.loading || pending, loadColumns }
}
