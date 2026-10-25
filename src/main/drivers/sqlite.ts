import type { Database, Statement } from 'better-sqlite3'
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
  TransactionInfo
} from '@shared/types'
import { buildFilterWhere } from '@shared/filter'
import { nowExpression } from '@shared/nowExpression'
import {
  DbError,
  orderClause,
  quoteIdent,
  splitStatements,
  summarizeStatement,
  type DatabaseAdapter
} from './types'

class SqliteAdapter implements DatabaseAdapter {
  readonly engine: DbEngine = 'sqlite'
  private db: Database | null = null

  // better-sqlite3 only binds numbers, strings, bigints, buffers and null.
  private bind(value: unknown): unknown {
    if (value === undefined) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    if (value !== null && typeof value === 'object') return JSON.stringify(value)
    return value
  }

  async testConnection(cfg: ConnectionConfig): Promise<boolean> {
    if (!cfg.file) throw new DbError('CONFIG', 'sqlite requires a file path', this.engine)
    const { default: DatabaseCtor } = await import('better-sqlite3')
    const db = new DatabaseCtor(cfg.file, { readonly: true, fileMustExist: true })
    db.close()
    return true
  }

  async connect(cfg: ConnectionConfig): Promise<void> {
    if (!cfg.file) throw new DbError('CONFIG', 'sqlite requires a file path', this.engine)
    const { default: DatabaseCtor } = await import('better-sqlite3')
    this.db = new DatabaseCtor(cfg.file, { fileMustExist: true })
  }

  async disconnect(): Promise<void> {
    this.db?.close()
    this.db = null
  }

  private require(): Database {
    if (!this.db) throw new DbError('NOT_CONNECTED', 'Not connected', this.engine)
    return this.db
  }

  async listDatabases(): Promise<string[]> {
    return ['main']
  }

  async listSchemas(): Promise<string[]> {
    return ['main']
  }

  async listTables(): Promise<TableInfo[]> {
    const rows = this.require()
      .prepare(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string; type: string }[]
    return rows.map((r) => ({ name: r.name, type: r.type as TableInfo['type'] }))
  }

