import { DEFAULT_LOCALE, isLocale, type Locale } from '@shared/i18n'

// Renderer-side locale state. Kept separate from the pure catalogue so the
// catalogue stays importable from Node (tests) without React.

const LOCALE_KEY = 'db-manager-locale'

export function readStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_KEY)
    if (isLocale(stored)) return stored
  } catch {
    // localStorage can throw when the profile is read-only; the default is fine.
  }
  return DEFAULT_LOCALE
}

export function storeLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_KEY, locale)
  } catch {
    // Ignore: the in-memory state still drives the current session.
  }
}

/** Keep the document language in sync so screen readers pick the right voice. */
export function applyDocumentLang(locale: Locale): void {
  document.documentElement.lang = locale
}
