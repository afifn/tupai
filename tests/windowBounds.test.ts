import { describe, expect, it } from 'vitest'
import { centerWindowBounds } from '@shared/windowBounds'

describe('centerWindowBounds', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 }

  it('centers the child over the parent', () => {
    const parent = { x: 100, y: 100, width: 1200, height: 800 }
    expect(centerWindowBounds(parent, { width: 900, height: 640 }, workArea)).toEqual({
      x: 250,
      y: 180
    })
  })

  it('keeps the window inside the work area near an edge', () => {
    const parent = { x: 0, y: 25, width: 400, height: 300 }
    expect(centerWindowBounds(parent, { width: 900, height: 640 }, workArea)).toEqual({
      x: 0,
      y: 25
    })
  })

  it('clamps a parent that sits partly outside the display', () => {
    const parent = { x: 1200, y: 700, width: 600, height: 400 }
    expect(centerWindowBounds(parent, { width: 900, height: 640 }, workArea)).toEqual({
      x: 540,
      y: 260
    })
  })
})
