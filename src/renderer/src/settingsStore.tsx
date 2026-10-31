import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { unwrap } from './api'
import { applyDocumentLang } from './localeStore'
import {
  DEFAULT_SETTINGS,
  structuredCloneSettings,
  type AppSettings
} from '@shared/settings'
import { applyTheme } from './themeStore'
import { themeBase } from './theme'
import { applyEditorColors } from './monacoSetup'
import { LocaleProvider } from './i18n'
import type { Locale } from '@shared/i18n'

interface SettingsContextValue {
  settings: AppSettings
  /** True until the stored settings have been read once. */
  loading: boolean
  error: string | null
  /** Merge a partial patch into the stored settings and persist it. */
  update: (patch: DeepPartial<AppSettings>) => Promise<void>
  /** Replace the whole object, used by import and reset. */
  replace: (next: AppSettings) => void
  reset: () => Promise<void>
  /** Re-read the stored settings, for changes main made on its own. */
  refresh: () => Promise<void>
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

function mergePatch(base: AppSettings, patch: DeepPartial<AppSettings>): AppSettings {
  const next = structuredCloneSettings(base)
  for (const key of Object.keys(patch) as (keyof AppSettings)[]) {
    const value = patch[key]
    if (value === undefined) continue
    // `customTheme.light.tokens` and `keymap` are maps, not records with a fixed
    // shape, so they are merged shallowly instead of being walked.
    if (key === 'customTheme') {
      const theme = value as DeepPartial<AppSettings['customTheme']>
      // DeepPartial turns the palette map into string|undefined; only real
      // strings are kept so the result still satisfies Record<string, string>.
      const tokens = (
        patch?: DeepPartial<Record<string, string>>
      ): Record<string, string> => {
        const out: Record<string, string> = {}
        for (const [name, color] of Object.entries(patch ?? {})) {
          if (typeof color === 'string') out[name] = color
        }
        return out
      }
      next.customTheme = {
        base:
          theme.base === 'light' || theme.base === 'dark'
            ? theme.base
            : next.customTheme.base,
        light: {
          tokens: { ...next.customTheme.light.tokens, ...tokens(theme.light?.tokens) }
        },
        dark: {
          tokens: { ...next.customTheme.dark.tokens, ...tokens(theme.dark?.tokens) }
        }
      }
      continue
    }
    if (key === 'keymap') {
      next.keymap = { ...next.keymap, ...(value as AppSettings['keymap']) }
      continue
    }
    next[key] = { ...next[key], ...(value as object) } as never
  }
  return next
}

/**
 * Applies the parts of the settings that are not React state: the theme
 * attributes, the document language, and the zoom factor. Running this from one
 * effect keeps the renderer and the stored file from drifting apart.
 */
function applySideEffects(settings: AppSettings): void {
  applyTheme(settings.general.themeId, settings.customTheme)
  // The editor follows the active appearance: a custom theme carries its own
  // light or dark base, and every other theme maps to one.
  const editorBase =
    settings.general.themeId === 'custom'
      ? (settings.customTheme.base ?? 'light')
      : themeBase(settings.general.themeId)
  applyEditorColors(editorBase, settings.editor.syntaxColors)
  applyDocumentLang(settings.general.locale)
  // Electron exposes zoom on the web frame; the factor is clamped by the schema.
  const zoom = settings.display.zoomFactor
  if (Math.abs(window.dbApi.getZoom() - zoom) > 0.001) {
    window.dbApi.setZoom(zoom)
  }

  // The grid font size is a token rather than a prop: every table reads the same
  // custom property, so one assignment reaches the data grid, query results, and
  // the structure panels without threading a prop through each of them.
  document.documentElement.style.setProperty(
    '--grid-font-size',
    `${settings.grid.fontSize + 0.5}px`
  )
}

export function SettingsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(() =>
    structuredCloneSettings(DEFAULT_SETTINGS)
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The locale provider below is keyed on the value so a language change
  // re-renders the whole tree once, instead of every component subscribing.
  const loaded = useRef(false)
  // Saves overlap when controls change quickly (a colour, a slider). Reading the
  // newest settings and tagging each request keeps a slow reply from replacing a
  // newer state or from letting an older patch drop a field added meanwhile.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const saveSeq = useRef(0)

  useEffect(() => {
    let cancelled = false
    unwrap(window.dbApi.getSettings())
      .then((stored) => {
        if (cancelled) return
        setSettings(stored)
        loaded.current = true
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    applySideEffects(settings)
  }, [settings])

  const update = useCallback(async (patch: DeepPartial<AppSettings>): Promise<void> => {
    // Merged onto the newest state, not the one this callback closed over: two
    // controls touched in a row would otherwise each start from the state
    // before the first change and the second save would undo the first.
    const next = mergePatch(settingsRef.current, patch)
    const seq = ++saveSeq.current
    settingsRef.current = next
    setSettings(next)
    try {
      const saved = await unwrap(window.dbApi.saveSettings(next))
      // A newer save is already on its way; its reply is the one that wins.
      if (seq !== saveSeq.current) return
      settingsRef.current = saved
      setSettings(saved)
      setError(null)
    } catch (err) {
      if (seq !== saveSeq.current) return
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const replace = useCallback((next: AppSettings) => {
    settingsRef.current = next
    setSettings(next)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const stored = await unwrap(window.dbApi.getSettings())
      settingsRef.current = stored
      setSettings(stored)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => window.dbApi.onSettingsChanged(() => void refresh()), [refresh])

  const reset = useCallback(async (): Promise<void> => {
    try {
      const saved = await unwrap(window.dbApi.resetSettings())
      setSettings(saved)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, loading, error, update, replace, reset, refresh }),
    [settings, loading, error, update, replace, reset, refresh]
  )

  return (
    <SettingsContext.Provider value={value}>
      <LocaleProvider forcedLocale={settings.general.locale}>{children}</LocaleProvider>
    </SettingsContext.Provider>
  )
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext)
  if (!context) {
    throw new Error('useSettings must be used inside SettingsProvider')
  }
  return context
}

/** Convenience for the many components that only need the editor options. */
export function useEditorSettings(): AppSettings['editor'] {
  return useSettings().settings.editor
}

/** Locale that settings asked for, used before the provider takes over. */
export function settingsLocale(settings: AppSettings): Locale {
  return settings.general.locale
}
