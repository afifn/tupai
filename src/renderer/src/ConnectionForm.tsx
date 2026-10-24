import { useEffect, useRef, useState } from 'react'
import type {
  ConnectionConfig,
  ConnectionColor,
  ConnectionGroup,
  DbEngine,
  SslMode,
  SslOptions,
  StoredConnection
} from '@shared/types'
import { CONNECTION_COLORS } from '@shared/types'
import { capabilitiesFor, defaultsFor, shouldAdoptPort } from '@shared/engineDefaults'
import { describeConnectionError } from '@shared/connectionError'
import { unwrap } from './api'
import { useFocusTrap } from './useFocusTrap'
import { useLocale } from './i18n'
import { ENGINE_LABEL, EngineIcon } from './EngineIcon'

interface Props {
  initial: StoredConnection | null
  onClose: () => void
  onSaved: () => void | Promise<void>
}

type FormTab = 'general' | 'ssl' | 'ssh'

// The order the engine picker shows. MySQL and MariaDB sit next to each other
// because they share a driver and a port; MongoDB is last because it is the only
// document store.
const ENGINE_ORDER: DbEngine[] = [
  'mysql',
  'mariadb',
  'postgres',
  'oracle',
  'sqlite',
  'mongodb'
]

interface FormState {
  id: string
  name: string
  engine: DbEngine
  host: string
  port: string
  // True once the user edits the port, so an engine switch stops overwriting it.
  portTouched: boolean
  user: string
  password: string
  database: string
  ssl: boolean
  sslMode: SslMode
  sslCaPath: string
  sslCertPath: string
  sslKeyPath: string
  sslServername: string
  sshEnabled: boolean
  sshHost: string
  sshPort: string
  sshUser: string
  sshAuthType: 'password' | 'privateKey'
  sshPassword: string
  sshKeyPath: string
  sshPassphrase: string
  sshStrict: boolean
  file: string
  color: ConnectionColor | ''
  groupId: string
}

function sslParts(
  ssl: StoredConnection['ssl']
): Pick<
  FormState,
  'ssl' | 'sslMode' | 'sslCaPath' | 'sslCertPath' | 'sslKeyPath' | 'sslServername'
> {
  if (ssl === true) {
    return {
      ssl: true,
      sslMode: 'require',
      sslCaPath: '',
      sslCertPath: '',
      sslKeyPath: '',
      sslServername: ''
    }
  }
  if (ssl && typeof ssl === 'object') {
    return {
      ssl: ssl.enabled,
      sslMode: ssl.mode ?? 'require',
      sslCaPath: ssl.caPath ?? '',
      sslCertPath: ssl.certPath ?? '',
      sslKeyPath: ssl.keyPath ?? '',
      sslServername: ssl.servername ?? ''
    }
  }
  return {
    ssl: false,
    sslMode: 'require',
    sslCaPath: '',
    sslCertPath: '',
    sslKeyPath: '',
    sslServername: ''
  }
}

function toForm(initial: StoredConnection | null): FormState {
  const engine = initial?.engine ?? 'mysql'
  const fallbackPort = defaultsFor(engine).port
  return {
    id: initial?.id ?? crypto.randomUUID(),
    name: initial?.name ?? '',
    engine,
    host: initial?.host ?? defaultsFor(engine).host,
    port: initial?.port ? String(initial.port) : fallbackPort ? String(fallbackPort) : '',
    // A stored port was a deliberate choice, so an engine switch must keep it.
    portTouched: Boolean(initial?.port),
    user: initial?.user ?? '',
    password: '',
    database: initial?.database ?? '',
    ...sslParts(initial?.ssl),
    sshEnabled: initial?.ssh?.enabled ?? false,
    sshHost: initial?.ssh?.host ?? '',
    sshPort: initial?.ssh?.port ? String(initial.ssh.port) : '22',
    sshUser: initial?.ssh?.user ?? '',
    sshAuthType: initial?.ssh?.authType ?? 'password',
    sshPassword: '',
    sshKeyPath: initial?.ssh?.privateKeyPath ?? '',
    sshPassphrase: '',
    sshStrict: initial?.ssh?.strictHostKey ?? false,
    file: initial?.file ?? '',
    color: (initial?.color as ConnectionColor | undefined) ?? '',
    groupId: initial?.groupId ?? ''
  }
}

