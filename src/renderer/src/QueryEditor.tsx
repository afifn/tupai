import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import Editor from '@monaco-editor/react'
import type {
  DbEngine,
  ExplainResult,
  QueryHistoryEntry,
  QueryResultSet,
  TransactionInfo
} from '@shared/types'
import { qualifiedTable } from '@shared/ddl'
import { formatSql, isFormatterSupported } from '@shared/sqlFormat'
import { pickDefaultDatabase } from '@shared/databaseChoice'
import { unwrap } from './api'
import { confirmDestructive } from './confirm'
import { monaco } from './monacoSetup'
import { PromptDialog } from './PromptDialog'
import { AiAssistant } from './AiAssistant'
import { QueryPlanPanel } from './QueryPlanPanel'
import { AiActionsPanel } from './AiActionsPanel'
import { QueryResultGrid } from './QueryResultGrid'
import { ContextMenu } from './ContextMenu'
import {
  IconChat,
  IconClose,
  IconFormat,
  IconHistory,
  IconMore,
  IconPlan,
  IconPlay,
  IconSave,
  IconStop,
  IconWrench
} from './Icons'
import { useLocale } from './i18n'
import type { MessageKey } from '@shared/i18n'
import { confirmAction } from './confirm'
import { commitsImplicitly } from '@shared/transactionGuard'
import { splitStatements } from '@shared/sqlBoundary'
import { useSettings } from './settingsStore'
import { shortcutLabel } from './platform'
import {
  getTables,
  onSchemaChange,
  primeSchemaCache,
  type CachedTable
} from './schemaCache'

interface Props {
  connectionId: string
  engine: string
  theme: string
  savedId?: string
  savedName?: string
  initialSql?: string
  initialDatabase?: string
  initialSchema?: string
  // Changes on every handoff, so a repeated insert for the same database still
  // re-applies the scope instead of leaving a hand-edited selector in place.
  initialToken?: number
  onSaved?: () => void
  // Tells the shell which database the editor is pointed at, so the assistant
  // can list the tables of that database for @mentions.
  onContextChange?: (context: { database: string; schema: string }) => void
  // Opens the Settings dialog on the AI section.
  onOpenSettings?: () => void
  // Called after a statement succeeds. The parent uses it to refresh the tree
  // and the assistant's table list when the script changed the schema.
  onRan?: (sql: string) => void
  // Commit/rollback outcome, so the shell can show a toast with the count.
  onTransactionNotice?: (message: string) => void
  // Tells the shell whether this editor holds an open transaction, so closing
  // the tab or disconnecting can ask first.
  onTransactionChange?: (open: boolean) => void
  // Inactive editors stay mounted, so they must re-report when they become the
  // visible one; the parent ignores reports from hidden editors.
  isVisible?: boolean
}

// Side panels are independent: history, the assistant, and AI actions can be
// open together, because a user often wants to keep history visible while
// asking the assistant about the statement. The query plan is not a panel: it is
// output of one execution, so it lives as a tab in the result area.
type AuxSurface = 'history' | 'ai' | 'actions'

// Which tab is selected in the result area: one per statement that returned
// rows, plus the message log and the execution plan.
type ResultView = number | 'messages' | 'plan'

interface Tab {
  id: string
  title: string
  sql: string
  // SQL as last loaded or saved. `dirty` is derived from the difference, so a
  // tab that was edited and then reverted to its saved text is not dirty.
  savedSql: string
  results: QueryResultSet[] | null
  error: string | null
  running: boolean
  durationMs: number
  // SQL that produced the current results. A run of a selection records only
  // that selection, so history and the message log match what was executed.
  ranSql: string
  view: ResultView
  plan: ExplainResult | null
  planLoading: boolean
  planError: string | null
  // A failed run has no result sets, so the message log would otherwise say
  // nothing ran. This keeps the executed SQL and the reason for the failure.
  failure: { sql: string; message: string } | null
}

// Imperative surface the shell needs in order to close a query tab without
// silently discarding typed SQL. One App tab can hold several editor sub-tabs,
// so "dirty" means any sub-tab differs from its baseline.
export interface QueryEditorHandle {
  hasDirty: () => boolean
  // Saves every dirty sub-tab that already has a name. Returns false when a
  // sub-tab still needs a name, so the caller can open the save dialog instead
  // of guessing one.
  saveDirty: () => Promise<boolean>
  // Opens the history side panel, used by the native View menu.
  openHistory: () => void
  // A manual transaction is open, so the shell must ask before closing the tab
  // or disconnecting: an abrupt close would silently roll the work back.
  hasOpenTransaction: () => boolean
  // Rolls the open transaction back, used by the close and disconnect guards.
  rollbackTransaction: () => Promise<void>
  // Commits it, for the close guard's "Commit" choice.
  commitTransaction: () => Promise<void>
  // How many statements the open transaction holds, for the close dialog.
  transactionStatementCount: () => number
}

const MAX_ROWS = 1000

const SQL_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'INSERT INTO',
  'UPDATE',
  'DELETE FROM',
  'VALUES',
  'JOIN',
  'LEFT JOIN',
  'INNER JOIN',
  'GROUP BY',
  'ORDER BY',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'CREATE TABLE',
  'ALTER TABLE',
  'DROP TABLE',
  'COUNT(*)',
  'DISTINCT',
  'AND',
  'OR',
  'AS'
]

function newTab(index: number): Tab {
  return {
    id: crypto.randomUUID(),
    title: `Query ${index}`,
    sql: '',
    savedSql: '',
    results: null,
    error: null,
    running: false,
    durationMs: 0,
    ranSql: '',
    view: 'messages',
    plan: null,
    planLoading: false,
    planError: null,
    failure: null
  }
}

const STARTER: Record<string, string> = {
  mysql: 'SELECT 1;',
  mariadb: 'SELECT 1;',
  postgres: 'SELECT 1;',
  oracle: 'SELECT 1 FROM DUAL;',
  sqlite: 'SELECT 1;'
}

