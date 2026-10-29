/**
 * Decides whether a driver error means "the session to the server is gone", as
 * opposed to a statement that failed.
 *
 * The distinction matters because the two need different handling. A failed
 * statement is reported to the caller and nothing else changes. A lost session
 * means the cached connection is dead: it must be dropped so the next call
 * reconnects, and the UI has to say so instead of blaming the query.
 *
 * This is pure so it can be tested directly. The driver files cannot be unit
 * tested: they import `pg`, `mysql2`, and `oracledb`, and the native ones are
 * built for Electron.
 */

/** Postgres SQLSTATEs for "the server shut the session down". */
const PG_FATAL_CODES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08S01' // protocol_violation
])

/** MySQL client error codes for a connection that is no longer usable. */
const MYSQL_FATAL_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ER_SERVER_SHUTDOWN',
  'ER_CONNECTION_KILLED'
])

/**
 * Oracle does not close the socket when it ends a session; the next call fails
 * instead, so the codes below are what a dropped session looks like.
 */
const ORACLE_FATAL_CODES = new Set([
  'ORA-03113', // end-of-file on communication channel
  'ORA-03114', // not connected to ORACLE
  'ORA-03135', // connection lost contact
  'ORA-12537', // TNS:connection closed
  'ORA-12570', // TNS:packet reader failure
  'ORA-12571', // TNS:packet writer failure
  'NJS-503', // connection was closed
  'NJS-511' // connection is not open
])

/**
 * Substrings that identify a session the server ended. `idle-session timeout` is
 * the one that prompted this: Postgres and pgbouncer both close a session that
 * has been idle for too long, and the message arrives as a normal error event on
 * a connection that is otherwise healthy.
 */
const LOST_MESSAGES = [
  'terminating connection',
  'idle-session timeout',
  'idle_in_transaction_session_timeout',
  'connection terminated',
  'connection lost',
  'server closed the connection',
  'connection is closed',
  'connection was closed',
  'not connected to oracle',
  'end-of-file on communication channel'
]

function codeOf(err: unknown): string {
  if (!err || typeof err !== 'object') return ''
  const record = err as { code?: unknown; errno?: unknown }
  const code = typeof record.code === 'string' ? record.code : ''
  // mysql2 sometimes carries the symbolic code in `errno` instead.
  if (code) return code
  return typeof record.errno === 'string' ? record.errno : ''
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message
    return typeof message === 'string' ? message : ''
  }
  return ''
}

export function isConnectionLostError(err: unknown): boolean {
  const code = codeOf(err).toUpperCase()
  if (code && PG_FATAL_CODES.has(code)) return true
  if (code && MYSQL_FATAL_CODES.has(code)) return true
  // Oracle codes carry a dash, so the set above is matched as a prefix to cope
  // with the extra text node-oracledb appends ("ORA-03113: end-of-file...").
  for (const fatal of ORACLE_FATAL_CODES) {
    if (code.startsWith(fatal)) return true
  }
  const message = messageOf(err).toLowerCase()
  return LOST_MESSAGES.some((needle) => message.includes(needle))
}

/**
 * One sentence for the banner, with the server's own wording kept as the detail.
 * The driver message is English and can be long; the caller shows this line and
 * logs the rest.
 */
export function describeLostSession(err: unknown): string {
  const message = messageOf(err).split('\n')[0].trim()
  if (!message) return 'Sesi ke server berakhir dan koneksi ini perlu disambung ulang.'
  return `Sesi ke server berakhir (${message}). Koneksi ini perlu disambung ulang.`
}
