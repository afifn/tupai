import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ColumnInfo,
  IndexInfo,
  PrimaryKeyInfo,
  TableAlteration
} from '@shared/types'
import { engineColumnTypes } from '@shared/ddl'
import { unwrap } from './api'
import { useLocale } from './i18n'
import { confirmDestructive } from './confirm'
import { IconClose, IconPlus, IconTrash } from './Icons'
import { DIAGRAM_COLORS, type DiagramColor } from './diagramLayout'

export interface QuickEditTarget {
  connectionId: string
  database: string
  schema?: string
  table: string
  engine: string
  // Colour currently applied to the card, so the dialog can edit it in place.
  color?: DiagramColor
  onColorChange?: (color: DiagramColor) => void
}

interface Props {
  target: QuickEditTarget
  onClose: () => void
  onApplied: () => void
  onError: (message: string) => void
}

// One editable row. `original` is kept so the save step can diff and only emit
// the ALTER statements that actually changed.
interface ColumnRow {
  id: string
  name: string
  dataType: string
  nullable: boolean
  primaryKey: boolean
  autoIncrement: boolean
  defaultValue: string
  original?: ColumnInfo
  isNew: boolean
  markedForDrop: boolean
}

type Tab = 'structure' | 'index'

let seq = 0
function nextId(): string {
  seq += 1
  return `q${seq}`
}

function toRow(column: ColumnInfo): ColumnRow {
  return {
    id: nextId(),
    name: column.name,
    dataType: column.dataType,
    nullable: column.nullable,
    primaryKey: column.isPrimaryKey,
    autoIncrement: column.autoIncrement === true,
    defaultValue: column.defaultValue ?? '',
    original: column,
    isNew: false,
    markedForDrop: false
  }
}

function blankRow(): ColumnRow {
  return {
    id: nextId(),
    name: '',
    dataType: 'varchar(255)',
    nullable: true,
    primaryKey: false,
    autoIncrement: false,
    defaultValue: '',
    isNew: true,
    markedForDrop: false
  }
}

