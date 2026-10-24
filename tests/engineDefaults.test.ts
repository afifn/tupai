import { describe, expect, it } from 'vitest'
import {
  ENGINE_CAPABILITIES,
  ENGINE_DEFAULTS,
  capabilitiesFor,
  defaultsFor,
  shouldAdoptPort
} from '@shared/engineDefaults'
import type { DbEngine } from '@shared/types'

const ENGINES: DbEngine[] = [
  'mysql',
  'mariadb',
  'postgres',
  'oracle',
  'sqlite',
  'mongodb'
]

describe('engine defaults', () => {
  it('covers every engine', () => {
    for (const engine of ENGINES) {
      expect(ENGINE_DEFAULTS[engine], engine).toBeDefined()
      expect(ENGINE_CAPABILITIES[engine], engine).toBeDefined()
    }
  })

  it('uses the conventional port for each engine', () => {
    expect(defaultsFor('mysql').port).toBe(3306)
    expect(defaultsFor('mariadb').port).toBe(3306)
    expect(defaultsFor('postgres').port).toBe(5432)
    expect(defaultsFor('oracle').port).toBe(1521)
    expect(defaultsFor('mongodb').port).toBe(27017)
    // SQLite is a file, so it has no port to suggest.
    expect(defaultsFor('sqlite').port).toBeNull()
  })

  it('marks SQLite as file-only and the others as network engines', () => {
    expect(capabilitiesFor('sqlite').file).toBe(true)
    expect(capabilitiesFor('sqlite').port).toBe(false)
    for (const engine of ENGINES.filter((e) => e !== 'sqlite')) {
      expect(capabilitiesFor(engine).file, engine).toBe(false)
      expect(capabilitiesFor(engine).port, engine).toBe(true)
    }
  })

  it('hides Oracle SSL and SSH, which the driver rejects', () => {
    // Oracle TLS needs TCPS/wallet and the tunnel is not implemented, so the
    // form must not offer either.
    expect(capabilitiesFor('oracle').ssl).toBe(false)
    expect(capabilitiesFor('oracle').ssh).toBe(false)
    expect(capabilitiesFor('oracle').serviceName).toBe(true)
  })

  it('offers SSH only where a tunnel exists', () => {
    expect(capabilitiesFor('mysql').ssh).toBe(true)
    expect(capabilitiesFor('mariadb').ssh).toBe(true)
    expect(capabilitiesFor('postgres').ssh).toBe(true)
    expect(capabilitiesFor('mongodb').ssh).toBe(false)
    expect(capabilitiesFor('sqlite').ssh).toBe(false)
  })
})

describe('shouldAdoptPort', () => {
  it('replaces an untouched port with the new engine default', () => {
    expect(shouldAdoptPort('3306', 'mysql', false)).toBe(true)
  })

  it('replaces an empty port', () => {
    expect(shouldAdoptPort('', 'mysql', false)).toBe(true)
    expect(shouldAdoptPort('   ', 'mysql', false)).toBe(true)
  })

  it('keeps a port the user typed', () => {
    // A server on a non-standard port must survive an engine switch.
    expect(shouldAdoptPort('13306', 'mysql', true)).toBe(false)
  })

  it('keeps a value that is not the previous default', () => {
    expect(shouldAdoptPort('13306', 'mysql', false)).toBe(false)
  })

  it('drops a carried-over port when leaving SQLite', () => {
    // SQLite has no port, so a value left in the field came from an earlier
    // engine and must not follow the user into the next one.
    expect(shouldAdoptPort('', 'sqlite', false)).toBe(true)
    expect(shouldAdoptPort('3306', 'sqlite', false)).toBe(true)
  })
})
