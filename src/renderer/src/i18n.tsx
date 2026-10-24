import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react'
import type { ReactNode } from 'react'
import {
  DEFAULT_LOCALE,
  formatDateTime,
  formatNumber,
  t,
  type Locale,
  type MessageKey,
  type MessageParams
} from '@shared/i18n'
import { describeError } from '@shared/errorText'
import { applyDocumentLang, readStoredLocale, storeLocale } from './localeStore'

interface LocaleContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  /** Translate a key for the active locale. */
  tr: (key: MessageKey, params?: MessageParams) => string
  /** Format a number with the active locale's grouping. */
  number: (value: number) => string
  /** Format a date/time with the active locale's order and separators. */
  dateTime: (value: string | number | Date) => string
  /** Text for a thrown error, translated by its code where possible. */
  errorText: (error: unknown) => string
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({
  children,
  forcedLocale
}: {
  children: ReactNode
  // Set by the settings provider once the stored settings are loaded. The
  // stored locale still wins on the very first render, before settings arrive.
  forcedLocale?: Locale
}): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale())

  useEffect(() => {
    if (forcedLocale) setLocaleState(forcedLocale)
  }, [forcedLocale])

  useEffect(() => {
    applyDocumentLang(locale)
    storeLocale(locale)
  }, [locale])

  const setLocale = useCallback((next: Locale) => setLocaleState(next), [])

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      tr: (key, params) => t(locale, key, params),
      number: (v) => formatNumber(locale, v),
      dateTime: (v) => formatDateTime(locale, v),
      errorText: (error) => describeError(error, locale)
    }),
    [locale, setLocale]
  )

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

/**
 * Read the active locale. Falls back to the default catalogue when a component
 * is rendered outside the provider, so a stray component never crashes a
 * screen; it just shows the default language.
 */
export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext)
  if (context) return context
  return {
    locale: DEFAULT_LOCALE,
    setLocale: () => undefined,
    tr: (key, params) => t(DEFAULT_LOCALE, key, params),
    number: (v) => formatNumber(DEFAULT_LOCALE, v),
    dateTime: (v) => formatDateTime(DEFAULT_LOCALE, v),
    errorText: (error) => describeError(error, DEFAULT_LOCALE)
  }
}
