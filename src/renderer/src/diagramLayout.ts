import type { ColumnInfo, ForeignKeyInfo } from '@shared/types'

export interface DiagramTable {
  database: string
  schema?: string
  name: string
  columns: ColumnInfo[]
  foreignKeys: ForeignKeyInfo[]
}

export interface DiagramNode {
  key: string
  table: DiagramTable
  x: number
  y: number
  // True when the table has no relationship to anything else in the diagram.
  // Those cards are parked in their own zone on the right.
  isolated: boolean
}

export interface DiagramEdge {
  id: string
  from: string
  to: string
  fromColumns: string[]
  toColumns: string[]
  // Used for the label and for stable ordering.
  name: string
}

export const CARD_WIDTH = 240
export const CARD_HEADER = 30
export const CARD_ROW = 22
export const CARD_MAX_COLUMNS = 12
export const GRID_GAP_X = 60
export const GRID_GAP_Y = 40
export const CANVAS_PADDING = 32

// Colours are named so the stored value stays readable and a theme change can
// map the same name to a different shade.
export const DIAGRAM_COLORS = [
  'none',
  'slate',
  'blue',
  'teal',
  'green',
  'amber',
  'orange',
  'rose',
  'violet'
] as const

export type DiagramColor = (typeof DIAGRAM_COLORS)[number]

export function tableNodeKey(table: { database: string; schema?: string; name: string }): string {
  return `${table.database}::${table.schema ?? ''}::${table.name}`.toLowerCase()
}

export function cardHeight(columnCount: number): number {
  const shown = Math.min(columnCount, CARD_MAX_COLUMNS)
  return CARD_HEADER + shown * CARD_ROW + (columnCount > CARD_MAX_COLUMNS ? CARD_ROW : 0) + 8
}

const COLUMN_GAP = 72
const ROW_GAP = 40
// Extra space between the connected zone and the isolated zone, wide enough to
// hold the divider and its label.
const ZONE_GAP = 150

// Stacks cards in columns using their real heights, so no two cards can overlap
// regardless of how many columns each table has.
function packZone(
  tables: DiagramTable[],
  startX: number,
  isolated: boolean
): DiagramNode[] {
  if (tables.length === 0) return []
  const perColumn = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(tables.length))))
  const columnY: number[] = []
  return tables.map((table, index) => {
    const column = Math.floor(index / perColumn)
    const y = columnY[column] ?? CANVAS_PADDING
    columnY[column] = y + cardHeight(Math.max(1, table.columns.length)) + ROW_GAP
    return {
      key: tableNodeKey(table),
      table,
      x: startX + column * (CARD_WIDTH + COLUMN_GAP),
      y,
      isolated
    }
  })
}

// Columns actually used by packZone, so the zone width never reserves space for
// an empty column (which used to push the isolated zone off screen).
function zoneColumnCount(count: number): number {
  if (count === 0) return 0
  const perColumn = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(count))))
  return Math.ceil(count / perColumn)
}

// Places related tables first, then parks tables with no relationship in a
// separate zone to the right. Ordering inside each zone is by name so repeated
// opens look the same.
export function autoLayout(tables: DiagramTable[]): DiagramNode[] {
  const edges = buildEdges(tables)
  const related = new Set<string>()
  for (const edge of edges) {
    related.add(edge.from)
    related.add(edge.to)
  }
  const byName = [...tables].sort((a, b) => a.name.localeCompare(b.name))
  const connected = byName.filter((table) => related.has(tableNodeKey(table)))
  const isolated = byName.filter((table) => !related.has(tableNodeKey(table)))

  const nodes = packZone(connected, CANVAS_PADDING, false)
  const connectedWidth =
    zoneColumnCount(connected.length) * (CARD_WIDTH + COLUMN_GAP)
  const isolatedStart =
    CANVAS_PADDING +
    connectedWidth +
    (connected.length > 0 && isolated.length > 0 ? ZONE_GAP : 0)
  return [...nodes, ...packZone(isolated, isolatedStart, true)]
}

// Width of the connected zone, used to draw the divider between zones.
export function zoneDividerX(nodes: DiagramNode[]): number | null {
  const connected = nodes.filter((node) => !node.isolated)
  const isolated = nodes.filter((node) => node.isolated)
  if (connected.length === 0 || isolated.length === 0) return null
  const connectedRight = Math.max(
    ...connected.map((node) => node.x + CARD_WIDTH)
  )
  const isolatedLeft = Math.min(...isolated.map((node) => node.x))
  return Math.round((connectedRight + isolatedLeft) / 2)
}

