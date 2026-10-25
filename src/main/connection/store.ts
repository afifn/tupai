import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { writeJsonAtomic } from '../storage/atomicWrite'
import type { ConnectionConfig, StoredConnection } from '@shared/types'
import { decryptSecret, encryptSecret } from './secrets'

interface StoredRecord extends Omit<ConnectionConfig, 'password' | 'ssh'> {
  passwordCipher?: string
  // SSH secrets are encrypted the same way as the database password so a
  // bastion password or key passphrase never sits in plain text.
  ssh?: Omit<NonNullable<ConnectionConfig['ssh']>, 'password' | 'passphrase'> & {
    passwordCipher?: string
    passphraseCipher?: string
  }
}

function storePath(): string {
  return join(app.getPath('userData'), 'connections.json')
}

async function readAll(): Promise<StoredRecord[]> {
  try {
    const raw = await readFile(storePath(), 'utf-8')
    return JSON.parse(raw) as StoredRecord[]
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function writeAll(records: StoredRecord[]): Promise<void> {
  // Atomic: a crash mid-write must never leave connections.json empty.
  await writeJsonAtomic(storePath(), records, { backup: true })
}

// Storing an empty string when encryption is unavailable used to look like a
// saved password that silently failed to decrypt, so the user only saw "access
// denied" later. encryptSecret fails at save time with a message naming the
// cause instead.
const SUBJECT_PASSWORD = 'Kata sandi'
const SUBJECT_SSH_PASSWORD = 'Kata sandi SSH'
const SUBJECT_SSH_PASSPHRASE = 'Passphrase SSH'

export async function listConnections(): Promise<StoredConnection[]> {
  const records = await readAll()
  return records.map(({ passwordCipher, ssh, ...rest }) => ({
    ...rest,
    // Never expose SSH secrets to the renderer; only whether they are set.
    ssh: ssh
      ? {
          enabled: ssh.enabled,
          host: ssh.host,
          port: ssh.port,
          user: ssh.user,
          authType: ssh.authType,
          privateKeyPath: ssh.privateKeyPath,
          strictHostKey: ssh.strictHostKey,
          password: undefined,
          passphrase: undefined
        }
      : undefined,
    hasPassword: Boolean(passwordCipher),
    hasSshPassword: Boolean(ssh?.passwordCipher),
    hasSshPassphrase: Boolean(ssh?.passphraseCipher)
  }))
}

export async function getConnectionConfig(id: string): Promise<ConnectionConfig | null> {
  const records = await readAll()
  const record = records.find((r) => r.id === id)
  if (!record) return null
  const { passwordCipher, ssh, ...rest } = record
  const sshConfig = ssh
    ? {
        enabled: ssh.enabled,
        host: ssh.host,
        port: ssh.port,
        user: ssh.user,
        authType: ssh.authType,
        privateKeyPath: ssh.privateKeyPath,
        strictHostKey: ssh.strictHostKey,
        password: await decryptSecret(ssh.passwordCipher),
        passphrase: await decryptSecret(ssh.passphraseCipher)
      }
    : undefined
  return { ...rest, ssh: sshConfig, password: await decryptSecret(passwordCipher) }
}

export async function saveConnection(cfg: ConnectionConfig): Promise<StoredConnection> {
  const records = await readAll()
  const { password, ssh, ...rest } = cfg
  const previous = records.find((r) => r.id === cfg.id)

  const next: StoredRecord = { ...rest }
  if (password) next.passwordCipher = await encryptSecret(password, SUBJECT_PASSWORD)
  else if (previous?.passwordCipher) next.passwordCipher = previous.passwordCipher

  if (ssh) {
    const previousSsh = previous?.ssh
    next.ssh = {
      enabled: ssh.enabled,
      host: ssh.host,
      port: ssh.port,
      user: ssh.user,
      authType: ssh.authType,
      privateKeyPath: ssh.privateKeyPath,
      strictHostKey: ssh.strictHostKey,
      // Keep the stored secret when the form left the field blank.
      passwordCipher: ssh.password
        ? await encryptSecret(ssh.password, SUBJECT_SSH_PASSWORD)
        : previousSsh?.passwordCipher,
      passphraseCipher: ssh.passphrase
        ? await encryptSecret(ssh.passphrase, SUBJECT_SSH_PASSPHRASE)
        : previousSsh?.passphraseCipher
    }
  }

  const index = records.findIndex((r) => r.id === cfg.id)
  if (index >= 0) records[index] = next
  else records.push(next)
  await writeAll(records)
  const { passwordCipher, ssh: storedSsh, ...stored } = next
  return {
    ...stored,
    ssh: storedSsh
      ? {
          enabled: storedSsh.enabled,
          host: storedSsh.host,
          port: storedSsh.port,
          user: storedSsh.user,
          authType: storedSsh.authType,
          privateKeyPath: storedSsh.privateKeyPath,
          strictHostKey: storedSsh.strictHostKey
        }
      : undefined,
    hasPassword: Boolean(passwordCipher),
    hasSshPassword: Boolean(storedSsh?.passwordCipher),
    hasSshPassphrase: Boolean(storedSsh?.passphraseCipher)
  }
}

export async function deleteConnection(id: string): Promise<void> {
  const records = await readAll()
  await writeAll(records.filter((r) => r.id !== id))
}

// Moves a connection into a group (or out of any group when groupId is empty).
// A dedicated function keeps this cheap: the renderer never holds the password,
// so it cannot round-trip the full config through saveConnection.
export async function setConnectionGroup(
  connectionId: string,
  groupId: string | null
): Promise<void> {
  const records = await readAll()
  const index = records.findIndex((r) => r.id === connectionId)
  if (index < 0) throw new Error(`Connection not found: ${connectionId}`)
  const next = { ...records[index] }
  if (groupId) next.groupId = groupId
  else delete next.groupId
  records[index] = next
  await writeAll(records)
}
