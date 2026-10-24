import { useEffect, useMemo, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
  separatorBefore?: boolean
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Roving focus: only one item is tabbable, and the arrow keys move between
  // enabled items. Without this the menu could only be used with a mouse.
  const [focusIndex, setFocusIndex] = useState(() =>
    Math.max(
      0,
      items.findIndex((item) => !item.disabled)
    )
  )

  const enabledIndexes = useMemo(
    () =>
      items
        .map((item, index) => (item.disabled ? -1 : index))
        .filter((index) => index >= 0),
    [items]
  )

  useEffect(() => {
    const node = ref.current?.querySelectorAll<HTMLButtonElement>(
      '.context-menu__item:not(:disabled)'
    )
    node?.[Math.max(0, enabledIndexes.indexOf(focusIndex))]?.focus()
    // Focus only on mount and when the highlighted item changes.
  }, [focusIndex, enabledIndexes])

  useEffect(() => {
    function onDocClick(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (enabledIndexes.length === 0) return
      const current = Math.max(0, enabledIndexes.indexOf(focusIndex))
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusIndex(enabledIndexes[(current + 1) % enabledIndexes.length])
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusIndex(
          enabledIndexes[(current - 1 + enabledIndexes.length) % enabledIndexes.length]
        )
      } else if (e.key === 'Home') {
        e.preventDefault()
        setFocusIndex(enabledIndexes[0])
      } else if (e.key === 'End') {
        e.preventDefault()
        setFocusIndex(enabledIndexes[enabledIndexes.length - 1])
      }
    }
    window.addEventListener('mousedown', onDocClick)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, focusIndex, enabledIndexes])

  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 30 - 12)
  }

  return (
    <div ref={ref} className="context-menu" style={style} role="menu">
      {items.map((item, i) => (
        <div key={i}>
          {item.separatorBefore && <div className="context-menu__sep" />}
          <button
            className={`context-menu__item${item.danger ? ' is-danger' : ''}`}
            onClick={() => {
              if (item.disabled) return
              item.onSelect()
              onClose()
            }}
            onMouseEnter={() => {
              if (!item.disabled) setFocusIndex(i)
            }}
            disabled={item.disabled}
            role="menuitem"
            tabIndex={i === focusIndex ? 0 : -1}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  )
}
