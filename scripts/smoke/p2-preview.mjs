// P2 preview: the assistant shows a few rows under an answer.
//
// Runs the built bundle against a real SQLite file and the local fake AI server
// (scripts/smoke/fake-ai-server.mjs). The prompt marker __SQL__ makes the fake
// server answer with a SELECT over the seeded `users` table.
const PORT = Number(process.env.PORT ?? 9340)
const AI_PORT = Number(process.env.AI_PORT ?? 8799)
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

const page = await findPage(Date.now() + 40000)
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
  if (m.method === 'Runtime.exceptionThrown')
    errors.push(
      m.params.exceptionDetails.text +
        ' ' +
        (m.params.exceptionDetails.exception?.description ?? '')
    )
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
const waitFor = async (expression, tries = 80) => {
  for (let i = 0; i < tries; i++) {
    if (await ev(expression)) return true
    await sleep(250)
  }
  return false
}

// The dock is a toggle, so it is only clicked when the composer is not already
// mounted; otherwise a second call would close the panel the test needs.
// Reloading is how the renderer picks up settings it read on mount. If the
// reload does not happen, every check after it would read the old document and
// pass or fail for the wrong reason, so it is asserted.
const reloadApp = async (label) => {
  // CDP's Page.reload is used instead of location.reload(): the in-page call is
  // dropped in this Electron build, which silently left the old document in
  // place. A token on window proves the new document really mounted.
  await ev(`window.__reloadToken = ${JSON.stringify(label)}`)
  await send('Page.reload', { ignoreCache: true })
  const ok = await waitFor(
    `typeof window.__reloadToken === 'undefined' && Boolean(window.dbApi && document.querySelector('.menubar'))`,
    120
  )
  if (!ok) {
    // Report what the page looks like instead of leaving a bare FAIL: a reload
    // that did not happen makes every later check meaningless.
    const state = await ev(`({
      token: typeof window.__reloadToken,
      dbApi: Boolean(window.dbApi),
      menubar: Boolean(document.querySelector('.menubar')),
      readyState: document.readyState
    })`)
    return { ok: false, state }
  }
  return { ok: true }
}

const openAssistant = async () => {
  if (await ev(`Boolean(document.querySelector('.ai__input'))`)) return true
  await ev(`(() => {
    const btn = [...document.querySelectorAll('.menubar .icon-btn')]
      .find((b) => /panel/i.test(b.getAttribute('title') || ''))
    btn?.click()
    return Boolean(btn)
  })()`)
  return waitFor(`Boolean(document.querySelector('.ai__input'))`, 40)
}

await send('Runtime.enable')
await send('Page.enable')
check(
  'app shell mounted',
  await waitFor(`Boolean(window.dbApi && document.querySelector('.menubar'))`, 120)
)

// Point the app at the fake AI server, and create the SQLite connection plus a
// small table through the real IPC surface. The database file itself is created
// empty by the runner; an empty file is a valid SQLite database.
const dbFile = process.env.PREVIEW_DB
if (!dbFile) throw new Error('PREVIEW_DB is not set')

await ev(`(async () => {
  const r = await window.dbApi.getSettings()
  if (!r.ok) throw new Error('getSettings failed')
  const s = r.data
  s.ai.baseUrl = 'http://127.0.0.1:${AI_PORT}/v1'
  s.ai.model = 'fake-model'
  s.ai.previewRows = true
  await window.dbApi.saveSettings(s)
  await window.dbApi.saveAiSettings({ baseUrl: 'http://127.0.0.1:${AI_PORT}/v1', apiKey: 'k', model: 'fake-model' })
  const connected = await window.dbApi.connect('smoke-preview')
  if (!connected.ok) throw new Error('connect failed: ' + JSON.stringify(connected.error))
  const created = await window.dbApi.runQuery({
    connectionId: 'smoke-preview',
    database: 'main',
    maxRows: 1,
    sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); ' +
      "INSERT INTO users (name) VALUES ('Ana'), ('Budi'), ('Citra'), ('Dewi'), ('Eka'), ('Fajar')"
  })
  if (!created.ok) throw new Error('seed failed: ' + JSON.stringify(created.error))
  return true
})()`)

// Reload so the renderer store and the assistant read the new settings.
const firstReload = await reloadApp('first')
check(
  'app reloads after saving settings',
  firstReload.ok,
  JSON.stringify(firstReload.state ?? {})
)
await sleep(800)

check('assistant dock opens', await openAssistant())

