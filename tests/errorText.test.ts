import { describe, expect, it } from 'vitest'
import { describeError } from '@shared/errorText'

describe('describeError', () => {
  it('translates a known driver code in both locales', () => {
    const error = { code: 'NOT_CONNECTED', message: 'Not connected', engine: 'mysql' }
    expect(describeError(error, 'id')).toBe('Koneksi ke server sudah tidak aktif.')
    expect(describeError(error, 'en')).toBe(
      'The connection to the server is no longer active.'
    )
  })

  it('picks the specific wording when one code covers several messages', () => {
    const base = { code: 'INVALID', engine: 'postgres' }
    expect(describeError({ ...base, message: 'No values to insert' }, 'id')).toBe(
      'Tidak ada nilai untuk disimpan.'
    )
    expect(
      describeError({ ...base, message: 'Primary key required for this operation' }, 'id')
    ).toBe('Operasi ini butuh primary key.')
  })

  it('leaves a server message alone, since it names the real problem', () => {
    const message = "Table 'sajada.nope' doesn't exist; ER_NO_SUCH_TABLE"
    expect(describeError({ code: 'QUERY', message, engine: 'mysql' }, 'id')).toBe(message)
  })

  it('explains a stopped worker in both locales', () => {
    expect(
      describeError({ code: 'WORKER_EXIT', message: 'exit 1', engine: 'sqlite' }, 'id')
    ).toBe('Worker database berhenti. Sambungkan ulang koneksi.')
    expect(
      describeError({ code: 'WORKER_EXIT', message: 'exit 1', engine: 'sqlite' }, 'en')
    ).toBe('The database worker stopped. Reconnect the connection.')
  })

  it('keeps the technical detail when a native module is wrong', () => {
    const detail =
      'The module better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 127.'
    const text = describeError(
      { code: 'NATIVE_ABI', message: detail, engine: 'sqlite' },
      'id'
    )
    expect(text).toContain('npm run rebuild')
    expect(text).toContain('NODE_MODULE_VERSION 127')
  })

  it('falls back to a translated sentence when there is nothing to show', () => {
    expect(describeError(null, 'id')).toBe('Terjadi kesalahan yang tidak dikenali.')
    expect(describeError({ code: 'X', message: '', engine: 'mysql' }, 'en')).toBe(
      'An unrecognised error occurred.'
    )
  })
})
