/**
 * Rules for carrying an existing profile over from the old product folder.
 *
 * The app was called "DB Manager" and Electron derives the profile folder from
 * the package name, so data lived in `db-manager`. The product is now "Tupai",
 * whose profile folder is `Tupai`. An upgrade that starts on the new path with an
 * empty connection list looks exactly like data loss, so the old profile is
 * carried across on first launch.
 */

/** Files that hold what the user would notice losing. */
export const CORE_PROFILE_FILES = [
  'connections.json',
  'connection-groups.json',
  'settings.json',
  'sync-profiles.json',
  'ai-settings.json',
  'ai-key.json'
]

/** Directories that hold user data rather than Chromium cache. */
export const CORE_PROFILE_DIRS = ['queries', 'history', 'Logs']

/**
 * Chromium's key store. Passwords and the AI key are encrypted against the key
 * inside it, so it is handled apart from the ordinary files: the key is merged
 * into the new store, never copied over a profile that already holds secrets.
 */
export const KEY_STORE_FILE = 'Local State'

/** Secrets that are unreadable unless the matching key comes across. */
export const ENCRYPTED_PROFILE_FILES = ['connections.json', 'ai-key.json']

export type ProfileMigrationAction =
  /** Copy the whole legacy folder; the new folder has nothing worth keeping. */
  | 'copy-all'
  /** Copy only the user-data entries, leaving the new folder's Chromium state. */
  | 'copy-core'
  /** Nothing to do: no legacy profile, or nothing in it worth carrying. */
  | 'skip'

export interface ProfileMigrationInput {
  legacyExists: boolean
  /** Whether the legacy folder holds any user data at all. */
  legacyHasData: boolean
  targetExists: boolean
  /** Names present in the new folder. Empty, or only Chromium cache, counts as unused. */
  targetEntries: string[]
}

/**
 * Decides what a migration should do.
 *
 * The case that used to be skipped silently: the new version ran once, wrote its
 * own settings, and created Chromium cache. The folder was no longer empty, so a
 * rename was refused and the connections never arrived.
 *
 * Nothing is ever overwritten with something older. Existing files in the new
 * folder win, except `settings.json` while it still holds nothing but defaults,
 * and the legacy folder is left in place so the copy can be repeated.
 */
export function planProfileMigration(
  input: ProfileMigrationInput
): ProfileMigrationAction {
  if (!input.legacyExists) return 'skip'
  if (!input.legacyHasData) return 'skip'
  if (!input.targetExists) return 'copy-all'

  const unused = input.targetEntries.every((name) => !isUserDataEntry(name))
  return unused ? 'copy-all' : 'copy-core'
}

/**
 * True for a name that holds something the user created.
 *
 * Chromium's caches (Cache, Code Cache, GPUCache, Network, ...) are disposable and
 * carry nothing of value, so a folder with only those has effectively never been
 * used. Kept as a deny-list because the cache names differ between Chromium
 * versions and new ones keep appearing.
 */
export function isUserDataEntry(name: string): boolean {
  const lowered = name.toLowerCase()
  if (CORE_PROFILE_FILES.some((file) => file.toLowerCase() === lowered)) return true
  if (CORE_PROFILE_DIRS.some((dir) => dir.toLowerCase() === lowered)) return true
  // Anything that is not a known Chromium cache directory counts as data: being
  // wrong here only means copying less, never destroying something.
  return !CHROMIUM_CACHE_NAMES.has(lowered)
}

const CHROMIUM_CACHE_NAMES = new Set([
  'blob_storage',
  'cache',
  'code cache',
  'dawncache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'gpucache',
  'gpupersistentcache',
  'grshadercache',
  'shadercache',
  'local storage',
  'network',
  'session storage',
  'service worker',
  'shared dictionary',
  'shared_proto_db',
  'webstorage',
  'preferences',
  'dips',
  'local state',
  'declarative_performance_observer.db',
  'declarative_performance_observer.db-journal'
])

export type KeyStoreAction =
  /** Take the legacy key into the new key store; encrypted files stay readable. */
  | 'adopt-legacy'
  /** The new profile has secrets already; its key stays and those files cannot move. */
  | 'keep-target'

export interface KeyStoreInput {
  /** The new profile already holds a secret encrypted with its own key. */
  targetHasSecrets: boolean
  /** The old profile has a key store to take the key from. */
  legacyHasKeyStore: boolean
}

/**
 * Decides which key store the merged profile uses.
 *
 * A secret is encrypted against a key that Chromium keeps in the profile's own
 * `Local State`. Measured on Windows: a value written in one profile cannot be
 * read in another, and copying just the ciphertext produces an unreadable secret.
 * So the key has to travel with it.
 *
 * Taking the legacy key is safe only while the new profile has no secrets of its
 * own, which is the situation right after an upgrade: nothing there needs the old
 * key. Once the new profile holds its own secrets, its key stays and the legacy
 * encrypted files are skipped rather than copied in an unreadable state.
 */
export function planKeyStore(input: KeyStoreInput): KeyStoreAction {
  if (!input.legacyHasKeyStore) return 'keep-target'
  return input.targetHasSecrets ? 'keep-target' : 'adopt-legacy'
}

/**
 * Whether a settings file still holds nothing but defaults.
 *
 * The new version writes its defaults on first run, so the file exists while
 * saying nothing about the user's choices. `mergeLegacySettings` uses this to know
 * which values are free to replace.
 */
export function isDefaultSettings(merged: unknown, defaults: unknown): boolean {
  return JSON.stringify(merged) === JSON.stringify(defaults)
}

/** True when the report describes work that actually happened. */
export function ranMigration(report: ProfileMigrationReport | null): boolean {
  return report !== null && report.action !== 'skip'
}

/**
 * Merges the old profile's settings into the new one without losing a choice the
 * user already made there.
 *
 * The new version writes a settings file on first run, so the file exists and
 * looks authoritative while most of it is still defaults. Wholesale replacement
 * would throw away a theme or font picked in the new build; wholesale skipping
 * would throw away the Oracle client folder, which the user cannot guess. So each
 * value is taken from the old profile only while the new one still holds the
 * default, compared through `defaults` so a missing key counts as default too.
 */
export function mergeLegacySettings<T>(target: T, legacy: T, defaults: T): T {
  if (isPlainObject(target) && isPlainObject(legacy) && isPlainObject(defaults)) {
    const keys = new Set([
      ...Object.keys(defaults),
      ...Object.keys(target),
      ...Object.keys(legacy)
    ])
    const merged: Record<string, unknown> = {}
    for (const key of keys) {
      merged[key] = mergeLegacySettings(
        (target as Record<string, unknown>)[key],
        (legacy as Record<string, unknown>)[key],
        (defaults as Record<string, unknown>)[key]
      )
    }
    return merged as T
  }
  // A key the new profile does not have at all counts as default: the file was
  // written by an older build that did not know about it yet.
  if (target === undefined) return legacy
  return sameJson(target, defaults) ? legacy : target
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * What the migration did, so the window can tell the user instead of leaving them
 * to wonder why their connection list changed.
 */
export interface ProfileMigrationReport {
  action: ProfileMigrationAction
  /** Folder the data came from, shown in the message. */
  legacyDir: string
  /** Names that were copied into the new profile. */
  copied: string[]
  /**
   * Names left behind because they are encrypted with a key the new profile does
   * not have. The user has to retype those passwords once.
   */
  needsAttention: string[]
}
