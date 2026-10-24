import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { writeJsonAtomic } from '../storage/atomicWrite'
import { randomUUID } from 'crypto'
import type { ConnectionGroup } from '@shared/types'

// Groups live in their own file so they can be created, renamed, and deleted
// independently of the connections inside them.
function groupsPath(): string {
  return join(app.getPath('userData'), 'connection-groups.json')
}

async function readAll(): Promise<ConnectionGroup[]> {
  try {
    const raw = await readFile(groupsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ConnectionGroup[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function writeAll(groups: ConnectionGroup[]): Promise<void> {
  await writeJsonAtomic(groupsPath(), groups, { backup: true })
}

export async function listConnectionGroups(): Promise<ConnectionGroup[]> {
  const groups = await readAll()
  return groups.sort((a, b) => a.name.localeCompare(b.name))
}

export async function saveConnectionGroup(input: {
  id?: string
  name: string
}): Promise<ConnectionGroup> {
  const name = input.name.trim()
  if (!name) throw new Error('Nama grup wajib diisi.')
  const groups = await readAll()
  const existing = input.id ? groups.find((g) => g.id === input.id) : undefined
  const group: ConnectionGroup = existing
    ? { ...existing, name }
    : { id: randomUUID(), name, createdAt: Date.now() }
  if (existing) {
    const index = groups.findIndex((g) => g.id === existing.id)
    groups[index] = group
  } else {
    groups.push(group)
  }
  await writeAll(groups)
  return group
}

export async function deleteConnectionGroup(id: string): Promise<void> {
  const groups = await readAll()
  await writeAll(groups.filter((g) => g.id !== id))
}
