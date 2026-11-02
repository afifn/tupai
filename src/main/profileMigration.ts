import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, dirname, join } from 'path'
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/settings'
import {
  CORE_PROFILE_DIRS,
  CORE_PROFILE_FILES,
  ENCRYPTED_PROFILE_FILES,
  KEY_STORE_FILE,
  isUserDataEntry,
  mergeLegacySettings,
  planKeyStore,
  planProfileMigration,
  type ProfileMigrationReport
} from '@shared/profileMigration'

/**
 * Carries an existing "DB Manager" profile into the "Tupai" one.
 *
 * Copying, not renaming: the old folder stays in place as a fallback the user can
 * inspect if anything looks wrong, and a half-finished copy never removes their
 * data. A marker in the new profile stops the copy from running again, so a
 * connection the user deletes later does not come back on the next launch.
 *
 * Order matters. The encryption key is taken first, before anything reads or
 * writes a secret, because Chromium reads that key when it starts. A key adopted
 * after that point is not the one in use, so `prepareProfileMigration` runs at
 * module load, before `app.whenReady`, and `copyProfileFiles` runs straight after.
 */

const MARKER_FILE = 'profile-migration.json'

/** Report for the window to show once, cleared as soon as it is read. */
let pendingReport: ProfileMigrationReport | null = null

/**
 * Runs before `app.whenReady`.
 *
 * Adopts the old encryption key only while the new profile has no secrets of its
 * own, because replacing the key under an existing secret makes it unreadable. The
 * new profile keeps its own key store and only `os_crypt` is replaced: Chromium
 * keeps other state in the same file.
 *
 * Returns false when this is not a migration case, so the caller can skip the copy
 * step entirely.
 */
export function prepareProfileMigration(legacyDir: string, targetDir: string): boolean {
  if (isAlreadyMigrated(targetDir)) return false
  if (!existsSync(legacyDir) || !hasLegacyData(legacyDir)) return false
  if (planProfileMigration(planInput(legacyDir, targetDir)) === 'skip') return false

  const targetHasSecrets =
    fileHasCipher(join(targetDir, 'connections.json')) ||
    fileHasCipher(join(targetDir, 'ai-key.json'))
  const legacyHasKeyStore = existsSync(join(legacyDir, KEY_STORE_FILE))
  const keyStore = planKeyStore({ targetHasSecrets, legacyHasKeyStore })
  if (keyStore !== 'adopt-legacy') return true

  return adoptKeyStore(join(legacyDir, KEY_STORE_FILE), join(targetDir, KEY_STORE_FILE))
}

/**
 * Copies the user data, after the key decision is settled.
 *
 * Returns null when there was nothing to do. The old key store itself is never
 * copied: when it was adopted its key is already inside the new one, and when it
 * was not adopted copying the file over would make the secrets already in the new
 * profile unreadable.
 */
export function copyProfileFiles(
  legacyDir: string,
  targetDir: string
): ProfileMigrationReport | null {
  if (isAlreadyMigrated(targetDir)) return null

  const action = planProfileMigration(planInput(legacyDir, targetDir))
  if (action === 'skip') return null

  const keyAdopted = keyWasAdopted(legacyDir, targetDir)
  const copied: string[] = []
  const needsAttention: string[] = []

  try {
    if (action === 'copy-all') {
      copied.push(...copyTree(legacyDir, targetDir))
    } else {
      for (const name of [...CORE_PROFILE_FILES, ...CORE_PROFILE_DIRS]) {
        const source = join(legacyDir, name)
        if (!existsSync(source)) continue
        if (ENCRYPTED_PROFILE_FILES.includes(name) && !keyAdopted) {
          // Copying an unreadable secret would look like a saved password that
          // silently fails to decrypt later, so it stays behind and is reported.
          needsAttention.push(name)
          continue
        }
        if (name === 'settings.json') {
          copySettings(source, join(targetDir, name))
          copied.push(name)
          continue
        }
        // Never overwrite what the running version already wrote; the user may
        // have changed it there. An existing but empty store counts as unwritten:
        // a first launch can create it, and that would hide the old records.
        const destination = join(targetDir, name)
        if (existsSync(destination) && !isEmptyStore(destination)) continue
        copyTree(source, destination)
        copied.push(name)
      }
    }
  } catch {
    // The new profile still works; the user just has to reconnect. The marker is
    // not written, so the next launch retries.
    pendingReport = { action, legacyDir, copied, needsAttention }
    return pendingReport
  }

  writeMarker(targetDir)
  pendingReport = { action, legacyDir, copied, needsAttention }
  return pendingReport
}

/** The report from this launch, cleared so the notice appears only once. */
export function takeMigrationReport(): ProfileMigrationReport | null {
  const report = pendingReport
  pendingReport = null
  return report
}

/**
 * Merges the old key into the new profile's key store.
 *
 * Verified on Windows: after this, secrets from the old profile decrypt in the
 * same run and after a restart. Chromium reads the value at startup and rewrites
 * it unchanged on shutdown, so the adopted key stays.
 */
