'use client'

// Small primitives for the HA components, in the HyperProx design language (Barlow Condensed headings,
// Barlow text, IBM Plex Mono labels; navy ground, teal accent). Kept in this folder so the panel can be
// mounted by another page without reaching into another feature's components.

import { Panel as KitPanel, Pill, styles } from '@/components/visual/kit'
import { ModalFrame } from '@/components/layout/ModalFrame'

export const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`

export function Btn({ kind = 'ghost', small, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'ghost' | 'danger'; small?: boolean }) {
  const k = kind === 'primary' ? styles.btnPri : kind === 'danger' ? styles.btnDanger : styles.btnGhost
  return (
    <button type="button" {...p}
      className={`${styles.btn} ${k} inline-flex items-center justify-center gap-1.5 whitespace-nowrap ${p.className ?? ''}`}
      style={small ? { minHeight: 30, padding: '4px 10px', fontSize: 12.5, ...p.style } : p.style} />
  )
}

export type Tone = 'accent' | 'good' | 'warn' | 'crit' | 'muted' | 'violet'

// A tag says its meaning in its words; the pill's tone only repeats it.
export function Tag({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return <Pill tone={tone === 'crit' ? 'bad' : tone === 'muted' ? undefined : tone} title={title}>{children}</Pill>
}

export function Note({ tone, children }: { tone: 'warn' | 'crit' | 'info' | 'good'; children: React.ReactNode }) {
  const c = tone === 'crit' ? 'var(--crit)' : tone === 'warn' ? 'var(--warn)' : tone === 'good' ? 'var(--good)' : 'var(--accent)'
  const t = tone === 'crit' ? 'var(--crit-soft)' : tone === 'warn' ? 'var(--warn-2, var(--warn))' : 'var(--text)'
  return (
    <div role={tone === 'crit' ? 'alert' : 'status'} className={styles.callout}
      style={{ background: mix(c, 10), borderColor: mix(c, 45), borderStyle: 'solid', color: t }}>{children}</div>
  )
}

export function Section({ title, right, children, id }: { title: string; right?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return <KitPanel id={id} title={title} actions={right}>{children}</KitPanel>
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
  return (
    <ModalFrame label={title} onClose={onClose} closeOnScrim z="z-50" width={wide ? 'sm:max-w-3xl' : 'sm:max-w-xl'}
      frameStyle={{ borderColor: 'var(--border-soft)', boxShadow: 'none' }}
      header={
        <div className="flex items-start justify-between gap-3 border-b px-4 sm:px-6 py-4" style={{ borderColor: 'var(--border-soft)' }}>
          <h2 className="font-display text-[24px] font-bold leading-tight" style={{ color: 'var(--text-bright)' }}>{title}</h2>
          <button onClick={onClose} aria-label="Close" className="px-2 text-lg" style={{ color: 'var(--text-dimmer)' }}>✕</button>
        </div>
      }>
      {children}
    </ModalFrame>
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
