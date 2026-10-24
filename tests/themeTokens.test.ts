import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio, parseColor } from '@shared/contrast'
import {
  CONTRAST_PAIRS,
  KNOWN_CONTRAST_GAPS,
  THEME_PRESETS,
  THEME_TOKEN_NAMES,
  THEME_TOKENS
} from '@shared/themeTokens'

const THEME_DIR = resolve('src/renderer/src/theme/themes')

interface ParsedBlock {
  selector: string
  tokens: Record<string, string>
}

/**
 * Pull `--token: value;` declarations out of a CSS file, grouped by selector.
 * Deliberately a small regex parser: these files are hand-written, contain no
 * nesting, and adding a CSS parser dependency for a test is not worth it.
 */
function parseBlocks(css: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  const blockRe = /([^{}]+)\{([^}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = blockRe.exec(css)) !== null) {
    const selector = match[1].trim().replace(/\s+/g, ' ')
    const body = match[2]
    const tokens: Record<string, string> = {}
    const declRe = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi
    let decl: RegExpExecArray | null
    while ((decl = declRe.exec(body)) !== null) {
      tokens[decl[1]] = decl[2].trim()
    }
    blocks.push({ selector, tokens })
  }
  return blocks
}

function tokensOf(file: string): Record<string, string> {
  const css = readFileSync(resolve(THEME_DIR, file), 'utf8')
  return Object.assign({}, ...parseBlocks(css).map((block) => block.tokens))
}

const light = tokensOf('light.css')
const dark = tokensOf('dark.css')
const presets = tokensOf('presets.css')

/**
 * Tokens declared only in light.css because they are content, not chrome:
 * connection identity and diagram card colours. They must survive into dark
 * mode unchanged, so dark.css must not redeclare them.
 */
const LIGHT_ONLY_TOKENS = THEME_TOKEN_NAMES.filter(
  (name) => name.startsWith('--conn-') || name.startsWith('--diagram-')
)

/** Tokens that both base palettes must declare. */
const SHARED_TOKENS = THEME_TOKEN_NAMES.filter(
  (name) => !LIGHT_ONLY_TOKENS.includes(name)
)

/** Resolve a token through base theme and preset, mirroring the CSS cascade. */
function resolveToken(
  base: Record<string, string>,
  token: string,
  presetTokens: Record<string, string> = {}
): string | undefined {
  return presetTokens[token] ?? base[token]
}

