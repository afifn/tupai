import { describe, expect, it } from 'vitest'
import {
  AI_PREVIEW_ROWS,
  previewableStatement,
  requestedRowCount,
  shouldPreview,
  supportsPreview
} from '@shared/aiPreview'

describe('previewableStatement', () => {
  it('accepts a plain SELECT and a CTE', () => {
    expect(previewableStatement('SELECT id FROM t', 'tampilkan 3 baris')?.sql).toBe(
      'SELECT id FROM t'
    )
    expect(
      previewableStatement('WITH x AS (SELECT 1) SELECT * FROM x', 'lihat data')?.sql
    ).toBe('WITH x AS (SELECT 1) SELECT * FROM x')
  })

  it('strips leading comments and a trailing semicolon', () => {
    const sql = '-- catatan\n/* blok */\nSELECT 1;'
    expect(previewableStatement(sql, '')?.sql).toBe('SELECT 1')
  })

  it('rejects writes, DDL, and anything with side effects', () => {
    const statements = [
      'DELETE FROM t',
      'UPDATE t SET a = 1',
      'INSERT INTO t VALUES (1)',
      'DROP TABLE t',
      'TRUNCATE t',
      'SELECT * INTO copy FROM t',
      'SELECT pg_sleep(10)',
      'SELECT SLEEP(5)',
      'SELECT BENCHMARK(1000000, MD5(1))',
      'WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone'
    ]
    for (const sql of statements) {
      expect(previewableStatement(sql, ''), sql).toBeNull()
    }
  })

  it('rejects a batch of two statements', () => {
    expect(previewableStatement('SELECT 1; SELECT 2', '')).toBeNull()
  })

  it('rejects an unterminated string literal', () => {
    expect(previewableStatement("SELECT 'oops FROM t", '')).toBeNull()
  })

  it('rejects a comment-only block', () => {
    expect(previewableStatement('-- hanya komentar', '')).toBeNull()
  })

  it('carries the row count the question asked for', () => {
    expect(previewableStatement('SELECT 1', 'tampilkan 3 baris')?.requested).toBe(3)
    expect(previewableStatement('SELECT 1', 'SELECT TOP 4 *')?.requested).toBe(4)
    expect(previewableStatement('SELECT 1', 'lihat tabel users')?.requested).toBeNull()
  })
})

describe('requestedRowCount', () => {
  it('reads the number from common Indonesian and English phrasing', () => {
    expect(requestedRowCount('tampilkan 3 baris dari tabel users')).toBe(3)
    expect(requestedRowCount('ambil 10 data terakhir')).toBe(10)
    expect(requestedRowCount('show me the top 2 rows')).toBe(2)
    expect(requestedRowCount('berikan 5 record')).toBe(5)
  })

  it('ignores a number that is not a row count', () => {
    expect(requestedRowCount('kolom 3 itu apa')).toBeNull()
    expect(requestedRowCount('jelaskan query ini')).toBeNull()
  })

  it('ignores zero and nonsense counts', () => {
    expect(requestedRowCount('tampilkan 0 baris')).toBeNull()
  })
})

describe('shouldPreview', () => {
  const select = 'SELECT * FROM users'

  it('shows the preview when the setting is on and no cap is exceeded', () => {
    expect(shouldPreview(select, 'tampilkan 3 baris', true)).toBe(true)
    expect(shouldPreview(select, 'tampilkan data users', true)).toBe(true)
    expect(shouldPreview(select, `tampilkan ${AI_PREVIEW_ROWS} baris`, true)).toBe(true)
  })

  it('shows only the query when more rows are requested than the cap', () => {
    expect(shouldPreview(select, 'tampilkan 10 baris', true)).toBe(false)
  })

  it('does nothing when the setting is off', () => {
    expect(shouldPreview(select, 'tampilkan 3 baris', false)).toBe(false)
  })

  it('does nothing for an unsafe statement even when enabled', () => {
    expect(shouldPreview('DELETE FROM users', 'tampilkan 3 baris', true)).toBe(false)
  })
})

describe('supportsPreview', () => {
  it('covers the SQL engines and skips MongoDB and a missing engine', () => {
    expect(supportsPreview('postgres')).toBe(true)
    expect(supportsPreview('sqlite')).toBe(true)
    expect(supportsPreview('mongodb')).toBe(false)
    expect(supportsPreview(undefined)).toBe(false)
  })
})
