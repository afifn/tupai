import type { MessageKey } from '@shared/i18n'
import { THEME_IDS, THEME_PRESETS, type ThemeId } from '@shared/themeTokens'

export interface ThemeDefinition {
  id: ThemeId
  /** Base palette the theme builds on. Monaco only needs to know this. */
  base: 'light' | 'dark'
  /** Value written to `data-theme-preset`, or null for the base palettes. */
  preset: string | null
  /**
   * Catalogue key for the label, not the label itself: the name has to change
   * with the interface language, and keeping the text here would mean two
   * places to translate.
   */
  labelKey: MessageKey
}

export const THEMES: ThemeDefinition[] = [
  { id: 'light', base: 'light', preset: null, labelKey: 'settings.themeLight' },
  { id: 'dark', base: 'dark', preset: null, labelKey: 'settings.themeDark' },
  {
    id: 'light-ocean',
    base: 'light',
    preset: 'ocean',
    labelKey: 'settings.themeLightOcean'
  },
  {
    id: 'dark-forest',
    base: 'dark',
    preset: 'forest',
    labelKey: 'settings.themeDarkForest'
  },
  // The palette comes from the settings file, so there is no CSS block for it.
  { id: 'custom', base: 'light', preset: null, labelKey: 'settings.themeCustom' }
]

export const DEFAULT_THEME_ID: ThemeId = 'light'

export function isThemeId(value: string | null): value is ThemeId {
  return value !== null && (THEME_IDS as readonly string[]).includes(value)
}

export function themeById(id: ThemeId): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]
}

/** Base palette for a theme id. Unknown ids fall back to light. */
export function themeBase(id: string | null): 'light' | 'dark' {
  return isThemeId(id) ? themeById(id).base : 'light'
}

export { THEME_PRESETS }
export type { ThemeId }
