import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiSettings, AiSettingsInput, AppInfo, UpdateState } from '@shared/types'
import type { AppSettings } from '@shared/settings'
import { MONO_FONTS } from '@shared/settings'
import { DEFAULT_KEYMAP, KEYMAP_ACTIONS, type ActionId } from '@shared/keymap'
import {
  CHROME_GROUPS,
  CORE_TOKENS,
  derivePalette,
  validatePalette
} from '@shared/customTheme'
import { LOCALE_LABELS, LOCALES, type Locale } from '@shared/i18n'
import { THEMES, type ThemeId } from './theme'
import { useSettings } from './settingsStore'
import { useLocale } from './i18n'
import { useFocusTrap } from './useFocusTrap'
import { unwrap } from './api'
import { IconClose } from './Icons'
import type { MessageKey } from '@shared/i18n'
import brandMark from './assets/brand/tupai.png'

type SectionId =
  'general' | 'appearance' | 'editor' | 'grid' | 'oracle' | 'ai' | 'keymap' | 'about'

const SECTIONS: { id: SectionId; labelKey: MessageKey }[] = [
  { id: 'general', labelKey: 'settings.section.general' },
  { id: 'appearance', labelKey: 'settings.section.appearance' },
  { id: 'editor', labelKey: 'settings.section.editor' },
  { id: 'grid', labelKey: 'settings.section.grid' },
  // Oracle is the only engine that may need a client library, so it gets its
  // own section instead of a footnote in General.
  { id: 'oracle', labelKey: 'settings.section.oracle' },
  { id: 'ai', labelKey: 'settings.section.ai' },
  { id: 'keymap', labelKey: 'settings.section.keymap' },
  { id: 'about', labelKey: 'settings.section.about' }
]

interface Props {
  onClose: () => void
  // Which section to open on. The AI panel deep-links here.
  initialSection?: SectionId
}

// One dialog for every preference. A sidebar keeps seven sections reachable
// without a scroll bar, which a single long form could not do.
export function SettingsDialog({
  onClose,
  initialSection = 'general'
}: Props): JSX.Element {
  const { settings, update, replace, reset, error } = useSettings()
  const { tr } = useLocale()
  const [section, setSection] = useState<SectionId>(initialSection)
  const dialogRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, true)

  const index = SECTIONS.findIndex((entry) => entry.id === section)

  function move(delta: number): void {
    const next = SECTIONS[(index + delta + SECTIONS.length) % SECTIONS.length]
    setSection(next.id)
    const button = navRef.current?.querySelector<HTMLButtonElement>(
      `[data-section="${next.id}"]`
    )
    button?.focus()
  }

  function onKey(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    move(event.key === 'ArrowDown' ? 1 : -1)
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={tr('settings.title')}
      onClick={onClose}
    >
      <div
        className="modal modal--settings"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="settings">
          <nav
            className="settings__nav"
            aria-label={tr('settings.sectionNav')}
            ref={navRef}
          >
            <h2 className="settings__title">{tr('settings.title')}</h2>
            {SECTIONS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                data-section={entry.id}
                className={`settings__nav-item${entry.id === section ? ' is-active' : ''}`}
                aria-current={entry.id === section ? 'page' : undefined}
                onClick={() => setSection(entry.id)}
              >
                {tr(entry.labelKey)}
              </button>
            ))}
            <div className="settings__nav-foot">
              <button
                className="btn btn--ghost btn--tiny"
                onClick={() => void reset()}
                title={tr('settings.resetDetail')}
              >
                {tr('settings.resetAll')}
              </button>
            </div>
          </nav>

          <section className="settings__body">
            <header className="settings__head">
              <h3>{tr(SECTIONS[index].labelKey)}</h3>
              <button
                className="icon-btn"
                onClick={onClose}
                aria-label={tr('common.close')}
              >
                <IconClose size={14} />
              </button>
            </header>

            {error && (
              <p className="notice notice--error" role="alert">
                {tr('settings.saveFailed', { message: error })}
              </p>
            )}

            {section === 'general' && (
              <GeneralSection settings={settings} update={update} replace={replace} />
            )}
            {section === 'appearance' && (
              <AppearanceSection settings={settings} update={update} />
            )}
            {section === 'editor' && (
              <EditorSection settings={settings} update={update} />
            )}
            {section === 'grid' && <GridSection settings={settings} update={update} />}
            {section === 'oracle' && (
              <OracleSection settings={settings} update={update} />
            )}
            {section === 'ai' && <AiSection settings={settings} update={update} />}
            {section === 'keymap' && (
              <KeymapSection settings={settings} update={update} />
            )}
            {section === 'about' && <AboutSection />}
          </section>
        </div>
      </div>
    </div>
  )
}

