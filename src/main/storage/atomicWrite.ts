import { randomUUID } from 'crypto'
import { copyFile, mkdir, rename, writeFile, unlink } from 'fs/promises'
import { dirname } from 'path'

// Writes a JSON file atomically: a temporary file in the same directory is
// written and flushed, then renamed over the target.
//
// Plain writeFile truncates the target first, so a crash, a kill signal, or a
// full disk during the write leaves an empty or half-written file. For
// connections.json that means every saved connection disappears at once. The
// rename is atomic on the same filesystem, so readers see either the old file
// or the new one, never a partial one.
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: { backup?: boolean } = {}
): Promise<void> {
  await writeAtomic(path, JSON.stringify(value, null, 2), options)
}

export async function writeAtomic(
  path: string,
  content: string,
  options: { backup?: boolean } = {}
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // Same directory as the target so the rename stays on one filesystem. The
  // name is unique per call: two writes in the same millisecond would otherwise
  // share a temp file and one of them would fail with ENOENT.
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, content, 'utf-8')
    if (options.backup) {
      // Keep the previous content next to the file. Restoring a lost or
      // corrupted store is then a rename, not a lost afternoon.
      await copyFile(path, `${path}.bak`).catch(() => undefined)
    }
    await rename(temp, path)
  } catch (err) {
    await unlink(temp).catch(() => undefined)
    throw err
  }
}