describe('theme token inventory', () => {
  it('lists every token exactly once', () => {
    const names = THEME_TOKENS.map((token) => token.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('matches the tokens declared in light.css', () => {
    expect([...THEME_TOKEN_NAMES].sort()).toEqual(Object.keys(light).sort())
  })

  it('matches the tokens declared in dark.css', () => {
    // Dark re-declares every surface token but inherits the identity colours.
    expect([...SHARED_TOKENS].sort()).toEqual(Object.keys(dark).sort())
  })

  it('keeps the identity colours out of dark.css', () => {
    for (const token of LIGHT_ONLY_TOKENS) {
      expect(Object.keys(dark), `${token} must not be redeclared in dark`).not.toContain(
        token
      )
    }
  })

  it('gives every token a group and a description', () => {
    for (const token of THEME_TOKENS) {
      expect(token.group.length).toBeGreaterThan(0)
      expect(token.description.length).toBeGreaterThan(10)
    }
  })
})

describe('theme presets', () => {
  it('only override tokens that exist in the base palettes', () => {
    const known = new Set(THEME_TOKEN_NAMES)
    for (const token of Object.keys(presets)) {
      expect(known.has(token), `${token} is not a known token`).toBe(true)
    }
  })

  it('never override surfaces, text, or status colours', () => {
    // A preset that changes --bg or --text would silently invalidate the
    // contrast work done for the base palette.
    const allowed = new Set([
      '--accent',
      '--accent-hover',
      '--accent-text',
      '--accent-soft',
      '--selected-bg'
    ])
    for (const token of Object.keys(presets)) {
      expect(allowed.has(token), `${token} must not be set by a preset`).toBe(true)
    }
  })

  it('declares a preset for every preset theme id', () => {
    const presetIds = THEME_PRESETS.map((preset) => preset.id)
    expect(presetIds).toEqual(['light-ocean', 'dark-forest'])
  })
})

describe('stylesheet hygiene', () => {
  it('keeps colour literals out of styles.css', () => {
    const css = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')

    // Only shadow colours are allowed to stay literal. They are black at
    // different alphas in every theme, so they are depth, not palette.
    const offenders: string[] = []
    css.split('\n').forEach((line, index) => {
      const hex = /#[0-9a-fA-F]{3,8}\b/.exec(line)
      if (hex) offenders.push(`${index + 1}: ${line.trim()}`)
    })

    expect(offenders).toEqual([])
  })

  it('imports every theme file from the top of styles.css', () => {
    const css = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')
    const firstLines = css.split('\n').slice(0, 8).join('\n')
    for (const file of ['light', 'dark', 'presets', 'previews']) {
      expect(firstLines).toContain(`./theme/themes/${file}.css`)
    }
  })
})

describe('contrast', () => {
  it('computes the reference ratios', () => {
    const white = parseColor('#ffffff')
    const black = parseColor('#000000')
    const grey = parseColor('#777777')
    expect(white && black && contrastRatio(white, black)).toBeCloseTo(21, 1)
    // #777777 on white is the classic near-miss: 4.48, just under AA.
    expect(white && grey && contrastRatio(grey, white)).toBeCloseTo(4.48, 1)
  })

  it('returns null for colours it cannot parse', () => {
    expect(parseColor('transparent')).toBeNull()
    expect(parseColor('rgba(0, 0, 0, 0.5)')).not.toBeNull()
    expect(parseColor('#12')).toBeNull()
  })

  it.each(['light', 'dark'] as const)('keeps every pair readable in %s', (themeName) => {
    const base = themeName === 'light' ? light : dark
    for (const pair of CONTRAST_PAIRS) {
      const fg = resolveToken(base, pair.fg)
      const bg = resolveToken(base, pair.bg)
      expect(fg, `${pair.fg} missing in ${themeName}`).toBeTruthy()
      expect(bg, `${pair.bg} missing in ${themeName}`).toBeTruthy()

      const fgRgb = parseColor(fg as string)
      const bgRgb = parseColor(bg as string)
      // Transparent and named colours are skipped on purpose: they have no
      // luminance of their own, so a ratio against them is meaningless.
      if (!fgRgb || !bgRgb) continue

      const ratio = contrastRatio(fgRgb, bgRgb)
      expect(
        ratio,
        `${themeName}: ${pair.fg} on ${pair.bg} is ${ratio.toFixed(2)}, needs ${pair.min} (${pair.note})`
      ).toBeGreaterThanOrEqual(pair.min)
    }
  })

  it.each(['light', 'dark'] as const)(
    'records the known contrast gaps in %s instead of hiding them',
    (themeName) => {
      const base = themeName === 'light' ? light : dark
      for (const gap of KNOWN_CONTRAST_GAPS) {
        const fg = parseColor(base[gap.fg])
        const bg = parseColor(base[gap.bg])
        expect(fg, `${gap.fg} missing in ${themeName}`).not.toBeNull()
        expect(bg, `${gap.bg} missing in ${themeName}`).not.toBeNull()

        const ratio = contrastRatio(fg as never, bg as never)
        // Assert the measured value, not the threshold: the point is that the
        // gap is documented. Fixing the colour must move it out of this list.
        expect(ratio, `${themeName}: ${gap.fg} on ${gap.bg} changed`).toBeCloseTo(
          gap.measured[themeName],
          1
        )

        // A gap listed only for one theme must actually pass in the other.
        if (gap.themes.includes(themeName)) {
          expect(ratio, `${gap.fg} now passes; move it to CONTRAST_PAIRS`).toBeLessThan(
            gap.min
          )
        } else {
          expect(ratio, `${gap.fg} regressed in ${themeName}`).toBeGreaterThanOrEqual(
            gap.min
          )
        }
      }
    }
  )

  it.each(THEME_PRESETS)('keeps the accent pair readable in $id', (preset) => {
    const base = preset.base === 'light' ? light : dark
    const accent = resolveToken(base, '--accent', presets)
    const accentText = resolveToken(base, '--accent-text', presets)
    expect(accent).toBeTruthy()
    expect(accentText).toBeTruthy()

    const ratio = contrastRatio(
      parseColor(accentText as string) as never,
      parseColor(accent as string) as never
    )
    expect(
      ratio,
      `${preset.id}: accent text on accent is ${ratio.toFixed(2)}`
    ).toBeGreaterThanOrEqual(4.5)
  })
})
