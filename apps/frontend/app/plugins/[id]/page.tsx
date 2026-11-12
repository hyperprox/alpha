'use client'

// =============================================================================
//  HyperProx — one plug-in, in full
//
//  The gallery card answers "is anything happening". This answers "show me
//  everything": a HUD, then the plug-in's own visual page (gauges, bars, a
//  pipeline, a network map) drawn from its typed `visual` numbers, then every
//  table in full, filterable, folded into Details at the bottom.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PluginVisual } from '@hyperprox/types'
import { HomeAssistantPage } from '@/components/plugins/home-assistant/HomeAssistant'
import { QnapPage } from '@/components/plugins/qnap/QnapPage'
import { HudHeader, styles as vs, type StatChip } from '@/components/visual/kit'
import { DetailsSection, PLUGIN_ICON, PluginSwitcher } from '@/components/plugins/visual/plugin-kit'
import { PlexClearOut } from '@/components/plugins/plex/ClearOut'
import { PlexLibrary } from '@/components/plugins/plex/Library'
import { ArrView, MeshView, PlexView, RouterView, UnmanicView, arrChips, plexChips, routerChips, unmanicChips, type Stuck } from '@/components/plugins/visual/views'

interface Column { key: string; label: string; align?: 'left' | 'right' }
interface Table  { title: string; columns: Column[]; rows: Array<Record<string, any>>; empty?: string; total?: number }
interface Detail {
  ok: boolean; error?: string
  stats?: Array<{ label: string; value: string; hint?: string; tone?: 'good' | 'warn' | 'bad' }>
  tables?: Table[]
  /** The same reading as typed numbers, for the visuals. Absent from an older API: the page shows the tables. */
  visual?: PluginVisual
}

