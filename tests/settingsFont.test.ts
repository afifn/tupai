import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MONO_FONT,
  DEFAULT_SETTINGS,
  isDefaultMonoFont,
  MONO_FONTS,
  resolveMonoFont,
  SYSTEM_MONO_FONT
} from '@shared/settings'

// "Use the default font" is a derived checkbox: ticking it writes the default
// value, and the box is checked when the stored value is that value. It used to
// compare with strict equality against MONO_FONTS[0], which meant ticking wrote
// the identical string that was already stored, so the box could never change
// state and looked broken.
describe('isDefaultMonoFont', () => {
  it('recognises the shipped default', () => {
    expect(isDefaultMonoFont(DEFAULT_MONO_FONT)).toBe(true)
  })

  it('recognises the default a fresh install gets', () => {
    expect(isDefaultMonoFont(DEFAULT_SETTINGS.editor.fontFamily)).toBe(true)
  })

  it('rejects a font the user picked', () => {
    for (const font of MONO_FONTS.slice(1)) {
      expect(isDefaultMonoFont(font)).toBe(false)
    }
  })

  // A value written by another build, or typed by hand, differs in quoting and
  // spacing only; it is still the default font.
  it('ignores quotes, spacing and case', () => {
    expect(isDefaultMonoFont('jetbrains mono, sfmono-regular, consolas, monospace')).toBe(
      true
    )
    expect(
      isDefaultMonoFont('  "JetBrains Mono",  SFMono-Regular ,Consolas,monospace ')
    ).toBe(true)
  })

  it('treats a different family as not default', () => {
    expect(isDefaultMonoFont('Consolas, monospace')).toBe(false)
    expect(isDefaultMonoFont("'Fira Code', Consolas, monospace")).toBe(false)
  })

  it('handles empty and missing values without throwing', () => {
    expect(isDefaultMonoFont('')).toBe(false)
    expect(isDefaultMonoFont(null)).toBe(false)
    expect(isDefaultMonoFont(undefined)).toBe(false)
  })

  // The round trip the checkbox performs: unticking then re-ticking must return
  // to default, and the check must report it as default afterwards.
  it('round-trips through a non-default choice', () => {
    const picked = MONO_FONTS[2]
    expect(isDefaultMonoFont(picked)).toBe(false)
    expect(isDefaultMonoFont(DEFAULT_MONO_FONT)).toBe(true)
  })

  // Unticking has to write something that is not default, or the derived checkbox
  // can never change state. The marker renders as the shipped font but reports
  // itself as "not chosen", so the box can be off.
  it('treats the system marker as not chosen', () => {
    expect(isDefaultMonoFont(SYSTEM_MONO_FONT)).toBe(false)
  })

  it('keeps the marker out of the font list', () => {
    expect(MONO_FONTS).not.toContain(SYSTEM_MONO_FONT)
  })

  // The checkbox state a user sees: ticked means a real font was chosen.
  it('distinguishes the three reachable states', () => {
    expect(isDefaultMonoFont(DEFAULT_MONO_FONT)).toBe(true)
    expect(isDefaultMonoFont(SYSTEM_MONO_FONT)).toBe(false)
    expect(isDefaultMonoFont(MONO_FONTS[1])).toBe(false)
  })
})

describe('resolveMonoFont', () => {
  it('turns the marker into the shipped stack', () => {
    expect(resolveMonoFont(SYSTEM_MONO_FONT)).toBe(DEFAULT_MONO_FONT)
  })

  it('turns an empty value into the shipped stack', () => {
    expect(resolveMonoFont('')).toBe(DEFAULT_MONO_FONT)
    expect(resolveMonoFont('   ')).toBe(DEFAULT_MONO_FONT)
    expect(resolveMonoFont(null)).toBe(DEFAULT_MONO_FONT)
    expect(resolveMonoFont(undefined)).toBe(DEFAULT_MONO_FONT)
  })

  it('passes a real font through unchanged', () => {
    const picked = MONO_FONTS[2]
    expect(resolveMonoFont(picked)).toBe(picked)
  })

  it('never returns the marker', () => {
    for (const value of [SYSTEM_MONO_FONT, '', null, undefined, ...MONO_FONTS]) {
      expect(resolveMonoFont(value)).not.toBe(SYSTEM_MONO_FONT)
    }
  })
})