  async getPrimaryKey(_database: string, table: string): Promise<PrimaryKeyInfo | null> {
    const rows = this.require()
      .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
      .all() as { name: string; pk: number }[]
    const columns = rows
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name)
    return columns.length > 0 ? { name: null, columns } : null
  }

  async listColumns(_db: string, table: string): Promise<ColumnInfo[]> {
    const db = this.require()
    const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as {
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }[]
    // PRAGMA does not flag AUTOINCREMENT; it only appears in the stored DDL.
    const master = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) as { sql: string | null } | undefined
    const autoinc = /\bAUTOINCREMENT\b/i.test(master?.sql ?? '')
    // A single-column INTEGER PRIMARY KEY is a rowid alias even without the
    // AUTOINCREMENT keyword, so SQLite fills it in on INSERT. Missing this made
    // the insert form send an explicit 0 and every new row landed on id 0.
    // WITHOUT ROWID tables have no such alias.
    const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(master?.sql ?? '')
    const pkCols = rows.filter((r) => r.pk > 0)
    const rowidAlias =
      !withoutRowid && pkCols.length === 1 && /^INTEGER$/i.test(pkCols[0].type.trim())
    return rows.map((r) => ({
      name: r.name,
      dataType: r.type,
      nullable: r.notnull === 0,
      defaultValue: r.dflt_value,
      isPrimaryKey: r.pk > 0,
      autoIncrement: r.pk > 0 && (autoinc || rowidAlias)
    }))
  }

  async selectRows(query: PageQuery): Promise<{
    rows: Record<string, unknown>[]
    total: number
  }> {
    const db = this.require()
    const table = quoteIdent(this.engine, query.table)
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
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where}`).get(...params) as {
        n: number
      }
    ).n
    const rows = db
      .prepare(`SELECT * FROM ${table}${where}${order} LIMIT ? OFFSET ?`)
      .all(...params, query.limit, query.offset) as Record<string, unknown>[]
    return { rows, total }
  }

  async fetchBatch(query: PageQuery): Promise<Record<string, unknown>[]> {
    const db = this.require()
    const table = quoteIdent(this.engine, query.table)
    const order = orderClause(
      this.engine,
      query.orderBy,
      query.orderDir,
      query.orderByColumns
    )
    return db
      .prepare(`SELECT * FROM ${table}${order} LIMIT ? OFFSET ?`)
      .all(query.limit, query.offset) as Record<string, unknown>[]
  }

  async updateRow(update: RowUpdate): Promise<void> {
    const db = this.require()
    const table = quoteIdent(this.engine, update.table)
    const cols = Object.keys(update.changes)
    const now = update.nowColumns ?? []
    if (cols.length === 0 && now.length === 0) return
    const setClause = [
      ...cols.map((c) => `${quoteIdent(this.engine, c)} = ?`),
      ...now.map((col) => {
        const expression = nowExpression(this.engine, col.kind)
        if (!expression)
          throw new DbError('UNSUPPORTED', 'now() tidak tersedia.', this.engine)
        return `${quoteIdent(this.engine, col.name)} = ${expression}`
      })
    ].join(', ')
    const where = this.buildWhere(update.primaryKeys)
    const stmt: Statement = db.prepare(`UPDATE ${table} SET ${setClause}${where.sql}`)
    stmt.run(
      ...cols.map((c) => this.bind(update.changes[c])),
      ...where.values.map((v) => this.bind(v))
    )
  }

  async insertRows(
    _database: string,
    _schema: string | undefined,
    table: string,
    rows: Record<string, unknown>[]
  ): Promise<number> {
    if (rows.length === 0) return 0
    const db = this.require()
    const target = quoteIdent(this.engine, table)
    const cols = Object.keys(rows[0])
    const colList = cols.map((c) => quoteIdent(this.engine, c)).join(', ')
    const marks = cols.map(() => '?').join(', ')
    const stmt = db.prepare(`INSERT INTO ${target} (${colList}) VALUES (${marks})`)
    const runAll = db.transaction((batch: Record<string, unknown>[]) => {
      let count = 0
      for (const row of batch) {
        stmt.run(...cols.map((c) => this.bind(row[c])))
        count += 1
      }
      return count
    })
    return runAll(rows)
  }

  async insertRow(insert: RowInsert): Promise<void> {
    const db = this.require()
    const table = quoteIdent(this.engine, insert.table)
    const cols = Object.keys(insert.values)
    if (cols.length === 0)
      throw new DbError('INVALID', 'No values to insert', this.engine)
    const colList = cols.map((c) => quoteIdent(this.engine, c)).join(', ')
    const marks = cols.map(() => '?').join(', ')
    db.prepare(`INSERT INTO ${table} (${colList}) VALUES (${marks})`).run(
      ...cols.map((c) => this.bind(insert.values[c]))
    )
  }

  async deleteRow(del: RowDelete): Promise<void> {
    const db = this.require()
    const table = quoteIdent(this.engine, del.table)
    const where = this.buildWhere(del.primaryKeys)
    db.prepare(`DELETE FROM ${table}${where.sql}`).run(
      ...where.values.map((v) => this.bind(v))
    )
  }

  async deleteRows(dels: RowDelete[]): Promise<number> {
    if (dels.length === 0) return 0
    const db = this.require()
    // better-sqlite3 transactions are synchronous and roll back on throw, so
    // one bad row leaves the table untouched.
    const runAll = db.transaction((rows: RowDelete[]) => {
      let deleted = 0
      for (const del of rows) {
        const table = quoteIdent(this.engine, del.table)
        const where = this.buildWhere(del.primaryKeys)
        const info = db
          .prepare(`DELETE FROM ${table}${where.sql}`)
          .run(...where.values.map((v) => this.bind(v)))
        deleted += info.changes
      }
      return deleted
    })
    return runAll(dels)
  }

  private buildWhere(pks: Record<string, unknown>): { sql: string; values: unknown[] } {
    const keys = Object.keys(pks)
    if (keys.length === 0)
      throw new DbError('INVALID', 'Primary key required for this operation', this.engine)
    const sql =
      ' WHERE ' + keys.map((k) => `${quoteIdent(this.engine, k)} = ?`).join(' AND ')
    return { sql, values: keys.map((k) => pks[k]) }
  }

  async applyRowChanges(changes: RowChangeSet): Promise<RowChangeResult> {
    if (
      changes.deletes.length === 0 &&
      changes.updates.length === 0 &&
      changes.inserts.length === 0
    ) {
      return { deleted: 0, updated: 0, inserted: 0 }
    }
    const db = this.require()
    const target = quoteIdent(this.engine, changes.table)

    // better-sqlite3 transactions are synchronous and roll back on throw, so a
    // failure in the insert phase undoes the deletes and updates too.
    const runAll = db.transaction((set: RowChangeSet): RowChangeResult => {
      let deleted = 0
      for (const keys of set.deletes) {
        const where = this.buildWhere(keys)
        const info = db
          .prepare(`DELETE FROM ${target}${where.sql}`)
          .run(...where.values.map((v) => this.bind(v)))
        deleted += info.changes
      }

      let updated = 0
      for (const update of set.updates) {
        const cols = Object.keys(update.changes)
        if (cols.length === 0) continue
        const setClause = cols.map((c) => `${quoteIdent(this.engine, c)} = ?`).join(', ')
        const where = this.buildWhere(update.primaryKeys)
        const info = db
          .prepare(`UPDATE ${target} SET ${setClause}${where.sql}`)
          .run(
            ...cols.map((c) => this.bind(update.changes[c])),
            ...where.values.map((v) => this.bind(v))
          )
        updated += info.changes
      }

      let inserted = 0
      for (const row of set.inserts) {
        const cols = Object.keys(row)
        if (cols.length === 0) continue
        const colList = cols.map((c) => quoteIdent(this.engine, c)).join(', ')
        const marks = cols.map(() => '?').join(', ')
        db.prepare(`INSERT INTO ${target} (${colList}) VALUES (${marks})`).run(
          ...cols.map((c) => this.bind(row[c]))
        )
        inserted += 1
      }

      return { deleted, updated, inserted }
    })

    return runAll(changes)
  }

  // better-sqlite3 runs statements synchronously in this thread, so no other
  // call can arrive while a query is in flight. Cancelling is therefore not
  // possible; the UI disables the button for this engine.
  async cancelQuery(): Promise<boolean> {
    return false
  }

  async runQuery(
    sql: string,
    maxRows: number,
    _context?: { database?: string; schema?: string },
    _onSession?: (sessionId: string) => void
  ): Promise<QueryResultSet[]> {
    const db = this.require()
    const statements = splitStatements(sql)
    if (statements.length === 0)
      throw new DbError('EMPTY', 'No SQL statement to run', this.engine)

    const results: QueryResultSet[] = []
    const runOne = db.transaction((stmts: string[]) => {
      for (const stmt of stmts) {
        const started = Date.now()
        const prepared: Statement = db.prepare(stmt)
        if (prepared.reader) {
          const columns = prepared.columns().map((c) => ({ name: c.name }))
          // iterate() pulls one row at a time and stops at maxRows. all() read
          // the entire result set into memory first, which is what made a
          // SELECT over a large table freeze the app.
          const iterator = prepared.raw(true).iterate() as IterableIterator<unknown[]>
          const rows: Record<string, unknown>[] = []
          let truncated = false
          for (const values of iterator) {
            if (rows.length >= maxRows) {
              truncated = true
              break
            }
            const row: Record<string, unknown> = {}
            columns.forEach((c, idx) => {
              row[c.name] = values[idx]
            })
            rows.push(row)
          }
          // Closing the iterator releases the statement even when it was not
          // exhausted.
          const closable = iterator as { return?: () => void }
          if (typeof closable.return === 'function') closable.return()
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
          const info = prepared.run()
          results.push({
            statement: summarizeStatement(stmt),
            kind: 'command',
            columns: [],
            rows: [],
            rowCount: info.changes,
            truncated: false,
            command: stmt.split(/\s+/)[0].toUpperCase(),
            durationMs: Date.now() - started
          })
        }
      }
    })
    runOne(statements)
    return results
  }

  async explainQuery(
    sql: string,
    _context?: { database?: string; schema?: string },
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
    // SQLite has no ANALYZE option on EXPLAIN; it reports the bytecode plan.
    const rows = this.require().prepare(`EXPLAIN QUERY PLAN ${statement}`).all() as {
      id: number
      parent: number
      notused: number
      detail: string
    }[]
    const raw = rows
      .map((row) => `${'  '.repeat(Math.max(0, row.parent > 0 ? 1 : 0))}${row.detail}`)
      .join('\n')
    if (!raw) {
      throw new DbError(
        'EXPLAIN_EMPTY',
        'SQLite tidak mengembalikan query plan.',
        this.engine
      )
    }
    return { format: 'text' as const, raw }
  }

  async getTableDdl(_database: string, table: string): Promise<string | null> {
    const row = this.require()
      .prepare('SELECT sql FROM sqlite_master WHERE name = ?')
      .get(table) as { sql: string | null } | undefined
    if (!row?.sql) return null
    return row.sql.endsWith(';') ? row.sql : `${row.sql};`
  }

  async listIndexes(_database: string, table: string): Promise<IndexInfo[]> {
    const db = this.require()
    const list = db.prepare(`PRAGMA index_list(${JSON.stringify(table)})`).all() as {
      name: string
      unique: number
      origin: string
    }[]
    return list.map((idx) => {
      const cols = db.prepare(`PRAGMA index_info(${JSON.stringify(idx.name)})`).all() as {
        name: string
      }[]
      return {
        name: idx.name,
        columns: cols.map((c) => c.name),
        unique: idx.unique === 1,
        // origin 'pk' marks the implicit PRIMARY KEY index, which is not
        // dropped like a normal index.
        primary: idx.origin === 'pk'
      }
    })
  }

  async listForeignKeys(_database: string, table: string): Promise<ForeignKeyInfo[]> {
    const db = this.require()
    const rows = db
      .prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`)
      .all() as {
      id: number
      seq: number
      table: string
      from: string
      to: string
      on_update: string
      on_delete: string
    }[]
    const byId = new Map<number, ForeignKeyInfo>()
    for (const r of rows) {
      const name = `fk_${table}_${r.id}`
      const entry = byId.get(r.id) ?? {
        name,
        columns: [],
        refTable: r.table,
        refColumns: [],
        onUpdate: r.on_update,
        onDelete: r.on_delete
      }
      entry.columns.push(r.from)
      entry.refColumns.push(r.to)
      byId.set(r.id, entry)
    }
    return [...byId.values()]
  }

  async getTableInfo(_database: string, table: string): Promise<TableInfoDetail> {
    const db = this.require()
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(this.engine, table)}`)
      .get() as { n: number }
    return { rowCount: count.n }
  }

  async getViewDefinition(_database: string, view: string): Promise<string | null> {
    const row = this.require()
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?`)
      .get(view) as { sql: string | null } | undefined
    return row?.sql ?? null
  }

  async getRoutineDefinition(
    _database: string,
    routine: string,
    kind: RoutineKind
  ): Promise<string | null> {
    // SQLite stores the original CREATE text in sqlite_master, so it is returned
    // verbatim instead of being reconstructed. Only triggers reach this method:
    // views go through getViewDefinition.
    if (kind !== 'trigger') return null
    const row = this.require()
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`)
      .get(routine) as { sql: string | null } | undefined
    return row?.sql ?? null
  }

  async listRoutines(): Promise<RoutineInfo[]> {
    const rows = this.require()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
      .all() as { name: string }[]
    return rows.map((r) => ({ name: r.name, kind: 'trigger' as const }))
  }

  async searchObjects(_database: string, term: string): Promise<SearchResult[]> {
    const db = this.require()
    const like = `%${term}%`
    const out: SearchResult[] = []
    const objs = db
      .prepare(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name LIKE ?
         ORDER BY name LIMIT 200`
      )
      .all(like) as { name: string; type: string }[]
    for (const r of objs) {
      out.push({ kind: r.type === 'view' ? 'view' : 'table', name: r.name })
    }
    const cols = db
      .prepare(
        `SELECT m.name AS tbl, p.name AS name, p.type AS type
         FROM sqlite_master m
         JOIN pragma_table_info(m.name) p
         WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite_%'
           AND p.name LIKE ?
         ORDER BY m.name LIMIT 200`
      )
      .all(like) as { tbl: string; name: string; type: string }[]
    for (const r of cols) {
      out.push({ kind: 'column', name: r.name, table: r.tbl, detail: r.type })
    }
    const triggers = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE ? LIMIT 100`
      )
      .all(like) as { name: string }[]
    for (const r of triggers) {
      out.push({ kind: 'routine', name: r.name, detail: 'TRIGGER' })
    }
    return out
  }

  async listSessions(): Promise<SessionInfo[]> {
    // SQLite is a single-file embedded database with no server sessions.
    return []
  }

  async killSession(): Promise<void> {
    throw new DbError(
      'NOT_SUPPORTED',
      'SQLite tidak punya sesi server untuk dihentikan.',
      this.engine
    )
  }

  async listTableStats(): Promise<TableStat[]> {
    const db = this.require()
    const rows = db
      .prepare(
        `SELECT name, type FROM sqlite_master
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      )
      .all() as { name: string; type: string }[]
    return rows.map((r) => {
      let rowCount: number | null = null
      if (r.type === 'table') {
        try {
          rowCount = (
            db
              .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(this.engine, r.name)}`)
              .get() as { n: number }
          ).n
        } catch {
          rowCount = null
        }
      }
      return {
        name: r.name,
        type: r.type === 'view' ? 'view' : 'table',
        rows: rowCount,
        sizeBytes: null,
        comment: null,
        engine: null,
        modifiedAt: null
      }
    })
  }

  async listUsers(): Promise<DbUser[]> {
    throw new DbError(
      'NOT_SUPPORTED',
      'SQLite tidak punya konsep user atau permission.',
      this.engine
    )
  }

  // SQLite has no session to pin: the adapter holds one handle, and a second
  // write transaction on it would deadlock against the first. The honest answer
  // is a clear refusal instead of a half-working transaction.
  async beginTransaction(): Promise<TransactionInfo> {
    throw new DbError(
      'UNSUPPORTED',
      'SQLite tidak mendukung transaksi manual: satu berkas hanya punya satu penulis, jadi transaksi kedua akan mengunci diri sendiri.',
      this.engine
    )
  }

  async commitTransaction(): Promise<void> {
    throw new DbError(
      'UNSUPPORTED',
      'SQLite tidak mendukung transaksi manual.',
      this.engine
    )
  }

  async rollbackTransaction(): Promise<void> {
    throw new DbError(
      'UNSUPPORTED',
      'SQLite tidak mendukung transaksi manual.',
      this.engine
    )
  }

  async listTransactions(): Promise<TransactionInfo[]> {
    return []
  }
}

export const createSqliteAdapter: (engine: DbEngine) => DatabaseAdapter = () =>
  new SqliteAdapter()
