import { describe, expect, it } from 'vitest'
import {
  engineForConnType,
  readRawConnection,
  toImportItem,
  toNcxAttributes
} from '@shared/navicatNcx'

// Attribute bags as fast-xml-parser hands them over: every value is a string.
const oracleBag: Record<string, string> = {
  ConnectionName: 'PAYROLL 5.8',
  ConnType: 'ORACLE',
  Host: 'db.example.test',
  Port: '1521',
  Database: 'orcl.example.test',
  UserName: 'payroll',
  Password: '00000000000000000000000000000000',
  SavePassword: 'true',
  SSL: 'false',
  SSH: 'false'
}

describe('engineForConnType', () => {
  it('maps the engines Tupai supports', () => {
    expect(engineForConnType('MYSQL')).toBe('mysql')
    expect(engineForConnType('MARIADB')).toBe('mariadb')
    expect(engineForConnType('POSTGRESQL')).toBe('postgres')
    expect(engineForConnType('ORACLE')).toBe('oracle')
    expect(engineForConnType('SQLITE')).toBe('sqlite')
    expect(engineForConnType('MONGODB')).toBe('mongodb')
  })

  it('is case-insensitive and trims', () => {
    expect(engineForConnType(' postgresql ')).toBe('postgres')
  })

  it('returns null for an engine Tupai does not implement', () => {
    expect(engineForConnType('SQLSERVER')).toBeNull()
    expect(engineForConnType('')).toBeNull()
  })
})

describe('readRawConnection', () => {
  it('reads the fields a Navicat export carries', () => {
    const raw = readRawConnection(oracleBag)
    expect(raw.name).toBe('PAYROLL 5.8')
    expect(raw.connType).toBe('ORACLE')
    expect(raw.host).toBe('db.example.test')
    expect(raw.port).toBe(1521)
    expect(raw.database).toBe('orcl.example.test')
    expect(raw.user).toBe('payroll')
    expect(raw.hasEncryptedPassword).toBe(true)
  })

  it('ignores an invalid port instead of importing NaN', () => {
    expect(readRawConnection({ ...oracleBag, Port: 'abc' }).port).toBeNull()
    expect(readRawConnection({ ...oracleBag, Port: '0' }).port).toBeNull()
    expect(readRawConnection({ ...oracleBag, Port: '99999' }).port).toBeNull()
  })

  it('does not claim a password when SavePassword is false', () => {
    const raw = readRawConnection({ ...oracleBag, SavePassword: 'false' })
    expect(raw.hasEncryptedPassword).toBe(false)
  })

  it('maps the SSH authentication method', () => {
    expect(
      readRawConnection({ ...oracleBag, SSH_AuthenMethod: 'PUBLIC KEY' }).sshAuthType
    ).toBe('privateKey')
    expect(
      readRawConnection({ ...oracleBag, SSH_AuthenMethod: 'PASSWORD' }).sshAuthType
    ).toBe('password')
  })
})

