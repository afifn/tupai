import { describe, expect, it } from 'vitest'
import {
  shouldCloseSettingsWithMain,
  shouldForgetMainWindow
} from '@shared/windowLifecycle'

// Closing the workspace while a preferences window stayed open left a window
// whose every action needs the workspace, and on Windows it kept the process
// alive until that window was closed too. Settings now closes with its parent.
describe('shouldCloseSettingsWithMain', () => {
  it('closes settings when the main window closes', () => {
    expect(shouldCloseSettingsWithMain({ settingsOpen: true, quitting: false })).toBe(
      true
    )
  })

  it('does nothing when no settings window is open', () => {
    expect(shouldCloseSettingsWithMain({ settingsOpen: false, quitting: false })).toBe(
      false
    )
  })

  // During app.quit() the windows are torn down in order; closing another one
  // from a `closed` handler can interrupt that sequence.
  it('never intervenes while the application is quitting', () => {
    expect(shouldCloseSettingsWithMain({ settingsOpen: true, quitting: true })).toBe(
      false
    )
    expect(shouldCloseSettingsWithMain({ settingsOpen: false, quitting: true })).toBe(
      false
    )
  })

  it('covers the whole truth table without throwing', () => {
    for (const settingsOpen of [true, false]) {
      for (const quitting of [true, false]) {
        const result = shouldCloseSettingsWithMain({ settingsOpen, quitting })
        expect(typeof result).toBe('boolean')
        if (quitting) expect(result).toBe(false)
      }
    }
  })
})

describe('shouldForgetMainWindow', () => {
  // A destroyed window must never reach the relaunch action or the menu.
  it('always forgets the main window once it is closed', () => {
    expect(shouldForgetMainWindow()).toBe(true)
  })
})
