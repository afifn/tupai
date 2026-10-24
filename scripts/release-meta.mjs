// Checks the update metadata electron-builder wrote before anything is uploaded.
//
// Auto-update fails silently when the feed is wrong: latest-mac.yml pointing at
// a zip that was never uploaded, a Windows feed listing a mac artifact, or a
// version that does not match package.json. This script reads the files in
// release/ and reports exactly that, so a broken release is caught locally
// instead of by every installed app.
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

const root = process.cwd()
const releaseDir = join(root, 'release')
const results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`)
}

function read(name) {
  const path = join(releaseDir, name)
  return existsSync(path) ? readFileSync(path, 'utf-8') : null
}

/** Minimal reader for the flat `key: value` shape electron-builder emits. */
function field(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : null
}

/** Every `url:` under a `files:` list, in order. */
function urls(text) {
  return [...text.matchAll(/^\s*-\s*url:\s*(.+)$/gm)].map((m) =>
    m[1].trim().replace(/^['"]|['"]$/g, '')
  )
}

function listed(name) {
  return existsSync(join(releaseDir, name))
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
const version = pkg.version
check('package.json has a version', Boolean(version), String(version))

const mac = read('latest-mac.yml')
const win = read('latest.yml')

if (!mac && !win) {
  console.log('No update metadata in release/. Build with a mac or win target first.')
  process.exit(1)
}

if (mac) {
  check('latest-mac.yml exists', true)
  check(
    'latest-mac.yml version matches package.json',
    field(mac, 'version') === version,
    field(mac, 'version')
  )
  const files = urls(mac)
  check(
    'latest-mac.yml lists a zip',
    files.some((f) => f.endsWith('.zip')),
    files.join(', ')
  )
  for (const name of files) {
    check(`artifact ${name} exists`, listed(name))
  }
  // Squirrel.Mac downloads the zip (electron-updater picks it out of the list),
  // so `path` must point at the zip even though the dmg is listed for people who
  // download by hand.
  const mainPath = field(mac, 'path')
  check(
    'latest-mac.yml path is the zip',
    Boolean(mainPath?.endsWith('.zip')),
    String(mainPath)
  )
}

if (win) {
  check('latest.yml exists', true)
  check(
    'latest.yml version matches package.json',
    field(win, 'version') === version,
    field(win, 'version')
  )
  const files = urls(win)
  check(
    'latest.yml lists an exe',
    files.some((f) => f.endsWith('.exe')),
    files.join(', ')
  )
  for (const name of files) {
    check(`artifact ${name} exists`, listed(name))
  }
}

// A feed that references a file with no blockmap still installs, but the
// download is full-size every time; report it so the release is not silently
// slower than it should be.
if (mac) {
  for (const name of urls(mac)) {
    if (!name.endsWith('.zip')) continue
    check(`blockmap for ${name}`, listed(`${name}.blockmap`))
  }
}

// The database worker is an ES module that runs from app.asar.unpacked, outside
// the app's own package.json. Without a "type": "module" marker next to it, Node
// falls back to CommonJS and every connection fails with "Cannot use import
// statement outside a module". A build made inside the project directory hides
// the bug, because Node then finds the project's package.json while walking up.
const unpackedRoots = [
  join(releaseDir, 'mac-arm64', 'Tupai.app', 'Contents', 'Resources'),
  join(releaseDir, 'mac', 'Tupai.app', 'Contents', 'Resources'),
  join(releaseDir, 'win-unpacked', 'resources')
]

let checkedUnpacked = false
for (const resources of unpackedRoots) {
  const marker = join(resources, 'app.asar.unpacked', 'out', 'main', 'package.json')
  if (!existsSync(marker)) continue
  checkedUnpacked = true
  let type = null
  try {
    type = JSON.parse(readFileSync(marker, 'utf-8')).type ?? null
  } catch {
    type = 'unreadable'
  }
  check(
    'unpacked worker is marked as an ES module',
    type === 'module',
    `${marker}: ${type}`
  )
}

if (!checkedUnpacked) {
  console.log('No unpacked app found; build a target before checking the worker marker.')
}

const artifacts = readdirSync(releaseDir).filter((f) => /\.(dmg|zip|exe)$/.test(f))
console.log(`\nArtifacts: ${artifacts.join(', ') || '(none)'}`)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