describe('toImportItem', () => {
  it('turns an Oracle export into a Tupai connection', () => {
    const item = toImportItem(readRawConnection(oracleBag), 0, [], 'id-1')
    expect(item.status).toBe('new')
    expect(item.engine).toBe('oracle')
    expect(item.needsPassword).toBe(true)
    expect(item.config).toMatchObject({
      id: 'id-1',
      name: 'PAYROLL 5.8',
      engine: 'oracle',
      host: 'db.example.test',
      port: 1521,
      database: 'orcl.example.test',
      user: 'payroll'
    })
    // The encrypted blob must never be carried into the saved config.
    expect(item.config?.password).toBeUndefined()
  })

  it('fills the port from the engine default when Navicat omitted it', () => {
    const item = toImportItem(
      readRawConnection({ ...oracleBag, Port: '' }),
      0,
      [],
      'id-1'
    )
    expect(item.config?.port).toBe(1521)
  })

  it('reports a name that already exists as a conflict', () => {
    const item = toImportItem(readRawConnection(oracleBag), 0, ['payroll 5.8'], 'id-1')
    expect(item.status).toBe('conflict')
    expect(item.config).not.toBeNull()
  })

  it('skips an engine Tupai does not support', () => {
    const item = toImportItem(
      readRawConnection({ ...oracleBag, ConnType: 'SQLSERVER' }),
      0,
      [],
      'id-1'
    )
    expect(item.status).toBe('unsupported')
    expect(item.skipReason).toBe('unsupported-engine')
    expect(item.config).toBeNull()
  })

  it('skips an entry with no name or no host', () => {
    expect(
      toImportItem(readRawConnection({ ...oracleBag, ConnectionName: '' }), 0, [], 'x')
        .skipReason
    ).toBe('missing-name')
    expect(
      toImportItem(readRawConnection({ ...oracleBag, Host: '' }), 0, [], 'x').skipReason
    ).toBe('missing-host')
  })

  it('imports a SQLite export from DatabaseFileName', () => {
    const item = toImportItem(
      readRawConnection({
        ConnectionName: 'local',
        ConnType: 'SQLITE',
        DatabaseFileName: 'C:\\data\\app.db',
        SavePassword: 'false'
      }),
      0,
      [],
      'id-1'
    )
    expect(item.engine).toBe('sqlite')
    expect(item.config?.file).toBe('C:\\data\\app.db')
    expect(item.config?.host).toBeUndefined()
  })

  it('drops SSL for Oracle with a warning instead of failing at connect', () => {
    const item = toImportItem(
      readRawConnection({ ...oracleBag, SSL: 'true' }),
      0,
      [],
      'id-1'
    )
    expect(item.config?.ssl).toBeUndefined()
    expect(item.warnings).toContain('ssl-dropped')
  })

  it('carries SSL and SSH for MySQL', () => {
    const item = toImportItem(
      readRawConnection({
        ConnectionName: 'prod',
        ConnType: 'MYSQL',
        Host: 'db.internal',
        Port: '3306',
        SSL: 'true',
        SSL_PGSSLMode: 'VERIFY-FULL',
        SSL_CACert: '/etc/ssl/ca.pem',
        SSH: 'true',
        SSH_Host: 'bastion',
        SSH_Port: '2222',
        SSH_UserName: 'ops',
        SSH_AuthenMethod: 'PUBLIC KEY',
        SSH_PrivateKey: '/home/ops/.ssh/id_ed25519'
      }),
      0,
      [],
      'id-1'
    )
    expect(item.config?.ssl).toMatchObject({
      enabled: true,
      mode: 'verify-full',
      caPath: '/etc/ssl/ca.pem'
    })
    expect(item.config?.ssh).toMatchObject({
      enabled: true,
      host: 'bastion',
      port: 2222,
      user: 'ops',
      authType: 'privateKey',
      privateKeyPath: '/home/ops/.ssh/id_ed25519'
    })
  })

  it('drops SSH for MongoDB with a warning', () => {
    const item = toImportItem(
      readRawConnection({
        ConnectionName: 'docs',
        ConnType: 'MONGODB',
        Host: 'mongo.internal',
        Port: '27017',
        SSH: 'true',
        SSH_Host: 'bastion'
      }),
      0,
      [],
      'id-1'
    )
    expect(item.config?.ssh).toBeUndefined()
    expect(item.warnings).toContain('ssh-dropped')
  })
})

describe('toNcxAttributes', () => {
  it('never writes a password', () => {
    const attrs = toNcxAttributes({
      id: 'x',
      name: 'prod',
      engine: 'mysql',
      host: 'db',
      port: 3306,
      password: 'secret'
    })
    expect(attrs.Password).toBe('')
    expect(attrs.SavePassword).toBe('false')
    expect(attrs.SSH_Password).toBe('')
    expect(attrs.SSH_SavePassword).toBe('false')
    expect(JSON.stringify(attrs)).not.toContain('secret')
  })

  it('writes the Navicat type names, not the internal ids', () => {
    const attrs = toNcxAttributes({ id: 'x', name: 'p', engine: 'postgres', host: 'h' })
    expect(attrs.ConnType).toBe('POSTGRESQL')
    const maria = toNcxAttributes({ id: 'x', name: 'm', engine: 'mariadb', host: 'h' })
    expect(maria.ConnType).toBe('MARIADB')
  })

  it('round-trips through the reader', () => {
    const attrs = toNcxAttributes({
      id: 'x',
      name: 'prod',
      engine: 'postgres',
      host: 'db.internal',
      port: 5433,
      user: 'app',
      database: 'shop',
      ssl: { enabled: true, mode: 'verify-ca', caPath: '/ca.pem' }
    })
    const item = toImportItem(readRawConnection(attrs), 0, [], 'id-2')
    expect(item.config).toMatchObject({
      name: 'prod',
      engine: 'postgres',
      host: 'db.internal',
      port: 5433,
      user: 'app',
      database: 'shop',
      ssl: { enabled: true, mode: 'verify-ca', caPath: '/ca.pem' }
    })
  })
})
