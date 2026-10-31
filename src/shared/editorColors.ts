// Syntax colours for the SQL editor.
//
// These are user choices, not design tokens: the palette files own the app
// chrome, while an editor colour scheme is personal and stored in settings.json
// the same way the custom theme palette is. Defaults follow the app theme so a
// user who never opens this page keeps the shipped look.

export type EditorSyntaxKey =
  'common' | 'keyword' | 'comment' | 'string' | 'number' | 'background'

export const EDITOR_SYNTAX_KEYS: EditorSyntaxKey[] = [
  'common',
  'keyword',
  'comment',
  'string',
  'number',
  'background'
]

export type EditorSyntaxColors = Partial<Record<EditorSyntaxKey, string>>

export type EditorBase = 'light' | 'dark'

// Kept in sync with the shipped light and dark palettes. A value that is close
// to the shipped one keeps the default editor readable without loading the
// stylesheet, which also makes the resolver testable.
export const DEFAULT_SYNTAX_COLORS: Record<
  EditorBase,
  Record<EditorSyntaxKey, string>
> = {
  light: {
    common: '#1b1f24',
    keyword: '#b3521f',
    comment: '#6d6f71',
    string: '#1f6b3a',
    number: '#33526b',
    background: '#ffffff'
  },
  dark: {
    common: '#e8eaed',
    keyword: '#e08a54',
    comment: '#9ea0a2',
    string: '#6fcf97',
    number: '#90b4d6',
    background: '#1e2126'
  }
}

const HEX = /^#([0-9a-fA-F]{6})$/

/** A stored value, or the default for that slot when it is missing or invalid. */
export function resolveSyntaxColors(
  base: EditorBase,
  stored: EditorSyntaxColors | undefined
): Record<EditorSyntaxKey, string> {
  const defaults = DEFAULT_SYNTAX_COLORS[base]
  const out = { ...defaults }
  for (const key of EDITOR_SYNTAX_KEYS) {
    const value = stored?.[key]
    if (value && HEX.test(value)) out[key] = value.toLowerCase()
  }
  return out
}

/** True when the stored palette differs from the shipped one for that base. */
export function isCustomSyntax(base: EditorBase, stored: EditorSyntaxColors): boolean {
  const resolved = resolveSyntaxColors(base, stored)
  const defaults = DEFAULT_SYNTAX_COLORS[base]
  return EDITOR_SYNTAX_KEYS.some((key) => resolved[key] !== defaults[key])
}

/**
 * Monaco theme description for the given colours.
 *
 * Monaco wants bare hex without `#`, and the token names follow its SQL grammar:
 * `keyword`, `comment`, `string`, `number`, plus the empty token for everything
 * else. Returning a plain object keeps this free of the Monaco import so the
 * values can be asserted in a unit test.
 */
export interface MonacoTheme {
  base: 'vs' | 'vs-dark'
  inherit: boolean
  rules: { token: string; foreground: string }[]
  colors: Record<string, string>
}

function bare(color: string): string {
  return color.replace('#', '').toLowerCase()
}

export function monacoTheme(
  base: EditorBase,
  colors: Record<EditorSyntaxKey, string>
): MonacoTheme {
  return {
    base: base === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: bare(colors.common) },
      { token: 'keyword', foreground: bare(colors.keyword) },
      { token: 'comment', foreground: bare(colors.comment) },
      { token: 'string', foreground: bare(colors.string) },
      { token: 'number', foreground: bare(colors.number) }
    ],
    colors: {
      'editor.background': colors.background,
      'editor.foreground': colors.common
    }
  }
}
