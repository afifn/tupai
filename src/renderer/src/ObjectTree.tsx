import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionGroup, SavedQuery, StoredConnection } from '@shared/types'
import { unwrap } from './api'
import { confirmDestructive } from './confirm'
import { PromptDialog } from './PromptDialog'
import { ContextMenu } from './ContextMenu'
import { useLocale } from './i18n'
import {
  ExplorerTree,
  type DatabaseTarget,
  type RoutineTarget,
  type SchemaTarget,
  type SelectedTable,
  type TableTarget
} from './ExplorerTree'
import { EngineIcon } from './EngineIcon'
import {
  IconCaret,
  IconFolder,
  IconPencil,
  IconPlug,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUnplug
} from './Icons'

interface Props {
  connections: StoredConnection[]
  activeId: string | null
  // Database and schema of the active tab, used to mark where the user is.
  activeDatabase?: string
  activeSchema?: string
  // Every connected connection, not just the focused one. Each keeps its own
  // expanded tree so the user can work across servers.
  openIds: Set<string>
  connectingIds: Set<string>
  // Connection id to a short failure reason, shown inline on the row.
  connectionErrors: Map<string, string>
  selected: SelectedTable | null
  treeVersion: number
  queryVersion: number
  onConnect: (id: string) => void
  onDisconnect: (id: string) => void
  onEdit: (conn: StoredConnection) => void
  onDelete: (id: string) => void
  onSelectTable: (sel: SelectedTable) => void
  onOpenQuery: (query: SavedQuery) => void
  onContextQuery: (query: SavedQuery, x: number, y: number) => void
  onContextConnection: (conn: StoredConnection, x: number, y: number) => void
  onContextDatabase: (target: DatabaseTarget, x: number, y: number) => void
  onContextSchema: (target: SchemaTarget, x: number, y: number) => void
  onContextTable: (target: TableTarget, x: number, y: number) => void
  onContextRoutine: (target: RoutineTarget, x: number, y: number) => void
  onOpenDefinition: (target: RoutineTarget) => void
  // Last database/schema the user clicked, so a new query tab can default to it.
  onFocusScope?: (target: {
    connectionId: string
    database: string
    schema?: string
  }) => void
  onNewConnection: () => void
  onRefresh: () => void
  onConnectionsChanged: () => void
  // Navicat migration: the tree background is where a user looks for "add
  // connections", so both directions live here too.
  onImportConnections: () => void
  onExportConnections: () => void
  // Sidebar filter, driven by Cmd/Ctrl+F in the shell. Empty means show all.
  filter: string
  // Aggregate result of the filter, so the shell can say "no match" when nothing
  // in any connection matched.
  onFilterResult: (result: { matches: number; pending: boolean }) => void
}

const UNGROUPED_DROP = 'ungrouped'

