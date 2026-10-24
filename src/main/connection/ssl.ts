import { readFile } from 'fs/promises'
import type { SslOptions } from '@shared/types'

export interface ResolvedSsl {
  enabled: boolean
  mode: NonNullable<SslOptions['mode']>
  ca?: Buffer
  cert?: Buffer
  key?: Buffer
  servername?: string
}

// Normalises the legacy boolean form and loads certificate files. Reading here
// (main process) keeps file access out of the renderer and out of the config.
export async function resolveSsl(
  ssl: boolean | SslOptions | undefined
): Promise<ResolvedSsl | null> {
  if (!ssl) return null
  if (ssl === true) {
    return { enabled: true, mode: 'require' }
  }
  if (!ssl.enabled) return null

  const mode = ssl.mode ?? 'require'
  const read = async (path?: string): Promise<Buffer | undefined> =>
    path ? readFile(path) : undefined

  return {
    enabled: true,
    mode,
    ca: await read(ssl.caPath),
    cert: await read(ssl.certPath),
    key: await read(ssl.keyPath),
    servername: ssl.servername
  }
}

export function sslEnabled(ssl: boolean | SslOptions | undefined): boolean {
  if (!ssl) return false
  return ssl === true ? true : ssl.enabled
}
