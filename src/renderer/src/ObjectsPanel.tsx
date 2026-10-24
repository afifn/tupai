import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DbEngine, TableStat } from '@shared/types'
import { unwrap } from './api'
import { useLocale } from './i18n'
import { EngineIcon } from './EngineIcon'
import { IconRefresh, IconTable, IconView } from './Icons'
import type { DatabaseTarget, TableTarget } from './ExplorerTree'

interface Props {
  connectionId: string
  engine: DbEngine
  connectionName: string
  database: string
  schema?: string
  onSelectTable: (sel: TableTarget) => void
  onOpenQuery: (database: string, schema?: string) => void
  onContextDatabase: (target: DatabaseTarget, x: number, y: number) => void
  onContextTable: (target: TableTarget, x: number, y: number) => void
}

export function ObjectsPanel({
  connectionId,
  engine,
  connectionName,
  database,
  schema,
  onSelectTable,
  onOpenQuery,
  onContextDatabase,
  onContextTable
}: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [stats, setStats] = useState<TableStat[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setStats(await unwrap(window.dbApi.listTableStats(connectionId, database, schema)))
    } catch (err) {
      setError(errorText(err))
      setStats([])
    } finally {
      setLoading(false)
    }
  }, [connectionId, database, schema])

  useEffect(() => {
    setFilter('')
    void load()
  }, [load])

  const filtered = useMemo(() => {
    if (!stats) return []
    const term = filter.trim().toLowerCase()
    if (!term) return stats
    return stats.filter((s) => s.name.toLowerCase().includes(term))
  }, [stats, filter])

  const tableCount = filtered.filter((s) => s.type === 'table').length
  const viewCount = filtered.filter((s) => s.type === 'view').length
  const showEngine = engine !== 'postgres' && engine !== 'oracle'

  function targetFor(row: TableStat): TableTarget {
    return {
      connectionId,
      engine,
      database,
      schema,
      table: row.name,
      type: row.type
    }
  }

  return (
    <div className="objects">
      <header className="objects__head">
        <div className="objects__path">
          <span className="objects__conn">
            <EngineIcon engine={engine} active />
          </span>
          <button
            className="objects__crumb"
            onClick={(e) =>
              onContextDatabase({ connectionId, engine, database }, e.clientX, e.clientY)
            }
            title={tr('objects.databaseMenu')}
          >
            {connectionName} / {database}
            {schema ? ` / ${schema}` : ''}
          </button>
          <span className="objects__counts">
            {tableCount} tabel · {viewCount} view
          </span>
        </div>

        <div className="objects__actions">
          <input
            className="input input--tight objects__filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={tr('objects.searchPlaceholder')}
            aria-label={tr('objects.search')}
          />
          <button
            className="btn btn--ghost btn--small"
            onClick={() => onOpenQuery(database, schema)}
            title={tr('objects.newQuery')}
          >
            {tr('app.query')}
          </button>
          <button
            className="btn btn--ghost btn--small"
            onClick={() => void load()}
            disabled={loading}
            title={tr('menu.reload')}
            aria-label={tr('menu.reload')}
          >
            <IconRefresh size={13} />
          </button>
        </div>
      </header>

      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}

      <div className="objects__body">
        {loading ? (
          <p className="muted objects__pad">{tr('explorer.loadingObjects')}</p>
        ) : !stats || stats.length === 0 ? (
          <p className="muted objects__pad">{tr('explorer.noObjects')}</p>
        ) : filtered.length === 0 ? (
          <p className="muted objects__pad">{tr('explorer.noObjectMatch')}</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table objects__table">
              <thead>
                <tr>
                  <th className="th-plain objects__th-name">{tr('objects.name')}</th>
                  <th className="th-plain">{tr('objects.rows')}</th>
                  <th className="th-plain">{tr('objects.size')}</th>
                  <th className="th-plain">{tr('objects.comment')}</th>
                  {showEngine && <th className="th-plain">{tr('objects.engine')}</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={`${row.type}:${row.name}`}>
                    <td className="cell">
                      <button
                        className="objects__name"
                        onClick={() => onSelectTable(targetFor(row))}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          onContextTable(targetFor(row), e.clientX, e.clientY)
                        }}
                        title={row.comment ?? row.name}
                      >
                        <span className="objects__icon">
                          {row.type === 'view' ? (
                            <IconView size={14} />
                          ) : (
                            <IconTable size={14} />
                          )}
                        </span>
                        {row.name}
                      </button>
                    </td>
                    <td className="cell">{row.rows ?? '-'}</td>
                    <td className="cell">
                      {row.sizeBytes ? formatSize(row.sizeBytes) : '-'}
                    </td>
                    <td className="cell">{row.comment ?? ''}</td>
                    {showEngine && <td className="cell">{row.engine ?? '-'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value.toFixed(1)} ${units[i]}`
}
