/**
 * Update rules that do not need Electron, so they can be tested directly.
 *
 * The updater itself lives in main, but the decisions that matter are here: who
 * may install an update silently, and what the user is offered when the build
 * cannot install it.
 */

export const RELEASE_PAGE = 'https://github.com/afifn/tupai/releases/latest'

/**
 * Squirrel.Mac refuses an update whose signature does not match the running
 * app. An ad-hoc signature is not enough: `codesign -dv` reports
 * `Signature=adhoc` for the unsigned builds we ship today, and only a real
 * Developer ID shows an `Authority=` line.
 */
export function isDeveloperSigned(codesignOutput: string): boolean {
  return /Authority=Developer ID Application/.test(codesignOutput)
}

/**
 * True when the app can download, replace itself, and restart without the user
 * leaving the app. macOS needs a Developer ID signature; Windows works with an
 * unsigned NSIS installer because the updater runs the installer itself.
 */
export function canAutoInstall(
  platform: NodeJS.Platform,
  packaged: boolean,
  signed: boolean
): boolean {
  if (!packaged) return false
  if (platform === 'darwin') return signed
  if (platform === 'win32') return true
  // Linux is not a shipping target; the generic provider would need an
  // AppImage or a package manager, neither of which exists here.
  return false
}

/** Where to send the user when the build cannot install the update itself. */
export function manualDownloadUrl(): string {
  return RELEASE_PAGE
}

/**
 * Compares two dotted versions numerically, ignoring a leading `v`. Returns a
 * negative number when `a` is older, 0 when equal, positive when newer.
 *
 * A prerelease suffix (`1.2.3-beta.1`) sorts before its release, matching what
 * users expect from semver without pulling in a parser.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { parts: number[]; pre: string } => {
    const clean = value.trim().replace(/^v/i, '')
    const dash = clean.indexOf('-')
    const core = dash < 0 ? clean : clean.slice(0, dash)
    const pre = dash < 0 ? '' : clean.slice(dash + 1)
    return {
      parts: core.split('.').map((part) => {
        const n = Number.parseInt(part, 10)
        return Number.isFinite(n) ? n : 0
      }),
      pre
    }
  }
  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.parts.length, right.parts.length)
  for (let i = 0; i < length; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (left.pre === right.pre) return 0
  // A release is newer than any prerelease of the same core version.
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre.localeCompare(right.pre)
}

/** True when `candidate` is a version the user should be offered. */
export function isNewerVersion(current: string, candidate: string): boolean {
  return compareVersions(candidate, current) > 0
}

/** True when GitHub has no release feed for this repository yet. */
export function isMissingReleaseFeedError(message: string): boolean {
  return /\b404\b/.test(message) && /releases\.atom/.test(message)
}

/**
 * Turns an updater error into something a user can act on. electron-updater
 * surfaces raw HTTP objects with every response header, which is unreadable in a
 * settings pane; the cases below are the ones that actually happen: no network
 * and a rejected feed. A missing GitHub release feed is classified separately
 * as no available update so the renderer can use its localized latest-version
 * message.
 */
export function describeUpdateError(message: string): string {
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message)) {
    return 'Tidak bisa menghubungi server pembaruan. Periksa koneksi internet.'
  }
  if (/\b401\b|\b403\b/.test(message)) {
    return 'Server pembaruan menolak permintaan ini.'
  }
  // Keep the first line only: the rest is a header dump.
  const firstLine = message.split('\n')[0].trim()
  return firstLine.length > 0 ? firstLine : message
}
