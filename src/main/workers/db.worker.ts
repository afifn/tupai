import { parentPort } from 'worker_threads'
import type {
  ConnectionConfig,
  DbEngine,
  PageQuery,
  RowChangeSet,
  RowDelete,
  RowInsert,
  RowUpdate,
  RoutineKind,
  TableStructure,
  TransactionBegin,
  TransactionRef
} from '@shared/types'
import { describeBinary, isBinaryCell } from '@shared/binary'
import { toTransferable } from '@shared/transferable'
import { describeLostSession, isConnectionLostError } from '@shared/connectionLost'
import { getAdapterFactory } from '../drivers/registry'
import { DbError, type DatabaseAdapter } from '../drivers/types'

interface WorkerRequest {
  id: number
  op: string
  payload: unknown
}

interface WorkerResponse {
  id: number
  ok: boolean
  data?: unknown
  error?: { code: string; message: string; engine: string }
  // Set only for the last message a dying worker sends. The parent treats it as
  // the reason every connection is about to disappear.
  fatal?: boolean
}

const adapters = new Map<string, DatabaseAdapter>()

// A worker that dies takes every connection with it, and Node reports the crash
// as an empty error message when the failure comes from inside a native module.
// The detail is sent to the parent before exiting so the log names the cause
// instead of only an exit code.
function reportFatal(err: unknown): void {
  const source = err instanceof Error ? err : new Error(String(err))
  // The stack already starts with "Name: message", so it is used on its own
  // rather than prefixed, which printed the same line twice.
  const stack = (source.stack ?? '').split('\n').slice(0, 6).join('\n')
  const message = (stack || `${source.name}: ${source.message}`).slice(0, 2000)
  try {
    parentPort?.postMessage({
      id: -1,
      ok: false,
      fatal: true,
      error: { code: 'WORKER_ERROR', message, engine: 'sqlite' }
    } satisfies WorkerResponse)
  } catch {
    // The thread is going down; the parent still reports the exit.
  }
}

process.on('uncaughtException', (err) => {
  reportFatal(err)
  // One turn of the loop so the message can leave the thread; exiting right away
  // can drop it and leave the parent with only an exit code.
  setImmediate(() => process.exit(1))
})
process.on('unhandledRejection', (reason) => {
  reportFatal(reason)
  setImmediate(() => process.exit(1))
})

// Every adapter this worker has ever opened. Used to tell "you never connected"
// apart from "you were connected and the connection went away": both used to
// raise the same NOT_CONNECTED, which blamed the user for a lost session.
const knownConnections = new Set<string>()

async function getConnected(connectionId: string): Promise<DatabaseAdapter> {
  const existing = adapters.get(connectionId)
  if (existing) return existing
  if (knownConnections.has(connectionId)) {
    throw new DbError(
      'CONNECTION_LOST',
      `Connection ${connectionId} was open but is no longer available`,
      'sqlite'
    )
  }
  throw new DbError('NOT_CONNECTED', `No active connection: ${connectionId}`, 'sqlite')
}

function isBinaryLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Buffer.isBuffer(value) ||
      value instanceof Uint8Array ||
      value.constructor?.name === 'Buffer')
  )
}

function toUint8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  return new Uint8Array(value as ArrayBufferLike)
}

// Converts raw binary values into a serializable preview so large buffers do
// not cross the worker boundary. `raw` keeps buffers intact for export paths.
function prepareRows(
  rows: Record<string, unknown>[],
  raw: boolean
): Record<string, unknown>[] {
  if (raw) return rows
  return rows.map((row) => {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      if (isBinaryLike(value) && !isBinaryCell(value)) {
        out[key] = describeBinary(toUint8(value))
        changed = true
      } else {
        out[key] = value
      }
    }
    return changed ? out : row
  })
}

// A driver can hand back a live handle (LOB, ResultSet, object type) instead of
// plain data. Handles cannot cross the thread boundary: postMessage throws a
// DataCloneError, and an uncaught one used to kill the worker together with
// every open connection. Values that cannot be cloned are described instead.
function postResponse(response: WorkerResponse): void {
  try {
    parentPort?.postMessage(response)
  } catch (err) {
    if ((err as { name?: string })?.name !== 'DataCloneError') throw err
    parentPort?.postMessage(toTransferable(response) as WorkerResponse)
  }
}

