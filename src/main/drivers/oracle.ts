import type { Connection } from 'oracledb'
import type {
  ColumnInfo,
  ConnectionConfig,
  DbEngine,
  DbUser,
  ForeignKeyInfo,
  IndexInfo,
  PageQuery,
  PrimaryKeyInfo,
  QueryResultSet,
  RowChangeResult,
  RowChangeSet,
  RowDelete,
  RowInsert,
  RowUpdate,
  RoutineInfo,
  RoutineKind,
  SearchResult,
  SessionInfo,
  TableInfo,
  TableInfoDetail,
  TableStat
} from '@shared/types'
import { buildFilterWhere, toOracleBinds } from '@shared/filter'
import {
  DbError,
  orderClause,
  qualifiedTable,
  quoteIdent,
  splitStatements,
  summarizeStatement,
  type DatabaseAdapter
} from './types'
import { sslEnabled } from '../connection/ssl'
import { sshEnabled } from '../connection/sshTunnel'

const QUERY_TIMEOUT_MS = 30000

class OracleAdapter implements DatabaseAdapter {
  readonly engine: DbEngine = 'oracle'
  private connection: Connection | null = null
  private config: ConnectionConfig | null = null

  private buildConnectString(cfg: ConnectionConfig): string {
    if (sshEnabled(cfg.ssh)) {
      throw new DbError(
        'SSH_NOT_SUPPORTED',
        'SSH tunnel belum didukung untuk Oracle. Nonaktifkan SSH di form koneksi.',
        this.engine
      )
    }
    // Oracle TLS is configured through TCPS descriptors or a wallet, not the
    // simple host:port form, so a plain "SSL on" is rejected with a clear
    // message rather than silently connecting in the clear.
    if (sslEnabled(cfg.ssl)) {
      throw new DbError(
        'SSL_NOT_SUPPORTED',
        'SSL Oracle memerlukan konfigurasi TCPS/wallet. Nonaktifkan SSL di form atau atur wallet Oracle secara manual.',
        this.engine
      )
    }
    if (cfg.database) return `${cfg.host}:${cfg.port}/${cfg.database}`
    return `${cfg.host}:${cfg.port}`
  }

  async testConnection(cfg: ConnectionConfig): Promise<boolean> {
    const oracledb = await import('oracledb')
    const conn = await oracledb.getConnection({
      user: cfg.user,
      password: cfg.password,
      connectString: this.buildConnectString(cfg)
    })
    await conn.close()
    return true
  }

  async connect(cfg: ConnectionConfig): Promise<void> {
    const oracledb = await import('oracledb')
    this.config = cfg
    this.connection = await oracledb.getConnection({
      user: cfg.user,
      password: cfg.password,
      connectString: this.buildConnectString(cfg)
    })
    this.connection.callTimeout = QUERY_TIMEOUT_MS
  }

  async disconnect(): Promise<void> {
    await this.connection?.close()
    this.connection = null
    this.config = null
  }

  private require(): Connection {
    if (!this.connection) throw new DbError('NOT_CONNECTED', 'Not connected', this.engine)
    return this.connection
  }

  private schema(): string {
    return (this.config?.user ?? '').toUpperCase()
  }

  // Ask oracledb for BLOB/RAW columns as Buffers instead of Lob handles so the
  // preview layer can inspect the bytes without a second round-trip.
  private fetchOptions(oracledb: typeof import('oracledb')): {
    outFormat: number
    fetchTypeHandler: (metaData: { dbType: number }) => { type: number } | undefined
  } {
    return {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      fetchTypeHandler: (metaData) => {
        if (metaData.dbType === oracledb.DB_TYPE_BLOB) {
          return { type: oracledb.BUFFER }
        }
        if (metaData.dbType === oracledb.DB_TYPE_RAW) {
          return { type: oracledb.BUFFER }
        }
        return undefined
      }
    }
  }

  private static readonly SYSTEM_USERS = new Set([
    'SYS',
    'SYSTEM',
    'OUTLN',
    'DBSNMP',
    'APPQOSSYS',
    'AUDSYS',
    'CTXSYS',
    'DVSYS',
    'GSMADMIN_INTERNAL',
    'LBACSYS',
    'MDSYS',
    'OJVMSYS',
    'ORDDATA',
    'ORDSYS',
    'WMSYS',
    'XDB',
    'REMOTE_SCHEDULER_AGENT',
    'SYSBACKUP',
    'SYSDG',
    'SYSKM',
    'SYSRAC',
    'XS$NULL'
  ])

  private userListSql(): string {
    return `SELECT username FROM all_users
            WHERE username NOT IN (${[...OracleAdapter.SYSTEM_USERS]
              .map((u) => `'${u}'`)
              .join(', ')})
            ORDER BY username`
  }

