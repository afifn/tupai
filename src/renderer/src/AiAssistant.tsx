import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AiChatMessage, AiSettings, DbEngine } from '@shared/types'
import { unwrap } from './api'
import { useLocale } from './i18n'
import { extractSqlBlocks, renderInline, splitFences, stripToolCalls } from './aiFormat'
import {
  MAX_MENTIONS,
  filterTables,
  matchMentionQuery,
  mergeSchemaContext,
  replaceMentionToken,
  tableKey,
  type MentionQuery,
  type MentionedTable
} from './aiMention'
import { useMentionCatalog, type MentionCatalogTable } from './useMentionCatalog'
import { useSettings } from './settingsStore'
import { AI_PREVIEW_ROWS, previewableStatement, supportsPreview } from '@shared/aiPreview'
import { AiPreviewTable } from './AiPreviewTable'
import { IconChat, IconClose, IconSettings, IconTrash } from './Icons'

interface Props {
  // Supplies table/column names for the model. Optional: the assistant still
  // works without a connected database.
  schemaContext?: string
  // Scope for @mentions. When both are set, typing @ lists that database's tables.
  connectionId?: string
  database?: string
  schema?: string
  // Bumped when the schema may have changed; reloads the @mention list.
  catalogVersion?: number
  engine?: DbEngine
  // Optional handler so a generated SQL block can be sent to the editor.
  // The scope travels with the SQL: the editor needs the database and schema the
  // assistant was answering about, otherwise it opens on the server default.
  onInsertSql?: (
    sql: string,
    scope: { connectionId?: string; database?: string; schema?: string }
  ) => void
  onClose?: () => void
  // The AI form lives in the Settings window; this panel only points there.
  onOpenSettings?: () => void
  // The right dock already names the panel in its tab, so the inner title row
  // would repeat it. Embedded mode drops that row and folds its actions into
  // the metadata line.
  embedded?: boolean
}

interface Turn {
  id: string
  role: 'user' | 'assistant'
  content: string
  error?: boolean
}

let turnSeq = 0

function nextTurnId(): string {
  turnSeq += 1
  return `turn-${turnSeq}`
}

