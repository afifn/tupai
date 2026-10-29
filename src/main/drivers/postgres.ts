import type { Client } from 'pg'
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
import { buildFilterWhere } from '@shared/filter'
import { describeLostSession } from '@shared/connectionLost'
import { nowExpression } from '@shared/nowExpression'
import { chunkRows } from '@shared/insertChunks'
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
import { resolveSsl, type ResolvedSsl } from '../connection/ssl'
import { openSshTunnel, sshEnabled, type SshTunnel } from '../connection/sshTunnel'

const QUERY_TIMEOUT_MS = 30000
// One connection per browsed database is required (a Postgres session is bound
// to a single database), but they were never closed: browsing 50 databases left
// 50 idle sockets open for the whole session. The least recently used client is
// closed once this limit is exceeded.
const MAX_CACHED_CLIENTS = 8

class PostgresAdapter implements DatabaseAdapter {
  readonly engine: DbEngine = 'postgres'
  private config: ConnectionConfig | null = null
  // Postgres binds a connection to a single database, so keep one client per
  // database the user browses instead of querying the wrong catalog.
  private clients = new Map<string, Client>()

  private ssl: ResolvedSsl | null = null
  private tunnel: SshTunnel | null = null
  // Why the last session ended, if the server closed it. Shown once to the
  // caller so "connection lost" comes with a reason instead of a bare code.
  private lostReason: string | null = null
  // Rejects when the client's session ends, so a pending cursor read can be
  // released instead of waiting for a callback that will never arrive.
  private deaths = new WeakMap<Client, Promise<never>>()
  // One dedicated client per open manual transaction. Reusing a cached client
  // would put every other tab's statement inside the same transaction.
  private transactions = new Map<string, { client: Client; info: TransactionInfo }>()

  private buildConfig(cfg: ConnectionConfig, database: string) {
    return {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database,
      ssl: this.ssl
        ? {
            rejectUnauthorized: this.ssl.mode !== 'require',
            ca: this.ssl.ca,
            cert: this.ssl.cert,
            key: this.ssl.key,
            servername: this.ssl.servername
          }
        : undefined,
      connectionTimeoutMillis: 8000,
      // Identifies this app's connections in pg_stat_activity. Useful for the
      // session panel and for verifying that the client cache stays bounded.
      application_name: 'Tupai'
    }
  }

  async testConnection(cfg: ConnectionConfig): Promise<boolean> {
    const { Client: PgClient } = await import('pg')
    // Test with the same TLS and tunnel settings the real connection will use.
    this.ssl = await resolveSsl(cfg.ssl)
    const tunnel =
      sshEnabled(cfg.ssh) && cfg.ssh ? await openSshTunnel(cfg.ssh, this.engine) : null
    try {
      const options: Record<string, unknown> = this.buildConfig(
        cfg,
        cfg.database ?? 'postgres'
      )
      if (tunnel) {
        options.stream = await tunnel.forward(cfg.host ?? 'localhost', cfg.port ?? 5432)
        delete options.host
        delete options.port
      }
      const client = new PgClient(options as never)
      await client.connect()
      await client.end()
      return true
    } finally {
      await tunnel?.close()
      this.ssl = null
    }
  }

  async connect(cfg: ConnectionConfig): Promise<void> {
    this.config = cfg
    this.ssl = await resolveSsl(cfg.ssl)
    if (sshEnabled(cfg.ssh) && cfg.ssh) {
      this.tunnel = await openSshTunnel(cfg.ssh, this.engine)
    }
    const client = await this.getClient(cfg.database ?? 'postgres')
    await client.query(`SET statement_timeout = ${QUERY_TIMEOUT_MS}`)
  }

  async disconnect(): Promise<void> {
    // Roll back before closing: the server does it on disconnect anyway, but an
    // explicit rollback also releases any lock the client was holding.
    for (const [id, entry] of this.transactions) {
      await entry.client.query('ROLLBACK').catch(() => undefined)
      await entry.client.end().catch(() => undefined)
      this.transactions.delete(id)
    }
    for (const client of this.clients.values()) {
      await client.end().catch(() => undefined)
    }
    this.clients.clear()
    this.config = null
    this.ssl = null
    await this.tunnel?.close()
    this.tunnel = null
  }

  /**
   * Attaches the handler that keeps a dropped session from becoming a crash.
   *
   * `pg.Client` is an EventEmitter, and it emits `error` when the server ends the
   * session (an idle timeout, an admin shutdown, a dropped socket). An EventEmitter
   * with no `error` listener re-throws the error as an uncaught exception, which
   * used to take down the whole worker and every other connection with it.
   *
   * The handler drops the dead client from the cache and remembers why, so the
   * next call for that database builds a fresh client. It deliberately does not
   * wrap `client.query`: pg runs its own queue through that method, and replacing
   * it made pg believe two queries were in flight at once.
   */
  private guard(client: Client, database: string): void {
    // Statements run through a pg-cursor, and a cursor read that is pending when
    // the session dies never calls back: the error arrives on the client, not on
    // the cursor. `died` is what a pending read races against, so the caller gets
    // an error instead of waiting forever.
    let fail: (err: Error) => void = () => undefined
    const died = new Promise<never>((_, reject) => {
      fail = reject
    })
    // A lost session is not always awaited (an idle client has nothing pending),
    // so the rejection is marked handled here.
    died.catch(() => undefined)
    this.deaths.set(client, died)

    client.on('error', (err: Error) => {
      this.forget(client, database)
      this.lostReason = describeLostSession(err)
      // The worker's stderr reaches db-manager.log, which is where a user is
      // asked to look when something goes wrong.
      console.error('[postgres] session ended:', this.lostReason)
      fail(err)
    })
  }