  async listDatabases(): Promise<string[]> {
    const res = await this.require().execute(this.userListSql())
    return (res.rows ?? []).map((r) => String((r as unknown[])[0]))
  }

  async listSchemas(): Promise<string[]> {
    const res = await this.require().execute(this.userListSql())
    return (res.rows ?? []).map((r) => String((r as unknown[])[0]))
  }

  async listTables(database: string, schema?: string): Promise<TableInfo[]> {
    const owner = (schema ?? database ?? this.schema()).toUpperCase()
    const res = await this.require().execute(
      `SELECT table_name, 'TABLE' AS kind FROM all_tables WHERE owner = :owner
       UNION ALL
       SELECT view_name, 'VIEW' AS kind FROM all_views WHERE owner = :owner
       ORDER BY 1`,
      { owner }
    )
    return (res.rows ?? []).map((r) => {
      const [name, kind] = r as [string, string]
      return {
        name,
        schema: owner,
        type: kind === 'VIEW' ? 'view' : 'table'
      }
    })
  }

  async getPrimaryKey(
    _database: string,
    table: string,
    schema?: string
  ): Promise<PrimaryKeyInfo | null> {
    const owner = (schema ?? this.schema()).toUpperCase()
    const res = await this.require().execute(
      `SELECT con.constraint_name, cc.column_name
       FROM all_constraints con
       JOIN all_cons_columns cc
         ON cc.owner = con.owner AND cc.constraint_name = con.constraint_name
       WHERE con.constraint_type = 'P' AND con.owner = :owner AND con.table_name = :tbl
       ORDER BY cc.position`,
      { owner, tbl: table.toUpperCase() }
    )
    const rows = (res.rows ?? []) as [string, string][]
    if (rows.length === 0) return null
    return { name: rows[0][0], columns: rows.map((r) => r[1]) }
  }

  async listColumns(
    _database: string,
    table: string,
    schema?: string
  ): Promise<ColumnInfo[]> {
    const owner = (schema ?? this.schema()).toUpperCase()
    // data_type alone is "VARCHAR2"/"NUMBER" without the declared size, so a
    // structure diff saw every sized column as different from its target and a
    // Table Designer round-trip dropped the length. Rebuild the spelling the
    // user originally declared.
    const res = await this.require().execute(
      `SELECT c.column_name, c.data_type, c.data_length, c.data_precision, c.data_scale,
              c.nullable, c.data_default, c.identity_column,
              (SELECT cc.comments FROM all_col_comments cc
                WHERE cc.owner = c.owner AND cc.table_name = c.table_name
                  AND cc.column_name = c.column_name) AS comments,
              CASE WHEN pk.column_name IS NOT NULL THEN 'Y' ELSE 'N' END AS is_pk
       FROM all_tab_columns c
       LEFT JOIN (
         SELECT cc.column_name
         FROM all_constraints con
         JOIN all_cons_columns cc
           ON cc.owner = con.owner AND cc.constraint_name = con.constraint_name
         WHERE con.constraint_type = 'P' AND con.owner = :owner AND con.table_name = :tbl
       ) pk ON pk.column_name = c.column_name
       WHERE c.owner = :owner AND c.table_name = :tbl
       ORDER BY c.column_id`,
      { owner, tbl: table.toUpperCase() }
    )
    return (res.rows ?? []).map((r) => {
      const [
        name,
        dataType,
        dataLength,
        precision,
        scale,
        nullable,
        dataDefault,
        identity,
        comment,
        isPk
      ] = r as [
        string,
        string,
        number | null,
        number | null,
        number | null,
        string,
        string | null,
        string,
        string | null,
        string
      ]
      let type = dataType
      if (dataType === 'VARCHAR2' || dataType === 'NVARCHAR2' || dataType === 'CHAR') {
        if (dataLength) type = `${dataType}(${dataLength})`
      } else if (dataType === 'NUMBER' && precision) {
        type = scale ? `NUMBER(${precision},${scale})` : `NUMBER(${precision})`
      } else if (dataType === 'RAW' && dataLength) {
        type = `RAW(${dataLength})`
      }
      return {
        name,
        dataType: type,
        nullable: nullable === 'Y',
        defaultValue: dataDefault ? dataDefault.trim() : null,
        isPrimaryKey: isPk === 'Y',
        autoIncrement: identity === 'YES',
        comment: comment ?? null
      }
    })
  }

