import { useMemo, useRef, useState } from 'react'
import type { StoredConnection } from '@shared/types'
import { unwrap } from './api'
import { useFocusTrap } from './useFocusTrap'
import { useLocale } from './i18n'
import { ENGINE_LABEL, EngineIcon } from './EngineIcon'

interface Props {
  // In sidebar order, so the checkbox list matches what the user just saw.
  connections: StoredConnection[]
  // Ids checked on open: the connection or group the user right-clicked, or
  // every connection when the dialog comes from the application menu.
  preselected: string[]
  onClose: () => void
  onExported: (result: { path: string; count: number }) => void
}

// Picks which stored connections go into one .ncx file. The previous flow always
// wrote every connection, which made a single-connection export impossible
// without deleting the others first.
export function ExportConnectionsDialog({
  connections,
  preselected,
  onClose,
  onExported
}: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [selected, setSelected] = useState<Set<string>>(() => new Set(preselected))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // True after the user dismissed the native save dialog: nothing was written,
  // and the picker stays open with the same selection.
  const [cancelled, setCancelled] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, true)

  const selectedCount = useMemo(
    () => connections.filter((c) => selected.has(c.id)).length,
    [connections, selected]
  )

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll(): void {
    setSelected(
      selectedCount === connections.length
        ? new Set()
        : new Set(connections.map((c) => c.id))
    )
  }

  async function run(): Promise<void> {
    if (selectedCount === 0 || busy) return
    setBusy(true)
    setError(null)
    setCancelled(false)
    try {
      const ids = connections.filter((c) => selected.has(c.id)).map((c) => c.id)
      const result = await unwrap(window.dbApi.exportNcx(ids))
      if (!result) {
        // The save dialog was cancelled: keep the picks so a second click does
        // not make the user redo the selection.
        setCancelled(true)
        return
      }
      onExported(result)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={tr('ncx.exportTitle')}
      onClick={onClose}
    >
      <div
        className="modal modal--ncx"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2>{tr('ncx.exportTitle')}</h2>
          <button className="btn btn--ghost btn--small" onClick={onClose}>
            {tr('common.close')}
          </button>
        </div>

        <p className="muted ncx__hint">{tr('ncx.exportHint')}</p>

        {error && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}

        {cancelled && !error && (
          <p className="notice" role="status">
            {tr('ncx.exportCancelled')}
          </p>
        )}

        <div className="ncx__bar">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={connections.length > 0 && selectedCount === connections.length}
              onChange={toggleAll}
              disabled={connections.length === 0 || busy}
            />
            <span>{tr('ncx.selectAll')}</span>
          </label>
          <span className="muted">
            {tr('ncx.selected', { count: selectedCount, total: connections.length })}
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
              </tr>
            </thead>
            <tbody>
              {connections.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted ncx__pad">
                    {tr('ncx.noConnections')}
                  </td>
                </tr>
              )}
              {connections.map((conn) => (
                <tr key={conn.id} className="ncx__row">
                  <td className="ncx__check">
                    <input
                      type="checkbox"
                      checked={selected.has(conn.id)}
                      onChange={() => toggle(conn.id)}
                      disabled={busy}
                      aria-label={conn.name}
                    />
                  </td>
                  <td>
                    <span className="ncx__name">{conn.name}</span>
                  </td>
                  <td>
                    <span className="ncx__engine">
                      <EngineIcon engine={conn.engine} size={13} />
                      {ENGINE_LABEL[conn.engine]}
                    </span>
                  </td>
                  <td className="ncx__server">
                    {conn.engine === 'sqlite'
                      ? (conn.file ?? '—')
                      : conn.port
                        ? `${conn.host}:${conn.port}`
                        : (conn.host ?? '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onClose} disabled={busy}>
            {tr('common.cancel')}
          </button>
          <button
            className="btn"
            onClick={() => void run()}
            disabled={busy || selectedCount === 0}
          >
            {busy ? tr('ncx.exporting') : tr('ncx.exportCount', { count: selectedCount })}
          </button>
        </div>
      </div>
    </div>
  )
}
