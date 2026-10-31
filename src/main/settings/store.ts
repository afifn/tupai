import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { writeJsonAtomic } from '../storage/atomicWrite'
import type { AppInfo } from '@shared/types'
import { activeLogPath } from '../logger'
import {
  DEFAULT_SETTINGS,
  appSettingsSchema,
  mergeSettings,
  structuredCloneSettings,
  type AppSettings
} from '@shared/settings'

// The single settings file. It lives beside connections.json and uses the same
// atomic write, so a crash mid-save cannot leave a half-written file that fails
// to parse on the next launch.
//
// Settings are not secrets: the AI key stays in ai-settings.json behind
// safeStorage, and connection passwords never leave the connection store. That
// separation is what makes exporting this file safe.

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export async function readSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(), 'utf-8')
    return mergeSettings(JSON.parse(raw))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // Missing file is the first-run case; unreadable JSON is a corrupt file.
    // Both fall back to defaults instead of blocking startup.
    if (code === 'ENOENT' || err instanceof SyntaxError) {
      return structuredCloneSettings(DEFAULT_SETTINGS)
    }
    throw err
  }
}

/**
 * Validate before writing. A renderer bug must not be able to persist a value
 * that fails its own schema and then load as defaults, silently reverting the
 * user's other settings.
 */
export async function writeSettings(next: AppSettings): Promise<AppSettings> {
  const parsed = appSettingsSchema.parse(next)
  const merged = mergeSettings(parsed)
  await writeJsonAtomic(settingsPath(), merged, { backup: true })
  return merged
}

export async function resetSettings(): Promise<AppSettings> {
  return writeSettings(structuredCloneSettings(DEFAULT_SETTINGS))
}

export function settingsFilePath(): string {
  return settingsPath()
}

// Injected by electron.vite.config.ts at build time; 'dev' when running from
// source, so the About page never claims a commit that does not exist.
declare const __BUILD_SHA__: string | undefined
declare const __BUILD_TIME__: string | undefined

export function appInfo(): AppInfo {
  return {
    version: app.getVersion(),
    buildSha: typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'dev',
    buildTime: typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'dev',
    packaged: app.isPackaged,
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
    logFile: activeLogPath()
  }
}
