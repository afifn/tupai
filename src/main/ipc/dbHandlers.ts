import { BrowserWindow, ipcMain, shell } from 'electron'
import { clipboard } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { IPC } from '@shared/ipc-contract'
import {
  connectionConfigSchema,
  listColumnsSchema,
  listTableStatsSchema,
  listTablesSchema,
  pageQuerySchema,
  pingSchema,
  rowDeleteSchema,
  rowDeleteBatchSchema,
  rowInsertSchema,
  rowUpdateSchema,
  queryRequestSchema,
  cancelQuerySchema,
  ddlRequestSchema,
  listUsersSchema,
  userRequestSchema,
  exportRequestSchema,
  exportResultSetSchema,
  queryHistoryAddSchema,
  searchObjectsSchema,
  listSessionsSchema,
  killSessionSchema,
  connectionGroupSchema,
  deleteConnectionGroupSchema,
  setConnectionGroupSchema,
  importPreviewRequestSchema,
  csvImportRequestSchema,
  sqlImportRequestSchema,
  saveFileDialogSchema,
  openFileDialogSchema,
  previewNcxImportSchema,
  applyNcxImportSchema,
  exportNcxSchema,
  saveSettingsSchema,
  importSettingsSchema,
  menuLabelsSchema,
  menuStateSchema,
  transactionBeginSchema,
  transactionRefSchema,
  openPathSchema,
  saveQuerySchema,
  savedQueryScopeSchema,
  deleteSavedQuerySchema,
  exportSavedQuerySchema,
  importSavedQuerySchema,
  executeSqlFileSchema,
  dumpDatabaseSchema,
  aiSettingsInputSchema,
  routineDefinitionSchema,
  aiChatSchema,
  aiChatStreamSchema,
  aiChatCancelSchema,
  explainRequestSchema,
  backupRequestSchema,
  restoreRequestSchema,
  deleteBackupEntrySchema,
  transferPreviewSchema,
  transferRequestSchema,
  structureSyncPreviewSchema,
  structureSyncRequestSchema,
  dataSyncPreviewSchema,
  dataSyncRequestSchema,
  saveSyncProfileSchema,
  deleteSyncProfileSchema,
  cancelSyncSchema,
  connectionIdOnlySchema,
  listSchemasRequestSchema,
  clipboardWriteSchema,
  listAiModelsRequestSchema,
  trustSshHostSchema,
  sshHostFingerprintSchema,
  openExternalSchema
} from '@shared/schemas'
import type {
  AiStreamEvent,
  DbEngine,
  IpcResult,
  StoredConnection,
  SyncProgress,
  TransferProgress,
  UserOperation
} from '@shared/types'
import { DbWorkerClient, toIpcResult } from '../workers/dbWorkerClient'
import { buildDdl } from '@shared/ddl'
import { buildUserSql, schemaObjectGrants } from '@shared/userOps'
import { dumpDatabase } from '../io/databaseDump'
import {
  exportResultSet,
  exportTable,
  importCsv,
  importSql,
  previewImport,
  showOpenDialog,
  showSaveDialog
} from '../io/handlers'
import {
  deleteConnection,
  getConnectionConfig,
  listConnections,
  saveConnection,
  setConnectionGroup
} from '../connection/store'
import {
  deleteConnectionGroup,
  listConnectionGroups,
  saveConnectionGroup
} from '../connection/groups'
import {
  previewNcxFile,
  suggestNcxFileName,
  toExportable,
  writeNcxFile
} from '../connection/ncx'
import { appInfo, readSettings, resetSettings, writeSettings } from '../settings/store'
import { applyMenuState, refreshApplicationMenu, setMenuLabels } from '../menu'
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateState,
  installUpdate,
  openDownloadPage
} from '../update/updater'
import { appSettingsSchema, mergeSettings } from '@shared/settings'
import {
  deleteSavedQuery,
  exportSavedQuery,
  importSavedQuery,
  listSavedQueries,
  saveQuery
} from '../savedQueries/store'
import {
  addQueryHistory,
  clearQueryHistory,
  listQueryHistory
} from '../savedQueries/history'
import { getAiSettings, saveAiSettings } from '../ai/store'
import { chat, chatStream, listAiModels } from '../ai/client'
import {
  backupDatabase,
  deleteBackupEntry,
  listBackups,
  restoreDatabase
} from '../io/backup'
import { previewTransfer, transferData } from '../io/dataTransfer'
import { previewStructureSync, structureSync } from '../sync/structureSync'
import { dataSync, previewDataSync } from '../sync/dataSync'
import { deleteSyncProfile, listSyncProfiles, saveSyncProfile } from '../sync/profiles'
import { forgetHostKey, storedFingerprint } from '../connection/knownHosts'
import { supportsTitleBarOverlay } from '../windowChrome'
import { log } from '../logger'
import { broadcastSettingsChanged } from '../settingsWindow'

