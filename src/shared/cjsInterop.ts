/**
 * Unwraps a CommonJS module imported from an ES module.
 *
 * `await import('pkg')` always returns a module namespace object. For a
 * CommonJS package, Node puts the `module.exports` value on `default` and also
 * copies some keys onto the namespace, but not functions in every case:
 *
 *   import('oracledb')  ->  { default: {...}, Connection, ... }
 *   import('oracledb')  ->  .getConnection === undefined
 *   .default.getConnection     === function
 *
 * Calling `namespace.getConnection()` therefore throws
 * "(intermediate value).getConnection is not a function". Resolving the shape in
 * one place keeps every driver from rediscovering this.
 *
 * A plain (already-unwrapped) module is returned unchanged, so this is safe to
 * apply to packages that look like ESM too.
 */
export function resolveCjsDefault<T>(mod: T | { default: T }): T {
  if (mod !== null && typeof mod === 'object' && 'default' in mod) {
    const candidate = (mod as { default?: unknown }).default
    // Only trust `default` when it is an object: a CommonJS package can export a
    // primitive or a function as its whole API, and `'default' in mod` would
    // still be true for a namespace that merely has a member named default.
    if (candidate !== null && typeof candidate === 'object') {
      return candidate as T
    }
    // A function export is also a valid module API.
    if (typeof candidate === 'function') {
      return candidate as T
    }
  }
  return mod as T
}
