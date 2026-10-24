import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ColumnInfo, ForeignKeyInfo } from '@shared/types'
import { unwrap } from './api'
import { useLocale } from './i18n'
import { IconClose, IconPlus, IconRefresh } from './Icons'
import { shortcutLabel } from './platform'
import { TableQuickEdit, type QuickEditTarget } from './TableQuickEdit'
import {
  CARD_MAX_COLUMNS,
  CARD_WIDTH,
  DIAGRAM_COLORS,
  autoLayout,
  buildEdges,
  canvasSize,
  cardHeight,
  clampPosition,
  edgeAnchors,
  mergeStoredLayout,
  normalizeLayout,
  orthogonalPath,
  readStoredDiagram,
  resolveCollisions,
  zoneDividerX,
  type DiagramColor,
  type DiagramNode,
  type DiagramTable
} from './diagramLayout'

interface Props {
  connectionId: string
  engine: string
  database: string
  schema?: string
  onClose: () => void
  onError: (message: string) => void
}

const STORAGE_PREFIX = 'diagram.v1'

// Zoom bounds and step. Ctrl+wheel uses a continuous factor; the buttons and
// shortcuts step by a fixed amount so keyboard-only users get predictable stops.
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2.5
const ZOOM_STEP = 0.1

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100))
}

function storageKey(connectionId: string, database: string, schema?: string): string {
  return `${STORAGE_PREFIX}:${connectionId}:${database}:${schema ?? ''}`
}