// Only edges whose both ends are visible in the diagram are drawn, so a table
// that references something outside the selected database does not produce a
// line pointing at nothing.
export function buildEdges(tables: DiagramTable[]): DiagramEdge[] {
  const present = new Set(tables.map(tableNodeKey))
  const edges: DiagramEdge[] = []
  for (const table of tables) {
    const from = tableNodeKey(table)
    for (const fk of table.foreignKeys) {
      const target: DiagramTable | undefined = tables.find(
        (candidate) =>
          candidate.name.toLowerCase() === fk.refTable.toLowerCase() &&
          (fk.refSchema ? (candidate.schema ?? '').toLowerCase() === fk.refSchema.toLowerCase() : true)
      )
      if (!target) continue
      const to = tableNodeKey(target)
      if (!present.has(to)) continue
      edges.push({
        id: `${from}->${to}:${fk.name}`,
        from,
        to,
        fromColumns: fk.columns,
        toColumns: fk.refColumns,
        name: fk.name
      })
    }
  }
  return edges
}

// Y centre of one column row inside a card. Columns beyond the visible limit
// fall back to the card centre so the line still lands on the table.
export function columnAnchorY(node: DiagramNode, column: string): number {
  const shown = node.table.columns.slice(0, CARD_MAX_COLUMNS)
  const index = shown.findIndex(
    (candidate) => candidate.name.toLowerCase() === column.toLowerCase()
  )
  if (index < 0) {
    return node.y + cardHeight(node.table.columns.length) / 2
  }
  return node.y + CARD_HEADER + index * CARD_ROW + CARD_ROW / 2
}

export interface EdgeAnchor {
  x1: number
  y1: number
  x2: number
  y2: number
  // A self-reference loops out of the right edge and back into it.
  self: boolean
  // Which pair of edges the line connects: left/right or top/bottom.
  orientation: 'horizontal' | 'vertical'
}

// Anchors land on the actual key rows, so a line reads "this column connects to
// that column" instead of merely joining two cards. When two cards sit in the
// same column, the line leaves from the bottom and re-enters at the top;
// otherwise it leaves from the facing side edges.
export function edgeAnchors(
  from: DiagramNode,
  to: DiagramNode,
  fromColumn: string,
  toColumn: string
): EdgeAnchor {
  const y1 = columnAnchorY(from, fromColumn)
  const y2 = columnAnchorY(to, toColumn)
  if (from.key === to.key) {
    const x = from.x + CARD_WIDTH
    return { x1: x, y1, x2: x, y2, self: true, orientation: 'horizontal' }
  }
  const fromHeight = cardHeight(from.table.columns.length)
  const toHeight = cardHeight(to.table.columns.length)
  const fromCx = from.x + CARD_WIDTH / 2
  const toCx = to.x + CARD_WIDTH / 2
  const horizontalDistance = Math.abs(toCx - fromCx)
  const verticallyStacked = horizontalDistance < CARD_WIDTH * 0.75

  if (verticallyStacked) {
    const goingDown = to.y >= from.y
    return {
      x1: fromCx,
      y1: goingDown ? from.y + fromHeight : from.y,
      x2: toCx,
      y2: goingDown ? to.y : to.y + toHeight,
      self: false,
      orientation: 'vertical'
    }
  }

  const toRight = toCx > fromCx
  return {
    x1: toRight ? from.x + CARD_WIDTH : from.x,
    y1,
    x2: toRight ? to.x : to.x + CARD_WIDTH,
    y2,
    self: false,
    orientation: 'horizontal'
  }
}

// Pushes a dragged card down until it no longer covers another card, so a drop
// can never leave two tables stacked on top of each other.
export function resolveCollisions(nodes: DiagramNode[], movedKey: string): DiagramNode[] {
  const moved = nodes.find((node) => node.key === movedKey)
  if (!moved) return nodes
  const others = nodes.filter((node) => node.key !== movedKey)
  let y = moved.y
  let shifted = true
  let guard = 0
  while (shifted && guard < 64) {
    shifted = false
    guard += 1
    for (const other of others) {
      const movedBottom = y + cardHeight(moved.table.columns.length)
      const otherBottom = other.y + cardHeight(other.table.columns.length)
      const overlapsX =
        moved.x < other.x + CARD_WIDTH && moved.x + CARD_WIDTH > other.x
      const overlapsY = y < otherBottom && movedBottom > other.y
      if (overlapsX && overlapsY) {
        y = otherBottom + 16
        shifted = true
      }
    }
  }
  const clamped = clampPosition(moved.x, y)
  return nodes.map((node) =>
    node.key === movedKey ? { ...node, x: clamped.x, y: clamped.y } : node
  )
}

// Pushes cards down inside one zone until nothing collides. The zone's left
// edge is fixed, so cards keep their columns.
function normalizeZone(nodes: DiagramNode[]): DiagramNode[] {
  const order = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)
  const placed: DiagramNode[] = []
  for (const node of order) {
    let candidate = { ...node }
    let guard = 0
    let moved = true
    while (moved && guard < 256) {
      moved = false
      guard += 1
      for (const other of placed) {
        const height = cardHeight(candidate.table.columns.length)
        const otherHeight = cardHeight(other.table.columns.length)
        const overlapsX =
          candidate.x < other.x + CARD_WIDTH &&
          candidate.x + CARD_WIDTH > other.x
        const overlapsY =
          candidate.y < other.y + otherHeight &&
          candidate.y + height > other.y
        if (overlapsX && overlapsY) {
          candidate = { ...candidate, y: other.y + otherHeight + 16 }
          moved = true
        }
      }
    }
    placed.push(candidate)
  }
  return placed
}

