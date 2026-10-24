import { describe, expect, it } from 'vitest'
import { editableCellValue, formatCellValue, formatDateValue } from '@shared/cellValue'

// A driver returns a Date in local time; the grid must never print the JS
// toString form ("Sat Oct 24 2026 19:29:44 GMT+0700 (Western Indonesia Time)").
const stamp = new Date(2026, 9, 24, 19, 29, 44)
const midnight = new Date(2026, 9, 24, 0, 0, 0)

describe('formatDateValue', () => {
  it('formats a timestamp as date and time', () => {
    expect(formatDateValue('datetime', stamp)).toBe('2026-10-24 19:29:44')
  })

  it('formats a date column without a midnight time', () => {
    expect(formatDateValue('date', midnight)).toBe('2026-10-24')
  })

  it('formats a time column without a date', () => {
    expect(formatDateValue('time', stamp)).toBe('19:29:44')
  })

  it('keeps sub-second precision when present', () => {
    const precise = new Date(2026, 9, 24, 19, 29, 44, 123)
    expect(formatDateValue('datetime', precise)).toBe('2026-10-24 19:29:44.123')
  })
})

describe('formatCellValue', () => {
  it('formats a Date by its column type', () => {
    expect(formatCellValue(stamp, 'timestamp without time zone')).toBe(
      '2026-10-24 19:29:44'
    )
    expect(formatCellValue(stamp, 'date')).toBe('2026-10-24')
  })

  it('never returns the JavaScript date string', () => {
    for (const dataType of [undefined, 'timestamp', 'date', 'time', 'timestamptz']) {
      expect(formatCellValue(stamp, dataType)).not.toMatch(/GMT|Western Indonesia/)
    }
  })

  it('treats a midnight Date in a query result as a date', () => {
    // Query results carry no column type, and a midnight value is almost always
    // a date column.
    expect(formatCellValue(midnight)).toBe('2026-10-24')
  })

  it('keeps a non-midnight Date in a query result as a timestamp', () => {
    expect(formatCellValue(stamp)).toBe('2026-10-24 19:29:44')
  })

  it('normalises the ISO separator for stored text', () => {
    expect(formatCellValue('2026-10-24T19:29:44', 'timestamp')).toBe(
      '2026-10-24 19:29:44'
    )
  })

  it('leaves text, numbers, and booleans alone', () => {
    expect(formatCellValue('halo', 'text')).toBe('halo')
    expect(formatCellValue(42, 'int')).toBe('42')
    expect(formatCellValue(true, 'boolean')).toBe('true')
  })

  it('renders null and undefined as empty text', () => {
    expect(formatCellValue(null)).toBe('')
    expect(formatCellValue(undefined, 'timestamp')).toBe('')
  })

  it('serialises objects and summarises binary', () => {
    expect(formatCellValue({ a: 1 }, 'json')).toBe('{"a":1}')
    expect(formatCellValue(new Uint8Array([1, 2, 3]), 'bytea')).toBe('<3B>')
  })
})

describe('editableCellValue', () => {
  it('produces the value a datetime-local input expects', () => {
    expect(editableCellValue(stamp, 'timestamp')).toBe('2026-10-24T19:29')
  })

  it('produces a date-only value for a date input', () => {
    expect(editableCellValue(midnight, 'date')).toBe('2026-10-24')
  })

  it('keeps a plain string value', () => {
    expect(editableCellValue('halo', 'text')).toBe('halo')
  })

  it('keeps a boolean as the select value', () => {
    expect(editableCellValue(true, 'boolean')).toBe('true')
  })

  it('returns empty text for null', () => {
    expect(editableCellValue(null, 'timestamp')).toBe('')
  })
})
