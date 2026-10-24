import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  canonicalValue,
  comparableColumns,
  compareValues,
  diffRows,
  rowKey,
  valueKind,
  type DiffColumn
} from '@shared/dataDiff'

const columns: DiffColumn[] = [
  { name: 'id', dataType: 'integer' },
  { name: 'name', dataType: 'varchar(50)' },
  { name: 'active', dataType: 'boolean' },
  { name: 'score', dataType: 'numeric(10,2)' }
]

describe('valueKind', () => {
  it('classifies engine-specific type names', () => {
    expect(valueKind('boolean')).toBe('boolean')
    expect(valueKind('TINYINT(1)')).toBe('boolean')
    expect(valueKind('integer')).toBe('number')
    expect(valueKind('NUMBER(10,2)')).toBe('number')
    expect(valueKind('timestamp with time zone')).toBe('datetime')
    expect(valueKind('datetime')).toBe('datetime')
    expect(valueKind('date')).toBe('date')
    expect(valueKind('bytea')).toBe('binary')
    expect(valueKind('jsonb')).toBe('json')
    expect(valueKind('varchar(20)')).toBe('text')
  })
})

describe('canonicalValue', () => {
  it('treats MySQL 1 and Postgres true as the same boolean', () => {
    expect(canonicalValue(true, 'boolean')).toBe(canonicalValue(1, 'boolean'))
    expect(canonicalValue('t', 'boolean')).toBe(canonicalValue('true', 'boolean'))
    expect(canonicalValue(false, 'boolean')).toBe(canonicalValue(0, 'boolean'))
    expect(canonicalValue('yes', 'boolean')).toBe(canonicalValue(1, 'boolean'))
  })

  it('normalises decimal text without floating point rounding', () => {
    expect(canonicalValue('0010.500', 'number')).toBe(canonicalValue('10.5', 'number'))
    expect(canonicalValue(10.5, 'number')).toBe(canonicalValue('10.50', 'number'))
    expect(canonicalValue('-0', 'number')).toBe('0')
    // 30 significant digits: Number() would collapse these into one value.
    expect(canonicalValue('123456789012345678901234567890', 'number')).not.toBe(
      canonicalValue('123456789012345678901234567891', 'number')
    )
  })

  it('keeps NULL distinct from the string null', () => {
    expect(canonicalValue(null, 'text')).toBeNull()
    expect(canonicalValue('null', 'text')).toBe('null')
    expect(canonicalValue(null, 'text')).not.toBe(canonicalValue('null', 'text'))
  })

  it('normalises the T separator and trailing Z in timestamps', () => {
    expect(canonicalValue('2024-01-02T03:04:05Z', 'datetime')).toBe(
      canonicalValue('2024-01-02 03:04:05', 'datetime')
    )
  })

  it('compares JSON objects regardless of key order', () => {
    expect(canonicalValue('{"a":1,"b":2}', 'json')).toBe(canonicalValue({ b: 2, a: 1 }, 'json'))
    expect(canonicalValue('{"a":1}', 'json')).not.toBe(canonicalValue('{"a":2}', 'json'))
  })

  it('compares binary as hex', () => {
    expect(canonicalValue(new Uint8Array([1, 2, 255]), 'binary')).toBe('0102ff')
    expect(canonicalValue('\\x0102ff', 'binary')).toBe('0102ff')
  })
})

describe('compareValues', () => {
  it('recognises equal values across driver shapes', () => {
    expect(compareValues(1, true, 'boolean')).toBe(true)
    expect(compareValues('12.30', 12.3, 'number')).toBe(true)
    expect(compareValues('2024-01-01', '2024-01-01', 'date')).toBe(true)
  })

  it('reports different values', () => {
    expect(compareValues('a', 'b', 'text')).toBe(false)
    expect(compareValues(1, 2, 'number')).toBe(false)
    expect(compareValues(null, '', 'text')).toBe(false)
  })
})

describe('rowKey', () => {
  it('builds a stable composite key', () => {
    const key = rowKey({ a: 1, b: 'x' }, ['a', 'b'], [
      { name: 'a', dataType: 'int' },
      { name: 'b', dataType: 'text' }
    ])
    expect(key).toBe(rowKey({ a: 1, b: 'x' }, ['a', 'b'], [
      { name: 'a', dataType: 'int' },
      { name: 'b', dataType: 'text' }
    ]))
  })

  it('does not confuse a null part with the text "null"', () => {
    const cols: DiffColumn[] = [
      { name: 'a', dataType: 'text' },
      { name: 'b', dataType: 'text' }
    ]
    expect(rowKey({ a: null, b: 'x' }, ['a', 'b'], cols)).not.toBe(
      rowKey({ a: 'null', b: 'x' }, ['a', 'b'], cols)
    )
  })
})

describe('comparableColumns', () => {
  it('keeps only columns present on both sides', () => {
    const result = comparableColumns(
      [
        { name: 'id', dataType: 'integer' },
        { name: 'source_only', dataType: 'text' }
      ],
      [
        { name: 'ID', dataType: 'int' },
        { name: 'target_only', dataType: 'text' }
      ]
    )
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('id')
  })
})

