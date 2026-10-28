import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { placeMenu, type MenuOffset } from '@shared/menuPosition'

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
  // Where the menu ends up. `null` until the real box has been measured, which
  // keeps the first paint from showing the menu at the pointer before it jumps
  // to its clamped spot.
  const [offset, setOffset] = useState<MenuOffset | null>(null)
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

  // Measure instead of guessing. A menu's height is not `itemCount * rowHeight`:
  // separators, padding, and labels that wrap to a second line all add to it,
  // and a guess left the last entries below the window edge where they could
  // not be clicked. `useLayoutEffect` runs after the DOM exists but before the
  // browser paints, so the menu is drawn once, already inside the window.
  // Re-running on every render also covers a late font or a changed label.
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    // `clientWidth`/`clientHeight` describe the space a fixed element can
    // actually use; `innerWidth` would include a classic scrollbar the menu
    // cannot paint over.
    const root = document.documentElement
    const next = placeMenu(
      x,
      y,
      { width: node.offsetWidth, height: node.offsetHeight },
      {
        width: root.clientWidth || window.innerWidth,
        height: root.clientHeight || window.innerHeight
      }
    )
    setOffset((prev) =>
      prev && prev.left === next.left && prev.top === next.top ? prev : next
    )
  })

  useEffect(() => {
    const node = ref.current?.querySelectorAll<HTMLButtonElement>(
      '.context-menu__item:not(:disabled)'
    )
    node?.[Math.max(0, enabledIndexes.indexOf(focusIndex))]?.focus()
    // Focus only on mount and when the highlighted item changes. `offset` is a
    // dependency because the menu is invisible until it has been measured, and
    // a hidden element cannot take focus.
  }, [focusIndex, enabledIndexes, offset])

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
    left: offset?.left ?? x,
    top: offset?.top ?? y,
    visibility: offset ? 'visible' : 'hidden'
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
