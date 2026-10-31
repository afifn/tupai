import { describe, expect, it } from 'vitest'
import { hexToHsv, hsvToHex, normalizeHex } from '@shared/colorPicker'

describe('normalizeHex', () => {
  it('accepts both hex lengths with or without the hash', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc')
    expect(normalizeHex('ABC')).toBe('#aabbcc')
    expect(normalizeHex('#1B1F24')).toBe('#1b1f24')
    expect(normalizeHex(' 1b1f24 ')).toBe('#1b1f24')
  })

  it('rejects anything that is not a colour code', () => {
    expect(normalizeHex('')).toBeNull()
    expect(normalizeHex('#12')).toBeNull()
    expect(normalizeHex('#12345')).toBeNull()
    expect(normalizeHex('#gggggg')).toBeNull()
    expect(normalizeHex('red')).toBeNull()
  })
})

describe('hexToHsv', () => {
  it('maps the primaries and greys', () => {
    expect(hexToHsv('#ff0000')).toEqual({ h: 0, s: 1, v: 1 })
    expect(hexToHsv('#00ff00')?.h).toBe(120)
    expect(hexToHsv('#0000ff')?.h).toBe(240)
    expect(hexToHsv('#ffffff')).toEqual({ h: 0, s: 0, v: 1 })
    expect(hexToHsv('#000000')).toEqual({ h: 0, s: 0, v: 0 })
  })

  it('returns null for an invalid value', () => {
    expect(hexToHsv('nope')).toBeNull()
  })
})

describe('hsvToHex', () => {
  it('round-trips every preset colour', () => {
    const presets = [
      '#1b1f24',
      '#3a4149',
      '#6d6f71',
      '#9ea0a2',
      '#c9cdd2',
      '#ffffff',
      '#b3521f',
      '#d97706',
      '#eab308',
      '#16a34a',
      '#0f766e',
      '#0891b2',
      '#2563eb',
      '#4f46e5',
      '#7c3aed',
      '#c026d3',
      '#db2777',
      '#dc2626'
    ]
    for (const hex of presets) {
      const hsv = hexToHsv(hex)
      expect(hsv).not.toBeNull()
      expect(hsvToHex(hsv!)).toBe(hex)
    }
  })

  it('wraps the hue and clamps saturation and value', () => {
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe('#ff0000')
    expect(hsvToHex({ h: -120, s: 1, v: 1 })).toBe('#0000ff')
    expect(hsvToHex({ h: 0, s: 2, v: 2 })).toBe('#ff0000')
    expect(hsvToHex({ h: 0, s: -1, v: -1 })).toBe('#000000')
  })
})
