import { describe, expect, it } from 'vitest'
import { lastSafeStatementBoundary, splitStatements } from '@shared/sqlBoundary'

describe('splitStatements', () => {
  it('splits on terminators and drops blank statements', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2'])
    expect(splitStatements('  ;;  ')).toEqual([])
    expect(splitStatements('')).toEqual([])
  })

  it('keeps a terminator inside a string literal', () => {
    expect(splitStatements(`SELECT ';' AS a; SELECT 2`)).toEqual([
      `SELECT ';' AS a`,
      'SELECT 2'
    ])
  })

  it('keeps a terminator inside a quoted identifier', () => {
    expect(splitStatements('SELECT ";" FROM t; SELECT 2')).toEqual([
      'SELECT ";" FROM t',
      'SELECT 2'
    ])
  })

  it('keeps a terminator inside a line comment', () => {
    expect(splitStatements('-- ; not a terminator\nSELECT 1; SELECT 2')).toEqual([
      '-- ; not a terminator\nSELECT 1',
      'SELECT 2'
    ])
  })

  it('keeps a terminator inside a block comment', () => {
    expect(splitStatements('/* ; */ SELECT 1; SELECT 2')).toEqual([
      '/* ; */ SELECT 1',
      'SELECT 2'
    ])
  })

  it('keeps semicolons inside a dollar-quoted body', () => {
    const sql = `CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 2;`
    expect(splitStatements(sql)).toEqual([
      `CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql`,
      'SELECT 2'
    ])
  })

  it('handles a tagged dollar-quoted body', () => {
    const sql = `DO $body$ BEGIN PERFORM 1; END $body$; SELECT 2`
    expect(splitStatements(sql)).toEqual([
      'DO $body$ BEGIN PERFORM 1; END $body$',
      'SELECT 2'
    ])
  })

  it('handles CRLF input', () => {
    expect(splitStatements('SELECT 1;\r\nSELECT 2;\r\n')).toEqual([
      'SELECT 1',
      'SELECT 2'
    ])
  })

  it('keeps a MySQL executable comment as a statement', () => {
    // mysqldump writes /*!40101 SET ... */; and MySQL executes it. Treating a
    // block comment as a no-op would silently drop the statement on restore.
    const sql = '/*!40101 SET NAMES utf8 */; SELECT 1;'
    expect(splitStatements(sql)).toEqual(['/*!40101 SET NAMES utf8 */', 'SELECT 1'])
  })

  it('keeps a comment-only chunk so restore does not drop it', () => {
    expect(splitStatements('-- nothing to do\n')).toEqual(['-- nothing to do'])
  })
})

describe('lastSafeStatementBoundary', () => {
  it('reports the position after the last terminator', () => {
    expect(lastSafeStatementBoundary('SELECT 1; SELECT 2;')).toBe(19)
  })

  it('ignores terminators inside a dollar-quoted body', () => {
    const sql = 'DO $$ BEGIN PERFORM 1; END $$; SELECT 2'
    expect(sql.slice(0, lastSafeStatementBoundary(sql)).trim()).toBe(
      'DO $$ BEGIN PERFORM 1; END $$;'
    )
  })

  it('returns -1 when there is no terminator', () => {
    expect(lastSafeStatementBoundary('SELECT 1')).toBe(-1)
  })
})
