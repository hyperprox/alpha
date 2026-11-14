'use client'

import { useRef, useState } from 'react'
import { useFocusTrap } from '@/lib/focus-trap'
import v from './vault.module.css'

// The shared vault controls: inputs, buttons, notices and the dialog frame used by every master-password,
// token and secret flow. Restyled to the HUD look; their props and behaviour are relied on across the app.
// No `outline: none` on the inputs: the global :focus-visible ring is how a keyboard user sees where they are.

export const INPUT = {
  background: 'var(--ground-deep)', border: '1px solid var(--border-strong)',
  color: 'var(--text-bright)', borderRadius: 9, padding: '0 12px', height: 42,
  fontFamily: 'inherit', fontSize: 14, width: '100%',
} as React.CSSProperties

export const LABEL = {
  display: 'block', fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.12em', textTransform: 'uppercase',
  color: 'var(--text-muted)', marginBottom: 6,
} as React.CSSProperties

export function PrimaryButton(p: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...p}
      className={`${v.btn} ${v.pri} ${p.className ?? ''}`}
      style={{ height: 42, background: 'var(--accent)', color: 'var(--accent-ink)', ...p.style }}
    />
  )
}

export function GhostButton(p: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...p}
      className={`${v.btn} ${v.ghost} ${p.className ?? ''}`}
      style={{ height: 42, background: 'transparent', color: 'var(--text-soft)', ...p.style }}
    />
  )
}

export function Notice({ kind, children }: { kind: 'error' | 'warn' | 'info'; children: React.ReactNode }) {
  const c = kind === 'error' ? 'var(--crit)' : kind === 'warn' ? 'var(--warn)' : 'var(--accent)'
  const t = kind === 'error' ? 'var(--crit-soft)' : kind === 'warn' ? 'var(--warn-2)' : 'var(--text)'
  return (
    <p
      role={kind === 'error' ? 'alert' : 'status'}
      className={v.notice}
      style={{
        background: `color-mix(in srgb, ${c} 10%, transparent)`,
        borderColor: `color-mix(in srgb, ${c} 35%, transparent)`,
        color: t,
      }}
    >
      {children}
    </p>
  )
}

/** Shown beside a busy button: the vault is slow, and silence reads as a hang. */
export function BusyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-mono animate-pulse" role="status" style={{ margin: 0, color: 'var(--text-muted)' }}>{children}</p>
  )
}

/**
 * A dialog that never grows past the screen: the title stays at the top, `footer` (the action buttons) stays at the
 * bottom, and only what is between them scrolls. Without `footer` the buttons scroll with the body.
 */
export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  // Escape closes it; Tab stays inside it; focus goes back where it was (lib/focus-trap.ts).
  const box = useRef<HTMLDivElement>(null)
  useFocusTrap(box, onClose)
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ background: 'var(--scrim)', backdropFilter: 'blur(4px)' }}
         onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className={v.dialog}>
        <div className={v.head}>
          <h2 className={v.title}>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className={v.close}>✕</button>
        </div>
        <div className={v.body}>{children}</div>
        {footer && <div className={v.foot}>{footer}</div>}
      </div>
    </div>
  )
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Plain-http origins have no clipboard API; fall back to a selection copy.
      const ta = document.createElement('textarea')
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
      document.body.appendChild(ta); ta.select()
      try { document.execCommand('copy') } catch { /* nothing more to try */ }
      document.body.removeChild(ta)
    }
    setDone(true)
    setTimeout(() => setDone(false), 1500)
  }
  return (
    <button type="button" onClick={copy} className={v.copy}
            style={{ height: 32, color: done ? 'var(--good)' : 'var(--text-soft)', borderColor: done ? 'var(--good)' : undefined }}>
      {done ? 'Copied' : label}
    </button>
  )
}

/** 0-4 from length and character variety; a hint, not a gate (the gate is length >= 12). */
export function passwordStrength(pw: string): { score: number; label: string } {
  let s = 0
  if (pw.length >= 12) s++
  if (pw.length >= 16) s++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++
  if (new Set(pw).size < 5) s = Math.min(s, 1)
  return { score: s, label: ['Too short or weak', 'Weak', 'Fair', 'Good', 'Strong'][s] }
}
