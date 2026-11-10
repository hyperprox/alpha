'use client'

// The Command center: every cluster as a panel side by side, teal for home and amber for a remote, and one
// "Needs attention" list from all of them, each item tagged with where it came from.

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { apiJson } from '@/lib/api'
import { type ClusterPanel, type Attention, type GpuRow, clusterColor, clusterInk, ago } from '@/lib/clusters'
import { gpuRowLabel, gpuRowTitle, gpuRowRight, gpuRowPct, gpuRowDetail, gpuRowAction } from '@/lib/gpu-rows'
import { Notice } from '@/components/vault/ui'

export function Dot({ kind, size = 9 }: { kind: 'home' | 'remote'; size?: number }) {
  return <span aria-hidden className="inline-block rounded-full shrink-0" style={{ width: size, height: size, background: clusterColor(kind) }} />
}

export function KindPill({ kind }: { kind: 'home' | 'remote' }) {
  return (
    <span className="font-mono uppercase rounded px-1.5 py-0.5" style={{ fontSize: 10.5, letterSpacing: '0.08em', background: clusterColor(kind), color: clusterInk(kind) }}>
      {kind === 'remote' ? 'remote' : 'home'}
    </span>
  )
}

function Bar({ label, pct, kind, right }: { label: string; pct: number | null; kind: 'home' | 'remote'; right?: string }) {
  return (
    <div className="grid items-center gap-2 text-xs" style={{ gridTemplateColumns: '6.5rem minmax(0,1fr) 3.2rem', color: 'var(--text-muted)' }}>
      <span className="truncate" title={label}>{label}</span>
      <span className="block h-2 rounded overflow-hidden" style={{ background: 'var(--ground-deep)' }}>
        <span className="block h-full" style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%`, background: clusterColor(kind), opacity: pct === null ? 0 : 1 }} />
      </span>
      <span className="text-right font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>{right ?? (pct === null ? '—' : `${pct}%`)}</span>
    </div>
  )
}

/**
 * One GPU: "node · short name" and its load on the first line (the node first, so a cut-off row still says
 * where it is), the bar, then one short line. A row that is not measured says why, with a link when setting
 * up monitoring is the fix. Tap the row for the full name and the longer explanation.
 */
export function GpuRowView({ g, kind }: { g: GpuRow; kind: 'home' | 'remote' }) {
  const [open, setOpen] = useState(false)
  const pct = gpuRowPct(g)
  const action = gpuRowAction(g)
  return (
    <div className="text-xs min-w-0 flex flex-col gap-1" style={{ color: 'var(--text-muted)' }}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} title={gpuRowTitle(g)} className="w-full text-left flex flex-col gap-1 min-w-0">
        <span className="flex items-baseline gap-2 w-full min-w-0">
          <span className="truncate min-w-0 flex-1" style={{ color: 'var(--text)' }}>{gpuRowLabel(g)}</span>
          <span className="font-mono shrink-0" style={{ fontVariantNumeric: 'tabular-nums' }}>{gpuRowRight(g)}</span>
        </span>
        <span className="block w-full h-2 rounded overflow-hidden" style={{ background: 'var(--ground-deep)' }}>
          <span className="block h-full" style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%`, background: clusterColor(kind), opacity: pct === null ? 0 : 1 }} />
        </span>
        <span className="break-words">{gpuRowDetail(g)} <span aria-hidden style={{ color: 'var(--text-dimmer)' }}>{open ? '▴' : '▾'}</span></span>
      </button>
      {action && (action.href
        ? <Link href={action.href} className="font-semibold self-start" style={{ color: clusterColor(kind) }}>{action.words}</Link>
        : <span style={{ color: 'var(--warn-2)' }}>{action.words}</span>)}
      {open && <span className="break-words" style={{ color: 'var(--text-dimmer)' }}>{gpuRowTitle(g)}. {g.capability}</span>}
    </div>
  )
}

function Card({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border px-3 py-2" style={{ background: 'var(--surface)', borderColor: 'var(--border-dim)' }}>
      <b className="block font-display font-bold" style={{ fontSize: 22, lineHeight: 1.1, color: 'var(--text-bright)' }}>{value}</b>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</span>
    </div>
  )
}

