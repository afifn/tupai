import { useEffect, useMemo, useRef, useState } from 'react'
import type { QueryResultSet } from '@shared/types'
import { formatBytes, isBinaryCell, type BinaryCell } from '@shared/binary'
import { parseSingleTableSelect } from '@shared/sqlSource'
import { unwrap } from './api'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { useLocale } from './i18n'

const DEFAULT_COL_WIDTH = 180
const MIN_COL_WIDTH = 60

interface Props {
  result: QueryResultSet
  connectionId: string
  database?: string
  schema?: string
  // Called after a cell was written, so the parent can decide whether to rerun.
  onChanged?: () => void
}

interface EditState {
  rowIndex: number
  column: string
  value: string
}

interface CellMenu {
  x: number
  y: number
  rowIndex: number
  column: string
}

interface SortState {
  column: string
  dir: 'asc' | 'desc'
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

/**
 * Grid for one result set of a query. It shares the table data grid's visual
 * language (resizable columns, sortable headers, cell context menu) but reads
 * from the rows already returned by the server instead of paging a table, since
 * a query result has no stable identity to page over.
 */
export function QueryResultGrid({
  result,
  connectionId,
  database,
  schema,
  onChanged
}: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [sort, setSort] = useState<SortState | null>(null)
  const [edit, setEdit] = useState<EditState | null>(null)
  const [menu, setMenu] = useState<CellMenu | null>(null)
  const [preview, setPreview] = useState<BinaryCell | null>(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [pkColumns, setPkColumns] = useState<string[] | null>(null)
  // Saved values keyed by primary key. A query result has no stable row identity
  // to refetch by, so the edited cell is patched locally instead of making the
  // user rerun the statement to see their own change.
  const [patches, setPatches] = useState<Record<string, Record<string, unknown>>>({})
  const resizeRef = useRef<{ column: string; startX: number; startWidth: number } | null>(
    null
  )

  // Editing needs a primary key, and only a statement that maps 1:1 to one table
  // has one. Anything else (join, aggregate, subquery) stays read-only.
  const source = useMemo(
    () => (result.kind === 'rows' ? parseSingleTableSelect(result.statement) : null),
    [result]
  )

  useEffect(() => {
    setColWidths({})
    setSort(null)
    setEdit(null)
    setNote(null)
    setPatches({})
  }, [result])

  useEffect(() => {
    setPkColumns(null)
    if (!source || !database) return
    let cancelled = false
    unwrap(
      window.dbApi.getPrimaryKey(
        connectionId,
        database,
        source.table,
        source.schema ?? schema
      )
    )
      .then((pk) => {
        if (!cancelled) setPkColumns(pk?.columns ?? [])
      })
      .catch(() => {
        if (!cancelled) setPkColumns([])
      })
    return () => {
      cancelled = true
    }
  }, [source, connectionId, database, schema])

  const editable = (pkColumns?.length ?? 0) > 0

  const rows = useMemo(() => {
    const keys = pkColumns ?? []
    const keyOf = (row: Record<string, unknown>): string =>
      keys.map((k) => String(row[k])).join('\u0000')
    const merged = result.rows.map((row) => {
      const patch = patches[keyOf(row)]
      return patch ? { ...row, ...patch } : row
    })
    if (!sort) return merged
    const factor = sort.dir === 'asc' ? 1 : -1
    merged.sort((a, b) => factor * compareValues(a[sort.column], b[sort.column]))
    return merged
  }, [result.rows, sort, patches, pkColumns])

  const widthOf = (name: string): number => colWidths[name] ?? DEFAULT_COL_WIDTH
  const totalWidth = result.columns.reduce((sum, c) => sum + widthOf(c.name), 0)

  function toggleSort(column: string): void {
    setSort((current) => {
      if (!current || current.column !== column) return { column, dir: 'asc' }
      if (current.dir === 'asc') return { column, dir: 'desc' }
      return null
    })
  }

  function resizeByKeyboard(event: React.KeyboardEvent, column: string): void {
    const step = event.shiftKey ? 40 : 16
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const next = Math.max(
        MIN_COL_WIDTH,
        widthOf(column) + (event.key === 'ArrowRight' ? step : -step)
      )
      setColWidths((prev) => ({ ...prev, [column]: next }))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      setColWidths((prev) => {
        const next = { ...prev }
        delete next[column]
        return next
      })
    }
  }

  function startResize(event: React.MouseEvent, column: string): void {
    event.preventDefault()
    event.stopPropagation()
    resizeRef.current = { column, startX: event.clientX, startWidth: widthOf(column) }
    document.body.classList.add('is-col-resizing')

    function onMove(move: MouseEvent): void {
      const ref = resizeRef.current
      if (!ref) return
      const next = Math.max(MIN_COL_WIDTH, ref.startWidth + (move.clientX - ref.startX))
      setColWidths((prev) => ({ ...prev, [ref.column]: next }))
    }
    function onUp(): void {
      resizeRef.current = null
      document.body.classList.remove('is-col-resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  async function commitEdit(): Promise<void> {
    if (!edit || !source || !database || !pkColumns) return
    const row = rows[edit.rowIndex]
    if (!row) return
    const primaryKeys: Record<string, unknown> = {}
    for (const key of pkColumns) primaryKeys[key] = row[key]
    setSaving(true)
    setNote(null)
    try {
      await unwrap(
        window.dbApi.updateRow({
          connectionId,
          database,
          schema: source.schema ?? schema,
          table: source.table,
          primaryKeys,
          changes: { [edit.column]: edit.value }
        })
      )
      const key = pkColumns.map((k) => String(row[k])).join('\u0000')
      setPatches((prev) => ({ ...prev, [key]: { [edit.column]: edit.value } }))
      setEdit(null)
      setNote(tr('query.editSaved'))
      onChanged?.()
    } catch (err) {
      setNote(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  async function exportAs(format: 'csv' | 'json'): Promise<void> {
    setExporting(true)
    setNote(null)
    try {
      const res = await unwrap(
        window.dbApi.exportResultSet({
          format,
          columns: result.columns.map((c) => c.name),
          rows: result.rows
        })
      )
      setNote(res ? tr('query.exported', { count: res.rowsWritten }) : null)
    } catch (err) {
      setNote(tr('query.exportFailed', { message: errorText(err) }))
    } finally {
      setExporting(false)
    }
  }

  function buildMenuItems(cell: CellMenu): MenuItem[] {
    const row = rows[cell.rowIndex]
    const raw = row?.[cell.column]
    const isNull = raw === null || raw === undefined
    const binary = isBinaryCell(raw) ? raw : null
    return [
      {
        label: tr('grid.editValue'),
        disabled: !editable || saving || isBinaryCell(raw),
        onSelect: () =>
          setEdit({
            rowIndex: cell.rowIndex,
            column: cell.column,
            value: isNull ? '' : String(raw)
          })
      },
      {
        label: tr('grid.copyValue'),
        disabled: isNull,
        separatorBefore: true,
        onSelect: () => void window.dbApi.clipboardWrite(isNull ? '' : String(raw))
      },
      {
        label: tr('grid.copyRow'),
        onSelect: () => void window.dbApi.clipboardWrite(JSON.stringify(row, null, 2))
      },
      {
        label: tr('grid.previewBinary'),
        disabled: !binary,
        onSelect: () => setPreview(binary)
      }
    ]
  }

  return (
    <div className="qres">
      <div className="qres__head">
        <span className="qres__count">
          {result.kind === 'command'
            ? tr('query.affected', { count: result.rowCount })
            : tr('query.rows', { count: result.rowCount })}
          {result.truncated ? ` · ${tr('query.truncated')}` : ''}
        </span>
        {editable && <span className="qres__editable">{tr('query.editable')}</span>}
        <span className="qres__actions">
          <button
            className="btn btn--ghost btn--tiny"
            onClick={() => void exportAs('csv')}
            disabled={exporting}
            title={tr('query.exportCsv')}
          >
            CSV
          </button>
          <button
            className="btn btn--ghost btn--tiny"
            onClick={() => void exportAs('json')}
            disabled={exporting}
            title={tr('query.exportJson')}
          >
            JSON
          </button>
        </span>
      </div>

      {note && (
        <p className="muted qres__note" role="status">
          {note}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="muted qres__empty">{tr('query.noRows')}</p>
      ) : (
        <div className="table-scroll table-scroll--short">
          <table className="data-table" style={{ width: totalWidth }}>
            <colgroup>
              {result.columns.map((c) => (
                <col key={c.name} style={{ width: widthOf(c.name) }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {result.columns.map((c) => (
                  <th
                    key={c.name}
                    className="th-col"
                    aria-sort={
                      sort?.column === c.name
                        ? sort.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <button
                      className="th-btn"
                      onClick={() => toggleSort(c.name)}
                      title={tr('query.sortHint')}
                    >
                      <span className="th-name">{c.name}</span>
                      {sort?.column === c.name && (
                        <span className="th-sort" aria-hidden="true">
                          {sort.dir === 'asc' ? '▲' : '▼'}
                        </span>
                      )}
                    </button>
                    <span
                      className="col-resizer"
                      onMouseDown={(e) => startResize(e, c.name)}
                      onKeyDown={(e) => resizeByKeyboard(e, c.name)}
                      tabIndex={0}
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={tr('query.resizeColumn', { name: c.name })}
                      title={tr('query.resizeHint')}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {result.columns.map((c) => {
                    const raw = row[c.name]
                    const isEditing =
                      edit?.rowIndex === rowIndex && edit.column === c.name
                    return (
                      <td
                        key={c.name}
                        className="cell"
                        onDoubleClick={() => {
                          if (!editable || saving || isBinaryCell(raw)) return
                          setEdit({
                            rowIndex,
                            column: c.name,
                            value: raw === null || raw === undefined ? '' : String(raw)
                          })
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          setMenu({
                            x: e.clientX,
                            y: e.clientY,
                            rowIndex,
                            column: c.name
                          })
                        }}
                      >
                        {isEditing ? (
                          <input
                            className="cell-input"
                            autoFocus
                            value={edit.value}
                            onChange={(e) => setEdit({ ...edit, value: e.target.value })}
                            onBlur={() => void commitEdit()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void commitEdit()
                              if (e.key === 'Escape') setEdit(null)
                            }}
                          />
                        ) : raw === null || raw === undefined ? (
                          <span className="cell-null">NULL</span>
                        ) : isBinaryCell(raw) ? (
                          <button
                            className="blob-badge"
                            onClick={() => setPreview(raw)}
                            title={tr('grid.previewBinary')}
                          >
                            {raw.kind === 'image' && raw.dataUrl ? (
                              <img
                                className="blob-badge__thumb"
                                src={raw.dataUrl}
                                alt=""
                              />
                            ) : (
                              <span className="blob-badge__icon" aria-hidden="true">
                                BLOB
                              </span>
                            )}
                            <span className="blob-badge__size">
                              {formatBytes(raw.size)}
                            </span>
                          </button>
                        ) : (
                          String(raw)
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu)}
          onClose={() => setMenu(null)}
        />
      )}

      {preview && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={tr('grid.previewBinary')}
          onClick={() => setPreview(null)}
        >
          <div className="modal modal--preview" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <h2>{tr('grid.previewBinary')}</h2>
              <button
                className="btn btn--ghost btn--small"
                onClick={() => setPreview(null)}
              >
                {tr('common.close')}
              </button>
            </div>
            <p className="muted preview__meta">
              {preview.mime} · {formatBytes(preview.size)}
            </p>
            {preview.kind === 'image' && preview.dataUrl ? (
              <div className="preview__image">
                <img src={preview.dataUrl} alt="" />
              </div>
            ) : preview.kind === 'text' && preview.text !== undefined ? (
              <pre className="sql-preview preview__text">{preview.text}</pre>
            ) : (
              <pre className="sql-preview preview__hex">{preview.hex}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
