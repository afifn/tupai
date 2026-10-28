import { Worker } from 'worker_threads'
import { sep } from 'path'
import { fileURLToPath } from 'url'
import type { DbErrorShape, IpcResult } from '@shared/types'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

// Metadata calls should answer quickly. Statement execution and batch writes
// get a larger budget because a legitimate migration or export can take
// minutes; the driver's own statement timeout still applies on top of this.
const DEFAULT_TIMEOUT_MS = 30_000
const LONG_OPERATIONS = new Set([
  'runQuery',
  'explainQuery',
  'fetchBatch',
  'insertRows',
  'applyRowChanges',
  'getTableStructure',
  'getTableDdl',
  'getRoutineDefinition',
  'listRoutines',
  'searchObjects'
])
const LONG_TIMEOUT_MS = 10 * 60_000

export class DbWorkerClient {
  private worker: Worker
  private seq = 0
  private pending = new Map<number, Pending>()
  private dead = false
  // Why the worker stopped. Kept so a later call reports the real cause instead
  // of a generic "already stopped" line that hides an ABI mismatch or a crash.
  private deadReason: DbErrorShape | null = null
  // The operation in flight when the worker died, and how long it had been
  // running. A crash report without this is untraceable: the exit code alone
  // does not say which statement took the thread down.
  private inFlight: { op: string; startedAt: number } | null = null
  // The operation that was running when the 'error' event fired. Kept separately
  // because rejecting the pending calls clears `inFlight` before 'exit' runs.
  private crashLastOp: string | null = null
  // Called whenever the worker dies, with the reason and the last operation.
  // Adapters only exist inside the worker, so their loss has to reach the
  // renderer; otherwise the UI keeps showing a connection that cannot be used
  // and every later call fails with a misleading "not connected".
  private onWorkerLost: ((reason: DbErrorShape, lastOp: string | null) => void) | null =
    null
  // Resolves when the worker is online. A message posted before that is dropped
  // by Node, which used to leave the caller waiting for the timeout.
  private ready: Promise<void> = Promise.resolve()

  constructor() {
    this.worker = this.spawn()
  }

  private spawn(): Worker {
    const workerPath = workerFile()
    let markReady: () => void = () => undefined
    this.ready = new Promise<void>((resolve) => {
      markReady = resolve
    })
    // The worker cannot import electron, so the paths it needs are passed
    // explicitly. Without TUPAI_USER_DATA the SSH host key store cannot be
    // resolved and every SSH tunnel would fail.
    const worker = new Worker(workerPath, {
      env: { ...process.env, TUPAI_USER_DATA: process.env.TUPAI_USER_DATA ?? '' }
    })
    worker.on(
      'message',
      (res: {
        id: number
        ok: boolean
        fatal?: boolean
        data?: unknown
        error?: DbErrorShape
      }) => {
        // The worker reports its own uncaught error before exiting. Without this
        // the parent only saw exit code 1, and a crash inside a native module
        // left an empty message in the log.
        if (res.fatal && res.error) {
          this.crashLastOp = this.describeInFlight()
          this.deadReason = res.error
          // The thread is exiting; refuse new calls instead of posting into it.
          this.dead = true
          this.failAll(res.error.message, res.error.code)
          return
        }
        const p = this.pending.get(res.id)
        if (!p) return
        this.pending.delete(res.id)
        if (p.timer) clearTimeout(p.timer)
        if (res.ok) p.resolve(res.data)
        else p.reject(res.error)
      }
    )
    worker.on('online', markReady)
    worker.on('error', (err) => {
      markReady()
      // Node reports a crash inside a native module with an empty message, so the
      // name and stack are what actually identify it. Without them the log only
      // says "worker died", which is not enough to fix anything.
      const detail = [err?.name, err?.message, err?.stack]
        .filter((part) => typeof part === 'string' && part.trim().length > 0)
        .join(': ')
      this.deadReason = describeWorkerFailure(detail || 'worker crashed')
      // The 'error' event rejects the pending calls, whose `.finally` clears
      // `inFlight`; the exit handler would then report no operation at all. Keep
      // it here so the crash report names what was running.
      this.crashLastOp = this.describeInFlight()
      this.failAll(this.deadReason.message, this.deadReason.code)
    })
    // Without this handler a crashed worker (OOM, native module segfault) left
    // every pending promise unresolved forever: the UI showed a spinner that
    // never stopped and no error ever appeared.
    worker.on('exit', (code) => {
      markReady()
      this.dead = true
      // A clean exit after terminate() is expected and already reported.
      if (!this.deadReason) {
        this.deadReason = {
          code: 'WORKER_EXIT',
          message: `exit ${code}`,
          engine: 'sqlite'
        }
      }
      // Prefer the operation recorded by the 'error' handler: rejecting the
      // pending calls already cleared `inFlight`.
      const lastOp = this.crashLastOp ?? this.describeInFlight()
      this.crashLastOp = null
      this.inFlight = null
      this.failAll(this.deadReason.message, this.deadReason.code)
      // Tell the main process that every adapter died with the thread.
      this.onWorkerLost?.(this.deadReason, lastOp)
    })
    return worker
  }

