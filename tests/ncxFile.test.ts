import { describe, expect, it } from 'vitest'
import { buildNcx, parseNcx } from '../src/main/connection/ncx'

// A sanitised copy of a real Navicat Premium 16 export: same element and
// attribute shape, fake host and credentials.
const NAVICAT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.5">
	<Connection ConnectionName="PAYROLL 5.8" ProjectUUID="" ConnType="ORACLE" ServiceProvider="Default" OraConnType="BASIC" Host="db.example.test" Port="1521" Database="orcl.example.test" OraServiceNameType="SERVICENAME" TNS="" MSSQLAuthenMode="" MSSQLAuthenWindowsDomain="" DatabaseFileName="" UserName="payroll" Password="00000000000000000000000000000000" SavePassword="true" SettingsSavePath="" SessionLimit="0" Encoding="" Keepalive="false" KeepaliveInterval="240" MySQLCharacterSet="false" Compression="false" AutoConnect="false" NamedPipe="false" NamedPipeSocket="" OraRole="DEFAULT" OraOSAuthen="false" SQLiteEncrypt="false" SQLiteEncryptPassword="" SQLiteSaveEncryptPassword="false" UseAdvanced="true" ClientCharsetID="0" ClientEncoding="65001" SSL="false" SSL_Authen="false" SSL_PGSSLMode="REQUIRE" SSL_ClientKey="" SSL_ClientCert="" SSL_CACert="" SSL_Clpher="" SSL_PGSSLCRL="" SSL_WeakCertValidation="false" SSL_AllowInvalidHostName="false" SSL_PEMClientKeyPassword="" SSH="false" SSH_Host="" SSH_Port="22" SSH_UserName="" SSH_AuthenMethod="PASSWORD" SSH_Password="" SSH_SavePassword="false" SSH_PrivateKey="" SSH_Passphrase="" SSH_SavePassphrase="false" SSH_Compress="false" HTTP="false" HTTP_URL="" HTTP_PA="" HTTP_PA_UserName="" HTTP_PA_Password="" HTTP_PA_SavePassword="" HTTP_EQ="" HTTP_CA="" HTTP_CA_ClientKey="" HTTP_CA_ClientCert="" HTTP_CA_CACert="" HTTP_CA_Passphrase="" HTTP_Proxy="" HTTP_Proxy_Host="" HTTP_Proxy_Port="" HTTP_Proxy_UserName="" HTTP_Proxy_Password="" HTTP_Proxy_SavePassword="">
		<Advance Database="PAYROLL" UserName="" Password="" SQLitePath="" SQLiteEncrypt="" SQLiteEncryptPassword="" SQLiteSaveEncryptPassword="" ShowDB="true" AutoOpen="false"/>
		<Advance Database="IT_DEV" UserName="" Password="" SQLitePath="" SQLiteEncrypt="" SQLiteEncryptPassword="" SQLiteSaveEncryptPassword="" ShowDB="true" AutoOpen="false"/>
	</Connection>
	<Connection ConnectionName="Shop &amp; Co" ConnType="MYSQL" Host="mysql.example.test" Port="3306" UserName="app" Password="" SavePassword="false" SSL="true" SSL_PGSSLMode="REQUIRE" SSH="false"/>
	<Connection ConnectionName="Legacy MSSQL" ConnType="SQLSERVER" Host="mssql.example.test" Port="1433" SavePassword="false"/>
</Connections>`

describe('parseNcx', () => {
  it('reads every connection from a Navicat export', () => {
    const result = parseNcx(NAVICAT_XML, [])
    expect(result.invalid).toBe(false)
    expect(result.items).toHaveLength(3)
  })

  it('maps an Oracle entry and its databases', () => {
    const [oracle] = parseNcx(NAVICAT_XML, []).items
    expect(oracle.engine).toBe('oracle')
    expect(oracle.name).toBe('PAYROLL 5.8')
    expect(oracle.host).toBe('db.example.test')
    expect(oracle.port).toBe(1521)
    expect(oracle.needsPassword).toBe(true)
    expect(oracle.config?.database).toBe('orcl.example.test')
  })

  it('decodes XML entities in a name', () => {
    const shop = parseNcx(NAVICAT_XML, []).items[1]
    expect(shop.name).toBe('Shop & Co')
    expect(shop.config?.name).toBe('Shop & Co')
  })

  it('marks an unsupported engine instead of dropping it silently', () => {
    const legacy = parseNcx(NAVICAT_XML, []).items[2]
    expect(legacy.status).toBe('unsupported')
    expect(legacy.skipReason).toBe('unsupported-engine')
    expect(legacy.name).toBe('Legacy MSSQL')
  })

  it('flags a name that already exists in Tupai', () => {
    const items = parseNcx(NAVICAT_XML, ['PAYROLL 5.8']).items
    expect(items[0].status).toBe('conflict')
    expect(items[1].status).toBe('new')
  })

  it('treats a file that is not a Navicat export as invalid', () => {
    expect(parseNcx('<Something/>', []).invalid).toBe(true)
    expect(parseNcx('not xml at all', []).invalid).toBe(true)
  })

  it('accepts a UTF-8 BOM, which the exporter writes', () => {
    const withBom = `\uFEFF${NAVICAT_XML}`
    expect(parseNcx(withBom, []).items).toHaveLength(3)
  })

  it('ignores attributes a newer Navicat adds', () => {
    const extra = NAVICAT_XML.replace(
      'ConnType="MYSQL"',
      'ConnType="MYSQL" SomeFutureOption="42"'
    )
    expect(parseNcx(extra, []).items[1].config?.name).toBe('Shop & Co')
  })
})

describe('buildNcx', () => {
  const connection = {
    id: 'c1',
    name: 'Shop & Co',
    engine: 'mysql' as const,
    host: 'mysql.example.test',
    port: 3306,
    user: 'app',
    database: 'shop'
  }

  it('writes a document Navicat can read back', () => {
    const xml = buildNcx([connection])
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('<Connections Ver="1.5">')
    expect(xml).toContain('ConnType="MYSQL"')
    // The ampersand must be escaped, or the file is not well-formed XML.
    expect(xml).toContain('ConnectionName="Shop &amp; Co"')
  })

  it('never writes a password or a passphrase', () => {
    const xml = buildNcx([
      {
        ...connection,
        password: 'secret-value',
        ssh: {
          enabled: true,
          host: 'b',
          user: 'u',
          authType: 'password',
          password: 'ssh-secret'
        }
      }
    ])
    expect(xml).not.toContain('secret-value')
    expect(xml).not.toContain('ssh-secret')
    expect(xml).toContain('SavePassword="false"')
    expect(xml).toContain('SSH_SavePassword="false"')
  })

  it('round-trips through the parser', () => {
    const xml = buildNcx([connection])
    const item = parseNcx(xml, []).items[0]
    expect(item.config).toMatchObject({
      name: 'Shop & Co',
      engine: 'mysql',
      host: 'mysql.example.test',
      port: 3306,
      user: 'app',
      database: 'shop'
    })
  })

  it('writes booleans as values, not bare attributes', () => {
    // Navicat reads `ShowDB="true"`; a bare `ShowDB` means nothing to it.
    const xml = buildNcx([connection])
    expect(xml).toMatch(/ShowDB="true"/)
  })
})
