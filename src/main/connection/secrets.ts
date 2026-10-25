import { safeStorage } from 'electron'

/**
 * Wrapper around Electron's safeStorage.
 *
 * Electron 45 deprecated the synchronous `isEncryptionAvailable`,
 * `encryptString`, and `decryptString`, and 46 removes them together with
 * Chromium's synchronous OSCrypt backend. The async replacements use the same
 * per-platform key store, so a value encrypted by an older build still decrypts
 * here; only the call shape changes.
 *
 * Every secret in the app goes through this module so the migration is one file
 * instead of four call sites, and so the "encryption unavailable" message stays
 * identical for connection passwords and the AI key.
 */

export class SecretStorageUnavailableError extends Error {
  constructor(subject: string) {
    super(
      `${subject} tidak bisa disimpan karena penyimpanan aman OS tidak tersedia. ` +
        'Di Linux pastikan keyring (gnome-keyring/kwallet) berjalan.'
    )
    this.name = 'SecretStorageUnavailableError'
  }
}

/** True when the OS can encrypt secrets right now. */
export async function canStoreSecrets(): Promise<boolean> {
  try {
    return await safeStorage.isAsyncEncryptionAvailable()
  } catch {
    // A backend that throws is as unusable as one that reports false.
    return false
  }
}

/**
 * Encrypts a secret to base64 for the JSON stores. An empty secret is not an
 * error: callers use it to mean "no secret", so it stays an empty string.
 */
export async function encryptSecret(secret: string, subject: string): Promise<string> {
  if (!secret) return ''
  if (!(await canStoreSecrets())) throw new SecretStorageUnavailableError(subject)
  try {
    const encrypted = await safeStorage.encryptStringAsync(secret)
    return encrypted.toString('base64')
  } catch (err) {
    throw new Error(
      `${subject} tidak bisa dienkripsi: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Decrypts a base64 value written by this app or by an older build. A value that
 * cannot be decrypted yields an empty string: a rotated OS key or a copied
 * profile must not crash the connection list.
 */
export async function decryptSecret(cipher: string | undefined): Promise<string> {
  if (!cipher) return ''
  try {
    const { result } = await safeStorage.decryptStringAsync(Buffer.from(cipher, 'base64'))
    return result
  } catch {
    return ''
  }
}
