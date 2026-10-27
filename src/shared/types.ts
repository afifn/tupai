export type DbEngine = 'mysql' | 'mariadb' | 'postgres' | 'oracle' | 'sqlite' | 'mongodb'

// MongoDB is a document store: no SQL editor, DDL, or user management.
export function isDocumentEngine(engine: DbEngine): boolean {
  return engine === 'mongodb'
}

export type SslMode = 'require' | 'verify-ca' | 'verify-full'

// Certificate material is referenced by file path, not copied into the config,
// so a private key never leaves the place the user already keeps it.
export interface SslOptions {
  enabled: boolean
  mode?: SslMode
  caPath?: string
  certPath?: string
  keyPath?: string
  servername?: string
}

export interface SshOptions {
  enabled: boolean
  host: string
  port?: number
  user: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  // When true, only a host already present in ~/.ssh/known_hosts or in the
  // app's stored keys is accepted; a new host is rejected instead of recorded.
  // Default is TOFU, which is what most users expect.
  strictHostKey?: boolean
}

export interface ConnectionConfig {
  id: string
  name: string
  engine: DbEngine
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  // Boolean is the legacy form; an object adds CA/cert/key and verification.
  ssl?: boolean | SslOptions
  ssh?: SshOptions
  file?: string
  // Visual identity: a preset colour key and an optional user-defined group.
  color?: string
  groupId?: string
}

// User-defined grouping for connections. Groups are stored separately from the
// connections so a group can exist before any connection is put in it.
export interface ConnectionGroup {
  id: string
  name: string
  createdAt: number
}

export type ConnectionColor =
  'slate' | 'red' | 'amber' | 'green' | 'teal' | 'blue' | 'violet' | 'pink'

export const CONNECTION_COLORS: ConnectionColor[] = [
  'slate',
  'red',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink'
]

export interface StoredConnection extends Omit<ConnectionConfig, 'password'> {
  hasPassword: boolean
  // SSH secrets are never sent to the renderer, so the form needs an explicit
  // flag to show "leave blank to keep". The empty string used before could not
  // be told apart from "no secret stored".
  hasSshPassword?: boolean
  hasSshPassphrase?: boolean
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error'

export interface ActiveConnection {
  id: string
  status: ConnectionStatus
  message?: string
}

export interface TableInfo {
  name: string
  schema?: string
  type: 'table' | 'view'
}

// Row used by the Navicat-style "Objects" browser: a table list with live
// metadata (rows, size, comment) instead of a plain name list.
export interface TableStat {
  name: string
  schema?: string
  type: 'table' | 'view'
  rows: number | null
  sizeBytes: number | null
  comment: string | null
  engine: string | null
  modifiedAt: string | null
}

export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  autoIncrement?: boolean
  comment?: string | null
}

export type FilterOperator =
  | 'contains'
  | 'equals'
  | 'notEquals'
  | 'startsWith'
  | 'endsWith'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isNull'
  | 'isNotNull'

export interface ColumnFilter {
  column: string
  op: FilterOperator
  value?: string
}

export interface PageQuery {
  connectionId: string
  database: string
  schema?: string
  table: string
  limit: number
  offset: number
  orderBy?: string
  orderDir?: 'asc' | 'desc'
  // Ordered keyset paging for sync: a composite primary key cannot be expressed
  // by the single orderBy column, and paging without a total order can repeat
  // or skip rows between batches.
  orderByColumns?: string[]
  filterColumn?: string
  filterValue?: string
  // Newer multi-condition filter. When present it takes precedence over the
  // single-column filterColumn/filterValue pair.
  filters?: ColumnFilter[]
  filterLogic?: 'and' | 'or'
}

export interface PageResult {
  columns: ColumnInfo[]
  rows: Record<string, unknown>[]
  total: number
  hasPrimaryKey: boolean
  primaryKeys: string[]
}

// A column the database should fill with its own current time. The expression
// is chosen by the driver, so the client clock never decides an audit value.
export interface RowNowColumn {
  name: string
  kind: 'date' | 'datetime' | 'time'
}

