import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DataSyncPreview,
  DataSyncResult,
  StoredConnection,
  StructureChange,
  StructureSyncPreview,
  StructureSyncResult,
  SyncEndpoint,
  SyncMode,
  SyncProfile,
  SyncProgress,
  TableInfo
} from '@shared/types'
import { DEFAULT_DATA_OPTIONS, DEFAULT_STRUCTURE_OPTIONS } from '@shared/types'
import { buildDdl } from '@shared/ddl'
import { unwrap } from './api'
import { confirmAction, confirmDestructive } from './confirm'
import { PromptDialog } from './PromptDialog'
import { t } from '@shared/i18n'
import { readStoredLocale } from './localeStore'
import { useLocale } from './i18n'
import type { MessageKey, MessageParams } from '@shared/i18n'

type Tr = (key: MessageKey, params?: MessageParams) => string

interface Props {
  connections: StoredConnection[]
  initialSource?: { connectionId: string; database?: string; schema?: string }
  onClose?: () => void
}

type Preview =
  | { mode: 'structure'; structure: StructureSyncPreview }
  | { mode: 'data'; data: DataSyncPreview }

type RunResult =
  | { mode: 'structure'; structure: StructureSyncResult }
  | { mode: 'data'; data: DataSyncResult }

const EMPTY_ENDPOINT: SyncEndpoint = { connectionId: '', database: '' }

let runSeq = 0

function nextSyncId(): string {
  runSeq += 1
  return `sync-${Date.now()}-${runSeq}`
}

function changeLabels(tr: Tr): Record<StructureChange['kind'], string> {
  return {
    createTable: tr('sync.changeCreateTable'),
    dropTable: tr('sync.changeDropTable'),
    addColumn: tr('sync.changeAddColumn'),
    dropColumn: tr('sync.changeDropColumn'),
    modifyColumn: tr('sync.changeModifyColumn'),
    createIndex: tr('sync.changeCreateIndex'),
    dropIndex: tr('sync.changeDropIndex'),
    createForeignKey: tr('sync.changeCreateFk'),
    dropForeignKey: tr('sync.changeDropFk'),
    primaryKey: tr('sync.changePk')
  }
}

function severityLabels(tr: Tr): Record<StructureChange['severity'], string> {
  return {
    info: tr('sync.severityInfo'),
    warning: tr('sync.severityWarning'),
    destructive: tr('sync.severityDestructive'),
    unsupported: tr('sync.notSupported')
  }
}

function dataStatusLabels(tr: Tr): Record<string, string> {
  return {
    missing: tr('sync.missingInTarget'),
    different: tr('sync.different'),
    same: tr('sync.same'),
    unsupported: tr('sync.notSupported')
  }
}

interface EndpointPickerProps {
  title: string
  connections: StoredConnection[]
  value: SyncEndpoint
  databases: string[]
  schemas: string[]
  loading: boolean
  disabled?: boolean
  onChange: (next: SyncEndpoint) => void
}

