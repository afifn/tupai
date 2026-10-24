// P2-6: strict host key mode must refuse an unknown host, while the default
// TOFU mode records it. Uses github.com:22 because it is a public SSH server
// that is reachable from here; authentication is expected to fail afterwards.
import { app } from 'electron'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { openSshTunnel } from '../../src/main/connection/sshTunnel'
import { checkHostKey, storedFingerprint } from '../../src/main/connection/knownHosts'
import type { SshOptions } from '../../src/shared/types'

const results: { name: string; ok: boolean; detail?: string }[] = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`)
}

function codeOf(err: unknown): string {
  return (err as { code?: string })?.code ?? 'none'
}

async function attempt(ssh: SshOptions): Promise<string> {
  try {
    const tunnel = await openSshTunnel(ssh, 'mysql')
    await tunnel.close()
    return 'connected'
  } catch (err) {
    return codeOf(err)
  }
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'tupai-p2-ssh-'))
  app.setPath('userData', dir)
  process.env.TUPAI_USER_DATA = dir

  // ---------- strict mode refuses an unknown host ----------
  const strict: SshOptions = {
    enabled: true,
    host: 'github.com',
    port: 22,
    user: 'git',
    authType: 'password',
    password: 'not-a-real-password',
    strictHostKey: true
  }
  const strictResult = await attempt(strict)
  check(
    'strict mode refuses an unknown host',
    strictResult === 'SSH_HOST_KEY',
    strictResult
  )
  const afterStrict = await storedFingerprint('github.com', 22)
  check('strict mode records nothing', afterStrict === null, String(afterStrict))

  // ---------- default TOFU records it, then authentication fails ----------
  const tofu: SshOptions = { ...strict, strictHostKey: false }
  const tofuResult = await attempt(tofu)
  check(
    'tofu mode accepts the host and fails at authentication',
    tofuResult === 'none',
    tofuResult
  )
  const stored = await storedFingerprint('github.com', 22)
  check(
    'tofu records the fingerprint',
    typeof stored === 'string' && stored.startsWith('SHA256:'),
    stored ?? 'null'
  )

  // ---------- strict mode now accepts the known host ----------
  const strictAgain = await attempt(strict)
  check(
    'strict mode accepts the recorded host',
    strictAgain === 'none',
    strictAgain
  )

  // ---------- a tampered fingerprint is still rejected in strict mode ----------
  const storePath = join(dir, 'known-ssh-hosts.json')
  const store = JSON.parse(await readFile(storePath, 'utf-8')) as Record<
    string,
    { fingerprint: string }
  >
  store['github.com:22'].fingerprint = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const { writeJsonAtomic } = await import('../../src/main/storage/atomicWrite')
  await writeJsonAtomic(storePath, store)
  const tampered = await attempt(strict)
  check('strict mode blocks a changed fingerprint', tampered === 'SSH_HOST_CHANGED', tampered)

  // ---------- checkHostKey reports strict-new distinctly ----------
  const fresh = await checkHostKey('strict-new.example.com', 22, 'SHA256:new', true)
  check('unknown host in strict mode is reported as changed', fresh.status === 'changed')
  const freshTofu = await checkHostKey('tofu-new.example.com', 22, 'SHA256:new', false)
  check('unknown host in tofu mode is reported as new', freshTofu.status === 'new')

  await rm(dir, { recursive: true, force: true })
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) for (const f of failed) console.log(` - ${f.name}${f.detail ? ` | ${f.detail}` : ''}`)
  app.exit(failed.length === 0 ? 0 : 1)
}

app.whenReady().then(() => {
  main().catch((err) => {
    console.error('SMOKE ERROR', err)
    app.exit(1)
  })
})
