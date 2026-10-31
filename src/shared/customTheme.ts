import { contrastRatio, parseColor, type Rgb } from './contrast'
import type { MessageKey } from './i18n'
import { CONTRAST_PAIRS, KNOWN_CONTRAST_GAPS, type ThemeToken } from './themeTokens'

// The custom palette: the user picks a handful of colours, everything else is
// derived, and every derived value is checked against the same WCAG pairs the
// shipped themes must pass.
//
// Content colours (engine marks, diagram cards, connection markers) are excluded
// on purpose. Those identify data, not chrome, and letting them be edited would
// make a saved connection or diagram unreadable.

export type PaletteBase = 'light' | 'dark'

/**
 * One editable colour.
 *
 * `labelKey` is the plain-language name the editor shows instead of the CSS
 * variable: a user picking colours should read "Panel background", not
 * `--surface-muted`. The CSS variable stays visible next to the value as the
 * technical name, for anyone copying it into their own stylesheet.
 */
export interface ChromeToken {
  name: string
  labelKey: MessageKey
}

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
  /** One sentence naming the parts of the app the group repaints. */
  hintKey:
    | 'theme.groupSurfaceHint'
    | 'theme.groupTextHint'
    | 'theme.groupAccentHint'
    | 'theme.groupStatusHint'
    | 'theme.groupNoticeHint'
    | 'theme.groupOverlayHint'
    | 'theme.groupScrollbarHint'
  tokens: ChromeToken[]
}

// 28 chrome tokens, grouped. The four "core" ones are what the picker shows
// first; the rest are derived and then editable under their group.
export const CHROME_GROUPS: ChromeTokenGroup[] = [
  {
    id: 'surface',
    labelKey: 'theme.groupSurface',
    hintKey: 'theme.groupSurfaceHint',
    tokens: [
      { name: '--bg', labelKey: 'theme.token.bg' },
      { name: '--surface', labelKey: 'theme.token.surface' },
      { name: '--surface-muted', labelKey: 'theme.token.surfaceMuted' },
      { name: '--surface-hover', labelKey: 'theme.token.surfaceHover' },
      { name: '--border', labelKey: 'theme.token.border' },
      { name: '--border-strong', labelKey: 'theme.token.borderStrong' }
    ]
  },
  {
    id: 'text',
    labelKey: 'theme.groupText',
    hintKey: 'theme.groupTextHint',
    tokens: [
      { name: '--text', labelKey: 'theme.token.text' },
      { name: '--text-muted', labelKey: 'theme.token.textMuted' }
    ]
  },
  {
    id: 'accent',
    labelKey: 'theme.groupAccent',
    hintKey: 'theme.groupAccentHint',
    tokens: [
      { name: '--accent', labelKey: 'theme.token.accent' },
      { name: '--accent-hover', labelKey: 'theme.token.accentHover' },
      { name: '--accent-text', labelKey: 'theme.token.accentText' },
      { name: '--accent-soft', labelKey: 'theme.token.accentSoft' },
      { name: '--selected-bg', labelKey: 'theme.token.selectedBg' },
      { name: '--pk-bg', labelKey: 'theme.token.pkBg' }
    ]
  },
  {
    id: 'status',
    labelKey: 'theme.groupStatus',
    hintKey: 'theme.groupStatusHint',
    tokens: [
      { name: '--ok', labelKey: 'theme.token.ok' },
      { name: '--error', labelKey: 'theme.token.error' },
      { name: '--info', labelKey: 'theme.token.info' },
      { name: '--error-text', labelKey: 'theme.token.errorText' }
    ]
  },
  {
    id: 'notice',
    labelKey: 'theme.groupNotice',
    hintKey: 'theme.groupNoticeHint',
    tokens: [
      { name: '--notice-error-bg', labelKey: 'theme.token.noticeErrorBg' },
      { name: '--notice-error-border', labelKey: 'theme.token.noticeErrorBorder' },
      { name: '--notice-ok-bg', labelKey: 'theme.token.noticeOkBg' },
      { name: '--notice-ok-border', labelKey: 'theme.token.noticeOkBorder' },
      { name: '--notice-info-bg', labelKey: 'theme.token.noticeInfoBg' },
      { name: '--notice-info-border', labelKey: 'theme.token.noticeInfoBorder' }
    ]
  },
  {
    id: 'overlay',
    labelKey: 'theme.groupOverlay',
    hintKey: 'theme.groupOverlayHint',
    tokens: [{ name: '--overlay', labelKey: 'theme.token.overlay' }]
  },
  {
    id: 'scrollbar',
    labelKey: 'theme.groupScrollbar',
    hintKey: 'theme.groupScrollbarHint',
    tokens: [
      { name: '--scrollbar-thumb', labelKey: 'theme.token.scrollbarThumb' },
      { name: '--scrollbar-thumb-hover', labelKey: 'theme.token.scrollbarThumbHover' },
      { name: '--scrollbar-track', labelKey: 'theme.token.scrollbarTrack' }
    ]
  }
]

