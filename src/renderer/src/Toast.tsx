import { useCallback, useEffect, useRef, useState } from 'react'
import { IconAlert, IconCheck, IconClose, IconInfo } from './Icons'
import { useLocale } from './i18n'

export type ToastKind = 'error' | 'ok' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastInput {
  kind: ToastKind
  title: string
  body?: string
  // Detail from the driver, shown small and selectable so it can be copied.
  detail?: string
  action?: ToastAction
  // Milliseconds before auto-dismiss. Errors stay until dismissed.
  timeoutMs?: number
}

interface ToastRecord extends ToastInput {
  id: number
}

let seq = 0

// One tray in the corner. Errors are sticky because a connection failure
// usually needs a follow-up action, and a message that disappears while the user
// reads it is worse than no message.
//
// Hovering a row pauses its timer, the way desktop notification trays behave: a
// message the user is reading must not vanish under the pointer.
export function useToasts(): {
  toasts: ToastRecord[]
  push: (input: ToastInput) => number
  dismiss: (id: number) => void
  pause: (id: number) => void
  resume: (id: number) => void
} {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  // Milliseconds left when a timer was paused, and when it last started. Both
  // are keyed by toast id so each row keeps its own countdown.
  const remaining = useRef(new Map<number, number>())
  const startedAt = useRef(new Map<number, number>())

  const stopTimer = useCallback((id: number): void => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const dismiss = useCallback(
    (id: number): void => {
      stopTimer(id)
      remaining.current.delete(id)
      startedAt.current.delete(id)
      setToasts((prev) => prev.filter((t) => t.id !== id))
    },
    [stopTimer]
  )

  const startTimer = useCallback(
    (id: number, ms: number): void => {
      startedAt.current.set(id, Date.now())
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ms)
      )
    },
    [dismiss]
  )

  const push = useCallback(
    (input: ToastInput): number => {
      seq += 1
      const id = seq
      setToasts((prev) => [...prev.slice(-3), { ...input, id }])
      const timeout = input.timeoutMs ?? (input.kind === 'error' ? 0 : 4000)
      if (timeout > 0) {
        remaining.current.set(id, timeout)
        startTimer(id, timeout)
      }
      return id
    },
    [startTimer]
  )

  const pause = useCallback(
    (id: number): void => {
      const left = remaining.current.get(id)
      if (left === undefined) return
      const started = startedAt.current.get(id) ?? Date.now()
      stopTimer(id)
      // A short floor stops a timer that was about to fire from expiring the
      // moment the pointer leaves.
      remaining.current.set(id, Math.max(600, left - (Date.now() - started)))
    },
    [stopTimer]
  )

  const resume = useCallback(
    (id: number): void => {
      const left = remaining.current.get(id)
      if (left === undefined) return
      startTimer(id, left)
    },
    [startTimer]
  )

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  return { toasts, push, dismiss, pause, resume }
}

interface Props {
  toasts: ToastRecord[]
  onDismiss: (id: number) => void
  onPause: (id: number) => void
  onResume: (id: number) => void
}

function ToastIcon({ kind }: { kind: ToastKind }): JSX.Element {
  if (kind === 'error') return <IconAlert size={14} />
  if (kind === 'ok') return <IconCheck size={14} />
  return <IconInfo size={14} />
}

export function ToastStack({
  toasts,
  onDismiss,
  onPause,
  onResume
}: Props): JSX.Element | null {
  const { tr } = useLocale()
  if (toasts.length === 0) return null
  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions">
      {/* One tray with hairline dividers, the way desktop notification centres
          stack rows. Separate floating cards read as web toasts. */}
      <div className="toast-stack">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast--${toast.kind}`}
            role={toast.kind === 'error' ? 'alert' : 'status'}
            onMouseEnter={() => onPause(toast.id)}
            onMouseLeave={() => onResume(toast.id)}
          >
            <span className="toast__icon">
              <ToastIcon kind={toast.kind} />
            </span>
            <div className="toast__body">
              <p className="toast__title">{toast.title}</p>
              {toast.body && <p className="toast__text">{toast.body}</p>}
              {toast.detail && (
                <p className="toast__detail" title={toast.detail}>
                  {toast.detail}
                </p>
              )}
              {toast.action && (
                <button
                  className="btn btn--tiny btn--ghost toast__action"
                  onClick={() => {
                    toast.action?.onClick()
                    onDismiss(toast.id)
                  }}
                >
                  {toast.action.label}
                </button>
              )}
            </div>
            <button
              className="toast__close"
              onClick={() => onDismiss(toast.id)}
              aria-label={tr('toast.close')}
              title={tr('common.close')}
            >
              <IconClose size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
