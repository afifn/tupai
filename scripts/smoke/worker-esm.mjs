// The database worker must load from a directory outside the project.
//
// In a packaged app the worker lives in `app.asar.unpacked/out/main`, where the
// nearest package.json is not the project's. Node then treats the ES module as
// CommonJS and every connection fails with "Cannot use import statement outside
// a module". Running the check from inside the project hides that, because Node
// finds the project's `"type": "module"` while walking up the tree.
//
// This copies the built worker to a temporary directory outside the repository
// and spawns it with plain Node, so the module type is decided the same way the
// packaged app decides it.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { Worker } from 'worker_threads'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`)
}

const project = resolve('.')
const source = resolve('out/main')

// The smoke runner points TMPDIR at .smoke/tmp inside the project, and a copy
// there would still see the project's package.json while Node walks up, which is
// exactly what this test must avoid. Pick a base outside the repository.
function outsideProject() {
  for (const candidate of [tmpdir(), '/tmp', '/var/tmp', process.env.HOME]) {
    if (!candidate) continue
    const resolved = resolve(candidate)
    if (!resolved.startsWith(project)) return resolved
  }
  throw new Error('No temporary directory outside the project is available.')
}

const work = mkdtempSync(join(outsideProject(), 'tupai-worker-'))

/** Spawns the worker and waits for a reply, a crash, or a timeout. */
function probe(dir) {
  return new Promise((done) => {
    const worker = new Worker(join(dir, 'db.worker.js'))
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate().catch(() => undefined)
      done(result)
    }
    const timer = setTimeout(() => finish({ kind: 'timeout' }), 8000)
    worker.on('error', (err) => finish({ kind: 'error', message: err.message }))
    worker.on('exit', (code) => finish({ kind: 'exit', code }))
    worker.on('message', (msg) => finish({ kind: 'message', msg }))
    // An unknown operation is enough: a reply proves the module was parsed and
    // the message loop is running, without opening a database.
    worker.postMessage({ id: 1, op: '__probe__', payload: {} })
  })
}

try {
  // 1. Outside the project, with the marker electron-builder ships.
  const withMarker = join(work, 'with-marker')
  cpSync(source, withMarker, { recursive: true })
  writeFileSync(join(withMarker, 'package.json'), JSON.stringify({ type: 'module' }))
  const ok = await probe(withMarker)
  check(
    'worker loads from a directory outside the project',
    ok.kind === 'message',
    JSON.stringify(ok)
  )

  // 2. Without the marker the same directory is treated as CommonJS, which is
  //    the packaged bug. This asserts the marker is what makes the difference,
  //    so a future change that drops it fails here.
  const withoutMarker = join(work, 'without-marker')
  cpSync(source, withoutMarker, { recursive: true })
  const broken = await probe(withoutMarker)
  check(
    'without the marker the worker fails, proving the marker matters',
    broken.kind === 'error' &&
      /import statement outside a module/.test(broken.message ?? ''),
    JSON.stringify(broken)
  )

  // 3. The shipped configuration must actually produce that marker.
  const builderConfig = readFileSync(resolve('electron-builder.yml'), 'utf-8')
  check(
    'electron-builder ships the ES module marker next to the worker',
    /app\.asar\.unpacked\/out\/main\/package\.json/.test(builderConfig)
  )
} finally {
  rmSync(work, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
