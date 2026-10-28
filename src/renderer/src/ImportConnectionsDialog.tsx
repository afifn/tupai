import { useEffect, useMemo, useRef, useState } from 'react'
import type { NcxImportItem, NcxSkipReason } from '@shared/navicatNcx'
import { unwrap } from './api'
import { useFocusTrap } from './useFocusTrap'
import { useLocale } from './i18n'
import { ENGINE_LABEL, EngineIcon } from './EngineIcon'
import type { MessageKey } from '@shared/i18n'

interface Props {
  filePath: string
  onClose: () => void
  // Called after a successful import so the shell can refresh its list.
  onImported: (imported: string[]) => void
}

// Preview of a Navicat connection export. Nothing is written until the user
// confirms, and only the rows they keep: an import that silently adds twelve
// connections is harder to undo than a checkbox list.
export function ImportConnectionsDialog({
  filePath,
  onClose,
  onImported
}: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [items, setItems] = useState<NcxImportItem[] | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, true)

  useEffect(() => {
    let cancelled = false
    unwrap(window.dbApi.previewNcxImport(filePath))
      .then((result) => {
        if (cancelled) return
        setInvalid(result.invalid)
        setItems(result.items)
        // Conflicts start unchecked: the user asked for a migration, not a
        // duplicate, and an existing name is usually the same connection.
        setSelected(
          new Set(result.items.filter((item) => item.status === 'new').map((i) => i.key))
        )
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err))
      })
    return () => {
      cancelled = true
    }
  }, [filePath, errorText])

  const importable = useMemo(
    () => (items ?? []).filter((item) => item.status !== 'unsupported'),
    [items]
  )
  const selectedCount = importable.filter((item) => selected.has(item.key)).length

  function toggle(key: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleAll(): void {
    setSelected(
      selectedCount === importable.length
        ? new Set()
        : new Set(importable.map((item) => item.key))
    )
  }

  async function apply(): Promise<void> {
    if (selectedCount === 0) return
    setBusy(true)
    setError(null)
    try {
      const result = await unwrap(window.dbApi.applyNcxImport(filePath, [...selected]))
      onImported(result.imported)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  function skipLabel(reason: NcxSkipReason | undefined): string {
    const key: MessageKey =
      reason === 'unsupported-engine'
        ? 'ncx.skipEngine'
        : reason === 'missing-name'
          ? 'ncx.skipName'
          : reason === 'missing-file'
            ? 'ncx.skipFile'
            : 'ncx.skipHost'
    return tr(key)
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={tr('ncx.title')}
      onClick={onClose}
    >
      <div
        className="modal modal--ncx"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2>{tr('ncx.title')}</h2>
          <button className="btn btn--ghost btn--small" onClick={onClose}>
            {tr('common.close')}
          </button>
        </div>

        <p className="muted ncx__hint">{tr('ncx.hint')}</p>

        {error && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}

        {invalid && (
          <p className="notice notice--error" role="alert">
            {tr('ncx.invalid')}
          </p>
        )}

        {items === null && !invalid && !error && (
          <p className="muted ncx__pad">{tr('ncx.loading')}</p>
        )}

        {items !== null && items.length === 0 && !invalid && (
          <p className="muted ncx__pad">{tr('ncx.empty')}</p>
        )}

        {items !== null && items.length > 0 && (
          <>
            <div className="ncx__bar">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={importable.length > 0 && selectedCount === importable.length}
                  onChange={toggleAll}
                  disabled={importable.length === 0 || busy}
                />
                <span>{tr('ncx.selectAll')}</span>
              </label>
              <span className="muted">
                {tr('ncx.selected', { count: selectedCount, total: items.length })}
              </span>
            </div>

            <div className="table-scroll ncx__scroll">
              <table className="data-table ncx__table">
                <thead>
                  <tr>
                    <th className="ncx__check" aria-label={tr('ncx.selectAll')} />
                    <th>{tr('ncx.colName')}</th>
                    <th>{tr('ncx.colEngine')}</th>
                    <th>{tr('ncx.colServer')}</th>
                    <th>{tr('ncx.colStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const disabled = item.status === 'unsupported' || busy
                    return (
                      <tr
                        key={item.key}
                        className={disabled ? 'ncx__row is-disabled' : 'ncx__row'}
                      >
                        <td className="ncx__check">
                          <input
                            type="checkbox"
                            checked={selected.has(item.key)}
                            onChange={() => toggle(item.key)}
                            disabled={disabled}
                            aria-label={item.name}
                          />
                        </td>
                        <td>
                          <span className="ncx__name">{item.name || '—'}</span>
                          {item.warnings.length > 0 && (
                            <span className="ncx__note">
                              {item.warnings
                                .map((w) =>
                                  w === 'ssl-dropped'
                                    ? tr('ncx.warnSslDropped')
                                    : w === 'ssh-dropped'
                                      ? tr('ncx.warnSshDropped')
                                      : w
                                )
                                .join(' · ')}
                            </span>
                          )}
                        </td>
                        <td>
                          {item.engine ? (
                            <span className="ncx__engine">
                              <EngineIcon engine={item.engine} size={13} />
                              {ENGINE_LABEL[item.engine]}
                            </span>
                          ) : (
                            <span className="muted">{item.connType || '—'}</span>
                          )}
                        </td>
                        <td className="ncx__server">
                          {item.engine === 'sqlite'
                            ? item.name
                            : item.port
                              ? `${item.host}:${item.port}`
                              : item.host}
                        </td>
                        <td>
                          {item.status === 'unsupported' ? (
                            <span className="ncx__badge is-unsupported">
                              {skipLabel(item.skipReason)}
                            </span>
                          ) : item.status === 'conflict' ? (
                            <span className="ncx__badge is-conflict">
                              {tr('ncx.statusConflict')}
                            </span>
                          ) : (
                            <span className="ncx__badge is-new">
                              {tr('ncx.statusNew')}
                            </span>
                          )}
                          {item.needsPassword && (
                            <span className="ncx__badge is-password">
                              {tr('ncx.needsPassword')}
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
            {tr('common.cancel')}
          </button>
          <button
            className="btn"
            onClick={() => void apply()}
            disabled={busy || selectedCount === 0}
          >
            {busy ? tr('ncx.importing') : tr('ncx.importCount', { count: selectedCount })}
          </button>
        </div>
      </div>
    </div>
  )
}