export interface RowUpdate {
  connectionId: string
  database: string
  schema?: string
  table: string
  primaryKeys: Record<string, unknown>
  changes: Record<string, unknown>
  // Set to the database's now() instead of a literal value in `changes`.
  nowColumns?: RowNowColumn[]
}

export interface RowInsert {
  connectionId: string
  database: string
  schema?: string
  table: string
  values: Record<string, unknown>
}

export interface RowDelete {
  connectionId: string
  database: string
  schema?: string
  table: string
  primaryKeys: Record<string, unknown>
}

export interface QueryRequest {
  connectionId: string
  sql: string
  maxRows: number
  database?: string
  schema?: string
  // Runs the statement inside an open manual transaction. Without it the
  // statement autocommits, which is what every other panel still does.
  transactionId?: string
}

// How many manual transactions one connection may hold open at once. Each one
// pins a server connection, so an unbounded number would exhaust the pool.
export const MAX_OPEN_TRANSACTIONS = 4

// Manual transaction held open by one query tab. The adapter pins a dedicated
// connection for it: a pooled or shared connection would let another tab's
// statement join the transaction, or the transaction's own statements run on
// different sessions and see nothing.
export interface TransactionBegin {
  connectionId: string
  transactionId: string
  database?: string
  schema?: string
}

export interface TransactionRef {
  connectionId: string
  transactionId: string
}

// One open transaction, as the renderer needs to show it.
export interface TransactionInfo {
  transactionId: string
  connectionId: string
  database?: string
  schema?: string
  startedAt: string
  statements: number
  // A statement failed inside the transaction. PostgreSQL marks the transaction
  // aborted at that point, so only a rollback is possible.
  failed: boolean
}

export interface QueryColumn {
  name: string
}

export interface QueryResultSet {
  statement: string
  kind: 'rows' | 'command'
  columns: QueryColumn[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  command?: string
  durationMs: number
}

export interface QueryResponse {
  results: QueryResultSet[]
  durationMs: number
}

// Query plan. Engines return different shapes, so the adapter normalises to a
// text payload plus a hint about how to present it.
export interface ExplainRequest {
  connectionId: string
  sql: string
  database?: string
  schema?: string
  // Runs the statement (Postgres ANALYZE) instead of only planning it.
  analyze?: boolean
}

export interface ExplainResult {
  engine: DbEngine
  format: 'json' | 'text'
  raw: string
  durationMs: number
}

export interface BackupOptions {
  structure: boolean
  data: boolean
}

export interface BackupEntry {
  id: string
  connectionId: string
  database: string
  engine: DbEngine
  filePath: string
  bytes: number
  tables: number
  rows: number
  structure: boolean
  data: boolean
  createdAt: number
}

// Data Transfer: copy rows from one table to another, possibly across engines.
export interface TransferSource {
  connectionId: string
  database: string
  schema?: string
  table: string
}

export interface TransferTarget extends TransferSource {
  // create the target table from the source columns when it is missing
  createTable?: boolean
  // delete every row in the target before inserting
  truncateFirst?: boolean
}

export interface TransferColumnMapping {
  source: string
  target: string
  // columns left unmapped are skipped; the source column is still readable
  include: boolean
}

export interface TransferRequest {
  // Correlates progress events with the run that produced them.
  transferId: string
  source: TransferSource
  target: TransferTarget
  mapping: TransferColumnMapping[]
  batchSize: number
  // when true nothing is written; the plan is validated and counted only
  dryRun: boolean
}

export interface TransferPreview {
  sourceEngine: DbEngine
  targetEngine: DbEngine
  sourceColumns: ColumnInfo[]
  // null when the target table does not exist yet
  targetColumns: ColumnInfo[] | null
  targetExists: boolean
  // best-effort mapping by identical column name
  suggestedMapping: TransferColumnMapping[]
  rowCount: number
  warnings: string[]
  // target type planned for a table that will be created; empty otherwise
  plannedTypes: Record<string, string>
}

export interface TransferProgress {
  phase: 'preparing' | 'transferring' | 'done'
  rowsRead: number
  rowsWritten: number
  batches: number
  tableCreated: boolean
  truncated: boolean
  totalRows: number | null
}

export interface TransferResult {
  rowsRead: number
  rowsWritten: number
  batches: number
  tableCreated: boolean
  truncated: boolean
  durationMs: number
  dryRun: boolean
  warnings: string[]
}

export interface DdlColumnDef {
  name: string
  dataType: string
  nullable: boolean
  primaryKey: boolean
  autoIncrement?: boolean
  defaultValue?: string
}

export interface PrimaryKeyInfo {
  name: string | null
  columns: string[]
}

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  method?: string
}

