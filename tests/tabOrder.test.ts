import { describe, expect, it } from 'vitest'
import { moveItem } from '../src/shared/tabOrder'

describe('moveItem', () => {
  it('moves an item earlier without changing the other items', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moves an item later without changing the other items', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('returns a copy when the indexes are equal or invalid', () => {
    const items = ['a', 'b']
    expect(moveItem(items, 1, 1)).toEqual(items)
    expect(moveItem(items, -1, 1)).toEqual(items)
    expect(moveItem(items, 0, 4)).toEqual(items)
    expect(moveItem(items, 1, 1)).not.toBe(items)
  })
})
