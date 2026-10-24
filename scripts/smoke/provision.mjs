// Creates a user, a database, tables, and seed data entirely through the app's
// IPC surface (the same calls the UI makes), then verifies the result.
//
// Usage: start the packaged app with --remote-debugging-port=9336 and the
// connections named below, then `node scripts/smoke/provision.mjs`.
//
// It is idempotent: the demo database and role are dropped first when present,
// so running it again rebuilds the same fixture.
const PORT = 9336
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
await send('Runtime.enable')
for (let i = 0; i < 60; i++) {
  if (await ev(`Boolean(window.dbApi)`)) break
  await new Promise((r) => setTimeout(r, 250))
}

const conns = (await ev('window.dbApi.listConnections()')).data
const pg = conns.find((c) => c.engine === 'postgres')
const my = conns.find((c) => c.engine === 'mysql')
const P = JSON.stringify(pg.id)
const M = JSON.stringify(my.id)

const DB = 'tupai_demo'
const USER = 'tupai_demo_user'
// Throwaway credential for the local fixture database this script creates. It is
// not a secret: it only exists inside a disposable local MySQL/PostgreSQL.
const PASS = 'TupaiDemo!2026'

// ---------- PostgreSQL ----------
check('pg connect', (await ev(`window.dbApi.connect(${P})`)).ok)

// New database through the DDL path the context menu uses.
const dropDb = await ev(
  `window.dbApi.executeDdl(${P}, { kind: 'dropDatabase', database: ${JSON.stringify(DB)} })`
)
check(
  'pg drop old demo db (idempotent)',
  dropDb.ok || /does not exist/.test(dropDb.error?.message ?? ''),
  dropDb.error?.message?.slice(0, 50)
)

const createDb = await ev(
  `window.dbApi.executeDdl(${P}, { kind: 'createDatabase', database: ${JSON.stringify(DB)} })`
)
check('pg create database', createDb.ok, createDb.error?.message)

// New login role through the user-ops path.
const dropUser = await ev(
  `window.dbApi.executeUserOp(${P}, { kind: 'dropUser', username: ${JSON.stringify(USER)} })`
)
check(
  'pg drop old user (idempotent)',
  dropUser.ok || /does not exist/.test(dropUser.error?.message ?? ''),
  dropUser.error?.message?.slice(0, 50)
)

const createUser = await ev(`window.dbApi.executeUserOp(${P}, {
  kind: 'createUser', username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)},
  canLogin: true, superuser: false
})`)
check('pg create user', createUser.ok, createUser.error?.message)

// Tables via the table designer DDL.
const tables = [
  {
    name: 'categories',
    columns: [
      {
        name: 'id',
        dataType: 'serial',
        nullable: false,
        primaryKey: true,
        autoIncrement: true
      },
      { name: 'name', dataType: 'varchar(60)', nullable: false, primaryKey: false },
      { name: 'slug', dataType: 'varchar(60)', nullable: false, primaryKey: false }
    ]
  },
  {
    name: 'products',
    columns: [
      {
        name: 'id',
        dataType: 'serial',
        nullable: false,
        primaryKey: true,
        autoIncrement: true
      },
      { name: 'category_id', dataType: 'integer', nullable: false, primaryKey: false },
      { name: 'name', dataType: 'varchar(120)', nullable: false, primaryKey: false },
      { name: 'price', dataType: 'numeric(12,2)', nullable: false, primaryKey: false },
      {
        name: 'stock',
        dataType: 'integer',
        nullable: false,
        primaryKey: false,
        defaultValue: '0'
      },
      {
        name: 'active',
        dataType: 'boolean',
        nullable: false,
        primaryKey: false,
        defaultValue: 'true'
      },
      {
        name: 'created_at',
        dataType: 'timestamptz',
        nullable: false,
        primaryKey: false,
        defaultValue: 'now()'
      }
    ]
  }
]
for (const t of tables) {
  const res = await ev(
    `window.dbApi.executeDdl(${P}, { kind: 'createTable', database: ${JSON.stringify(DB)}, schema: 'public', table: ${JSON.stringify(t.name)}, columns: ${JSON.stringify(t.columns)} })`
  )
  check(`pg create table ${t.name}`, res.ok, res.error?.message)
}