export function ObjectTree({
  connections,
  activeId,
  activeDatabase,
  activeSchema,
  openIds,
  connectingIds,
  connectionErrors,
  selected,
  treeVersion,
  queryVersion,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
  onSelectTable,
  onOpenQuery,
  onContextQuery,
  onContextConnection,
  onContextDatabase,
  onContextSchema,
  onContextTable,
  onContextRoutine,
  onOpenDefinition,
  onFocusScope,
  onNewConnection,
  onRefresh,
  onImportConnections,
  onExportConnections,
  filter,
  onFilterResult,
  onConnectionsChanged
}: Props): JSX.Element {
  const { tr } = useLocale()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [groups, setGroups] = useState<ConnectionGroup[]>([])
  // Groups start collapsed on a fresh launch so the sidebar opens compact.
  // Existing groups are marked collapsed once, when the list first arrives;
  // later user toggles are not overridden.
  const [collapsedGroupsInitialised, setCollapsedGroupsInitialised] = useState(false)
  const [groupPrompt, setGroupPrompt] = useState<
    { mode: 'create' } | { mode: 'rename'; group: ConnectionGroup } | null
  >(null)
  const [groupMenu, setGroupMenu] = useState<{
    group: ConnectionGroup
    x: number
    y: number
  } | null>(null)
  // Right-click on empty tree space: the same actions the sidebar header
  // offers, so the list can be managed without hunting for the toolbar.
  const [backgroundMenu, setBackgroundMenu] = useState<{
    x: number
    y: number
  } | null>(null)
  // Drag-and-drop: the dragged connection id plus the group currently hovered.
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const loadGroups = useCallback(() => {
    unwrap(window.dbApi.listConnectionGroups())
      .then(setGroups)
      .catch(() => setGroups([]))
  }, [])

  useEffect(() => {
    loadGroups()
  }, [loadGroups, connections])

  // Collapse every group the first time the list loads. This runs once per app
  // session, so it does not fight the user afterwards.
  useEffect(() => {
    if (collapsedGroupsInitialised || groups.length === 0) return
    setCollapsed((prev) => {
      const next = new Set(prev)
      for (const g of groups) next.add(`group:${g.id}`)
      return next
    })
    setCollapsedGroupsInitialised(true)
  }, [groups, collapsedGroupsInitialised])

  async function saveGroup(name: string): Promise<void> {
    const prompt = groupPrompt
    setGroupPrompt(null)
    if (!name.trim()) return
    try {
      await unwrap(
        window.dbApi.saveConnectionGroup({
          id: prompt?.mode === 'rename' ? prompt.group.id : undefined,
          name
        })
      )
      loadGroups()
    } catch {
      // The list simply stays as it was; the prompt is already closed.
    }
  }

  async function deleteConnection(conn: StoredConnection): Promise<void> {
    const proceed = await confirmDestructive(
      tr('app.deleteConnectionMessage', { name: conn.name }),
      {
        title: tr('app.deleteConnectionTitle'),
        detail: tr('app.deleteConnectionDetail')
      }
    )
    if (!proceed) return
    onDelete(conn.id)
  }

  async function deleteGroup(group: ConnectionGroup): Promise<void> {
    const members = connections.filter((c) => c.groupId === group.id)
    const note =
      members.length > 0
        ? tr('tree.deleteGroupDetail', { count: members.length })
        : undefined
    const proceed = await confirmDestructive(
      tr('tree.deleteGroupConfirm', { name: group.name }),
      {
        title: tr('menu.deleteGroup'),
        detail: note
      }
    )
    if (!proceed) return
    try {
      await unwrap(window.dbApi.deleteConnectionGroup(group.id))
      loadGroups()
    } catch {
      // Leave the list unchanged on failure.
    }
  }

  function toggleCollapse(id: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Every newly connected connection opens its tree, not just the focused one.
  // Otherwise a connection that was collapsed before connecting stays closed,
  // and the caret shows "collapsed" for children that are never rendered.
  useEffect(() => {
    setCollapsed((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const id of openIds) {
        if (next.delete(id)) changed = true
      }
      return changed ? next : prev
    })
  }, [openIds])

  // Drop target ids: a group id, or UNGROUPED_DROP for the "no group" zone.
  async function moveToGroup(
    connectionId: string,
    groupId: string | null
  ): Promise<void> {
    const current = connections.find((c) => c.id === connectionId)
    if (!current) return
    if ((current.groupId ?? null) === groupId) return
    try {
      await unwrap(window.dbApi.setConnectionGroup(connectionId, groupId))
      // Reordering the sidebar needs the updated connection list from App.
      onConnectionsChanged()
      if (groupId)
        setCollapsed((prev) => {
          const next = new Set(prev)
          next.delete(`group:${groupId}`)
          return next
        })
    } catch {
      // The tree keeps its previous grouping when the move fails.
    }
  }

  function dragProps(groupId: string | null) {
    const targetId = groupId ?? UNGROUPED_DROP
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!draggingId) return
        // Prevent the default so the drop event fires.
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (dropTarget !== targetId) setDropTarget(targetId)
      },
      onDragLeave: (e: React.DragEvent) => {
        // Ignore leave events fired when moving over a child element.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropTarget((current) => (current === targetId ? null : current))
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        const id = draggingId ?? e.dataTransfer.getData('text/plain')
        setDropTarget(null)
        setDraggingId(null)
        if (id) void moveToGroup(id, groupId)
      }
    }
  }

  const knownGroupIds = new Set(groups.map((g) => g.id))
  const filterTerm = filter.trim().toLowerCase()
  const filterActive = filterTerm.length > 0

  // A connection that is not connected has no tree to search, so during a filter
  // only its own name can match. Connections that are open report their result
  // from ExplorerTree; the ones that are closed fall back to the name.
  const [connectionMatches, setConnectionMatches] = useState<Record<string, boolean>>({})
  function connectionVisible(c: StoredConnection): boolean {
    if (!filterActive) return true
    if (!openIds.has(c.id)) return c.name.toLowerCase().includes(filterTerm)
    return connectionMatches[c.id] ?? true
  }

  // While filtering, open every connection so its objects are loaded and can be
  // matched, the same way a branch is expanded.
  useEffect(() => {
    if (!filterActive) return
    for (const c of connections) {
      if (openIds.has(c.id)) continue
      setCollapsed((prev) => {
        if (!prev.has(c.id)) return prev
        const next = new Set(prev)
        next.delete(c.id)
        return next
      })
    }
  }, [filterActive, filterTerm, connections, openIds])

  // Hiding a connection must not unmount its ExplorerTree: the tree is what
  // reports whether it has a match, so unmounting it would leave the connection
  // hidden forever. The row is hidden with a class instead, and the tree keeps
  // rendering (and matching) underneath.
  const filterReportRef = useRef(onFilterResult)
  filterReportRef.current = onFilterResult
  useEffect(() => {
    if (!filterActive) {
      filterReportRef.current({ matches: 1, pending: false })
      return
    }
    filterReportRef.current({
      matches: connections.filter(connectionVisible).length,
      pending: false
    })
  }, [filterActive, filterTerm, connections, connectionMatches])
  const ungrouped = connections.filter((c) => !c.groupId || !knownGroupIds.has(c.groupId))

  function renderConnection(c: StoredConnection): JSX.Element {
    const isOpen = openIds.has(c.id)
    const isCollapsed = collapsed.has(c.id)
    const isConnecting = connectingIds.has(c.id)
    const failure = connectionErrors.get(c.id)
    // A connection that is not connected renders no children, so it is never
    // "expanded" no matter what the collapsed set says.
    const isExpanded = isOpen && !isCollapsed
    const rowState = isConnecting
      ? ' is-connecting'
      : failure
        ? ' is-failed'
        : isOpen
          ? ' is-open'
          : ''
    // The focused connection is the one whose tree the menubar acts on.
    const focusState = c.id === activeId ? ' is-focused' : ''
    // Hidden by the filter but still mounted: the ExplorerTree inside is what
    // decides whether this connection matches, so unmounting it would make the
    // decision permanent.
    const hidden = !connectionVisible(c)
    return (
      <div
        key={c.id}
        className={`objtree__conn${c.color ? ` is-colored conn-tint--${c.color}` : ''}${
          draggingId === c.id ? ' is-dragging' : ''
        }${failure ? ' is-failed' : ''}${hidden ? ' is-filtered-out' : ''}`}
      >
        <div
          className={`objtree__row${rowState}${focusState}`}
          title={
            isConnecting
              ? 'Menyambung...'
              : failure
                ? tr('tree.retryHint', { message: failure })
                : undefined
          }
          draggable
          onDragStart={(e) => {
            setDraggingId(c.id)
            e.dataTransfer.effectAllowed = 'move'
            // Some platforms require data to be set for the drag to start.
            e.dataTransfer.setData('text/plain', c.id)
          }}
          onDragEnd={() => {
            setDraggingId(null)
            setDropTarget(null)
          }}
          onDoubleClick={(e) => {
            // Ignore double-clicks that land on the caret or an action button.
            if ((e.target as HTMLElement).closest('button')) return
            if (isOpen) onDisconnect(c.id)
            else onConnect(c.id)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            onContextConnection(c, e.clientX, e.clientY)
          }}
        >
          <button
            className="objtree__caret"
            onClick={() => {
              if (!isOpen) {
                // Nothing to expand yet. Connecting opens the tree once the
                // session is up, so the caret matches what the user sees.
                onConnect(c.id)
                return
              }
              toggleCollapse(c.id)
            }}
            aria-label={
              !isOpen
                ? tr('tree.connectAndExpand')
                : isCollapsed
                  ? 'Bentangkan'
                  : 'Ciutkan'
            }
            aria-expanded={isExpanded}
          >
            <IconCaret open={isExpanded} />
          </button>
          <span className={`objtree__icon${c.id === activeId ? ' is-active' : ''}`}>
            <EngineIcon engine={c.engine} active={isOpen} size={14} />
          </span>
          <span className="objtree__name" title={c.name}>
            {c.name}
          </span>
          <span className="objtree__actions">
            {isConnecting ? (
              <span className="objtree__busy" role="status">
                {tr('tree.connecting')}
              </span>
            ) : isOpen ? (
              <button
                className="icon-btn icon-btn--xs"
                onClick={() => onDisconnect(c.id)}
                title={tr('tree.disconnect')}
                aria-label={tr('tree.disconnect')}
              >
                <IconUnplug size={13} />
              </button>
            ) : (
              <button
                className="icon-btn icon-btn--xs"
                onClick={() => onConnect(c.id)}
                title={tr('tree.connect')}
                aria-label={tr('tree.connect')}
              >
                <IconPlug size={13} />
              </button>
            )}
            <button
              className="icon-btn icon-btn--xs"
              onClick={() => onEdit(c)}
              title={tr('tree.edit')}
              aria-label={tr('tree.edit')}
            >
              <IconPencil size={13} />
            </button>
            <button
              className="icon-btn icon-btn--xs icon-btn--danger"
              onClick={() => void deleteConnection(c)}
              title={tr('tree.delete')}
              aria-label={tr('tree.delete')}
            >
              <IconTrash size={13} />
            </button>
          </span>
        </div>

        {isExpanded && (
          <div className="objtree__tree">
            <ExplorerTree
              connectionId={c.id}
              engine={c.engine}
              selected={selected}
              onSelectTable={onSelectTable}
              onOpenQuery={onOpenQuery}
              onContextQuery={onContextQuery}
              onContextDatabase={onContextDatabase}
              onContextSchema={onContextSchema}
              onContextTable={onContextTable}
              onContextRoutine={onContextRoutine}
              onOpenDefinition={onOpenDefinition}
              onFocusScope={(target) => onFocusScope?.({ connectionId: c.id, ...target })}
              version={treeVersion}
              queryVersion={queryVersion}
              activeDatabase={c.id === activeId ? activeDatabase : undefined}
              activeSchema={c.id === activeId ? activeSchema : undefined}
              filter={filter}
              onFilterResult={(result) =>
                setConnectionMatches((prev) => {
                  const next = result.pending ? true : result.matches > 0
                  return prev[c.id] === next ? prev : { ...prev, [c.id]: next }
                })
              }
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="objtree"
      onContextMenu={(e) => {
        // Rows open their own menu; only empty space belongs to the list.
        if ((e.target as HTMLElement).closest('.objtree__row, .objtree__group-head')) {
          return
        }
        e.preventDefault()
        setBackgroundMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <div className="objtree__section">
        <span className="objtree__section-label">{tr('tree.connections')}</span>
        <span className="objtree__section-actions">
          <button
            className="icon-btn icon-btn--xs"
            onClick={onNewConnection}
            title={tr('app.newConnection')}
            aria-label={tr('app.newConnection')}
          >
            <IconPlus size={13} />
          </button>
          <button
            className="icon-btn icon-btn--xs"
            onClick={onRefresh}
            title={tr('tree.reloadTree')}
            aria-label={tr('tree.reloadTree')}
          >
            <IconRefresh size={13} />
          </button>
        </span>
      </div>

      {connections.length === 0 && groups.length === 0 ? (
        <div className="objtree__empty">
          <p className="muted">{tr('tree.emptyConnections')}</p>
          <button className="btn btn--ghost btn--tiny" onClick={onNewConnection}>
            {tr('app.newConnection')}
          </button>
        </div>
      ) : (
        <div className="objtree__list">
          {groups.map((group) => {
            const members = connections.filter((c) => c.groupId === group.id)
            const isGroupCollapsed = collapsed.has(`group:${group.id}`)
            const isDropTarget = dropTarget === group.id
            return (
              <div
                key={group.id}
                className={`objtree__group${isDropTarget ? ' is-drop-target' : ''}`}
                {...dragProps(group.id)}
              >
                <button
                  className="objtree__group-head"
                  onClick={() => toggleCollapse(`group:${group.id}`)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setGroupMenu({ group, x: e.clientX, y: e.clientY })
                  }}
                  aria-expanded={!isGroupCollapsed}
                >
                  <span className="objtree__caret">
                    <IconCaret open={!isGroupCollapsed} />
                  </span>
                  <span className="objtree__group-icon">
                    <IconFolder size={14} />
                  </span>
                  <span className="objtree__group-name">{group.name}</span>
                  <span className="objtree__group-count">{members.length}</span>
                </button>
                {!isGroupCollapsed &&
                  (members.length === 0 ? (
                    <p className="muted objtree__group-empty">{tr('tree.dropHere')}</p>
                  ) : (
                    members.map((c) => renderConnection(c))
                  ))}
              </div>
            )
          })}
          {ungrouped.length > 0 && (
            <div
              className={`objtree__ungrouped${
                dropTarget === UNGROUPED_DROP ? ' is-drop-target' : ''
              }`}
              {...dragProps(null)}
            >
              {ungrouped.map((c) => renderConnection(c))}
            </div>
          )}
        </div>
      )}

      {groupMenu && (
        <ContextMenu
          x={groupMenu.x}
          y={groupMenu.y}
          items={[
            {
              label: tr('menu.renameGroup'),
              onSelect: () => setGroupPrompt({ mode: 'rename', group: groupMenu.group })
            },
            {
              label: tr('menu.deleteGroup'),
              danger: true,
              separatorBefore: true,
              onSelect: () => void deleteGroup(groupMenu.group)
            }
          ]}
          onClose={() => setGroupMenu(null)}
        />
      )}

      {backgroundMenu && (
        <ContextMenu
          x={backgroundMenu.x}
          y={backgroundMenu.y}
          items={[
            { label: tr('menu.newConnection'), onSelect: onNewConnection },
            {
              label: tr('menu.newGroup'),
              onSelect: () => setGroupPrompt({ mode: 'create' })
            },
            {
              label: tr('ncx.importMenu'),
              separatorBefore: true,
              onSelect: onImportConnections
            },
            {
              label: tr('ncx.exportMenu'),
              onSelect: onExportConnections
            },
            {
              label: tr('menu.reload'),
              separatorBefore: true,
              onSelect: onRefresh
            }
          ]}
          onClose={() => setBackgroundMenu(null)}
        />
      )}

      {groupPrompt && (
        <PromptDialog
          title={
            groupPrompt.mode === 'create' ? tr('menu.newGroup') : tr('tree.renameGroup')
          }
          label={tr('app.groupName')}
          defaultValue={groupPrompt.mode === 'rename' ? groupPrompt.group.name : ''}
          confirmLabel={tr(
            groupPrompt.mode === 'create' ? 'app.createGroup' : 'app.saveConnection'
          )}
          onConfirm={(name) => void saveGroup(name)}
          onClose={() => setGroupPrompt(null)}
        />
      )}
    </div>
  )
}
