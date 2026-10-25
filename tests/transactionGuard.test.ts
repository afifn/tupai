import { describe, expect, it } from 'vitest'
import { commitsImplicitly, firstImplicitCommit } from '@shared/transactionGuard'

describe('commitsImplicitly', () => {
  it('flags DDL on the engines that commit implicitly', () => {
    const statements = [
      'CREATE TABLE t (id INT)',
      'ALTER TABLE t ADD COLUMN a INT',
      'DROP TABLE t',
      'TRUNCATE TABLE t',
      'RENAME TABLE a TO b',
      'GRANT SELECT ON t TO bob'
    ]
    for (const engine of ['mysql', 'mariadb', 'oracle'] as const) {
      for (const sql of statements) {
        expect(commitsImplicitly(engine, sql), `${engine}: ${sql}`).toBe(true)
      }
    }
  })

  it('never flags PostgreSQL, whose DDL is transactional', () => {
    expect(commitsImplicitly('postgres', 'CREATE TABLE t (id INT)')).toBe(false)
    expect(commitsImplicitly('postgres', 'DROP TABLE t')).toBe(false)
  })

  it('ignores engines without manual transactions', () => {
    expect(commitsImplicitly('sqlite', 'CREATE TABLE t (id INT)')).toBe(false)
    expect(commitsImplicitly('mongodb', 'CREATE TABLE t (id INT)')).toBe(false)
  })

  it('ignores DML', () => {
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET a = 1',
      'DELETE FROM t',
      'SELECT 1'
    ]) {
      expect(commitsImplicitly('mysql', sql), sql).toBe(false)
    }
  })

  it('looks past leading comments', () => {
    expect(commitsImplicitly('mysql', '-- migration\nCREATE TABLE t (id INT)')).toBe(true)
    expect(commitsImplicitly('mysql', '/* step 1 */\n\nALTER TABLE t ADD a INT')).toBe(
      true
    )
  })

  it('does not treat a keyword inside a name as DDL', () => {
    expect(commitsImplicitly('mysql', 'SELECT created_at FROM t')).toBe(false)
    expect(commitsImplicitly('mysql', "INSERT INTO t VALUES ('drop')")).toBe(false)
  })

  it('ignores an empty statement', () => {
    expect(commitsImplicitly('mysql', '   ')).toBe(false)
  })
})

describe('firstImplicitCommit', () => {
  it('returns the statement that would commit, not the whole script', () => {
    expect(
      firstImplicitCommit('mysql', [
        'INSERT INTO t VALUES (1)',
        'CREATE TABLE u (id INT)'
      ])
    ).toBe('CREATE TABLE u (id INT)')
  })

  it('returns null when nothing commits implicitly', () => {
    expect(firstImplicitCommit('postgres', ['CREATE TABLE t (id INT)'])).toBeNull()
    expect(firstImplicitCommit('mysql', ['INSERT INTO t VALUES (1)'])).toBeNull()
  })
})
