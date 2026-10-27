import { describe, expect, it } from 'vitest'
import { oracleLimitSql, oraclePageBinds, oraclePageSql } from '@shared/oracleSql'

// Oracle 12c added the SQL standard OFFSET/FETCH syntax. Oracle 11g rejects it,
// so a driver that always emits it cannot browse a table on an old server. These
// are the two shapes it has to produce.
describe('oraclePageSql', () => {
  const select = 'SELECT * FROM users ORDER BY id'

  it('uses OFFSET/FETCH on 12c and newer', () => {
    const sql = oraclePageSql(select, { offset: 50, limit: 25 }, true)
    expect(sql).toBe(`${select} OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`)
  })

  it('wraps the query in ROWNUM filters on 11g', () => {
    const sql = oraclePageSql(select, { offset: 50, limit: 25 }, false)
    expect(sql).toContain('ROWNUM <= :lim2')
    expect(sql).toContain('WHERE rn > :off')
    // The inner query must keep its ORDER BY, or the page boundaries are random.
    expect(sql).toContain(select)
    // No 12c-only syntax may leak into the legacy shape.
    expect(sql).not.toContain('OFFSET')
    expect(sql).not.toContain('FETCH NEXT')
  })

  it('omits the outer filter on the first page of the legacy shape', () => {
    const sql = oraclePageSql(select, { offset: 0, limit: 25 }, false)
    expect(sql).not.toContain('rn >')
    expect(sql).toContain('ROWNUM <= :lim2')
  })
})

describe('oraclePageBinds', () => {
  it('binds offset and limit separately on 12c', () => {
    expect(oraclePageBinds({ offset: 10, limit: 5 }, true)).toEqual({ off: 10, lim: 5 })
  })

  it('binds the summed upper bound on 11g', () => {
    // ROWNUM filters on the inner query, so the bound is offset + limit.
    expect(oraclePageBinds({ offset: 10, limit: 5 }, false)).toEqual({
      off: 10,
      lim2: 15
    })
  })

  it('omits :off on the first page of the legacy shape', () => {
    // Oracle raises ORA-01036 for a bind the statement never mentions, and the
    // legacy SQL only adds `WHERE rn > :off` when offset > 0.
    expect(oraclePageBinds({ offset: 0, limit: 25 }, false)).toEqual({ lim2: 25 })
  })

  it('only returns binds that the generated SQL actually references', () => {
    for (const modern of [true, false]) {
      for (const offset of [0, 7, 100]) {
        const paging = { offset, limit: 25 }
        const sql = oraclePageSql('SELECT * FROM t', paging, modern)
        const binds = oraclePageBinds(paging, modern)
        const referenced = [...sql.matchAll(/:([a-z0-9_]+)/gi)].map((m) => m[1])
        expect(Object.keys(binds).sort()).toEqual([...new Set(referenced)].sort())
      }
    }
  })
})

describe('oracleLimitSql', () => {
  it('uses FETCH FIRST on 12c', () => {
    expect(oracleLimitSql('SELECT 1 FROM dual', 200, true)).toBe(
      'SELECT 1 FROM dual FETCH FIRST 200 ROWS ONLY'
    )
  })

  it('wraps in ROWNUM on 11g', () => {
    const sql = oracleLimitSql('SELECT 1 FROM dual ORDER BY 1', 200, false)
    expect(sql).toBe('SELECT * FROM (SELECT 1 FROM dual ORDER BY 1) WHERE ROWNUM <= 200')
    expect(sql).not.toContain('FETCH FIRST')
  })
})
