import { app } from 'electron'
import { createWriteStream, type WriteStream } from 'fs'
import { join } from 'path'

type Level = 'info' | 'warn' | 'error'

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

let stream: WriteStream | null = null

function getStream(): WriteStream | null {
  if (stream) return stream
  try {
    stream = createWriteStream(join(app.getPath('userData'), 'db-manager.log'), {
      flags: 'a'
    })
  } catch {
    stream = null
  }
  return stream
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

export function log(level: Level, message: string, context?: unknown): void {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    context: context === undefined ? undefined : redact(context)
  }
  const line = JSON.stringify(entry)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  getStream()?.write(line + '\n')
}
