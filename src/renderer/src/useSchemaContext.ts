import { useEffect, useRef, useState } from 'react'
import type { DbEngine } from '@shared/types'
import { buildSchemaSummary, sortForPrompt, type SchemaTable } from '@shared/aiSchema'
import { unwrap } from './api'

// Loads a compact description of the database the user is working in, so the
// assistant can answer "analyse this database" without the user opening a table
// or typing an @mention first.
//
// Scope is one database on purpose. Enumerating every database on the
// connection is what the sidebar cache does, and it is both slow and wrong here:
// a question is about the database in front of the user. Columns are fetched
// lazily per table with a hard budget, because a 300-table schema would
// otherwise spend the whole prompt on names.
//
// Failures are silent by design: the assistant still answers without a schema,
// and an error banner in the chat panel for a background fetch would be noise.

const MAX_TABLES = 80
const MAX_COLUMN_FETCHES = 30

export interface SchemaContextState {
  /** Ready-to-send block, or undefined while loading or when unavailable. */
  context: string | undefined
  loading: boolean
}

export function useSchemaContext(
  connectionId: string | undefined,
  engine: DbEngine | undefined,
  database: string | undefined,
  schemaName: string | undefined,
  // Bumped when the schema may have changed (table created, dropped, renamed).
  catalogVersion = 0
): SchemaContextState {
  const [state, setState] = useState<SchemaContextState>({
    context: undefined,
    loading: false
  })
  // The loaded key is kept in a ref so a re-render with the same scope does not
  // refetch; the state only carries what the UI needs.
  const loadedKey = useRef<string | null>(null)

  useEffect(() => {
    if (!connectionId || !database || !engine) {
      setState({ context: undefined, loading: false })
      return
    }
    // MongoDB has no columns or SQL, and the document store is not described by
    // a table list in the same way; the assistant answers from the collection
    // name the user mentions instead.
    if (engine === 'mongodb') {
      setState({ context: undefined, loading: false })
      return
    }

    const key = `${connectionId}|${engine}|${database}|${schemaName ?? ''}|${catalogVersion}`
    if (loadedKey.current === key) return

    let cancelled = false
    setState({ context: undefined, loading: true })

    // Only Postgres and Oracle have a real schema level. Passing one on MySQL
    // would be ignored at best, so the empty value is dropped.
    const schema =
      (engine === 'postgres' || engine === 'oracle') && schemaName
        ? schemaName
        : undefined

    void (async () => {
      try {
        const listed = await unwrap(
          window.dbApi.listTables(connectionId, database, schema)
        )
        const tables: SchemaTable[] = listed.slice(0, MAX_TABLES).map((t) => ({
          name: t.name,
          schema: t.schema,
          type: t.type,
          columns: []
        }))

        // Columns for the first few tables, in the same order the summary shows
        // them, so the detail lands on the tables the model reads first.
        const ordered = sortForPrompt(tables)
        let fetches = 0
        for (const table of ordered) {
          if (fetches >= MAX_COLUMN_FETCHES || cancelled) break
          fetches += 1
          try {
            table.columns = await unwrap(
              window.dbApi.listColumns(
                connectionId,
                database,
                table.name,
                table.schema ?? schema
              )
            )
          } catch {
            // A table the user cannot read still belongs in the list by name.
            table.columns = []
          }
        }

        if (cancelled) return
        loadedKey.current = key
        setState({
          context: buildSchemaSummary(engine, database, ordered),
          loading: false
        })
      } catch {
        if (cancelled) return
        // Leave the key unset so a later open retries instead of caching a
        // failure for the whole session.
        setState({ context: undefined, loading: false })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [connectionId, engine, database, schemaName, catalogVersion])

  return state
}
