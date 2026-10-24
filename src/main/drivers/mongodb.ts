import { ObjectId } from 'mongodb'
import type { Db, MongoClient } from 'mongodb'
import type {
  ColumnFilter,
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
  RowDelete,
  RowInsert,
  RowUpdate,
  RoutineInfo,
  SearchResult,
  SessionInfo,
  TableInfo,
  TableInfoDetail,
  TableStat
} from '@shared/types'
import { DbError, type DatabaseAdapter } from './types'
import { resolveSsl, sslEnabled } from '../connection/ssl'
import { sshEnabled } from '../connection/sshTunnel'

class MongoAdapter implements DatabaseAdapter {
  readonly engine: DbEngine = 'mongodb'
  private client: MongoClient | null = null

  private uri(cfg: ConnectionConfig): string {
    const user = cfg.user ? encodeURIComponent(cfg.user) : ''
    const pass = cfg.password ? encodeURIComponent(cfg.password) : ''
    const auth = user ? `${user}:${pass}@` : ''
    const host = cfg.host ?? 'localhost'
    const port = cfg.port ?? 27017
    const params = sslEnabled(cfg.ssl) ? '?tls=true' : ''
    return `mongodb://${auth}${host}:${port}/${params}`
  }

  private async clientOptions(cfg: ConnectionConfig): Promise<{
    serverSelectionTimeoutMS: number
    tls?: boolean
    tlsCAFile?: string
    tlsCertificateKeyFile?: string
    tlsAllowInvalidCertificates?: boolean
  }> {
    const ssl = await resolveSsl(cfg.ssl)
    if (!ssl) return { serverSelectionTimeoutMS: 8000 }
    // The driver takes file paths rather than buffers for TLS material.
    const opts: {
      serverSelectionTimeoutMS: number
      tls: boolean
      tlsCAFile?: string
      tlsCertificateKeyFile?: string
      tlsAllowInvalidCertificates?: boolean
    } = {
      serverSelectionTimeoutMS: 8000,
      tls: true,
      tlsAllowInvalidCertificates: ssl.mode === 'require'
    }
    if (cfg.ssl && typeof cfg.ssl === 'object') {
      if (cfg.ssl.caPath) opts.tlsCAFile = cfg.ssl.caPath
      if (cfg.ssl.certPath || cfg.ssl.keyPath) {
        opts.tlsCertificateKeyFile = cfg.ssl.keyPath ?? cfg.ssl.certPath
      }
    }
    return opts
  }

  async testConnection(cfg: ConnectionConfig): Promise<boolean> {
    const { MongoClient: Client } = await import('mongodb')
    const client = new Client(this.uri(cfg), await this.clientOptions(cfg))
    await client.connect()
    await client.db('admin').command({ ping: 1 })
    await client.close()
    return true
  }

  async connect(cfg: ConnectionConfig): Promise<void> {
    if (sshEnabled(cfg.ssh)) {
      throw new DbError(
        'SSH_NOT_SUPPORTED',
        'SSH tunnel belum didukung untuk MongoDB. Nonaktifkan SSH di form koneksi.',
        this.engine
      )
    }
    const { MongoClient: Client } = await import('mongodb')
    this.client = new Client(this.uri(cfg), await this.clientOptions(cfg))
    await this.client.connect()
  }

  async disconnect(): Promise<void> {
    await this.client?.close()
    this.client = null
  }

  private require(): MongoClient {
    if (!this.client) throw new DbError('NOT_CONNECTED', 'Not connected', this.engine)
    return this.client
  }

  private db(name: string): Db {
    return this.require().db(name)
  }

  async listDatabases(): Promise<string[]> {
    const admin = this.require().db('admin')
    const res = await admin.admin().listDatabases()
    return res.databases.map((d) => d.name)
  }

  async listSchemas(): Promise<string[]> {
    return []
  }

