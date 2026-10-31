import { useEffect, useState } from 'react'
import Editor from '@monaco-editor/react'
import { unwrap } from './api'
import { useLocale } from './i18n'
import { useSettings } from './settingsStore'
import { confirmDestructive } from './confirm'
import { monaco, EDITOR_THEME_NAME } from './monacoSetup'

export interface ViewDesignerResult {
  created?: { database: string; schema?: string; view: string }
  dropped?: { database: string; schema?: string; view: string }
}

interface CreateProps {
  mode: 'create'
  connectionId: string
  engine: string
  database: string
  schema?: string
  onCancel: () => void
  onDone: (result: ViewDesignerResult) => void
}

interface EditProps {
  mode: 'edit'
  connectionId: string
  engine: string
  database: string
  schema?: string
  view: string
  onDone: (result: ViewDesignerResult) => void
}

type Props = CreateProps | EditProps

const STARTER: Record<string, string> = {
  mysql: 'SELECT\n  *\nFROM ',
  mariadb: 'SELECT\n  *\nFROM ',
  postgres: 'SELECT\n  *\nFROM ',
  oracle: 'SELECT\n  *\nFROM ',
  sqlite: 'SELECT\n  *\nFROM '
}

export function ViewDesigner(props: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const { settings } = useSettings()
  const { connectionId, engine } = props
  const [name, setName] = useState(props.mode === 'edit' ? props.view : '')
  const [sql, setSql] = useState('')
  const [loading, setLoading] = useState(props.mode === 'edit')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<string[] | null>(null)

  useEffect(() => {
    if (props.mode !== 'edit') {
      setSql(STARTER[engine] ?? 'SELECT\n  *\nFROM ')
      return
    }
    setLoading(true)
    setError(null)
    unwrap(
      window.dbApi.getViewDefinition(
        connectionId,
        props.database,
        props.view,
        props.schema
      )
    )
      .then((def) => {
        // PostgreSQL's pg_get_viewdef returns the SELECT body without a
        // trailing semicolon; the editor works on that body.
        setSql((def ?? '').trim().replace(/;\s*$/, ''))
        setLoading(false)
      })
      .catch((err) => {
        setError(errorText(err))
        setLoading(false)
      })
  }, [connectionId, engine, props])

  function buildOp(): {
    kind: 'createView'
    database: string
    schema?: string
    view: string
    selectSql: string
    orReplace: boolean
  } | null {
    if (!name.trim()) {
      setError(tr('view.nameRequired'))
      return null
    }
    if (!sql.trim()) {
      setError(tr('view.sqlRequired'))
      return null
    }
    return {
      kind: 'createView',
      database: props.database,
      schema: props.schema,
      view: name.trim(),
      selectSql: sql,
      orReplace: props.mode === 'edit'
    }
  }

  async function handlePreview(): Promise<void> {
    const op = buildOp()
    if (!op) return
    setError(null)
    try {
      setPreview(await unwrap(window.dbApi.previewDdl(connectionId, op)))
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function handleSave(): Promise<void> {
    const op = buildOp()
    if (!op) return
    setBusy(true)
    setError(null)
    try {
      await unwrap(window.dbApi.executeDdl(connectionId, op))
      props.onDone({
        created: { database: props.database, schema: props.schema, view: name.trim() }
      })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleDrop(): Promise<void> {
    if (props.mode !== 'edit') return
    const proceed = await confirmDestructive(
      tr('view.deleteMessage', { name: props.view }),
      {
        title: tr('view.dropTitle'),
        detail: tr('view.dropDetail')
      }
    )
    if (!proceed) return
    setBusy(true)
    setError(null)
    try {
      await unwrap(
        window.dbApi.executeDdl(connectionId, {
          kind: 'dropView',
          database: props.database,
          schema: props.schema,
          view: props.view
        })
      )
      props.onDone({
        dropped: { database: props.database, schema: props.schema, view: props.view }
      })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="designer">
      <header className="designer__bar">
        <div className="designer__identity">
          <h2 className="designer__title">
            {props.mode === 'create'
              ? tr('view.newTitle')
              : tr('view.definitionOf', { name: props.view })}
          </h2>
          <div className="designer__meta">
            <span className="designer__path">
              {props.database}
              {props.schema ? `.${props.schema}` : ''}
              {props.mode === 'edit' ? `.${props.view}` : ''}
            </span>
            {props.mode === 'create' && (
              <label className="designer__meta-field">
                <span>{tr('view.name')}</span>
                <input
                  className="input input--tight"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={tr('view.namePlaceholder')}
                  autoFocus
                />
              </label>
            )}
          </div>
        </div>
        <div className="designer__actions">
          <button
            className="btn btn--ghost btn--small"
            onClick={() => void handlePreview()}
            disabled={busy}
          >
            {tr('designer.showSql')}
          </button>
          {props.mode === 'create' ? (
            <button
              className="btn btn--ghost btn--small"
              onClick={props.onCancel}
              disabled={busy}
            >
              {tr('common.cancel')}
            </button>
          ) : (
            <button
              className="btn btn--ghost btn--small designer__danger"
              onClick={() => void handleDrop()}
              disabled={busy}
            >
              {tr('menu.dropView')}
            </button>
          )}
          <button
            className="btn btn--small"
            onClick={() => void handleSave()}
            disabled={busy || loading}
          >
            {busy
              ? tr('view.saving')
              : props.mode === 'create'
                ? tr('view.create')
                : tr('common.save')}
          </button>
        </div>
      </header>

      {error && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}

      <div className="designer__editor">
        {loading ? (
          <p className="muted designer__pad">{tr('view.loading')}</p>
        ) : (
          <Editor
            height="100%"
            language="sql"
            theme={EDITOR_THEME_NAME}
            value={sql}
            onChange={(v) => setSql(v ?? '')}
            options={{
              minimap: { enabled: settings.editor.minimap },
              fontSize: settings.editor.fontSize,
              fontFamily: settings.editor.fontFamily,
              tabSize: settings.editor.tabSize,
              wordWrap: settings.editor.wordWrap ? 'on' : 'off',
              scrollBeyondLastLine: false,
              automaticLayout: true
            }}
            onMount={(editor) => {
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
                void handleSave()
              })
            }}
          />
        )}
      </div>

      {preview && (
        <div className="designer__preview">
          <div className="designer__preview-head">
            <span>{tr('view.previewSql')}</span>
            <button className="btn btn--ghost btn--tiny" onClick={() => setPreview(null)}>
              {tr('designer.hide')}
            </button>
          </div>
          <pre className="sql-preview">{preview.join('\n')}</pre>
        </div>
      )}
    </div>
  )
}
