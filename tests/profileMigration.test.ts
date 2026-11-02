import { describe, expect, it } from 'vitest'
import {
  CORE_PROFILE_FILES,
  isUserDataEntry,
  mergeLegacySettings,
  planKeyStore,
  planProfileMigration,
  ranMigration
} from '@shared/profileMigration'

// An upgrade from the "DB Manager" build lands on a new profile folder. When the
// old connections did not come along it looked like the app had lost the user's
// data, which is what these rules fix.
describe('planProfileMigration', () => {
  const legacyWithData = { legacyExists: true, legacyHasData: true }

  it('copies everything when the new folder does not exist yet', () => {
    expect(
      planProfileMigration({ ...legacyWithData, targetExists: false, targetEntries: [] })
    ).toBe('copy-all')
  })

  it('copies everything when the new folder holds only Chromium cache', () => {
    // A first run of the new version creates the folder and starts Chromium, but
    // there is nothing of the user's in it.
    expect(
      planProfileMigration({
        ...legacyWithData,
        targetExists: true,
        targetEntries: ['Cache', 'Code Cache', 'GPUCache', 'Network', 'Preferences']
      })
    ).toBe('copy-all')
  })

  // The case that used to be skipped silently: the new version ran once and wrote
  // its own settings, so the copy was refused and no connection arrived.
  it('merges the user-data entries when the new folder already has data', () => {
    expect(
      planProfileMigration({
        ...legacyWithData,
        targetExists: true,
        targetEntries: ['settings.json', 'Cache', 'Local State']
      })
    ).toBe('copy-core')
  })

  it('does nothing when there is no legacy profile', () => {
    expect(
      planProfileMigration({
        legacyExists: false,
        legacyHasData: false,
        targetExists: false,
        targetEntries: []
      })
    ).toBe('skip')
  })

  // A legacy folder left behind after a successful migration must not copy again.
  it('does nothing when the legacy folder holds no user data', () => {
    expect(
      planProfileMigration({
        legacyExists: true,
        legacyHasData: false,
        targetExists: true,
        targetEntries: ['connections.json']
      })
    ).toBe('skip')
  })
})

describe('isUserDataEntry', () => {
  it('recognises the files the app owns', () => {
    for (const file of CORE_PROFILE_FILES) {
      expect(isUserDataEntry(file), file).toBe(true)
    }
  })

  it('recognises the user-data directories', () => {
    expect(isUserDataEntry('queries')).toBe(true)
    expect(isUserDataEntry('history')).toBe(true)
    expect(isUserDataEntry('Logs')).toBe(true)
  })

  it('treats Chromium caches as disposable', () => {
    for (const name of [
      'Cache',
      'Code Cache',
      'GPUCache',
      'ShaderCache',
      'Network',
      'blob_storage'
    ]) {
      expect(isUserDataEntry(name), name).toBe(false)
    }
  })

  it('is case-insensitive', () => {
    expect(isUserDataEntry('CONNECTIONS.JSON')).toBe(true)
    expect(isUserDataEntry('cache')).toBe(false)
  })

  // Being wrong in this direction only copies less, never destroys anything, so
  // an unknown name counts as data.
  it('counts an unknown entry as data rather than cache', () => {
    expect(isUserDataEntry('something-new-from-chromium')).toBe(true)
  })
})

// A secret written in one profile cannot be read in another: measured on Windows,
// decryption fails until the key that wrote it is the key in use. So the key has
// to travel with the secrets, and only while the destination owns none.
describe('planKeyStore', () => {
  it('adopts the legacy key when the new profile has no secrets', () => {
    expect(planKeyStore({ targetHasSecrets: false, legacyHasKeyStore: true })).toBe(
      'adopt-legacy'
    )
  })

  // Replacing the key here would make the secrets the user already saved in the
  // new profile unreadable, which is worse than retyping the old passwords.
  it('keeps the new key when it already protects a secret', () => {
    expect(planKeyStore({ targetHasSecrets: true, legacyHasKeyStore: true })).toBe(
      'keep-target'
    )
  })

  it('keeps the new key when the legacy profile has no key store', () => {
    expect(planKeyStore({ targetHasSecrets: false, legacyHasKeyStore: false })).toBe(
      'keep-target'
    )
  })
})

describe('mergeLegacySettings', () => {
  const defaults = {
    general: { locale: 'en', themeId: 'light' },
    oracle: { clientLibDir: '' },
    editor: { fontFamily: 'default-mono', fontSize: 13 },
    grid: { pageSize: 50 }
  }

  it('takes the old value when the new profile still holds the default', () => {
    const target = { ...defaults, general: { ...defaults.general } }
    const legacy = {
      ...defaults,
      general: { locale: 'en', themeId: 'dark-forest' },
      oracle: { clientLibDir: 'D:/oracle/bin' }
    }
    const merged = mergeLegacySettings(target, legacy, defaults)
    expect(merged.general.themeId).toBe('dark-forest')
    expect(merged.oracle.clientLibDir).toBe('D:/oracle/bin')
  })

  // The new version writes defaults on first run, so the file exists. Replacing
  // it wholesale would undo a choice the user just made in the new build.
  it('keeps a value the user already changed in the new profile', () => {
    const target = {
      ...defaults,
      general: { locale: 'id', themeId: 'light' },
      editor: { fontFamily: 'Consolas', fontSize: 15 }
    }
    const legacy = {
      ...defaults,
      general: { locale: 'en', themeId: 'dark-forest' },
      editor: { fontFamily: 'Fira Code', fontSize: 13 }
    }
    const merged = mergeLegacySettings(target, legacy, defaults)
    expect(merged.general.locale).toBe('id')
    expect(merged.editor.fontFamily).toBe('Consolas')
    expect(merged.editor.fontSize).toBe(15)
  })

  it('merges per value, not per section', () => {
    // One changed field must not freeze the whole section.
    const target = {
      ...defaults,
      editor: { fontFamily: 'Consolas', fontSize: 13 }
    }
    const legacy = {
      ...defaults,
      editor: { fontFamily: 'Fira Code', fontSize: 16 }
    }
    const merged = mergeLegacySettings(target, legacy, defaults)
    expect(merged.editor.fontFamily).toBe('Consolas')
    expect(merged.editor.fontSize).toBe(16)
  })

  it('fills a key the new profile does not have', () => {
    const target = { general: { locale: 'en' } } as typeof defaults
    const legacy = {
      ...defaults,
      general: { locale: 'en', themeId: 'dark-forest' }
    }
    expect(mergeLegacySettings(target, legacy, defaults).general.themeId).toBe(
      'dark-forest'
    )
  })
})

describe('ranMigration', () => {
  it('is false when nothing happened', () => {
    expect(ranMigration(null)).toBe(false)
  })

  it('is true when files were carried over', () => {
    expect(
      ranMigration({
        action: 'copy-core',
        legacyDir: 'C:/old',
        copied: ['connections.json'],
        needsAttention: []
      })
    ).toBe(true)
  })
})
