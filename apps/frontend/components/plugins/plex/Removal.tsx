'use client'

// =============================================================================
//  HyperProx — the removal preview and its results (Plex Clear-out and Library)
//
//  Shows exactly which files go, which way each item goes (Sonarr, Radarr or
//  Plex itself), what that means in plain English, who it would upset (next up,
//  partly watched), a "kept by rule" badge, and anything that cannot go (being
//  watched now, Plex not allowing deletions). The API decides all of it; this
//  only shows it, and sends the single-use preview id back to remove.
// =============================================================================

import type { ReactNode } from 'react'
import { Pill, bytes } from '@/components/visual/kit'
import { BusyNote, Modal, Notice } from '@/components/vault/ui'
import c from './clearout.module.css'

export type Via = 'sonarr' | 'radarr' | 'plex'
export interface PlanItem {
  id: string; title: string; via: Via; files: Array<{ path: string; sizeBytes: number | null }>; sizeBytes: number
  note: string; warnings: string[]; keptBy: string | null; blocked: string | null
}
export interface Plan { id: string; items: PlanItem[]; totalBytes: number; skipped: Array<{ id: string; reason: string }>; notice?: string }
export interface ItemResult { id: string; title: string; via: Via; removed: boolean; message: string; sizeBytes: number }

export const VIA_WORD: Record<Via, string> = { sonarr: 'via Sonarr', radarr: 'via Radarr', plex: 'via Plex' }
const size = (b: number | null) => (b ? bytes(b) : 'size unknown')

export function RemovalModal({ plan, results, busy, error, extra, onRemove, onClose }: {
  plan: Plan; results: ItemResult[] | null; busy: boolean; error: string | null
  /** Options that change the plan (Library: "keep monitored"); changing one previews again. */
  extra?: ReactNode
  onRemove(): void; onClose(): void
}) {
  const go = plan.items.filter(i => !i.blocked)
  const held = plan.items.filter(i => i.blocked)
  return (
    <Modal title={results ? 'Removal finished' : 'Remove for good?'} onClose={onClose}>
      {!results ? (
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
            These files are deleted from disk. This cannot be undone. Plex is asked to look at the folders again
            afterwards so they leave Plex straight away.
          </p>
          {plan.notice && <Notice kind="warn">{plan.notice}</Notice>}
          {extra}
          <ul className={c.plist} aria-label="What will be removed" style={{ maxHeight: '50vh' }}>
            {plan.items.map(i => (
              <li key={i.id} style={{ flexDirection: 'column', gap: 4 }}>
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline', justifyContent: 'space-between' }}>
                  <b style={{ textDecoration: i.blocked ? 'line-through' : undefined }}>{i.title}</b>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Pill tone={i.via === 'plex' ? 'warn' : 'accent'}>{VIA_WORD[i.via]}</Pill>
                    {i.keptBy && <Pill tone="violet" title="Keep rules do not block a removal you choose yourself">kept by rule: {i.keptBy}</Pill>}
                    <em>{size(i.sizeBytes)}</em>
                  </span>
                </span>
                <span style={{ fontSize: '.82rem', color: 'var(--text-muted)' }}>{i.note}</span>
                {i.blocked && <span style={{ fontSize: '.82rem', color: 'var(--crit)' }}>{i.blocked}</span>}
                {i.warnings.map(w => <span key={w} style={{ fontSize: '.82rem', color: 'var(--warn)' }}>⚠ {w}</span>)}
                <span className={c.meta}>{i.files.slice(0, 6).map(f => f.path).join(' · ')}{i.files.length > 6 ? ` · and ${i.files.length - 6} more files` : ''}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm" style={{ color: 'var(--text-bright)' }}>
            <b>{go.length} {go.length === 1 ? 'item' : 'items'} · about {bytes(plan.totalBytes)}</b>
            {held.length > 0 && <span style={{ color: 'var(--text-muted)' }}> · {held.length} left alone</span>}
          </p>
          {plan.skipped.length > 0 && <Notice kind="warn">{plan.skipped.length} left out: {plan.skipped.map(x => x.reason).slice(0, 3).join(' ')}</Notice>}
          {error && <Notice kind="error">{error}</Notice>}
          <div className="flex gap-2 justify-end">
            <button className={c.btn} onClick={onClose}>Cancel</button>
            <button className={`${c.btn} ${c.btnDanger}`} disabled={!go.length || busy} onClick={onRemove}>{busy ? 'Removing…' : `Remove ${go.length}`}</button>
          </div>
          {busy && <BusyNote>Removing one at a time, and checking each one is gone.</BusyNote>}
        </div>
      ) : (
        <div className="space-y-4">
          <ul className={c.plist} aria-label="What happened">
            {results.map(r => <li key={r.id}><b>{r.title}</b><em className={r.removed ? c.ok : c.bad}>{r.removed ? 'removed' : 'not removed'}</em></li>)}
          </ul>
          {results.map(r => <Notice key={r.id} kind={r.removed ? 'info' : 'warn'}>{r.title}: {r.message}</Notice>)}
          <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
            {results.filter(r => r.removed).length} removed, about {bytes(results.filter(r => r.removed).reduce((a, r) => a + (r.sizeBytes ?? 0), 0))} freed.
          </p>
        </div>
      )}
    </Modal>
  )
}