function agoLabel(at: number | null): string {
  if (!at) return ''
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`
}

const ACCENT = 'var(--accent)'
const BORDER = 'var(--border)'
const TONE: Record<string, string> = { good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--crit)' }

/** Values that read as state get a colour; everything else stays neutral. */
function cellTone(v: string): string | undefined {
  const s = v.toLowerCase()
  if (['yes', 'running', 'playing', 'direct play'].includes(s)) return TONE.good
  if (['paused', 'transcode', 'dynamic'].includes(s))            return TONE.warn
  if (['no', 'stopped', 'no lease'].includes(s))                 return 'var(--text-dim)'
  return undefined
}

/**
 * Remember a disclosure across reloads, without breaking when storage is gone.
 *
 * Private windows and locked-down browsers throw on access rather than
 * returning null, so every read and write is guarded. A forgotten preference is
 * a cosmetic loss; an exception here would blank the page.
 */
function useRemembered(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(fallback)
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(key)
      if (v !== null) setOn(v === '1')
    } catch { /* no storage: the fallback stands */ }
  }, [key])
  const set = useCallback((v: boolean) => {
    setOn(v)
    try { window.localStorage.setItem(key, v ? '1' : '0') } catch { /* nothing to do */ }
  }, [key])
  return [on, set]
}

/** Long tables start closed. A page with six tables and four hundred rows
 *  answers nothing until you have scrolled past it, so the default is the
 *  headline — title and count — with the rows one click away. */
const LONG_TABLE = 12

function DataTable({ table, storageKey, force }: {
  table: Table; storageKey: string; force?: 'open' | 'closed' | null
}) {
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useRemembered(storageKey, table.rows.length <= LONG_TABLE)

  // "Expand all" / "Collapse all" overrides every remembered choice at once.
  useEffect(() => { if (force) setOpen(force === 'open') }, [force, setOpen])

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return table.rows
    return table.rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(q)))
  }, [table.rows, filter])

  return (
    <section className="rounded-lg border" style={{ background: 'var(--surface)', borderColor: BORDER }}>
      <header className="flex items-center gap-3 border-b px-5 py-3.5"
        style={{ borderColor: open ? BORDER : 'transparent' }}>
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex items-center gap-2 text-left transition-colors hover:text-[var(--text-bright)]">
          <span aria-hidden className="font-mono text-[10px] transition-transform"
            style={{ color: 'var(--text-dim)', display: 'inline-block',
                     transform: open ? 'rotate(90deg)' : 'none' }}>▶</span>
          <h2 className="font-display text-[20px] font-semibold" style={{ color: 'var(--text-bright)' }}>
            {table.title}
          </h2>
        </button>
        <span className="font-mono text-[11px] tabular-nums" style={{ color: 'var(--text-dimmer)' }}>
          {rows.length}
          {filter && rows.length !== table.rows.length && ` of ${table.rows.length}`}
        </span>
        {/* A table that is only part of the story has to say so, or it quietly
            contradicts the figure in the stat tile above it. */}
        {!filter && table.total !== undefined && table.total > table.rows.length && (
          <span className="rounded px-1.5 py-0.5 font-mono text-[10px]"
            style={{ background: 'color-mix(in srgb, var(--warn) 7%, transparent)', color: 'var(--warn)', border: '1px solid color-mix(in srgb, var(--warn) 16%, transparent)' }}>
            showing {table.rows.length} of {table.total}
          </span>
        )}
        {open && table.rows.length > 8 && (
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="filter"
            className="ml-auto h-10 w-48 rounded-md border px-3 text-sm outline-none transition-colors focus:border-cyan"
            style={{ background: 'var(--ground-deep)', borderColor: 'var(--border-strong)', color: 'var(--text-bright)' }}
          />
        )}
      </header>

      {!open ? null : rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm" style={{ color: 'var(--text-dimmer)' }}>
          {filter ? 'Nothing matches that filter.' : (table.empty ?? 'Nothing to show.')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {table.columns.map(c => (
                  <th key={c.key}
                    className="whitespace-nowrap border-b px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em]"
                    style={{ borderColor: BORDER, color: 'var(--text-dim)', textAlign: c.align ?? 'left' }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="transition-colors hover:bg-hover">
                  {table.columns.map(c => {
                    const v = String(r[c.key] ?? '—')
                    return (
                      <td key={c.key}
                        className="whitespace-nowrap border-b px-5 py-2 font-mono text-[12px] tabular-nums"
                        style={{
                          borderColor: 'var(--surface-notice)',
                          color: cellTone(v) ?? 'var(--text-soft)',
                          textAlign: c.align ?? 'left',
                        }}>
                        {v}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}


function PluginDetailPage({ params }: { params: { id: string } }) {
  const [stuck, setStuck] = useState<Stuck[]>([])
  const [rescuing, setRescuing] = useState<string | null>(null)
  const [rescueNote, setRescueNote] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [name,   setName]   = useState(params.id)
  const [loading, setLoading] = useState(true)
  const [everySeconds, setEverySeconds] = useState(0)
  const [live, setLive] = useRemembered(`hp.live.${params.id}`, true)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [force, setForce] = useState<'open' | 'closed' | null>(null)
  // A poll must never stack on a slow one. The router is the thing being
  // protected here: a 25-second connection-table read against a 10-second timer
  // would otherwise leave three requests in flight against one device.
  const inFlight = useRef(false)

  /**
   * @param quiet a background poll — do not raise the spinner or disable the
   *              button, or the page flickers every interval and the reader
   *              cannot tell a refresh from a reload.
   */
  const load = useCallback(async (quiet = false) => {
    if (inFlight.current) return
    inFlight.current = true
    if (!quiet) setLoading(true)
    try {
      const [meta, d] = await Promise.all([
        fetch('/api/plugins').then(r => r.json()),
        fetch(`/api/plugins/${params.id}/detail`).then(r => r.json()),
      ])
      const m = meta?.data?.find((p: any) => p.id === params.id)
      if (m) { setName(m.name); setEverySeconds(Number(m.refreshSeconds ?? 0)) }
      setDetail(d.success ? d.data : { ok: false, error: d.error })
      setFetchedAt(Date.now())
    } catch (e: any) {
      // A failed BACKGROUND poll keeps the last good page. Replacing a working
      // table with an error because one refresh timed out loses data the reader
      // was in the middle of using, and the next tick usually succeeds.
      if (!quiet) setDetail({ ok: false, error: e.message })
    } finally {
      inFlight.current = false
      if (!quiet) setLoading(false)
    }
  }, [params.id])

  const loadStuck = useCallback(async () => {
    const r = await fetch(`/api/plugins/${params.id}/stuck`).then(x => x.json()).catch(() => null)
    if (r?.success) setStuck(r.data)
  }, [params.id])

  useEffect(() => { load(); loadStuck() }, [load, loadStuck])

  // Poll only when the plug-in asked to be polled, the reader has it switched
  // on, and the tab is actually being looked at. A hidden tab polling a router
  // forever is the failure mode worth designing out: nobody sees the cost, so
  // nobody turns it off.
  useEffect(() => {
    if (!everySeconds || !live) return
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer) return
      timer = setInterval(() => { if (!document.hidden) load(true) }, everySeconds * 1000)
    }
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }
    const onVisibility = () => {
      if (document.hidden) { stop() } else { load(true); start() }
    }
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [everySeconds, live, load])

  // Plex: now streaming and bandwidth every five seconds, from one light call, merged into the page in place so
  // nothing flickers and the posters stay put. A change in who is watching what also re-reads the whole page.
  // Paused while the tab is hidden, and read at once when it is shown again.
  const isPlex = params.id === 'plex'
  const [plexTab, setPlexTabRaw] = useState<'now' | 'clearout' | 'library'>('now')
  useEffect(() => {
    try { const t = window.localStorage.getItem('hp.plex.tab'); if (t === 'now' || t === 'clearout' || t === 'library') setPlexTabRaw(t) } catch { /* no storage */ }
  }, [])
  const setPlexTab = (t: 'now' | 'clearout' | 'library') => { setPlexTabRaw(t); try { window.localStorage.setItem('hp.plex.tab', t) } catch { /* no storage */ } }
  const [liveAt, setLiveAt] = useState<number | null>(null)
  const sessionKeys = useRef<string | null>(null)
  useEffect(() => {
    if (!isPlex || !live) return
    let timer: ReturnType<typeof setInterval> | null = null
    let busy = false
    const tick = async () => {
      if (busy || document.hidden) return
      busy = true
      try {
        const r = await fetch('/api/plugins/plex/live').then(x => x.json())
        const d = r?.success ? r.data : null
        if (d?.ok) {
          setDetail(prev => (prev?.ok && prev.visual?.kind === 'plex')
            ? { ...prev, visual: { ...prev.visual, sessions: d.sessions, counts: d.counts, bandwidth: d.bandwidth } }
            : prev)
          setLiveAt(Date.now())
          const keys = (d.sessions as Array<{ user: string; title: string; episode: string | null }>)
            .map(x => `${x.user}|${x.title}|${x.episode ?? ''}`).sort().join('\n')
          if (sessionKeys.current !== null && keys !== sessionKeys.current) void load(true)
          sessionKeys.current = keys
        }
      } catch { /* the dot goes grey; the last reading stays */ } finally { busy = false }
    }
    const start = () => { if (!timer) timer = setInterval(() => void tick(), 5000) }
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }
    const onVisibility = () => { if (document.hidden) stop(); else { void tick(); start() } }
    void tick(); start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [isPlex, live, load])

  // Re-render once a second purely so the "12s ago" label stays honest.
  const [, tick] = useState(0)
  useEffect(() => {
    if (!fetchedAt) return
    const t = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [fetchedAt])

  const tableCount = detail?.tables?.length ?? 0

  const rescue = async (s: Stuck) => {
    if (!window.confirm(
      `Import ${s.mappable} of ${s.files} file(s) for ${s.series} by reading the season and episode ` +
      `out of each filename?` + (s.unmappable.length ? `\n\n${s.unmappable.length} file(s) will be left alone.` : ''))) return
    setRescuing(s.id); setRescueNote(null)
    const r = await fetch(`/api/plugins/${params.id}/stuck/${encodeURIComponent(s.id)}`, { method: 'POST' })
      .then(x => x.json()).catch(() => null)
    setRescuing(null)
    setRescueNote(r?.success ? r.data.message : (r?.error ?? 'The rescue could not be started.'))
    setTimeout(() => { load(); loadStuck() }, 4000)
  }

  const v = detail?.ok ? detail.visual : undefined
  const unmatchedStuck = v?.kind === 'arrstack' ? stuck.filter(x => !v.blocked.some(b => b.downloadId === x.id)) : stuck
  const chips: StatChip[] = !detail?.ok ? [] : v?.kind === 'plex' ? plexChips(v) : v?.kind === 'arrstack' ? arrChips(v)
    : v?.kind === 'unmanic' ? unmanicChips(v) : v?.kind === 'mikrotik' ? routerChips(v)
    : (detail.stats ?? []).slice(0, 4).map(x => ({ label: x.label, value: x.value, tone: x.tone === 'bad' ? 'crit' as const : x.tone === 'warn' ? 'warn' as const : undefined }))

  const statsGrid = !!detail?.stats?.length && (
    <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 168px), 1fr))', gridAutoRows: '1fr' }}>
      {detail.stats.map(x => (
        <div key={x.label} className="flex flex-col rounded-lg border px-5 py-4" style={{ background: 'var(--surface)', borderColor: 'var(--border-soft)' }}>
          <p className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-dim)' }}>{x.label}</p>
          <p className="mt-1 font-display font-semibold tabular-nums leading-none"
            style={{ color: x.tone ? TONE[x.tone] : 'var(--text-bright)', fontSize: x.value.length > 14 ? 16 : x.value.length > 10 ? 19 : 22, overflowWrap: 'anywhere' }}>
            {x.value}
          </p>
          {x.hint && <p className="mt-auto pt-2 text-[13px] leading-snug" style={{ color: 'var(--text-dimmer)' }}>{x.hint}</p>}
        </div>
      ))}
    </div>
  )
  const tables = (
    <div className="flex flex-col gap-6">
      {tableCount > 1 && (
        <button
          onClick={() => { setForce(f => (f === 'open' ? 'closed' : 'open')); setTimeout(() => setForce(null), 0) }}
          className="h-10 self-start rounded-md border px-4 text-sm transition-colors hover:bg-hover"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text)', background: 'transparent' }}>
          Expand / collapse all
        </button>
      )}
      {(detail?.tables ?? []).map(t => (
        <DataTable key={t.title} table={t} force={force} storageKey={`hp.open.${params.id}.${t.title}`} />
      ))}
    </div>
  )

  return (
    <div className="overflow-x-hidden">
      <div className={vs.page}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {fetchedAt && !isPlex && <span className="font-mono text-[10px] tabular-nums" style={{ color: 'var(--text-dimmer)' }}>{agoLabel(fetchedAt)}</span>}
            {isPlex && live && (() => {
              const last = Math.max(liveAt ?? 0, fetchedAt ?? 0)
              const fresh = !!liveAt && Date.now() - liveAt < 15_000
              return (
                <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.1em]" role="status"
                  style={{ color: fresh ? 'var(--accent)' : 'var(--text-dimmer)' }}>
                  <span aria-hidden className={fresh ? 'animate-pulse' : ''} style={{ width: 8, height: 8, borderRadius: 999, display: 'inline-block',
                    background: fresh ? 'var(--accent)' : 'var(--text-dimmer)', boxShadow: fresh ? '0 0 10px var(--accent)' : 'none' }} />
                  {fresh ? 'live' : last ? `last updated ${agoLabel(last)}` : 'connecting…'}
                </span>
              )
            })()}
            {/* Only offered where the plug-in declared a rate. A device that never
                asked to be polled does not get a switch that implies it could be. */}
            {everySeconds > 0 && (
              <button onClick={() => setLive(!live)} aria-pressed={live}
                title={isPlex ? (live ? 'Now streaming updates every 5 s, the rest every minute. Click to pause.' : 'Updates are paused') : live ? `Refreshing every ${everySeconds}s — click to pause` : 'Auto-refresh is off'}
                className="flex h-10 items-center gap-2 rounded-md border px-4 font-mono text-xs uppercase tracking-[0.1em] transition-colors hover:bg-hover"
                style={{ borderColor: live ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'var(--border-strong)',
                         color: live ? 'var(--accent)' : 'var(--text)', background: 'transparent' }}>
                <span aria-hidden className={live ? 'animate-pulse' : ''} style={{ width: 8, height: 8, borderRadius: 999, display: 'inline-block',
                  background: live ? 'var(--accent)' : 'var(--text-dimmer)', boxShadow: live ? '0 0 10px var(--accent)' : 'none' }} />
                {isPlex ? (live ? 'pause' : 'paused') : live ? `live · ${everySeconds} s` : 'paused'}
              </button>
            )}
            {/* A page that refreshes itself keeps Refresh only as a small secondary control. */}
            <button onClick={() => load()} disabled={loading}
              className={isPlex
                ? 'h-10 rounded-md border px-3 text-xs transition-colors hover:bg-hover disabled:opacity-40'
                : 'h-10 rounded-md px-5 text-sm font-semibold transition-opacity hover:opacity-85 disabled:opacity-40'}
              style={isPlex
                ? { borderColor: 'var(--border-strong)', color: 'var(--text-dim)', background: 'transparent' }
                : { background: 'var(--accent)', color: 'var(--accent-ink)', border: 'none' }}>
              {loading ? 'reading…' : 'Refresh'}
            </button>
          </div>
        </div>

        <PluginSwitcher current={params.id} />

        <HudHeader level={2} eyebrow={`Plug-in${detail?.ok ? ' · live data' : ''}`} title={name} icon={PLUGIN_ICON[params.id] ?? 'plugin'} chips={chips} label={`${name} overview`} />

        {loading && !detail && <p className="text-sm" role="status" style={{ color: 'var(--text-dimmer)' }}>reading…</p>}

        {detail && !detail.ok && (
          <div className="rounded-lg border px-5 py-4" role="alert" style={{ borderColor: 'color-mix(in srgb, var(--crit) 33%, transparent)', background: 'var(--surface)' }}>
            <p className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: TONE.bad }}>not reporting</p>
            <p className="mt-1.5 text-sm" style={{ color: 'var(--text-soft)' }}>{detail.error}</p>
          </div>
        )}

        {detail?.ok && (
          <>
            {isPlex && (
              <div role="tablist" aria-label="Plex views" className="flex flex-wrap gap-2">
                {([['now', 'Now playing'], ['clearout', 'Clear-out'], ['library', 'Library']] as const).map(([k, label]) => (
                  <button key={k} role="tab" aria-selected={plexTab === k} onClick={() => setPlexTab(k)}
                    className="h-10 rounded-md border px-4 font-display text-sm font-semibold uppercase tracking-[0.1em]"
                    style={{ borderColor: plexTab === k ? 'color-mix(in srgb, var(--accent) 45%, transparent)' : 'var(--border-strong)',
                      color: plexTab === k ? 'var(--accent)' : 'var(--text)', background: plexTab === k ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent' }}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            {v?.kind === 'plex' && (!isPlex || plexTab === 'now') && <PlexView v={v} />}
            {/* What nobody watches, and the whole library. Read on their own (Plex itself), so they never slow the live view. */}
            {isPlex && plexTab === 'clearout' && <PlexClearOut live={live} />}
            {isPlex && plexTab === 'library' && <PlexLibrary />}
            {v?.kind === 'arrstack' && <ArrView v={v} stuck={stuck} rescuing={rescuing} onRescue={rescue} rescueNote={rescueNote} />}
            {v?.kind === 'unmanic' && <UnmanicView v={v} />}
            {v?.kind === 'mikrotik' && <RouterView v={v} />}
            {v?.kind === 'meshcentral' && <MeshView v={v} />}

            {/* Downloads that are complete and cannot be filed, when the page has no alert card for them. */}
            {unmatchedStuck.length > 0 && (
              <section className="rounded-lg border p-5"
                style={{ background: 'var(--surface)', borderColor: 'color-mix(in srgb, var(--warn) 35%, transparent)' }}>
                <div className="mb-2 flex items-baseline gap-2">
                  <h2 className="font-display text-[20px] font-semibold" style={{ color: 'var(--warn-2)' }}>Stuck imports ({unmatchedStuck.length})</h2>
                </div>
                <p className="mb-4 text-sm leading-relaxed" style={{ color: 'var(--text-muted)', maxWidth: 680 }}>
                  These downloaded correctly. The library cannot read a season and episode out of the
                  filenames, so no amount of waiting will file them. Mapping reads the numbers from each
                  name and imports against the matching episode — files it cannot read are left alone
                  rather than filed somewhere plausible.
                </p>
                {rescueNote && !v && (
                  <div className="mb-3 rounded-md px-3 py-2 text-sm" role="status"
                    style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)', color: 'var(--accent)' }}>{rescueNote}</div>
                )}
                <div className="flex flex-col gap-2">
                  {unmatchedStuck.map(x => (
                    <div key={x.id} className="rounded-lg p-3" style={{ background: 'var(--ground-inset)', border: '1px solid var(--border)' }}>
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[15px] font-semibold" style={{ color: 'var(--text-bright)' }}>{x.series}</span>
                        <span className="text-[13px]" style={{ color: 'var(--text-dim)' }}>{x.reason}</span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px]" style={{ color: 'var(--text-dimmer)' }}>{x.title}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs" style={{ color: x.mappable ? 'var(--good)' : 'var(--crit)' }}>{x.mappable} of {x.files} mappable</span>
                        {x.unmappable.length > 0 && (
                          <span className="text-[13px]" title={x.unmappable.join('\n')} style={{ color: 'var(--warn)' }}>{x.unmappable.length} unreadable — hover to see</span>
                        )}
                        <button onClick={() => rescue(x)} disabled={!x.mappable || rescuing === x.id}
                          className="ml-auto h-9 rounded-md px-4 text-sm font-semibold"
                          style={{ background: 'var(--accent)', color: 'var(--accent-ink)', border: 'none', opacity: (!x.mappable || rescuing === x.id) ? 0.4 : 1 }}>
                          {rescuing === x.id ? 'importing…' : 'Map by filename'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* A plug-in that sends no visual still gets its figures and tables in full, as before. */}
            {v ? (tableCount > 0 || !!detail.stats?.length) && (
              <DetailsSection count={tableCount}>{statsGrid}{tables}</DetailsSection>
            ) : (<>{statsGrid}{tables}</>)}
          </>
        )}
      </div>
    </div>
  )
}

/** Home Assistant has its own page: several houses, each with Devices (controls), health and settings. */
export default function PluginPage({ params }: { params: { id: string } }) {
  if (params.id === 'qnap') return <QnapPage />
  return params.id === 'home-assistant' ? <HomeAssistantPage /> : <PluginDetailPage params={params} />
}