interface SectionProps {
  settings: AppSettings
  update: (patch: Partial<AppSettings> | Record<string, unknown>) => Promise<void>
}

function GeneralSection({
  settings,
  update,
  replace
}: SectionProps & { replace: (next: AppSettings) => void }): JSX.Element {
  const { tr } = useLocale()
  const [notice, setNotice] = useState<string | null>(null)

  async function exportSettings(): Promise<void> {
    try {
      const path = await unwrap(window.dbApi.exportSettings())
      setNotice(
        path
          ? tr('settings.general.exported', { path })
          : tr('settings.general.exportCancelled')
      )
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }

  async function importSettings(): Promise<void> {
    try {
      const chosen = await unwrap(
        window.dbApi.openFileDialog([{ name: 'JSON', extensions: ['json'] }])
      )
      if (!chosen) return
      const imported = await unwrap(window.dbApi.importSettings(chosen))
      replace(imported)
      setNotice(tr('settings.general.imported'))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="settings__pane">
      <fieldset className="settings__group">
        <legend>{tr('settings.general.language')}</legend>
        <p className="settings__hint">{tr('settings.general.languageHint')}</p>
        {/* A dropdown rather than a radio row: the list grows with each
            language, and five stacked radios pushed the rest of the section
            below the fold. Each label is written in its own language so someone
            who cannot read the current one can still find theirs. */}
        <label className="settings__field settings__field--inline">
          <span>{tr('settings.languageLabel')}</span>
          <select
            className="input"
            value={settings.general.locale}
            onChange={(e) =>
              void update({
                general: { ...settings.general, locale: e.target.value as Locale }
              })
            }
          >
            {LOCALES.map((locale: Locale) => (
              <option key={locale} value={locale}>
                {LOCALE_LABELS[locale]}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="settings__group">
        <legend>{tr('settings.general.behavior')}</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.general.confirmOnClose}
            onChange={(e) =>
              void update({
                general: { ...settings.general, confirmOnClose: e.target.checked }
              })
            }
          />
          <span>{tr('settings.general.confirmClose')}</span>
        </label>
      </fieldset>

      <fieldset className="settings__group">
        <legend>{tr('settings.general.transfer')}</legend>
        <p className="settings__hint">{tr('settings.general.transferHint')}</p>
        <div className="settings__actions">
          <button
            className="btn btn--small btn--ghost"
            onClick={() => void exportSettings()}
          >
            {tr('settings.general.export')}
          </button>
          <button
            className="btn btn--small btn--ghost"
            onClick={() => void importSettings()}
          >
            {tr('settings.general.import')}
          </button>
        </div>
        {notice && <p className="muted settings__hint">{notice}</p>}
      </fieldset>
    </div>
  )
}

function AppearanceSection({ settings, update }: SectionProps): JSX.Element {
  const { tr } = useLocale()
  const [showPalette, setShowPalette] = useState(settings.general.themeId === 'custom')

  return (
    <div className="settings__pane">
      <fieldset className="settings__group">
        <legend>{tr('settings.appearance.theme')}</legend>
        <p className="settings__hint">{tr('settings.appearance.themeHint')}</p>
        <div className="settings__themes">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`settings__theme${
                settings.general.themeId === theme.id ? ' is-active' : ''
              }`}
              onClick={() => {
                void update({
                  general: { ...settings.general, themeId: theme.id as ThemeId }
                })
                if (theme.id === 'custom') setShowPalette(true)
              }}
            >
              <span
                className="settings__swatch"
                data-preview-theme={theme.id}
                aria-hidden
              />
              <span>{tr(theme.labelKey)}</span>
            </button>
          ))}
        </div>
      </fieldset>

      {showPalette && <PaletteEditor settings={settings} update={update} />}

      <fieldset className="settings__group">
        <legend>{tr('settings.appearance.zoom')}</legend>
        <p className="settings__hint">{tr('settings.appearance.zoomHint')}</p>
        <div className="settings__row">
          <input
            type="range"
            min={0.8}
            max={1.5}
            step={0.05}
            value={settings.display.zoomFactor}
            onChange={(e) =>
              void update({ display: { zoomFactor: Number(e.target.value) } })
            }
            aria-label={tr('settings.appearance.zoom')}
          />
          <span className="settings__value">
            {Math.round(settings.display.zoomFactor * 100)}%
          </span>
          <button
            className="btn btn--ghost btn--tiny"
            onClick={() => void update({ display: { zoomFactor: 1 } })}
          >
            {tr('settings.appearance.zoomReset')}
          </button>
        </div>
      </fieldset>
    </div>
  )
}

