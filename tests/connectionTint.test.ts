import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio, parseColor } from '@shared/contrast'
import { THEME_TOKEN_NAMES } from '@shared/themeTokens'

// A coloured connection row carries its identity in two places: a 14% wash over
// the whole block, and — once the session is open — the label text. The label
// shade is `color-mix(<brand> 50%, --text)`, so it cannot be read from the theme
// file as a hex value; this test recomputes the mix from the tokens and asserts
// it stays readable wherever the text can land.
//
// 4.5:1 is the WCAG AA floor for body text. Without this test the shade can be
// nudged toward the brand colour for looks and silently drop under the floor,
// which is exactly what happened before: the raw brand colour measured 2.55:1.

const THEME_DIR = resolve('src/renderer/src/theme/themes')

/** Percentage of brand colour in the label shade. Mirrors styles.css. */
const LABEL_BRAND_SHARE = 0.5
/** Wash alpha per tint, as written in styles.css. Amber is the one exception. */
const WASH_ALPHA = 0.14
const AMBER_WASH_ALPHA = 0.16

const TINTS = [
  'slate',
  'red',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink'
] as const

interface Rgb {
  r: number
  g: number
  b: number
}

function parseTokens(file: string): Record<string, string> {
  const css = readFileSync(resolve(THEME_DIR, file), 'utf8')
  const tokens: Record<string, string> = {}
  const declRe = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi
  let match: RegExpExecArray | null
  while ((match = declRe.exec(css)) !== null) tokens[match[1]] = match[2].trim()
  return tokens
}

/** Linear mix of two opaque colours, the same maths `color-mix` performs. */
function mix(a: Rgb, b: Rgb, shareOfA: number): Rgb {
  return {
    r: a.r * shareOfA + b.r * (1 - shareOfA),
    g: a.g * shareOfA + b.g * (1 - shareOfA),
    b: a.b * shareOfA + b.b * (1 - shareOfA)
  }
}

/** Paint a translucent colour over an opaque one. */
function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return mix(fg, bg, alpha)
}

const light = parseTokens('light.css')
const dark = parseTokens('dark.css')

/**
 * Identity colours are declared only in light.css on purpose: a connection is
 * the same connection in both themes, so `--conn-*` must not shift with the
 * palette (themeTokens.test.ts enforces that). In the real cascade the dark
 * theme inherits them, so this resolves the same way instead of failing on a
 * token that is correctly absent from dark.css.
 */
function paletteFor(themeName: 'light' | 'dark'): Record<string, string> {
  return themeName === 'light' ? light : { ...light, ...dark }
}

function rgb(token: string, base: Record<string, string>): Rgb {
  const value = base[token]
  expect(value, `${token} is missing`).toBeTruthy()
  const parsed = parseColor(value)
  expect(parsed, `${token} is not a parseable colour: ${value}`).not.toBeNull()
  return parsed as Rgb
}

describe('connection identity colours', () => {
  it('declares every tint the stylesheet uses', () => {
    for (const tint of TINTS) {
      expect(THEME_TOKEN_NAMES, `--conn-${tint}`).toContain(`--conn-${tint}`)
    }
  })

  it.each(['light', 'dark'] as const)(
    'keeps the connected label readable in %s',
    (themeName) => {
      const base = paletteFor(themeName)
      const surface = rgb('--surface', base)
      const hover = rgb('--surface-hover', base)
      const text = rgb('--text', base)

      for (const tint of TINTS) {
        const brand = rgb(`--conn-${tint}`, base)
        const label = mix(brand, text, LABEL_BRAND_SHARE)
        const alpha = tint === 'amber' ? AMBER_WASH_ALPHA : WASH_ALPHA
        const wash = over(brand, surface, alpha)

        // The label sits on the wash normally, and on the opaque hover
        // background while the pointer is over the row, which hides the wash.
        const onWash = contrastRatio(label, wash)
        const onHover = contrastRatio(label, hover)

        expect(
          onWash,
          `${themeName}: ${tint} label on its wash is ${onWash.toFixed(2)}, needs 4.5`
        ).toBeGreaterThanOrEqual(4.5)
        expect(
          onHover,
          `${themeName}: ${tint} label on hover is ${onHover.toFixed(2)}, needs 4.5`
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  )

  it.each(['light', 'dark'] as const)(
    'keeps the neutral label readable on every wash in %s',
    (themeName) => {
      // A disconnected coloured row shows --text on the wash. This is the state
      // most rows are in, so it must clear the floor with plenty of room.
      const base = paletteFor(themeName)
      const surface = rgb('--surface', base)
      const text = rgb('--text', base)

      for (const tint of TINTS) {
        const brand = rgb(`--conn-${tint}`, base)
        const alpha = tint === 'amber' ? AMBER_WASH_ALPHA : WASH_ALPHA
        const wash = over(brand, surface, alpha)
        const ratio = contrastRatio(text, wash)
        expect(
          ratio,
          `${themeName}: neutral label on the ${tint} wash is ${ratio.toFixed(2)}`
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  )

  it('documents that the raw brand colour is not usable as label text', () => {
    // The reason the label uses a mixed shade instead of the token itself. If a
    // future palette makes the raw colours readable, this assertion fails and
    // the mix can be simplified — that is a deliberate signal, not noise.
    const base = paletteFor('light')
    const surface = rgb('--surface', base)
    const unreadable = TINTS.filter((tint) => {
      const brand = rgb(`--conn-${tint}`, base)
      const alpha = tint === 'amber' ? AMBER_WASH_ALPHA : WASH_ALPHA
      return contrastRatio(brand, over(brand, surface, alpha)) < 4.5
    })
    expect(unreadable.length).toBeGreaterThan(0)
  })
})
