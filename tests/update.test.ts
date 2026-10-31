import { describe, expect, it } from 'vitest'
import {
  RELEASE_PAGE,
  canAutoInstall,
  compareVersions,
  describeUpdateError,
  isDeveloperSigned,
  isMissingReleaseFeedError,
  isNewerVersion,
  manualDownloadUrl
} from '@shared/update'

describe('isDeveloperSigned', () => {
  it('accepts a real Developer ID signature', () => {
    const output = [
      'Executable=/Applications/Tupai.app/Contents/MacOS/Tupai',
      'Identifier=com.tupai.app',
      'Authority=Developer ID Application: Afif (TEAMID)',
      'Authority=Developer ID Certification Authority',
      'Authority=Apple Root CA'
    ].join('\n')
    expect(isDeveloperSigned(output)).toBe(true)
  })

  it('rejects an ad-hoc signature', () => {
    // This is what an unsigned electron-builder output reports, and Squirrel.Mac
    // refuses to install an update over it.
    const output = [
      'Executable=/Volumes/Lexar/DEV/DESKTOP/tupai/release/mac-arm64/Tupai.app/Contents/MacOS/Tupai',
      'Identifier=Electron',
      'Signature=adhoc',
      'Info.plist=not bound'
    ].join('\n')
    expect(isDeveloperSigned(output)).toBe(false)
  })

  it('rejects empty output from a missing signature', () => {
    expect(isDeveloperSigned('')).toBe(false)
  })
})

describe('canAutoInstall', () => {
  it('never auto-installs from a development run', () => {
    expect(canAutoInstall('win32', false, true)).toBe(false)
    expect(canAutoInstall('darwin', false, true)).toBe(false)
  })

  it('auto-installs on Windows, where NSIS runs the installer', () => {
    expect(canAutoInstall('win32', true, false)).toBe(true)
  })

  it('requires a Developer ID on macOS', () => {
    expect(canAutoInstall('darwin', true, false)).toBe(false)
    expect(canAutoInstall('darwin', true, true)).toBe(true)
  })

  it('does not claim support for Linux', () => {
    expect(canAutoInstall('linux', true, true)).toBe(false)
  })
})

describe('manualDownloadUrl', () => {
  it('points at the latest release page', () => {
    expect(manualDownloadUrl()).toBe(RELEASE_PAGE)
    expect(manualDownloadUrl()).toMatch(
      /^https:\/\/github\.com\/afifn\/tupai\/releases\//
    )
  })
})

describe('compareVersions', () => {
  it('orders dotted versions numerically, not as text', () => {
    expect(compareVersions('0.0.2', '0.0.10')).toBeLessThan(0)
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })

  it('ignores a leading v', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
  })

  it('treats a missing segment as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0)
  })

  it('sorts a prerelease before its release', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.1')).toBeGreaterThan(0)
  })
})

describe('isNewerVersion', () => {
  it('offers only a strictly newer version', () => {
    expect(isNewerVersion('0.0.1', '0.0.2')).toBe(true)
    expect(isNewerVersion('0.0.1', '0.0.1')).toBe(false)
    expect(isNewerVersion('0.0.2', '0.0.1')).toBe(false)
  })
})

describe('describeUpdateError', () => {
  it('recognizes a missing GitHub release feed as no available update', () => {
    const raw =
      'HttpError: 404 \n"method: GET url: https://github.com/afifn/tupai/releases.atom\n\nPlease double check..."'
    expect(isMissingReleaseFeedError(raw)).toBe(true)
    expect(
      isMissingReleaseFeedError(
        '404 https://github.com/afifn/tupai/releases/download/v1/file.zip'
      )
    ).toBe(false)
  })

  it('reports a network failure', () => {
    expect(describeUpdateError('getaddrinfo ENOTFOUND github.com')).toBe(
      'Tidak bisa menghubungi server pembaruan. Periksa koneksi internet.'
    )
  })

  it('keeps only the first line of an unknown error', () => {
    expect(describeUpdateError('Something broke\nHeaders: {...}')).toBe('Something broke')
  })
})
