export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/**
 * Position for a child window centered over its parent, kept inside the usable
 * work area so the title bar can never land under a menu bar or off-screen.
 */
export function centerWindowBounds(
  parent: Rect,
  size: Size,
  workArea: Rect
): { x: number; y: number } {
  const centeredX = Math.round(parent.x + (parent.width - size.width) / 2)
  const centeredY = Math.round(parent.y + (parent.height - size.height) / 2)
  const maxX = workArea.x + Math.max(0, workArea.width - size.width)
  const maxY = workArea.y + Math.max(0, workArea.height - size.height)
  return {
    x: Math.min(Math.max(centeredX, workArea.x), maxX),
    y: Math.min(Math.max(centeredY, workArea.y), maxY)
  }
}
