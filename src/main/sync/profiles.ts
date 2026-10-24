import { app } from 'electron'
import { randomUUID } from 'crypto'
import { readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { writeJsonAtomic } from '../storage/atomicWrite'
import type { SaveSyncProfileInput, SyncProfile } from '@shared/types'

// Profiles live in one JSON file next to the connection store. They only hold
// endpoint identifiers and options; credentials stay in the connection store
// and are never copied here, so a profile can be read without decrypting
// anything.
interface ProfileFile {
  profiles: SyncProfile[]
}

function profilePath(): string {
  return join(app.getPath('userData'), 'sync-profiles.json')
}

async function readAll(): Promise<SyncProfile[]> {
  try {
    const raw = await readFile(profilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ProfileFile>
    if (!Array.isArray(parsed.profiles)) return []
    return parsed.profiles.filter(
      (p): p is SyncProfile =>
        typeof p?.id === 'string' &&
        typeof p?.name === 'string' &&
        (p?.mode === 'structure' || p?.mode === 'data')
    )
  } catch (err) {
    // A missing file is the first-run state, not an error. A corrupt file is
    // also treated as empty so one bad profile cannot block the panel.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    return []
  }
}

export async function listSyncProfiles(): Promise<SyncProfile[]> {
  const profiles = await readAll()
  return profiles.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function saveSyncProfile(input: SaveSyncProfileInput): Promise<SyncProfile> {
  const profiles = await readAll()
  const profile: SyncProfile = {
    id: input.id ?? randomUUID(),
    name: input.name,
    mode: input.mode,
    source: input.source,
    target: input.target,
    tables: input.tables,
    structureOptions: input.structureOptions,
    dataOptions: input.dataOptions,
    updatedAt: Date.now()
  }
  const index = profiles.findIndex((p) => p.id === profile.id)
  if (index >= 0) profiles[index] = profile
  else profiles.push(profile)
  await writeJsonAtomic(profilePath(), { profiles } satisfies ProfileFile, {
    backup: true
  })
  return profile
}

export async function deleteSyncProfile(id: string): Promise<void> {
  const profiles = await readAll()
  const remaining = profiles.filter((p) => p.id !== id)
  if (remaining.length === profiles.length) return
  if (remaining.length === 0) {
    await unlink(profilePath()).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err
    })
    return
  }
  await writeJsonAtomic(profilePath(), { profiles: remaining } satisfies ProfileFile, {
    backup: true
  })
}