  async selectRows(query: PageQuery): Promise<{
    rows: Record<string, unknown>[]
    total: number
  }> {
    const conn = this.require()
    const owner = (query.schema ?? this.schema()).toUpperCase()
    const table = qualifiedTable(this.engine, query.table, owner)
    let where = ''
    const binds: Record<string, unknown> = {}
    if (
      query.filterColumn &&
      query.filterValue !== undefined &&
      query.filterValue !== ''
    ) {
      where = ` WHERE TO_CHAR(${quoteIdent(this.engine, query.filterColumn)}) LIKE :flt`
      binds.flt = `%${query.filterValue}%`
    }
    if (query.filters && query.filters.length > 0) {
      const built = buildFilterWhere(
        this.engine,
        query.filters,
        query.filterLogic,
        (identifier) => quoteIdent(this.engine, identifier)
      )
      if (built.where) {
        where = built.where
        // Oracle binds are named; drop the legacy filter bind and add the new ones.
        delete binds.flt
        Object.assign(binds, toOracleBinds(built.params))
      }
    }
    const countRes = await conn.execute(
      `SELECT COUNT(*) AS n FROM ${table}${where}`,
      binds
    )
    const total = Number((countRes.rows?.[0] as unknown[])?.[0] ?? 0)
    let order = ''
    if (query.orderBy) {
      const dir = query.orderDir === 'desc' ? 'DESC' : 'ASC'
      order = ` ORDER BY ${quoteIdent(this.engine, query.orderBy)} ${dir}`
    }
    binds.off = query.offset
    binds.lim = query.limit
    const oracledb = await import('oracledb')
    const res = await conn.execute(
      `SELECT * FROM ${table}${where}${order} OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`,
      binds,
      this.fetchOptions(oracledb)
    )
    return { rows: (res.rows ?? []) as Record<string, unknown>[], total }
  }

  async fetchBatch(query: PageQuery): Promise<Record<string, unknown>[]> {
    const oracledb = await import('oracledb')
    const conn = this.require()
    const owner = (query.schema ?? this.schema()).toUpperCase()
    const table = qualifiedTable(this.engine, query.table, owner)
    const order = orderClause(
      this.engine,
      query.orderBy,
      query.orderDir,
      query.orderByColumns
    )
    const res = await conn.execute(
      `SELECT * FROM ${table}${order} OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`,
      { off: query.offset, lim: query.limit },
      this.fetchOptions(oracledb)
    )
    return (res.rows ?? []) as Record<string, unknown>[]
  }

  async updateRow(update: RowUpdate): Promise<void> {
    const owner = (update.schema ?? this.schema()).toUpperCase()
    const table = qualifiedTable(this.engine, update.table, owner)
    const cols = Object.keys(update.changes)
    if (cols.length === 0) return
    const binds: Record<string, unknown> = {}
    const setClause = cols
      .map((k, i) => {
        binds[`s${i}`] = update.changes[k]
        return `${quoteIdent(this.engine, k)} = :s${i}`
      })
      .join(', ')
    const where = this.buildWhere(update.primaryKeys, binds, 'w')
    await this.require().execute(
      `UPDATE ${table} SET ${setClause} WHERE ${where}`,
      binds,
      { autoCommit: true }
    )
  }

  async insertRow(insert: RowInsert): Promise<void> {
    const owner = (insert.schema ?? this.schema()).toUpperCase()
    const table = qualifiedTable(this.engine, insert.table, owner)
    const cols = Object.keys(insert.values)
    if (cols.length === 0)
      throw new DbError('INVALID', 'No values to insert', this.engine)
    const binds: Record<string, unknown> = {}
    const colList = cols.map((k) => quoteIdent(this.engine, k)).join(', ')
    const marks = cols
      .map((k, i) => {
        binds[`v${i}`] = insert.values[k]
        return `:v${i}`
      })
      .join(', ')
    await this.require().execute(
      `INSERT INTO ${table} (${colList}) VALUES (${marks})`,
      binds,
      { autoCommit: true }
    )
  }

  async insertRows(
    _database: string,
    schema: string | undefined,
    table: string,
    rows: Record<string, unknown>[]
  ): Promise<number> {
    if (rows.length === 0) return 0
    const owner = (schema ?? this.schema()).toUpperCase()
    const target = qualifiedTable(this.engine, table, owner)
    const cols = Object.keys(rows[0])
    const colList = cols.map((k) => quoteIdent(this.engine, k)).join(', ')
    const marks = cols.map((_, i) => `:v${i}`).join(', ')
    const conn = this.require()
    let count = 0
    for (const row of rows) {
      const binds: Record<string, unknown> = {}
      cols.forEach((k, i) => {
        binds[`v${i}`] = row[k]
      })
      await conn.execute(`INSERT INTO ${target} (${colList}) VALUES (${marks})`, binds, {
        autoCommit: true
      })
      count += 1
    }
    return count
  }

