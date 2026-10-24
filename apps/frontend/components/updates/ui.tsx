'use client'

import { useEffect, useRef } from 'react'
import { alpha } from '@/lib/theme'
import type { UpdatesStepStatus } from '@hyperprox/types'

// Small primitives for the Updates page. The vault's button/modal live in another feature's
// folder, so the few this page needs are kept here rather than reaching across.

export function Btn({ kind = 'ghost', small, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'ghost' | 'danger'; small?: boolean }) {
  const style: React.CSSProperties =
    kind === 'primary' ? { background: 'var(--accent)', color: 'var(--accent-ink)', border: '1px solid var(--accent)', fontWeight: 600 }
    : kind === 'danger' ? { background: 'transparent', color: 'var(--crit-2)', border: '1px solid ' + alpha('var(--crit-2)', 45) }
    : { background: 'transparent', color: 'var(--text-soft)', border: '1px solid var(--border-strong)' }
  return (
    <button
      type="button"
      {...p}
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${p.className ?? ''}`}
      style={{ height: small ? 28 : 36, fontSize: small ? 12.5 : 14, ...style, ...p.style }}
    />
  )
}

export function Badge({ tone, children, title }: { tone: 'accent' | 'good' | 'warn' | 'crit' | 'muted' | 'violet'; children: React.ReactNode; title?: string }) {
  const c = { accent: 'var(--accent)', good: 'var(--good)', warn: 'var(--warn)', crit: 'var(--crit-2)', muted: 'var(--text-muted)', violet: 'var(--violet)' }[tone]
  return (
    <span title={title} className="inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 font-mono"
          style={{ fontSize: 11, color: c, background: alpha(c, 10), border: `1px solid ${alpha(c, 30)}` }}>
      {children}
    </span>
  )
}

export function Panel({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-[10px] border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3" style={{ borderColor: 'var(--border)' }}>
        <h2 className="font-display font-semibold" style={{ fontSize: 20, color: 'var(--text-bright)' }}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  )
}

export function Notice({ tone, children }: { tone: 'warn' | 'crit' | 'info'; children: React.ReactNode }) {
  const c = tone === 'crit' ? 'var(--crit)' : tone === 'warn' ? 'var(--warn)' : 'var(--accent)'
  const t = tone === 'crit' ? 'var(--crit-soft)' : tone === 'warn' ? 'var(--warn-2)' : 'var(--text)'
  return (
    <div role={tone === 'crit' ? 'alert' : 'status'} className="rounded-md border px-3 py-2 text-sm"
         style={{ background: alpha(c, 10), borderColor: alpha(c, 35), color: t }}>
      {children}
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-6 text-sm" style={{ color: 'var(--text-muted)' }}>{children}</p>
}

export const TH = 'px-4 py-2 text-left font-mono font-normal'
export const THEAD_STYLE: React.CSSProperties = { color: 'var(--text-dimmer)', fontSize: 11, letterSpacing: '0.1em', borderBottom: '1px solid var(--border)' }

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden
         style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>
      <path d="M4 2l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function StepIcon({ status }: { status: UpdatesStepStatus }) {
  const p = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1.7, 'aria-hidden': true } as const
  const label = status
  switch (status) {
    case 'ok':
      return <svg {...p} stroke="var(--good)"><title>{label}</title><circle cx="8" cy="8" r="6.2" /><path d="M5 8.2l2 2 4-4.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
    case 'failed':
      return <svg {...p} stroke="var(--crit-2)"><title>{label}</title><circle cx="8" cy="8" r="6.2" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" strokeLinecap="round" /></svg>
    case 'running':
      return <svg {...p} stroke="var(--accent)" className="animate-spin"><title>{label}</title><path d="M8 1.8a6.2 6.2 0 1 1-6.2 6.2" strokeLinecap="round" /></svg>
    case 'skipped':
      return <svg {...p} stroke="var(--text-dim)"><title>{label}</title><circle cx="8" cy="8" r="6.2" /><path d="M5 8h6" strokeLinecap="round" /></svg>
    default:
      return <svg {...p} stroke="var(--text-dimmer)"><title>{label}</title><circle cx="8" cy="8" r="6.2" strokeDasharray="2 2.4" /></svg>
  }
}

export function Icon({ name }: { name: 'refresh' | 'play' | 'dry' | 'reboot' }) {
  const p = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true } as const
  if (name === 'refresh') return <svg {...p}><path d="M13.5 8a5.5 5.5 0 1 1-1.8-4.1M13.5 2.5v3h-3" strokeLinecap="round" strokeLinejoin="round" /></svg>
  if (name === 'play') return <svg {...p}><path d="M4.5 2.8v10.4L13 8z" strokeLinejoin="round" /></svg>
  if (name === 'dry') return <svg {...p}><path d="M2 3.5h12M2 8h12M2 12.5h7" strokeLinecap="round" strokeDasharray="1.5 2.5" /></svg>
  return <svg {...p}><path d="M8 1.8v5.4M4.6 4a5.5 5.5 0 1 0 6.8 0" strokeLinecap="round" /></svg>
}

/** Confirmation dialog: Escape closes, focus moves in, Tab stays inside, focus returns on close. */
export function ConfirmDialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const focusables = () => Array.from(box.current?.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])') ?? []).filter(e => !(e as HTMLButtonElement).disabled)
    // Land on the cancel-side control, not the destructive one.
    ;(focusables()[1] ?? focusables()[0])?.focus()
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab') return
      const f = focusables()
      if (!f.length) return
      const first = f[0], last = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', h)
    return () => { window.removeEventListener('keydown', h); before?.focus?.() }
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" style={{ background: 'var(--scrim)', backdropFilter: 'blur(4px)' }}
         onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={title}
           className="w-full max-w-md space-y-4 rounded-xl border p-6"
           style={{ background: 'var(--surface-raised)', borderColor: 'var(--border-soft)' }}>
        <h2 className="font-display font-semibold" style={{ fontSize: 22, color: 'var(--text-bright)' }}>{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function fmtTime(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export const REASONS: Record<string, string> = {
  'excluded':    'excluded by policy',
  'not-running': 'not running',
  'no-apt':      'no apt (not a Debian-family guest)',
  'no-agent':    'no guest agent',
  'windows':     'Windows guest',
}

export const ACTION_LABEL: Record<string, string> = {
  'preflight': 'Preflight', 'refresh': 'Refresh', 'snapshot': 'Snapshot', 'apt': 'apt upgrade', 'docker': 'Docker images',
  'check': 'Health check', 'ceph': 'Ceph packages', 'node-upgrade': 'Node upgrade', 'node-reboot': 'Node reboot',
  'kernel-cleanup': 'Kernel cleanup', 'self': 'HyperProx itself',
}
