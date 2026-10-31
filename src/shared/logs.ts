// Pure log naming and retention rules, shared so they can be tested without
// writing files. The writer in main/logger.ts applies them to the Logs folder.

export type LogLevelName = 'info' | 'warn' | 'error'

export const LOG_LEVELS: LogLevelName[] = ['info', 'warn', 'error']

const RANK: Record<LogLevelName, number> = { info: 0, warn: 1, error: 2 }

/** Local calendar day as YYYYMMDD, matching the file name users see. */
export function formatLogDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/**
 * `tupai-20261031.log` for the first file of a day, then `-02`, `-03` when the
 * size cap forces another file that same day.
 */
export function logFileName(dateKey: string, part: number): string {
  const suffix = part > 1 ? `-${String(part).padStart(2, '0')}` : ''
  return `tupai-${dateKey}${suffix}.log`
}

/** True when `level` is at or above the configured minimum. */
export function shouldLog(level: LogLevelName, minimum: LogLevelName): boolean {
  return RANK[level] >= RANK[minimum]
}

/** True when appending `incomingBytes` would exceed the per-file cap. */
export function shouldRotate(
  currentBytes: number,
  incomingBytes: number,
  maxBytes: number
): boolean {
  return currentBytes > 0 && currentBytes + incomingBytes > maxBytes
}

/**
 * Names to delete so at most `maxFiles` remain. Oldest modification time goes
 * first; a tie falls back to the name so the result is deterministic.
 */
export function filesToDelete<T extends { name: string; mtimeMs: number }>(
  files: readonly T[],
  maxFiles: number
): string[] {
  if (files.length <= maxFiles) return []
  const ordered = [...files].sort(
    (a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name)
  )
  return ordered.slice(0, files.length - maxFiles).map((file) => file.name)
}