let completionRegistered = false

export const QueryEditor = forwardRef<QueryEditorHandle, Props>(function QueryEditor(
  {
    connectionId,
    engine,
    theme,
    savedId,
    savedName,
    initialSql,
    initialDatabase,
    initialSchema,
    initialToken,
    onSaved,
    onContextChange,
    onOpenSettings,
    onRan,
    onTransactionNotice,
    onTransactionChange,
    isVisible = true
  },
  ref
): JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>(() => [{ ...newTab(1), sql: initialSql ?? '' }])
  const [cancelling, setCancelling] = useState(false)
  // SQLite runs synchronously and MongoDB has no SQL editor, so the button is
  // disabled there instead of pretending the query can be stopped.
  const cancellable =
    engine === 'mysql' ||
    engine === 'mariadb' ||
    engine === 'postgres' ||
    engine === 'oracle'
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id)
  const connectionRef = useRef(connectionId)
  connectionRef.current = connectionId
  // The Monaco command is registered once; route it through a ref so it always
  // runs the current tab's SQL instead of the first render's closure.
  const runRef = useRef<() => void>(() => undefined)

  const [databases, setDatabases] = useState<string[]>([])
  const [database, setDatabase] = useState<string>('')
  const [schemas, setSchemas] = useState<string[]>([])
  const [schema, setSchema] = useState<string>('')
  const [tables, setTables] = useState<CachedTable[]>(() => getTables(connectionId))
  const [selectTarget, setSelectTarget] = useState<string>('')
  const [savePrompt, setSavePrompt] = useState(false)
  // Panels are independent toggles rather than one exclusive slot: history and
  // the assistant are useful at the same time, and closing one must not close
  // the other. The rail only appears while at least one is open.
  const [panels, setPanels] = useState<Record<AuxSurface, boolean>>({
    history: false,
    ai: false,
    actions: false
  })
  // One manual transaction per editor. It is created on demand and lives on the
  // connection until the user commits or rolls back, so every sub-tab shares it:
  // they all talk to the same database session.
  const [transaction, setTransaction] = useState<TransactionInfo | null>(null)
  const transactionIdRef = useRef<string | null>(null)
  const transactionRef = useRef<TransactionInfo | null>(null)
  const transactionSupported = engine !== 'sqlite' && engine !== 'mongodb'
  const railOpen = panels.history || panels.ai || panels.actions
  const historyOpen = panels.history
  const aiOpen = panels.ai
  const actionsOpen = panels.actions
  const [history, setHistory] = useState<QueryHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [actionsInitial, setActionsInitial] = useState<string | undefined>(undefined)
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null)
  // Tracks whether the editor has a non-empty selection, so the run button can
  // say what it will actually execute.
  const [hasSelection, setHasSelection] = useState(false)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const { tr, errorText } = useLocale()
  const { settings } = useSettings()
  const editorPrefs = settings.editor
  // The editor used to be a fixed 220px. A stored fraction lets the user trade
  // editor height for result height on tall windows without a rebuild.
  const [editorFraction, setEditorFraction] = useState<number>(() => {
    const stored = Number(localStorage.getItem('queryEditor.split'))
    return Number.isFinite(stored) && stored >= 0.2 && stored <= 0.8 ? stored : 0.42
  })
  const [railWidth, setRailWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem('queryEditor.railWidth'))
    return Number.isFinite(stored) && stored >= 300 ? Math.min(560, stored) : 360
  })
  const workRef = useRef<HTMLDivElement | null>(null)

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]
  const dirtyTabs = tabs.filter((t) => t.sql !== t.savedSql)

  // The shell asks this before closing the tab. Saving is only automatic when
  // every dirty sub-tab already belongs to a saved query; otherwise the caller
  // opens the name dialog so nothing is written under a guessed name.
  useImperativeHandle(
    ref,
    () => ({
      hasDirty: () => dirtyTabs.length > 0,
      openHistory: () => setPanels((prev) => ({ ...prev, history: true })),
      hasOpenTransaction: () => transactionIdRef.current !== null,
      rollbackTransaction,
      commitTransaction,
      transactionStatementCount: () => transactionRef.current?.statements ?? 0,
      saveDirty: async (): Promise<boolean> => {
        if (!savedId) return false
        const tab = tabs.find((t) => t.id === activeId)
        if (!tab || tab.sql === tab.savedSql) return true
        if (!database) return false
        await unwrap(
          window.dbApi.saveQuery({
            id: savedId,
            connectionId,
            database,
            schema: schema || undefined,
            name: savedName ?? tab.title,
            sql: tab.sql
          })
        )
        setTabs((prev) =>
          prev.map((t) => (t.id === tab.id ? { ...t, savedSql: t.sql } : t))
        )
        onSaved?.()
        return true
      }
    }),
    [
      activeId,
      connectionId,
      database,
      dirtyTabs.length,
      onSaved,
      savedId,
      savedName,
      schema,
      tabs
    ]
  )

  // The Builder can hand SQL to an editor that is already mounted, so the
  // initialSql prop is applied whenever it changes, not only on first render.
  useEffect(() => {
    if (!initialSql) return
    setTabs((prev) => {
      if (prev.length === 0) return prev
      const current = prev.find((t) => t.id === activeId) ?? prev[0]
      // Never overwrite SQL the user typed; only adopt a new handoff.
      if (current.sql === initialSql) return prev
      return prev.map((t) =>
        t.id === current.id ? { ...t, sql: initialSql, savedSql: initialSql } : t
      )
    })
  }, [initialSql, activeId])

  useEffect(() => {
    if (initialDatabase) setDatabase(initialDatabase)
    if (initialSchema) setSchema(initialSchema)
    // initialToken is not read: it only forces this effect to run again when the
    // database and schema strings are identical to the previous handoff.
  }, [initialDatabase, initialSchema, initialToken])

  const refreshHistory = useCallback(async (): Promise<void> => {
    setHistoryLoading(true)
    try {
      setHistory(await unwrap(window.dbApi.listQueryHistory(connectionId)))
    } catch {
      setHistory([])
    } finally {
      setHistoryLoading(false)
    }
  }, [connectionId])

  useEffect(() => {
    if (!historyOpen) return
    void refreshHistory()
  }, [historyOpen, refreshHistory])

  useEffect(() => {
    setTables(getTables(connectionId))
    return onSchemaChange(() => setTables(getTables(connectionId)))
  }, [connectionId])

  useEffect(() => {
    void primeSchemaCache(connectionId)
  }, [connectionId])

  useEffect(() => {
    let cancelled = false
    setDatabases([])
    setDatabase(initialDatabase ?? '')
    setSchemas([])
    setSchema(initialSchema ?? '')
    unwrap(window.dbApi.listDatabases(connectionId))
      .then((dbs) => {
        if (cancelled) return
        setDatabases(dbs)
        setDatabase((prev) => prev || pickDefaultDatabase(dbs) || '')
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connectionId])

  useEffect(() => {
    if (!database) {
      setSchemas([])
      return
    }
    let cancelled = false
    unwrap(window.dbApi.listSchemas(connectionId, database))
      .then((found) => {
        if (cancelled) return
        setSchemas(found)
        setSchema((prev) => (prev && found.includes(prev) ? prev : (found[0] ?? '')))
      })
      .catch(() => {
        if (!cancelled) setSchemas([])
      })
    return () => {
      cancelled = true
    }
  }, [connectionId, database])

  // Report upward so @mentions resolve against the same database the editor is
  // pointed at, including after the user switches databases in the toolbar.
  // The callback is held in a ref so a parent that re-creates the function on
  // every render cannot retrigger this effect in a loop.
  const contextChangeRef = useRef(onContextChange)
  contextChangeRef.current = onContextChange
  const onTransactionChangeRef = useRef(onTransactionChange)
  onTransactionChangeRef.current = onTransactionChange
  // Same pattern: the run handler is created per render, but the callback may
  // change without the editor needing to re-register anything.
  const onRanRef = useRef(onRan)
  onRanRef.current = onRan
  useEffect(() => {
    if (!isVisible) return
    contextChangeRef.current?.({ database, schema })
  }, [database, schema, isVisible])

  function insertSelectAll(tableKey: string): void {
    const target = tables.find(
      (t) => `${t.database}.${t.schema ?? ''}.${t.name}` === tableKey
    )
    if (!target) return
    const name = qualifiedTable(
      engine as never,
      target.name,
      target.schema,
      target.database
    )
    updateTab(activeId, {
      sql: `SELECT * FROM ${name};`,
      results: null,
      error: null
    })
  }

  useEffect(() => {
    if (completionRegistered) return
    completionRegistered = true
    monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.'],
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position)
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn
        }
        const linePrefix = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        })
        const tables = getTables(connectionRef.current)
        const suggestions: monaco.languages.CompletionItem[] = []
        const seen = new Set<string>()
        const push = (item: monaco.languages.CompletionItem): void => {
          const key = `${item.kind}:${item.label}`
          if (seen.has(key)) return
          seen.add(key)
          suggestions.push(item)
        }

        // "table." or "alias." prefix: only that table's columns.
        const dotMatch = /([A-Za-z_][\w$]*)\s*\.\s*[\w$]*$/.exec(linePrefix)
        if (dotMatch) {
          const prefix = dotMatch[1]
          const target =
            tables.find((t) => t.name === prefix) ??
            tables.find((t) => t.name.toLowerCase() === prefix.toLowerCase())
          if (target) {
            for (const c of target.columns) {
              push({
                label: c.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: c.name,
                detail: `${target.name}.${c.name} : ${c.dataType}`,
                range
              })
            }
            return { suggestions }
          }
        }

        // Plain position: table names and keywords, deduped.
        for (const t of tables) {
          push({
            label: t.name,
            kind: monaco.languages.CompletionItemKind.Struct,
            insertText: t.name,
            detail: tr('query.tableHint', {
              path: `${t.database}${t.schema ? '.' + t.schema : ''}`
            }),
            range
          })
        }
        for (const kw of SQL_KEYWORDS) {
          push({
            label: kw,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: kw,
            range
          })
        }
        return { suggestions }
      }
    })
  }, [])

  const updateTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  // What the run button will execute: the selection when there is one, otherwise
  // the whole editor. Sending the whole tab while a fragment is highlighted is
  // the most common way to run the wrong statement by accident.
  function sqlToRun(): string {
    const editor = editorRef.current
    const selection = editor?.getSelection()
    if (!editorPrefs.runSelection) {
      return tabs.find((t) => t.id === activeId)?.sql ?? ''
    }
    if (editor && selection && !selection.isEmpty()) {
      const picked = editor.getModel()?.getValueInRange(selection) ?? ''
      if (picked.trim()) return picked
    }
    return tabs.find((t) => t.id === activeId)?.sql ?? ''
  }

  async function runActive(sqlOverride?: string): Promise<void> {
    const tab = tabs.find((t) => t.id === activeId)
    if (!tab) return
    const sql = sqlOverride ?? sqlToRun()
    if (!sql.trim()) {
      updateTab(tab.id, { error: tr('query.emptySql'), results: null })
      return
    }
    updateTab(tab.id, { running: true, error: null, failure: null })
    try {
      // DDL would silently end a manual transaction on MySQL/Oracle, so the
      // user is asked before anything runs.
      if (!(await confirmImplicitCommit(sql))) {
        updateTab(tab.id, { running: false })
        return
      }
      const started = performance.now()
      const results = await unwrap(
        window.dbApi.runQuery({
          connectionId,
          sql,
          maxRows: MAX_ROWS,
          database: database || undefined,
          schema: schema || undefined,
          transactionId: transactionIdRef.current ?? undefined
        })
      )
      if (transactionIdRef.current) {
        // The adapter counts statements; mirror the count so the toolbar shows
        // how much is pending without a round trip.
        setTransaction((prev) =>
          prev ? { ...prev, statements: prev.statements + 1 } : prev
        )
      }
      const durationMs = Math.round(performance.now() - started)
      const firstRows = results.findIndex((r) => r.kind === 'rows')
      updateTab(tab.id, {
        running: false,
        results,
        error: null,
        durationMs,
        ranSql: sql,
        failure: null,
        view: firstRows >= 0 ? firstRows : 'messages'
      })
      onRanRef.current?.(sql)
      const rowCount = results.reduce((sum, r) => sum + r.rowCount, 0)
      void window.dbApi.addQueryHistory({
        connectionId,
        database: database || undefined,
        schema: schema || undefined,
        sql,
        ok: true,
        rowCount,
        durationMs
      })
      if (historyOpen) void refreshHistory()
    } catch (err) {
      const message = errorText(err)
      updateTab(tab.id, {
        running: false,
        error: message,
        results: null,
        ranSql: sql,
        failure: { sql, message },
        view: 'messages'
      })
      void window.dbApi.addQueryHistory({
        connectionId,
        database: database || undefined,
        schema: schema || undefined,
        sql,
        ok: false,
        error: message
      })
      if (historyOpen) void refreshHistory()
    }
  }

  runRef.current = () => void runActive()

  async function cancelActive(): Promise<void> {
    setCancelling(true)
    try {
      await unwrap(window.dbApi.cancelQuery(connectionId))
    } catch (err) {
      updateTab(active.id, {
        error: errorText(err)
      })
    } finally {
      setCancelling(false)
    }
  }

  async function explainActive(): Promise<void> {
    const tab = tabs.find((t) => t.id === activeId)
    if (!tab) return
    const sql = sqlToRun()
    if (!sql.trim()) {
      updateTab(tab.id, { error: tr('query.emptySql'), results: null })
      return
    }
    updateTab(tab.id, { view: 'plan', planLoading: true, planError: null })
    try {
      const plan = await unwrap(
        window.dbApi.explainQuery({
          connectionId,
          sql,
          database: database || undefined,
          schema: schema || undefined
        })
      )
      updateTab(tab.id, { plan, planLoading: false })
    } catch (err) {
      updateTab(tab.id, {
        plan: null,
        planLoading: false,
        planError: errorText(err)
      })
    }
  }

  function requestSave(): void {
    const tab = tabs.find((t) => t.id === activeId)
    if (!tab || !tab.sql.trim()) return
    if (!database) {
      updateTab(tab.id, { error: tr('query.needDatabase') })
      return
    }
    setSavePrompt(true)
  }

  async function saveQueryWithName(name: string): Promise<void> {
    const tab = tabs.find((t) => t.id === activeId)
    if (!tab) return
    setSavePrompt(false)
    try {
      await unwrap(
        window.dbApi.saveQuery({
          id: savedId,
          connectionId,
          database,
          schema: schema || undefined,
          name,
          sql: tab.sql
        })
      )
      // The text now matches what is stored, so the tab is no longer dirty.
      updateTab(tab.id, { savedSql: tab.sql })
      onSaved?.()
    } catch (err) {
      updateTab(tab.id, {
        error: errorText(err)
      })
    }
  }

  function addTab(): void {
    const tab = newTab(tabs.length + 1)
    setTabs((prev) => [...prev, tab])
    setActiveId(tab.id)
  }

  function closeTab(id: string): void {
    const next = tabs.filter((t) => t.id !== id)
    if (next.length === 0) {
      const fresh = newTab(1)
      setTabs([fresh])
      setActiveId(fresh.id)
      return
    }
    setTabs(next)
    if (id === activeId) setActiveId(next[next.length - 1].id)
  }

  // Only the current database/schema is described, capped so a large server
  // cannot push the prompt past the model's context window.
  const schemaContext = useMemo(() => {
    const scoped = tables.filter(
      (t) => t.database === database && (t.schema ?? '') === (schema ?? '')
    )
    const list = scoped.length > 0 ? scoped : tables
    if (list.length === 0) return undefined
    const lines: string[] = []
    for (const table of list.slice(0, 120)) {
      const name = `${table.database}${table.schema ? '.' + table.schema : ''}.${table.name}`
      const columns = table.columns
        .slice(0, 60)
        .map((c) => `${c.name} ${c.dataType}${c.isPrimaryKey ? ' PK' : ''}`)
        .join(', ')
      lines.push(`${name}(${columns})`)
    }
    const prefix = `Engine: ${engine}\nDatabase: ${database || '-'}${
      schema ? `\nSchema: ${schema}` : ''
    }\n`
    return prefix + lines.join('\n')
  }, [tables, database, schema, engine])

  useEffect(() => {
    transactionRef.current = transaction
    onTransactionChangeRef.current?.(transaction !== null)
  }, [transaction])

  useEffect(() => {
    localStorage.setItem('queryEditor.split', String(editorFraction))
  }, [editorFraction])

  useEffect(() => {
    localStorage.setItem('queryEditor.railWidth', String(railWidth))
  }, [railWidth])

  // ---------- manual transaction ----------

  /** Starts a transaction for this editor, or returns the one already open. */
  async function beginTransaction(): Promise<TransactionInfo | null> {
    if (transaction) return transaction
    const id = `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    try {
      const info = await unwrap(
        window.dbApi.beginTransaction({
          connectionId,
          transactionId: id,
          database: database || undefined,
          schema: schema || undefined
        })
      )
      transactionIdRef.current = info.transactionId
      setTransaction(info)
      return info
    } catch (err) {
      updateTab(active.id, { error: errorText(err) })
      return null
    }
  }

  async function commitTransaction(): Promise<void> {
    const current = transaction
    if (!current) return
    try {
      await unwrap(
        window.dbApi.commitTransaction({
          connectionId,
          transactionId: current.transactionId
        })
      )
      pushTransactionToast('query.txCommitted', current.statements)
    } catch (err) {
      updateTab(active.id, { error: errorText(err) })
      return
    } finally {
      transactionIdRef.current = null
      setTransaction(null)
    }
    // Committed work is visible now, so any open table grid is stale.
    onRan?.('')
  }

  async function rollbackTransaction(): Promise<void> {
    const current = transaction
    if (!current) return
    try {
      await unwrap(
        window.dbApi.rollbackTransaction({
          connectionId,
          transactionId: current.transactionId
        })
      )
      pushTransactionToast('query.txRolledBack', current.statements)
    } catch (err) {
      updateTab(active.id, { error: errorText(err) })
    } finally {
      transactionIdRef.current = null
      setTransaction(null)
    }
  }

  function pushTransactionToast(key: MessageKey, statements: number): void {
    onTransactionNotice?.(tr(key, { count: statements }))
  }

  /**
   * DDL commits implicitly on MySQL, MariaDB, and Oracle. Running it inside a
   * manual transaction would end the transaction without telling the user, so
   * the script is checked first and the user decides.
   */
  async function confirmImplicitCommit(sql: string): Promise<boolean> {
    if (!transaction) return true
    const statements = splitStatements(sql)
    const offender = statements.find((stmt) =>
      commitsImplicitly(engine as DbEngine, stmt)
    )
    if (!offender) return true
    const choice = await confirmAction({
      title: tr('query.txDdlTitle'),
      message: tr('query.txDdlMessage', { engine }),
      detail: offender.trim().slice(0, 300),
      actions: [
        { label: tr('query.txDdlCommitAndRun'), primary: true },
        { label: tr('common.cancel') }
      ]
    })
    if (!choice) return false
    await commitTransaction()
    return true
  }

  function togglePanel(next: AuxSurface): void {
    setPanels((current) => ({ ...current, [next]: !current[next] }))
  }

  function closePanel(next: AuxSurface): void {
    setPanels((current) => ({ ...current, [next]: false }))
  }

  // Both dividers use the work area's live rectangle, so the fraction stays
  // correct after a window resize or a sidebar toggle.
  function startSplitDrag(event: React.PointerEvent<HTMLDivElement>): void {
    const work = workRef.current
    if (!work) return
    event.preventDefault()
    const rect = work.getBoundingClientRect()
    if (rect.height <= 0) return
    document.body.classList.add('is-row-resizing')
    const onMove = (move: PointerEvent): void => {
      const next = (move.clientY - rect.top) / rect.height
      setEditorFraction(Math.min(0.8, Math.max(0.2, next)))
    }
    const onUp = (): void => {
      document.body.classList.remove('is-row-resizing')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // ArrowDown moves the divider down, which makes the editor taller; ArrowUp
  // does the opposite. The key must match the pointer, not the number.
  function onSplitKey(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 0.05 : -0.05
    setEditorFraction((current) => Math.min(0.8, Math.max(0.2, current + delta)))
  }

  function startRailResize(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = railWidth
    document.body.classList.add('is-panel-resizing')
    const onMove = (move: PointerEvent): void => {
      setRailWidth(Math.min(560, Math.max(300, startWidth + (startX - move.clientX))))
    }
    const onUp = (): void => {
      document.body.classList.remove('is-panel-resizing')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function insertSql(sql: string): void {
    const tab = tabs.find((t) => t.id === activeId)
    if (!tab) return
    const merged = tab.sql.trim() ? `${tab.sql.trim()}\n\n${sql}` : sql
    updateTab(activeId, { sql: merged })
  }

  // Formatting is deterministic and local. When the formatter cannot parse a
  // statement (stored procedures, vendor syntax) the text is left untouched and
  // the reason is shown instead of silently rewriting it.
  function beautifyActive(): void {
    const tab = tabs.find((t) => t.id === activeId)
    if (!tab || !tab.sql.trim()) return
    const result = formatSql(tab.sql, engine as DbEngine)
    if (result.fellBack) {
      updateTab(tab.id, {
        error: tr('query.beautifySkipped', {
          reason: result.error ?? tr('query.syntaxUnknown')
        })
      })
      return
    }
    updateTab(tab.id, { sql: result.sql, error: null })
  }

  // One tab per statement that returned rows, plus the message log. A command
  // result has no columns, so it is reported in the log instead of an empty grid.
  const results = active.results ?? []
  const gridTabs = results
    .map((result, index) => ({ result, index }))
    .filter((entry) => entry.result.kind === 'rows')
  const hasPlanTab = Boolean(active.plan || active.planLoading || active.planError)
  // A stored index can point past the current results after a rerun, so the view
  // is clamped instead of rendering an empty pane with no explanation.
  const view: ResultView =
    typeof active.view === 'number'
      ? active.view < results.length
        ? active.view
        : 'messages'
      : active.view === 'plan' && !hasPlanTab
        ? 'messages'
        : active.view
  const activeResult = typeof view === 'number' ? (results[view] ?? null) : null

  return (
    <div className="query">
      <div className="query__context">
        <label className="query__ctx-field">
          <span className="query__ctx-label">Database</span>
          <select
            className="input"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            disabled={databases.length === 0 || transaction !== null}
            title={transaction ? tr('query.txContextLocked') : undefined}
          >
            {databases.length === 0 && <option value="">{tr('query.none')}</option>}
            {databases.map((db) => (
              <option key={db} value={db}>
                {db}
              </option>
            ))}
          </select>
        </label>

        <label className="query__ctx-field">
          <span className="query__ctx-label">Schema</span>
          <select
            className="input"
            value={schema}
            onChange={(e) => setSchema(e.target.value)}
            disabled={schemas.length === 0 || transaction !== null}
            title={transaction ? tr('query.txContextLocked') : undefined}
          >
            {schemas.length === 0 && <option value="">{tr('query.none')}</option>}
            {schemas.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="query__ctx-field query__ctx-field--wide">
          <span className="query__ctx-label">{tr('query.selectAllLabel')}</span>
          <select
            className="input"
            value={selectTarget}
            onChange={(e) => {
              setSelectTarget(e.target.value)
              if (e.target.value) {
                insertSelectAll(e.target.value)
                setSelectTarget('')
              }
            }}
            disabled={tables.length === 0}
          >
            <option value="">
              {tables.length === 0 ? tr('qb.loadingTables') : tr('qb.pickTable')}
            </option>
            {tables.map((t) => (
              <option
                key={`${t.database}.${t.schema ?? ''}.${t.name}`}
                value={`${t.database}.${t.schema ?? ''}.${t.name}`}
              >
                {t.database}
                {t.schema ? `.${t.schema}` : ''}.{t.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="query__work" ref={workRef}>
        <div className="query__main">
          <div className="query__tabs">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`query__tab${t.id === activeId ? ' is-active' : ''}`}
              >
                <button
                  className="query__tab-label"
                  onClick={() => setActiveId(t.id)}
                  title={t.sql !== t.savedSql ? tr('query.unsaved') : t.title}
                >
                  {t.title}
                  {t.sql !== t.savedSql && (
                    <span className="query__tab-dirty" aria-label={tr('query.unsaved')} />
                  )}
                </button>
                {tabs.length > 1 && (
                  <button
                    className="query__tab-close"
                    onClick={() => closeTab(t.id)}
                    aria-label={tr('query.closeTabLabel', { name: t.title })}
                  >
                    <IconClose size={12} />
                  </button>
                )}
              </div>
            ))}
            <button
              className="query__tab-add"
              onClick={addTab}
              aria-label={tr('query.newTab')}
            >
              +
            </button>
          </div>

          <div className="query__toolbar">
            <div className="query__toolbar-group query__toolbar-group--run">
              {active.running ? (
                <button
                  className="btn btn--small btn--danger query__run"
                  onClick={() => void cancelActive()}
                  disabled={cancelling || !cancellable}
                  title={cancellable ? tr('query.stop') : tr('query.cannotCancel')}
                >
                  <IconStop size={12} />
                  {cancelling ? tr('query.stopping') : tr('query.stop')}
                </button>
              ) : (
                <button
                  className="btn btn--small query__run"
                  onClick={() => void runActive()}
                  title={
                    hasSelection ? tr('query.runSelectionTitle') : tr('query.runTitle')
                  }
                >
                  <IconPlay size={12} />
                  {hasSelection ? tr('query.runSelection') : tr('query.run')}
                  <span className="query__kbd">{shortcutLabel('Enter')}</span>
                </button>
              )}
            </div>

            <div className="query__toolbar-group query__toolbar-group--tx">
              {!transaction ? (
                <button
                  className="btn btn--small btn--ghost query__tx-start"
                  onClick={() => void beginTransaction()}
                  disabled={!transactionSupported || active.running}
                  title={
                    transactionSupported
                      ? tr('query.txStartHint')
                      : tr('query.txUnsupported', { engine })
                  }
                >
                  {tr('query.txStart')}
                </button>
              ) : (
                <>
                  <span
                    className={`query__tx-badge${transaction.failed ? ' is-failed' : ''}`}
                    title={
                      transaction.failed ? tr('query.txFailed') : tr('query.txActive')
                    }
                  >
                    <span className="query__tx-dot" aria-hidden="true" />
                    {tr('query.txStatements', { count: transaction.statements })}
                  </span>
                  <button
                    className="btn btn--small btn--ok"
                    onClick={() => void commitTransaction()}
                    disabled={transaction.failed || active.running}
                    title={tr('query.txCommitTitle')}
                  >
                    {tr('query.txCommit')}
                  </button>
                  <button
                    className="btn btn--small btn--ghost"
                    onClick={() => void rollbackTransaction()}
                    disabled={active.running}
                    title={tr('query.txRollbackTitle')}
                  >
                    {tr('query.txRollback')}
                  </button>
                </>
              )}
            </div>

            <div className="query__toolbar-group query__toolbar-group--tools">
              <button
                className="icon-btn"
                onClick={requestSave}
                disabled={!active.sql.trim()}
                aria-label={savedId ? tr('query.update') : tr('query.save')}
                title={savedId ? tr('query.updateTitle') : tr('query.saveTitle')}
              >
                <IconSave size={15} />
              </button>
              <button
                className="icon-btn"
                onClick={beautifyActive}
                disabled={!active.sql.trim() || !isFormatterSupported(engine as DbEngine)}
                aria-label={tr('query.format')}
                title={tr('query.formatTitle')}
              >
                <IconFormat size={15} />
              </button>
              <span className="query__toolbar-sep" aria-hidden="true" />
              <button
                className={`icon-btn${historyOpen ? ' is-active' : ''}`}
                onClick={() => togglePanel('history')}
                aria-pressed={historyOpen}
                aria-label={tr('query.history')}
                title={tr('query.historyTitle')}
              >
                <IconHistory size={15} />
              </button>
              <button
                className={`icon-btn${aiOpen ? ' is-active' : ''}`}
                onClick={() => togglePanel('ai')}
                aria-pressed={aiOpen}
                aria-label={tr('query.assistant')}
                title={tr('query.assistantTitle')}
              >
                <IconChat size={15} />
              </button>
              <button
                className={`icon-btn${actionsOpen ? ' is-active' : ''}`}
                onClick={() => {
                  setActionsInitial(undefined)
                  togglePanel('actions')
                }}
                aria-pressed={actionsOpen}
                aria-label={tr('query.actions')}
                title={tr('query.actionsTitle')}
                disabled={!active.sql.trim()}
              >
                <IconWrench size={15} />
              </button>
              <button
                className="icon-btn"
                onClick={() => void explainActive()}
                disabled={
                  !active.sql.trim() || active.planLoading || engine === 'mongodb'
                }
                aria-label={tr('query.plan')}
                title={
                  engine === 'mongodb'
                    ? tr('query.mongoNoExplain')
                    : tr('query.planTitle')
                }
              >
                <IconPlan size={15} />
              </button>
              <button
                className="icon-btn"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  setMoreMenu({ x: rect.left, y: rect.bottom + 4 })
                }}
                aria-label={tr('query.more')}
                title={tr('query.more')}
                aria-haspopup="menu"
              >
                <IconMore size={15} />
              </button>
            </div>

            {active.results && (
              <span className="query__meta">
                {tr('query.statements', {
                  count: active.results.length,
                  ms: active.durationMs
                })}
              </span>
            )}
          </div>

          <div
            className="query__editor"
            style={{ flexGrow: editorFraction, flexBasis: 0 }}
          >
            <Editor
              height="100%"
              path={active.id}
              defaultLanguage="sql"
              language="sql"
              theme={theme === 'dark' ? 'vs-dark' : 'vs'}
              value={active.sql}
              onChange={(value) => updateTab(active.id, { sql: value ?? '' })}
              options={{
                fontSize: editorPrefs.fontSize,
                fontFamily: editorPrefs.fontFamily,
                tabSize: editorPrefs.tabSize,
                wordWrap: editorPrefs.wordWrap ? 'on' : 'off',
                minimap: { enabled: editorPrefs.minimap },
                lineNumbers: editorPrefs.lineNumbers ? 'on' : 'off',
                scrollBeyondLastLine: false,
                automaticLayout: true
              }}
              onMount={(editor) => {
                editorRef.current = editor
                editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
                  runRef.current()
                })
                editor.onDidChangeCursorSelection((event) => {
                  setHasSelection(!event.selection.isEmpty())
                })
              }}
            />
          </div>

          <div
            className="query__split"
            role="separator"
            aria-orientation="horizontal"
            aria-label={tr('query.splitLabel')}
            aria-valuemin={20}
            aria-valuemax={80}
            aria-valuenow={Math.round(editorFraction * 100)}
            tabIndex={0}
            title={tr('query.splitHint')}
            onPointerDown={startSplitDrag}
            onKeyDown={onSplitKey}
          >
            <span className="query__split-grip" aria-hidden="true" />
          </div>

          <div
            className="query__results"
            style={{ flexGrow: 1 - editorFraction, flexBasis: 0 }}
          >
            {active.running && (
              <p className="query__running" role="status">
                {tr('query.running')}
              </p>
            )}

            {active.error && (
              <div className="notice notice--error query__error" role="alert">
                <p className="query__error-text">{active.error}</p>
                <button
                  className="btn btn--tiny btn--ghost"
                  onClick={() => {
                    setActionsInitial('fix')
                    setPanels((current) => ({ ...current, actions: true }))
                  }}
                  title={tr('query.fixHint')}
                >
                  {tr('query.fixWithAi')}
                </button>
              </div>
            )}

            {!active.results && !active.error && !hasPlanTab && !active.running && (
              <div className="query__results-empty">
                <p className="muted">
                  {tr('query.emptyResults', { key: shortcutLabel('Enter') })}
                </p>
                {hasSelection && (
                  <p className="muted">
                    {tr('query.emptySelection', { key: shortcutLabel('Enter') })}
                  </p>
                )}
              </div>
            )}

            {(active.results || hasPlanTab) && (
              <div className="qres-tabs" role="tablist" aria-label={tr('query.results')}>
                {gridTabs.map((entry, order) => (
                  <button
                    key={entry.index}
                    role="tab"
                    aria-selected={view === entry.index}
                    className={`qres-tab${view === entry.index ? ' is-active' : ''}`}
                    onClick={() => updateTab(active.id, { view: entry.index })}
                  >
                    {tr('query.resultTab', { n: order + 1 })}
                    <span className="qres-tab__count" aria-hidden="true">
                      {entry.result.rowCount}
                    </span>
                  </button>
                ))}
                <button
                  role="tab"
                  aria-selected={view === 'messages'}
                  className={`qres-tab${view === 'messages' ? ' is-active' : ''}`}
                  onClick={() => updateTab(active.id, { view: 'messages' })}
                >
                  {tr('query.messages')}
                </button>
                {hasPlanTab && (
                  <button
                    role="tab"
                    aria-selected={view === 'plan'}
                    className={`qres-tab${view === 'plan' ? ' is-active' : ''}`}
                    onClick={() => updateTab(active.id, { view: 'plan' })}
                  >
                    {tr('query.planTab')}
                  </button>
                )}
              </div>
            )}

            <div className="query__results-body">
              {view === 'messages' && (
                <QueryMessages
                  results={active.results}
                  ranSql={active.ranSql}
                  failure={active.failure}
                />
              )}
              {view === 'plan' && (
                <QueryPlanPanel
                  result={active.plan}
                  loading={active.planLoading}
                  error={active.planError}
                  onClose={() => updateTab(active.id, { view: 'messages' })}
                  onRetry={() => void explainActive()}
                />
              )}
              {typeof view === 'number' && activeResult && (
                <QueryResultGrid
                  key={`${active.id}:${view}`}
                  result={activeResult}
                  connectionId={connectionId}
                  database={database || undefined}
                  schema={schema || undefined}
                />
              )}
            </div>
          </div>
        </div>

        {railOpen && (
          <div
            className="query__rail-resizer"
            onPointerDown={startRailResize}
            role="separator"
            aria-orientation="vertical"
            aria-label={tr('query.railLabel')}
            title={tr('query.railHint')}
          />
        )}
        {railOpen && (
          <aside
            className="query__rail"
            style={{ width: railWidth }}
            aria-label={tr('query.panels')}
          >
            <div className="query__rail-stack">
              {aiOpen && (
                <div className="query__panel">
                  <AiAssistant
                    schemaContext={schemaContext}
                    connectionId={connectionId}
                    database={database || undefined}
                    schema={schema || undefined}
                    engine={engine as DbEngine}
                    onInsertSql={insertSql}
                    onOpenSettings={onOpenSettings ?? (() => undefined)}
                    onClose={() => closePanel('ai')}
                  />
                </div>
              )}

              {actionsOpen && (
                <div className="query__panel">
                  <AiActionsPanel
                    sql={active.sql}
                    engine={engine as DbEngine}
                    errorMessage={active.error}
                    schemaContext={schemaContext}
                    initialActionId={actionsInitial}
                    onApply={(next) => updateTab(active.id, { sql: next, error: null })}
                    onClose={() => closePanel('actions')}
                  />
                </div>
              )}

              {historyOpen && (
                <div className="query__panel">
                  <div className="query__history">
                    <div className="query__history-head">
                      <span>
                        {tr('query.historyTitlePanel', { count: history.length })}
                      </span>
                      <div className="query__history-actions">
                        <button
                          className="btn btn--ghost btn--tiny"
                          onClick={() => void refreshHistory()}
                          disabled={historyLoading}
                        >
                          {tr('query.historyReload')}
                        </button>
                        <button
                          className="btn btn--ghost btn--tiny"
                          onClick={() => {
                            void confirmDestructive(tr('query.historyClearConfirm'), {
                              title: tr('query.historyClearTitle'),
                              detail: tr('query.historyClearDetail')
                            }).then((ok) => {
                              if (!ok) return
                              void unwrap(
                                window.dbApi.clearQueryHistory(connectionId)
                              ).then(() => {
                                setHistory([])
                              })
                            })
                          }}
                          disabled={history.length === 0}
                        >
                          {tr('query.historyClear')}
                        </button>
                        <button
                          className="icon-btn"
                          onClick={() => closePanel('history')}
                          aria-label={tr('query.historyClose')}
                          title={tr('query.historyClose')}
                        >
                          <IconClose size={12} />
                        </button>
                      </div>
                    </div>
                    {historyLoading ? (
                      <p className="muted query__history-empty">
                        {tr('query.historyLoading')}
                      </p>
                    ) : history.length === 0 ? (
                      <p className="muted query__history-empty">
                        {tr('query.historyEmpty')}
                      </p>
                    ) : (
                      <ul className="query__history-list">
                        {history.map((h) => (
                          <li key={h.id} className="query__history-item">
                            <button
                              className="query__history-sql"
                              onClick={() => updateTab(active.id, { sql: h.sql })}
                              title={tr('query.historyOpenSql')}
                            >
                              <span className="query__history-text">{h.sql}</span>
                              <span className="query__history-meta">
                                {new Date(h.createdAt).toLocaleString()}
                                {h.ok
                                  ? ` | ${tr('query.historyRows', { count: h.rowCount ?? 0 })}`
                                  : ` | ${tr('query.historyFailed')}`}
                                {h.durationMs !== null && h.durationMs !== undefined
                                  ? ` | ${h.durationMs} ms`
                                  : ''}
                              </span>
                            </button>
                            {!h.ok && h.error && (
                              <span className="query__history-error">{h.error}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {savePrompt && (
        <PromptDialog
          title={savedId ? tr('query.updateTitlePrompt') : 'Simpan query'}
          label={tr('query.namePrompt')}
          defaultValue={savedName ?? active.title}
          confirmLabel={tr(savedId ? 'query.updateLabel' : 'query.saveLabel')}
          onConfirm={(name) => void saveQueryWithName(name)}
          onClose={() => setSavePrompt(false)}
        />
      )}

      {moreMenu && (
        <ContextMenu
          x={moreMenu.x}
          y={moreMenu.y}
          items={[
            {
              label: tr('query.sample'),
              onSelect: () =>
                updateTab(active.id, { sql: STARTER[engine] ?? 'SELECT 1;' })
            },
            {
              label: tr('query.runTitle'),
              separatorBefore: true,
              disabled: !active.sql.trim(),
              onSelect: () => void runActive(active.sql)
            }
          ]}
          onClose={() => setMoreMenu(null)}
        />
      )}
    </div>
  )
})

// Message log for one execution: one row per statement with its status, row
// count, and duration. It is the only place a command result (INSERT, DDL) is
// shown, since a grid with no columns would say nothing useful.
function QueryMessages({
  results,
  ranSql,
  failure
}: {
  results: QueryResultSet[] | null
  ranSql: string
  failure: { sql: string; message: string } | null
}): JSX.Element {
  const { tr } = useLocale()
  if (failure) {
    return (
      <div className="qmsg">
        <table className="qmsg__table">
          <thead>
            <tr>
              <th className="qmsg__num">#</th>
              <th>{tr('query.statement')}</th>
              <th>{tr('query.status')}</th>
              <th className="qmsg__num">{tr('query.colRows')}</th>
              <th className="qmsg__num">{tr('query.duration')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="qmsg__num">1</td>
              <td className="qmsg__sql" title={failure.sql}>
                {failure.sql}
              </td>
              <td>
                <span className="qmsg__badge is-failed">
                  {tr('query.statementFailed')}
                </span>
              </td>
              <td className="qmsg__num">-</td>
              <td className="qmsg__num">-</td>
            </tr>
          </tbody>
        </table>
        <p className="qmsg__error">{failure.message}</p>
      </div>
    )
  }
  if (!results || results.length === 0) {
    return (
      <div className="qmsg qmsg--empty">
        <p className="muted">{tr('query.noStatements')}</p>
        {ranSql.trim() && <pre className="qmsg__sql-full">{ranSql}</pre>}
      </div>
    )
  }
  return (
    <div className="qmsg">
      <table className="qmsg__table">
        <thead>
          <tr>
            <th className="qmsg__num">#</th>
            <th>{tr('query.statement')}</th>
            <th>{tr('query.status')}</th>
            <th className="qmsg__num">{tr('query.colRows')}</th>
            <th className="qmsg__num">{tr('query.duration')}</th>
          </tr>
        </thead>
        <tbody>
          {results.map((result, index) => (
            <tr key={index}>
              <td className="qmsg__num">{index + 1}</td>
              <td className="qmsg__sql" title={result.statement}>
                {result.statement}
              </td>
              <td>
                <span className="qmsg__badge is-ok">{tr('query.statementOk')}</span>
              </td>
              <td className="qmsg__num">{result.rowCount}</td>
              <td className="qmsg__num">{result.durationMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
