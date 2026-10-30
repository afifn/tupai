import { describe, expect, it } from 'vitest'
import { normalizeClientDir, sameClientDir } from '@shared/oracleClientPath'

describe('Oracle client folder comparison', () => {
  it('treats separators and a trailing slash as the same folder', () => {
    expect(
      sameClientDir(
        'D:\\app\\product\\21c\\dbhomeXE\\bin',
        'D:/app/product/21c/dbhomeXE/bin'
      )
    ).toBe(true)
    expect(sameClientDir('D:\\oracle\\ic\\', 'D:\\oracle\\ic')).toBe(true)
  })

  it('ignores repeated separators', () => {
    expect(sameClientDir('D:\\\\oracle\\\\ic', 'D:/oracle/ic')).toBe(true)
  })

  it('keeps a bare root a path', () => {
    expect(normalizeClientDir('/')).toBe('/')
    expect(sameClientDir('/', '//')).toBe(true)
  })

  it('compares case only where the platform does', () => {
    const upper = 'D:\\Oracle\\IC'
    const lower = 'd:\\oracle\\ic'
    expect(sameClientDir(upper, lower)).toBe(process.platform === 'win32')
  })

  it('still separates two different folders', () => {
    expect(sameClientDir('D:\\oracle\\ic', 'D:\\oracle\\ic2')).toBe(false)
    expect(sameClientDir('', 'D:\\oracle\\ic')).toBe(false)
  })
})
