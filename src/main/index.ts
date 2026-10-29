import { app, BrowserWindow, ipcMain, nativeImage, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { registerDbHandlers, disposeDbHandlers } from './ipc/dbHandlers'
import { supportsTitleBarOverlay } from './windowChrome'
import { refreshApplicationMenu } from './menu'
import { initUpdater, scheduleStartupCheck } from './update/updater'
import { log } from './logger'
import { IPC } from '@shared/ipc-contract'
import { titleBarColorsSchema } from '@shared/schemas'
import { toIpcResult } from './workers/dbWorkerClient'
import {
  registerSettingsWindowHandlers,
  setMainWindow,
  settingsWindowForSender
} from './settingsWindow'

// Whether this window got `titleBarOverlay` at creation. Electron has no getter
// for it, so the decision is made once and both the window state and the IPC
// handler read it from here.
let titleBarOverlayEnabled = false

export function titleBarOverlayActive(): boolean {
  return titleBarOverlayEnabled
}
// electron-vite copies the file into out/ and hands back the runtime path. The
// packaged exe already embeds build/icon.png through electron-builder, but the
// dev window and the Linux build need it explicitly or they show the default
// Electron logo in the taskbar.
import appIcon from '../../build/icon.png?asset'

// The product used to be called "DB Manager" and its data lived in a
// `db-manager` folder. Electron derives that folder from the product name, so
// renaming to "Tupai" would silently start a new profile with no connections.
//
// Copying the folder is not safe: passwords and the AI key are encrypted with
// a DPAPI key stored in Chromium's `Local State`, and a copied ciphertext only
// decrypts against the exact key that produced it. Moving the folder without
// that key makes every saved password unreadable.
//
// Pointing userData at the existing folder instead keeps every key valid. New
// installs, which have no legacy folder, get the new `Tupai` location.
const legacyUserData = join(app.getPath('appData'), 'db-manager')
// An explicit --user-data-dir is a deliberate choice (portable profile, smoke
// test); redirecting it to the legacy folder would read and write the user's
// real connections instead. Electron applies the switch before this point, so
// a userData path that is not the default one means the switch was passed.
const defaultUserData = join(app.getPath('appData'), app.name)
if (
  app.getPath('userData') === defaultUserData &&
  existsSync(join(legacyUserData, 'connections.json'))
) {
  app.setPath('userData', legacyUserData)
}

// The database worker cannot import electron, but it needs the same userData
// directory for the SSH host key store. Exporting it here keeps a single source
// of truth; the worker inherits the variable when it is spawned.
process.env.TUPAI_USER_DATA = app.getPath('userData')

// Must match `appId` in electron-builder.yml. Without it Windows groups the
// window under electron.exe in dev and can fall back to the default Electron
// icon in the taskbar even when the window icon is set.
if (process.platform === 'win32') app.setAppUserModelId('com.tupai.app')

// In dev the running bundle is Electron.app, so the Dock shows the Electron
// logo no matter what the window icon says: on macOS the Dock icon comes from
// the bundle, not from BrowserWindow. Setting it explicitly keeps the Tupai mark
// while developing. A packaged build reads icon.icns from its own bundle, so
// this is skipped there to avoid overriding a signed icon.
if (process.platform === 'darwin' && !app.isPackaged) {
  app.whenReady().then(() => {
    const image = nativeImage.createFromPath(appIcon)
    if (!image.isEmpty()) app.dock?.setIcon(image)
  })
}

process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException', { message: err.message, stack: err.stack })
})

process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection', {
    message: reason instanceof Error ? reason.message : String(reason)
  })
})

function createWindow(): void {
  // Windows and Linux draw their own caption buttons, so the toolbar row can
  // only become the title bar when the overlay puts those buttons inside it.
  // `titleBarOverlay` is Windows 11+ and Linux (GTK); Windows 10 ignores it and
  // would end up with no window controls at all, so the native frame stays there.
  const usesTitleBarOverlay = supportsTitleBarOverlay()
  titleBarOverlayEnabled = usesTitleBarOverlay

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    // Below this size the object tree, editor, and result grid stop being
    // usable at the same time: with the dock open the editor would get under
    // 480px. The window refuses to shrink further.
    minWidth: 1024,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Tupai',
    // The toolbar is the title bar: hiding the native one puts the window
    // controls on the toolbar row and gives back the 28px the title used to
    // occupy. macOS uses `hiddenInset` so the traffic lights keep their standard
    // offset. Windows and Linux keep `frame: true` and use `titleBarOverlay`,
    // which draws the caption buttons inside the toolbar while the OS still
    // owns their behaviour (snap layout, resize border, system menu). The
    // overlay colours are placeholder values: the renderer reports the real
    // toolbar colour once the theme is known, because a CSS variable cannot
    // reach the native overlay.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : usesTitleBarOverlay
        ? {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: { color: '#ffffff', symbolColor: '#1b1f24', height: 44 }
          }
        : {}),
    // Windows takes the taskbar icon from the exe, but dev runs electron.exe and
    // macOS/Linux use the window icon. Keep both paths on the same mark.
    icon: appIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  setMainWindow(win)

  win.on('ready-to-show', () => win.show())

  // The overlay is native, so it cannot follow the theme by itself. The renderer
  // measures the toolbar and reports both colours whenever the theme changes.
  if (usesTitleBarOverlay) {
    ipcMain.handle(IPC.titleBarColors, (event, raw) => {
      const targetWindow =
        event.sender === win.webContents ? win : settingsWindowForSender(event.sender)
      if (!targetWindow) return { ok: true, data: true }
      try {
        const { color, symbolColor, height } = titleBarColorsSchema.parse(raw)
        targetWindow.setTitleBarOverlay({ color, symbolColor, height })
        return { ok: true, data: true }
      } catch (err) {
        return toIpcResult<boolean>(err)
      }
    })
  }

  // In fullscreen macOS hides the traffic lights, so the toolbar must stop
  // reserving room for them. The renderer cannot see native fullscreen itself.
  const sendWindowState = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send(IPC.windowState, {
      fullscreen: win.isFullScreen(),
      titleBarOverlay: titleBarOverlayEnabled
    })
  }
  win.on('enter-full-screen', sendWindowState)
  win.on('leave-full-screen', sendWindowState)

  win.webContents.on('render-process-gone', (_event, details) => {
    log('error', 'render-process-gone', details)
  })

  win.webContents.on('preload-error', (_event, path, error) => {
    log('error', 'preload-error', { path, message: error.message })
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (!devUrl || !url.startsWith(devUrl)) {
      event.preventDefault()
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Runs before any store reads userData, so a renamed product keeps its
  // connections and saved queries.
  log('info', 'app ready')
  // Built from the saved keymap so the menu shows the shortcuts the app really
  // listens for, including any the user rebound.
  void refreshApplicationMenu()
  registerDbHandlers()
  registerSettingsWindowHandlers()
  // The updater is initialised before the window so the first paint already has
  // a state to render instead of flashing "idle".
  void initUpdater().then(() => scheduleStartupCheck())
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void disposeDbHandlers()
})
