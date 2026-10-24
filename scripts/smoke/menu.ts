// Menu checks: the native application menu is built in main, so this runs in
// main too. It creates the real window, then clicks menu items and reads the
// DOM to prove each one reaches the renderer and does something.
import { app, BrowserWindow, Menu } from 'electron'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { registerDbHandlers } from '../../src/main/ipc/dbHandlers'
import { refreshApplicationMenu } from '../../src/main/menu'

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Runs in the page. Kept as a string so it is not bundled with main's types.
async function evaluate<T>(win: BrowserWindow, script: string): Promise<T> {
  return (await win.webContents.executeJavaScript(script, true)) as T
}

async function waitFor(
  win: BrowserWindow,
  expression: string,
  tries = 60
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await evaluate<boolean>(win, `Boolean(${expression})`)) return true
    await sleep(250)
  }
  return false
}

/** Finds a menu item by its label, across every top-level menu. */
function findMenuItem(label: string): Electron.MenuItem | null {
  const menu = Menu.getApplicationMenu()
  if (!menu) return null
  for (const top of menu.items) {
    for (const item of top.submenu?.items ?? []) {
      if (item.label === label) return item
    }
  }
  return null
}

function clickMenu(label: string): boolean {
  const item = findMenuItem(label)
  if (!item || !item.enabled) return false
  item.click()
  return true
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tupai-menu-'))
  app.setPath('userData', dir)
  process.env.TUPAI_USER_DATA = dir
  // The SQLite adapter opens with fileMustExist, and an empty file is a valid
  // empty database, so the file has to exist before the connection is used.
  await writeFile(join(dir, 'm.db'), '')
  await writeFile(
    join(dir, 'connections.json'),
    JSON.stringify([
      {
        id: 'menu-sqlite',
        name: 'Menu SQLite',
        engine: 'sqlite',
        file: join(dir, 'm.db')
      }
    ])
  )

  registerDbHandlers()

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(process.cwd(), 'out/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  await win.loadFile(join(process.cwd(), 'out/renderer/index.html'))
  win.show()

  const mounted = await waitFor(
    win,
    'window.dbApi && document.querySelector(".menubar")',
    120
  )
  check('window mounts', mounted)

  // Configure the assistant and connect the seeded SQLite connection, so the
  // connection-scoped items have a target and the dock can render its composer.
  await evaluate<boolean>(
    win,
    `(async () => {
      const s = await window.dbApi.getSettings()
      s.data.ai.baseUrl = 'http://127.0.0.1:8799/v1'
      s.data.ai.model = 'fake-model'
      await window.dbApi.saveSettings(s.data)
      await window.dbApi.saveAiSettings({ baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'k', model: 'fake-model' })
      await window.dbApi.connect('menu-sqlite')
      return true
    })()`
  )
  // The sidebar only learns about a connection by reading it on mount, and the
  // menu state follows the focused connection, so connect through the tree.
  await evaluate<boolean>(
    win,
    `(() => {
      const row = [...document.querySelectorAll('.objtree__row')]
        .find((r) => r.textContent.includes('Menu SQLite'))
      row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return Boolean(row)
    })()`
  )
  await sleep(1500)
  const sidebarState = await evaluate<string>(
    win,
    `(async () => JSON.stringify({
      rows: [...document.querySelectorAll('.objtree__row')].map((r) => r.className + ':' + r.textContent.slice(0, 24)),
      empty: document.querySelector('.objtree__empty')?.textContent ?? null,
      status: document.querySelector('.statusbar')?.textContent ?? null,
      stored: (await window.dbApi.listConnections()).data?.length ?? 'err'
    }))()`
  )
  check(
    'connection is focused for the menu',
    await evaluate<boolean>(
      win,
      'Boolean(document.querySelector(".objtree__row.is-open"))'
    ),
    sidebarState
  )

  // ---------- the menu exists with real items ----------
  const menu = Menu.getApplicationMenu()
  const topLabels = (menu?.items ?? []).map((item) => item.label)
  check(
    'menu has the app menus',
    ['File', 'Edit', 'View', 'Tools', 'Window'].every((label) =>
      topLabels.includes(label)
    ),
    topLabels.join('|')
  )
  check('settings item exists', findMenuItem('Setelan...') !== null)
  check('a query item exists', findMenuItem('Query baru') !== null)

  // ---------- File > Query baru ----------
  check('menu: query baru is clicked', clickMenu('Query baru'))
  check(
    'menu: a query tab opens',
    await waitFor(win, 'document.querySelector(".query__toolbar")'),
    String(
      await evaluate<number>(win, 'document.querySelectorAll(".query__toolbar").length')
    )
  )

  // ---------- File > Koneksi baru ----------
  check('menu: koneksi baru is clicked', clickMenu('Koneksi baru...'))
  check(
    'menu: the connection dialog opens',
    await waitFor(win, 'document.querySelector(".conn-form, .modal, .dialog")'),
    String(
      await evaluate<number>(
        win,
        'document.querySelectorAll(".conn-form, .modal, .dialog").length'
      )
    )
  )
  // Close it so later menu items are not blocked by the dialog.
  await evaluate(
    win,
    `document.querySelector('.conn-form .icon-btn, .modal .icon-btn')?.click()`
  )
  await sleep(300)

  // ---------- View > Panel asisten ----------
  check('menu: panel asisten is clicked', clickMenu('Panel asisten'))
  const dockOpen = await waitFor(win, 'document.querySelector(".ai__composer")')
  check(
    'menu: the assistant dock opens',
    dockOpen,
    await evaluate<string>(
      win,
      `JSON.stringify({
        composer: document.querySelectorAll('.ai__composer').length,
        settings: document.querySelectorAll('.ai__settings').length,
        panel: document.querySelectorAll('.rightpanel').length
      })`
    )
  )
  check('menu: panel asisten is clicked again', clickMenu('Panel asisten'))
  check(
    'menu: the assistant dock closes',
    await waitFor(win, '!document.querySelector(".ai__composer")', 40)
  )

  // ---------- Edit > Cari objek ----------
  check('menu: cari objek is clicked', clickMenu('Cari objek'))
  check(
    'menu: the sidebar filter opens',
    await waitFor(win, 'document.querySelector(".sidebar__filter-input")'),
    String(
      await evaluate<number>(
        win,
        'document.querySelectorAll(".sidebar__filter-input").length'
      )
    )
  )

  // ---------- the mac-only app menu carries settings ----------
  const appMenu = (menu?.items ?? []).find((item) => item.label === app.name)
  const appLabels = (appMenu?.submenu?.items ?? []).map((item) => item.label)
  check(
    'app menu has settings on mac',
    process.platform !== 'darwin' || appLabels.includes('Setelan...'),
    appLabels.join('|')
  )

  // ---------- accelerators follow the keymap ----------
  const filterItem = findMenuItem('Cari objek')
  check(
    'menu: the filter shortcut comes from the keymap',
    filterItem?.accelerator === 'CmdOrCtrl+F',
    String(filterItem?.accelerator)
  )
  await evaluate<boolean>(
    win,
    `(async () => {
      const s = await window.dbApi.getSettings()
      s.data.keymap['sidebar.filter'] = 'Mod+K'
      await window.dbApi.saveSettings(s.data)
      return true
    })()`
  )
  await sleep(700)
  const rebound = findMenuItem('Cari objek')
  check(
    'menu: a rebound shortcut reaches the menu',
    rebound?.accelerator === 'CmdOrCtrl+K',
    String(rebound?.accelerator)
  )

  // ---------- no item is a dead entry ----------
  const dead: string[] = []
  for (const top of menu?.items ?? []) {
    for (const item of top.submenu?.items ?? []) {
      if (!item.label || item.type === 'separator') continue
      // Roles and our own click handlers are both real; a plain item with
      // neither would be decoration.
      if (item.role) continue
      if (item.click) continue
      dead.push(item.label)
    }
  }
  check('every menu item has an action', dead.length === 0, dead.join('|'))

  await rm(dir, { recursive: true, force: true })
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ` | ${f.detail}` : ''}`)
  }
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(async () => {
  // The real entry point installs the menu; this harness builds it through the
  // same function instead of booting the whole app.
  await refreshApplicationMenu()
  main().catch((err) => {
    console.error('SMOKE ERROR', err)
    app.exit(1)
  })
})