export interface ForeignKeyInfo {
  name: string
  columns: string[]
  refSchema?: string
  refTable: string
  refColumns: string[]
  onUpdate?: string
  onDelete?: string
}

export interface TableInfoDetail {
  rowCount?: number | null
  sizeBytes?: number | null
  engine?: string | null
  collation?: string | null
  comment?: string | null
  extra?: { label: string; value: string }[]
}

export type RoutineKind = 'function' | 'procedure' | 'trigger' | 'event'

export interface RoutineInfo {
  name: string
  kind: RoutineKind
  schema?: string
  detail?: string | null
  // Postgres needs the argument types to identify (and drop) an overloaded
  // function, so the signature is carried alongside the name.
  signature?: string | null
}

export type SearchObjectKind = 'table' | 'view' | 'column' | 'routine'

export interface SearchResult {
  kind: SearchObjectKind
  name: string
  schema?: string
  table?: string
  detail?: string | null
}

export interface SessionInfo {
  id: string
  user?: string | null
  database?: string | null
  state?: string | null
  query?: string | null
  client?: string | null
  durationMs?: number | null
  startedAt?: string | null
  isSelf?: boolean
}

// Snapshot of a column as it exists in the database, used to diff an edit so
// engines like Postgres only receive the ALTER COLUMN statements that changed.
export interface ColumnSnapshot {
  dataType: string
  nullable: boolean
  defaultValue: string | null
  autoIncrement?: boolean
}

// One column-level change inside an ALTER TABLE. The renderer computes these
// by diffing the edited grid against the original table.
export type TableAlteration =
  | { type: 'addColumn'; column: DdlColumnDef }
  | { type: 'dropColumn'; name: string }
  | { type: 'renameColumn'; from: string; to: string }
  | { type: 'modifyColumn'; column: DdlColumnDef; previous?: ColumnSnapshot }
  | { type: 'setPrimaryKey'; columns: string[]; constraintName?: string | null }
  | { type: 'dropPrimaryKey'; constraintName?: string | null }
  | {
      type: 'setColumnComment'
      column: string
      comment: string | null
      definition?: DdlColumnDef
    }
  | { type: 'setTableComment'; comment: string | null }

export type DdlOperation =
  | {
      kind: 'createTable'
      database: string
      schema?: string
      table: string
      columns: DdlColumnDef[]
    }
  | {
      kind: 'dropTable'
      database: string
      schema?: string
      table: string
    }
  | {
      kind: 'addColumn'
      database: string
      schema?: string
      table: string
      column: DdlColumnDef
    }
  | {
      kind: 'dropColumn'
      database: string
      schema?: string
      table: string
      column: string
    }
  | {
      kind: 'createIndex'
      database: string
      schema?: string
      table: string
      indexName: string
      columns: string[]
      unique: boolean
    }
  | {
      kind: 'dropIndex'
      database: string
      schema?: string
      table: string
      indexName: string
    }
  | {
      kind: 'createDatabase'
      database: string
    }
  | {
      kind: 'dropDatabase'
      database: string
    }
  | {
      kind: 'createSchema'
      database: string
      schema: string
    }
  | {
      kind: 'dropSchema'
      database: string
      schema: string
    }
  | {
      kind: 'truncateTable'
      database: string
      schema?: string
      table: string
    }
  | {
      kind: 'emptyTable'
      database: string
      schema?: string
      table: string
    }
  | {
      kind: 'renameTable'
      database: string
      schema?: string
      table: string
      newName: string
    }
  | {
      kind: 'alterTable'
      database: string
      schema?: string
      table: string
      alterations: TableAlteration[]
    }
  | {
      kind: 'createForeignKey'
      database: string
      schema?: string
      table: string
      name?: string
      columns: string[]
      refSchema?: string
      refTable: string
      refColumns: string[]
      onUpdate?: string
      onDelete?: string
    }
  | {
      kind: 'dropForeignKey'
      database: string
      schema?: string
      table: string
      name: string
    }
  | {
      kind: 'createView'
      database: string
      schema?: string
      view: string
      selectSql: string
      orReplace?: boolean
    }
  | {
      kind: 'dropView'
      database: string
      schema?: string
      view: string
    }
  | {
      kind: 'dropRoutine'
      database: string
      schema?: string
      routine: string
      routineKind: RoutineKind
      signature?: string | null
      onTable?: string | null
    }

