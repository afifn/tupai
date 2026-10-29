import { DEFAULT_THEME_ID, isThemeId, THEMES, themeById, type ThemeId } from './theme'
import { resolvePalette, validatePalette } from '@shared/customTheme'
import type { CustomTheme } from '@shared/settings'

// Theme persistence and the two attributes the CSS reads.
//
// `data-theme` selects the base palette (light/dark) and `data-theme-preset`
// selects an accent override. They are separate so an unknown or future preset
// still renders a valid base theme instead of falling back to unstyled colours.

const THEME_KEY = 'db-manager-theme'

export function readStoredTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (isThemeId(stored)) return stored
  } catch {
    // localStorage can throw when the profile is read-only.
  }
  // Same fallback as before the theme registry existed: follow the OS, so a
  // user who never picked a theme does not get a white flash at night.
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return DEFAULT_THEME_ID
  }
}

export function storeTheme(id: ThemeId): void {
  try {
    localStorage.setItem(THEME_KEY, id)
  } catch {
    // Ignore: the in-memory state still drives the current session.
  }
}

// Tokens written inline by a custom palette. Kept in a module-level list so a
// switch back to a shipped theme can remove exactly what it added instead of
// guessing which custom properties belong to the theme.
let appliedCustomTokens: string[] = []

export function applyTheme(id: ThemeId, custom?: CustomTheme): void {
  const root = document.documentElement
  for (const token of appliedCustomTokens) root.style.removeProperty(token)
  appliedCustomTokens = []

  const theme = themeById(id)
  root.dataset.theme = theme.base
  if (theme.preset) root.dataset.themePreset = theme.preset
  else delete root.dataset.themePreset

  // `custom` has no CSS block: its palette is resolved from the settings file
  // and written as inline custom properties on top of the base palette.
  //
  // Only a palette that passes its contrast checks is applied. Editing a colour
  // in the Settings page updates the file as you type, and applying an
  // unreadable value here would repaint the dialog itself white-on-white before
  // the user could see the warning. The editor previews on its own subtree
  // instead; the app follows once the palette is valid.
  if (id === 'custom' && custom) {
    const tokens = resolvePalette(theme.base, custom[theme.base].tokens)
    const valid = validatePalette(tokens).ok
    const applied = valid ? tokens : resolvePalette(theme.base, {})
    for (const [token, value] of Object.entries(applied)) {
      root.style.setProperty(token, value)
      appliedCustomTokens.push(token)
    }
  }
}

export { THEMES, type ThemeId }
