import { useEffect, useState } from 'react'
import type { QueryResultSet } from '@shared/types'
import { AI_PREVIEW_ROWS } from '@shared/aiPreview'
import { unwrap } from './api'
import { useLocale } from './i18n'

interface Props {
  connectionId: string
  sql: string
  database?: string
  schema?: string
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (value instanceof Uint8Array) return `<${value.length}B>`
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return '[objek]'
    }
  }
  return String(value)
}

/**
 * Runs the SELECT from an assistant answer and shows a few rows under it. The
 * query is read-only by construction (see `previewableStatement`), the row cap
 * comes from `maxRows`, and nothing here is editable: this is a peek at the
 * answer, not a data grid.
 */
export function AiPreviewTable({
  connectionId,
  sql,
  database,
  schema
}: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [result, setResult] = useState<QueryResultSet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setResult(null)
    unwrap(
      window.dbApi.runQuery({
        connectionId,
        sql,
        maxRows: AI_PREVIEW_ROWS,
        database,
        schema
      })
    )
      .then((sets) => {
        if (cancelled) return
        const rows = sets.find((set) => set.kind === 'rows')
        if (!rows) {
          setError(tr('ai.previewNoRows'))
          return
        }
        setResult(rows)
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `tr` is stable per locale; re-running on a language change is harmless.
  }, [connectionId, sql, database, schema, tr])

  if (loading) {
    return (
      <p className="ai__preview-note" role="status">
        {tr('ai.previewLoading')}
      </p>
    )
  }

  if (error) {
    return (
      <p className="ai__preview-note ai__preview-note--error" role="alert">
        {tr('ai.previewFailed', { message: error })}
      </p>
    )
  }

  if (!result) return <></>

  if (result.rows.length === 0) {
    return <p className="ai__preview-note">{tr('ai.previewEmpty')}</p>
  }

  return (
    <div className="ai__preview">
      <div className="ai__preview-scroll">
        <table className="ai__preview-table">
          <thead>
            <tr>
              {result.columns.map((column) => (
                <th key={column.name} title={column.name}>
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {result.columns.map((column) => {
                  const value = row[column.name]
                  return (
                    <td key={column.name} title={cellText(value)}>
                      {value === null || value === undefined ? (
                        <span className="cell-null">NULL</span>
                      ) : (
                        cellText(value)
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ai__preview-note">
        {result.truncated
          ? tr('ai.previewCapped', { max: AI_PREVIEW_ROWS })
          : tr('ai.previewCount', { count: result.rows.length })}
      </p>
    </div>
  )
}
