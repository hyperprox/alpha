'use client'

import { useEffect, useState } from 'react'

export const INPUT = {
  background: 'var(--ground-deep)', border: '1px solid var(--border-strong)',
  color: 'var(--text-bright)', borderRadius: 6, padding: '0 12px', height: 42,
  fontFamily: 'inherit', fontSize: 14, outline: 'none', width: '100%',
} as React.CSSProperties

export const LABEL = { display: 'block', fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 } as React.CSSProperties

export function PrimaryButton(p: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...p}
      className={`rounded-md px-4 disabled:opacity-40 ${p.className ?? ''}`}
      style={{ height: 42, background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: 600, border: 'none', ...p.style }}
    />
  )
}

export function GhostButton(p: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...p}
      className={`rounded-md border px-4 disabled:opacity-40 ${p.className ?? ''}`}
      style={{ height: 42, background: 'transparent', color: 'var(--text-soft)', borderColor: 'var(--border-strong)', ...p.style }}
    />
  )
}

export function Notice({ kind, children }: { kind: 'error' | 'warn' | 'info'; children: React.ReactNode }) {
  const c = kind === 'error' ? 'var(--crit)' : kind === 'warn' ? 'var(--warn)' : 'var(--accent)'
  const t = kind === 'error' ? 'var(--crit-soft)' : kind === 'warn' ? 'var(--warn-2)' : 'var(--text)'
  return (
    <p
      role={kind === 'error' ? 'alert' : 'status'}
      className="rounded-md border px-3 py-2 text-sm"
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

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ background: 'var(--scrim)', backdropFilter: 'blur(4px)' }}
         onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-label={title}
           className="w-full max-w-md rounded-xl border p-6 space-y-4"
           style={{ background: 'var(--surface-raised)', borderColor: 'var(--border-soft)' }}>
        <div className="flex items-center justify-between">
          <h2 className="font-display font-semibold" style={{ fontSize: 22, color: 'var(--text-bright)' }}>{title}</h2>
          <button onClick={onClose} aria-label="Close" style={{ color: 'var(--text-dimmer)', fontSize: 18 }}>✕</button>
        </div>
        {children}
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
    <button type="button" onClick={copy} className="rounded border px-3 text-xs font-medium"
            style={{ height: 30, borderColor: 'var(--border-strong)', color: done ? 'var(--good)' : 'var(--text-soft)' }}>
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
