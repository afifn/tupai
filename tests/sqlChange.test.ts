import { describe, expect, it } from 'vitest'
import { changesSchema } from '@shared/sqlChange'

describe('changesSchema', () => {
  it('detects statements that change the catalogue', () => {
    const statements = [
      'CREATE TABLE users (id INT)',
      'create table users (id int)',
      'ALTER TABLE users ADD COLUMN name TEXT',
      'DROP TABLE users',
      'RENAME TABLE a TO b',
      'TRUNCATE TABLE users',
      'CREATE INDEX idx ON users (id)',
      'CREATE OR REPLACE VIEW v AS SELECT 1',
      "COMMENT ON TABLE users IS 'x'",
      'GRANT SELECT ON users TO bob',
      'BEGIN; CREATE TABLE t (id INT); COMMIT;'
    ]
    for (const sql of statements) {
      expect(changesSchema(sql), sql).toBe(true)
    }
  })

  it('ignores reads, even when a column or alias looks like a keyword', () => {
    const statements = [
      'SELECT * FROM users',
      'SELECT create_date, drop_reason FROM users',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'EXPLAIN SELECT * FROM users',
      'SHOW TABLES'
    ]
    for (const sql of statements) {
      expect(changesSchema(sql), sql).toBe(false)
    }
  })

  it('ignores keywords inside comments and string literals', () => {
    expect(changesSchema('-- create table later\nSELECT 1')).toBe(false)
    expect(changesSchema('/* drop table */ SELECT 1')).toBe(false)
    expect(changesSchema("SELECT 'create table x' AS note")).toBe(false)
    expect(changesSchema('SELECT "drop" FROM t')).toBe(false)
  })

  it('ignores an empty script', () => {
    expect(changesSchema('')).toBe(false)
    expect(changesSchema('   \n  ')).toBe(false)
  })

  it('does not treat a word containing a keyword as a match', () => {
    expect(changesSchema('SELECT recreate, dropped FROM t')).toBe(false)
  })
})