const fk = await ev(`window.dbApi.executeDdl(${P}, {
  kind: 'createForeignKey', database: ${JSON.stringify(DB)}, schema: 'public',
  table: 'products', name: 'products_category_fk', columns: ['category_id'],
  refTable: 'categories', refSchema: 'public', refColumns: ['id'],
  onUpdate: 'CASCADE', onDelete: 'RESTRICT'
})`)
check('pg create foreign key', fk.ok, fk.error?.message)

// Seeder through the grid's insert path.
const seedCategories = [
  { name: 'Kopi', slug: 'kopi' },
  { name: 'Teh', slug: 'teh' },
  { name: 'Makanan', slug: 'makanan' }
]
for (const row of seedCategories) {
  const res = await ev(
    `window.dbApi.insertRow({ connectionId: ${P}, database: ${JSON.stringify(DB)}, schema: 'public', table: 'categories', values: ${JSON.stringify(row)} })`
  )
  if (!res.ok) check(`pg seed category ${row.slug}`, false, res.error?.message)
}
check('pg seed categories', true, `${seedCategories.length} rows`)

const products = [
  { category_id: 1, name: 'Kopi Arabika Gayo', price: 85000, stock: 24 },
  { category_id: 1, name: 'Kopi Robusta Lampung', price: 65000, stock: 40 },
  { category_id: 1, name: 'Kopi Susu Botol', price: 25000, stock: 120 },
  { category_id: 2, name: 'Teh Melati', price: 18000, stock: 60 },
  { category_id: 2, name: 'Teh Hijau Premium', price: 32000, stock: 35 },
  { category_id: 3, name: 'Pisang Goreng', price: 15000, stock: 80 },
  { category_id: 3, name: 'Roti Bakar Keju', price: 22000, stock: 45 }
]
for (const row of products) {
  const res = await ev(
    `window.dbApi.insertRow({ connectionId: ${P}, database: ${JSON.stringify(DB)}, schema: 'public', table: 'products', values: ${JSON.stringify(row)} })`
  )
  if (!res.ok) check(`pg seed product ${row.name}`, false, res.error?.message)
}
check('pg seed products', true, `${products.length} rows`)

// Grant through the user-ops path (this is the code path I just fixed).
const grantDb = await ev(`window.dbApi.executeUserOp(${P}, {
  kind: 'grant', user: ${JSON.stringify(USER)}, privileges: ['CONNECT'],
  onType: 'database', database: ${JSON.stringify(DB)}
})`)
check('pg grant CONNECT on database', grantDb.ok, grantDb.error?.message)

const grantSchema = await ev(`window.dbApi.executeUserOp(${P}, {
  kind: 'grant', user: ${JSON.stringify(USER)}, privileges: ['USAGE'],
  onType: 'schema', database: ${JSON.stringify(DB)}, schema: 'public'
})`)
check('pg grant USAGE on schema', grantSchema.ok, grantSchema.error?.message)

const grantTable = await ev(`window.dbApi.executeUserOp(${P}, {
  kind: 'grant', user: ${JSON.stringify(USER)}, privileges: ['SELECT'],
  onType: 'table', database: ${JSON.stringify(DB)}, schema: 'public', table: 'products'
})`)
check(
  'pg grant SELECT on table (cross-database)',
  grantTable.ok,
  grantTable.error?.message
)

// Verify the data is readable through the app and the grant really works.
const count = await ev(
  `window.dbApi.runQuery({ connectionId: ${P}, database: ${JSON.stringify(DB)}, schema: 'public', sql: 'SELECT COUNT(*) AS n FROM products', maxRows: 10 })`
)
check(
  'pg seeded row count',
  count.ok && count.data[0].rows[0].n === String(products.length),
  count.ok ? JSON.stringify(count.data[0].rows[0]) : count.error?.message
)

const join =
  await ev(`window.dbApi.runQuery({ connectionId: ${P}, database: ${JSON.stringify(DB)}, schema: 'public',
  sql: "SELECT c.name AS category, COUNT(p.id) AS items, SUM(p.price) AS total FROM categories c LEFT JOIN products p ON p.category_id = c.id GROUP BY c.name ORDER BY c.name", maxRows: 10 })`)
check(
  'pg join query',
  join.ok && join.data[0].rows.length === 3,
  join.ok ? JSON.stringify(join.data[0].rows) : join.error?.message
)

