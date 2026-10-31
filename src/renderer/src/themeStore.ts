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
// The last state written to the document. Settings are saved on every control
// change, and re-removing and re-adding the palette on an unrelated change made
// the whole window repaint for a frame, which reads as a blink.
let appliedSignature = ''

export function applyTheme(id: ThemeId, custom?: CustomTheme): void {
  const root = document.documentElement
  const theme = themeById(id)
  // The custom theme has no CSS block, so its base comes from the variant the
  // user is editing. Without this the dark palette could be saved and edited
  // while the app kept rendering the light one.
  const base = id === 'custom' ? (custom?.base ?? 'light') : theme.base
  const preset = theme.preset ?? null

  // `custom` has no CSS block: its palette is resolved from the settings file
  // and written as inline custom properties on top of the base palette.
  //
  // Only a palette that passes its contrast checks is applied. Editing a colour
  // in the Settings page updates the file as you type, and applying an
  // unreadable value here would repaint the dialog itself white-on-white before
  // the user could see the warning. The editor previews on its own subtree
  // instead; the app follows once the palette is valid.
  const tokens: Record<string, string> = {}
  if (id === 'custom' && custom) {
    const resolved = resolvePalette(base, custom[base].tokens)
    Object.assign(
      tokens,
      validatePalette(resolved).ok ? resolved : resolvePalette(base, {})
    )
  }

  const signature = JSON.stringify([base, preset, tokens])
  if (signature === appliedSignature) return
  appliedSignature = signature

  for (const token of appliedCustomTokens) root.style.removeProperty(token)
  appliedCustomTokens = []

  root.dataset.theme = base
  if (preset) root.dataset.themePreset = preset
  else delete root.dataset.themePreset

  for (const [token, value] of Object.entries(tokens)) {
    root.style.setProperty(token, value)
    appliedCustomTokens.push(token)
  }
}

export { THEMES, type ThemeId }
