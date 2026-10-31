import { useCallback, useEffect, useState } from 'react'
import type { BackupEntry } from '@shared/types'
import { unwrap } from './api'
import { useLocale } from './i18n'
import { confirmDestructive } from './confirm'

interface Props {
  connectionId: string
  database?: string
  connectionName?: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function BackupPanel({
  connectionId,
  database,
  connectionName
}: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [databases, setDatabases] = useState<string[]>([])
  const [target, setTarget] = useState<string>(database ?? '')
  const [structure, setStructure] = useState(true)
  const [data, setData] = useState(true)
  const [busy, setBusy] = useState<'backup' | 'restore' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<BackupEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)

  const loadHistory = useCallback(async (): Promise<void> => {
    setHistoryLoading(true)
    try {
      setHistory(await unwrap(window.dbApi.listBackups()))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    unwrap(window.dbApi.listDatabases(connectionId))
      .then((found) => {
        if (cancelled) return
        setDatabases(found)
        setTarget((prev) => (prev && found.includes(prev) ? prev : (found[0] ?? '')))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connectionId])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  async function handleBackup(): Promise<void> {
    if (!target) {
      setError(tr('backup.needDatabase'))
      return
    }
    setBusy('backup')
    setError(null)
    setMessage(null)
    try {
      const entry = await unwrap(
        window.dbApi.backupDatabase(connectionId, target, { structure, data })
      )
      if (!entry) {
        setMessage(tr('backup.cancelled'))
      } else {
        setMessage(
          tr('backup.done', {
            tables: entry.tables,
            rows: entry.rows,
            size: formatBytes(entry.bytes)
          })
        )
        await loadHistory()
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  async function handleRestore(): Promise<void> {
    const proceed = await confirmDestructive(tr('backup.restoreConfirm'), {
      title: tr('backup.restoreTitle'),
      detail: tr('backup.restoreDetail'),
      confirmLabel: tr('common.run')
    })
    if (!proceed) return
    setBusy('restore')
    setError(null)
    setMessage(null)
    try {
      const result = await unwrap(
        window.dbApi.restoreDatabase(connectionId, target || undefined)
      )
      if (!result) {
        setMessage(tr('backup.restoreCancelled'))
      } else {
        setMessage(tr('backup.restoreDone', { count: result.statements }))
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  async function removeEntry(entry: BackupEntry): Promise<void> {
    const proceed = await confirmDestructive(tr('backup.deleteHistoryConfirm'), {
      title: tr('backup.deleteHistoryTitle'),
      detail: tr('backup.deleteHistoryDetail')
    })
    if (!proceed) return
    try {
      await unwrap(window.dbApi.deleteBackupEntry(entry.id))
      await loadHistory()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <div className="backup">
      <div className="backup__bar">
        <h2 className="grid-title">{tr('backup.title')}</h2>
        {connectionName && <span className="muted">{connectionName}</span>}
      </div>

      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice notice--ok" role="status">
          {message}
        </p>
      )}

      <section className="backup__card">
        <h3>{tr('backup.database')}</h3>
        <div className="backup__row">
          <label className="field">
            <span className="field__label">{tr('backup.databaseLabel')}</span>
            <select
              className="input"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={databases.length === 0}
            >
              {databases.length === 0 && <option value="">{tr('common.none')}</option>}
              {databases.map((db) => (
                <option key={db} value={db}>
                  {db}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="backup__checks">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={structure}
              onChange={(e) => setStructure(e.target.checked)}
            />
            {tr('backup.formatStructure')}
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={data}
              onChange={(e) => setData(e.target.checked)}
            />
            {tr('backup.formatData')}
          </label>
        </div>
        <p className="field__hint">{tr('backup.formatHint')}</p>
        <div className="backup__actions">
          <button
            className="btn btn--small"
            onClick={() => void handleBackup()}
            disabled={busy !== null || !target || (!structure && !data)}
          >
            {busy === 'backup' ? tr('backup.running') : tr('backup.start')}
          </button>
          <button
            className="btn btn--small btn--ghost"
            onClick={() => void handleRestore()}
            disabled={busy !== null || !target}
            title={tr('backup.restoreHint')}
          >
            {busy === 'restore' ? tr('backup.restoring') : tr('backup.restore')}
          </button>
        </div>
      </section>

      <section className="backup__card">
        <div className="backup__bar">
          <h3>{tr('backup.history')}</h3>
          <button
            className="btn btn--tiny btn--ghost"
            onClick={() => void loadHistory()}
            disabled={historyLoading}
          >
            {tr('menu.reload')}
          </button>
        </div>
        {historyLoading ? (
          <p className="muted">{tr('backup.loadingHistory')}</p>
        ) : history.length === 0 ? (
          <p className="muted">{tr('backup.noHistory')}</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table backup__table">
              <thead>
                <tr>
                  <th>{tr('backup.colTime')}</th>
                  <th>{tr('backup.colDatabase')}</th>
                  <th>{tr('backup.colContents')}</th>
                  <th>{tr('backup.colTables')}</th>
                  <th>{tr('backup.colRows')}</th>
                  <th>{tr('backup.colSize')}</th>
                  <th>{tr('backup.colFile')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.id}>
                    <td>{new Date(entry.createdAt).toLocaleString()}</td>
                    <td>{entry.database}</td>
                    <td>
                      {entry.structure ? 'struktur' : ''}
                      {entry.structure && entry.data ? ' + ' : ''}
                      {entry.data ? 'data' : ''}
                    </td>
                    <td>{entry.tables}</td>
                    <td>{entry.rows}</td>
                    <td>{formatBytes(entry.bytes)}</td>
                    <td className="backup__path" title={entry.filePath}>
                      {entry.filePath}
                    </td>
                    <td>
                      <button
                        className="btn btn--tiny btn--ghost"
                        onClick={() => void removeEntry(entry)}
                      >
                        {tr('menu.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
