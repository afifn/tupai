import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { writeJsonAtomic } from '../storage/atomicWrite'
import type { AiSettings, AiSettingsInput } from '@shared/types'
import { normaliseModelIds } from '@shared/settings'
import { decryptSecret, encryptSecret } from '../connection/secrets'
import { readSettings, writeSettings } from '../settings/store'

// The API key is the only secret here. Everything else (base URL, model, the
// cached model list, temperature, token cap, system prompt) lives in
// settings.json, so the Settings dialog edits one file and the AI client reads
// the same values. Keeping a second copy of the model in this file is how a
// model change in Settings used to have no effect.
//
// The key cannot move: safeStorage encrypts it, and settings.json is the file
// users export and share.

interface StoredSecret {
  apiKeyCipher?: string
}

export const DEFAULT_SYSTEM_PROMPT = [
  'Kamu asisten SQL di aplikasi desktop manajemen database.',
  'Jawab dalam bahasa yang dipakai pengguna, langsung ke inti.',
  '',
  'Gaya jawaban:',
  '- Mulai dari jawaban, bukan pengantar. Tanpa "Tentu", "Baik", "Tentu saja", atau pujian.',
  '- Tanpa basa-basi penutup seperti "Semoga membantu" atau "Silakan bertanya lagi".',
  '- Tanpa emoji, tanpa tanda pisah panjang, tanpa huruf kapital berlebih.',
  '- Satu ide per kalimat. Hindari kata pemasaran: powerful, seamless, revolusioner, canggih.',
  '- Jangan mengulang pertanyaan pengguna sebelum menjawab.',
  '',
  'Isi jawaban:',
  '- Sebutkan engine yang dituju saat menulis SQL.',
  '- Gunakan identifier yang valid untuk engine itu.',
  '- Tulis setiap SQL di dalam blok berpagar ```sql, satu blok per jawaban.',
  '- Jangan memakai tabel markdown atau judul; panel ini sempit. Pakai daftar pendek bila perlu.',
  '- Jangan mengarang tabel atau kolom. Bila konteks tidak memuatnya, tulis bahwa datanya tidak tersedia.',
  '- Bila permintaan ambigu, tanyakan satu hal yang paling menentukan, bukan daftar pertanyaan.'
].join('\n')

function secretPath(): string {
  return join(app.getPath('userData'), 'ai-key.json')
}

// The old file held the full settings plus the key. It is read once so an
// upgrade keeps the key and the values the user already chose.
function legacyPath(): string {
  return join(app.getPath('userData'), 'ai-settings.json')
}

async function readSecret(): Promise<StoredSecret> {
  try {
    const raw = await readFile(secretPath(), 'utf-8')
    const parsed = JSON.parse(raw) as StoredSecret
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

async function writeSecret(record: StoredSecret): Promise<void> {
  await writeJsonAtomic(secretPath(), record, { backup: true })
}

// Same rule as connection passwords: refuse to save rather than write an empty
// value that looks saved but can never be read back. The shared helper keeps one
// message and one code path for every secret in the app.
const SUBJECT_API_KEY = 'API key'

function normaliseBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  const url = new URL(trimmed)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL harus http:// atau https://')
  }
  return trimmed
}

let migrated = false

/**
 * Move a legacy ai-settings.json into settings.json once, keeping the key in its
 * own file. Runs lazily so a read-only profile cannot block startup.
 */
async function migrateLegacy(): Promise<void> {
  if (migrated) return
  migrated = true
  try {
    const raw = await readFile(legacyPath(), 'utf-8')
    const legacy = JSON.parse(raw) as {
      baseUrl?: string
      apiKeyCipher?: string
      model?: string
      temperature?: number
      maxTokens?: number
      systemPrompt?: string
    }
    if (legacy.apiKeyCipher) {
      const existing = await readSecret()
      if (!existing.apiKeyCipher) {
        await writeSecret({ apiKeyCipher: legacy.apiKeyCipher })
      }
    }
    const settings = await readSettings()
    const next = {
      ...settings,
      ai: {
        ...settings.ai,
        baseUrl: legacy.baseUrl?.trim() || settings.ai.baseUrl,
        model: legacy.model ?? settings.ai.model,
        temperature: legacy.temperature ?? settings.ai.temperature,
        maxTokens: legacy.maxTokens ?? settings.ai.maxTokens,
        systemPrompt: legacy.systemPrompt ?? settings.ai.systemPrompt
      }
    }
    await writeSettings(next)
  } catch {
    // No legacy file, or it is unreadable: nothing to migrate.
  }
}

export async function getAiSettings(): Promise<AiSettings> {
  await migrateLegacy()
  const settings = await readSettings()
  const secret = await readSecret()
  return {
    baseUrl: settings.ai.baseUrl,
    model: settings.ai.model,
    models: settings.ai.models,
    temperature: settings.ai.temperature,
    maxTokens: settings.ai.maxTokens,
    previewRows: settings.ai.previewRows,
    // The stored prompt may be empty, meaning "use the app default". Resolving
    // it here keeps every caller from repeating the fallback.
    systemPrompt: settings.ai.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
    hasApiKey: Boolean(secret.apiKeyCipher)
  }
}

/** The model list cached by the last successful fetch, for the dropdown. */
export async function getAiModels(): Promise<string[]> {
  const settings = await readSettings()
  return settings.ai.models
}

export async function saveAiModels(models: string[]): Promise<string[]> {
  const settings = await readSettings()
  const unique = normaliseModelIds(models)
  await writeSettings({ ...settings, ai: { ...settings.ai, models: unique } })
  return unique
}

// Returns the API key for main-process use only. Callers must never forward it
// to the renderer.
export async function getAiApiKey(): Promise<string> {
  await migrateLegacy()
  const secret = await readSecret()
  return decryptSecret(secret.apiKeyCipher)
}

export async function saveAiSettings(input: AiSettingsInput): Promise<AiSettings> {
  await migrateLegacy()
  if (input.apiKey) {
    const secret = await readSecret()
    await writeSecret({
      ...secret,
      apiKeyCipher: await encryptSecret(input.apiKey, SUBJECT_API_KEY)
    })
  }
  const settings = await readSettings()
  await writeSettings({
    ...settings,
    ai: {
      ...settings.ai,
      baseUrl: normaliseBaseUrl(input.baseUrl),
      model: input.model ?? settings.ai.model,
      temperature: input.temperature ?? settings.ai.temperature,
      maxTokens: input.maxTokens ?? settings.ai.maxTokens,
      systemPrompt: input.systemPrompt ?? settings.ai.systemPrompt,
      previewRows: input.previewRows ?? settings.ai.previewRows
    }
  })
  return getAiSettings()
}
