import type { Pool, PoolConnection } from 'mysql2/promise'
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
import { buildFilterWhere } from '@shared/filter'
import { chunkRows } from '@shared/insertChunks'
import {
  DbError,
  orderClause,
  qualifiedTable,
  quoteIdent,
  splitStatements,
  summarizeStatement,
  type DatabaseAdapter
} from './types'
import { resolveSsl, type ResolvedSsl } from '../connection/ssl'
import { openSshTunnel, sshEnabled, type SshTunnel } from '../connection/sshTunnel'

const QUERY_TIMEOUT_MS = 30000

// The core (non-promise) connection exposes a row stream. Reading it and
// destroying it once `maxRows` is reached keeps the server from sending the
// rest of the result set: without this a SELECT over a large table buffered
// every row in the worker and then threw all but 1000 away.
interface StreamResult {
  fields: string[] | null
  rows: Record<string, unknown>[]
  truncated: boolean
  affectedRows: number
}

function streamStatement(
  connection: { query: (options: { sql: string; timeout: number }) => unknown },
  sql: string,
  maxRows: number
): Promise<StreamResult> {
  return new Promise<StreamResult>((resolve, reject) => {
    const rows: Record<string, unknown>[] = []
    let fields: string[] | null = null
    let truncated = false
    let affectedRows = 0
    let settled = false
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve({ fields, rows, truncated, affectedRows })
    }
    const query = connection.query({ sql, timeout: QUERY_TIMEOUT_MS }) as {
      stream: (options?: { highWaterMark?: number }) => NodeJS.ReadableStream
      queryTimeout?: ReturnType<typeof setTimeout> | null
    }
    const stream = query.stream({ highWaterMark: 16 })
    // mysql2 arms one timer per query and only clears it in done(). Destroying
    // the stream early skips done(), so the timer later fires
    // PROTOCOL_SEQUENCE_TIMEOUT on a query nobody is waiting for. Clear it here
    // so an early stop is not reported as a timeout on the next call.
    const clearQueryTimer = (): void => {
      if (query.queryTimeout) {
        clearTimeout(query.queryTimeout)
        query.queryTimeout = null
      }
    }
    stream.on('fields', (value: unknown) => {
      // A statement without a result set (CREATE, INSERT, SET, USE) emits
      // `fields` with undefined. Reading .map on it threw inside mysql2's
      // packet handler, which stalled the command sequence until the query
      // timer fired 30 seconds later.
      fields = Array.isArray(value)
        ? (value as { name: string }[]).map((f) => f.name)
        : null
    })
    stream.on('data', (row: unknown) => {
      // A statement without a result set emits one header row instead of data.
      if (!fields) {
        affectedRows = (row as { affectedRows?: number }).affectedRows ?? 0
        return
      }
      if (rows.length < maxRows) {
        rows.push(row as Record<string, unknown>)
        return
      }
      truncated = true
      clearQueryTimer()
      ;(stream as unknown as { destroy: () => void }).destroy()
    })
    stream.on('end', () => {
      clearQueryTimer()
      finish()
    })
    stream.on('close', () => {
      clearQueryTimer()
      finish()
    })
    stream.on('error', (err: Error) => {
      clearQueryTimer()
      finish(err)
    })
  })
}

class MysqlAdapter implements DatabaseAdapter {
  readonly engine: DbEngine

  constructor(engine: DbEngine = 'mysql') {
    this.engine = engine
  }

  private pool: Pool | null = null
  private tunnel: SshTunnel | null = null

  private async buildOptions(cfg: ConnectionConfig, ssl?: ResolvedSsl | null) {
    const tls = ssl
      ? {
          rejectUnauthorized: ssl.mode !== 'require',
          ca: ssl.ca,
          cert: ssl.cert,
          key: ssl.key,
          servername: ssl.servername
        }
      : undefined
    const base = {
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      ssl: tls,
      connectTimeout: 8000,
      multipleStatements: false
    }
    // Through a tunnel the socket is already connected; host/port must not be
    // used, or mysql2 would open a direct connection instead.
    if (sshEnabled(cfg.ssh) && cfg.ssh) {
      const tunnel = await openSshTunnel(cfg.ssh, this.engine)
      this.tunnel = tunnel
      const stream = await tunnel.forward(cfg.host ?? 'localhost', cfg.port ?? 3306)
      return { ...base, stream }
    }
    return { ...base, host: cfg.host, port: cfg.port }
  }