const openHref = (p: { id: string; kind: string }) => (p.kind === 'home' ? '/dashboard' : `/clusters/${p.id}`)

export function PanelView({ p }: { p: ClusterPanel }) {
  const k = p.kind
  const quorum = p.quorum === 'ok' ? 'OK' : p.quorum === 'standalone' ? 'single' : p.quorum === 'lost' ? 'LOST' : '—'
  return (
    <div className="rounded-xl border p-4 flex flex-col gap-3 min-w-0" style={{ background: 'var(--surface-raised)', borderColor: 'var(--border)', borderTop: `3px solid ${clusterColor(k)}` }}>
      <div className="flex items-center gap-2 flex-wrap">
        <Dot kind={k} />
        <h2 className="font-display font-bold uppercase truncate" style={{ fontSize: 19, letterSpacing: '0.04em', color: 'var(--text-bright)' }}>{p.name}</h2>
        <KindPill kind={k} />
        <Link href={openHref(p)} className="ml-auto text-sm font-semibold" style={{ color: clusterColor(k) }}>Open ›</Link>
      </div>
      {!p.reachable && <Notice kind="error">{p.error ?? 'Not answering.'}</Notice>}
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(7.5rem,1fr))' }}>
        <Card value={`${p.nodes.online} / ${p.nodes.total}`} label={p.nodes.total === 1 ? 'node online' : 'nodes online'} />
        {k === 'remote' ? <Card value={p.latencyMs === null ? '—' : `${p.latencyMs} ms`} label="to answer" /> : <Card value={quorum} label="quorum" />}
        <Card value={String(p.guests.running)} label={p.guests.running === 1 ? 'guest running' : 'guests running'} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Bar label="CPU" pct={p.cpuPct} kind={k} />
        <Bar label="Memory" pct={p.memPct} kind={k} />
        <Bar label="Storage" pct={p.storagePct} kind={k} />
      </div>
      {p.gpus.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {p.gpus.map((g, i) => <GpuRowView key={`${g.node}-${g.pci ?? i}-${i}`} g={g} kind={k} />)}
          {p.gpuNote && <p className="text-xs" style={{ color: 'var(--text-dimmer)' }}>{p.gpuNote}</p>}
        </div>
      )}
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {p.lastBackup ? `Last backup ${ago(p.lastBackup.at)} · ${p.lastBackup.ok ? 'OK' : 'did not finish cleanly'}` : 'No backup task found'}
        {k === 'home' && p.quorum !== 'unknown' ? ` · quorum ${quorum}` : ''}
      </p>
      <p className="text-xs" style={{ color: p.updates?.security ? 'var(--warn-2)' : 'var(--text-muted)' }}>
        {!p.updates ? 'Updates: not checked yet'
          : p.updates.result === 'skipped' && !p.updates.available ? `Updates: not checked ${ago(Date.parse(p.updates.checkedAt))} (${p.updates.reason ?? 'skipped'})`
          : p.updates.available
            ? `Updates available on ${p.updates.available} machine${p.updates.available === 1 ? '' : 's'} (${p.updates.packages} package${p.updates.packages === 1 ? '' : 's'}${p.updates.security ? `, ${p.updates.security} security` : ''}) · checked ${ago(Date.parse(p.updates.checkedAt))}`
            : `Up to date · checked ${ago(Date.parse(p.updates.checkedAt))}`}
      </p>
      <div className="flex gap-2 flex-wrap">
        {k === 'home' ? (
          <>
            <Link href="/infrastructure" className="text-xs font-semibold rounded-md border px-2.5 py-1" style={{ borderColor: 'var(--border-strong)', color: 'var(--text)' }}>Guests</Link>
            <Link href="/updates" className="text-xs font-semibold rounded-md border px-2.5 py-1" style={{ borderColor: 'var(--border-strong)', color: 'var(--text)' }}>Updates{p.updates?.available ? ` (${p.updates.available})` : ''}</Link>
            <Link href="/ha" className="text-xs font-semibold rounded-md border px-2.5 py-1" style={{ borderColor: 'var(--border-strong)', color: 'var(--text)' }}>HA</Link>
          </>
        ) : (
          <>
            <Link href={`/clusters/${p.id}?tab=guests`} className="text-xs font-semibold rounded-md border px-2.5 py-1" style={{ borderColor: 'var(--remote)', color: 'var(--remote)' }}>Guests</Link>
            <Link href={`/clusters/${p.id}/updates`} className="text-xs font-semibold rounded-md border px-2.5 py-1" style={{ borderColor: 'var(--remote)', color: 'var(--remote)' }}>Updates{p.updates?.available ? ` (${p.updates.available})` : ''}</Link>
            <Link href={`/clusters/${p.id}?tab=files`} className="text-xs font-semibold rounded-md border px-2.5 py-1" style={{ borderColor: 'var(--remote)', color: 'var(--remote)' }}>Send files</Link>
            <Link href={`/clusters/${p.id}?tab=settings`} className="text-xs font-semibold rounded-md border px-2.5 py-1" style={{ borderColor: 'var(--remote)', color: 'var(--remote)' }}>Edit server</Link>
          </>
        )}
      </div>
    </div>
  )
}

