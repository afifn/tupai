import { useCallback, useEffect, useState } from 'react'
import type { DbUser, QueryResultSet, UserOperation } from '@shared/types'
import { privilegeChoices } from '@shared/userOps'
import { unwrap } from './api'
import { useLocale } from './i18n'
import { confirmDestructive } from './confirm'

interface Props {
  connectionId: string
  engine: string
}

type Mode = 'none' | 'create' | 'grant' | 'revoke'

interface FormState {
  username: string
  host: string
  password: string
  canLogin: boolean
  superuser: boolean
  privileges: string[]
  onType: 'database' | 'table' | 'schema'
  database: string
  schema: string
  table: string
}

const EMPTY: FormState = {
  username: '',
  host: '%',
  password: '',
  canLogin: true,
  superuser: false,
  privileges: ['SELECT'],
  onType: 'database',
  database: '',
  schema: '',
  table: ''
}

export function UsersPanel({ connectionId, engine }: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [users, setUsers] = useState<DbUser[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('none')
  const [form, setForm] = useState<FormState>(EMPTY)
  const [preview, setPreview] = useState<string[] | null>(null)
  const [pending, setPending] = useState<UserOperation | null>(null)
  const [busy, setBusy] = useState(false)

  const isMysql = engine === 'mysql' || engine === 'mariadb'
  const privChoices = privilegeChoices(engine as never)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setUsers(await unwrap(window.dbApi.listUsers(connectionId)))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [connectionId])

  useEffect(() => {
    void load()
  }, [load])

  function resetForm(): void {
    setForm(EMPTY)
    setPreview(null)
    setPending(null)
    setMode('none')
  }

  function togglePriv(p: string): void {
    setForm((prev) => ({
      ...prev,
      privileges: prev.privileges.includes(p)
        ? prev.privileges.filter((x) => x !== p)
        : [...prev.privileges, p]
    }))
  }

  async function requestPreview(op: UserOperation): Promise<void> {
    setError(null)
    setMessage(null)
    try {
      setPreview(await unwrap(window.dbApi.previewUserOp(connectionId, op)))
      setPending(op)
      setMode('none')
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function execute(): Promise<void> {
    if (!pending) return
    setBusy(true)
    setError(null)
    try {
      const results: QueryResultSet[] = await unwrap(
        window.dbApi.executeUserOp(connectionId, pending)
      )
      setMessage(tr('users.statementsDone', { count: results.length }))
      resetForm()
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  function submitCreate(): void {
    if (!form.username.trim() || !form.password) {
      setError(tr('users.needCredentials'))
      return
    }
    void requestPreview({
      kind: 'createUser',
      username: form.username.trim(),
      host: isMysql ? form.host.trim() || '%' : undefined,
      password: form.password,
      canLogin: form.canLogin,
      superuser: form.superuser
    })
  }

  function submitPrivilege(kind: 'grant' | 'revoke', user: DbUser): void {
    if (form.privileges.length === 0) {
      setError(tr('users.needPrivilege'))
      return
    }
    if (!form.database.trim()) {
      setError(tr('users.needDatabase'))
      return
    }
    if (form.onType === 'table' && !form.table.trim()) {
      setError(tr('users.needTable'))
      return
    }
    void requestPreview({
      kind,
      user: user.name,
      host: user.host,
      privileges: form.privileges,
      onType: form.onType,
      database: form.database.trim(),
      schema: form.schema.trim() || undefined,
      table: form.table.trim() || undefined
    })
  }

  function submitDrop(user: DbUser): void {
    const label = isMysql ? `${user.name}@${user.host}` : user.name
    void confirmDestructive(`Drop user "${label}"?`, {
      title: tr('users.dropTitle'),
      detail: tr('users.dropDetail')
    }).then((ok) => {
      if (!ok) return
      void requestPreview({ kind: 'dropUser', username: user.name, host: user.host })
    })
  }

  function startPrivilege(user: DbUser, kind: 'grant' | 'revoke'): void {
    setForm({ ...EMPTY, username: user.name, host: user.host ?? '%' })
    setMode(kind)
    setMessage(null)
    setError(null)
  }

  return (
    <div className="struct">
      <div className="grid-toolbar">
        <h2 className="grid-title">{tr('users.title')}</h2>
        <div className="grid-toolbar__actions">
          <button
            className="btn btn--small"
            onClick={() => {
              setMode(mode === 'create' ? 'none' : 'create')
              setForm(EMPTY)
              setPreview(null)
            }}
          >
            {tr('users.newUser')}
          </button>
          <button
            className="btn btn--ghost btn--small"
            onClick={() => void load()}
            disabled={busy}
          >
            {tr('menu.reload')}
          </button>
        </div>
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

      {mode === 'create' && (
        <div className="struct__form">
          <div className="field-row">
            <label className="field">
              <span className="field__label">{tr('users.username')}</span>
              <input
                className="input"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                autoComplete="off"
              />
            </label>
            {isMysql && (
              <label className="field">
                <span className="field__label">{tr('users.host')}</span>
                <input
                  className="input"
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
              </label>
            )}
          </div>
          <label className="field">
            <span className="field__label">{tr('users.password')}</span>
            <input
              className="input"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete="new-password"
            />
          </label>
          <div className="struct__checks">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.canLogin}
                onChange={(e) => setForm({ ...form, canLogin: e.target.checked })}
              />
              <span>{tr('users.canLogin')}</span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.superuser}
                onChange={(e) => setForm({ ...form, superuser: e.target.checked })}
              />
              <span>{isMysql ? 'Superuser' : 'SUPERUSER'}</span>
            </label>
          </div>
          <button className="btn btn--small" onClick={submitCreate}>
            {tr('users.showSql')}
          </button>
        </div>
      )}

      {(mode === 'grant' || mode === 'revoke') && (
        <div className="struct__form">
          <p className="field__label">
            {mode === 'grant' ? tr('users.grantTo') : tr('users.revokeFrom')}{' '}
            <strong>{form.username}</strong>
          </p>
          <div className="field">
            <span className="field__label">{tr('users.privilege')}</span>
            <div className="struct__checks">
              {privChoices.map((p) => (
                <label key={p} className="checkbox checkbox--tight">
                  <input
                    type="checkbox"
                    checked={form.privileges.includes(p)}
                    onChange={() => togglePriv(p)}
                  />
                  <span>{p}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="field-row">
            <label className="field field--narrow">
              <span className="field__label">{tr('users.on')}</span>
              <select
                className="input"
                value={form.onType}
                onChange={(e) =>
                  setForm({ ...form, onType: e.target.value as FormState['onType'] })
                }
              >
                <option value="database">{tr('users.scopeDatabase')}</option>
                <option value="table">{tr('users.scopeTable')}</option>
                {!isMysql && <option value="schema">{tr('users.scopeSchema')}</option>}
              </select>
            </label>
            <label className="field">
              <span className="field__label">{tr('users.database')}</span>
              <input
                className="input"
                value={form.database}
                onChange={(e) => setForm({ ...form, database: e.target.value })}
              />
            </label>
          </div>
          {form.onType === 'table' && (
            <div className="field-row">
              <label className="field">
                <span className="field__label">{tr('users.schemaOptional')}</span>
                <input
                  className="input"
                  value={form.schema}
                  onChange={(e) => setForm({ ...form, schema: e.target.value })}
                  placeholder="public"
                />
              </label>
              <label className="field">
                <span className="field__label">{tr('users.table')}</span>
                <input
                  className="input"
                  value={form.table}
                  onChange={(e) => setForm({ ...form, table: e.target.value })}
                />
              </label>
            </div>
          )}
          <div className="struct__actions">
            <button className="btn btn--ghost btn--small" onClick={resetForm}>
              {tr('common.cancel')}
            </button>
            {users?.find((u) => u.name === form.username) && (
              <button
                className="btn btn--small"
                onClick={() =>
                  submitPrivilege(
                    mode,
                    users.find((u) => u.name === form.username)!
                  )
                }
              >
                {tr('users.showSql')}
              </button>
            )}
          </div>
        </div>
      )}

      {preview && (
        <div className="struct__preview">
          <div className="struct__preview-head">
            <span>{tr('users.previewSql')}</span>
            <button
              className="btn btn--ghost btn--small"
              onClick={resetForm}
              disabled={busy}
            >
              {tr('common.cancel')}
            </button>
          </div>
          <pre className="sql-preview">{preview.join('\n')}</pre>
          <button
            className="btn btn--small"
            onClick={() => void execute()}
            disabled={busy}
          >
            {busy ? 'Menjalankan...' : 'Jalankan'}
          </button>
        </div>
      )}

      {loading ? (
        <p className="muted">{tr('users.loading')}</p>
      ) : !users || users.length === 0 ? (
        <p className="muted">{tr('users.empty')}</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th className="th-plain">{tr('users.colUser')}</th>
                {isMysql && <th className="th-plain">{tr('users.colHost')}</th>}
                <th className="th-plain">{tr('users.colLogin')}</th>
                <th className="th-plain">{tr('users.colSuperuser')}</th>
                <th className="th-plain">{tr('users.colAttributes')}</th>
                <th className="th-plain">{tr('users.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={`${u.name}@${u.host ?? ''}`}>
                  <td className="cell">{u.name}</td>
                  {isMysql && <td className="cell">{u.host}</td>}
                  <td className="cell">
                    {u.canLogin ? tr('common.yes') : tr('common.no')}
                  </td>
                  <td className="cell">
                    {u.isSuperuser ? tr('common.yes') : tr('common.no')}
                  </td>
                  <td className="cell">
                    {u.attributes.length === 0 ? (
                      <span className="cell-null">-</span>
                    ) : (
                      u.attributes.join(', ')
                    )}
                  </td>
                  <td className="cell cell--actions">
                    <button
                      className="btn btn--ghost btn--tiny"
                      onClick={() => startPrivilege(u, 'grant')}
                      disabled={busy}
                    >
                      Grant
                    </button>
                    <button
                      className="btn btn--ghost btn--tiny"
                      onClick={() => startPrivilege(u, 'revoke')}
                      disabled={busy}
                    >
                      Revoke
                    </button>
                    <button
                      className="btn btn--ghost btn--tiny"
                      onClick={() => submitDrop(u)}
                      disabled={busy}
                    >
                      {tr('menu.delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
