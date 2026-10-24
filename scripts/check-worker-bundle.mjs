#!/usr/bin/env node
// Fails the build when the database worker bundle reaches `electron`.
//
// The worker runs in worker_threads, where the `electron` module does not
// exist. Importing it there fails at runtime with a message that says nothing
// about the real cause ("Cannot read properties of undefined (reading
// 'exports')"), and only for the engine that pulled it in. That is exactly how
// a SSH host-key helper once broke every MySQL and PostgreSQL connection while
// SQLite kept working.
//
// The check walks the import graph from out/main/db.worker.js instead of
// grepping every chunk, because a chunk may legitimately be shared with the
// main process (which does have electron).
import { readFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'

const entry = resolve(process.argv[2] ?? 'out/main/db.worker.js')

// Static imports, re-exports, bare imports, and dynamic import() calls: the
// adapter chunks are loaded lazily with import(), so a static-only check would
// miss exactly the case this guard exists for.
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

async function readImports(file) {
  let text
  try {
    text = await readFile(file, 'utf-8')
  } catch {
    return []
  }
  const found = []
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3]
    if (spec) found.push(spec)
  }
  return found
}

async function main() {
  const seen = new Set()
  const queue = [entry]
  const offenders = []

  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of await readImports(file)) {
      if (spec === 'electron' || spec.startsWith('electron/')) {
        offenders.push({ file, spec })
        continue
      }
      // Only relative imports are part of the bundle graph; packages are
      // resolved at runtime and are externalized by electron-vite.
      if (!spec.startsWith('.')) continue
      const next = resolve(dirname(file), spec)
      queue.push(next.endsWith('.js') ? next : `${next}.js`)
    }
  }

  if (offenders.length > 0) {
    console.error('Worker bundle imports electron, which is unavailable in worker_threads:')
    for (const { file, spec } of offenders) {
      console.error(`  ${spec} <- ${file}`)
    }
    console.error(
      'Move the shared code out of the worker graph, or pass the value in through an env var.'
    )
    process.exit(1)
  }

  console.log(`worker bundle check: ${seen.size} files, no electron import`)
}

await main()
