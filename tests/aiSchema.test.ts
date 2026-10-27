import { describe, expect, it } from 'vitest'
import { buildSchemaSummary, sortForPrompt, type SchemaTable } from '@shared/aiSchema'
import type { ColumnInfo } from '@shared/types'

function column(
  name: string,
  dataType = 'text',
  extra: Partial<ColumnInfo> = {}
): ColumnInfo {
  return {
    name,
    dataType,
    nullable: true,
    defaultValue: null,
    isPrimaryKey: false,
    autoIncrement: false,
    comment: null,
    ...extra
  } as ColumnInfo
}

function table(
  name: string,
  columns: ColumnInfo[],
  extra: Partial<SchemaTable> = {}
): SchemaTable {
  return { name, type: 'table', columns, ...extra }
}

describe('buildSchemaSummary', () => {
  it('states the engine and database before the table list', () => {
    const text = buildSchemaSummary('postgres', 'heccard_dev', [
      table('users', [column('id', 'integer', { isPrimaryKey: true })])
    ])
    expect(text).toContain('Engine: postgres')
    expect(text).toContain('Database: heccard_dev')
    expect(text).toContain('Tabel (1):')
    expect(text).toContain('- users: id integer PK')
  })

  it('marks a view and its columns', () => {
    const text = buildSchemaSummary('mysql', 'shop', [
      { name: 'v_sales', type: 'view', columns: [column('total', 'decimal')] }
    ])
    expect(text).toContain('- v_sales [view]: total decimal')
  })

  it('qualifies names with the schema on engines that have one', () => {
    const postgres = buildSchemaSummary('postgres', 'db', [
      table('orders', [], { schema: 'sales' })
    ])
    expect(postgres).toContain('- sales.orders')

    // MySQL reports the database as the schema; repeating it would be invalid.
    const mysql = buildSchemaSummary('mysql', 'shop', [
      table('orders', [], { schema: 'shop' })
    ])
    expect(mysql).toContain('- orders')
    expect(mysql).not.toContain('shop.orders')
  })

  it('says so when the database has no tables instead of an empty list', () => {
    const text = buildSchemaSummary('sqlite', 'main', [])
    expect(text).toContain('belum ada atau belum dimuat')
  })

  it('counts truncated columns so the model knows the list is partial', () => {
    const many = Array.from({ length: 50 }, (_, i) => column(`c${i}`))
    const text = buildSchemaSummary('sqlite', 'main', [table('wide', many)], {
      maxColumnsPerTable: 10
    })
    expect(text).toContain('... (40 kolom lain)')
    expect(text).not.toContain('c40')
  })

  it('names the remaining tables once the detailed budget is spent', () => {
    const tables = Array.from({ length: 5 }, (_, i) =>
      table(`t${i}`, [column('id', 'integer', { isPrimaryKey: true })])
    )
    const text = buildSchemaSummary('sqlite', 'main', tables, { maxDetailedTables: 2 })
    expect(text).toContain('- t0: id integer PK')
    expect(text).toContain('- t2')
    expect(text).not.toContain('- t2:')
  })

  it('never exceeds the character budget', () => {
    const tables = Array.from({ length: 200 }, (_, i) =>
      table(`table_${i}`, [column('id'), column('name'), column('created_at')])
    )
    const text = buildSchemaSummary('sqlite', 'main', tables, { maxChars: 800 })
    expect(text.length).toBeLessThanOrEqual(800)
    // Truncation is announced rather than silently dropping the rest.
    expect(text).toContain('tidak dimuat')
  })
})

describe('sortForPrompt', () => {
  it('puts tables before views, then orders by schema and name', () => {
    const sorted = sortForPrompt([
      { name: 'v_b', type: 'view', columns: [] },
      { name: 'b', type: 'table', columns: [], schema: 'z' },
      { name: 'a', type: 'table', columns: [], schema: 'z' },
      { name: 'c', type: 'table', columns: [], schema: 'a' }
    ])
    expect(sorted.map((t) => `${t.schema ?? ''}.${t.name}`)).toEqual([
      'a.c',
      'z.a',
      'z.b',
      '.v_b'
    ])
  })
})