// ER-style diagram for one database. Every table is a card; clicking a card
// opens a quick editor for column types and row insertion, and cards can be
// dragged and coloured. Positions and colours live in localStorage per
// connection+database so reopening the diagram restores the layout.
export function DiagramView({
  connectionId,
  engine,
  database,
  schema,
  onClose,
  onError
}: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [nodes, setNodes] = useState<DiagramNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<QuickEditTarget | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [colors, setColors] = useState<Record<string, DiagramColor>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  // Reads the live zoom inside native wheel/key handlers without re-binding them.
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  // The parent passes an inline callback; keeping it in a ref stops load from
  // being recreated on every render, which would retrigger its effect forever.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const dragRef = useRef<{ key: string; offsetX: number; offsetY: number } | null>(null)

  const key = storageKey(connectionId, database, schema)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const tables = await unwrap(window.dbApi.listTables(connectionId, database, schema))
      const detail: DiagramTable[] = []
      for (const table of tables) {
        let columns: ColumnInfo[] = []
        let foreignKeys: ForeignKeyInfo[] = []
        try {
          columns = await unwrap(
            window.dbApi.listColumns(connectionId, database, table.name, schema)
          )
        } catch {
          columns = []
        }
        try {
          foreignKeys = await unwrap(
            window.dbApi.listForeignKeys(connectionId, database, table.name, schema)
          )
        } catch {
          foreignKeys = []
        }
        detail.push({
          database,
          schema: table.schema ?? schema,
          name: table.name,
          columns,
          foreignKeys
        })
      }
      const stored = readStoredDiagram(localStorage.getItem(key))
      // Normalise even when positions were saved: a table added since then, or a
      // layout from an older version, could otherwise open with cards stacked.
      setNodes(normalizeLayout(mergeStoredLayout(autoLayout(detail), stored)))
      setColors(stored.colors)
    } catch (err) {
      const message = errorText(err)
      setError(message)
      onErrorRef.current(message)
    } finally {
      setLoading(false)
    }
  }, [connectionId, database, schema, key])

  useEffect(() => {
    void load()
  }, [load])

  // Ctrl+wheel zooms and keeps the point under the cursor anchored, so the card
  // being inspected stays in place instead of sliding away. Registered natively
  // because React's onWheel is passive and cannot preventDefault the browser
  // page zoom.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    function onWheel(event: WheelEvent): void {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const node = canvasRef.current
      if (!node) return
      const rect = node.getBoundingClientRect()
      const pointerX = event.clientX - rect.left + node.scrollLeft
      const pointerY = event.clientY - rect.top + node.scrollTop
      setZoom((current) => {
        const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08
        const next = clampZoom(current * factor)
        if (next === current) return current
        const ratio = next / current
        // Preserve the canvas point under the pointer across the scale change.
        requestAnimationFrame(() => {
          const el = canvasRef.current
          if (!el) return
          el.scrollLeft = pointerX * ratio - (event.clientX - rect.left)
          el.scrollTop = pointerY * ratio - (event.clientY - rect.top)
        })
        return next
      })
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [loading, nodes.length])

  // Keyboard zoom works without a mouse: Ctrl/Cmd with +, -, or 0. The diagram
  // only reacts while it is mounted, and the listener is ignored when the event
  // comes from a text field.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (!event.ctrlKey && !event.metaKey) return
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        setZoom((current) => clampZoom(current + ZOOM_STEP))
        return
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        setZoom((current) => clampZoom(current - ZOOM_STEP))
        return
      }
      if (event.key === '0') {
        event.preventDefault()
        setZoom(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function zoomBy(delta: number): void {
    setZoom((current) => clampZoom(current + delta))
  }

  // Positions are written on drag end, not on every mousemove, so a slow drag
  // does not hammer localStorage.
  function persistPositions(next: DiagramNode[]): void {
    const stored = readStoredDiagram(localStorage.getItem(key))
    const positions = { ...stored.positions }
    for (const node of next) positions[node.key] = { x: node.x, y: node.y }
    localStorage.setItem(key, JSON.stringify({ positions, colors }))
  }

  function setColor(nodeKey: string, color: DiagramColor): void {
    setColors((prev) => {
      const next = { ...prev, [nodeKey]: color }
      const stored = readStoredDiagram(localStorage.getItem(key))
      localStorage.setItem(
        key,
        JSON.stringify({ positions: stored.positions, colors: next })
      )
      return next
    })
  }

  function resetLayout(): void {
    localStorage.removeItem(key)
    setColors({})
    void load()
    setNotice(tr('diagram.layoutReset'))
  }

  const edges = useMemo(() => buildEdges(nodes.map((n) => n.table)), [nodes])
  const size = canvasSize(nodes)
  const dividerX = zoneDividerX(nodes)
  const isolatedCount = nodes.filter((node) => node.isolated).length

  function startDrag(event: React.MouseEvent, node: DiagramNode): void {
    // The card is also clickable; a drag only starts from the header and only
    // after the pointer actually moves, which is handled in onMove.
    if ((event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = {
      key: node.key,
      // Pointer coordinates are screen pixels; the stage is scaled, so the grab
      // offset is converted into layout coordinates.
      offsetX:
        (event.clientX - rect.left + (canvasRef.current?.scrollLeft ?? 0)) /
          (zoomRef.current || 1) -
        node.x,
      offsetY:
        (event.clientY - rect.top + (canvasRef.current?.scrollTop ?? 0)) /
          (zoomRef.current || 1) -
        node.y
    }
    document.body.classList.add('is-diagram-dragging')

    function onMove(moveEvent: MouseEvent): void {
      const drag = dragRef.current
      const canvas = canvasRef.current
      if (!drag || !canvas) return
      const canvasRect = canvas.getBoundingClientRect()
      // Divide by the zoom so the card tracks the cursor 1:1 on screen instead of
      // drifting faster than the pointer.
      const scale = zoomRef.current || 1
      const x =
        (moveEvent.clientX - canvasRect.left + canvas.scrollLeft) / scale - drag.offsetX
      const y =
        (moveEvent.clientY - canvasRect.top + canvas.scrollTop) / scale - drag.offsetY
      const position = clampPosition(x, y)
      setNodes((prev) =>
        prev.map((item) => (item.key === drag.key ? { ...item, ...position } : item))
      )
    }

    function onUp(): void {
      document.body.classList.remove('is-diagram-dragging')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const draggedKey = dragRef.current?.key
      dragRef.current = null
      setNodes((current) => {
        // Dropping on top of another card is not allowed; the card is pushed
        // down until it is clear.
        const resolved = draggedKey ? resolveCollisions(current, draggedKey) : current
        persistPositions(resolved)
        return resolved
      })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="diagram">
      <header className="diagram__head">
        <div className="diagram__title">
          <h2>
            Diagram {database}
            {schema ? `.${schema}` : ''}
          </h2>
          <span className="muted diagram__count">
            {tr('diagram.counts', { tables: nodes.length, relations: edges.length })}
          </span>
          <span className="muted diagram__zoom-hint">
            {tr('diagram.zoomHint', {
              scroll: shortcutLabel('scroll'),
              keys: shortcutLabel('+/-')
            })}
          </span>
        </div>
        <div className="diagram__actions">
          <button
            className="btn btn--tiny btn--ghost"
            onClick={() => void load()}
            disabled={loading}
            title={tr('diagram.reload')}
          >
            <IconRefresh size={13} /> {loading ? tr('common.loading') : tr('menu.reload')}
          </button>
          <button
            className="btn btn--tiny btn--ghost"
            onClick={resetLayout}
            title={tr('diagram.resetLayout')}
          >
            {tr('diagram.autoLayout')}
          </button>
          <div className="diagram__zoom" role="group" aria-label={tr('diagram.zoom')}>
            <button
              className="diagram__zoom-btn"
              onClick={() => zoomBy(-ZOOM_STEP)}
              disabled={zoom <= MIN_ZOOM}
              title={`Perkecil (${shortcutLabel('-')})`}
              aria-label={tr('diagram.zoomOut')}
            >
              <span className="diagram__zoom-minus" />
            </button>
            <button
              className="diagram__zoom-value"
              onClick={() => setZoom(1)}
              title={`Kembali ke 100% (${shortcutLabel('0')})`}
              aria-label={tr('diagram.zoomReset', { percent: Math.round(zoom * 100) })}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              className="diagram__zoom-btn"
              onClick={() => zoomBy(ZOOM_STEP)}
              disabled={zoom >= MAX_ZOOM}
              title={`Perbesar (${shortcutLabel('+')})`}
              aria-label={tr('diagram.zoomIn')}
            >
              <IconPlus size={12} />
            </button>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={tr('diagram.close')}
            title={tr('common.close')}
          >
            <IconClose size={14} />
          </button>
        </div>
      </header>

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

      {loading ? (
        <p className="muted diagram__pad">{tr('diagram.loading')}</p>
      ) : nodes.length === 0 ? (
        <p className="muted diagram__pad">{tr('diagram.noTables')}</p>
      ) : (
        <div
          className="diagram__canvas"
          ref={canvasRef}
          // Clicking empty canvas drops the previous selection, so the colour
          // palette disappears with it.
          onMouseDown={(event) => {
            if ((event.target as HTMLElement).closest('.diagram__card')) return
            setSelected(null)
          }}
        >
          {/* The sizer reserves the scaled footprint so scrollbars match what is
              visible, while the stage keeps its natural coordinate space. */}
          <div
            className="diagram__sizer"
            style={{ width: size.width * zoom, height: size.height * zoom }}
          >
            <div
              className="diagram__stage"
              style={{
                width: size.width,
                height: size.height,
                // transform keeps the layout coordinates intact, so drag maths and
                // saved positions do not need to know about the zoom level.
                transform: `scale(${zoom})`,
                transformOrigin: '0 0'
              }}
            >
              <svg className="diagram__edges" width={size.width} height={size.height}>
                <defs>
                  {/* Arrow head marks the referenced key, so the direction of the
                    relationship is readable at a glance. */}
                  <marker
                    id="diagram-arrow"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 8 4 L 0 8 z" className="diagram__arrow" />
                  </marker>
                </defs>
                {edges.map((edge) => {
                  const from = nodes.find((n) => n.key === edge.from)
                  const to = nodes.find((n) => n.key === edge.to)
                  if (!from || !to) return null
                  // One curve per column pair so a composite key shows each
                  // mapping instead of a single generic table-to-table line.
                  const pairs = edge.fromColumns.map((column, index) => ({
                    fromColumn: column,
                    toColumn: edge.toColumns[index] ?? edge.toColumns[0] ?? column
                  }))
                  return pairs.map((pair, index) => {
                    const a = edgeAnchors(from, to, pair.fromColumn, pair.toColumn)
                    const key = `${edge.id}:${index}`
                    return (
                      <g key={key} className="diagram__edge">
                        <path d={orthogonalPath(a)} markerEnd="url(#diagram-arrow)" />
                        <title>
                          {edge.name}: {from.table.name}.{pair.fromColumn} →{' '}
                          {to.table.name}.{pair.toColumn}
                        </title>
                      </g>
                    )
                  })
                })}
              </svg>

              {dividerX !== null && (
                <div
                  className="diagram__zone-divider"
                  style={{ left: dividerX }}
                  aria-hidden="true"
                >
                  <span className="diagram__zone-label">
                    {isolatedCount} tanpa relasi
                  </span>
                </div>
              )}

              {nodes.map((node) => {
                const color = colors[node.key] ?? 'none'
                const height = cardHeight(node.table.columns.length)
                const shown = node.table.columns.slice(0, CARD_MAX_COLUMNS)
                const hidden = node.table.columns.length - shown.length
                return (
                  <div
                    key={node.key}
                    className={`diagram__card diagram__card--${color}${
                      node.isolated && color === 'none' ? ' diagram__card--isolated' : ''
                    }${selected === node.key ? ' is-selected' : ''}`}
                    style={{ left: node.x, top: node.y, width: CARD_WIDTH, height }}
                    onMouseDown={(e) => startDrag(e, node)}
                    onClick={() => setSelected(node.key)}
                    onDoubleClick={() =>
                      setEditing({
                        connectionId,
                        database: node.table.database,
                        schema: node.table.schema,
                        table: node.table.name,
                        engine,
                        color: colors[node.key] ?? 'none',
                        onColorChange: (next) => setColor(node.key, next)
                      })
                    }
                    title={tr('diagram.editHint', { table: node.table.name })}
                  >
                    <div className="diagram__card-head">
                      <span className="diagram__card-name">{node.table.name}</span>
                      <button
                        className="diagram__card-edit"
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditing({
                            connectionId,
                            database: node.table.database,
                            schema: node.table.schema,
                            table: node.table.name,
                            engine,
                            color: colors[node.key] ?? 'none',
                            onColorChange: (next) => setColor(node.key, next)
                          })
                        }}
                        title={tr('diagram.editTable')}
                        aria-label={`Edit ${node.table.name}`}
                      >
                        <IconPlus size={12} />
                      </button>
                    </div>
                    <ul className="diagram__columns">
                      {shown.map((column) => (
                        <li key={column.name} className="diagram__column">
                          <span className="diagram__column-name" title={column.name}>
                            {column.isPrimaryKey && (
                              <span className="diagram__pk">PK</span>
                            )}
                            {column.name}
                          </span>
                          <span className="diagram__column-type" title={column.dataType}>
                            {column.dataType}
                          </span>
                        </li>
                      ))}
                      {hidden > 0 && (
                        <li className="diagram__column diagram__column--more">
                          +{hidden} kolom lain
                        </li>
                      )}
                    </ul>
                    {selected === node.key && (
                      <div
                        className="diagram__palette"
                        role="group"
                        aria-label={tr('diagram.tableColor')}
                      >
                        {DIAGRAM_COLORS.map((option) => (
                          <button
                            key={option}
                            className={`diagram__swatch diagram__swatch--${option}${
                              color === option ? ' is-active' : ''
                            }`}
                            onClick={(e) => {
                              e.stopPropagation()
                              setColor(node.key, option)
                            }}
                            aria-label={`Warna ${option}`}
                            title={option === 'none' ? tr('conn.noColor') : option}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {editing && (
        <TableQuickEdit
          target={editing}
          onClose={() => setEditing(null)}
          onApplied={() => {
            setNotice(tr('diagram.saved'))
            // A successful save means the previous failure no longer applies.
            setError(null)
            void load()
          }}
          onError={(message) => {
            // The dialog shows the message inline; forwarding it to the app
            // banner as well would leave a stale error after a later success.
            setError(message)
          }}
        />
      )}
    </div>
  )
}
