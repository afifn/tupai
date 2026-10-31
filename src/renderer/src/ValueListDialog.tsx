import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from './useFocusTrap'
import { useLocale } from './i18n'

interface Props {
  /** ENUM or SET, shown in the title so the dialog says what it edits. */
  typeName: string
  /** Current values, one per line. */
  values: string
  onConfirm: (values: string) => void
  onClose: () => void
}

/**
 * Editor for an ENUM/SET value list.
 *
 * The list is edited one value per line instead of a comma-separated field: a
 * value may itself contain a comma, and a single line made that impossible to
 * tell apart. The preview shows the SQL the list will produce.
 */
export function ValueListDialog({
  typeName,
  values,
  onConfirm,
  onClose
}: Props): JSX.Element {
  const { tr } = useLocale()
  const [text, setText] = useState(values)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, true)

  useEffect(() => {
    areaRef.current?.focus()
    areaRef.current?.select()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const items = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const preview = items.length
    ? `${typeName}(${items.map((item) => `'${item.replace(/'/g, "''")}'`).join(',')})`
    : `${typeName}()`

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={tr('designer.valuesTitle', { type: typeName })}
      onClick={onClose}
    >
      <div
        className="modal modal--prompt"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2>{tr('designer.valuesTitle', { type: typeName })}</h2>
        </div>
        <label className="designer__values-field">
          <span>{tr('designer.valuesLabel')}</span>
          <textarea
            className="input designer__values-input"
            ref={areaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={tr('designer.valuesPlaceholder')}
            spellCheck={false}
            rows={8}
          />
        </label>
        <p className="settings__hint">{tr('designer.valuesHint')}</p>
        <p className="designer__values-preview">
          <code>{preview}</code>
        </p>
        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose}>
            {tr('common.cancel')}
          </button>
          <button
            className="btn"
            disabled={items.length === 0}
            onClick={() => onConfirm(items.join('\n'))}
          >
            {tr('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
