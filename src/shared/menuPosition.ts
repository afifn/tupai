// Placement of a floating menu (context menu, overflow menu) inside the window.
//
// Pure on purpose: the renderer measures the real box, and this decides where
// it may go. Measuring matters because a menu's height is not a function of its
// item count: separators, padding, and labels that wrap to a second line are
// all part of it, so a per-item guess lets the last entries fall outside the
// window where they cannot be clicked.

export interface MenuSize {
  width: number
  height: number
}

export interface MenuOffset {
  left: number
  top: number
}

/**
 * Offset for a menu opened at `x`/`y`, pulled back inside the viewport.
 *
 * The menu opens at the pointer when it fits. Near an edge it slides up or
 * left, the way a native menu does, instead of being clipped. A menu taller or
 * wider than the window is pinned to the margin; the caller caps its height so
 * the rest can be scrolled rather than lost.
 */
export function placeMenu(
  x: number,
  y: number,
  size: MenuSize,
  viewport: MenuSize,
  margin = 8
): MenuOffset {
  const maxLeft = Math.max(margin, viewport.width - size.width - margin)
  const maxTop = Math.max(margin, viewport.height - size.height - margin)
  return {
    left: Math.min(Math.max(margin, x), maxLeft),
    top: Math.min(Math.max(margin, y), maxTop)
  }
}
