import { release as osRelease } from 'os'

// Whether this build can use a native title-bar overlay: the OS draws the
// caption buttons inside the toolbar row, which lets the toolbar double as the
// title bar without the app drawing minimise/maximise/close itself.
//
// Windows 11 (build 22000) and later support it. Windows 10 ignores the option,
// which would leave the window with no controls at all, so it keeps the native
// frame. Linux uses the same mechanism through GTK. macOS is excluded: it uses
// `titleBarStyle: 'hiddenInset'` and the traffic lights instead.
//
// Kept in its own module because both the window creation and the IPC handlers
// need the answer, and Electron offers no getter for it.

export function supportsTitleBarOverlay(): boolean {
  if (process.platform === 'win32') {
    const build = Number(osRelease().split('.')[2])
    return Number.isFinite(build) && build >= 22000
  }
  return process.platform === 'linux'
}
