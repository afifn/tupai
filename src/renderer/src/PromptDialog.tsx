import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from './useFocusTrap'
import { useLocale } from './i18n'

interface Props {
  title: string
  label?: string
  defaultValue?: string
  confirmLabel?: string
  placeholder?: string
  onConfirm: (value: string) => void
  onClose: () => void
}

// In-app replacement for window.prompt, which Electron does not implement.
export function PromptDialog({
  title,
  label,
  defaultValue = '',
  confirmLabel,
  placeholder,
  onConfirm,
  onClose
}: Props): JSX.Element {
  const { tr } = useLocale()
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, true)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function submit(): void {
    const trimmed = value.trim()
    if (!trimmed) return
    onConfirm(trimmed)
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="modal modal--prompt"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2>{title}</h2>
        </div>
        <div className="form">
          <label className="field">
            {label && <span className="field__label">{label}</span>}
            <input
              ref={inputRef}
              className="input"
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
          </label>
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={onClose}>
              {tr('common.cancel')}
            </button>
            <button className="btn" onClick={submit} disabled={!value.trim()}>
              {confirmLabel ?? tr('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
