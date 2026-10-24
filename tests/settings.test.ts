import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  normaliseModelIds,
  appSettingsSchema,
  mergeSettings,
  structuredCloneSettings
} from '@shared/settings'

describe('mergeSettings', () => {
  it('returns the defaults for an empty or missing file', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('fills a setting added after the file was written', () => {
    // A settings.json from before `restoreSession` existed must still load.
    const old = structuredCloneSettings(DEFAULT_SETTINGS)
    delete (old.general as Partial<typeof old.general>).restoreSession
    const merged = mergeSettings(old)
    expect(merged.general.restoreSession).toBe(DEFAULT_SETTINGS.general.restoreSession)
    expect(merged.general.locale).toBe(DEFAULT_SETTINGS.general.locale)
  })

  it('keeps a value the user changed', () => {
    const settings = structuredCloneSettings(DEFAULT_SETTINGS)
    settings.editor.fontSize = 17
    settings.general.themeId = 'dark'
    const merged = mergeSettings(settings)
    expect(merged.editor.fontSize).toBe(17)
    expect(merged.general.themeId).toBe('dark')
  })

  it('falls back to every default when the file is corrupt', () => {
    // One bad value must not throw away the rest of the file, but a file that is
    // not an object at all has nothing worth keeping.
    expect(mergeSettings('nonsense')).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings([1, 2, 3])).toEqual(DEFAULT_SETTINGS)
  })

  it('rejects a font size outside the usable range', () => {
    const settings = structuredCloneSettings(DEFAULT_SETTINGS)
    settings.editor.fontSize = 4
    expect(appSettingsSchema.safeParse(settings).success).toBe(false)
  })

  it('accepts the custom theme id', () => {
    const settings = structuredCloneSettings(DEFAULT_SETTINGS)
    settings.general.themeId = 'custom'
    expect(appSettingsSchema.safeParse(settings).success).toBe(true)
  })

  it('never carries an API key', () => {
    // The key belongs to ai-settings.json behind safeStorage; its presence here
    // would make "export settings" leak a secret.
    const json = JSON.stringify(DEFAULT_SETTINGS)
    expect(json).not.toContain('apiKey')
    expect(json).not.toContain('password')
  })

  it('does not share nested objects with the defaults', () => {
    const settings = structuredCloneSettings(DEFAULT_SETTINGS)
    settings.editor.fontFamily = 'changed'
    settings.customTheme.light.tokens['--bg'] = '#000000'
    settings.ai.models.push('gpt-4o-mini')
    expect(DEFAULT_SETTINGS.editor.fontFamily).not.toBe('changed')
    expect(DEFAULT_SETTINGS.customTheme.light.tokens['--bg']).toBeUndefined()
    expect(DEFAULT_SETTINGS.ai.models).toEqual([])
  })

  it('keeps a cached model list and defaults it to empty', () => {
    const settings = structuredCloneSettings(DEFAULT_SETTINGS)
    delete (settings.ai as Partial<typeof settings.ai>).models
    expect(mergeSettings(settings).ai.models).toEqual([])

    settings.ai.models = ['b', 'a']
    expect(mergeSettings(settings).ai.models).toEqual(['b', 'a'])
  })

  it('rejects a model list that is not an array of strings', () => {
    const result = appSettingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, models: [1] }
    })
    expect(result.success).toBe(false)
  })
})

describe('normaliseModelIds', () => {
  it('trims, drops blanks, removes duplicates, and sorts', () => {
    expect(normaliseModelIds([' b ', 'a', '', '  ', 'b'])).toEqual(['a', 'b'])
  })

  it('caps the list so settings.json cannot grow without bound', () => {
    const many = Array.from({ length: 600 }, (_, index) => `model-${index}`)
    expect(normaliseModelIds(many)).toHaveLength(500)
  })
})
