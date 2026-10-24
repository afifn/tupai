import { useCallback, useEffect, useState } from 'react'
import type { DbEngine } from '@shared/types'
import {
  BUILTIN_AI_ACTIONS,
  buildCustomAction,
  type AiActionDefinition
} from '@shared/aiActions'
import { extractSqlBlocks, splitFences } from './aiFormat'
import { unwrap } from './api'
import { useLocale } from './i18n'

interface Props {
  sql: string
  engine: DbEngine
  // Last database error for this tab, used by the fix action.
  errorMessage?: string | null
  // Real table and column names so fixes use existing identifiers.
  schemaContext?: string
  // Lets the error notice open this panel straight on the fix action.
  initialActionId?: string
  onApply: (sql: string) => void
  onClose: () => void
}

interface CustomActionRecord {
  name: string
  instruction: string
}

const STORAGE_KEY = 'ai-actions.custom'

function readCustomActions(): CustomActionRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((row): row is CustomActionRecord =>
      Boolean(
        row &&
        typeof row === 'object' &&
        typeof (row as CustomActionRecord).name === 'string' &&
        typeof (row as CustomActionRecord).instruction === 'string'
      )
    )
  } catch {
    return []
  }
}

function writeCustomActions(records: CustomActionRecord[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
}

const ENGINES: DbEngine[] = ['postgres', 'mysql', 'mariadb', 'sqlite', 'oracle']

function extractSqlBlock(text: string): string | null {
  const blocks = extractSqlBlocks(text)
  if (blocks.length > 0) return blocks[0].trim()
  // Some models reply with the statement only, without a fence.
  const trimmed = text.trim()
  if (/^(select|insert|update|delete|with|create|alter|drop)\b/i.test(trimmed))
    return trimmed
  return null
}

export function AiActionsPanel({
  sql,
  engine,
  errorMessage,
  schemaContext,
  initialActionId,
  onApply,
  onClose
}: Props): JSX.Element {
  const { tr, errorText: describeError } = useLocale()
  const [custom, setCustom] = useState<CustomActionRecord[]>(() => readCustomActions())
  const [actionId, setActionId] = useState<string>(() => initialActionId ?? 'optimize')
  const [targetEngine, setTargetEngine] = useState<DbEngine>(
    engine === 'postgres' ? 'mysql' : 'postgres'
  )
  // Seeded from the tab error, but editable so the user can paste an error
  // from another client or fix the text before asking.
  const [errorText, setErrorText] = useState<string>(() => errorMessage?.trim() ?? '')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reply, setReply] = useState<string | null>(null)
  const [suggested, setSuggested] = useState<string | null>(null)
  const [showCustomForm, setShowCustomForm] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customInstruction, setCustomInstruction] = useState('')

  useEffect(() => {
    setReply(null)
    setSuggested(null)
    setError(null)
  }, [actionId, sql])

  // A fresh failure replaces the error text, so the fix action never uses a
  // stale message from the previous run.
  useEffect(() => {
    if (errorMessage?.trim()) setErrorText(errorMessage.trim())
  }, [errorMessage])

  const actions: AiActionDefinition[] = [
    ...BUILTIN_AI_ACTIONS,
    ...custom.map((record) => buildCustomAction(record.name, record.instruction))
  ]

  const saveCustom = useCallback((): void => {
    const name = customName.trim()
    const instruction = customInstruction.trim()
    if (!name || !instruction) {
      setError(tr('aiact.needNameInstruction'))
      return
    }
    const next = [...custom.filter((c) => c.name !== name), { name, instruction }]
    setCustom(next)
    writeCustomActions(next)
    setCustomName('')
    setCustomInstruction('')
    setShowCustomForm(false)
    setActionId(`custom:${name}`)
    setError(null)
  }, [custom, customName, customInstruction])

  function removeCustom(name: string): void {
    const next = custom.filter((c) => c.name !== name)
    setCustom(next)
    writeCustomActions(next)
    if (actionId === `custom:${name}`) setActionId('optimize')
  }

  async function run(): Promise<void> {
    const action = actions.find((a) => a.id === actionId)
    if (!action) return
    if (!sql.trim()) {
      setError(tr('aiact.emptyTab'))
      return
    }
    if (action.needsError && !errorText.trim()) {
      setError(tr('aiact.needError'))
      return
    }
    setRunning(true)
    setError(null)
    setReply(null)
    setSuggested(null)
    try {
      const messages = action.buildMessages({
        sql,
        engine,
        targetEngine,
        errorMessage: errorText,
        schemaContext
      })
      const result = await unwrap(window.dbApi.aiChat({ messages }))
      setReply(result.content)
      setSuggested(extractSqlBlock(result.content))
    } catch (err) {
      setError(describeError(err))
    } finally {
      setRunning(false)
    }
  }

  const active = actions.find((a) => a.id === actionId)

  return (
    <section className="aiact" aria-label={tr('aiact.title')}>
      <header className="aiact__head">
        <h2>{tr('aiact.title')}</h2>
        <div className="aiact__head-actions">
          <button
            className="btn btn--tiny btn--ghost"
            onClick={() => setShowCustomForm((v) => !v)}
            aria-expanded={showCustomForm}
          >
            {tr('aiact.custom')}
          </button>
          <button className="btn btn--tiny btn--ghost" onClick={onClose}>
            {tr('common.close')}
          </button>
        </div>
      </header>

      {showCustomForm && (
        <div className="aiact__form">
          <label className="field">
            <span className="field__label">{tr('aiact.actionName')}</span>
            <input
              className="input"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder={tr('aiact.actionNamePlaceholder')}
              maxLength={60}
            />
          </label>
          <label className="field">
            <span className="field__label">{tr('aiact.instruction')}</span>
            <textarea
              className="input aiact__instruction"
              value={customInstruction}
              onChange={(e) => setCustomInstruction(e.target.value)}
              placeholder={tr('aiact.instructionPlaceholder')}
              maxLength={2000}
            />
          </label>
          <div className="aiact__form-actions">
            <button className="btn btn--tiny" onClick={saveCustom}>
              {tr('aiact.saveAction')}
            </button>
            {custom.length > 0 && (
              <span className="muted aiact__hint">
                {custom.length} aksi kustom tersimpan
              </span>
            )}
          </div>
          {custom.length > 0 && (
            <ul className="aiact__custom-list">
              {custom.map((record) => (
                <li key={record.name}>
                  <span>{record.name}</span>
                  <button
                    className="btn btn--tiny btn--ghost"
                    onClick={() => removeCustom(record.name)}
                  >
                    {tr('menu.delete')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="aiact__row">
        <label className="field field--inline">
          <span className="field__label">{tr('aiact.action')}</span>
          <select
            className="input"
            value={actionId}
            onChange={(e) => setActionId(e.target.value)}
          >
            {actions.map((action) => (
              <option key={action.id} value={action.id}>
                {action.label}
              </option>
            ))}
          </select>
        </label>
        {active?.id === 'convert' && (
          <label className="field field--inline">
            <span className="field__label">{tr('aiact.to')}</span>
            <select
              className="input"
              value={targetEngine}
              onChange={(e) => setTargetEngine(e.target.value as DbEngine)}
            >
              {ENGINES.filter((e) => e !== engine).map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className="btn btn--small"
          onClick={() => void run()}
          disabled={
            running || !sql.trim() || Boolean(active?.needsError && !errorText.trim())
          }
        >
          {running ? 'Memproses...' : 'Jalankan'}
        </button>
      </div>

      {active?.needsError && (
        <label className="field">
          <span className="field__label">{tr('aiact.errorMessage')}</span>
          <textarea
            className="input aiact__instruction"
            value={errorText}
            onChange={(e) => setErrorText(e.target.value)}
            placeholder={tr('aiact.errorPlaceholder')}
            maxLength={4000}
          />
          <span className="field__hint">
            {errorMessage?.trim() ? tr('aiact.errorSeeded') : tr('aiact.noError')}
          </span>
        </label>
      )}

      {active && <p className="field__hint">{active.description}</p>}

      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}

      {reply && (
        <div className="aiact__result">
          {splitFences(reply).map((segment, index) =>
            segment.kind === 'code' ? (
              <pre key={index} className="aiact__code">
                {segment.text}
              </pre>
            ) : (
              <p key={index} className="aiact__prose">
                {segment.text.trim()}
              </p>
            )
          )}
          {suggested && (
            <div className="aiact__apply">
              <button className="btn btn--small" onClick={() => onApply(suggested)}>
                {tr('aiact.applyToEditor')}
              </button>
              <span className="muted aiact__hint">{tr('aiact.applyHint')}</span>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
