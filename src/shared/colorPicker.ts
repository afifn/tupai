/**
 * Colour conversions for the in-app picker.
 *
 * Kept here, free of React, so the hue maths can be tested directly. HSV is the
 * working space because a saturation/value square plus a hue slider is easier to
 * operate than three RGB sliders, and it round-trips to hex without losing the
 * value the user typed.
 */

export interface Hsv {
  // Degrees, 0..359.
  h: number
  // 0..1.
  s: number
  // 0..1.
  v: number
}

const HEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/**
 * Accepts `#rgb`, `rgb`, `#rrggbb`, or `rrggbb` and returns the six-digit form.
 * Returns null for anything else so a half-typed value never reaches settings.
 */
export function normalizeHex(text: string): string | null {
  const match = HEX.exec(text.trim())
  if (!match) return null
  const digits = match[1]
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((char) => char + char)
          .join('')
      : digits
  return `#${full.toLowerCase()}`
}

export function hexToHsv(hex: string): Hsv | null {
  const normalized = normalizeHex(hex)
  if (!normalized) return null
  const r = Number.parseInt(normalized.slice(1, 3), 16) / 255
  const g = Number.parseInt(normalized.slice(3, 5), 16) / 255
  const b = Number.parseInt(normalized.slice(5, 7), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min

  let h = 0
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
    if (h < 0) h += 360
  }

  return { h, s: max === 0 ? 0 : delta / max, v: max }
}

function channel(value: number): string {
  return Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, '0')
}

export function hsvToHex(hsv: Hsv): string {
  const h = ((hsv.h % 360) + 360) % 360
  const s = Math.min(1, Math.max(0, hsv.s))
  const v = Math.min(1, Math.max(0, hsv.v))
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c

  let rgb: [number, number, number]
  if (h < 60) rgb = [c, x, 0]
  else if (h < 120) rgb = [x, c, 0]
  else if (h < 180) rgb = [0, c, x]
  else if (h < 240) rgb = [0, x, c]
  else if (h < 300) rgb = [x, 0, c]
  else rgb = [c, 0, x]

  return `#${channel(rgb[0] + m)}${channel(rgb[1] + m)}${channel(rgb[2] + m)}`
}