function PaletteEditor({ settings, update }: SectionProps): JSX.Element {
  const { tr } = useLocale()
  const [base, setBase] = useState<'light' | 'dark'>('light')
  const [core, setCore] = useState<Record<string, string>>({})
  const [advanced, setAdvanced] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const stored = settings.customTheme[base].tokens
  // Start from the stored palette, or the derivation of the shipped seed, so
  // the editor never opens on an empty form.
  const current = useMemo(
    () => (Object.keys(stored).length > 0 ? stored : derivePalette(base)),
    [stored, base]
  )
  const validation = useMemo(() => validatePalette(current), [current])

  function setToken(token: string, value: string): void {
    setNotice(null)
    void update({
      customTheme: { [base]: { tokens: { ...stored, ...current, [token]: value } } }
    })
  }

  function derive(): void {
    const next = derivePalette(base, core as never)
    setNotice(null)
    void update({ customTheme: { [base]: { tokens: next } } })
  }

  return (
    <fieldset className="settings__group">
      <legend>{tr('theme.custom.title')}</legend>
      <p className="settings__hint">{tr('theme.custom.hint')}</p>

      <div className="settings__row">
        <span className="settings__label">{tr('theme.custom.mode')}</span>
        <div className="settings__choices">
          {(['light', 'dark'] as const).map((value) => (
            <label key={value} className="settings__choice">
              <input
                type="radio"
                name="palette-base"
                checked={base === value}
                onChange={() => setBase(value)}
              />
              <span>
                {value === 'light' ? tr('theme.custom.light') : tr('theme.custom.dark')}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="settings__core">
        <span className="settings__label">{tr('theme.custom.core')}</span>
        <div className="settings__core-grid">
          {CORE_TOKENS.map((token) => (
            <label key={token} className="settings__color">
              <input
                type="color"
                value={current[token] ?? '#000000'}
                onChange={(e) => {
                  setCore((prev) => ({ ...prev, [token]: e.target.value }))
                  setToken(token, e.target.value)
                }}
                aria-label={token}
              />
              <span className="settings__color-name">{token.replace('--', '')}</span>
              <input
                className="input input--tight settings__hex"
                value={current[token] ?? ''}
                onChange={(e) => setToken(token, e.target.value)}
                spellCheck={false}
              />
            </label>
          ))}
        </div>
        <button className="btn btn--ghost btn--tiny" onClick={derive}>
          {tr('theme.custom.derive')}
        </button>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={advanced}
          onChange={(e) => setAdvanced(e.target.checked)}
        />
        <span>{tr('theme.custom.advanced')}</span>
      </label>

      {advanced && (
        <>
          <p className="settings__hint">{tr('theme.custom.advancedHint')}</p>
          {CHROME_GROUPS.map((group) => (
            <div key={group.id} className="settings__token-group">
              <span className="settings__label">{tr(group.labelKey)}</span>
              <div className="settings__core-grid">
                {group.tokens.map((token) => (
                  <label key={token} className="settings__color">
                    <input
                      type="color"
                      value={current[token] ?? '#000000'}
                      onChange={(e) => setToken(token, e.target.value)}
                      aria-label={token}
                    />
                    <span className="settings__color-name">
                      {token.replace('--', '')}
                    </span>
                    <input
                      className="input input--tight settings__hex"
                      value={current[token] ?? ''}
                      onChange={(e) => setToken(token, e.target.value)}
                      spellCheck={false}
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      <div
        className={`settings__contrast${validation.ok ? ' is-ok' : ' is-bad'}`}
        role="status"
      >
        <p>
          {validation.ok
            ? tr('theme.custom.valid')
            : tr('theme.custom.invalid', { count: validation.failures.length })}
        </p>
        <ul>
          {validation.failures.map((failure) => (
            <li key={`${failure.fg}:${failure.bg}`}>
              {tr('theme.custom.failure', {
                fg: failure.fg,
                bg: failure.bg,
                ratio: failure.ratio,
                min: failure.min
              })}
            </li>
          ))}
          {validation.warnings.map((warning) => (
            <li key={`w:${warning.fg}:${warning.bg}`} className="settings__warning">
              {tr('theme.custom.warning', {
                fg: warning.fg,
                bg: warning.bg,
                ratio: warning.ratio
              })}
            </li>
          ))}
        </ul>
      </div>

      {notice && <p className="muted settings__hint">{notice}</p>}
    </fieldset>
  )
}

function EditorSection({ settings, update }: SectionProps): JSX.Element {
  const { tr } = useLocale()
  const editor = settings.editor
  return (
    <div className="settings__pane">
      <label className="settings__field">
        <span>{tr('settings.editor.fontFamily')}</span>
        <select
          className="input"
          value={editor.fontFamily}
          onChange={(e) =>
            void update({ editor: { ...editor, fontFamily: e.target.value } })
          }
        >
          {MONO_FONTS.map((font) => (
            <option key={font} value={font}>
              {font.split(',')[0].replace(/'/g, '')}
            </option>
          ))}
        </select>
      </label>

      <label className="settings__field">
        <span>
          {tr('settings.editor.fontSize')} ({editor.fontSize}px)
        </span>
        <input
          type="range"
          min={11}
          max={20}
          step={1}
          value={editor.fontSize}
          onChange={(e) =>
            void update({ editor: { ...editor, fontSize: Number(e.target.value) } })
          }
        />
      </label>

      <label className="settings__field">
        <span>{tr('settings.editor.tabSize')}</span>
        <select
          className="input"
          value={editor.tabSize}
          onChange={(e) =>
            void update({
              editor: { ...editor, tabSize: Number(e.target.value) as 2 | 4 | 8 }
            })
          }
        >
          {[2, 4, 8].map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={editor.wordWrap}
          onChange={(e) =>
            void update({ editor: { ...editor, wordWrap: e.target.checked } })
          }
        />
        <span>{tr('settings.editor.wordWrap')}</span>
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={editor.minimap}
          onChange={(e) =>
            void update({ editor: { ...editor, minimap: e.target.checked } })
          }
        />
        <span>{tr('settings.editor.minimap')}</span>
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={editor.lineNumbers}
          onChange={(e) =>
            void update({ editor: { ...editor, lineNumbers: e.target.checked } })
          }
        />
        <span>{tr('settings.editor.lineNumbers')}</span>
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={editor.runSelection}
          onChange={(e) =>
            void update({ editor: { ...editor, runSelection: e.target.checked } })
          }
        />
        <span>{tr('settings.editor.runSelection')}</span>
      </label>
      <p className="settings__hint">{tr('settings.editor.runSelectionHint')}</p>
    </div>
  )
}

function GridSection({ settings, update }: SectionProps): JSX.Element {
  const { tr } = useLocale()
  const grid = settings.grid
  return (
    <div className="settings__pane">
      <label className="settings__field">
        <span>
          {tr('settings.grid.fontSize')} ({grid.fontSize}px)
        </span>
        <input
          type="range"
          min={11}
          max={16}
          step={1}
          value={grid.fontSize}
          onChange={(e) =>
            void update({ grid: { ...grid, fontSize: Number(e.target.value) } })
          }
        />
      </label>
      <label className="settings__field">
        <span>{tr('settings.grid.pageSize')}</span>
        <select
          className="input"
          value={grid.pageSize}
          onChange={(e) =>
            void update({ grid: { ...grid, pageSize: Number(e.target.value) } })
          }
        >
          {[50, 100, 200].map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <p className="settings__hint">{tr('settings.grid.pageSizeHint')}</p>
    </div>
  )
}

const ORACLE_CLIENT_DOWNLOAD =
  'https://www.oracle.com/database/technologies/instant-client/downloads.html'

function OracleSection({ settings, update }: SectionProps): JSX.Element {
  const { tr } = useLocale()
  const oracle = settings.oracle
  // The field is committed on blur rather than on every keystroke: each change
  // is written to disk and the driver re-initialises on the next attempt, so
  // typing a path one character at a time would retry a dozen broken folders.
  const [draft, setDraft] = useState(oracle.clientLibDir)

  useEffect(() => {
    setDraft(oracle.clientLibDir)
  }, [oracle.clientLibDir])

  async function pickFolder(): Promise<void> {
    try {
      const chosen = await unwrap(
        window.dbApi.openFileDialog(undefined, { directory: true })
      )
      if (!chosen) return
      setDraft(chosen)
      await update({ oracle: { ...oracle, clientLibDir: chosen } })
    } catch {
      // A cancelled dialog is not an error; the typed value stays.
    }
  }

  return (
    <div className="settings__pane">
      <p className="settings__hint">{tr('settings.oracle.hint')}</p>
      <label className="settings__field">
        <span>{tr('settings.oracle.client')}</span>
        <input
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft === oracle.clientLibDir) return
            void update({ oracle: { ...oracle, clientLibDir: draft } })
          }}
          placeholder={tr('settings.oracle.clientPlaceholder')}
          spellCheck={false}
        />
      </label>
      <div className="settings__actions">
        <button className="btn btn--small btn--ghost" onClick={() => void pickFolder()}>
          {tr('settings.oracle.browse')}
        </button>
        <button
          className="btn btn--small btn--ghost"
          onClick={() => {
            void window.dbApi.openExternal(ORACLE_CLIENT_DOWNLOAD)
          }}
        >
          {tr('settings.oracle.download')}
        </button>
        <span className="settings__spacer" />
        <button
          className="btn btn--small btn--ghost"
          disabled={!oracle.clientLibDir && !draft}
          onClick={() => {
            setDraft('')
            void update({ oracle: { ...oracle, clientLibDir: '' } })
          }}
        >
          {tr('settings.oracle.clear')}
        </button>
      </div>
      <p className="settings__hint">{tr('settings.oracle.downloadHint')}</p>
      <p className="settings__hint">{tr('settings.oracle.modeHint')}</p>
    </div>
  )
}

function AiSection(_props: SectionProps): JSX.Element {
  const { tr } = useLocale()
  // The AI block has one writer in main (saveAiSettings), so this section keeps
  // its own draft and sends whole values there. Going through the generic
  // settings update would race the model list main caches after a fetch.
  const { refresh } = useSettings()
  const [draft, setDraft] = useState<AiSettings | null>(null)
  const [fetching, setFetching] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    unwrap(window.dbApi.getAiSettings())
      .then((stored) => {
        setDraft(stored)
        setHasKey(stored.hasApiKey)
      })
      .catch((err) => setNotice(err instanceof Error ? err.message : String(err)))
  }, [])

  if (!draft) {
    return (
      <div className="settings__pane">
        <p className="muted settings__hint">{tr('common.loading')}</p>
      </div>
    )
  }

  const models = draft.models
  const options =
    draft.model && !models.includes(draft.model) ? [draft.model, ...models] : models

  // Writes one or more fields and keeps the draft in step with what main saved.
  async function commit(patch: Partial<AiSettingsInput>): Promise<void> {
    setSaving(true)
    setNotice(null)
    try {
      const next = { ...draft!, ...patch }
      const stored = await unwrap(
        window.dbApi.saveAiSettings({
          baseUrl: next.baseUrl,
          apiKey: patch.apiKey,
          model: next.model,
          temperature: next.temperature,
          maxTokens: next.maxTokens,
          systemPrompt: next.systemPrompt,
          previewRows: next.previewRows
        })
      )
      setDraft(stored)
      setHasKey(stored.hasApiKey)
      if (patch.apiKey) setApiKey('')
      // The assistant reads previewRows from the shared settings store.
      await refresh()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function fetchModels(): Promise<void> {
    setFetching(true)
    setNotice(null)
    try {
      // Main saves the base URL it used and the ids it found.
      const found = await unwrap(window.dbApi.listAiModels(draft!.baseUrl))
      setDraft(await unwrap(window.dbApi.getAiSettings()))
      await refresh()
      setNotice(
        found.length === 0
          ? tr('settings.ai.noModels')
          : tr('settings.ai.modelsFound', { count: found.length })
      )
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setFetching(false)
    }
  }

  async function save(): Promise<void> {
    setSaving(true)
    setNotice(null)
    try {
      const stored = await unwrap(
        window.dbApi.saveAiSettings({
          baseUrl: draft!.baseUrl,
          apiKey: apiKey || undefined,
          model: draft!.model,
          temperature: draft!.temperature,
          maxTokens: draft!.maxTokens,
          systemPrompt: draft!.systemPrompt,
          previewRows: draft!.previewRows
        })
      )
      setDraft(stored)
      setHasKey(stored.hasApiKey)
      setApiKey('')
      await refresh()
      setNotice(tr('settings.ai.saved'))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings__pane">
      <p className="settings__hint">{tr('settings.ai.hint')}</p>

      <label className="settings__field">
        <span>{tr('settings.ai.baseUrl')}</span>
        <input
          className="input"
          value={draft.baseUrl}
          onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          onBlur={() => void commit({ baseUrl: draft.baseUrl })}
          spellCheck={false}
        />
      </label>

      <label className="settings__field">
        <span>{tr('settings.ai.apiKey')}</span>
        <input
          className="input"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasKey ? tr('settings.ai.keyStored') : 'sk-...'}
          spellCheck={false}
          autoComplete="off"
        />
        <span className="settings__hint">{tr('settings.ai.encryptedHint')}</span>
      </label>

      <div className="settings__field">
        <span>{tr('settings.ai.model')}</span>
        <div className="settings__row">
          {options.length > 0 ? (
            <select
              className="input"
              value={draft.model}
              onChange={(e) => {
                setDraft({ ...draft, model: e.target.value })
                void commit({ model: e.target.value })
              }}
            >
              <option value="">{tr('ai.chooseModel')}</option>
              {options.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              onBlur={() => void commit({ model: draft.model })}
              placeholder="gpt-4o-mini"
              spellCheck={false}
            />
          )}
          <button
            className="btn btn--small btn--ghost"
            onClick={() => void fetchModels()}
            disabled={fetching}
          >
            {fetching ? tr('settings.ai.fetching') : tr('settings.ai.fetchModels')}
          </button>
        </div>
      </div>

      <label className="settings__field">
        <span>
          {tr('settings.ai.temperature')} ({draft.temperature})
        </span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.1}
          value={draft.temperature}
          onChange={(e) => {
            const temperature = Number(e.target.value)
            setDraft({ ...draft, temperature })
            void commit({ temperature })
          }}
        />
      </label>

      <label className="settings__field">
        <span>{tr('settings.ai.maxTokens')}</span>
        <input
          className="input"
          type="number"
          min={1}
          max={200000}
          value={draft.maxTokens}
          onChange={(e) => setDraft({ ...draft, maxTokens: Number(e.target.value) })}
          onBlur={() => void commit({ maxTokens: draft.maxTokens })}
        />
      </label>

      <div className="settings__field">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={draft.previewRows}
            onChange={(e) => {
              const previewRows = e.target.checked
              setDraft({ ...draft, previewRows })
              void commit({ previewRows })
            }}
          />
          <span>{tr('settings.ai.previewRows')}</span>
        </label>
        <span className="settings__hint">{tr('settings.ai.previewRowsHint')}</span>
      </div>

      <label className="settings__field">
        <span>{tr('settings.ai.systemPrompt')}</span>
        <textarea
          className="input settings__prompt"
          value={draft.systemPrompt}
          onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
          onBlur={() => void commit({ systemPrompt: draft.systemPrompt })}
          rows={5}
          spellCheck={false}
        />
        <span className="settings__hint">{tr('settings.ai.systemPromptHint')}</span>
      </label>

      <div className="settings__actions">
        <button className="btn btn--small" onClick={() => void save()} disabled={saving}>
          {saving ? tr('conn.saving') : tr('settings.ai.save')}
        </button>
      </div>
      {notice && <p className="muted settings__hint">{notice}</p>}
    </div>
  )
}

function KeymapSection({ settings, update }: SectionProps): JSX.Element {
  const { tr } = useLocale()
  const [recording, setRecording] = useState<ActionId | null>(null)
  const keymap = settings.keymap

  useEffect(() => {
    if (!recording) return
    // Captured so the closure sees a non-null action id.
    const action = recording
    function onKeyDown(event: KeyboardEvent): void {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(null)
        return
      }
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return
      const parts: string[] = []
      if (event.ctrlKey || event.metaKey) parts.push('Mod')
      if (event.shiftKey) parts.push('Shift')
      if (event.altKey) parts.push('Alt')
      parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key)
      const next = { ...keymap, [action]: parts.join('+') }
      setRecording(null)
      void update({ keymap: next })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, keymap, update])

  // Which other action already uses each binding, so a clash is visible before
  // the user saves it.
  const used = new Map<string, ActionId>()
  for (const action of KEYMAP_ACTIONS) {
    const value = keymap[action] ?? DEFAULT_KEYMAP[action]
    used.set(value, action)
  }

  return (
    <div className="settings__pane">
      <p className="settings__hint">{tr('settings.keymap.hint')}</p>
      <table className="data-table settings__keymap">
        <thead>
          <tr>
            <th>{tr('settings.section.keymap')}</th>
            <th>Shortcut</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {KEYMAP_ACTIONS.map((action) => {
            const value = keymap[action] ?? DEFAULT_KEYMAP[action]
            const conflict = KEYMAP_ACTIONS.find(
              (other) =>
                other !== action && (keymap[other] ?? DEFAULT_KEYMAP[other]) === value
            )
            return (
              <tr key={action}>
                <td>{tr(`settings.keymap.action.${action}` as MessageKey)}</td>
                <td>
                  <code className="settings__binding">
                    {recording === action ? tr('settings.keymap.recording') : value}
                  </code>
                  {conflict && (
                    <span className="settings__conflict">
                      {tr('settings.keymap.conflict', {
                        action: tr(`settings.keymap.action.${conflict}` as MessageKey)
                      })}
                    </span>
                  )}
                </td>
                <td className="settings__keymap-actions">
                  <button
                    className="btn btn--tiny btn--ghost"
                    onClick={() => setRecording(recording === action ? null : action)}
                  >
                    {tr('settings.keymap.record')}
                  </button>
                  {keymap[action] && (
                    <button
                      className="btn btn--tiny btn--ghost"
                      onClick={() => {
                        const next = { ...keymap }
                        delete next[action]
                        void update({ keymap: next })
                      }}
                    >
                      {tr('settings.keymap.reset')}
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {recording && (
        <p className="muted settings__hint">{tr('settings.keymap.pressEscape')}</p>
      )}
    </div>
  )
}

function AboutSection(): JSX.Element {
  const { tr, dateTime } = useLocale()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    unwrap(window.dbApi.appInfo())
      .then(setInfo)
      .catch(() => setInfo(null))
    void window.dbApi.getUpdateState().then((res) => {
      if (res.ok && res.data) setUpdate(res.data)
    })
  }, [])

  // Main owns the update lifecycle, so the panel mirrors its events instead of
  // running its own poll.
  useEffect(() => {
    return window.dbApi.onUpdateState((next) => {
      if (next) setUpdate(next)
    })
  }, [])

  async function checkNow(): Promise<void> {
    setChecking(true)
    try {
      const next = await unwrap(window.dbApi.checkForUpdates())
      setUpdate(next)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  async function download(): Promise<void> {
    try {
      setUpdate(await unwrap(window.dbApi.downloadUpdate()))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }

  async function install(): Promise<void> {
    try {
      await unwrap(window.dbApi.installUpdate())
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    }
  }

  async function openPage(): Promise<void> {
    await window.dbApi.openUpdatePage().catch(() => undefined)
  }

  if (!info) return <p className="muted settings__hint">{tr('settings.loading')}</p>

  const phase = update?.phase ?? 'idle'
  const busy = checking || phase === 'checking'
  const statusText = ((): string | null => {
    if (!update) return null
    if (phase === 'checking') return tr('settings.about.checking')
    if (phase === 'not-available')
      return tr('settings.about.upToDate', { version: update.currentVersion })
    if (phase === 'available')
      return tr('settings.about.available', { version: update.version ?? '' })
    if (phase === 'downloading')
      return tr('settings.about.downloading', { percent: update.percent ?? 0 })
    if (phase === 'downloaded') return tr('settings.about.downloaded')
    if (phase === 'unsupported') return tr('settings.about.unsupported')
    if (phase === 'error')
      return tr('settings.about.updateFailed', { message: update.message ?? '' })
    return null
  })()

  async function copyDiagnostics(): Promise<void> {
    const text = [
      `Tupai ${info!.version}`,
      `build ${info!.buildSha} (${info!.buildTime})`,
      `${info!.packaged ? 'release' : 'development'}`,
      `electron ${info!.electron} · chrome ${info!.chrome} · node ${info!.node}`,
      `${info!.platform}/${info!.arch}`,
      `userData ${info!.userData}`
    ].join('\n')
    await window.dbApi.clipboardWrite(text)
    setNotice(tr('settings.about.copied'))
  }

  return (
    <div className="settings__pane">
      <div className="settings__about">
        <div className="settings__about-mark">
          <img className="settings__about-logo" src={brandMark} alt="" />
        </div>
        <div>
          <p className="settings__about-name">Tupai</p>
          <p className="muted settings__hint">
            {tr('settings.about.version')} {info.version} ·{' '}
            {info.packaged ? tr('settings.about.release') : tr('settings.about.dev')}
          </p>
        </div>
      </div>

      <dl className="settings__info">
        <dt>{tr('settings.about.build')}</dt>
        <dd>
          <code>{info.buildSha}</code>
        </dd>
        <dt>{tr('settings.about.buildTime')}</dt>
        <dd>{info.buildTime}</dd>
        <dt>{tr('settings.about.runtime')}</dt>
        <dd>
          Electron {info.electron} · Chromium {info.chrome} · Node {info.node}
        </dd>
        <dt>{tr('settings.about.system')}</dt>
        <dd>
          {info.platform} / {info.arch}
        </dd>
        <dt>{tr('settings.about.userData')}</dt>
        <dd>
          <code className="settings__path">{info.userData}</code>
          <button
            className="btn btn--tiny btn--ghost"
            onClick={() => void window.dbApi.openAppPath('userData')}
          >
            {tr('settings.about.open')}
          </button>
        </dd>
        <dt>{tr('settings.about.logFile')}</dt>
        <dd>
          <code className="settings__path">{info.logFile}</code>
          <button
            className="btn btn--tiny btn--ghost"
            onClick={() => void window.dbApi.openAppPath('logFile')}
          >
            {tr('settings.about.open')}
          </button>
        </dd>
      </dl>

      <fieldset className="settings__group">
        <legend>{tr('settings.about.update')}</legend>
        <p className="settings__hint">{tr('settings.about.updateHint')}</p>
        <div className="settings__actions">
          <button
            className="btn btn--small btn--ghost"
            onClick={() => void checkNow()}
            disabled={busy || phase === 'downloading'}
          >
            {busy ? tr('settings.about.checking') : tr('settings.about.check')}
          </button>
          {phase === 'available' && !update?.manual && (
            <button className="btn btn--small" onClick={() => void download()}>
              {tr('settings.about.download')}
            </button>
          )}
          {phase === 'downloaded' && (
            <button className="btn btn--small" onClick={() => void install()}>
              {tr('settings.about.install')}
            </button>
          )}
          {update?.manual && (phase === 'available' || phase === 'error') && (
            <button className="btn btn--small" onClick={() => void openPage()}>
              {tr('settings.about.openDownload')}
            </button>
          )}
        </div>
        {statusText && (
          <p
            className={`settings__hint${phase === 'error' ? ' is-error' : ''}`}
            role={phase === 'error' ? 'alert' : 'status'}
          >
            {statusText}
          </p>
        )}
        {update?.manual && (phase === 'available' || phase === 'error') && (
          <p className="settings__hint">{tr('settings.about.manualHint')}</p>
        )}
        {phase === 'downloading' && (
          <div
            className="settings__progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={update?.percent ?? 0}
          >
            <span style={{ width: `${update?.percent ?? 0}%` }} />
          </div>
        )}
        {update?.checkedAt && (
          <p className="muted settings__hint">
            {tr('settings.about.checkedAt', { time: dateTime(update.checkedAt) })}
          </p>
        )}
      </fieldset>

      <div className="settings__actions">
        <button
          className="btn btn--small btn--ghost"
          onClick={() => void copyDiagnostics()}
        >
          {tr('settings.about.copy')}
        </button>
      </div>
      {notice && <p className="muted settings__hint">{notice}</p>}
    </div>
  )
}