// Sync: compare one database against another and deploy the difference.
// Structure sync plans DDL, data sync compares rows by primary key. Both share
// the endpoint and progress shapes so one panel can drive either mode.
export type SyncMode = 'structure' | 'data'

export interface SyncEndpoint {
  connectionId: string
  database: string
  schema?: string
}

export type SyncSeverity = 'info' | 'warning' | 'destructive' | 'unsupported'

export interface StructureSyncOptions {
  createMissingTables: boolean
  dropExtraTables: boolean
  addMissingColumns: boolean
  alterColumns: boolean
  dropExtraColumns: boolean
  syncIndexes: boolean
  dropExtraIndexes: boolean
  syncForeignKeys: boolean
  dropExtraForeignKeys: boolean
}

export const DEFAULT_STRUCTURE_OPTIONS: StructureSyncOptions = {
  createMissingTables: true,
  dropExtraTables: false,
  addMissingColumns: true,
  alterColumns: false,
  dropExtraColumns: false,
  syncIndexes: true,
  dropExtraIndexes: false,
  syncForeignKeys: false,
  dropExtraForeignKeys: false
}

export interface DataSyncOptions {
  insertMissing: boolean
  updateDifferent: boolean
  deleteExtra: boolean
  batchSize: number
  // A hard cap keeps one table from filling the worker's memory. The preview
  // says when the cap was reached instead of silently comparing a prefix.
  maxRowsPerTable: number
  continueOnError: boolean
}

export const DEFAULT_DATA_OPTIONS: DataSyncOptions = {
  insertMissing: true,
  updateDifferent: true,
  deleteExtra: false,
  batchSize: 500,
  maxRowsPerTable: 100000,
  continueOnError: true
}

// One column-level difference as shown in the preview. `operations` is what the
// deploy step sends through buildDdl; an unsupported change has none.
export interface StructureChange {
  id: string
  table: string
  kind:
    | 'createTable'
    | 'dropTable'
    | 'addColumn'
    | 'dropColumn'
    | 'modifyColumn'
    | 'createIndex'
    | 'dropIndex'
    | 'createForeignKey'
    | 'dropForeignKey'
    | 'primaryKey'
  object: string
  detail: string
  severity: SyncSeverity
  operations: DdlOperation[]
}

export interface StructureTableDiff {
  table: string
  status: 'missing' | 'extra' | 'different' | 'same'
  changeCount: number
}

export interface StructureSyncPreview {
  sourceEngine: DbEngine
  targetEngine: DbEngine
  tables: StructureTableDiff[]
  changes: StructureChange[]
  warnings: string[]
}

export interface StructureSyncRequest {
  syncId: string
  source: SyncEndpoint
  target: SyncEndpoint
  // Source table names to compare. Empty means every table at the source.
  tables: string[]
  options: StructureSyncOptions
  dryRun: boolean
}

export interface StructureSyncResult {
  applied: number
  failed: number
  skipped: number
  statements: number
  durationMs: number
  dryRun: boolean
  warnings: string[]
  errors: string[]
}

export interface DataTableDiff {
  table: string
  status: 'missing' | 'different' | 'same' | 'unsupported'
  inserts: number
  updates: number
  deletes: number
  unchanged: number
  primaryKeys: string[]
  reason?: string
  truncated: boolean
}

export interface DataSyncPreview {
  sourceEngine: DbEngine
  targetEngine: DbEngine
  tables: DataTableDiff[]
  warnings: string[]
}

export interface DataSyncRequest {
  syncId: string
  source: SyncEndpoint
  target: SyncEndpoint
  tables: string[]
  options: DataSyncOptions
  dryRun: boolean
}

