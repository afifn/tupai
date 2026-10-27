import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ColumnInfo,
  DdlColumnDef,
  DdlOperation,
  ForeignKeyInfo,
  IndexInfo,
  PrimaryKeyInfo,
  TableAlteration,
  TableInfo,
  TableInfoDetail
} from '@shared/types'
import { engineColumnTypes } from '@shared/ddl'
import { unwrap } from './api'
import { confirmDestructive } from './confirm'
import { PromptDialog } from './PromptDialog'
import { useLocale } from './i18n'

// A designer row carries a stable id so React keys survive reorder/rename and
// the edit-mode diff can track a column across name changes.
interface DesignerColumn {
  id: string
  name: string
  dataType: string
  nullable: boolean
  primaryKey: boolean
  autoIncrement: boolean
  defaultValue: string
  comment: string
  original?: ColumnInfo
  isNew: boolean
  markedForDrop: boolean
}

// Emitted after a successful save so the caller can refresh and, for a newly
// created table, open it. `created` is only set in create mode.
export interface DesignerResult {
  created?: { database: string; schema?: string; table: string }
  dropped?: { database: string; schema?: string; table: string }
}

interface CommonProps {
  connectionId: string
  engine: string
  onDone: (result: DesignerResult) => void
}

interface CreateProps extends CommonProps {
  mode: 'create'
  defaultDatabase: string
  defaultSchema?: string
  onCancel: () => void
}

interface EditProps extends CommonProps {
  mode: 'edit'
  database: string
  schema?: string
  table: string
}

type Props = CreateProps | EditProps

type DesignerTab = 'columns' | 'indexes' | 'foreign' | 'info'

const FK_ACTIONS = ['', 'NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']

let seq = 0
function nextId(): string {
  seq += 1
  return `c${seq}`
}

function toDesigner(col: ColumnInfo): DesignerColumn {
  return {
    id: nextId(),
    name: col.name,
    dataType: col.dataType,
    nullable: col.nullable,
    primaryKey: col.isPrimaryKey,
    autoIncrement: col.autoIncrement === true,
    defaultValue: col.defaultValue ?? '',
    comment: col.comment ?? '',
    original: col,
    isNew: false,
    markedForDrop: false
  }
}

function blankColumn(engine: string): DesignerColumn {
  return {
    id: nextId(),
    name: '',
    dataType: engineColumnTypes(engine as never)[0],
    nullable: true,
    primaryKey: false,
    autoIncrement: false,
    defaultValue: '',
    comment: '',
    isNew: true,
    markedForDrop: false
  }
}

function toDef(c: DesignerColumn): DdlColumnDef {
  return {
    name: c.name.trim(),
    dataType: c.dataType.trim(),
    nullable: c.nullable,
    primaryKey: c.primaryKey,
    autoIncrement: c.autoIncrement,
    defaultValue: c.defaultValue
  }
}

