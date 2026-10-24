import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

// Keeps Tab and Shift+Tab inside a modal. Without this, tabbing walks into the
// grid or editor behind the backdrop, which are still focusable, and the user
// loses the dialog. Escape is handled by the caller because what closing means
// differs per dialog.
export function useFocusTrap(ref: RefObject<HTMLElement>, active: boolean): void {
  useEffect(() => {
    if (!active) return
    const node = ref.current
    if (!node) return

    const focusFirst = (): void => {
      const targets = node.querySelectorAll<HTMLElement>(FOCUSABLE)
      const first = targets[0]
      if (first) first.focus()
      else node.focus()
    }
    // Move focus in when the dialog opens, unless something inside already has
    // it (an autoFocus input, for example).
    if (!node.contains(document.activeElement)) focusFirst()

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Tab') return
      const current = ref.current
      if (!current) return
      const targets = Array.from(current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null
      )
      if (targets.length === 0) return
      const first = targets[0]
      const last = targets[targets.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [ref, active])
}
