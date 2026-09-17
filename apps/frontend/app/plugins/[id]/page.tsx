'use client'

// =============================================================================
//  HyperProx — one plug-in, in full
//
//  The gallery card answers "is anything happening". This answers "show me
//  everything": every device, every session, the history — as real tables you
//  can filter, not a four-row summary.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'

interface Column { key: string; label: string; align?: 'left' | 'right' }
interface Table  { title: string; columns: Column[]; rows: Array<Record<string, any>>; empty?: string; total?: number }
interface Detail {
  ok: boolean; error?: string
  stats?: Array<{ label: string; value: string; hint?: string; tone?: 'good' | 'warn' | 'bad' }>
  tables?: Table[]
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
      <header className="flex items-center gap-3 border-b px-4 py-2.5"
        style={{ borderColor: open ? BORDER : 'transparent' }}>
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex items-center gap-2 text-left transition-colors hover:text-white">
          <span aria-hidden className="font-mono text-[10px] transition-transform"
            style={{ color: 'var(--text-dim)', display: 'inline-block',
                     transform: open ? 'rotate(90deg)' : 'none' }}>▶</span>
          <h2 className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-white">
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
            className="ml-auto w-44 rounded border px-2 py-1 font-mono text-[11px] outline-none transition-colors focus:border-cyan"
            style={{ background: 'var(--ground)', borderColor: 'var(--border-strong)', color: 'var(--text)' }}
          />
        )}
      </header>

      {!open ? null : rows.length === 0 ? (
        <p className="px-4 py-6 text-center font-mono text-[11px]" style={{ color: 'var(--text-dimmer)' }}>
          {filter ? 'Nothing matches that filter.' : (table.empty ?? 'Nothing to show.')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {table.columns.map(c => (
                  <th key={c.key}
                    className="whitespace-nowrap border-b px-4 py-2 font-display text-[10px] uppercase tracking-[0.14em]"
                    style={{ borderColor: BORDER, color: 'var(--text-dim)', textAlign: c.align ?? 'left' }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="transition-colors hover:bg-white/[0.03]">
                  {table.columns.map(c => {
                    const v = String(r[c.key] ?? '—')
                    return (
                      <td key={c.key}
                        className="whitespace-nowrap border-b px-4 py-1.5 font-mono text-[12px] tabular-nums"
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

interface Stuck {
  id: string; title: string; series: string; path: string
  reason: string; files: number; mappable: number; unmappable: string[]
}

export default function PluginDetailPage({ params }: { params: { id: string } }) {
  const [stuck, setStuck] = useState<Stuck[]>([])
  const [rescuing, setRescuing] = useState<string | null>(null)
  const [rescueNote, setRescueNote] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [name,   setName]   = useState(params.id)
  const [icon,   setIcon]   = useState('')
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
      if (m) { setName(m.name); setIcon(m.icon); setEverySeconds(Number(m.refreshSeconds ?? 0)) }
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

  return (
    <div className="flex h-full flex-col" style={{ background: 'var(--ground)' }}>
      <header className="flex flex-shrink-0 items-center gap-3 border-b px-6"
        style={{ height: 56, borderColor: BORDER, background: 'var(--surface-raised)' }}>
        <Link href="/plugins" className="font-mono text-[11px] transition-colors hover:text-white"
          style={{ color: 'var(--text-dim)' }}>← plug-ins</Link>
        <span className="text-base">{icon}</span>
        <h1 className="font-display text-lg font-light tracking-[0.14em] text-white">{name}</h1>
        <div className="ml-auto flex items-center gap-2">
          {tableCount > 1 && (
            <button
              onClick={() => { setForce(f => (f === 'open' ? 'closed' : 'open')); setTimeout(() => setForce(null), 0) }}
              className="rounded border px-3 py-1 font-display text-xs tracking-wide transition-colors hover:bg-white/5"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}>
              Expand / collapse all
            </button>
          )}
          {fetchedAt && (
            <span className="font-mono text-[10px] tabular-nums" style={{ color: 'var(--text-dimmer)' }}>
              {agoLabel(fetchedAt)}
            </span>
          )}
          {/* Only offered where the plug-in declared a rate. A device that never
              asked to be polled does not get a switch that implies it could be. */}
          {everySeconds > 0 && (
            <button onClick={() => setLive(!live)}
              title={live ? `Refreshing every ${everySeconds}s — click to pause` : 'Auto-refresh is off'}
              className="flex items-center gap-1.5 rounded border px-3 py-1 font-display text-xs tracking-wide transition-colors hover:bg-white/5"
              style={{ borderColor: live ? 'color-mix(in srgb, var(--good) 35%, transparent)' : 'var(--border-strong)',
                       color: live ? 'var(--good)' : 'var(--text-muted)' }}>
              <span aria-hidden style={{
                width: 6, height: 6, borderRadius: 999,
                background: live ? 'var(--good)' : 'var(--text-dimmer)',
                display: 'inline-block',
              }} />
              {live ? `live · ${everySeconds}s` : 'paused'}
            </button>
          )}
          <button onClick={() => load()} disabled={loading}
            className="rounded border px-3 py-1 font-display text-xs tracking-wide transition-colors hover:bg-white/5 disabled:opacity-40"
            style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}>
            {loading ? 'reading…' : 'Refresh'}
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading && !detail && (
          <p className="font-mono text-[11px]" style={{ color: 'var(--text-dimmer)' }}>reading…</p>
        )}

        {detail && !detail.ok && (
          <div className="rounded-lg border px-4 py-3" style={{ borderColor: 'color-mix(in srgb, var(--crit) 33%, transparent)', background: 'var(--ground)' }}>
            <p className="font-display text-[11px] uppercase tracking-[0.14em]" style={{ color: TONE.bad }}>
              not reporting
            </p>
            <p className="mt-1 font-mono text-[12px]" style={{ color: 'var(--text-soft)' }}>{detail.error}</p>
          </div>
        )}

        {detail?.ok && (
          <>
            {/* Downloads that are complete and cannot be filed. Above the
                tables, because nothing else on this page is waiting on a person. */}
            {stuck.length > 0 && (
              <section className="mb-6 rounded-xl border p-4"
                style={{ background: 'var(--surface)', borderColor: 'color-mix(in srgb, var(--warn) 35%, transparent)' }}>
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="font-display text-sm font-semibold uppercase tracking-widest" style={{ color: 'var(--warn)' }}>
                    Stuck imports ({stuck.length})
                  </span>
                </div>
                <p className="mb-3 font-mono text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)', maxWidth: 640 }}>
                  These downloaded correctly. The library cannot read a season and episode out of the
                  filenames, so no amount of waiting will file them. Mapping reads the numbers from each
                  name and imports against the matching episode — files it cannot read are left alone
                  rather than filed somewhere plausible.
                </p>
                {rescueNote && (
                  <div className="mb-3 rounded px-3 py-2 font-mono text-[11px]"
                    style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)', color: 'var(--accent)' }}>
                    {rescueNote}
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  {stuck.map(s => (
                    <div key={s.id} className="rounded-lg p-3" style={{ background: 'var(--ground-inset)', border: '1px solid var(--border)' }}>
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-mono text-[12.5px]" style={{ color: 'var(--text-bright)' }}>{s.series}</span>
                        <span className="font-mono text-[10px]" style={{ color: 'var(--text-dim)' }}>{s.reason}</span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10px]" style={{ color: 'var(--text-dimmer)' }}>{s.title}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px]" style={{ color: s.mappable ? 'var(--good)' : 'var(--crit)' }}>
                          {s.mappable} of {s.files} mappable
                        </span>
                        {s.unmappable.length > 0 && (
                          <span className="font-mono text-[10px]" title={s.unmappable.join('\n')} style={{ color: 'var(--warn)' }}>
                            {s.unmappable.length} unreadable — hover to see
                          </span>
                        )}
                        <button
                          onClick={() => rescue(s)}
                          disabled={!s.mappable || rescuing === s.id}
                          className="ml-auto rounded px-3 py-1 font-display text-xs font-semibold tracking-wide"
                          style={{
                            background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
                            color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
                            opacity: (!s.mappable || rescuing === s.id) ? 0.4 : 1,
                          }}>
                          {rescuing === s.id ? 'importing…' : 'Map by filename'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* gridAutoRows 1fr is what stops the row going ragged: without it a
                single card whose value wraps sets its own height and every card
                beside it stretches to match, which is how twelve tidy figures
                turn into a block of uneven boxes. Cards get a floor of 168px so
                a label like "Known devices" stays on one line, and the value
                steps down a size when the string is long rather than wrapping. */}
            {!!detail.stats?.length && (
              <div className="mb-5 grid gap-3"
                style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))', gridAutoRows: '1fr' }}>
                {detail.stats.map(s => (
                  <div key={s.label} className="flex flex-col rounded-lg border px-4 py-3"
                    style={{ background: 'var(--surface)', borderColor: BORDER }}>
                    <p className="font-display text-[10px] uppercase tracking-[0.16em]" style={{ color: 'var(--text-dim)' }}>
                      {s.label}
                    </p>
                    <p className="mt-1 font-display font-semibold tabular-nums leading-none"
                      style={{ color: s.tone ? TONE[s.tone] : 'var(--text-bright)',
                               fontSize: s.value.length > 14 ? 16 : s.value.length > 10 ? 19 : 22 }}>
                      {s.value}
                    </p>
                    {s.hint && (
                      <p className="mt-auto pt-2 font-mono text-[10px] leading-snug" style={{ color: 'var(--text-dimmer)' }}>
                        {s.hint}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-col gap-5">
              {(detail.tables ?? []).map(t => (
                <DataTable key={t.title} table={t} force={force}
                  storageKey={`hp.open.${params.id}.${t.title}`} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