const aclSql = `SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = '${USER}' AND table_name = 'products'`
const acl = await ev(
  `window.dbApi.runQuery({ connectionId: ${P}, database: ${JSON.stringify(DB)}, sql: ${JSON.stringify(aclSql)}, maxRows: 10 })`
)
check(
  'pg grant visible in catalog',
  acl.ok && acl.data[0].rows.some((r) => r.privilege_type === 'SELECT'),
  acl.ok ? JSON.stringify(acl.data[0].rows) : acl.error?.message
)

const users = await ev(`window.dbApi.listUsers(${P})`)
check(
  'pg user listed',
  users.ok && users.data.some((u) => u.name === USER),
  users.ok ? `${users.data.length} users` : users.error?.message
)

// ---------- MySQL ----------
check('mysql connect', (await ev(`window.dbApi.connect(${M})`)).ok)

// MySQL keeps the database and the user between runs, so both are dropped
// first. Tolerating "already exists" was not enough: the tables and seed rows
// then accumulated and the row counts failed on every second run.
const myDropDb = await ev(
  `window.dbApi.executeDdl(${M}, { kind: 'dropDatabase', database: ${JSON.stringify(DB)} })`
)
check(
  'mysql drop old demo db (idempotent)',
  myDropDb.ok || /doesn't exist|does not exist/.test(myDropDb.error?.message ?? ''),
  myDropDb.error?.message?.slice(0, 60)
)
const myDropUser = await ev(`window.dbApi.executeUserOp(${M}, {
  kind: 'dropUser', username: ${JSON.stringify(USER)}, host: 'localhost'
})`)
check(
  'mysql drop old user (idempotent)',
  myDropUser.ok ||
    /Operation DROP USER failed|does not exist/.test(myDropUser.error?.message ?? ''),
  myDropUser.error?.message?.slice(0, 60)
)

const myDb = await ev(
  `window.dbApi.executeDdl(${M}, { kind: 'createDatabase', database: ${JSON.stringify(DB)} })`
)
check('mysql create database', myDb.ok, myDb.error?.message?.slice(0, 60))

const myUser = await ev(`window.dbApi.executeUserOp(${M}, {
  kind: 'createUser', username: ${JSON.stringify(USER)}, host: 'localhost', password: ${JSON.stringify(PASS)},
  canLogin: true, superuser: false
})`)
check('mysql create user', myUser.ok, myUser.error?.message?.slice(0, 60))

const myTables = [
  {
    name: 'customers',
    columns: [
      {
        name: 'id',
        dataType: 'int',
        nullable: false,
        primaryKey: true,
        autoIncrement: true
      },
      { name: 'name', dataType: 'varchar(80)', nullable: false, primaryKey: false },
      { name: 'email', dataType: 'varchar(120)', nullable: false, primaryKey: false },
      {
        name: 'joined_at',
        dataType: 'datetime',
        nullable: false,
        primaryKey: false,
        defaultValue: 'CURRENT_TIMESTAMP'
      }
    ]
  },
  {
    name: 'orders',
    columns: [
      {
        name: 'id',
        dataType: 'int',
        nullable: false,
        primaryKey: true,
        autoIncrement: true
      },
      { name: 'customer_id', dataType: 'int', nullable: false, primaryKey: false },
      { name: 'total', dataType: 'decimal(12,2)', nullable: false, primaryKey: false },
      {
        name: 'status',
        dataType: "enum('new','paid','shipped')",
        nullable: false,
        primaryKey: false,
        defaultValue: "'new'"
      }
    ]
  }
]
for (const t of myTables) {
  const res = await ev(
    `window.dbApi.executeDdl(${M}, { kind: 'createTable', database: ${JSON.stringify(DB)}, table: ${JSON.stringify(t.name)}, columns: ${JSON.stringify(t.columns)} })`
  )
  check(`mysql create table ${t.name}`, res.ok, res.error?.message)
}

const myFk = await ev(`window.dbApi.executeDdl(${M}, {
  kind: 'createForeignKey', database: ${JSON.stringify(DB)},
  table: 'orders', name: 'orders_customer_fk', columns: ['customer_id'],
  refTable: 'customers', refColumns: ['id'], onUpdate: 'CASCADE', onDelete: 'RESTRICT'
})`)
check('mysql create foreign key', myFk.ok, myFk.error?.message)

