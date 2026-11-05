'use client'

// Small primitives for the HA components, in the HyperProx design language (Barlow Condensed headings,
// Barlow text, IBM Plex Mono labels; navy ground, teal accent). Kept in this folder so the panel can be
// mounted by another page without reaching into another feature's components.

import { useEffect } from 'react'

export const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`

export function Btn({ kind = 'ghost', small, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'ghost' | 'danger'; small?: boolean }) {
  const style: React.CSSProperties =
    kind === 'primary' ? { background: 'var(--accent)', color: 'var(--accent-ink)', border: '1px solid var(--accent)', fontWeight: 600 }
    : kind === 'danger' ? { background: 'transparent', color: 'var(--crit-soft)', border: `1px solid ${mix('var(--crit)', 55)}` }
    : { background: 'transparent', color: 'var(--text-soft)', border: '1px solid var(--border-strong)' }
  return (
    <button type="button" {...p}
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${p.className ?? ''}`}
      style={{ height: small ? 28 : 36, fontSize: small ? 12.5 : 14, ...style, ...p.style }} />
  )
}

export type Tone = 'accent' | 'good' | 'warn' | 'crit' | 'muted' | 'violet'
const TONE: Record<Tone, string> = { accent: 'var(--accent)', good: 'var(--good)', warn: 'var(--warn)', crit: 'var(--crit)', muted: 'var(--text-muted)', violet: 'var(--violet)' }

export function Tag({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  const c = TONE[tone]
  return (
    <span title={title} className="inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 font-mono"
      style={{ fontSize: 11, color: c, background: mix(c, 10), border: `1px solid ${mix(c, 30)}` }}>{children}</span>
  )
}

export function Note({ tone, children }: { tone: 'warn' | 'crit' | 'info' | 'good'; children: React.ReactNode }) {
  const c = tone === 'crit' ? 'var(--crit)' : tone === 'warn' ? 'var(--warn)' : tone === 'good' ? 'var(--good)' : 'var(--accent)'
  const t = tone === 'crit' ? 'var(--crit-soft)' : tone === 'warn' ? 'var(--warn-2, var(--warn))' : 'var(--text)'
  return (
    <div role={tone === 'crit' ? 'alert' : 'status'} className="rounded-md border px-3 py-2 text-sm leading-relaxed"
      style={{ background: mix(c, 10), borderColor: mix(c, 35), color: t }}>{children}</div>
  )
}

export function Section({ title, right, children, id }: { title: string; right?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="rounded-[10px] border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 sm:px-5 py-3" style={{ borderColor: 'var(--border)' }}>
        <h2 className="font-display font-semibold" style={{ fontSize: 20, color: 'var(--text-bright)' }}>{title}</h2>
        {right}
      </div>
      <div className="px-4 sm:px-5 py-4">{children}</div>
    </section>
  )
}

export function Label({ children }: { children: React.ReactNode }) {
  return <p className="font-mono uppercase" style={{ fontSize: 11, letterSpacing: '0.12em', color: 'var(--text-dimmer)' }}>{children}</p>
}

/** One switch with a sentence. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className="flex items-start gap-3 text-left disabled:opacity-50">
      <span className="relative mt-0.5 inline-block shrink-0 rounded-full transition-colors" style={{ width: 40, height: 22, background: on ? 'var(--accent)' : 'var(--border-strong)' }}>
        <span className="absolute top-[3px] rounded-full transition-all" style={{ left: on ? 21 : 3, width: 16, height: 16, background: on ? 'var(--accent-ink)' : 'var(--text-soft)' }} />
      </span>
      <span className="text-[15px] leading-snug" style={{ color: 'var(--text-bright)' }}>{label}</span>
    </button>
  )
}

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center sm:p-6" style={{ background: 'var(--scrim)', backdropFilter: 'blur(4px)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-label={title}
        className={`flex w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} flex-col overflow-hidden border sm:rounded-xl`}
        style={{ background: 'var(--surface-raised)', borderColor: 'var(--border-soft)', maxHeight: '100dvh' }}>
        <div className="flex items-start justify-between gap-3 border-b px-4 sm:px-6 py-4" style={{ borderColor: 'var(--border-soft)' }}>
          <h2 className="font-display text-[24px] font-bold leading-tight" style={{ color: 'var(--text-bright)' }}>{title}</h2>
          <button onClick={onClose} aria-label="Close" className="px-2 text-lg" style={{ color: 'var(--text-dimmer)' }}>✕</button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 sm:px-6 py-5">{children}</div>
      </div>
    </div>
  )
}

export function Bullets({ items, color = 'var(--text)' }: { items: string[]; color?: string }) {
  if (!items.length) return null
  return <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed" style={{ color }}>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
}

export const SELECT: React.CSSProperties = {
  background: 'var(--ground-deep)', border: '1px solid var(--border-strong)', color: 'var(--text-bright)',
  borderRadius: 6, padding: '0 10px', height: 36, fontSize: 14, outline: 'none',
}
