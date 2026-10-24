import { useCallback, useEffect, useState } from 'react'
import type { ColumnInfo, TableInfoDetail } from '@shared/types'
import { unwrap } from './api'
import { useLocale } from './i18n'
import { IconRefresh } from './Icons'

export interface DetailSelection {
  connectionId: string
  database: string
  schema?: string
  table: string
}

// One row the user clicked in the data grid. The key is the table's primary-key
// string so the grid can highlight the same row.
export interface InspectedRow {
  key: string
  values: Record<string, unknown>
}

interface Props {
  selection: DetailSelection | null
  inspectedRow: InspectedRow | null
}

interface InfoRow {
  label: string
  value: string
}

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatNumber(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return value.toLocaleString()
}

// Cell values arrive as primitives, objects (JSON columns), or binary previews.
// The detail pane is read-only, so the value is shown as text and never parsed
// back into a query.
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') {
    if (value instanceof Uint8Array) return `<biner ${value.length} byte>`
    const asBinary = value as { kind?: string; size?: number }
    if (typeof asBinary.kind === 'string' && typeof asBinary.size === 'number') {
      return `<biner ${asBinary.size} byte>`
    }
    try {
      return JSON.stringify(value)
    } catch {
      return '[objek]'
    }
  }
  return String(value)
}

// The right-hand detail panel. It answers "what is selected?" without forcing
// the user to open the table: columns, keys, size, and the object DDL.
export function DetailPanel({ selection, inspectedRow }: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [info, setInfo] = useState<TableInfoDetail | null>(null)
  const [ddl, setDdl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ddlOpen, setDdlOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!selection) {
      setColumns([])
      setInfo(null)
      setDdl(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    setNotice(null)
    try {
      const [cols, detail] = await Promise.all([
        unwrap(
          window.dbApi.listColumns(
            selection.connectionId,
            selection.database,
            selection.table,
            selection.schema
          )
        ),
        unwrap(
          window.dbApi.getTableInfo(
            selection.connectionId,
            selection.database,
            selection.table,
            selection.schema
          )
        ).catch(() => null)
      ])
      setColumns(cols)
      setInfo(detail)
      // DDL is only fetched when the user asks for it: on MySQL it is a
      // SHOW CREATE TABLE round trip per table.
      setDdl(null)
    } catch (err) {
      setError(errorText(err))
      setColumns([])
      setInfo(null)
    } finally {
      setLoading(false)
    }
  }, [selection])

  useEffect(() => {
    void load()
  }, [load])

  async function loadDdl(): Promise<void> {
    if (!selection) return
    setDdlOpen(true)
    if (ddl !== null) return
    try {
      const found = await unwrap(
        window.dbApi.getObjectDdl(
          selection.connectionId,
          selection.database,
          selection.table,
          selection.schema
        )
      )
      setDdl(found ?? tr('detail.ddlUnavailable'))
    } catch (err) {
      setDdl(tr('detail.ddlFailed', { message: errorText(err) }))
    }
  }

  async function copyDdl(): Promise<void> {
    if (!ddl) return
    await window.dbApi.clipboardWrite(ddl)
    setNotice(tr('explorer.copyDdl'))
  }

  const rows: InfoRow[] = []
  if (info) {
    const count = formatNumber(info.rowCount)
    if (count) rows.push({ label: tr('detail.rows'), value: count })
    const size = formatBytes(info.sizeBytes)
    if (size) rows.push({ label: tr('detail.size'), value: size })
    if (info.engine) rows.push({ label: tr('detail.engine'), value: info.engine })
    if (info.collation)
      rows.push({ label: tr('detail.collation'), value: info.collation })
    for (const extra of info.extra ?? [])
      rows.push({ label: extra.label, value: extra.value })
  }

  if (!selection) {
    return (
      <div className="detail">
        <p className="muted detail__empty">{tr('detail.pickTable')}</p>
      </div>
    )
  }

  return (
    <div className="detail">
      <div className="detail__path" title={`${selection.database}.${selection.table}`}>
        <span className="detail__db">{selection.database}</span>
        {selection.schema && <span className="detail__schema">.{selection.schema}</span>}
        <span className="detail__table">.{selection.table}</span>
      </div>

      {inspectedRow && (
        <div className="detail__section">
          <div className="detail__section-head">
            <span>{tr('detail.selectedRow')}</span>
            <span className="detail__count">
              {Object.keys(inspectedRow.values).length}
            </span>
          </div>
          <dl className="detail__record">
            {Object.entries(inspectedRow.values).map(([name, value]) => {
              const text = renderValue(value)
              return (
                <div key={name} className="detail__field">
                  <dt title={name}>{name}</dt>
                  <dd
                    className={
                      value === null || value === undefined ? 'is-null' : undefined
                    }
                    title={text}
                  >
                    {text}
                  </dd>
                </div>
              )
            })}
          </dl>
        </div>
      )}

      <div className="detail__actions">
        <button
          className="btn btn--tiny btn--ghost"
          onClick={() => void load()}
          disabled={loading}
        >
          <IconRefresh size={12} /> {tr('menu.reload')}
        </button>
        <button className="btn btn--tiny btn--ghost" onClick={() => void loadDdl()}>
          {tr('detail.showDdl')}
        </button>
      </div>

      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice notice--ok" role="status">
          {notice}
        </p>
      )}

      {loading ? (
        <p className="muted detail__empty">{tr('detail.loading')}</p>
      ) : (
        <>
          {rows.length > 0 && (
            <dl className="detail__stats">
              {rows.map((row) => (
                <div key={row.label} className="detail__stat">
                  <dt>{row.label}</dt>
                  <dd title={row.value}>{row.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {info?.comment && <p className="detail__comment">{info.comment}</p>}

          <div className="detail__section">
            <span className="detail__section-head">
              Kolom <span className="detail__count">{columns.length}</span>
            </span>
            {columns.length === 0 ? (
              <p className="muted detail__empty">{tr('detail.noColumns')}</p>
            ) : (
              <ul className="detail__columns">
                {columns.map((column) => (
                  <li key={column.name} className="detail__column">
                    <span className="detail__col-name" title={column.name}>
                      {column.isPrimaryKey && (
                        <span className="detail__pk" title={tr('detail.primaryKey')}>
                          PK
                        </span>
                      )}
                      {column.name}
                    </span>
                    <span className="detail__col-type">{column.dataType}</span>
                    {!column.nullable && (
                      <span className="detail__flag" title={tr('detail.notNull')}>
                        NN
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {ddlOpen && ddl !== null && (
            <div className="detail__section">
              <div className="detail__section-head">
                <span>{tr('detail.ddl')}</span>
                <button
                  className="btn btn--tiny btn--ghost"
                  onClick={() => void copyDdl()}
                >
                  {tr('qb.copy')}
                </button>
              </div>
              <pre className="detail__ddl">{ddl}</pre>
            </div>
          )}
        </>
      )}
    </div>
  )
}
