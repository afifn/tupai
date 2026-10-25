import { useEffect, useState } from 'react'
import type { DbEngine } from '@shared/types'
import { AiAssistant } from './AiAssistant'
import { DetailPanel, type DetailSelection, type InspectedRow } from './DetailPanel'
import { IconChat, IconClose, IconTable } from './Icons'
import { useLocale } from './i18n'

export type RightPanelTab = 'assistant' | 'detail'

interface Props {
  tab: RightPanelTab
  onTabChange: (tab: RightPanelTab) => void
  onClose: () => void
  schemaContext?: string
  // Scope for @mentions: the database the user is working in. Without it the
  // assistant keeps working but offers no table suggestions.
  mentionConnectionId?: string
  mentionDatabase?: string
  mentionSchema?: string
  // Changes whenever the catalogue may have changed, so @mention reloads.
  catalogVersion?: number
  engine?: DbEngine
  selection: DetailSelection | null
  inspectedRow: InspectedRow | null
  onOpenSettings?: () => void
  onInsertSql?: (
    sql: string,
    scope: { connectionId?: string; database?: string; schema?: string }
  ) => void
}

// The dock is a helper, not the workspace: it opens narrow so the grid and the
// editor keep their width, and the user can still drag it wider when a long
// answer or a wide record needs it.
const MIN_WIDTH = 280
const MAX_WIDTH = 620
const DEFAULT_WIDTH = 300
// The previous default. A stored value equal to it was never a deliberate
// choice, so it migrates to the new default instead of keeping the old width.
const LEGACY_DEFAULT_WIDTH = 380

function clampWidth(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)))
}

// The dock shows one surface at a time: the conversation or the selected
// record. They compete for the same vertical space, and a tab keeps either one
// full height instead of splitting both into cramped halves.
export function RightPanel({
  tab,
  onTabChange,
  onClose,
  schemaContext,
  mentionConnectionId,
  mentionDatabase,
  mentionSchema,
  catalogVersion,
  engine,
  selection,
  inspectedRow,
  onOpenSettings,
  onInsertSql
}: Props): JSX.Element {
  const { tr } = useLocale()
  const [width, setWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem('rightPanel.width'))
    if (!Number.isFinite(stored) || stored <= 0) return DEFAULT_WIDTH
    if (stored === LEGACY_DEFAULT_WIDTH) return DEFAULT_WIDTH
    return clampWidth(stored)
  })

  useEffect(() => {
    localStorage.setItem('rightPanel.width', String(width))
  }, [width])

  function startResize(event: React.MouseEvent): void {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    document.body.classList.add('is-panel-resizing')

    function onMove(moveEvent: MouseEvent): void {
      setWidth(clampWidth(startWidth + (startX - moveEvent.clientX)))
    }
    function onUp(): void {
      document.body.classList.remove('is-panel-resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <aside
      className="rightpanel"
      style={{ ['--panel-width' as string]: `${width}px` }}
      aria-label={tr('right.panel')}
    >
      <div
        className="rightpanel__resizer"
        onMouseDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label={tr('right.resize')}
        title={tr('right.resizeHint')}
      />

      <header className="rightpanel__head">
        <div className="rightpanel__tabs" role="tablist">
          <button
            className={`rightpanel__tab${tab === 'assistant' ? ' is-active' : ''}`}
            role="tab"
            aria-selected={tab === 'assistant'}
            onClick={() => onTabChange('assistant')}
            title={tr('right.assistant')}
          >
            <IconChat size={13} />
            <span>{tr('right.assistant')}</span>
          </button>
          <button
            className={`rightpanel__tab${tab === 'detail' ? ' is-active' : ''}`}
            role="tab"
            aria-selected={tab === 'detail'}
            onClick={() => onTabChange('detail')}
            title={tr('right.detailTab')}
          >
            <IconTable size={13} />
            <span>{tr('right.detail')}</span>
          </button>
        </div>
        <button
          className="icon-btn"
          onClick={onClose}
          aria-label={tr('right.close')}
          title={tr('right.close')}
        >
          <IconClose size={14} />
        </button>
      </header>

      <div className="rightpanel__body">
        <div
          className="rightpanel__pane"
          style={{ display: tab === 'assistant' ? 'flex' : 'none' }}
        >
          <AiAssistant
            embedded
            schemaContext={schemaContext}
            connectionId={mentionConnectionId}
            database={mentionDatabase}
            schema={mentionSchema}
            catalogVersion={catalogVersion}
            engine={engine}
            onInsertSql={onInsertSql}
            onOpenSettings={onOpenSettings}
          />
        </div>
        <div
          className="rightpanel__pane"
          style={{ display: tab === 'detail' ? 'flex' : 'none' }}
        >
          <DetailPanel selection={selection} inspectedRow={inspectedRow} />
        </div>
      </div>
    </aside>
  )
}
