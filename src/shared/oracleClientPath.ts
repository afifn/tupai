/**
 * Compares two Oracle client folders the way the filesystem would.
 *
 * The folder a user picks is a filesystem path, and the same folder has many
 * spellings: `D:\oracle\ic`, `D:/oracle/ic`, `D:\oracle\ic\`. Comparing the raw
 * strings would report "you must restart" for a folder the process already
 * loaded, which is exactly the confusing message this check exists to avoid.
 *
 * Windows also ignores case, so `D:\Oracle\IC` and `d:\oracle\ic` are the same
 * folder there. POSIX paths are case-sensitive, so case is preserved elsewhere.
 */
export function normalizeClientDir(dir: string): string {
  const collapsed = dir.trim().replace(/[\\/]+/g, '/')
  // A trailing separator does not change which folder is meant, but a bare root
  // ("/" or "C:/") must keep its slash to stay a path at all.
  const trimmed = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed
  return isWindows() ? trimmed.toLowerCase() : trimmed
}

export function sameClientDir(a: string, b: string): boolean {
  return normalizeClientDir(a) === normalizeClientDir(b)
}

// The renderer is sandboxed and has no `process`, so this must not assume it.
function isWindows(): boolean {
  return typeof process !== 'undefined' && process.platform === 'win32'
}
