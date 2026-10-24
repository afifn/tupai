import type { ConnectionConfig, DbEngine, SslMode } from './types'
import { defaultsFor } from './engineDefaults'

// Navicat exports connections as an XML file whose root is <Connections Ver="1.5">
// and whose entries are <Connection> elements carrying every setting as an
// attribute. This module is the pure half of the importer: it takes the parsed
// attribute bag and produces a Tupai connection, so the mapping is unit-tested
// without XML, Electron, or the filesystem.
//
// Passwords are deliberately not imported. Navicat stores them encrypted with a
// key that belongs to Navicat, and pretending to support that would break on the
// next version and invite a reverse-engineering dependency. An imported
// connection reports `needsPassword` so the UI can ask the user to type it once.

export type NcxImportStatus = 'new' | 'conflict' | 'unsupported'

export type NcxSkipReason =
  'unsupported-engine' | 'missing-name' | 'missing-host' | 'missing-file'

export interface NcxRawConnection {
  name: string
  connType: string
  host: string
  port: number | null
  database: string
  user: string
  file: string
  sslEnabled: boolean
  sslMode: SslMode | null
  sslCaPath: string
  sslCertPath: string
  sslKeyPath: string
  sshEnabled: boolean
  sshHost: string
  sshPort: number | null
  sshUser: string
  sshAuthType: 'password' | 'privateKey'
  sshKeyPath: string
  // True when the export carried a password field. The value is never decoded.
  hasEncryptedPassword: boolean
}

export interface NcxImportItem {
  // Stable key for the preview list and for applying a selection.
  key: string
  name: string
  engine: DbEngine | null
  status: NcxImportStatus
  skipReason?: NcxSkipReason
  needsPassword: boolean
  // The config to save. Present only when status is 'new' or 'conflict'.
  config: ConnectionConfig | null
  // Non-fatal notes shown next to the row, e.g. "SSL was on but no CA file".
  warnings: string[]
  // Raw values the preview needs to describe the entry.
  host: string
  port: number | null
  connType: string
}

// Navicat's ConnType is uppercase and covers engines Tupai does not implement.
const ENGINE_BY_CONN_TYPE: Record<string, DbEngine> = {
  MYSQL: 'mysql',
  MARIADB: 'mariadb',
  POSTGRESQL: 'postgres',
  ORACLE: 'oracle',
  SQLITE: 'sqlite',
  MONGODB: 'mongodb'
}

function attr(bag: Record<string, string>, name: string): string {
  const value = bag[name]
  return typeof value === 'string' ? value.trim() : ''
}

function attrBool(bag: Record<string, string>, name: string): boolean {
  return attr(bag, name).toLowerCase() === 'true'
}

function attrPort(bag: Record<string, string>, name: string): number | null {
  const raw = attr(bag, name)
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null
}

function sslModeFromNcx(raw: string): SslMode | null {
  // Navicat writes the libpq mode names; REQUIRE is the default when absent.
  switch (raw.toUpperCase().replace(/_/g, '-')) {
    case 'REQUIRE':
      return 'require'
    case 'VERIFY-CA':
      return 'verify-ca'
    case 'VERIFY-FULL':
      return 'verify-full'
    default:
      return null
  }
}

export function engineForConnType(connType: string): DbEngine | null {
  return ENGINE_BY_CONN_TYPE[connType.trim().toUpperCase()] ?? null
}

/**
 * Read one <Connection> attribute bag into a neutral record. Unknown attributes
 * are ignored on purpose: Navicat adds fields between versions and a new one
 * must not fail the whole import.
 */