// Normalises a whole layout, not just one dragged card. Stored positions can
// overlap when tables were added since the layout was saved, or when the layout
// came from an older version that used a uniform grid. Cards are visited top to
// bottom and pushed down until nothing collides, which keeps the user's rough
// arrangement while guaranteeing no stacking on open.
//
// The two zones are normalised separately and the isolated zone is shifted to
// the right of every connected card, so a stale layout can never mix unrelated
// tables back into the related group.
export function normalizeLayout(nodes: DiagramNode[]): DiagramNode[] {
  const connected = nodes.filter((node) => !node.isolated)
  const isolated = nodes.filter((node) => node.isolated)

  const placedConnected = normalizeZone(connected)
  const connectedRight =
    placedConnected.length > 0
      ? Math.max(...placedConnected.map((node) => node.x + CARD_WIDTH))
      : CANVAS_PADDING
  const isolatedFloor =
    placedConnected.length > 0 ? connectedRight + ZONE_GAP : CANVAS_PADDING

  const placedIsolated = normalizeZone(
    isolated.map((node) => ({ ...node, x: Math.max(node.x, isolatedFloor) }))
  )

  return [...placedConnected, ...placedIsolated]
}

// Builds an orthogonal (right-angle) path between two anchors. Relationships are
// read as wiring, so straight segments with square corners are clearer than a
// curve that reads like a loose thread.
export function orthogonalPath(a: EdgeAnchor): string {
  const round = (value: number): number => Math.round(value)

  if (a.self) {
    // Loop out of the right edge and back into it.
    const out = round(a.x1 + 44)
    const midY = round((a.y1 + a.y2) / 2)
    return [
      `M ${round(a.x1)} ${round(a.y1)}`,
      `L ${out} ${round(a.y1)}`,
      `L ${out} ${midY}`,
      `L ${round(a.x2)} ${midY}`,
      `L ${round(a.x2)} ${round(a.y2)}`
    ].join(' ')
  }

  // Vertical neighbours: leave from the bottom/top edge and step across once.
  if (a.orientation === 'vertical') {
    const midY = round((a.y1 + a.y2) / 2)
    return [
      `M ${round(a.x1)} ${round(a.y1)}`,
      `L ${round(a.x1)} ${midY}`,
      `L ${round(a.x2)} ${midY}`,
      `L ${round(a.x2)} ${round(a.y2)}`
    ].join(' ')
  }

  // Side-by-side cards: a single elbow halfway between the facing edges.
  const midX = round((a.x1 + a.x2) / 2)
  return [
    `M ${round(a.x1)} ${round(a.y1)}`,
    `L ${midX} ${round(a.y1)}`,
    `L ${midX} ${round(a.y2)}`,
    `L ${round(a.x2)} ${round(a.y2)}`
  ].join(' ')
}

export interface StoredDiagram {
  positions: Record<string, { x: number; y: number }>
  colors: Record<string, DiagramColor>
}

export function readStoredDiagram(raw: string | null): StoredDiagram {
  if (!raw) return { positions: {}, colors: {} }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredDiagram>
    const positions: Record<string, { x: number; y: number }> = {}
    for (const [key, value] of Object.entries(parsed.positions ?? {})) {
      if (
        value &&
        typeof value === 'object' &&
        Number.isFinite((value as { x: number }).x) &&
        Number.isFinite((value as { y: number }).y)
      ) {
        positions[key] = {
          x: Math.max(0, Math.round((value as { x: number }).x)),
          y: Math.max(0, Math.round((value as { y: number }).y))
        }
      }
    }
    const colors: Record<string, DiagramColor> = {}
    for (const [key, value] of Object.entries(parsed.colors ?? {})) {
      if (typeof value === 'string' && (DIAGRAM_COLORS as readonly string[]).includes(value)) {
        colors[key] = value as DiagramColor
      }
    }
    return { positions, colors }
  } catch {
    return { positions: {}, colors: {} }
  }
}

export function mergeStoredLayout(nodes: DiagramNode[], stored: StoredDiagram): DiagramNode[] {
  return nodes.map((node) => {
    const saved = stored.positions[node.key]
    return saved ? { ...node, x: saved.x, y: saved.y } : node
  })
}

export function canvasSize(nodes: DiagramNode[]): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const node of nodes) {
    width = Math.max(width, node.x + CARD_WIDTH + CANVAS_PADDING)
    height = Math.max(height, node.y + cardHeight(node.table.columns.length) + CANVAS_PADDING)
  }
  return { width: Math.max(width, 640), height: Math.max(height, 420) }
}

// Clamps a drag so a card can never be dropped outside the scrollable canvas.
export function clampPosition(x: number, y: number): { x: number; y: number } {
  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) }
}
