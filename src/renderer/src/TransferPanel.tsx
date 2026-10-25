import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  StoredConnection,
  TableInfo,
  TransferColumnMapping,
  TransferPreview,
  TransferProgress,
  TransferResult
} from '@shared/types'
import { unwrap } from './api'
import { useLocale } from './i18n'

interface Props {
  connections: StoredConnection[]
  initialSource?: {
    connectionId: string
    database: string
    schema?: string
    table: string
  }
  onClose?: () => void
}

interface EndpointState {
  connectionId: string
  database: string
  schema?: string
  table: string
}

const EMPTY_ENDPOINT: EndpointState = { connectionId: '', database: '', table: '' }

let runSeq = 0

function nextTransferId(): string {
  runSeq += 1
  return `transfer-${Date.now()}-${runSeq}`
}

export function TransferPanel({
  connections,
  initialSource,
  onClose
}: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [source, setSource] = useState<EndpointState>(
    initialSource ? { ...initialSource } : EMPTY_ENDPOINT
  )
  const [target, setTarget] = useState<EndpointState>(EMPTY_ENDPOINT)
  const [targetCreate, setTargetCreate] = useState(true)
  const [targetTruncate, setTargetTruncate] = useState(false)
  const [batchSize, setBatchSize] = useState(500)
  const [dryRun, setDryRun] = useState(true)

  const [preview, setPreview] = useState<TransferPreview | null>(null)
  const [mapping, setMapping] = useState<TransferColumnMapping[]>([])
  const [previewing, setPreviewing] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<TransferProgress | null>(null)
  const [result, setResult] = useState<TransferResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const activeId = useRef<string | null>(null)

  const [sourceDbs, setSourceDbs] = useState<string[]>([])
  const [sourceTables, setSourceTables] = useState<TableInfo[]>([])
  const [targetDbs, setTargetDbs] = useState<string[]>([])
  const [targetTables, setTargetTables] = useState<TableInfo[]>([])
  const [targetTableName, setTargetTableName] = useState('')

  // Progress is pushed from main while the transfer runs.
  useEffect(() => {
    const off = window.dbApi.onTransferProgress((event) => {
      if (event.transferId !== activeId.current) return
      setProgress(event.progress)
    })
    return off
  }, [])

  useEffect(() => {
    if (!source.connectionId) {
      setSourceDbs([])
      return
    }
    let cancelled = false
    unwrap(window.dbApi.listDatabases(source.connectionId))
      .then((found) => {
        if (cancelled) return
        setSourceDbs(found)
        setSource((prev) =>
          prev.database && found.includes(prev.database)
            ? prev
            : { ...prev, database: found[0] ?? '', table: '' }
        )
      })
      .catch((err) => {
        if (cancelled) return
        setSourceDbs([])
        // A disconnected connection is the usual cause; say so instead of
        // showing an empty dropdown with no explanation.
        setError(tr('transfer.sourceDbsFailed', { message: errorText(err) }))
      })
    return () => {
      cancelled = true
    }
  }, [source.connectionId])

  useEffect(() => {
    if (!target.connectionId) {
      setTargetDbs([])
      return
    }
    let cancelled = false
    unwrap(window.dbApi.listDatabases(target.connectionId))
      .then((found) => {
        if (cancelled) return
        setTargetDbs(found)
        setTarget((prev) =>
          prev.database && found.includes(prev.database)
            ? prev
            : { ...prev, database: found[0] ?? '', table: '' }
        )
      })
      .catch((err) => {
        if (cancelled) return
        setTargetDbs([])
        setError(tr('transfer.targetDbsFailed', { message: errorText(err) }))
      })
    return () => {
      cancelled = true
    }
  }, [target.connectionId])

  useEffect(() => {
    if (!source.connectionId || !source.database) {
      setSourceTables([])
      return
    }
    let cancelled = false
    unwrap(window.dbApi.listTables(source.connectionId, source.database, source.schema))
      .then((found) => {
        if (!cancelled) setSourceTables(found)
      })
      .catch(() => {
        if (!cancelled) setSourceTables([])
      })
    return () => {
      cancelled = true
    }
  }, [source.connectionId, source.database, source.schema])

  useEffect(() => {
    if (!target.connectionId || !target.database) {
      setTargetTables([])
      return
    }
    let cancelled = false
    unwrap(window.dbApi.listTables(target.connectionId, target.database, target.schema))
      .then((found) => {
        if (!cancelled) setTargetTables(found)
      })
      .catch(() => {
        if (!cancelled) setTargetTables([])
      })
    return () => {
      cancelled = true
    }
  }, [target.connectionId, target.database, target.schema])

  // A source table with the same name is the usual destination; prefill it so
  // the common case needs no typing.
  useEffect(() => {
    if (source.table && !targetTableName) setTargetTableName(source.table)
  }, [source.table, targetTableName])

  const loadPreview = useCallback(async (): Promise<void> => {
    if (!source.connectionId || !source.table) {
      setError(tr('transfer.needSource'))
      return
    }
    if (!target.connectionId || !target.database || !targetTableName) {
      setError(tr('transfer.needTarget'))
      return
    }
    setPreviewing(true)
    setError(null)
    setNotice(null)
    setResult(null)
    try {
      const found = await unwrap(
        window.dbApi.previewTransfer({
          source: {
            connectionId: source.connectionId,
            database: source.database,
            schema: source.schema,
            table: source.table
          },
          target: {
            connectionId: target.connectionId,
            database: target.database,
            schema: target.schema,
            table: targetTableName,
            createTable: targetCreate,
            truncateFirst: targetTruncate
          }
        })
      )
      setPreview(found)
      setMapping(found.suggestedMapping)
      setNotice(
        found.targetExists
          ? tr('transfer.targetExistsHint', {
              rows: found.rowCount,
              columns: found.sourceColumns.length
            })
          : tr('transfer.targetNewHint', { rows: found.rowCount })
      )
    } catch (err) {
      setPreview(null)
      setMapping([])
      setError(errorText(err))
    } finally {
      setPreviewing(false)
    }
  }, [source, target, targetTableName, targetCreate, targetTruncate])

  async function start(): Promise<void> {
    if (!preview) {
      setError(tr('transfer.needPreview'))
      return
    }
    const id = nextTransferId()
    activeId.current = id
    setRunning(true)
    setError(null)
    setNotice(null)
    setResult(null)
    setProgress(null)
    try {
      const outcome = await unwrap(
        window.dbApi.startTransfer({
          transferId: id,
          source: {
            connectionId: source.connectionId,
            database: source.database,
            schema: source.schema,
            table: source.table
          },
          target: {
            connectionId: target.connectionId,
            database: target.database,
            schema: target.schema,
            table: targetTableName,
            createTable: targetCreate,
            truncateFirst: targetTruncate
          },
          mapping,
          batchSize,
          dryRun
        })
      )
      setResult(outcome)
      setNotice(
        outcome.dryRun
          ? tr('transfer.dryRunDone')
          : tr('transfer.done', {
              rows: outcome.rowsWritten,
              batches: outcome.batches
            })
      )
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRunning(false)
      activeId.current = null
    }
  }

  const included = mapping.filter((m) => m.include)
  const canStart = Boolean(preview) && included.length > 0 && !running && !previewing

  function endpointLabel(connectionId: string): string {
    return connections.find((c) => c.id === connectionId)?.name ?? tr('sync.notChosen')
  }

  return (
    <div className="transfer">
      <div className="transfer__bar">
        <h2 className="grid-title">{tr('transfer.title')}</h2>
        <div className="transfer__bar-actions">
          <button
            className="btn btn--tiny btn--ghost"
            onClick={() => void loadPreview()}
            disabled={previewing || running}
          >
            {previewing ? tr('transfer.loadingPreview') : tr('transfer.loadPreview')}
          </button>
          {onClose && (
            <button className="btn btn--tiny btn--ghost" onClick={onClose}>
              {tr('common.close')}
            </button>
          )}
        </div>
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

      <div className="transfer__grid">
        <section className="transfer__card">
          <h3>{tr('transfer.source')}</h3>
          <label className="field">
            <span className="field__label">{tr('transfer.connection')}</span>
            <select
              className="input"
              value={source.connectionId}
              onChange={(e) =>
                setSource({
                  connectionId: e.target.value,
                  database: '',
                  schema: undefined,
                  table: ''
                })
              }
            >
              <option value="">{tr('transfer.choose')}</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.engine})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{tr('transfer.database')}</span>
            <select
              className="input"
              value={source.database}
              onChange={(e) =>
                setSource((prev) => ({ ...prev, database: e.target.value, table: '' }))
              }
              disabled={sourceDbs.length === 0}
            >
              {sourceDbs.length === 0 && <option value="">{tr('transfer.none')}</option>}
              {sourceDbs.map((db) => (
                <option key={db} value={db}>
                  {db}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{tr('transfer.table')}</span>
            <select
              className="input"
              value={source.table}
              onChange={(e) => setSource((prev) => ({ ...prev, table: e.target.value }))}
              disabled={sourceTables.length === 0}
            >
              <option value="">
                {sourceTables.length === 0
                  ? tr('transfer.noTable')
                  : tr('transfer.pickTable')}
              </option>
              {sourceTables.map((t) => (
                <option key={`${t.schema ?? ''}.${t.name}`} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="transfer__card">
          <h3>{tr('transfer.target')}</h3>
          <label className="field">
            <span className="field__label">{tr('transfer.connection')}</span>
            <select
              className="input"
              value={target.connectionId}
              onChange={(e) =>
                setTarget({
                  connectionId: e.target.value,
                  database: '',
                  schema: undefined,
                  table: ''
                })
              }
            >
              <option value="">{tr('transfer.choose')}</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.engine})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{tr('transfer.database')}</span>
            <select
              className="input"
              value={target.database}
              onChange={(e) =>
                setTarget((prev) => ({ ...prev, database: e.target.value, table: '' }))
              }
              disabled={targetDbs.length === 0}
            >
              {targetDbs.length === 0 && <option value="">{tr('transfer.none')}</option>}
              {targetDbs.map((db) => (
                <option key={db} value={db}>
                  {db}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{tr('transfer.targetTable')}</span>
            <input
              className="input"
              value={targetTableName}
              onChange={(e) => setTargetTableName(e.target.value)}
              placeholder={tr('transfer.targetTablePlaceholder')}
              spellCheck={false}
              list="transfer-target-tables"
            />
            <datalist id="transfer-target-tables">
              {targetTables.map((t) => (
                <option key={`${t.schema ?? ''}.${t.name}`} value={t.name} />
              ))}
            </datalist>
            <span className="field__hint">
              {targetTables.some((t) => t.name === targetTableName)
                ? tr('transfer.targetExists')
                : tr('transfer.targetNew')}
            </span>
          </label>
          <div className="transfer__checks">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={targetCreate}
                onChange={(e) => setTargetCreate(e.target.checked)}
              />
              {tr('transfer.createTable')}
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={targetTruncate}
                onChange={(e) => setTargetTruncate(e.target.checked)}
              />
              {tr('transfer.emptyTarget')}
            </label>
          </div>
        </section>
      </div>

      <div className="transfer__options">
        <label className="transfer__inline">
          <span className="field__label">{tr('transfer.batch')}</span>
          <input
            className="input transfer__batch"
            type="number"
            min={1}
            max={2000}
            value={batchSize}
            onChange={(e) => {
              const parsed = Number(e.target.value)
              setBatchSize(
                Number.isFinite(parsed) ? Math.max(1, Math.min(2000, parsed)) : 500
              )
            }}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
          />
          {tr('transfer.dryRun')}
        </label>
        <button
          className="btn btn--small"
          onClick={() => void start()}
          disabled={!canStart}
        >
          {running
            ? tr('transfer.moving')
            : dryRun
              ? tr('transfer.validate')
              : tr('transfer.start')}
        </button>
      </div>

      {preview && (
        <section className="transfer__card">
          <div className="transfer__bar">
            <h3>{tr('transfer.columnMapping')}</h3>
            <span className="muted">
              {preview.sourceEngine} → {preview.targetEngine} | {included.length}/
              {tr('transfer.columnCount', { count: mapping.length })}
            </span>
          </div>
          {preview.warnings.length > 0 && (
            <ul className="transfer__warnings">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <div className="table-scroll">
            <table className="data-table transfer__table">
              <thead>
                <tr>
                  <th>{tr('transfer.use')}</th>
                  <th>{tr('transfer.sourceColumn')}</th>
                  <th>{tr('transfer.sourceType')}</th>
                  <th>{tr('transfer.targetColumn')}</th>
                  <th>{tr('transfer.targetType')}</th>
                </tr>
              </thead>
              <tbody>
                {mapping.map((row, index) => {
                  const sourceColumn = preview.sourceColumns.find(
                    (c) => c.name === row.source
                  )
                  const targetColumn = preview.targetColumns?.find(
                    (c) => c.name === row.target
                  )
                  return (
                    <tr key={`${row.source}-${index}`}>
                      <td>
                        <input
                          type="checkbox"
                          checked={row.include}
                          onChange={(e) => {
                            const next = [...mapping]
                            next[index] = { ...next[index], include: e.target.checked }
                            setMapping(next)
                          }}
                          aria-label={`Sertakan ${row.source}`}
                        />
                      </td>
                      <td>{row.source}</td>
                      <td className="muted">{sourceColumn?.dataType ?? '-'}</td>
                      <td>
                        <input
                          className="input transfer__target-input"
                          value={row.target}
                          onChange={(e) => {
                            const next = [...mapping]
                            next[index] = { ...next[index], target: e.target.value }
                            setMapping(next)
                          }}
                          spellCheck={false}
                          aria-label={tr('transfer.targetColumnLabel', {
                            source: row.source
                          })}
                        />
                      </td>
                      <td className="muted">
                        {targetColumn?.dataType ??
                          preview.plannedTypes[row.target] ??
                          tr('transfer.newType')}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(progress || result) && (
        <section className="transfer__card">
          <h3>Status</h3>
          {progress && (
            <p className="transfer__progress" role="status">
              {progress.phase === 'preparing'
                ? 'Menyiapkan...'
                : progress.phase === 'done'
                  ? 'Selesai'
                  : `Batch ${progress.batches}: ${progress.rowsRead} dibaca, ${progress.rowsWritten} ditulis`}
            </p>
          )}
          {result && (
            <ul className="transfer__result">
              <li>Baris dibaca: {result.rowsRead}</li>
              <li>Baris ditulis: {result.rowsWritten}</li>
              <li>Batch: {result.batches}</li>
              <li>Durasi: {result.durationMs} ms</li>
              <li>
                {tr('transfer.tableCreated', {
                  value: result.tableCreated ? tr('transfer.yes') : tr('transfer.no')
                })}
              </li>
              <li>
                {tr('transfer.truncatedFirst', {
                  value: result.truncated ? tr('transfer.yes') : tr('transfer.no')
                })}
              </li>
              {result.dryRun && <li>{tr('transfer.modeDryRun')}</li>}
              {result.warnings.map((warning) => (
                <li key={warning} className="transfer__warning">
                  {warning}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {source.table && (
        <p className="muted transfer__summary">
          {endpointLabel(source.connectionId)}:{source.database}.{source.table} →{' '}
          {endpointLabel(target.connectionId)}:{target.database || '?'}.
          {targetTableName || '?'}
        </p>
      )}
    </div>
  )
}