let client: DbWorkerClient | null = null

// Sync ids the user cancelled while a deploy was running. The flag is checked
// from the progress callback, so cancellation lands between tables (data) or
// between statements (structure) instead of killing the worker mid-query.
const cancelledSyncs = new Set<string>()

function syncSender(event: Electron.IpcMainInvokeEvent): {
  send: (progress: SyncProgress) => boolean
} {
  const sender = event.sender
  return {
    send(progress) {
      if (sender.isDestroyed()) return false
      sender.send(IPC.syncProgress, progress)
      return !cancelledSyncs.has(progress.syncId)
    }
  }
}

function getClient(): DbWorkerClient {
  if (!client) {
    client = new DbWorkerClient()
    // The adapters live only inside the worker, so a crash silently destroys
    // every open connection. Forward that to the window: without it the UI keeps
    // showing a connection that cannot be used, and the next call fails with a
    // "not connected" that looks like the user's fault.
    client.setWorkerLostHandler((reason, lastOp) => {
      log('error', 'worker-lost', { code: reason.code, message: reason.message, lastOp })
      // The log keeps the stack; the banner gets the first line only, because a
      // stack trace in a notice bar is unreadable and pushes the sentence away.
      const headline = reason.message.split('\n')[0]
      const shown = { ...reason, message: headline }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
          win.webContents.send(IPC.workerLostEvent, { reason: shown, lastOp })
      }
    })
  }
  return client
}

// Resolves the database/schema a DDL statement must run against. Database-level
// operations are excluded: the target may not exist yet (create) or must not be
// entered (drop), and schemas being created or dropped must not be selected.
function ddlContext(operation: { kind: string; database: string; schema?: string }): {
  database?: string
  schema?: string
} {
  if (operation.kind === 'createDatabase' || operation.kind === 'dropDatabase') {
    return {}
  }
  if (operation.kind === 'createSchema' || operation.kind === 'dropSchema') {
    return { database: operation.database }
  }
  return { database: operation.database, schema: operation.schema }
}

async function run<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    return toIpcResult<T>(err)
  }
}

/**
 * Builds the statements for a user operation. Most are a pure translation, but
 * an Oracle schema-wide grant cannot be one statement: the objects are listed
 * first and each gets its own GRANT, so the preview shows exactly what will run.
 */
async function userStatements(
  connectionId: string,
  engine: DbEngine,
  operation: UserOperation
): Promise<string[]> {
  const schemaWide =
    (operation.kind === 'grant' || operation.kind === 'revoke') &&
    operation.onType === 'schema' &&
    engine === 'oracle'
  if (!schemaWide) return buildUserSql(engine, operation)

  const scoped = operation as Extract<UserOperation, { kind: 'grant' | 'revoke' }>
  const owner = scoped.schema ?? scoped.database
  const tables = (await getClient().call('listTables', {
    connectionId,
    database: owner,
    schema: owner
  })) as { name: string }[]
  return schemaObjectGrants(
    engine,
    {
      kind: scoped.kind,
      user: scoped.user,
      host: scoped.host,
      privileges: scoped.privileges,
      schema: owner
    },
    tables.map((t) => t.name)
  )
}