const customers = [
  { name: 'Rina', email: 'rina@example.com' },
  { name: 'Budi', email: 'budi@example.com' },
  { name: 'Sari', email: 'sari@example.com' }
]
for (const row of customers) {
  const res = await ev(
    `window.dbApi.insertRow({ connectionId: ${M}, database: ${JSON.stringify(DB)}, table: 'customers', values: ${JSON.stringify(row)} })`
  )
  if (!res.ok) check(`mysql seed customer ${row.name}`, false, res.error?.message)
}
check('mysql seed customers', true, `${customers.length} rows`)

const orders = [
  { customer_id: 1, total: 150000, status: 'paid' },
  { customer_id: 1, total: 75000, status: 'shipped' },
  { customer_id: 2, total: 220000, status: 'new' },
  { customer_id: 3, total: 45000, status: 'paid' },
  { customer_id: 3, total: 98000, status: 'paid' }
]
for (const row of orders) {
  const res = await ev(
    `window.dbApi.insertRow({ connectionId: ${M}, database: ${JSON.stringify(DB)}, table: 'orders', values: ${JSON.stringify(row)} })`
  )
  if (!res.ok) check(`mysql seed order ${row.total}`, false, res.error?.message)
}
check('mysql seed orders', true, `${orders.length} rows`)

const myGrant = await ev(`window.dbApi.executeUserOp(${M}, {
  kind: 'grant', user: ${JSON.stringify(USER)}, host: 'localhost', privileges: ['SELECT'],
  onType: 'table', database: ${JSON.stringify(DB)}, table: 'orders'
})`)
check('mysql grant SELECT on table', myGrant.ok, myGrant.error?.message)

const myCount = await ev(
  `window.dbApi.runQuery({ connectionId: ${M}, database: ${JSON.stringify(DB)}, sql: 'SELECT COUNT(*) AS n FROM orders', maxRows: 10 })`
)
check(
  'mysql seeded row count',
  myCount.ok && Number(myCount.data[0].rows[0].n) === orders.length,
  myCount.ok ? JSON.stringify(myCount.data[0].rows[0]) : myCount.error?.message
)

const myJoin =
  await ev(`window.dbApi.runQuery({ connectionId: ${M}, database: ${JSON.stringify(DB)},
  sql: "SELECT c.name, COUNT(o.id) AS orders, SUM(o.total) AS spent FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id, c.name ORDER BY c.id", maxRows: 10 })`)
check(
  'mysql join query',
  myJoin.ok && myJoin.data[0].rows.length === 3,
  myJoin.ok ? JSON.stringify(myJoin.data[0].rows) : myJoin.error?.message
)

const myAclSql = `SHOW GRANTS FOR '${USER}'@'localhost'`
const myAcl = await ev(
  `window.dbApi.runQuery({ connectionId: ${M}, database: ${JSON.stringify(DB)}, sql: ${JSON.stringify(myAclSql)}, maxRows: 20 })`
)
check(
  'mysql grant visible',
  myAcl.ok && JSON.stringify(myAcl.data[0].rows).includes('SELECT'),
  myAcl.ok ? JSON.stringify(myAcl.data[0].rows).slice(0, 120) : myAcl.error?.message
)

// listIndexes was broken on MySQL 9 before this run.
const myIndexes = await ev(
  `window.dbApi.listIndexes(${M}, ${JSON.stringify(DB)}, 'orders')`
)
check(
  'mysql listIndexes works',
  myIndexes.ok && myIndexes.data.length >= 1,
  myIndexes.ok ? `${myIndexes.data.length} indexes` : myIndexes.error?.message
)

const myTablesList = await ev(`window.dbApi.listTables(${M}, ${JSON.stringify(DB)})`)
check(
  'mysql tables visible',
  myTablesList.ok && myTablesList.data.length === 2,
  myTablesList.ok
    ? myTablesList.data.map((t) => t.name).join(',')
    : myTablesList.error?.message
)

await ev(`window.dbApi.disconnect(${P})`)
await ev(`window.dbApi.disconnect(${M})`)

check('no uncaught renderer errors', errors.length === 0, errors.slice(0, 2).join(' | '))
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
ws.close()
process.exit(failed.length === 0 ? 0 : 1)