  async deleteRow(del: RowDelete): Promise<void> {
    const owner = (del.schema ?? this.schema()).toUpperCase()
    const table = qualifiedTable(this.engine, del.table, owner)
    const binds: Record<string, unknown> = {}
    const where = this.buildWhere(del.primaryKeys, binds, 'w')
    await this.require().execute(`DELETE FROM ${table} WHERE ${where}`, binds, {
      autoCommit: true
    })
  }

  async deleteRows(dels: RowDelete[]): Promise<number> {
    if (dels.length === 0) return 0
    const conn = this.require()
    // autoCommit is off until COMMIT, so a failure rolls the whole batch back.
    try {
      let deleted = 0
      for (const del of dels) {
        const owner = (del.schema ?? this.schema()).toUpperCase()
        const table = qualifiedTable(this.engine, del.table, owner)
        const binds: Record<string, unknown> = {}
        const where = this.buildWhere(del.primaryKeys, binds, 'w')
        const res = await conn.execute(`DELETE FROM ${table} WHERE ${where}`, binds, {
          autoCommit: false
        })
        deleted += res.rowsAffected ?? 0
      }
      await conn.commit()
      return deleted
    } catch (err) {
      await conn.rollback().catch(() => undefined)
      throw err
    }
  }

  async applyRowChanges(changes: RowChangeSet): Promise<RowChangeResult> {
    if (
      changes.deletes.length === 0 &&
      changes.updates.length === 0 &&
      changes.inserts.length === 0
    ) {
      return { deleted: 0, updated: 0, inserted: 0 }
    }
    const conn = this.require()
    const owner = (changes.schema ?? this.schema()).toUpperCase()
    const target = qualifiedTable(this.engine, changes.table, owner)
    // autoCommit stays off until the explicit COMMIT, so any failure rolls the
    // whole table back.
    try {
      let deleted = 0
      for (const keys of changes.deletes) {
        const binds: Record<string, unknown> = {}
        const where = this.buildWhere(keys, binds, 'd')
        const res = await conn.execute(`DELETE FROM ${target} WHERE ${where}`, binds, {
          autoCommit: false
        })
        deleted += res.rowsAffected ?? 0
      }

      let updated = 0
      for (const update of changes.updates) {
        const cols = Object.keys(update.changes)
        if (cols.length === 0) continue
        const binds: Record<string, unknown> = {}
        const setClause = cols
          .map((k, i) => {
            binds[`s${i}`] = update.changes[k]
            return `${quoteIdent(this.engine, k)} = :s${i}`
          })
          .join(', ')
        const where = this.buildWhere(update.primaryKeys, binds, 'u')
        const res = await conn.execute(
          `UPDATE ${target} SET ${setClause} WHERE ${where}`,
          binds,
          { autoCommit: false }
        )
        updated += res.rowsAffected ?? 0
      }

      let inserted = 0
      for (const row of changes.inserts) {
        const cols = Object.keys(row)
        if (cols.length === 0) continue
        const binds: Record<string, unknown> = {}
        const colList = cols.map((k) => quoteIdent(this.engine, k)).join(', ')
        const marks = cols
          .map((k, i) => {
            binds[`i${i}`] = row[k]
            return `:i${i}`
          })
          .join(', ')
        await conn.execute(
          `INSERT INTO ${target} (${colList}) VALUES (${marks})`,
          binds,
          { autoCommit: false }
        )
        inserted += 1
      }

      await conn.commit()
      return { deleted, updated, inserted }
    } catch (err) {
      await conn.rollback().catch(() => undefined)
      throw err
    }
  }

  private buildWhere(
    pks: Record<string, unknown>,
    binds: Record<string, unknown>,
    prefix: string
  ): string {
    const keys = Object.keys(pks)
    if (keys.length === 0)
      throw new DbError('INVALID', 'Primary key required for this operation', this.engine)
    return keys
      .map((k, i) => {
        binds[`${prefix}${i}`] = pks[k]
        return `${quoteIdent(this.engine, k)} = :${prefix}${i}`
      })
      .join(' AND ')
  }

  // CURRENT_SCHEMA is session state. A query that selected schema A used to
  // leave the session there, so later queries without an explicit schema ran
  // against A instead of the user's own schema.
  private async applyCurrentSchema(schema?: string): Promise<void> {
    const conn = this.require()
    const target = schema ?? this.schema()
    await conn.execute(
      `ALTER SESSION SET CURRENT_SCHEMA = ${quoteIdent(this.engine, target)}`
    )
  }

  // Oracle identifies the session as SID,SERIAL#. Cancelling uses
  // ALTER SYSTEM CANCEL SQL on a second connection, which stops the statement
  // and keeps the session alive.
  private runningSession: string | null = null

