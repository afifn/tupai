import { describe, expect, it } from 'vitest'
import { describeConnectionError } from '@shared/connectionError'
import { t, type Locale, type MessageKey, type MessageParams } from '@shared/i18n'

const trFor = (locale: Locale) => (key: MessageKey, params?: MessageParams) =>
  t(locale, key, params)

describe('describeConnectionError', () => {
  it('follows the active locale', () => {
    const refused = describeConnectionError(
      'connect ECONNREFUSED 127.0.0.1:3306',
      'mysql',
      trFor('id')
    )
    expect(refused.title).toBe('Server menolak koneksi')
    expect(refused.hint).toContain('MySQL/MariaDB')
    expect(refused.retryable).toBe(true)

    const english = describeConnectionError(
      'connect ECONNREFUSED 127.0.0.1:3306',
      'mysql',
      trFor('en')
    )
    expect(english.title).toBe('The server refused the connection')
    expect(english.hint).toContain('MySQL/MariaDB')
  })

  it('names the engine in the reader language', () => {
    const sqlite = describeConnectionError('connect ECONNREFUSED', 'sqlite', trFor('id'))
    expect(sqlite.hint).toContain('file SQLite')
    const english = describeConnectionError('connect ECONNREFUSED', 'sqlite', trFor('en'))
    expect(english.hint).toContain('SQLite file')
  })

  it('marks credential and database problems as not retryable', () => {
    const auth = describeConnectionError('ER_ACCESS_DENIED_ERROR', 'mysql', trFor('en'))
    expect(auth.retryable).toBe(false)
    const missing = describeConnectionError('ER_BAD_DB_ERROR', 'mysql', trFor('en'))
    expect(missing.retryable).toBe(false)
  })

  it('keeps the server detail when nothing matched', () => {
    const raw = 'Something odd happened at 0x1234'
    const failure = describeConnectionError(raw, 'postgres', trFor('en'))
    expect(failure.title).toBe('Could not connect')
    expect(failure.hint).toContain(raw)
  })
})
