import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { IPC } from '@shared/ipc-contract'
import type {
  AiChatReply,
  AiChatRequest,
  AiModel,
  AiSettings,
  AiStreamEvent,
  MenuAction,
  MenuState,
  TransactionBegin,
  TransactionInfo,
  TransactionRef,
  UpdateState,
  WindowState,
  WorkerLostEvent,
  AiSettingsInput,
  BackupEntry,
  BackupOptions,
  ColumnInfo,
  ConnectionConfig,
  ConnectionGroup,
  CsvImportRequest,
  DataSyncPreview,
  DataSyncRequest,
  DataSyncResult,
  DbUser,
  DdlOperation,
  ExplainRequest,
  ExplainResult,
  ExportRequest,
  ForeignKeyInfo,
  ImportPreview,
  ImportResult,
  IndexInfo,
  IpcResult,
  PageQuery,
  PageResult,
  PrimaryKeyInfo,
  QueryRequest,
  QueryResultSet,
  QueryHistoryEntry,
  ResultExportRequest,
  RowDelete,
  RowInsert,
  RowUpdate,
  RoutineInfo,
  RoutineKind,
  SaveQueryInput,
  SaveSyncProfileInput,
  SavedQuery,
  SearchResult,
  SessionInfo,
  SqlImportRequest,
  StoredConnection,
  StructureSyncPreview,
  StructureSyncRequest,
  StructureSyncResult,
  SyncProfile,
  SyncProgress,
  TableInfo,
  TableInfoDetail,
  TableStat,
  TransferPreview,
  TransferProgress,
  TransferRequest,
  TransferResult,
  TransferSource,
  TransferTarget,
  UserOperation
} from '@shared/types'
import type { NcxImportItem } from '@shared/navicatNcx'
import type { AppSettings } from '@shared/settings'
import type { AppInfo } from '@shared/types'

