import { useEffect, useState } from 'react'
import type { ColumnInfo, ExportFormat, ImportPreview } from '@shared/types'
import { unwrap } from './api'
import { useLocale } from './i18n'
import type { SelectedTable } from './ExplorerTree'

interface Props {
  selection: SelectedTable
}

type Tab = 'export' | 'importCsv' | 'importSql'

export function IoPanel({ selection }: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [tab, setTab] = useState<Tab>('export')
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // export
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [exporting, setExporting] = useState(false)

  // import csv
  const [csvPath, setCsvPath] = useState<string | null>(null)
  const [delimiter, setDelimiter] = useState(',')
  const [hasHeader, setHasHeader] = useState(true)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [mapping, setMapping] = useState<Record<string, string | null>>({})
  const [importing, setImporting] = useState(false)

  // import sql
  const [sqlPath, setSqlPath] = useState<string | null>(null)
  const [runningSql, setRunningSql] = useState(false)

  useEffect(() => {
    setPreview(null)
    setCsvPath(null)
    setSqlPath(null)
    setError(null)
    setMessage(null)
    unwrap(
      window.dbApi.listColumns(
        selection.connectionId,
        selection.database,
        selection.table,
        selection.schema
      )
    )
      .then(setColumns)
      .catch(() => setColumns([]))
  }, [selection])

  async function handleExport(): Promise<void> {
    setError(null)
    setMessage(null)
    const defaultPath = `${selection.table}.${format}`
    const chosen = await unwrap(window.dbApi.saveFileDialog(defaultPath))
    if (!chosen) return
    setExporting(true)
    try {
      const result = await unwrap(
        window.dbApi.exportTable({
          connectionId: selection.connectionId,
          database: selection.database,
          schema: selection.schema,
          table: selection.table,
          format,
          filePath: chosen
        })
      )
      setMessage(tr('io.exportDone', { rows: result.rowsWritten, file: chosen }))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setExporting(false)
    }
  }

  async function handlePickCsv(): Promise<void> {
    setError(null)
    const chosen = await unwrap(
      window.dbApi.openFileDialog([{ name: 'CSV', extensions: ['csv', 'txt'] }])
    )
    if (!chosen) return
    setCsvPath(chosen)
    await refreshPreview(chosen, delimiter, hasHeader)
  }

  async function refreshPreview(
    path: string,
    delim: string,
    header: boolean
  ): Promise<void> {
    setError(null)
    setMessage(null)
    try {
      const result = await unwrap(window.dbApi.previewImport(path, delim, header))
      setPreview(result)
      const initial: Record<string, string | null> = {}
      result.headers.forEach((h, i) => {
        const match = columns.find((c) => c.name.toLowerCase() === h.toLowerCase())
        initial[h] = match ? match.name : (columns[i]?.name ?? null)
      })
      setMapping(initial)
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function handleImportCsv(): Promise<void> {
    if (!csvPath || !preview) return
    setError(null)
    setMessage(null)
    setImporting(true)
    try {
      const result = await unwrap(
        window.dbApi.importCsv({
          connectionId: selection.connectionId,
          database: selection.database,
          schema: selection.schema,
          table: selection.table,
          filePath: csvPath,
          delimiter,
          hasHeader,
          mapping
        })
      )
      const extra = result.firstError ? ` Error pertama: ${result.firstError}` : ''
      setMessage(
        tr('io.importDone', {
          rows: result.rowsInserted,
          failed: result.failed,
          extra
        })
      )
    } catch (err) {
      setError(errorText(err))
    } finally {
      setImporting(false)
    }
  }

  async function handlePickSql(): Promise<void> {
    setError(null)
    const chosen = await unwrap(
      window.dbApi.openFileDialog([{ name: 'SQL', extensions: ['sql', 'txt'] }])
    )
    if (chosen) setSqlPath(chosen)
  }

  async function handleImportSql(): Promise<void> {
    if (!sqlPath) return
    setError(null)
    setMessage(null)
    setRunningSql(true)
    try {
      const result = await unwrap(
        window.dbApi.importSql({
          connectionId: selection.connectionId,
          filePath: sqlPath
        })
      )
      setMessage(tr('io.importSqlDone', { count: result.statements }))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRunningSql(false)
    }
  }

  return (
    <div className="struct">
      <h2 className="grid-title">
        Import / Export: {selection.database}
        {selection.schema ? `.${selection.schema}` : ''}.{selection.table}
      </h2>

      <div className="subtabs">
        <button
          className={`subtab${tab === 'export' ? ' is-active' : ''}`}
          onClick={() => setTab('export')}
        >
          {tr('io.export')}
        </button>
        <button
          className={`subtab${tab === 'importCsv' ? ' is-active' : ''}`}
          onClick={() => setTab('importCsv')}
        >
          {tr('io.importCsv')}
        </button>
        <button
          className={`subtab${tab === 'importSql' ? ' is-active' : ''}`}
          onClick={() => setTab('importSql')}
        >
          {tr('io.importSql')}
        </button>
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

      {tab === 'export' && (
        <div className="struct__form">
          <label className="field field--narrow">
            <span className="field__label">{tr('io.format')}</span>
            <select
              className="input"
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
            >
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
              <option value="sql">SQL (INSERT)</option>
            </select>
          </label>
          <button
            className="btn btn--small"
            onClick={() => void handleExport()}
            disabled={exporting}
          >
            {exporting ? 'Mengekspor...' : tr('io.chooseFileAndExport')}
          </button>
        </div>
      )}

      {tab === 'importCsv' && (
        <div className="struct__form">
          <div className="field-row">
            <label className="field">
              <span className="field__label">{tr('io.csvFile')}</span>
              <input
                className="input"
                value={csvPath ?? ''}
                readOnly
                placeholder={tr('io.notChosen')}
              />
            </label>
            <button
              className="btn btn--ghost btn--small"
              onClick={() => void handlePickCsv()}
            >
              {tr('io.chooseFile')}
            </button>
          </div>
          <div className="field-row">
            <label className="field field--narrow">
              <span className="field__label">{tr('io.delimiter')}</span>
              <input
                className="input"
                value={delimiter}
                onChange={(e) => setDelimiter(e.target.value)}
                maxLength={4}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={hasHeader}
                onChange={(e) => {
                  setHasHeader(e.target.checked)
                  if (csvPath) void refreshPreview(csvPath, delimiter, e.target.checked)
                }}
              />
              <span>{tr('io.firstRowHeader')}</span>
            </label>
            {csvPath && (
              <button
                className="btn btn--ghost btn--small"
                onClick={() => void refreshPreview(csvPath, delimiter, hasHeader)}
              >
                {tr('io.reloadPreview')}
              </button>
            )}
          </div>

          {preview && (
            <>
              <span className="field__label">
                Mapping kolom (CSV &rarr; tabel). Preview {preview.sampledRows} baris.
              </span>
              <div className="table-scroll table-scroll--short">
                <table className="data-table">
                  <thead>
                    <tr>
                      {preview.headers.map((h) => (
                        <th key={h} className="th-plain">
                          <div className="map-head">{h}</div>
                          <select
                            className="input"
                            value={mapping[h] ?? ''}
                            onChange={(e) =>
                              setMapping((prev) => ({
                                ...prev,
                                [h]: e.target.value || null
                              }))
                            }
                          >
                            <option value="">{tr('io.skipColumn')}</option>
                            {columns.map((c) => (
                              <option key={c.name} value={c.name}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, i) => (
                      <tr key={i}>
                        {preview.headers.map((h, j) => (
                          <td key={h} className="cell">
                            {row[j] ?? ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                className="btn btn--small"
                onClick={() => void handleImportCsv()}
                disabled={importing}
              >
                {importing ? 'Mengimpor...' : tr('io.importNow')}
              </button>
            </>
          )}
        </div>
      )}

      {tab === 'importSql' && (
        <div className="struct__form">
          <div className="field-row">
            <label className="field">
              <span className="field__label">{tr('io.sqlFile')}</span>
              <input
                className="input"
                value={sqlPath ?? ''}
                readOnly
                placeholder={tr('io.notChosen')}
              />
            </label>
            <button
              className="btn btn--ghost btn--small"
              onClick={() => void handlePickSql()}
            >
              {tr('io.chooseFile')}
            </button>
          </div>
          <p className="field__label">{tr('io.sqlWholeFile')}</p>
          <button
            className="btn btn--small"
            onClick={() => void handleImportSql()}
            disabled={!sqlPath || runningSql}
          >
            {runningSql ? 'Menjalankan...' : tr('io.runImport')}
          </button>
        </div>
      )}
    </div>
  )
}
