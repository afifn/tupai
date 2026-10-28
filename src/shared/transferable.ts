// Values that cross the worker boundary must be plain data. A driver can return a
// live handle instead (a LOB bound to the connection, a result set, an object
// type), and postMessage then throws a DataCloneError. That error used to be
// uncaught, which killed the worker thread and every connection with it.
//
// These helpers turn such a value into a readable label so the rest of the row
// still reaches the UI.

const MAX_DEPTH = 8

export function describeOpaque(value: unknown): string {
  if (typeof value === 'function') return '[fungsi]'
  const name = (value as { constructor?: { name?: string } } | null)?.constructor?.name
  return name ? `[${name}]` : '[nilai tidak bisa ditampilkan]'
}

export function toTransferable(value: unknown, depth = 0): unknown {
  if (value === null) return null
  if (typeof value === 'function') return describeOpaque(value)
  if (typeof value !== 'object') return value
  if (value instanceof Date || value instanceof Uint8Array) return value
  if (depth >= MAX_DEPTH) return describeOpaque(value)
  if (Array.isArray(value)) return value.map((item) => toTransferable(item, depth + 1))
  const proto = Object.getPrototypeOf(value)
  // Only plain objects are walked. Anything else is a class instance whose
  // fields may hold state that means nothing outside the thread.
  if (proto !== Object.prototype && proto !== null) return describeOpaque(value)
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = toTransferable(item, depth + 1)
  }
  return out
}
