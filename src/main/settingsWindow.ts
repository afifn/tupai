import { BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { z } from 'zod'
import { IPC } from '@shared/ipc-contract'
import { supportsTitleBarOverlay } from './windowChrome'
import appIcon from '../../build/icon.png?asset'

const settingsSectionSchema = z.enum([
  'general',
  'appearance',
  'editor',
  'grid',
  'oracle',
  'ai',
  'keymap',
  'about'
])

let settingsWindow: BrowserWindow | null = null
let mainWindow: BrowserWindow | null = null

/**
 * Records the main window, or clears it once it is gone.
 *
 * Clearing matters: the settings window is a child of the main one, and the
 * relaunch action and the application menu both resolve the main window through
 * here. A stale reference pointed at a destroyed window, so the next action
 * silently did nothing.
 */
export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

export function mainWindowForMenu(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export function isSettingsWindow(sender: Electron.WebContents): boolean {
  return settingsWindow?.webContents === sender
}

/** Whether a settings window is currently open. */
export function hasSettingsWindow(): boolean {
  return settingsWindow !== null && !settingsWindow.isDestroyed()
}

export function settingsWindowForSender(
  sender: Electron.WebContents
): BrowserWindow | null {
  return settingsWindow?.webContents === sender && !settingsWindow.isDestroyed()
    ? settingsWindow
    : null
}

export function openSettingsWindow(section: unknown = 'general'): void {
  const parsed = settingsSectionSchema.safeParse(section)
  const targetSection = parsed.success ? parsed.data : 'general'
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    void settingsWindow.webContents.executeJavaScript(
      `window.location.hash = ${JSON.stringify(`settings=${targetSection}`)}`
    )
    return
  }

  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  const usesTitleBarOverlay = supportsTitleBarOverlay()
  const win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    show: false,
    title: 'Tupai',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : usesTitleBarOverlay
        ? {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: {
              color: 'rgba(0,0,0,0)',
              symbolColor: '#1b1f24',
              height: 44
            }
          }
        : {}),
    icon: appIcon,
    ...(parent ? { parent } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  settingsWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (!rendererUrl || !url.startsWith(rendererUrl)) event.preventDefault()
  })
  win.webContents.on('render-process-gone', () => {
    if (!win.isDestroyed()) win.close()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(`${devUrl}#settings=${targetSection}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: `settings=${targetSection}`
    })
  }
}

/**
 * Closes the settings window, if one is open.
 *
 * Called when the main window closes: settings is a child of it, and nothing it
 * shows can be applied once the workspace is gone. Leaving it open stranded a
 * window that could not do anything, and on Windows it also kept the process
 * alive until the user closed it separately.
 */
export function closeSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close()
}

export function registerSettingsWindowHandlers(): void {
  ipcMain.handle(IPC.openSettingsWindow, (_event, rawSection) => {
    const parsed = settingsSectionSchema.safeParse(rawSection)
    if (!parsed.success) return { ok: false, error: 'Bagian pengaturan tidak valid.' }
    openSettingsWindow(parsed.data)
    return { ok: true, data: true }
  })

  ipcMain.handle(IPC.closeSettingsWindow, (event) => {
    if (settingsWindow?.webContents === event.sender && !settingsWindow.isDestroyed()) {
      settingsWindow.close()
    }
    return { ok: true, data: true }
  })
}

export function broadcastSettingsChanged(except?: Electron.WebContents): void {
  for (const win of [mainWindow, settingsWindow]) {
    if (win && !win.isDestroyed() && win.webContents !== except) {
      win.webContents.send(IPC.settingsChanged)
    }
  }
}
