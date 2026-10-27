import { describe, expect, it } from 'vitest'
import {
  acceleratorFor,
  bindingFor,
  bindingFromEvent,
  DEFAULT_KEYMAP,
  findConflicts,
  formatBinding,
  formatBindingLabel,
  matchesBinding,
  parseBinding,
  type Keymap
} from '@shared/keymap'

describe('parseBinding', () => {
  it('reads the stored form', () => {
    expect(parseBinding('Mod+Shift+F')).toEqual({
      mod: true,
      shift: true,
      alt: false,
      key: 'F'
    })
  })

  it('accepts a punctuation key', () => {
    expect(parseBinding('Mod+,')?.key).toBe(',')
  })

  it('keeps a literal plus as the key', () => {
    // "Mod++" is Mod and the plus key, not Mod plus an empty key.
    expect(parseBinding('Mod++')).toEqual({
      mod: true,
      shift: false,
      alt: false,
      key: '+'
    })
  })

  it('rejects an unknown modifier', () => {
    expect(parseBinding('Hyper+F')).toBeNull()
  })

  it('rejects an empty binding', () => {
    expect(parseBinding('')).toBeNull()
    expect(parseBinding('   ')).toBeNull()
  })
})

describe('formatBindingLabel', () => {
  it('uses macOS glyphs', () => {
    expect(formatBindingLabel('Mod+,', 'darwin')).toBe('⌘,')
    expect(formatBindingLabel('Mod+Shift+F', 'darwin')).toBe('⌘⇧F')
    expect(formatBindingLabel('Mod+Enter', 'darwin')).toBe('⌘↩')
  })

  it('spells modifiers on Windows and Linux', () => {
    expect(formatBindingLabel('Mod+,', 'win32')).toBe('Ctrl+,')
    expect(formatBindingLabel('Mod+Shift+F', 'win32')).toBe('Ctrl+Shift+F')
    expect(formatBindingLabel('Mod+Enter', 'linux')).toBe('Ctrl+Enter')
  })

  it('uppercases a single letter key', () => {
    expect(formatBindingLabel('Mod+w', 'win32')).toBe('Ctrl+W')
  })

  it('keeps unparseable text as it is', () => {
    expect(formatBindingLabel('Hyper+F', 'darwin')).toBe('Hyper+F')
  })
})

describe('formatBinding', () => {
  it('round-trips', () => {
    for (const text of ['Mod+F', 'Mod+Shift+F', 'Mod+,', 'Alt+Enter']) {
      const binding = parseBinding(text)
      expect(binding).not.toBeNull()
      expect(formatBinding(binding!)).toBe(text)
    }
  })
})

describe('bindingFromEvent', () => {
  it('maps the platform modifier to Mod', () => {
    const mac = bindingFromEvent({
      key: 'F',
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
      altKey: false
    })
    const win = bindingFromEvent({
      key: 'F',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false
    })
    expect(mac).toEqual(win)
    expect(mac?.mod).toBe(true)
  })

  it('ignores a bare modifier press', () => {
    expect(
      bindingFromEvent({
        key: 'Shift',
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
        altKey: false
      })
    ).toBeNull()
  })
})

describe('matchesBinding', () => {
  it('matches regardless of which platform modifier was used', () => {
    const binding = parseBinding('Mod+W')!
    expect(
      matchesBinding(
        { key: 'w', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
        binding
      )
    ).toBe(true)
    expect(
      matchesBinding(
        { key: 'w', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false },
        binding
      )
    ).toBe(true)
  })

  it('does not match when a modifier differs', () => {
    const binding = parseBinding('Mod+W')!
    expect(
      matchesBinding(
        { key: 'w', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false },
        binding
      )
    ).toBe(false)
  })

  it('does not match a plain key against a Mod binding', () => {
    const binding = parseBinding('Mod+F')!
    expect(
      matchesBinding(
        { key: 'f', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false },
        binding
      )
    ).toBe(false)
  })
})

describe('keymap', () => {
  it('ships a binding for every action', () => {
    for (const [action, value] of Object.entries(DEFAULT_KEYMAP)) {
      expect(value, action).toBeTruthy()
      expect(parseBinding(value), action).not.toBeNull()
    }
  })

  it('has no conflicts out of the box', () => {
    expect(findConflicts({})).toEqual([])
  })

  it('reports both sides of a clash', () => {
    const keymap: Keymap = { 'tab.close': 'Mod+F' }
    const conflicts = findConflicts(keymap)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toEqual(expect.arrayContaining(['sidebar.filter', 'tab.close']))
  })

  it('uses the stored value over the default', () => {
    expect(bindingFor({ 'sidebar.filter': 'Mod+K' }, 'sidebar.filter')).toEqual({
      mod: true,
      shift: false,
      alt: false,
      key: 'K'
    })
    expect(bindingFor({}, 'sidebar.filter')?.key).toBe('F')
  })
})

describe('acceleratorFor', () => {
  const accel = (text: string): string => acceleratorFor(parseBinding(text)!)

  it('maps Mod to the platform accelerator', () => {
    expect(accel('Mod+F')).toBe('CmdOrCtrl+F')
    expect(accel('Mod+,')).toBe('CmdOrCtrl+,')
    expect(accel('Mod+1')).toBe('CmdOrCtrl+1')
  })

  it('keeps shift and alt in Electron order', () => {
    expect(accel('Mod+Shift+F')).toBe('CmdOrCtrl+Shift+F')
    expect(accel('Mod+Alt+F')).toBe('CmdOrCtrl+Alt+F')
  })

  it('names keys Electron spells differently', () => {
    expect(accel('Mod+Enter')).toBe('CmdOrCtrl+Enter')
    expect(accel('Mod+ArrowUp')).toBe('CmdOrCtrl+Up')
  })

  it('works without a modifier', () => {
    expect(accel('F5')).toBe('F5')
  })
})
