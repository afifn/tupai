import type { DbEngine, UserOperation } from './types'
import { isMysqlFamily, quoteIdent, qualifiedTable } from './ddl'

// Single quotes are the SQL string delimiter here; escaping only needs to
// cover the backslash-heavy MySQL and the standard doubled quote.
function sqlLiteral(engine: DbEngine, value: string): string {
  if (isMysqlFamily(engine)) {
    return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
  }
  return "'" + value.replace(/'/g, "''") + "'"
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
    return `DATABASE ${quoteIdent(engine, op.database)}`
  }
  if (op.onType === 'schema') {
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
  }
}

export function privilegeChoices(engine: DbEngine): string[] {
  if (engine === 'postgres') {
    return ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']
  }
  if (engine === 'oracle') {
    return ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'INDEX', 'REFERENCES', 'ALL']
  }
  return ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'ALL']
}