export function AiAssistant({
  schemaContext,
  connectionId,
  database,
  schema,
  catalogVersion = 0,
  engine,
  onInsertSql,
  onClose,
  onOpenSettings,
  embedded = false
}: Props): JSX.Element {
  const openSettings = onOpenSettings ?? (() => undefined)
  const { tr, errorText } = useLocale()
  const { settings: appSettings } = useSettings()
  const previewEnabled = appSettings.ai.previewRows
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<{
    kind: 'ok' | 'error' | 'info'
    text: string
  } | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  // Id of the streamed answer in flight. Kept in a ref so the cleanup on
  // unmount can cancel it without re-subscribing the event listener.
  const streamIdRef = useRef<string | null>(null)
  const [streamingText, setStreamingText] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // Mention state: the popup is driven by the @ token under the caret, and the
  // chosen tables persist for the whole conversation.
  const [mentions, setMentions] = useState<MentionedTable[]>([])
  const [mention, setMention] = useState<MentionQuery | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [loadingMention, setLoadingMention] = useState(false)
  const catalog = useMentionCatalog(
    connectionId,
    engine,
    database,
    schema,
    mention !== null,
    catalogVersion
  )

  const mentionOptions = useMemo(
    () => (mention ? filterTables(catalog.tables, mention.query) : []),
    [mention, catalog.tables]
  )

  const mentionEnabled = Boolean(connectionId && database && engine !== 'mongodb')

  const configured = Boolean(settings?.hasApiKey && settings.model)
  // The scope the next question will be answered in. Shown as plain text: a
  // pill for each fact would be three badges saying "this is a database".
  const scopeLabel = [engine, database, schema].filter(Boolean).join(' · ')

  const loadSettings = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const loaded = await unwrap(window.dbApi.getAiSettings())
      setSettings(loaded)
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  useEffect(() => {
    const node = listRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [turns, sending])

  // Accumulates the streamed text outside React state so the cancel handler and
  // the event listener read the latest value without re-subscribing.
  const streamingTextRef = useRef('')

  // Tokens arrive while the request is open. The partial answer is rendered from
  // streamingText and only becomes a turn when the stream ends, so a cancelled
  // answer leaves no half-written turn behind.
  useEffect(() => {
    return window.dbApi.onAiStream((event) => {
      if (event.requestId !== streamIdRef.current) return
      if (event.type === 'delta' && event.text) {
        // Appended to the ref before setState on purpose. A provider can send
        // every delta and [DONE] in one chunk, so the listener may see 'done'
        // in the same tick as the last delta; a ref mirrored from state by an
        // effect would still be empty then, and the whole answer was dropped.
        streamingTextRef.current += event.text
        setStreamingText(streamingTextRef.current)
        return
      }
      if (event.type === 'error') {
        setNotice({ kind: 'error', text: event.text ?? tr('ai.answerFailed') })
        streamIdRef.current = null
        setSending(false)
        setStreamingText('')
        streamingTextRef.current = ''
        return
      }
      if (event.type === 'done') {
        const answer = streamingTextRef.current
        if (answer.trim().length > 0) {
          setTurns((prev) => [
            ...prev,
            { id: nextTurnId(), role: 'assistant', content: answer }
          ])
        }
        streamingTextRef.current = ''
        setStreamingText('')
        streamIdRef.current = null
        setSending(false)
      }
    })
  }, [tr])

  // A stream must not outlive the panel.
  useEffect(() => {
    return () => {
      const id = streamIdRef.current
      if (id) void window.dbApi.aiChatCancel(id)
    }
  }, [])

  async function handleSend(): Promise<void> {
    const text = draft.trim()
    if (!text || sending) return
    const userTurn: Turn = { id: nextTurnId(), role: 'user', content: text }
    const history = [...turns, userTurn]
    setTurns(history)
    setDraft('')
    setMention(null)
    setSending(true)
    setNotice(null)
    setStreamingText('')
    streamingTextRef.current = ''
    const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    streamIdRef.current = requestId
    try {
      const messages: AiChatMessage[] = history
        .filter((t) => !t.error)
        .map((t) => ({ role: t.role, content: t.content }))
      await unwrap(
        window.dbApi.aiChatStream(requestId, {
          messages,
          schemaContext: mergeSchemaContext(schemaContext, mentions)
        })
      )
    } catch (err) {
      // The main process also emits an 'error' event; this covers a failure
      // before the stream opened.
      setNotice({
        kind: 'error',
        text: errorText(err)
      })
      if (streamIdRef.current === requestId) {
        streamIdRef.current = null
        setSending(false)
        setStreamingText('')
        streamingTextRef.current = ''
      }
    }
    // No cleanup in a `finally`: the IPC promise can resolve before the last
    // 'delta' and 'done' events are delivered, and clearing the request id here
    // made the listener drop them, so the answer never appeared.
  }

  async function handleStop(): Promise<void> {
    const id = streamIdRef.current
    if (!id) return
    streamIdRef.current = null
    await window.dbApi.aiChatCancel(id).catch(() => undefined)
    const partial = streamingTextRef.current
    if (partial.trim().length > 0) {
      setTurns((prev) => [
        ...prev,
        {
          id: nextTurnId(),
          role: 'assistant',
          content: `${partial}\n\n${tr('ai.stopped')}`
        }
      ])
    }
    streamingTextRef.current = ''
    setStreamingText('')
    setSending(false)
  }

  // Recomputes the @ token from the caret. Called on typing, clicking, and
  // caret movement so the popup never points at a stale position.
  function syncMentionCaret(): void {
    const input = inputRef.current
    if (!input || !mentionEnabled) {
      setMention(null)
      return
    }
    const caret = input.selectionStart ?? input.value.length
    setMention(matchMentionQuery(input.value.slice(0, caret)))
    setMentionIndex(0)
  }

  async function chooseMention(table: MentionCatalogTable): Promise<void> {
    if (!mention) return
    const already = mentions.find((m) => tableKey(m) === tableKey(table))
    if (!already && mentions.length >= MAX_MENTIONS) {
      setNotice({
        kind: 'info',
        text: tr('ai.maxMentionsNotice', { count: MAX_MENTIONS })
      })
      setMention(null)
      return
    }
    const next = replaceMentionToken(draft, mention, { ...table, columns: [] })
    setDraft(next.text)
    setMention(null)
    if (already) {
      // Re-mentioning a table only rewrites the token; columns are already known.
      requestAnimationFrame(() => {
        const input = inputRef.current
        if (!input) return
        input.focus()
        input.setSelectionRange(next.caret, next.caret)
      })
      return
    }
    setLoadingMention(true)
    try {
      const loaded = await catalog.loadColumns(table)
      setMentions((prev) => [...prev, loaded])
    } finally {
      setLoadingMention(false)
      requestAnimationFrame(() => {
        const input = inputRef.current
        if (!input) return
        input.focus()
        input.setSelectionRange(next.caret, next.caret)
      })
    }
  }

  function removeMention(table: MentionedTable): void {
    setMentions((prev) => prev.filter((m) => tableKey(m) !== tableKey(table)))
  }

  function clearThread(): void {
    setTurns([])
    setMentions([])
    setMention(null)
  }

  const sqlBlocks = useMemo(() => {
    return turns.map((turn) => ({ id: turn.id, blocks: extractSqlBlocks(turn.content) }))
  }, [turns])

  // Row previews, keyed by the assistant turn. The question that produced the
  // answer decides whether the preview is shown at all: asking for more than
  // AI_PREVIEW_ROWS keeps only the SQL block, which is the point of the cap.
  const previews = useMemo(() => {
    const out = new Map<string, { sql: string }>()
    if (!previewEnabled || !supportsPreview(engine) || !connectionId) return out
    turns.forEach((turn, index) => {
      if (turn.role !== 'assistant' || turn.error) return
      const question =
        [...turns.slice(0, index)].reverse().find((t) => t.role === 'user')?.content ?? ''
      const blocks = extractSqlBlocks(turn.content)
      for (const block of blocks) {
        const statement = previewableStatement(block, question)
        if (!statement) continue
        if (statement.requested !== null && statement.requested > AI_PREVIEW_ROWS) return
        out.set(turn.id, { sql: statement.sql })
        return
      }
    })
    return out
  }, [turns, previewEnabled, engine, connectionId])

  return (
    <section className="ai" aria-label={tr('ai.assistant')}>
      {!embedded && (
        <header className="ai__head">
          <div className="ai__title">
            <IconChat size={14} />
            <h2>{tr('ai.assistant')}</h2>
          </div>
          <div className="ai__head-actions">
            <button
              className="icon-btn"
              onClick={openSettings}
              title={tr('ai.settings')}
              aria-label={tr('ai.settings')}
            >
              <IconSettings size={14} />
            </button>
            {turns.length > 0 && (
              <button
                className="icon-btn"
                onClick={clearThread}
                title={tr('ai.clearThread')}
                aria-label={tr('ai.clearThread')}
              >
                <IconTrash size={14} />
              </button>
            )}
            {onClose && (
              <button
                className="icon-btn"
                onClick={onClose}
                title={tr('ai.closeAssistant')}
                aria-label={tr('ai.closeAssistant')}
              >
                <IconClose size={14} />
              </button>
            )}
          </div>
        </header>
      )}

      {notice && (
        <p
          className={`notice notice--${notice.kind === 'ok' ? 'ok' : notice.kind === 'info' ? 'info' : 'error'}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}

      {loading ? (
        <p className="muted ai__pad">{tr('ai.loadingSettings')}</p>
      ) : !configured ? (
        <div className="ai__settings">
          <p className="muted ai__pad">{tr('ai.notConfigured')}</p>
          <div className="ai__settings-actions">
            <button className="btn btn--small" onClick={openSettings}>
              {tr('ai.openSettings')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="ai__meta">
            <span className="ai__scope" title={tr('ai.activeContext')}>
              {scopeLabel || tr('ai.noContext')}
            </span>
            <span className="ai__meta-right">
              {settings?.model && (
                <span className="ai__model" title={tr('ai.activeModel')}>
                  {settings.model}
                </span>
              )}
              {embedded && (
                <div className="ai__head-actions">
                  <button
                    className="icon-btn icon-btn--xs"
                    onClick={openSettings}
                    title={tr('ai.settings')}
                    aria-label={tr('ai.settings')}
                  >
                    <IconSettings size={13} />
                  </button>
                  {turns.length > 0 && (
                    <button
                      className="icon-btn icon-btn--xs"
                      onClick={clearThread}
                      title={tr('ai.clearThread')}
                      aria-label={tr('ai.clearThread')}
                    >
                      <IconTrash size={13} />
                    </button>
                  )}
                </div>
              )}
            </span>
          </div>

          <div className="ai__thread" ref={listRef}>
            {turns.length === 0 ? (
              <p className="muted ai__pad ai__empty">
                {mentionEnabled ? tr('ai.emptyThread') : tr('ai.emptyNoScope')}
              </p>
            ) : (
              turns.map((turn) => {
                const blocks = sqlBlocks.find((s) => s.id === turn.id)?.blocks ?? []
                const preview = previews.get(turn.id)
                return (
                  <article
                    key={turn.id}
                    className={`ai__turn ai__turn--${turn.role}${turn.error ? ' is-error' : ''}`}
                  >
                    <span className="ai__role">
                      {turn.role === 'user' ? tr('ai.roleUser') : tr('ai.roleAssistant')}
                    </span>
                    <div className="ai__content">
                      {splitFences(turn.content).map((segment, index) =>
                        segment.kind === 'code' ? (
                          <pre key={index} className="ai__code">
                            <code>{segment.text}</code>
                          </pre>
                        ) : (
                          <p key={index} className="ai__para">
                            {renderInline(segment.text).map((part, partIndex) =>
                              part.kind === 'code' ? (
                                <code key={partIndex} className="ai__inline-code">
                                  {part.text}
                                </code>
                              ) : part.kind === 'bold' ? (
                                <strong key={partIndex}>{part.text}</strong>
                              ) : (
                                <span key={partIndex}>{part.text}</span>
                              )
                            )}
                          </p>
                        )
                      )}
                      {turn.role === 'assistant' &&
                        stripToolCalls(turn.content).strippedToolCalls && (
                          <p className="ai__stripped" role="status">
                            {tr('ai.toolCallStripped')}
                          </p>
                        )}
                    </div>
                    {preview && (
                      <AiPreviewTable
                        connectionId={connectionId as string}
                        sql={preview.sql}
                        database={database}
                        schema={schema}
                      />
                    )}
                    {blocks.length > 0 && onInsertSql && (
                      <div className="ai__sql-actions">
                        {blocks.map((sql, index) => (
                          <button
                            key={index}
                            className="btn btn--tiny btn--ghost"
                            onClick={() =>
                              onInsertSql(sql, {
                                connectionId,
                                database,
                                schema
                              })
                            }
                          >
                            {blocks.length > 1
                              ? tr('ai.insertSqlIndexed', { index: index + 1 })
                              : tr('ai.insertSql')}
                          </button>
                        ))}
                      </div>
                    )}
                  </article>
                )
              })
            )}
            {sending && streamingText.length === 0 && (
              <p className="muted ai__pad" role="status">
                {tr('ai.thinking')}
              </p>
            )}
            {sending && streamingText.length > 0 && (
              <article className="ai__turn ai__turn--assistant" aria-live="polite">
                <div className="ai__content">{streamingText}</div>
              </article>
            )}
          </div>

          <div className="ai__composer">
            {mention && (
              <div
                className="ai__suggest"
                role="listbox"
                aria-label={tr('ai.matchingTables')}
              >
                {catalog.loading ? (
                  <p className="ai__suggest-note">{tr('ai.loadingTables')}</p>
                ) : !mentionEnabled ? (
                  <p className="ai__suggest-note">{tr('ai.noTables')}</p>
                ) : catalog.error ? (
                  <p className="ai__suggest-note ai__suggest-note--error">
                    {tr('ai.tablesFailed', { message: catalog.error })}
                  </p>
                ) : mentionOptions.length === 0 ? (
                  <p className="ai__suggest-note">
                    {tr('ai.noMatchingTables', { database: database ?? '' })}
                  </p>
                ) : (
                  mentionOptions.map((table, index) => (
                    <button
                      key={tableKey(table)}
                      className={`ai__suggest-item${index === mentionIndex ? ' is-active' : ''}`}
                      role="option"
                      aria-selected={index === mentionIndex}
                      onMouseEnter={() => setMentionIndex(index)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void chooseMention(table)}
                    >
                      <span className="ai__suggest-name">{table.name}</span>
                      <span className="ai__suggest-kind">
                        {table.type === 'view'
                          ? tr('ai.tableKindView')
                          : tr('ai.tableKindTable')}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
            {mentions.length > 0 && (
              <ul className="ai__mentions" aria-label={tr('ai.mentionedTables')}>
                {mentions.map((table) => (
                  <li key={tableKey(table)} className="ai__mention">
                    <span
                      title={tr('ai.mentionTitle', {
                        database: table.database,
                        table: table.name,
                        count: table.columns.length
                      })}
                    >
                      {table.name}
                      <span className="ai__mention-count">{table.columns.length}</span>
                    </span>
                    <button
                      className="ai__mention-remove"
                      onClick={() => removeMention(table)}
                      aria-label={tr('ai.removeMentionLabel', { table: table.name })}
                      title={tr('ai.removeMention')}
                    >
                      <IconClose size={10} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <textarea
              ref={inputRef}
              className="input ai__input"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                const input = e.target
                setMention(
                  matchMentionQuery(input.value.slice(0, input.selectionStart ?? 0))
                )
                setMentionIndex(0)
              }}
              onClick={syncMentionCaret}
              onKeyUp={(e) => {
                // Arrow keys and Home/End move the caret without changing text.
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                  syncMentionCaret()
                }
              }}
              onBlur={() => setMention(null)}
              onKeyDown={(e) => {
                // The popup owns the keyboard while it is open, otherwise Enter
                // would send the message instead of picking a table.
                if (mention && mentionOptions.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setMentionIndex((i) => (i + 1) % mentionOptions.length)
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setMentionIndex(
                      (i) => (i - 1 + mentionOptions.length) % mentionOptions.length
                    )
                    return
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault()
                    void chooseMention(mentionOptions[mentionIndex])
                    return
                  }
                }
                if (e.key === 'Escape' && mention) {
                  e.preventDefault()
                  setMention(null)
                  return
                }
                // Enter sends; Shift+Enter keeps the newline. IME composition
                // must not be interrupted, so it is checked first.
                if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                e.preventDefault()
                void handleSend()
              }}
              placeholder={
                mentionEnabled ? tr('ai.composerHintMention') : tr('ai.composerHintPlain')
              }
              rows={3}
              aria-label={tr('ai.messageLabel')}
            />
            <div className="ai__composer-foot">
              <span className={`ai__hint${sending ? ' ai__hint--busy' : ''}`}>
                {loadingMention
                  ? tr('ai.loadingColumns')
                  : sending
                    ? tr('ai.thinking')
                    : tr('ai.hintPlain')}
              </span>
              {sending && (
                <button
                  className="btn btn--ghost btn--small"
                  onClick={() => void handleStop()}
                  title={tr('ai.stopAnswer')}
                >
                  {tr('ai.stop')}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}
