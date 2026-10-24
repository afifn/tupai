import { useEffect, useState } from 'react'
import { applyTheme, readStoredTheme, storeTheme, type ThemeId } from './themeStore'
import { themeBase } from './theme'

export type Theme = 'light' | 'dark'

export interface UseThemeResult {
  /** Full theme id, including accent presets. */
  themeId: ThemeId
  /** Base palette only, for consumers that just need light vs dark (Monaco). */
  theme: Theme
  setThemeId: (id: ThemeId) => void
  /** Kept for the existing toggle button: flips between light and dark. */
  toggle: () => void
}

export function useTheme(): UseThemeResult {
  const [themeId, setThemeIdState] = useState<ThemeId>(() => readStoredTheme())

  useEffect(() => {
    applyTheme(themeId)
    storeTheme(themeId)
  }, [themeId])

  const theme = themeBase(themeId)

  return {
    themeId,
    theme,
    setThemeId: (id) => setThemeIdState(id),
    // The quick toggle drops an accent preset on purpose: it is a light/dark
    // switch, and silently keeping "dark-forest" while showing "dark" would
    // leave the header icon out of step with the actual palette.
    toggle: () => setThemeIdState(theme === 'dark' ? 'light' : 'dark')
  }
}
