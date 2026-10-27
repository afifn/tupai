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
  TableStat,
  TransactionBegin,
  TransactionInfo,
  TransactionRef
} from '@shared/types'
import { MAX_OPEN_TRANSACTIONS } from '@shared/types'
import { commitsImplicitly } from '@shared/transactionGuard'
import { buildFilterWhere, toOracleBinds } from '@shared/filter'
import { nowExpression } from '@shared/nowExpression'
import {
  DbError,
  orderClause,
  qualifiedTable,
  quoteIdent,
  splitStatements,
  summarizeStatement,
  type DatabaseAdapter,
  type QueryContext
} from './types'
import { sslEnabled } from '../connection/ssl'
import { sshEnabled } from '../connection/sshTunnel'
import { resolveCjsDefault } from '@shared/cjsInterop'
import { oracleLimitSql, oraclePageBinds, oraclePageSql } from '@shared/oracleSql'

const QUERY_TIMEOUT_MS = 30000

// `oracledb` is a CommonJS package: imported from an ES module its real API
// arrives on `default`, so `(await import('oracledb')).getConnection` is
// undefined and connecting fails with "(intermediate value).getConnection is not
// a function". Every load in this file goes through one helper so the shape is
// handled once.
async function loadOracle(): Promise<typeof import('oracledb')> {
  const mod = await import('oracledb')
  return resolveCjsDefault(mod) as unknown as typeof import('oracledb')
}

// Thick mode is process-wide and can only be initialised once, so the outcome is
// memoised. Keying it on the directory means changing the setting in Preferences
// takes effect on the next attempt instead of requiring an app restart.
let thickMode: { dir: string; error: string | null } | null = null

/**
 * Reads the Instant Client folder from the settings file.
 *
 * This module runs inside the database worker, where `electron` is unavailable,
 * so it cannot import the settings store. The main process exports the same
 * userData directory as TUPAI_USER_DATA for the SSH host key store, and the
 * settings file lives there too. A missing or unreadable file simply means thin
 * mode, which is the correct default.
 */
