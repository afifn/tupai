// Verifies the packaged app still works end-to-end after the P1 changes, using
// the saved connections from the real profile.
//
// Usage: start the packaged app with --remote-debugging-port=9337, then run
// `node scripts/smoke/p1-app.mjs`. It only reads and deletes non-existent demo
// rows, so it is safe against a live database.
const PORT = 9337
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
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let seq = 0
const pending = new Map()
const errors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
await send('Runtime.enable')
for (let i = 0; i < 60; i++) {
  if (await ev(`Boolean(window.dbApi)`)) break
  await new Promise((r) => setTimeout(r, 250))
}

const conns = (await ev('window.dbApi.listConnections()')).data
const pg = conns.find((c) => c.engine === 'postgres')
const my = conns.find((c) => c.engine === 'mysql')

// PostgreSQL: row limit + transactional delete on the demo database.
const P = JSON.stringify(pg.id)
check('pg connect', (await ev(`window.dbApi.connect(${P})`)).ok)
const pgLimit = await ev(`window.dbApi.runQuery({ connectionId: ${P}, database: 'tupai_demo', schema: 'public', sql: 'SELECT * FROM products', maxRows: 3 })`)
check('pg maxRows through IPC', pgLimit.ok && pgLimit.data[0].rows.length === 3 && pgLimit.data[0].truncated, pgLimit.ok ? `${pgLimit.data[0].rows.length} rows` : pgLimit.error.message)

const pgDelete = await ev(`(async () => {
  const res = await window.dbApi.deleteRows('${pg.id}', 'tupai_demo', 'products', [{ id: 999998 }, { id: 999999 }], 'public')
  return res
})()`)
check('pg deleteRows IPC', pgDelete.ok, pgDelete.ok ? `${pgDelete.data} rows` : pgDelete.error.message)

const pgTables = await ev(`window.dbApi.listTables(${P}, 'tupai_demo', 'public')`)
check('pg tables still listed', pgTables.ok && pgTables.data.length >= 2, `${pgTables.data?.length} tables`)
await ev(`window.dbApi.disconnect(${P})`)

// MySQL: index listing (fixed earlier) plus a limited query.
const M = JSON.stringify(my.id)
check('mysql connect', (await ev(`window.dbApi.connect(${M})`)).ok)
const myDbs = await ev(`window.dbApi.listDatabases(${M})`)
check('mysql databases', myDbs.ok && myDbs.data.length > 0, `${myDbs.data?.length} databases`)
const myLimit = await ev(`window.dbApi.runQuery({ connectionId: ${M}, database: 'sajada', sql: 'SELECT * FROM information_schema.columns LIMIT 5000', maxRows: 50 })`)
check('mysql maxRows through IPC', myLimit.ok && myLimit.data[0].rows.length === 50 && myLimit.data[0].truncated, myLimit.ok ? `${myLimit.data[0].rows.length} rows` : myLimit.error.message)
const myIndexes = await ev(`window.dbApi.listIndexes(${M}, 'sajada', 'cache')`)
check('mysql listIndexes IPC', myIndexes.ok, myIndexes.ok ? `${myIndexes.data.length} indexes` : myIndexes.error.message)
await ev(`window.dbApi.disconnect(${M})`)

check('no uncaught renderer errors', errors.length === 0, errors.slice(0, 2).join(' | '))
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
ws.close()
process.exit(failed.length === 0 ? 0 : 1)
