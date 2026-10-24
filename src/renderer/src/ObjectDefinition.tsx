import { useCallback, useEffect, useState } from 'react'
import type { RoutineKind } from '@shared/types'
import { unwrap } from './api'
import { useLocale } from './i18n'
import { IconClose } from './Icons'

export interface DefinitionTarget {
  connectionId: string
  database: string
  schema?: string
  name: string
  // A view is fetched through getViewDefinition, everything else through
  // getRoutineDefinition.
  kind: 'view' | RoutineKind
  signature?: string | null
}

interface Props {
  target: DefinitionTarget
  onClose: () => void
  onError: (message: string) => void
}

const KIND_LABEL: Record<string, string> = {
  view: 'view',
  function: 'function',
  procedure: 'procedure',
  trigger: 'trigger',
  event: 'event'
}

// Read-only source viewer. Navicat shows the same text in a plain editor with
// the CREATE statement intact, which is what people copy into migrations.
export function ObjectDefinition({ target, onClose, onError }: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [empty, setEmpty] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setNotice(null)
    setEmpty(false)
    try {
      const result =
        target.kind === 'view'
          ? await unwrap(
              window.dbApi.getViewDefinition(
                target.connectionId,
                target.database,
                target.name,
                target.schema
              )
            )
          : await unwrap(
              window.dbApi.getRoutineDefinition(
                target.connectionId,
                target.database,
                target.name,
                target.kind,
                target.schema,
                target.signature ?? null
              )
            )
      if (!result || !result.trim()) {
        setText(null)
        setEmpty(true)
      } else {
        setText(result)
      }
    } catch (err) {
      const message = errorText(err)
      setText(null)
      onError(message)
      setNotice(message)
    } finally {
      setLoading(false)
    }
  }, [target, onError])

  useEffect(() => {
    void load()
  }, [load])

  async function copy(): Promise<void> {
    if (!text) return
    try {
      await unwrap(window.dbApi.clipboardWrite(text))
      setNotice(tr('def.copied'))
    } catch {
      setNotice(tr('explorer.copyFailed'))
    }
  }

  const path = `${target.database}${target.schema ? `.${target.schema}` : ''}.${target.name}`

  return (
    <section className="defview" aria-label={tr('def.title')}>
      <header className="defview__head">
        <div className="defview__title">
          <span className="defview__kind">{KIND_LABEL[target.kind] ?? target.kind}</span>
          <h2 title={path}>{path}</h2>
        </div>
        <div className="defview__actions">
          <button
            className="btn btn--tiny btn--ghost"
            onClick={() => void load()}
            disabled={loading}
            title={tr('def.reload')}
          >
            {loading ? 'Memuat...' : 'Muat ulang'}
          </button>
          <button
            className="btn btn--tiny btn--ghost"
            onClick={() => void copy()}
            disabled={!text}
            title={tr('def.copy')}
          >
            {tr('def.copy')}
          </button>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={tr('def.close')}
            title={tr('common.close')}
          >
            <IconClose size={14} />
          </button>
        </div>
      </header>

      {notice && (
        <p className="notice notice--info defview__notice" role="status">
          {notice}
        </p>
      )}

      {loading ? (
        <p className="muted defview__pad">{tr('def.loading')}</p>
      ) : empty ? (
        <div className="defview__pad">
          <p className="muted">
            Server tidak mengembalikan definisi untuk{' '}
            {KIND_LABEL[target.kind] ?? target.kind} ini.
          </p>
          <p className="muted defview__hint">{tr('def.ownerOnly')}</p>
        </div>
      ) : text ? (
        <pre className="defview__code">
          <code>{text}</code>
        </pre>
      ) : null}
    </section>
  )
}
