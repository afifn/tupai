import { useCallback, useEffect, useState } from 'react'
import type { SessionInfo } from '@shared/types'
import { unwrap } from './api'
import { useLocale } from './i18n'
import { confirmDestructive } from './confirm'

interface Props {
  connectionId: string
  engine: string
  database?: string
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-'
  if (ms < 1000) return `${ms} ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} dtk`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} mnt ${seconds % 60} dtk`
  const hours = Math.floor(minutes / 60)
  return `${hours} jam ${minutes % 60} mnt`
}

export function SessionsPanel({ connectionId, engine, database }: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  const supportsSessions = engine !== 'sqlite'

  const load = useCallback(async (): Promise<void> => {
    if (!supportsSessions) {
      setSessions([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      // Scoped to the current database by default; "show all" drops the filter
      // where the engine allows it.
      setSessions(
        await unwrap(
          window.dbApi.listSessions(connectionId, showAll ? undefined : database)
        )
      )
    } catch (err) {
      setError(errorText(err))
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [connectionId, database, showAll, supportsSessions])

  useEffect(() => {
    void load()
  }, [load])

  async function kill(session: SessionInfo): Promise<void> {
    const label = `sesi ${session.id}${session.user ? ` (${session.user})` : ''}`
    const proceed = await confirmDestructive(`Hentikan ${label}?`, {
      title: tr('sessions.stopTitle'),
      detail: tr('sessions.stopDetail'),
      confirmLabel: 'Hentikan'
    })
    if (!proceed) return
    setBusyId(session.id)
    setError(null)
    try {
      await unwrap(window.dbApi.killSession(connectionId, session.id))
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="sessions">
      <div className="sessions__bar">
        <h2 className="grid-title">{tr('sessions.title')}</h2>
        <div className="sessions__actions">
          {supportsSessions && engine !== 'mongodb' && (
            <label className="checkbox checkbox--tight">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
              />
              <span>{tr('sessions.showAll')}</span>
            </label>
          )}
          <button
            className="btn btn--ghost btn--small"
            onClick={() => void load()}
            disabled={loading || !supportsSessions}
          >
            {loading ? tr('common.loading') : tr('menu.reload')}
          </button>
        </div>
      </div>

      {!supportsSessions && (
        <p className="notice notice--info">
          SQLite adalah database file tunggal tanpa sesi server, jadi tidak ada daftar
          sesi.
        </p>
      )}

      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}

      {supportsSessions &&
        (loading ? (
          <p className="muted">{tr('sessions.loading')}</p>
        ) : !sessions || sessions.length === 0 ? (
          <p className="muted">
            {database && !showAll
              ? tr('sessions.emptyIn', { database })
              : tr('sessions.empty')}
          </p>
        ) : (
          <div className="table-scroll table-scroll--short">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="th-plain">{tr('sessions.colId')}</th>
                  <th className="th-plain">{tr('sessions.colUser')}</th>
                  <th className="th-plain">{tr('sessions.colDatabase')}</th>
                  <th className="th-plain">{tr('sessions.colStatus')}</th>
                  <th className="th-plain">{tr('sessions.colDuration')}</th>
                  <th className="th-plain">{tr('sessions.colQuery')}</th>
                  <th className="th-plain">{tr('sessions.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="cell session-id">
                      {s.id}
                      {s.isSelf && (
                        <span className="session-self">{tr('sessions.self')}</span>
                      )}
                    </td>
                    <td className="cell">{s.user ?? '-'}</td>
                    <td className="cell">{s.database ?? '-'}</td>
                    <td className="cell">{s.state ?? '-'}</td>
                    <td className="cell">{formatDuration(s.durationMs)}</td>
                    <td className="cell session-query" title={s.query ?? ''}>
                      {s.query ? s.query.replace(/\s+/g, ' ').trim() : '-'}
                    </td>
                    <td className="cell cell--actions">
                      <button
                        className="btn btn--ghost btn--tiny"
                        onClick={() => void kill(s)}
                        disabled={busyId === s.id || s.isSelf}
                        title={
                          s.isSelf ? tr('sessions.cannotStopSelf') : tr('sessions.stop')
                        }
                      >
                        {busyId === s.id ? '...' : 'Hentikan'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  )
}
