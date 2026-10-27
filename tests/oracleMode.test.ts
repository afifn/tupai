import { describe, expect, it } from 'vitest'
import { describeConnectionError } from '@shared/connectionError'
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/settings'
import { messagesId } from '@shared/i18n'

const tr = (
  key: keyof typeof messagesId,
  params?: Record<string, string | number>
): string => {
  const template = messagesId[key] ?? key
  return params
    ? template.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name] ?? ''))
    : template
}

describe('Oracle thin mode error', () => {
  it('explains NJS-138 instead of leaving the raw code', () => {
    const failure = describeConnectionError(
      'NJS-138: connections to this database server version are not supported by node-oracledb in Thin mode',
      'oracle',
      tr
    )
    expect(failure.title).toContain('Oracle')
    // The user has to know that an older server needs the client library.
    expect(failure.hint).toContain('12.1')
    expect(failure.hint).toContain('Instant Client')
    expect(failure.hint).toContain('Pengaturan')
    // Not retryable: retrying without changing the setting fails the same way.
    expect(failure.retryable).toBe(false)
  })

  it('points at the client folder for other client-library failures', () => {
    const failure = describeConnectionError(
      'DPI-1047: Cannot locate a 64-bit Oracle Client library: "oci.dll"',
      'oracle',
      tr
    )
    expect(failure.title).toContain('Instant Client')
    expect(failure.hint).toContain('oci.dll')
    expect(failure.hint).toContain('DPI-1047')
    expect(failure.retryable).toBe(false)
  })

  it('still reports a plain listener failure as retryable', () => {
    const failure = describeConnectionError('ORA-12541: TNS:no listener', 'oracle', tr)
    expect(failure.retryable).toBe(true)
  })
})

describe('oracle settings', () => {
  it('defaults to thin mode with no client folder', () => {
    expect(DEFAULT_SETTINGS.oracle.clientLibDir).toBe('')
  })

  it('keeps a stored client folder', () => {
    const merged = mergeSettings({
      ...DEFAULT_SETTINGS,
      oracle: { clientLibDir: 'C:\\oracle\\instantclient_21_13' }
    })
    expect(merged.oracle.clientLibDir).toBe('C:\\oracle\\instantclient_21_13')
  })

  it('fills in the oracle block for a settings file written before it existed', () => {
    const legacy = { ...DEFAULT_SETTINGS } as Record<string, unknown>
    delete legacy.oracle
    const merged = mergeSettings(legacy)
    expect(merged.oracle.clientLibDir).toBe('')
  })

  it('falls back to defaults when the folder is not a string', () => {
    const merged = mergeSettings({
      ...DEFAULT_SETTINGS,
      oracle: { clientLibDir: 42 }
    })
    expect(merged.oracle.clientLibDir).toBe('')
  })
})
