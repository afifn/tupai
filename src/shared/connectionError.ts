import type { DbEngine } from './types'
import type { MessageKey, MessageParams } from './i18n'

// Raw driver errors are English, often just a code plus an address. A user who
// clicked Connect needs to know what to fix, so each common failure maps to a
// short title and one actionable sentence. The wording lives in the locale
// catalogue; this module only decides which case matched.
export interface ConnectionFailure {
  title: string
  hint: string
  // False for problems the user must fix in the connection settings.
  retryable: boolean
}

type Translate = (key: MessageKey, params?: MessageParams) => string

const ENGINE_SERVICE: Record<string, MessageKey> = {
  mysql: 'connErr.serviceMysql',
  mariadb: 'connErr.serviceMysql',
  postgres: 'connErr.servicePostgres',
  oracle: 'connErr.serviceOracle',
  sqlite: 'connErr.serviceSqlite',
  mongodb: 'connErr.serviceMongodb'
}

function serviceName(engine: DbEngine | undefined, tr: Translate): string {
  return tr((engine && ENGINE_SERVICE[engine]) || 'connErr.serviceGeneric')
}

export function describeConnectionError(
  raw: string,
  engine: DbEngine | undefined,
  tr: Translate
): ConnectionFailure {
  const text = (raw ?? '').trim()
  const upper = text.toUpperCase()
  const has = (...needles: string[]): boolean =>
    needles.some((needle) => upper.includes(needle.toUpperCase()))

  if (has('ECONNREFUSED')) {
    return {
      title: tr('connErr.refusedTitle'),
      hint: tr('connErr.refusedHint', { service: serviceName(engine, tr) }),
      retryable: true
    }
  }
  if (has('ENOTFOUND', 'EAI_AGAIN', 'GETADDRINFO')) {
    return {
      title: tr('connErr.dnsTitle'),
      hint: tr('connErr.dnsHint'),
      retryable: true
    }
  }
  if (has('ETIMEDOUT', 'TIMEOUT', 'ETIMEOUT')) {
    return {
      title: tr('connErr.timeoutTitle'),
      hint: tr('connErr.timeoutHint'),
      retryable: true
    }
  }
  if (has('ECONNRESET', 'EPIPE', 'PROTOCOL_CONNECTION_LOST', 'CONNECTION TERMINATED')) {
    return {
      title: tr('connErr.resetTitle'),
      hint: tr('connErr.resetHint'),
      retryable: true
    }
  }
  if (has('EHOSTUNREACH', 'ENETUNREACH')) {
    return {
      title: tr('connErr.unreachableTitle'),
      hint: tr('connErr.unreachableHint'),
      retryable: true
    }
  }
  if (
    has(
      'ER_ACCESS_DENIED_ERROR',
      'ACCESS DENIED',
      '28P01',
      'ORA-01017',
      'AUTHENTICATION FAILED',
      'INVALID PASSWORD'
    )
  ) {
    return {
      title: tr('connErr.authTitle'),
      hint: tr('connErr.authHint'),
      retryable: false
    }
  }
  if (has('ER_BAD_DB_ERROR', '3D000', 'UNKNOWN DATABASE', 'DATABASE DOES NOT EXIST')) {
    return {
      title: tr('connErr.databaseTitle'),
      hint: tr('connErr.databaseHint'),
      retryable: false
    }
  }
  if (has('SQLITE_CANTOPEN', 'UNABLE TO OPEN DATABASE FILE')) {
    return {
      title: tr('connErr.sqliteFileTitle'),
      hint: tr('connErr.sqliteFileHint'),
      retryable: false
    }
  }
  if (has('ORA-12541', 'NO LISTENER')) {
    return {
      title: tr('connErr.oracleListenerTitle'),
      hint: tr('connErr.oracleListenerHint'),
      retryable: true
    }
  }
  if (has('ORA-12514', 'SERVICE_NAME')) {
    return {
      title: tr('connErr.oracleServiceTitle'),
      hint: tr('connErr.oracleServiceHint'),
      retryable: false
    }
  }
  if (has('SSL', 'CERTIFICATE')) {
    return {
      title: tr('connErr.tlsTitle'),
      hint: tr('connErr.tlsHint'),
      retryable: false
    }
  }
  if (has('SSH')) {
    return {
      title: tr('connErr.sshTitle'),
      hint: tr('connErr.sshHint'),
      retryable: true
    }
  }

  return {
    title: tr('connErr.unknownTitle'),
    // The server text is the most useful detail when it exists, so it is kept
    // after the generic sentence instead of being replaced by it.
    hint: text ? `${tr('connErr.unknownHint')} (${text})` : tr('connErr.unknownHint'),
    retryable: true
  }
}