const seeded = await ev(`(async () => {
  const conns = await window.dbApi.listConnections()
  return conns.ok ? conns.data.map((c) => ({ id: c.id, name: c.name, engine: c.engine })) : conns
})()`)
check(
  'sqlite connection exists',
  Array.isArray(seeded) && seeded.some((c) => c.engine === 'sqlite'),
  JSON.stringify(seeded)
)

// Connect and open the table so the assistant knows its scope.
const connName = seeded.find((c) => c.engine === 'sqlite')?.name ?? ''
await ev(`(() => {
  const row = [...document.querySelectorAll('.objtree__row')].find((r) => r.textContent.includes(${JSON.stringify(connName)}))
  row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  return Boolean(row)
})()`)
await sleep(1800)

// Connect through the sidebar: after a reload the shell does not know the
// connection is open, and the tree only lists databases once it is.
// A double-click toggles, so only send it when the row is not already open.
const alreadyOpen = await ev(`Boolean(document.querySelector('.objtree__row.is-open'))`)
if (!alreadyOpen) {
  await ev(`(() => {
    const row = [...document.querySelectorAll('.objtree__row')].find((r) => r.textContent.includes('Smoke Preview'))
    if (!row) return false
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    return true
  })()`)
}
check(
  'connection connects from the sidebar',
  await waitFor(`Boolean(document.querySelector('.objtree__row.is-open'))`, 60)
)
await sleep(1200)

// The tree needs the database expanded before the table row exists.
const dbExpanded = await ev(`(() => {
  const row = [...document.querySelectorAll('.tree__row--db')].find((r) => /main/.test(r.textContent))
  if (!row) return false
  row.click()
  return true
})()`)
await waitFor(`Boolean(document.querySelector('.tree__row--table'))`, 60)
const tableOpened = await ev(`(() => {
  const row = [...document.querySelectorAll('.tree__row--table')].find((r) => /users/.test(r.textContent))
  if (!row) return false
  row.click()
  return true
})()`)
await sleep(1500)
check(
  'users table opens',
  dbExpanded && tableOpened,
  `db=${dbExpanded} table=${tableOpened}`
)

