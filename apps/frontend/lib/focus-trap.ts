// Modal dialogs keep the keyboard inside them: Tab and Shift+Tab cycle through the dialog's own controls, Escape
// closes it, focus starts inside it and goes back to where it was when it closes. CSS-free so it can be tested.
import { useEffect, type RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Where Tab (or Shift+Tab) goes from `current` among `items`: around the end, never out of the dialog. */
export function nextFocusIndex(count: number, current: number, back: boolean): number {
  if (count <= 0) return -1
  if (current < 0) return back ? count - 1 : 0
  return back ? (current - 1 + count) % count : (current + 1) % count
}

/** Trap focus in `ref` while it is mounted; Escape calls onClose. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, onClose?: () => void): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const before = document.activeElement as HTMLElement | null
    const items = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(x => x.offsetParent !== null || x === document.activeElement)
    if (!el.contains(document.activeElement)) (items()[0] ?? el).focus()
    const onKey = (e: KeyboardEvent) => {
      // A dialog opened inside this one (the master-password prompt in a drawer) handled it already.
      if (e.defaultPrevented) return
      if (e.key === 'Escape' && onClose) { e.preventDefault(); e.stopPropagation(); onClose(); return }
      if (e.key !== 'Tab') return
      const list = items()
      if (!list.length) { e.preventDefault(); return }
      const i = nextFocusIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey)
      e.preventDefault()
      list[i]?.focus()
    }
    el.addEventListener('keydown', onKey)
    return () => { el.removeEventListener('keydown', onKey); before?.focus?.() }
  }, [ref, onClose])
}
