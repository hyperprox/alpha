'use client'

import type { CertsInventoryEntry, CertsVerdict } from '@hyperprox/types'
import { Badge } from '@/components/updates/ui'

// The Updates page keeps its small primitives in its own folder; they are re-exported here so
// this feature has one import path and a later move of them touches one file.
export { Badge, Btn, ConfirmDialog, Empty, Notice, Panel, TH, THEAD_STYLE, Chevron } from '@/components/updates/ui'

type Tone = 'accent' | 'good' | 'warn' | 'crit' | 'muted'

export const VERDICT_TONE: Record<CertsVerdict, Tone> = { ok: 'good', warn: 'warn', critical: 'crit', error: 'crit', unknown: 'muted' }
export const VERDICT_LABEL: Record<CertsVerdict, string> = { ok: 'OK', warn: 'Warning', critical: 'Critical', error: 'Error', unknown: 'Unknown' }

/** Worst first, so a sort on this puts what needs attention at the top. */
export const VERDICT_RANK: Record<CertsVerdict, number> = { critical: 0, error: 1, warn: 2, unknown: 3, ok: 4 }

export const SOURCE_LABEL: Record<CertsInventoryEntry['source'], string> = {
  npm: 'Proxy', managed: 'HyperProx', pve: 'Hypervisor node', pbs: 'Backup server', probe: 'Probe',
}

export function VerdictBadge({ verdict }: { verdict: CertsVerdict }) {
  return <Badge tone={VERDICT_TONE[verdict]}>{VERDICT_LABEL[verdict]}</Badge>
}

export function StagingBadge() {
  return <Badge tone="warn" title="Issued by the CA's staging environment; browsers do not trust it">STAGING</Badge>
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function fmtDays(n: number | null): string {
  if (n === null) return '—'
  if (n < 0) return `expired ${Math.abs(Math.round(n))}d ago`
  return `${Math.round(n)}d`
}

/** Reason text is the point of a verdict, so it is shown, not hidden in a tooltip. */
export function Reason({ children }: { children: React.ReactNode }) {
  return <div className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>{children}</div>
}

export function Icon({ name }: { name: 'refresh' | 'play' | 'deploy' | 'check' }) {
  const p = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true } as const
  if (name === 'refresh') return <svg {...p}><path d="M13.5 8a5.5 5.5 0 1 1-1.8-4.1M13.5 2.5v3h-3" strokeLinecap="round" strokeLinejoin="round" /></svg>
  if (name === 'play') return <svg {...p}><path d="M4.5 2.8v10.4L13 8z" strokeLinejoin="round" /></svg>
  if (name === 'deploy') return <svg {...p}><path d="M8 11.5V2.5M4.5 6L8 2.5 11.5 6M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10" strokeLinecap="round" strokeLinejoin="round" /></svg>
  return <svg {...p}><path d="M3 8.5l3.2 3L13 4.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