describe('diffRows', () => {
  const sourceRows = [
    { id: 1, name: 'alpha', active: true, score: '10.50' },
    { id: 2, name: 'beta', active: false, score: '20.00' },
    { id: 3, name: 'gamma', active: true, score: null }
  ]
  const targetRows = [
    { id: 1, name: 'alpha', active: 1, score: 10.5 },
    { id: 2, name: 'BETA', active: 0, score: '20.00' },
    { id: 4, name: 'delta', active: 1, score: '5.00' }
  ]
  const base = {
    sourceRows,
    targetRows,
    columns,
    primaryKeys: ['id']
  }

  it('classifies inserts, updates, deletes and unchanged rows', () => {
    const diff = diffRows({
      ...base,
      options: { insertMissing: true, updateDifferent: true, deleteExtra: true }
    })
    expect(diff.inserts).toEqual([{ id: 3, name: 'gamma', active: true, score: null }])
    expect(diff.updates).toEqual([
      { primaryKeys: { id: 2 }, changes: { name: 'beta' } }
    ])
    expect(diff.deletes).toEqual([{ id: 4 }])
    // id=1 differs only in how the driver spelled boolean and decimal values.
    expect(diff.unchanged).toBe(1)
    expect(diff.duplicateKeys).toEqual([])
  })

  it('honours each option independently', () => {
    const noInsert = diffRows({
      ...base,
      options: { insertMissing: false, updateDifferent: true, deleteExtra: false }
    })
    expect(noInsert.inserts).toHaveLength(0)
    expect(noInsert.updates).toHaveLength(1)
    expect(noInsert.deletes).toHaveLength(0)

    const noUpdate = diffRows({
      ...base,
      options: { insertMissing: true, updateDifferent: false, deleteExtra: false }
    })
    expect(noUpdate.updates).toHaveLength(0)
    expect(noUpdate.unchanged).toBe(2)

    const nothing = diffRows({
      ...base,
      options: { insertMissing: false, updateDifferent: false, deleteExtra: false }
    })
    expect(nothing.inserts).toHaveLength(0)
    expect(nothing.updates).toHaveLength(0)
    expect(nothing.deletes).toHaveLength(0)
  })

  it('never writes primary key columns as an update', () => {
    const diff = diffRows({
      sourceRows: [{ id: 1, name: 'x', active: true, score: null }],
      targetRows: [{ id: 1, name: 'y', active: 1, score: null }],
      columns,
      primaryKeys: ['id'],
      options: { insertMissing: true, updateDifferent: true, deleteExtra: true }
    })
    expect(diff.updates[0].changes).not.toHaveProperty('id')
  })

  it('supports composite primary keys', () => {
    const cols: DiffColumn[] = [
      { name: 'tenant', dataType: 'text' },
      { name: 'id', dataType: 'int' },
      { name: 'label', dataType: 'text' }
    ]
    const diff = diffRows({
      sourceRows: [
        { tenant: 'a', id: 1, label: 'one' },
        { tenant: 'b', id: 1, label: 'two' }
      ],
      targetRows: [{ tenant: 'a', id: 1, label: 'old' }],
      columns: cols,
      primaryKeys: ['tenant', 'id'],
      options: { insertMissing: true, updateDifferent: true, deleteExtra: true }
    })
    expect(diff.updates).toEqual([
      { primaryKeys: { tenant: 'a', id: 1 }, changes: { label: 'one' } }
    ])
    expect(diff.inserts).toEqual([{ tenant: 'b', id: 1, label: 'two' }])
  })

  it('reports duplicate keys instead of updating ambiguously', () => {
    const diff = diffRows({
      sourceRows: [
        { id: 1, name: 'first', active: true, score: null },
        { id: 1, name: 'second', active: true, score: null }
      ],
      targetRows: [],
      columns,
      primaryKeys: ['id'],
      options: { insertMissing: true, updateDifferent: true, deleteExtra: true }
    })
    expect(diff.inserts).toHaveLength(1)
    expect(diff.duplicateKeys).toHaveLength(1)
  })

  it('treats an empty target as all inserts', () => {
    const diff = diffRows({
      ...base,
      targetRows: [],
      options: { insertMissing: true, updateDifferent: true, deleteExtra: false }
    })
    expect(diff.inserts).toHaveLength(3)
    expect(diff.deletes).toHaveLength(0)
  })

  it('treats an empty source as all deletes when enabled', () => {
    const diff = diffRows({
      ...base,
      sourceRows: [],
      options: { insertMissing: true, updateDifferent: true, deleteExtra: true }
    })
    expect(diff.inserts).toHaveLength(0)
    expect(diff.deletes).toHaveLength(3)
  })

  it('compares JSON columns structurally', () => {
    const diff = diffRows({
      sourceRows: [{ id: 1, doc: { b: 2, a: 1 } }],
      targetRows: [{ id: 1, doc: '{"a":1,"b":2}' }],
      columns: [
        { name: 'id', dataType: 'integer' },
        { name: 'doc', dataType: 'jsonb' }
      ],
      primaryKeys: ['id'],
      options: { insertMissing: true, updateDifferent: true, deleteExtra: false }
    })
    expect(diff.updates).toHaveLength(0)
    expect(diff.unchanged).toBe(1)
  })

  it('does not report a change for equal timestamps spelled differently', () => {
    const diff = diffRows({
      sourceRows: [{ id: 1, at: '2024-05-06T07:08:09Z' }],
      targetRows: [{ id: 1, at: '2024-05-06 07:08:09' }],
      columns: [
        { name: 'id', dataType: 'integer' },
        { name: 'at', dataType: 'timestamptz' }
      ],
      primaryKeys: ['id'],
      options: { insertMissing: true, updateDifferent: true, deleteExtra: false }
    })
    expect(diff.unchanged).toBe(1)
  })
})

describe('canonicalJson', () => {
  it('sorts keys recursively', () => {
    expect(canonicalJson({ b: { d: 4, c: 3 }, a: 1 })).toBe('{"a":1,"b":{"c":3,"d":4}}')
  })

  it('handles null and arrays', () => {
    expect(canonicalJson([1, null, 'x'])).toBe('[1,null,"x"]')
    expect(canonicalJson(null)).toBe('null')
  })
})
