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
  TableInfo,
  TableInfoDetail,
  RoutineInfo,
  RoutineKind,
  SearchResult,
  SessionInfo,
  TransactionBegin,
  TransactionInfo,
  TransactionRef
} from '@shared/types'
import { quoteIdent } from '@shared/ddl'

export class DbError extends Error {
  readonly code: string
  readonly engine: DbEngine

  constructor(code: string, message: string, engine: DbEngine) {
    super(message)
    this.name = 'DbError'
    this.code = code
    this.engine = engine
  }

  toShape(): { code: string; message: string; engine: DbEngine } {
    return { code: this.code, message: this.message, engine: this.engine }
  }
}

export interface DatabaseAdapter {
  readonly engine: DbEngine
  testConnection(cfg: ConnectionConfig): Promise<boolean>
  connect(cfg: ConnectionConfig): Promise<void>
  disconnect(): Promise<void>
  listDatabases(): Promise<string[]>
  listSchemas(database?: string): Promise<string[]>
  listTables(database: string, schema?: string): Promise<TableInfo[]>
  listTableStats(
    database: string,
    schema?: string
  ): Promise<import('@shared/types').TableStat[]>
  listColumns(database: string, table: string, schema?: string): Promise<ColumnInfo[]>
  selectRows(query: PageQuery): Promise<{
    rows: Record<string, unknown>[]
    total: number
  }>
  fetchBatch(query: PageQuery): Promise<Record<string, unknown>[]>
  updateRow(update: RowUpdate): Promise<void>
  insertRow(insert: RowInsert): Promise<void>
  insertRows(
    database: string,
    schema: string | undefined,
    table: string,
    rows: Record<string, unknown>[]
  ): Promise<number>
  deleteRow(del: RowDelete): Promise<void>
  // Deletes several rows in one transaction. The grid used to call deleteRow
  // once per selected row, so a failure halfway through left the table with
  // some rows removed and no way to tell which.
  deleteRows(dels: RowDelete[]): Promise<number>
  // Applies a delete/update/insert set for one table inside a single
  // transaction. Sync needs the three phases ordered and all-or-nothing; calling
  // deleteRows/updateRow/insertRows separately gave three independent
  // transactions and no way to report partial progress.
  applyRowChanges(changes: RowChangeSet): Promise<RowChangeResult>
  runQuery(
    sql: string,
    maxRows: number,
    context?: QueryContext,
    // Receives the engine's own backend identifier once the statement starts,
    // so a cancel request can target this exact session instead of guessing.
    onSession?: (sessionId: string) => void
  ): Promise<QueryResultSet[]>
  // Cancels the statement currently running on this adapter, without closing
  // the connection. Returns false when nothing is running.
  cancelQuery(): Promise<boolean>
  explainQuery(
    sql: string,
    context?: QueryContext,
    analyze?: boolean
  ): Promise<{ format: 'json' | 'text'; raw: string }>
  getTableDdl(database: string, table: string, schema?: string): Promise<string | null>
  getPrimaryKey(
    database: string,
    table: string,
    schema?: string
  ): Promise<PrimaryKeyInfo | null>
  listIndexes(database: string, table: string, schema?: string): Promise<IndexInfo[]>
  listForeignKeys(
    database: string,
    table: string,
    schema?: string
  ): Promise<ForeignKeyInfo[]>
  getTableInfo(database: string, table: string, schema?: string): Promise<TableInfoDetail>
  getViewDefinition(
    database: string,
    view: string,
    schema?: string
  ): Promise<string | null>
  listRoutines(database: string, schema?: string): Promise<RoutineInfo[]>
  // CREATE statement for a stored function, procedure, or trigger. Null when the
  // server does not expose the body (some hosted engines restrict it).
  getRoutineDefinition(
    database: string,
    routine: string,
    kind: RoutineKind,
    schema?: string,
    signature?: string | null
  ): Promise<string | null>
  searchObjects(database: string, term: string, schema?: string): Promise<SearchResult[]>
  listSessions(database?: string): Promise<SessionInfo[]>
  killSession(sessionId: string): Promise<void>
  listUsers(): Promise<DbUser[]>
  // Manual transaction. The adapter pins a dedicated connection for the id and
  // keeps it until commit or rollback, so statements sent with the same id share
  // one session and see their own uncommitted writes. Engines without
  // transactions (SQLite's single handle, MongoDB without a replica set) throw
  // DbError('UNSUPPORTED') with a reason the UI shows.
  beginTransaction(begin: TransactionBegin): Promise<TransactionInfo>
  commitTransaction(ref: TransactionRef): Promise<void>
  rollbackTransaction(ref: TransactionRef): Promise<void>
  // Open transactions on this adapter, for the shell to warn about before a
  // disconnect and for tests to assert cleanup.
  listTransactions(): Promise<TransactionInfo[]>
}

export interface QueryContext {
  database?: string
  schema?: string
  // When set, the statement runs on the connection pinned by beginTransaction.
  transactionId?: string
}

export type AdapterFactory = (engine: DbEngine) => DatabaseAdapter

export { quoteIdent, qualifiedTable, buildDdl, engineColumnTypes } from '@shared/ddl'
// The splitter lives in src/shared so the renderer can preview the same
// statements the drivers will run.
export { splitStatements } from '@shared/sqlBoundary'

// Read a batch ordered by an explicit column list. `orderByColumns` exists for
// sync, where a composite primary key must be the paging order; a single
// orderBy column leaves ties and rows can repeat or vanish across batches.
export function orderClause(
  engine: DbEngine,
  orderBy: string | undefined,
  orderDir: 'asc' | 'desc' | undefined,
  orderByColumns: string[] | undefined
): string {
  if (orderByColumns && orderByColumns.length > 0) {
    return ` ORDER BY ${orderByColumns.map((c) => quoteIdent(engine, c)).join(', ')}`
  }
  if (!orderBy) return ''
  const dir = orderDir === 'desc' ? 'DESC' : 'ASC'
  return ` ORDER BY ${quoteIdent(engine, orderBy)} ${dir}`
}



export function summarizeStatement(sql: string): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  return oneLine.length > 120 ? oneLine.slice(0, 117) + '...' : oneLine
}
