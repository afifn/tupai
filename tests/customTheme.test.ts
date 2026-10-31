import { describe, expect, it } from 'vitest'
import {
  CHROME_GROUPS,
  CHROME_TOKENS,
  CORE_TOKENS,
  PRIMARY_TOKENS,
  derivePalette,
  malformedTokens,
  mix,
  resolvePalette,
  surfaceFrom,
  tokenLabelKey,
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

  it('offers three main colours for the simple view', () => {
    expect(PRIMARY_TOKENS).toHaveLength(3)
    for (const name of PRIMARY_TOKENS) expect(CORE_TOKENS).toContain(name)
    // The panel colour is derived from the background, so it is not a main one.
    expect(PRIMARY_TOKENS).not.toContain('--surface')
  })

  it('gives every token and group a plain-language label', () => {
    for (const group of CHROME_GROUPS) {
      expect(group.labelKey).toMatch(/^theme\.group/)
      expect(group.hintKey).toMatch(/^theme\.group.+Hint$/)
      for (const token of group.tokens) {
        // A token without a label would fall back to "another colour", which is
        // useless in the editor.
        expect(tokenLabelKey(token.name), token.name).not.toBe(
          'theme.custom.unknownColour'
        )
      }
    }
  })

  it('falls back for a token outside the editor', () => {
    expect(tokenLabelKey('--engine-mysql')).toBe('theme.custom.unknownColour')
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

describe('surfaceFrom', () => {
  it('lifts a dark background by a small fixed step', () => {
    expect(surfaceFrom('#16181c')).toBe('#282a2e')
  })

  it('keeps a near-white background white', () => {
    // Nothing left to lift, so the shipped light panel is simply white.
    expect(surfaceFrom('#f4f5f7')).toBe('#ffffff')
  })

  it('darkens a panel for a pure white window instead of leaving both identical', () => {
    expect(surfaceFrom('#ffffff')).toBe('#f7f7f7')
  })

  it('leaves an unparseable colour alone', () => {
    expect(surfaceFrom('transparent')).toBe('transparent')
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

  it('ignores a core colour that is not a colour yet', () => {
    // Half-typed hex must not become the derived background.
    const tokens = derivePalette('light', { '--bg': '#10' })
    expect(tokens['--bg']).toBe(derivePalette('light')['--bg'])
    expect(validatePalette(tokens).ok).toBe(true)
  })

  it('derives the panel from the window background when none is given', () => {
    // This is what the simple view relies on: three colours in, panel out.
    const tokens = derivePalette('dark', { '--bg': '#0b0c10' })
    expect(tokens['--bg']).toBe('#0b0c10')
    expect(tokens['--surface']).toBe(surfaceFrom('#0b0c10'))
    expect(tokens['--surface']).not.toBe('#0b0c10')
  })

  it('keeps an explicit panel colour', () => {
    const tokens = derivePalette('light', { '--bg': '#101010', '--surface': '#202020' })
    expect(tokens['--surface']).toBe('#202020')
  })
})

describe('malformedTokens', () => {
  it('reports a value that cannot be parsed', () => {
    expect(malformedTokens({ '--bg': '#12', '--text': '#000000' })).toEqual(['--bg'])
  })

  it('ignores tokens that have no value at all', () => {
    expect(malformedTokens({ '--bg': '' })).toEqual([])
    expect(malformedTokens({})).toEqual([])
  })

  it('accepts every format the parser understands', () => {
    expect(malformedTokens({ '--bg': '#fff', '--text': 'rgb(0 0 0)' })).toEqual([])
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

  it('derives the missing tokens from the stored colours, not from the seed', () => {
    // A palette saved with only the main colours used to mix green button and
    // white-on-brown label, which then failed its own contrast check and left
    // the app on the default theme.
    const stored = {
      '--bg': '#dde1e9',
      '--surface': '#ffffff',
      '--text': '#1b1f24',
      '--accent': '#2f9e6a'
    }
    const resolved = resolvePalette('light', stored)
    for (const name of ['--bg', '--surface', '--text', '--accent'] as const) {
      expect(resolved[name], name).toBe(stored[name])
    }
    // The label on the button is chosen for the green button, not for the seed.
    expect(resolved['--accent-text']).toBe(
      derivePalette('light', stored)['--accent-text']
    )
    expect(validatePalette(resolved).failures).toEqual([])
  })
})