function EndpointPicker({
  title,
  connections,
  value,
  databases,
  schemas,
  loading,
  disabled,
  onChange
}: EndpointPickerProps): JSX.Element {
  const { tr } = useLocale()
  return (
    <section className="sync__card">
      <h3>{title}</h3>
      <label className="field">
        <span className="field__label">{tr('sync.connection')}</span>
        <select
          className="input"
          value={value.connectionId}
          disabled={disabled}
          onChange={(e) =>
            onChange({ connectionId: e.target.value, database: '', schema: undefined })
          }
        >
          <option value="">{tr('sync.choose')}</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.engine})
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field__label">{tr('sync.database')}</span>
        <select
          className="input"
          value={value.database}
          disabled={disabled || databases.length === 0}
          onChange={(e) =>
            onChange({ ...value, database: e.target.value, schema: undefined })
          }
        >
          <option value="">
            {loading
              ? tr('sync.tablesLoading')
              : databases.length === 0
                ? tr('common.none')
                : tr('sync.choose')}
          </option>
          {databases.map((db) => (
            <option key={db} value={db}>
              {db}
            </option>
          ))}
        </select>
      </label>
      {schemas.length > 0 && (
        <label className="field">
          <span className="field__label">{tr('sync.schema')}</span>
          <select
            className="input"
            value={value.schema ?? ''}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, schema: e.target.value || undefined })}
          >
            <option value="">{tr('sync.defaultConnection')}</option>
            {schemas.map((schema) => (
              <option key={schema} value={schema}>
                {schema}
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  )
}

export function SyncPanel({ connections, initialSource, onClose }: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [mode, setMode] = useState<SyncMode>('structure')
  const [source, setSource] = useState<SyncEndpoint>(
    initialSource
      ? {
          connectionId: initialSource.connectionId,
          database: initialSource.database ?? '',
          schema: initialSource.schema
        }
      : EMPTY_ENDPOINT
  )
  const [target, setTarget] = useState<SyncEndpoint>(EMPTY_ENDPOINT)

  const [sourceDbs, setSourceDbs] = useState<string[]>([])
  const [targetDbs, setTargetDbs] = useState<string[]>([])
  const [sourceSchemas, setSourceSchemas] = useState<string[]>([])
  const [targetSchemas, setTargetSchemas] = useState<string[]>([])
  const [dbsLoading, setDbsLoading] = useState(false)

  const [sourceTables, setSourceTables] = useState<TableInfo[]>([])
  const [targetTables, setTargetTables] = useState<TableInfo[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [allTables, setAllTables] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [structureOptions, setStructureOptions] = useState({
    ...DEFAULT_STRUCTURE_OPTIONS
  })
  const [dataOptions, setDataOptions] = useState({ ...DEFAULT_DATA_OPTIONS })
  const [dryRun, setDryRun] = useState(false)

  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [running, setRunning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const activeId = useRef<string | null>(null)

  const [profiles, setProfiles] = useState<SyncProfile[]>([])
  const [profilesLoading, setProfilesLoading] = useState(true)
  const [profileName, setProfileName] = useState<string | null>(null)
  const [savingProfile, setSavingProfile] = useState(false)
  const [loadedProfileId, setLoadedProfileId] = useState<string | undefined>()

  const loadProfiles = useCallback(async (): Promise<void> => {
    setProfilesLoading(true)
    try {
      setProfiles(await unwrap(window.dbApi.listSyncProfiles()))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setProfilesLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadProfiles()
  }, [loadProfiles])

  // Progress is pushed from main while a deploy runs. Events for another sync
  // (a second window, or a run that already finished) are ignored.
  useEffect(() => {
    return window.dbApi.onSyncProgress((event) => {
      if (event.syncId !== activeId.current) return
      setProgress(event)
    })
  }, [])

  useEffect(() => {
    if (!source.connectionId) {
      setSourceDbs([])
      setSourceSchemas([])
      return
    }
    let cancelled = false
    setDbsLoading(true)
    unwrap(window.dbApi.listDatabases(source.connectionId))
      .then((found) => {
        if (cancelled) return
        setSourceDbs(found)
        setSource((prev) =>
          prev.database && found.includes(prev.database)
            ? prev
            : { ...prev, database: found[0] ?? '', schema: undefined }
        )
      })
      .catch((err) => {
        if (cancelled) return
        setSourceDbs([])
        setError(tr('sync.errSourceDbs', { message: errorText(err) }))
      })
      .finally(() => {
        if (!cancelled) setDbsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [source.connectionId])

  useEffect(() => {
    if (!target.connectionId) {
      setTargetDbs([])
      setTargetSchemas([])
      return
    }
    let cancelled = false
    setDbsLoading(true)
    unwrap(window.dbApi.listDatabases(target.connectionId))
      .then((found) => {
        if (cancelled) return
        setTargetDbs(found)
        setTarget((prev) =>
          prev.database && found.includes(prev.database)
            ? prev
            : { ...prev, database: found[0] ?? '', schema: undefined }
        )
      })
      .catch((err) => {
        if (cancelled) return
        setTargetDbs([])
        setError(tr('sync.errTargetDbs', { message: errorText(err) }))
      })
      .finally(() => {
        if (!cancelled) setDbsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [target.connectionId])

  useEffect(() => {
    if (!source.connectionId || !source.database) {
      setSourceSchemas([])
      return
    }
    let cancelled = false
    unwrap(window.dbApi.listSchemas(source.connectionId, source.database))
      .then((found) => {
        if (cancelled) return
        setSourceSchemas(found)
        // Keep the connection's own default schema unless the user picked one.
        // Auto-selecting the first entry would silently point an Oracle sync at
        // another user's schema.
        setSource((prev) =>
          prev.schema && !found.includes(prev.schema)
            ? { ...prev, schema: undefined }
            : prev
        )
      })
      .catch(() => {
        if (!cancelled) setSourceSchemas([])
      })
    return () => {
      cancelled = true
    }
  }, [source.connectionId, source.database])

  useEffect(() => {
    if (!target.connectionId || !target.database) {
      setTargetSchemas([])
      return
    }
    let cancelled = false
    unwrap(window.dbApi.listSchemas(target.connectionId, target.database))
      .then((found) => {
        if (cancelled) return
        setTargetSchemas(found)
        setTarget((prev) =>
          prev.schema && !found.includes(prev.schema)
            ? { ...prev, schema: undefined }
            : prev
        )
      })
      .catch(() => {
        if (!cancelled) setTargetSchemas([])
      })
    return () => {
      cancelled = true
    }
  }, [target.connectionId, target.database])

  useEffect(() => {
    if (!source.connectionId || !source.database) {
      setSourceTables([])
      return
    }
    let cancelled = false
    setTablesLoading(true)
    unwrap(window.dbApi.listTables(source.connectionId, source.database, source.schema))
      .then((found) => {
        if (!cancelled) setSourceTables(found.filter((t) => t.type === 'table'))
      })
      .catch(() => {
        if (!cancelled) setSourceTables([])
      })
      .finally(() => {
        if (!cancelled) setTablesLoading(false)
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
        if (!cancelled) setTargetTables(found.filter((t) => t.type === 'table'))
      })
      .catch(() => {
        if (!cancelled) setTargetTables([])
      })
    return () => {
      cancelled = true
    }
  }, [target.connectionId, target.database, target.schema])

  // A custom selection starts from every source table; the user then unchecks
  // what must not be touched. An empty selection would mean "all tables" again,
  // so it is never left empty by the toggles.
  function setAllTablesMode(next: boolean): void {
    setAllTables(next)
    if (!next && selected.size === 0) {
      setSelected(new Set(sourceTables.map((t) => t.name)))
    }
    setPreview(null)
    setResult(null)
  }

  function toggleTable(name: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
    setPreview(null)
    setResult(null)
  }

  function resetRunState(): void {
    setPreview(null)
    setResult(null)
    setProgress(null)
    setNotice(null)
  }

  const tableNames = useMemo(() => {
    const names = new Set<string>()
    for (const table of sourceTables) names.add(table.name)
    for (const table of targetTables) names.add(table.name)
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [sourceTables, targetTables])

  const sourceSet = useMemo(
    () => new Set(sourceTables.map((t) => t.name)),
    [sourceTables]
  )
  const targetSet = useMemo(
    () => new Set(targetTables.map((t) => t.name)),
    [targetTables]
  )

  const sameEndpoint =
    Boolean(source.connectionId) &&
    source.connectionId === target.connectionId &&
    source.database === target.database &&
    (source.schema ?? '') === (target.schema ?? '')

  const ready =
    Boolean(source.connectionId && source.database) &&
    Boolean(target.connectionId && target.database) &&
    !sameEndpoint

  const tablesArg = allTables ? [] : [...selected].sort()

  const loadPreview = useCallback(async (): Promise<void> => {
    if (!ready) {
      setError(tr('sync.needEndpoints'))
      return
    }
    if (!allTables && tablesArg.length === 0) {
      setError(tr('sync.needTables'))
      return
    }
    setPreviewing(true)
    setError(null)
    setNotice(null)
    setResult(null)
    try {
      if (mode === 'structure') {
        const found = await unwrap(
          window.dbApi.previewStructureSync({
            source,
            target,
            tables: tablesArg,
            options: structureOptions
          })
        )
        setPreview({ mode: 'structure', structure: found })
        const changedTables = found.tables.filter((t) => t.changeCount > 0).length
        const runnable = found.changes.filter((c) => c.operations.length > 0).length
        setNotice(
          changedTables === 0
            ? tr('sync.noStructureDiffNotice')
            : tr('sync.structureSummary', {
                changes: found.changes.length,
                tables: changedTables,
                runnable
              })
        )
      } else {
        const found = await unwrap(
          window.dbApi.previewDataSync({
            source,
            target,
            tables: tablesArg,
            options: dataOptions
          })
        )
        setPreview({ mode: 'data', data: found })
        const totals = found.tables.reduce(
          (sum, t) => ({
            inserts: sum.inserts + t.inserts,
            updates: sum.updates + t.updates,
            deletes: sum.deletes + t.deletes
          }),
          { inserts: 0, updates: 0, deletes: 0 }
        )
        const differing = found.tables.filter((t) => t.status === 'different').length
        const unsupported = found.tables.filter((t) => t.status === 'unsupported').length
        setNotice(
          differing === 0
            ? tr('sync.noDataDiffNotice')
            : tr('sync.dataSummary', {
                inserts: totals.inserts,
                updates: totals.updates,
                deletes: totals.deletes,
                tables: differing
              }) +
                (unsupported > 0
                  ? tr('sync.dataSummarySkipped', { count: unsupported })
                  : '.')
        )
      }
    } catch (err) {
      setPreview(null)
      setError(errorText(err))
    } finally {
      setPreviewing(false)
    }
  }, [ready, allTables, tablesArg, mode, source, target, structureOptions, dataOptions])

  async function startRun(): Promise<void> {
    if (!preview) {
      setError(tr('sync.needPreview'))
      return
    }
    if (!dryRun) {
      const chosen = await confirmAction({
        title: tr('sync.runTitle'),
        message:
          mode === 'structure'
            ? tr('sync.runMessageStructure')
            : tr('sync.runMessageData'),
        detail:
          mode === 'structure' ? tr('sync.runDetailStructure') : tr('sync.runDetailData'),
        actions: [{ label: t(readStoredLocale(), 'action.run'), primary: true }]
      })
      if (!chosen) return
    }

    const id = nextSyncId()
    activeId.current = id
    setRunning(true)
    setCancelling(false)
    setError(null)
    setNotice(null)
    setResult(null)
    setProgress(null)
    try {
      if (mode === 'structure') {
        const outcome = await unwrap(
          window.dbApi.runStructureSync({
            syncId: id,
            source,
            target,
            tables: tablesArg,
            options: structureOptions,
            dryRun
          })
        )
        setResult({ mode: 'structure', structure: outcome })
        setNotice(
          outcome.dryRun
            ? tr('sync.dryRunDone')
            : tr('sync.structureDone', {
                applied: outcome.applied,
                statements: outcome.statements,
                failed: outcome.failed,
                skipped: outcome.skipped
              })
        )
      } else {
        const outcome = await unwrap(
          window.dbApi.runDataSync({
            syncId: id,
            source,
            target,
            tables: tablesArg,
            options: dataOptions,
            dryRun
          })
        )
        setResult({ mode: 'data', data: outcome })
        setNotice(
          outcome.dryRun
            ? tr('sync.dryRunDoneRows')
            : tr('sync.dataDone', {
                inserted: outcome.inserted,
                updated: outcome.updated,
                deleted: outcome.deleted,
                failed: outcome.failed
              })
        )
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRunning(false)
      setCancelling(false)
      activeId.current = null
    }
  }

  async function cancelRun(): Promise<void> {
    const id = activeId.current
    if (!id) return
    setCancelling(true)
    try {
      await unwrap(window.dbApi.cancelSync(id))
      setNotice(tr('sync.cancelSent'))
    } catch (err) {
      setError(errorText(err))
    }
  }

  function applyProfile(profile: SyncProfile): void {
    setMode(profile.mode)
    setSource(profile.source)
    setTarget(profile.target)
    if (profile.structureOptions) {
      setStructureOptions({ ...DEFAULT_STRUCTURE_OPTIONS, ...profile.structureOptions })
    }
    if (profile.dataOptions) {
      setDataOptions({ ...DEFAULT_DATA_OPTIONS, ...profile.dataOptions })
    }
    setAllTables(profile.tables.length === 0)
    setSelected(new Set(profile.tables))
    setLoadedProfileId(profile.id)
    resetRunState()
    setError(null)
  }

  async function saveProfile(name: string): Promise<void> {
    setProfileName(null)
    setSavingProfile(true)
    setError(null)
    try {
      // Renaming an existing profile saves it as a new one; overwriting the old
      // name silently would lose the profile the user started from.
      const loaded = profiles.find((p) => p.id === loadedProfileId)
      const saved = await unwrap(
        window.dbApi.saveSyncProfile({
          id: loaded && loaded.name === name ? loadedProfileId : undefined,
          name,
          mode,
          source,
          target,
          tables: tablesArg,
          structureOptions,
          dataOptions
        })
      )
      setLoadedProfileId(saved.id)
      await loadProfiles()
      setNotice(tr('sync.profileSaved', { name: saved.name }))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSavingProfile(false)
    }
  }

  async function removeProfile(profile: SyncProfile): Promise<void> {
    const proceed = await confirmDestructive(
      tr('sync.deleteProfileConfirm', { name: profile.name }),
      { title: tr('sync.deleteProfile'), detail: tr('sync.deleteProfileDetail') }
    )
    if (!proceed) return
    try {
      await unwrap(window.dbApi.deleteSyncProfile(profile.id))
      if (loadedProfileId === profile.id) setLoadedProfileId(undefined)
      await loadProfiles()
    } catch (err) {
      setError(errorText(err))
    }
  }

  const script = useMemo(() => {
    if (!preview || preview.mode !== 'structure') return []
    const engine = preview.structure.targetEngine
    return preview.structure.changes.flatMap((change) =>
      change.operations.flatMap((operation) => {
        try {
          return buildDdl(engine, operation).map((sql) => ({ table: change.table, sql }))
        } catch (err) {
          return [
            {
              table: change.table,
              sql: `-- ${err instanceof Error ? err.message : String(err)}`
            }
          ]
        }
      })
    )
  }, [preview])

  const changesBySeverity = useMemo(() => {
    if (!preview || preview.mode !== 'structure') {
      return { runnable: 0, destructive: 0, unsupported: 0, skipped: 0 }
    }
    let runnable = 0
    let destructive = 0
    let unsupported = 0
    let skipped = 0
    for (const change of preview.structure.changes) {
      if (change.severity === 'unsupported') unsupported += 1
      else if (change.operations.length === 0) skipped += 1
      else {
        runnable += 1
        if (change.severity === 'destructive') destructive += 1
      }
    }
    return { runnable, destructive, unsupported, skipped }
  }, [preview])

  function connectionName(connectionId: string): string {
    return connections.find((c) => c.id === connectionId)?.name ?? tr('sync.notChosen')
  }

  function endpointLabel(endpoint: SyncEndpoint): string {
    if (!endpoint.connectionId) return tr('sync.notChosenYet')
    const path = [endpoint.database, endpoint.schema].filter(Boolean).join('.')
    return `${connectionName(endpoint.connectionId)}:${path || '?'}`
  }

  const canPreview = ready && !previewing && !running
  const canRun = Boolean(preview) && !running && !previewing

  // Changing what will be compared invalidates the preview. Otherwise a user
  // could preview without "hapus baris", enable it, and run deletes that were
  // never shown. Deploy recomputes on the main side, so a stale preview is
  // only a display risk, but it is a misleading one.
  const compareSignature = useMemo(
    () =>
      JSON.stringify({
        mode,
        source,
        target,
        allTables,
        selected: [...selected].sort(),
        structureOptions,
        dataOptions
      }),
    [mode, source, target, allTables, selected, structureOptions, dataOptions]
  )
  const previewSignature = useRef<string | null>(null)

  useEffect(() => {
    if (previewSignature.current === null) {
      previewSignature.current = compareSignature
      return
    }
    if (previewSignature.current === compareSignature) return
    previewSignature.current = compareSignature
    setPreview(null)
    setResult(null)
    setProgress(null)
    setNotice(null)
  }, [compareSignature])
  return (
    <div className="sync">
      <div className="sync__bar">
        <div className="sync__heading">
          <h2 className="grid-title">{tr('sync.title')}</h2>
          <nav className="sync__modes" role="tablist" aria-label={tr('sync.modes')}>
            {(
              [
                ['structure', tr('sync.modeStructure')],
                ['data', tr('sync.modeData')]
              ] as [SyncMode, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={mode === id}
                className={`sync__mode${mode === id ? ' is-active' : ''}`}
                onClick={() => {
                  setMode(id)
                  resetRunState()
                }}
                disabled={running}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="sync__bar-actions">
          <button
            className="btn btn--small btn--ghost"
            onClick={() => void loadPreview()}
            disabled={!canPreview}
          >
            {previewing ? tr('sync.comparing') : tr('sync.loadPreview')}
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

      <div className="sync__grid">
        <EndpointPicker
          title={tr('sync.source')}
          connections={connections}
          value={source}
          databases={sourceDbs}
          schemas={sourceSchemas}
          loading={dbsLoading}
          disabled={running}
          onChange={(next) => {
            setSource(next)
            resetRunState()
          }}
        />
        <EndpointPicker
          title={tr('sync.target')}
          connections={connections}
          value={target}
          databases={targetDbs}
          schemas={targetSchemas}
          loading={dbsLoading}
          disabled={running}
          onChange={(next) => {
            setTarget(next)
            resetRunState()
          }}
        />
      </div>

      {sameEndpoint && (
        <p className="notice notice--info" role="status">
          {tr('sync.sameEndpoint')}
        </p>
      )}

      <section className="sync__card">
        <div className="sync__bar">
          <h3>{tr('sync.objects')}</h3>
          <span className="muted">
            {tablesLoading
              ? tr('sync.tablesLoading')
              : tr('sync.tableCounts', {
                  source: sourceTables.length,
                  target: targetTables.length
                })}
          </span>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={allTables}
            disabled={running}
            onChange={(e) => setAllTablesMode(e.target.checked)}
          />
          {tr('sync.allTables')}
        </label>
        <p className="field__hint">
          {allTables ? tr('sync.allTablesHint') : tr('sync.pickTablesHint')}
        </p>

        {!allTables &&
          (tableNames.length === 0 ? (
            <p className="muted">
              {tablesLoading ? tr('sync.loadingTables') : tr('sync.noTables')}
            </p>
          ) : (
            <>
              <div className="sync__selection-actions">
                <button
                  className="btn btn--tiny btn--ghost"
                  disabled={running}
                  onClick={() =>
                    setSelected(new Set(tableNames.filter((name) => sourceSet.has(name))))
                  }
                >
                  {tr('sync.selectAllSource')}
                </button>
                <button
                  className="btn btn--tiny btn--ghost"
                  disabled={running || selected.size === 0}
                  onClick={() => setSelected(new Set())}
                >
                  {tr('sync.clearSelection')}
                </button>
                <span className="muted">
                  {tr('sync.selectedCount', { count: selected.size })}
                </span>
              </div>
              <div className="sync__table-list">
                {tableNames.map((name) => {
                  const inSource = sourceSet.has(name)
                  const inTarget = targetSet.has(name)
                  return (
                    <label key={name} className="sync__table-row">
                      <input
                        type="checkbox"
                        checked={selected.has(name)}
                        disabled={running || !inSource}
                        onChange={() => toggleTable(name)}
                      />
                      <span className="sync__table-name">{name}</span>
                      <span className="sync__table-tag">
                        {inSource && inTarget
                          ? tr('sync.bothSides')
                          : inSource
                            ? tr('sync.sourceOnly')
                            : tr('sync.targetOnly')}
                      </span>
                    </label>
                  )
                })}
              </div>
            </>
          ))}
      </section>

      <section className="sync__card">
        <h3>
          {mode === 'structure' ? tr('sync.optionsStructure') : tr('sync.optionsData')}
        </h3>
        {mode === 'structure' ? (
          <div className="sync__options">
            {(
              [
                ['createMissingTables', tr('sync.optCreateTables')],
                ['addMissingColumns', tr('sync.optAddColumns')],
                ['alterColumns', tr('sync.optAlterColumns')],
                ['syncIndexes', tr('sync.optIndexes')],
                ['syncForeignKeys', tr('sync.optForeignKeys')],
                ['dropExtraTables', tr('sync.optDropTables')],
                ['dropExtraColumns', tr('sync.optDropColumns')],
                ['dropExtraIndexes', tr('sync.optDropIndexes')],
                ['dropExtraForeignKeys', tr('sync.optDropForeignKeys')]
              ] as [keyof typeof structureOptions, string][]
            ).map(([key, label]) => (
              <label
                key={key}
                className={`checkbox${key.startsWith('drop') ? ' sync__danger-option' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={structureOptions[key]}
                  disabled={running}
                  onChange={(e) =>
                    setStructureOptions((prev) => ({ ...prev, [key]: e.target.checked }))
                  }
                />
                {label}
              </label>
            ))}
          </div>
        ) : (
          <div className="sync__options">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={dataOptions.insertMissing}
                disabled={running}
                onChange={(e) =>
                  setDataOptions((prev) => ({ ...prev, insertMissing: e.target.checked }))
                }
              />
              {tr('sync.optInsertMissing')}
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={dataOptions.updateDifferent}
                disabled={running}
                onChange={(e) =>
                  setDataOptions((prev) => ({
                    ...prev,
                    updateDifferent: e.target.checked
                  }))
                }
              />
              {tr('sync.optUpdateDifferent')}
            </label>
            <label className="checkbox sync__danger-option">
              <input
                type="checkbox"
                checked={dataOptions.deleteExtra}
                disabled={running}
                onChange={(e) =>
                  setDataOptions((prev) => ({ ...prev, deleteExtra: e.target.checked }))
                }
              />
              {tr('sync.optDeleteExtra')}
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={dataOptions.continueOnError}
                disabled={running}
                onChange={(e) =>
                  setDataOptions((prev) => ({
                    ...prev,
                    continueOnError: e.target.checked
                  }))
                }
              />
              {tr('sync.optContinueOnError')}
            </label>
            <div className="sync__numbers">
              <label className="field field--narrow">
                <span className="field__label">{tr('sync.batchRead')}</span>
                <input
                  className="input input--tight"
                  type="number"
                  min={1}
                  max={5000}
                  value={dataOptions.batchSize}
                  disabled={running}
                  onChange={(e) => {
                    const parsed = Number(e.target.value)
                    setDataOptions((prev) => ({
                      ...prev,
                      batchSize: Number.isFinite(parsed)
                        ? Math.max(1, Math.min(5000, Math.trunc(parsed)))
                        : DEFAULT_DATA_OPTIONS.batchSize
                    }))
                  }}
                />
              </label>
              <label className="field field--narrow">
                <span className="field__label">{tr('sync.maxRowsPerTable')}</span>
                <input
                  className="input input--tight"
                  type="number"
                  min={1}
                  max={1000000}
                  value={dataOptions.maxRowsPerTable}
                  disabled={running}
                  onChange={(e) => {
                    const parsed = Number(e.target.value)
                    setDataOptions((prev) => ({
                      ...prev,
                      maxRowsPerTable: Number.isFinite(parsed)
                        ? Math.max(1, Math.min(1000000, Math.trunc(parsed)))
                        : DEFAULT_DATA_OPTIONS.maxRowsPerTable
                    }))
                  }}
                />
              </label>
            </div>
            <p className="field__hint">{tr('sync.dataPkHint')}</p>
          </div>
        )}
      </section>

      <div className="sync__actions">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={dryRun}
            disabled={running}
            onChange={(e) => setDryRun(e.target.checked)}
          />
          {tr('sync.dryRun')}
        </label>
        <button
          className="btn btn--small"
          onClick={() => void startRun()}
          disabled={!canRun}
        >
          {running
            ? tr('sync.running')
            : dryRun
              ? tr('sync.runDry')
              : mode === 'structure'
                ? tr('sync.applyStructure')
                : tr('sync.syncData')}
        </button>
        {running && (
          <button
            className="btn btn--small btn--ghost"
            onClick={() => void cancelRun()}
            disabled={cancelling}
          >
            {cancelling ? tr('sync.cancelling') : tr('sync.cancel')}
          </button>
        )}
      </div>

      {progress && (
        <section className="sync__card">
          <div className="sync__bar">
            <h3>{tr('sync.progress')}</h3>
            <span className="muted">
              {tr('sync.progressTables', {
                done: progress.tablesDone,
                total: progress.tablesTotal
              })}
            </span>
          </div>
          <p className="sync__progress" role="status">
            {progress.phase === 'preparing'
              ? tr('sync.preparing')
              : progress.phase === 'comparing'
                ? 'Membandingkan...'
                : progress.phase === 'done'
                  ? tr('sync.done')
                  : `Menerapkan${progress.table ? ` ${progress.table}` : ''}`}
            {mode === 'data' &&
              progress.phase === 'deploying' &&
              `: ${progress.inserted} insert, ${progress.updated} update, ${progress.deleted} delete`}
            {mode === 'structure' &&
              progress.phase === 'deploying' &&
              `: ${progress.statements} statement`}
          </p>
        </section>
      )}

      {preview && (
        <section className="sync__card">
          <div className="sync__bar">
            <h3>{tr('sync.preview')}</h3>
            <span className="muted">
              {preview.mode === 'structure'
                ? `${preview.structure.sourceEngine} → ${preview.structure.targetEngine}`
                : `${preview.data.sourceEngine} → ${preview.data.targetEngine}`}
            </span>
          </div>

          {preview.mode === 'structure' ? (
            <>
              <div className="sync__summary">
                <span>{tr('sync.willRun', { count: changesBySeverity.runnable })}</span>
                <span>
                  {tr('sync.willDelete', { count: changesBySeverity.destructive })}
                </span>
                <span>
                  {tr('sync.skippedByOption', { count: changesBySeverity.skipped })}
                </span>
                <span>
                  {tr('sync.unsupportedCount', { count: changesBySeverity.unsupported })}
                </span>
              </div>
              {preview.structure.warnings.length > 0 && (
                <ul className="sync__warnings">
                  {preview.structure.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
              {preview.structure.changes.length === 0 ? (
                <p className="muted">{tr('sync.noStructureDiff')}</p>
              ) : (
                <div className="table-scroll sync__scroll">
                  <table className="data-table sync__table">
                    <thead>
                      <tr>
                        <th>{tr('sync.colStatus')}</th>
                        <th>{tr('sync.colTable')}</th>
                        <th>{tr('sync.colChange')}</th>
                        <th>{tr('sync.colObject')}</th>
                        <th>{tr('sync.colNote')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.structure.changes.map((change) => (
                        <tr key={change.id}>
                          <td>
                            <span
                              className={`sync__sev sync__sev--${change.severity}`}
                              title={severityLabels(tr)[change.severity]}
                            >
                              {severityLabels(tr)[change.severity]}
                            </span>
                          </td>
                          <td>{change.table}</td>
                          <td>{changeLabels(tr)[change.kind]}</td>
                          <td className="sync__object">{change.object}</td>
                          <td>{change.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {script.length > 0 && (
                <details className="sync__script">
                  <summary>Skrip DDL ({script.length} statement)</summary>
                  <pre>
                    {script
                      .map((entry) => `-- ${entry.table}\n${entry.sql}`)
                      .join('\n\n')}
                  </pre>
                </details>
              )}
            </>
          ) : (
            <>
              {preview.data.warnings.length > 0 && (
                <ul className="sync__warnings">
                  {preview.data.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
              {preview.data.tables.length === 0 ? (
                <p className="muted">{tr('sync.noTableCompare')}</p>
              ) : (
                <div className="table-scroll sync__scroll">
                  <table className="data-table sync__table">
                    <thead>
                      <tr>
                        <th>{tr('sync.colTable')}</th>
                        <th>{tr('sync.colStatus')}</th>
                        <th className="sync__num">{tr('sync.colInsert')}</th>
                        <th className="sync__num">{tr('sync.colUpdate')}</th>
                        <th className="sync__num">{tr('sync.colDelete')}</th>
                        <th className="sync__num">{tr('sync.colSame')}</th>
                        <th>{tr('sync.colPrimaryKey')}</th>
                        <th>{tr('sync.colNote')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.data.tables.map((table) => (
                        <tr key={table.table}>
                          <td>{table.table}</td>
                          <td>{dataStatusLabels(tr)[table.status] ?? table.status}</td>
                          <td className="sync__num">{table.inserts}</td>
                          <td className="sync__num">{table.updates}</td>
                          <td className="sync__num">{table.deletes}</td>
                          <td className="sync__num">{table.unchanged}</td>
                          <td className="sync__object">
                            {table.primaryKeys.join(', ') || '-'}
                          </td>
                          <td>
                            {table.reason ??
                              (table.truncated ? tr('sync.truncated') : '')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {result && (
        <section className="sync__card">
          <h3>{tr('sync.results')}</h3>
          <ul className="sync__result">
            {result.mode === 'structure' ? (
              <>
                <li>{tr('sync.appliedChanges', { count: result.structure.applied })}</li>
                <li>
                  {tr('sync.statementsRun', { count: result.structure.statements })}
                </li>
                <li>{tr('sync.failedCount', { count: result.structure.failed })}</li>
                <li>{tr('sync.skippedCount', { count: result.structure.skipped })}</li>
                <li>{tr('sync.duration', { ms: result.structure.durationMs })}</li>
                {result.structure.dryRun && <li>{tr('sync.modeDryRun')}</li>}
                {result.structure.errors.map((message) => (
                  <li key={message} className="sync__error">
                    {message}
                  </li>
                ))}
                {result.structure.warnings.map((warning) => (
                  <li key={warning} className="sync__warning">
                    {warning}
                  </li>
                ))}
              </>
            ) : (
              <>
                <li>Insert: {result.data.inserted}</li>
                <li>Update: {result.data.updated}</li>
                <li>Delete: {result.data.deleted}</li>
                <li>{tr('sync.failedTables', { count: result.data.failed })}</li>
                <li>{tr('sync.duration', { ms: result.data.durationMs })}</li>
                {result.data.dryRun && <li>{tr('sync.modeDryRun')}</li>}
                {result.data.errors.map((message) => (
                  <li key={message} className="sync__error">
                    {message}
                  </li>
                ))}
                {result.data.warnings.map((warning) => (
                  <li key={warning} className="sync__warning">
                    {warning}
                  </li>
                ))}
              </>
            )}
          </ul>
        </section>
      )}

      <section className="sync__card">
        <div className="sync__bar">
          <h3>{tr('sync.profiles')}</h3>
          <div className="sync__bar-actions">
            <button
              className="btn btn--tiny btn--ghost"
              onClick={() => setProfileName('')}
              disabled={!ready || running || savingProfile}
              title={ready ? tr('sync.saveSelection') : tr('sync.needEndpointsFirst')}
            >
              {tr('sync.saveProfile')}
            </button>
            <button
              className="btn btn--tiny btn--ghost"
              onClick={() => void loadProfiles()}
              disabled={profilesLoading}
            >
              {tr('menu.reload')}
            </button>
          </div>
        </div>
        {loadedProfileId && (
          <p className="sync__profile-active">
            {tr('sync.activeProfile')}{' '}
            {profiles.find((p) => p.id === loadedProfileId)?.name ??
              tr('sync.savedProfile')}
            <button
              className="btn btn--tiny btn--ghost"
              onClick={() => setLoadedProfileId(undefined)}
              title={tr('sync.detachProfile')}
            >
              {tr('sync.detachProfile')}
            </button>
          </p>
        )}
        {profilesLoading ? (
          <p className="muted">{tr('sync.loadingProfiles')}</p>
        ) : profiles.length === 0 ? (
          <p className="muted">{tr('sync.noProfiles')}</p>
        ) : (
          <ul className="sync__profiles">
            {profiles.map((profile) => (
              <li key={profile.id} className="sync__profile">
                <div className="sync__profile-main">
                  <span className="sync__profile-name">{profile.name}</span>
                  <span className="sync__profile-meta">
                    {profile.mode === 'structure'
                      ? tr('sync.modeStructureShort')
                      : tr('sync.modeDataShort')}{' '}
                    | {endpointLabel(profile.source)} → {endpointLabel(profile.target)}
                  </span>
                  <span className="sync__profile-meta">
                    {profile.tables.length === 0
                      ? tr('sync.allTablesShort')
                      : tr('sync.profileTables', { count: profile.tables.length })}{' '}
                    | {new Date(profile.updatedAt).toLocaleString()}
                  </span>
                </div>
                <div className="sync__bar-actions">
                  <button
                    className="btn btn--tiny btn--ghost"
                    onClick={() => applyProfile(profile)}
                    disabled={running}
                  >
                    {tr('sync.loadProfile')}
                  </button>
                  <button
                    className="btn btn--tiny btn--ghost"
                    onClick={() => void removeProfile(profile)}
                    disabled={running}
                  >
                    {tr('menu.delete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="muted sync__summary">
        {endpointLabel(source)} → {endpointLabel(target)}
      </p>

      {profileName !== null && (
        <PromptDialog
          title={tr('sync.saveProfileTitle')}
          label={tr('sync.profileName')}
          defaultValue={profiles.find((p) => p.id === loadedProfileId)?.name ?? ''}
          confirmLabel={tr('common.save')}
          placeholder={tr('sync.profilePlaceholder')}
          onConfirm={(name) => void saveProfile(name)}
          onClose={() => setProfileName(null)}
        />
      )}
    </div>
  )
}