// Ask for three rows; the fake server replies with a SELECT.
const typed = await ev(`(() => {
  const box = document.querySelector('.ai__input')
  if (!box) return false
  const setter = Object.getOwnPropertyDescriptor(box.constructor.prototype, 'value').set
  setter.call(box, '__SQL__ show 3 rows from the users table')
  box.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
check('question is typed', typed)
await ev(`(() => {
  const box = document.querySelector('.ai__input')
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return true
})()`)

check(
  'answer arrives',
  await waitFor(`document.querySelectorAll('.ai__turn').length >= 2`, 120)
)
check(
  'preview table is rendered',
  await waitFor(`Boolean(document.querySelector('.ai__preview-table'))`, 120)
)
const preview = await ev(`(() => {
  const table = document.querySelector('.ai__preview-table')
  if (!table) return null
  const headers = [...table.querySelectorAll('th')].map((th) => th.textContent)
  const rows = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent))
  const note = table.closest('.ai__preview')?.querySelector('.ai__preview-note')?.textContent
  return { headers, rows, note }
})()`)
check(
  'preview shows the real rows',
  preview !== null && preview.rows.length === 3,
  JSON.stringify(preview)
)
check(
  'preview uses the table columns',
  preview !== null && preview.headers.includes('id') && preview.headers.includes('name'),
  JSON.stringify(preview?.headers)
)
check(
  'preview reports how many rows it showed',
  preview !== null && /3/.test(preview.note ?? ''),
  String(preview?.note)
)

// Asking for more than the cap must leave only the SQL block.
await ev(`(() => {
  const box = document.querySelector('.ai__input')
  const setter = Object.getOwnPropertyDescriptor(box.constructor.prototype, 'value').set
  setter.call(box, '__SQL__ show 10 rows from the users table')
  box.dispatchEvent(new Event('input', { bubbles: true }))
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return true
})()`)
await waitFor(`document.querySelectorAll('.ai__turn').length >= 4`, 120)
await sleep(1200)
const second = await ev(`(() => ({
  previews: document.querySelectorAll('.ai__preview-table').length,
  codeBlocks: document.querySelectorAll('.ai__code').length
}))()`)
check(
  'asking for more than 5 rows shows only the query',
  second.previews === 1 && second.codeBlocks >= 2,
  JSON.stringify(second)
)

// A table created after the panel opened must become mentionable without
// closing and reopening it. The @ catalogue is keyed on the tree version, which
// the shell bumps whenever the schema may have changed.
// Load the catalogue first. The bug only shows when a list was already cached:
// the picker kept it and the new table stayed invisible until the panel was
// closed and reopened.
await ev(`(() => {
  const box = document.querySelector('.ai__input')
  const setter = Object.getOwnPropertyDescriptor(box.constructor.prototype, 'value').set
  setter.call(box, '@')
  box.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await waitFor(`document.querySelectorAll('.ai__suggest-name').length > 0`, 80)
const initialList = await ev(
  `[...document.querySelectorAll('.ai__suggest-name')].map((n) => n.textContent)`
)
check(
  'the catalogue is loaded before the new table exists',
  Array.isArray(initialList) &&
    initialList.includes('users') &&
    !initialList.includes('orders'),
  JSON.stringify(initialList)
)
await ev(`(() => {
  const box = document.querySelector('.ai__input')
  const setter = Object.getOwnPropertyDescriptor(box.constructor.prototype, 'value').set
  setter.call(box, '')
  box.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)

const ordersCreated = await ev(`(async () => {
  const created = await window.dbApi.runQuery({
    connectionId: 'smoke-preview',
    database: 'main',
    maxRows: 1,
    sql: 'CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL)'
  })
  return created.ok
})()`)
check('a table can be created from a query', ordersCreated)

await ev(`(() => {
  const box = document.querySelector('.ai__input')
  const setter = Object.getOwnPropertyDescriptor(box.constructor.prototype, 'value').set
  setter.call(box, '@')
  box.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await sleep(900)
const staleList = await ev(
  `[...document.querySelectorAll('.ai__suggest-name')].map((n) => n.textContent)`
)
check(
  'the cached catalogue does not have the new table yet',
  !staleList.includes('orders'),
  JSON.stringify(staleList)
)

// Refresh the tree the way the user does, then the same picker must list it.
await ev(`(() => {
  const btn = [...document.querySelectorAll('.objtree__section-actions button')]
    .find((b) => /Reload/.test(b.getAttribute('title') || ''))
  btn?.click()
  return Boolean(btn)
})()`)
await sleep(1200)
await ev(`(() => {
  const box = document.querySelector('.ai__input')
  const setter = Object.getOwnPropertyDescriptor(box.constructor.prototype, 'value').set
  setter.call(box, '@')
  box.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
const ordersOffered = await waitFor(
  `[...document.querySelectorAll('.ai__suggest-name')].some((n) => n.textContent === 'orders')`,
  80
)
const refreshedList = await ev(
  `[...document.querySelectorAll('.ai__suggest-name')].map((n) => n.textContent)`
)
check(
  'the @ picker offers the new table after a refresh',
  ordersOffered,
  JSON.stringify(refreshedList)
)
await ev(`(() => {
  const box = document.querySelector('.ai__input')
  const setter = Object.getOwnPropertyDescriptor(box.constructor.prototype, 'value').set
  setter.call(box, '')
  box.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)

// The assistant is told which engine and database it is looking at even with no
// table tab open, so "which database is this" is answerable.
const scopeLines = await ev(`(() => {
  const scope = [...document.querySelectorAll('.ai__scope, .ai__model')].map(
    (b) => b.textContent
  )
  return scope
})()`)
// The prompt itself has to name the database, not just a badge in the UI.
const sentSystem = await fetch(`http://127.0.0.1:${AI_PORT}/v1/last-system`)
  .then((r) => r.json())
  .then((body) => String(body.content ?? ''))
check(
  'the prompt names the current database',
  sentSystem.includes('Database: main'),
  sentSystem
    .split('\n')
    .filter((line) => /^(Engine|Database|Table|Schema)/.test(line))
    .join(' | ')
)
check(
  'the assistant knows its database scope',
  Array.isArray(scopeLines) && scopeLines.some((b) => /main/.test(b)),
  JSON.stringify(scopeLines)
)

// A provider that sends every delta and the terminator in one chunk must still
// produce a visible answer. The listener used to read a ref mirrored from state
// by an effect, so a burst left the turn empty and the answer vanished.
const beforeBurst = await ev(`document.querySelectorAll('.ai__turn').length`)
await ev(`(() => {
  const box = document.querySelector('.ai__input')
  if (!box) return false
  const setter = Object.getOwnPropertyDescriptor(box.constructor.prototype, 'value').set
  setter.call(box, '__BURST__ halo')
  box.dispatchEvent(new Event('input', { bubbles: true }))
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return true
})()`)
const burstArrived = await waitFor(
  `document.querySelectorAll('.ai__turn').length >= ${beforeBurst + 2}`,
  120
)
const burstDiag = await ev(`(() => ({
  turns: [...document.querySelectorAll('.ai__turn')].map((t) => t.textContent.slice(0, 40)),
  notice: document.querySelector('.ai .notice')?.textContent ?? null,
  draft: document.querySelector('.ai__input')?.value ?? null,
  sending: Boolean(document.querySelector('.ai__composer-foot .btn--ghost')),
  suggest: document.querySelectorAll('.ai__suggest').length
}))()`)
check('burst answer arrives as a new turn', burstArrived, JSON.stringify(burstDiag))
await sleep(600)
const burst = await ev(`(() => {
  const turns = [...document.querySelectorAll('.ai__turn')]
  const last = turns[turns.length - 1]
  return { count: turns.length, text: last?.textContent ?? '' }
})()`)
check(
  'a burst answer still shows in the transcript',
  burst.text.includes('satu burst'),
  JSON.stringify(burst)
)

// Turning the setting off removes the preview. This goes through the Settings
// dialog, which is the real path and updates the panel live, so no reload is
// involved.
const tablesBeforeToggle = await ev(
  `document.querySelectorAll('.ai__preview-table').length`
)
check(
  'previews are visible before the toggle',
  tablesBeforeToggle >= 1,
  String(tablesBeforeToggle)
)
await ev(
  `window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }))`
)
check(
  'settings opens for the toggle',
  await waitFor(`Boolean(document.querySelector('.settings'))`)
)
await ev(`document.querySelector('[data-section="ai"]')?.click()`)
await sleep(400)
const beforeToggleAi = await ev(
  `(async () => (await window.dbApi.getSettings()).data.ai)()`
)
const rendererAi = await ev(`(() => {
  const box = [...document.querySelectorAll('.settings__pane input[type="checkbox"]')]
    .find((el) => el.closest('.settings__field')?.textContent?.includes('sample rows'))
  const pane = document.querySelector('.settings__pane')
  const modelInput = pane?.querySelector('select, .settings__row input')
  return {
    checkbox: box ? box.checked : null,
    model: modelInput ? modelInput.value : null,
    baseUrl: pane?.querySelector('input.input')?.value ?? null
  }
})()`)
const toggled = await ev(`(() => {
  const box = [...document.querySelectorAll('.settings__pane input[type="checkbox"]')]
    .find((el) => el.closest('.settings__field')?.textContent?.includes('sample rows'))
  if (!box || !box.checked) return false
  box.click()
  return true
})()`)
check(
  'preview toggle is switched off',
  toggled,
  JSON.stringify({ beforeToggleAi, rendererAi })
)
await sleep(600)
const storedOff = await ev(
  `(async () => {
    const s = (await window.dbApi.getSettings()).data.ai
    return { previewRows: s.previewRows, model: s.model, baseUrl: s.baseUrl }
  })()`
)
check(
  'the preview setting is stored as off without losing the model',
  storedOff?.previewRows === false && storedOff?.model === 'fake-model',
  JSON.stringify(storedOff)
)

await ev(`document.querySelector('.settings__head .icon-btn')?.click()`)
check('settings closes', await waitFor(`!document.querySelector('.settings')`, 40))
check(
  'assistant is still open',
  await waitFor(`Boolean(document.querySelector('.ai__input'))`, 40)
)

const beforeOff = await ev(`document.querySelectorAll('.ai__turn').length`)
await ev(`(() => {
  const box = document.querySelector('.ai__input')
  if (!box) return false
  const setter = Object.getOwnPropertyDescriptor(box.constructor.prototype, 'value').set
  setter.call(box, '__SQL__ show 3 rows from the users table')
  box.dispatchEvent(new Event('input', { bubbles: true }))
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return true
})()`)
const arrived = await waitFor(
  `document.querySelectorAll('.ai__turn').length >= ${beforeOff + 2}`,
  120
)
const afterSend = await ev(`(() => ({
  turns: document.querySelectorAll('.ai__turn').length,
  notice: document.querySelector('.ai .notice')?.textContent ?? null,
  last: [...document.querySelectorAll('.ai__turn')].pop()?.textContent.slice(0, 120) ?? ''
}))()`)
check(
  'answer still arrives with the preview off',
  arrived,
  `before=${beforeOff} ${JSON.stringify(afterSend)}`
)
await sleep(1200)
const disabled = await ev(`(() => ({
  tables: document.querySelectorAll('.ai__preview-table').length,
  code: document.querySelectorAll('.ai__code').length
}))()`)
// Turning the setting off also clears previews that were already on screen:
// they come from the same live state, so leaving them would be a stale table.
check(
  'setting off clears every preview and keeps the SQL blocks',
  disabled.tables === 0 && disabled.code >= 2,
  JSON.stringify({ ...disabled, before: tablesBeforeToggle })
)

check('no renderer exceptions', errors.length === 0, errors.join(' | '))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
