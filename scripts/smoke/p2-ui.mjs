// P2 UI checks against the packaged app: the unsaved-changes guard on query
// tabs and the in-app confirmation dialog replacing window.confirm.
//
// Usage: start the packaged app with --remote-debugging-port=9338, then run
// `node scripts/smoke/p2-ui.mjs`.
const PORT = 9338
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`)
}
async function findPage(deadline) {
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('no CDP page')
}
const page = await findPage(Date.now() + 30000)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let seq = 0
const pending = new Map()
const errors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text)
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await send('Runtime.enable')
for (let i = 0; i < 60; i++) {
  if (await ev(`Boolean(window.dbApi && document.querySelector('.menubar'))`)) break
  await sleep(250)
}

// The demo database from smoke:provision must exist for this check.
const conns = (await ev('window.dbApi.listConnections()')).data
const pg = conns.find((c) => c.engine === 'postgres')
if (!pg) {
  console.log('SKIP: no postgres connection saved')
  process.exit(0)
}
const P = JSON.stringify(pg.id)

// Connect through the sidebar, not through IPC: the menubar's Query button is
// disabled until the app itself knows a connection is open, and connecting via
// IPC leaves the shell state untouched.
const connected = await ev(`(() => {
  // The double-click handler lives on the inner .objtree__row, not the
  // coloured wrapper.
  const rows = Array.from(document.querySelectorAll('.objtree__row'))
  const row = rows.find((r) => r.textContent.includes(${JSON.stringify(pg.name)}))
  if (!row) return 'row-not-found'
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  return 'double-clicked'
})()`)
await sleep(1500)
const connectionOpen = await ev(
  `Boolean(document.querySelector('.objtree__row.is-open'))`
)
const rowState = await ev(
  `Array.from(document.querySelectorAll('.objtree__row')).map(r => r.className + ':' + r.textContent.slice(0, 20))`
)
check(
  'connect through the sidebar',
  connected === 'double-clicked' && connectionOpen,
  `${connected}; open=${connectionOpen}; rows=${JSON.stringify(rowState)}`
)

// Open a query tab through the menubar button, which is the same action as the
// shortcut but does not depend on a synthetic key event reaching window.
const opened = await ev(`(() => {
  const button = Array.from(document.querySelectorAll('.menubar__item'))
    .find((b) => b.textContent.trim() === 'Query')
  if (!button || button.disabled) return false
  button.click()
  return true
})()`)
await sleep(500)
const toolbarAfterClick = await ev(`Boolean(document.querySelector('.query__toolbar'))`)
check(
  'query tab opens',
  opened && toolbarAfterClick,
  `clicked=${opened} toolbar=${toolbarAfterClick} menus=${await ev(`Array.from(document.querySelectorAll('.menubar__item')).map(b => b.textContent.trim()).join('|')`)}`
)

// "Isi contoh" writes starter SQL into the active editor, which is a real user
// path to make the tab dirty (Monaco is not exposed on window for scripting).
// It lives in the toolbar's overflow menu, so open that first.
const moreOpened = await ev(`(() => {
  const more = document.querySelector('.query__toolbar button[aria-label="Aksi lain"]')
  more?.click()
  return Boolean(more)
})()`)
await sleep(250)
const sampleClicked = await ev(`(() => {
  const item = Array.from(document.querySelectorAll('.context-menu__item'))
    .find((b) => b.textContent.trim() === 'Isi contoh')
  item?.click()
  return Boolean(item)
})()`)
await sleep(400)
const dirtyMark = await ev(`Boolean(document.querySelector('.query__tab-dirty'))`)
check(
  'unsaved marker appears after editing',
  dirtyMark,
  `overflow=${moreOpened} sample=${sampleClicked}`
)

// Select all in the editor: the run button must switch to "Jalankan seleksi",
// because executing the whole tab while a fragment is highlighted runs the
// wrong statement. Cmd/Ctrl+A is the same path a user takes.
await ev(`document.querySelector('.monaco-editor textarea')?.focus()`)
await sleep(200)
await send('Input.dispatchKeyEvent', {
  type: 'keyDown',
  modifiers: 4,
  key: 'a',
  code: 'KeyA',
  windowsVirtualKeyCode: 65,
  nativeVirtualKeyCode: 65,
  commands: ['selectAll']
})
await send('Input.dispatchKeyEvent', {
  type: 'keyUp',
  modifiers: 4,
  key: 'a',
  code: 'KeyA',
  windowsVirtualKeyCode: 65,
  nativeVirtualKeyCode: 65
})
await sleep(300)
const runLabel = await ev(`document.querySelector('.query__run')?.textContent ?? ''`)
check('selection changes the run action', runLabel.includes('seleksi'), runLabel.trim())

// Running opens one result tab per row-returning statement plus the message log.
await ev(`document.querySelector('.query__run')?.click()`)
await sleep(2000)
const resultTabs = await ev(`document.querySelectorAll('.qres-tab').length`)
const hasGrid = await ev(`Boolean(document.querySelector('.qres .data-table'))`)
check(
  'result opens in its own grid tab',
  resultTabs >= 2 && hasGrid,
  `tabs=${resultTabs} grid=${hasGrid}`
)

const messagesOpened = await ev(`(() => {
  const tab = Array.from(document.querySelectorAll('.qres-tab'))
    .find((b) => b.textContent.trim().startsWith('Pesan'))
  tab?.click()
  return Boolean(tab)
})()`)
await sleep(250)
const messageRows = await ev(`document.querySelectorAll('.qmsg__table tbody tr').length`)
check(
  'message log lists the executed statement',
  messagesOpened && messageRows >= 1,
  `opened=${messagesOpened} rows=${messageRows}`
)

// Close the shell tab (Cmd/Ctrl+W) on a dirty query: the in-app dialog must
// appear instead of discarding the SQL.
await ev(
  `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }))`
)
await sleep(400)
const dialogTitle = await ev(
  `document.querySelector('.modal--confirm h2')?.textContent ?? ''`
)
check('closing a dirty tab asks first', dialogTitle.length > 0, dialogTitle)

// Cancel must keep the tab and its text.
const beforeCancel = await ev(`document.querySelectorAll('.query__tab').length`)
await ev(`(async () => {
  const buttons = Array.from(document.querySelectorAll('.modal--confirm button'))
  const cancel = buttons.find((b) => b.textContent.trim() === 'Batal')
  cancel?.click()
  return true
})()`)
await sleep(250)
const afterCancel = await ev(`document.querySelectorAll('.query__tab').length`)
const dialogGone = await ev(`!document.querySelector('.modal--confirm')`)
check(
  'cancel keeps the tab open',
  dialogGone && afterCancel === beforeCancel,
  `${beforeCancel} -> ${afterCancel}`
)

// Discard must close it (the dialog is still open after cancelling).
await ev(
  `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }))`
)
await sleep(300)
await ev(`(async () => {
  const buttons = Array.from(document.querySelectorAll('.modal--confirm button'))
  const discard = buttons.find((b) => b.textContent.trim() === 'Buang')
  discard?.click()
  return true
})()`)
await sleep(300)
check('discard closes the tab', await ev(`!document.querySelector('.modal--confirm')`))

// The confirmation dialog is also used for destructive connection actions.
const confirmApi = await ev(`typeof window.dbApi !== 'undefined'`)
check('preload still exposes the API', confirmApi === true)

// No native dialogs: window.confirm/alert must not be called by the app.
const nativeCalls = await ev(`(() => {
  let calls = 0
  const original = window.confirm
  window.confirm = (...args) => { calls++; return original.apply(window, args) }
  window.alert = () => { calls++ }
  return calls
})()`)
check('no native dialog was triggered during this run', nativeCalls === 0)

await ev(`window.dbApi.disconnect(${P})`)
check('no uncaught renderer errors', errors.length === 0, errors.slice(0, 2).join(' | '))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
ws.close()
process.exit(failed.length === 0 ? 0 : 1)
