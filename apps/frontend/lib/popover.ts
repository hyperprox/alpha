// Where a pop-up menu goes, next to the button that opened it: below and right-aligned to it, flipped above when
// there is no room below, and kept inside the window. It is drawn on document.body (position: fixed), so no
// scrolling table around the button can clip it. CSS-free so it can be tested.

export interface Rect { top: number; left: number; right: number; bottom: number; width: number; height: number }

export function placeMenu(anchor: Rect, menu: { width: number; height: number }, view: { width: number; height: number }, gap = 4, margin = 8): { top: number; left: number; above: boolean } {
  const below = anchor.bottom + gap
  const above = anchor.top - gap - menu.height
  const fitsBelow = below + menu.height <= view.height - margin
  const useAbove = !fitsBelow && above >= margin
  let top = useAbove ? above : below
  top = Math.max(margin, Math.min(top, view.height - margin - menu.height))
  let left = anchor.right - menu.width
  left = Math.max(margin, Math.min(left, view.width - margin - menu.width))
  return { top, left, above: useAbove }
}