function adoptKeyStore(legacyFile: string, targetFile: string): boolean {
  try {
    const legacy = readJson(legacyFile) as { os_crypt?: Record<string, unknown> }
    if (!legacy?.os_crypt) return false
    const target = (existsSync(targetFile) ? readJson(targetFile) : {}) as Record<
      string,
      unknown
    > & { os_crypt?: Record<string, unknown> }
    mkdirSync(dirname(targetFile), { recursive: true })
    writeFileSync(
      targetFile,
      JSON.stringify({
        ...target,
        os_crypt: { ...(target.os_crypt ?? {}), ...legacy.os_crypt }
      })
    )
    return true
  } catch {
    // A locked or unreadable key store must not stop startup: the copy step then
    // leaves the encrypted files behind and the user reconnects.
    return false
  }
}

/**
 * Writes settings from the old profile, keeping every value already chosen in the
 * new one.
 *
 * A plain copy would overwrite a theme the user just picked. Skipping the file
 * would lose the Oracle client folder, which the user cannot guess. So the two are
 * merged per value against the defaults: a value still at its default is replaced,
 * anything the user changed stays.
 */
function copySettings(source: string, destination: string): void {
  const legacy = mergeSettings(readJson(source))
  const target = mergeSettings(
    existsSync(destination) ? readJson(destination) : undefined
  )
  const merged = mergeLegacySettings(target, legacy, DEFAULT_SETTINGS)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, JSON.stringify(merged, null, 2))
}

function planInput(
  legacyDir: string,
  targetDir: string
): {
  legacyExists: boolean
  legacyHasData: boolean
  targetExists: boolean
  targetEntries: string[]
} {
  const legacyExists = existsSync(legacyDir)
  const targetExists = existsSync(targetDir)
  return {
    legacyExists,
    legacyHasData: legacyExists && hasLegacyData(legacyDir),
    targetExists,
    targetEntries: targetExists ? safeReaddir(targetDir) : []
  }
}

/** True when the old profile holds at least one file the user would miss. */
function hasLegacyData(dir: string): boolean {
  return [...CORE_PROFILE_FILES, ...CORE_PROFILE_DIRS].some((name) =>
    existsSync(join(dir, name))
  )
}

/** True when a stored record already holds a secret encrypted with its own key. */
function fileHasCipher(file: string): boolean {
  if (!existsSync(file)) return false
  try {
    return holdsCipher(readJson(file))
  } catch {
    return false
  }
}

function holdsCipher(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsCipher)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    key.endsWith('Cipher') ? Boolean(entry) : holdsCipher(entry)
  )
}

/**
 * Whether an existing destination may be copied over without losing anything.
 *
 * A store the app created but never filled counts as unwritten: a first launch can
 * write `[]` or `{}` before the migration runs, and treating that as "the user
 * already has data" would hide every old record. A real directory counts as empty
 * only when it holds no files, so an existing `queries` or `history` folder is
 * never merged over.
 */
function isEmptyStore(target: string): boolean {
  try {
    if (statSync(target).isDirectory()) return safeReaddir(target).length === 0
    const parsed = readJson(target)
    if (Array.isArray(parsed)) return parsed.length === 0
    if (parsed && typeof parsed === 'object') return Object.keys(parsed).length === 0
    return false
  } catch {
    // Unreadable counts as empty: there is nothing there to preserve, and the copy
    // replaces a file the app could not parse anyway.
    return true
  }
}

/** Whether the running profile holds the key the old secrets were written with. */
function keyWasAdopted(legacyDir: string, targetDir: string): boolean {
  const key = (dir: string): string | undefined => {
    try {
      const state = readJson(join(dir, KEY_STORE_FILE)) as {
        os_crypt?: { encrypted_key?: string }
      }
      return state?.os_crypt?.encrypted_key
    } catch {
      return undefined
    }
  }
  const legacy = key(legacyDir)
  return Boolean(legacy) && legacy === key(targetDir)
}

/** A profile that already ran the migration is never touched again. */
function isAlreadyMigrated(targetDir: string): boolean {
  return existsSync(join(targetDir, MARKER_FILE))
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

/**
 * Copies a file or a directory tree, skipping everything Chromium owns.
 *
 * Caches are large, mean nothing outside the profile that wrote them, and copying
 * hundreds of megabytes would make the first launch after an upgrade feel stuck.
 * Skipping them for files as well as directories keeps the new profile's own
 * Chromium state intact; `Local State` falls into that group and so is never
 * copied by accident. User data (saved queries, query history, logs) is kept.
 *
 * Settings are merged rather than copied, so a theme the user already picked in
 * the new build survives even when the whole folder is being filled.
 */
function copyTree(from: string, to: string): string[] {
  if (!statSync(from).isDirectory()) {
    mkdirSync(dirname(to), { recursive: true })
    if (basename(to) === 'settings.json') {
      copySettings(from, to)
    } else {
      copyFileSync(from, to)
    }
    return []
  }

  mkdirSync(to, { recursive: true })
  const copied: string[] = []
  for (const name of safeReaddir(from)) {
    if (name === MARKER_FILE || !isUserDataEntry(name)) continue
    const inner = copyTree(join(from, name), join(to, name))
    copied.push(name, ...inner.map((entry) => join(name, entry)))
  }
  return copied
}

function writeMarker(targetDir: string): void {
  try {
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, MARKER_FILE),
      JSON.stringify({ version: 1, at: new Date().toISOString() })
    )
  } catch {
    // The copy already happened; losing the marker is not worth a failure.
  }
}