export function registerDbHandlers(): void {
  ipcMain.handle(IPC.ping, (_e, raw) =>
    run(async () => {
      const { message } = pingSchema.parse(raw)
      return { echo: message }
    })
  )

  // Diagnostic only: forwards a deliberate worker crash when the app was started
  // with TUPAI_DEBUG_CRASH=1. Used to verify that a dead worker is reported to
  // the window instead of leaving a phantom connection behind, and that the log
  // names the cause. `throw` raises an uncaught error; anything else exits.
  ipcMain.handle(IPC.debugCrashWorker, (_e, mode?: unknown) =>
    run(async () => {
      if (process.env.TUPAI_DEBUG_CRASH !== '1') {
        throw new Error('Diagnostic crash is disabled.')
      }
      await getClient().call('__crash', { mode: mode === 'throw' ? 'throw' : 'exit' })
      return true
    })
  )

  ipcMain.handle(IPC.listConnections, () => run(() => listConnections()))

  ipcMain.handle(IPC.saveConnection, (_e, raw) =>
    run(() => saveConnection(connectionConfigSchema.parse(raw)))
  )

  ipcMain.handle(IPC.deleteConnection, (_e, raw) =>
    run(async () => {
      const { connectionId } = connectionIdOnlySchema.parse(raw)
      await getClient()
        .call('disconnect', { connectionId })
        .catch(() => undefined)
      await deleteConnection(connectionId)
      return true
    })
  )

  ipcMain.handle(IPC.listConnectionGroups, () => run(() => listConnectionGroups()))

  ipcMain.handle(IPC.saveConnectionGroup, (_e, raw) =>
    run(() => saveConnectionGroup(connectionGroupSchema.parse(raw)))
  )

  ipcMain.handle(IPC.deleteConnectionGroup, (_e, raw) =>
    run(async () => {
      const { id } = deleteConnectionGroupSchema.parse(raw)
      await deleteConnectionGroup(id)
      return true
    })
  )

  // Navicat connection import. The preview never touches the store; applying
  // re-parses the file so a renderer cannot hand main a fabricated connection.
  ipcMain.handle(IPC.previewNcxImport, (_e, raw) =>
    run(async () => {
      const { filePath } = previewNcxImportSchema.parse(raw)
      const existing = (await listConnections()).map((c) => c.name)
      return previewNcxFile(filePath, existing)
    })
  )

  ipcMain.handle(IPC.applyNcxImport, (_e, raw) =>
    run(async () => {
      const { filePath, keys } = applyNcxImportSchema.parse(raw)
      const existing = (await listConnections()).map((c) => c.name)
      const preview = await previewNcxFile(filePath, existing)
      if (preview.invalid) throw new Error('invalid-ncx')
      const wanted = new Set(keys)
      const imported: string[] = []
      const skipped: string[] = []
      for (const item of preview.items) {
        if (!wanted.has(item.key) || !item.config) {
          skipped.push(item.name)
          continue
        }
        await saveConnection(item.config)
        imported.push(item.name)
      }
      return { imported, skipped }
    })
  )

  // Export writes what the user selected, never the stored passwords: Navicat
  // expects its own ciphertext and a plaintext blob would be a leak.
  ipcMain.handle(IPC.exportNcx, (_e, raw) =>
    run(async () => {
      const { connectionIds } = exportNcxSchema.parse(raw)
      const all = await listConnections()
      const byId = new Map(all.map((c) => [c.id, c]))
      // Keep the order the renderer sent, so the file lists connections the same
      // way the export dialog did instead of store order.
      const chosen = connectionIds
        .map((id) => byId.get(id))
        .filter((c): c is StoredConnection => Boolean(c))
      if (chosen.length === 0) return null
      const target = await showSaveDialog(suggestNcxFileName(chosen.map((c) => c.name)))
      if (!target) return null
      await writeNcxFile(target, chosen.map(toExportable))
      return { path: target, count: chosen.length }
    })
  )

  ipcMain.handle(IPC.setConnectionGroup, (_e, raw) =>
    run(async () => {
      const { connectionId, groupId } = setConnectionGroupSchema.parse(raw)
      await setConnectionGroup(connectionId, groupId)
      return true
    })
  )

  ipcMain.handle(IPC.testConnection, (_e, raw) =>
    run(() => {
      const cfg = connectionConfigSchema.parse(raw)
      return getClient().call<boolean>('testConnection', cfg)
    })
  )

  ipcMain.handle(IPC.connect, (_e, raw) =>
    run(async () => {
      const { connectionId } = connectionIdOnlySchema.parse(raw)
      const cfg = await getConnectionConfig(connectionId)
      if (!cfg) throw new Error(`Connection not found: ${connectionId}`)
      return getClient().call<boolean>('connect', cfg)
    })
  )

  ipcMain.handle(IPC.disconnect, (_e, raw) =>
    run(() => {
      const { connectionId } = connectionIdOnlySchema.parse(raw)
      return getClient().call<boolean>('disconnect', { connectionId })
    })
  )

  ipcMain.handle(IPC.listDatabases, (_e, raw) =>
    run(() => {
      const { connectionId } = connectionIdOnlySchema.parse(raw)
      return getClient().call<string[]>('listDatabases', { connectionId })
    })
  )

  ipcMain.handle(IPC.listSchemas, (_e, raw) =>
    run(() => {
      const { connectionId, database } = listSchemasRequestSchema.parse(raw)
      return getClient().call<string[]>('listSchemas', { connectionId, database })
    })
  )

  ipcMain.handle(IPC.listTables, (_e, raw) =>
    run(() => {
      const parsed = listTablesSchema.parse(raw)
      return getClient().call('listTables', parsed)
    })
  )

  ipcMain.handle(IPC.listColumns, (_e, raw) =>
    run(() => {
      const parsed = listColumnsSchema.parse(raw)
      return getClient().call('listColumns', parsed)
    })
  )

  ipcMain.handle(IPC.getPrimaryKey, (_e, raw) =>
    run(() => {
      const parsed = listColumnsSchema.parse(raw)
      return getClient().call('getPrimaryKey', parsed)
    })
  )

  ipcMain.handle(IPC.listIndexes, (_e, raw) =>
    run(() => {
      const parsed = listColumnsSchema.parse(raw)
      return getClient().call('listIndexes', parsed)
    })
  )

  ipcMain.handle(IPC.listForeignKeys, (_e, raw) =>
    run(() => {
      const parsed = listColumnsSchema.parse(raw)
      return getClient().call('listForeignKeys', parsed)
    })
  )

  ipcMain.handle(IPC.getTableInfo, (_e, raw) =>
    run(() => {
      const parsed = listColumnsSchema.parse(raw)
      return getClient().call('getTableInfo', parsed)
    })
  )

  ipcMain.handle(IPC.getObjectDdl, (_e, raw) =>
    run(() => {
      const parsed = listColumnsSchema.parse(raw)
      return getClient().call('getTableDdl', parsed)
    })
  )

  ipcMain.handle(IPC.getViewDefinition, (_e, raw) =>
    run(() => {
      const { connectionId, database, table, schema } = listColumnsSchema.parse(raw)
      return getClient().call('getViewDefinition', {
        connectionId,
        database,
        view: table,
        schema
      })
    })
  )

  ipcMain.handle(IPC.getRoutineDefinition, (_e, raw) =>
    run(() => {
      const parsed = routineDefinitionSchema.parse(raw)
      return getClient().call('getRoutineDefinition', parsed)
    })
  )

  ipcMain.handle(IPC.listRoutines, (_e, raw) =>
    run(() => {
      const { connectionId, database, schema } = listTablesSchema.parse(raw)
      return getClient().call('listRoutines', { connectionId, database, schema })
    })
  )

  ipcMain.handle(IPC.searchObjects, (_e, raw) =>
    run(() => {
      const parsed = searchObjectsSchema.parse(raw)
      return getClient().call('searchObjects', parsed)
    })
  )

  ipcMain.handle(IPC.listSessions, (_e, raw) =>
    run(() => {
      const parsed = listSessionsSchema.parse(raw)
      return getClient().call('listSessions', parsed)
    })
  )

  ipcMain.handle(IPC.killSession, (_e, raw) =>
    run(async () => {
      const parsed = killSessionSchema.parse(raw)
      await getClient().call('killSession', parsed)
      return true
    })
  )

  ipcMain.handle(IPC.listTableStats, (_e, raw) =>
    run(() => {
      const parsed = listTableStatsSchema.parse(raw)
      return getClient().call('listTableStats', parsed)
    })
  )

  ipcMain.handle(IPC.selectRows, (_e, raw) =>
    run(() => {
      const parsed = pageQuerySchema.parse(raw)
      return getClient().call('selectRows', parsed)
    })
  )

  ipcMain.handle(IPC.updateRow, (_e, raw) =>
    run(() => {
      const parsed = rowUpdateSchema.parse(raw)
      return getClient().call('updateRow', parsed)
    })
  )

  ipcMain.handle(IPC.insertRow, (_e, raw) =>
    run(() => {
      const parsed = rowInsertSchema.parse(raw)
      return getClient().call('insertRow', parsed)
    })
  )

  ipcMain.handle(IPC.deleteRow, (_e, raw) =>
    run(() => {
      const parsed = rowDeleteSchema.parse(raw)
      return getClient().call('deleteRow', parsed)
    })
  )

  ipcMain.handle(IPC.deleteRows, (_e, raw) =>
    run(async () => {
      const parsed = rowDeleteBatchSchema.parse(raw)
      const dels = parsed.rows.map((primaryKeys) => ({
        connectionId: parsed.connectionId,
        database: parsed.database,
        schema: parsed.schema,
        table: parsed.table,
        primaryKeys
      }))
      return getClient().call<number>('deleteRows', { dels })
    })
  )

  ipcMain.handle(IPC.beginTransaction, (_e, raw) =>
    run(() => {
      const parsed = transactionBeginSchema.parse(raw)
      return getClient().call('beginTransaction', parsed)
    })
  )

  ipcMain.handle(IPC.commitTransaction, (_e, raw) =>
    run(async () => {
      const parsed = transactionRefSchema.parse(raw)
      await getClient().call('commitTransaction', parsed)
      return true
    })
  )

  ipcMain.handle(IPC.rollbackTransaction, (_e, raw) =>
    run(async () => {
      const parsed = transactionRefSchema.parse(raw)
      await getClient().call('rollbackTransaction', parsed)
      return true
    })
  )

  ipcMain.handle(IPC.listTransactions, (_e, raw) =>
    run(() => {
      const { connectionId } = transactionRefSchema
        .pick({ connectionId: true })
        .parse(raw)
      return getClient().call('listTransactions', { connectionId })
    })
  )

  ipcMain.handle(IPC.runQuery, (_e, raw) =>
    run(() => {
      const parsed = queryRequestSchema.parse(raw)
      return getClient().call('runQuery', parsed)
    })
  )

  ipcMain.handle(IPC.cancelQuery, (_e, raw) =>
    run(async () => {
      const { connectionId } = cancelQuerySchema.parse(raw)
      return getClient().call<boolean>('cancelQuery', { connectionId })
    })
  )

  ipcMain.handle(IPC.explainQuery, (_e, raw) =>
    run(() => {
      const parsed = explainRequestSchema.parse(raw)
      return getClient().call('explainQuery', parsed)
    })
  )

  ipcMain.handle(IPC.previewDdl, (_e, raw) =>
    run(async () => {
      const { connectionId, operation } = ddlRequestSchema.parse(raw)
      const cfg = await getConnectionConfig(connectionId)
      if (!cfg) throw new Error(`Connection not found: ${connectionId}`)
      return buildDdl(cfg.engine, operation)
    })
  )

  ipcMain.handle(IPC.executeDdl, (_e, raw) =>
    run(async () => {
      const { connectionId, operation } = ddlRequestSchema.parse(raw)
      const cfg = await getConnectionConfig(connectionId)
      if (!cfg) throw new Error(`Connection not found: ${connectionId}`)
      const statements = buildDdl(cfg.engine, operation)

      // Route the DDL to the right database/schema. Postgres runs each query
      // against one database, and MySQL/Oracle need their session default set,
      // so without this context a drop/create would target the wrong catalog.
      // createDatabase/dropDatabase must not switch: that database may not exist
      // yet, and createSchema/dropSchema must not set search_path to a schema
      // that is being created or removed.
      const context = ddlContext(operation)

      // SQLite has no TRUNCATE and its sqlite_sequence table may not exist.
      // Run the reset as a second statement only when that table is present.
      if (cfg.engine === 'sqlite' && operation.kind === 'truncateTable') {
        const results = await getClient().call('runQuery', {
          connectionId,
          sql: statements.join('\n'),
          maxRows: 1,
          ...context
        })
        try {
          await getClient().call('runQuery', {
            connectionId,
            sql: `DELETE FROM sqlite_sequence WHERE name = '${operation.table.replace(
              /'/g,
              "''"
            )}';`,
            maxRows: 1
          })
        } catch {
          // sqlite_sequence is absent unless a table uses AUTOINCREMENT.
        }
        return results
      }

      return getClient().call('runQuery', {
        connectionId,
        sql: statements.join('\n'),
        maxRows: 1,
        ...context
      })
    })
  )

  ipcMain.handle(IPC.listUsers, (_e, raw) =>
    run(() => {
      const { connectionId } = listUsersSchema.parse(raw)
      return getClient().call('listUsers', { connectionId })
    })
  )

  ipcMain.handle(IPC.previewUserOp, (_e, raw) =>
    run(async () => {
      const { connectionId, operation } = userRequestSchema.parse(raw)
      const cfg = await getConnectionConfig(connectionId)
      if (!cfg) throw new Error(`Connection not found: ${connectionId}`)
      return userStatements(connectionId, cfg.engine, operation)
    })
  )

  ipcMain.handle(IPC.executeUserOp, (_e, raw) =>
    run(async () => {
      const { connectionId, operation } = userRequestSchema.parse(raw)
      const cfg = await getConnectionConfig(connectionId)
      if (!cfg) throw new Error(`Connection not found: ${connectionId}`)
      const statements = await userStatements(connectionId, cfg.engine, operation)
      // A table-level GRANT names a table in a specific database. Without the
      // context the statement ran against the connection's default database,
      // so granting on a table elsewhere failed with "relation does not exist".
      const scoped = operation.kind === 'grant' || operation.kind === 'revoke'
      const database = scoped ? operation.database : undefined
      const schema = scoped ? operation.schema : undefined
      return getClient().call('runQuery', {
        connectionId,
        sql: statements.join('\n'),
        maxRows: 1,
        database,
        schema
      })
    })
  )

  ipcMain.handle(IPC.exportTable, (_e, raw) =>
    run(() => {
      const parsed = exportRequestSchema.parse(raw)
      return exportTable(getClient(), parsed)
    })
  )

  ipcMain.handle(IPC.exportResultSet, (_e, raw) =>
    run(async () => {
      const parsed = exportResultSetSchema.parse(raw)
      const filePath = await showSaveDialog(
        parsed.format === 'csv' ? 'query-result.csv' : 'query-result.json'
      )
      if (!filePath) return null
      return exportResultSet(parsed, filePath)
    })
  )
  ipcMain.handle(IPC.previewImport, (_e, raw) =>
    run(() => {
      const parsed = importPreviewRequestSchema.parse(raw)
      return previewImport(parsed.filePath, parsed.delimiter, parsed.hasHeader)
    })
  )

  ipcMain.handle(IPC.importCsv, (_e, raw) =>
    run(() => {
      const parsed = csvImportRequestSchema.parse(raw)
      return importCsv(getClient(), parsed)
    })
  )

  ipcMain.handle(IPC.importSql, (_e, raw) =>
    run(() => {
      const parsed = sqlImportRequestSchema.parse(raw)
      return importSql(getClient(), parsed)
    })
  )

  ipcMain.handle(IPC.saveFileDialog, (_e, raw) =>
    run(() => {
      const parsed = saveFileDialogSchema.parse(raw)
      return showSaveDialog(parsed.defaultPath)
    })
  )

  ipcMain.handle(IPC.openFileDialog, (_e, raw) =>
    run(() => {
      const parsed = openFileDialogSchema.parse(raw ?? {})
      return showOpenDialog(parsed.filters, parsed.directory === true)
    })
  )

  // Electron 44 reworked the clipboard to match the W3C API, so writeText and
  // readText return promises. The old synchronous calls still compile but the
  // value would be a promise, which is how a copy silently became "[object
  // Promise]" after the upgrade.
  ipcMain.handle(IPC.clipboardWrite, (_e, raw) =>
    run(async () => {
      const { text } = clipboardWriteSchema.parse(raw)
      await clipboard.writeText(text)
      return true
    })
  )

  ipcMain.handle(IPC.clipboardRead, () => run(() => clipboard.readText()))

  ipcMain.handle(IPC.getAiSettings, () => run(() => getAiSettings()))

  ipcMain.handle(IPC.saveAiSettings, (event, raw) =>
    run(async () => {
      const saved = await saveAiSettings(aiSettingsInputSchema.parse(raw))
      broadcastSettingsChanged(event.sender)
      return saved
    })
  )

  ipcMain.handle(IPC.listAiModels, (_e, raw) =>
    run(() => {
      const parsed = listAiModelsRequestSchema.parse(raw ?? {})
      return listAiModels(parsed.baseUrl)
    })
  )

  ipcMain.handle(IPC.aiChat, (_e, raw) => run(() => chat(aiChatSchema.parse(raw))))

  // One controller per in-flight stream so the renderer can stop it.
  const aiStreams = new Map<string, AbortController>()

  ipcMain.handle(IPC.aiChatStream, (event, raw) =>
    run(async () => {
      const parsed = aiChatStreamSchema.parse(raw)
      const sender = event.sender
      const controller = new AbortController()
      aiStreams.set(parsed.requestId, controller)
      const emit = (payload: AiStreamEvent): void => {
        if (sender.isDestroyed()) return
        sender.send(IPC.aiChatStreamEvent, payload)
      }
      try {
        await chatStream(parsed, emit, controller.signal)
        return true
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        emit({ requestId: parsed.requestId, type: 'error', text: message })
        throw err
      } finally {
        aiStreams.delete(parsed.requestId)
      }
    })
  )

  ipcMain.handle(IPC.aiChatCancel, (_e, raw) =>
    run(async () => {
      const { requestId } = aiChatCancelSchema.parse(raw)
      const controller = aiStreams.get(requestId)
      if (!controller) return false
      controller.abort()
      return true
    })
  )

  ipcMain.handle(IPC.listSavedQueries, (_e, raw) =>
    run(() => {
      const { connectionId } = savedQueryScopeSchema.parse(raw)
      return listSavedQueries(connectionId)
    })
  )

  ipcMain.handle(IPC.listQueryHistory, (_e, raw) =>
    run(() => {
      const { connectionId } = savedQueryScopeSchema.parse(raw)
      return listQueryHistory(connectionId)
    })
  )

  ipcMain.handle(IPC.addQueryHistory, (_e, raw) =>
    run(() => addQueryHistory(queryHistoryAddSchema.parse(raw)))
  )

  ipcMain.handle(IPC.clearQueryHistory, (_e, raw) =>
    run(async () => {
      const { connectionId } = savedQueryScopeSchema.parse(raw)
      await clearQueryHistory(connectionId)
      return true
    })
  )

  ipcMain.handle(IPC.saveQuery, (_e, raw) =>
    run(() => saveQuery(saveQuerySchema.parse(raw)))
  )

  ipcMain.handle(IPC.deleteSavedQuery, (_e, raw) =>
    run(async () => {
      const { id } = deleteSavedQuerySchema.parse(raw)
      await deleteSavedQuery(id)
      return true
    })
  )

  ipcMain.handle(IPC.exportSavedQuery, (_e, raw) =>
    run(async () => {
      const { id } = exportSavedQuerySchema.parse(raw)
      const target = await showSaveDialog('query.sql')
      if (!target) return false
      await exportSavedQuery(id, target)
      return true
    })
  )

  ipcMain.handle(IPC.importSavedQuery, (_e, raw) =>
    run(async () => {
      const { connectionId } = importSavedQuerySchema.parse(raw)
      const source = await showOpenDialog([{ name: 'SQL', extensions: ['sql'] }])
      if (!source) return null
      return importSavedQuery(source, connectionId)
    })
  )

  ipcMain.handle(IPC.executeSqlFile, (_e, raw) =>
    run(async () => {
      const { connectionId, database } = executeSqlFileSchema.parse(raw)
      const source = await showOpenDialog([{ name: 'SQL', extensions: ['sql'] }])
      if (!source) return null
      return importSql(getClient(), { connectionId, filePath: source, database })
    })
  )

  ipcMain.handle(IPC.dumpDatabase, (_e, raw) =>
    run(async () => {
      const { connectionId, database } = dumpDatabaseSchema.parse(raw)
      const target = await showSaveDialog(`${database}.sql`)
      if (!target) return null
      return dumpDatabase(getClient(), connectionId, database, target)
    })
  )

  ipcMain.handle(IPC.backupDatabase, (_e, raw) =>
    run(async () => {
      const parsed = backupRequestSchema.parse(raw)
      const target = await showSaveDialog(
        `${parsed.database}-${new Date().toISOString().slice(0, 10)}.sql`
      )
      if (!target) return null
      return backupDatabase(getClient(), parsed.connectionId, parsed.database, target, {
        structure: parsed.structure,
        data: parsed.data
      })
    })
  )

  ipcMain.handle(IPC.restoreDatabase, (_e, raw) =>
    run(async () => {
      const parsed = restoreRequestSchema.parse(raw)
      const source = await showOpenDialog([{ name: 'SQL', extensions: ['sql'] }])
      if (!source) return null
      return restoreDatabase(getClient(), parsed.connectionId, parsed.database, source)
    })
  )

  // After SSH_HOST_CHANGED the user can accept the new host key. Forgetting the
  // recorded fingerprint makes the next connect record it again (TOFU).
  ipcMain.handle(IPC.getSettings, () => run(() => readSettings()))

  ipcMain.handle(IPC.saveSettings, (event, raw) =>
    run(async () => {
      const { settings } = saveSettingsSchema.parse(raw)
      const next = appSettingsSchema.parse(settings)
      // The AI block has exactly one writer: saveAiSettings. The renderer holds
      // a copy it read at mount, so letting a generic settings save carry that
      // copy back would overwrite the model and base URL main wrote in the
      // meantime (that is how toggling "show sample rows" used to clear the
      // model). Import is the exception: there the file is the user's intent.
      const stored = await readSettings()
      const saved = await writeSettings({ ...next, ai: stored.ai })
      broadcastSettingsChanged(event.sender)
      // A rebound shortcut or a language change has to reach the native menu
      // too; it is built in main from the catalogue.
      if (
        JSON.stringify(saved.keymap) !== JSON.stringify(stored.keymap) ||
        saved.general.locale !== stored.general.locale
      ) {
        await refreshApplicationMenu()
      }
      return saved
    })
  )

  ipcMain.handle(IPC.resetSettings, (event) =>
    run(async () => {
      const saved = await resetSettings()
      broadcastSettingsChanged(event.sender)
      await refreshApplicationMenu()
      return saved
    })
  )

  // The renderer knows which tools are usable right now; main greys out the menu
  // items that would otherwise be dead entries.
  // The renderer owns the catalogue, so it sends the translated menu labels.
  ipcMain.handle(IPC.windowState, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return run(async () => ({
      fullscreen: win?.isFullScreen() ?? false,
      titleBarOverlay: supportsTitleBarOverlay()
    }))
  })

  ipcMain.handle(IPC.menuLabels, (_e, raw) =>
    run(async () => {
      setMenuLabels(menuLabelsSchema.parse(raw))
      return true
    })
  )

  ipcMain.handle(IPC.menuState, (_e, raw) =>
    run(async () => {
      applyMenuState(menuStateSchema.parse(raw))
      return true
    })
  )

  // The exported file is exactly what the settings page shows, minus secrets,
  // which never live in settings.json in the first place.
  ipcMain.handle(IPC.exportSettings, () =>
    run(async () => {
      const target = await showSaveDialog('tupai-settings.json')
      if (!target) return null
      const settings = await readSettings()
      await writeFile(target, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
      return target
    })
  )

  ipcMain.handle(IPC.importSettings, (event, raw) =>
    run(async () => {
      const { filePath } = importSettingsSchema.parse(raw)
      const text = await readFile(filePath, 'utf-8')
      const merged = mergeSettings(JSON.parse(text))
      const saved = await writeSettings(merged)
      broadcastSettingsChanged(event.sender)
      await refreshApplicationMenu()
      return saved
    })
  )

  ipcMain.handle(IPC.appInfo, () => run(async () => appInfo()))

  // Update checks are main-only: the renderer gets a state object, never a feed
  // URL, and cannot ask for an install the platform forbids.
  ipcMain.handle(IPC.updateCheck, () => run(() => checkForUpdates()))
  ipcMain.handle(IPC.updateDownload, () => run(() => downloadUpdate()))
  ipcMain.handle(IPC.updateInstall, () => run(async () => installUpdate()))
  ipcMain.handle(IPC.updateOpenPage, () => run(() => openDownloadPage()))

  // Opens a documentation or download page in the system browser. The URL is
  // validated to http(s) so a compromised renderer cannot ask the shell to open
  // a local file or a custom scheme.
  ipcMain.handle(IPC.openExternal, (_e, raw) =>
    run(async () => {
      const { url } = openExternalSchema.parse(raw)
      await shell.openExternal(url)
      return true
    })
  )
  ipcMain.handle(IPC.updateState, () => run(async () => getUpdateState()))

  ipcMain.handle(IPC.openPath, (_e, raw) =>
    run(async () => {
      const { target } = openPathSchema.parse(raw)
      const info = appInfo()
      const path = target === 'userData' ? info.userData : info.logFile
      await shell.openPath(path)
      return true
    })
  )

  ipcMain.handle(IPC.trustSshHost, (_e, raw) =>
    run(async () => {
      const { connectionId } = trustSshHostSchema.parse(raw)
      const cfg = await getConnectionConfig(connectionId)
      if (!cfg?.ssh) throw new Error('Koneksi ini tidak memakai SSH.')
      return forgetHostKey(cfg.ssh.host, cfg.ssh.port ?? 22)
    })
  )

  // Shows what the app already trusts for a host, so the form can display the
  // fingerprint instead of asking the user to trust something invisible.
  ipcMain.handle(IPC.sshHostFingerprint, (_e, raw) =>
    run(async () => {
      const { host, port } = sshHostFingerprintSchema.parse(raw)
      return storedFingerprint(host, port ?? 22)
    })
  )

  ipcMain.handle(IPC.listBackups, () => run(() => listBackups()))

  ipcMain.handle(IPC.deleteBackupEntry, (_e, raw) =>
    run(async () => {
      const { id } = deleteBackupEntrySchema.parse(raw)
      await deleteBackupEntry(id)
      return true
    })
  )

  ipcMain.handle(IPC.previewTransfer, (_e, raw) =>
    run(() => previewTransfer(getClient(), transferPreviewSchema.parse(raw)))
  )

  ipcMain.handle(IPC.startTransfer, (event, raw) =>
    run(async () => {
      const parsed = transferRequestSchema.parse(raw)
      // Progress is pushed to the window that started the transfer. The sender
      // is captured here so a destroyed window cannot break the loop.
      const sender = event.sender
      const sendProgress = (progress: TransferProgress): boolean => {
        if (sender.isDestroyed()) return false
        sender.send(IPC.transferProgress, {
          transferId: parsed.transferId,
          progress
        })
        return true
      }
      return transferData(getClient(), parsed, { onProgress: sendProgress })
    })
  )

  ipcMain.handle(IPC.previewStructureSync, (_e, raw) =>
    run(() => previewStructureSync(getClient(), structureSyncPreviewSchema.parse(raw)))
  )

  ipcMain.handle(IPC.runStructureSync, (event, raw) =>
    run(async () => {
      const parsed = structureSyncRequestSchema.parse(raw)
      cancelledSyncs.delete(parsed.syncId)
      const sender = syncSender(event)
      try {
        return await structureSync(getClient(), parsed, { onProgress: sender.send })
      } finally {
        cancelledSyncs.delete(parsed.syncId)
      }
    })
  )

  ipcMain.handle(IPC.previewDataSync, (_e, raw) =>
    run(() => previewDataSync(getClient(), dataSyncPreviewSchema.parse(raw)))
  )

  ipcMain.handle(IPC.runDataSync, (event, raw) =>
    run(async () => {
      const parsed = dataSyncRequestSchema.parse(raw)
      cancelledSyncs.delete(parsed.syncId)
      const sender = syncSender(event)
      try {
        return await dataSync(getClient(), parsed, { onProgress: sender.send })
      } finally {
        cancelledSyncs.delete(parsed.syncId)
      }
    })
  )

  ipcMain.handle(IPC.cancelSync, (_e, raw) =>
    run(async () => {
      const { syncId } = cancelSyncSchema.parse(raw)
      cancelledSyncs.add(syncId)
      return true
    })
  )

  ipcMain.handle(IPC.listSyncProfiles, () => run(() => listSyncProfiles()))

  ipcMain.handle(IPC.saveSyncProfile, (_e, raw) =>
    run(() => saveSyncProfile(saveSyncProfileSchema.parse(raw)))
  )

  ipcMain.handle(IPC.deleteSyncProfile, (_e, raw) =>
    run(async () => {
      const { id } = deleteSyncProfileSchema.parse(raw)
      await deleteSyncProfile(id)
      return true
    })
  )
}

export async function disposeDbHandlers(): Promise<void> {
  await client?.terminate()
  client = null
}
