import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type {
  AiSettings,
  AiSettingsInput,
  AppInfo,
  LogFilesInfo,
  UpdateState
} from '@shared/types'
import type { AppSettings } from '@shared/settings'
import { MONO_FONTS } from '@shared/settings'
import {
  DEFAULT_KEYMAP,
  KEYMAP_ACTIONS,
  formatBindingLabel,
  type ActionId
} from '@shared/keymap'
import {
  CHROME_GROUPS,
  PRIMARY_TOKENS,
  derivePalette,
  malformedTokens,
  resolvePalette,
  tokenLabelKey,
  validatePalette,
  type PaletteBase
} from '@shared/customTheme'
import { parseColor } from '@shared/contrast'
import {
  EDITOR_SYNTAX_KEYS,
  isCustomSyntax,
  resolveSyntaxColors,
  type EditorSyntaxKey
} from '@shared/editorColors'
import { LOCALE_LABELS, LOCALES, type Locale } from '@shared/i18n'
import type { MessageKey } from '@shared/i18n'
import { THEMES, themeBase, themeById, type ThemeId } from './theme'
import { useSettings } from './settingsStore'
import { useLocale } from './i18n'
import { ColorField } from './ColorField'
import { useFocusTrap } from './useFocusTrap'
import { unwrap } from './api'
import { sameClientDir } from '@shared/oracleClientPath'
import {
  IconActivity,
  IconChat,
  IconDatabase,
  IconInfo,
  IconKey,
  IconPencil,
  IconSettings,
  IconSun,
  IconTable
} from './Icons'
import brandMark from './assets/brand/tupai.png'
import type { CSSProperties, ComponentType } from 'react'

export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'editor'
  | 'grid'
  | 'oracle'
  | 'ai'
  | 'keymap'
  | 'log'
  | 'about'

const SECTIONS: {
  id: SettingsSectionId
  labelKey: MessageKey
  Icon: ComponentType<{ size?: number }>
}[] = [
  { id: 'general', labelKey: 'settings.section.general', Icon: IconSettings },
  { id: 'appearance', labelKey: 'settings.section.appearance', Icon: IconSun },
  { id: 'editor', labelKey: 'settings.section.editor', Icon: IconPencil },
  { id: 'grid', labelKey: 'settings.section.grid', Icon: IconTable },
  // Oracle is the only engine that may need a client library, so it gets its
  // own section instead of a footnote in General.
  { id: 'oracle', labelKey: 'settings.section.oracle', Icon: IconDatabase },
  { id: 'ai', labelKey: 'settings.section.ai', Icon: IconChat },
  { id: 'keymap', labelKey: 'settings.section.keymap', Icon: IconKey },
  { id: 'log', labelKey: 'settings.section.log', Icon: IconActivity },
  { id: 'about', labelKey: 'settings.section.about', Icon: IconInfo }
]

interface Props {
  // Which section to open on. The AI panel deep-links here.
  initialSection?: string
}

