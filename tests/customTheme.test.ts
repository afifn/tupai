import { describe, expect, it } from 'vitest'
import {
  CHROME_TOKENS,
  CORE_TOKENS,
  derivePalette,
  mix,
  resolvePalette,
  validatePalette
} from '@shared/customTheme'
import { THEME_TOKEN_NAMES } from '@shared/themeTokens'

describe('chrome token inventory', () => {
  it('covers 28 chrome tokens and no content tokens', () => {
    expect(CHROME_TOKENS).toHaveLength(28)
    // Content colours identify data, not chrome, so they must stay fixed.
    for (const name of CHROME_TOKENS) {
      expect(name.startsWith('--engine-'), name).toBe(false)
      expect(name.startsWith('--diagram-'), name).toBe(false)
      expect(name.startsWith('--conn-'), name).toBe(false)
    }
  })

  it('only names tokens that exist in the inventory', () => {
    const known = new Set(THEME_TOKEN_NAMES)
    for (const name of CHROME_TOKENS) expect(known.has(name), name).toBe(true)
  })

  it('exposes four core tokens', () => {
    expect(CORE_TOKENS).toHaveLength(4)
    for (const name of CORE_TOKENS) expect(CHROME_TOKENS).toContain(name)
  })
})

describe('mix', () => {
  it('returns the endpoints at 0 and 1', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff')
  })

  it('leaves an unparseable colour alone instead of guessing', () => {
    expect(mix('transparent', '#ffffff', 0.5)).toBe('transparent')
  })
})

describe('derivePalette', () => {
  it('produces every chrome token for both bases', () => {
    for (const base of ['light', 'dark'] as const) {
      const tokens = derivePalette(base)
      for (const name of CHROME_TOKENS) {
        expect(tokens[name], `${base} ${name}`).toMatch(/^#[0-9a-f]{6,8}$/i)
      }
    }
  })

  it('passes the mandatory contrast pairs with the seed colours', () => {
    for (const base of ['light', 'dark'] as const) {
      const result = validatePalette(derivePalette(base))
      expect(result.failures, `${base}: ${JSON.stringify(result.failures)}`).toEqual([])
      expect(result.ok).toBe(true)
    }
  })

  it('uses the four core colours it was given', () => {
    const tokens = derivePalette('light', {
      '--bg': '#101010',
      '--surface': '#202020',
      '--text': '#f0f0f0',
      '--accent': '#00a000'
    })
    expect(tokens['--bg']).toBe('#101010')
    expect(tokens['--surface']).toBe('#202020')
    expect(tokens['--text']).toBe('#f0f0f0')
    expect(tokens['--accent']).toBe('#00a000')
  })
})

describe('validatePalette', () => {
  it('rejects unreadable text', () => {
    const tokens = { ...derivePalette('light'), '--text': '#f7f7f7' }
    const result = validatePalette(tokens)
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.fg === '--text')).toBe(true)
    // The message has to name the measured ratio, not just fail silently.
    expect(result.failures[0].ratio).toBeLessThan(4.5)
  })

  it('rejects an accent whose label is unreadable', () => {
    const tokens = { ...derivePalette('light'), '--accent-text': '#c9a07d' }
    const result = validatePalette(tokens)
    expect(result.failures.some((f) => f.bg === '--accent')).toBe(true)
  })

  it('warns instead of blocking on the recorded pre-existing gaps', () => {
    const tokens = derivePalette('light')
    const result = validatePalette(tokens)
    expect(result.ok).toBe(true)
    expect(result.warnings.some((w) => w.fg === '--border-strong')).toBe(true)
  })
})

describe('resolvePalette', () => {
  it('fills tokens a stored palette does not have', () => {
    const resolved = resolvePalette('dark', { '--bg': '#000000' })
    expect(resolved['--bg']).toBe('#000000')
    expect(resolved['--surface']).toMatch(/^#[0-9a-f]{6,8}$/i)
    for (const name of CHROME_TOKENS) expect(resolved[name], name).toBeTruthy()
  })

  it('ignores a stored value that is not a colour', () => {
    const resolved = resolvePalette('light', { '--bg': 'not-a-colour' })
    expect(resolved['--bg']).not.toBe('not-a-colour')
  })
})