function toConfig(form: FormState): ConnectionConfig {
  const base: ConnectionConfig = {
    id: form.id,
    name: form.name.trim(),
    engine: form.engine
  }
  if (form.color) base.color = form.color
  if (form.groupId) base.groupId = form.groupId
  const caps = capabilitiesFor(form.engine)
  if (!caps.host) {
    base.file = form.file.trim()
    return base
  }
  base.host = form.host.trim()
  base.port = Number(form.port)
  base.user = form.user.trim() || undefined
  base.database = form.database.trim() || undefined
  if (caps.ssl) {
    const ssl: SslOptions = { enabled: form.ssl, mode: form.sslMode }
    if (form.sslCaPath.trim()) ssl.caPath = form.sslCaPath.trim()
    if (form.sslCertPath.trim()) ssl.certPath = form.sslCertPath.trim()
    if (form.sslKeyPath.trim()) ssl.keyPath = form.sslKeyPath.trim()
    if (form.sslServername.trim()) ssl.servername = form.sslServername.trim()
    base.ssl = ssl
  }
  if (caps.ssh && form.sshEnabled) {
    base.ssh = {
      enabled: true,
      host: form.sshHost.trim(),
      port: Number(form.sshPort) || 22,
      user: form.sshUser.trim(),
      authType: form.sshAuthType
    }
    if (form.sshAuthType === 'privateKey') {
      if (form.sshKeyPath.trim()) base.ssh.privateKeyPath = form.sshKeyPath.trim()
      if (form.sshPassphrase) base.ssh.passphrase = form.sshPassphrase
    } else if (form.sshPassword) {
      base.ssh.password = form.sshPassword
    }
    if (form.sshStrict) base.ssh.strictHostKey = true
  }
  if (form.password) base.password = form.password
  return base
}