export function AttentionFeed({ items }: { items: Attention[] }) {
  return (
    <div className="rounded-xl border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <h2 className="font-display font-bold uppercase mb-2" style={{ fontSize: 17, letterSpacing: '0.04em', color: 'var(--text-bright)' }}>Needs attention, all clusters</h2>
      {items.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Nothing needs attention right now.</p> : (
        <ul className="flex flex-col gap-2">
          {items.map((a, i) => (
            <li key={i} className="flex gap-2.5 items-start">
              <span className="mt-1.5"><Dot kind={a.kind} /></span>
              <div className="min-w-0">
                <b className="text-sm" style={{ color: a.severity === 'crit' ? 'var(--crit-soft)' : 'var(--text-bright)' }}>{a.title}</b>
                <small className="block text-xs" style={{ color: 'var(--text-muted)' }}>{a.clusterName} · {a.detail}</small>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function useCommandCenter(everyMs = 30_000) {
  const [data, setData] = useState<{ panels: ClusterPanel[]; attention: Attention[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    const r = await apiJson<{ data: { panels: ClusterPanel[]; attention: Attention[] } }>('/api/clusters/overview')
    if (r.ok) { setData(r.body!.data); setError(null) } else setError(r.error ?? 'Could not read the clusters')
  }, [])
  useEffect(() => { void load(); const t = setInterval(load, everyMs); return () => clearInterval(t) }, [load, everyMs])
  return { data, error, reload: load }
}

/** The panels and the feed, as one block (the Command center page, and the dashboard when remotes exist). */
export function CommandCenter() {
  const { data, error } = useCommandCenter()
  if (error) return <Notice kind="error">{error}</Notice>
  if (!data) return <p className="text-sm animate-pulse" style={{ color: 'var(--text-muted)' }}>Reading every cluster…</p>
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,19rem),1fr))' }}>
        {data.panels.map(p => <PanelView key={p.id} p={p} />)}
      </div>
      <AttentionFeed items={data.attention} />
    </div>
  )
}

/**
 * On the home dashboard: every cluster's panel, but only once a remote server has been added. With none, the
 * dashboard is exactly as it was.
 */
export function CommandCenterIfRemotes() {
  const [remotes, setRemotes] = useState(0)
  useEffect(() => { apiJson<{ data: Array<{ kind: string }> }>('/api/clusters').then(r => { if (r.ok) setRemotes((r.body!.data ?? []).filter(c => c.kind === 'remote').length) }) }, [])
  if (!remotes) return null
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-3"><h2 className="font-display font-semibold" style={{ fontSize: 22, color: 'var(--text-bright)' }}>All clusters</h2><Link href="/clusters" className="text-sm" style={{ color: 'var(--accent)' }}>Command center ›</Link></div>
      <CommandCenter />
    </section>
  )
}
