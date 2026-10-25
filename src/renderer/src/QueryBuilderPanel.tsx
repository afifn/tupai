import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ColumnInfo,
  DbEngine,
  ForeignKeyInfo,
  QueryResultSet,
  TableInfo
} from '@shared/types'
import {
  AGGREGATE_LABELS,
  EMPTY_BUILDER_STATE,
  JOIN_LABELS,
  buildQuerySql,
  newId,
  nextAlias,
  suggestJoins,
  type BuilderAggregate,
  type BuilderFilter,
  type BuilderJoinType,
  type BuilderProjection,
  type BuilderState,
  type BuilderTable
} from '@shared/queryBuilder'
import {
  FILTER_OPERATORS,
  FILTER_OPERATOR_LABELS,
  operatorNeedsValue
} from '@shared/filter'
import { unwrap } from './api'
import { useLocale } from './i18n'
import { pickDefaultDatabase } from '@shared/databaseChoice'

interface Props {
  connectionId: string
  engine: DbEngine
  database: string
  schema?: string
  onOpenSql: (sql: string) => void
}

interface FlatColumn {
  tableId: string
  alias: string
  column: string
  dataType: string
}

const MAX_ROWS = 200

export function QueryBuilderPanel({
  connectionId,
  engine,
  database: initialDatabase,
  schema: initialSchema,
  onOpenSql
}: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [state, setState] = useState<BuilderState>(EMPTY_BUILDER_STATE)
  const [available, setAvailable] = useState<TableInfo[]>([])
  const [loadingTables, setLoadingTables] = useState(true)
  const [adding, setAdding] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The builder owns its database/schema so the user can switch without
  // reopening the tab.
  const [databases, setDatabases] = useState<string[]>([])
  const [database, setDatabase] = useState(initialDatabase)
  const [schemas, setSchemas] = useState<string[]>([])
  const [schema, setSchema] = useState<string | undefined>(initialSchema)
  const [joinSuggestions, setJoinSuggestions] = useState<
    {
      leftTableId: string
      leftColumn: string
      rightTableId: string
      rightColumn: string
    }[]
  >([])
  const [manualJoin, setManualJoin] = useState<{
    type: BuilderJoinType
    leftTableId: string
    leftColumn: string
    rightTableId: string
    rightColumn: string
  }>({
    type: 'inner',
    leftTableId: '',
    leftColumn: '',
    rightTableId: '',
    rightColumn: ''
  })
  const [joinFormOpen, setJoinFormOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<QueryResultSet[] | null>(null)

  useEffect(() => {
    let cancelled = false
    unwrap(window.dbApi.listDatabases(connectionId))
      .then((found) => {
        if (!cancelled) setDatabases(found)
      })
      .catch(() => {
        if (!cancelled) setDatabases([])
      })
    return () => {
      cancelled = true
    }
  }, [connectionId])

  useEffect(() => {
    let cancelled = false
    unwrap(window.dbApi.listSchemas(connectionId, database))
      .then((found) => {
        if (cancelled) return
        setSchemas(found)
        setSchema((prev) => {
          if (prev && found.includes(prev)) return prev
          return pickDefaultDatabase(found)
        })
      })
      .catch(() => {
        if (!cancelled) setSchemas([])
      })
    return () => {
      cancelled = true
    }
  }, [connectionId, database])

  useEffect(() => {
    let cancelled = false
    setLoadingTables(true)
    setError(null)
    unwrap(window.dbApi.listTables(connectionId, database, schema))
      .then((tables) => {
        if (!cancelled) setAvailable(tables)
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err))
      })
      .finally(() => {
        if (!cancelled) setLoadingTables(false)
      })
    return () => {
      cancelled = true
    }
  }, [connectionId, database, schema])

  // A new connection or database invalidates the canvas: aliases and columns
  // belong to the previous target.
  useEffect(() => {
    setState(EMPTY_BUILDER_STATE)
    setJoinSuggestions([])
    setResults(null)
    setNotice(null)
  }, [connectionId, database, schema])

  const flatColumns: FlatColumn[] = useMemo(
    () =>
      state.tables.flatMap((table) =>
        table.columns.map((column) => ({
          tableId: table.id,
          alias: table.alias,
          column: column.name,
          dataType: column.dataType
        }))
      ),
    [state.tables]
  )

  const built = useMemo(() => buildQuerySql(engine, state), [engine, state])

  const addTable = useCallback(
    async (name: string): Promise<void> => {
      setError(null)
      setNotice(null)
      const existing = state.tables.find((t) => t.table === name)
      if (existing) {
        setNotice(tr('qb.tableAlreadyOnCanvas', { name }))
        return
      }
      try {
        const columns = await unwrap(
          window.dbApi.listColumns(connectionId, database, name, schema)
        )
        const table: BuilderTable = {
          id: newId('tbl'),
          database,
          schema,
          table: name,
          alias: nextAlias(state, name),
          columns: columns.map((c: ColumnInfo) => ({
            name: c.name,
            dataType: c.dataType,
            isPrimaryKey: c.isPrimaryKey
          }))
        }
        const nextState: BuilderState = {
          ...state,
          tables: [...state.tables, table]
        }
        setState(nextState)
        setAdding('')

        // Foreign keys on the new table (and on existing ones pointing at it)
        // become one-click join suggestions.
        const keys: ForeignKeyInfo[] = []
        try {
          keys.push(
            ...(await unwrap(
              window.dbApi.listForeignKeys(connectionId, database, name, schema)
            ))
          )
        } catch {
          // A view has no foreign keys; that is not an error.
        }
        const fkInput = [
          ...keys.map((fk) => ({
            tableId: table.id,
            columns: fk.columns,
            refTable: fk.refTable,
            refSchema: fk.refSchema,
            refColumns: fk.refColumns
          })),
          ...(
            await Promise.all(
              state.tables.map(async (existingTable) => {
                try {
                  const found = await unwrap(
                    window.dbApi.listForeignKeys(
                      connectionId,
                      database,
                      existingTable.table,
                      schema
                    )
                  )
                  return found
                    .filter((fk) => fk.refTable.toLowerCase() === name.toLowerCase())
                    .map((fk) => ({
                      tableId: existingTable.id,
                      columns: fk.columns,
                      refTable: fk.refTable,
                      refSchema: fk.refSchema,
                      refColumns: fk.refColumns
                    }))
                } catch {
                  return []
                }
              })
            )
          ).flat()
        ]
        setJoinSuggestions(suggestJoins(nextState, fkInput))
      } catch (err) {
        setError(errorText(err))
      }
    },
    [connectionId, database, schema, state]
  )

  function removeTable(tableId: string): void {
    setState((prev) => ({
      ...prev,
      tables: prev.tables.filter((t) => t.id !== tableId),
      joins: prev.joins.filter(
        (j) => j.leftTableId !== tableId && j.rightTableId !== tableId
      ),
      projections: prev.projections.filter((p) => p.tableId !== tableId),
      filters: prev.filters.filter((f) => f.tableId !== tableId),
      groups: prev.groups.filter((g) => g.tableId !== tableId),
      sorts: prev.sorts.filter((s) => s.tableId !== tableId)
    }))
    setJoinSuggestions((prev) =>
      prev.filter((s) => s.leftTableId !== tableId && s.rightTableId !== tableId)
    )
  }

  function setAlias(tableId: string, alias: string): void {
    setState((prev) => ({
      ...prev,
      tables: prev.tables.map((t) => (t.id === tableId ? { ...t, alias } : t))
    }))
  }

  function toggleProjection(tableId: string, column: string): void {
    setState((prev) => {
      const existing = prev.projections.find(
        (p) => p.kind === 'column' && p.tableId === tableId && p.column === column
      )
      if (existing) {
        return {
          ...prev,
          projections: prev.projections.filter((p) => p.id !== existing.id)
        }
      }
      // Two same-named columns would collide in the result set, so the second
      // one starts with a qualified alias the user can still edit.
      const collision = prev.projections.some((p) => {
        if (p.kind === 'expression') return false
        if (p.alias?.trim()) return false
        return p.column === column
      })
      const projection: BuilderProjection = {
        id: newId('prj'),
        kind: 'column',
        tableId,
        column,
        aggregate: 'none',
        alias: collision ? `${tableById(tableId)?.alias ?? 't'}_${column}` : undefined
      }
      return { ...prev, projections: [...prev.projections, projection] }
    })
  }

  function updateProjection(id: string, patch: Partial<BuilderProjection>): void {
    setState((prev) => ({
      ...prev,
      projections: prev.projections.map((p) => (p.id === id ? { ...p, ...patch } : p))
    }))
  }

  function addExpression(): void {
    setState((prev) => ({
      ...prev,
      projections: [
        ...prev.projections,
        {
          id: newId('prj'),
          kind: 'expression',
          expression: '',
          aggregate: 'none'
        }
      ]
    }))
  }

  function addFilter(): void {
    setState((prev) => ({
      ...prev,
      filters: [
        ...prev.filters,
        {
          id: newId('flt'),
          tableId: prev.tables[0]?.id,
          column: '',
          op: 'equals',
          value: '',
          conjunction: 'and'
        }
      ]
    }))
  }

  function updateFilter(id: string, patch: Partial<BuilderFilter>): void {
    setState((prev) => ({
      ...prev,
      filters: prev.filters.map((f) => (f.id === id ? { ...f, ...patch } : f))
    }))
  }

  function addSort(): void {
    setState((prev) => ({
      ...prev,
      sorts: [
        ...prev.sorts,
        {
          id: newId('srt'),
          tableId: prev.tables[0]?.id,
          column: '',
          direction: 'asc'
        }
      ]
    }))
  }

  function addJoin(
    type: BuilderJoinType,
    leftTableId: string,
    leftColumn: string,
    rightTableId: string,
    rightColumn: string
  ): void {
    setState((prev) => ({
      ...prev,
      joins: [
        ...prev.joins,
        { id: newId('join'), type, leftTableId, leftColumn, rightTableId, rightColumn }
      ]
    }))
    setJoinSuggestions((prev) =>
      prev.filter(
        (s) =>
          !(
            s.leftTableId === leftTableId &&
            s.leftColumn === leftColumn &&
            s.rightTableId === rightTableId &&
            s.rightColumn === rightColumn
          )
      )
    )
  }

  async function runPreview(): Promise<void> {
    if (built.errors.length > 0 || !built.sql) return
    setRunning(true)
    setError(null)
    setResults(null)
    try {
      const sets = await unwrap(
        window.dbApi.runQuery({
          connectionId,
          sql: built.sql,
          maxRows: MAX_ROWS,
          database,
          schema
        })
      )
      setResults(sets)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRunning(false)
    }
  }

  function tableById(id: string): BuilderTable | undefined {
    return state.tables.find((t) => t.id === id)
  }

  const columnsOf = (tableId: string): { name: string; dataType: string }[] =>
    tableById(tableId)?.columns ?? []

  return (
    <div className="qb">
      <div className="qb__bar">
        <h2 className="grid-title">{tr('qb.title')}</h2>
        <div className="qb__bar-actions">
          <label className="qb__inline">
            <span className="field__label">{tr('qb.database')}</span>
            <select
              className="input"
              value={database}
              onChange={(e) => {
                setDatabase(e.target.value)
                setAdding('')
              }}
              disabled={databases.length === 0}
            >
              {databases.length === 0 && <option value={database}>{database}</option>}
              {databases.map((db) => (
                <option key={db} value={db}>
                  {db}
                </option>
              ))}
            </select>
          </label>
          {schemas.length > 0 && (
            <label className="qb__inline">
              <span className="field__label">{tr('qb.schema')}</span>
              <select
                className="input"
                value={schema ?? ''}
                onChange={(e) => {
                  setSchema(e.target.value || undefined)
                  setAdding('')
                }}
              >
                {schemas.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="qb__inline">
            <span className="field__label">{tr('qb.addTable')}</span>
            <select
              className="input"
              value={adding}
              onChange={(e) => {
                const name = e.target.value
                setAdding(name)
                if (name) void addTable(name)
              }}
              disabled={loadingTables || available.length === 0}
            >
              <option value="">
                {loadingTables
                  ? tr('qb.loadingTables')
                  : available.length === 0
                    ? tr('qb.noTables')
                    : tr('qb.pickTable')}
              </option>
              {available.map((t) => (
                <option key={`${t.schema ?? ''}.${t.name}`} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={state.distinct}
              onChange={(e) =>
                setState((prev) => ({ ...prev, distinct: e.target.checked }))
              }
            />
            DISTINCT
          </label>
          <label className="qb__inline">
            <span className="field__label">{tr('qb.limit')}</span>
            <input
              className="input qb__limit"
              type="number"
              min={1}
              max={100000}
              value={state.limit ?? ''}
              onChange={(e) => {
                const parsed = Number(e.target.value)
                setState((prev) => ({
                  ...prev,
                  limit: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
                }))
              }}
              placeholder={tr('qb.noLimit')}
            />
          </label>
          <button
            className="btn btn--tiny btn--ghost"
            onClick={() => setJoinFormOpen((v) => !v)}
            aria-expanded={joinFormOpen}
            disabled={state.tables.length < 2}
          >
            {tr('qb.createJoin')}
          </button>
          <button
            className="btn btn--tiny btn--ghost"
            onClick={() => {
              setState(EMPTY_BUILDER_STATE)
              setJoinSuggestions([])
              setResults(null)
              setNotice(null)
            }}
            disabled={state.tables.length === 0}
          >
            {tr('qb.reset')}
          </button>
        </div>
      </div>

      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice notice--info" role="status">
          {notice}
        </p>
      )}

      {state.tables.length === 0 ? (
        <p className="muted qb__empty">{tr('qb.emptyCanvas')}</p>
      ) : (
        <div className="qb__canvas">
          {state.tables.map((table) => (
            <section className="qb-card" key={table.id}>
              <header className="qb-card__head">
                <div className="qb-card__title">
                  <strong>{table.table}</strong>
                  <span className="muted qb-card__schema">
                    {table.schema ? `${table.schema}.` : ''}
                    {table.database}
                  </span>
                </div>
                <button
                  className="icon-btn"
                  onClick={() => removeTable(table.id)}
                  aria-label={tr('qb.removeTableLabel', { table: table.table })}
                  title={tr('qb.removeTable')}
                >
                  ×
                </button>
              </header>
              <label className="qb-card__alias">
                <span className="field__label">{tr('qb.alias')}</span>
                <input
                  className="input"
                  value={table.alias}
                  onChange={(e) => setAlias(table.id, e.target.value)}
                  spellCheck={false}
                />
              </label>
              <ul className="qb-card__columns">
                {table.columns.map((column) => {
                  const active = state.projections.some(
                    (p) =>
                      p.kind === 'column' &&
                      p.tableId === table.id &&
                      p.column === column.name
                  )
                  return (
                    <li key={column.name}>
                      <button
                        className={`qb-col${active ? ' is-active' : ''}`}
                        onClick={() => toggleProjection(table.id, column.name)}
                        title={active ? tr('qb.clickToRemove') : tr('qb.clickToAdd')}
                        aria-pressed={active}
                      >
                        <span className="qb-col__name">
                          {column.isPrimaryKey && <span className="qb-col__pk">PK</span>}
                          {column.name}
                        </span>
                        <span className="qb-col__type">{column.dataType}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {joinSuggestions.length > 0 && (
        <div className="qb__suggestions">
          <span className="field__label">{tr('qb.joinFromFk')}</span>
          {joinSuggestions.map((s) => {
            const left = tableById(s.leftTableId)
            const right = tableById(s.rightTableId)
            if (!left || !right) return null
            return (
              <button
                key={`${s.leftTableId}:${s.leftColumn}:${s.rightTableId}:${s.rightColumn}`}
                className="btn btn--tiny btn--ghost"
                onClick={() =>
                  addJoin(
                    'inner',
                    s.leftTableId,
                    s.leftColumn,
                    s.rightTableId,
                    s.rightColumn
                  )
                }
              >
                {left.alias}.{s.leftColumn} = {right.alias}.{s.rightColumn}
              </button>
            )
          })}
        </div>
      )}

      {joinFormOpen && state.tables.length >= 2 && (
        <div className="qb-join">
          <label className="qb__inline">
            <span className="field__label">{tr('qb.joinType')}</span>
            <select
              className="input"
              value={manualJoin.type}
              onChange={(e) =>
                setManualJoin((prev) => ({
                  ...prev,
                  type: e.target.value as BuilderJoinType
                }))
              }
            >
              {(Object.keys(JOIN_LABELS) as BuilderJoinType[]).map((type) => (
                <option key={type} value={type}>
                  {JOIN_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <label className="qb__inline">
            <span className="field__label">{tr('qb.leftTable')}</span>
            <select
              className="input"
              value={manualJoin.leftTableId}
              onChange={(e) =>
                setManualJoin((prev) => ({
                  ...prev,
                  leftTableId: e.target.value,
                  leftColumn: ''
                }))
              }
            >
              <option value="">{tr('qb.choose')}</option>
              {state.tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.alias}
                </option>
              ))}
            </select>
          </label>
          <label className="qb__inline">
            <span className="field__label">{tr('qb.column')}</span>
            <select
              className="input"
              value={manualJoin.leftColumn}
              onChange={(e) =>
                setManualJoin((prev) => ({ ...prev, leftColumn: e.target.value }))
              }
              disabled={!manualJoin.leftTableId}
            >
              <option value="">{tr('qb.choose')}</option>
              {columnsOf(manualJoin.leftTableId).map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="qb__inline">
            <span className="field__label">{tr('qb.rightTable')}</span>
            <select
              className="input"
              value={manualJoin.rightTableId}
              onChange={(e) =>
                setManualJoin((prev) => ({
                  ...prev,
                  rightTableId: e.target.value,
                  rightColumn: ''
                }))
              }
            >
              <option value="">{tr('qb.choose')}</option>
              {state.tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.alias}
                </option>
              ))}
            </select>
          </label>
          <label className="qb__inline">
            <span className="field__label">{tr('qb.column')}</span>
            <select
              className="input"
              value={manualJoin.rightColumn}
              onChange={(e) =>
                setManualJoin((prev) => ({ ...prev, rightColumn: e.target.value }))
              }
              disabled={!manualJoin.rightTableId}
            >
              <option value="">{tr('qb.choose')}</option>
              {columnsOf(manualJoin.rightTableId).map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn--tiny"
            onClick={() => {
              if (
                !manualJoin.leftTableId ||
                !manualJoin.leftColumn ||
                !manualJoin.rightTableId ||
                !manualJoin.rightColumn
              ) {
                setError(tr('qb.joinIncomplete'))
                return
              }
              if (manualJoin.leftTableId === manualJoin.rightTableId) {
                setError(tr('qb.joinSameTable'))
                return
              }
              addJoin(
                manualJoin.type,
                manualJoin.leftTableId,
                manualJoin.leftColumn,
                manualJoin.rightTableId,
                manualJoin.rightColumn
              )
              setError(null)
            }}
          >
            {tr('qb.addJoin')}
          </button>
        </div>
      )}

      {state.joins.length > 0 && (
        <ul className="qb__joins">
          {state.joins.map((join) => {
            const left = tableById(join.leftTableId)
            const right = tableById(join.rightTableId)
            return (
              <li key={join.id}>
                <span>
                  {JOIN_LABELS[join.type]} {right?.alias ?? '?'} ON {left?.alias ?? '?'}.
                  {join.leftColumn} = {right?.alias ?? '?'}.{join.rightColumn}
                </span>
                <button
                  className="btn btn--tiny btn--ghost"
                  onClick={() =>
                    setState((prev) => ({
                      ...prev,
                      joins: prev.joins.filter((j) => j.id !== join.id)
                    }))
                  }
                >
                  {tr('menu.delete')}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className="qb__panels">
        <section className="qb-panel">
          <header className="qb-panel__head">
            <h3>{tr('qb.output')}</h3>
            <button className="btn btn--tiny btn--ghost" onClick={addExpression}>
              {tr('qb.computedColumn')}
            </button>
          </header>
          {state.projections.length === 0 ? (
            <p className="muted qb-panel__empty">{tr('qb.outputEmpty')}</p>
          ) : (
            <ul className="qb-panel__rows">
              {state.projections.map((projection) => (
                <li key={projection.id} className="qb-row">
                  <span className="qb-row__source">
                    {projection.kind === 'expression' ? (
                      <input
                        className="input"
                        value={projection.expression ?? ''}
                        onChange={(e) =>
                          updateProjection(projection.id, { expression: e.target.value })
                        }
                        placeholder={tr('qb.expressionPlaceholder')}
                        spellCheck={false}
                      />
                    ) : (
                      `${tableById(projection.tableId ?? '')?.alias ?? '?'}.${projection.column}`
                    )}
                  </span>
                  <select
                    className="input qb-row__agg"
                    value={projection.aggregate}
                    onChange={(e) =>
                      updateProjection(projection.id, {
                        aggregate: e.target.value as BuilderAggregate
                      })
                    }
                    aria-label={tr('qb.aggregate')}
                  >
                    {(Object.keys(AGGREGATE_LABELS) as BuilderAggregate[]).map((agg) => (
                      <option key={agg} value={agg}>
                        {AGGREGATE_LABELS[agg]}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input qb-row__alias"
                    value={projection.alias ?? ''}
                    onChange={(e) =>
                      updateProjection(projection.id, { alias: e.target.value })
                    }
                    placeholder={tr('qb.aliasPlaceholder')}
                    spellCheck={false}
                  />
                  <button
                    className="btn btn--tiny btn--ghost"
                    onClick={() =>
                      setState((prev) => ({
                        ...prev,
                        projections: prev.projections.filter(
                          (p) => p.id !== projection.id
                        )
                      }))
                    }
                    aria-label={tr('qb.removeOutput')}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="qb-panel">
          <header className="qb-panel__head">
            <h3>{tr('qb.criteria')}</h3>
            <button className="btn btn--tiny btn--ghost" onClick={addFilter}>
              {tr('qb.addFilter')}
            </button>
          </header>
          {state.filters.length === 0 ? (
            <p className="muted qb-panel__empty">{tr('qb.noFilter')}</p>
          ) : (
            <ul className="qb-panel__rows">
              {state.filters.map((filter, index) => (
                <li key={filter.id} className="qb-row">
                  {index > 0 && (
                    <select
                      className="input qb-row__logic"
                      value={filter.conjunction}
                      onChange={(e) =>
                        updateFilter(filter.id, {
                          conjunction: e.target.value === 'or' ? 'or' : 'and'
                        })
                      }
                      aria-label={tr('qb.connector')}
                    >
                      <option value="and">AND</option>
                      <option value="or">OR</option>
                    </select>
                  )}
                  <select
                    className="input qb-row__col"
                    value={
                      filter.tableId && filter.column
                        ? `${filter.tableId}|${filter.column}`
                        : ''
                    }
                    onChange={(e) => {
                      const [tableId, column] = e.target.value.split('|')
                      updateFilter(filter.id, { tableId, column })
                    }}
                    aria-label={tr('qb.filterColumn')}
                  >
                    <option value="">{tr('qb.chooseColumn')}</option>
                    {flatColumns.map((c) => (
                      <option
                        key={`${c.tableId}|${c.column}`}
                        value={`${c.tableId}|${c.column}`}
                      >
                        {c.alias}.{c.column}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input qb-row__op"
                    value={filter.op}
                    onChange={(e) =>
                      updateFilter(filter.id, {
                        op: e.target.value as BuilderFilter['op']
                      })
                    }
                    aria-label={tr('qb.operator')}
                  >
                    {FILTER_OPERATORS.map((op) => (
                      <option key={op} value={op}>
                        {FILTER_OPERATOR_LABELS[op]}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input qb-row__value"
                    value={filter.value}
                    onChange={(e) => updateFilter(filter.id, { value: e.target.value })}
                    disabled={!operatorNeedsValue(filter.op)}
                    placeholder={operatorNeedsValue(filter.op) ? 'nilai' : '-'}
                    aria-label={tr('qb.filterValue')}
                  />
                  <button
                    className="btn btn--tiny btn--ghost"
                    onClick={() =>
                      setState((prev) => ({
                        ...prev,
                        filters: prev.filters.filter((f) => f.id !== filter.id)
                      }))
                    }
                    aria-label={tr('qb.removeFilter')}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="qb-panel">
          <header className="qb-panel__head">
            <h3>{tr('qb.groupBy')}</h3>
            <button
              className="btn btn--tiny btn--ghost"
              onClick={() =>
                setState((prev) => ({
                  ...prev,
                  groups: [
                    ...prev.groups,
                    { id: newId('grp'), tableId: prev.tables[0]?.id, column: '' }
                  ]
                }))
              }
            >
              {tr('qb.addGroup')}
            </button>
          </header>
          {state.groups.length === 0 ? (
            <p className="muted qb-panel__empty">{tr('qb.aggregateHint')}</p>
          ) : (
            <ul className="qb-panel__rows">
              {state.groups.map((group) => (
                <li key={group.id} className="qb-row">
                  <select
                    className="input qb-row__col"
                    value={
                      group.tableId && group.column
                        ? `${group.tableId}|${group.column}`
                        : ''
                    }
                    onChange={(e) => {
                      const [tableId, column] = e.target.value.split('|')
                      setState((prev) => ({
                        ...prev,
                        groups: prev.groups.map((g) =>
                          g.id === group.id ? { ...g, tableId, column } : g
                        )
                      }))
                    }}
                    aria-label={tr('qb.groupByColumn')}
                  >
                    <option value="">{tr('qb.chooseColumn')}</option>
                    {flatColumns.map((c) => (
                      <option
                        key={`${c.tableId}|${c.column}`}
                        value={`${c.tableId}|${c.column}`}
                      >
                        {c.alias}.{c.column}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn--tiny btn--ghost"
                    onClick={() =>
                      setState((prev) => ({
                        ...prev,
                        groups: prev.groups.filter((g) => g.id !== group.id)
                      }))
                    }
                    aria-label={tr('qb.removeGroupBy')}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="qb-panel">
          <header className="qb-panel__head">
            <h3>{tr('qb.sort')}</h3>
            <button className="btn btn--tiny btn--ghost" onClick={addSort}>
              {tr('qb.addSort')}
            </button>
          </header>
          {state.sorts.length === 0 ? (
            <p className="muted qb-panel__empty">{tr('qb.noSort')}</p>
          ) : (
            <ul className="qb-panel__rows">
              {state.sorts.map((sort) => (
                <li key={sort.id} className="qb-row">
                  <select
                    className="input qb-row__col"
                    value={
                      sort.tableId && sort.column ? `${sort.tableId}|${sort.column}` : ''
                    }
                    onChange={(e) => {
                      const [tableId, column] = e.target.value.split('|')
                      setState((prev) => ({
                        ...prev,
                        sorts: prev.sorts.map((s) =>
                          s.id === sort.id ? { ...s, tableId, column } : s
                        )
                      }))
                    }}
                    aria-label={tr('qb.sortColumn')}
                  >
                    <option value="">{tr('qb.chooseColumn')}</option>
                    {flatColumns.map((c) => (
                      <option
                        key={`${c.tableId}|${c.column}`}
                        value={`${c.tableId}|${c.column}`}
                      >
                        {c.alias}.{c.column}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input qb-row__logic"
                    value={sort.direction}
                    onChange={(e) =>
                      setState((prev) => ({
                        ...prev,
                        sorts: prev.sorts.map((s) =>
                          s.id === sort.id
                            ? {
                                ...s,
                                direction: e.target.value === 'desc' ? 'desc' : 'asc'
                              }
                            : s
                        )
                      }))
                    }
                    aria-label={tr('qb.sortDirection')}
                  >
                    <option value="asc">ASC</option>
                    <option value="desc">DESC</option>
                  </select>
                  <button
                    className="btn btn--tiny btn--ghost"
                    onClick={() =>
                      setState((prev) => ({
                        ...prev,
                        sorts: prev.sorts.filter((s) => s.id !== sort.id)
                      }))
                    }
                    aria-label={tr('qb.removeSort')}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="qb-preview">
        <header className="qb-panel__head">
          <h3>{tr('qb.sql')}</h3>
          <div className="qb__bar-actions">
            <button
              className="btn btn--tiny btn--ghost"
              onClick={() => {
                void window.dbApi.clipboardWrite(built.sql)
                setNotice(tr('qb.copied'))
              }}
              disabled={!built.sql}
            >
              {tr('qb.copy')}
            </button>
            <button
              className="btn btn--tiny btn--ghost"
              onClick={() => onOpenSql(built.sql)}
              disabled={!built.sql}
            >
              {tr('qb.openInEditor')}
            </button>
            <button
              className="btn btn--small"
              onClick={() => void runPreview()}
              disabled={running || built.errors.length > 0 || !built.sql}
            >
              {running ? tr('qb.running') : tr('qb.run')}
            </button>
          </div>
        </header>
        {built.errors.length > 0 && (
          <ul className="qb-errors" role="alert">
            {built.errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
        <pre className="qb-preview__sql">{built.sql || tr('qb.noSql')}</pre>
      </section>

      {results && (
        <section className="qb-preview">
          <header className="qb-panel__head">
            <h3>{tr('qb.results')}</h3>
            <button className="btn btn--tiny btn--ghost" onClick={() => setResults(null)}>
              {tr('common.close')}
            </button>
          </header>
          {results.length === 0 ? (
            <p className="muted qb-panel__empty">{tr('qb.noResults')}</p>
          ) : (
            results.map((set, index) => (
              <div key={index} className="qb-result">
                <p className="qb-result__meta">
                  {set.rowCount} {tr('query.colRows')}
                  {set.truncated
                    ? ` ${tr('qb.truncated', { max: MAX_ROWS })}`
                    : ''} | {set.durationMs} ms
                </p>
                <div className="table-scroll">
                  <table className="data-table qb-result__table">
                    <thead>
                      <tr>
                        {set.columns.map((c) => (
                          <th key={c.name}>{c.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {set.rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                          {set.columns.map((c) => (
                            <td key={c.name}>
                              {row[c.name] === null || row[c.name] === undefined
                                ? 'NULL'
                                : typeof row[c.name] === 'object'
                                  ? JSON.stringify(row[c.name])
                                  : String(row[c.name])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </section>
      )}
    </div>
  )
}
