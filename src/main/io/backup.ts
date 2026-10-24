import { app } from 'electron'
import { createReadStream, createWriteStream } from 'fs'
import { readFile, stat } from 'fs/promises'
import { once } from 'events'
import { join } from 'path'
import { writeJsonAtomic } from '../storage/atomicWrite'
import { randomUUID } from 'crypto'
import type { BackupEntry, BackupOptions } from '@shared/types'
import { qualifiedTable, quoteIdent } from '@shared/ddl'
import { sqlLiteral } from '@shared/sqlLiteral'
import { lastSafeStatementBoundary } from '@shared/sqlBoundary'
import { DbWorkerClient } from '../workers/dbWorkerClient'
import { getConnectionConfig } from '../connection/store'
import { listScopedTables, schemaPrelude } from './tableScope'

const CHUNK_SIZE = 500
const HISTORY_FILE = 'backups.json'

async function writeChunk(stream: NodeJS.WritableStream, text: string): Promise<void> {
  if (!stream.write(text)) await once(stream, 'drain')
}

export interface BackupProgress {
  tables: number
  tablesDone: number
  rowsWritten: number
}

function historyPath(): string {
  return join(app.getPath('userData'), HISTORY_FILE)
}

export async function listBackups(): Promise<BackupEntry[]> {
  try {
    const raw = await readFile(historyPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as BackupEntry[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function writeHistory(entries: BackupEntry[]): Promise<void> {
  await writeJsonAtomic(historyPath(), entries)
}

export async function deleteBackupEntry(id: string): Promise<void> {
  const entries = await listBackups()
  await writeHistory(entries.filter((e) => e.id !== id))
}

export async function backupDatabase(
  client: DbWorkerClient,
  connectionId: string,
  database: string,
  filePath: string,
  options: BackupOptions,
  onProgress?: (p: BackupProgress) => void
): Promise<BackupEntry> {
  const cfg = await getConnectionConfig(connectionId)
  if (!cfg) throw new Error(`Connection not found: ${connectionId}`)
  const engine = cfg.engine

  const tables = await listScopedTables(client, connectionId, database, engine)
  const dataTables = tables.filter((t) => t.type === 'table')

  const stream = createWriteStream(filePath, { encoding: 'utf-8' })
  const progress: BackupProgress = {
    tables: dataTables.length,
    tablesDone: 0,
    rowsWritten: 0
  }

  try {
    await writeChunk(
      stream,
      `-- Tupai backup\n-- Database: ${database}\n-- Engine: ${engine}\n` +
        `-- Created: ${new Date().toISOString()}\n` +
        `-- Contents: ${options.structure ? 'structure' : ''}${
          options.structure && options.data ? ' + ' : ''
        }${options.data ? 'data' : ''}\n\n`
    )

    if (options.structure) {
      // Schemas must exist before their tables; without this a backup of a
      // non-public schema could not be restored.
      for (const statement of schemaPrelude(engine, dataTables)) {
        await writeChunk(stream, `${statement}\n\n`)
      }
      for (const t of dataTables) {
        const ddl = await client.call<string | null>('getTableDdl', {
          connectionId,
          database,
          table: t.name,
          schema: t.schema
        })
        if (ddl) await writeChunk(stream, `${ddl}\n\n`)
      }
    }

    if (options.data) {
      for (const t of dataTables) {
        const cols = await client.call<{ name: string }[]>('listColumns', {
          connectionId,
          database,
          table: t.name,
          schema: t.schema
        })
        const colNames = cols.map((c) => c.name)
        if (colNames.length === 0) {
          progress.tablesDone += 1
          continue
        }
        const target = qualifiedTable(engine, t.name, t.schema, database)
        const colList = colNames.map((c) => quoteIdent(engine, c)).join(', ')

        let offset = 0
        let wroteHeader = false
        for (;;) {
          const batch = await client.call<Record<string, unknown>[]>('fetchBatch', {
            connectionId,
            database,
            schema: t.schema,
            table: t.name,
            limit: CHUNK_SIZE,
            offset
          })
          if (batch.length === 0) break
          if (!wroteHeader) {
            await writeChunk(stream, `-- Data: ${t.name}\n`)
            wroteHeader = true
          }
          let out = ''
          for (const row of batch) {
            const values = colNames.map((c) => sqlLiteral(engine, row[c])).join(', ')
            out += `INSERT INTO ${target} (${colList}) VALUES (${values});\n`
          }
          await writeChunk(stream, out)
          progress.rowsWritten += batch.length
          offset += CHUNK_SIZE
          onProgress?.(progress)
          if (batch.length < CHUNK_SIZE) break
        }
        if (wroteHeader) await writeChunk(stream, '\n')
        progress.tablesDone += 1
        onProgress?.(progress)
      }
    }
  } finally {
    stream.end()
    await once(stream, 'finish')
  }

  const info = await stat(filePath)
  const entry: BackupEntry = {
    id: randomUUID(),
    connectionId,
    database,
    engine,
    filePath,
    bytes: info.size,
    tables: progress.tables,
    rows: progress.rowsWritten,
    structure: options.structure,
    data: options.data,
    createdAt: Date.now()
  }
  const history = await listBackups()
  await writeHistory([entry, ...history].slice(0, 200))
  return entry
}

export async function restoreDatabase(
  client: DbWorkerClient,
  connectionId: string,
  database: string | undefined,
  filePath: string
): Promise<{ statements: number }> {
  // A dump can be far larger than memory. The file is read line by line and
  // sent in chunks that end on a statement boundary, so a 1 GB dump restores
  // with a bounded buffer instead of readFile-ing the whole thing.
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const statements: string[] = []
  let buffer = ''
  let count = 0
  const FLUSH_AT = 2 * 1024 * 1024

  const flush = async (force: boolean): Promise<void> => {
    if (buffer.trim().length === 0) {
      buffer = ''
      return
    }
    // Cut only at a terminator outside strings, comments, and dollar-quoted
    // bodies. A plain search for ";\n" would split inside a multi-line value
    // or a function body and corrupt the restore.
    const cut = force ? buffer.length : lastSafeStatementBoundary(buffer)
    if (cut <= 0) {
      if (!force) return
      statements.push(buffer)
      buffer = ''
    } else {
      statements.push(buffer.slice(0, cut))
      buffer = buffer.slice(cut)
    }
    if (statements.length > 0) {
      const sql = statements.join('\n')
      statements.length = 0
      const result = await client.call<unknown[]>('runQuery', {
        connectionId,
        sql,
        maxRows: 1,
        database
      })
      count += result.length
    }
  }

  try {
    for await (const chunk of stream) {
      buffer += chunk as string
      if (buffer.length >= FLUSH_AT) await flush(false)
    }
    await flush(true)
  } finally {
    stream.destroy()
  }
  return { statements: count }
}
