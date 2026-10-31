import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocale } from './i18n'
import { hexToHsv, hsvToHex, normalizeHex, type Hsv } from '@shared/colorPicker'

/**
 * A colour swatch that opens its own picker.
 *
 * The platform colour panel (`<input type="color">`) opens outside the page and,
 * in this app, ends up behind the Settings window, which is a child of the main
 * window. The panel flashed and then looked covered. This picker is part of the
 * page, so it cannot be hidden by another window and behaves the same on every
 * platform.
 *
 * Dragging updates the picker only. `onChange` fires when the gesture ends, so
 * one drag is one settings write instead of dozens per second.
 */

interface Props {
  value: string
  onChange: (value: string) => void
  /** Accessible name, already translated by the caller. */
  label: string
  size?: 'sm' | 'md'
}

// Six neutrals and twelve hues: enough to pick a readable syntax colour without
// opening the hex field, and small enough to scan in one look.
const PRESETS = [
  '#1b1f24',
  '#3a4149',
  '#6d6f71',
  '#9ea0a2',
  '#c9cdd2',
  '#ffffff',
  '#b3521f',
  '#d97706',
  '#eab308',
  '#16a34a',
  '#0f766e',
  '#0891b2',
  '#2563eb',
  '#4f46e5',
  '#7c3aed',
  '#c026d3',
  '#db2777',
  '#dc2626'
]

const POPOVER_WIDTH = 236
const POPOVER_HEIGHT = 268
const EDGE = 8

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function ColorField({ value, onChange, label, size = 'md' }: Props): JSX.Element {
  const { tr } = useLocale()
  const [open, setOpen] = useState(false)
  const [hsv, setHsv] = useState<Hsv>({ h: 0, s: 0, v: 0 })
  const [hexText, setHexText] = useState(value)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  // Pointer moves update state, but the commit has to read the value from the
  // same gesture end; a ref avoids waiting for the next render.
  const hsvRef = useRef<Hsv>(hsv)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const svRef = useRef<HTMLDivElement>(null)
  const hexRef = useRef<HTMLInputElement>(null)

  function show(): void {
    const parsed = hexToHsv(value) ?? { h: 0, s: 0, v: 0 }
    hsvRef.current = parsed
    setHsv(parsed)
    setHexText(value)
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      const left = clamp(rect.left, EDGE, window.innerWidth - POPOVER_WIDTH - EDGE)
      const below = rect.bottom + 6
      const top =
        below + POPOVER_HEIGHT > window.innerHeight - EDGE
          ? Math.max(EDGE, rect.top - POPOVER_HEIGHT - 6)
          : below
      setPosition({ top, left })
    }
    setOpen(true)
  }

  function hide(focusTrigger = true): void {
    setOpen(false)
    if (focusTrigger) triggerRef.current?.focus()
  }

  // Close when the page scrolls or resizes: the popover is fixed to viewport
  // coordinates, so keeping it in place would detach it from its swatch.
  useEffect(() => {
    if (!open) return
    const onScroll = (): void => hide(false)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Capture phase, and stop the event here: the Settings page listens for
      // Escape on the window to close the whole window, so an open picker would
      // otherwise take the window down with it.
      event.preventDefault()
      event.stopPropagation()
      hide()
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (popoverRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      hide(false)
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])

  useEffect(() => {
    if (open) hexRef.current?.focus()
  }, [open])

  function commit(next: Hsv): void {
    hsvRef.current = next
    setHsv(next)
    const hex = hsvToHex(next)
    setHexText(hex)
    onChange(hex)
  }

  function preview(next: Hsv): void {
    hsvRef.current = next
    setHsv(next)
    setHexText(hsvToHex(next))
  }

  // A hue move on a grey or black leaves every colour identical, which reads as
  // a dead control. Raising saturation keeps the change visible; a black value
  // needs some brightness before the hue can show at all.
  function withVisibleHue(next: Hsv): Hsv {
    return {
      h: next.h,
      s: next.s === 0 ? 1 : next.s,
      v: next.v < 0.05 ? 1 : next.v
    }
  }

  function fromPointer(
    event: React.PointerEvent<HTMLDivElement>,
    commitNow: boolean
  ): void {
    const rect = svRef.current?.getBoundingClientRect()
    if (!rect) return
    const next: Hsv = {
      h: hsvRef.current.h,
      s: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      v: 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1)
    }
    if (commitNow) commit(next)
    else preview(next)
  }

  const hueCss = `hsl(${Math.round(hsv.h)} 100% 50%)`

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`color-field__trigger color-field__trigger--${size}`}
        style={{ background: value }}
        onClick={() => (open ? hide() : show())}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
      />
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="color-field__popover"
            style={{ top: position.top, left: position.left }}
            role="dialog"
            aria-label={label}
          >
            <div
              ref={svRef}
              className="color-field__sv"
              style={{
                background: `linear-gradient(to top, black, transparent), linear-gradient(to right, white, ${hueCss})`
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                fromPointer(event, false)
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  fromPointer(event, false)
                }
              }}
              onPointerUp={(event) => fromPointer(event, true)}
            >
              <span
                className="color-field__sv-handle"
                style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
              />
            </div>

            <input
              className="color-field__hue"
              type="range"
              min={0}
              max={359}
              value={Math.round(hsv.h)}
              style={{ '--hue-color': hueCss } as React.CSSProperties}
              onInput={(event) =>
                preview({ ...hsvRef.current, h: Number(event.currentTarget.value) })
              }
              onPointerUp={() => commit(withVisibleHue(hsvRef.current))}
              onKeyUp={() => commit(withVisibleHue(hsvRef.current))}
              aria-label={label}
            />

            <input
              ref={hexRef}
              className="input input--tight color-field__hex"
              value={hexText}
              onChange={(event) => {
                const text = event.currentTarget.value
                setHexText(text)
                const normalized = normalizeHex(text)
                if (normalized) {
                  const next = hexToHsv(normalized)
                  if (next) {
                    hsvRef.current = next
                    setHsv(next)
                    onChange(normalized)
                  }
                }
              }}
              onBlur={() => setHexText(hsvToHex(hsvRef.current))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur()
                }
              }}
              aria-label={tr('colorPicker.hex')}
              spellCheck={false}
            />

            <div
              className="color-field__presets"
              role="group"
              aria-label={tr('colorPicker.presets')}
            >
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="color-field__preset"
                  style={{ background: preset }}
                  title={preset}
                  aria-label={preset}
                  onClick={() => {
                    const next = hexToHsv(preset)
                    if (next) commit(next)
                  }}
                />
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
