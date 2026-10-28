import { describe, expect, it } from 'vitest'
import { placeMenu } from '@shared/menuPosition'

const VIEWPORT = { width: 1000, height: 700 }

describe('placeMenu', () => {
  it('opens at the pointer when the menu fits', () => {
    expect(placeMenu(120, 200, { width: 220, height: 160 }, VIEWPORT)).toEqual({
      left: 120,
      top: 200
    })
  })

  it('slides up when the pointer is near the bottom edge', () => {
    const menu = { width: 220, height: 230 }
    // Right-click at y=680 in a 700px window: only 20px is left, so the menu
    // has to move up by its own height instead of hanging off the window.
    const placed = placeMenu(120, 680, menu, VIEWPORT)
    expect(placed.top).toBe(VIEWPORT.height - menu.height - 8)
    expect(placed.top + menu.height).toBeLessThanOrEqual(VIEWPORT.height)
  })

  it('slides left when the pointer is near the right edge', () => {
    const menu = { width: 240, height: 120 }
    const placed = placeMenu(950, 100, menu, VIEWPORT)
    expect(placed.left).toBe(VIEWPORT.width - menu.width - 8)
  })

  it('keeps a small margin instead of touching the edge', () => {
    const placed = placeMenu(0, 0, { width: 200, height: 100 }, VIEWPORT)
    expect(placed).toEqual({ left: 8, top: 8 })
  })

  it('pins a menu bigger than the window to the margin', () => {
    const placed = placeMenu(400, 400, { width: 1200, height: 900 }, VIEWPORT)
    expect(placed).toEqual({ left: 8, top: 8 })
  })

  it('never returns a negative offset in a tiny window', () => {
    const placed = placeMenu(
      50,
      50,
      { width: 300, height: 400 },
      { width: 120, height: 90 }
    )
    expect(placed.left).toBeGreaterThanOrEqual(8)
    expect(placed.top).toBeGreaterThanOrEqual(8)
  })
})
