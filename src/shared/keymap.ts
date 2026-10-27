// Shortcuts the user can rebind. Only shell actions live here: Monaco owns its
// own editing keys (undo, comment, multi-cursor), and overriding those would
// mean fighting the editor instead of configuring the app.

export const KEYMAP_ACTIONS = [
  'settings.open',
  'query.newTab',
  'query.run',
  'tab.close',
  'sidebar.filter',
  'view.data',
  'view.structure',
  'view.io',
  'open.sessions',
  'open.users'
] as const

export type ActionId = (typeof KEYMAP_ACTIONS)[number]

// These match the shortcuts the app already had, so an upgrade does not change
// any behaviour for someone who never opens the keymap page.
export const DEFAULT_KEYMAP: Record<ActionId, string> = {
  'settings.open': 'Mod+,',
  'query.newTab': 'Mod+1',
  'query.run': 'Mod+Enter',
  'tab.close': 'Mod+W',
  'sidebar.filter': 'Mod+F',
  'view.data': 'Mod+3',
  'view.structure': 'Mod+4',
  'view.io': 'Mod+5',
  'open.sessions': 'Mod+6',
  'open.users': 'Mod+2'
}

export interface Binding {
  // Cmd on macOS, Ctrl elsewhere. One flag so a profile follows the platform
  // instead of pinning a macOS-only shortcut to Windows.
  mod: boolean
  shift: boolean
  alt: boolean
  key: string
}

const MODIFIERS = new Set(['mod', 'shift', 'alt'])

/**
 * Parse a stored binding such as `Mod+Shift+F` or `Mod+,`.
 *
 * The key is the last segment, so a literal `+` key is written `Mod++` and the
 * parser keeps it as `+` instead of treating it as a separator.
 */
export function parseBinding(text: string): Binding | null {
  const value = (text ?? '').trim()
  if (!value) return null
  // A trailing "+" means the key itself is "+": `Mod++` is Mod plus the plus
  // key. Splitting naively would leave an empty key and drop the binding.
  const plusKey = value.endsWith('+')
  const parts = (plusKey ? value.slice(0, -1) : value).split('+')
  const key = plusKey ? '+' : (parts.pop() ?? '')
  const binding: Binding = {
    mod: false,
    shift: false,
    alt: false,
    key
  }
  for (const part of parts) {
    const flag = part.trim().toLowerCase()
    if (!flag) continue
    if (!MODIFIERS.has(flag)) return null
    if (flag === 'mod') binding.mod = true
    if (flag === 'shift') binding.shift = true
    if (flag === 'alt') binding.alt = true
  }
  if (!binding.key) return null
  return binding
}

// Keys whose name is shorter as a glyph on macOS. The stored form keeps the
// DOM name so event matching stays platform-neutral; only the label changes.
const MAC_KEY_GLYPHS: Record<string, string> = {
  Enter: '↩',
  Escape: '⎋',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→'
}

/**
 * Human label for a stored binding on the host platform: `⌘⇧F` on macOS,
 * `Ctrl+Shift+F` on Windows/Linux. Settings used to print the raw stored form
 * (`Mod+Shift+F`), which is not a key anyone can press.
 */
export function formatBindingLabel(text: string, platform: string): string {
  const binding = parseBinding(text)
  if (!binding) return text
  const key = binding.key.length === 1 ? binding.key.toUpperCase() : binding.key
  if (platform === 'darwin') {
    return `${binding.mod ? '⌘' : ''}${binding.shift ? '⇧' : ''}${
      binding.alt ? '⌥' : ''
    }${MAC_KEY_GLYPHS[key] ?? key}`
  }
  const parts: string[] = []
  if (binding.mod) parts.push('Ctrl')
  if (binding.shift) parts.push('Shift')
  if (binding.alt) parts.push('Alt')
  parts.push(key)
  return parts.join('+')
}

export function formatBinding(binding: Binding): string {
  const parts: string[] = []
  if (binding.mod) parts.push('Mod')
  if (binding.shift) parts.push('Shift')
  if (binding.alt) parts.push('Alt')
  parts.push(binding.key)
  return parts.join('+')
}

/** Two bindings collide when every flag and the key match, ignoring key case. */
export function sameBinding(a: Binding, b: Binding): boolean {
  return (
    a.mod === b.mod &&
    a.shift === b.shift &&
    a.alt === b.alt &&
    a.key.toLowerCase() === b.key.toLowerCase()
  )
}

export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export function bindingFromEvent(event: KeyEventLike): Binding | null {
  // A bare modifier press is not a shortcut; recording it would store "Shift".
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return null
  return {
    mod: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
    key: event.key
  }
}

/** True when the event matches the binding, ignoring the OS-specific modifier. */
export function matchesBinding(event: KeyEventLike, binding: Binding): boolean {
  return sameBinding(
    bindingFromEvent(event) ?? { mod: false, shift: false, alt: false, key: '' },
    binding
  )
}

export type Keymap = Partial<Record<ActionId, string>>

/** Effective binding for an action: the user's value, or the shipped default. */
export function bindingFor(keymap: Keymap, action: ActionId): Binding | null {
  return parseBinding(keymap[action] ?? DEFAULT_KEYMAP[action])
}

/**
 * Electron accelerator text for a stored binding, so the native menu shows the
 * same shortcut the app actually listens for. A rebind in Settings therefore
 * updates the menu instead of leaving a stale hint next to it.
 */
export function acceleratorFor(binding: Binding): string {
  const parts: string[] = []
  if (binding.mod) parts.push('CmdOrCtrl')
  if (binding.shift) parts.push('Shift')
  if (binding.alt) parts.push('Alt')
  // Electron names a few keys differently from the DOM event.key used here.
  const key = binding.key.length === 1 ? binding.key.toUpperCase() : binding.key
  const names: Record<string, string> = {
    Enter: 'Enter',
    Escape: 'Escape',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ' ': 'Space'
  }
  parts.push(names[key] ?? key)
  return parts.join('+')
}

/**
 * Actions that share a shortcut. Returned as groups so the settings page can
 * name both sides of a clash instead of only the one being recorded.
 */
export function findConflicts(keymap: Keymap): ActionId[][] {
  const byKey = new Map<string, ActionId[]>()
  for (const action of KEYMAP_ACTIONS) {
    const binding = bindingFor(keymap, action)
    if (!binding) continue
    const signature = formatBinding(binding)
    const list = byKey.get(signature) ?? []
    list.push(action)
    byKey.set(signature, list)
  }
  return [...byKey.values()].filter((list) => list.length > 1)
}
