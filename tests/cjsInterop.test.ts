import { describe, expect, it } from 'vitest'
import { resolveCjsDefault } from '@shared/cjsInterop'

// `await import('pkg')` returns a namespace object even for a CommonJS package.
// `oracledb` puts its API on `default`, so calling `namespace.getConnection()`
// threw "(intermediate value).getConnection is not a function" and every Oracle
// connection failed before a single packet reached the server.
describe('resolveCjsDefault', () => {
  it('unwraps a CommonJS namespace to its default export', () => {
    const api = { getConnection: () => 'ok', OUT_FORMAT_OBJECT: 4002 }
    const namespace = { default: api, Connection: class {} }
    expect(resolveCjsDefault(namespace)).toBe(api)
    expect(resolveCjsDefault(namespace).getConnection()).toBe('ok')
  })

  it('returns a plain module unchanged', () => {
    const esm = { Client: class {}, Query: class {} }
    expect(resolveCjsDefault(esm)).toBe(esm)
  })

  it('unwraps a module whose whole export is a function', () => {
    const factory = (): string => 'called'
    expect(resolveCjsDefault({ default: factory })).toBe(factory)
  })

  it('ignores a default member that is not the module API', () => {
    // A namespace can have a property literally named "default" that is a
    // string; treating that as the API would break the caller.
    const esm = { default: 'not the api', createPool: () => 'pool' }
    expect(resolveCjsDefault(esm)).toBe(esm)
  })

  it('handles null without throwing', () => {
    expect(resolveCjsDefault(null as never)).toBeNull()
  })
})