async function readOracleClientDir(): Promise<string> {
  const dir = process.env.TUPAI_USER_DATA
  if (!dir) return ''
  try {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const raw = await readFile(join(dir, 'settings.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { oracle?: { clientLibDir?: unknown } }
    const value = parsed?.oracle?.clientLibDir
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/**
 * Switches the driver to thick mode when an Instant Client folder is configured.
 *
 * Thin mode speaks the Oracle wire protocol directly and needs no client
 * library, but it only supports server 12.1 and newer. A 10g/11g server rejects
 * it with NJS-138, and the only way to reach it is the OCI client through thick
 * mode. The driver refuses a second `initOracleClient` call, hence the memo.
 *
 * Returns null when thick mode is not configured, or an error message when it
 * was configured but could not be loaded, so the caller can explain the problem
 * instead of letting the raw NJS code through.
 */
async function ensureOracleMode(dir: string): Promise<string | null> {
  const wanted = dir.trim()
  if (!wanted) return null
  if (thickMode?.dir === wanted) return thickMode.error
  const oracledb = await loadOracle()
  try {
    // libDir is the folder holding oci.dll / libclntsh, not the library itself.
    oracledb.initOracleClient({ libDir: wanted })
    thickMode = { dir: wanted, error: null }
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    thickMode = { dir: wanted, error: message }
    return message
  }
}

class OracleAdapter implements DatabaseAdapter {
  readonly engine: DbEngine = 'oracle'
  private connection: Connection | null = null
  // One dedicated connection per open manual transaction, because the shared
  // connection runs statements with autoCommit on.
  private transactions = new Map<string, { conn: Connection; info: TransactionInfo }>()
  private config: ConnectionConfig | null = null
  // Whether all_tab_columns has identity_column (12c+) and whether the server
  // accepts OFFSET/FETCH. null until probed.
  private capabilities: { identityColumn: boolean; modernPaging: boolean } | null = null

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
    await this.prepareMode()
    const oracledb = await loadOracle()
    const conn = await oracledb.getConnection({
      user: cfg.user,
      password: cfg.password,
      connectString: this.buildConnectString(cfg)
    })
    await conn.close()
    return true
  }

  async connect(cfg: ConnectionConfig): Promise<void> {
    await this.prepareMode()
    const oracledb = await loadOracle()
    this.config = cfg
    this.connection = await oracledb.getConnection({
      user: cfg.user,
      password: cfg.password,
      connectString: this.buildConnectString(cfg)
    })
    this.connection.callTimeout = QUERY_TIMEOUT_MS
  }

  /**
   * Applies the Oracle client setting before any connection attempt.
   *
   * A configured but unloadable client is reported here, because the alternative
   * is the driver falling back to thin mode and failing later with NJS-138,
   * which says nothing about the folder the user just typed.
   */
  private async prepareMode(): Promise<void> {
    const dir = await readOracleClientDir()
    const failure = await ensureOracleMode(dir)
    if (failure) {
      throw new DbError(
        'ORACLE_CLIENT_FAILED',
        `Oracle Instant Client di "${dir}" tidak bisa dipakai: ${failure}`,
        this.engine
      )
    }
  }

  async disconnect(): Promise<void> {
    for (const [id, entry] of this.transactions) {
      await entry.conn.rollback().catch(() => undefined)
      await entry.conn.close().catch(() => undefined)
      this.transactions.delete(id)
    }
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
    const owner = schema ?? database ?? this.schema()
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

  // Oracle folds unquoted identifiers to upper case but keeps quoted ones
  // exactly, so catalog lookups use the name the catalog returned. A blanket
  // toUpperCase() made a quoted table such as "orders" invisible to the column
  // and primary-key queries; the grid then opened with no columns, which looked
  // like the data was missing.
  async getPrimaryKey(
    _database: string,
    table: string,
    schema?: string
  ): Promise<PrimaryKeyInfo | null> {
    const owner = schema ?? this.schema()
    const res = await this.require().execute(
      `SELECT con.constraint_name, cc.column_name
       FROM all_constraints con
       JOIN all_cons_columns cc
         ON cc.owner = con.owner AND cc.constraint_name = con.constraint_name
       WHERE con.constraint_type = 'P' AND con.owner = :owner AND con.table_name = :tbl
       ORDER BY cc.position`,
      { owner, tbl: table }
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
    const owner = schema ?? this.schema()
    // data_type alone is "VARCHAR2"/"NUMBER" without the declared size, so a
    // structure diff saw every sized column as different from its target and a
    // Table Designer round-trip dropped the length. Rebuild the spelling the
    // user originally declared.
    //
    // `all_tab_columns.identity_column` only exists from 12c on, and referencing
    // a missing column fails the whole query with ORA-00904: opening any table on
    // an 11g server was impossible. The column list is probed first and the
    // identity expression is chosen from what this server actually has.
    const identity = await this.identityExpression()
    const res = await this.require().execute(
      `SELECT c.column_name, c.data_type, c.data_length, c.data_precision, c.data_scale,
              c.nullable, c.data_default, ${identity} AS identity_column,
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
      { owner, tbl: table }
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

  /**
   * SQL for the identity flag, chosen from the columns this server actually has.
   *
   * `all_tab_columns.identity_column` was added in 12c. On 11g the reference
   * fails with ORA-00904 and the whole table view breaks, so the feature has to
   * degrade instead of being assumed. The probe result is cached per connection
   * because the answer cannot change for a running server.
   */
  private async identityExpression(): Promise<string> {
    return (await this.serverCapabilities()).identityColumn ? 'c.identity_column' : `'NO'`
  }

  /**
   * Which SQL features this server has. Probed once per connection, because the
   * answer cannot change while the server runs.
   *
   * 12c introduced `identity_column`, `OFFSET ... FETCH NEXT` and
   * `FETCH FIRST`. On 11g each of those fails the whole statement, so they are
   * checked instead of assumed: browsing a table on an old server is the common
   * case, not an edge case.
   */
  private async serverCapabilities(): Promise<{
    identityColumn: boolean
    modernPaging: boolean
  }> {
    if (this.capabilities) return this.capabilities
    const capabilities = { identityColumn: false, modernPaging: false }
    try {
      // `ALL_TAB_COLUMNS` has a row for every column of every table, so an empty
      // result is not expected. `ROWNUM = 1` still validates the select list, so
      // a missing column raises ORA-00904 even when the predicate matches nothing.
      const probe = await this.require().execute(
        `SELECT identity_column FROM all_tab_columns WHERE rownum <= 1`
      )
      capabilities.identityColumn = Array.isArray(probe.rows)
    } catch {
      capabilities.identityColumn = false
    }
    try {
      await this.require().execute(
        `SELECT 1 FROM dual OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY`
      )
      capabilities.modernPaging = true
    } catch {
      capabilities.modernPaging = false
    }
    this.capabilities = capabilities
    return capabilities
  }

  async selectRows(query: PageQuery): Promise<{
    rows: Record<string, unknown>[]
    total: number
  }> {
    const conn = this.require()
    const owner = query.schema ?? this.schema()
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
    // The count and the page are separate statements, so they get separate bind
    // objects. Mutating one object meant the count query received the paging
    // binds, which it never references, and Oracle rejects that with ORA-01036.
    const countBinds = { ...binds }
    const countRes = await conn.execute(
      `SELECT COUNT(*) AS n FROM ${table}${where}`,
      countBinds
    )
    const total = Number((countRes.rows?.[0] as unknown[])?.[0] ?? 0)
    let order = ''
    if (query.orderBy) {
      const dir = query.orderDir === 'desc' ? 'DESC' : 'ASC'
      order = ` ORDER BY ${quoteIdent(this.engine, query.orderBy)} ${dir}`
    }
    const { modernPaging } = await this.serverCapabilities()
    const paging = { offset: query.offset, limit: query.limit }
    const pageBinds = { ...binds, ...oraclePageBinds(paging, modernPaging) }
    const oracledb = await loadOracle()
    const res = await conn.execute(
      oraclePageSql(`SELECT * FROM ${table}${where}${order}`, paging, modernPaging),
      pageBinds,
      this.fetchOptions(oracledb)
    )
    return { rows: (res.rows ?? []) as Record<string, unknown>[], total }
  }

  async fetchBatch(query: PageQuery): Promise<Record<string, unknown>[]> {
    const oracledb = await loadOracle()
    const conn = this.require()
    const owner = query.schema ?? this.schema()
    const table = qualifiedTable(this.engine, query.table, owner)
    const order = orderClause(
      this.engine,
      query.orderBy,
      query.orderDir,
      query.orderByColumns
    )
    const { modernPaging } = await this.serverCapabilities()
    const paging = { offset: query.offset, limit: query.limit }
    const res = await conn.execute(
      oraclePageSql(`SELECT * FROM ${table}${order}`, paging, modernPaging),
      oraclePageBinds(paging, modernPaging),
      this.fetchOptions(oracledb)
    )
    return (res.rows ?? []) as Record<string, unknown>[]
  }

  async updateRow(update: RowUpdate): Promise<void> {
    const owner = update.schema ?? this.schema()
    const table = qualifiedTable(this.engine, update.table, owner)
    const cols = Object.keys(update.changes)
    const now = update.nowColumns ?? []
    if (cols.length === 0 && now.length === 0) return
    const binds: Record<string, unknown> = {}
    const setClause = [
      ...cols.map((k, i) => {
        binds[`s${i}`] = update.changes[k]
        return `${quoteIdent(this.engine, k)} = :s${i}`
      }),
      ...now.map((col) => {
        const expression = nowExpression(this.engine, col.kind)
        if (!expression)
          throw new DbError('UNSUPPORTED', 'now() tidak tersedia.', this.engine)
        return `${quoteIdent(this.engine, col.name)} = ${expression}`
      })
    ].join(', ')
    const where = this.buildWhere(update.primaryKeys, binds, 'w')
    await this.require().execute(
      `UPDATE ${table} SET ${setClause} WHERE ${where}`,
      binds,
      { autoCommit: true }
    )
  }

  async insertRow(insert: RowInsert): Promise<void> {
    const owner = insert.schema ?? this.schema()
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
    const owner = schema ?? this.schema()
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
    const owner = del.schema ?? this.schema()
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
        const owner = del.schema ?? this.schema()
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
    const owner = changes.schema ?? this.schema()
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
  private async applyCurrentSchema(
    schema?: string,
    connection?: Connection
  ): Promise<void> {
    const conn = connection ?? this.require()
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
    const oracledb = await loadOracle()
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
    context?: QueryContext,
    onSession?: (sessionId: string) => void
  ): Promise<QueryResultSet[]> {
    const oracledb = await loadOracle()
    const pinned = context?.transactionId
      ? this.transactions.get(context.transactionId)
      : undefined
    if (context?.transactionId && !pinned) {
      throw new DbError(
        'NO_TRANSACTION',
        'Transaksi tidak lagi terbuka. Jalankan ulang atau mulai transaksi baru.',
        this.engine
      )
    }
    const statements = splitStatements(sql)
    if (statements.length === 0)
      throw new DbError('EMPTY', 'No SQL statement to run', this.engine)
    // Oracle commits implicitly before and after DDL, so an open transaction
    // cannot survive it. Clearing the entry keeps listTransactions honest.
    if (pinned) {
      for (const stmt of statements) {
        if (commitsImplicitly(this.engine, stmt)) {
          this.transactions.delete(context!.transactionId!)
          break
        }
      }
    }
    const conn = pinned?.conn ?? this.require()
    // Oracle has no separate database switch; the schema is the owning user.
    await this.applyCurrentSchema(context?.schema, conn)
    // A pinned connection keeps autoCommit off so COMMIT/ROLLBACK stay the
    // caller's decision.
    const autoCommit = !pinned
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
            autoCommit,
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
      if (pinned) pinned.info.statements += 1
      return results
    } catch (err) {
      if (pinned) pinned.info.failed = true
      throw err
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
    const owner = schema ?? this.schema()
    const cols = await this.require().execute(
      `SELECT column_name, data_type, data_length, data_precision, data_scale, nullable, data_default
       FROM all_tab_columns WHERE owner = :owner AND table_name = :tbl ORDER BY column_id`,
      { owner, tbl: table }
    )
    if (!cols.rows || cols.rows.length === 0) return null
    const pkRes = await this.require().execute(
      `SELECT cc.column_name FROM all_constraints con
       JOIN all_cons_columns cc ON cc.owner = con.owner AND cc.constraint_name = con.constraint_name
       WHERE con.constraint_type = 'P' AND con.owner = :owner AND con.table_name = :tbl`,
      { owner, tbl: table }
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
    const owner = schema ?? this.schema()
    const res = await this.require().execute(
      `SELECT i.index_name, i.uniqueness, i.index_type, ic.column_name, ic.column_position
       FROM all_indexes i
       JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
       WHERE i.table_owner = :owner AND i.table_name = :tbl
       ORDER BY i.index_name, ic.column_position`,
      { owner, tbl: table }
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
    const owner = schema ?? this.schema()
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
      { owner, tbl: table }
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
    const owner = schema ?? this.schema()
    const res = await this.require().execute(
      `SELECT num_rows, blocks, last_analyzed,
              (SELECT comments FROM all_tab_comments tc
                WHERE tc.owner = t.owner AND tc.table_name = t.table_name) AS comments
       FROM all_tables t
       WHERE owner = :owner AND table_name = :tbl`,
      { owner, tbl: table }
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
    const owner = schema ?? this.schema()
    const res = await this.require().execute(
      `SELECT text FROM all_views WHERE owner = :owner AND view_name = :view`,
      { owner, view: view }
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
    const owner = schema ?? this.schema()
    const name = routine
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
    const owner = schema ?? this.schema()
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
    const owner = schema ?? this.schema()
    const like = `%${term.toUpperCase()}%`
    const out: SearchResult[] = []
    const { modernPaging } = await this.serverCapabilities()
    const objs = await this.require().execute(
      oracleLimitSql(
        `SELECT table_name, 'TABLE' AS kind FROM all_tables
         WHERE owner = :owner AND UPPER(table_name) LIKE :term
         UNION ALL
         SELECT view_name, 'VIEW' FROM all_views
         WHERE owner = :owner AND UPPER(view_name) LIKE :term
         ORDER BY 1`,
        200,
        modernPaging
      ),
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
      oracleLimitSql(
        `SELECT table_name, column_name, data_type FROM all_tab_columns
         WHERE owner = :owner AND UPPER(column_name) LIKE :term
         ORDER BY table_name, column_id`,
        200,
        modernPaging
      ),
      { owner, term: like }
    )
    for (const r of (cols.rows ?? []) as [string, string, string][]) {
      out.push({ kind: 'column', name: r[1], table: r[0], schema: owner, detail: r[2] })
    }
    const routines = await this.require().execute(
      oracleLimitSql(
        `SELECT object_name, object_type FROM all_objects
         WHERE owner = :owner AND object_type IN ('FUNCTION','PROCEDURE')
           AND UPPER(object_name) LIKE :term`,
        100,
        modernPaging
      ),
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
    const owner = schema ?? this.schema()
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

  async beginTransaction(begin: TransactionBegin): Promise<TransactionInfo> {
    if (this.transactions.size >= MAX_OPEN_TRANSACTIONS) {
      throw new DbError(
        'TOO_MANY_TRANSACTIONS',
        `Maksimal ${MAX_OPEN_TRANSACTIONS} transaksi terbuka per koneksi. Commit atau rollback salah satu dulu.`,
        this.engine
      )
    }
    if (this.transactions.has(begin.transactionId)) {
      throw new DbError('TRANSACTION_EXISTS', 'Transaksi sudah terbuka.', this.engine)
    }
    if (!this.config) throw new DbError('NOT_CONNECTED', 'Not connected', this.engine)
    const oracledb = await loadOracle()
    const conn = await oracledb.getConnection({
      user: this.config.user,
      password: this.config.password,
      connectString: this.buildConnectString(this.config)
    })
    conn.callTimeout = QUERY_TIMEOUT_MS
    try {
      await this.applyCurrentSchema(begin.schema, conn)
    } catch (err) {
      await conn.close().catch(() => undefined)
      throw err
    }
    const info: TransactionInfo = {
      transactionId: begin.transactionId,
      connectionId: begin.connectionId,
      database: begin.database,
      schema: begin.schema,
      startedAt: new Date().toISOString(),
      statements: 0,
      failed: false
    }
    this.transactions.set(begin.transactionId, { conn, info })
    return info
  }

  async commitTransaction(ref: TransactionRef): Promise<void> {
    const entry = this.transactions.get(ref.transactionId)
    if (!entry) {
      throw new DbError('NO_TRANSACTION', 'Transaksi tidak lagi terbuka.', this.engine)
    }
    this.transactions.delete(ref.transactionId)
    try {
      await entry.conn.commit()
    } finally {
      await entry.conn.close().catch(() => undefined)
    }
  }

  async rollbackTransaction(ref: TransactionRef): Promise<void> {
    const entry = this.transactions.get(ref.transactionId)
    if (!entry) return
    this.transactions.delete(ref.transactionId)
    try {
      await entry.conn.rollback()
    } finally {
      await entry.conn.close().catch(() => undefined)
    }
  }

  async listTransactions(): Promise<TransactionInfo[]> {
    return [...this.transactions.values()].map((entry) => ({ ...entry.info }))
  }
}

export const createOracleAdapter: (engine: DbEngine) => DatabaseAdapter = () =>
  new OracleAdapter()
