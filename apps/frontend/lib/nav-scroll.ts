// Whether the sidebar's own scroller has more of the menu below the fold (components/layout/Sidebar.tsx). CSS-free.

/** True when a scroller has more than a few pixels of content below what it shows. */
export function navHasMoreBelow(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight > 4
}
