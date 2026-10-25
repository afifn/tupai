import { describe, expect, it } from 'vitest'
import { en } from '@shared/i18n/en'
import { es } from '@shared/i18n/es'
import { id } from '@shared/i18n/id'
import { ja } from '@shared/i18n/ja'
import { zh } from '@shared/i18n/zh'
import {
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  LOCALE_TAGS,
  LOCALES,
  formatDateTime,
  formatNumber,
  t,
  type Locale
} from '@shared/i18n'

const idKeys = Object.keys(id).sort()
const enKeys = Object.keys(en).sort()
// Every shipped language must cover the whole catalogue, so a new key cannot
// land in English only and silently show English on a Chinese screen.
const CATALOGUES: Record<Locale, Record<string, string>> = { en, id, zh, ja, es }

describe('translation catalogue', () => {
  it('has the same keys in every language', () => {
    for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
      expect(Object.keys(catalogue).sort(), `${locale} keys`).toEqual(idKeys)
    }
  })

  it('ships English as the default and first locale', () => {
    expect(DEFAULT_LOCALE).toBe('en')
    expect(LOCALES[0]).toBe('en')
  })

  it('has a label for every locale', () => {
    for (const locale of LOCALES) expect(LOCALE_LABELS[locale]?.trim()).toBeTruthy()
  })

  it('has no empty or whitespace-only value, except where empty is intended', () => {
    // A blank label hides an action that is disabled anyway; these two are the
    // only entries that are deliberately empty.
    const ALLOWED_EMPTY = new Set(['sessions.cannotStopSelf'])
    for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
      for (const [key, value] of Object.entries(catalogue)) {
        if (ALLOWED_EMPTY.has(key)) continue
        expect(value.trim().length, `${locale}:${key} is empty`).toBeGreaterThan(0)
      }
    }
  })

  it('uses the same placeholders in both languages', () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

    for (const key of idKeys as (keyof typeof id)[]) {
      for (const [locale, catalogue] of Object.entries(CATALOGUES)) {
        expect(
          placeholders(catalogue[key]),
          `placeholders differ for ${key} in ${locale}`
        ).toEqual(placeholders(en[key]))
      }
    }
  })

  it('keeps every plural key paired', () => {
    const pluralBases = new Set(
      idKeys.filter((key) => key.endsWith('_one')).map((key) => key.slice(0, -4))
    )
    for (const base of pluralBases) {
      expect(idKeys, `${base}_other missing in id`).toContain(`${base}_other`)
      expect(enKeys, `${base}_other missing in en`).toContain(`${base}_other`)
    }
  })
})

describe('translate', () => {
  it('returns the key for an unknown message', () => {
    expect(t('id', 'does.not.exist' as never)).toBe('does.not.exist')
  })

  it('interpolates parameters', () => {
    expect(t('id', 'query.resultTab', { n: 3 })).toBe('Hasil 3')
    expect(t('en', 'query.resultTab', { n: 3 })).toBe('Result 3')
  })

  it('leaves an unresolved placeholder alone instead of printing undefined', () => {
    expect(t('id', 'query.resultTab', {})).toBe('Hasil {n}')
  })

  it('selects the plural form from count', () => {
    expect(t('en', 'grid.rowsRange', { from: 1, to: 1, total: 1, count: 1 })).toBe(
      'Showing 1 to 1 of 1 row'
    )
    expect(t('en', 'grid.rowsRange', { from: 1, to: 50, total: 90, count: 90 })).toBe(
      'Showing 1 to 50 of 90 rows'
    )
    expect(t('id', 'grid.rowsRange', { from: 1, to: 50, total: 90, count: 90 })).toBe(
      'Menampilkan 1 sampai 50 dari 90 baris'
    )
  })
})

describe('locale formatting', () => {
  it('formats numbers per locale', () => {
    // Indonesian groups thousands with a dot, English with a comma.
    expect(formatNumber('id', 1234567)).toBe('1.234.567')
    expect(formatNumber('en', 1234567)).toBe('1,234,567')
    expect(formatNumber('es', 1234567)).toBe('1.234.567')
  })

  it('formats dates per locale and survives an invalid value', () => {
    const value = new Date(2026, 0, 2, 15, 4, 5)
    expect(formatDateTime('id', value)).toContain('2026')
    expect(formatDateTime('en', value)).toContain('2026')
    expect(formatDateTime('id', 'not a date')).toBe('not a date')
  })

  it('exposes a BCP 47 tag for every locale', () => {
    for (const locale of LOCALES) {
      expect(LOCALE_TAGS[locale], locale).toMatch(/^[a-z]{2}-[A-Z]{2}$/)
    }
  })
})