  /** Registers the crash reporter. Only one consumer exists: the IPC layer. */
  setWorkerLostHandler(
    handler: (reason: DbErrorShape, lastOp: string | null) => void
  ): void {
    this.onWorkerLost = handler
  }

  // The operation that was running when the worker died, formatted for the log.
  private describeInFlight(): string | null {
    if (!this.inFlight) return null
    const seconds = Math.round((Date.now() - this.inFlight.startedAt) / 1000)
    return `${this.inFlight.op} (${seconds}s)`
  }

  // A stopped worker is recoverable: the adapters only live in the worker, so
  // the renderer reconnects anyway. Respawning here means the user does not
  // have to restart the whole app to get a working connection back.
  private revive(): boolean {
    if (!this.dead) return true
    this.dead = false
    this.deadReason = null
    this.worker = this.spawn()
    return true
  }

  private failAll(message: string, code: string): void {
    const error: DbErrorShape = { code, message, engine: 'sqlite' }
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
  }

  async call<T>(op: string, payload: unknown): Promise<T> {
    if (this.dead) {
      // Try one restart. A worker that dies on startup (broken native module)
      // will report the same cause again instead of silently looping.
      this.revive()
    }
    await this.ready
    if (this.dead) {
      // The fresh worker died before it could take the call; report why instead
      // of posting into a dead thread and timing out.
      throw this.deadReason ?? { code: 'WORKER_EXIT', message: 'exit', engine: 'sqlite' }
    }
    const id = ++this.seq
    const timeout = LONG_OPERATIONS.has(op) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
    this.inFlight = { op, startedAt: Date.now() }
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        resolve: resolve as (v: unknown) => void,
        reject
      }
      entry.timer = setTimeout(() => {
        // The driver call cannot be cancelled from here, so the entry is
        // removed and the caller gets an error instead of waiting forever.
        this.pending.delete(id)
        if (this.inFlight?.op === op) this.inFlight = null
        reject({
          code: 'TIMEOUT',
          message: `Operasi ${op} melebihi ${Math.round(timeout / 1000)} detik.`,
          engine: 'sqlite'
        } satisfies DbErrorShape)
      }, timeout)
      this.pending.set(id, entry)
      this.worker.postMessage({ id, op, payload })
    }).finally(() => {
      // The call settled (result, driver error, or timeout): nothing is in flight.
      if (this.inFlight?.op === op) this.inFlight = null
    })
  }

  async terminate(): Promise<void> {
    this.dead = true
    this.deadReason = { code: 'WORKER_EXIT', message: 'app closed', engine: 'sqlite' }
    this.failAll('app closed', 'WORKER_EXIT')
    await this.worker.terminate()
  }
}

// In a packaged build the main script lives inside app.asar, but a worker thread
// starts outside Electron's patched fs and cannot open a file from the archive.
// electron-builder unpacks out/main for this reason, so the same relative path
// is resolved against the unpacked copy instead.
function workerFile(): string {
  const path = fileURLToPath(new URL('./db.worker.js', import.meta.url))
  const marker = `${sep}app.asar${sep}`
  if (!path.includes(marker)) return path
  return path.replace(marker, `${sep}app.asar.unpacked${sep}`)
}

// A native module built for the host Node instead of Electron fails with a
// NODE_MODULE_VERSION mismatch. That is not a database problem, so it gets its
// own code and the renderer can tell the user how to fix it.
function describeWorkerFailure(message: string): DbErrorShape {
  if (
    /NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(message)
  ) {
    return { code: 'NATIVE_ABI', message, engine: 'sqlite' }
  }
  if (/Cannot find module/i.test(message)) {
    return { code: 'NATIVE_MISSING', message, engine: 'sqlite' }
  }
  return { code: 'WORKER_ERROR', message, engine: 'sqlite' }
}

export function toIpcResult<T>(err: unknown): IpcResult<T> {
  if (err && typeof err === 'object' && 'code' in err && 'engine' in err) {
    return { ok: false, error: err as DbErrorShape }
  }
  return {
    ok: false,
    error: {
      code: 'INTERNAL',
      message: err instanceof Error ? err.message : String(err),
      engine: 'sqlite'
    }
  }
}
