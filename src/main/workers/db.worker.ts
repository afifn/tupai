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
  TableStructure
} from '@shared/types'
import { describeBinary, isBinaryCell } from '@shared/binary'
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
}

const adapters = new Map<string, DatabaseAdapter>()

async function getConnected(connectionId: string): Promise<DatabaseAdapter> {
  const existing = adapters.get(connectionId)
  if (!existing)
    throw new DbError('NOT_CONNECTED', `No active connection: ${connectionId}`, 'sqlite')
  return existing
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

async function handle(op: string, payload: unknown): Promise<unknown> {
  switch (op) {
    case 'testConnection': {
      const cfg = payload as ConnectionConfig
      const factory = await getAdapterFactory(cfg.engine)
      return factory(cfg.engine).testConnection(cfg)
    }
    case 'connect': {
      const cfg = payload as ConnectionConfig
      const factory = await getAdapterFactory(cfg.engine)
      const adapter = factory(cfg.engine)
      await adapter.connect(cfg)
      adapters.set(cfg.id, adapter)
      return true
    }
    case 'disconnect': {
      const { connectionId } = payload as { connectionId: string }
      const adapter = adapters.get(connectionId)
      await adapter?.disconnect()
      adapters.delete(connectionId)
      return true
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
      const { connectionId, sql, maxRows, database, schema } = payload as {
        connectionId: string
        sql: string
        maxRows: number
        database?: string
        schema?: string
      }
      const adapter = await getConnected(connectionId)
      // The adapter records the backend id itself; the callback exists so a
      // future engine can report progress without changing this contract.
      const results = await adapter.runQuery(
        sql,
        maxRows,
        { database, schema },
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
      response.error = {
        code: 'INTERNAL',
        message: describeError(err),
        engine
      }
    }
  }
  parentPort?.postMessage(response)
})
