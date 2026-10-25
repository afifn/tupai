import { en } from './en'
import { id, type MessageKey } from './id'
import { es } from './es'
import { ja } from './ja'
import { zh } from './zh'

// English is the product language: every key is authored there first and the
// others are translations of it. Keeping it first in the list also makes it the
// fallback for a key a translation has not reached yet.
export type Locale = 'en' | 'id' | 'zh' | 'ja' | 'es'

export const LOCALES: Locale[] = ['en', 'id', 'zh', 'ja', 'es']

export const DEFAULT_LOCALE: Locale = 'en'

/** BCP 47 tags for Intl, so dates and numbers follow the chosen language. */
export const LOCALE_TAGS: Record<Locale, string> = {
  en: 'en-US',
  id: 'id-ID',
  zh: 'zh-CN',
  ja: 'ja-JP',
  es: 'es-ES'
}

/** Label shown in the language picker, written in that language. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  id: 'Bahasa Indonesia',
  zh: '简体中文',
  ja: '日本語',
  es: 'Español'
}

const CATALOGUES: Record<Locale, Record<MessageKey, string>> = { en, id, zh, ja, es }

export type MessageParams = Record<string, string | number>

export function isLocale(value: string | null): value is Locale {
  return (
    value === 'en' || value === 'id' || value === 'zh' || value === 'ja' || value === 'es'
  )
}

function lookup(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const catalogue = CATALOGUES[locale] ?? CATALOGUES[DEFAULT_LOCALE]

  // Plural selection is explicit rather than via Intl.PluralRules: the only
  // languages we ship need "one" and "other", and an explicit suffix keeps the
  // catalogue readable and the test simple.
  let template: string | undefined
  if (params && typeof params.count === 'number') {
    const suffix = params.count === 1 ? '_one' : '_other'
    const pluralKey = `${key}${suffix}` as MessageKey
    if (pluralKey in catalogue) template = catalogue[pluralKey]
  }

  if (template === undefined) template = catalogue[key]
  if (template === undefined && locale !== DEFAULT_LOCALE) {
    // A translation can lag behind the catalogue. English is the source of
    // truth, so a missing key shows English instead of the raw key.
    const fallback = CATALOGUES[DEFAULT_LOCALE]
    if (params && typeof params.count === 'number') {
      const pluralKey = `${key}${params.count === 1 ? '_one' : '_other'}` as MessageKey
      if (pluralKey in fallback) template = fallback[pluralKey]
    }
    if (template === undefined) template = fallback[key]
  }
  if (template === undefined) {
    // Never throw from a translation lookup: a missing key must not take down
    // the render. The key itself is the most useful thing to show.
    return key
  }
  return params ? interpolate(template, params) : template
}

function interpolate(template: string, params: MessageParams): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * Translate a key. `params.count` selects the plural form when the catalogue
 * has one; any other param fills a `{name}` placeholder.
 */
export function t(locale: Locale, key: MessageKey, params?: MessageParams): string {
  return lookup(locale, key, params)
}

export function formatNumber(locale: Locale, value: number): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale] ?? LOCALE_TAGS[DEFAULT_LOCALE]).format(
    value
  )
}

export function formatDateTime(locale: Locale, value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString(LOCALE_TAGS[locale] ?? LOCALE_TAGS[DEFAULT_LOCALE])
}

export {
  id as messagesId,
  en as messagesEn,
  zh as messagesZh,
  ja as messagesJa,
  es as messagesEs
}
export type { MessageKey }
