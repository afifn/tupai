import { dialog, BrowserWindow } from 'electron'
import { createReadStream, createWriteStream } from 'fs'
import { readFile } from 'fs/promises'
import { once } from 'events'
import type {
  CsvImportRequest,
  ExportRequest,
  ImportPreview,
  ImportResult,
  ResultExportRequest,
  SqlImportRequest
} from '@shared/types'
import { CsvRowParser, toCsvHeader, toCsvRow } from './csv'
import { quoteIdent } from '@shared/ddl'
import { sqlLiteral } from '@shared/sqlLiteral'
import { DbWorkerClient } from '../workers/dbWorkerClient'
import { getConnectionConfig } from '../connection/store'

const CHUNK_SIZE = 1000

async function writeChunk(stream: NodeJS.WritableStream, text: string): Promise<void> {
  if (!stream.write(text)) {
    await once(stream, 'drain')
  }
}

export async function exportTable(
  client: DbWorkerClient,
  req: ExportRequest
): Promise<{ rowsWritten: number }> {
  const cfg = await getConnectionConfig(req.connectionId)
  if (!cfg) throw new Error(`Connection not found: ${req.connectionId}`)
  const columns = await client.call<{ name: string }[]>('listColumns', {
    connectionId: req.connectionId,
    database: req.database,
    table: req.table,
    schema: req.schema
  })
  const columnNames = columns.map((c) => c.name)

  const stream = createWriteStream(req.filePath, { encoding: 'utf-8' })
  let offset = 0
  let total = 0

  try {
    if (req.format === 'csv') {
      await writeChunk(stream, toCsvHeader(columnNames, ',') + '\n')
    } else if (req.format === 'json') {
      await writeChunk(stream, '[\n')
    } else if (req.format === 'sql') {
      const cols = columnNames.map((c) => quoteIdent(cfg.engine, c)).join(', ')
      const target = quoteIdent(cfg.engine, req.table)
      const insertPrefix = `INSERT INTO ${target} (${cols}) VALUES\n`
      await writeChunk(stream, `-- Export tabel ${req.table}\n${insertPrefix}`)
    }

    let firstJson = true
    let firstSql = true
    for (;;) {
      const batch = await client.call<Record<string, unknown>[]>('fetchBatch', {
        connectionId: req.connectionId,
        database: req.database,
        schema: req.schema,
        table: req.table,
        limit: CHUNK_SIZE,
        offset
      })
      if (batch.length === 0) break

      if (req.format === 'csv') {
        let out = ''
        for (const row of batch) {
          out += toCsvRow(columnNames.map((c) => row[c]), ',') + '\n'
        }
        await writeChunk(stream, out)
      } else if (req.format === 'json') {
        let out = ''
        for (const row of batch) {
          out += (firstJson ? '' : ',\n') + JSON.stringify(row)
          firstJson = false
        }
        await writeChunk(stream, out)
      } else {
        let out = ''
        for (const row of batch) {
          const values = columnNames.map((c) => sqlLiteral(cfg.engine, row[c])).join(', ')
          out += (firstSql ? '' : ',\n') + `(${values})`
          firstSql = false
        }
        await writeChunk(stream, out)
      }

      total += batch.length
      offset += CHUNK_SIZE
      if (batch.length < CHUNK_SIZE) break
    }

    if (req.format === 'json') await writeChunk(stream, '\n]\n')
    else if (req.format === 'sql') await writeChunk(stream, ';\n')
  } finally {
    stream.end()
    await once(stream, 'finish')
  }

  return { rowsWritten: total }
}

// Exports a result set the renderer already holds (a query result), so no
// re-query is needed and the exact rows the user sees are what gets written.
export async function exportResultSet(
  req: ResultExportRequest,
  filePath: string
): Promise<{ rowsWritten: number }> {
  const stream = createWriteStream(filePath, { encoding: 'utf-8' })
  try {
    if (req.format === 'csv') {
      await writeChunk(stream, toCsvHeader(req.columns, ',') + '\n')
      let out = ''
      for (const row of req.rows) {
        out += toCsvRow(req.columns.map((c) => row[c]), ',') + '\n'
      }
      await writeChunk(stream, out)
    } else {
      const body = JSON.stringify(req.rows, null, 2)
      await writeChunk(stream, body + '\n')
    }
  } finally {
    stream.end()
    await once(stream, 'finish')
  }
  return { rowsWritten: req.rows.length }
}

