import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '@shared/ipc-contract'
import { acceleratorFor, bindingFor, type ActionId } from '@shared/keymap'
import type { MenuAction, MenuState } from '@shared/types'
import type { AppSettings } from '@shared/settings'
import { readSettings } from './settings/store'

// Menu items whose shortcut the user can rebind. The accelerator comes from the
// saved keymap so the menu never advertises a key the app does not listen for.
const KEYMAP_FOR_ACTION: Partial<Record<MenuAction, ActionId>> = {
  'settings.open': 'settings.open',
  'query.new': 'query.newTab',
  'sidebar.filter': 'sidebar.filter',
  'sessions.open': 'open.sessions',
  'users.open': 'open.users'
}

// macOS installs a default application menu whose "Close Window" item claims
// Cmd+W before the renderer sees it, so Cmd+W closed the whole window instead
// of the active tab. The menu below keeps the standard items users expect
// (quit, hide, edit, window) but deliberately leaves out every `close` role so
// the shortcut reaches the renderer, which closes one tab at a time.
//
// The app-specific items are real commands, not decoration: each one sends a
// MenuAction to the focused window and the renderer runs the same function the
// toolbar button does. Items that would do nothing are greyed out from the state
// the renderer reports.

// Which items need a connection, and which also need an engine that speaks SQL.
// Kept next to the labels so a new item cannot forget its rule.
const NEEDS_CONNECTION: MenuAction[] = [
  'query.new',
  'query.import',
  'query.history',
  'table.browse',
  'transfer.open'
]
const NEEDS_SQL: MenuAction[] = ['diagram.open', 'sync.open', 'backup.open']
// Every action that has a menu item. The item id is the action, so this is the
// only list the state pass needs.
const MENU_ACTIONS: MenuAction[] = [
  'settings.open',
  'edit.selectAll',
  'update.check',
  'about.open',
  'connection.new',
  'connection.import',
  'connection.export',
  'group.new',
  'query.new',
  'query.import',
  'query.history',
  'table.browse',
  'diagram.open',
  'transfer.open',
  'sync.open',
  'backup.open',
  'sessions.open',
  'users.open',
  'assistant.toggle',
  'sidebar.filter',
  'app.reloadTree'
]

let menuState: MenuState = {
  hasConnection: false,
  sqlEngine: false,
  supportsUsers: false,
  supportsSessions: false
}

/**
 * Greys out the items that cannot do anything yet. Called with the state the
 * renderer reports, and again after the menu is rebuilt.
 */
export function applyMenuState(state: MenuState): void {
  menuState = state
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  for (const action of MENU_ACTIONS) {
    const item = menu.getMenuItemById(action)
    if (!item) continue
    if (NEEDS_CONNECTION.includes(action)) item.enabled = state.hasConnection
    else if (NEEDS_SQL.includes(action))
      item.enabled = state.hasConnection && state.sqlEngine
    else if (action === 'users.open')
      item.enabled = state.hasConnection && state.supportsUsers
    else if (action === 'sessions.open')
      item.enabled = state.hasConnection && state.supportsSessions
  }
}

function sendMenuAction(action: MenuAction): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.menuAction, action)
}

// Translated labels, sent by the renderer whenever the language changes.
//
// The catalogue is NOT imported here on purpose: bundling all five languages
// into the main process produced a bundle that esbuild could not transpile
// ("Unterminated string literal"), and main has no other reason to carry ~6500
// strings. The renderer already has them loaded and sends just the labels this
// menu needs.
export type MenuLabels = Record<string, string>

let menuLabels: MenuLabels = {}

