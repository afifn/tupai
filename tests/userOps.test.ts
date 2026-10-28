import { describe, expect, it } from 'vitest'
import {
  buildUserSql,
  privilegeScopes,
  schemaObjectGrants,
  systemPrivilegeChoices
} from '@shared/userOps'
import type { UserOperation } from '@shared/types'

// Oracle rejects `IDENTIFIED BY 'literal'` with ORA-00988: the clause takes a
// password identifier, not a string. Every case below is a password shape the
// form allows, so the generated SQL has to survive all of them.
describe('buildUserSql: createUser on Oracle', () => {
  const create = (
    password: string,
    extra: Partial<{ canLogin: boolean; superuser: boolean }> = {}
  ) =>
    buildUserSql('oracle', {
      kind: 'createUser',
      username: 'APP',
      password,
      canLogin: extra.canLogin ?? true,
      superuser: extra.superuser ?? false
    })

  it('quotes the password as an identifier, never as a string literal', () => {
    expect(create('abc123')[0]).toBe('CREATE USER "APP" IDENTIFIED BY "abc123";')
    expect(create('abc123')[0]).not.toContain("'")
  })

  it('keeps a password that starts with a digit', () => {
    expect(create('123abc')[0]).toContain('IDENTIFIED BY "123abc"')
  })

  it('keeps punctuation and mixed case exactly as typed', () => {
    expect(create('p@ss-W0rd!#')[0]).toContain('IDENTIFIED BY "p@ss-W0rd!#"')
  })

  it('keeps a password that is a reserved word', () => {
    expect(create('SELECT')[0]).toContain('IDENTIFIED BY "SELECT"')
  })

  it('escapes an embedded double quote', () => {
    expect(create('a"b')[0]).toContain('IDENTIFIED BY "a""b"')
  })

  it('grants CREATE SESSION so the new account can actually connect', () => {
    // Without this a fresh Oracle user fails with ORA-01045 on first login.
    expect(create('abc123')).toEqual([
      'CREATE USER "APP" IDENTIFIED BY "abc123";',
      'GRANT CREATE SESSION TO "APP";'
    ])
  })

  it('locks the account when "can login" is off', () => {
    expect(create('abc123', { canLogin: false })).toEqual([
      'CREATE USER "APP" IDENTIFIED BY "abc123";',
      'ALTER USER "APP" ACCOUNT LOCK;'
    ])
  })

  it('grants DBA when "superuser" is on', () => {
    expect(create('abc123', { superuser: true })).toContain('GRANT DBA TO "APP";')
  })
})

describe('buildUserSql: other engines are untouched', () => {
  it('keeps the MySQL password as a string literal', () => {
    expect(
      buildUserSql('mysql', {
        kind: 'createUser',
        username: 'app',
        host: '%',
        password: "p'a\\ss",
        canLogin: true,
        superuser: false
      })
    ).toEqual([`CREATE USER \`app\`@'%' IDENTIFIED BY 'p''a\\\\ss';`])
  })

  it('keeps the PostgreSQL form', () => {
    expect(
      buildUserSql('postgres', {
        kind: 'createUser',
        username: 'app',
        password: 'abc',
        canLogin: true,
        superuser: false
      })
    ).toEqual([`CREATE USER "app" WITH LOGIN PASSWORD 'abc';`])
  })
})

