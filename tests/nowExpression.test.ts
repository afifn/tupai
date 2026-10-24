import { describe, expect, it } from 'vitest'
import { isNowKind, nowExpression } from '@shared/nowExpression'

describe('nowExpression', () => {
  it('uses the engine function that matches the column kind', () => {
    expect(nowExpression('mysql', 'datetime')).toBe('NOW()')
    expect(nowExpression('mysql', 'date')).toBe('CURDATE()')
    expect(nowExpression('mysql', 'time')).toBe('CURTIME()')
    expect(nowExpression('postgres', 'datetime')).toBe('NOW()')
    expect(nowExpression('postgres', 'date')).toBe('CURRENT_DATE')
    expect(nowExpression('postgres', 'time')).toBe('CURRENT_TIME')
  })

  it('shares the MySQL dialect with MariaDB', () => {
    expect(nowExpression('mariadb', 'datetime')).toBe(nowExpression('mysql', 'datetime'))
  })

  it('uses the session clock on Oracle', () => {
    expect(nowExpression('oracle', 'datetime')).toBe('CURRENT_TIMESTAMP')
    expect(nowExpression('oracle', 'date')).toBe('TRUNC(CURRENT_TIMESTAMP)')
    expect(nowExpression('oracle', 'time')).toContain('HH24:MI:SS')
  })

  it('uses local time on SQLite, which has no server timezone', () => {
    expect(nowExpression('sqlite', 'datetime')).toBe("datetime('now','localtime')")
    expect(nowExpression('sqlite', 'date')).toBe("date('now','localtime')")
    expect(nowExpression('sqlite', 'time')).toBe("time('now','localtime')")
  })

  it('returns null for MongoDB, which has no SQL', () => {
    expect(nowExpression('mongodb', 'datetime')).toBeNull()
  })

  it('never returns an empty expression', () => {
    const engines = ['mysql', 'mariadb', 'postgres', 'oracle', 'sqlite'] as const
    for (const engine of engines) {
      for (const kind of ['date', 'datetime', 'time'] as const) {
        expect(nowExpression(engine, kind)?.trim()).toBeTruthy()
      }
    }
  })
})

describe('isNowKind', () => {
  it('accepts the three date-like kinds', () => {
    expect(isNowKind('date')).toBe(true)
    expect(isNowKind('datetime')).toBe(true)
    expect(isNowKind('time')).toBe(true)
  })

  it('rejects the kinds that have no current-time meaning', () => {
    expect(isNowKind('text')).toBe(false)
    expect(isNowKind('number')).toBe(false)
    expect(isNowKind('boolean')).toBe(false)
    expect(isNowKind('json')).toBe(false)
  })
})
