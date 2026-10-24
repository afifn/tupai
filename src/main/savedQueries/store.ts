import { app } from 'electron'
import { readFile, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import { writeAtomic } from '../storage/atomicWrite'
import { randomUUID } from 'crypto'
import type { SaveQueryInput, SavedQuery } from '@shared/types'

// Each saved query is a standalone .sql file so users can import/export them
// with any editor, matching Navicat's file-per-query model.
const HEADER_RE = /^--\s*db-manager-query:\s*(\{.*\})\s*$/m

function queriesDir(): string {
  return join(app.getPath('userData'), 'queries')
}

function fileFor(id: string): string {
  return join(queriesDir(), `${id}.sql`)
}

function toFile(query: SavedQuery): string {
  const meta = {
    id: query.id,
    connectionId: query.connectionId,
    database: query.database,
    schema: query.schema,
    name: query.name,
    updatedAt: query.updatedAt
  }
  return `-- db-manager-query: ${JSON.stringify(meta)}\n${query.sql}\n`
}

function parseFile(content: string, fallbackId: string): SavedQuery | null {
  const match = HEADER_RE.exec(content)
  if (!match) return null
  try {
    const meta = JSON.parse(match[1]) as Partial<SavedQuery>
    const sql = content.replace(HEADER_RE, '').trim()
    return {
      id: meta.id ?? fallbackId,
      connectionId: meta.connectionId ?? '',
      database: meta.database ?? '',
      schema: meta.schema,
      name: meta.name ?? fallbackId,
      sql,
      updatedAt: meta.updatedAt ?? Date.now()
    }
  } catch {
    return null
  }
}

async function readAll(): Promise<SavedQuery[]> {
  let files: string[]
  try {
    files = await readdir(queriesDir())
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const queries: SavedQuery[] = []
  for (const file of files) {
    if (!file.endsWith('.sql')) continue
    try {
      const content = await readFile(join(queriesDir(), file), 'utf-8')
      const parsed = parseFile(content, file.replace(/\.sql$/, ''))
      if (parsed) queries.push(parsed)
    } catch {
      // skip unreadable file
    }
  }
  return queries
}

export async function listSavedQueries(connectionId: string): Promise<SavedQuery[]> {
  const queries = await readAll()
  return queries
    .filter((q) => q.connectionId === connectionId)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function saveQuery(input: SaveQueryInput): Promise<SavedQuery> {
  const query: SavedQuery = {
    id: input.id ?? randomUUID(),
    connectionId: input.connectionId,
    database: input.database,
    schema: input.schema,
    name: input.name,
    sql: input.sql,
    updatedAt: Date.now()
  }
  await writeAtomic(fileFor(query.id), toFile(query))
  return query
}

export async function deleteSavedQuery(id: string): Promise<void> {
  try {
    await unlink(fileFor(id))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

export async function exportSavedQuery(id: string, targetPath: string): Promise<void> {
  const queries = await readAll()
  const query = queries.find((q) => q.id === id)
  if (!query) throw new Error(`Query not found: ${id}`)
  await writeAtomic(targetPath, toFile(query))
}

export async function importSavedQuery(
  filePath: string,
  connectionId: string
): Promise<SavedQuery> {
  const content = await readFile(filePath, 'utf-8')
  const fallbackName = filePath.split(/[\\/]/).pop()?.replace(/\.sql$/i, '') ?? 'Query'
  const parsed = parseFile(content, randomUUID())
  const query: SavedQuery = parsed
    ? {
        ...parsed,
        id: randomUUID(),
        connectionId,
        name: parsed.name || fallbackName,
        updatedAt: Date.now()
      }
    : {
        id: randomUUID(),
        connectionId,
        database: '',
        name: fallbackName,
        sql: content.trim(),
        updatedAt: Date.now()
      }
  await writeAtomic(fileFor(query.id), toFile(query))
  return query
}
