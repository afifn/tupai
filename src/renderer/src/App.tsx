import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageKey } from '@shared/i18n'
import type {
  DbEngine,
  MenuAction,
  RoutineKind,
  SavedQuery,
  StoredConnection
} from '@shared/types'
import { ApiError, unwrap } from './api'
import { ConnectionForm } from './ConnectionForm'
import { ImportConnectionsDialog } from './ImportConnectionsDialog'
import { ObjectTree } from './ObjectTree'
import type {
  DatabaseTarget,
  RoutineTarget,
  SchemaTarget,
  SelectedTable,
  TableTarget
} from './ExplorerTree'
import { DataGrid } from './DataGrid'
import { FormView } from './FormView'
import { SessionsPanel } from './SessionsPanel'
import { ObjectsPanel } from './ObjectsPanel'
import { QueryEditor, type QueryEditorHandle } from './QueryEditor'
import { ConfirmDialog, type ConfirmAction } from './ConfirmDialog'
import { confirmAction, confirmDestructive } from './confirm'
import { TableDesigner } from './TableDesigner'
import { ViewDesigner } from './ViewDesigner'
import { ObjectDefinition } from './ObjectDefinition'
import { DiagramView } from './DiagramView'
import { UsersPanel } from './UsersPanel'
import { RightPanel, type RightPanelTab } from './RightPanel'
import type { InspectedRow } from './DetailPanel'
import { BackupPanel } from './BackupPanel'
import { QueryBuilderPanel } from './QueryBuilderPanel'
import { TransferPanel } from './TransferPanel'
import { SyncPanel } from './SyncPanel'
import { IoPanel } from './IoPanel'
import { clearSchemaCache } from './schemaCache'
import { changesSchema } from '@shared/sqlChange'
import { ToastStack, useToasts } from './Toast'
import { describeConnectionError } from '@shared/connectionError'
import { useLocale } from './i18n'
import { useSettings } from './settingsStore'
import { SettingsDialog } from './SettingsDialog'
import { bindingFor, matchesBinding, type ActionId } from '@shared/keymap'

import { PromptDialog } from './PromptDialog'
import {
  IconActivity,
  IconArchive,
  IconClose,
  IconSearch,
  IconFolderPlus,
  IconImport,
  IconPlus,
  IconQuery,
  IconSidebar,
  IconServer,
  IconFilter,
  IconSettings,
  IconSync,
  IconTable,
  IconSchema,
  IconTablePlus,
  IconTransfer,
  IconUsers,
  IconView
} from './Icons'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { shortcutLabel } from './platform'
import { pickDefaultDatabase } from '@shared/databaseChoice'
import { useSchemaContext } from './useSchemaContext'

type TableView = 'data' | 'form' | 'struct' | 'io' | 'definition'

type Tab =
  | { id: string; type: 'table'; selection: SelectedTable; view: TableView }
  | {
      id: string
      type: 'query'
      connectionId: string
      savedId?: string
      savedName?: string
      initialSql?: string
      initialDatabase?: string
      initialSchema?: string
      // Bumped on every handoff so the editor re-applies a scope whose value is
      // unchanged (for example inserting twice for the same database after the
      // user switched the toolbar selector by hand).
      initialToken?: number
    }
  | { id: string; type: 'users'; connectionId: string }
  | {
      id: string
      type: 'diagram'
      connectionId: string
      engine: string
      database: string
      schema?: string
    }
  | {
      id: string
      type: 'definition'
      connectionId: string
      database: string
      schema?: string
      name: string
      kind: 'view' | RoutineKind
      signature?: string | null
    }
  | { id: string; type: 'backup'; connectionId: string; database?: string }
  | {
      id: string
      type: 'sync'
      connectionId: string
      database?: string
      schema?: string
    }
  | {
      id: string
      type: 'transfer'
      connectionId: string
      database?: string
      table?: string
      schema?: string
    }
  | {
      id: string
      type: 'builder'
      connectionId: string
      engine: DbEngine
      database: string
      schema?: string
    }
  | { id: string; type: 'sessions'; connectionId: string; database?: string }
  | {
      id: string
      type: 'objects'
      connectionId: string
      engine: DbEngine
      connectionName: string
      database: string
      schema?: string
    }
  | {
      id: string
      type: 'createTable'
      connectionId: string
      database: string
      schema?: string
    }
  | {
      id: string
      type: 'view'
      connectionId: string
      engine: DbEngine
      database: string
      schema?: string
      viewName: string
    }

function tableKey(sel: SelectedTable): string {
  return `table:${sel.connectionId}:${sel.database}:${sel.schema ?? ''}:${sel.table}`
}

function createTableKey(connectionId: string, database: string, schema?: string): string {
  return `createTable:${connectionId}:${database}:${schema ?? ''}`
}

function viewKey(
  connectionId: string,
  database: string,
  schema: string | undefined,
  view: string
): string {
  return `view:${connectionId}:${database}:${schema ?? ''}:${view}`
}

// Row values are sent to the assistant as compact text. Long values are cut so a
// single BLOB or text column cannot dominate the prompt.
function formatContextValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') {
    if (value instanceof Uint8Array) return `<biner ${value.length}B>`
    try {
      const text = JSON.stringify(value)
      return text.length > 80 ? `${text.slice(0, 80)}...` : text
    } catch {
      return '[objek]'
    }
  }
  const text = String(value)
  return text.length > 80 ? `${text.slice(0, 80)}...` : text
}

// Table tabs carry their connection inside the selection, every other tab
// carries it directly. One accessor keeps both shapes usable.
function tabConnectionId(tab: Tab): string {
  return 'connectionId' in tab ? tab.connectionId : tab.selection.connectionId
}

// Database and schema the tab is pointed at. The sidebar marks this location so
// the tree agrees with the editor instead of only tracking what is expanded.
function tabScope(tab: Tab | null): { database: string; schema?: string } | null {
  if (!tab) return null
  if (tab.type === 'table') {
    return { database: tab.selection.database, schema: tab.selection.schema }
  }
  if (tab.type === 'users') return null
  if (tab.type === 'query') {
    if (!tab.initialDatabase) return null
    return { database: tab.initialDatabase, schema: tab.initialSchema }
  }
  if ('database' in tab && tab.database) {
    return { database: tab.database, schema: 'schema' in tab ? tab.schema : undefined }
  }
  return null
}

// Tab labels are user-visible, so they come from the catalogue. `tr` is passed
// in because these helpers live outside the component.
function tabLabel(
  tab: Tab,
  tr: (key: MessageKey, params?: Record<string, string | number>) => string
): string {
  if (tab.type === 'query') return tab.savedName ?? tr('tab.query')
  if (tab.type === 'users') return tr('app.users')
  if (tab.type === 'backup') return tr('app.backup')
  if (tab.type === 'sync') return tr('app.sync')
  if (tab.type === 'builder') return tr('app.builder')
  if (tab.type === 'transfer') return tr('app.transferTitle').split(' (')[0]
  if (tab.type === 'sessions') return tr('app.sessions')
  if (tab.type === 'objects') return tab.database
  if (tab.type === 'createTable') return tr('tab.newTable')
  if (tab.type === 'view') return tab.viewName || tr('tab.newView')
  if (tab.type === 'definition') return tab.name
  if (tab.type === 'diagram') return tr('app.diagram')
  return tab.selection.table
}

// Two connections each have their own query tab, so a bare "Query editor" made
// them indistinguishable in the tab bar; the connection name disambiguates.
function tabTooltip(
  tab: Tab,
  tr: (key: MessageKey, params?: Record<string, string | number>) => string,
  connectionName?: string
): string {
  const where = connectionName ? tr('tab.where', { name: connectionName }) : ''
  if (tab.type === 'query') return tab.savedName ?? tr('tab.queryTooltip', { where })
  if (tab.type === 'users') return tr('app.usersTitle', { key: '' }).trim()
  if (tab.type === 'backup') return tr('appMenu.backup')
  if (tab.type === 'sync') {
    return tr('tab.syncTooltip', {
      where: tab.database ? tr('tab.where', { name: tab.database }) : ''
    })
  }
  if (tab.type === 'builder') {
    return tr('tab.builderTooltip', {
      scope: `${tab.database}${tab.schema ? `.${tab.schema}` : ''}`
    })
  }
  if (tab.type === 'transfer') {
    return tr('tab.transferTooltip', {
      from: tab.table ? tr('tab.from', { table: tab.table }) : ''
    })
  }
  if (tab.type === 'sessions') {
    return tr('tab.sessionsTooltip', {
      where: tab.database ? tr('tab.where', { name: tab.database }) : ''
    })
  }
  if (tab.type === 'objects') {
    return tr('tab.objectsTooltip', {
      database: tab.database,
      scope: tab.schema ? `.${tab.schema}` : ''
    })
  }
  if (tab.type === 'createTable') {
    return tr('tab.newTableTooltip', {
      scope: `${tab.database}${tab.schema ? `.${tab.schema}` : ''}`
    })
  }
  if (tab.type === 'view') {
    return tr('tab.newViewTooltip', {
      scope: `${tab.database}${tab.schema ? `.${tab.schema}` : ''}.${tab.viewName || tr('tab.newSuffix')}`
    })
  }
  if (tab.type === 'definition') {
    return tr('tab.definitionTooltip', {
      scope: `${tab.database}${tab.schema ? `.${tab.schema}` : ''}`,
      name: tab.name,
      kind: tab.kind
    })
  }
  if (tab.type === 'diagram') {
    return tr('tab.diagramTooltip', {
      scope: `${tab.database}${tab.schema ? `.${tab.schema}` : ''}`
    })
  }
  const { database, schema, table } = tab.selection
  return `${database}${schema ? `.${schema}` : ''}.${table}`
}

function TabIcon({ tab }: { tab: Tab }): JSX.Element {
  if (tab.type === 'query') return <IconQuery size={13} />
  if (tab.type === 'users') return <IconUsers size={13} />
  if (tab.type === 'backup') return <IconImport size={13} />
  if (tab.type === 'sync') return <IconSync size={13} />
  if (tab.type === 'builder') return <IconQuery size={13} />
  if (tab.type === 'transfer') return <IconImport size={13} />
  if (tab.type === 'sessions') return <IconActivity size={13} />
  if (tab.type === 'objects') return <IconTable size={13} />
  if (tab.type === 'view') return <IconView size={13} />
  return <IconTable size={13} />
}

// Distance kept between the last toolbar control and the native caption buttons.
// Zero makes the settings button read as part of the minimise/maximise/close
// cluster instead of a separate control.
const CAPTION_GAP = 10

