import { contrastRatio, parseColor, type Rgb } from './contrast'
import { CONTRAST_PAIRS, KNOWN_CONTRAST_GAPS, type ThemeToken } from './themeTokens'

// The custom palette: the user picks a handful of colours, everything else is
// derived, and every derived value is checked against the same WCAG pairs the
// shipped themes must pass.
//
// Content colours (engine marks, diagram cards, connection markers) are excluded
// on purpose. Those identify data, not chrome, and letting them be edited would
// make a saved connection or diagram unreadable.

export type PaletteBase = 'light' | 'dark'

export interface ChromeTokenGroup {
  id: 'surface' | 'text' | 'accent' | 'status' | 'notice' | 'overlay' | 'scrollbar'
  labelKey:
    | 'theme.groupSurface'
    | 'theme.groupText'
    | 'theme.groupAccent'
    | 'theme.groupStatus'
    | 'theme.groupNotice'
    | 'theme.groupOverlay'
    | 'theme.groupScrollbar'
  tokens: string[]
}

// 28 chrome tokens, grouped. The four "core" ones are what the picker shows
// first; the rest are derived and then editable under their group.
export const CHROME_GROUPS: ChromeTokenGroup[] = [
  {
    id: 'surface',
    labelKey: 'theme.groupSurface',
    tokens: [
      '--bg',
      '--surface',
      '--surface-muted',
      '--surface-hover',
      '--border',
      '--border-strong'
    ]
  },
  {
    id: 'text',
    labelKey: 'theme.groupText',
    tokens: ['--text', '--text-muted']
  },
  {
    id: 'accent',
    labelKey: 'theme.groupAccent',
    tokens: [
      '--accent',
      '--accent-hover',
      '--accent-text',
      '--accent-soft',
      '--selected-bg',
      '--pk-bg'
    ]
  },
  {
    id: 'status',
    labelKey: 'theme.groupStatus',
    tokens: ['--ok', '--error', '--info', '--error-text']
  },
  {
    id: 'notice',
    labelKey: 'theme.groupNotice',
    tokens: [
      '--notice-error-bg',
      '--notice-error-border',
      '--notice-ok-bg',
      '--notice-ok-border',
      '--notice-info-bg',
      '--notice-info-border'
    ]
  },
  {
    id: 'overlay',
    labelKey: 'theme.groupOverlay',
    tokens: ['--overlay']
  },
  {
    id: 'scrollbar',
    labelKey: 'theme.groupScrollbar',
    tokens: ['--scrollbar-thumb', '--scrollbar-thumb-hover', '--scrollbar-track']
  }
]

export const CHROME_TOKENS: string[] = CHROME_GROUPS.flatMap((group) => group.tokens)

/** Tokens the picker shows first: the four that decide the whole look. */
export const CORE_TOKENS = ['--bg', '--surface', '--text', '--accent'] as const

// Shipped values for the four core tokens, used to seed a new custom palette so
// it starts from something readable instead of an empty form.
const SEED: Record<PaletteBase, Record<(typeof CORE_TOKENS)[number], string>> = {
  light: {
    '--bg': '#f4f5f7',
    '--surface': '#ffffff',
    '--text': '#1b1f24',
    '--accent': '#b3521f'
  },
  dark: {
    '--bg': '#16181c',
    '--surface': '#1e2126',
    '--text': '#e8eaed',
    '--accent': '#e08a54'
  }
}

// Status colours stay per base palette: they are semantic (danger is red) and
// deriving them from an arbitrary accent would produce a green error message.
const STATUS: Record<PaletteBase, Record<string, string>> = {
  light: { '--ok': '#1f6b3a', '--error': '#b3261e', '--info': '#33526b' },
  dark: { '--ok': '#6fcf97', '--error': '#ff8a80', '--info': '#90b4d6' }
}

// Below this, secondary text stops being readable at normal size.
const MUTED_MIN_RATIO = 4.6

