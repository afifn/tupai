// WCAG 2.x relative luminance and contrast ratio.
//
// Pure on purpose: the theme tests assert every token pair from Node, without a
// browser or a CSS parser. Colours that cannot be parsed (transparent, named
// colours, gradients) return null so a caller can skip them instead of
// silently treating them as black.

export interface Rgb {
  r: number
  g: number
  b: number
}

function channel(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function parseColor(value: string): Rgb | null {
  const text = (value ?? '').trim().toLowerCase()
  if (!text) return null

  if (text.startsWith('#')) {
    const hex = text.slice(1)
    if (hex.length === 3) {
      const [r, g, b] = hex.split('')
      return parseColor(`#${r}${r}${g}${g}${b}${b}`)
    }
    if (hex.length === 6 || hex.length === 8) {
      // The alpha byte of #RRGGBBAA does not change the contrast ratio against
      // an opaque background, and the palette uses it for overlays.
      const rgb = Number.parseInt(hex.slice(0, 6), 16)
      if (Number.isNaN(rgb)) return null
      return {
        r: (rgb >> 16) & 0xff,
        g: (rgb >> 8) & 0xff,
        b: rgb & 0xff
      }
    }
    return null
  }

  const match = /^rgba?\(([^)]+)\)$/.exec(text)
  if (!match) return null
  const parts = match[1].split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return null
  const [r, g, b] = parts.slice(0, 3).map((part) => {
    const n = Number.parseFloat(part)
    return Number.isNaN(n) ? Number.NaN : n
  })
  if ([r, g, b].some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null
  return { r, g, b }
}

export function relativeLuminance(color: Rgb): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

export function meetsContrast(fg: Rgb, bg: Rgb, minimum = 4.5): boolean {
  return contrastRatio(fg, bg) >= minimum
}