export function readRawConnection(bag: Record<string, string>): NcxRawConnection {
  const connType = attr(bag, 'ConnType')
  const sshAuth = attr(bag, 'SSH_AuthenMethod').toUpperCase()
  return {
    name: attr(bag, 'ConnectionName'),
    connType,
    host: attr(bag, 'Host'),
    port: attrPort(bag, 'Port'),
    database: attr(bag, 'Database'),
    user: attr(bag, 'UserName'),
    file: attr(bag, 'DatabaseFileName'),
    sslEnabled: attrBool(bag, 'SSL'),
    sslMode: sslModeFromNcx(attr(bag, 'SSL_PGSSLMode')),
    sslCaPath: attr(bag, 'SSL_CACert'),
    sslCertPath: attr(bag, 'SSL_ClientCert'),
    sslKeyPath: attr(bag, 'SSL_ClientKey'),
    sshEnabled: attrBool(bag, 'SSH'),
    sshHost: attr(bag, 'SSH_Host'),
    sshPort: attrPort(bag, 'SSH_Port'),
    sshUser: attr(bag, 'SSH_UserName'),
    // Navicat writes "PASSWORD" or "PUBLIC KEY".
    sshAuthType: sshAuth.includes('KEY') ? 'privateKey' : 'password',
    sshKeyPath: attr(bag, 'SSH_PrivateKey'),
    hasEncryptedPassword:
      attr(bag, 'Password').length > 0 && attrBool(bag, 'SavePassword')
  }
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Turn a raw record into a preview row. `existingNames` are the names already in
 * Tupai, compared case-insensitively, so a re-import reports a conflict instead
 * of creating a duplicate the user cannot tell apart.
 */
export function toImportItem(
  raw: NcxRawConnection,
  index: number,
  existingNames: Iterable<string>,
  id: string
): NcxImportItem {
  // The key is content-based, not just the index: main re-parses the file when
  // the user confirms, and a stable key keeps the selection meaningful even if
  // the file changed in between. The index keeps duplicates distinguishable.
  const base: NcxImportItem = {
    key: `ncx-${index}-${raw.connType}-${raw.name}-${raw.host}-${raw.port ?? ''}`,
    name: raw.name,
    engine: engineForConnType(raw.connType),
    status: 'unsupported',
    needsPassword: raw.hasEncryptedPassword,
    config: null,
    warnings: [],
    host: raw.host,
    port: raw.port,
    connType: raw.connType
  }

  if (!raw.name) {
    return { ...base, skipReason: 'missing-name' }
  }
  const engine = base.engine
  if (!engine) {
    return { ...base, skipReason: 'unsupported-engine' }
  }

  const caps = defaultsFor(engine)
  const isFile = engine === 'sqlite'

  if (isFile) {
    if (!raw.file) return { ...base, skipReason: 'missing-file' }
  } else if (!raw.host) {
    return { ...base, skipReason: 'missing-host' }
  }

  const warnings: string[] = []
  const config: ConnectionConfig = {
    id,
    name: raw.name,
    engine
  }

  if (isFile) {
    config.file = raw.file
  } else {
    config.host = raw.host
    config.port = raw.port ?? caps.port ?? undefined
    if (raw.user) config.user = raw.user
    if (raw.database) config.database = raw.database

    // SSL only survives when the target engine can actually use it. Oracle
    // rejects it in the driver, so an SSL flag from Navicat is dropped with a
    // warning instead of being saved and failing at connect time.
    if (raw.sslEnabled && engine === 'oracle') {
      warnings.push('ssl-dropped')
    } else if (raw.sslEnabled) {
      config.ssl = {
        enabled: true,
        mode: raw.sslMode ?? 'require'
      }
      if (raw.sslCaPath) config.ssl.caPath = raw.sslCaPath
      if (raw.sslCertPath) config.ssl.certPath = raw.sslCertPath
      if (raw.sslKeyPath) config.ssl.keyPath = raw.sslKeyPath
    }

    if (raw.sshEnabled) {
      if (engine === 'mongodb' || engine === 'oracle') {
        warnings.push('ssh-dropped')
      } else if (!raw.sshHost) {
        warnings.push('ssh-dropped')
      } else {
        config.ssh = {
          enabled: true,
          host: raw.sshHost,
          port: raw.sshPort ?? 22,
          user: raw.sshUser,
          authType: raw.sshAuthType
        }
        if (raw.sshAuthType === 'privateKey' && raw.sshKeyPath) {
          config.ssh.privateKeyPath = raw.sshKeyPath
        }
      }
    }
  }

  const taken = new Set([...existingNames].map(normalizeName))
  const status: NcxImportStatus = taken.has(normalizeName(raw.name)) ? 'conflict' : 'new'

  return { ...base, status, config, warnings }
}

/** Navicat attribute bag for one Tupai connection, ready for XMLBuilder. */
export function toNcxAttributes(config: ConnectionConfig): Record<string, string> {
  const ssl = typeof config.ssl === 'object' ? config.ssl : null
  const ssh = config.ssh
  const isFile = config.engine === 'sqlite'
  const mode = ssl?.mode ?? 'require'
  return {
    ConnectionName: config.name,
    ProjectUUID: '',
    ConnType: (config.engine === 'postgres'
      ? 'POSTGRESQL'
      : config.engine === 'mariadb'
        ? 'MARIADB'
        : config.engine.toUpperCase()) as string,
    ServiceProvider: 'Default',
    OraConnType: 'BASIC',
    Host: config.host ?? '',
    Port: config.port ? String(config.port) : '',
    Database: config.database ?? '',
    OraServiceNameType: 'SERVICENAME',
    TNS: '',
    MSSQLAuthenMode: '',
    MSSQLAuthenWindowsDomain: '',
    DatabaseFileName: isFile ? (config.file ?? '') : '',
    UserName: config.user ?? '',
    // Passwords are never exported: Navicat expects its own ciphertext, and
    // writing plaintext or a fake blob would be worse than asking again.
    Password: '',
    SavePassword: 'false',
    SettingsSavePath: '',
    SessionLimit: '0',
    Encoding: '',
    Keepalive: 'false',
    KeepaliveInterval: '240',
    MySQLCharacterSet: 'false',
    Compression: 'false',
    AutoConnect: 'false',
    NamedPipe: 'false',
    NamedPipeSocket: '',
    OraRole: 'DEFAULT',
    OraOSAuthen: 'false',
    SQLiteEncrypt: 'false',
    SQLiteEncryptPassword: '',
    SQLiteSaveEncryptPassword: 'false',
    UseAdvanced: 'true',
    ClientCharsetID: '0',
    ClientEncoding: '65001',
    SSL: ssl?.enabled ? 'true' : 'false',
    SSL_Authen: 'false',
    SSL_PGSSLMode:
      mode === 'verify-full'
        ? 'VERIFY-FULL'
        : mode === 'verify-ca'
          ? 'VERIFY-CA'
          : 'REQUIRE',
    SSL_ClientKey: ssl?.keyPath ?? '',
    SSL_ClientCert: ssl?.certPath ?? '',
    SSL_CACert: ssl?.caPath ?? '',
    SSL_Clpher: '',
    SSL_PGSSLCRL: '',
    SSL_WeakCertValidation: 'false',
    SSL_AllowInvalidHostName: 'false',
    SSL_PEMClientKeyPassword: '',
    SSH: ssh?.enabled ? 'true' : 'false',
    SSH_Host: ssh?.host ?? '',
    SSH_Port: ssh?.port ? String(ssh.port) : '22',
    SSH_UserName: ssh?.user ?? '',
    SSH_AuthenMethod: ssh?.authType === 'privateKey' ? 'PUBLIC KEY' : 'PASSWORD',
    SSH_Password: '',
    SSH_SavePassword: 'false',
    SSH_PrivateKey: ssh?.privateKeyPath ?? '',
    SSH_Passphrase: '',
    SSH_SavePassphrase: 'false',
    SSH_Compress: 'false',
    HTTP: 'false',
    HTTP_URL: '',
    HTTP_PA: '',
    HTTP_PA_UserName: '',
    HTTP_PA_Password: '',
    HTTP_PA_SavePassword: '',
    HTTP_EQ: '',
    HTTP_CA: '',
    HTTP_CA_ClientKey: '',
    HTTP_CA_ClientCert: '',
    HTTP_CA_CACert: '',
    HTTP_CA_Passphrase: '',
    HTTP_Proxy: '',
    HTTP_Proxy_Host: '',
    HTTP_Proxy_Port: '',
    HTTP_Proxy_UserName: '',
    HTTP_Proxy_Password: '',
    HTTP_Proxy_SavePassword: ''
  }
}
