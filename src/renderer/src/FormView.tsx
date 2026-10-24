import { useCallback, useEffect, useState } from 'react'
import type { ColumnInfo, PageResult } from '@shared/types'
import {
  classifyColumnType,
  coerceInput,
  inputElementType,
  toInputValue
} from '@shared/columnType'
import { formatBytes, isBinaryCell } from '@shared/binary'
import { unwrap } from './api'
import { useLocale } from './i18n'
import { confirmDestructive } from './confirm'
import type { SelectedTable } from './ExplorerTree'

interface Props {
  selection: SelectedTable
}

const PAGE_SIZE = 50

// One record at a time, as a vertical form. Useful for wide tables where a
// horizontal grid needs a lot of scrolling.
export function FormView({ selection }: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [data, setData] = useState<PageResult | null>(null)
  const [index, setIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editColumn, setEditColumn] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(
    async (options?: { quiet?: boolean }): Promise<PageResult | null> => {
      const quiet = options?.quiet === true
      if (!quiet) setLoading(true)
      setError(null)
      try {
        const result = await unwrap(
          window.dbApi.selectRows({
            connectionId: selection.connectionId,
            database: selection.database,
            schema: selection.schema,
            table: selection.table,
            limit: PAGE_SIZE,
            offset: 0
          })
        )
        setData(result)
        setIndex((current) =>
          result.rows.length === 0 ? 0 : Math.min(current, result.rows.length - 1)
        )
        return result
      } catch (err) {
        setError(errorText(err))
        return null
      } finally {
        if (!quiet) setLoading(false)
      }
    },
    [selection]
  )

  useEffect(() => {
    setIndex(0)
    setEditColumn(null)
    setMessage(null)
    void load()
  }, [load])

  const columns: ColumnInfo[] = data?.columns ?? []
  const rows = data?.rows ?? []
  const row = rows[index]
  const pks = data?.primaryKeys ?? []
  const canEdit = (data?.hasPrimaryKey ?? false) && pks.length > 0

  function pkOf(target: Record<string, unknown>): Record<string, unknown> {
    const pk: Record<string, unknown> = {}
    for (const k of pks) pk[k] = target[k]
    return pk
  }

  function startEdit(column: ColumnInfo): void {
    if (!row || !canEdit) return
    setEditColumn(column.name)
    setEditValue(
      row[column.name] === null
        ? ''
        : toInputValue(classifyColumnType(column.dataType), row[column.name])
    )
    setMessage(null)
  }

  async function commitEdit(column: ColumnInfo): Promise<void> {
    if (!row) return
    let value: unknown
    try {
      value = coerceInput(classifyColumnType(column.dataType), editValue)
    } catch (err) {
      setError(tr('form.columnError', { name: column.name, message: errorText(err) }))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await unwrap(
        window.dbApi.updateRow({
          connectionId: selection.connectionId,
          database: selection.database,
          schema: selection.schema,
          table: selection.table,
          primaryKeys: pkOf(row),
          changes: { [column.name]: value }
        })
      )
      setEditColumn(null)
      setMessage(tr('form.saved'))
      // Patch the record in place. Refetching would reorder the form's row list
      // and move the user to a different record right after saving.
      setData((prev) => {
        if (!prev) return prev
        const rows = prev.rows.slice()
        rows[index] = { ...rows[index], [column.name]: value }
        return { ...prev, rows }
      })
      // A primary key edit changes which record this is, so the page has to be
      // read again; everything else stays local.
      if (pks.includes(column.name)) await load({ quiet: true })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function deleteRow(): Promise<void> {
    if (!row || !canEdit) return
    const proceed = await confirmDestructive(tr('form.deleteConfirm'), {
      title: tr('form.deleteTitle'),
      detail: tr('form.deleteDetail')
    })
    if (!proceed) return
    setBusy(true)
    setError(null)
    try {
      await unwrap(
        window.dbApi.deleteRow({
          connectionId: selection.connectionId,
          database: selection.database,
          schema: selection.schema,
          table: selection.table,
          primaryKeys: pkOf(row)
        })
      )
      setMessage(tr('form.deleted'))
      // Drop the record locally and clamp the index instead of refetching, so
      // deleting does not flash the form or jump to a different record.
      const remaining = (data?.rows ?? []).filter((_, i) => i !== index)
      setData((prev) =>
        prev ? { ...prev, rows: remaining, total: Math.max(0, prev.total - 1) } : prev
      )
      setIndex((current) => Math.max(0, Math.min(current, remaining.length - 1)))
      if (remaining.length === 0 && (data?.total ?? 0) > 1) await load({ quiet: true })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <p className="muted formview__pad">{tr('form.loading')}</p>
  if (!data) return <p className="muted formview__pad">{tr('form.columnsFailed')}</p>

  return (
    <div className="formview">
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

      {rows.length === 0 ? (
        <p className="muted formview__pad">
          {canEdit ? tr('form.emptyTable') : tr('form.emptyTableReadOnly')}
        </p>
      ) : (
        <>
          <div className="formview__nav">
            <button
              className="btn btn--ghost btn--small"
              onClick={() => {
                setIndex((i) => Math.max(0, i - 1))
                setEditColumn(null)
              }}
              disabled={index === 0 || busy}
            >
              {tr('form.previous')}
            </button>
            <span className="formview__counter">
              {tr('form.counter', { index: index + 1, total: rows.length })}
              {data.total > rows.length
                ? tr('form.counterTotal', { total: data.total })
                : ''}
            </span>
            <button
              className="btn btn--ghost btn--small"
              onClick={() => {
                setIndex((i) => Math.min(rows.length - 1, i + 1))
                setEditColumn(null)
              }}
              disabled={index >= rows.length - 1 || busy}
            >
              {tr('form.next')}
            </button>
            <div className="formview__actions">
              <button
                className="btn btn--ghost btn--small"
                onClick={() => void load()}
                disabled={busy}
              >
                {tr('form.reload')}
              </button>
              <button
                className="btn btn--ghost btn--small formview__danger"
                onClick={() => void deleteRow()}
                disabled={busy || !canEdit}
                title={canEdit ? tr('form.deleteRow') : tr('form.needsPrimaryKey')}
              >
                {tr('form.deleteTitle')}
              </button>
            </div>
          </div>

          {!canEdit && <p className="notice notice--info">{tr('form.readOnlyNoPk')}</p>}

          <dl className="formview__fields">
            {columns.map((c) => {
              const raw = row[c.name]
              const editing = editColumn === c.name
              const kind = classifyColumnType(c.dataType)
              return (
                <div key={c.name} className="formview__field">
                  <dt className="formview__label">
                    <span className="formview__name">{c.name}</span>
                    <span className="formview__type">
                      {c.dataType}
                      {c.isPrimaryKey ? ' · PK' : ''}
                      {c.nullable ? '' : ' · NOT NULL'}
                    </span>
                    {c.comment && <span className="formview__comment">{c.comment}</span>}
                  </dt>
                  <dd className="formview__value">
                    {editing ? (
                      <span className="formview__editor">
                        {kind === 'boolean' ? (
                          <select
                            className="input input--cell"
                            autoFocus
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                          >
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        ) : (
                          <input
                            className="input input--cell"
                            type={inputElementType(kind)}
                            autoFocus
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void commitEdit(c)
                              if (e.key === 'Escape') setEditColumn(null)
                            }}
                          />
                        )}
                        <button
                          className="btn btn--small"
                          onClick={() => void commitEdit(c)}
                          disabled={busy}
                        >
                          {tr('common.save')}
                        </button>
                        <button
                          className="btn btn--ghost btn--small"
                          onClick={() => setEditColumn(null)}
                          disabled={busy}
                        >
                          {tr('common.cancel')}
                        </button>
                      </span>
                    ) : raw === null || raw === undefined ? (
                      <span className="cell-null">NULL</span>
                    ) : isBinaryCell(raw) ? (
                      <span className="blob-badge">
                        <span className="blob-badge__icon" aria-hidden="true">
                          BLOB
                        </span>
                        <span className="blob-badge__size">{formatBytes(raw.size)}</span>
                      </span>
                    ) : (
                      <span className="formview__text">{String(raw)}</span>
                    )}
                    {!editing && canEdit && !isBinaryCell(raw) && (
                      <button
                        className="btn btn--ghost btn--tiny formview__edit"
                        onClick={() => startEdit(c)}
                        disabled={busy}
                      >
                        {tr('form.edit')}
                      </button>
                    )}
                  </dd>
                </div>
              )
            })}
          </dl>
        </>
      )}
    </div>
  )
}