export function ConnectionForm({ initial, onClose, onSaved }: Props): JSX.Element {
  const { tr, errorText } = useLocale()
  const [form, setForm] = useState<FormState>(() => toForm(initial))
  const [tab, setTab] = useState<FormTab>('general')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [groups, setGroups] = useState<ConnectionGroup[]>([])
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(
    null
  )

  const caps = capabilitiesFor(form.engine)
  const defaults = defaultsFor(form.engine)

  useEffect(() => {
    unwrap(window.dbApi.listConnectionGroups())
      .then(setGroups)
      .catch(() => setGroups([]))
  }, [])

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  // Switching engine rewrites only what the user has not decided: the port
  // follows the new engine unless it was typed by hand, and a capability the new
  // engine lacks is switched off so a hidden stale value cannot be saved.
  function changeEngine(next: DbEngine): void {
    setForm((prev) => {
      if (prev.engine === next) return prev
      const nextCaps = capabilitiesFor(next)
      const nextDefaults = defaultsFor(next)
      const adoptPort = shouldAdoptPort(prev.port, prev.engine, prev.portTouched)
      const port =
        adoptPort && nextDefaults.port !== null ? String(nextDefaults.port) : prev.port
      return {
        ...prev,
        engine: next,
        port,
        host: nextCaps.host && !prev.host.trim() ? nextDefaults.host : prev.host,
        ssl: nextCaps.ssl ? prev.ssl : false,
        sshEnabled: nextCaps.ssh ? prev.sshEnabled : false
      }
    })
    // A tab that the new engine does not support would show nothing.
    const nextCaps = capabilitiesFor(next)
    if (tab === 'ssl' && !nextCaps.ssl) setTab('general')
    if (tab === 'ssh' && !nextCaps.ssh) setTab('general')
    setMessage(null)
  }

  async function browseSqliteFile(): Promise<void> {
    setMessage(null)
    try {
      const chosen = await unwrap(
        window.dbApi.openFileDialog([
          { name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
          { name: tr('conn.filterAll'), extensions: ['*'] }
        ])
      )
      if (!chosen) return
      setForm((prev) => {
        const next = { ...prev, file: chosen }
        if (!prev.name.trim()) {
          const base = chosen.split(/[\\/]/).pop() ?? ''
          next.name = base.replace(/\.(db|sqlite|sqlite3|db3)$/i, '') || base
        }
        return next
      })
    } catch (err) {
      setMessage({
        kind: 'error',
        text: errorText(err)
      })
    }
  }

  async function browseFile(
    key: 'sslCaPath' | 'sslCertPath' | 'sslKeyPath'
  ): Promise<void> {
    setMessage(null)
    try {
      const chosen = await unwrap(
        window.dbApi.openFileDialog([
          {
            name: tr('conn.filterCertificate'),
            extensions: ['pem', 'crt', 'cer', 'key', 'p12', 'pfx']
          },
          { name: tr('conn.filterAll'), extensions: ['*'] }
        ])
      )
      if (chosen) update(key, chosen)
    } catch (err) {
      setMessage({
        kind: 'error',
        text: errorText(err)
      })
    }
  }

  async function browseSshKey(): Promise<void> {
    setMessage(null)
    try {
      const chosen = await unwrap(
        window.dbApi.openFileDialog([
          {
            name: tr('conn.filterSshKey'),
            extensions: ['pem', 'key', 'ppk', 'pub', '*']
          },
          { name: tr('conn.filterAll'), extensions: ['*'] }
        ])
      )
      if (chosen) update('sshKeyPath', chosen)
    } catch (err) {
      setMessage({
        kind: 'error',
        text: errorText(err)
      })
    }
  }

  // Validation lives here rather than in zod so the message can point at the
  // field that is wrong instead of failing the whole save with a JSON dump.
  function validationError(): string | null {
    if (!form.name.trim()) return tr('conn.nameRequired')
    if (caps.host && !form.host.trim()) return tr('conn.errHost')
    if (caps.port) {
      const port = Number(form.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return tr('conn.errPort')
    }
    if (caps.file && !form.file.trim()) return tr('conn.errFile')
    return null
  }

  async function handleTest(): Promise<void> {
    const invalid = validationError()
    if (invalid) {
      setMessage({ kind: 'error', text: invalid })
      return
    }
    setTesting(true)
    setMessage(null)
    try {
      await unwrap(window.dbApi.testConnection(toConfig(form)))
      setMessage({ kind: 'ok', text: tr('conn.testOk') })
    } catch (err) {
      // The driver message is a code plus an address; the classifier turns it
      // into what to fix. The raw text stays as the fallback.
      const raw = err instanceof Error ? err.message : String(err)
      const failure = describeConnectionError(raw, form.engine, tr)
      setMessage({
        kind: 'error',
        text: tr('conn.testFailed', { title: failure.title, hint: failure.hint })
      })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave(): Promise<void> {
    const invalid = validationError()
    if (invalid) {
      setMessage({ kind: 'error', text: invalid })
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      await unwrap(window.dbApi.saveConnection(toConfig(form)))
      await onSaved()
    } catch (err) {
      setMessage({
        kind: 'error',
        text: errorText(err)
      })
    } finally {
      setSaving(false)
    }
  }

  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, true)

  // Fingerprint already recorded for the SSH host, so the user can see what
  // the app trusts instead of trusting an invisible key.
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  useEffect(() => {
    if (!form.sshEnabled || !form.sshHost.trim()) {
      setFingerprint(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void unwrap(
        window.dbApi.sshHostFingerprint(form.sshHost.trim(), Number(form.sshPort) || 22)
      )
        .then((value) => {
          if (!cancelled) setFingerprint(value)
        })
        .catch(() => {
          if (!cancelled) setFingerprint(null)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [form.sshEnabled, form.sshHost, form.sshPort])

  const tabs: { id: FormTab; label: string; enabled: boolean; dot: boolean }[] = [
    { id: 'general', label: tr('conn.tabGeneral'), enabled: true, dot: false },
    { id: 'ssl', label: tr('conn.tabSsl'), enabled: caps.ssl, dot: form.ssl },
    {
      id: 'ssh',
      label: tr('conn.tabSsh'),
      enabled: caps.ssh,
      dot: form.sshEnabled
    }
  ]
  const visibleTabs = tabs.filter((entry) => entry.enabled)

  function onTabKey(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const index = visibleTabs.findIndex((entry) => entry.id === tab)
    const delta = event.key === 'ArrowRight' ? 1 : -1
    const next = visibleTabs[(index + delta + visibleTabs.length) % visibleTabs.length]
    setTab(next.id)
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={tr('conn.form')}
    >
      <div className="modal modal--conn" ref={dialogRef}>
        <div className="modal__head">
          <h2>{initial ? tr('conn.editTitle') : tr('conn.newTitle')}</h2>
          <button className="btn btn--ghost btn--small" onClick={onClose}>
            {tr('common.close')}
          </button>
        </div>

        <div className="conn">
          {/* Identity: the two choices that decide everything below. */}
          <div className="conn__identity">
            <label className="field">
              <span className="field__label">{tr('conn.name')}</span>
              <input
                className="input"
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                placeholder={tr('conn.namePlaceholder')}
                autoFocus
              />
            </label>

            <div className="field">
              <span className="field__label">{tr('conn.engineSection')}</span>
              <div
                className="conn__engines"
                role="radiogroup"
                aria-label={tr('conn.engineSection')}
              >
                {ENGINE_ORDER.map((engine) => {
                  const selected = form.engine === engine
                  return (
                    <button
                      key={engine}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`conn__engine${selected ? ' is-active' : ''}`}
                      onClick={() => changeEngine(engine)}
                    >
                      <EngineIcon engine={engine} size={18} active={selected} />
                      <span>{ENGINE_LABEL[engine]}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="field-row">
              <label className="field">
                <span className="field__label">{tr('conn.group')}</span>
                <select
                  className="input"
                  value={form.groupId}
                  onChange={(e) => update('groupId', e.target.value)}
                >
                  <option value="">{tr('conn.noGroup')}</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field">
                <span className="field__label">{tr('conn.color')}</span>
                <div className="swatches" role="group" aria-label={tr('conn.colorGroup')}>
                  <button
                    type="button"
                    className={`swatch swatch--none${form.color === '' ? ' is-on' : ''}`}
                    onClick={() => update('color', '')}
                    title={tr('conn.noColor')}
                    aria-label={tr('conn.noColor')}
                    aria-pressed={form.color === ''}
                  >
                    ×
                  </button>
                  {CONNECTION_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`swatch swatch--${c}${form.color === c ? ' is-on' : ''}`}
                      onClick={() => update('color', c)}
                      title={c}
                      aria-label={tr('conn.colorName', { name: c })}
                      aria-pressed={form.color === c}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>

          <nav
            className="conn__tabs"
            role="tablist"
            aria-label={tr('conn.form')}
            onKeyDown={onTabKey}
          >
            {visibleTabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                tabIndex={tab === entry.id ? 0 : -1}
                className={`conn__tab${tab === entry.id ? ' is-active' : ''}`}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
                {entry.dot && <span className="conn__tab-dot" aria-hidden="true" />}
              </button>
            ))}
          </nav>

          <div className="conn__panel" role="tabpanel">
            {tab === 'general' && (
              <>
                {caps.file ? (
                  <label className="field">
                    <span className="field__label">{tr('conn.file')}</span>
                    <div className="file-picker">
                      <input
                        className="input"
                        value={form.file}
                        onChange={(e) => update('file', e.target.value)}
                        placeholder="C:\data\app.db"
                      />
                      <button
                        className="btn btn--ghost btn--small"
                        onClick={() => void browseSqliteFile()}
                        disabled={testing || saving}
                      >
                        {tr('conn.browse')}
                      </button>
                    </div>
                  </label>
                ) : (
                  <>
                    <div className="field-row">
                      <label className="field">
                        <span className="field__label">{tr('conn.host')}</span>
                        <input
                          className="input"
                          value={form.host}
                          onChange={(e) => update('host', e.target.value)}
                          placeholder={defaults.host}
                        />
                      </label>
                      <label className="field field--narrow">
                        <span className="field__label">{tr('conn.port')}</span>
                        <input
                          className="input"
                          type="number"
                          min={1}
                          max={65535}
                          value={form.port}
                          onChange={(e) =>
                            setForm((prev) => ({
                              ...prev,
                              port: e.target.value,
                              portTouched: true
                            }))
                          }
                          placeholder={defaults.port ? String(defaults.port) : undefined}
                          title={
                            defaults.port
                              ? tr('conn.portDefault', { port: defaults.port })
                              : undefined
                          }
                        />
                      </label>
                    </div>

                    <div className="field-row">
                      <label className="field">
                        <span className="field__label">{tr('conn.user')}</span>
                        <input
                          className="input"
                          value={form.user}
                          onChange={(e) => update('user', e.target.value)}
                          placeholder={defaults.user}
                          autoComplete="off"
                        />
                      </label>
                      <label className="field">
                        <span className="field__label">{tr('conn.password')}</span>
                        <input
                          className="input"
                          type="password"
                          value={form.password}
                          onChange={(e) => update('password', e.target.value)}
                          autoComplete="new-password"
                          placeholder={
                            initial?.hasPassword ? tr('conn.keepPassword') : ''
                          }
                        />
                      </label>
                    </div>

                    <label className="field">
                      <span className="field__label">
                        {caps.serviceName
                          ? tr('conn.serviceName')
                          : tr('conn.databaseOptional')}
                      </span>
                      <input
                        className="input"
                        value={form.database}
                        onChange={(e) => update('database', e.target.value)}
                        placeholder={
                          caps.serviceName ? tr('conn.serviceNamePlaceholder') : undefined
                        }
                      />
                    </label>

                    {!caps.ssl && (
                      <p className="muted field__hint">{tr('conn.oracleNote')}</p>
                    )}
                  </>
                )}
              </>
            )}

            {tab === 'ssl' && caps.ssl && (
              <>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={form.ssl}
                    onChange={(e) => update('ssl', e.target.checked)}
                  />
                  <span>{tr('conn.useSsl')}</span>
                </label>

                {form.ssl && (
                  <>
                    <label className="field">
                      <span className="field__label">{tr('conn.sslMode')}</span>
                      <select
                        className="input"
                        value={form.sslMode}
                        onChange={(e) => update('sslMode', e.target.value as SslMode)}
                      >
                        <option value="require">{tr('conn.sslRequire')}</option>
                        <option value="verify-ca">{tr('conn.sslVerifyCa')}</option>
                        <option value="verify-full">{tr('conn.sslVerifyFull')}</option>
                      </select>
                    </label>

                    <label className="field">
                      <span className="field__label">{tr('conn.caCert')}</span>
                      <div className="file-picker">
                        <input
                          className="input"
                          value={form.sslCaPath}
                          onChange={(e) => update('sslCaPath', e.target.value)}
                          placeholder="C:\certs\ca.pem"
                        />
                        <button
                          type="button"
                          className="btn btn--ghost btn--small"
                          onClick={() => void browseFile('sslCaPath')}
                          disabled={testing || saving}
                        >
                          {tr('conn.browse')}
                        </button>
                      </div>
                    </label>

                    <div className="field-row">
                      <label className="field">
                        <span className="field__label">{tr('conn.clientCert')}</span>
                        <div className="file-picker">
                          <input
                            className="input"
                            value={form.sslCertPath}
                            onChange={(e) => update('sslCertPath', e.target.value)}
                            placeholder="client-cert.pem"
                          />
                          <button
                            type="button"
                            className="btn btn--ghost btn--small"
                            onClick={() => void browseFile('sslCertPath')}
                            disabled={testing || saving}
                          >
                            {tr('conn.browse')}
                          </button>
                        </div>
                      </label>
                      <label className="field">
                        <span className="field__label">{tr('conn.clientKey')}</span>
                        <div className="file-picker">
                          <input
                            className="input"
                            value={form.sslKeyPath}
                            onChange={(e) => update('sslKeyPath', e.target.value)}
                            placeholder="client-key.pem"
                          />
                          <button
                            type="button"
                            className="btn btn--ghost btn--small"
                            onClick={() => void browseFile('sslKeyPath')}
                            disabled={testing || saving}
                          >
                            {tr('conn.browse')}
                          </button>
                        </div>
                      </label>
                    </div>

                    <label className="field">
                      <span className="field__label">{tr('conn.serverName')}</span>
                      <input
                        className="input"
                        value={form.sslServername}
                        onChange={(e) => update('sslServername', e.target.value)}
                        placeholder="db.example.com"
                      />
                    </label>

                    <p className="muted field__hint">{tr('conn.certHint')}</p>
                  </>
                )}
              </>
            )}

            {tab === 'ssh' && caps.ssh && (
              <>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={form.sshEnabled}
                    onChange={(e) => update('sshEnabled', e.target.checked)}
                  />
                  <span>{tr('conn.useSsh')}</span>
                </label>

                {form.sshEnabled && (
                  <>
                    <div className="field-row">
                      <label className="field">
                        <span className="field__label">{tr('conn.sshHost')}</span>
                        <input
                          className="input"
                          value={form.sshHost}
                          onChange={(e) => update('sshHost', e.target.value)}
                          placeholder="bastion.example.com"
                        />
                      </label>
                      <label className="field field--narrow">
                        <span className="field__label">{tr('conn.port')}</span>
                        <input
                          className="input"
                          type="number"
                          value={form.sshPort}
                          onChange={(e) => update('sshPort', e.target.value)}
                        />
                      </label>
                    </div>

                    <label className="field">
                      <span className="field__label">{tr('conn.sshUser')}</span>
                      <input
                        className="input"
                        value={form.sshUser}
                        onChange={(e) => update('sshUser', e.target.value)}
                        autoComplete="off"
                      />
                    </label>

                    <label className="field">
                      <span className="field__label">{tr('conn.auth')}</span>
                      <select
                        className="input"
                        value={form.sshAuthType}
                        onChange={(e) =>
                          update(
                            'sshAuthType',
                            e.target.value as 'password' | 'privateKey'
                          )
                        }
                      >
                        <option value="password">{tr('conn.authPassword')}</option>
                        <option value="privateKey">{tr('conn.authKey')}</option>
                      </select>
                    </label>

                    {form.sshAuthType === 'password' ? (
                      <label className="field">
                        <span className="field__label">{tr('conn.sshPassword')}</span>
                        <input
                          className="input"
                          type="password"
                          value={form.sshPassword}
                          onChange={(e) => update('sshPassword', e.target.value)}
                          autoComplete="new-password"
                          placeholder={
                            initial?.hasSshPassword ? tr('conn.keepPassword') : ''
                          }
                        />
                      </label>
                    ) : (
                      <>
                        <label className="field">
                          <span className="field__label">{tr('conn.privateKey')}</span>
                          <div className="file-picker">
                            <input
                              className="input"
                              value={form.sshKeyPath}
                              onChange={(e) => update('sshKeyPath', e.target.value)}
                              placeholder="C:\Users\me\.ssh\id_ed25519"
                            />
                            <button
                              type="button"
                              className="btn btn--ghost btn--small"
                              onClick={() => void browseSshKey()}
                              disabled={testing || saving}
                            >
                              {tr('conn.browse')}
                            </button>
                          </div>
                        </label>
                        <label className="field">
                          <span className="field__label">{tr('conn.passphrase')}</span>
                          <input
                            className="input"
                            type="password"
                            value={form.sshPassphrase}
                            onChange={(e) => update('sshPassphrase', e.target.value)}
                            autoComplete="new-password"
                            placeholder={
                              initial?.hasSshPassphrase ? tr('conn.keepPassword') : ''
                            }
                          />
                        </label>
                      </>
                    )}

                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={form.sshStrict}
                        onChange={(e) => update('sshStrict', e.target.checked)}
                      />
                      <span>{tr('conn.sshStrict')}</span>
                    </label>
                    <p className="muted field__hint">
                      {form.sshStrict ? tr('conn.sshStrictHint') : tr('conn.sshTofuHint')}
                    </p>
                    <p className="muted field__hint">
                      {fingerprint
                        ? tr('conn.fingerprint', { value: fingerprint })
                        : tr('conn.noFingerprint')}
                    </p>
                    <p className="muted field__hint">{tr('conn.sshRouteHint')}</p>
                  </>
                )}
              </>
            )}
          </div>

          {message && (
            <p className={`notice notice--${message.kind}`} role="status">
              {message.text}
            </p>
          )}

          <div className="modal__actions">
            <button
              className="btn btn--ghost"
              onClick={() => void handleTest()}
              disabled={testing || saving}
            >
              {testing ? tr('conn.testing') : tr('conn.test')}
            </button>
            <button className="btn" onClick={() => void handleSave()} disabled={saving}>
              {saving ? tr('conn.saving') : tr('conn.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