  async testConnection(cfg: ConnectionConfig): Promise<boolean> {
    const mysql = await import('mysql2/promise')
    const ssl = await resolveSsl(cfg.ssl)
    const options = await this.buildOptions(cfg, ssl)
    try {
      const conn = await mysql.createConnection(options)
      await conn.ping()
      await conn.end()
      return true
    } finally {
      await this.closeTunnel()
    }
  }

  async connect(cfg: ConnectionConfig): Promise<void> {
    const mysql = await import('mysql2/promise')
    const ssl = await resolveSsl(cfg.ssl)
    const options = await this.buildOptions(cfg, ssl)
    this.pool = mysql.createPool(options)
    const conn = await this.pool.getConnection()
    conn.release()
  }

  private async closeTunnel(): Promise<void> {
    await this.tunnel?.close()
    this.tunnel = null
  }

  async disconnect(): Promise<void> {
    await this.pool?.end()
    this.pool = null
    await this.closeTunnel()
  }

  private async withConnection<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
    if (!this.pool) throw new DbError('NOT_CONNECTED', 'Not connected', this.engine)
    const conn = await this.pool.getConnection()
    try {
      return await fn(conn)
    } finally {
      conn.release()
    }
  }

  async listDatabases(): Promise<string[]> {
    return this.withConnection(async (c) => {
      const [rows] = await c.query('SHOW DATABASES')
      // MySQL/MariaDB keep system databases visible (Navicat shows mysql, sys,
      // information_schema, performance_schema). Postgres is the engine that
      // hides its system schemas.
      return (rows as { Database: string }[]).map((r) => r.Database)
    })
  }

  async listSchemas(): Promise<string[]> {
    return []
  }

  async listTables(database: string): Promise<TableInfo[]> {
    return this.withConnection(async (c) => {
      const [rows] = await c.query(
        'SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name',
        [database]
      )
      return (rows as { name: string; type: string }[]).map((r) => ({
        name: r.name,
        schema: database,
        type: r.type === 'VIEW' ? 'view' : 'table'
      }))
    })
  }

  async getPrimaryKey(database: string, table: string): Promise<PrimaryKeyInfo | null> {
    return this.withConnection(async (c) => {
      const [rows] = await c.query(
        "SELECT constraint_name AS name FROM information_schema.table_constraints WHERE table_schema = ? AND table_name = ? AND constraint_type = 'PRIMARY KEY' LIMIT 1",
        [database, table]
      )
      const name = (rows as { name: string }[])[0]?.name
      if (!name) return null
      const [cols] = await c.query(
        'SELECT column_name AS name FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? AND constraint_name = ? ORDER BY ordinal_position',
        [database, table, name]
      )
      return { name, columns: (cols as { name: string }[]).map((r) => r.name) }
    })
  }

  async listColumns(database: string, table: string): Promise<ColumnInfo[]> {
    return this.withConnection(async (c) => {
      const [rows] = await c.query(
        'SELECT column_name AS name, column_type AS dataType, is_nullable AS nullable, column_default AS defaultValue, column_key AS columnKey, extra AS extra, column_comment AS comment FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position',
        [database, table]
      )
      return (
        rows as {
          name: string
          dataType: string
          nullable: string
          defaultValue: string | null
          columnKey: string
          extra: string
          comment: string
        }[]
      ).map((r) => ({
        name: r.name,
        dataType: r.dataType,
        nullable: r.nullable === 'YES',
        defaultValue: r.defaultValue,
        isPrimaryKey: r.columnKey === 'PRI',
        autoIncrement: r.extra.toLowerCase().includes('auto_increment'),
        comment: r.comment || null
      }))
    })
  }

  async selectRows(query: PageQuery): Promise<{
    rows: Record<string, unknown>[]
    total: number
  }> {
    return this.withConnection(async (c) => {
      const table = qualifiedTable(this.engine, query.table, query.schema, query.database)
      const params: unknown[] = []
      let where = ''
      if (
        query.filterColumn &&
        query.filterValue !== undefined &&
        query.filterValue !== ''
      ) {
        where = ` WHERE ${quoteIdent(this.engine, query.filterColumn)} LIKE ?`
        params.push(`%${query.filterValue}%`)
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
      const [countRows] = await c.query(
        `SELECT COUNT(*) AS n FROM ${table}${where}`,
        params
      )
      const total = (countRows as { n: number }[])[0].n
      const [rows] = await c.query(
        `SELECT * FROM ${table}${where}${order} LIMIT ? OFFSET ?`,
        [...params, query.limit, query.offset]
      )
      return { rows: rows as Record<string, unknown>[], total }
    })
  }

  async fetchBatch(query: PageQuery): Promise<Record<string, unknown>[]> {
    return this.withConnection(async (c) => {
      const table = qualifiedTable(this.engine, query.table, query.schema, query.database)
      const order = orderClause(
        this.engine,
        query.orderBy,
        query.orderDir,
        query.orderByColumns
      )
      const [rows] = await c.query(`SELECT * FROM ${table}${order} LIMIT ? OFFSET ?`, [
        query.limit,
        query.offset
      ])
      return rows as Record<string, unknown>[]
    })
  }

  async updateRow(update: RowUpdate): Promise<void> {
    await this.withConnection(async (c) => {
      const table = qualifiedTable(
        this.engine,
        update.table,
        update.schema,
        update.database
      )
      const cols = Object.keys(update.changes)
      if (cols.length === 0) return
      const setClause = cols.map((k) => `${quoteIdent(this.engine, k)} = ?`).join(', ')
      const where = this.buildWhere(update.primaryKeys)
      await c.execute(`UPDATE ${table} SET ${setClause}${where.sql}`, [
        ...cols.map((k) => update.changes[k]),
        ...where.values
      ] as never[])
    })
  }

  async insertRows(
    database: string,
    schema: string | undefined,
    table: string,
    rows: Record<string, unknown>[]
  ): Promise<number> {
    if (rows.length === 0) return 0
    return this.withConnection(async (c) => {
      const target = qualifiedTable(this.engine, table, schema, database)
      const cols = Object.keys(rows[0])
      const colList = cols.map((k) => quoteIdent(this.engine, k)).join(', ')
      const rowMarks = `(${cols.map(() => '?').join(', ')})`
      // One statement per batch used to exceed max_allowed_packet on a large
      // import. Chunks keep every statement small; the transaction keeps the
      // batch all-or-nothing.
      const chunks = chunkRows(rows, cols.length)
      await c.beginTransaction()
      try {
        let inserted = 0
        for (const chunk of chunks) {
          const values: unknown[] = []
          for (const row of chunk) {
            for (const k of cols) values.push(row[k])
          }
          const allMarks = chunk.map(() => rowMarks).join(', ')
          const [res] = await c.execute(
            `INSERT INTO ${target} (${colList}) VALUES ${allMarks}`,
            values as never[]
          )
          inserted += (res as { affectedRows?: number }).affectedRows ?? chunk.length
        }
        await c.commit()
        return inserted
      } catch (err) {
        await c.rollback().catch(() => undefined)
        throw err
      }
    })
  }

  async insertRow(insert: RowInsert): Promise<void> {
    await this.withConnection(async (c) => {
      const table = qualifiedTable(
        this.engine,
        insert.table,
        insert.schema,
        insert.database
      )
      const cols = Object.keys(insert.values)
      if (cols.length === 0)
        throw new DbError('INVALID', 'No values to insert', this.engine)
      const setClause = cols.map((k) => quoteIdent(this.engine, k)).join(', ')
      const marks = cols.map(() => '?').join(', ')
      await c.execute(
        `INSERT INTO ${table} (${setClause}) VALUES (${marks})`,
        cols.map((k) => insert.values[k]) as never[]
      )
    })
  }

  async deleteRow(del: RowDelete): Promise<void> {
    await this.withConnection(async (c) => {
      const table = qualifiedTable(this.engine, del.table, del.schema, del.database)
      const where = this.buildWhere(del.primaryKeys)
      await c.execute(`DELETE FROM ${table}${where.sql}`, where.values as never[])
    })
  }

  async deleteRows(dels: RowDelete[]): Promise<number> {
    if (dels.length === 0) return 0
    return this.withConnection(async (c) => {
      await c.beginTransaction()
      try {
        let deleted = 0
        for (const del of dels) {
          const table = qualifiedTable(this.engine, del.table, del.schema, del.database)
          const where = this.buildWhere(del.primaryKeys)
          const [res] = await c.execute(
            `DELETE FROM ${table}${where.sql}`,
            where.values as never[]
          )
          deleted += (res as { affectedRows?: number }).affectedRows ?? 0
        }
        await c.commit()
        return deleted
      } catch (err) {
        await c.rollback().catch(() => undefined)
        throw err
      }
    })
  }

  async applyRowChanges(changes: RowChangeSet): Promise<RowChangeResult> {
    if (
      changes.deletes.length === 0 &&
      changes.updates.length === 0 &&
      changes.inserts.length === 0
    ) {
      return { deleted: 0, updated: 0, inserted: 0 }
    }
    return this.withConnection(async (c) => {
      const target = qualifiedTable(
        this.engine,
        changes.table,
        changes.schema,
        changes.database
      )
      await c.beginTransaction()
      try {
        let deleted = 0
        for (const keys of changes.deletes) {
          const where = this.buildWhere(keys)
          const [res] = await c.execute(
            `DELETE FROM ${target}${where.sql}`,
            where.values as never[]
          )
          deleted += (res as { affectedRows?: number }).affectedRows ?? 0
        }

        let updated = 0
        for (const update of changes.updates) {
          const cols = Object.keys(update.changes)
          if (cols.length === 0) continue
          const setClause = cols
            .map((k) => `${quoteIdent(this.engine, k)} = ?`)
            .join(', ')
          const where = this.buildWhere(update.primaryKeys)
          const [res] = await c.execute(`UPDATE ${target} SET ${setClause}${where.sql}`, [
            ...cols.map((k) => update.changes[k]),
            ...where.values
          ] as never[])
          updated += (res as { affectedRows?: number }).affectedRows ?? 0
        }

        let inserted = 0
        if (changes.inserts.length > 0) {
          const cols = Object.keys(changes.inserts[0])
          if (cols.length > 0) {
            const colList = cols.map((k) => quoteIdent(this.engine, k)).join(', ')
            const rowMarks = `(${cols.map(() => '?').join(', ')})`
            for (const chunk of chunkRows(changes.inserts, cols.length)) {
              const values: unknown[] = []
              for (const row of chunk) {
                for (const k of cols) values.push(row[k])
              }
              const allMarks = chunk.map(() => rowMarks).join(', ')
              const [res] = await c.execute(
                `INSERT INTO ${target} (${colList}) VALUES ${allMarks}`,
                values as never[]
              )
              inserted += (res as { affectedRows?: number }).affectedRows ?? chunk.length
            }
          }
        }

        await c.commit()
        return { deleted, updated, inserted }
      } catch (err) {
        await c.rollback().catch(() => undefined)
        throw err
      }
    })
  }

  private buildWhere(pks: Record<string, unknown>): { sql: string; values: unknown[] } {
    const keys = Object.keys(pks)
    if (keys.length === 0)
      throw new DbError('INVALID', 'Primary key required for this operation', this.engine)
    const sql =
      ' WHERE ' + keys.map((k) => `${quoteIdent(this.engine, k)} = ?`).join(' AND ')
    return { sql, values: keys.map((k) => pks[k]) }
  }

  // Connection id reported by the server for the statement in flight. KILL QUERY
  // cancels only the statement, leaving the session (and the pool) usable.
  private runningConnectionId: number | null = null

  async cancelQuery(): Promise<boolean> {
    if (this.runningConnectionId === null) return false
    const id = this.runningConnectionId
    return this.withConnection(async (c) => {
      await c.query(`KILL QUERY ${id}`)
      return true
    })
  }

  async runQuery(
    sql: string,
    maxRows: number,
    context?: { database?: string; schema?: string },
    onSession?: (sessionId: string) => void
  ): Promise<QueryResultSet[]> {
    const statements = splitStatements(sql)
    if (statements.length === 0)
      throw new DbError('EMPTY', 'No SQL statement to run', this.engine)
    return this.withConnection(async (c) => {
      // MySQL binds the default schema per session; switch when a database is chosen.
      if (context?.database) {
        await c.query(`USE ${quoteIdent(this.engine, context.database)}`)
      }
      const threadRes = await c.query('SELECT CONNECTION_ID() AS id')
      const threadId = Number((threadRes[0] as { id?: number }[])[0]?.id ?? 0)
      this.runningConnectionId =
        Number.isInteger(threadId) && threadId > 0 ? threadId : null
      if (this.runningConnectionId !== null) onSession?.(String(this.runningConnectionId))
      const results: QueryResultSet[] = []
      try {
        for (const stmt of statements) {
          const started = Date.now()
          const streamed = await streamStatement(c.connection, stmt, maxRows)
          if (streamed.fields) {
            results.push({
              statement: summarizeStatement(stmt),
              kind: 'rows',
              columns: streamed.fields.map((name) => ({ name })),
              rows: streamed.rows,
              rowCount: streamed.rows.length,
              truncated: streamed.truncated,
              durationMs: Date.now() - started
            })
          } else {
            results.push({
              statement: summarizeStatement(stmt),
              kind: 'command',
              columns: [],
              rows: [],
              rowCount: streamed.affectedRows,
              truncated: false,
              command: stmt.split(/\s+/)[0].toUpperCase(),
              durationMs: Date.now() - started
            })
          }
        }
        return results
      } finally {
        this.runningConnectionId = null
      }
    })
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
    // MySQL can only ANALYZE a statement it would actually run; format=json is
    // available on 5.6+ and is the only machine-readable shape.
    const prefix = analyze ? 'EXPLAIN ANALYZE FORMAT=JSON ' : 'EXPLAIN FORMAT=JSON '
    return this.withConnection(async (c) => {
      if (context?.database) {
        await c.query(`USE ${quoteIdent(this.engine, context.database)}`)
      }
      const [rows] = await c.query({
        sql: `${prefix}${statement}`,
        timeout: QUERY_TIMEOUT_MS
      })
      const first = Array.isArray(rows)
        ? (rows as Record<string, unknown>[])[0]
        : undefined
      const raw = first ? String(Object.values(first)[0] ?? '') : ''
      if (!raw) {
        throw new DbError(
          'EXPLAIN_EMPTY',
          'Server tidak mengembalikan query plan.',
          this.engine
        )
      }
      return { format: 'json' as const, raw }
    })
  }

  async getTableDdl(database: string, table: string): Promise<string | null> {
    return this.withConnection(async (c) => {
      const [rows] = await c.query(
        `SHOW CREATE TABLE ${qualifiedTable(this.engine, table, undefined, database)}`
      )
      const row = (rows as Record<string, string>[])[0]
      if (!row) return null
      const ddl = row['Create Table'] ?? row['Create View']
      if (!ddl) return null
      return ddl.endsWith(';') ? ddl : `${ddl};`
    })
  }

  async listIndexes(database: string, table: string): Promise<IndexInfo[]> {
    return this.withConnection(async (c) => {
      // `column` is a reserved word in MySQL 8+/9, so the alias must be quoted
      // (or renamed). Without this every call fails with ER_PARSE_ERROR.
      const [rows] = await c.query(
        `SELECT index_name AS name, non_unique AS nonUnique, index_type AS method,
                column_name AS \`column\`, seq_in_index AS seq
         FROM information_schema.statistics
         WHERE table_schema = ? AND table_name = ?
         ORDER BY index_name, seq_in_index`,
        [database, table]
      )
      const byName = new Map<string, IndexInfo>()
      for (const r of rows as {
        name: string
        nonUnique: number
        method: string
        column: string
      }[]) {
        const entry = byName.get(r.name) ?? {
          name: r.name,
          columns: [],
          unique: r.nonUnique === 0,
          primary: r.name === 'PRIMARY',
          method: r.method
        }
        entry.columns.push(r.column)
        byName.set(r.name, entry)
      }
      return [...byName.values()]
    })
  }

  async listForeignKeys(database: string, table: string): Promise<ForeignKeyInfo[]> {
    return this.withConnection(async (c) => {
      const [rows] = await c.query(
        `SELECT rc.constraint_name AS name, kcu.column_name AS \`column\`,
                kcu.referenced_table_schema AS refSchema, kcu.referenced_table_name AS refTable,
                kcu.referenced_column_name AS refColumn, rc.update_rule AS onUpdate,
                rc.delete_rule AS onDelete
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = rc.constraint_name
          AND kcu.constraint_schema = rc.constraint_schema
          AND kcu.table_name = rc.table_name
         WHERE rc.constraint_schema = ? AND rc.table_name = ?
         ORDER BY rc.constraint_name, kcu.ordinal_position`,
        [database, table]
      )
      const byName = new Map<string, ForeignKeyInfo>()
      for (const r of rows as {
        name: string
        column: string
        refSchema: string | null
        refTable: string | null
        refColumn: string | null
        onUpdate: string | null
        onDelete: string | null
      }[]) {
        if (!r.refTable || !r.refColumn) continue
        const entry = byName.get(r.name) ?? {
          name: r.name,
          columns: [],
          refSchema: r.refSchema ?? undefined,
          refTable: r.refTable,
          refColumns: [],
          onUpdate: r.onUpdate ?? undefined,
          onDelete: r.onDelete ?? undefined
        }
        entry.columns.push(r.column)
        entry.refColumns.push(r.refColumn)
        byName.set(r.name, entry)
      }
      return [...byName.values()]
    })
  }

  async getTableInfo(database: string, table: string): Promise<TableInfoDetail> {
    return this.withConnection(async (c) => {
      const [rows] = await c.query(
        `SELECT table_rows AS rowCount, data_length AS dataLength, index_length AS indexLength,
                engine, table_collation AS collation, table_comment AS comment
         FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
        [database, table]
      )
      const r = (
        rows as {
          rowCount: number | null
          dataLength: number | null
          indexLength: number | null
          engine: string | null
          collation: string | null
          comment: string | null
        }[]
      )[0]
      if (!r) return {}
      const data = Number(r.dataLength ?? 0)
      const index = Number(r.indexLength ?? 0)
      return {
        rowCount: r.rowCount === null ? null : Number(r.rowCount),
        sizeBytes: data + index,
        engine: r.engine ?? null,
        collation: r.collation ?? null,
        comment: r.comment ?? null
      }
    })
  }

  async getViewDefinition(database: string, view: string): Promise<string | null> {
    return this.withConnection(async (c) => {
      const [rows] = await c.query(
        'SELECT view_definition AS def FROM information_schema.views WHERE table_schema = ? AND table_name = ?',
        [database, view]
      )
      const row = (rows as { def: string | null }[])[0]
      return row?.def ?? null
    })
  }

  async getRoutineDefinition(
    database: string,
    routine: string,
    kind: RoutineKind,
    _schema?: string,
    _signature?: string | null
  ): Promise<string | null> {
    return this.withConnection(async (c) => {
      // SHOW CREATE is the only statement that returns the body plus the
      // definer and SQL mode. information_schema.routines loses those.
      if (kind === 'trigger') {
        const [rows] = await c.query(
          `SHOW CREATE TRIGGER ${quoteIdent(this.engine, routine)}`
        )
        const row = (rows as Record<string, string>[])[0]
        return row?.['SQL Original Statement'] ?? null
      }
      const keyword = kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
      const [rows] = await c.query(
        `SHOW CREATE ${keyword} ${qualifiedTable(this.engine, routine, undefined, database)}`
      )
      const row = (rows as Record<string, string>[])[0]
      if (!row) return null
      const key = Object.keys(row).find((k) => k.startsWith('Create '))
      return key ? row[key] : null
    })
  }

  async listRoutines(database: string): Promise<RoutineInfo[]> {
    return this.withConnection(async (c) => {
      const out: RoutineInfo[] = []
      const [routines] = await c.query(
        'SELECT routine_name AS name, routine_type AS type FROM information_schema.routines WHERE routine_schema = ? ORDER BY routine_name',
        [database]
      )
      for (const r of routines as { name: string; type: string }[]) {
        out.push({
          name: r.name,
          kind: r.type === 'PROCEDURE' ? 'procedure' : 'function'
        })
      }
      const [triggers] = await c.query(
        'SELECT trigger_name AS name, event_object_table AS tbl FROM information_schema.triggers WHERE trigger_schema = ? ORDER BY trigger_name',
        [database]
      )
      for (const r of triggers as { name: string; tbl: string }[]) {
        out.push({ name: r.name, kind: 'trigger', detail: r.tbl })
      }
      // Events only exist on MySQL/MariaDB, and the table may be empty.
      try {
        const [events] = await c.query(
          'SELECT event_name AS name, status FROM information_schema.events WHERE event_schema = ? ORDER BY event_name',
          [database]
        )
        for (const r of events as { name: string; status: string }[]) {
          out.push({ name: r.name, kind: 'event', detail: r.status })
        }
      } catch {
        // Events are not supported on this server version; ignore.
      }
      return out
    })
  }

  async searchObjects(database: string, term: string): Promise<SearchResult[]> {
    return this.withConnection(async (c) => {
      const like = `%${term}%`
      const out: SearchResult[] = []
      const [objs] = await c.query(
        `SELECT table_name AS name, table_type AS type FROM information_schema.tables
         WHERE table_schema = ? AND table_name LIKE ?
         ORDER BY table_name LIMIT 200`,
        [database, like]
      )
      for (const r of objs as { name: string; type: string }[]) {
        out.push({
          kind: r.type === 'VIEW' ? 'view' : 'table',
          name: r.name
        })
      }
      const [cols] = await c.query(
        `SELECT table_name AS tbl, column_name AS name, column_type AS type
         FROM information_schema.columns
         WHERE table_schema = ? AND column_name LIKE ?
         ORDER BY table_name, ordinal_position LIMIT 200`,
        [database, like]
      )
      for (const r of cols as { tbl: string; name: string; type: string }[]) {
        out.push({
          kind: 'column',
          name: r.name,
          table: r.tbl,
          detail: r.type
        })
      }
      const [routines] = await c.query(
        `SELECT routine_name AS name, routine_type AS type FROM information_schema.routines
         WHERE routine_schema = ? AND routine_name LIKE ? LIMIT 100`,
        [database, like]
      )
      for (const r of routines as { name: string; type: string }[]) {
        out.push({
          kind: 'routine',
          name: r.name,
          detail: r.type
        })
      }
      return out
    })
  }

  async listSessions(database?: string): Promise<SessionInfo[]> {
    return this.withConnection(async (c) => {
      const [rows] = await c.query(
        `SELECT id, user, host, db, command, time, state, info
         FROM information_schema.processlist
         ${database ? 'WHERE db = ?' : ''}
         ORDER BY time DESC`,
        database ? [database] : []
      )
      const [self] = await c.query('SELECT CONNECTION_ID() AS id')
      const selfId = String((self as { id: number }[])[0]?.id ?? '')
      return (
        rows as {
          id: number
          user: string
          host: string
          db: string | null
          command: string
          time: number | null
          state: string | null
          info: string | null
        }[]
      ).map((r) => ({
        id: String(r.id),
        user: r.user,
        database: r.db,
        state: r.state ?? r.command,
        query: r.info,
        client: r.host,
        // `time` is seconds spent in the current state.
        durationMs: r.time === null ? null : r.time * 1000,
        isSelf: String(r.id) === selfId
      }))
    })
  }

  async killSession(sessionId: string): Promise<void> {
    const id = Number(sessionId)
    if (!Number.isInteger(id) || id <= 0) {
      throw new DbError(
        'INVALID_SESSION',
        `ID sesi tidak valid: ${sessionId}`,
        this.engine
      )
    }
    await this.withConnection(async (c) => {
      await c.query(`KILL ${id}`)
    })
  }

  async listTableStats(database: string): Promise<TableStat[]> {
    return this.withConnection(async (c) => {
      // `rows` is a reserved word in MySQL 8.4, so every alias that could clash
      // with a keyword is quoted. `data_length + index_length` also needs its
      // own alias to stay readable in the result.
      const [rows] = await c.query(
        `SELECT TABLE_NAME AS \`name\`, TABLE_TYPE AS \`type\`,
                TABLE_ROWS AS \`rows\`,
                COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS \`sizeBytes\`,
                TABLE_COMMENT AS \`comment\`, ENGINE AS \`engine\`,
                UPDATE_TIME AS \`modifiedAt\`
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME`,
        [database]
      )
      return (
        rows as {
          name: string
          type: string
          rows: number | null
          sizeBytes: number | null
          comment: string | null
          engine: string | null
          modifiedAt: Date | null
        }[]
      ).map((r) => ({
        name: r.name,
        type: r.type === 'VIEW' ? 'view' : 'table',
        rows: r.rows === null ? null : Number(r.rows),
        sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
        comment: r.comment || null,
        engine: r.engine,
        modifiedAt: r.modifiedAt ? new Date(r.modifiedAt).toISOString() : null
      }))
    })
  }

  async listUsers(): Promise<DbUser[]> {
    return this.withConnection(async (c) => {
      const [rows] = await c.query(
        'SELECT User AS name, Host AS host, Super_priv AS superPriv, account_locked AS locked FROM mysql.user ORDER BY User, Host'
      )
      return (
        rows as {
          name: string
          host: string
          superPriv: string
          locked: string
        }[]
      ).map((r) => ({
        name: r.name,
        host: r.host,
        canLogin: true,
        isSuperuser: r.superPriv === 'Y',
        attributes: r.locked === 'Y' ? ['locked'] : []
      }))
    })
  }
}

export function createMysqlAdapter(engine: DbEngine): DatabaseAdapter {
  return new MysqlAdapter(engine)
}
