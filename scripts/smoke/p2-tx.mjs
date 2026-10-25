// Manual transaction through the real UI, against a real PostgreSQL.
//
// The interesting part is not the happy path: it is that a write inside the
// transaction is invisible outside it, that rollback really discards, and that
// closing the tab asks first and honours "Batal".
const PORT = Number(process.env.PORT ?? 9392)
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

await send('Runtime.enable')
check(
  'app shell mounted',
  await waitFor(`Boolean(window.dbApi && document.querySelector('.menubar'))`, 120)
)

// Connect through the sidebar so the shell knows the session is open.
await ev(`(() => {
  const row = [...document.querySelectorAll('.objtree__row')].find((r) => r.textContent.includes('Tx Smoke'))
  row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  return Boolean(row)
})()`)
check(
  'connection opens from the sidebar',
  await waitFor(`Boolean(document.querySelector('.objtree__row.is-open'))`)
)
await sleep(1200)

await ev(`(() => {
  const b = [...document.querySelectorAll('.menubar__item')].find((x) => /^Query/.test(x.textContent.trim()))
  b?.click()
  return Boolean(b)
})()`)
check(
  'query tab opens',
  await waitFor(`Boolean(document.querySelector('.query__toolbar'))`)
)

const setSql = (sql) =>
  ev(`(() => {
    const ta = document.querySelector('.monaco-editor textarea')
    if (!ta) return 'no-editor'
    ta.focus()
    document.execCommand('selectAll')
    document.execCommand('insertText', false, ${JSON.stringify(sql)})
    return 'ok'
  })()`)
const clickRun = () =>
  ev(
    `(() => { const b = document.querySelector('.query__run'); b?.click(); return Boolean(b) })()`
  )
const badge = () =>
  ev(`document.querySelector('.query__tx-badge')?.textContent.trim() ?? null`)
const outsideRows = () =>
  ev(`(async () => {
    const r = await window.dbApi.runQuery({ connectionId: 'tx-smoke', database: 'postgres', maxRows: 50, sql: 'SELECT body FROM tx_smoke_notes ORDER BY id' })
    return r.ok ? r.data[0].rows.map((x) => x.body) : r.error
  })()`)

// ---------- start a transaction ----------
check(
  'transaction button is available',
  await waitFor(`Boolean(document.querySelector('.query__tx-start'))`)
)
await ev(`document.querySelector('.query__tx-start')?.click()`)
check(
  'transaction badge appears',
  await waitFor(`Boolean(document.querySelector('.query__tx-badge'))`)
)
check(
  'commit and rollback replace the start button',
  JSON.stringify(
    await ev(
      `[...document.querySelectorAll('.query__toolbar-group--tx button')].map((b) => b.textContent.trim())`
    )
  ) === JSON.stringify(['Commit', 'Rollback']),
  JSON.stringify(
    await ev(
      `[...document.querySelectorAll('.query__toolbar-group--tx button')].map((b) => b.textContent.trim())`
    )
  )
)
check(
  'database and schema are locked while open',
  JSON.stringify(
    await ev(
      `[...document.querySelectorAll('.query__ctx-field select')].slice(0, 2).map((s) => s.disabled)`
    )
  ) === '[true,true]'
)

// ---------- write inside, invisible outside ----------
await setSql("INSERT INTO tx_smoke_notes (body) VALUES ('from-tx')")
await clickRun()
check(
  'statement runs inside the transaction',
  await waitFor(`document.querySelector('.query__tx-badge')?.textContent.includes('1')`)
)
const insideSeen = await outsideRows()
check(
  'the write is invisible to another session',
  Array.isArray(insideSeen) && !insideSeen.includes('from-tx'),
  JSON.stringify(insideSeen)
)

// ---------- rollback discards ----------
await ev(
  `(() => { const b = [...document.querySelectorAll('.query__toolbar-group--tx button')].find((x) => /^Rollback$/.test(x.textContent.trim())); b?.click(); return Boolean(b) })()`
)
check(
  'badge disappears after rollback',
  await waitFor(`!document.querySelector('.query__tx-badge')`)
)
const afterRollback = await outsideRows()
check(
  'rollback discarded the row',
  Array.isArray(afterRollback) && !afterRollback.includes('from-tx'),
  JSON.stringify(afterRollback)
)

