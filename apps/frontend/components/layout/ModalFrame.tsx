'use client'

// =============================================================================
//  HyperProx — the frame every wizard and long dialog sits in
//
//  Header (title and step strip) and footer (Back / Install) stay on screen;
//  only the body between them scrolls. The frame is never taller than the
//  viewport (100dvh less a margin), and on a phone it is a full-screen sheet.
//  Layout is set inline and in globals.css (.hx-modal), so a card class passed
//  in for its looks cannot turn the flex column back into a block and push the
//  footer below the fold, which is what happened to the New website wizard.
// =============================================================================

import { useEffect, type CSSProperties, type ReactNode } from 'react'

export function ModalFrame({
  label, onClose, header, footer, children, width = 'sm:max-w-4xl', z = 'z-40', closeOnScrim = false, escape = true,
  frameClassName = '', frameStyle, bodyClassName = 'px-4 sm:px-6 py-5 space-y-4', after,
}: {
  label: string
  onClose?: () => void
  header?: ReactNode
  footer?: ReactNode
  children: ReactNode
  /** Tailwind max-width for 640 px and up; on a phone the frame is full width. */
  width?: string
  z?: string
  /** Clicking outside the frame closes it (only where losing what was typed costs nothing). */
  closeOnScrim?: boolean
  /** Escape closes it. */
  escape?: boolean
  frameClassName?: string
  frameStyle?: CSSProperties
  bodyClassName?: string
  /** Rendered after the frame, inside the overlay: a confirmation on top of the wizard. */
  after?: ReactNode
}) {
  useEffect(() => {
    if (!escape || !onClose) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [escape, onClose])
  return (
    <div className={`fixed inset-0 ${z} flex items-stretch sm:items-center justify-center sm:p-6`}
      style={{ background: 'var(--scrim)', backdropFilter: 'blur(4px)' }}
      onMouseDown={closeOnScrim && onClose ? e => { if (e.target === e.currentTarget) onClose() } : undefined}>
      <div role="dialog" aria-modal="true" aria-label={label}
        className={`hx-modal w-full ${width} border sm:rounded-xl ${frameClassName}`}
        style={{
          background: 'var(--surface-raised)', borderColor: 'var(--border-strong)', boxShadow: 'var(--shadow)',
          ...frameStyle,
          // Last, so nothing passed in can undo them.
          display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0,
        }}>
        {header && <div className="shrink-0">{header}</div>}
        <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${bodyClassName}`} data-modal-body>{children}</div>
        {footer && (
          <div className="hx-modal-foot shrink-0 flex flex-wrap items-center justify-between gap-2 border-t px-4 sm:px-6 pt-3"
            style={{ borderColor: 'var(--border-soft)', background: 'inherit' }}>
            {footer}
          </div>
        )}
      </div>
      {after}
    </div>
  )
}
