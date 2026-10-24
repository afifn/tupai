import { useCallback, useEffect, useRef, useState } from 'react'
import type { DbEngine, RoutineInfo, SavedQuery, TableInfo } from '@shared/types'
import { unwrap } from './api'
import { useLocale } from './i18n'
import {
  IconCaret,
  IconDatabase,
  IconQuery,
  IconRoutine,
  IconSchema,
  IconTable,
  IconView
} from './Icons'

export interface SelectedTable {
  connectionId: string
  engine: DbEngine
  database: string
  schema?: string
  table: string
  // Views get a Definition tab; tables do not.
  type?: 'table' | 'view'
}

export interface DatabaseTarget {
  connectionId: string
  engine: DbEngine
  database: string
}

export interface TableTarget {
  connectionId: string
  engine: DbEngine
  database: string
  schema?: string
  table: string
  type: 'table' | 'view'
}

export interface SchemaTarget {
  connectionId: string
  engine: DbEngine
  database: string
  schema: string
}

export interface RoutineTarget {
  connectionId: string
  engine: DbEngine
  database: string
  schema?: string
  routine: RoutineInfo
}

interface Props {
  connectionId: string
  engine: DbEngine
  // Database and schema the active tab works in. Only these get the accent
  // colour; expansion alone is a caret state, not a location.
  activeDatabase?: string
  activeSchema?: string
  selected: SelectedTable | null
  onSelectTable: (sel: SelectedTable) => void
  onOpenQuery: (query: SavedQuery) => void
  onContextQuery: (query: SavedQuery, x: number, y: number) => void
  onContextDatabase: (target: DatabaseTarget, x: number, y: number) => void
  onContextSchema: (target: SchemaTarget, x: number, y: number) => void
  onContextTable: (target: TableTarget, x: number, y: number) => void
  onContextRoutine: (target: RoutineTarget, x: number, y: number) => void
  // Clicking a routine shows its CREATE statement.
  onOpenDefinition: (target: RoutineTarget) => void
  version: number
  queryVersion: number
  // Sidebar filter term. Empty means no filtering. Matching is client-side over
  // what the tree has loaded, so the parent also uses the reported result to
  // hide connections that contain nothing.
  filter?: string
  onFilterResult?: (result: { matches: number; pending: boolean }) => void
}

type NodeState = 'idle' | 'loading' | 'error'

const SCHEMA_ENGINES: DbEngine[] = ['postgres', 'oracle']