export const CHROME_TOKENS: string[] = CHROME_GROUPS.flatMap((group) =>
  group.tokens.map((token) => token.name)
)

/** Token name to plain-language label, for every chrome token. */
const TOKEN_LABELS = new Map<string, MessageKey>(
  CHROME_GROUPS.flatMap((group) =>
    group.tokens.map((token) => [token.name, token.labelKey] as const)
  )
)

export function tokenLabelKey(name: string): MessageKey {
  return TOKEN_LABELS.get(name) ?? 'theme.custom.unknownColour'
}

/** Tokens the picker shows first: the four that decide the whole look. */
export const CORE_TOKENS = ['--bg', '--surface', '--text', '--accent'] as const

/**
 * The three colours the simple view edits. The panel colour follows the window
 * background, so a user who only wants a different look never has to reason
 * about two backgrounds that must sit next to each other.
 */
export const PRIMARY_TOKENS = ['--bg', '--text', '--accent'] as const

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

/**
 * Panel colour for a window background.
 *
 * The step is a fixed amount of lightness, not a percentage: a percentage that
 * is right for a near-white window turns a dark window into a grey slab, and a
 * user may pick a dark background in the light appearance (or the reverse).
 */
export function surfaceFrom(bg: string): string {
  const rgb = parseColor(bg)
  if (!rgb) return bg
  const lift = (channel: number): number => Math.min(255, channel + 18)
  const lifted = { r: lift(rgb.r), g: lift(rgb.g), b: lift(rgb.b) }
  const moved = Math.max(lifted.r - rgb.r, lifted.g - rgb.g, lifted.b - rgb.b)
  // A window that is already almost white cannot get lighter, so its panels go
  // a little darker to keep the two surfaces distinguishable.
  if (moved < 6) {
    const lower = (channel: number): number => Math.max(0, channel - 8)
    return toHex({ r: lower(rgb.r), g: lower(rgb.g), b: lower(rgb.b) })
  }
  return toHex(lifted)
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
 * Derive the 28 chrome tokens from the core colours.
 *
 * The result is a starting point, not a guarantee: `validatePalette` still has
 * to pass, because a user can pick a text colour that is too close to the
 * background and no amount of derivation fixes that.
 *
 * `--surface` is optional. When the caller only gave a window background, the
 * panel colour follows it, which is what the simple view relies on.
 */
export function derivePalette(
  base: PaletteBase,
  core: Partial<Record<(typeof CORE_TOKENS)[number], string>> = {}
): Record<string, string> {
  // A half-typed hex value must not become the derived background, so anything
  // the parser rejects falls back to the shipped seed for that slot.
  const pick = (name: (typeof CORE_TOKENS)[number]): string => {
    const value = core[name]
    return value && parseColor(value) ? value : SEED[base][name]
  }
  const bg = pick('--bg')
  const explicitSurface = core['--surface']
  const bgChoice = core['--bg']
  const surface =
    explicitSurface && parseColor(explicitSurface)
      ? explicitSurface
      : bgChoice && parseColor(bgChoice)
        ? surfaceFrom(bg)
        : SEED[base]['--surface']
  const text = pick('--text')
  const accent = pick('--accent')
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

/**
 * Colour fields whose text cannot be read as a colour at all, such as a
 * half-typed hex value. Contrast checking skips these pairs, so they need their
 * own report: without it the editor would say "all pairs pass" while a field is
 * plainly invalid.
 */
export function malformedTokens(tokens: Record<string, string>): string[] {
  return CHROME_TOKENS.filter((name) => {
    const value = tokens[name]
    return typeof value === 'string' && value.trim() !== '' && !parseColor(value)
  })
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
 * Everything the palette does not store is derived from the colours it does
 * store, not from the shipped seed. A palette saved with only the three main
 * colours must still produce muted text and a button label that match those
 * colours: deriving them from the seed produced a mixed palette (green button
 * with white text meant for the brown one), which then failed its own contrast
 * check and left the app on the default theme.
 */
export function resolvePalette(
  base: PaletteBase,
  stored: Record<string, string>
): Record<string, string> {
  const core: Partial<Record<(typeof CORE_TOKENS)[number], string>> = {}
  for (const token of CORE_TOKENS) {
    const value = stored[token]
    if (value && parseColor(value)) core[token] = value
  }
  const derived = derivePalette(base, core)
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
