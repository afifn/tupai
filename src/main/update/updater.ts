import { app, BrowserWindow, shell } from 'electron'
import { execFile } from 'child_process'
import updaterPkg from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'
import { IPC } from '@shared/ipc-contract'
import type { UpdateState } from '@shared/types'
import {
  canAutoInstall,
  describeUpdateError,
  isMissingReleaseFeedError,
  isDeveloperSigned,
  manualDownloadUrl
} from '@shared/update'
import { log } from '../logger'

// Update checks run in main because only main may replace the app bundle and
// restart. The renderer never talks to the update server: it receives a small
// state object and can ask for a check, a download, or an install.
//
// Windows: electron-updater downloads the NSIS installer that matches the
// installed platform/arch and runs it on quit. macOS: Squirrel.Mac refuses an
// unsigned bundle, so until the app ships with a Developer ID the check only
// reports the version and opens the release page. `canAutoInstall` decides which
// path is taken, so signing the build turns auto-install on with no code change.

// electron-updater ships CommonJS; the default export is the module object.
const { autoUpdater } = updaterPkg

let state: UpdateState = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  manual: false,
  downloadUrl: manualDownloadUrl()
}

// The feed is only consulted when the app is packaged: in dev electron-updater
// looks for a dev-app-update.yml that does not exist, and the version in
// package.json says nothing about what is released.
let signedCache: boolean | null = null

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(IPC.updateStateEvent, state)
  }
}

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  broadcast()
}

export function getUpdateState(): UpdateState {
  return state
}

/**
 * Reads the code signature once. `codesign -dv` writes its report to stderr and
 * exits 0 even for an ad-hoc signature, so the output is what matters, not the
 * exit code.
 */
function isSigned(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(true)
  if (signedCache !== null) return Promise.resolve(signedCache)
  return new Promise<boolean>((resolve) => {
    execFile(
      'codesign',
      ['-dv', '--verbose=2', app.getPath('exe')],
      { timeout: 5000 },
      (err, stdout, stderr) => {
        // A missing codesign or a hard failure is treated as unsigned: the
        // worst case is the user downloading the update themselves.
        const output = `${stdout ?? ''}${stderr ?? ''}`
        signedCache = !err && isDeveloperSigned(output)
        resolve(signedCache)
      }
    )
  })
}

async function computeManual(): Promise<boolean> {
  return !canAutoInstall(process.platform, app.isPackaged, await isSigned())
}

function handleUpdateError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  if (isMissingReleaseFeedError(message)) {
    setState({ phase: 'not-available', checkedAt: new Date().toISOString() })
    return
  }
  setState({ phase: 'error', message: describeUpdateError(message) })
}

export async function initUpdater(): Promise<void> {
  state = {
    ...state,
    currentVersion: app.getVersion(),
    manual: await computeManual()
  }

  if (!app.isPackaged) {
    setState({
      phase: 'unsupported',
      message: 'Pembaruan hanya berjalan pada build terpasang.'
    })
    return
  }

  // Log through the app logger so a failed update lands in the same file the
  // About page points at.
  autoUpdater.logger = {
    info: (message?: unknown) => log('info', 'updater', { message }),
    warn: (message?: unknown) => log('warn', 'updater', { message }),
    error: (message?: unknown) => log('error', 'updater', { message }),
    debug: (message?: unknown) => log('info', 'updater', { message })
  }

  // A feed other than the GitHub release. Used by the local update test and by
  // anyone hosting the artifacts themselves; the app only ever reads it, and the
  // value comes from the environment the user launched the app with, so it
  // carries no more trust than the binary itself.
  const feedUrl = process.env['TUPAI_UPDATE_URL']?.trim()
  if (feedUrl) {
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
    log('info', 'updater', { message: `Using override feed ${feedUrl}` })
  }

  // The user decides when to install; Windows downloads in the background so
  // the restart is quick, but nothing replaces the app behind their back.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    setState({ phase: 'checking', message: undefined })
  })
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    setState({
      phase: 'available',
      version: info.version,
      checkedAt: new Date().toISOString(),
      message: undefined
    })
  })
  autoUpdater.on('update-not-available', () => {
    setState({ phase: 'not-available', checkedAt: new Date().toISOString() })
  })
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    setState({
      phase: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(progress.percent)))
    })
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    setState({ phase: 'downloaded', version: info.version, percent: 100 })
  })
  autoUpdater.on('error', (err: Error) => {
    handleUpdateError(err)
  })

  setState({ phase: 'idle' })
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) {
    setState({
      phase: 'unsupported',
      message: 'Pembaruan hanya berjalan pada build terpasang.'
    })
    return state
  }
  setState({ phase: 'checking', message: undefined })
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    // An offline machine is the normal case here, so the message is kept short
    // and the phase stays recoverable by checking again.
    handleUpdateError(err)
  }
  return state
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (state.phase !== 'available') return state
  if (state.manual) {
    await openDownloadPage()
    return state
  }
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    handleUpdateError(err)
  }
  return state
}

export function installUpdate(): boolean {
  if (state.phase !== 'downloaded') return false
  // `isSilent` keeps the NSIS window out of the way; `isForceRunAfter` brings
  // the app back once the installer finishes.
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
  return true
}

export async function openDownloadPage(): Promise<boolean> {
  await shell.openExternal(state.downloadUrl ?? manualDownloadUrl())
  return true
}

/**
 * Startup check. Delayed so a slow update server never competes with the first
 * connection or the window paint.
 */
export function scheduleStartupCheck(delayMs = 8000): void {
  if (!app.isPackaged) return
  setTimeout(() => {
    void checkForUpdates()
  }, delayMs).unref()
}
