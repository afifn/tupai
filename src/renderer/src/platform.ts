// Shortcut labels must match the platform the window is running on: macOS uses
// the Command key, Windows and Linux use Ctrl. Key handling in the renderer
// already accepts both (ctrlKey || metaKey); only the text shown to the user
// was hardcoded to Ctrl.
const isMac = window.dbApi.platform === 'darwin'

export const MOD_KEY = isMac ? '\u2318' : 'Ctrl'

// Builds labels like "Ctrl+Enter" or "⌘Enter". Keys are joined with "+" on
// Windows/Linux and concatenated on macOS, matching how the OS spells them.
export function shortcutLabel(...keys: string[]): string {
  return isMac ? MOD_KEY + keys.join('') : [MOD_KEY, ...keys].join('+')
}
