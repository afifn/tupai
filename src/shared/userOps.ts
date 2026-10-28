import type { DbEngine, PrivilegeObjectType, UserOperation } from './types'
import { isMysqlFamily, quoteIdent, qualifiedTable } from './ddl'

// Single quotes are the SQL string delimiter here; escaping only needs to
// cover the backslash-heavy MySQL and the standard doubled quote.
function sqlLiteral(engine: DbEngine, value: string): string {
  if (isMysqlFamily(engine)) {
    return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
  }
  return "'" + value.replace(/'/g, "''") + "'"
}

// Oracle's `IDENTIFIED BY` takes a password *identifier*, not a string literal:
// `IDENTIFIED BY 'abc'` always fails with ORA-00988 whatever the value. A quoted
// identifier is the only form that also survives digits, punctuation, reserved
// words and mixed case, and it keeps the password exactly as typed.
function oraclePassword(password: string): string {
  return '"' + password.replace(/"/g, '""') + '"'
}

function account(engine: DbEngine, user: string, host?: string): string {
  const name = quoteIdent(engine, user)
  if (isMysqlFamily(engine)) {
    return `${name}@${sqlLiteral(engine, host ?? '%')}`
  }
  return name
}

function privilegeObject(engine: DbEngine, op: UserOperation): string {
  if (op.kind !== 'grant' && op.kind !== 'revoke')
    throw new Error('Unsupported operation for privilege object')
  if (op.onType === 'database') {
    if (engine === 'oracle') {
      // Oracle has no database-level object privilege. Emitting
      // `GRANT SELECT ON DATABASE x` only ever produced ORA-00905.
      throw new Error(
        'Oracle tidak punya hak akses per database. Gunakan scope Tabel, atau System Privileges untuk hak tingkat sistem.'
      )
    }
    return `DATABASE ${quoteIdent(engine, op.database)}`
  }
  if (op.onType === 'schema') {
    if (engine === 'oracle') {
      // Schema-wide grants are expanded per object in the main process, because
      // Oracle cannot express them as one statement.
      throw new Error(
        'Hak akses per schema di Oracle harus diberikan per objek, bukan satu statement.'
      )
    }
    const schema = op.schema ?? op.database
    return `SCHEMA ${quoteIdent(engine, schema)}`
  }
  if (!op.table) throw new Error('Table name required for table-level privileges')
  if (engine === 'postgres') {
    return `TABLE ${qualifiedTable(engine, op.table, op.schema)}`
  }
  if (isMysqlFamily(engine)) {
    // MySQL spells a table privilege as `db`.`table`; a bare name would apply
    // to whatever database the session happens to be in.
    return `TABLE ${qualifiedTable(engine, op.table, undefined, op.database)}`
  }
  // Oracle has no ON TABLE keyword: GRANT SELECT ON "schema"."table" TO user.
  return qualifiedTable(engine, op.table, op.schema ?? op.database)
}

export function buildUserSql(engine: DbEngine, op: UserOperation): string[] {
  switch (op.kind) {
    case 'createUser': {
      const who = account(engine, op.username, op.host)
      if (engine === 'postgres') {
        const parts: string[] = []
        if (op.canLogin) parts.push('LOGIN')
        else parts.push('NOLOGIN')
        if (op.superuser) parts.push('SUPERUSER')
        parts.push(`PASSWORD ${sqlLiteral(engine, op.password)}`)
        return [`CREATE USER ${who} WITH ${parts.join(' ')};`]
      }
      if (engine === 'oracle') {
        // A fresh Oracle account has no privileges at all, so it cannot even
        // connect: the form's "can login" and "superuser" boxes used to be
        // ignored here and every created user failed with ORA-01045.
        const statements = [
          `CREATE USER ${who} IDENTIFIED BY ${oraclePassword(op.password)};`
        ]
        if (op.canLogin) statements.push(`GRANT CREATE SESSION TO ${who};`)
        else statements.push(`ALTER USER ${who} ACCOUNT LOCK;`)
        if (op.superuser) statements.push(`GRANT DBA TO ${who};`)
        return statements
      }
      // MySQL/MariaDB take the password as a string literal, so the escaping
      // there stays as it was.
      return [`CREATE USER ${who} IDENTIFIED BY ${sqlLiteral(engine, op.password)};`]
    }
    case 'dropUser': {
      const who = account(engine, op.username, op.host)
      return [`DROP USER ${who};`]
    }
    case 'grant': {
      const who = account(engine, op.user, op.host)
      const privs = op.privileges.join(', ')
      return [`GRANT ${privs} ON ${privilegeObject(engine, op)} TO ${who};`]
    }
    case 'revoke': {
      const who = account(engine, op.user, op.host)
      const privs = op.privileges.join(', ')
      return [`REVOKE ${privs} ON ${privilegeObject(engine, op)} FROM ${who};`]
    }
    case 'grantSystem': {
      requireSystemPrivileges(engine, op.privileges)
      const who = account(engine, op.user, op.host)
      return [`GRANT ${op.privileges.join(', ')} TO ${who};`]
    }
    case 'revokeSystem': {
      requireSystemPrivileges(engine, op.privileges)
      const who = account(engine, op.user, op.host)
      return [`REVOKE ${op.privileges.join(', ')} FROM ${who};`]
    }
  }
}

function requireSystemPrivileges(engine: DbEngine, privileges: string[]): void {
  if (engine !== 'oracle') {
    throw new Error('System privileges hanya tersedia untuk Oracle.')
  }
  if (privileges.length === 0) throw new Error('Pilih minimal satu system privilege.')
}

/**
 * Expands a schema-wide grant into one statement per object. Oracle has no
 * `GRANT ... ON SCHEMA`, so the objects are listed first and each one gets its
 * own statement; the caller runs them in a single transaction.
 */
export function schemaObjectGrants(
  engine: DbEngine,
  op: {
    kind: 'grant' | 'revoke'
    user: string
    host?: string
    privileges: string[]
    schema: string
  },
  objects: string[]
): string[] {
  if (engine !== 'oracle') {
    throw new Error('Hak akses massal per schema hanya tersedia untuk Oracle.')
  }
  if (objects.length === 0) {
    throw new Error(`Tidak ada objek di schema ${op.schema}.`)
  }
  const who = account(engine, op.user, op.host)
  const privs = op.privileges.join(', ')
  const verb = op.kind === 'grant' ? 'GRANT' : 'REVOKE'
  const target = op.kind === 'grant' ? 'TO' : 'FROM'
  return objects.map(
    (name) =>
      `${verb} ${privs} ON ${qualifiedTable(engine, name, op.schema)} ${target} ${who};`
  )
}

/**
 * Object scopes this engine can actually express. The UI renders only these, so
 * a scope that would produce invalid SQL is never offered.
 */
export function privilegeScopes(engine: DbEngine): PrivilegeObjectType[] {
  if (engine === 'oracle') return ['table', 'schema']
  if (isMysqlFamily(engine)) return ['database', 'table']
  return ['database', 'schema', 'table']
}

export function privilegeChoices(engine: DbEngine): string[] {
  if (engine === 'postgres') {
    return [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
      'ALL'
    ]
  }
  if (engine === 'oracle') {
    return ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'INDEX', 'REFERENCES', 'ALL']
  }
  return [
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'CREATE',
    'DROP',
    'ALTER',
    'INDEX',
    'ALL'
  ]
}

/**
 * Oracle system privileges, granted without an ON clause. Kept to the ones an
 * administrator hands out in day-to-day work; the full list has hundreds of
 * entries and `GRANT ANY PRIVILEGE` covers the rest.
 */
export function systemPrivilegeChoices(engine: DbEngine): string[] {
  if (engine !== 'oracle') return []
  return [
    'CREATE SESSION',
    'CREATE TABLE',
    'CREATE VIEW',
    'CREATE SEQUENCE',
    'CREATE PROCEDURE',
    'CREATE TRIGGER',
    'CREATE ANY TABLE',
    'SELECT ANY TABLE',
    'INSERT ANY TABLE',
    'UPDATE ANY TABLE',
    'DELETE ANY TABLE',
    'UNLIMITED TABLESPACE',
    'DBA'
  ]
}