export async function previewImport(
  filePath: string,
  delimiter: string,
  hasHeader: boolean,
  sampleSize = 20
): Promise<ImportPreview> {
  // Only the first rows are needed. Reading the whole file made previewing a
  // large export as slow (and as memory-hungry) as importing it.
  const parser = new CsvRowParser(delimiter)
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const collected: string[][] = []
  let headers: string[] | null = null
  try {
    for await (const chunk of stream) {
      for (const raw of parser.push(chunk as string)) {
        if (!headers) {
          headers = hasHeader ? raw : raw.map((_, i) => `column_${i + 1}`)
          if (hasHeader) continue
        }
        collected.push(raw)
        if (collected.length >= sampleSize) break
      }
      if (collected.length >= sampleSize) break
    }
    if (collected.length < sampleSize) {
      for (const raw of parser.end()) {
        if (!headers) {
          headers = hasHeader ? raw : raw.map((_, i) => `column_${i + 1}`)
          if (hasHeader) continue
        }
        collected.push(raw)
        if (collected.length >= sampleSize) break
      }
    }
  } finally {
    stream.destroy()
  }
  return {
    headers: headers ?? [],
    rows: collected,
    sampledRows: collected.length
  }
}

// Reads the CSV incrementally and inserts in batches. The previous version
// loaded the whole file with readFile, so importing a large export could run the
// worker out of memory before a single row was written.
export async function importCsv(
  client: DbWorkerClient,
  req: CsvImportRequest
): Promise<ImportResult> {
  const parser = new CsvRowParser(req.delimiter)
  const input = createReadStream(req.filePath, { encoding: 'utf-8' })

  let sourceHeaders: string[] | null = null
  let headerIndex: Record<string, number> = {}
  const buffer: Record<string, unknown>[] = []
  let inserted = 0
  let failed = 0
  let firstError: string | undefined

  const BATCH = 500

  async function flush(): Promise<void> {
    if (buffer.length === 0) return
    const batch = buffer.splice(0, buffer.length)
    try {
      inserted += await client.call<number>('insertRows', {
        connectionId: req.connectionId,
        database: req.database,
        schema: req.schema,
        table: req.table,
        rows: batch
      })
    } catch (err) {
      failed += batch.length
      if (!firstError) firstError = err instanceof Error ? err.message : String(err)
    }
  }

  function toRecord(raw: string[]): Record<string, unknown> {
    const record: Record<string, unknown> = {}
    for (const source of sourceHeaders ?? []) {
      const target = req.mapping[source]
      if (!target) continue
      const value = raw[headerIndex[source]]
      record[target] = value === undefined || value === '' ? null : value
    }
    return record
  }

  for await (const chunk of input) {
    for (const raw of parser.push(chunk as string)) {
      if (!sourceHeaders) {
        // The first physical row is either the header or, without one, real
        // data that must still be imported (it used to be dropped).
        sourceHeaders = req.hasHeader
          ? raw
          : raw.map((_, i) => `column_${i + 1}`)
        headerIndex = {}
        sourceHeaders.forEach((h, i) => {
          headerIndex[h] = i
        })
        if (req.hasHeader) continue
      }
      buffer.push(toRecord(raw))
      if (buffer.length >= BATCH) await flush()
    }
  }
  for (const raw of parser.end()) {
    if (!sourceHeaders) {
      sourceHeaders = req.hasHeader ? raw : raw.map((_, i) => `column_${i + 1}`)
      headerIndex = {}
      sourceHeaders.forEach((h, i) => {
        headerIndex[h] = i
      })
      if (req.hasHeader) continue
    }
    buffer.push(toRecord(raw))
  }
  await flush()

  return { rowsInserted: inserted, failed, firstError }
}

export async function importSql(
  client: DbWorkerClient,
  req: SqlImportRequest
): Promise<{ statements: number }> {
  const text = await readFile(req.filePath, 'utf-8')
  const result = await client.call<{ length: number }[]>('runQuery', {
    connectionId: req.connectionId,
    sql: text,
    maxRows: 1,
    database: req.database
  })
  return { statements: result.length }
}

export async function showSaveDialog(
  defaultPath: string
): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow()
  const result = await dialog.showSaveDialog(win ?? undefined!, { defaultPath })
  if (result.canceled || !result.filePath) return null
  return result.filePath
}

export async function showOpenDialog(
  filters?: { name: string; extensions: string[] }[]
): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow()
  const result = await dialog.showOpenDialog(win ?? undefined!, {
    properties: ['openFile'],
    filters
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}