  async cancelQuery(): Promise<boolean> {
    if (!this.runningSession) return false
    const session = this.runningSession
    const oracledb = await import('oracledb')
    const cfg = this.config
    if (!cfg) return false
    const admin = await oracledb.getConnection({
      user: cfg.user,
      password: cfg.password,
      connectString: this.buildConnectString(cfg)
    })
    try {
      await admin.execute(`ALTER SYSTEM CANCEL SQL '${session}'`)
      return true
    } finally {
      await admin.close().catch(() => undefined)
    }
  }

  async runQuery(
    sql: string,
    maxRows: number,
    context?: { database?: string; schema?: string },
    onSession?: (sessionId: string) => void
  ): Promise<QueryResultSet[]> {
    const oracledb = await import('oracledb')
    const conn = this.require()
    // Oracle has no separate database switch; the schema is the owning user.
    await this.applyCurrentSchema(context?.schema)
    const statements = splitStatements(sql)
    if (statements.length === 0)
      throw new DbError('EMPTY', 'No SQL statement to run', this.engine)
    const sidRes = await conn.execute(
      "SELECT SYS_CONTEXT('USERENV','SID') || ',' || serial# AS sid FROM v$session WHERE sid = SYS_CONTEXT('USERENV','SID')"
    )
    const sessionId = String(((sidRes.rows ?? []) as unknown[][])[0]?.[0] ?? '')
    this.runningSession = sessionId || null
    if (this.runningSession) onSession?.(this.runningSession)
    const results: QueryResultSet[] = []
    try {
      for (const stmt of statements) {
        const started = Date.now()
        // resultSet streams rows in fetchArraySize chunks. Without it, execute()
        // buffered every row of the result set before the caller could slice it.
        const res = await conn.execute(
          stmt,
          {},
          {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
            autoCommit: true,
            resultSet: true,
            fetchArraySize: Math.min(500, maxRows + 1)
          }
        )
        if (res.resultSet && res.metaData) {
          const columns = res.metaData.map((m: { name: string }) => ({ name: m.name }))
          const rows: Record<string, unknown>[] = []
          let truncated = false
          try {
            for (;;) {
              const batch = (await res.resultSet.getRows(
                Math.min(500, maxRows + 1 - rows.length)
              )) as Record<string, unknown>[]
              if (batch.length === 0) break
              rows.push(...batch)
              if (rows.length > maxRows) {
                truncated = true
                break
              }
            }
          } finally {
            await res.resultSet.close().catch(() => undefined)
          }
          if (rows.length > maxRows) rows.length = maxRows
          results.push({
            statement: summarizeStatement(stmt),
            kind: 'rows',
            columns,
            rows,
            rowCount: rows.length,
            truncated,
            durationMs: Date.now() - started
          })
        } else {
          results.push({
            statement: summarizeStatement(stmt),
            kind: 'command',
            columns: [],
            rows: [],
            rowCount: res.rowsAffected ?? 0,
            truncated: false,
            command: stmt.split(/\s+/)[0].toUpperCase(),
            durationMs: Date.now() - started
          })
        }
      }
      return results
    } finally {
      this.runningSession = null
    }
  }

  async explainQuery(
    sql: string,
    context?: { database?: string; schema?: string },
    _analyze?: boolean
  ): Promise<{ format: 'json' | 'text'; raw: string }> {
    const statements = splitStatements(sql)
    if (statements.length === 0)
      throw new DbError('EMPTY', 'No SQL statement to explain', this.engine)
    if (statements.length > 1)
      throw new DbError(
        'EXPLAIN_MULTI',
        'Explain hanya menerima satu statement.',
        this.engine
      )
    const statement = statements[0].trim().replace(/;$/, '')
    const conn = this.require()
    await this.applyCurrentSchema(context?.schema)
    // Oracle needs a PLAN_TABLE row source. EXPLAIN PLAN writes into it and
    // DBMS_XPLAN renders the result; ANALYZE is not a valid option here.
    const statementId = `rea_${Date.now()}`
    await conn.execute(
      `EXPLAIN PLAN SET STATEMENT_ID = '${statementId}' FOR ${statement}`
    )
    const res = await conn.execute(
      `SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, :id, 'BASIC +COST +ROWS'))`,
      { id: statementId }
    )
    const rows = (res.rows ?? []) as Record<string, unknown>[]
    const raw = rows.map((row) => String(Object.values(row)[0] ?? '')).join('\n')
    if (!raw.trim()) {
      throw new DbError(
        'EXPLAIN_EMPTY',
        'Oracle tidak mengembalikan query plan.',
        this.engine
      )
    }
    return { format: 'text' as const, raw }
  }

