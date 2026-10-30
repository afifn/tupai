import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionConfig } from '@shared/types'

// The Oracle library can be initialised once per process: `initOracleClient`
// throws NJS-090 for a second call with another folder, and NJS-118 when a thin
// connection already exists. The fake records what the driver asked for so the
// tests can prove the second folder is never loaded.
const fake = vi.hoisted(() => ({
  inits: [] as { libDir?: string }[],
  initError: null as Error | null,
  connections: 0
}))

vi.mock('oracledb', () => {
  const api = {
    CLOB: 1,
    OUT_FORMAT_OBJECT: 4002,
    DB_TYPE_BLOB: 2007,
    DB_TYPE_RAW: 2006,
    fetchAsString: [] as unknown[],
    initOracleClient: (options: { libDir?: string }) => {
      if (fake.initError) throw fake.initError
      fake.inits.push(options)
    },
    getConnection: async () => {
      fake.connections += 1
      return { close: async () => undefined, callTimeout: 0 }
    }
  }
  return { default: api, ...api }
})

const cfg = {
  engine: 'oracle',
  id: 'oracle-test',
  host: 'localhost',
  port: 1521,
  database: 'XEPDB1',
  user: 'scott',
  password: 'tiger'
} as ConnectionConfig

const DIR_A = 'C:\\oracle\\instantclient_21_13'
const DIR_B = 'D:\\app\\product\\21c\\dbhomeXE\\bin'

let userData: string

// Each case needs its own copy of the module: the loaded folder is module state,
// exactly like the process-wide state it mirrors.
async function loadAdapter(): Promise<
  ReturnType<typeof import('../src/main/drivers/oracle').createOracleAdapter>
> {
  vi.resetModules()
  const { createOracleAdapter } = await import('../src/main/drivers/oracle')
  return createOracleAdapter('oracle')
}

function writeSettings(clientLibDir: string): void {
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ oracle: { clientLibDir } })
  )
}

beforeEach(() => {
  fake.inits = []
  fake.initError = null
  fake.connections = 0
  userData = mkdtempSync(join(tmpdir(), 'tupai-oracle-'))
  process.env.TUPAI_USER_DATA = userData
})

afterEach(() => {
  delete process.env.TUPAI_USER_DATA
  rmSync(userData, { recursive: true, force: true })
})

describe('Oracle client folder changes', () => {
  it('loads the configured folder once and connects through it', async () => {
    writeSettings(DIR_A)
    const adapter = await loadAdapter()
    await expect(adapter.testConnection(cfg)).resolves.toBe(true)
    expect(fake.inits).toEqual([{ libDir: DIR_A }])
    expect(fake.connections).toBe(1)
  })

  it('refuses a different folder without calling init again', async () => {
    writeSettings(DIR_A)
    const adapter = await loadAdapter()
    await adapter.testConnection(cfg)

    writeSettings(DIR_B)
    await expect(adapter.testConnection(cfg)).rejects.toMatchObject({
      code: 'ORACLE_CLIENT_RESTART_REQUIRED'
    })
    // The whole point: the second init would have thrown NJS-090 and blamed the
    // folder the user just picked, which is perfectly valid.
    expect(fake.inits).toEqual([{ libDir: DIR_A }])
    expect(fake.connections).toBe(1)
  })

  it('accepts the loaded folder again after the setting is changed back', async () => {
    writeSettings(DIR_A)
    const adapter = await loadAdapter()
    await adapter.testConnection(cfg)

    writeSettings(DIR_B)
    await expect(adapter.testConnection(cfg)).rejects.toMatchObject({
      code: 'ORACLE_CLIENT_RESTART_REQUIRED'
    })

    writeSettings(DIR_A)
    await expect(adapter.testConnection(cfg)).resolves.toBe(true)
    expect(fake.inits).toHaveLength(1)
  })

  it('reports a driver NJS-090 as a restart, not as a bad folder', async () => {
    writeSettings(DIR_B)
    fake.initError = new Error(
      'NJS-090: initOracleClient() was already called with different arguments'
    )
    const adapter = await loadAdapter()
    await expect(adapter.testConnection(cfg)).rejects.toMatchObject({
      code: 'ORACLE_CLIENT_RESTART_REQUIRED'
    })
    expect(fake.connections).toBe(0)
  })

  it('retries a folder that failed to load once its contents are fixed', async () => {
    writeSettings(DIR_B)
    fake.initError = new Error('DPI-1047: Cannot locate a 64-bit Oracle Client library')
    const adapter = await loadAdapter()
    await expect(adapter.testConnection(cfg)).rejects.toMatchObject({
      code: 'ORACLE_CLIENT_FAILED'
    })

    // Extracting the missing library into the same folder must be enough; the
    // failure is not memoised per path.
    fake.initError = null
    await expect(adapter.testConnection(cfg)).resolves.toBe(true)
    expect(fake.inits).toEqual([{ libDir: DIR_B }])
  })

  it('stays in thin mode when no folder is configured', async () => {
    writeSettings('')
    const adapter = await loadAdapter()
    await expect(adapter.testConnection(cfg)).resolves.toBe(true)
    expect(fake.inits).toEqual([])
    expect(fake.connections).toBe(1)
  })
})