// ---------- commit keeps ----------
await ev(`document.querySelector('.query__tx-start')?.click()`)
await waitFor(`Boolean(document.querySelector('.query__tx-badge'))`)
await setSql("INSERT INTO tx_smoke_notes (body) VALUES ('kept')")
await clickRun()
await waitFor(`document.querySelector('.query__tx-badge')?.textContent.includes('1')`)
await ev(
  `(() => { const b = [...document.querySelectorAll('.query__toolbar-group--tx button')].find((x) => /^Commit$/.test(x.textContent.trim())); b?.click(); return Boolean(b) })()`
)
check(
  'badge disappears after commit',
  await waitFor(`!document.querySelector('.query__tx-badge')`)
)
const afterCommit = await outsideRows()
check(
  'commit kept the row',
  Array.isArray(afterCommit) && afterCommit.includes('kept'),
  JSON.stringify(afterCommit)
)

// ---------- closing asks, and cancel really cancels ----------
await ev(`document.querySelector('.query__tx-start')?.click()`)
await waitFor(`Boolean(document.querySelector('.query__tx-badge'))`)
await ev(`document.querySelector('.tab__close')?.click()`)
check(
  'closing asks first',
  await waitFor(`Boolean(document.querySelector('.modal--confirm'))`)
)
const actions = await ev(
  `[...document.querySelectorAll('.modal--confirm button')].map((b) => b.textContent.trim())`
)
check(
  'the dialog offers commit, rollback, and cancel',
  JSON.stringify(actions) === JSON.stringify(['Commit', 'Rollback', 'Batal']),
  JSON.stringify(actions)
)
await ev(
  `(() => { const b = [...document.querySelectorAll('.modal--confirm button')].find((x) => /^Batal$/.test(x.textContent.trim())); b?.click(); return Boolean(b) })()`
)
await sleep(900)
check(
  'cancel keeps the tab and the transaction',
  (await ev(`Boolean(document.querySelector('.query__tx-badge'))`)) &&
    (await ev(`document.querySelectorAll('.tab__close').length`)) === 1,
  JSON.stringify({
    badge: await badge(),
    tabs: await ev(`document.querySelectorAll('.tab__close').length`)
  })
)

// ---------- rollback then close ----------
await ev(`document.querySelector('.tab__close')?.click()`)
await waitFor(`Boolean(document.querySelector('.modal--confirm'))`)
await ev(
  `(() => { const b = [...document.querySelectorAll('.modal--confirm button')].find((x) => /^Rollback$/.test(x.textContent.trim())); b?.click(); return Boolean(b) })()`
)
await sleep(1000)
// The tab still holds unsaved SQL from the earlier runs, so the close guard asks
// a second time. Its labels come from the locale catalogue.
const discard = await ev(
  `(() => {
    const b = [...document.querySelectorAll('.modal--confirm button')].find((x) => /^(Buang|Discard)$/.test(x.textContent.trim()))
    if (!b) return 'not-found'
    b.click()
    return 'clicked'
  })()`
)
if (discard !== 'clicked') console.log('  (no discard dialog)', discard)
const closed = await waitFor(`document.querySelectorAll('.tab__close').length === 0`)
check(
  'rollback closes the tab',
  closed,
  JSON.stringify(
    await ev(`({
      tabs: document.querySelectorAll('.tab__close').length,
      labels: [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim().slice(0, 24)),
      dialog: document.querySelector('.modal--confirm h2')?.textContent ?? null,
      buttons: [...document.querySelectorAll('.modal--confirm button')].map((b) => b.textContent.trim())
    })`)
  )
)
check('no transaction was left behind', (await outsideRows()).includes('kept'))

check('no renderer exceptions', errors.length === 0, errors.join(' | '))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