  /** Removes a client that can no longer be used from every place it is held. */
  private forget(client: Client, database: string): void {
    if (this.clients.get(database) === client) this.clients.delete(database)
    for (const [id, entry] of this.transactions) {
      if (entry.client === client) this.transactions.delete(id)
    }
  }

  /** A fresh client for a manual transaction, never the shared cache. */
  private async openTransactionClient(database: string): Promise<Client> {
    if (!this.config) throw new DbError('NOT_CONNECTED', 'Not connected', this.engine)
    const { Client: PgClient } = await import('pg')
    const options: Record<string, unknown> = this.buildConfig(this.config, database)
    if (this.tunnel) {
      options.stream = await this.tunnel.forward(
        this.config.host ?? 'localhost',
        this.config.port ?? 5432
      )
      delete options.host
      delete options.port
    }
    const client = new PgClient(options as never)
    await client.connect()
    await client.query(`SET statement_timeout = ${QUERY_TIMEOUT_MS}`)
    this.guard(client, database)
    return client
  }

  private async getClient(database: string): Promise<Client> {
    const existing = this.clients.get(database)
    if (existing) {
      // Refresh recency: Map preserves insertion order, so deleting and
      // re-inserting moves this entry to the end.
      this.clients.delete(database)
      this.clients.set(database, existing)
      return existing
    }
    if (!this.config) throw new DbError('NOT_CONNECTED', 'Not connected', this.engine)
    const { Client: PgClient } = await import('pg')
    const options: Record<string, unknown> = this.buildConfig(this.config, database)
    // Postgres keeps one client per database; each one opens its own channel
    // through the same SSH connection.
    if (this.tunnel) {
      options.stream = await this.tunnel.forward(
        this.config.host ?? 'localhost',
        this.config.port ?? 5432
      )
      delete options.host
      delete options.port
    }
    const client = new PgClient(options as never)
    await client.connect()
    await client.query(`SET statement_timeout = ${QUERY_TIMEOUT_MS}`)
    this.guard(client, database)
    this.clients.set(database, client)
    await this.evictClients()
    return client
  }

  // Closes the oldest clients until the cache is within the limit. The most
  // recently used one is never evicted, so the caller's client stays alive.
  private async evictClients(): Promise<void> {
    while (this.clients.size > MAX_CACHED_CLIENTS) {
      const oldest = this.clients.keys().next().value as string | undefined
      if (oldest === undefined) return
      const client = this.clients.get(oldest)
      this.clients.delete(oldest)
      await client?.end().catch(() => undefined)
    }
  }

  private defaultDatabase(): string {
    return this.config?.database ?? 'postgres'
  }

  // DROP DATABASE fails while any session is still connected ("is being
  // accessed by other users"). Our own per-database client is one such
  // session, so close it and terminate any remaining backends first.
  private dropDatabaseTarget(sql: string): string | null {
    const match = /^\s*drop\s+database\s+(?:if\s+exists\s+)?(.+?)\s*;?\s*$/i.exec(sql)
    if (!match) return null
    const raw = match[1].trim()
    const name = raw.startsWith('"')
      ? raw.slice(1, raw.lastIndexOf('"')).replace(/""/g, '"')
      : raw
    return name
  }