export function ExplorerTree({
  connectionId,
  engine,
  activeDatabase,
  activeSchema,
  selected,
  onSelectTable,
  onOpenQuery,
  onContextQuery,
  onContextDatabase,
  onContextSchema,
  onContextTable,
  onContextRoutine,
  onOpenDefinition,
  version,
  queryVersion,
  filter,
  onFilterResult
}: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [databases, setDatabases] = useState<string[] | null>(null)
  const [dbState, setDbState] = useState<NodeState>('loading')
  const [dbError, setDbError] = useState<string | null>(null)

  // Navicat keeps every database and schema you open expanded at the same time,
  // so these are sets instead of a single "current" node. Loading state is also
  // per key; a single flag would make one database's spinner hide another's
  // already loaded tables.
  const [expandedDbs, setExpandedDbs] = useState<Set<string>>(new Set())
  const [schemasByDb, setSchemasByDb] = useState<Record<string, string[]>>({})
  const [loadingSchemas, setLoadingSchemas] = useState<Set<string>>(new Set())

  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set())
  const [tablesByKey, setTablesByKey] = useState<Record<string, TableInfo[]>>({})
  const [loadingTables, setLoadingTables] = useState<Set<string>>(new Set())

  const [routinesByKey, setRoutinesByKey] = useState<Record<string, RoutineInfo[]>>({})

  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>([])
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const usesSchemas = SCHEMA_ENGINES.includes(engine)

  // The filter hides rows whose label does not contain the term. It is
  // deliberately client-side: the tree already knows what it loaded, and asking
  // the server on every keystroke would make a wide search slow. Branches are
  // expanded while filtering (below) so their contents actually load, otherwise
  // only database names could ever match.
  const filterTerm = (filter ?? '').trim().toLowerCase()
  const filterActive = filterTerm.length > 0

  function hit(value: string | undefined | null): boolean {
    return filterActive && (value ?? '').toLowerCase().includes(filterTerm)
  }

  function visibleTables(key: string, showAll: boolean): TableInfo[] {
    const list = tablesByKey[key] ?? []
    return filterActive && !showAll ? list.filter((item) => hit(item.name)) : list
  }

  function visibleRoutines(key: string, showAll: boolean): RoutineInfo[] {
    const list = routinesByKey[key] ?? []
    return filterActive && !showAll ? list.filter((item) => hit(item.name)) : list
  }

  function visibleQueries(
    db: string,
    schema: string | undefined,
    showAll: boolean
  ): SavedQuery[] {
    const list = savedQueries.filter(
      (q) => q.database === db && (q.schema ?? undefined) === (schema ?? undefined)
    )
    return filterActive && !showAll ? list.filter((q) => hit(q.name)) : list
  }

  // A branch matches when its own name matches or one of its children does.
  function branchHit(db: string, schema: string | undefined): boolean {
    const key = schema ? `${db}.${schema}` : db
    if (hit(schema)) return true
    if (visibleTables(key, false).length > 0) return true
    if (visibleRoutines(key, false).length > 0) return true
    if (visibleQueries(db, schema, false).length > 0) return true
    return false
  }

  function databaseHit(db: string): boolean {
    if (hit(db)) return true
    if (!usesSchemas) return branchHit(db, undefined)
    // A schema's children only exist once it has been loaded; while filtering the
    // effect below loads them, and this returns false until then.
    return (schemasByDb[db] ?? []).some((schema) => hit(schema) || branchHit(db, schema))
  }

  const filterPending =
    dbState === 'loading' || loadingTables.size > 0 || loadingSchemas.size > 0
  const filterHasMatch = (databases ?? []).some((db) => databaseHit(db))

  // The parent hides connections that contain nothing, so it needs to know both
  // the result and whether a branch is still loading.
  const filterResultRef = useRef(onFilterResult)
  filterResultRef.current = onFilterResult
  useEffect(() => {
    filterResultRef.current?.({
      matches: filterHasMatch ? 1 : 0,
      pending: filterPending
    })
  }, [filterHasMatch, filterPending])

  // Tracks the last DDL version handled so the mount run is skipped; the
  // connection-change reset is handled by its own effect.
  const lastVersion = useRef(version)

  const loadQueries = useCallback(() => {
    unwrap(window.dbApi.listSavedQueries(connectionId))
      .then(setSavedQueries)
      .catch(() => setSavedQueries([]))
  }, [connectionId])

  const loadDatabases = useCallback(() => {
    return unwrap(window.dbApi.listDatabases(connectionId))
      .then((dbs) => {
        setDatabases(dbs)
        setDbState('idle')
      })
      .catch((err) => {
        setDbError(errorText(err))
        setDbState('error')
      })
  }, [connectionId])

  const loadSchemas = useCallback(
    async (db: string): Promise<void> => {
      setLoadingSchemas((prev) => new Set(prev).add(db))
      try {
        const schemas = await unwrap(window.dbApi.listSchemas(connectionId, db))
        setSchemasByDb((prev) => ({ ...prev, [db]: schemas }))
      } catch {
        setSchemasByDb((prev) => ({ ...prev, [db]: [] }))
      } finally {
        setLoadingSchemas((prev) => {
          const next = new Set(prev)
          next.delete(db)
          return next
        })
      }
    },
    [connectionId]
  )

  const loadTables = useCallback(
    async (db: string, schema: string | undefined, force = false): Promise<void> => {
      const key = schema ? `${db}.${schema}` : db
      if (!force && tablesByKey[key]) return
      setLoadingTables((prev) => new Set(prev).add(key))
      try {
        const tables = await unwrap(window.dbApi.listTables(connectionId, db, schema))
        setTablesByKey((prev) => ({ ...prev, [key]: tables }))
      } catch {
        setTablesByKey((prev) => ({ ...prev, [key]: [] }))
      } finally {
        setLoadingTables((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    [connectionId, tablesByKey]
  )

  const loadRoutines = useCallback(
    async (db: string, schema: string | undefined): Promise<void> => {
      if (engine === 'mongodb') return
      const key = schema ? `${db}.${schema}` : db
      try {
        const routines = await unwrap(window.dbApi.listRoutines(connectionId, db, schema))
        setRoutinesByKey((prev) => ({ ...prev, [key]: routines }))
      } catch {
        setRoutinesByKey((prev) => ({ ...prev, [key]: [] }))
      }
    },
    [connectionId, engine]
  )

  // Expand every branch while filtering so its tables and routines are loaded
  // and can be matched. loadTables/loadSchemas return early once cached, so this
  // does not refetch on every keystroke.
  useEffect(() => {
    if (!filterActive) return
    for (const db of databases ?? []) {
      setExpandedDbs((prev) => (prev.has(db) ? prev : new Set(prev).add(db)))
      void loadTables(db, undefined)
      void loadRoutines(db, undefined)
      if (usesSchemas) void loadSchemas(db)
    }
  }, [
    filterActive,
    filterTerm,
    databases,
    usesSchemas,
    loadTables,
    loadRoutines,
    loadSchemas
  ])

  useEffect(() => {
    if (!filterActive) return
    for (const [db, list] of Object.entries(schemasByDb)) {
      for (const schema of list) {
        const key = `${db}.${schema}`
        setExpandedSchemas((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
        void loadTables(db, schema)
        void loadRoutines(db, schema)
      }
    }
  }, [filterActive, filterTerm, schemasByDb, loadTables, loadRoutines])
  // Full reset only when the connection changes: the previously expanded
  // database/schema belong to another server.
  useEffect(() => {
    setDatabases(null)
    setDbState('loading')
    setDbError(null)
    setExpandedDbs(new Set())
    setSchemasByDb({})
    setExpandedSchemas(new Set())
    setTablesByKey({})
    void loadDatabases()
  }, [loadDatabases])

  // Structural refresh (DDL): reload the visible database/schema/tables but
  // keep expansion state so the tree does not collapse under the user.
  useEffect(() => {
    if (lastVersion.current === version) return
    lastVersion.current = version
    void loadDatabases()
    // Refresh every open branch, not just one, so a DDL change updates all the
    // databases and schemas the user has expanded.
    for (const db of expandedDbs) {
      if (!usesSchemas) {
        void loadTables(db, undefined, true)
        continue
      }
      void loadSchemas(db)
    }
    for (const key of expandedSchemas) {
      const dot = key.indexOf('.')
      if (dot < 0) continue
      void loadTables(key.slice(0, dot), key.slice(dot + 1), true)
    }
  }, [version])

  // Saved queries live in a separate store: reload just that list so tree
  // expansion state is preserved when a query is saved, renamed, or deleted.
  useEffect(() => {
    loadQueries()
  }, [loadQueries, queryVersion])

  function groupKey(...parts: string[]): string {
    return parts.join('\u0000')
  }

  function toggleGroup(key: string): void {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function expandDatabase(db: string): Promise<void> {
    setExpandedDbs((prev) => new Set(prev).add(db))

    if (!usesSchemas) {
      await Promise.all([loadTables(db, undefined), loadRoutines(db, undefined)])
      return
    }
    if (schemasByDb[db]) return
    await loadSchemas(db)
  }

  function toggleDatabase(db: string): void {
    if (expandedDbs.has(db)) {
      // Collapsing a database closes its schemas too, otherwise reopening it
      // would show stale children from a branch the user already closed.
      setExpandedDbs((prev) => {
        const next = new Set(prev)
        next.delete(db)
        return next
      })
      setExpandedSchemas((prev) => {
        const next = new Set(prev)
        for (const key of next) {
          if (key.startsWith(`${db}.`)) next.delete(key)
        }
        return next
      })
      return
    }
    void expandDatabase(db)
  }

  async function toggleSchema(db: string, schema: string): Promise<void> {
    const key = `${db}.${schema}`
    if (expandedSchemas.has(key)) {
      setExpandedSchemas((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      return
    }
    setExpandedSchemas((prev) => new Set(prev).add(key))
    await Promise.all([loadTables(db, schema), loadRoutines(db, schema)])
  }

  // Container rows (Tables, Views, Queries) are navigation, not objects: the
  // caret says they open, the count says how much is inside. A second icon on
  // every one of them only competed with the object rows below it.
  function renderGroup(
    label: string,
    key: string,
    items: JSX.Element[]
  ): JSX.Element | null {
    if (items.length === 0) return null
    const isCollapsed = collapsedGroups.has(key)
    return (
      <div className="tree__group">
        <button
          className="tree__row tree__row--group"
          onClick={() => toggleGroup(key)}
          aria-expanded={!isCollapsed}
        >
          <span className="tree__caret">
            <IconCaret open={!isCollapsed} />
          </span>
          <span className="tree__label">
            {label} <span className="tree__count">({items.length})</span>
          </span>
        </button>
        {!isCollapsed && <div className="tree__children">{items}</div>}
      </div>
    )
  }

  function renderQueries(db: string, schema: string | undefined): JSX.Element | null {
    // While filtering, a group only appears when something inside it matches,
    // unless the group's own container is the only hit.
    // A database whose own name matches shows all of its children, including
    // through the schema level: the user searched for the database.
    const showAll = hit(schema) || hit(db)
    const items = visibleQueries(db, schema, showAll).map((q) => (
      <button
        key={q.id}
        className="tree__row tree__row--table"
        onClick={() => onOpenQuery(q)}
        onContextMenu={(e) => {
          e.preventDefault()
          onContextQuery(q, e.clientX, e.clientY)
        }}
        title={q.sql}
      >
        <span className="tree__icon">
          <IconQuery size={14} />
        </span>
        <span className="tree__label">{q.name}</span>
      </button>
    ))
    return renderGroup(
      tr('explorer.queries'),
      groupKey(db, schema ?? '', 'queries'),
      items
    )
  }

  function renderSchemaChildren(db: string, schema: string | undefined): JSX.Element {
    const key = schema ? `${db}.${schema}` : db
    // When the branch's own name matches, everything inside it is relevant;
    // otherwise only the children whose names match are shown. A database match
    // applies through the schema level too: the user searched for the database.
    const showAll = hit(schema) || hit(db)
    const tables = visibleTables(key, showAll)
    const routines = visibleRoutines(key, showAll)

    if (loadingTables.has(key) && tables.length === 0)
      return <p className="muted tree-pad">{tr('explorer.loadingObjects')}</p>

    const tableItems = tables
      .filter((t) => t.type === 'table')
      .map((t) => renderTableButton(db, schema, t))
    const viewItems = tables
      .filter((t) => t.type === 'view')
      .map((t) => renderTableButton(db, schema, t))

    const routineItems = routines.map((r) => renderRoutineButton(db, schema, r))

    const hasAnything =
      tableItems.length > 0 || viewItems.length > 0 || routineItems.length > 0
    const queryGroup = renderQueries(db, schema)

    if (!hasAnything && !queryGroup)
      return filterActive ? (
        <></>
      ) : (
        <p className="muted tree-pad">{tr('explorer.noObjects')}</p>
      )

    return (
      <>
        {renderGroup(
          tr('explorer.tables'),
          groupKey(db, schema ?? '', 'tables'),
          tableItems
        )}
        {renderGroup(
          tr('explorer.views'),
          groupKey(db, schema ?? '', 'views'),
          viewItems
        )}
        {renderGroup(
          tr('explorer.routines'),
          groupKey(db, schema ?? '', 'routines'),
          routineItems
        )}
        {queryGroup}
      </>
    )
  }

  function renderRoutineButton(
    db: string,
    schema: string | undefined,
    r: RoutineInfo
  ): JSX.Element {
    return (
      <button
        key={`${r.kind}:${r.name}`}
        className="tree__row tree__row--table"
        onClick={() =>
          onOpenDefinition({ connectionId, engine, database: db, schema, routine: r })
        }
        onContextMenu={(e) => {
          e.preventDefault()
          onContextRoutine(
            { connectionId, engine, database: db, schema, routine: r },
            e.clientX,
            e.clientY
          )
        }}
        title={`${r.kind}${r.detail ? ` · ${r.detail}` : ''}`}
      >
        <span className="tree__icon">
          <IconRoutine size={14} />
        </span>
        <span className="tree__label">{r.name}</span>
        <span className="tree__tag">{r.kind}</span>
      </button>
    )
  }

  function renderTableButton(
    db: string,
    schema: string | undefined,
    t: TableInfo
  ): JSX.Element {
    const tableKey = `${db}.${schema ?? ''}.${t.name}`
    const isSelected =
      selected?.database === db &&
      selected?.table === t.name &&
      (selected?.schema ?? undefined) === (schema ?? undefined)
    return (
      <button
        key={tableKey}
        className={`tree__row tree__row--table${isSelected ? ' is-selected' : ''}`}
        onClick={() =>
          onSelectTable({
            connectionId,
            engine,
            database: db,
            schema,
            table: t.name,
            type: t.type
          })
        }
        onContextMenu={(e) => {
          e.preventDefault()
          onContextTable(
            {
              connectionId,
              engine,
              database: db,
              schema,
              table: t.name,
              type: t.type
            },
            e.clientX,
            e.clientY
          )
        }}
        aria-pressed={isSelected}
      >
        <span className="tree__icon">
          {t.type === 'view' ? <IconView size={14} /> : <IconTable size={14} />}
        </span>
        <span className="tree__label">{t.name}</span>
      </button>
    )
  }

  if (dbState === 'loading')
    return <p className="muted tree-pad">{tr('explorer.loadingDatabases')}</p>
  if (dbState === 'error')
    return (
      <p className="notice notice--error tree-pad" role="alert">
        {tr('explorer.databasesFailed', { message: dbError ?? '' })}
      </p>
    )
  if (!databases || databases.length === 0)
    return <p className="muted tree-pad">{tr('explorer.noDatabases')}</p>

  // While filtering, a database with no matching child is hidden so the tree
  // reads as the result set rather than the full catalogue with some rows gone.
  const visibleDatabases = filterActive ? databases.filter(databaseHit) : databases

  if (filterActive && !filterPending && visibleDatabases.length === 0)
    return <p className="muted tree-pad">{tr('explorer.noObjectMatch')}</p>

  return (
    <div className="tree">
      {visibleDatabases.map((db) => {
        const isDbOpen = expandedDbs.has(db)
        const isDbActive = activeDatabase === db
        const schemas = schemasByDb[db] ?? []
        const schemaLoading = loadingSchemas.has(db)
        return (
          <div key={db}>
            <button
              className={`tree__row tree__row--db${isDbOpen ? ' is-open' : ''}${
                isDbActive ? ' is-active' : ''
              }`}
              onClick={() => toggleDatabase(db)}
              onContextMenu={(e) => {
                e.preventDefault()
                onContextDatabase(
                  { connectionId, engine, database: db },
                  e.clientX,
                  e.clientY
                )
              }}
              aria-expanded={isDbOpen}
            >
              <span className="tree__caret">
                <IconCaret open={isDbOpen} />
              </span>
              <span className="tree__icon">
                <IconDatabase />
              </span>
              <span className="tree__label">{db}</span>
            </button>
            {isDbOpen && (
              <div className="tree__children">
                {usesSchemas ? (
                  schemaLoading && schemas.length === 0 ? (
                    <p className="muted tree-pad">{tr('explorer.loadingSchemas')}</p>
                  ) : schemas.length === 0 ? (
                    <p className="muted tree-pad">{tr('explorer.noSchemas')}</p>
                  ) : (
                    // A database whose own name matched shows all its schemas:
                    // the user searched for the database, not for a schema.
                    (filterActive && !hit(db)
                      ? schemas.filter((s) => hit(s) || branchHit(db, s))
                      : schemas
                    ).map((schema) => {
                      const schemaKey = `${db}.${schema}`
                      const isSchemaOpen = expandedSchemas.has(schemaKey)
                      const isSchemaActive = isDbActive && activeSchema === schema
                      return (
                        <div key={schemaKey}>
                          <button
                            className={`tree__row tree__row--schema${
                              isSchemaActive ? ' is-active' : ''
                            }`}
                            onClick={() => void toggleSchema(db, schema)}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              onContextSchema(
                                { connectionId, engine, database: db, schema },
                                e.clientX,
                                e.clientY
                              )
                            }}
                            aria-expanded={isSchemaOpen}
                          >
                            <span className="tree__caret">
                              <IconCaret open={isSchemaOpen} />
                            </span>
                            <span className="tree__icon">
                              <IconSchema />
                            </span>
                            <span className="tree__label">{schema}</span>
                          </button>
                          {isSchemaOpen && (
                            <div className="tree__children">
                              {renderSchemaChildren(db, schema)}
                            </div>
                          )}
                        </div>
                      )
                    })
                  )
                ) : (
                  renderSchemaChildren(db, undefined)
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
