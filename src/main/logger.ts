import { app } from 'electron'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'fs'
import { join } from 'path'
import type { LogSettings } from '@shared/settings'
import {
  filesToDelete,
  formatLogDate,
  logFileName,
  shouldLog,
  shouldRotate,
  type LogLevelName
} from '@shared/logs'
import type { LogFileInfo, LogFilesInfo } from '@shared/types'

const SECRET_KEYS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization'
]

let config: LogSettings = { level: 'info', maxFileSizeMb: 5, maxFiles: 14 }
let currentDate: string | null = null
let currentPart = 1
let currentBytes = 0
let writes = 0
let migratedLegacy = false

function directory(): string {
  return join(app.getPath('userData'), 'Logs')
}

function ensureDirectory(): boolean {
  try {
    mkdirSync(directory(), { recursive: true })
    return true
  } catch {
    return false
  }
}

/**
 * The old single file sat in the profile root. Keep its content by moving it
 * into Logs once, under a name the rotation rules never reuse.
 */
function migrateLegacyFile(): void {
  if (migratedLegacy) return
  migratedLegacy = true
  const legacy = join(app.getPath('userData'), 'db-manager.log')
  const target = join(directory(), 'tupai-legacy.log')
  try {
    if (!existsSync(legacy) || existsSync(target)) return
    ensureDirectory()
    renameSync(legacy, target)
  } catch {
    // A locked or read-only profile must not stop the app from logging.
  }
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.includes(k.toLowerCase())) {
        out[k] = v ? '[redacted]' : v
      } else {
        out[k] = redact(v, depth + 1)
      }
    }
    return out
  }
  return value
}

/** Highest daily part already on disk, so a restart keeps appending. */
function latestPart(dateKey: string, dir: string): number {
  let part = 1
  try {
    for (const name of readdirSync(dir)) {
      const match = name.match(new RegExp(`^tupai-${dateKey}(?:-(\\d{2}))?\\.log$`))
      if (!match) continue
      part = Math.max(part, match[1] ? Number.parseInt(match[1], 10) : 1)
    }
  } catch {
    // The directory may not exist yet; the first write creates it.
  }
  return part
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function logFiles(): Array<LogFileInfo & { mtimeMs: number }> {
  const dir = directory()
  try {
    return readdirSync(dir)
      .filter((name) => /^tupai-\d{8}(?:-\d{2})?\.log$|^tupai-legacy\.log$/.test(name))
      .map((name) => {
        const stat = statSync(join(dir, name))
        return {
          name,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          mtimeMs: stat.mtimeMs
        }
      })
  } catch {
    return []
  }
}

/** Drop the oldest files so the folder never exceeds the configured count. */
function enforceRetention(): void {
  const dir = directory()
  for (const name of filesToDelete(logFiles(), config.maxFiles)) {
    try {
      unlinkSync(join(dir, name))
    } catch {
      // Another process may hold the file; the next pass retries.
    }
  }
}

export function logDirectoryPath(): string {
  return directory()
}

/** The file the next log line will land in, whether or not it exists yet. */
export function activeLogPath(): string {
  const nowKey = formatLogDate(new Date())
  if (currentDate !== nowKey) {
    return join(directory(), logFileName(nowKey, latestPart(nowKey, directory())))
  }
  return join(directory(), logFileName(currentDate ?? nowKey, currentPart))
}

export function listLogFiles(): LogFilesInfo {
  const files = logFiles()
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ name, size, modifiedAt }) => ({ name, size, modifiedAt }))
  return { dir: directory(), active: activeLogPath(), files }
}

/**
 * Apply the saved preferences. Called at startup and after a settings save, so
 * a new level or cap takes effect without a restart.
 */
export function configureLogger(next: LogSettings): void {
  config = { ...next }
  migratedLegacy = false
  migrateLegacyFile()
  if (!ensureDirectory()) return
  // Re-read the active file so lowering the cap applies to the next line.
  currentDate = null
  currentBytes = 0
  currentPart = 1
  enforceRetention()
}

export function log(level: LogLevelName, message: string, context?: unknown): void {
  if (!shouldLog(level, config.level)) return
  const now = new Date()
  const dateKey = formatLogDate(now)
  if (!ensureDirectory()) return
  migrateLegacyFile()

  if (dateKey !== currentDate) {
    currentDate = dateKey
    currentPart = latestPart(dateKey, directory())
    currentBytes = sizeOf(join(directory(), logFileName(dateKey, currentPart)))
  }

  const entry = {
    time: now.toISOString(),
    level,
    message,
    context: context === undefined ? undefined : redact(context)
  }
  const line = `${JSON.stringify(entry)}\n`
  const bytes = Buffer.byteLength(line)
  const maxBytes = config.maxFileSizeMb * 1024 * 1024
  if (shouldRotate(currentBytes, bytes, maxBytes)) {
    currentPart += 1
    currentBytes = 0
  }

  const path = join(directory(), logFileName(dateKey, currentPart))
  try {
    appendFileSync(path, line)
    currentBytes += bytes
    writes += 1
    if (writes % 25 === 0 || currentPart > 1) enforceRetention()
  } catch (err) {
    // Logging must never take the app down, and must not log its own failure
    // through the same path.
    console.error('log write failed', err)
    return
  }

  const text = line.trimEnd()
  if (level === 'error') console.error(text)
  else if (level === 'warn') console.warn(text)
  else console.log(text)
}
