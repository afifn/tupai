import { z } from 'zod'
import type { Locale } from './i18n'
import { LOCALES } from './i18n'
import { KEYMAP_ACTIONS, DEFAULT_KEYMAP, type ActionId, type Keymap } from './keymap'
import type { ThemeId } from './themeTokens'

// One settings object for the whole app. It lives in the main process so it can
// be written atomically next to the other stores, exported as one file, and
// read before the window paints.
//
// Secrets are deliberately absent: the AI API key stays in ai-settings.json
// behind safeStorage, and no connection password ever reaches this file. That is
// what makes "export settings" safe to share.

export interface GeneralSettings {
  locale: Locale
  themeId: ThemeId
  // Ask before closing a tab with unsaved SQL.
  confirmOnClose: boolean
}

export interface DisplaySettings {
  // Electron zoom factor. 1 is 100%.
  zoomFactor: number
}

export interface EditorSettings {
  fontFamily: string
  fontSize: number
  tabSize: 2 | 4 | 8
  wordWrap: boolean
  minimap: boolean
  lineNumbers: boolean
  // Cmd+Enter runs only the selection when true, the whole tab otherwise.
  runSelection: boolean
}

export interface GridSettings {
  fontSize: number
  pageSize: number
}

export interface AiSettingsShape {
  baseUrl: string
  model: string
  // Models returned by the last "fetch models" call. Kept so the picker is
  // populated on the next launch without asking the server again.
  models: string[]
  temperature: number
  maxTokens: number
  systemPrompt: string
  // Runs the first SELECT of a reply and shows up to AI_PREVIEW_ROWS rows under
  // the answer. Off means the panel only offers the SQL block.
  previewRows: boolean
}

/** Per-base-theme palette override for the `custom` theme. */
export interface CustomPalette {
  // Token name to CSS colour, e.g. { '--bg': '#ffffff' }.
  tokens: Record<string, string>
}

export interface CustomTheme {
  light: CustomPalette
  dark: CustomPalette
}

export interface AppSettings {
  general: GeneralSettings
  display: DisplaySettings
  editor: EditorSettings
  grid: GridSettings
  ai: AiSettingsShape
  keymap: Keymap
  customTheme: CustomTheme
}

export const MONO_FONTS = [
  "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
  "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
  "Consolas, 'Courier New', monospace",
  "'Fira Code', Consolas, monospace"
]

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    locale: 'en',
    themeId: 'light',
    confirmOnClose: true
  },
  display: {
    zoomFactor: 1
  },
  editor: {
    fontFamily: MONO_FONTS[0],
    fontSize: 13,
    tabSize: 2,
    wordWrap: false,
    minimap: false,
    lineNumbers: true,
    runSelection: true
  },
  grid: {
    fontSize: 12,
    pageSize: 50
  },
  ai: {
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    models: [],
    temperature: 0.2,
    maxTokens: 2048,
    systemPrompt: '',
    previewRows: true
  },
  keymap: { ...DEFAULT_KEYMAP },
  customTheme: { light: { tokens: {} }, dark: { tokens: {} } }
}

const paletteSchema = z.object({
  // Six digits, or eight when the palette carries an alpha (the overlay token).
  tokens: z.record(z.string().regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/)).default({})
})

const keymapShape = Object.fromEntries(
  KEYMAP_ACTIONS.map((action) => [
    action,
    z
      .string()
      .max(40)
      // Modifiers, then a key: a single character, a named key such as Enter,
      // or the plus key itself (`Mod++`).
      .regex(/^([A-Za-z]+\+)*(\+|[^+\s]+)$/)
      .optional()
  ])
) as Record<ActionId, z.ZodOptional<z.ZodString>>

export const appSettingsSchema = z.object({
  general: z.object({
    locale: z.enum(LOCALES as [Locale, ...Locale[]]),
    themeId: z.enum(['light', 'dark', 'light-ocean', 'dark-forest', 'custom']),
    confirmOnClose: z.boolean()
  }),
  display: z.object({
    // Electron clamps zoom to 0.25-5; the UI offers a narrower, usable range.
    zoomFactor: z.number().min(0.8).max(1.5)
  }),
  editor: z.object({
    fontFamily: z.string().min(1).max(120),
    fontSize: z.number().int().min(11).max(20),
    tabSize: z.union([z.literal(2), z.literal(4), z.literal(8)]),
    wordWrap: z.boolean(),
    minimap: z.boolean(),
    lineNumbers: z.boolean(),
    runSelection: z.boolean()
  }),
  grid: z.object({
    fontSize: z.number().int().min(11).max(16),
    pageSize: z.union([z.literal(50), z.literal(100), z.literal(200)])
  }),
  ai: z.object({
    baseUrl: z.string().min(1).max(500),
    model: z.string().max(120),
    models: z.array(z.string().min(1).max(120)).max(500).default([]),
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().min(1).max(200000),
    systemPrompt: z.string().max(8000),
    previewRows: z.boolean()
  }),
  keymap: z.object(keymapShape),
  customTheme: z.object({
    light: paletteSchema,
    dark: paletteSchema
  })
})

/**
 * Fill in anything the stored file does not have.
 *
 * This is what makes adding a setting a non-event: an old settings.json simply
 * gets the new default, and a value that no longer validates falls back to the
 * default instead of failing to load and losing everything else.
 */
export function mergeSettings(raw: unknown): AppSettings {
  const parsed = appSettingsSchema.safeParse(raw)
  if (!parsed.success) return structuredCloneSettings(DEFAULT_SETTINGS)
  const value = parsed.data
  return {
    general: { ...DEFAULT_SETTINGS.general, ...value.general },
    display: { ...DEFAULT_SETTINGS.display, ...value.display },
    editor: { ...DEFAULT_SETTINGS.editor, ...value.editor },
    grid: { ...DEFAULT_SETTINGS.grid, ...value.grid },
    ai: { ...DEFAULT_SETTINGS.ai, ...value.ai },
    keymap: { ...DEFAULT_SETTINGS.keymap, ...value.keymap },
    customTheme: {
      light: { tokens: value.customTheme.light.tokens },
      dark: { tokens: value.customTheme.dark.tokens }
    }
  }
}

/**
 * Cleans the cached model ids: trims, drops blanks, removes duplicates, and
 * sorts so the dropdown order does not depend on the server. Capped because the
 * list is user-visible and stored in settings.json.
 */
export function normaliseModelIds(ids: readonly string[]): string[] {
  const unique = new Set<string>()
  for (const id of ids) {
    const trimmed = id.trim()
    if (trimmed) unique.add(trimmed)
  }
  return [...unique].sort().slice(0, 500)
}

/** Deep copy so a caller mutating the result cannot change the defaults. */
export function structuredCloneSettings(settings: AppSettings): AppSettings {
  return {
    general: { ...settings.general },
    display: { ...settings.display },
    editor: { ...settings.editor },
    grid: { ...settings.grid },
    ai: { ...settings.ai, models: [...settings.ai.models] },
    keymap: { ...settings.keymap },
    customTheme: {
      light: { tokens: { ...settings.customTheme.light.tokens } },
      dark: { tokens: { ...settings.customTheme.dark.tokens } }
    }
  }
}

/**
 * The settings file as written to disk. Identical to AppSettings today, but a
 * separate type keeps the door open for a future field that must not be
 * exported (the AI key already lives elsewhere).
 */
export type ExportedSettings = AppSettings