// Oracle has object privileges only. `GRANT ... ON DATABASE` and
// `GRANT ... ON SCHEMA` are not Oracle syntax and always failed with ORA-00905.
describe('buildUserSql: Oracle never emits an invalid scope', () => {
  const grant = (onType: 'database' | 'table' | 'schema'): UserOperation => ({
    kind: 'grant',
    user: 'APP',
    privileges: ['SELECT'],
    onType,
    database: 'PAYROLL',
    schema: 'PAYROLL',
    table: 'KARYAWAN'
  })

  it('rejects the database scope with a readable reason', () => {
    expect(() => buildUserSql('oracle', grant('database'))).toThrow(/per database/i)
  })

  it('rejects a single-statement schema scope', () => {
    expect(() => buildUserSql('oracle', grant('schema'))).toThrow(/per objek/i)
  })

  it('grants per table without the ON TABLE keyword', () => {
    expect(buildUserSql('oracle', grant('table'))).toEqual([
      'GRANT SELECT ON "PAYROLL"."KARYAWAN" TO "APP";'
    ])
  })

  it('revokes per table', () => {
    expect(
      buildUserSql('oracle', { ...grant('table'), kind: 'revoke' } as UserOperation)
    ).toEqual(['REVOKE SELECT ON "PAYROLL"."KARYAWAN" FROM "APP";'])
  })

  it('still allows the database scope on PostgreSQL and MySQL', () => {
    expect(buildUserSql('postgres', grant('database'))).toEqual([
      'GRANT SELECT ON DATABASE "PAYROLL" TO "APP";'
    ])
    expect(buildUserSql('mysql', grant('database'))).toEqual([
      "GRANT SELECT ON DATABASE `PAYROLL` TO `APP`@'%';"
    ])
  })

  it('never produces ON DATABASE or ON SCHEMA for Oracle', () => {
    const scopes: ('database' | 'table' | 'schema')[] = ['database', 'table', 'schema']
    for (const scope of scopes) {
      for (const kind of ['grant', 'revoke'] as const) {
        let sql: string[] | null = null
        try {
          sql = buildUserSql('oracle', { ...grant(scope), kind } as UserOperation)
        } catch {
          // Refusing is the correct outcome for the unsupported scopes.
        }
        for (const statement of sql ?? []) {
          expect(statement).not.toMatch(/ON\s+(DATABASE|SCHEMA)\s/i)
        }
      }
    }
  })
})

describe('privilegeScopes', () => {
  it('offers only the scopes each engine can express', () => {
    expect(privilegeScopes('oracle')).toEqual(['table', 'schema'])
    expect(privilegeScopes('mysql')).toEqual(['database', 'table'])
    expect(privilegeScopes('mariadb')).toEqual(['database', 'table'])
    expect(privilegeScopes('postgres')).toEqual(['database', 'schema', 'table'])
  })

  it('never offers a database scope for Oracle', () => {
    expect(privilegeScopes('oracle')).not.toContain('database')
  })
})

// Schema-wide grants are expanded per object: one statement per table, so the
// preview shows exactly what will run.
describe('schemaObjectGrants', () => {
  const op = {
    kind: 'grant' as const,
    user: 'APP',
    privileges: ['SELECT'],
    schema: 'PAYROLL'
  }

  it('emits one statement per object', () => {
    expect(schemaObjectGrants('oracle', op, ['KARYAWAN', 'BAGIAN'])).toEqual([
      'GRANT SELECT ON "PAYROLL"."KARYAWAN" TO "APP";',
      'GRANT SELECT ON "PAYROLL"."BAGIAN" TO "APP";'
    ])
  })

  it('revokes with FROM instead of TO', () => {
    expect(schemaObjectGrants('oracle', { ...op, kind: 'revoke' }, ['KARYAWAN'])).toEqual(
      ['REVOKE SELECT ON "PAYROLL"."KARYAWAN" FROM "APP";']
    )
  })

  it('refuses an empty schema instead of emitting nothing', () => {
    expect(() => schemaObjectGrants('oracle', op, [])).toThrow(/tidak ada objek/i)
  })

  it('is Oracle-only', () => {
    expect(() => schemaObjectGrants('postgres', op, ['t'])).toThrow(/Oracle/i)
  })
})

// System privileges carry no ON clause; keeping them a separate operation is
// what makes that impossible to confuse with an object privilege.
describe('buildUserSql: system privileges', () => {
  it('grants without an ON clause', () => {
    expect(
      buildUserSql('oracle', {
        kind: 'grantSystem',
        user: 'APP',
        privileges: ['CREATE SESSION', 'CREATE TABLE']
      })
    ).toEqual(['GRANT CREATE SESSION, CREATE TABLE TO "APP";'])
  })

  it('revokes without an ON clause', () => {
    expect(
      buildUserSql('oracle', {
        kind: 'revokeSystem',
        user: 'APP',
        privileges: ['DBA']
      })
    ).toEqual(['REVOKE DBA FROM "APP";'])
  })

  it('is not offered for other engines', () => {
    expect(systemPrivilegeChoices('oracle').length).toBeGreaterThan(0)
    expect(systemPrivilegeChoices('postgres')).toEqual([])
    expect(systemPrivilegeChoices('mysql')).toEqual([])
  })

  it('refuses to build a system grant for another engine', () => {
    expect(() =>
      buildUserSql('postgres', { kind: 'grantSystem', user: 'app', privileges: ['DBA'] })
    ).toThrow(/Oracle/i)
  })
})
