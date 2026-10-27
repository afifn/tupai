import { describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@shared/types'
import { createOracleAdapter } from '../src/main/drivers/oracle'

type Adapter = ReturnType<typeof createOracleAdapter>

interface Call {
  sql: string
  binds?: Record<string, unknown>
}

// The adapter never opens a connection here. The private connection is replaced
// with a recorder, and capabilities are pre-seeded so listColumns does not probe
// the server through the same fake.
function makeAdapter(rows: unknown[][] = []): {
  adapter: Adapter
  calls: Call[]
} {
  const adapter = createOracleAdapter('oracle')
  const calls: Call[] = []
  const internals = adapter as unknown as {
    connection: {
      execute: (
        sql: string,
        binds?: Record<string, unknown>
      ) => Promise<{ rows: unknown[][] }>
    }
    config: ConnectionConfig
    capabilities: { identityColumn: boolean; modernPaging: boolean }
  }
  internals.config = { user: 'scott' } as ConnectionConfig
  internals.capabilities = { identityColumn: false, modernPaging: false }
  internals.connection = {
    execute: async (sql, binds) => {
      calls.push({ sql, binds })
      return { rows }
    }
  }
  return { adapter, calls }
}

describe('Oracle catalog lookups keep the quoted name', () => {
  it('loads columns for a lower-case table instead of folding it to upper case', async () => {
    const { adapter, calls } = makeAdapter([
      ['id', 'NUMBER', 22, 10, 0, 'N', null, 'NO', null, 'Y'],
      ['name', 'VARCHAR2', 50, null, null, 'Y', null, 'NO', null, 'N']
    ])

    const columns = await adapter.listColumns('ORCL', 'orders', 'SCOTT')

    expect(calls).toHaveLength(1)
    expect(calls[0].binds).toEqual({ owner: 'SCOTT', tbl: 'orders' })
    expect(columns.map((c) => c.name)).toEqual(['id', 'name'])
    expect(columns[0].isPrimaryKey).toBe(true)
  })

  it('reads the primary key with the exact table name', async () => {
    const { adapter, calls } = makeAdapter()
    await adapter.getPrimaryKey('ORCL', 'orders', 'SCOTT')
    expect(calls[0].binds).toEqual({ owner: 'SCOTT', tbl: 'orders' })
  })

  it('reads indexes with the exact table name', async () => {
    const { adapter, calls } = makeAdapter()
    await adapter.listIndexes('ORCL', 'orders', 'SCOTT')
    expect(calls[0].binds).toEqual({ owner: 'SCOTT', tbl: 'orders' })
  })

  it('reads foreign keys with the exact table name', async () => {
    const { adapter, calls } = makeAdapter()
    await adapter.listForeignKeys('ORCL', 'orders', 'SCOTT')
    expect(calls[0].binds).toEqual({ owner: 'SCOTT', tbl: 'orders' })
  })

  it('reads table stats and DDL with the exact table name', async () => {
    const { adapter, calls } = makeAdapter()
    await adapter.getTableInfo('ORCL', 'orders', 'SCOTT')
    await adapter.getTableDdl('ORCL', 'orders', 'SCOTT')
    expect(calls.map((c) => c.binds)).toEqual([
      { owner: 'SCOTT', tbl: 'orders' },
      { owner: 'SCOTT', tbl: 'orders' }
    ])
  })

  it('reads a lower-case view definition with the exact name', async () => {
    const { adapter, calls } = makeAdapter()
    await adapter.getViewDefinition('ORCL', 'recent_orders', 'SCOTT')
    expect(calls[0].binds).toEqual({ owner: 'SCOTT', view: 'recent_orders' })
  })

  it('does not upper-case a quoted lower-case owner', async () => {
    const { adapter, calls } = makeAdapter()
    await adapter.listTables('scott')
    expect(calls[0].binds).toEqual({ owner: 'scott' })
  })

  it('searches names case-insensitively so quoted lower-case objects match', async () => {
    const { adapter, calls } = makeAdapter()
    await adapter.searchObjects('ORCL', 'orders', 'SCOTT')
    expect(calls[0].sql).toContain('UPPER(table_name) LIKE :term')
    expect(calls[0].sql).toContain('UPPER(view_name) LIKE :term')
    expect(calls[1].sql).toContain('UPPER(column_name) LIKE :term')
    expect(calls[2].sql).toContain('UPPER(object_name) LIKE :term')
  })

  it('reads a lower-case routine body with the exact name', async () => {
    const { adapter, calls } = makeAdapter()
    await adapter.getRoutineDefinition('ORCL', 'sync_orders', 'procedure', 'SCOTT')
    expect(calls[0].binds).toEqual({
      type: 'PROCEDURE',
      name: 'sync_orders',
      owner: 'SCOTT'
    })
    expect(calls[1].binds).toEqual({ owner: 'SCOTT', name: 'sync_orders' })
  })
})
