import { describe, expect, it } from 'vitest'
import {
  FILTER_OPERATORS,
  FILTER_OPERATOR_LABELS,
  operatorNeedsValue
} from '@shared/filter'

describe('filter operator labels', () => {
  it('labels every operator', () => {
    for (const op of FILTER_OPERATORS) {
      expect(FILTER_OPERATOR_LABELS[op]?.trim(), op).toBeTruthy()
    }
  })

  it('starts every value-taking label with a glyph so the list scans without reading', () => {
    // The NULL checks are not comparisons, so they have no symbol to show; they
    // read as `is NULL` instead of inventing a glyph that SQL does not use.
    for (const op of FILTER_OPERATORS.filter(operatorNeedsValue)) {
      expect(FILTER_OPERATOR_LABELS[op], op).toMatch(/^[~=!^$<>]/)
    }
  })

  it('keeps the NULL checks as IS NULL / IS NOT NULL', () => {
    expect(FILTER_OPERATOR_LABELS.isNull).toBe('is NULL')
    expect(FILTER_OPERATOR_LABELS.isNotNull).toBe('is not NULL')
  })

  it('uses the comparison symbol the SQL will emit', () => {
    expect(FILTER_OPERATOR_LABELS.equals).toMatch(/^=/)
    expect(FILTER_OPERATOR_LABELS.notEquals).toMatch(/^!=/)
    expect(FILTER_OPERATOR_LABELS.gt).toMatch(/^> /)
    expect(FILTER_OPERATOR_LABELS.gte).toMatch(/^>=/)
    expect(FILTER_OPERATOR_LABELS.lt).toMatch(/^< /)
    expect(FILTER_OPERATOR_LABELS.lte).toMatch(/^<=/)
  })

  it('keeps the names in English rather than a mix of languages', () => {
    const indonesian = /mengandung|sama dengan|tidak sama|diawali|diakhiri|lebih|kosong/i
    for (const op of FILTER_OPERATORS) {
      expect(FILTER_OPERATOR_LABELS[op], op).not.toMatch(indonesian)
    }
  })

  it('marks the text matchers distinctly from the comparisons', () => {
    expect(FILTER_OPERATOR_LABELS.contains).toMatch(/^~/)
    expect(FILTER_OPERATOR_LABELS.startsWith).toMatch(/^\^/)
    expect(FILTER_OPERATOR_LABELS.endsWith).toMatch(/^\$/)
  })

  it('tells the UI which operators need a value', () => {
    expect(operatorNeedsValue('isNull')).toBe(false)
    expect(operatorNeedsValue('isNotNull')).toBe(false)
    expect(operatorNeedsValue('equals')).toBe(true)
  })
})
