import { describe, expect, it } from 'vitest'
import {
  filesToDelete,
  formatLogDate,
  logFileName,
  shouldLog,
  shouldRotate
} from '@shared/logs'

describe('formatLogDate', () => {
  it('uses the local calendar day as YYYYMMDD', () => {
    expect(formatLogDate(new Date(2026, 9, 31, 23, 59))).toBe('20261031')
    expect(formatLogDate(new Date(2026, 0, 5, 1, 0))).toBe('20260105')
  })
})

describe('logFileName', () => {
  it('names the first file of a day without a part suffix', () => {
    expect(logFileName('20261031', 1)).toBe('tupai-20261031.log')
  })

  it('adds a zero-padded part suffix after rotation', () => {
    expect(logFileName('20261031', 2)).toBe('tupai-20261031-02.log')
    expect(logFileName('20261031', 12)).toBe('tupai-20261031-12.log')
  })
})

describe('shouldLog', () => {
  it('keeps the configured level and everything above it', () => {
    expect(shouldLog('info', 'info')).toBe(true)
    expect(shouldLog('warn', 'info')).toBe(true)
    expect(shouldLog('error', 'info')).toBe(true)
    expect(shouldLog('info', 'warn')).toBe(false)
    expect(shouldLog('warn', 'warn')).toBe(true)
    expect(shouldLog('warn', 'error')).toBe(false)
    expect(shouldLog('error', 'error')).toBe(true)
  })
})

describe('shouldRotate', () => {
  it('rotates only when the next line would exceed the cap', () => {
    expect(shouldRotate(0, 10, 10)).toBe(false)
    expect(shouldRotate(5, 5, 10)).toBe(false)
    expect(shouldRotate(6, 5, 10)).toBe(true)
  })
})

describe('filesToDelete', () => {
  const file = (name: string, mtimeMs: number) => ({ name, mtimeMs })

  it('keeps everything while the count is within the cap', () => {
    expect(filesToDelete([file('a', 1), file('b', 2)], 3)).toEqual([])
  })

  it('deletes the oldest files first', () => {
    const files = [file('new', 30), file('old', 10), file('mid', 20)]
    expect(filesToDelete(files, 2)).toEqual(['old'])
    expect(filesToDelete(files, 1)).toEqual(['old', 'mid'])
  })

  it('is deterministic when timestamps tie', () => {
    expect(filesToDelete([file('b', 10), file('a', 10)], 1)).toEqual(['a'])
  })
})
