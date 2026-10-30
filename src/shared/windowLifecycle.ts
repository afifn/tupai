/**
 * Window lifecycle rules that do not need Electron, so they can be tested
 * directly. Main wires these into the real window events.
 */

export interface CompanionCloseContext {
  /** A settings window is currently open. */
  settingsOpen: boolean
  /** The application is quitting: the OS is closing every window anyway. */
  quitting: boolean
}

/**
 * Whether closing the main window should also close the settings window.
 *
 * Settings is a child of the main window, but Electron does not close children
 * with their parent: closing the workspace left a preferences window alive whose
 * every action needs that workspace, and on Windows it also kept the process
 * running until the user closed it separately.
 *
 * Quitting is excluded on purpose. During `app.quit()` the windows are already
 * being torn down in order, and closing another one from a `closed` handler can
 * interrupt that sequence.
 */
export function shouldCloseSettingsWithMain(ctx: CompanionCloseContext): boolean {
  if (ctx.quitting) return false
  return ctx.settingsOpen
}

/**
 * Whether the main window reference should be forgotten.
 *
 * Always true: a destroyed window must never be handed to the relaunch action or
 * the application menu, which silently did nothing while the reference stayed.
 */
export function shouldForgetMainWindow(): boolean {
  return true
}