export function installApplicationMenu(
  settings?: AppSettings,
  labels?: MenuLabels
): void {
  if (labels) menuLabels = labels
  // A missing label falls back to the English text the renderer would send, and
  // then to the key itself, so a stale renderer cannot leave a blank menu.
  const label = (key: string): string => menuLabels[key] ?? key
  const keymap = settings?.keymap
  const accelerator = (action: MenuAction, fallback?: string): string | undefined => {
    const id = KEYMAP_FOR_ACTION[action]
    if (!id || !keymap) return fallback
    const binding = bindingFor(keymap, id)
    return binding ? acceleratorFor(binding) : fallback
  }
  const isMac = process.platform === 'darwin'
  const isDev = Boolean(process.env['ELECTRON_RENDERER_URL'])
  const devItems: MenuItemConstructorOptions[] = isDev
    ? [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }]
    : []
  const item = (
    label: string,
    action: MenuAction,
    fallbackAccelerator?: string
  ): MenuItemConstructorOptions => ({
    // The id is the action, so applyMenuState can find the item later without
    // depending on the label the user sees.
    id: action,
    label,
    accelerator: accelerator(action, fallbackAccelerator),
    click: () => sendMenuAction(action)
  })

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            // macOS renders the application menu title from the running bundle
            // (Electron.app in dev), so this label only matters on other
            // platforms; a packaged build shows "Tupai" either way.
            label: app.name,
            submenu: [
              item(label('appMenu.about'), 'about.open'),
              { type: 'separator' as const },
              item(label('appMenu.settings'), 'settings.open', 'Cmd+,'),
              item(label('appMenu.checkUpdates'), 'update.check'),
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: label('appMenu.file'),
      submenu: [
        item(label('appMenu.newConnection'), 'connection.new', 'CmdOrCtrl+N'),
        item(label('appMenu.importConnections'), 'connection.import'),
        item(label('appMenu.exportConnections'), 'connection.export'),
        { type: 'separator' },
        item(label('appMenu.newGroup'), 'group.new'),
        { type: 'separator' },
        item(label('appMenu.newQuery'), 'query.new', 'CmdOrCtrl+T'),
        item(label('appMenu.importQuery'), 'query.import'),
        item(label('appMenu.queryHistory'), 'query.history'),
        { type: 'separator' },
        ...(isMac ? [] : [{ role: 'quit' as const }])
      ]
    },
    {
      label: label('appMenu.edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        // A custom item instead of role: 'selectAll'. The role selects every
        // selectable node in the page, which is exactly the web-page behaviour
        // the renderer now avoids; this routes the command to the focused
        // field or SQL editor instead.
        item(label('appMenu.selectAll'), 'edit.selectAll', 'CmdOrCtrl+A'),
        { type: 'separator' },
        item(label('appMenu.findObjects'), 'sidebar.filter', 'CmdOrCtrl+F')
      ]
    },
    {
      label: label('appMenu.view'),
      submenu: [
        ...devItems,
        item(label('appMenu.browseTables'), 'table.browse'),
        item(label('appMenu.diagram'), 'diagram.open'),
        { type: 'separator' },
        item(label('appMenu.assistantPanel'), 'assistant.toggle', 'CmdOrCtrl+Shift+A'),
        item(label('appMenu.reloadTree'), 'app.reloadTree'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: label('appMenu.tools'),
      submenu: [
        item(label('appMenu.transfer'), 'transfer.open'),
        item(label('appMenu.sync'), 'sync.open'),
        item(label('appMenu.backup'), 'backup.open'),
        { type: 'separator' },
        item(label('appMenu.sessions'), 'sessions.open'),
        item(label('appMenu.users'), 'users.open'),
        { type: 'separator' },
        item(label('appMenu.checkUpdates'), 'update.check')
      ]
    },
    {
      label: label('appMenu.window'),
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  // A rebuild drops the enabled flags, so the last known state is re-applied.
  applyMenuState(menuState)
}

/**
 * Reads the saved keymap and rebuilds the menu. Called after a settings save so
 * a rebound shortcut shows up in the menu immediately.
 */
export async function refreshApplicationMenu(): Promise<void> {
  installApplicationMenu(await readSettings())
}

/** Called by the renderer with the translated labels for the current locale. */
export function setMenuLabels(labels: MenuLabels): void {
  menuLabels = labels
  void refreshApplicationMenu()
}
