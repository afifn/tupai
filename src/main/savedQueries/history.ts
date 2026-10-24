import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { writeJsonAtomic } from '../storage/atomicWrite'
import { randomUUID } from 'crypto'
import type { QueryHistoryEntry } from '@shared/types'

// History is a single JSON file per connection: it is append-heavy and read as
// a whole list, unlike saved queries which are user-edited files.
const MAX_ENTRIES = 300

function historyFile(connectionId: string): string {
  // Connection ids are UUIDs, but sanitise anyway so a bad id cannot escape
  // the history directory.
  const safe = connectionId.replace(/[^A-Za-z0-9_-]/g, '_')
  return join(app.getPath('userData'), 'history', `${safe}.json`)
}

async function readAll(connectionId: string): Promise<QueryHistoryEntry[]> {
  try {
    const text = await readFile(historyFile(connectionId), 'utf-8')
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as QueryHistoryEntry[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    return []
  }
}

export async function listQueryHistory(
  connectionId: string
): Promise<QueryHistoryEntry[]> {
  const all = await readAll(connectionId)
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

export async function addQueryHistory(
  input: Omit<QueryHistoryEntry, 'id' | 'createdAt'>
): Promise<QueryHistoryEntry> {
  const entry: QueryHistoryEntry = {
    ...input,
    id: randomUUID(),
    createdAt: Date.now()
  }
  const all = await readAll(input.connectionId)
  // Skip an immediate duplicate (same SQL as the newest entry) so re-running a
  // query does not fill the list with copies.
  const newest = all.sort((a, b) => b.createdAt - a.createdAt)[0]
  if (newest && newest.sql.trim() === entry.sql.trim() && newest.ok === entry.ok) {
    return newest
  }
  all.push(entry)
  all.sort((a, b) => b.createdAt - a.createdAt)
  const trimmed = all.slice(0, MAX_ENTRIES)
  await writeJsonAtomic(historyFile(input.connectionId), trimmed)
  return entry
}

export async function clearQueryHistory(connectionId: string): Promise<void> {
  await writeJsonAtomic(historyFile(connectionId), [])
}
