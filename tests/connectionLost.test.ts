import { describe, expect, it } from 'vitest'
import { describeLostSession, isConnectionLostError } from '@shared/connectionLost'

// The case that prompted this: Postgres closes an idle session and the driver
// reports it as a normal error event. Before, that event had no listener, so it
// became an uncaught exception and killed the whole worker along with every
// other connection.
describe('isConnectionLostError', () => {
  it('recognises the idle-session timeout message', () => {
    const err = new Error('terminating connection due to idle-session timeout')
    expect(isConnectionLostError(err)).toBe(true)
  })

  it('recognises the idle-in-transaction variant', () => {
    expect(
      isConnectionLostError(
        new Error('terminating connection due to idle-in-transaction timeout')
      )
    ).toBe(true)
  })

  it('recognises the Postgres admin shutdown SQLSTATE', () => {
    const err = Object.assign(new Error('terminating connection'), { code: '57P01' })
    expect(isConnectionLostError(err)).toBe(true)
  })

  it('recognises a dropped socket', () => {
    expect(
      isConnectionLostError(
        Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      )
    ).toBe(true)
    expect(isConnectionLostError(new Error('Connection terminated unexpectedly'))).toBe(
      true
    )
  })

  it('recognises the MySQL protocol-lost code', () => {
    expect(
      isConnectionLostError(
        Object.assign(new Error('Connection lost: The server closed the connection.'), {
          code: 'PROTOCOL_CONNECTION_LOST'
        })
      )
    ).toBe(true)
  })

  it('recognises Oracle session death', () => {
    for (const code of ['ORA-03113', 'ORA-03114', 'ORA-03135', 'ORA-12537']) {
      expect(
        isConnectionLostError(Object.assign(new Error(`${code}: something`), { code }))
      ).toBe(true)
    }
  })

  it('matches an Oracle code that carries trailing text', () => {
    const err = Object.assign(new Error('x'), {
      code: 'ORA-03113: end-of-file on communication channel'
    })
    expect(isConnectionLostError(err)).toBe(true)
  })

  // A failed statement must not be mistaken for a lost session: the connection
  // is still good, and dropping it would make the user reconnect for nothing.
  it('does not treat a statement error as a lost session', () => {
    expect(
      isConnectionLostError(
        Object.assign(new Error('syntax error at or near "SELCT"'), { code: '42601' })
      )
    ).toBe(false)
    expect(
      isConnectionLostError(
        Object.assign(new Error('relation "nope" does not exist'), { code: '42P01' })
      )
    ).toBe(false)
    expect(
      isConnectionLostError(new Error('duplicate key value violates unique constraint'))
    ).toBe(false)
  })

  it('does not treat a timeout of our own as a lost session', () => {
    // The worker sets statement_timeout; that is a statement being cancelled,
    // not a session ending, so the connection is still usable.
    expect(
      isConnectionLostError(
        Object.assign(new Error('canceling statement due to statement timeout'), {
          code: '57014'
        })
      )
    ).toBe(false)
  })

  it('handles junk input without throwing', () => {
    expect(isConnectionLostError(null)).toBe(false)
    expect(isConnectionLostError(undefined)).toBe(false)
    expect(isConnectionLostError(42)).toBe(false)
    expect(isConnectionLostError({})).toBe(false)
  })
})

describe('describeLostSession', () => {
  it('keeps the server wording as the detail', () => {
    const text = describeLostSession(
      new Error('terminating connection due to idle-session timeout')
    )
    expect(text).toContain('Sesi ke server berakhir')
    expect(text).toContain('idle-session timeout')
    expect(text).toContain('disambung ulang')
  })

  it('uses only the first line of a multi-line error', () => {
    const text = describeLostSession(new Error('first line\nsecond line\nthird'))
    expect(text).toContain('first line')
    expect(text).not.toContain('second line')
  })

  it('falls back to a plain sentence when there is no message', () => {
    const text = describeLostSession({})
    expect(text).toContain('Sesi ke server berakhir')
    expect(text).toContain('disambung ulang')
  })
})