export interface DataSyncResult {
  tables: DataTableDiff[]
  inserted: number
  updated: number
  deleted: number
  failed: number
  durationMs: number
  dryRun: boolean
  warnings: string[]
  errors: string[]
}

export interface SyncProgress {
  syncId: string
  mode: SyncMode
  phase: 'preparing' | 'comparing' | 'deploying' | 'done'
  table?: string
  tablesDone: number
  tablesTotal: number
  // Structure sync counts statements; data sync counts rows.
  statements: number
  inserted: number
  updated: number
  deleted: number
}

export interface SyncProfile {
  id: string
  name: string
  mode: SyncMode
  source: SyncEndpoint
  target: SyncEndpoint
  tables: string[]
  structureOptions?: StructureSyncOptions
  dataOptions?: DataSyncOptions
  updatedAt: number
}

export interface SaveSyncProfileInput {
  id?: string
  name: string
  mode: SyncMode
  source: SyncEndpoint
  target: SyncEndpoint
  tables: string[]
  structureOptions?: StructureSyncOptions
  dataOptions?: DataSyncOptions
}

// Snapshot of one table's structure, assembled by the worker from the adapter's
// existing metadata calls. Shared so the pure diff planner can be tested.
export interface TableStructure {
  name: string
  columns: ColumnInfo[]
  primaryKey: PrimaryKeyInfo | null
  indexes: IndexInfo[]
  foreignKeys: ForeignKeyInfo[]
}

// One table's row changes, applied by the adapter inside a single transaction.
export interface RowChangeSet {
  connectionId: string
  database: string
  schema?: string
  table: string
  deletes: Record<string, unknown>[]
  updates: { primaryKeys: Record<string, unknown>; changes: Record<string, unknown> }[]
  inserts: Record<string, unknown>[]
}

export interface RowChangeResult {
  deleted: number
  updated: number
  inserted: number
}

export interface DbUser {
  name: string
  host?: string
  canLogin: boolean
  isSuperuser: boolean
  attributes: string[]
}

export type PrivilegeObjectType = 'database' | 'table' | 'schema'

export interface PrivilegeRequest {
  connectionId: string
  user: string
  host?: string
  privileges: string[]
  onType: PrivilegeObjectType
  database: string
  schema?: string
  table?: string
}

export type UserOperation =
  | {
      kind: 'createUser'
      username: string
      host?: string
      password: string
      canLogin: boolean
      superuser: boolean
    }
  | {
      kind: 'dropUser'
      username: string
      host?: string
    }
  | {
      kind: 'grant'
      user: string
      host?: string
      privileges: string[]
      onType: PrivilegeObjectType
      database: string
      schema?: string
      table?: string
    }
  | {
      kind: 'revoke'
      user: string
      host?: string
      privileges: string[]
      onType: PrivilegeObjectType
      database: string
      schema?: string
      table?: string
    }

export type ExportFormat = 'csv' | 'json' | 'sql'

export interface ResultExportRequest {
  format: 'csv' | 'json'
  columns: string[]
  rows: Record<string, unknown>[]
}

export interface QueryHistoryEntry {
  id: string
  connectionId: string
  database?: string
  schema?: string
  sql: string
  ok: boolean
  error?: string | null
  rowCount?: number | null
  durationMs?: number | null
  createdAt: number
}

export interface ExportRequest {
  connectionId: string
  database: string
  schema?: string
  table: string
  format: ExportFormat
  filePath: string
}

export interface ExportProgress {
  rowsWritten: number
  done: boolean
  filePath: string
}

export interface ImportPreviewRequest {
  filePath: string
  delimiter: string
  hasHeader: boolean
}

export interface ImportPreview {
  headers: string[]
  rows: string[][]
  sampledRows: number
}

export interface CsvImportRequest {
  connectionId: string
  database: string
  schema?: string
  table: string
  filePath: string
  delimiter: string
  hasHeader: boolean
  mapping: Record<string, string | null>
}

export interface ImportResult {
  rowsInserted: number
  failed: number
  firstError?: string
}

export interface SqlImportRequest {
  connectionId: string
  filePath: string
  database?: string
}