async function handle(op: string, payload: unknown): Promise<unknown> {
  switch (op) {
    case 'testConnection': {
      const cfg = payload as ConnectionConfig
      const factory = await getAdapterFactory(cfg.engine)
      return factory(cfg.engine).testConnection(cfg)
    }
    // Diagnostic hook: crashes the thread on purpose so the crash-reporting path
    // can be exercised without a real segfault. Only reachable when the env var
    // is set, so a shipped build cannot trigger it. The `throw` mode raises an
    // uncaught error instead of a bare exit, which is what a real crash does.
    case '__crash': {
      if (process.env.TUPAI_DEBUG_CRASH !== '1') {
        throw new DbError('UNKNOWN_OP', 'Unknown operation: __crash', 'sqlite')
      }
      if ((payload as { mode?: string })?.mode === 'throw') {
        setTimeout(() => {
          throw new Error('Diagnostic worker crash')
        }, 0)
        return true
      }
      process.exit(99)
    }
    // eslint-disable-next-line no-fallthrough -- process.exit never returns
    case 'connect': {
      const cfg = payload as ConnectionConfig
      const factory = await getAdapterFactory(cfg.engine)
      const adapter = factory(cfg.engine)
      await adapter.connect(cfg)
      // Reconnecting over an existing adapter would leave the old connection open
      // on the server until it times out; close it first.
      const previous = adapters.get(cfg.id)
      adapters.set(cfg.id, adapter)
      knownConnections.add(cfg.id)
      if (previous) await previous.disconnect().catch(() => undefined)
      return true
    }
    case 'disconnect': {
      const { connectionId } = payload as { connectionId: string }
      const adapter = adapters.get(connectionId)
      await adapter?.disconnect()
      adapters.delete(connectionId)
      knownConnections.delete(connectionId)
      return true
    }
    case 'beginTransaction': {
      const begin = payload as TransactionBegin
      return (await getConnected(begin.connectionId)).beginTransaction(begin)
    }
    case 'commitTransaction': {
      const ref = payload as TransactionRef
      return (await getConnected(ref.connectionId)).commitTransaction(ref)
    }
    case 'rollbackTransaction': {
      const ref = payload as TransactionRef
      return (await getConnected(ref.connectionId)).rollbackTransaction(ref)
    }
    case 'listTransactions': {
      const { connectionId } = payload as { connectionId: string }
      return (await getConnected(connectionId)).listTransactions()
    }
    case 'listDatabases': {
      const { connectionId } = payload as { connectionId: string }
      return (await getConnected(connectionId)).listDatabases()
    }
    case 'listSchemas': {
      const { connectionId, database } = payload as {
        connectionId: string
        database?: string
      }
      return (await getConnected(connectionId)).listSchemas(database)
    }
    case 'listTables': {
      const { connectionId, database, schema } = payload as {
        connectionId: string
        database: string
        schema?: string
      }
      return (await getConnected(connectionId)).listTables(database, schema)
    }
    case 'listTableStats': {
      const { connectionId, database, schema } = payload as {
        connectionId: string
        database: string
        schema?: string
      }
      return (await getConnected(connectionId)).listTableStats(database, schema)
    }
    case 'listColumns': {
      const { connectionId, database, table, schema } = payload as {
        connectionId: string
        database: string
        table: string
        schema?: string
      }
      return (await getConnected(connectionId)).listColumns(database, table, schema)
    }
    case 'selectRows': {
      const query = payload as PageQuery
      const adapter = await getConnected(query.connectionId)
      const [page, columns] = await Promise.all([
        adapter.selectRows(query),
        adapter.listColumns(query.database, query.table, query.schema)
      ])
      const primaryKeys = columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
      return {
        columns,
        rows: prepareRows(page.rows, false),
        total: page.total,
        hasPrimaryKey: primaryKeys.length > 0,
        primaryKeys
      }
    }
    case 'fetchBatch': {
      return (await getConnected((payload as PageQuery).connectionId)).fetchBatch(
        payload as PageQuery
      )
    }
    case 'insertRows': {
      const { connectionId, database, schema, table, rows } = payload as {
        connectionId: string
        database: string
        schema?: string
        table: string
        rows: Record<string, unknown>[]
      }
      return (await getConnected(connectionId)).insertRows(database, schema, table, rows)
    }
    case 'updateRow': {
      const update = payload as RowUpdate
      return (await getConnected(update.connectionId)).updateRow(update)
    }
    case 'insertRow': {
      const insert = payload as RowInsert
      return (await getConnected(insert.connectionId)).insertRow(insert)
    }
    case 'deleteRow': {
      const del = payload as RowDelete
      return (await getConnected(del.connectionId)).deleteRow(del)
    }
    case 'deleteRows': {
      const { dels } = payload as { dels: RowDelete[] }
      if (dels.length === 0) return 0
      return (await getConnected(dels[0].connectionId)).deleteRows(dels)
    }
    case 'applyRowChanges': {
      return (await getConnected((payload as RowChangeSet).connectionId)).applyRowChanges(
        payload as RowChangeSet
      )
    }
    // One round trip per table instead of four metadata calls from the main
    // process. Sync compares many tables and the worker already holds the
    // connection.
    case 'getTableStructure': {
      const { connectionId, database, table, schema } = payload as {
        connectionId: string
        database: string
        table: string
        schema?: string
      }
      const adapter = await getConnected(connectionId)
      const [columns, primaryKey, indexes, foreignKeys] = await Promise.all([
        adapter.listColumns(database, table, schema),
        adapter.getPrimaryKey(database, table, schema),
        adapter.listIndexes(database, table, schema),
        adapter.listForeignKeys(database, table, schema)
      ])
      return {
        name: table,
        columns,
        primaryKey,
        indexes,
        foreignKeys
      } satisfies TableStructure
    }
    case 'cancelQuery': {
      const { connectionId } = payload as { connectionId: string }
      const adapter = await getConnected(connectionId)
      return adapter.cancelQuery()
    }
    case 'runQuery': {
      const { connectionId, sql, maxRows, database, schema, transactionId } = payload as {
        connectionId: string
        sql: string
        maxRows: number
        database?: string
        schema?: string
        transactionId?: string
      }
      const adapter = await getConnected(connectionId)
      // The adapter records the backend id itself; the callback exists so a
      // future engine can report progress without changing this contract.
      const results = await adapter.runQuery(
        sql,
        maxRows,
        { database, schema, transactionId },
        () => undefined
      )
      return results.map((r) => ({ ...r, rows: prepareRows(r.rows, false) }))
    }
    case 'explainQuery': {
      const { connectionId, sql, database, schema, analyze } = payload as {
        connectionId: string
        sql: string
        database?: string
        schema?: string
        analyze?: boolean
      }
      const adapter = await getConnected(connectionId)
      const started = Date.now()
      const plan = await adapter.explainQuery(sql, { database, schema }, analyze)
      return {
        engine: adapter.engine,
        format: plan.format,
        raw: plan.raw,
        durationMs: Date.now() - started
      }
    }
    case 'getTableDdl': {
      const { connectionId, database, table, schema } = payload as {
        connectionId: string
        database: string
        table: string
        schema?: string
      }
      return (await getConnected(connectionId)).getTableDdl(database, table, schema)
    }
    case 'getPrimaryKey': {
      const { connectionId, database, table, schema } = payload as {
        connectionId: string
        database: string
        table: string
        schema?: string
      }
      return (await getConnected(connectionId)).getPrimaryKey(database, table, schema)
    }
    case 'listIndexes': {
      const { connectionId, database, table, schema } = payload as {
        connectionId: string
        database: string
        table: string
        schema?: string
      }
      return (await getConnected(connectionId)).listIndexes(database, table, schema)
    }
    case 'listForeignKeys': {
      const { connectionId, database, table, schema } = payload as {
        connectionId: string
        database: string
        table: string
        schema?: string
      }
      return (await getConnected(connectionId)).listForeignKeys(database, table, schema)
    }
    case 'getTableInfo': {
      const { connectionId, database, table, schema } = payload as {
        connectionId: string
        database: string
        table: string
        schema?: string
      }
      return (await getConnected(connectionId)).getTableInfo(database, table, schema)
    }
    case 'getViewDefinition': {
      const { connectionId, database, view, schema } = payload as {
        connectionId: string
        database: string
        view: string
        schema?: string
      }
      return (await getConnected(connectionId)).getViewDefinition(database, view, schema)
    }
    case 'getRoutineDefinition': {
      const { connectionId, database, routine, kind, schema, signature } = payload as {
        connectionId: string
        database: string
        routine: string
        kind: RoutineKind
        schema?: string
        signature?: string | null
      }
      return (await getConnected(connectionId)).getRoutineDefinition(
        database,
        routine,
        kind,
        schema,
        signature
      )
    }
    case 'listRoutines': {
      const { connectionId, database, schema } = payload as {
        connectionId: string
        database: string
        schema?: string
      }
      return (await getConnected(connectionId)).listRoutines(database, schema)
    }
    case 'searchObjects': {
      const { connectionId, database, term, schema } = payload as {
        connectionId: string
        database: string
        term: string
        schema?: string
      }
      return (await getConnected(connectionId)).searchObjects(database, term, schema)
    }
    case 'listSessions': {
      const { connectionId, database } = payload as {
        connectionId: string
        database?: string
      }
      return (await getConnected(connectionId)).listSessions(database)
    }
    case 'killSession': {
      const { connectionId, sessionId } = payload as {
        connectionId: string
        sessionId: string
      }
      return (await getConnected(connectionId)).killSession(sessionId)
    }
    case 'listUsers': {
      const { connectionId } = payload as { connectionId: string }
      return (await getConnected(connectionId)).listUsers()
    }
    // Which Oracle client folder this thread loaded, if any. Answers the
    // question the UI cannot guess: whether the folder in Settings is the one
    // the process is really using, or whether it is waiting for a restart.
    case 'oracleClientStatus': {
      const { loadedOracleClientDir } = await import('../drivers/oracle')
      return { loadedDir: loadedOracleClientDir() }
    }
    default:
      throw new DbError('UNKNOWN_OP', `Unknown operation: ${op}`, 'sqlite')
  }
}
// Node aggregates multi-address connection failures into an AggregateError whose
// own message is empty. Without unwrapping it the renderer receives a blank
// reason, which is useless for the user.
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const parts: string[] = []
  const own = err.message.trim()
  if (own) parts.push(own)
  const code = (err as NodeJS.ErrnoException).code
  if (code && !own.includes(code)) parts.push(code)
  const errors = (err as { errors?: unknown[] }).errors
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      if (!(inner instanceof Error)) continue
      const text = inner.message.trim()
      const innerCode = (inner as NodeJS.ErrnoException).code
      const label =
        text && innerCode && !text.includes(innerCode)
          ? `${text} (${innerCode})`
          : text || innerCode
      if (label && !parts.some((p) => p.includes(label))) parts.push(label)
    }
  }
  return parts.join('; ') || err.name || 'Kesalahan tidak diketahui'
}

parentPort?.on('message', async (req: WorkerRequest) => {
  const response: WorkerResponse = { id: req.id, ok: true }
  try {
    response.data = await handle(req.op, req.payload)
  } catch (err) {
    response.ok = false
    if (err instanceof DbError) {
      response.error = err.toShape()
    } else {
      const engine = (req.payload as { engine?: DbEngine })?.engine ?? 'sqlite'
      // A session the server ended arrives as a driver error, not as a DbError.
      // Reporting it as INTERNAL would blame the statement; the connection is
      // what is gone, so it gets the code the UI turns into "reconnect".
      if (isConnectionLostError(err)) {
        response.error = {
          code: 'CONNECTION_LOST',
          message: describeLostSession(err),
          engine
        }
      } else {
        response.error = {
          code: 'INTERNAL',
          message: describeError(err),
          engine
        }
      }
    }
  }
  postResponse(response)
})