  async getTableDdl(
    _database: string,
    table: string,
    schema?: string
  ): Promise<string | null> {
    const owner = (schema ?? this.schema()).toUpperCase()
    const cols = await this.require().execute(
      `SELECT column_name, data_type, data_length, data_precision, data_scale, nullable, data_default
       FROM all_tab_columns WHERE owner = :owner AND table_name = :tbl ORDER BY column_id`,
      { owner, tbl: table.toUpperCase() }
    )
    if (!cols.rows || cols.rows.length === 0) return null
    const pkRes = await this.require().execute(
      `SELECT cc.column_name FROM all_constraints con
       JOIN all_cons_columns cc ON cc.owner = con.owner AND cc.constraint_name = con.constraint_name
       WHERE con.constraint_type = 'P' AND con.owner = :owner AND con.table_name = :tbl`,
      { owner, tbl: table.toUpperCase() }
    )
    const pk = new Set((pkRes.rows ?? []).map((r) => String((r as unknown[])[0])))
    const defs = (cols.rows as unknown[][]).map((r) => {
      const [name, dataType, dataLength, precision, scale, nullable, dataDefault] = r as [
        string,
        string,
        number,
        number | null,
        number | null,
        string,
        string | null
      ]
      let type = dataType
      if (dataType === 'VARCHAR2' || dataType === 'NVARCHAR2' || dataType === 'CHAR') {
        type = `${dataType}(${dataLength})`
      } else if (dataType === 'NUMBER' && precision) {
        type = scale ? `NUMBER(${precision},${scale})` : `NUMBER(${precision})`
      }
      let def = `  ${quoteIdent(this.engine, name)} ${type}`
      if (pk.has(name)) def += ' PRIMARY KEY'
      else if (nullable === 'N') def += ' NOT NULL'
      if (dataDefault) def += ` DEFAULT ${dataDefault.trim()}`
      return def
    })
    const target = qualifiedTable(this.engine, table, owner)
    return `CREATE TABLE ${target} (\n${defs.join(',\n')}\n);`
  }

  async listIndexes(
    _database: string,
    table: string,
    schema?: string
  ): Promise<IndexInfo[]> {
    const owner = (schema ?? this.schema()).toUpperCase()
    const res = await this.require().execute(
      `SELECT i.index_name, i.uniqueness, i.index_type, ic.column_name, ic.column_position
       FROM all_indexes i
       JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
       WHERE i.table_owner = :owner AND i.table_name = :tbl
       ORDER BY i.index_name, ic.column_position`,
      { owner, tbl: table.toUpperCase() }
    )
    const byName = new Map<string, IndexInfo>()
    for (const r of (res.rows ?? []) as [string, string, string, string, number][]) {
      const [name, uniqueness, indexType, column] = r
      const entry = byName.get(name) ?? {
        name,
        columns: [],
        unique: uniqueness === 'UNIQUE',
        primary: /^SYS_C/i.test(name),
        method: indexType
      }
      entry.columns.push(column)
      byName.set(name, entry)
    }
    return [...byName.values()]
  }

  async listForeignKeys(
    _database: string,
    table: string,
    schema?: string
  ): Promise<ForeignKeyInfo[]> {
    const owner = (schema ?? this.schema()).toUpperCase()
    const res = await this.require().execute(
      `SELECT c.constraint_name, cc.column_name, r.owner AS ref_owner,
              rc.table_name AS ref_table, rcc.column_name AS ref_column,
              c.delete_rule
       FROM all_constraints c
       JOIN all_cons_columns cc
         ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
       JOIN all_constraints rc
         ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name
       JOIN all_cons_columns rcc
         ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name
        AND rcc.position = cc.position
       WHERE c.constraint_type = 'R' AND c.owner = :owner AND c.table_name = :tbl
       ORDER BY c.constraint_name, cc.position`,
      { owner, tbl: table.toUpperCase() }
    )
    const byName = new Map<string, ForeignKeyInfo>()
    for (const r of (res.rows ?? []) as [
      string,
      string,
      string,
      string,
      string,
      string
    ][]) {
      const [name, column, refOwner, refTable, refColumn, deleteRule] = r
      const entry = byName.get(name) ?? {
        name,
        columns: [],
        refSchema: refOwner,
        refTable,
        refColumns: [],
        onDelete: deleteRule
      }
      entry.columns.push(column)
      entry.refColumns.push(refColumn)
      byName.set(name, entry)
    }
    return [...byName.values()]
  }