export function App(): JSX.Element {
  const [connections, setConnections] = useState<StoredConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  // Every connection that is currently connected. Navicat keeps several open at
  // once; activeId is just the one whose tabs and menus are in focus.
  const [openConnectionIds, setOpenConnectionIds] = useState<Set<string>>(new Set())
  // Connections whose last connect attempt failed, with the reason to show in
  // the tree. Cleared as soon as the connection succeeds again.
  const [connectionErrors, setConnectionErrors] = useState<Map<string, string>>(new Map())
  const [connectingIds, setConnectingIds] = useState<Set<string>>(new Set())
  // Set when the database worker thread dies: every adapter lives in that thread,
  // so all connections are gone at once. Shown as a banner so the user knows to
  // reconnect instead of blaming the server.
  const [workerLost, setWorkerLost] = useState<{
    message: string
    lastOp: string | null
  } | null>(null)
  const {
    toasts,
    push: pushToast,
    dismiss: dismissToast,
    pause: pauseToast,
    resume: resumeToast
  } = useToasts()
  const { tr, errorText } = useLocale()
  const [editing, setEditing] = useState<StoredConnection | 'new' | null>(null)
  // Path of the Navicat export being previewed, or null when the dialog is shut.
  const [ncxPath, setNcxPath] = useState<string | null>(null)
  // Sidebar filter, opened with Cmd/Ctrl+F. It filters what the tree has loaded
  // instead of running a per-database server search, so one field covers every
  // connection the user has open.
  const [sidebarFilter, setSidebarFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterResult, setFilterResult] = useState<{ matches: number; pending: boolean }>(
    {
      matches: 1,
      pending: false
    }
  )
  const filterInputRef = useRef<HTMLInputElement | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  // One ref per query tab, so closing can ask the editor whether it holds
  // unsaved SQL. Non-query tabs never register here.
  const queryEditors = useRef(new Map<string, QueryEditorHandle>())
  // Set when a close is waiting on the unsaved-changes dialog.
  const [pendingClose, setPendingClose] = useState<{
    tabIds: string[]
    dirtyTabId: string
  } | null>(null)
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const tabStripRef = useRef<HTMLDivElement | null>(null)
  // Table tabs whose filter panel is open. The toggle lives in the tab strip
  // (see the table tab below), so the shell owns it instead of the grid.
  const [openFilterTabs, setOpenFilterTabs] = useState<Set<string>>(new Set())
  const { settings } = useSettings()
  // Monaco only needs light vs dark; the accent presets are UI-only.
  const theme: 'light' | 'dark' = settings.general.themeId.startsWith('dark')
    ? 'dark'
    : 'light'
  // macOS runs with `titleBarStyle: 'hiddenInset'`, so the toolbar is the title
  // bar: it needs room for the traffic lights, and none in fullscreen where
  // macOS hides them. Windows 11 and Linux use `titleBarOverlay`, so the OS draws
  // the caption buttons inside the same row and the renderer only has to keep
  // them from overlapping the toolbar controls.
  const customTitleBar = window.dbApi.usesCustomTitleBar === true
  const [windowFullscreen, setWindowFullscreen] = useState(false)
  // Chromium exposes the window-controls overlay directly, and it is the only
  // source that reflects whether the OS actually drew the caption buttons. The
  // IPC flag says the window was created with the option; this says it took
  // effect. Reading it first also avoids one frame with the wrong padding.
  const [titleBarOverlay, setTitleBarOverlay] = useState(
    () =>
      window.dbApi.usesCustomTitleBar !== true &&
      navigator.windowControlsOverlay?.visible === true
  )
  // Right inset for the OS caption buttons, measured from the toolbar itself so
  // a future width change cannot leave the buttons on top of a control.
  const [captionInset, setCaptionInset] = useState(0)
  const toolbarRef = useRef<HTMLElement>(null)

  // The worker holds every adapter, so when its thread dies the app has no
  // connections left even though the UI still lists them as open. Clearing the
  // set makes the tree show "connect" again, which is the truth.
  useEffect(() => {
    return window.dbApi.onWorkerLost((event) => {
      setOpenConnectionIds(new Set())
      setConnectingIds(new Set())
      clearSchemaCache()
      setWorkerLost({ message: event.reason.message, lastOp: event.lastOp })
    })
  }, [])

  useEffect(() => {
    if (customTitleBar) {
      // macOS: the traffic lights are hidden in fullscreen, so the toolbar has to
      // stop reserving their inset. The renderer cannot see native fullscreen.
      void window.dbApi
        .getWindowState()
        .then((res) => {
          if (res.ok && res.data) setWindowFullscreen(res.data.fullscreen)
        })
        .catch(() => undefined)
      return window.dbApi.onWindowState((state) => setWindowFullscreen(state.fullscreen))
    }

    const overlay = navigator.windowControlsOverlay
    if (!overlay) return
    const sync = (): void => setTitleBarOverlay(overlay.visible)
    sync()
    overlay.addEventListener('geometrychange', sync)
    return () => overlay.removeEventListener('geometrychange', sync)
  }, [customTitleBar])

  // The caption buttons are drawn by the OS, so their width is not in the DOM.
  // `getTitlebarAreaRect()` reports the rectangle the OS kept for them, which is
  // exact; the fallback measures what the toolbar content cannot use.
  //
  // The same pass also pushes the overlay colours and height, because a zoom
  // change fires `resize` but leaves the toolbar's CSS height at 44px: the
  // overlay is in DIP and would otherwise keep the old, mismatched height.
  const syncOverlay = useCallback((): void => {
    const node = toolbarRef.current
    if (!node) return
    const zoom = window.dbApi.getZoom() || 1
    const height = Math.round(node.getBoundingClientRect().height * zoom)
    // A transparent overlay lets the page paint under the caption buttons, so
    // the toolbar's own divider runs unbroken to the window edge. The toolbar
    // background already matches the theme, so nothing is lost by leaving the
    // overlay colourless; only the symbols need a colour.
    void window.dbApi
      .setTitleBarColors('rgba(0,0,0,0)', getComputedStyle(document.body).color, height)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!titleBarOverlay) {
      setCaptionInset(0)
      return
    }
    function measure(): void {
      const node = toolbarRef.current
      if (!node) return
      const overlay = navigator.windowControlsOverlay
      const area = overlay?.visible ? overlay.getTitlebarAreaRect() : null
      // The overlay rect is in page CSS pixels, the same coordinate space as the
      // toolbar, so the two can be subtracted directly. Only the overlay's own
      // height is in DIP and needs the zoom conversion.
      if (area) {
        // Leave a gap between the last control and the caption buttons: at zero
        // the settings button sits flush against the minimise button and reads as
        // one cluster.
        setCaptionInset(
          Math.max(0, Math.round(node.clientWidth - area.right) + CAPTION_GAP)
        )
      } else {
        const scroll = node.querySelector('.menubar__scroll')
        const contentWidth = scroll ? scroll.scrollWidth : 0
        const free = node.clientWidth - contentWidth
        setCaptionInset(free > 0 ? Math.max(0, Math.round(free)) : 0)
      }
      syncOverlay()
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (toolbarRef.current) observer.observe(toolbarRef.current)
    const overlay = navigator.windowControlsOverlay
    overlay?.addEventListener('geometrychange', measure)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      overlay?.removeEventListener('geometrychange', measure)
      window.removeEventListener('resize', measure)
    }
  }, [titleBarOverlay, syncOverlay])

  // The overlay is native, so it cannot read a CSS variable. Re-send after a
  // theme change: this effect belongs to the app shell, whose parent
  // SettingsProvider applies the theme attribute in its own effect, and a child
  // effect runs first. Reading in a microtask (after both have committed) avoids
  // sending the previous theme's colours.
  //
  // No cancellation flag here on purpose: StrictMode mounts, cleans up, and
  // mounts again in development, and a flag cleared by the first cleanup would
  // swallow the only send. Sending twice is harmless.
  useEffect(() => {
    if (!titleBarOverlay) return
    void Promise.resolve().then(syncOverlay)
  }, [
    titleBarOverlay,
    settings.general.themeId,
    settings.display.zoomFactor,
    syncOverlay
  ])
  // Inactive editors stay mounted so their state survives tab switches. Their
  // scope reports must be ignored, or the last mounted tab would win.
  const activeTabIdRef = useRef<string | null>(null)
  activeTabIdRef.current = activeTabId
  const [treeVersion, setTreeVersion] = useState(0)
  const [queryVersion, setQueryVersion] = useState(0)
  // Query tabs with an uncommitted manual transaction. The shell guards closing
  // the tab, disconnecting, and quitting on this set.
  const [openTransactions, setOpenTransactions] = useState<Set<string>>(new Set())
  // The right dock holds the assistant and the selected record. It opens on
  // demand so the editor keeps the full width until the user needs it.
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('assistant')
  // The row the user clicked in the grid, shown in the dock's detail section.
  const [inspectedRow, setInspectedRow] = useState<InspectedRow | null>(null)
  // Database and schema the active query editor is pointed at. The assistant
  // uses it to list tables for @mentions, so it must follow the editor toolbar.
  const [assistantScope, setAssistantScope] = useState<{
    connectionId?: string
    database?: string
    schema?: string
  }>({})
  // Last database/schema clicked in the sidebar, per connection. A new query tab
  // uses it as its default scope, and the tree marks it while no tab points
  // somewhere else. Per connection so switching servers cannot inherit a
  // database that belongs to another one.
  const [treeFocus, setTreeFocus] = useState<
    Record<string, { database: string; schema?: string }>
  >({})
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(
    null
  )
  const [queryMenu, setQueryMenu] = useState<{
    x: number
    y: number
    query: SavedQuery
  } | null>(null)
  const [renamingQuery, setRenamingQuery] = useState<SavedQuery | null>(null)
  const [connMenu, setConnMenu] = useState<{
    x: number
    y: number
    conn: StoredConnection
  } | null>(null)
  const [dbMenu, setDbMenu] = useState<{
    x: number
    y: number
    target: DatabaseTarget
  } | null>(null)
  const [tableMenu, setTableMenu] = useState<{
    x: number
    y: number
    target: TableTarget
  } | null>(null)
  const [schemaMenu, setSchemaMenu] = useState<{
    x: number
    y: number
    target: SchemaTarget
  } | null>(null)
  const [routineMenu, setRoutineMenu] = useState<{
    x: number
    y: number
    target: RoutineTarget
  } | null>(null)
  const [namePrompt, setNamePrompt] = useState<{
    title: string
    label: string
    defaultValue?: string
    confirmLabel?: string
    onConfirm: (value: string) => void
  } | null>(null)
  const [groupPrompt, setGroupPrompt] = useState<{ mode: 'create' } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<
    'general' | 'appearance' | 'editor' | 'grid' | 'ai' | 'keymap' | 'about'
  >('general')

  async function createGroup(name: string): Promise<void> {
    setGroupPrompt(null)
    if (!name.trim()) return
    try {
      await unwrap(window.dbApi.saveConnectionGroup({ name }))
      // The sidebar reloads its own group list when connections change.
      setTreeVersion((v) => v + 1)
    } catch (err) {
      setError(errorText(err))
    }
  }

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  // The menus and the status bar follow the active tab. With several
  // connections open, the focused tree row is not always the server whose tab
  // the user is looking at.
  const activeTabConnectionId =
    activeTab && 'connectionId' in activeTab
      ? activeTab.connectionId
      : activeTab?.type === 'table'
        ? activeTab.selection.connectionId
        : null
  // The focused connection wins. The effect below moves focus when a tab is
  // selected, so this stays in sync without letting an old tab override a fresh
  // sidebar selection.
  const menuConnectionId = activeId
  const activeEngine = connections.find((c) => c.id === menuConnectionId)?.engine
  const activeConnectionName = connections.find((c) => c.id === menuConnectionId)?.name
  const supportsUsers =
    activeEngine === 'mysql' ||
    activeEngine === 'mariadb' ||
    activeEngine === 'postgres' ||
    activeEngine === 'oracle'
  const isDocument = activeEngine === 'mongodb'
  const activeSelection = activeTab?.type === 'table' ? activeTab.selection : null
  // Where the active tab works. A tab on another connection must not mark a
  // database in the focused connection's tree.
  const activeScope = tabScope(activeTab)
  // A tab is the strongest signal; without one, the tree still marks the
  // database the user last opened so the sidebar keeps saying where they are.
  const focusedTreeScope = menuConnectionId ? treeFocus[menuConnectionId] : undefined
  const treeActiveDatabase =
    activeTabConnectionId && activeTabConnectionId === activeId
      ? activeScope?.database
      : focusedTreeScope?.database
  const treeActiveSchema =
    activeTabConnectionId && activeTabConnectionId === activeId
      ? activeScope?.schema
      : focusedTreeScope?.schema

  // What the Detail pane describes. Clicking a table in the sidebar opens its
  // tab, so the active table tab is the selection.
  const detailSelection =
    activeTab?.type === 'table'
      ? {
          connectionId: activeTab.selection.connectionId,
          database: activeTab.selection.database,
          schema: activeTab.selection.schema,
          table: activeTab.selection.table
        }
      : null

  // The assistant gets the real column list of the open table. Names alone are
  // not enough to write valid SQL, and a full schema dump would flood the prompt.
  const [contextColumns, setContextColumns] = useState<
    { name: string; dataType: string; isPrimaryKey: boolean }[]
  >([])

  useEffect(() => {
    if (!detailSelection) {
      setContextColumns([])
      return
    }
    let cancelled = false
    unwrap(
      window.dbApi.listColumns(
        detailSelection.connectionId,
        detailSelection.database,
        detailSelection.table,
        detailSelection.schema
      )
    )
      .then((found) => {
        if (cancelled) return
        setContextColumns(
          found.map((c) => ({
            name: c.name,
            dataType: c.dataType,
            isPrimaryKey: c.isPrimaryKey
          }))
        )
      })
      .catch(() => {
        if (!cancelled) setContextColumns([])
      })
    return () => {
      cancelled = true
    }
  }, [
    detailSelection?.connectionId,
    detailSelection?.database,
    detailSelection?.schema,
    detailSelection?.table
  ])

  // @mentions resolve against one database. A table tab already knows its
  // database; a query tab reports its own toolbar selection. Anything else has
  // no obvious scope, so mentions stay off until the user opens a table or query.
  const assistantScopeResolved = (() => {
    if (activeTab?.type === 'table') {
      return {
        connectionId: activeTab.selection.connectionId,
        database: activeTab.selection.database,
        schema: activeTab.selection.schema
      }
    }
    if (assistantScope.connectionId && assistantScope.database) {
      return assistantScope
    }
    return null
  })()

  // The assistant always knows which engine and database the user is looking at,
  // even when no table is open: answering "which database am I in" should not
  // require opening a table first. Table and column lines are added on top.
  //
  // The schema summary is loaded for the database in scope so a question like
  // "analyse this database" has real table names to work with. When a table is
  // open, its columns are already in `contextColumns`, so the summary drops that
  // table to avoid sending the same definition twice.
  //
  // A table tab already knows its database, but a query tab or a freshly expanded
  // tree may not; `activeDatabase`/`activeSchema` come from the sidebar selection
  // and cover the case where the user has a database open without a table tab.
  const assistantContextScope = detailSelection ??
    assistantScopeResolved ?? {
      connectionId: activeId ?? undefined,
      database: treeActiveDatabase,
      schema: treeActiveSchema
    }
  const schemaSummary = useSchemaContext(
    assistantContextScope?.connectionId,
    activeEngine,
    assistantContextScope?.database,
    assistantContextScope?.schema,
    treeVersion
  )

  const rightPanelSchemaContext = (() => {
    if (!activeEngine) return undefined
    const scope = assistantContextScope
    const lines = [
      `Engine: ${activeEngine}`,
      scope?.database ? `Database: ${scope.database}` : '',
      scope?.schema ? `Schema: ${scope.schema}` : '',
      detailSelection ? `Table: ${detailSelection.table}` : ''
    ].filter(Boolean)
    if (contextColumns.length > 0) {
      lines.push(
        'Columns: ' +
          contextColumns
            .map((c) => `${c.name} ${c.dataType}${c.isPrimaryKey ? ' PK' : ''}`)
            .join(', ')
      )
    }
    if (inspectedRow) {
      lines.push(
        tr('app.selectedRow') +
          ' ' +
          Object.entries(inspectedRow.values)
            .map(([k, v]) => `${k}=${formatContextValue(v)}`)
            .join(', ')
      )
    }
    const base = lines.join('\n')
    if (!schemaSummary.context) return base
    // Drop the open table from the summary: its full column list is already in
    // the block above, and repeating it wastes prompt budget.
    const filtered = detailSelection
      ? schemaSummary.context
          .split('\n')
          .filter(
            (line) =>
              !line.startsWith(`- ${detailSelection.table}:`) &&
              !line.startsWith(`- ${detailSelection.table} [view]:`)
          )
          .join('\n')
      : schemaSummary.context
    // The summary repeats "Engine:" and "Database:" so it can stand alone; here
    // they are already in the header above, so only the table list is appended.
    const tableList = filtered
      .split('\n')
      .filter((line) => !/^(Engine|Database):/.test(line))
      .join('\n')
      .trim()
    return tableList ? `${base}\n\n${tableList}` : base
  })()

  // A clicked row belongs to one table; switching tabs must not keep showing a
  // record from another table in the detail pane.
  useEffect(() => {
    setInspectedRow(null)
  }, [activeTabId])

  // Selecting a tab also focuses its connection, so the sidebar highlight, the
  // menus, and the status bar all agree with what is on screen.
  useEffect(() => {
    if (activeTabConnectionId) setActiveId(activeTabConnectionId)
  }, [activeTabConnectionId])

  function refreshTree(): void {
    clearSchemaCache()
    setTreeVersion((v) => v + 1)
  }

  // Lightweight refresh for saved queries: does not reset tree expansion.
  function refreshQueries(): void {
    setQueryVersion((v) => v + 1)
  }

  async function executeDdl(
    connectionId: string,
    operation: Parameters<typeof window.dbApi.previewDdl>[1]
  ): Promise<boolean> {
    try {
      await unwrap(window.dbApi.executeDdl(connectionId, operation))
      refreshTree()
      return true
    } catch (err) {
      setError(errorText(err))
      return false
    }
  }

  function openCreateTable(database: string, schema?: string): void {
    if (!menuConnectionId) return
    const id = createTableKey(menuConnectionId, database, schema)
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [
            ...prev,
            {
              id,
              type: 'createTable',
              connectionId: menuConnectionId,
              database,
              schema
            }
          ]
    )
    setActiveTabId(id)
  }

  function openView(
    database: string,
    schema: string | undefined,
    viewName: string,
    engine: DbEngine
  ): void {
    if (!menuConnectionId) return
    const id = viewKey(menuConnectionId, database, schema, viewName)
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [
            ...prev,
            {
              id,
              type: 'view',
              connectionId: menuConnectionId,
              engine,
              database,
              schema,
              viewName
            }
          ]
    )
    setActiveTabId(id)
  }

  // Opens the read-only CREATE statement for a view, function, procedure,
  // trigger, or event in its own tab. Without this, a routine could only be
  // dropped from the tree and a view definition was buried in the designer.
  function openDefinition(target: {
    connectionId: string
    database: string
    schema?: string
    name: string
    kind: 'view' | RoutineKind
    signature?: string | null
  }): void {
    const id = `definition:${target.connectionId}:${target.database}:${target.schema ?? ''}:${target.kind}:${target.name}`
    setTabs((prev) => {
      if (prev.some((tab) => tab.id === id)) return prev
      return [...prev, { id, type: 'definition', ...target }]
    })
    setActiveTabId(id)
    setActiveId(target.connectionId)
  }

  // Opens the ER diagram for one database, optionally scoped to a schema.
  function openDiagram(database: string, schema?: string): void {
    const conn = connections.find((c) => c.id === menuConnectionId)
    if (!conn || !menuConnectionId) return
    const id = `diagram:${menuConnectionId}:${database}:${schema ?? ''}`
    setTabs((prev) =>
      prev.some((tab) => tab.id === id)
        ? prev
        : [
            ...prev,
            {
              id,
              type: 'diagram',
              connectionId: menuConnectionId,
              engine: conn.engine,
              database,
              schema
            }
          ]
    )
    setActiveTabId(id)
  }

  function openQueryFor(database?: string, schema?: string): void {
    if (!menuConnectionId) return
    openQueryForConnection(menuConnectionId, database, schema)
  }

  // The explicit connection matters when the caller just changed focus: reading
  // menuConnectionId in a timeout would still see the previous value.
  function openQueryForConnection(
    connectionId: string,
    database?: string,
    schema?: string
  ): void {
    const id = `query:${connectionId}`
    setTabs((prev) => {
      const existing = prev.find((t) => t.id === id)
      if (existing) {
        return prev.map((t) =>
          t.id === id && t.type === 'query'
            ? {
                ...t,
                initialDatabase: database ?? t.initialDatabase,
                initialSchema: schema ?? t.initialSchema,
                // The editor only re-applies the scope when a dependency
                // changes. A hand-edited selector keeps the same strings, so the
                // handoff bumps the token to force it back.
                ...(database || schema ? { initialToken: (t.initialToken ?? 0) + 1 } : {})
              }
            : t
        )
      }
      return [
        ...prev,
        {
          id,
          type: 'query',
          connectionId,
          initialDatabase: database,
          initialSchema: schema,
          initialToken: database || schema ? 1 : undefined
        }
      ]
    })
    setActiveTabId(id)
  }

  function buildConnectionMenuItems(conn: StoredConnection): MenuItem[] {
    const isOpen = openConnectionIds.has(conn.id)
    const isMongo = conn.engine === 'mongodb'
    return [
      {
        label: isOpen ? tr('menu.disconnect') : tr('menu.connect'),
        onSelect: () =>
          isOpen ? void handleDisconnect(conn.id) : void handleConnect(conn.id)
      },
      { label: tr('menu.editConnection'), onSelect: () => setEditing(conn) },
      {
        label: tr('menu.newDatabase'),
        separatorBefore: true,
        disabled: isMongo,
        onSelect: () =>
          setNamePrompt({
            title: tr('menu.newDatabase'),
            label: tr('prompt.databaseName'),
            confirmLabel: tr('prompt.create'),
            onConfirm: (name) => {
              setNamePrompt(null)
              void executeDdl(conn.id, { kind: 'createDatabase', database: name })
            }
          })
      },
      {
        label: tr('menu.browseObjects'),
        onSelect: () => {
          if (!isOpen) void handleConnect(conn.id)
          setActiveId(conn.id)
          setTimeout(() => openObjects(conn.database ?? 'postgres'), 0)
        }
      },
      {
        label: tr('menu.newQuery'),
        onSelect: () => {
          if (!isOpen) void handleConnect(conn.id)
          setActiveId(conn.id)
          const focus = treeFocus[conn.id]
          openQueryForConnection(conn.id, focus?.database ?? conn.database, focus?.schema)
        }
      },
      {
        label: tr('menu.executeSqlFile'),
        disabled: isMongo,
        onSelect: () => {
          void unwrap(window.dbApi.executeSqlFile(conn.id)).then((res) => {
            if (res) {
              setError(null)
              refreshTree()
              pushToast({
                kind: 'ok',
                title: tr('toast.sqlDone'),
                body: tr('toast.sqlDoneBody', { count: res.statements })
              })
            }
          })
        }
      },
      {
        label: tr('menu.exportDatabaseSql'),
        disabled: isMongo,
        onSelect: () =>
          setNamePrompt({
            title: tr('app.exportDatabase'),
            label: tr('prompt.databaseName'),
            confirmLabel: tr('prompt.export'),
            onConfirm: (database) => {
              setNamePrompt(null)
              void unwrap(window.dbApi.dumpDatabase(conn.id, database)).then((res) => {
                if (res) {
                  pushToast({
                    kind: 'ok',
                    title: tr('toast.exportDone'),
                    body: tr('toast.exportDoneBody', {
                      done: res.tablesDone,
                      total: res.tables,
                      rows: res.rowsWritten
                    })
                  })
                }
              })
            }
          })
      },
      { label: tr('menu.reload'), separatorBefore: true, onSelect: refreshTree },
      {
        label: tr('menu.deleteConnection'),
        danger: true,
        onSelect: () => {
          void confirmDestructive(
            tr('app.deleteConnectionMessage', { name: conn.name }),
            {
              title: tr('app.deleteConnectionTitle'),
              detail: tr('app.deleteConnectionDetail')
            }
          ).then((ok) => {
            if (ok) void handleDelete(conn.id)
          })
        }
      }
    ]
  }

  function buildDatabaseMenuItems(target: DatabaseTarget): MenuItem[] {
    const supportsSchema = target.engine === 'postgres'
    return [
      {
        label: tr('menu.browseObjects'),
        onSelect: () => {
          if (!openConnectionIds.has(target.connectionId)) {
            void handleConnect(target.connectionId).then(() =>
              openObjects(target.database, undefined, target.connectionId)
            )
          } else {
            setActiveId(target.connectionId)
            openObjects(target.database, undefined, target.connectionId)
          }
        }
      },
      {
        label: tr('menu.showDiagram'),
        onSelect: () => openDiagram(target.database)
      },
      {
        label: tr('menu.newQuery'),
        onSelect: () => openQueryFor(target.database)
      },
      {
        label: tr('menu.newSchema'),
        disabled: !supportsSchema,
        onSelect: () =>
          setNamePrompt({
            title: tr('app.newSchemaTitle'),
            label: tr('prompt.schemaName'),
            confirmLabel: tr('prompt.create'),
            onConfirm: (name) => {
              setNamePrompt(null)
              void executeDdl(target.connectionId, {
                kind: 'createSchema',
                database: target.database,
                schema: name
              })
            }
          })
      },
      {
        label: tr('menu.newTable'),
        separatorBefore: true,
        disabled: target.engine === 'mongodb',
        onSelect: () => openCreateTable(target.database)
      },
      {
        label: tr('menu.newView'),
        disabled: target.engine === 'mongodb',
        onSelect: () => openView(target.database, undefined, '', target.engine)
      },
      { label: tr('menu.reload'), onSelect: refreshTree },
      {
        label: tr('menu.dropDatabase'),
        danger: true,
        separatorBefore: true,
        onSelect: () =>
          setNamePrompt({
            title: `${tr('menu.dropDatabase')} "${target.database}"?`,
            label: tr('prompt.typeDatabase'),
            defaultValue: '',
            confirmLabel: tr('menu.dropDatabase'),
            onConfirm: (name) => {
              setNamePrompt(null)
              if (name !== target.database) {
                setError(tr('prompt.nameMismatch', { name: target.database }))
                return
              }
              void executeDdl(target.connectionId, {
                kind: 'dropDatabase',
                database: target.database
              }).then((ok) => {
                if (ok) {
                  closeTabsForDroppedTable(
                    target.connectionId,
                    target.database,
                    undefined
                  )
                }
              })
            }
          })
      }
    ]
  }

  function buildSchemaMenuItems(target: SchemaTarget): MenuItem[] {
    return [
      {
        label: tr('menu.browseObjects'),
        onSelect: () => {
          if (!openConnectionIds.has(target.connectionId)) {
            void handleConnect(target.connectionId).then(() =>
              openObjects(target.database, target.schema, target.connectionId)
            )
          } else {
            setActiveId(target.connectionId)
            openObjects(target.database, target.schema, target.connectionId)
          }
        }
      },
      {
        label: tr('menu.showDiagram'),
        onSelect: () => openDiagram(target.database, target.schema)
      },
      {
        label: tr('menu.newQuery'),
        onSelect: () => openQueryFor(target.database, target.schema)
      },
      {
        label: tr('menu.newTable'),
        onSelect: () => openCreateTable(target.database, target.schema)
      },
      {
        label: tr('menu.newView'),
        onSelect: () => openView(target.database, target.schema, '', target.engine)
      },
      { label: tr('menu.reload'), onSelect: refreshTree },
      {
        label: tr('menu.dropSchema'),
        danger: true,
        separatorBefore: true,
        onSelect: () =>
          setNamePrompt({
            title: `${tr('menu.dropSchema')} "${target.schema}"?`,
            label: tr('prompt.typeSchema'),
            defaultValue: '',
            confirmLabel: tr('menu.dropSchema'),
            onConfirm: (name) => {
              setNamePrompt(null)
              if (name !== target.schema) {
                setError(tr('prompt.nameMismatch', { name: target.schema }))
                return
              }
              void executeDdl(target.connectionId, {
                kind: 'dropSchema',
                database: target.database,
                schema: target.schema
              }).then((ok) => {
                if (ok) {
                  closeTabsForDroppedTable(
                    target.connectionId,
                    target.database,
                    target.schema
                  )
                }
              })
            }
          })
      }
    ]
  }

  function buildRoutineMenuItems(target: RoutineTarget): MenuItem[] {
    const r = target.routine
    const kindLabel =
      r.kind === 'function' ? 'function' : r.kind === 'procedure' ? 'procedure' : r.kind
    return [
      {
        label: tr('menu.showDefinition'),
        onSelect: () =>
          openDefinition({
            connectionId: target.connectionId,
            database: target.database,
            schema: target.schema,
            name: r.name,
            kind: r.kind,
            signature: r.signature ?? null
          })
      },
      {
        label: tr('menu.drop'),
        danger: true,
        onSelect: () => {
          void confirmDestructive(
            tr('app.dropRoutineMessage', { kind: kindLabel, name: r.name })
          ).then((ok) => {
            if (!ok) return
            void executeDdl(target.connectionId, {
              kind: 'dropRoutine',
              database: target.database,
              schema: target.schema,
              routine: r.name,
              routineKind: r.kind,
              signature: r.signature ?? null,
              onTable: r.kind === 'trigger' ? (r.detail ?? null) : null
            })
          })
        }
      }
    ]
  }

  function buildTableMenuItems(target: TableTarget): MenuItem[] {
    const isView = target.type === 'view'
    const open = (): void =>
      openTable({
        connectionId: target.connectionId,
        engine: target.engine,
        database: target.database,
        schema: target.schema,
        table: target.table
      })
    return [
      { label: tr('menu.open'), onSelect: open },
      ...(isView
        ? [
            {
              label: tr('menu.showDefinition'),
              onSelect: () =>
                openDefinition({
                  connectionId: target.connectionId,
                  database: target.database,
                  schema: target.schema,
                  name: target.table,
                  kind: 'view'
                })
            }
          ]
        : []),
      {
        label: isView ? tr('menu.designView') : tr('menu.design'),
        onSelect: () => {
          if (isView) {
            openView(target.database, target.schema, target.table, target.engine)
            return
          }
          open()
          setTimeout(() => {
            const id = tableKey({
              connectionId: target.connectionId,
              engine: target.engine,
              database: target.database,
              schema: target.schema,
              table: target.table
            })
            setTableView(id, 'struct')
          }, 0)
        }
      },
      {
        label: tr('menu.newTable'),
        separatorBefore: true,
        disabled: isView,
        onSelect: () => openCreateTable(target.database, target.schema)
      },
      {
        label: tr('menu.emptyTable'),
        disabled: isView,
        onSelect: () => {
          void confirmDestructive(tr('app.emptyTableMessage', { table: target.table }), {
            title: tr('app.emptyTableTitle'),
            detail: tr('app.emptyTableDetail')
          }).then((ok) => {
            if (!ok) return
            void executeDdl(target.connectionId, {
              kind: 'emptyTable',
              database: target.database,
              schema: target.schema,
              table: target.table
            })
          })
        }
      },
      {
        label: tr('menu.truncateTable'),
        disabled: isView,
        onSelect: () => {
          void confirmDestructive(
            tr('app.truncateTableMessage', { table: target.table }),
            {
              title: tr('app.truncateTableTitle'),
              detail: tr('app.truncateTableDetail')
            }
          ).then((ok) => {
            if (!ok) return
            void executeDdl(target.connectionId, {
              kind: 'truncateTable',
              database: target.database,
              schema: target.schema,
              table: target.table
            })
          })
        }
      },
      {
        label: tr('menu.renameTable'),
        disabled: isView,
        onSelect: () =>
          setNamePrompt({
            title: tr('menu.renameTable'),
            label: tr('prompt.newName'),
            defaultValue: target.table,
            confirmLabel: tr('menu.renameTable'),
            onConfirm: (newName) => {
              setNamePrompt(null)
              if (newName === target.table) return
              void executeDdl(target.connectionId, {
                kind: 'renameTable',
                database: target.database,
                schema: target.schema,
                table: target.table,
                newName
              })
            }
          })
      },
      {
        label: tr('menu.exportTable'),
        separatorBefore: true,
        onSelect: () => {
          open()
          setTimeout(() => {
            const id = tableKey({
              connectionId: target.connectionId,
              engine: target.engine,
              database: target.database,
              schema: target.schema,
              table: target.table
            })
            setTableView(id, 'io')
          }, 0)
        }
      },
      {
        label: isView ? tr('menu.dropView') : tr('menu.dropTable'),
        danger: true,
        separatorBefore: true,
        onSelect: () =>
          setNamePrompt({
            title: `${isView ? tr('menu.dropView') : tr('menu.dropTable')} "${target.table}"?`,
            label: isView ? tr('prompt.typeView') : tr('prompt.typeTable'),
            defaultValue: '',
            confirmLabel: isView ? tr('menu.dropView') : tr('menu.dropTable'),
            onConfirm: (name) => {
              setNamePrompt(null)
              if (name !== target.table) {
                setError(tr('prompt.nameMismatch', { name: target.table }))
                return
              }
              void executeDdl(
                target.connectionId,
                isView
                  ? {
                      kind: 'dropView',
                      database: target.database,
                      schema: target.schema,
                      view: target.table
                    }
                  : {
                      kind: 'dropTable',
                      database: target.database,
                      schema: target.schema,
                      table: target.table
                    }
              ).then((ok) => {
                if (ok) {
                  closeTabsForDroppedTable(
                    target.connectionId,
                    target.database,
                    target.schema,
                    target.table
                  )
                }
              })
            }
          })
      }
    ]
  }

  // Keep the active tab visible. Opening a table from the tree appends a tab at
  // the far right, and with enough tabs open that tab starts off-screen, so the
  // user had to scroll the strip before they could see what had just opened.
  // `inline: 'nearest'` scrolls only when needed, so clicking a tab that is
  // already visible does not jump the strip.
  useEffect(() => {
    if (!activeTabId) return
    const strip = tabStripRef.current
    if (!strip) return
    const active = strip.querySelector<HTMLElement>('.tab.is-active')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId, tabs.length])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setConnections(await unwrap(window.dbApi.listConnections()))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  function openTable(sel: SelectedTable): void {
    const id = tableKey(sel)
    setTabs((prev) => {
      if (prev.some((t) => t.id === id)) return prev
      return [...prev, { id, type: 'table', selection: sel, view: 'data' }]
    })
    setActiveTabId(id)
  }

  function setTableView(id: string, view: TableView): void {
    setTabs((prev) =>
      prev.map((t) => (t.id === id && t.type === 'table' ? { ...t, view } : t))
    )
  }

  // One query tab per connection. Opening a query while another server is
  // focused must not steal the tab that belongs to the first one.
  function openQuery(): void {
    if (!menuConnectionId) return
    // Follow the context the user is looking at. A table/objects/diagram tab
    // names its database, and a query tab keeps the tree focus in sync with its
    // toolbar, so the tree is the freshest signal for a query tab: clicking
    // another database and then "+" must move the editor there.
    const tabScopeHere = activeTabConnectionId === menuConnectionId ? activeScope : null
    const focus = treeFocus[menuConnectionId]
    const connection = connections.find((c) => c.id === menuConnectionId)
    const database =
      activeTab?.type === 'query'
        ? (focus?.database ?? tabScopeHere?.database ?? connection?.database)
        : (tabScopeHere?.database ?? focus?.database ?? connection?.database)
    const schema =
      activeTab?.type === 'query'
        ? (focus?.schema ?? tabScopeHere?.schema)
        : (tabScopeHere?.schema ?? focus?.schema)
    openQueryForConnection(menuConnectionId, database, schema)
    setActiveId(menuConnectionId)
  }

  // SQL from the assistant carries the scope it was written for. Opening the
  // first query tab regardless of connection was wrong: the user was looking at
  // "post" in PostgreSQL but the SQL landed in a tab pointed at whatever the
  // server default happened to be.
  function insertAssistantSql(
    sql: string,
    scope: { connectionId?: string; database?: string; schema?: string }
  ): void {
    const targetConnectionId = scope.connectionId ?? menuConnectionId
    if (!targetConnectionId) return
    const id = `query:${targetConnectionId}`
    const database = scope.database
    const schema = scope.schema
    setTabs((prev) => {
      const existing = prev.find((tab) => tab.id === id)
      if (existing) {
        return prev.map((tab) =>
          tab.id === id && tab.type === 'query'
            ? {
                ...tab,
                initialSql: sql,
                // The editor applies these when they change, so the database and
                // schema selectors follow the SQL instead of staying on defaults.
                initialDatabase: database ?? tab.initialDatabase,
                initialSchema: schema ?? tab.initialSchema,
                initialToken: (tab.initialToken ?? 0) + 1
              }
            : tab
        )
      }
      return [
        ...prev,
        {
          id,
          type: 'query',
          connectionId: targetConnectionId,
          initialSql: sql,
          initialDatabase: database,
          initialSchema: schema,
          initialToken: 1
        }
      ]
    })
    setActiveTabId(id)
    setActiveId(targetConnectionId)
  }

  function openSavedQuery(query: SavedQuery): void {
    const id = `saved:${query.id}`
    setTabs((prev) => {
      if (prev.some((t) => t.id === id)) return prev
      return [
        ...prev,
        {
          id,
          type: 'query',
          connectionId: query.connectionId,
          savedId: query.id,
          savedName: query.name,
          initialSql: query.sql,
          initialDatabase: query.database,
          initialSchema: query.schema
        }
      ]
    })
    setActiveTabId(id)
  }

  function renameSavedQuery(query: SavedQuery, name: string): void {
    if (!name.trim() || name === query.name) {
      setRenamingQuery(null)
      return
    }
    setRenamingQuery(null)
    void unwrap(
      window.dbApi.saveQuery({
        id: query.id,
        connectionId: query.connectionId,
        database: query.database,
        schema: query.schema,
        name: name.trim(),
        sql: query.sql
      })
    ).then(() => refreshQueries())
  }

  function deleteSavedQuery(query: SavedQuery): void {
    void confirmDestructive(tr('app.deleteQueryMessage', { name: query.name }), {
      title: tr('app.deleteQueryTitle'),
      detail: tr('app.deleteQueryDetail')
    }).then((ok) => {
      if (!ok) return
      void unwrap(window.dbApi.deleteSavedQuery(query.id)).then(() => {
        closeTab(`saved:${query.id}`)
        refreshQueries()
      })
    })
  }

  function exportSavedQuery(query: SavedQuery): void {
    void unwrap(window.dbApi.exportSavedQuery(query.id))
  }

  function importSavedQuery(): void {
    if (!menuConnectionId) return
    void unwrap(window.dbApi.importSavedQuery(menuConnectionId)).then((imported) => {
      if (imported) refreshQueries()
    })
  }

  function buildQueryMenuItems(query: SavedQuery): MenuItem[] {
    return [
      { label: tr('menu.open'), onSelect: () => openSavedQuery(query) },
      { label: tr('menu.renameQuery'), onSelect: () => setRenamingQuery(query) },
      { label: tr('menu.exportQuerySql'), onSelect: () => exportSavedQuery(query) },
      {
        label: tr('menu.delete'),
        danger: true,
        separatorBefore: true,
        onSelect: () => deleteSavedQuery(query)
      }
    ]
  }

  function openUsers(): void {
    if (!menuConnectionId) return
    const id = `users:${menuConnectionId}`
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [...prev, { id, type: 'users', connectionId: menuConnectionId }]
    )
    setActiveTabId(id)
  }

  function openBackup(): void {
    if (!menuConnectionId) return
    const id = `backup:${menuConnectionId}`
    const database =
      activeSelection?.connectionId === menuConnectionId
        ? activeSelection.database
        : undefined
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [...prev, { id, type: 'backup', connectionId: menuConnectionId, database }]
    )
    setActiveTabId(id)
  }

  function openTransfer(): void {
    if (!menuConnectionId) return
    const id = `transfer:${menuConnectionId}`
    const selection =
      activeSelection?.connectionId === menuConnectionId ? activeSelection : undefined
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [
            ...prev,
            {
              id,
              type: 'transfer',
              connectionId: menuConnectionId,
              database: selection?.database,
              schema: selection?.schema,
              table: selection?.table
            }
          ]
    )
    setActiveTabId(id)
  }

  function openSync(): void {
    if (!menuConnectionId) return
    const id = `sync:${menuConnectionId}`
    const selection =
      activeSelection?.connectionId === menuConnectionId ? activeSelection : undefined
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [
            ...prev,
            {
              id,
              type: 'sync',
              connectionId: menuConnectionId,
              database: selection?.database,
              schema: selection?.schema
            }
          ]
    )
    setActiveTabId(id)
  }

  // Opens the object browser for the current database, falling back to the
  // connection's default when nothing is selected yet.
  // Diagram needs a concrete database; reuse the same fallback as the object
  // browser so the button works before any table is selected.
  async function openDiagramForActive(): Promise<void> {
    if (!menuConnectionId) return
    const conn = connections.find((c) => c.id === menuConnectionId)
    if (!conn) return
    let database = activeSelection?.database ?? conn.database
    if (!database) {
      try {
        const found = await unwrap(window.dbApi.listDatabases(menuConnectionId))
        database = pickDefaultDatabase(found)
      } catch (err) {
        setError(errorText(err))
        return
      }
    }
    if (!database) {
      setError(tr('app.noDatabaseToDraw'))
      return
    }
    openDiagram(database, activeSelection?.schema)
  }

  async function openTableBrowser(): Promise<void> {
    if (!menuConnectionId) return
    const conn = connections.find((c) => c.id === menuConnectionId)
    if (!conn) return
    let database = activeSelection?.database ?? conn.database
    if (!database) {
      try {
        const found = await unwrap(window.dbApi.listDatabases(menuConnectionId))
        database = pickDefaultDatabase(found)
      } catch (err) {
        setError(errorText(err))
        return
      }
    }
    if (!database) {
      setError(tr('app.noDatabaseToBrowse'))
      return
    }
    openObjects(database, activeSelection?.schema)
  }

  async function openBuilder(): Promise<void> {
    if (!menuConnectionId) return
    const conn = connections.find((c) => c.id === menuConnectionId)
    if (!conn) return
    let database = activeSelection?.database ?? conn.database
    if (!database) {
      // A connection may have no default database; pick the first one the
      // server reports instead of failing with an empty canvas.
      try {
        const found = await unwrap(window.dbApi.listDatabases(menuConnectionId))
        database = pickDefaultDatabase(found)
      } catch (err) {
        setError(errorText(err))
        return
      }
    }
    if (!database) {
      setError(tr('app.noDatabaseToOpen'))
      return
    }
    const schema =
      activeSelection?.connectionId === menuConnectionId
        ? activeSelection.schema
        : undefined
    const id = `builder:${menuConnectionId}:${database}:${schema ?? ''}`
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [
            ...prev,
            {
              id,
              type: 'builder',
              connectionId: menuConnectionId,
              engine: conn.engine,
              database,
              schema
            }
          ]
    )
    setActiveTabId(id)
  }

  function openSessions(): void {
    if (!menuConnectionId) return
    // Use the database of the active table tab when there is one, so the list
    // starts scoped to what the user is working on.
    const id = `sessions:${menuConnectionId}`
    const database =
      activeSelection?.connectionId === menuConnectionId
        ? activeSelection.database
        : undefined
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [...prev, { id, type: 'sessions', connectionId: menuConnectionId, database }]
    )
    setActiveTabId(id)
  }

  // Navicat-style object browser for one database (optionally one schema).
  function openObjects(database: string, schema?: string, connectionId?: string): void {
    const targetId = connectionId ?? menuConnectionId
    if (!targetId) return
    const conn = connections.find((c) => c.id === targetId)
    if (!conn) return
    const id = `objects:${targetId}:${database}:${schema ?? ''}`
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [
            ...prev,
            {
              id,
              type: 'objects',
              connectionId: targetId,
              engine: conn.engine,
              connectionName: conn.name,
              database,
              schema
            }
          ]
    )
    setActiveTabId(id)
  }

  function applyTabChange(next: Tab[]): void {
    setTabs(next)
    setActiveTabId((current) =>
      current && next.some((t) => t.id === current)
        ? current
        : next.length > 0
          ? next[next.length - 1].id
          : null
    )
  }

  // Closing used to discard typed SQL without asking. The close now stops at
  // the first query tab with unsaved text and lets the user save, discard, or
  // cancel; tabs without edits still close immediately.
  async function requestClose(
    predicate: (tab: Tab, index: number) => boolean
  ): Promise<void> {
    const doomed = tabs.filter((tab, i) => predicate(tab, i))
    if (doomed.length === 0) return
    // An open transaction is more dangerous than unsaved text: closing would
    // roll back work the user may believe is saved. Ask before anything else.
    const withTx = doomed.find((tab) => openTransactions.has(tab.id))
    if (withTx) {
      const editor = queryEditors.current.get(withTx.id)
      const choice = await confirmAction({
        title: tr('query.txCloseTitle'),
        message: tr('query.txCloseMessage', {
          count: editor?.transactionStatementCount() ?? 0
        }),
        actions: [
          { label: tr('query.txCommit'), primary: true },
          { label: tr('query.txRollback'), danger: true },
          { label: tr('common.cancel') }
        ]
      })
      // "Batal" is one of the actions, not the dialog's own close button, so it
      // arrives as a normal choice. Without this check it fell through to the
      // else branch and rolled back, which is the opposite of cancelling.
      if (!choice || choice.label === tr('common.cancel')) return
      if (choice.label === tr('query.txCommit')) {
        await editor?.commitTransaction()
      } else {
        await editor?.rollbackTransaction()
      }
      // The editor reports the new state; if it is still open (the commit
      // failed), do not close the tab and lose the reason.
      if (editor?.hasOpenTransaction()) return
    }
    const dirty = doomed.find((tab) => {
      if (tab.type !== 'query') return false
      return queryEditors.current.get(tab.id)?.hasDirty() ?? false
    })
    if (dirty) {
      setPendingClose({ tabIds: doomed.map((t) => t.id), dirtyTabId: dirty.id })
      return
    }
    applyTabChange(tabs.filter((tab) => !doomed.some((d) => d.id === tab.id)))
  }

  function closeTab(id: string): void {
    void requestClose((t) => t.id === id)
  }

  function closeTabs(predicate: (tab: Tab, index: number) => boolean): void {
    void requestClose(predicate)
  }

  function finishPendingClose(): void {
    if (!pendingClose) return
    const ids = new Set(pendingClose.tabIds)
    setPendingClose(null)
    applyTabChange(tabs.filter((tab) => !ids.has(tab.id)))
  }

  async function savePendingClose(): Promise<void> {
    if (!pendingClose) return
    const editor = queryEditors.current.get(pendingClose.dirtyTabId)
    const saved = (await editor?.saveDirty()) ?? false
    if (!saved) {
      // The tab has no saved query yet, so it needs a name. Select it and open
      // the editor's own save dialog instead of inventing a name.
      setActiveTabId(pendingClose.dirtyTabId)
      setPendingClose(null)
      pushToast({
        kind: 'info',
        title: tr('toast.nameQueryFirst'),
        body: tr('toast.nameQueryFirstBody')
      })
      return
    }
    finishPendingClose()
  }

  // Quitting with an open transaction would roll it back on the server without a
  // word. Electron cannot show an in-app dialog during teardown, so the browser's
  // own confirm is the only hook that can cancel the close; it is used only when
  // there is something to lose.
  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent): void {
      const open = openTransactions.size
      const dirtyQuery = tabs.some(
        (tab) =>
          tab.type === 'query' && (queryEditors.current.get(tab.id)?.hasDirty() ?? false)
      )
      if (open === 0 && !(settings.general.confirmOnClose && dirtyQuery)) return
      // A non-empty returnValue is what makes Chromium ask. The text itself is
      // ignored by every current browser, so it only has to exist.
      event.preventDefault()
      event.returnValue = tr(open > 0 ? 'query.txQuitMessage' : 'app.confirmCloseMessage')
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [openTransactions, settings.general.confirmOnClose, tabs, tr])

  // A dropped table (or a dropped schema, which removes all its tables) must
  // not leave a stale data/struct/io tab pointed at an object that is gone.
  function closeTabsForDroppedTable(
    connectionId: string,
    database: string,
    schema: string | undefined,
    table?: string
  ): void {
    closeTabs((tab) => {
      if (tab.type === 'table') {
        const sel = tab.selection
        if (sel.connectionId !== connectionId) return false
        if (sel.database !== database) return false
        if ((sel.schema ?? undefined) !== (schema ?? undefined)) return false
        if (table !== undefined && sel.table !== table) return false
        return true
      }
      if (tab.type === 'view') {
        if (tab.connectionId !== connectionId) return false
        if (tab.database !== database) return false
        if ((tab.schema ?? undefined) !== (schema ?? undefined)) return false
        if (table !== undefined && tab.viewName !== table) return false
        return true
      }
      return false
    })
  }

  function buildTabMenuItems(tabId: string): MenuItem[] {
    const index = tabs.findIndex((t) => t.id === tabId)
    return [
      {
        label: tr('menu.closeTab'),
        onSelect: () => closeTab(tabId)
      },
      {
        label: tr('menu.closeOthers'),
        disabled: tabs.length <= 1,
        onSelect: () => closeTabs((t) => t.id !== tabId)
      },
      {
        label: tr('menu.closeRight'),
        disabled: index < 0 || index >= tabs.length - 1,
        onSelect: () => closeTabs((_t, i) => i > index)
      },
      {
        label: tr('menu.closeAllTabs'),
        separatorBefore: true,
        onSelect: () => closeTabs(() => true)
      }
    ]
  }

  // Navicat migration. Import asks for a file and opens the preview; nothing is
  // written until the user confirms the rows in that dialog.
  async function importConnections(): Promise<void> {
    try {
      const chosen = await unwrap(
        window.dbApi.openFileDialog([{ name: 'Navicat', extensions: ['ncx'] }])
      )
      if (!chosen) return
      setNcxPath(chosen)
    } catch (err) {
      pushToast({ kind: 'error', title: tr('ncx.title'), body: errorText(err) })
    }
  }

  async function exportConnections(): Promise<void> {
    if (connections.length === 0) {
      pushToast({
        kind: 'info',
        title: tr('ncx.exportTitle'),
        body: tr('ncx.noConnections')
      })
      return
    }
    try {
      const result = await unwrap(window.dbApi.exportNcx(connections.map((c) => c.id)))
      if (!result) {
        pushToast({
          kind: 'info',
          title: tr('ncx.exportTitle'),
          body: tr('ncx.exportCancelled')
        })
        return
      }
      pushToast({
        kind: 'ok',
        title: tr('ncx.exportTitle'),
        body: tr('ncx.exportDone', { count: result.count, path: result.path })
      })
    } catch (err) {
      pushToast({ kind: 'error', title: tr('ncx.exportTitle'), body: errorText(err) })
    }
  }

  // Shell shortcuts come from the keymap, so rebinding one in Settings takes
  // effect here without touching this effect. Monaco keeps its own keys.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const action = (id: ActionId): boolean => {
        const binding = bindingFor(settings.keymap, id)
        return binding ? matchesBinding(e, binding) : false
      }

      if (action('settings.open')) {
        e.preventDefault()
        setSettingsOpen(true)
        return
      }
      if (action('tab.close') && activeTabId) {
        e.preventDefault()
        closeTab(activeTabId)
        return
      }
      if (action('sidebar.filter')) {
        // One field for every open connection. Captured before the webview's own
        // find, which has nothing to search in a canvas-based tree.
        e.preventDefault()
        setFilterOpen(true)
        requestAnimationFrame(() => filterInputRef.current?.select())
        return
      }
      if (action('query.newTab')) {
        e.preventDefault()
        openQuery()
        return
      }
      if (action('open.users') && supportsUsers) {
        e.preventDefault()
        openUsers()
        return
      }
      if (action('open.sessions') && menuConnectionId && activeEngine !== 'sqlite') {
        e.preventDefault()
        openSessions()
        return
      }
      if (activeTab?.type === 'table') {
        if (action('view.data')) {
          e.preventDefault()
          setTableView(activeTab.id, 'data')
          return
        }
        if (action('view.structure')) {
          e.preventDefault()
          setTableView(activeTab.id, 'struct')
          return
        }
        if (action('view.io')) {
          e.preventDefault()
          setTableView(activeTab.id, 'io')
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    activeTabId,
    activeTab,
    menuConnectionId,
    supportsUsers,
    tabs,
    activeEngine,
    settings.keymap
  ])

  // A new release is announced once per session with a toast that opens the
  // Settings dialog. Auto-download is off, so the user decides when to install.
  const announcedUpdate = useRef<string | null>(null)
  useEffect(() => {
    return window.dbApi.onUpdateState((state) => {
      if (!state || state.phase !== 'available' || !state.version) return
      if (announcedUpdate.current === state.version) return
      announcedUpdate.current = state.version
      pushToast({
        kind: 'info',
        title: tr('toast.updateAvailable', { version: state.version }),
        body: tr('toast.updateAvailableBody'),
        action: {
          label: tr('settings.open'),
          onClick: () => {
            setSettingsSection('about')
            setSettingsOpen(true)
          }
        },
        timeoutMs: 12000
      })
    })
  }, [pushToast, tr])

  // The native menu lives in main, which does not bundle the locale catalogue.
  // Send the translated labels whenever the language changes.
  useEffect(() => {
    const keys = [
      'appMenu.about',
      'appMenu.selectAll',
      'appMenu.settings',
      'appMenu.checkUpdates',
      'appMenu.file',
      'appMenu.edit',
      'appMenu.view',
      'appMenu.tools',
      'appMenu.window',
      'appMenu.newConnection',
      'appMenu.importConnections',
      'appMenu.exportConnections',
      'appMenu.newGroup',
      'appMenu.newQuery',
      'appMenu.importQuery',
      'appMenu.queryHistory',
      'appMenu.findObjects',
      'appMenu.browseTables',
      'appMenu.diagram',
      'appMenu.assistantPanel',
      'appMenu.reloadTree',
      'appMenu.transfer',
      'appMenu.sync',
      'appMenu.backup',
      'appMenu.sessions',
      'appMenu.users'
    ] as const
    const labels: Record<string, string> = {}
    for (const key of keys) labels[key] = tr(key)
    void window.dbApi.setMenuLabels(labels).catch(() => undefined)
  }, [tr])

  // Report which menu items are usable.  // Report which menu items are usable. Recomputed from the same values the
  // toolbar uses to disable its own buttons, so the two never disagree.
  useEffect(() => {
    void window.dbApi.setMenuState({
      hasConnection: Boolean(menuConnectionId),
      sqlEngine: Boolean(menuConnectionId) && !isDocument,
      supportsUsers,
      supportsSessions: Boolean(menuConnectionId) && activeEngine !== 'sqlite'
    })
  }, [menuConnectionId, isDocument, supportsUsers, activeEngine])

  // The native menu runs in main, so it sends commands here. Every branch maps
  // to a function the toolbar or a shortcut already uses; the menu is a second
  // entry point, not a second implementation.
  useEffect(() => {
    return window.dbApi.onMenuAction((action: MenuAction) => {
      switch (action) {
        case 'connection.new':
          setEditing('new')
          break
        case 'connection.import':
          void importConnections()
          break
        case 'connection.export':
          void exportConnections()
          break
        case 'group.new':
          setGroupPrompt({ mode: 'create' })
          break
        case 'query.new':
          openQuery()
          break
        case 'query.import':
          importSavedQuery()
          break
        case 'query.history': {
          const editor = activeTabId ? queryEditors.current.get(activeTabId) : undefined
          if (editor) editor.openHistory()
          else openQuery()
          break
        }
        case 'table.browse':
          void openTableBrowser()
          break
        case 'diagram.open':
          void openDiagramForActive()
          break
        case 'transfer.open':
          openTransfer()
          break
        case 'sync.open':
          openSync()
          break
        case 'backup.open':
          openBackup()
          break
        case 'sessions.open':
          openSessions()
          break
        case 'users.open':
          openUsers()
          break
        case 'assistant.toggle':
          setRightPanelTab('assistant')
          setRightPanelOpen((open) => !open)
          break
        case 'sidebar.filter':
          setFilterOpen(true)
          requestAnimationFrame(() => filterInputRef.current?.select())
          break
        case 'edit.selectAll': {
          // The page itself is not a document (body is user-select: none), so
          // Select All belongs to the focused field or the SQL editor. Doing
          // nothing anywhere else keeps the chrome from turning into a block of
          // highlighted text.
          const el = document.activeElement
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.select()
          } else if (el instanceof HTMLElement && el.closest('.monaco-editor')) {
            const editor = activeTabId ? queryEditors.current.get(activeTabId) : undefined
            editor?.selectAll()
          }
          break
        }
        case 'about.open':
          setSettingsSection('about')
          setSettingsOpen(true)
          break
        case 'settings.open':
          setSettingsSection('general')
          setSettingsOpen(true)
          break
        case 'update.check':
          // The About pane owns the buttons, so the menu opens it and lets the
          // check run there instead of duplicating the state machine.
          setSettingsSection('about')
          setSettingsOpen(true)
          void window.dbApi.checkForUpdates().catch(() => undefined)
          break
        case 'app.reloadTree':
          refreshTree()
          break
      }
    })
  }, [
    activeTabId,
    importConnections,
    exportConnections,
    importSavedQuery,
    openQuery,
    openTableBrowser,
    openDiagramForActive,
    openTransfer,
    openSync,
    openBackup,
    openSessions,
    openUsers,
    refreshTree
  ])

  async function handleConnect(id: string): Promise<void> {
    setError(null)
    const conn = connections.find((c) => c.id === id)
    const label = conn?.name ?? tr('app.connectionFallback')
    setConnectingIds((prev) => new Set(prev).add(id))
    try {
      await unwrap(window.dbApi.connect(id))
      clearSchemaCache()
      setOpenConnectionIds((prev) => new Set(prev).add(id))
      setConnectionErrors((prev) => {
        if (!prev.has(id)) return prev
        const next = new Map(prev)
        next.delete(id)
        return next
      })
      setActiveId(id)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const failure = describeConnectionError(raw, conn?.engine, tr)
      setConnectionErrors((prev) => new Map(prev).set(id, failure.title))
      // A changed SSH host key is the one failure the user can resolve without
      // editing the connection: confirm the new fingerprint and reconnect.
      if (err instanceof ApiError && err.code === 'SSH_HOST_CHANGED') {
        pushToast({
          kind: 'error',
          title: `${label}: host key SSH berubah`,
          body: tr('app.hostKeyChangedBody'),
          detail: raw,
          action: {
            label: tr('action.trustKey'),
            onClick: () => {
              void (async () => {
                try {
                  await unwrap(window.dbApi.trustSshHost(id))
                  await handleConnect(id)
                } catch (trustErr) {
                  pushToast({
                    kind: 'error',
                    title: tr('app.trustKeyFailed', { label }),
                    body: trustErr instanceof Error ? trustErr.message : String(trustErr)
                  })
                }
              })()
            }
          }
        })
        return
      }
      pushToast({
        kind: 'error',
        title: `${label}: ${failure.title}`,
        body: failure.hint,
        // The raw driver text is only repeated when it adds information the
        // translated hint does not already contain.
        detail:
          raw && raw !== failure.hint && !failure.hint.includes(raw) ? raw : undefined,
        action: failure.retryable
          ? { label: tr('action.retry'), onClick: () => void handleConnect(id) }
          : conn
            ? { label: tr('action.editConnection'), onClick: () => setEditing(conn) }
            : undefined
      })
    } finally {
      setConnectingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  function dropTabsForConnection(id: string): void {
    setTabs((prev) => {
      const next = prev.filter((t) => {
        const connId = t.type === 'table' ? t.selection.connectionId : t.connectionId
        return connId !== id
      })
      setActiveTabId((current) =>
        current && next.some((t) => t.id === current)
          ? current
          : next.length > 0
            ? next[next.length - 1].id
            : null
      )
      return next
    })
  }

  async function handleDisconnect(id: string): Promise<void> {
    // An open transaction would be rolled back by the server on disconnect. Say
    // so before it happens instead of letting the changes vanish.
    const openHere = tabs.filter(
      (tab) =>
        tab.type === 'query' && tab.connectionId === id && openTransactions.has(tab.id)
    )
    if (openHere.length > 0) {
      const choice = await confirmAction({
        title: tr('query.txDisconnectTitle'),
        message: tr('query.txDisconnectMessage'),
        actions: [
          { label: tr('query.txCommit'), primary: true },
          { label: tr('query.txRollback'), danger: true },
          { label: tr('common.cancel') }
        ]
      })
      if (!choice || choice.label === tr('common.cancel')) return
      for (const tab of openHere) {
        const editor = queryEditors.current.get(tab.id)
        if (!editor) continue
        if (choice.label === tr('query.txCommit')) await editor.commitTransaction()
        else await editor.rollbackTransaction()
        if (editor.hasOpenTransaction()) return
      }
    }
    await unwrap(window.dbApi.disconnect(id))
    setOpenConnectionIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setConnectionErrors((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
    // Focus moves to another live connection so the menus stay usable instead
    // of pointing at a connection that no longer exists.
    setActiveId((current) => {
      if (current !== id) return current
      const remaining = [...openConnectionIds].filter((c) => c !== id)
      return remaining[remaining.length - 1] ?? null
    })
    dropTabsForConnection(id)
  }

  async function handleDelete(id: string): Promise<void> {
    await unwrap(window.dbApi.deleteConnection(id))
    setOpenConnectionIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setConnectionErrors((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
    setActiveId((current) => {
      if (current !== id) return current
      const remaining = [...openConnectionIds].filter((c) => c !== id)
      return remaining[remaining.length - 1] ?? null
    })
    dropTabsForConnection(id)
    await reload()
  }

  function renderTabContent(tab: Tab): JSX.Element {
    if (tab.type === 'query') {
      const engine =
        connections.find((c) => c.id === tab.connectionId)?.engine ?? 'sqlite'
      return (
        <QueryEditor
          ref={(handle) => {
            if (handle) queryEditors.current.set(tab.id, handle)
            else queryEditors.current.delete(tab.id)
          }}
          connectionId={tab.connectionId}
          engine={engine}
          theme={theme}
          savedId={tab.savedId}
          savedName={tab.savedName}
          initialSql={tab.initialSql}
          initialDatabase={tab.initialDatabase}
          initialSchema={tab.initialSchema}
          initialToken={tab.initialToken}
          onSaved={refreshQueries}
          onOpenSettings={() => {
            setSettingsSection('ai')
            setSettingsOpen(true)
          }}
          isVisible={tab.id === activeTabId}
          onContextChange={({ database, schema }) => {
            if (activeTabIdRef.current !== tab.id) return
            setAssistantScope({ connectionId: tab.connectionId, database, schema })
          }}
          onTransactionNotice={(message) => {
            pushToast({ kind: 'ok', title: message })
          }}
          onTransactionChange={(open) => {
            setOpenTransactions((prev) => {
              if (open === prev.has(tab.id)) return prev
              const next = new Set(prev)
              if (open) next.add(tab.id)
              else next.delete(tab.id)
              return next
            })
          }}
          onRan={(sql) => {
            // A CREATE/ALTER/DROP makes both the tree and the assistant's
            // @mention list stale. Refreshing only on a schema change keeps a
            // plain SELECT from reloading every open tree.
            if (changesSchema(sql)) refreshTree()
          }}
        />
      )
    }
    if (tab.type === 'users') {
      return <UsersPanel connectionId={tab.connectionId} engine={activeEngine ?? ''} />
    }
    if (tab.type === 'backup') {
      const conn = connections.find((c) => c.id === tab.connectionId)
      return (
        <BackupPanel
          connectionId={tab.connectionId}
          database={tab.database}
          connectionName={conn?.name}
        />
      )
    }
    if (tab.type === 'builder') {
      return (
        <QueryBuilderPanel
          connectionId={tab.connectionId}
          engine={tab.engine}
          database={tab.database}
          schema={tab.schema}
          onOpenSql={(sql) => {
            const queryId = `query:${tab.connectionId}`
            setTabs((prev) => {
              if (prev.some((t) => t.id === queryId)) {
                return prev.map((t) =>
                  t.id === queryId && t.type === 'query'
                    ? {
                        ...t,
                        initialSql: sql,
                        initialDatabase: tab.database,
                        initialSchema: tab.schema
                      }
                    : t
                )
              }
              return [
                ...prev,
                {
                  id: queryId,
                  type: 'query',
                  connectionId: tab.connectionId,
                  initialSql: sql,
                  initialDatabase: tab.database,
                  initialSchema: tab.schema
                }
              ]
            })
            setActiveTabId(queryId)
          }}
        />
      )
    }
    if (tab.type === 'transfer') {
      return (
        <TransferPanel
          connections={connections}
          initialSource={{
            connectionId: tab.connectionId,
            database: tab.database ?? '',
            schema: tab.schema,
            table: tab.table ?? ''
          }}
          onClose={() => closeTab(tab.id)}
        />
      )
    }
    if (tab.type === 'sync') {
      return (
        <SyncPanel
          connections={connections}
          initialSource={{
            connectionId: tab.connectionId,
            database: tab.database,
            schema: tab.schema
          }}
          onClose={() => closeTab(tab.id)}
        />
      )
    }
    if (tab.type === 'sessions') {
      const engine =
        connections.find((c) => c.id === tab.connectionId)?.engine ?? 'sqlite'
      return (
        <SessionsPanel
          connectionId={tab.connectionId}
          engine={engine}
          database={tab.database}
        />
      )
    }
    if (tab.type === 'objects') {
      return (
        <ObjectsPanel
          connectionId={tab.connectionId}
          engine={tab.engine}
          connectionName={tab.connectionName}
          database={tab.database}
          schema={tab.schema}
          onSelectTable={(sel) => {
            openTable({
              connectionId: sel.connectionId,
              engine: sel.engine,
              database: sel.database,
              schema: sel.schema,
              table: sel.table
            })
          }}
          onOpenQuery={(database, schema) => {
            if (tab.connectionId !== activeId) setActiveId(tab.connectionId)
            openQueryFor(database, schema)
          }}
          onContextDatabase={(target, x, y) => setDbMenu({ target, x, y })}
          onContextTable={(target, x, y) => setTableMenu({ target, x, y })}
        />
      )
    }
    if (tab.type === 'diagram') {
      return (
        <DiagramView
          connectionId={tab.connectionId}
          engine={tab.engine}
          database={tab.database}
          schema={tab.schema}
          onClose={() => {
            setError(null)
            closeTab(tab.id)
          }}
          onError={(message) => setError(message)}
        />
      )
    }
    if (tab.type === 'definition') {
      return (
        <ObjectDefinition
          target={{
            connectionId: tab.connectionId,
            database: tab.database,
            schema: tab.schema,
            name: tab.name,
            kind: tab.kind,
            signature: tab.signature
          }}
          onClose={() => closeTab(tab.id)}
          onError={(message) => setError(message)}
        />
      )
    }
    if (tab.type === 'createTable') {
      const engine =
        connections.find((c) => c.id === tab.connectionId)?.engine ?? 'sqlite'
      return (
        <TableDesigner
          mode="create"
          connectionId={tab.connectionId}
          engine={engine}
          defaultDatabase={tab.database}
          defaultSchema={tab.schema}
          onCancel={() => closeTab(tab.id)}
          onDone={(result) => {
            refreshTree()
            closeTab(tab.id)
            // Jump straight into the table the user just created.
            if (result.created) {
              openTable({
                connectionId: tab.connectionId,
                engine,
                database: result.created.database,
                schema: result.created.schema,
                table: result.created.table
              })
            }
          }}
        />
      )
    }
    if (tab.type === 'view') {
      const engine =
        connections.find((c) => c.id === tab.connectionId)?.engine ?? 'sqlite'
      if (tab.viewName) {
        return (
          <ViewDesigner
            mode="edit"
            connectionId={tab.connectionId}
            engine={engine}
            theme={theme}
            database={tab.database}
            schema={tab.schema}
            view={tab.viewName}
            onDone={(result) => {
              refreshTree()
              if (result.dropped) closeTab(tab.id)
            }}
          />
        )
      }
      return (
        <ViewDesigner
          mode="create"
          connectionId={tab.connectionId}
          engine={engine}
          theme={theme}
          database={tab.database}
          schema={tab.schema}
          onCancel={() => closeTab(tab.id)}
          onDone={(result) => {
            refreshTree()
            closeTab(tab.id)
            if (result.created) {
              openView(
                result.created.database,
                result.created.schema,
                result.created.view,
                engine
              )
            }
          }}
        />
      )
    }
    const doc = tab.selection.engine === 'mongodb'
    if (doc) {
      // Document store: no DDL or SQL, only document browsing and import/export.
      return (
        <div className="table-tab">
          <nav className="viewtabs">
            <button
              className={`viewtab${tab.view !== 'io' ? ' is-active' : ''}`}
              onClick={() => setTableView(tab.id, 'data')}
            >
              {tr('tab.data')}
            </button>
            <button
              className={`viewtab${tab.view === 'io' ? ' is-active' : ''}`}
              onClick={() => setTableView(tab.id, 'io')}
            >
              {tr('tab.io')}
            </button>
          </nav>
          {tab.view === 'io' ? (
            <IoPanel selection={tab.selection} />
          ) : (
            <DataGrid selection={tab.selection} />
          )}
        </div>
      )
    }
    const filterOpen = openFilterTabs.has(tab.id)
    return (
      <div className="table-tab">
        <nav className="viewtabs">
          <button
            className={`viewtab${tab.view === 'data' ? ' is-active' : ''}`}
            onClick={() => setTableView(tab.id, 'data')}
          >
            {tr('tab.data')}
          </button>
          <button
            className={`viewtab${tab.view === 'form' ? ' is-active' : ''}`}
            onClick={() => setTableView(tab.id, 'form')}
          >
            {tr('tab.form')}
          </button>
          <button
            className={`viewtab${tab.view === 'struct' ? ' is-active' : ''}`}
            onClick={() => setTableView(tab.id, 'struct')}
          >
            {tr('tab.structure')}
          </button>
          <button
            className={`viewtab${tab.view === 'io' ? ' is-active' : ''}`}
            onClick={() => setTableView(tab.id, 'io')}
          >
            {tr('tab.io')}
          </button>
          {tab.selection.type === 'view' && (
            <button
              className={`viewtab${tab.view === 'definition' ? ' is-active' : ''}`}
              onClick={() => setTableView(tab.id, 'definition')}
              title={tr('app.viewDefinition')}
            >
              {tr('tab.definition')}
            </button>
          )}
          {tab.view === 'data' && (
            <button
              className={`viewtab viewtab--filter${filterOpen ? ' is-active' : ''}`}
              onClick={() =>
                setOpenFilterTabs((prev) => {
                  const next = new Set(prev)
                  if (next.has(tab.id)) next.delete(tab.id)
                  else next.add(tab.id)
                  return next
                })
              }
              aria-expanded={filterOpen}
              aria-pressed={filterOpen}
              title={filterOpen ? tr('grid.hideFilters') : tr('grid.advancedFilter')}
            >
              <IconFilter size={13} />
              <span>{tr('grid.showFilters')}</span>
            </button>
          )}
        </nav>
        {tab.view === 'data' ? (
          <DataGrid
            selection={tab.selection}
            filterOpen={filterOpen}
            inspectedRowKey={
              inspectedRow && activeTabId === tab.id ? inspectedRow.key : null
            }
            onInspectRow={(row, key) => {
              setInspectedRow({ key, values: row })
              setRightPanelOpen(true)
              // Clicking a row is a request to inspect it, so show that tab.
              setRightPanelTab('detail')
            }}
          />
        ) : tab.view === 'form' ? (
          <FormView selection={tab.selection} />
        ) : tab.view === 'struct' ? (
          <TableDesigner
            mode="edit"
            connectionId={tab.selection.connectionId}
            engine={tab.selection.engine}
            database={tab.selection.database}
            schema={tab.selection.schema}
            table={tab.selection.table}
            onDone={(result) => {
              refreshTree()
              // Dropping the table from its structure tab must not leave a
              // tab pointed at a table that no longer exists.
              if (result.dropped) closeTab(tab.id)
            }}
          />
        ) : tab.view === 'definition' ? (
          <ObjectDefinition
            target={{
              connectionId: tab.selection.connectionId,
              database: tab.selection.database,
              schema: tab.selection.schema,
              name: tab.selection.table,
              kind: 'view'
            }}
            onClose={() => setTableView(tab.id, 'data')}
            onError={(message) => setError(message)}
          />
        ) : (
          <IoPanel selection={tab.selection} />
        )}
      </div>
    )
  }

  return (
    <div className="app">
      <header
        className={`menubar${customTitleBar ? ' menubar--titlebar' : ''}${
          titleBarOverlay ? ' menubar--overlay' : ''
        }${windowFullscreen ? ' is-fullscreen' : ''}`}
        role="toolbar"
        aria-label={tr('app.toolbar')}
        style={captionInset > 0 ? { paddingRight: captionInset } : undefined}
        ref={toolbarRef}
      >
        <div className="menubar__scroll">
          <div className="menubar__group">
            <button
              className="menubar__item"
              onClick={() => setEditing('new')}
              title={tr('app.newConnection')}
            >
              <IconServer size={15} />
              <span>{tr('app.connections')}</span>
            </button>
            <button
              className="menubar__item menubar__item--icon"
              onClick={() => setGroupPrompt({ mode: 'create' })}
              title={tr('app.newGroup')}
              aria-label={tr('app.newGroup')}
            >
              <IconFolderPlus size={15} />
            </button>
            <button
              className="menubar__item menubar__item--icon"
              onClick={importSavedQuery}
              disabled={!menuConnectionId}
              title={tr('app.importQuery')}
              aria-label={tr('app.importQuery')}
            >
              <IconImport size={15} />
            </button>
          </div>

          <span className="menubar__divider" />

          <div className="menubar__group">
            <button
              className="menubar__item"
              onClick={openQuery}
              disabled={!menuConnectionId || isDocument}
              title={
                isDocument
                  ? tr('app.mongoNoSql')
                  : `Tab query baru (${shortcutLabel('1')})`
              }
            >
              <IconQuery size={15} />
              <span>{tr('app.query')}</span>
            </button>
            <button
              className="menubar__item"
              onClick={openBuilder}
              disabled={!menuConnectionId || isDocument}
              title={isDocument ? tr('app.mongoNoSql') : tr('app.builderHint')}
            >
              <IconQuery size={15} />
              <span>{tr('app.builder')}</span>
            </button>
            <button
              className="menubar__item"
              onClick={openTableBrowser}
              disabled={!menuConnectionId}
              title={tr('app.exploreTables')}
            >
              <IconTablePlus size={15} />
              <span>{tr('app.tables')}</span>
            </button>
            <button
              className="menubar__item"
              onClick={() => void openDiagramForActive()}
              disabled={!menuConnectionId || isDocument}
              title={isDocument ? tr('app.mongoNoDiagram') : tr('app.diagramHint')}
            >
              <IconSchema size={15} />
              <span>{tr('app.diagram')}</span>
            </button>
          </div>

          <span className="menubar__divider" />

          <div className="menubar__group">
            <button
              className="menubar__item"
              onClick={openTransfer}
              disabled={!menuConnectionId}
              title={tr('app.transferTitle')}
            >
              <IconTransfer size={15} />
              <span>{tr('app.transfer')}</span>
            </button>
            <button
              className="menubar__item"
              onClick={openSync}
              disabled={!menuConnectionId || isDocument}
              title={isDocument ? tr('app.mongoNoSync') : tr('app.syncHint')}
            >
              <IconSync size={15} />
              <span>{tr('app.sync')}</span>
            </button>
            <button
              className="menubar__item"
              onClick={openBackup}
              disabled={!menuConnectionId || isDocument}
              title={isDocument ? tr('app.mongoNoBackup') : tr('app.backupHint')}
            >
              <IconArchive size={15} />
              <span>{tr('app.backup')}</span>
            </button>
          </div>

          <span className="menubar__divider" />

          <div className="menubar__group">
            <button
              className="menubar__item"
              onClick={openSessions}
              disabled={!menuConnectionId || activeEngine === 'sqlite'}
              title={
                activeEngine === 'sqlite'
                  ? tr('app.sqliteNoSessions')
                  : `Sesi aktif (${shortcutLabel('6')})`
              }
            >
              <IconActivity size={15} />
              <span>{tr('app.sessions')}</span>
            </button>
            <button
              className="menubar__item"
              onClick={openUsers}
              disabled={!supportsUsers}
              title={
                supportsUsers
                  ? tr('app.usersTitle', { key: shortcutLabel('2') })
                  : tr('app.engineNoUsers', {
                      engine: activeEngine ?? tr('app.engineThis')
                    })
              }
            >
              <IconUsers size={15} />
              <span>{tr('app.users')}</span>
            </button>
          </div>
        </div>

        <span className="menubar__spacer" />
        <button
          className={`icon-btn icon-btn--toggle${rightPanelOpen ? ' is-active' : ''}`}
          onClick={() => setRightPanelOpen((open) => !open)}
          aria-pressed={rightPanelOpen}
          aria-label={
            rightPanelOpen ? tr('app.hideRightPanel') : tr('app.showRightPanel')
          }
          title={rightPanelOpen ? tr('app.hideSidePanel') : tr('app.showSidePanel')}
        >
          <IconSidebar size={15} />
        </button>
        <button
          className="icon-btn"
          onClick={() => {
            setSettingsSection('general')
            setSettingsOpen(true)
          }}
          aria-label={tr('settings.open')}
          title={tr('settings.open')}
        >
          <IconSettings size={15} />
        </button>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          {filterOpen && (
            <div className="sidebar__filter">
              <IconSearch size={13} />
              <input
                ref={filterInputRef}
                className="sidebar__filter-input"
                value={sidebarFilter}
                onChange={(e) => setSidebarFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setSidebarFilter('')
                    setFilterOpen(false)
                  }
                }}
                placeholder={tr('search.sidebarPlaceholder')}
                aria-label={tr('search.sidebarLabel')}
              />
              {/* One control, not two: clearing the text and closing the field
                  are the same intent for a filter that only lives here. */}
              <button
                className="sidebar__filter-close"
                onClick={() => {
                  setSidebarFilter('')
                  setFilterOpen(false)
                }}
                aria-label={tr('search.close')}
              >
                <IconClose size={11} />
              </button>
            </div>
          )}

          {filterOpen &&
            sidebarFilter.trim() &&
            !filterResult.pending &&
            filterResult.matches === 0 && (
              <p className="muted sidebar__filter-empty">
                {tr('explorer.noObjectMatch')}
              </p>
            )}

          {error && (
            <p className="notice notice--error" role="alert">
              {error}
            </p>
          )}

          {workerLost && (
            <div className="notice notice--error" role="alert">
              <p>
                {tr('app.workerLost', { message: workerLost.message })}
                {workerLost.lastOp
                  ? ` ${tr('app.workerLostLastOp', { op: workerLost.lastOp })}`
                  : ''}
              </p>
              <button
                className="btn btn--small btn--ghost"
                onClick={() => setWorkerLost(null)}
              >
                {tr('common.close')}
              </button>
            </div>
          )}

          {loading ? (
            <p className="muted">{tr('app.loadingConnections')}</p>
          ) : (
            <ObjectTree
              connections={connections}
              activeId={activeId}
              activeDatabase={treeActiveDatabase}
              activeSchema={treeActiveSchema}
              openIds={openConnectionIds}
              connectingIds={connectingIds}
              connectionErrors={connectionErrors}
              selected={activeSelection}
              treeVersion={treeVersion}
              queryVersion={queryVersion}
              onNewConnection={() => setEditing('new')}
              onImportConnections={() => void importConnections()}
              onExportConnections={() => void exportConnections()}
              filter={sidebarFilter}
              onFilterResult={setFilterResult}
              onConnect={(id) => void handleConnect(id)}
              onDisconnect={(id) => void handleDisconnect(id)}
              onEdit={(conn) => setEditing(conn)}
              onDelete={(id) => void handleDelete(id)}
              onSelectTable={openTable}
              onOpenQuery={openSavedQuery}
              onContextQuery={(query, x, y) => setQueryMenu({ query, x, y })}
              onContextConnection={(conn, x, y) => setConnMenu({ conn, x, y })}
              onContextDatabase={(target, x, y) => setDbMenu({ target, x, y })}
              onContextSchema={(target, x, y) => setSchemaMenu({ target, x, y })}
              onContextTable={(target, x, y) => setTableMenu({ target, x, y })}
              onContextRoutine={(target, x, y) => setRoutineMenu({ target, x, y })}
              onFocusScope={(target) => {
                // Expanding a database or schema is also a selection: the tree
                // highlight, the menus, and a new query tab must follow it even
                // when another connection was focused a moment ago.
                setActiveId(target.connectionId)
                setTreeFocus((prev) => {
                  const current = prev[target.connectionId]
                  if (
                    current?.database === target.database &&
                    (current?.schema ?? undefined) === (target.schema ?? undefined)
                  ) {
                    return prev
                  }
                  return {
                    ...prev,
                    [target.connectionId]: {
                      database: target.database,
                      schema: target.schema
                    }
                  }
                })
              }}
              onOpenDefinition={(target) =>
                openDefinition({
                  connectionId: target.connectionId,
                  database: target.database,
                  schema: target.schema,
                  name: target.routine.name,
                  kind: target.routine.kind,
                  signature: target.routine.signature ?? null
                })
              }
              onRefresh={refreshTree}
              onConnectionsChanged={() => void reload()}
            />
          )}
        </aside>

        <main className="content">
          <div className="tabbar">
            <div className="tabbar__tabs" role="tablist" ref={tabStripRef}>
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`tab${tab.id === activeTabId ? ' is-active' : ''}`}
                  role="tab"
                  aria-selected={tab.id === activeTabId}
                >
                  <button
                    className="tab__label"
                    onClick={() => setActiveTabId(tab.id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setTabMenu({ x: e.clientX, y: e.clientY, tabId: tab.id })
                    }}
                    title={tabTooltip(
                      tab,
                      tr,
                      connections.find((c) => c.id === tabConnectionId(tab))?.name
                    )}
                  >
                    <span className="tab__icon">
                      <TabIcon tab={tab} />
                    </span>
                    <span className="tab__text">{tabLabel(tab, tr)}</span>
                  </button>
                  <button
                    className="tab__close"
                    onClick={() => closeTab(tab.id)}
                    aria-label={tr('app.closeTabLabel', { name: tabLabel(tab, tr) })}
                  >
                    <IconClose size={11} />
                  </button>
                </div>
              ))}
              <button
                className="tabbar__new"
                onClick={openQuery}
                disabled={!menuConnectionId || isDocument}
                title={
                  isDocument
                    ? tr('app.mongoNoQuery')
                    : `Tab query baru (${shortcutLabel('1')})`
                }
                aria-label={tr('app.newQueryTab')}
              >
                <IconPlus size={13} />
              </button>
            </div>
          </div>

          <div className="tabpanels">
            {tabs.length === 0 ? (
              <p className="muted">
                {openConnectionIds.size > 0
                  ? tr('app.pickTableOrQuery')
                  : tr('app.connectToStart')}
              </p>
            ) : (
              tabs.map((tab) => (
                <div
                  key={tab.id}
                  className="tab-panel"
                  style={{ display: tab.id === activeTabId ? 'flex' : 'none' }}
                >
                  {renderTabContent(tab)}
                </div>
              ))
            )}
          </div>
        </main>

        {rightPanelOpen && (
          <RightPanel
            tab={rightPanelTab}
            onTabChange={setRightPanelTab}
            onClose={() => setRightPanelOpen(false)}
            schemaContext={rightPanelSchemaContext}
            mentionConnectionId={assistantScopeResolved?.connectionId}
            mentionDatabase={assistantScopeResolved?.database}
            mentionSchema={assistantScopeResolved?.schema}
            catalogVersion={treeVersion}
            engine={activeEngine}
            selection={detailSelection}
            inspectedRow={inspectedRow}
            onOpenSettings={() => {
              setSettingsSection('ai')
              setSettingsOpen(true)
            }}
            onInsertSql={insertAssistantSql}
          />
        )}
      </div>

      <footer className="statusbar">
        <span className="statusbar__item">
          {tr('app.connectionCount', { count: connections.length })}
        </span>
        <span className="statusbar__item">
          {tr('app.tabCount', { count: tabs.length })}
        </span>
        {activeConnectionName && (
          <span className="statusbar__item statusbar__item--active">
            {activeConnectionName}
          </span>
        )}
        {activeSelection && (
          <span className="statusbar__item">
            {activeSelection.database}
            {activeSelection.schema ? `.${activeSelection.schema}` : ''}
            {` / ${activeSelection.table}`}
          </span>
        )}
        <span className="statusbar__spacer" />
        <span className="statusbar__item">{activeEngine ?? tr('app.notConnected')}</span>
      </footer>

      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={buildTabMenuItems(tabMenu.tabId)}
          onClose={() => setTabMenu(null)}
        />
      )}

      {queryMenu && (
        <ContextMenu
          x={queryMenu.x}
          y={queryMenu.y}
          items={buildQueryMenuItems(queryMenu.query)}
          onClose={() => setQueryMenu(null)}
        />
      )}

      {connMenu && (
        <ContextMenu
          x={connMenu.x}
          y={connMenu.y}
          items={buildConnectionMenuItems(connMenu.conn)}
          onClose={() => setConnMenu(null)}
        />
      )}

      {dbMenu && (
        <ContextMenu
          x={dbMenu.x}
          y={dbMenu.y}
          items={buildDatabaseMenuItems(dbMenu.target)}
          onClose={() => setDbMenu(null)}
        />
      )}

      {tableMenu && (
        <ContextMenu
          x={tableMenu.x}
          y={tableMenu.y}
          items={buildTableMenuItems(tableMenu.target)}
          onClose={() => setTableMenu(null)}
        />
      )}

      {schemaMenu && (
        <ContextMenu
          x={schemaMenu.x}
          y={schemaMenu.y}
          items={buildSchemaMenuItems(schemaMenu.target)}
          onClose={() => setSchemaMenu(null)}
        />
      )}

      {routineMenu && (
        <ContextMenu
          x={routineMenu.x}
          y={routineMenu.y}
          items={buildRoutineMenuItems(routineMenu.target)}
          onClose={() => setRoutineMenu(null)}
        />
      )}

      {groupPrompt && (
        <PromptDialog
          title={tr('app.newGroup')}
          label={tr('app.groupName')}
          confirmLabel={tr('app.create')}
          onConfirm={(name) => void createGroup(name)}
          onClose={() => setGroupPrompt(null)}
        />
      )}

      {renamingQuery && (
        <PromptDialog
          title={tr('app.renameQuery')}
          label={tr('app.queryName')}
          defaultValue={renamingQuery.name}
          confirmLabel={tr('common.save')}
          onConfirm={(name) => renameSavedQuery(renamingQuery, name)}
          onClose={() => setRenamingQuery(null)}
        />
      )}

      {namePrompt && (
        <PromptDialog
          title={namePrompt.title}
          label={namePrompt.label}
          defaultValue={namePrompt.defaultValue}
          confirmLabel={namePrompt.confirmLabel}
          onConfirm={namePrompt.onConfirm}
          onClose={() => setNamePrompt(null)}
        />
      )}

      {pendingClose && (
        <ConfirmDialog
          title={tr('app.queryUnsaved')}
          message={tr('query.unsavedCloseMessage')}
          detail={
            tabs.find((t) => t.id === pendingClose.dirtyTabId)?.type === 'query'
              ? (
                  tabs.find((t) => t.id === pendingClose.dirtyTabId) as
                    { title: string } | undefined
                )?.title
              : undefined
          }
          actions={[
            { label: tr('action.save'), primary: true },
            { label: tr('action.discard'), danger: true }
          ]}
          onSelect={(action: ConfirmAction) => {
            // Compare the role, not the label: the label is localised, so a
            // text comparison would silently discard the SQL in English.
            if (action.primary) void savePendingClose()
            else finishPendingClose()
          }}
          onClose={() => setPendingClose(null)}
        />
      )}

      <ToastStack
        toasts={toasts}
        onDismiss={dismissToast}
        onPause={pauseToast}
        onResume={resumeToast}
      />

      {editing && (
        <ConnectionForm
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await reload()
          }}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          initialSection={settingsSection}
          onClose={() => {
            setSettingsOpen(false)
            setSettingsSection('general')
          }}
        />
      )}

      {ncxPath && (
        <ImportConnectionsDialog
          filePath={ncxPath}
          onClose={() => setNcxPath(null)}
          onImported={(imported) => {
            setNcxPath(null)
            void reload().then(() => {
              pushToast({
                kind: imported.length > 0 ? 'ok' : 'info',
                title: tr('ncx.title'),
                body:
                  imported.length > 0
                    ? tr('ncx.done', { count: imported.length })
                    : tr('ncx.doneNone')
              })
            })
          }}
        />
      )}
    </div>
  )
}
