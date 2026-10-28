import { describe, expect, it } from 'vitest'
import { describeOpaque, toTransferable } from '@shared/transferable'

// A row value can be a live driver handle instead of plain data. Structured
// clone refuses functions, so posting such a response threw a DataCloneError and
// killed the whole database worker. These cases pin the behaviour that turns the
// value into a label instead.
describe('toTransferable', () => {
  it('keeps primitives, dates and bytes', () => {
    const date = new Date('2026-10-28T00:00:00.000Z')
    const bytes = new Uint8Array([1, 2, 3])
    expect(toTransferable('a')).toBe('a')
    expect(toTransferable(7)).toBe(7)
    expect(toTransferable(null)).toBeNull()
    expect(toTransferable(true)).toBe(true)
    expect(toTransferable(date)).toBe(date)
    expect(toTransferable(bytes)).toBe(bytes)
  })

  it('walks plain objects and arrays', () => {
    const value = { rows: [{ name: 'PAYROLL', size: 3 }], total: 1 }
    expect(toTransferable(value)).toEqual({
      rows: [{ name: 'PAYROLL', size: 3 }],
      total: 1
    })
  })

  it('replaces a class instance with a label', () => {
    class Lob {
      readonly type = 'CLOB'
    }
    expect(toTransferable({ value: new Lob() })).toEqual({ value: '[Lob]' })
  })

  it('replaces a function with a label', () => {
    expect(toTransferable({ cb: () => 1 })).toEqual({ cb: '[fungsi]' })
  })

  it('keeps an event emitter from being walked into its listeners', () => {
    // A LOB handle is an EventEmitter: its listeners live in own properties and
    // are functions, which is exactly what made structured clone fail.
    const handle = Object.assign(Object.create(Object.prototype), {
      _events: { close: () => undefined }
    })
    Object.setPrototypeOf(handle, class Handle {}.prototype)
    expect(toTransferable({ value: handle })).toEqual({ value: '[Handle]' })
  })

  it('stops at the depth limit instead of recursing forever', () => {
    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let i = 0; i < 20; i++) {
      cursor.next = {}
      cursor = cursor.next as Record<string, unknown>
    }
    const out = toTransferable(deep)
    expect(() => structuredClone(out)).not.toThrow()
  })

  it('produces data structuredClone accepts', () => {
    const row = {
      ID: 'abc',
      VALUE: Object.assign(Object.create(null), {}),
      HANDLE: Object.setPrototypeOf({ listeners: [() => 1] }, class L {}.prototype),
      NESTED: { when: new Date(), blob: new Uint8Array([9]) }
    }
    expect(() => structuredClone(toTransferable(row))).not.toThrow()
  })
})

describe('describeOpaque', () => {
  it('names the constructor', () => {
    class ResultSet {}
    expect(describeOpaque(new ResultSet())).toBe('[ResultSet]')
  })

  it('labels a function', () => {
    expect(describeOpaque(() => 1)).toBe('[fungsi]')
  })

  it('falls back when there is no usable name', () => {
    expect(describeOpaque(Object.create(null))).toBe('[nilai tidak bisa ditampilkan]')
  })
})
