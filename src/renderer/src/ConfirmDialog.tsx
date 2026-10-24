import { useEffect, useRef } from 'react'
import { useFocusTrap } from './useFocusTrap'
import { useLocale } from './i18n'

export interface ConfirmAction {
  label: string
  // Marks the primary action when it is not the destructive one (for example
  // "Save" in the unsaved-changes dialog).
  primary?: boolean
  danger?: boolean
}

interface Props {
  title: string
  message: string
  // Extra detail shown under the message, e.g. the object being deleted.
  detail?: string
  // Up to three actions. The first one receives initial focus when it is not
  // destructive, so pressing Enter repeats the safe choice.
  actions: ConfirmAction[]
  onSelect: (action: ConfirmAction) => void
  onClose: () => void
}

// In-app replacement for window.confirm. The native dialog cannot be styled,
// ignores the app theme, and on macOS blocks the whole window; this keeps the
// confirmation inside the app and gives keyboard users a predictable focus.
export function ConfirmDialog({
  title,
  message,
  detail,
  actions,
  onSelect,
  onClose
}: Props): JSX.Element {
  const { tr } = useLocale()
  const dialogRef = useRef<HTMLDivElement>(null)
  const initialRef = useRef<HTMLButtonElement>(null)

  useFocusTrap(dialogRef, true)

  useEffect(() => {
    // Prefer the safe action, so pressing Enter does not delete anything.
    const target =
      initialRef.current ??
      (dialogRef.current?.querySelector('button') as HTMLButtonElement | null)
    target?.focus()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const safeIndex = actions.findIndex((a) => !a.danger)
  const focusIndex = safeIndex >= 0 ? safeIndex : actions.length - 1

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-message"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="modal modal--confirm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="confirm-title">{title}</h2>
        </div>
        <div className="form">
          <p id="confirm-message" className="confirm__message">
            {message}
          </p>
          {detail && <p className="confirm__detail">{detail}</p>}
          <div className="modal__actions">
            {actions.map((action, index) => (
              <button
                key={action.label}
                ref={index === focusIndex ? initialRef : undefined}
                className={`btn${action.danger ? ' btn--danger' : ''}${
                  action.primary ? ' btn--primary' : ''
                }`}
                onClick={() => onSelect(action)}
              >
                {action.label}
              </button>
            ))}
            <button className="btn btn--ghost" onClick={onClose}>
              {tr('common.cancel')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