// MySQL and SQLite require the auto-increment column to be a key.
function requiresPkForAuto(engine: string): boolean {
  return engine === 'mysql' || engine === 'mariadb' || engine === 'sqlite'
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(1)} ${units[i]}`
}

export function TableDesigner(props: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const { connectionId, engine, onDone } = props
  const isEdit = props.mode === 'edit'
  const types = engineColumnTypes(engine as never)

  const [tab, setTab] = useState<DesignerTab>('columns')
  const [databases, setDatabases] = useState<string[]>([])
  const [database, setDatabase] = useState(
    props.mode === 'create' ? props.defaultDatabase : props.database
  )
  const [schema, setSchema] = useState(
    props.mode === 'create'
      ? (props.defaultSchema ?? (engine === 'postgres' ? 'public' : ''))
      : (props.schema ?? '')
  )
  const [table, setTable] = useState(props.mode === 'edit' ? props.table : '')
  const [columns, setColumns] = useState<DesignerColumn[]>(() =>
    props.mode === 'create' ? [blankColumn(engine)] : []
  )
  const [originalPk, setOriginalPk] = useState<PrimaryKeyInfo | null>(null)
  const [loading, setLoading] = useState(isEdit)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<string[] | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [dropPrompt, setDropPrompt] = useState(false)
  const lastNameRef = useRef<HTMLInputElement | null>(null)

  // Indexes
  const [indexes, setIndexes] = useState<IndexInfo[]>([])
  const [indexesLoading, setIndexesLoading] = useState(false)
  const [indexName, setIndexName] = useState('')
  const [indexColumns, setIndexColumns] = useState<string[]>([])
  const [indexUnique, setIndexUnique] = useState(false)

  // Foreign keys
  const [fks, setFks] = useState<ForeignKeyInfo[]>([])
  const [fksLoading, setFksLoading] = useState(false)
  const [tables, setTables] = useState<TableInfo[]>([])
  const [fkName, setFkName] = useState('')
  const [fkColumns, setFkColumns] = useState<string[]>([])
  const [fkRefTable, setFkRefTable] = useState('')
  const [fkRefColumns, setFkRefColumns] = useState<string[]>([])
  const [fkRefColumnsList, setFkRefColumnsList] = useState<ColumnInfo[]>([])
  const [fkOnUpdate, setFkOnUpdate] = useState('')
  const [fkOnDelete, setFkOnDelete] = useState('')

  // Info / DDL
  const [tableInfo, setTableInfo] = useState<TableInfoDetail | null>(null)
  const [objectDdl, setObjectDdl] = useState<string | null>(null)
  const [infoLoading, setInfoLoading] = useState(false)
  const [tableComment, setTableComment] = useState('')

  const usesSchema = engine === 'postgres' || engine === 'oracle'
  const editableStructure = engine !== 'mongodb'

  useEffect(() => {
    unwrap(window.dbApi.listDatabases(connectionId))
      .then((dbs) => {
        setDatabases(dbs)
        if (props.mode === 'create' && !props.defaultDatabase && dbs.length > 0) {
          setDatabase(dbs[0])
        }
      })
      .catch(() => setDatabases([]))
  }, [connectionId])

  const editDatabase = props.mode === 'edit' ? props.database : ''
  const editSchema = props.mode === 'edit' ? (props.schema ?? '') : ''
  const editTable = props.mode === 'edit' ? props.table : ''

  const reloadStructure = useCallback(async (): Promise<void> => {
    if (props.mode !== 'edit') return
    const [cols, pk] = await Promise.all([
      unwrap(
        window.dbApi.listColumns(
          connectionId,
          editDatabase,
          editTable,
          editSchema || undefined
        )
      ),
      unwrap(
        window.dbApi.getPrimaryKey(
          connectionId,
          editDatabase,
          editTable,
          editSchema || undefined
        )
      )
    ])
    setColumns(cols.map(toDesigner))
    setOriginalPk(pk)
  }, [connectionId, props.mode, editDatabase, editSchema, editTable])

  useEffect(() => {
    if (props.mode !== 'edit') return
    setLoading(true)
    setError(null)
    reloadStructure()
      .then(() => setLoading(false))
      .catch((err) => {
        setError(errorText(err))
        setLoading(false)
      })
  }, [reloadStructure, props.mode])

  const loadIndexes = useCallback(async (): Promise<void> => {
    if (props.mode !== 'edit') return
    setIndexesLoading(true)
    try {
      setIndexes(
        await unwrap(
          window.dbApi.listIndexes(
            connectionId,
            editDatabase,
            editTable,
            editSchema || undefined
          )
        )
      )
    } catch (err) {
      setError(errorText(err))
    } finally {
      setIndexesLoading(false)
    }
  }, [connectionId, props.mode, editDatabase, editSchema, editTable])

  const loadForeignKeys = useCallback(async (): Promise<void> => {
    if (props.mode !== 'edit') return
    setFksLoading(true)
    try {
      setFks(
        await unwrap(
          window.dbApi.listForeignKeys(
            connectionId,
            editDatabase,
            editTable,
            editSchema || undefined
          )
        )
      )
    } catch (err) {
      setError(errorText(err))
    } finally {
      setFksLoading(false)
    }
  }, [connectionId, props.mode, editDatabase, editSchema, editTable])

  const loadInfo = useCallback(async (): Promise<void> => {
    if (props.mode !== 'edit') return
    setInfoLoading(true)
    try {
      const [info, ddl] = await Promise.all([
        unwrap(
          window.dbApi.getTableInfo(
            connectionId,
            editDatabase,
            editTable,
            editSchema || undefined
          )
        ),
        unwrap(
          window.dbApi.getObjectDdl(
            connectionId,
            editDatabase,
            editTable,
            editSchema || undefined
          )
        )
      ])
      setTableInfo(info)
      setTableComment(info.comment ?? '')
      setObjectDdl(ddl)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setInfoLoading(false)
    }
  }, [connectionId, props.mode, editDatabase, editSchema, editTable])

  // Load the data each sub-tab needs, lazily, the first time it is opened.
  useEffect(() => {
    if (props.mode !== 'edit') return
    if (tab === 'indexes') void loadIndexes()
    else if (tab === 'foreign') {
      void loadForeignKeys()
      unwrap(window.dbApi.listTables(connectionId, editDatabase, editSchema || undefined))
        .then(setTables)
        .catch(() => setTables([]))
    } else if (tab === 'info') void loadInfo()
  }, [
    tab,
    props.mode,
    loadIndexes,
    loadForeignKeys,
    loadInfo,
    connectionId,
    editDatabase,
    editSchema
  ])

  const activeColumns = columns.filter((c) => !c.markedForDrop)
  const pkColumns = activeColumns.filter((c) => c.primaryKey).map((c) => c.name.trim())

  function updateColumn(id: string, patch: Partial<DesignerColumn>): void {
    setColumns((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)))
    setPreview(null)
  }

  function togglePrimaryKey(id: string): void {
    setColumns((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c
        const primaryKey = !c.primaryKey
        return {
          ...c,
          primaryKey,
          // Dropping PK clears auto-increment for engines that need PK first.
          autoIncrement:
            !primaryKey && requiresPkForAuto(engine) ? false : c.autoIncrement
        }
      })
    )
    setPreview(null)
  }

  function toggleAutoIncrement(id: string): void {
    setColumns((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c
        const autoIncrement = !c.autoIncrement
        return {
          ...c,
          autoIncrement,
          primaryKey: autoIncrement && requiresPkForAuto(engine) ? true : c.primaryKey
        }
      })
    )
    setPreview(null)
  }

  function addColumn(afterId?: string): void {
    setColumns((prev) => {
      const fresh = blankColumn(engine)
      if (!afterId) return [...prev, fresh]
      const idx = prev.findIndex((c) => c.id === afterId)
      return [...prev.slice(0, idx + 1), fresh, ...prev.slice(idx + 1)]
    })
    setPreview(null)
    setTimeout(() => lastNameRef.current?.focus(), 0)
  }

  function removeColumn(id: string): void {
    setColumns((prev) => {
      const target = prev.find((c) => c.id === id)
      // A brand-new row just disappears; a persisted one is flagged for DROP.
      if (target?.isNew) return prev.filter((c) => c.id !== id)
      return prev.map((c) => (c.id === id ? { ...c, markedForDrop: true } : c))
    })
    setPreview(null)
  }

  function restoreColumn(id: string): void {
    setColumns((prev) =>
      prev.map((c) => (c.id === id ? { ...c, markedForDrop: false } : c))
    )
    setPreview(null)
  }

  function moveColumn(id: string, dir: -1 | 1): void {
    setColumns((prev) => {
      const idx = prev.findIndex((c) => c.id === id)
      const next = idx + dir
      if (idx < 0 || next < 0 || next >= prev.length) return prev
      const copy = [...prev]
      const [item] = copy.splice(idx, 1)
      copy.splice(next, 0, item)
      return copy
    })
    setPreview(null)
  }

  function validationError(): string | null {
    if (!editableStructure) return tr('designer.engineNoDdl')
    if (!table.trim()) return tr('designer.tableNameRequired')
    const kept = columns.filter((c) => !c.markedForDrop)
    if (kept.length === 0) return tr('designer.needColumn')
    const named = kept.filter((c) => c.name.trim())
    if (named.length !== kept.length) return tr('designer.everyColumnNamed')
    const names = named.map((c) => c.name.trim().toLowerCase())
    if (new Set(names).size !== names.length) return tr('designer.duplicateColumn')
    return null
  }

  function buildOperation(): DdlOperation | null {
    const invalid = validationError()
    if (invalid) {
      setError(invalid)
      return null
    }
    if (props.mode === 'create') {
      return {
        kind: 'createTable',
        database,
        schema: schema.trim() || undefined,
        table: table.trim(),
        columns: columns.filter((c) => !c.markedForDrop).map(toDef)
      }
    }
    const alterations = diffAlterations(columns, originalPk, pkColumns, engine)
    if (alterations.length === 0) {
      setError(tr('designer.noChanges'))
      return null
    }
    return {
      kind: 'alterTable',
      database: props.database,
      schema: props.schema,
      table: props.table,
      alterations
    }
  }

  async function handlePreview(): Promise<void> {
    setError(null)
    const op = buildOperation()
    if (!op) return
    try {
      const sql = await unwrap(window.dbApi.previewDdl(connectionId, op))
      setPreview(sql)
      setShowPreview(true)
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function handleSave(): Promise<void> {
    setError(null)
    const op = buildOperation()
    if (!op) return
    setBusy(true)
    try {
      await unwrap(window.dbApi.executeDdl(connectionId, op))
      if (props.mode === 'create') {
        onDone({
          created: {
            database,
            schema: schema.trim() || undefined,
            table: table.trim()
          }
        })
      } else {
        // Reset the diff baseline so a second save does not re-apply the same
        // alterations against stale snapshots.
        await reloadStructure()
        onDone({})
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const heading = useMemo(() => {
    if (props.mode === 'create') return tr('designer.newTable')
    return tr('designer.structure', { table: props.table })
  }, [props, tr])

  async function previewIndex(): Promise<void> {
    if (props.mode !== 'edit') return
    if (!indexName.trim() || indexColumns.length === 0) {
      setError(tr('designer.needIndexColumns'))
      return
    }
    setError(null)
    try {
      const sql = await unwrap(
        window.dbApi.previewDdl(connectionId, {
          kind: 'createIndex',
          database: props.database,
          schema: props.schema,
          table: props.table,
          indexName: indexName.trim(),
          columns: indexColumns,
          unique: indexUnique
        })
      )
      setPreview(sql)
      setShowPreview(true)
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function runIndex(): Promise<void> {
    if (props.mode !== 'edit') return
    if (!indexName.trim() || indexColumns.length === 0) {
      setError(tr('designer.needIndexColumns'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await unwrap(
        window.dbApi.executeDdl(connectionId, {
          kind: 'createIndex',
          database: props.database,
          schema: props.schema,
          table: props.table,
          indexName: indexName.trim(),
          columns: indexColumns,
          unique: indexUnique
        })
      )
      setIndexName('')
      setIndexColumns([])
      setIndexUnique(false)
      await loadIndexes()
      onDone({})
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function dropIndex(name: string): Promise<void> {
    if (props.mode !== 'edit') return
    const proceed = await confirmDestructive(tr('designer.dropIndexConfirm', { name }), {
      title: tr('designer.dropIndexTitle'),
      detail: tr('designer.dropIndexDetail')
    })
    if (!proceed) return
    setBusy(true)
    setError(null)
    try {
      await unwrap(
        window.dbApi.executeDdl(connectionId, {
          kind: 'dropIndex',
          database: props.database,
          schema: props.schema,
          table: props.table,
          indexName: name
        })
      )
      await loadIndexes()
      onDone({})
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  function toggleFkColumn(name: string): void {
    setFkColumns((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    )
  }

  function toggleFkRefColumn(name: string): void {
    setFkRefColumns((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    )
  }

  function chooseFkRefTable(name: string): void {
    setFkRefTable(name)
    setFkRefColumns([])
    if (!name) {
      setFkRefColumnsList([])
      return
    }
    unwrap(
      window.dbApi.listColumns(connectionId, editDatabase, name, editSchema || undefined)
    )
      .then(setFkRefColumnsList)
      .catch(() => setFkRefColumnsList([]))
  }

  function buildFkOperation(): DdlOperation | null {
    if (props.mode !== 'edit') return null
    if (fkColumns.length === 0 || !fkRefTable || fkRefColumns.length === 0) {
      setError(tr('designer.needFkColumns'))
      return null
    }
    if (fkColumns.length !== fkRefColumns.length) {
      setError(tr('designer.fkColumnMismatch'))
      return null
    }
    return {
      kind: 'createForeignKey',
      database: props.database,
      schema: props.schema,
      table: props.table,
      name: fkName.trim() || undefined,
      columns: fkColumns,
      refSchema: props.schema,
      refTable: fkRefTable,
      refColumns: fkRefColumns,
      onUpdate: fkOnUpdate || undefined,
      onDelete: fkOnDelete || undefined
    }
  }

  async function previewForeignKey(): Promise<void> {
    const op = buildFkOperation()
    if (!op) return
    setError(null)
    try {
      const sql = await unwrap(window.dbApi.previewDdl(connectionId, op))
      setPreview(sql)
      setShowPreview(true)
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function runForeignKey(): Promise<void> {
    const op = buildFkOperation()
    if (!op) return
    setBusy(true)
    setError(null)
    try {
      await unwrap(window.dbApi.executeDdl(connectionId, op))
      setFkName('')
      setFkColumns([])
      setFkRefTable('')
      setFkRefColumns([])
      setFkRefColumnsList([])
      setFkOnUpdate('')
      setFkOnDelete('')
      await loadForeignKeys()
      onDone({})
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function dropForeignKey(name: string): Promise<void> {
    if (props.mode !== 'edit') return
    const proceed = await confirmDestructive(
      tr('designer.dropForeignConfirm', { name }),
      {
        title: tr('designer.dropForeignTitle'),
        detail: tr('designer.dropForeignDetail')
      }
    )
    if (!proceed) return
    setBusy(true)
    setError(null)
    try {
      await unwrap(
        window.dbApi.executeDdl(connectionId, {
          kind: 'dropForeignKey',
          database: props.database,
          schema: props.schema,
          table: props.table,
          name
        })
      )
      await loadForeignKeys()
      onDone({})
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function saveTableComment(): Promise<void> {
    if (props.mode !== 'edit') return
    setBusy(true)
    setError(null)
    try {
      await unwrap(
        window.dbApi.executeDdl(connectionId, {
          kind: 'alterTable',
          database: props.database,
          schema: props.schema,
          table: props.table,
          alterations: [
            {
              type: 'setTableComment',
              comment: tableComment.trim() === '' ? null : tableComment
            }
          ]
        })
      )
      await loadInfo()
      onDone({})
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function confirmDropTable(name: string): Promise<void> {
    if (props.mode !== 'edit') return
    setDropPrompt(false)
    if (name !== props.table) {
      setError(tr('designer.nameMismatch', { name: props.table }))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await unwrap(
        window.dbApi.executeDdl(connectionId, {
          kind: 'dropTable',
          database: props.database,
          schema: props.schema,
          table: props.table
        })
      )
      onDone({
        dropped: {
          database: props.database,
          schema: props.schema,
          table: props.table
        }
      })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const titleInput = props.mode === 'create'
  const showTabs = props.mode === 'edit'

  return (
    <div className="designer">
      <header className="designer__bar">
        <div className="designer__identity">
          <h2 className="designer__title">{heading}</h2>
          <div className="designer__meta">
            {titleInput ? (
              <>
                <label className="designer__meta-field">
                  <span>{tr('designer.database')}</span>
                  <select
                    className="input input--tight"
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                  >
                    {databases.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
                {usesSchema && (
                  <label className="designer__meta-field">
                    <span>
                      {engine === 'oracle'
                        ? tr('designer.schemaOwner')
                        : tr('designer.schema')}
                    </span>
                    <input
                      className="input input--tight"
                      value={schema}
                      onChange={(e) => setSchema(e.target.value)}
                      placeholder={engine === 'oracle' ? 'NAMA_USER' : 'public'}
                    />
                  </label>
                )}
                <label className="designer__meta-field">
                  <span>{tr('designer.tableName')}</span>
                  <input
                    className="input input--tight"
                    value={table}
                    onChange={(e) => {
                      setTable(e.target.value)
                      setPreview(null)
                    }}
                    placeholder={tr('designer.tableNamePlaceholder')}
                    autoFocus
                  />
                </label>
              </>
            ) : (
              <span className="designer__path">
                {props.mode === 'edit' ? props.database : ''}
                {props.mode === 'edit' && props.schema ? `.${props.schema}` : ''}
                {props.mode === 'edit' ? `.${props.table}` : ''}
              </span>
            )}
          </div>
        </div>

        <div className="designer__actions">
          {tab === 'columns' && (
            <button
              className="btn btn--ghost btn--small"
              onClick={() => void handlePreview()}
              disabled={busy}
            >
              {tr('designer.showSql')}
            </button>
          )}
          {props.mode === 'create' ? (
            <button
              className="btn btn--ghost btn--small"
              onClick={props.onCancel}
              disabled={busy}
            >
              {tr('common.cancel')}
            </button>
          ) : null}
          {tab === 'columns' && (
            <button
              className="btn btn--small"
              onClick={() => void handleSave()}
              disabled={busy || loading}
            >
              {busy
                ? tr('query.saving')
                : props.mode === 'create'
                  ? tr('designer.createTable')
                  : tr('designer.save')}
            </button>
          )}
        </div>
      </header>

      {showTabs && (
        <nav className="designer__tabs" role="tablist">
          {(
            [
              ['columns', tr('designer.tabColumns')],
              ['indexes', tr('designer.tabIndexes')],
              ['foreign', tr('designer.tabForeign')],
              ['info', tr('designer.tabInfo')]
            ] as [DesignerTab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`designer__tab${tab === id ? ' is-active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      )}

      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="muted designer__pad">{tr('designer.loadingColumns')}</p>
      ) : tab === 'columns' || !showTabs ? (
        <div className="designer__grid-wrap">
          <table className="designer__grid">
            <thead>
              <tr>
                <th className="designer__col-name">{tr('designer.colName')}</th>
                <th className="designer__col-type">{tr('designer.colType')}</th>
                <th className="designer__col-flag" title={tr('designer.nullable')}>
                  {tr('designer.colNull')}
                </th>
                <th className="designer__col-flag" title={tr('designer.primaryKey')}>
                  {tr('designer.colPk')}
                </th>
                <th className="designer__col-flag" title={tr('designer.autoIncrement')}>
                  {tr('designer.colAi')}
                </th>
                <th className="designer__col-default">{tr('designer.colDefault')}</th>
                <th className="designer__col-comment">{tr('designer.colComment')}</th>
                <th
                  className="designer__col-actions"
                  aria-label={tr('designer.colActions')}
                />
              </tr>
            </thead>
            <tbody>
              {columns.map((c, i) => {
                if (c.markedForDrop) {
                  return (
                    <tr key={c.id} className="designer__row designer__row--dropped">
                      <td colSpan={8} className="designer__dropped">
                        <span>
                          {tr('designer.columnDropped', {
                            name: c.original?.name ?? c.name
                          })}
                        </span>
                        <button
                          className="btn btn--ghost btn--tiny"
                          onClick={() => restoreColumn(c.id)}
                        >
                          {tr('designer.undo')}
                        </button>
                      </td>
                    </tr>
                  )
                }
                const autoDisabled = engine === 'sqlite' && isEdit
                return (
                  <tr key={c.id} className="designer__row">
                    <td>
                      <input
                        className="input input--cell"
                        value={c.name}
                        onChange={(e) => updateColumn(c.id, { name: e.target.value })}
                        placeholder={tr('designer.namePlaceholder')}
                        ref={i === columns.length - 1 ? lastNameRef : undefined}
                        aria-label={tr('designer.nameLabel')}
                      />
                    </td>
                    <td>
                      <select
                        className="input input--cell"
                        value={c.dataType}
                        onChange={(e) => updateColumn(c.id, { dataType: e.target.value })}
                        aria-label={tr('designer.typeLabel')}
                      >
                        {/* Keep a loaded custom type (e.g. enum, user-defined)
                            selectable even when it is not one of the presets. */}
                        {!types.includes(c.dataType) && c.dataType !== '' && (
                          <option value={c.dataType}>{c.dataType}</option>
                        )}
                        {types.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="designer__cell-flag">
                      <input
                        type="checkbox"
                        checked={c.nullable}
                        onChange={(e) =>
                          updateColumn(c.id, { nullable: e.target.checked })
                        }
                        aria-label={tr('designer.nullableFor', {
                          name: c.name || tr('designer.nameLabel')
                        })}
                      />
                    </td>
                    <td className="designer__cell-flag">
                      <button
                        type="button"
                        className={`designer__chip${c.primaryKey ? ' is-on' : ''}`}
                        onClick={() => togglePrimaryKey(c.id)}
                        aria-pressed={c.primaryKey}
                        aria-label={tr('designer.pkFor', {
                          name: c.name || tr('designer.nameLabel')
                        })}
                        title={tr('designer.primaryKey')}
                      >
                        {c.primaryKey ? 'PK' : '+'}
                      </button>
                    </td>
                    <td className="designer__cell-flag">
                      <button
                        type="button"
                        className={`designer__chip${c.autoIncrement ? ' is-on' : ''}`}
                        onClick={() => toggleAutoIncrement(c.id)}
                        disabled={autoDisabled}
                        aria-pressed={c.autoIncrement}
                        aria-label={tr('designer.aiFor', {
                          name: c.name || tr('designer.nameLabel')
                        })}
                        title={
                          autoDisabled
                            ? tr('designer.autoIncrementSqlite')
                            : tr('designer.autoIncrement')
                        }
                      >
                        {c.autoIncrement ? 'AI' : '+'}
                      </button>
                    </td>
                    <td>
                      <input
                        className="input input--cell"
                        value={c.defaultValue}
                        onChange={(e) =>
                          updateColumn(c.id, { defaultValue: e.target.value })
                        }
                        placeholder={tr('designer.defaultPlaceholder')}
                        aria-label={tr('designer.defaultLabel')}
                      />
                    </td>
                    <td>
                      <input
                        className="input input--cell"
                        value={c.comment}
                        onChange={(e) => updateColumn(c.id, { comment: e.target.value })}
                        placeholder={
                          engine === 'sqlite'
                            ? tr('designer.commentUnsupported')
                            : tr('designer.commentPlaceholder')
                        }
                        disabled={engine === 'sqlite'}
                        aria-label={tr('designer.commentLabel')}
                      />
                    </td>
                    <td className="designer__cell-actions">
                      <button
                        className="icon-btn icon-btn--xs"
                        onClick={() => moveColumn(c.id, -1)}
                        disabled={i === 0}
                        title={tr('designer.moveUp')}
                        aria-label={tr('designer.moveUpLabel')}
                      >
                        ↑
                      </button>
                      <button
                        className="icon-btn icon-btn--xs"
                        onClick={() => moveColumn(c.id, 1)}
                        disabled={i === columns.length - 1}
                        title={tr('designer.moveDown')}
                        aria-label={tr('designer.moveDownLabel')}
                      >
                        ↓
                      </button>
                      <button
                        className="icon-btn icon-btn--xs"
                        onClick={() => addColumn(c.id)}
                        title={tr('designer.insertBelow')}
                        aria-label={tr('designer.insertBelow')}
                      >
                        +
                      </button>
                      <button
                        className="icon-btn icon-btn--xs icon-btn--danger"
                        onClick={() => removeColumn(c.id)}
                        title={tr('designer.removeColumn')}
                        aria-label={tr('designer.removeColumn')}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <div className="designer__footer">
            <button
              className="btn btn--ghost btn--small"
              onClick={() => addColumn()}
              disabled={busy}
            >
              {tr('designer.addColumn')}
            </button>
            {pkColumns.length > 0 && (
              <span className="designer__pk-note">
                {tr('designer.pkNote')} <strong>{pkColumns.join(', ')}</strong>
              </span>
            )}
            {props.mode === 'edit' && (
              <button
                className="btn btn--ghost btn--small designer__danger"
                onClick={() => setDropPrompt(true)}
                disabled={busy}
              >
                {tr('designer.dropTable')}
              </button>
            )}
          </div>
        </div>
      ) : tab === 'indexes' ? (
        <div className="designer__pane">
          {indexesLoading ? (
            <p className="muted designer__pad">{tr('designer.loadingIndexes')}</p>
          ) : indexes.length === 0 ? (
            <p className="muted designer__pad">{tr('designer.noIndexes')}</p>
          ) : (
            <table className="designer__list">
              <thead>
                <tr>
                  <th>{tr('designer.colName')}</th>
                  <th>{tr('designer.colColumns')}</th>
                  <th>{tr('designer.colType')}</th>
                  <th aria-label={tr('designer.actions')} />
                </tr>
              </thead>
              <tbody>
                {indexes.map((idx) => (
                  <tr key={idx.name}>
                    <td className="designer__mono">{idx.name}</td>
                    <td className="designer__mono">{idx.columns.join(', ')}</td>
                    <td>
                      {idx.primary ? 'PRIMARY' : idx.unique ? 'UNIQUE' : 'INDEX'}
                      {idx.method ? ` · ${idx.method}` : ''}
                    </td>
                    <td className="designer__cell-actions">
                      <button
                        className="btn btn--ghost btn--tiny"
                        onClick={() => void dropIndex(idx.name)}
                        disabled={busy || idx.primary}
                        title={
                          idx.primary ? tr('designer.primaryNoDrop') : tr('menu.delete')
                        }
                      >
                        {tr('menu.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="designer__form-block">
            <span className="designer__block-title">{tr('designer.newIndex')}</span>
            <div className="designer__index-row">
              <input
                className="input input--tight"
                value={indexName}
                onChange={(e) => setIndexName(e.target.value)}
                placeholder={tr('designer.indexNamePlaceholder')}
                aria-label={tr('designer.indexName')}
              />
              <label className="checkbox checkbox--tight">
                <input
                  type="checkbox"
                  checked={indexUnique}
                  onChange={(e) => setIndexUnique(e.target.checked)}
                />
                <span>{tr('designer.unique')}</span>
              </label>
              <button
                className="btn btn--ghost btn--small"
                onClick={() => void previewIndex()}
                disabled={busy}
              >
                {tr('designer.showSql')}
              </button>
              <button
                className="btn btn--small"
                onClick={() => void runIndex()}
                disabled={busy}
              >
                {tr('designer.createIndex')}
              </button>
            </div>
            <div className="designer__index-cols">
              {activeColumns.map((c) => (
                <label key={c.id} className="checkbox checkbox--tight">
                  <input
                    type="checkbox"
                    checked={indexColumns.includes(c.name.trim())}
                    onChange={(e) =>
                      setIndexColumns((prev) =>
                        e.target.checked
                          ? [...prev, c.name.trim()]
                          : prev.filter((n) => n !== c.name.trim())
                      )
                    }
                  />
                  <span>{c.name || tr('designer.unnamed')}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      ) : tab === 'foreign' ? (
        <div className="designer__pane">
          {fksLoading ? (
            <p className="muted designer__pad">{tr('designer.loadingForeign')}</p>
          ) : fks.length === 0 ? (
            <p className="muted designer__pad">{tr('designer.noForeign')}</p>
          ) : (
            <table className="designer__list">
              <thead>
                <tr>
                  <th>{tr('designer.name')}</th>
                  <th>{tr('designer.colColumns')}</th>
                  <th>{tr('designer.reference')}</th>
                  <th>{tr('designer.onUpdateDelete')}</th>
                  <th aria-label={tr('designer.actions')} />
                </tr>
              </thead>
              <tbody>
                {fks.map((fk) => (
                  <tr key={fk.name}>
                    <td className="designer__mono">{fk.name}</td>
                    <td className="designer__mono">{fk.columns.join(', ')}</td>
                    <td className="designer__mono">
                      {fk.refSchema ? `${fk.refSchema}.` : ''}
                      {fk.refTable} ({fk.refColumns.join(', ')})
                    </td>
                    <td>
                      {fk.onUpdate ?? '-'} / {fk.onDelete ?? '-'}
                    </td>
                    <td className="designer__cell-actions">
                      <button
                        className="btn btn--ghost btn--tiny"
                        onClick={() => void dropForeignKey(fk.name)}
                        disabled={busy}
                      >
                        {tr('menu.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="designer__form-block">
            <span className="designer__block-title">{tr('designer.newForeign')}</span>
            <div className="designer__index-row">
              <input
                className="input input--tight"
                value={fkName}
                onChange={(e) => setFkName(e.target.value)}
                placeholder={tr('designer.constraintPlaceholder')}
                aria-label={tr('designer.constraintName')}
              />
            </div>
            <div className="designer__fk-grid">
              <div>
                <span className="designer__sub">{tr('designer.localColumns')}</span>
                <div className="designer__index-cols">
                  {activeColumns.map((c) => (
                    <label key={c.id} className="checkbox checkbox--tight">
                      <input
                        type="checkbox"
                        checked={fkColumns.includes(c.name.trim())}
                        onChange={() => toggleFkColumn(c.name.trim())}
                      />
                      <span>{c.name || tr('designer.unnamed')}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <span className="designer__sub">{tr('designer.refTable')}</span>
                <select
                  className="input input--tight"
                  value={fkRefTable}
                  onChange={(e) => chooseFkRefTable(e.target.value)}
                >
                  <option value="">{tr('designer.chooseTable')}</option>
                  {tables
                    .filter((t) => t.type === 'table')
                    .map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name}
                      </option>
                    ))}
                </select>
                <div className="designer__index-cols">
                  {fkRefColumnsList.map((c) => (
                    <label key={c.name} className="checkbox checkbox--tight">
                      <input
                        type="checkbox"
                        checked={fkRefColumns.includes(c.name)}
                        onChange={() => toggleFkRefColumn(c.name)}
                      />
                      <span>
                        {c.name}
                        {c.isPrimaryKey ? ' (PK)' : ''}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="designer__index-row">
              <label className="designer__meta-field">
                <span>{tr('designer.onUpdate')}</span>
                <select
                  className="input input--tight"
                  value={fkOnUpdate}
                  onChange={(e) => setFkOnUpdate(e.target.value)}
                >
                  {FK_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a || tr('designer.fkDefault')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="designer__meta-field">
                <span>{tr('designer.onDelete')}</span>
                <select
                  className="input input--tight"
                  value={fkOnDelete}
                  onChange={(e) => setFkOnDelete(e.target.value)}
                >
                  {FK_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a || tr('designer.fkDefault')}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn btn--ghost btn--small"
                onClick={() => void previewForeignKey()}
                disabled={busy}
              >
                {tr('designer.showSql')}
              </button>
              <button
                className="btn btn--small"
                onClick={() => void runForeignKey()}
                disabled={busy}
              >
                {tr('designer.createForeign')}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="designer__pane">
          {infoLoading ? (
            <p className="muted designer__pad">{tr('designer.loadingInfo')}</p>
          ) : (
            <>
              <dl className="designer__info">
                <dt>{tr('designer.rowsEstimate')}</dt>
                <dd>{tableInfo?.rowCount ?? '-'}</dd>
                <dt>{tr('designer.size')}</dt>
                <dd>{formatBytes(tableInfo?.sizeBytes)}</dd>
                {tableInfo?.engine && (
                  <>
                    <dt>{tr('designer.engine')}</dt>
                    <dd>{tableInfo.engine}</dd>
                  </>
                )}
                {tableInfo?.collation && (
                  <>
                    <dt>{tr('designer.collation')}</dt>
                    <dd>{tableInfo.collation}</dd>
                  </>
                )}
                {tableInfo?.extra?.map((e) => (
                  <div key={e.label} className="designer__info-extra">
                    <dt>{e.label}</dt>
                    <dd>{e.value}</dd>
                  </div>
                ))}
              </dl>

              <div className="designer__form-block">
                <span className="designer__block-title">
                  {tr('designer.tableComment')}
                </span>
                <div className="designer__index-row">
                  <input
                    className="input input--tight designer__comment-input"
                    value={tableComment}
                    onChange={(e) => setTableComment(e.target.value)}
                    placeholder={
                      engine === 'sqlite'
                        ? tr('designer.commentTableUnsupported')
                        : tr('designer.commentTablePlaceholder')
                    }
                    disabled={engine === 'sqlite'}
                    aria-label={tr('designer.tableComment')}
                  />
                  <button
                    className="btn btn--small"
                    onClick={() => void saveTableComment()}
                    disabled={
                      busy ||
                      engine === 'sqlite' ||
                      tableComment === (tableInfo?.comment ?? '')
                    }
                  >
                    {tr('designer.saveComment')}
                  </button>
                </div>
              </div>

              <div className="designer__preview-head">
                <span>{tr('designer.ddl')}</span>
                {objectDdl && (
                  <button
                    className="btn btn--ghost btn--tiny"
                    onClick={() => void window.dbApi.clipboardWrite(objectDdl)}
                  >
                    {tr('qb.copy')}
                  </button>
                )}
              </div>
              {objectDdl ? (
                <pre className="sql-preview">{objectDdl}</pre>
              ) : (
                <p className="muted designer__pad">{tr('designer.engineNoDdl')}</p>
              )}
            </>
          )}
        </div>
      )}

      {showPreview && preview && (
        <div className="designer__preview">
          <div className="designer__preview-head">
            <span>{tr('view.previewSql')}</span>
            <button
              className="btn btn--ghost btn--tiny"
              onClick={() => setShowPreview(false)}
            >
              {tr('designer.hide')}
            </button>
          </div>
          <pre className="sql-preview">{preview.join('\n')}</pre>
        </div>
      )}

      {dropPrompt && props.mode === 'edit' && (
        <PromptDialog
          title={`${tr('designer.dropTable')} "${props.table}"?`}
          label={tr('designer.typeToConfirm')}
          placeholder={props.table}
          confirmLabel={tr('designer.dropTable')}
          onConfirm={(name) => void confirmDropTable(name)}
          onClose={() => setDropPrompt(false)}
        />
      )}
    </div>
  )
}

// Diffs the edited grid against the persisted table so the server only runs the
// ALTER statements that actually changed. PK changes are emitted last.
function diffAlterations(
  columns: DesignerColumn[],
  originalPk: PrimaryKeyInfo | null,
  nextPk: string[],
  engine: string
): TableAlteration[] {
  const out: TableAlteration[] = []
  const mysqlFamily = engine === 'mysql' || engine === 'mariadb'

  for (const c of columns) {
    if (c.markedForDrop && !c.isNew) {
      out.push({ type: 'dropColumn', name: c.original!.name })
      continue
    }
    if (c.isNew) {
      out.push({ type: 'addColumn', column: toDef(c) })
      continue
    }
    const orig = c.original!
    const name = c.name.trim()
    if (name !== orig.name) {
      out.push({ type: 'renameColumn', from: orig.name, to: name })
    }
    const typeChanged = c.dataType.trim() !== orig.dataType
    const nullChanged = c.nullable !== orig.nullable
    const autoChanged = c.autoIncrement !== (orig.autoIncrement === true)
    const defNext = c.defaultValue && c.defaultValue !== '' ? c.defaultValue : null
    const defChanged = (orig.defaultValue ?? null) !== defNext
    const modified = typeChanged || nullChanged || autoChanged || defChanged
    if (modified) {
      out.push({
        type: 'modifyColumn',
        column: toDef(c),
        previous: {
          dataType: orig.dataType,
          defaultValue: orig.defaultValue,
          nullable: orig.nullable,
          autoIncrement: orig.autoIncrement === true
        }
      })
    }
    // Comments are a separate statement on most engines. MySQL re-declares the
    // whole column with MODIFY COLUMN, which silently drops the comment, so it
    // is always re-emitted there when the column was modified at all.
    const commentNext = c.comment.trim() === '' ? null : c.comment
    const commentChanged = (orig.comment ?? null) !== commentNext
    if (commentChanged || (mysqlFamily && modified)) {
      out.push({
        type: 'setColumnComment',
        column: name,
        comment: commentNext,
        definition: toDef(c)
      })
    }
  }

  const beforePk = (originalPk?.columns ?? []).map((s) => s.toLowerCase()).join(',')
  const afterPk = nextPk.map((s) => s.toLowerCase()).join(',')
  if (beforePk !== afterPk) {
    // A changed PK must be dropped first; MySQL drops it by keyword, the rest
    // need the constraint name.
    if (originalPk) {
      out.push({ type: 'dropPrimaryKey', constraintName: originalPk.name })
    }
    if (nextPk.length > 0) {
      out.push({ type: 'setPrimaryKey', columns: nextPk })
    }
  }

  return out
}