const dbApi = {
  // The renderer needs the host platform to label shortcuts correctly (Cmd on
  // macOS, Ctrl elsewhere). process.platform is readable in a sandboxed
  // preload; the full process object is not exposed.
  platform: process.platform,
  // True when the window has no native title bar, so the renderer adds the
  // traffic-light inset itself.
  usesCustomTitleBar: process.platform === 'darwin',
  setTitleBarColors(
    color: string,
    symbolColor: string,
    height: number
  ): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.titleBarColors, { color, symbolColor, height })
  },
  getWindowState(): Promise<IpcResult<WindowState>> {
    return ipcRenderer.invoke(IPC.windowState)
  },
  onWindowState(listener: (state: WindowState) => void): () => void {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: WindowState): void =>
      listener(payload)
    ipcRenderer.on(IPC.windowStateEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC.windowStateEvent, wrapped)
  },
  // Fires when the worker thread dies. Every open connection died with it.
  onWorkerLost(listener: (event: WorkerLostEvent) => void): () => void {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: WorkerLostEvent): void =>
      listener(payload)
    ipcRenderer.on(IPC.workerLostEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC.workerLostEvent, wrapped)
  },
  // Diagnostic only; the main process refuses unless TUPAI_DEBUG_CRASH=1.
  debugCrashWorker(): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.debugCrashWorker)
  },
  ping(message: string): Promise<IpcResult<{ echo: string }>> {
    return ipcRenderer.invoke(IPC.ping, { message })
  },
  listConnections(): Promise<IpcResult<StoredConnection[]>> {
    return ipcRenderer.invoke(IPC.listConnections)
  },
  saveConnection(cfg: ConnectionConfig): Promise<IpcResult<StoredConnection>> {
    return ipcRenderer.invoke(IPC.saveConnection, cfg)
  },
  deleteConnection(connectionId: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.deleteConnection, { connectionId })
  },
  previewNcxImport(
    filePath: string
  ): Promise<IpcResult<{ items: NcxImportItem[]; invalid: boolean }>> {
    return ipcRenderer.invoke(IPC.previewNcxImport, { filePath })
  },
  applyNcxImport(
    filePath: string,
    keys: string[]
  ): Promise<IpcResult<{ imported: string[]; skipped: string[] }>> {
    return ipcRenderer.invoke(IPC.applyNcxImport, { filePath, keys })
  },
  exportNcx(
    connectionIds: string[]
  ): Promise<IpcResult<{ path: string; count: number } | null>> {
    return ipcRenderer.invoke(IPC.exportNcx, { connectionIds })
  },
  listConnectionGroups(): Promise<IpcResult<ConnectionGroup[]>> {
    return ipcRenderer.invoke(IPC.listConnectionGroups)
  },
  saveConnectionGroup(input: {
    id?: string
    name: string
  }): Promise<IpcResult<ConnectionGroup>> {
    return ipcRenderer.invoke(IPC.saveConnectionGroup, input)
  },
  deleteConnectionGroup(id: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.deleteConnectionGroup, { id })
  },
  setConnectionGroup(
    connectionId: string,
    groupId: string | null
  ): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.setConnectionGroup, { connectionId, groupId })
  },
  testConnection(cfg: ConnectionConfig): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.testConnection, cfg)
  },
  connect(connectionId: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.connect, { connectionId })
  },
  disconnect(connectionId: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.disconnect, { connectionId })
  },
  listDatabases(connectionId: string): Promise<IpcResult<string[]>> {
    return ipcRenderer.invoke(IPC.listDatabases, { connectionId })
  },
  listSchemas(connectionId: string, database?: string): Promise<IpcResult<string[]>> {
    return ipcRenderer.invoke(IPC.listSchemas, { connectionId, database })
  },
  listTables(
    connectionId: string,
    database: string,
    schema?: string
  ): Promise<IpcResult<TableInfo[]>> {
    return ipcRenderer.invoke(IPC.listTables, { connectionId, database, schema })
  },
  listTableStats(
    connectionId: string,
    database: string,
    schema?: string
  ): Promise<IpcResult<TableStat[]>> {
    return ipcRenderer.invoke(IPC.listTableStats, { connectionId, database, schema })
  },
  listColumns(
    connectionId: string,
    database: string,
    table: string,
    schema?: string
  ): Promise<IpcResult<ColumnInfo[]>> {
    return ipcRenderer.invoke(IPC.listColumns, { connectionId, database, table, schema })
  },
  getPrimaryKey(
    connectionId: string,
    database: string,
    table: string,
    schema?: string
  ): Promise<IpcResult<PrimaryKeyInfo | null>> {
    return ipcRenderer.invoke(IPC.getPrimaryKey, {
      connectionId,
      database,
      table,
      schema
    })
  },
  listIndexes(
    connectionId: string,
    database: string,
    table: string,
    schema?: string
  ): Promise<IpcResult<IndexInfo[]>> {
    return ipcRenderer.invoke(IPC.listIndexes, { connectionId, database, table, schema })
  },
  listForeignKeys(
    connectionId: string,
    database: string,
    table: string,
    schema?: string
  ): Promise<IpcResult<ForeignKeyInfo[]>> {
    return ipcRenderer.invoke(IPC.listForeignKeys, {
      connectionId,
      database,
      table,
      schema
    })
  },
  getTableInfo(
    connectionId: string,
    database: string,
    table: string,
    schema?: string
  ): Promise<IpcResult<TableInfoDetail>> {
    return ipcRenderer.invoke(IPC.getTableInfo, { connectionId, database, table, schema })
  },
  getObjectDdl(
    connectionId: string,
    database: string,
    table: string,
    schema?: string
  ): Promise<IpcResult<string | null>> {
    return ipcRenderer.invoke(IPC.getObjectDdl, { connectionId, database, table, schema })
  },
  getViewDefinition(
    connectionId: string,
    database: string,
    view: string,
    schema?: string
  ): Promise<IpcResult<string | null>> {
    return ipcRenderer.invoke(IPC.getViewDefinition, {
      connectionId,
      database,
      table: view,
      schema
    })
  },
  listRoutines(
    connectionId: string,
    database: string,
    schema?: string
  ): Promise<IpcResult<RoutineInfo[]>> {
    return ipcRenderer.invoke(IPC.listRoutines, { connectionId, database, schema })
  },
  getRoutineDefinition(
    connectionId: string,
    database: string,
    routine: string,
    kind: RoutineKind,
    schema?: string,
    signature?: string | null
  ): Promise<IpcResult<string | null>> {
    return ipcRenderer.invoke(IPC.getRoutineDefinition, {
      connectionId,
      database,
      routine,
      kind,
      schema,
      signature
    })
  },
  searchObjects(
    connectionId: string,
    database: string,
    term: string,
    schema?: string
  ): Promise<IpcResult<SearchResult[]>> {
    return ipcRenderer.invoke(IPC.searchObjects, { connectionId, database, term, schema })
  },
  listSessions(
    connectionId: string,
    database?: string
  ): Promise<IpcResult<SessionInfo[]>> {
    return ipcRenderer.invoke(IPC.listSessions, { connectionId, database })
  },
  killSession(connectionId: string, sessionId: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.killSession, { connectionId, sessionId })
  },
  selectRows(query: PageQuery): Promise<IpcResult<PageResult>> {
    return ipcRenderer.invoke(IPC.selectRows, query)
  },
  updateRow(update: RowUpdate): Promise<IpcResult<void>> {
    return ipcRenderer.invoke(IPC.updateRow, update)
  },
  insertRow(insert: RowInsert): Promise<IpcResult<void>> {
    return ipcRenderer.invoke(IPC.insertRow, insert)
  },
  deleteRow(del: RowDelete): Promise<IpcResult<void>> {
    return ipcRenderer.invoke(IPC.deleteRow, del)
  },
  // One transaction for every selected row. Returns how many rows were removed.
  deleteRows(
    connectionId: string,
    database: string,
    table: string,
    rows: Record<string, unknown>[],
    schema?: string
  ): Promise<IpcResult<number>> {
    return ipcRenderer.invoke(IPC.deleteRows, {
      connectionId,
      database,
      schema,
      table,
      rows
    })
  },
  beginTransaction(begin: TransactionBegin): Promise<IpcResult<TransactionInfo>> {
    return ipcRenderer.invoke(IPC.beginTransaction, begin)
  },
  commitTransaction(ref: TransactionRef): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.commitTransaction, ref)
  },
  rollbackTransaction(ref: TransactionRef): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.rollbackTransaction, ref)
  },
  listTransactions(connectionId: string): Promise<IpcResult<TransactionInfo[]>> {
    return ipcRenderer.invoke(IPC.listTransactions, { connectionId })
  },
  runQuery(req: QueryRequest): Promise<IpcResult<QueryResultSet[]>> {
    return ipcRenderer.invoke(IPC.runQuery, req)
  },
  // Stops the statement running on this connection. Returns false when nothing
  // was running or the engine cannot cancel (SQLite, MongoDB).
  cancelQuery(connectionId: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.cancelQuery, { connectionId })
  },
  explainQuery(req: ExplainRequest): Promise<IpcResult<ExplainResult>> {
    return ipcRenderer.invoke(IPC.explainQuery, req)
  },
  previewDdl(
    connectionId: string,
    operation: DdlOperation
  ): Promise<IpcResult<string[]>> {
    return ipcRenderer.invoke(IPC.previewDdl, { connectionId, operation })
  },
  executeDdl(
    connectionId: string,
    operation: DdlOperation
  ): Promise<IpcResult<QueryResultSet[]>> {
    return ipcRenderer.invoke(IPC.executeDdl, { connectionId, operation })
  },
  listUsers(connectionId: string): Promise<IpcResult<DbUser[]>> {
    return ipcRenderer.invoke(IPC.listUsers, { connectionId })
  },
  previewUserOp(
    connectionId: string,
    operation: UserOperation
  ): Promise<IpcResult<string[]>> {
    return ipcRenderer.invoke(IPC.previewUserOp, { connectionId, operation })
  },
  executeUserOp(
    connectionId: string,
    operation: UserOperation
  ): Promise<IpcResult<QueryResultSet[]>> {
    return ipcRenderer.invoke(IPC.executeUserOp, { connectionId, operation })
  },
  exportTable(req: ExportRequest): Promise<IpcResult<{ rowsWritten: number }>> {
    return ipcRenderer.invoke(IPC.exportTable, req)
  },
  exportResultSet(
    req: ResultExportRequest
  ): Promise<IpcResult<{ rowsWritten: number } | null>> {
    return ipcRenderer.invoke(IPC.exportResultSet, req)
  },
  previewImport(
    filePath: string,
    delimiter: string,
    hasHeader: boolean
  ): Promise<IpcResult<ImportPreview>> {
    return ipcRenderer.invoke(IPC.previewImport, { filePath, delimiter, hasHeader })
  },
  importCsv(req: CsvImportRequest): Promise<IpcResult<ImportResult>> {
    return ipcRenderer.invoke(IPC.importCsv, req)
  },
  importSql(req: SqlImportRequest): Promise<IpcResult<{ statements: number }>> {
    return ipcRenderer.invoke(IPC.importSql, req)
  },
  saveFileDialog(defaultPath: string): Promise<IpcResult<string | null>> {
    return ipcRenderer.invoke(IPC.saveFileDialog, { defaultPath })
  },
  openFileDialog(
    filters?: { name: string; extensions: string[] }[],
    options?: { directory?: boolean }
  ): Promise<IpcResult<string | null>> {
    return ipcRenderer.invoke(IPC.openFileDialog, {
      filters,
      directory: options?.directory === true
    })
  },
  clipboardWrite(text: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.clipboardWrite, { text })
  },
  clipboardRead(): Promise<IpcResult<string>> {
    return ipcRenderer.invoke(IPC.clipboardRead)
  },
  listSavedQueries(connectionId: string): Promise<IpcResult<SavedQuery[]>> {
    return ipcRenderer.invoke(IPC.listSavedQueries, { connectionId })
  },
  saveQuery(input: SaveQueryInput): Promise<IpcResult<SavedQuery>> {
    return ipcRenderer.invoke(IPC.saveQuery, input)
  },
  deleteSavedQuery(id: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.deleteSavedQuery, { id })
  },
  exportSavedQuery(id: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.exportSavedQuery, { id })
  },
  importSavedQuery(connectionId: string): Promise<IpcResult<SavedQuery | null>> {
    return ipcRenderer.invoke(IPC.importSavedQuery, { connectionId })
  },
  listQueryHistory(connectionId: string): Promise<IpcResult<QueryHistoryEntry[]>> {
    return ipcRenderer.invoke(IPC.listQueryHistory, { connectionId })
  },
  addQueryHistory(
    entry: Omit<QueryHistoryEntry, 'id' | 'createdAt'>
  ): Promise<IpcResult<QueryHistoryEntry>> {
    return ipcRenderer.invoke(IPC.addQueryHistory, entry)
  },
  clearQueryHistory(connectionId: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.clearQueryHistory, { connectionId })
  },
  executeSqlFile(
    connectionId: string,
    database?: string
  ): Promise<IpcResult<{ statements: number } | null>> {
    return ipcRenderer.invoke(IPC.executeSqlFile, { connectionId, database })
  },
  dumpDatabase(
    connectionId: string,
    database: string
  ): Promise<
    IpcResult<{ tables: number; tablesDone: number; rowsWritten: number } | null>
  > {
    return ipcRenderer.invoke(IPC.dumpDatabase, { connectionId, database })
  },
  backupDatabase(
    connectionId: string,
    database: string,
    options: BackupOptions
  ): Promise<IpcResult<BackupEntry | null>> {
    return ipcRenderer.invoke(IPC.backupDatabase, { connectionId, database, ...options })
  },
  restoreDatabase(
    connectionId: string,
    database?: string
  ): Promise<IpcResult<{ statements: number } | null>> {
    return ipcRenderer.invoke(IPC.restoreDatabase, { connectionId, database })
  },
  listBackups(): Promise<IpcResult<BackupEntry[]>> {
    return ipcRenderer.invoke(IPC.listBackups)
  },
  deleteBackupEntry(id: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.deleteBackupEntry, { id })
  },
  previewTransfer(input: {
    source: TransferSource
    target: TransferTarget
  }): Promise<IpcResult<TransferPreview>> {
    return ipcRenderer.invoke(IPC.previewTransfer, input)
  },
  startTransfer(request: TransferRequest): Promise<IpcResult<TransferResult>> {
    return ipcRenderer.invoke(IPC.startTransfer, request)
  },
  onTransferProgress(
    listener: (event: { transferId: string; progress: TransferProgress }) => void
  ): () => void {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      payload: { transferId: string; progress: TransferProgress }
    ): void => listener(payload)
    ipcRenderer.on(IPC.transferProgress, wrapped)
    return () => ipcRenderer.removeListener(IPC.transferProgress, wrapped)
  },
  getAiSettings(): Promise<IpcResult<AiSettings>> {
    return ipcRenderer.invoke(IPC.getAiSettings)
  },
  saveAiSettings(input: AiSettingsInput): Promise<IpcResult<AiSettings>> {
    return ipcRenderer.invoke(IPC.saveAiSettings, input)
  },
  listAiModels(baseUrl?: string): Promise<IpcResult<AiModel[]>> {
    return ipcRenderer.invoke(IPC.listAiModels, { baseUrl })
  },
  aiChat(request: AiChatRequest): Promise<IpcResult<AiChatReply>> {
    return ipcRenderer.invoke(IPC.aiChat, request)
  },
  // Starts a streamed answer. Deltas arrive through onAiStream; the promise
  // resolves when the stream ends or rejects with the provider error.
  aiChatStream(requestId: string, request: AiChatRequest): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.aiChatStream, { requestId, ...request })
  },
  aiChatCancel(requestId: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.aiChatCancel, { requestId })
  },
  // Native menu items run in main, which has no access to renderer state; they
  // send a command here and the shell decides what to do.
  onMenuAction(listener: (action: MenuAction) => void): () => void {
    const wrapped = (_e: Electron.IpcRendererEvent, action: MenuAction): void =>
      listener(action)
    ipcRenderer.on(IPC.menuAction, wrapped)
    return () => ipcRenderer.removeListener(IPC.menuAction, wrapped)
  },
  // Translated labels for the native menu, which lives in main.
  setMenuLabels(labels: Record<string, string>): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.menuLabels, labels)
  },
  // Tells main which menu items make sense, so none of them is a dead control.
  setMenuState(state: MenuState): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.menuState, state)
  },
  onAiStream(listener: (event: AiStreamEvent) => void): () => void {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: AiStreamEvent): void =>
      listener(payload)
    ipcRenderer.on(IPC.aiChatStreamEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC.aiChatStreamEvent, wrapped)
  },
  // Accepts a changed SSH host key after the user confirms the new fingerprint.
  // Zoom is a property of the web frame, not of the main process, so it is
  // applied here instead of over IPC.
  setZoom(factor: number): void {
    webFrame.setZoomFactor(factor)
  },
  getZoom(): number {
    return webFrame.getZoomFactor()
  },
  getSettings(): Promise<IpcResult<AppSettings>> {
    return ipcRenderer.invoke(IPC.getSettings)
  },
  saveSettings(settings: AppSettings): Promise<IpcResult<AppSettings>> {
    return ipcRenderer.invoke(IPC.saveSettings, { settings })
  },
  resetSettings(): Promise<IpcResult<AppSettings>> {
    return ipcRenderer.invoke(IPC.resetSettings)
  },
  exportSettings(): Promise<IpcResult<string | null>> {
    return ipcRenderer.invoke(IPC.exportSettings)
  },
  importSettings(filePath: string): Promise<IpcResult<AppSettings>> {
    return ipcRenderer.invoke(IPC.importSettings, { filePath })
  },
  appInfo(): Promise<IpcResult<AppInfo>> {
    return ipcRenderer.invoke(IPC.appInfo)
  },
  // Update state comes from main; the renderer only renders it.
  checkForUpdates(): Promise<IpcResult<UpdateState>> {
    return ipcRenderer.invoke(IPC.updateCheck)
  },
  downloadUpdate(): Promise<IpcResult<UpdateState>> {
    return ipcRenderer.invoke(IPC.updateDownload)
  },
  installUpdate(): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.updateInstall)
  },
  openUpdatePage(): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.updateOpenPage)
  },
  // Opens a documentation or download page in the system browser.
  openExternal(url: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.openExternal, { url })
  },
  getUpdateState(): Promise<IpcResult<UpdateState>> {
    return ipcRenderer.invoke(IPC.updateState)
  },
  onUpdateState(listener: (state: UpdateState) => void): () => void {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: UpdateState): void =>
      listener(payload)
    ipcRenderer.on(IPC.updateStateEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC.updateStateEvent, wrapped)
  },
  openAppPath(target: 'userData' | 'logFile'): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.openPath, { target })
  },
  trustSshHost(connectionId: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.trustSshHost, { connectionId })
  },
  // Fingerprint already recorded for a host, if any.
  sshHostFingerprint(host: string, port?: number): Promise<IpcResult<string | null>> {
    return ipcRenderer.invoke(IPC.sshHostFingerprint, { host, port })
  },
  previewStructureSync(
    input: Omit<StructureSyncRequest, 'syncId' | 'dryRun'>
  ): Promise<IpcResult<StructureSyncPreview>> {
    return ipcRenderer.invoke(IPC.previewStructureSync, input)
  },
  runStructureSync(
    request: StructureSyncRequest
  ): Promise<IpcResult<StructureSyncResult>> {
    return ipcRenderer.invoke(IPC.runStructureSync, request)
  },
  previewDataSync(
    input: Omit<DataSyncRequest, 'syncId' | 'dryRun'>
  ): Promise<IpcResult<DataSyncPreview>> {
    return ipcRenderer.invoke(IPC.previewDataSync, input)
  },
  runDataSync(request: DataSyncRequest): Promise<IpcResult<DataSyncResult>> {
    return ipcRenderer.invoke(IPC.runDataSync, request)
  },
  cancelSync(syncId: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.cancelSync, { syncId })
  },
  onSyncProgress(listener: (progress: SyncProgress) => void): () => void {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: SyncProgress): void =>
      listener(payload)
    ipcRenderer.on(IPC.syncProgress, wrapped)
    return () => ipcRenderer.removeListener(IPC.syncProgress, wrapped)
  },
  listSyncProfiles(): Promise<IpcResult<SyncProfile[]>> {
    return ipcRenderer.invoke(IPC.listSyncProfiles)
  },
  saveSyncProfile(input: SaveSyncProfileInput): Promise<IpcResult<SyncProfile>> {
    return ipcRenderer.invoke(IPC.saveSyncProfile, input)
  },
  deleteSyncProfile(id: string): Promise<IpcResult<boolean>> {
    return ipcRenderer.invoke(IPC.deleteSyncProfile, { id })
  }
}

contextBridge.exposeInMainWorld('dbApi', dbApi)

export type DbApi = typeof dbApi
