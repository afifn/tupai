import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { writeJsonAtomic } from '../storage/atomicWrite'

// Host keys are checked on first use (TOFU) instead of requiring the user to
// manage a known_hosts file. The first connection to a host records its SHA-256
// fingerprint; every later connection must present the same key. A changed key
// is the signal that matters (re-installed server, or a machine-in-the-middle),
// so it blocks the connection instead of silently trusting the new key.
export type HostKeyStatus = 'new' | 'known' | 'changed'

interface StoredHostKey {
  host: string
  port: number
  fingerprint: string
  firstSeen: number
}

type HostKeyStore = Record<string, StoredHostKey>

// This module is loaded inside the database worker thread as well as the main
// process (SSH tunnels open there), and `electron` is not available in a worker.
// The main process sets TUPAI_USER_DATA before spawning the worker, so both
// sides resolve the same directory without importing electron here.
function userDataDir(): string {
  const dir = process.env.TUPAI_USER_DATA
  if (!dir) {
    throw new Error(
      'TUPAI_USER_DATA belum diset. Proses utama harus menetapkannya sebelum worker dibuat.'
    )
  }
  return dir
}

function storePath(): string {
  return join(userDataDir(), 'known-ssh-hosts.json')
}

function hostKey(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`
}

async function readAll(): Promise<HostKeyStore> {
  try {
    const raw = await readFile(storePath(), 'utf-8')
    const parsed = JSON.parse(raw) as HostKeyStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // A corrupt file must not make every SSH connection fail. Start over: the
    // next connection re-records the key, which is the same trust level as a
    // first use. console.warn is used instead of the app logger because this
    // module also runs in the database worker, where electron is unavailable.
    console.warn('[known-hosts] unreadable, resetting:', String(err))
    return {}
  }
}

async function writeAll(store: HostKeyStore): Promise<void> {
  await writeJsonAtomic(storePath(), store)
}

export interface HostKeyCheck {
  status: HostKeyStatus
  // Set when status is 'changed': the fingerprint recorded earlier.
  previous?: string
}

export function sshFingerprint(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

// Fingerprints already trusted by OpenSSH, so a user who has connected to this
// host from a terminal is not asked to trust it again. Hashed entries
// (|1|salt|hash) cannot be matched without the hostname hash algorithm and are
// skipped; those hosts fall back to TOFU.
async function systemKnownHosts(host: string, port: number): Promise<string[] | null> {
  let text: string
  try {
    text = await readFile(join(homedir(), '.ssh', 'known_hosts'), 'utf-8')
  } catch {
    return null
  }
  const wanted = port === 22 ? host.toLowerCase() : `[${host.toLowerCase()}]:${port}`
  const found: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|')) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    const hosts = parts[0].split(',')
    if (!hosts.some((entry) => entry.toLowerCase() === wanted)) continue
    found.push(sshFingerprint(Buffer.from(parts[2], 'base64')))
  }
  return found
}

// Compares the presented fingerprint with the stored one and records it when
// the host has not been seen before.
export async function checkHostKey(
  host: string,
  port: number,
  fingerprint: string,
  // Strict mode refuses an unknown host instead of recording it. The stored
  // store and ~/.ssh/known_hosts are both consulted first.
  strict = false
): Promise<HostKeyCheck> {
  const store = await readAll()
  const key = hostKey(host, port)
  const existing = store[key]
  if (!existing) {
    const trusted = await systemKnownHosts(host, port)
    if (trusted && trusted.length > 0 && !trusted.includes(fingerprint)) {
      return { status: 'changed', previous: trusted.join(', ') }
    }
    if (trusted?.includes(fingerprint)) {
      store[key] = { host, port, fingerprint, firstSeen: Date.now() }
      await writeAll(store)
      return { status: 'known' }
    }
    if (strict) {
      // Reported as 'changed' with no previous fingerprint: the connection is
      // refused, and the message tells the user the host is simply unknown.
      return { status: 'changed', previous: undefined }
    }
    store[key] = { host, port, fingerprint, firstSeen: Date.now() }
    await writeAll(store)
    return { status: 'new' }
  }
  if (existing.fingerprint === fingerprint) return { status: 'known' }
  return { status: 'changed', previous: existing.fingerprint }
}

// Returns the fingerprint recorded for a host, if any. Used by the connection
// form to show what the app already trusts.
export async function storedFingerprint(
  host: string,
  port: number
): Promise<string | null> {
  const store = await readAll()
  return store[hostKey(host, port)]?.fingerprint ?? null
}

// Removes a recorded key so the next connection is treated as first use. Used
// by the explicit "trust the new key" action after the server was reinstalled.
export async function forgetHostKey(host: string, port: number): Promise<boolean> {
  const store = await readAll()
  const key = hostKey(host, port)
  if (!store[key]) return false
  delete store[key]
  await writeAll(store)
  return true
}
