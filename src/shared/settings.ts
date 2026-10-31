import { z } from 'zod'
import type { Locale } from './i18n'
import { LOCALES } from './i18n'
import { KEYMAP_ACTIONS, DEFAULT_KEYMAP, type ActionId, type Keymap } from './keymap'
import type { ThemeId } from './themeTokens'
import type { EditorSyntaxColors } from './editorColors'
import type { LogLevelName } from './logs'

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
  // Editor syntax colours. Empty keeps the shipped colours for the app theme.
  syntaxColors: EditorSyntaxColors
}

export interface GridSettings {
  fontSize: number
  pageSize: number
}

/**
 * How much the app writes to its daily log files, and how long those files are
 * kept. The level is a floor: `warn` also keeps errors, `error` keeps only
 * failures. Sizes are in megabytes so the value stays readable in the UI.
 */
export interface LogSettings {
  level: LogLevelName
  maxFileSizeMb: number
  maxFiles: number
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
  /**
   * Which variant the app renders while the custom theme is active. Without it
   * the dark palette could be edited and never shown, because the theme itself
   * has no CSS block to pick a base from.
   */
  base: 'light' | 'dark'
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
  oracle: OracleSettings
  logs: LogSettings
}

/**
 * Oracle needs an extra step no other engine does: servers older than 12.1 are
 * only reachable through the OCI client library, which the driver cannot ship.
 * An empty directory keeps the driver in thin mode, which is correct for 12.1+
 * and needs no client at all.
 */
export interface OracleSettings {
  /** Folder holding oci.dll (Windows) or libclntsh (macOS/Linux). */
  clientLibDir: string
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
    runSelection: true,
    syntaxColors: {}
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
  customTheme: { base: 'light', light: { tokens: {} }, dark: { tokens: {} } },
  oracle: { clientLibDir: '' },
  logs: {
    level: 'info',
    maxFileSizeMb: 5,
    maxFiles: 14
  }
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
    runSelection: z.boolean(),
    // Each key is optional: a stored palette may set one colour and keep the
    // shipped value for the rest.
    syntaxColors: z
      .object({
        common: z
          .string()
          .regex(/^#([0-9a-fA-F]{6})$/)
          .optional(),
        keyword: z
          .string()
          .regex(/^#([0-9a-fA-F]{6})$/)
          .optional(),
        comment: z
          .string()
          .regex(/^#([0-9a-fA-F]{6})$/)
          .optional(),
        string: z
          .string()
          .regex(/^#([0-9a-fA-F]{6})$/)
          .optional(),
        number: z
          .string()
          .regex(/^#([0-9a-fA-F]{6})$/)
          .optional(),
        background: z
          .string()
          .regex(/^#([0-9a-fA-F]{6})$/)
          .optional()
      })
      .default({})
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
    // A settings file written before the custom theme had a variant has no
    // `base`; defaulting keeps that file valid instead of rejecting it.
    base: z.enum(['light', 'dark']).default('light'),
    light: paletteSchema,
    dark: paletteSchema
  }),
  oracle: z.object({
    // Empty means thin mode. The path is only a folder; the driver resolves the
    // library file itself and reports what it could not find.
    clientLibDir: z.string().max(500)
  }),
  logs: z
    .object({
      // A floor, not a filter: `warn` keeps warnings and errors.
      level: z.enum(['info', 'warn', 'error']),
      maxFileSizeMb: z.number().int().min(1).max(50),
      // Enough history for a fortnight by default without filling the disk.
      maxFiles: z.number().int().min(1).max(100)
    })
    // A settings file written before the Log section existed must keep every
    // other preference instead of being rejected as a whole.
    .default(DEFAULT_SETTINGS.logs)
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
      base: value.customTheme.base,
      light: { tokens: value.customTheme.light.tokens },
      dark: { tokens: value.customTheme.dark.tokens }
    },
    oracle: { ...DEFAULT_SETTINGS.oracle, ...value.oracle },
    logs: { ...DEFAULT_SETTINGS.logs, ...value.logs }
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
    editor: {
      ...settings.editor,
      syntaxColors: { ...settings.editor.syntaxColors }
    },
    grid: { ...settings.grid },
    ai: { ...settings.ai, models: [...settings.ai.models] },
    keymap: { ...settings.keymap },
    customTheme: {
      base: settings.customTheme.base,
      light: { tokens: { ...settings.customTheme.light.tokens } },
      dark: { tokens: { ...settings.customTheme.dark.tokens } }
    },
    oracle: { ...settings.oracle },
    logs: { ...settings.logs }
  }
}

/**
 * The settings file as written to disk. Identical to AppSettings today, but a
 * separate type keeps the door open for a future field that must not be
 * exported (the AI key already lives elsewhere).
 */
export type ExportedSettings = AppSettings