  async listTables(database: string): Promise<TableInfo[]> {
    const collections = await this.db(database).listCollections().toArray()
    return collections
      .map((c) => ({ name: c.name, type: 'table' as const }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async listColumns(database: string, table: string): Promise<ColumnInfo[]> {
    // Document stores are schemaless; infer fields from a document sample.
    const sample = await this.db(database).collection(table).find({}).limit(50).toArray()
    const fields = new Map<string, string>()
    for (const doc of sample) {
      for (const [key, value] of Object.entries(doc)) {
        if (!fields.has(key)) fields.set(key, mongoTypeOf(value))
      }
    }
    if (!fields.has('_id')) fields.set('_id', 'ObjectId')
    const columns: ColumnInfo[] = [...fields.entries()].map(([name, dataType]) => ({
      name,
      dataType,
      nullable: name !== '_id',
      defaultValue: null,
      isPrimaryKey: name === '_id'
    }))
    columns.sort((a, b) =>
      a.name === '_id' ? -1 : b.name === '_id' ? 1 : a.name.localeCompare(b.name)
    )
    return columns
  }

  async selectRows(query: PageQuery): Promise<{
    rows: Record<string, unknown>[]
    total: number
  }> {
    const coll = this.db(query.database).collection(query.table)
    const filter = this.buildFilter(query)
    const total = await coll.countDocuments(filter)
    let cursor = coll.find(filter).skip(query.offset).limit(query.limit)
    if (query.orderBy) {
      cursor = cursor.sort({ [query.orderBy]: query.orderDir === 'desc' ? -1 : 1 })
    }
    const docs = await cursor.toArray()
    return { rows: docs.map(serializeDoc), total }
  }

  async fetchBatch(query: PageQuery): Promise<Record<string, unknown>[]> {
    const coll = this.db(query.database).collection(query.table)
    let cursor = coll.find({}).skip(query.offset).limit(query.limit)
    if (query.orderBy) {
      cursor = cursor.sort({ [query.orderBy]: query.orderDir === 'desc' ? -1 : 1 })
    }
    const docs = await cursor.toArray()
    return docs.map(serializeDoc)
  }

  private buildFilter(query: PageQuery): Record<string, unknown> {
    // The advanced filter used by the data grid is the newer mechanism and
    // takes precedence, matching every SQL driver. It used to be ignored here,
    // so the grid showed "filter active" while returning the unfiltered rows.
    if (query.filters && query.filters.length > 0) {
      const clauses = query.filters
        .map((filter) => mongoClause(filter.column, filter.op, filter.value ?? ''))
        .filter((clause): clause is Record<string, unknown> => clause !== null)
      if (clauses.length === 0) return {}
      return clauses.length === 1
        ? clauses[0]
        : { [query.filterLogic === 'or' ? '$or' : '$and']: clauses }
    }
    if (query.filterColumn && query.filterValue) {
      return {
        [query.filterColumn]: { $regex: escapeRegex(query.filterValue), $options: 'i' }
      }
    }
    return {}
  }

  async updateRow(update: RowUpdate): Promise<void> {
    const coll = this.db(update.database).collection(update.table)
    const { _id, ...changes } = update.changes
    void _id
    // MongoDB has no SQL, so the server clock is a Date sent as the value.
    for (const col of update.nowColumns ?? []) changes[col.name] = new Date()
    await coll.updateOne({ _id: toObjectId(update.primaryKeys._id) } as never, {
      $set: changes
    })
  }

  async insertRow(insert: RowInsert): Promise<void> {
    const coll = this.db(insert.database).collection(insert.table)
    const values = withExplicitId(insert.values)
    await coll.insertOne(values)
  }

  async insertRows(
    database: string,
    _schema: string | undefined,
    table: string,
    rows: Record<string, unknown>[]
  ): Promise<number> {
    if (rows.length === 0) return 0
    const coll = this.db(database).collection(table)
    // Keep an explicitly provided _id: a data transfer between collections is
    // expected to preserve document identity. Previously every _id was dropped
    // and Mongo generated new ones, silently breaking references.
    const docs = rows.map((row) => withExplicitId(row))
    const res = await coll.insertMany(docs)
    return res.insertedCount
  }

  async deleteRow(del: RowDelete): Promise<void> {
    const coll = this.db(del.database).collection(del.table)
    await coll.deleteOne({ _id: toObjectId(del.primaryKeys._id) } as never)
  }

  async deleteRows(dels: RowDelete[]): Promise<number> {
    if (dels.length === 0) return 0
    // A single deleteMany with $in is atomic per document on the server and
    // avoids one round trip per selected row.
    const ids = dels.map((del) => toObjectId(del.primaryKeys._id))
    const coll = this.db(dels[0].database).collection(dels[0].table)
    const res = await coll.deleteMany({ _id: { $in: ids } } as never)
    return res.deletedCount ?? 0
  }

  // Sync is a relational feature: it compares declared columns and a primary
  // key. Documents are schemaless, so a row-level merge has no key to compare.
  async applyRowChanges(): Promise<RowChangeResult> {
    throw new DbError(
      'NOT_SUPPORTED',
      'Sinkronisasi data tidak didukung untuk MongoDB. Gunakan Data Transfer untuk memindahkan dokumen.',
      this.engine
    )
  }

  // The Data tab does not run long server-side queries, and the SQL editor is
  // disabled for this engine, so there is nothing to cancel.
  async cancelQuery(): Promise<boolean> {
    return false
  }

  async runQuery(
    _sql?: string,
    _maxRows?: number,
    _context?: { database?: string; schema?: string },
    _onSession?: (sessionId: string) => void
  ): Promise<QueryResultSet[]> {
    throw new DbError(
      'NOT_SUPPORTED',
      'MongoDB tidak mendukung query SQL. Gunakan tab Data untuk menelusuri dokumen.',
      this.engine
    )
  }

  async explainQuery(): Promise<{ format: 'json' | 'text'; raw: string }> {
    throw new DbError(
      'NOT_SUPPORTED',
      'MongoDB tidak mendukung EXPLAIN SQL. Gunakan tab Data untuk menelusuri dokumen.',
      this.engine
    )
  }

  async getTableDdl(): Promise<string | null> {
    throw new DbError('NOT_SUPPORTED', 'MongoDB tidak mendukung DDL SQL.', this.engine)
  }

  async getPrimaryKey(): Promise<PrimaryKeyInfo | null> {
    return null
  }

  async listIndexes(): Promise<IndexInfo[]> {
    return []
  }

  async listForeignKeys(): Promise<ForeignKeyInfo[]> {
    return []
  }

  async getTableInfo(): Promise<TableInfoDetail> {
    return {}
  }

  async getViewDefinition(): Promise<string | null> {
    return null
  }

  async listRoutines(): Promise<RoutineInfo[]> {
    return []
  }

  async getRoutineDefinition(): Promise<string | null> {
    // MongoDB has no stored routines.
    return null
  }

  async listTableStats(database: string): Promise<TableStat[]> {
    const collections = await this.db(database)
      .listCollections({}, { nameOnly: true })
      .toArray()
    const out: TableStat[] = []
    for (const c of collections) {
      let rows: number | null = null
      let sizeBytes: number | null = null
      try {
        const stats = await this.db(database).command({ collStats: c.name })
        rows = typeof stats.count === 'number' ? stats.count : null
        sizeBytes = typeof stats.size === 'number' ? stats.size : null
      } catch {
        // Stats may be unavailable on some deployments; the row still shows.
      }
      out.push({
        name: c.name,
        type: 'table',
        rows,
        sizeBytes,
        comment: null,
        engine: null,
        modifiedAt: null
      })
    }
    return out
  }

  async searchObjects(database: string, term: string): Promise<SearchResult[]> {
    const res = await this.db(database).listCollections({}, { nameOnly: true }).toArray()
    const lower = term.toLowerCase()
    return res
      .filter((c) => c.name.toLowerCase().includes(lower))
      .map((c) => ({ kind: 'table' as const, name: c.name }))
  }

  async listSessions(): Promise<SessionInfo[]> {
    const admin = this.db('admin')
    const res = await admin.command({ currentOp: 1, active: true })
    const ops = (res.inprog ?? []) as Record<string, unknown>[]
    return ops.map((op) => {
      const opid = op.opid as { id?: unknown; shard?: string } | number | undefined
      const id =
        typeof opid === 'object' && opid !== null && 'id' in opid
          ? String(opid.id)
          : String(opid ?? '')
      const secs = typeof op.secs_running === 'number' ? op.secs_running : null
      return {
        id,
        user: (op.effectiveUsers as string[] | undefined)?.[0] ?? null,
        database: (op.ns as string | undefined)?.split('.')[0] ?? null,
        state: (op.type as string) ?? (op.op as string) ?? null,
        query: op.command ? JSON.stringify(op.command) : null,
        client: (op.client as string) ?? null,
        durationMs: secs === null ? null : secs * 1000
      }
    })
  }

  async killSession(sessionId: string): Promise<void> {
    const opid = Number(sessionId)
    if (!Number.isInteger(opid) || opid <= 0) {
      throw new DbError(
        'INVALID_SESSION',
        `ID operasi tidak valid: ${sessionId}`,
        this.engine
      )
    }
    const res = await this.db('admin').command({ killOp: 1, op: opid })
    if (res.ok !== 1) {
      throw new DbError('KILL_FAILED', `Gagal menghentikan operasi ${opid}.`, this.engine)
    }
  }

  async listUsers(): Promise<DbUser[]> {
    const res = await this.db('admin').command({ usersInfo: 1 })
    const users = (res.users ?? []) as { user: string; roles?: unknown[] }[]
    return users.map((u) => ({
      name: u.user,
      canLogin: true,
      isSuperuser:
        Array.isArray(u.roles) && u.roles.some((r) => JSON.stringify(r).includes('root')),
      attributes: []
    }))
  }
}

function mongoTypeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value instanceof Date) return 'date'
  switch (typeof value) {
    case 'number':
      return Number.isInteger(value) ? 'int' : 'double'
    case 'boolean':
      return 'bool'
    case 'object':
      return value?.constructor?.name === 'ObjectId' ? 'ObjectId' : 'object'
    default:
      return 'string'
  }
}

function serializeDoc(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(doc)) {
    if (value && typeof value === 'object' && value.constructor?.name === 'ObjectId') {
      out[key] = value.toString()
    } else if (value instanceof Date) {
      out[key] = value.toISOString()
    } else if (value && typeof value === 'object') {
      out[key] = JSON.stringify(value)
    } else {
      out[key] = value
    }
  }
  return out
}

