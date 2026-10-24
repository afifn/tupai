import type { DbEngine } from './types'

// One source of truth for what each engine needs and what it defaults to. The
// connection form, the Navicat importer, and the tests all read from here, so a
// new engine cannot be half-added: a missing entry is a compile error.
export interface EngineDefaults {
  // Null for engines with no TCP port (SQLite is a file).
  port: number | null
  host: string
  // Placeholder only. An empty string means the engine has no conventional
  // administrative user worth suggesting.
  user: string
}

export interface EngineCapabilities {
  // Fields the form shows. Anything false is hidden instead of shown and then
  // rejected by the driver, which used to be the case for Oracle SSL.
  host: boolean
  port: boolean
  user: boolean
  password: boolean
  database: boolean
  file: boolean
  ssl: boolean
  ssh: boolean
  // Oracle connects with a service name rather than a database name.
  serviceName: boolean
}

export const ENGINE_DEFAULTS: Record<DbEngine, EngineDefaults> = {
  mysql: { port: 3306, host: 'localhost', user: 'root' },
  mariadb: { port: 3306, host: 'localhost', user: 'root' },
  postgres: { port: 5432, host: 'localhost', user: 'postgres' },
  oracle: { port: 1521, host: 'localhost', user: 'system' },
  mongodb: { port: 27017, host: 'localhost', user: '' },
  sqlite: { port: null, host: '', user: '' }
}

export const ENGINE_CAPABILITIES: Record<DbEngine, EngineCapabilities> = {
  mysql: {
    host: true,
    port: true,
    user: true,
    password: true,
    database: true,
    file: false,
    ssl: true,
    ssh: true,
    serviceName: false
  },
  mariadb: {
    host: true,
    port: true,
    user: true,
    password: true,
    database: true,
    file: false,
    ssl: true,
    ssh: true,
    serviceName: false
  },
  postgres: {
    host: true,
    port: true,
    user: true,
    password: true,
    database: true,
    file: false,
    ssl: true,
    ssh: true,
    serviceName: false
  },
  // Oracle TLS is configured through TCPS descriptors or a wallet, not the
  // simple host:port + PEM form the form offers, so SSL is hidden here.
  oracle: {
    host: true,
    port: true,
    user: true,
    password: true,
    database: true,
    file: false,
    ssl: false,
    ssh: false,
    serviceName: true
  },
  mongodb: {
    host: true,
    port: true,
    user: true,
    password: true,
    database: true,
    file: false,
    ssl: true,
    ssh: false,
    serviceName: false
  },
  sqlite: {
    host: false,
    port: false,
    user: false,
    password: false,
    database: false,
    file: true,
    ssl: false,
    ssh: false,
    serviceName: false
  }
}

export function defaultsFor(engine: DbEngine): EngineDefaults {
  return ENGINE_DEFAULTS[engine]
}

export function capabilitiesFor(engine: DbEngine): EngineCapabilities {
  return ENGINE_CAPABILITIES[engine]
}

/**
 * Whether a port should follow the newly selected engine.
 *
 * The user's own value must survive an engine change: switching MySQL to
 * PostgreSQL on a server that listens on 3306 should not silently rewrite the
 * port. Only an untouched field, or one still holding the previous engine's
 * default, is replaced.
 */
export function shouldAdoptPort(
  currentPort: string,
  previousEngine: DbEngine,
  portTouched: boolean
): boolean {
  if (portTouched) return false
  const trimmed = currentPort.trim()
  if (!trimmed) return true
  const previousDefault = ENGINE_DEFAULTS[previousEngine].port
  // Coming from SQLite there is no port to preserve, so the carried-over value
  // is stale by definition.
  if (previousDefault === null) return true
  return trimmed === String(previousDefault)
}
