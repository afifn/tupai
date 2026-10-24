// Drives the packaged app through the Chrome DevTools Protocol to verify the
// real renderer, preload bridge, IPC, and worker all work together.
// Usage: start the packaged app with --remote-debugging-port=9333, then run
// `node scripts/smoke/cdp.mjs`.
const PORT = 9333
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`)
}

async function findPage(deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('no CDP page target')
}

const page = await findPage(Date.now() + 30000)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

let seq = 0
const pending = new Map()
const consoleErrors = []
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description ?? ''))
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }
}

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.text + ' ' + (res.exceptionDetails.exception?.description ?? ''))
  }
  return res.result.value
}

await send('Runtime.enable')
await send('Log.enable')

// Wait until React has mounted the shell.
const ready = await (async () => {
  for (let i = 0; i < 60; i++) {
    const ok = await evaluate(`Boolean(document.querySelector('.menubar') && window.dbApi)`)
    if (ok) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
})()
check('renderer shell mounted', ready)
check('document title', (await evaluate('document.title')) === 'Tupai', await evaluate('document.title'))
check('preload platform exposed', (await evaluate('window.dbApi.platform')) === 'darwin', await evaluate('window.dbApi.platform'))

// Shortcut labels must use the Command glyph on macOS.
const menuTitles = await evaluate(
  `Array.from(document.querySelectorAll('.menubar__item')).map((b) => b.getAttribute('title') || '')`
)
check(
  'shortcut labels use Cmd glyph',
  menuTitles.some((t) => t.includes('\u2318')),
  menuTitles.filter(Boolean).slice(0, 4).join(' / ')
)

// Every renderer module must load; a broken import would leave the root empty.
check(
  'root has content',
  (await evaluate(`document.getElementById('root').children.length > 0`)) === true
)

// Exercise the real IPC -> worker -> driver path from inside the renderer.
// The SQLite adapter opens with fileMustExist, so the file is seeded first.
const connectionId = 'cdp-smoke-sqlite'
const dbPath = '/tmp/tupai-cdp-smoke.db'
// better-sqlite3 in node_modules is built for Electron's ABI, so this plain
// Node script cannot load it; the system sqlite3 CLI creates the empty file.
const { execFileSync } = await import('node:child_process')
// Start from a clean file so a repeated run does not accumulate rows from the
// previous one.
execFileSync('/usr/bin/sqlite3', [dbPath, 'DROP TABLE IF EXISTS smoke;'])
await evaluate(`(async () => {
  const res = await window.dbApi.saveConnection({
    id: '${connectionId}', name: 'CDP smoke', engine: 'sqlite', file: '${dbPath}'
  })
  if (!res.ok) throw new Error('saveConnection: ' + res.error.message)
  const conn = await window.dbApi.connect('${connectionId}')
  if (!conn.ok) throw new Error('connect: ' + conn.error.message)
  return true
})()`).catch((e) => check('save + connect via IPC', false, e.message))
check('save + connect via IPC', true)

const dbList = await evaluate(`window.dbApi.listDatabases('${connectionId}')`)
check('IPC listDatabases', dbList.ok && dbList.data.includes('main'), JSON.stringify(dbList.data ?? dbList.error))

const query = await evaluate(`window.dbApi.runQuery({
  connectionId: '${connectionId}',
  sql: "CREATE TABLE IF NOT EXISTS smoke (id INTEGER PRIMARY KEY, txt TEXT); INSERT INTO smoke (txt) VALUES ('back\\\\slash'), ('O''Brien');",
  maxRows: 100
})`)
check('IPC runQuery multi-statement', query.ok && query.data.length === 2, query.ok ? `${query.data.length} results` : query.error.message)

const rows = await evaluate(`window.dbApi.selectRows({
  connectionId: '${connectionId}', database: 'main', table: 'smoke', limit: 10, offset: 0
})`)
const texts = rows.ok ? rows.data.rows.map((r) => r.txt) : []
// One literal backslash: SQLite does not treat it as an escape character.
check(
  'IPC selectRows keeps literal values',
  rows.ok && texts.includes('back\\slash') && texts.includes("O'Brien"),
  JSON.stringify(texts)
)

// exportResultSet opens a native save dialog, which cannot be answered from a
// script and would block the promise forever. Only the validation path is
// checked: an empty column list must be rejected by zod before the dialog.
const rejected = await evaluate(`window.dbApi.exportResultSet({
  format: 'csv', columns: [], rows: []
})`)
check(
  'IPC exportResultSet rejects invalid payload',
  rejected.ok === false && Boolean(rejected.error.message),
  rejected.ok === false ? 'validation rejected the empty column list' : 'accepted'
)

const stats = await evaluate(`window.dbApi.listTableStats('${connectionId}', 'main')`)
check('IPC listTableStats', stats.ok && stats.data.some((s) => s.name === 'smoke'), stats.ok ? `${stats.data.length} tables` : stats.error.message)

const bad = await evaluate(`window.dbApi.runQuery({ connectionId: '${connectionId}', sql: 'SELECT * FROM missing_table', maxRows: 10 })`)
check('errors surface as structured results', bad.ok === false && Boolean(bad.error.message), bad.error?.message?.slice(0, 60))

await evaluate(`window.dbApi.disconnect('${connectionId}')`)
await evaluate(`window.dbApi.deleteConnection('${connectionId}')`)

check('no uncaught renderer errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
ws.close()
process.exit(failed.length === 0 ? 0 : 1)