// Table editor in the shape of the Navicat dialog: name and colour on top, a
// Structure/Index switch, then an editable column grid. Opened from a diagram
// card, so it also owns the card colour.
export function TableQuickEdit({
  target,
  onClose,
  onApplied,
  onError
}: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [tab, setTab] = useState<Tab>('structure')
  const [name, setName] = useState(target.table)
  const [rows, setRows] = useState<ColumnRow[]>([])
  const [indexes, setIndexes] = useState<IndexInfo[]>([])
  const [originalPk, setOriginalPk] = useState<PrimaryKeyInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [color, setColor] = useState<DiagramColor>(target.color ?? 'none')
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [columns, indexList, pk] = await Promise.all([
        unwrap(
          window.dbApi.listColumns(
            target.connectionId,
            target.database,
            target.table,
            target.schema
          )
        ),
        unwrap(
          window.dbApi.listIndexes(
            target.connectionId,
            target.database,
            target.table,
            target.schema
          )
        ).catch(() => []),
        unwrap(
          window.dbApi.getPrimaryKey(
            target.connectionId,
            target.database,
            target.table,
            target.schema
          )
        ).catch(() => null)
      ])
      setRows(columns.map(toRow))
      setIndexes(indexList)
      setOriginalPk(pk)
    } catch (err) {
      const message = errorText(err)
      setError(message)
      onErrorRef.current(message)
    } finally {
      setLoading(false)
    }
  }, [target])

  useEffect(() => {
    void load()
  }, [load])

  const typeOptions = engineColumnTypes(target.engine as never)
  const visible = rows.filter((row) => !row.markedForDrop)

  function updateRow(id: string, patch: Partial<ColumnRow>): void {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  function addRow(): void {
    const fresh = blankRow()
    setRows((prev) => [...prev, fresh])
    setSelected(fresh.id)
  }

  function dropRow(): void {
    if (!selected) return
    setRows((prev) =>
      prev
        .map((row) => {
          if (row.id !== selected) return row
          // A new row is simply removed; an existing one is flagged so the save
          // step emits DROP COLUMN instead of silently forgetting it.
          return row.isNew ? row : { ...row, markedForDrop: true }
        })
        .filter((row) => !(row.isNew && row.id === selected))
    )
    setSelected(null)
  }

  function buildAlterations(): TableAlteration[] {
    const out: TableAlteration[] = []
    const mysqlFamily = target.engine === 'mysql' || target.engine === 'mariadb'
    for (const row of rows) {
      if (row.markedForDrop && !row.isNew) {
        out.push({ type: 'dropColumn', name: row.original!.name })
        continue
      }
      const columnName = row.name.trim()
      const def = {
        name: columnName,
        dataType: row.dataType.trim(),
        nullable: row.nullable,
        primaryKey: row.primaryKey,
        autoIncrement: row.autoIncrement,
        defaultValue: row.defaultValue.trim() === '' ? undefined : row.defaultValue.trim()
      }
      if (row.isNew) {
        out.push({ type: 'addColumn', column: def })
        continue
      }
      const orig = row.original!
      if (columnName !== orig.name) {
        out.push({ type: 'renameColumn', from: orig.name, to: columnName })
      }
      const typeChanged = def.dataType !== orig.dataType
      const nullChanged = def.nullable !== orig.nullable
      const autoChanged = row.autoIncrement !== (orig.autoIncrement === true)
      const defNext = def.defaultValue ?? null
      const defChanged = (orig.defaultValue ?? null) !== defNext
      if (typeChanged || nullChanged || autoChanged || defChanged) {
        out.push({
          type: 'modifyColumn',
          column: def,
          previous: {
            dataType: orig.dataType,
            nullable: orig.nullable,
            defaultValue: orig.defaultValue,
            autoIncrement: orig.autoIncrement === true
          }
        })
      }
      // MySQL re-declares the whole column on MODIFY, so a comment change has to
      // ride along with it.
      if (mysqlFamily && (typeChanged || nullChanged || autoChanged || defChanged)) {
        out.push({
          type: 'setColumnComment',
          column: columnName,
          comment: orig.comment ?? null,
          definition: def
        })
      }
    }

    const nextPk = visible.filter((row) => row.primaryKey).map((row) => row.name.trim())
    const beforePk = (originalPk?.columns ?? []).map((s) => s.toLowerCase()).join(',')
    const afterPk = nextPk.map((s) => s.toLowerCase()).join(',')
    if (beforePk !== afterPk) {
      if (originalPk) {
        out.push({ type: 'dropPrimaryKey', constraintName: originalPk.name })
      }
      if (nextPk.length > 0) out.push({ type: 'setPrimaryKey', columns: nextPk })
    }
    return out
  }

  const renameNeeded = name.trim() !== target.table && name.trim() !== ''

  async function save(): Promise<void> {
    if (!name.trim()) {
      setError(tr('quick.nameRequired'))
      return
    }
    const unnamed = visible.find((row) => !row.name.trim())
    if (unnamed) {
      setError(tr('quick.everyColumnNamed'))
      return
    }
    const alterations = buildAlterations()
    if (alterations.length === 0 && !renameNeeded) {
      setNotice(tr('quick.noChanges'))
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (renameNeeded) {
        await unwrap(
          window.dbApi.executeDdl(target.connectionId, {
            kind: 'renameTable',
            database: target.database,
            schema: target.schema,
            table: target.table,
            newName: name.trim()
          })
        )
      }
      if (alterations.length > 0) {
        await unwrap(
          window.dbApi.executeDdl(target.connectionId, {
            kind: 'alterTable',
            database: target.database,
            schema: target.schema,
            table: renameNeeded ? name.trim() : target.table,
            alterations
          })
        )
      }
      onApplied()
      onClose()
    } catch (err) {
      const message = errorText(err)
      setError(message)
      onErrorRef.current(message)
    } finally {
      setBusy(false)
    }
  }

  async function deleteTable(): Promise<void> {
    const proceed = await confirmDestructive(
      tr('quick.dropConfirm', { table: target.table }),
      { title: tr('quick.deleteTable'), detail: tr('quick.dropDetail') }
    )
    if (!proceed) return
    setBusy(true)
    setError(null)
    try {
      await unwrap(
        window.dbApi.executeDdl(target.connectionId, {
          kind: 'dropTable',
          database: target.database,
          schema: target.schema,
          table: target.table
        })
      )
      onApplied()
      onClose()
    } catch (err) {
      const message = errorText(err)
      setError(message)
      onErrorRef.current(message)
    } finally {
      setBusy(false)
    }
  }

  function chooseColor(option: DiagramColor): void {
    setColor(option)
    target.onColorChange?.(option)
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal modal--tableedit"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit tabel ${target.table}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="tableedit__head">
          <div className="tableedit__field">
            <span className="tableedit__label">{tr('quick.name')}</span>
            <input
              className="input tableedit__name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              aria-label={tr('quick.tableName')}
            />
          </div>
          <button
            className="icon-btn tableedit__close"
            onClick={onClose}
            aria-label={tr('quick.close')}
            title={tr('quick.close')}
          >
            <IconClose size={14} />
          </button>
        </header>

        <div className="tableedit__field">
          <span className="tableedit__label">{tr('quick.color')}</span>
          <div
            className="tableedit__colors"
            role="group"
            aria-label={tr('quick.tableColor')}
          >
            {DIAGRAM_COLORS.map((option) => (
              <button
                key={option}
                className={`tableedit__color tableedit__color--${option}${
                  color === option ? ' is-active' : ''
                }`}
                onClick={() => chooseColor(option)}
                aria-label={option === 'none' ? 'Tanpa warna' : `Warna ${option}`}
                aria-pressed={color === option}
                title={option === 'none' ? 'Tanpa warna' : option}
              />
            ))}
          </div>
        </div>

        <nav className="tableedit__tabs" role="tablist">
          <button
            className={`tableedit__tab${tab === 'structure' ? ' is-active' : ''}`}
            role="tab"
            aria-selected={tab === 'structure'}
            onClick={() => setTab('structure')}
          >
            {tr('quick.structure')}
          </button>
          <button
            className={`tableedit__tab${tab === 'index' ? ' is-active' : ''}`}
            role="tab"
            aria-selected={tab === 'index'}
            onClick={() => setTab('index')}
          >
            {tr('quick.index')}
          </button>
        </nav>

        {error && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice notice--info" role="status">
            {notice}
          </p>
        )}

        {loading ? (
          <p className="muted tableedit__pad">{tr('quick.loadingStructure')}</p>
        ) : tab === 'structure' ? (
          <div className="tableedit__grid-wrap">
            <table className="tableedit__grid">
              <thead>
                <tr>
                  <th className="tableedit__col-name">column_name</th>
                  <th className="tableedit__col-type">data_type</th>
                  <th className="tableedit__col-flag">is_nullable</th>
                  <th className="tableedit__col-flag">PK</th>
                  <th className="tableedit__col-default">default</th>
                  <th className="tableedit__col-flag">auto</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`tableedit__row${row.markedForDrop ? ' is-dropped' : ''}${
                      selected === row.id ? ' is-selected' : ''
                    }`}
                    onClick={() => setSelected(row.id)}
                  >
                    <td>
                      <input
                        className="input tableedit__cell"
                        value={row.name}
                        onChange={(e) => updateRow(row.id, { name: e.target.value })}
                        spellCheck={false}
                        aria-label={`Nama kolom ${row.name || 'baru'}`}
                      />
                    </td>
                    <td>
                      <input
                        className="input tableedit__cell"
                        list="tableedit-types"
                        value={row.dataType}
                        onChange={(e) => updateRow(row.id, { dataType: e.target.value })}
                        spellCheck={false}
                        aria-label={`Tipe data ${row.name || 'baru'}`}
                      />
                    </td>
                    <td className="tableedit__cell-flag">
                      <button
                        className={`tableedit__toggle${row.nullable ? '' : ' is-on'}`}
                        onClick={() => updateRow(row.id, { nullable: !row.nullable })}
                        aria-pressed={!row.nullable}
                        title={row.nullable ? 'Boleh NULL' : tr('quick.notNull')}
                      >
                        {row.nullable ? 'YES' : 'NO'}
                      </button>
                    </td>
                    <td className="tableedit__cell-flag">
                      <input
                        type="checkbox"
                        checked={row.primaryKey}
                        onChange={(e) =>
                          updateRow(row.id, { primaryKey: e.target.checked })
                        }
                        aria-label={`Primary key ${row.name || 'baru'}`}
                      />
                    </td>
                    <td>
                      <input
                        className="input tableedit__cell"
                        value={row.defaultValue}
                        onChange={(e) =>
                          updateRow(row.id, { defaultValue: e.target.value })
                        }
                        placeholder="NULL"
                        spellCheck={false}
                        aria-label={`Default ${row.name || 'baru'}`}
                      />
                    </td>
                    <td className="tableedit__cell-flag">
                      <input
                        type="checkbox"
                        checked={row.autoIncrement}
                        onChange={(e) =>
                          updateRow(row.id, { autoIncrement: e.target.checked })
                        }
                        aria-label={`Auto increment ${row.name || 'baru'}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="tableedit-types">
              {typeOptions.map((type) => (
                <option key={type} value={type} />
              ))}
            </datalist>
          </div>
        ) : (
          <div className="tableedit__grid-wrap">
            <table className="tableedit__grid">
              <thead>
                <tr>
                  <th className="tableedit__col-name">index</th>
                  <th className="tableedit__col-type">columns</th>
                  <th className="tableedit__col-flag">unique</th>
                  <th className="tableedit__col-flag">primary</th>
                </tr>
              </thead>
              <tbody>
                {indexes.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted tableedit__pad">
                      {tr('quick.noIndex')}
                    </td>
                  </tr>
                ) : (
                  indexes.map((index) => (
                    <tr key={index.name} className="tableedit__row">
                      <td className="tableedit__readonly">{index.name}</td>
                      <td className="tableedit__readonly">{index.columns.join(', ')}</td>
                      <td className="tableedit__cell-flag">
                        {index.unique ? 'YES' : 'NO'}
                      </td>
                      <td className="tableedit__cell-flag">
                        {index.primary ? 'YES' : 'NO'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <p className="muted tableedit__hint">
              {tr('quick.index')} dikelola di tab Struktur pada editor tabel penuh.
            </p>
          </div>
        )}

        <footer className="tableedit__footer">
          <button
            className="tableedit__icon-btn"
            onClick={addRow}
            disabled={busy || tab !== 'structure'}
            title={tr('quick.addColumn')}
            aria-label={tr('quick.addColumn')}
          >
            <IconPlus size={14} />
          </button>
          <button
            className="tableedit__icon-btn"
            onClick={dropRow}
            disabled={busy || tab !== 'structure' || !selected}
            title={tr('quick.deleteColumns')}
            aria-label={tr('quick.deleteColumns')}
          >
            <span className="tableedit__minus" />
          </button>
          <span className="tableedit__spacer" />
          <button
            className="btn btn--small btn--ghost tableedit__delete"
            onClick={() => void deleteTable()}
            disabled={busy}
          >
            <IconTrash size={13} /> {tr('quick.deleteTable')}
          </button>
          <button className="btn btn--small" onClick={() => void save()} disabled={busy}>
            {busy ? tr('query.saving') : tr('grid.saveChanges')}
          </button>
        </footer>
      </div>
    </div>
  )
}