function toObjectId(value: unknown): unknown {
  if (value === undefined || value === null) return value
  const str = String(value)
  if (/^[0-9a-fA-F]{24}$/.test(str)) {
    return new ObjectId(str)
  }
  return value
}

// Copies the row and restores an explicit _id as an ObjectId when it looks like
// one. Mongo rejects a string _id when the collection already stores ObjectIds.
function withExplicitId(row: Record<string, unknown>): Record<string, unknown> {
  const { _id, ...rest } = row
  if (_id === undefined || _id === null || _id === '') return rest
  return { _id: toObjectId(_id), ...rest }
}

// One grid filter condition as a Mongo query fragment. Operators mirror the
// SQL filter semantics: text comparison is case-insensitive, and NULL means a
// missing field.
function mongoClause(
  column: string,
  op: ColumnFilter['op'],
  value: string
): Record<string, unknown> | null {
  switch (op) {
    case 'isNull':
      return { [column]: { $in: [null] } }
    case 'isNotNull':
      return { [column]: { $nin: [null] } }
    case 'contains':
      return { [column]: { $regex: escapeRegex(value), $options: 'i' } }
    case 'startsWith':
      return { [column]: { $regex: `^${escapeRegex(value)}`, $options: 'i' } }
    case 'endsWith':
      return { [column]: { $regex: `${escapeRegex(value)}$`, $options: 'i' } }
    case 'equals':
      return { [column]: value }
    case 'notEquals':
      return { [column]: { $ne: value } }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const numeric = Number(value)
      // Values typed in the grid arrive as strings. Comparing them with $gt
      // would compare strings, so use a number when the input is numeric.
      const operand = value.trim() !== '' && Number.isFinite(numeric) ? numeric : value
      const operator =
        op === 'gt' ? '$gt' : op === 'gte' ? '$gte' : op === 'lt' ? '$lt' : '$lte'
      return { [column]: { [operator]: operand } }
    }
    default:
      return null
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const createMongoAdapter: (engine: DbEngine) => DatabaseAdapter = () =>
  new MongoAdapter()