export interface DbErrorShape {
  code: string
  message: string
  engine: DbEngine
}

export interface SavedQuery {
  id: string
  connectionId: string
  database: string
  schema?: string
  name: string
  sql: string
  updatedAt: number
}

export interface SaveQueryInput {
  id?: string
  connectionId: string
  database: string
  schema?: string
  name: string
  sql: string
}

export interface IpcResult<T> {
  ok: boolean
  data?: T
  error?: DbErrorShape
}

// OpenAI-compatible assistant settings. The key never reaches the renderer:
// listAiSettings reports hasApiKey instead, the same way connections work.
// Build and runtime identity shown on the About page. Main fills it; the
// renderer only displays it.
export interface AppInfo {
  version: string
  buildSha: string
  buildTime: string
  packaged: boolean
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  userData: string
  logFile: string
}

// Update lifecycle as the renderer sees it. `manual` is true when this build
// cannot replace itself (unsigned macOS), so the panel offers a download link
// instead of an install button.
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  // Version the server offers, once known.
  version?: string
  // 0-100 while downloading.
  percent?: number
  // True when this build can install the update by itself.
  manual: boolean
  // Page to open when `manual` is true.
  downloadUrl?: string
  message?: string
  checkedAt?: string
}

// Commands the native application menu can send to the renderer. Keeping them
// in one union means a new menu item cannot silently do nothing.
export type MenuAction =
  | 'connection.new'
  | 'connection.import'
  | 'connection.export'
  | 'group.new'
  | 'query.new'
  | 'query.import'
  | 'query.history'
  | 'table.browse'
  | 'diagram.open'
  | 'transfer.open'
  | 'sync.open'
  | 'backup.open'
  | 'sessions.open'
  | 'users.open'
  | 'assistant.toggle'
  | 'sidebar.filter'
  | 'settings.open'
  | 'edit.selectAll'
  | 'update.check'
  | 'about.open'
  | 'app.reloadTree'

// Which menu items make sense right now. The renderer owns this knowledge (it
// holds the open tabs and the focused connection), so it reports it to main and
// main greys out the items that would do nothing.
// Native window facts the renderer needs to lay out its own title bar row.
export interface WindowState {
  fullscreen: boolean
  // The OS draws caption buttons inside the toolbar (Windows 11, Linux). The
  // renderer reserves room for them and keeps the overlay colours in sync.
  titleBarOverlay: boolean
}

// Sent when the database worker thread dies. Every adapter lives in that thread,
// so all open connections are gone; the renderer must stop showing them as
// connected instead of failing later with a misleading "not connected".
export interface WorkerLostEvent {
  reason: { code: string; message: string; engine: string }
  // The operation that was running when the thread died, with its duration.
  // Without it a crash report only has an exit code, which identifies nothing.
  lastOp: string | null
}

export interface MenuState {
  // A connection is focused, so connection-scoped tools have a target.
  hasConnection: boolean
  // The focused connection speaks SQL; MongoDB has no diagram, sync, or backup.
  sqlEngine: boolean
  supportsUsers: boolean
  supportsSessions: boolean
}

export interface AiSettings {
  baseUrl: string
  model: string
  // Ids cached by the last successful fetch, so the picker works offline.
  models: string[]
  temperature: number
  maxTokens: number
  systemPrompt: string
  // Runs the SELECT from an answer and shows a few rows under it.
  previewRows: boolean
  hasApiKey: boolean
}

export interface AiSettingsInput {
  baseUrl: string
  apiKey?: string
  model?: string
  temperature?: number
  maxTokens?: number
  systemPrompt?: string
  previewRows?: boolean
}

export interface AiModel {
  id: string
  ownedBy?: string
  created?: number
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiChatRequest {
  messages: AiChatMessage[]
  // Optional database context so the assistant can answer with real names.
  schemaContext?: string
}

// Streamed assistant output. The renderer receives these while the model is
// still answering, so the panel can show progress instead of a spinner.
export interface AiStreamEvent {
  requestId: string
  type: 'delta' | 'done' | 'error'
  // Text appended for 'delta'; the full message for 'error'.
  text?: string
  model?: string
}

export interface AiChatReply {
  content: string
  model: string
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}
