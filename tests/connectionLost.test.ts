import { describe, expect, it } from 'vitest'
import { describeError } from '@shared/errorText'

// Two different situations used to share one code and one sentence:
//   - the user never connected, and
//   - the user was connected, but the worker thread (which owns every adapter)
//     died and took the connection with it.
// The second one looked like the server had dropped the session, which sent the
// user looking at the wrong thing. They are now separate codes.
describe('connection loss wording', () => {
  it('keeps the plain wording when nothing was connected', () => {
    const error = {
      code: 'NOT_CONNECTED',
      message: 'No active connection: c1',
      engine: 'oracle'
    }
    expect(describeError(error, 'en')).toBe(
      'The connection to the server is no longer active.'
    )
    expect(describeError(error, 'id')).toBe('Koneksi ke server sudah tidak aktif.')
  })

  it('says the connection was lost and asks for a reconnect', () => {
    const error = {
      code: 'CONNECTION_LOST',
      message: 'Connection c1 was open but is no longer available',
      engine: 'oracle'
    }
    const en = describeError(error, 'en')
    expect(en).toContain('was open')
    expect(en).toContain('Reconnect')
    // It must not read like the server dropped the session: that is a different
    // failure and sends the user to the wrong place.
    expect(en).not.toContain('no longer active')

    const id = describeError(error, 'id')
    expect(id).toContain('tadinya terbuka')
    expect(id).toContain('Sambungkan ulang')
  })
})