/**
 * Fade `text` toward each background as far as the contrast budget allows.
 *
 * A fixed mix breaks as soon as someone picks a low-contrast pair; searching the
 * step keeps the derived palette valid for any core colours, and the picker's
 * validation then only has to catch what the user typed by hand.
 */
function mutedFrom(text: string, backgrounds: string[]): string {
  const target = parseColor(text)
  if (!target) return text
  let best = text
  for (let step = 0.1; step <= 0.6; step += 0.02) {
    const candidate = mix(text, backgrounds[0], step)
    const parsed = parseColor(candidate)
    if (!parsed) break
    const readable = backgrounds.every((bg) => {
      const other = parseColor(bg)
      return !other || contrastRatio(parsed, other) >= MUTED_MIN_RATIO
    })
    if (!readable) break
    best = candidate
  }
  return best
}

function toHex(color: Rgb): string {
  const part = (n: number): string =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0')
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`
}

/**
 * Mix two colours in linear light. Mixing gamma-encoded sRGB directly darkens
 * the middle of the ramp and makes the derived greys muddy; linear light keeps
 * the midpoint close to what the eye expects.
 */
export function mix(from: string, to: string, amount: number): string {
  const a = parseColor(from)
  const b = parseColor(to)
  if (!a || !b) return from
  const t = Math.min(1, Math.max(0, amount))
  const linear = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const encode = (value: number): number => {
    const c = Math.max(0, Math.min(1, value))
    return (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255
  }
  const blend = (x: number, y: number): number =>
    encode(linear(x) * (1 - t) + linear(y) * t)
  return toHex({ r: blend(a.r, b.r), g: blend(a.g, b.g), b: blend(a.b, b.b) })
}

/** Whichever of white or the theme text colour reads better on the given fill. */
function readableOn(fill: string, preferred: string): string {
  const target = parseColor(fill)
  if (!target) return preferred
  const white = { r: 255, g: 255, b: 255 }
  const dark = { r: 27, g: 31, b: 36 }
  const onWhite = contrastRatio(target, white)
  const onDark = contrastRatio(target, dark)
  return onWhite >= onDark ? '#ffffff' : toHex(dark)
}

/**
 * Derive the 28 chrome tokens from four core colours.
 *
 * The result is a starting point, not a guarantee: `validatePalette` still has
 * to pass, because a user can pick a text colour that is too close to the
 * background and no amount of derivation fixes that.
 */
export function derivePalette(
  base: PaletteBase,
  core: Partial<Record<(typeof CORE_TOKENS)[number], string>> = {}
): Record<string, string> {
  const bg = core['--bg'] ?? SEED[base]['--bg']
  const surface = core['--surface'] ?? SEED[base]['--surface']
  const text = core['--text'] ?? SEED[base]['--text']
  const accent = core['--accent'] ?? SEED[base]['--accent']
  const status = STATUS[base]

  const tokens: Record<string, string> = {
    '--bg': bg,
    '--surface': surface,
    '--surface-muted': mix(surface, text, 0.05),
    '--surface-hover': mix(surface, text, 0.1),
    '--border': mix(surface, text, 0.17),
    '--border-strong': mix(surface, text, 0.34),
    '--text': text,
    // Secondary text must stay readable on every surface, so it is not a fixed
    // mix: the amount is the largest step toward the background that still
    // clears 4.5:1 on both bg and surface.
    '--text-muted': mutedFrom(text, [bg, surface]),
    '--accent': accent,
    '--accent-hover': mix(accent, text, 0.18),
    '--accent-text': readableOn(accent, text),
    '--accent-soft': mix(surface, accent, 0.14),
    '--selected-bg': mix(surface, accent, 0.22),
    '--pk-bg': mix(surface, text, 0.04),
    '--ok': status['--ok'],
    '--error': status['--error'],
    '--info': status['--info'],
    '--error-text': readableOn(status['--error'], text),
    '--notice-error-bg': mix(surface, status['--error'], 0.12),
    '--notice-error-border': mix(surface, status['--error'], 0.34),
    '--notice-ok-bg': mix(surface, status['--ok'], 0.12),
    '--notice-ok-border': mix(surface, status['--ok'], 0.34),
    '--notice-info-bg': mix(surface, status['--info'], 0.12),
    '--notice-info-border': mix(surface, status['--info'], 0.34),
    '--overlay': base === 'dark' ? '#00000099' : '#14181e73',
    '--scrollbar-thumb': mix(surface, text, 0.28),
    '--scrollbar-thumb-hover': mix(surface, text, 0.42),
    '--scrollbar-track': '#00000000'
  }

  // Anything outside the chrome set is untouched by design.
  return tokens
}

export interface ContrastFailure {
  fg: string
  bg: string
  ratio: number
  min: number
  note: string
}

export interface PaletteValidation {
  ok: boolean
  failures: ContrastFailure[]
  // Known pre-existing gaps that the shipped themes also fail. Reported, never
  // blocking: a palette that copies the default values must not be rejected.
  warnings: ContrastFailure[]
}

function pairRatio(
  tokens: Record<string, string>,
  fg: string,
  bg: string
): number | null {
  const a = parseColor(tokens[fg] ?? '')
  const b = parseColor(tokens[bg] ?? '')
  if (!a || !b) return null
  return contrastRatio(a, b)
}

/** Check a palette against the same WCAG pairs the shipped themes must pass. */
export function validatePalette(tokens: Record<string, string>): PaletteValidation {
  const failures: ContrastFailure[] = []
  const warnings: ContrastFailure[] = []

  const knownGapKeys = new Set(KNOWN_CONTRAST_GAPS.map((gap) => `${gap.fg}|${gap.bg}`))

  for (const pair of CONTRAST_PAIRS) {
    const ratio = pairRatio(tokens, pair.fg, pair.bg)
    if (ratio === null) continue
    if (ratio + 0.005 >= pair.min) continue
    const failure: ContrastFailure = {
      fg: pair.fg,
      bg: pair.bg,
      ratio: Math.round(ratio * 100) / 100,
      min: pair.min,
      note: pair.note
    }
    if (knownGapKeys.has(`${pair.fg}|${pair.bg}`)) warnings.push(failure)
    else failures.push(failure)
  }

  // The two recorded gaps are checked separately so they warn instead of block.
  for (const gap of KNOWN_CONTRAST_GAPS) {
    const ratio = pairRatio(tokens, gap.fg, gap.bg)
    if (ratio === null) continue
    if (ratio + 0.005 >= gap.min) continue
    if (!warnings.some((w) => w.fg === gap.fg && w.bg === gap.bg)) {
      warnings.push({
        fg: gap.fg,
        bg: gap.bg,
        ratio: Math.round(ratio * 100) / 100,
        min: gap.min,
        note: gap.note
      })
    }
  }

  return { ok: failures.length === 0, failures, warnings }
}

/**
 * Turn a stored palette into the CSS custom properties to apply.
 *
 * Missing tokens are filled from the derivation so a palette saved by an older
 * version, or one where the user only touched the core four, still renders a
 * complete theme instead of inheriting half of the built-in one.
 */
export function resolvePalette(
  base: PaletteBase,
  stored: Record<string, string>
): Record<string, string> {
  const derived = derivePalette(base)
  const out: Record<string, string> = {}
  for (const token of CHROME_TOKENS) {
    const value = stored[token]
    out[token] = value && parseColor(value) ? value : derived[token]
  }
  return out
}

/** Token inventory for the editor UI: name, group, and description. */
export function chromeTokenInfo(tokens: ThemeToken[]): Map<string, ThemeToken> {
  const wanted = new Set(CHROME_TOKENS)
  return new Map(tokens.filter((token) => wanted.has(token.name)).map((t) => [t.name, t]))
}
