import { readFile } from 'fs/promises'
import type { Client, ClientChannel } from 'ssh2'
import type { DbEngine, SshOptions } from '@shared/types'
import { DbError } from '../drivers/types'
import { checkHostKey, sshFingerprint } from './knownHosts'

export interface SshTunnel {
  // Opens a TCP stream to the database through the SSH server.
  forward(targetHost: string, targetPort: number): Promise<ClientChannel>
  close(): Promise<void>
}

// Establishes one SSH connection per database connection and forwards each DB
// socket through it. The database host/port stay the ones the user configured;
// only the transport changes.
export async function openSshTunnel(
  ssh: SshOptions,
  engine: DbEngine = 'mysql'
): Promise<SshTunnel> {
  const { Client: SshClient } = await import('ssh2')
  const client: Client = new SshClient()
  const port = ssh.port ?? 22

  // Filled in by hostVerifier so the failure below can name the fingerprints.
  // A holder object keeps TypeScript from narrowing these to null: the
  // assignments happen inside a callback that the compiler cannot order.
  const seen: {
    fingerprint: string | null
    hostKeyError: string | null
    verified: boolean
  } = { fingerprint: null, hostKeyError: null, verified: false }

  const connectConfig: Parameters<Client['connect']>[0] = {
    host: ssh.host,
    port,
    username: ssh.user,
    readyTimeout: 15000,
    // ssh2 supports an async decision through the `verify` callback. The key is
    // checked before authentication, so a database password is never sent to a
    // host whose key does not match the recorded one.
    hostVerifier: (key: Buffer, verify: (valid: boolean) => void): void => {
      const fingerprint = sshFingerprint(key)
      seen.fingerprint = fingerprint
      void checkHostKey(ssh.host, port, fingerprint, ssh.strictHostKey === true)
        .then((result) => {
          if (result.status === 'changed') {
            seen.hostKeyError = result.previous
              ? `Host key ${ssh.host}:${port} berubah. Sidik jari sekarang ` +
                `${fingerprint}, sebelumnya ${result.previous}. ` +
                'Koneksi dihentikan untuk mencegah penyadapan.'
              : `Host ${ssh.host}:${port} belum dikenal dan mode verifikasi ketat aktif. ` +
                `Sidik jarinya ${fingerprint}. Tambahkan host ini ke ` +
                '~/.ssh/known_hosts atau nonaktifkan mode ketat untuk mempercayainya.'
            verify(false)
            return
          }
          seen.verified = true
          verify(true)
        })
        .catch((err) => {
          // A store failure must not silently downgrade verification.
          seen.hostKeyError = `Gagal memeriksa host key: ${
            err instanceof Error ? err.message : String(err)
          }`
          verify(false)
        })
    }
  }

  if (ssh.authType === 'privateKey') {
    if (!ssh.privateKeyPath) {
      throw new DbError(
        'SSH_CONFIG',
        'SSH private key path wajib diisi untuk autentikasi key.',
        engine
      )
    }
    connectConfig.privateKey = await readFile(ssh.privateKeyPath)
    if (ssh.passphrase) connectConfig.passphrase = ssh.passphrase
  } else {
    connectConfig.password = ssh.password ?? ''
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        client.removeListener('ready', onReady)
        reject(err)
      }
      const onReady = (): void => {
        client.removeListener('error', onError)
        resolve()
      }
      client.once('ready', onReady)
      client.once('error', onError)
      client.connect(connectConfig)
    })
  } catch (err) {
    if (seen.hostKeyError) {
      const changed = seen.hostKeyError.includes('berubah')
      throw new DbError(
        changed ? 'SSH_HOST_CHANGED' : 'SSH_HOST_KEY',
        seen.hostKeyError,
        engine
      )
    }
    // Only a rejected key is a host-key problem. When verification passed, the
    // failure is something else (usually authentication) and must keep its own
    // message: labelling a wrong password as a host key error would send the
    // user chasing the wrong fix.
    if (!seen.verified && seen.fingerprint) {
      throw new DbError(
        'SSH_HOST_KEY',
        `Host key ${ssh.host}:${port} tidak diterima (${seen.fingerprint}). ${
          err instanceof Error ? err.message : String(err)
        }`,
        engine
      )
    }
    throw err
  }

  return {
    forward(targetHost: string, targetPort: number): Promise<ClientChannel> {
      return new Promise<ClientChannel>((resolve, reject) => {
        client.forwardOut(
          '127.0.0.1',
          0,
          targetHost,
          targetPort,
          (err, stream) => {
            if (err) reject(err)
            else resolve(stream)
          }
        )
      })
    },
    async close(): Promise<void> {
      client.end()
    }
  }
}

export function sshEnabled(ssh: SshOptions | undefined): boolean {
  return Boolean(ssh?.enabled && ssh.host && ssh.user)
}
