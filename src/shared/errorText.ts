import type { MessageKey } from './i18n'
import { t, type Locale } from './i18n'

// Driver and worker errors are raised in main as a code plus an English message,
// because the worker has no access to the locale catalogue. The renderer owns the
// wording, so a failed query never shows an English sentence in an Indonesian
// screen. Anything without a mapping keeps the server text: it is usually the
// most useful part (the missing table, the syntax error position).
const CODE_KEYS: Record<string, MessageKey> = {
  NOT_CONNECTED: 'error.notConnected',
  CONNECTION_LOST: 'error.connectionLost',
  EMPTY: 'error.noStatement',
  EXPLAIN_EMPTY: 'error.explainEmpty',
  EXPLAIN_MULTI: 'error.explainMulti',
  INVALID: 'error.noValues',
  INVALID_SESSION: 'error.invalidSession',
  KILL_FAILED: 'error.killFailed',
  NOT_SUPPORTED: 'error.notSupported',
  SSH_CONFIG: 'error.sshConfig',
  SSH_NOT_SUPPORTED: 'error.sshNotSupported',
  SSL_NOT_SUPPORTED: 'error.sslNotSupported',
  UNKNOWN_OP: 'error.unknownOp',
  WORKER_EXIT: 'error.workerStopped',
  WORKER_ERROR: 'error.workerCrashed',
  TIMEOUT: 'error.timeout',
  NATIVE_ABI: 'error.nativeAbi',
  NATIVE_MISSING: 'error.nativeMissing'
}

// The driver uses one code for several messages, so the few cases where the
// wording matters are picked out by their stable English text.
const MESSAGE_KEYS: { match: string; key: MessageKey }[] = [
  { match: 'primary key required', key: 'error.primaryKeyRequired' },
  { match: 'sqlite requires a file path', key: 'error.configSqlitePath' },
  { match: 'no sql statement to run', key: 'error.noStatement' },
  { match: 'no sql statement to explain', key: 'error.noStatementToExplain' },
  { match: 'no values to insert', key: 'error.noValues' },
  { match: 'not connected', key: 'error.notConnected' }
]

/**
 * Turn a thrown error into text for the active locale. Server errors that are
 * already human readable (a missing table, a syntax error) pass through
 * unchanged, since translating them would hide the detail the user needs.
 */
export function describeError(error: unknown, locale: Locale): string {
  if (!error || typeof error !== 'object') return t(locale, 'error.unknown')

  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  const message =
    'message' in error && typeof error.message === 'string' ? error.message : ''

  // The message is checked before the code: one code (INVALID) covers both
  // "no values" and "primary key required", and only the message says which.
  const lower = message.toLowerCase()
  for (const entry of MESSAGE_KEYS) {
    if (lower.includes(entry.match)) return t(locale, entry.key)
  }

  const mapped = CODE_KEYS[code]
  if (mapped) {
    // Keep the technical detail for the worker and native-module failures: the
    // sentence explains what to do, the detail says which module broke.
    if (code === 'NATIVE_ABI' || code === 'NATIVE_MISSING' || code === 'WORKER_ERROR') {
      return message ? `${t(locale, mapped)} (${message})` : t(locale, mapped)
    }
    return t(locale, mapped)
  }

  return message || t(locale, 'error.unknown')
}