  async getTableInfo(
    _database: string,
    table: string,
    schema?: string
  ): Promise<TableInfoDetail> {
    const owner = (schema ?? this.schema()).toUpperCase()
    const res = await this.require().execute(
      `SELECT num_rows, blocks, last_analyzed,
              (SELECT comments FROM all_tab_comments tc
                WHERE tc.owner = t.owner AND tc.table_name = t.table_name) AS comments
       FROM all_tables t
       WHERE owner = :owner AND table_name = :tbl`,
      { owner, tbl: table.toUpperCase() }
    )
    const row = (res.rows ?? [])[0] as
      [number | null, number | null, Date | null, string | null] | undefined
    if (!row) return {}
    const blocks = row[1] ?? null
    return {
      rowCount: row[0] ?? null,
      // Oracle default block size 8 KB; blocks * 8192 is an estimate.
      sizeBytes: blocks === null ? null : blocks * 8192,
      comment: row[3] ?? null,
      extra: row[2] ? [{ label: 'Last analyzed', value: String(row[2]) }] : []
    }
  }

  async getViewDefinition(
    _database: string,
    view: string,
    schema?: string
  ): Promise<string | null> {
    const owner = (schema ?? this.schema()).toUpperCase()
    const res = await this.require().execute(
      `SELECT text FROM all_views WHERE owner = :owner AND view_name = :view`,
      { owner, view: view.toUpperCase() }
    )
    const row = (res.rows ?? [])[0] as [string] | undefined
    return row?.[0] ?? null
  }

  async getRoutineDefinition(
    _database: string,
    routine: string,
    kind: RoutineKind,
    schema?: string
  ): Promise<string | null> {
    const owner = (schema ?? this.schema()).toUpperCase()
    const name = routine.toUpperCase()
    // DBMS_METADATA is the supported way to rebuild a CREATE statement; the
    // source views only contain the body.
    const type =
      kind === 'trigger' ? 'TRIGGER' : kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
    try {
      const res = await this.require().execute(
        `SELECT DBMS_METADATA.GET_DDL(:type, :name, :owner) AS ddl FROM dual`,
        { type, name, owner }
      )
      const row = (res.rows ?? [])[0] as [string | null] | undefined
      if (row?.[0]) return row[0]
    } catch {
      // GET_DDL needs the OBJECT privilege; fall back to the source view.
    }
    if (kind === 'trigger') {
      const res = await this.require().execute(
        `SELECT trigger_body FROM all_triggers
         WHERE owner = :owner AND trigger_name = :name`,
        { owner, name }
      )
      const body = (res.rows ?? [])[0] as [string | null] | undefined
      return body?.[0] ?? null
    }
    const res = await this.require().execute(
      `SELECT text FROM all_source
       WHERE owner = :owner AND name = :name
       ORDER BY type, line`,
      { owner, name }
    )
    const lines = (res.rows ?? []) as [string][]
    return lines.length > 0 ? lines.map((r) => r[0]).join('') : null
  }

  async listRoutines(_database: string, schema?: string): Promise<RoutineInfo[]> {
    const owner = (schema ?? this.schema()).toUpperCase()
    const out: RoutineInfo[] = []
    const res = await this.require().execute(
      `SELECT object_name, object_type FROM all_objects
       WHERE owner = :owner AND object_type IN ('FUNCTION', 'PROCEDURE')
       ORDER BY object_name`,
      { owner }
    )
    for (const r of (res.rows ?? []) as [string, string][]) {
      out.push({
        name: r[0],
        kind: r[1] === 'PROCEDURE' ? 'procedure' : 'function'
      })
    }
    const trig = await this.require().execute(
      `SELECT trigger_name, table_name, status FROM all_triggers
       WHERE owner = :owner ORDER BY trigger_name`,
      { owner }
    )
    for (const r of (trig.rows ?? []) as [string, string, string][]) {
      out.push({ name: r[0], kind: 'trigger', detail: `${r[1]} (${r[2]})` })
    }
    return out
  }

  async searchObjects(
    _database: string,
    term: string,
    schema?: string
  ): Promise<SearchResult[]> {
    const owner = (schema ?? this.schema()).toUpperCase()
    const like = `%${term.toUpperCase()}%`
    const out: SearchResult[] = []
    const objs = await this.require().execute(
      `SELECT table_name, 'TABLE' AS kind FROM all_tables
       WHERE owner = :owner AND table_name LIKE :term
       UNION ALL
       SELECT view_name, 'VIEW' FROM all_views
       WHERE owner = :owner AND view_name LIKE :term
       ORDER BY 1 FETCH FIRST 200 ROWS ONLY`,
      { owner, term: like }
    )
    for (const r of (objs.rows ?? []) as [string, string][]) {
      out.push({
        kind: r[1] === 'VIEW' ? 'view' : 'table',
        name: r[0],
        schema: owner
      })
    }
    const cols = await this.require().execute(
      `SELECT table_name, column_name, data_type FROM all_tab_columns
       WHERE owner = :owner AND column_name LIKE :term
       ORDER BY table_name, column_id FETCH FIRST 200 ROWS ONLY`,
      { owner, term: like }
    )
    for (const r of (cols.rows ?? []) as [string, string, string][]) {
      out.push({ kind: 'column', name: r[1], table: r[0], schema: owner, detail: r[2] })
    }
    const routines = await this.require().execute(
      `SELECT object_name, object_type FROM all_objects
       WHERE owner = :owner AND object_type IN ('FUNCTION','PROCEDURE') AND object_name LIKE :term
       FETCH FIRST 100 ROWS ONLY`,
      { owner, term: like }
    )
    for (const r of (routines.rows ?? []) as [string, string][]) {
      out.push({ kind: 'routine', name: r[0], schema: owner, detail: r[1] })
    }
    return out
  }

