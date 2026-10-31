import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SYNTAX_COLORS,
  EDITOR_SYNTAX_KEYS,
  isCustomSyntax,
  monacoTheme,
  resolveSyntaxColors
} from '@shared/editorColors'

describe('resolveSyntaxColors', () => {
  it('returns the shipped colours when nothing is stored', () => {
    expect(resolveSyntaxColors('light', {})).toEqual(DEFAULT_SYNTAX_COLORS.light)
    expect(resolveSyntaxColors('dark', undefined)).toEqual(DEFAULT_SYNTAX_COLORS.dark)
  })

  it('keeps a stored colour and fills the rest from the theme', () => {
    const resolved = resolveSyntaxColors('dark', { keyword: '#FF0000' })
    expect(resolved.keyword).toBe('#ff0000')
    expect(resolved.string).toBe(DEFAULT_SYNTAX_COLORS.dark.string)
  })

  it('ignores a value that is not a six-digit colour', () => {
    expect(resolveSyntaxColors('light', { keyword: 'red' }).keyword).toBe(
      DEFAULT_SYNTAX_COLORS.light.keyword
    )
    expect(resolveSyntaxColors('light', { keyword: '#fff' }).keyword).toBe(
      DEFAULT_SYNTAX_COLORS.light.keyword
    )
  })
})

describe('isCustomSyntax', () => {
  it('is false while the palette matches the theme', () => {
    expect(isCustomSyntax('light', {})).toBe(false)
    expect(isCustomSyntax('light', DEFAULT_SYNTAX_COLORS.light)).toBe(false)
  })

  it('is true as soon as one colour differs', () => {
    expect(isCustomSyntax('light', { comment: '#123456' })).toBe(true)
  })
})

describe('monacoTheme', () => {
  it('maps every syntax role to a Monaco token rule', () => {
    const theme = monacoTheme('dark', DEFAULT_SYNTAX_COLORS.dark)
    const tokens = new Map(theme.rules.map((rule) => [rule.token, rule.foreground]))
    expect(tokens.get('keyword')).toBe('e08a54')
    expect(tokens.get('comment')).toBe('9ea0a2')
    expect(tokens.get('string')).toBe('6fcf97')
    expect(tokens.get('number')).toBe('90b4d6')
    // The empty token is the fallback for everything else.
    expect(tokens.get('')).toBe('e8eaed')
  })

  it('uses the chosen background and picks the matching Monaco base', () => {
    const colors = { ...DEFAULT_SYNTAX_COLORS.light, background: '#fafafa' }
    const theme = monacoTheme('light', colors)
    expect(theme.base).toBe('vs')
    expect(theme.colors['editor.background']).toBe('#fafafa')
    expect(monacoTheme('dark', DEFAULT_SYNTAX_COLORS.dark).base).toBe('vs-dark')
  })

  it('covers every key in the palette', () => {
    const colors = resolveSyntaxColors('light', {})
    expect(Object.keys(colors).sort()).toEqual([...EDITOR_SYNTAX_KEYS].sort())
  })
})
