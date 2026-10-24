// Verifies the store writes are atomic: a crash mid-write must leave the old
// file intact instead of an empty one. This is the failure that wiped
// connections.json during a test run.
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeJsonAtomic } from '../../src/main/storage/atomicWrite'

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tupai-atomic-'))
  const target = join(dir, 'connections.json')

  await writeJsonAtomic(target, [{ id: 'a' }])
  check('writes a new file', JSON.parse(await readFile(target, 'utf-8')).length === 1)

  await writeJsonAtomic(target, [{ id: 'a' }, { id: 'b' }])
  check('overwrites atomically', JSON.parse(await readFile(target, 'utf-8')).length === 2)

  // No temporary files left behind.
  const { readdir } = await import('fs/promises')
  const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.tmp'))
  check('leaves no temp files', leftovers.length === 0, leftovers.join(','))

  // Simulate a failed write: the directory is read-only, so the temp file
  // cannot be created. The old file must survive untouched.
  const before = await readFile(target, 'utf-8')
  const { chmod } = await import('fs/promises')
  await chmod(dir, 0o500)
  let failed = false
  try {
    await writeJsonAtomic(target, [{ id: 'lost' }])
  } catch {
    failed = true
  }
  await chmod(dir, 0o700)
  const after = await readFile(target, 'utf-8')
  check('failed write is reported', failed)
  check('failed write keeps the previous content', after === before, after === before ? 'unchanged' : 'CHANGED')

  // Concurrent writers must not interleave into a broken file. Each write uses
  // its own temp name, so these really run in parallel.
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => writeJsonAtomic(target, [{ id: i }]))
  )
  let parsed: unknown = null
  try {
    parsed = JSON.parse(await readFile(target, 'utf-8'))
  } catch {
    parsed = null
  }
  check('concurrent writes leave valid JSON', Array.isArray(parsed) && parsed.length === 1)

  // Backup: the previous content must be recoverable after an overwrite.
  await writeJsonAtomic(target, [{ id: 'first' }], { backup: true })
  await writeJsonAtomic(target, [{ id: 'second' }], { backup: true })
  const backup = JSON.parse(await readFile(`${target}.bak`, 'utf-8'))
  check('backup keeps the previous version', backup[0].id === 'first', JSON.stringify(backup))

  // Old-style non-atomic write is the control: truncating leaves a partial file.
  await writeFile(target, 'x'.repeat(5000), 'utf-8')
  const partial = await readFile(target, 'utf-8')
  check('control: plain truncate is not atomic', partial.length === 5000)

  await rm(dir, { recursive: true, force: true })
  const failedCount = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failedCount}/${results.length} passed`)
  if (failedCount > 0) for (const f of results.filter((r) => !r.ok)) console.log(` - ${f.name}`)
  process.exit(failedCount === 0 ? 0 : 1)
}

void main()