  async listSessions(_database?: string): Promise<SessionInfo[]> {
    // v$session needs SELECT on the dynamic performance view; a normal user may
    // not have it, so the error is surfaced instead of swallowed.
    const res = await this.require().execute(
      `SELECT s.sid, s.serial#, s.username, s.status, s.machine, s.sql_id,
              ROUND((SYSDATE - s.logon_time) * 86400) AS elapsed,
              q.sql_text
       FROM v$session s
       LEFT JOIN v$sql q ON q.sql_id = s.sql_id AND q.child_number = 0
       WHERE s.type = 'USER'
       ORDER BY s.logon_time`
    )
    return (res.rows ?? []).map((r) => {
      const [sid, serial, username, status, machine, sqlId, elapsed, sqlText] = r as [
        number,
        number,
        string | null,
        string,
        string | null,
        string | null,
        number | null,
        string | null
      ]
      return {
        id: `${sid},${serial}`,
        user: username,
        state: status,
        query: sqlText ?? (sqlId ? `sql_id ${sqlId}` : null),
        client: machine,
        durationMs: elapsed === null ? null : elapsed * 1000
      }
    })
  }

  async killSession(sessionId: string): Promise<void> {
    const match = /^(\d+),(\d+)$/.exec(sessionId)
    if (!match) {
      throw new DbError(
        'INVALID_SESSION',
        `ID sesi tidak valid: ${sessionId}`,
        this.engine
      )
    }
    await this.require().execute(
      `ALTER SYSTEM KILL SESSION '${match[1]},${match[2]}' IMMEDIATE`
    )
  }

  async listTableStats(_database: string, schema?: string): Promise<TableStat[]> {
    const owner = (schema ?? this.schema()).toUpperCase()
    const res = await this.require().execute(
      `SELECT t.table_name, t.num_rows,
              t.blocks * 8192 AS size_bytes,
              tc.comments,
              CASE WHEN v.view_name IS NOT NULL THEN 'VIEW' ELSE 'TABLE' END AS kind
       FROM all_tables t
       LEFT JOIN all_views v
         ON v.owner = t.owner AND v.view_name = t.table_name
       LEFT JOIN all_tab_comments tc
         ON tc.owner = t.owner AND tc.table_name = t.table_name
       WHERE t.owner = :owner
       ORDER BY t.table_name`,
      { owner }
    )
    return (
      (res.rows ?? []) as [string, number | null, number | null, string | null, string][]
    ).map((r) => ({
      name: r[0],
      type: r[4] === 'VIEW' ? 'view' : 'table',
      rows: r[1] === null ? null : Number(r[1]),
      sizeBytes: r[2] === null ? null : Number(r[2]),
      comment: r[3] ?? null,
      engine: null,
      modifiedAt: null
    }))
  }

  async listUsers(): Promise<DbUser[]> {
    const res = await this.require().execute(
      `SELECT u.username, u.account_status,
              CASE WHEN r.granted_role = 'DBA' THEN 'Y' ELSE 'N' END AS is_dba
       FROM all_users u
       LEFT JOIN (
         SELECT grantee, granted_role FROM dba_role_privs WHERE granted_role = 'DBA'
       ) r ON r.grantee = u.username
       ORDER BY u.username`
    )
    return (res.rows ?? []).map((r) => {
      const row = r as Record<string, unknown>
      return {
        name: String(row.USERNAME ?? row.username),
        canLogin: String(row.ACCOUNT_STATUS ?? row.account_status ?? '').startsWith(
          'OPEN'
        ),
        isSuperuser: String(row.IS_DBA ?? row.is_dba) === 'Y',
        attributes: []
      }
    })
  }
}

export const createOracleAdapter: (engine: DbEngine) => DatabaseAdapter = () =>
  new OracleAdapter()