export function SettingsPage({ initialSection = 'general' }: Props): JSX.Element {
  const { settings, update, replace, reset, error, loading } = useSettings()
  const { tr } = useLocale()
  const [resetConfirm, setResetConfirm] = useState(false)
  const [titlebarInset, setTitlebarInset] = useState(12)
  const validSection = (value: string): SettingsSectionId =>
    SECTIONS.some((entry) => entry.id === value)
      ? (value as SettingsSectionId)
      : 'general'
  const [section, setSection] = useState<SettingsSectionId>(() =>
    validSection(initialSection)
  )
  const [reloadKey, setReloadKey] = useState(0)
  const navRef = useRef<HTMLElement>(null)
  const resetButtonRef = useRef<HTMLButtonElement>(null)
  const resetDialogRef = useRef<HTMLElement>(null)
  const titlebarRef = useRef<HTMLElement>(null)
  useFocusTrap(resetDialogRef, resetConfirm)

  useEffect(() => {
    document.title = `${tr('settings.title')} · Tupai`
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (resetConfirm) setResetConfirm(false)
      else void window.dbApi.closeSettingsWindow()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [tr, resetConfirm])

  useEffect(() => {
    const overlay = navigator.windowControlsOverlay
    if (!overlay) return

    const syncOverlay = (): void => {
      const active = overlay.visible
      document.documentElement.dataset.titlebarOverlay = active ? 'true' : 'false'
      const area = active ? overlay.getTitlebarAreaRect() : null
      const header = titlebarRef.current
      if (active && area && header) {
        setTitlebarInset(Math.max(12, Math.round(header.clientWidth - area.right) + 12))
        const zoom = window.dbApi.getZoom() || 1
        const height = Math.round(header.getBoundingClientRect().height * zoom)
        void window.dbApi
          .setTitleBarColors(
            'rgba(0,0,0,0)',
            getComputedStyle(document.body).color,
            height
          )
          .catch(() => undefined)
      } else {
        setTitlebarInset(12)
      }
    }

    syncOverlay()
    overlay.addEventListener('geometrychange', syncOverlay)
    window.addEventListener('resize', syncOverlay)
    return () => {
      overlay.removeEventListener('geometrychange', syncOverlay)
      window.removeEventListener('resize', syncOverlay)
      delete document.documentElement.dataset.titlebarOverlay
    }
  }, [settings.general.themeId, settings.display.zoomFactor])

  useEffect(() => {
    return window.dbApi.onUpdateState((state) => {
      if (state) setReloadKey((key) => key + 1)
    })
  }, [])

  useEffect(() => setSection(validSection(initialSection)), [initialSection])
  useEffect(() => {
    const onHashChange = (): void => {
      if (window.location.hash.startsWith('#settings=')) {
        setSection(validSection(window.location.hash.slice('#settings='.length)))
      }
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  useEffect(
    () => window.dbApi.onSettingsChanged(() => setReloadKey((key) => key + 1)),
    []
  )

  const index = SECTIONS.findIndex((entry) => entry.id === section)
  // macOS System Settings puts its panes in a toolbar strip; Windows and Linux
  // keep the left rail their users already know from other settings apps.
  const isMac = window.dbApi.platform === 'darwin'

  function move(delta: number): void {
    const next = SECTIONS[(index + delta + SECTIONS.length) % SECTIONS.length]
    setSection(next.id)
    const button = navRef.current?.querySelector<HTMLButtonElement>(
      `[data-section="${next.id}"]`
    )
    button?.focus()
  }

  function onKey(event: React.KeyboardEvent<HTMLElement>): void {
    if (!(event.target instanceof HTMLButtonElement)) return
    const forward = isMac ? 'ArrowRight' : 'ArrowDown'
    const backward = isMac ? 'ArrowLeft' : 'ArrowUp'
    if (event.key !== forward && event.key !== backward) return
    event.preventDefault()
    move(event.key === forward ? 1 : -1)
  }

  return (
    <main
      className={`settings-page${isMac ? ' settings-page--mac' : ''}`}
      onKeyDown={onKey}
    >
      <header
        className="settings-window-titlebar"
        ref={titlebarRef}
        style={{ paddingRight: titlebarInset }}
      >
        <span>{isMac ? tr('settings.title') : 'Tupai'}</span>
      </header>
      <div className="settings">
        <nav
          className="settings__nav"
          aria-label={tr('settings.sectionNav')}
          aria-orientation={isMac ? 'horizontal' : 'vertical'}
          role="tablist"
          ref={navRef}
        >
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`settings-tab-${entry.id}`}
              aria-controls="settings-panel"
              data-section={entry.id}
              aria-selected={entry.id === section}
              className={`settings__nav-item${entry.id === section ? ' is-active' : ''}`}
              onClick={() => setSection(entry.id)}
            >
              <span className="settings__nav-icon" aria-hidden="true">
                <entry.Icon size={isMac ? 19 : 15} />
              </span>
              <span className="settings__nav-label">{tr(entry.labelKey)}</span>
            </button>
          ))}
        </nav>

        <section
          className="settings__body"
          id="settings-panel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${section}`}
        >
          {error && (
            <p className="notice notice--error" role="alert">
              {tr('settings.saveFailed', { message: error })}
            </p>
          )}

          {loading ? (
            <p className="settings__state" role="status">
              {tr('settings.loading')}
            </p>
          ) : section === 'general' ? (
            <GeneralSection settings={settings} update={update} replace={replace} />
          ) : section === 'appearance' ? (
            <AppearanceSection settings={settings} update={update} />
          ) : section === 'editor' ? (
            <EditorSection settings={settings} update={update} />
          ) : section === 'grid' ? (
            <GridSection settings={settings} update={update} />
          ) : section === 'oracle' ? (
            <OracleSection settings={settings} update={update} />
          ) : section === 'ai' ? (
            <AiSection key={reloadKey} settings={settings} update={update} />
          ) : section === 'keymap' ? (
            <KeymapSection settings={settings} update={update} />
          ) : section === 'log' ? (
            <LogSection settings={settings} update={update} />
          ) : (
            <AboutSection />
          )}

          <footer className="settings__footer">
            <button
              className="btn btn--small btn--ghost"
              onClick={() => setResetConfirm(true)}
              title={tr('settings.resetDetail')}
              ref={resetButtonRef}
            >
              {tr('settings.resetAll')}
            </button>
          </footer>
        </section>
      </div>
      {resetConfirm && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal"
            ref={resetDialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="settings-reset-title"
          >
            <h2 id="settings-reset-title">{tr('settings.resetConfirm')}</h2>
            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={() => setResetConfirm(false)}>
                {tr('common.cancel')}
              </button>
              <button
                className="btn"
                onClick={() => {
                  setResetConfirm(false)
                  void reset()
                  requestAnimationFrame(() => resetButtonRef.current?.focus())
                }}
              >
                {tr('settings.resetAll')}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
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
  // The custom chip previews the stored palette, not the colours of whichever
  // theme is active. Without this a green custom palette showed an orange chip
  // while a shipped theme was selected, which read as "my colours were lost".
  const customSwatch = useMemo(() => {
    const base = settings.customTheme.base ?? 'light'
    const tokens = resolvePalette(base, settings.customTheme[base].tokens)
    return {
      '--swatch-bg': tokens['--surface'],
      '--swatch-accent': tokens['--accent']
    } as CSSProperties
  }, [settings.customTheme])

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
              aria-pressed={settings.general.themeId === theme.id}
              className={`settings__theme${
                settings.general.themeId === theme.id ? ' is-active' : ''
              }`}
              onClick={() =>
                void update({
                  general: { ...settings.general, themeId: theme.id as ThemeId }
                })
              }
            >
              <span
                className="settings__swatch"
                data-preview-theme={theme.id}
                style={theme.id === 'custom' ? customSwatch : undefined}
                aria-hidden
              />
              <span>{tr(theme.labelKey)}</span>
            </button>
          ))}
        </div>
      </fieldset>

      {/* Always visible: the section can prepare a palette before the theme is
          switched on, and it says so instead of hiding behind the theme list. */}
      <PaletteEditor settings={settings} update={update} />

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
  // The variant being edited is also the one the app renders, so switching to
  // Dark shows the dark palette immediately instead of only in the preview.
  const [base, setBase] = useState<PaletteBase>(
    () => settings.customTheme.base ?? themeById(settings.general.themeId).base
  )
  const [advanced, setAdvanced] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  // Text of a hex field being typed, keyed by palette and token. Kept apart from
  // the saved palette so a half-finished value is neither written to disk nor
  // replaced by the previous colour under the caret.
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const stored = settings.customTheme[base].tokens
  // Every field shows a real colour: tokens the derivation decided are filled in
  // here instead of leaving the advanced list full of empty boxes.
  const current = useMemo(() => resolvePalette(base, stored), [stored, base])
  const draftKey = (token: string): string => `${base}:${token}`
  // Saved values plus whatever is being typed: a half-finished code is not on
  // disk yet, but it still has to be reported or the form would say every colour
  // is fine while one field plainly is not.
  const malformed = useMemo(() => {
    const bad = malformedTokens(stored)
    for (const [key, value] of Object.entries(drafts)) {
      if (!key.startsWith(`${base}:`)) continue
      const token = key.slice(base.length + 1)
      if (!parseColor(value) && !bad.includes(token)) bad.push(token)
    }
    return bad
  }, [stored, drafts, base])
  const validation = useMemo(() => validatePalette(current), [current])
  const invalidCode = malformed.length > 0
  const ready = validation.ok && !invalidCode
  const active = settings.general.themeId === 'custom'
  const state = invalidCode ? 'error' : ready ? 'ready' : 'fix'

  const label = (token: string): string => tr(tokenLabelKey(token))

  function clearDraft(token: string): void {
    setDrafts((prev) => {
      if (!(draftKey(token) in prev)) return prev
      const next = { ...prev }
      delete next[draftKey(token)]
      return next
    })
  }

  function fieldValue(token: string): string {
    return drafts[draftKey(token)] ?? current[token] ?? ''
  }

  /**
   * Change one of the three main colours. Everything else is recalculated here,
   * which is what lets the simple view work without a separate "apply" step.
   */
  function applyPrimary(token: string, value: string): void {
    const core: Record<string, string> = {
      '--bg': token === '--bg' ? value : current['--bg'],
      '--text': token === '--text' ? value : current['--text'],
      '--accent': token === '--accent' ? value : current['--accent']
    }
    // A panel colour set by hand in the advanced view survives until the window
    // background itself changes.
    if (token !== '--bg' && current['--surface']) core['--surface'] = current['--surface']
    void update({
      customTheme: { [base]: { tokens: derivePalette(base, core as never) } }
    })
  }

  /** Persist one colour. An unreadable string stays in the field until fixed. */
  function applyToken(token: string, value: string): void {
    clearDraft(token)
    if (!parseColor(value)) return
    if ((PRIMARY_TOKENS as readonly string[]).includes(token)) {
      applyPrimary(token, value)
      return
    }
    void update({ customTheme: { [base]: { tokens: { ...current, [token]: value } } } })
  }

  function colourField(token: string): JSX.Element {
    const invalid = malformed.includes(token)
    return (
      <div key={token} className="settings__color">
        <span className="settings__color-name">
          <span className="settings__color-label">{label(token)}</span>
          <code className="settings__token">{token}</code>
        </span>
        <ColorField
          value={current[token] ?? '#000000'}
          onChange={(value) => applyToken(token, value)}
          label={tr('theme.custom.pickerAria', { name: label(token) })}
          size="sm"
        />
        <input
          className={`input input--tight settings__hex${invalid ? ' is-invalid' : ''}`}
          value={fieldValue(token)}
          onChange={(e) => {
            const value = e.target.value
            setDrafts((prev) => ({ ...prev, [draftKey(token)]: value }))
            if (parseColor(value)) applyToken(token, value)
          }}
          aria-invalid={invalid || undefined}
          aria-label={tr('theme.custom.hexAria', { name: label(token) })}
          spellCheck={false}
        />
      </div>
    )
  }

  const previewStyle = useMemo(() => {
    const style: Record<string, string> = {}
    for (const [token, value] of Object.entries(current)) style[token] = value
    return style as CSSProperties
  }, [current])

  const hasDetails = validation.failures.length > 0 || validation.warnings.length > 0

  return (
    <fieldset className="settings__group">
      <legend>{tr('theme.custom.title')}</legend>
      <p className="settings__hint">{tr('theme.custom.hint')}</p>

      <div className="settings__custom-status">
        <div className="settings__row">
          <span className="settings__label">{tr('theme.custom.mode')}</span>
          <div className="settings__choices">
            {(['light', 'dark'] as const).map((value) => (
              <label key={value} className="settings__choice">
                <input
                  type="radio"
                  name="palette-base"
                  checked={base === value}
                  onChange={() => {
                    setBase(value)
                    void update({ customTheme: { base: value } })
                  }}
                />
                <span>
                  {value === 'light' ? tr('theme.custom.light') : tr('theme.custom.dark')}
                </span>
              </label>
            ))}
          </div>
        </div>
        {active ? (
          <p className="settings__hint">{tr('theme.custom.inUse')}</p>
        ) : (
          <>
            <button
              className="btn btn--small"
              disabled={state !== 'ready'}
              onClick={() =>
                void update({
                  general: { ...settings.general, themeId: 'custom' as ThemeId }
                })
              }
            >
              {tr('theme.custom.useTheme')}
            </button>
            {state !== 'ready' && (
              <p className="settings__hint">{tr('theme.custom.useThemeBlocked')}</p>
            )}
          </>
        )}
      </div>

      <div className="settings__custom-grid">
        <div className="settings__custom-colours">
          <span className="settings__label">{tr('theme.custom.core')}</span>
          <p className="settings__hint">{tr('theme.custom.coreHint')}</p>
          <div className="settings__primary-grid">
            {PRIMARY_TOKENS.map((token) => colourField(token))}
          </div>
        </div>

        <div className="settings__custom-preview">
          <span className="settings__label">{tr('theme.custom.preview')}</span>
          <div className="settings__preview" style={previewStyle} aria-hidden="true">
            <div className="settings__preview-bar">
              <span>{tr('theme.custom.previewTitle')}</span>
              <span className="settings__preview-chip">
                {tr('theme.custom.previewChip')}
              </span>
            </div>
            <div className="settings__preview-body">
              <p className="settings__preview-text">{tr('theme.custom.previewText')}</p>
              <p className="settings__preview-muted">{tr('theme.custom.previewMuted')}</p>
              <div className="settings__preview-row">
                {tr('theme.custom.previewSelected')}
              </div>
              <span className="settings__preview-button">
                {tr('theme.custom.previewAction')}
              </span>
              <div className="settings__preview-notice">
                {tr('theme.custom.previewNotice')}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={`settings__status is-${state}`} role="status">
        <p className="settings__status-title">
          {state === 'error'
            ? tr('theme.custom.badCode')
            : state === 'ready'
              ? tr('theme.custom.ready')
              : tr('theme.custom.needsFix')}
        </p>
        <p className="settings__status-hint">
          {state === 'error'
            ? tr('theme.custom.badCodeHint', { names: malformed.map(label).join(', ') })
            : state === 'ready'
              ? tr('theme.custom.readyHint')
              : tr('theme.custom.needsFixHint')}
        </p>
        {state !== 'ready' && (
          <p className="settings__status-hint">{tr('theme.custom.pending')}</p>
        )}
        {hasDetails && (
          <>
            <button
              className="settings__link"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((open) => !open)}
            >
              {detailsOpen ? tr('theme.custom.hideDetails') : tr('theme.custom.details')}
            </button>
            {detailsOpen && (
              <ul className="settings__status-list">
                {validation.failures.map((failure) => (
                  <li key={`${failure.fg}:${failure.bg}`}>
                    {tr('theme.custom.failure', {
                      fg: label(failure.fg),
                      bg: label(failure.bg),
                      ratio: failure.ratio,
                      min: failure.min
                    })}
                  </li>
                ))}
                {validation.warnings.map((warning) => (
                  <li key={`w:${warning.fg}:${warning.bg}`} className="settings__warning">
                    {tr('theme.custom.warning', {
                      fg: label(warning.fg),
                      bg: label(warning.bg),
                      ratio: warning.ratio
                    })}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <button
        className="settings__disclosure"
        aria-expanded={advanced}
        onClick={() => setAdvanced((open) => !open)}
      >
        {advanced ? tr('theme.custom.advancedHide') : tr('theme.custom.advanced')}
      </button>

      {advanced && (
        <>
          <p className="settings__hint">{tr('theme.custom.advancedHint')}</p>
          {CHROME_GROUPS.map((group) => (
            <div key={group.id} className="settings__token-group">
              <span className="settings__label">{tr(group.labelKey)}</span>
              <p className="settings__hint">{tr(group.hintKey)}</p>
              <div className="settings__core-grid">
                {group.tokens.map((token) => colourField(token.name))}
              </div>
            </div>
          ))}
        </>
      )}
    </fieldset>
  )
}

function EditorSection({ settings, update }: SectionProps): JSX.Element {
  const { tr } = useLocale()
  const editor = settings.editor
  const base: 'light' | 'dark' =
    settings.general.themeId === 'custom'
      ? (settings.customTheme.base ?? 'light')
      : themeBase(settings.general.themeId)
  const colors = resolveSyntaxColors(base, editor.syntaxColors)
  const customized = isCustomSyntax(base, editor.syntaxColors)

  // The default font is the first entry of the shipped list. Deriving the
  // checkbox from the value keeps one source of truth instead of a second flag
  // that could disagree with the select.
  const usingDefaultFont = editor.fontFamily === MONO_FONTS[0]

  function setColor(key: EditorSyntaxKey, value: string): void {
    void update({
      editor: { ...editor, syntaxColors: { ...editor.syntaxColors, [key]: value } }
    })
  }

  function resetColors(): void {
    void update({ editor: { ...editor, syntaxColors: {} } })
  }

  return (
    <div className="settings__pane">
      <fieldset className="settings__group">
        <legend>{tr('settings.editor.display')}</legend>
        <div className="settings__editor-row">
          <span className="settings__editor-row-label">
            {tr('settings.editor.fontSize')}
          </span>
          <div className="settings__editor-row-body">
            <input
              type="range"
              min={11}
              max={20}
              step={1}
              value={editor.fontSize}
              onChange={(e) =>
                void update({ editor: { ...editor, fontSize: Number(e.target.value) } })
              }
              aria-label={tr('settings.editor.fontSize')}
            />
            <span className="settings__value">{editor.fontSize}px</span>
          </div>
        </div>

        <div className="settings__editor-row">
          <span className="settings__editor-row-label">
            {tr('settings.editor.tabSize')}
          </span>
          <div className="settings__editor-row-body">
            <select
              className="input input--tight"
              value={editor.tabSize}
              onChange={(e) =>
                void update({
                  editor: { ...editor, tabSize: Number(e.target.value) as 2 | 4 | 8 }
                })
              }
              aria-label={tr('settings.editor.tabSize')}
            >
              {[2, 4, 8].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="settings__editor-row">
          <span className="settings__editor-row-label">{tr('settings.editor.show')}</span>
          <div className="settings__editor-row-body settings__editor-checks">
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
                checked={editor.runSelection}
                onChange={(e) =>
                  void update({ editor: { ...editor, runSelection: e.target.checked } })
                }
              />
              <span>{tr('settings.editor.runSelection')}</span>
            </label>
          </div>
        </div>
        <p className="settings__hint">{tr('settings.editor.runSelectionHint')}</p>
      </fieldset>

      <fieldset className="settings__group">
        <legend>{tr('settings.editor.fontColors')}</legend>
        <div className="settings__editor-row">
          <span className="settings__editor-row-label">{tr('settings.editor.font')}</span>
          <div className="settings__editor-row-body">
            <select
              className="input input--tight settings__editor-font"
              value={editor.fontFamily}
              onChange={(e) =>
                void update({ editor: { ...editor, fontFamily: e.target.value } })
              }
              disabled={usingDefaultFont}
              aria-label={tr('settings.editor.font')}
            >
              {MONO_FONTS.map((font) => (
                <option key={font} value={font}>
                  {font.split(',')[0].replace(/'/g, '')}
                </option>
              ))}
            </select>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={usingDefaultFont}
                onChange={(e) =>
                  void update({
                    editor: {
                      ...editor,
                      fontFamily: e.target.checked ? MONO_FONTS[0] : editor.fontFamily
                    }
                  })
                }
              />
              <span>{tr('settings.editor.useDefaultFont')}</span>
            </label>
          </div>
        </div>

        <div className="settings__editor-row">
          <span className="settings__editor-row-label">
            {tr('settings.editor.syntaxColors')}
          </span>
          <div className="settings__editor-row-body">
            <div className="settings__syntax">
              {EDITOR_SYNTAX_KEYS.map((key) => (
                <div key={key} className="settings__syntax-item">
                  <ColorField
                    value={colors[key]}
                    onChange={(next) => setColor(key, next)}
                    label={tr(EDITOR_SYNTAX_LABELS[key])}
                  />
                  <span>{tr(EDITOR_SYNTAX_LABELS[key])}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        {customized && (
          <button className="btn btn--ghost btn--tiny" onClick={resetColors}>
            {tr('settings.editor.resetColors')}
          </button>
        )}
      </fieldset>

      <fieldset className="settings__group">
        <legend>{tr('settings.editor.preview')}</legend>
        <p className="settings__hint">{tr('settings.editor.previewHint')}</p>
        <div
          className="settings__editor-preview"
          style={{
            fontFamily: editor.fontFamily,
            fontSize: `${editor.fontSize}px`,
            background: colors.background,
            color: colors.common
          }}
        >
          {editor.lineNumbers && (
            <div className="settings__editor-preview-lines" aria-hidden="true">
              {[1, 2, 3, 4, 5].map((line) => (
                <span key={line}>{line}</span>
              ))}
            </div>
          )}
          <pre
            className="settings__editor-preview-code"
            style={{ whiteSpace: editor.wordWrap ? 'pre-wrap' : 'pre' }}
            aria-label={tr('settings.editor.preview')}
          >
            <code>
              <span style={{ color: colors.comment }}>
                {tr('settings.editor.sampleComment')}
              </span>
              {'\n'}
              <span style={{ color: colors.keyword }}>SELECT</span>{' '}
              <span style={{ color: colors.common }}>name</span>,{' '}
              <span style={{ color: colors.common }}>status</span>
              {'\n'}
              <span style={{ color: colors.keyword }}>FROM</span>{' '}
              <span style={{ color: colors.common }}>orders</span>
              {'\n'}
              <span style={{ color: colors.keyword }}>WHERE</span>{' '}
              <span style={{ color: colors.common }}>total</span> &gt;{' '}
              <span style={{ color: colors.number }}>100</span>
              {'\n'}
              {' '.repeat(editor.tabSize * 2)}
              <span style={{ color: colors.keyword }}>AND</span>{' '}
              <span style={{ color: colors.common }}>status</span> ={' '}
              <span style={{ color: colors.string }}>&apos;paid&apos;</span>;
            </code>
          </pre>
        </div>
      </fieldset>
    </div>
  )
}

const EDITOR_SYNTAX_LABELS: Record<EditorSyntaxKey, MessageKey> = {
  common: 'settings.editor.colorCommon',
  keyword: 'settings.editor.colorKeyword',
  comment: 'settings.editor.colorComment',
  string: 'settings.editor.colorString',
  number: 'settings.editor.colorNumber',
  background: 'settings.editor.colorBackground'
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
  // Which folder the running process actually loaded. The saved setting and the
  // loaded library can disagree, and only main can tell them apart, so the pane
  // asks instead of assuming the setting is live.
  const [loadedDir, setLoadedDir] = useState<string | null>(null)

  useEffect(() => {
    setDraft(oracle.clientLibDir)
  }, [oracle.clientLibDir])

  useEffect(() => {
    let active = true
    unwrap(window.dbApi.getOracleClientStatus())
      .then((status) => {
        if (active) setLoadedDir(status.loadedDir)
      })
      .catch(() => {
        // No worker answer means thin mode as far as this pane can tell.
        if (active) setLoadedDir(null)
      })
    return () => {
      active = false
    }
  }, [oracle.clientLibDir])

  const pending =
    oracle.clientLibDir.trim().length > 0 &&
    loadedDir !== null &&
    !sameClientDir(loadedDir, oracle.clientLibDir)

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
      {loadedDir && !pending && (
        <p className="settings__hint">
          {tr('settings.oracle.statusActive', { dir: loadedDir })}
        </p>
      )}
      {pending && (
        <>
          <p className="notice notice--info">
            {tr('settings.oracle.statusPending', { dir: loadedDir ?? '' })}
          </p>
          <div className="settings__actions">
            <button
              className="btn btn--small"
              onClick={() => {
                void window.dbApi.relaunchApp()
              }}
            >
              {tr('settings.oracle.restartNow')}
            </button>
          </div>
        </>
      )}
      <p className="settings__hint">{tr('settings.oracle.downloadHint')}</p>
      <p className="settings__hint">{tr('settings.oracle.modeHint')}</p>
      <p className="settings__hint">{tr('settings.oracle.restartHint')}</p>
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
            <th>{tr('settings.keymap.shortcut')}</th>
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
                    {recording === action
                      ? tr('settings.keymap.recording')
                      : formatBindingLabel(value, window.dbApi.platform)}
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function LogSection({ settings, update }: SectionProps): JSX.Element {
  const { tr, dateTime } = useLocale()
  const logs = settings.logs
  const [info, setInfo] = useState<LogFilesInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setInfo(await unwrap(window.dbApi.listLogFiles()))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  // The list can change while this section is open: a rotation may add a file
  // right after the level or cap is saved.
  useEffect(() => {
    void load()
  }, [load, logs.level, logs.maxFileSizeMb, logs.maxFiles])

  return (
    <div className="settings__pane">
      <fieldset className="settings__group">
        <legend>{tr('settings.log.level')}</legend>
        <p className="settings__hint">{tr('settings.log.levelHint')}</p>
        <select
          className="input input--tight"
          value={logs.level}
          onChange={(e) =>
            void update({
              logs: { ...logs, level: e.target.value as 'info' | 'warn' | 'error' }
            })
          }
        >
          <option value="info">{tr('settings.log.levelInfo')}</option>
          <option value="warn">{tr('settings.log.levelWarn')}</option>
          <option value="error">{tr('settings.log.levelError')}</option>
        </select>
      </fieldset>

      <fieldset className="settings__group">
        <legend>{tr('settings.log.retention')}</legend>
        <p className="settings__hint">{tr('settings.log.retentionHint')}</p>
        <div className="settings__row">
          <label className="settings__field">
            <span>{tr('settings.log.maxFileSize')}</span>
            <input
              className="input input--tight"
              type="number"
              min={1}
              max={50}
              value={logs.maxFileSizeMb}
              onChange={(e) => {
                const value = Number(e.target.value)
                if (!Number.isFinite(value)) return
                void update({
                  logs: {
                    ...logs,
                    maxFileSizeMb: Math.min(50, Math.max(1, Math.round(value)))
                  }
                })
              }}
            />
          </label>
          <label className="settings__field">
            <span>{tr('settings.log.maxFiles')}</span>
            <input
              className="input input--tight"
              type="number"
              min={1}
              max={100}
              value={logs.maxFiles}
              onChange={(e) => {
                const value = Number(e.target.value)
                if (!Number.isFinite(value)) return
                void update({
                  logs: {
                    ...logs,
                    maxFiles: Math.min(100, Math.max(1, Math.round(value)))
                  }
                })
              }}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="settings__group">
        <legend>{tr('settings.log.history')}</legend>
        <p className="settings__hint">{tr('settings.log.historyHint')}</p>
        <div className="settings__actions">
          <button
            className="btn btn--small btn--ghost"
            onClick={() => void window.dbApi.openAppPath('logsDir')}
          >
            {tr('settings.log.openFolder')}
          </button>
          <button
            className="btn btn--small btn--ghost"
            disabled={!info}
            onClick={() => void window.dbApi.openAppPath('logFile')}
          >
            {tr('settings.log.openActive')}
          </button>
          <button className="btn btn--small btn--ghost" onClick={() => void load()}>
            {tr('settings.log.refresh')}
          </button>
        </div>

        {error && (
          <p className="notice notice--error" role="alert">
            {tr('settings.log.loadFailed', { message: error })}
          </p>
        )}
        {loading && !info ? (
          <p className="settings__state" role="status">
            {tr('common.loading')}
          </p>
        ) : !info || info.files.length === 0 ? (
          <p className="settings__state">{tr('settings.log.empty')}</p>
        ) : (
          <table className="data-table settings__keymap">
            <thead>
              <tr>
                <th>{tr('settings.log.name')}</th>
                <th>{tr('settings.log.size')}</th>
                <th>{tr('settings.log.modified')}</th>
              </tr>
            </thead>
            <tbody>
              {info.files.map((file) => (
                <tr key={file.name}>
                  <td>
                    <code>{file.name}</code>
                    {file.name === info.active.split(/[\\/]/).pop() && (
                      <span className="settings__value">{tr('settings.log.active')}</span>
                    )}
                  </td>
                  <td>{formatBytes(file.size)}</td>
                  <td>{dateTime(file.modifiedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="settings__hint">
          {tr('settings.log.directory', { path: info?.dir ?? '' })}
        </p>
      </fieldset>
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