  private async prepareDropDatabase(name: string): Promise<void> {
    const current = this.defaultDatabase()
    if (name !== current) {
      const own = this.clients.get(name)
      if (own) {
        this.clients.delete(name)
        await own.end().catch(() => undefined)
      }
    }
    const client = await this.getClient(current)
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name]
    )
  }

  async listDatabases(): Promise<string[]> {
    const client = await this.getClient(this.defaultDatabase())
    const res = await client.query(
      'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname'
    )
    return res.rows.map((r) => r.datname as string)
  }

  async listSchemas(database?: string): Promise<string[]> {
    const client = await this.getClient(database ?? this.defaultDatabase())
    // Hide PostgreSQL system schemas the way GUI clients like Navicat do.
    const res = await client.query(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name NOT LIKE 'pg\\_%'
         AND schema_name <> 'information_schema'
       ORDER BY schema_name`
    )
    return res.rows.map((r) => r.schema_name as string)
  }

  async listTables(database: string, schema = 'public'): Promise<TableInfo[]> {
    const client = await this.getClient(database)
    const res = await client.query(
      'SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
      [schema]
    )
    return res.rows.map((r) => ({
      name: r.name as string,
      schema,
      type: (r.type as string) === 'VIEW' ? 'view' : 'table'
    }))
  }

  async listColumns(
    database: string,
    table: string,
    schema = 'public'
  ): Promise<ColumnInfo[]> {
    const client = await this.getClient(database)
    // format_type renders the declared type including length/precision
    // ("character varying(255)", "numeric(10,2)"). information_schema.data_type
    // reports only the base name, so a structure diff or a Table Designer
    // round-trip silently dropped every length and scale.
    const res = await client.query(
      `SELECT a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS "dataType",
              NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS "defaultValue",
              a.attidentity <> '' AS "isIdentity",
              col_description(c.oid, a.attnum) AS comment,
              (pk.attnum IS NOT NULL) AS "isPrimaryKey"
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       -- Primary key membership by attribute number. Matching on the column
       -- name instead would break for a composite key whose column names are
       -- duplicated across schemas, and selecting a column the subquery never
       -- produced made this whole query fail with "column pk.is_pk does not
       -- exist" (42703).
       LEFT JOIN (
         SELECT con.conrelid, unnest(con.conkey) AS attnum
         FROM pg_constraint con
         WHERE con.contype = 'p'
       ) pk ON pk.conrelid = c.oid AND pk.attnum = a.attnum
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [schema, table]
    )
    return res.rows.map((r) => {
      const defaultValue = r.defaultValue as string | null
      return {
        name: r.name as string,
        dataType: r.dataType as string,
        nullable: r.nullable === true,
        defaultValue,
        isPrimaryKey: r.isPrimaryKey === true,
        // serial/bigserial show up as a nextval() default; IDENTITY sets attidentity.
        autoIncrement:
          r.isIdentity === true || (defaultValue?.startsWith('nextval(') ?? false),
        comment: (r.comment as string | null) ?? null
      }
    })
  }

  async getPrimaryKey(
    database: string,
    table: string,
    schema = 'public'
  ): Promise<PrimaryKeyInfo | null> {
    const client = await this.getClient(database)
    const res = await client.query(
      `SELECT tc.constraint_name AS name, kcu.column_name AS column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY kcu.ordinal_position`,
      [schema, table]
    )
    if (res.rows.length === 0) return null
    return {
      name: res.rows[0].name as string,
      columns: res.rows.map((r) => r.column as string)
    }
  }

  async selectRows(query: PageQuery): Promise<{
    rows: Record<string, unknown>[]
    total: number
  }> {
    const client = await this.getClient(query.database)
    const table = qualifiedTable(this.engine, query.table, query.schema)
    const params: unknown[] = []
    let where = ''
    if (
      query.filterColumn &&
      query.filterValue !== undefined &&
      query.filterValue !== ''
    ) {
      params.push(`%${query.filterValue}%`)
      where = ` WHERE ${quoteIdent(this.engine, query.filterColumn)}::text LIKE $${params.length}`
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
        params.splice(0, params.length, ...built.params)
      }
    }
    let order = ''
    if (query.orderBy) {
      const dir = query.orderDir === 'desc' ? 'DESC' : 'ASC'
      order = ` ORDER BY ${quoteIdent(this.engine, query.orderBy)} ${dir}`
    }
    const countRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM ${table}${where}`,
      params
    )
    const total = countRes.rows[0].n as number
    const limitIdx = params.length + 1
    const offsetIdx = params.length + 2
    const rowsRes = await client.query(
      `SELECT * FROM ${table}${where}${order} LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, query.limit, query.offset]
    )
    return { rows: rowsRes.rows as Record<string, unknown>[], total }
  }

  async fetchBatch(query: PageQuery): Promise<Record<string, unknown>[]> {
    const client = await this.getClient(query.database)
    const table = qualifiedTable(this.engine, query.table, query.schema)
    const order = orderClause(
      this.engine,
      query.orderBy,
      query.orderDir,
      query.orderByColumns
    )
    const res = await client.query(`SELECT * FROM ${table}${order} LIMIT $1 OFFSET $2`, [
      query.limit,
      query.offset
    ])
    return res.rows as Record<string, unknown>[]
  }

  async updateRow(update: RowUpdate): Promise<void> {
    const client = await this.getClient(update.database)
    const table = qualifiedTable(this.engine, update.table, update.schema)
    const cols = Object.keys(update.changes)
    const now = update.nowColumns ?? []
    if (cols.length === 0 && now.length === 0) return
    const params: unknown[] = []
    const setClause = [
      ...cols.map((k) => {
        params.push(update.changes[k])
        return `${quoteIdent(this.engine, k)} = $${params.length}`
      }),
      ...now.map((col) => {
        const expression = nowExpression(this.engine, col.kind)
        if (!expression)
          throw new DbError('UNSUPPORTED', 'now() tidak tersedia.', this.engine)
        return `${quoteIdent(this.engine, col.name)} = ${expression}`
      })
    ].join(', ')
    const where = this.buildWhere(update.primaryKeys, params.length)
    params.push(...where.values)
    await client.query(`UPDATE ${table} SET ${setClause}${where.sql}`, params)
  }

  async insertRows(
    database: string,
    schema: string | undefined,
    table: string,
    rows: Record<string, unknown>[]
  ): Promise<number> {
    if (rows.length === 0) return 0
    const client = await this.getClient(database)
    const target = qualifiedTable(this.engine, table, schema)
    const cols = Object.keys(rows[0])
    const colList = cols.map((k) => quoteIdent(this.engine, k)).join(', ')
    // PostgreSQL allows at most 65535 bind parameters per statement; a large
    // import would otherwise fail with a protocol-level error.
    const chunks = chunkRows(rows, cols.length)
    await client.query('BEGIN')
    try {
      let inserted = 0
      for (const chunk of chunks) {
        const params: unknown[] = []
        const tuples = chunk.map((row) => {
          const marks = cols.map((k) => {
            params.push(row[k])
            return `$${params.length}`
          })
          return `(${marks.join(', ')})`
        })
        const res = await client.query(
          `INSERT INTO ${target} (${colList}) VALUES ${tuples.join(', ')}`,
          params
        )
        inserted += res.rowCount ?? chunk.length
      }
      await client.query('COMMIT')
      return inserted
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    }
  }

  async insertRow(insert: RowInsert): Promise<void> {
    const client = await this.getClient(insert.database)
    const table = qualifiedTable(this.engine, insert.table, insert.schema)
    const cols = Object.keys(insert.values)
    if (cols.length === 0)
      throw new DbError('INVALID', 'No values to insert', this.engine)
    const params: unknown[] = []
    const colList = cols
      .map((k) => {
        params.push(insert.values[k])
        return quoteIdent(this.engine, k)
      })
      .join(', ')
    const marks = cols.map((_, i) => `$${i + 1}`).join(', ')
    await client.query(`INSERT INTO ${table} (${colList}) VALUES (${marks})`, params)
  }

  async deleteRow(del: RowDelete): Promise<void> {
    const client = await this.getClient(del.database)
    const table = qualifiedTable(this.engine, del.table, del.schema)
    const params: unknown[] = []
    const where = this.buildWhere(del.primaryKeys, 0)
    params.push(...where.values)
    await client.query(`DELETE FROM ${table}${where.sql}`, params)
  }

  async deleteRows(dels: RowDelete[]): Promise<number> {
    if (dels.length === 0) return 0
    const client = await this.getClient(dels[0].database)
    await client.query('BEGIN')
    try {
      let deleted = 0
      for (const del of dels) {
        const table = qualifiedTable(this.engine, del.table, del.schema)
        const where = this.buildWhere(del.primaryKeys, 0)
        const res = await client.query(`DELETE FROM ${table}${where.sql}`, where.values)
        deleted += res.rowCount ?? 0
      }
      await client.query('COMMIT')
      return deleted
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
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
    const client = await this.getClient(changes.database)
    const target = qualifiedTable(this.engine, changes.table, changes.schema)
    await client.query('BEGIN')
    try {
      let deleted = 0
      for (const keys of changes.deletes) {
        const where = this.buildWhere(keys, 0)
        const res = await client.query(`DELETE FROM ${target}${where.sql}`, where.values)
        deleted += res.rowCount ?? 0
      }

      let updated = 0
      for (const update of changes.updates) {
        const cols = Object.keys(update.changes)
        if (cols.length === 0) continue
        const params: unknown[] = []
        const setClause = cols
          .map((k) => {
            params.push(update.changes[k])
            return `${quoteIdent(this.engine, k)} = $${params.length}`
          })
          .join(', ')
        const where = this.buildWhere(update.primaryKeys, params.length)
        params.push(...where.values)
        const res = await client.query(
          `UPDATE ${target} SET ${setClause}${where.sql}`,
          params
        )
        updated += res.rowCount ?? 0
      }

      let inserted = 0
      if (changes.inserts.length > 0) {
        const cols = Object.keys(changes.inserts[0])
        if (cols.length > 0) {
          const colList = cols.map((k) => quoteIdent(this.engine, k)).join(', ')
          for (const chunk of chunkRows(changes.inserts, cols.length)) {
            const params: unknown[] = []
            const tuples = chunk.map((row) => {
              const marks = cols.map((k) => {
                params.push(row[k])
                return `$${params.length}`
              })
              return `(${marks.join(', ')})`
            })
            const res = await client.query(
              `INSERT INTO ${target} (${colList}) VALUES ${tuples.join(', ')}`,
              params
            )
            inserted += res.rowCount ?? chunk.length
          }
        }
      }

      await client.query('COMMIT')
      return { deleted, updated, inserted }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw err
    }
  }

  private buildWhere(
    pks: Record<string, unknown>,
    offset: number
  ): { sql: string; values: unknown[] } {
    const keys = Object.keys(pks)
    if (keys.length === 0)
      throw new DbError('INVALID', 'Primary key required for this operation', this.engine)
    const values = keys.map((k) => pks[k])
    const sql =
      ' WHERE ' +
      keys
        .map((k, i) => `${quoteIdent(this.engine, k)} = $${offset + i + 1}`)
        .join(' AND ')
    return { sql, values }
  }

  // search_path is session state, so it must be set on every query, not only
  // when a schema is supplied. Without the reset branch a query that picked
  // schema A left the client pointing at A for every later query that had no
  // explicit schema.
  private async applySearchPath(client: Client, schema?: string): Promise<void> {
    if (schema) {
      await client.query(`SET search_path TO ${quoteIdent(this.engine, schema)}`)
    } else {
      await client.query('SET search_path TO DEFAULT')
    }
  }

  // Backend pid of the statement in flight, used by cancelQuery. The pid comes
  // from the server itself (pg_backend_pid), so no assumption about the client
  // is needed.
  private runningPid: number | null = null

  async cancelQuery(): Promise<boolean> {
    if (this.runningPid === null) return false
    const pid = this.runningPid
    // The cancel MUST use a separate connection. The client running the
    // statement is busy, so a query sent on it is queued behind the very
    // statement it is meant to stop; when the cancel finally runs, PostgreSQL
    // cancels it instead. A short-lived second client avoids that.
    if (!this.config) return false
    const { Client: PgClient } = await import('pg')
    const options: Record<string, unknown> = this.buildConfig(
      this.config,
      this.defaultDatabase()
    )
    if (this.tunnel) {
      options.stream = await this.tunnel.forward(
        this.config.host ?? 'localhost',
        this.config.port ?? 5432
      )
      delete options.host
      delete options.port
    }
    const canceler = new PgClient(options as never)
    try {
      await canceler.connect()
      const res = await canceler.query('SELECT pg_cancel_backend($1) AS ok', [pid])
      return res.rows[0]?.ok === true
    } finally {
      await canceler.end().catch(() => undefined)
    }
  }

  async runQuery(
    sql: string,
    maxRows: number,
    context?: QueryContext,
    onSession?: (sessionId: string) => void
  ): Promise<QueryResultSet[]> {
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
    const client =
      pinned?.client ??
      (await this.getClient(context?.database ?? this.defaultDatabase()))
    await this.applySearchPath(client, context?.schema)
    const pidRes = await client.query('SELECT pg_backend_pid() AS pid')
    this.runningPid = Number(pidRes.rows[0]?.pid ?? 0) || null
    if (this.runningPid !== null) onSession?.(String(this.runningPid))
    const statements = splitStatements(sql)
    if (statements.length === 0)
      throw new DbError('EMPTY', 'No SQL statement to run', this.engine)
    const results: QueryResultSet[] = []
    try {
      for (const stmt of statements) {
        const started = Date.now()
        const dropTarget = this.dropDatabaseTarget(stmt)
        if (dropTarget) await this.prepareDropDatabase(dropTarget)
        const res = await this.runStatement(client, stmt, maxRows)
        if (res.columns.length > 0) {
          results.push({
            statement: summarizeStatement(stmt),
            kind: 'rows',
            columns: res.columns,
            rows: res.rows,
            rowCount: res.rows.length,
            truncated: res.truncated,
            durationMs: Date.now() - started
          })
        } else {
          results.push({
            statement: summarizeStatement(stmt),
            kind: 'command',
            columns: [],
            rows: [],
            rowCount: res.rowCount,
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
      this.runningPid = null
    }
  }

  // A cursor reads rows in batches, so a SELECT that matches millions of rows
  // only transfers maxRows + 1 of them. A plain client.query() buffered the
  // whole result set in the worker before the caller could slice it.
  private async runStatement(
    client: Client,
    sql: string,
    maxRows: number
  ): Promise<{
    columns: { name: string }[]
    rows: Record<string, unknown>[]
    truncated: boolean
    rowCount: number
  }> {
    const { default: Cursor } = await import('pg-cursor')
    const cursor = client.query(new Cursor(sql, [], { rowMode: 'array' }))
    const values: unknown[][] = []
    let fields: { name: string }[] = []
    let truncated = false
    let rowCount = 0
    // Resolves to a rejection when the session ends, so a read that will never
    // call back is released instead of hanging the query.
    const died = this.deaths.get(client)
    try {
      for (;;) {
        const read = new Promise<{ rows: unknown[][]; result?: unknown }>(
          (resolve, reject) => {
            cursor.read(
              Math.min(500, maxRows + 1 - values.length),
              (err: Error | undefined, rows: unknown[][], result: unknown) => {
                if (err) reject(err)
                else resolve({ rows, result })
              }
            )
          }
        )
        const batch = died ? await Promise.race([read, died]) : await read
        if (batch.result) {
          const meta = batch.result as {
            fields?: { name: string }[]
            rowCount?: number | null
          }
          if (meta.fields && meta.fields.length > 0) fields = meta.fields
          if (typeof meta.rowCount === 'number') rowCount = meta.rowCount
        }
        if (batch.rows.length === 0) break
        values.push(...batch.rows)
        if (values.length > maxRows) {
          truncated = true
          break
        }
      }
    } finally {
      // On a dead session `close()` waits for a reply that never comes, so it is
      // raced against the same death promise as the reads.
      const closing = cursor.close().catch(() => undefined)
      await (died ? Promise.race([closing, died.catch(() => undefined)]) : closing)
    }
    if (values.length > maxRows) values.length = maxRows
    const rows = values.map((row) => {
      const record: Record<string, unknown> = {}
      fields.forEach((field, index) => {
        record[field.name] = row[index]
      })
      return record
    })
    return { columns: fields, rows, truncated, rowCount }
  }

  async explainQuery(
    sql: string,
    context?: { database?: string; schema?: string },
    analyze?: boolean
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
    const client = await this.getClient(context?.database ?? this.defaultDatabase())
    await this.applySearchPath(client, context?.schema)
    // ANALYZE actually executes the statement, so the caller has to ask for it.
    const options = analyze
      ? 'EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS)'
      : 'EXPLAIN (FORMAT JSON)'
    const res = await client.query({ text: `${options} ${statement}` })
    const first = (res.rows as Record<string, unknown>[])[0]
    const plan = first ? Object.values(first)[0] : undefined
    if (plan === undefined) {
      throw new DbError(
        'EXPLAIN_EMPTY',
        'Server tidak mengembalikan query plan.',
        this.engine
      )
    }
    return { format: 'json' as const, raw: JSON.stringify(plan) }
  }

  async getTableDdl(
    database: string,
    table: string,
    schema = 'public'
  ): Promise<string | null> {
    const client = await this.getClient(database)
    const cols = await client.query(
      `SELECT column_name AS name, data_type AS type, is_nullable AS nullable,
              column_default AS "defaultValue", character_maximum_length AS maxlen
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, table]
    )
    if (cols.rows.length === 0) return null
    const pkRes = await client.query(
      `SELECT kcu.column_name AS name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schema, table]
    )
    const pk = new Set(pkRes.rows.map((r) => r.name as string))
    const defs = cols.rows.map((r) => {
      let type = r.type as string
      if (r.maxlen && (type === 'character varying' || type === 'character')) {
        type = `${type}(${r.maxlen})`
      }
      let def = `  ${quoteIdent(this.engine, r.name as string)} ${type}`
      if (pk.has(r.name as string)) def += ' PRIMARY KEY'
      else if (r.nullable === 'NO') def += ' NOT NULL'
      if (r.defaultValue) def += ` DEFAULT ${r.defaultValue}`
      return def
    })
    const target = qualifiedTable(this.engine, table, schema)
    return `CREATE TABLE ${target} (\n${defs.join(',\n')}\n);`
  }

  async listIndexes(
    database: string,
    table: string,
    schema = 'public'
  ): Promise<IndexInfo[]> {
    const client = await this.getClient(database)
    const res = await client.query(
      `SELECT i.relname AS name, ix.indisunique AS unique, ix.indisprimary AS primary,
              am.amname AS method,
              a.attname AS column, array_position(ix.indkey, a.attnum) AS seq
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_am am ON am.oid = i.relam
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (ix.indkey)
       WHERE n.nspname = $1 AND t.relname = $2
       ORDER BY i.relname, seq`,
      [schema, table]
    )
    const byName = new Map<string, IndexInfo>()
    for (const r of res.rows as {
      name: string
      unique: boolean
      primary: boolean
      method: string
      column: string
      seq: number
    }[]) {
      const entry = byName.get(r.name) ?? {
        name: r.name,
        columns: [],
        unique: r.unique,
        primary: r.primary,
        method: r.method
      }
      entry.columns.push(r.column)
      byName.set(r.name, entry)
    }
    return [...byName.values()]
  }

  async listForeignKeys(
    database: string,
    table: string,
    schema = 'public'
  ): Promise<ForeignKeyInfo[]> {
    const client = await this.getClient(database)
    const res = await client.query(
      `SELECT con.conname AS name, att.attname AS column,
              nsp2.nspname AS "refSchema", cl2.relname AS "refTable",
              att2.attname AS "refColumn",
              con.confupdtype AS "upd", con.confdeltype AS "del"
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = cl.relnamespace
       JOIN pg_class cl2 ON cl2.oid = con.confrelid
       JOIN pg_namespace nsp2 ON nsp2.oid = cl2.relnamespace
       JOIN pg_attribute att ON att.attrelid = cl.oid AND att.attnum = ANY (con.conkey)
       JOIN pg_attribute att2 ON att2.attrelid = cl2.oid AND att2.attnum = ANY (con.confkey)
       WHERE con.contype = 'f' AND nsp.nspname = $1 AND cl.relname = $2
       ORDER BY con.conname`,
      [schema, table]
    )
    const action: Record<string, string> = {
      a: 'NO ACTION',
      r: 'RESTRICT',
      c: 'CASCADE',
      n: 'SET NULL',
      d: 'SET DEFAULT'
    }
    const byName = new Map<string, ForeignKeyInfo>()
    for (const r of res.rows as {
      name: string
      column: string
      refSchema: string
      refTable: string
      refColumn: string
      upd: string
      del: string
    }[]) {
      const entry = byName.get(r.name) ?? {
        name: r.name,
        columns: [],
        refSchema: r.refSchema,
        refTable: r.refTable,
        refColumns: [],
        onUpdate: action[r.upd] ?? 'NO ACTION',
        onDelete: action[r.del] ?? 'NO ACTION'
      }
      entry.columns.push(r.column)
      entry.refColumns.push(r.refColumn)
      byName.set(r.name, entry)
    }
    return [...byName.values()]
  }

  async getTableInfo(
    database: string,
    table: string,
    schema = 'public'
  ): Promise<TableInfoDetail> {
    const client = await this.getClient(database)
    const res = await client.query(
      `SELECT c.reltuples::bigint AS "rowCount", pg_total_relation_size(c.oid) AS "sizeBytes",
              obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, table]
    )
    const r = res.rows[0]
    if (!r) return {}
    return {
      rowCount: r.rowCount === null ? null : Number(r.rowCount),
      sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
      comment: (r.comment as string | null) ?? null
    }
  }

  async getViewDefinition(
    database: string,
    view: string,
    schema = 'public'
  ): Promise<string | null> {
    const client = await this.getClient(database)
    const res = await client.query(
      `SELECT pg_get_viewdef(format('%I.%I', $1::text, $2::text)::regclass, true) AS def`,
      [schema, view]
    )
    return (res.rows[0]?.def as string) ?? null
  }

  async getRoutineDefinition(
    database: string,
    routine: string,
    kind: RoutineKind,
    schema = 'public',
    signature?: string | null
  ): Promise<string | null> {
    const client = await this.getClient(database)
    // Triggers have no pg_get_functiondef; pg_get_triggerdef rebuilds the
    // CREATE TRIGGER statement from the catalog.
    if (kind === 'trigger') {
      const res = await client.query(
        `SELECT pg_get_triggerdef(t.oid, true) AS def
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND t.tgname = $2`,
        [schema, routine]
      )
      return (res.rows[0]?.def as string) ?? null
    }
    // Overloaded functions need the identity arguments to pick one OID.
    const args = (signature ?? '').trim()
    const res = await client.query(
      `SELECT pg_get_functiondef(p.oid) AS def
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname = $2
         AND ($3 = '' OR pg_get_function_identity_arguments(p.oid) = $3)
       LIMIT 1`,
      [schema, routine, args]
    )
    return (res.rows[0]?.def as string) ?? null
  }

  async listRoutines(database: string, schema = 'public'): Promise<RoutineInfo[]> {
    const client = await this.getClient(database)
    const out: RoutineInfo[] = []
    const procs = await client.query(
      `SELECT p.proname AS name, p.prokind AS kind,
              pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1
       ORDER BY p.proname`,
      [schema]
    )
    for (const r of procs.rows as { name: string; kind: string; args: string }[]) {
      // prokind: f=function, p=procedure, a=aggregate, w=window.
      if (r.kind !== 'f' && r.kind !== 'p') continue
      out.push({
        name: r.name,
        kind: r.kind === 'p' ? 'procedure' : 'function',
        signature: `(${r.args})`
      })
    }
    const triggers = await client.query(
      `SELECT t.tgname AS name, c.relname AS tbl
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND NOT t.tgisinternal
       ORDER BY t.tgname`,
      [schema]
    )
    for (const r of triggers.rows as { name: string; tbl: string }[]) {
      out.push({ name: r.name, kind: 'trigger', detail: r.tbl })
    }
    return out
  }

  async searchObjects(
    database: string,
    term: string,
    schema = 'public'
  ): Promise<SearchResult[]> {
    const client = await this.getClient(database)
    const like = `%${term}%`
    const out: SearchResult[] = []
    const objs = await client.query(
      `SELECT table_name AS name, table_type AS type FROM information_schema.tables
       WHERE table_schema = $1 AND table_name ILIKE $2
       ORDER BY table_name LIMIT 200`,
      [schema, like]
    )
    for (const r of objs.rows as { name: string; type: string }[]) {
      out.push({
        kind: r.type === 'VIEW' ? 'view' : 'table',
        name: r.name,
        schema
      })
    }
    const cols = await client.query(
      `SELECT table_name AS tbl, column_name AS name, data_type AS type
       FROM information_schema.columns
       WHERE table_schema = $1 AND column_name ILIKE $2
       ORDER BY table_name, ordinal_position LIMIT 200`,
      [schema, like]
    )
    for (const r of cols.rows as { tbl: string; name: string; type: string }[]) {
      out.push({ kind: 'column', name: r.name, table: r.tbl, schema, detail: r.type })
    }
    const routines = await client.query(
      `SELECT p.proname AS name, p.prokind AS kind FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = $1 AND p.proname ILIKE $2 LIMIT 100`,
      [schema, like]
    )
    for (const r of routines.rows as { name: string; kind: string }[]) {
      if (r.kind !== 'f' && r.kind !== 'p') continue
      out.push({
        kind: 'routine',
        name: r.name,
        schema,
        detail: r.kind === 'p' ? 'PROCEDURE' : 'FUNCTION'
      })
    }
    return out
  }

  async listSessions(database?: string): Promise<SessionInfo[]> {
    const client = await this.getClient(database ?? this.defaultDatabase())
    // Scope to one database by default (safe default), with the current backend
    // flagged so the UI can prevent killing itself.
    const res = await client.query(
      `SELECT pid, usename, datname, state, query,
              client_addr::text AS client,
              EXTRACT(EPOCH FROM (now() - query_start)) * 1000 AS duration_ms,
              query_start::text AS started_at,
              pid = pg_backend_pid() AS is_self
       FROM pg_stat_activity
       WHERE datname = $1
       ORDER BY query_start NULLS LAST`,
      [database ?? this.defaultDatabase()]
    )
    return res.rows.map((r) => ({
      id: String(r.pid),
      user: (r.usename as string) ?? null,
      database: (r.datname as string) ?? null,
      state: (r.state as string) ?? null,
      query: (r.query as string) ?? null,
      client: (r.client as string) ?? null,
      durationMs: r.duration_ms === null ? null : Math.round(Number(r.duration_ms)),
      startedAt: (r.started_at as string) ?? null,
      isSelf: r.is_self === true
    }))
  }

  async killSession(sessionId: string): Promise<void> {
    const pid = Number(sessionId)
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new DbError(
        'INVALID_SESSION',
        `ID sesi tidak valid: ${sessionId}`,
        this.engine
      )
    }
    const client = await this.getClient(this.defaultDatabase())
    const res = await client.query('SELECT pg_terminate_backend($1) AS ok', [pid])
    if (res.rows[0]?.ok !== true) {
      throw new DbError(
        'KILL_FAILED',
        `Gagal menghentikan sesi ${pid}. Mungkin butuh privilege superuser.`,
        this.engine
      )
    }
  }

  async listTableStats(database: string, schema = 'public'): Promise<TableStat[]> {
    const client = await this.getClient(database)
    const res = await client.query(
      `SELECT c.relname AS name,
              c.relkind AS kind,
              c.reltuples::bigint AS rows,
              pg_total_relation_size(c.oid) AS "sizeBytes",
              obj_description(c.oid, 'pg_class') AS comment,
              NULL AS engine,
              NULL AS "modifiedAt"
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'v')
       ORDER BY c.relname`,
      [schema]
    )
    return res.rows.map((r) => ({
      name: r.name as string,
      type: r.kind === 'v' ? 'view' : 'table',
      // Postgres keeps -1 until the table has been analyzed.
      rows: r.rows === null || Number(r.rows) < 0 ? null : Number(r.rows),
      sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
      comment: (r.comment as string | null) ?? null,
      engine: null,
      modifiedAt: null
    }))
  }

  async listUsers(): Promise<DbUser[]> {
    const client = await this.getClient(this.defaultDatabase())
    const res = await client.query(
      `SELECT rolname AS name, rolsuper AS super, rolcanlogin AS canlogin, rolcreatedb AS createdb, rolcreaterole AS createrole
       FROM pg_roles
       ORDER BY rolname`
    )
    return res.rows.map((r) => {
      const attributes: string[] = []
      if (r.createdb === true) attributes.push('createdb')
      if (r.createrole === true) attributes.push('createrole')
      return {
        name: r.name as string,
        canLogin: r.canlogin === true,
        isSuperuser: r.super === true,
        attributes
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
    const database = begin.database ?? this.defaultDatabase()
    const client = await this.openTransactionClient(database)
    try {
      await this.applySearchPath(client, begin.schema)
      await client.query('BEGIN')
    } catch (err) {
      await client.end().catch(() => undefined)
      throw err
    }
    const info: TransactionInfo = {
      transactionId: begin.transactionId,
      connectionId: begin.connectionId,
      database,
      schema: begin.schema,
      startedAt: new Date().toISOString(),
      statements: 0,
      failed: false
    }
    this.transactions.set(begin.transactionId, { client, info })
    return info
  }

  async commitTransaction(ref: TransactionRef): Promise<void> {
    const entry = this.transactions.get(ref.transactionId)
    if (!entry) {
      throw new DbError('NO_TRANSACTION', 'Transaksi tidak lagi terbuka.', this.engine)
    }
    this.transactions.delete(ref.transactionId)
    try {
      await entry.client.query('COMMIT')
    } finally {
      await entry.client.end().catch(() => undefined)
    }
  }

  async rollbackTransaction(ref: TransactionRef): Promise<void> {
    const entry = this.transactions.get(ref.transactionId)
    if (!entry) return
    this.transactions.delete(ref.transactionId)
    try {
      await entry.client.query('ROLLBACK')
    } finally {
      await entry.client.end().catch(() => undefined)
    }
  }

  async listTransactions(): Promise<TransactionInfo[]> {
    return [...this.transactions.values()].map((entry) => ({ ...entry.info }))
  }
}

export const createPostgresAdapter: (engine: DbEngine) => DatabaseAdapter = () =>
  new PostgresAdapter()
