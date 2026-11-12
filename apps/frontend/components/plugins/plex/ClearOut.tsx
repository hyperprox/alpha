'use client'

// =============================================================================
//  HyperProx — Plex Clear-out
//
//  What nobody watches, so space can be freed: never watched (no play in the
//  whole history, in Plex longer than a minimum age) and idle (played before,
//  but not for months), with the keep rules' counts, a running "frees about"
//  total, and removal through Sonarr or Radarr only: a preview of exactly what
//  goes, then the master password. Without the Arr Stack plug-in it only copies
//  the list. The API (routes/plex-clearout.ts) holds every rule and every guard;
//  this page only asks.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { GlowBars, Panel, Pill, Tiles, bytes, styles as s } from '@/components/visual/kit'
import { Poster } from '@/components/plugins/visual/views'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { BusyNote, CopyButton, Notice } from '@/components/vault/ui'
import { RemovalModal, VIA_WORD, type ItemResult, type Plan, type Via } from './Removal'
import c from './clearout.module.css'

type Kind = 'movie' | 'show'
interface Row {
  id: string; kind: Kind; title: string; year: number | null; section: string; sectionTitle: string
  sizeBytes: number | null; plays: number; viewers: number; lastPlayed: number | null; addedAt: number
  list: 'never' | 'idle'; removable: boolean; via: Via; art: string | null
}
interface Totals { items: number; unwatched: number; unwatchedShare: number; never: number; idle: number; listBytes: number }
interface Report {
  generatedAt: number; historySince: number | null; historyPlays: number
  sizesFrom: { tv: 'arr' | 'plex'; movies: 'arr' | 'plex' }
  arr: { sonarr: boolean; radarr: boolean }
  sections: Array<{ key: string; title: string; kind: Kind }>
  rows: Row[]
  kept: Array<{ rule: string; label: string; tv: number; movies: number }>
  totals: { tv: Totals; movies: Totals }
  cutoffs: { neverMinMonths: number; idleMonths: number }
  notes: string[]
}
type Preview = Plan
type Result = ItemResult

const PAGE = 60
const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
const size = (b: number | null) => (b ? bytes(b) : 'size unknown')

/** `live`: re-read quietly every minute while the tab is visible (the API caches the reading for ten minutes). */
export function PlexClearOut({ live = true }: { live?: boolean }) {
  const { role } = useSession()
  const canRemove = atLeast(role, 'operator')
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<{ code?: string; text: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<Kind>('movie')
  const [list, setList] = useState<'all' | 'never' | 'idle'>('all')
  const [section, setSection] = useState('all')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'size' | 'added' | 'played'>('size')
  const [shown, setShown] = useState(PAGE)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [results, setResults] = useState<Result[] | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)

  const load = useCallback(async (refresh = false, quiet = false) => {
    if (!quiet) { setLoading(true); setError(null) }
    const r = await apiJson<{ data: Report }>(`/api/plugins/plex/clearout${refresh ? '?refresh=1' : ''}`)
    if (!quiet) setLoading(false)
    if (!r.ok || !r.body?.data) {
      // A failed background read keeps the list the reader is using.
      if (!quiet) setError({ code: r.code, text: r.error ?? 'Clear-out could not be read.' })
      return
    }
    setError(null)
    setReport(r.body.data)
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => { if (!document.hidden) void load(false, true) }, 60_000)
    const onVisibility = () => { if (!document.hidden) void load(false, true) }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisibility) }
  }, [live, load])

  // Each tab starts from its own sensible default: largest first.
  useEffect(() => { setSection('all'); setShown(PAGE); setTicked(new Set()) }, [tab])

  const rows = useMemo(() => {
    if (!report) return []
    const needle = q.trim().toLowerCase()
    const out = report.rows.filter(r => r.kind === tab
      && (list === 'all' || r.list === list)
      && (section === 'all' || r.section === section)
      && (!needle || r.title.toLowerCase().includes(needle)))
    if (sort === 'added') out.sort((a, b) => a.addedAt - b.addedAt)
    else if (sort === 'played') out.sort((a, b) => (a.lastPlayed ?? 0) - (b.lastPlayed ?? 0))
    else out.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))
    return out
  }, [report, tab, list, section, q, sort])

  const biggest = Math.max(1, ...rows.map(r => r.sizeBytes ?? 0))
  const byId = useMemo(() => new Map((report?.rows ?? []).map(r => [r.id, r])), [report])
  const tickedRows = [...ticked].map(id => byId.get(id)).filter((r): r is Row => !!r)
  const freed = tickedRows.reduce((a, r) => a + (r.sizeBytes ?? 0), 0)
  const arrOn = report ? (tab === 'show' ? report.arr.sonarr : report.arr.radarr) : false
  const removable = tickedRows.filter(r => r.removable)

  const toggle = (id: string) => setTicked(t => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const copyText = (tickedRows.length ? tickedRows : rows).map(r =>
    `${r.title}${r.year ? ` (${r.year})` : ''}\t${size(r.sizeBytes)}\t${r.list === 'never' ? 'never watched' : `last played ${day(r.lastPlayed)}`}`).join('\n')

  async function askPreview() {
    setBusy('preview'); setActionError(null); setResults(null)
    const r = await apiJson<{ data: Preview }>('/api/plugins/plex/clearout/preview', 'POST', { ids: removable.map(x => x.id) })
    setBusy(null)
    if (!r.ok || !r.body?.data) { setActionError(r.error ?? 'The preview could not be made.'); return }
    setPreview(r.body.data)
  }

  async function remove() {
    if (!preview) return
    setBusy('remove'); setActionError(null)
    const r = await apiJson<{ data: { results: Result[] } }>('/api/plugins/plex/clearout/remove', 'POST', { previewId: preview.id })
    setBusy(null)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void remove()); return }
    if (!r.ok || !r.body?.data) { setActionError(r.error ?? 'Nothing was removed.'); return }
    setResults(r.body.data.results)
    setTicked(new Set())
    void load(true)
  }

  if (error) {
    return (
      <Panel title="Clear-out" sub="WHAT NOBODY WATCHES">
        <p className={s.empty}>
          {error.code === 'plex_not_set'
            ? 'Clear-out reads your Plex server directly, because its play history covers every account and goes back further than Tautulli’s. Add the Plex server address and token in this plug-in’s settings on the Plug-ins page.'
            : error.text}
        </p>
      </Panel>
    )
  }
  if (!report) {
    return <Panel title="Clear-out" sub="WHAT NOBODY WATCHES"><BusyNote>Reading Plex’s whole play history and library. A big library takes a minute.</BusyNote></Panel>
  }

  const t = tab === 'show' ? report.totals.tv : report.totals.movies
  const sections = report.sections.filter(x => x.kind === tab)
  const kept = report.kept.map(k => ({ label: k.label, value: tab === 'show' ? k.tv : k.movies })).filter(k => k.value > 0)

  return (
    <>
      <Panel title="Clear-out" sub="WHAT NOBODY WATCHES" actions={canRemove ? (
        <button className={c.btn} onClick={() => void load(true)} disabled={loading} title="Reads Plex again (at most once a minute)">{loading ? 'Reading…' : 'Read again'}</button>
      ) : undefined}>
        <div className={c.bar} style={{ marginBottom: 12 }}>
          <div className={c.seg} role="group" aria-label="Library type">
            <button aria-pressed={tab === 'movie'} onClick={() => setTab('movie')}>Movies</button>
            <button aria-pressed={tab === 'show'} onClick={() => setTab('show')}>TV</button>
          </div>
        </div>
        <Tiles label="Clear-out totals" items={[
          { label: 'history since', value: report.historySince ? day(report.historySince) : 'none', title: `${report.historyPlays} plays across every account` },
          { label: 'never watched', value: t.never, tone: 'warn' },
          { label: 'idle', value: t.idle },
          { label: 'lists add up to', value: bytes(t.listBytes), tone: 'accent' },
          { label: 'of library unplayed', value: `${t.unwatchedShare}%` },
        ]} />
        <p className={c.note} style={{ marginTop: 10 }}>
          Plex only remembers plays back to {report.historySince ? day(report.historySince) : 'when it started recording'}, so “never watched” means not since then.
          Never watched: no plays at all and in Plex more than {report.cutoffs.neverMinMonths} months. Idle: played before, but not in {report.cutoffs.idleMonths} months.
          Sizes come from {(tab === 'show' ? report.sizesFrom.tv : report.sizesFrom.movies) === 'arr' ? (tab === 'show' ? 'Sonarr' : 'Radarr') : 'Plex'}.
        </p>
        {tab === 'movie' && (
          <p className={c.caveat} style={{ marginTop: 10 }}>
            <b>Most films are watched once.</b> {t.unwatchedShare}% of your {t.items} films have never been played, so “never watched” is not the same as “not wanted”.
            The list starts with the largest files, where removing one frees the most.
          </p>
        )}
        {report.notes.map(n => <p key={n} className={c.note} style={{ marginTop: 8 }}>{n}</p>)}
      </Panel>

      {kept.length > 0 && (
        <Panel title="Kept off this list" sub="BY YOUR KEEP RULES">
          <GlowBars label="Items each keep rule held back" items={kept.map(k => ({ label: k.label, value: k.value, text: String(k.value) }))} />
          <p className={c.note} style={{ marginTop: 8 }}>Change the rules in this plug-in’s settings on the Plug-ins page.</p>
        </Panel>
      )}

      <Panel title={tab === 'show' ? 'Shows' : 'Films'} sub={`${rows.length} LISTED`}>
        <div className={c.bar} style={{ marginBottom: 12 }}>
          <div className={c.seg} role="group" aria-label="Which list">
            <button aria-pressed={list === 'all'} onClick={() => setList('all')}>Both</button>
            <button aria-pressed={list === 'never'} onClick={() => setList('never')}>Never watched</button>
            <button aria-pressed={list === 'idle'} onClick={() => setList('idle')}>Idle</button>
          </div>
          {sections.length > 1 && (
            <select className={c.input} aria-label="Library" value={section} onChange={e => setSection(e.target.value)}>
              <option value="all">Every library</option>
              {sections.map(x => <option key={x.key} value={x.key}>{x.title}</option>)}
            </select>
          )}
          <select className={c.input} aria-label="Order" value={sort} onChange={e => setSort(e.target.value as typeof sort)}>
            <option value="size">Largest first</option>
            <option value="added">Oldest in Plex first</option>
            <option value="played">Longest since played first</option>
          </select>
          <input className={`${c.input} ${c.search}`} type="search" placeholder="Search titles" aria-label="Search titles" value={q} onChange={e => setQ(e.target.value)} />
        </div>

        {rows.length === 0 ? <p className={s.empty}>Nothing on this list. Everything here has been watched recently, or a keep rule holds it.</p> : (
          <ul className={c.rows} aria-label="Clear-out list">
            {rows.slice(0, shown).map(r => {
              const on = ticked.has(r.id)
              return (
                <li key={r.id} className={c.row} data-on={on}>
                  <input type="checkbox" className={c.check} checked={on} onChange={() => toggle(r.id)} aria-label={`Tick ${r.title}`} />
                  <Poster title={r.title} art={r.art} className={c.thumb} />
                  <div className={c.body}>
                    <div className={c.head}>
                      <span className={c.title}>{r.title}{r.year ? <small> ({r.year})</small> : null}</span>
                      <Pill tone={r.list === 'never' ? 'warn' : 'violet'}>{r.list === 'never' ? 'never watched' : 'idle'}</Pill>
                      <Pill tone={r.via === 'plex' ? undefined : 'accent'} title={r.via === 'plex' ? 'Not managed by Sonarr or Radarr: Plex itself would remove it' : 'Managed by the Arr Stack: removed there, so it is not downloaded again'}>{VIA_WORD[r.via]}</Pill>
                      <span className={c.size}>{size(r.sizeBytes)}</span>
                    </div>
                    <div className={c.meter} aria-hidden><i style={{ width: `${Math.max(2, ((r.sizeBytes ?? 0) / biggest) * 100)}%` }} /></div>
                    <div className={c.meta}>
                      {r.plays} {r.plays === 1 ? 'play' : 'plays'} · {r.viewers} {r.viewers === 1 ? 'viewer' : 'viewers'} · last played {r.lastPlayed ? day(r.lastPlayed) : 'never'} · added {day(r.addedAt)} · {r.sectionTitle}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {rows.length > shown && (
          <div className={c.bar} style={{ marginTop: 10, justifyContent: 'center' }}>
            <button className={`${c.btn} ${c.more}`} onClick={() => setShown(n => n + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}</button>
          </div>
        )}
      </Panel>

      <div className={c.dock} role="region" aria-label="Ticked items">
        <b>{ticked.size ? `${ticked.size} ticked` : 'Nothing ticked'}</b>
        <span>{ticked.size ? `frees about ${bytes(freed)}` : 'tick items to see how much space they free'}</span>
        <div className={c.acts}>
          <button className={c.btn} disabled={!rows.length} onClick={() => setTicked(new Set(rows.slice(0, shown).map(r => r.id)))}>Tick all shown</button>
          {ticked.size > 0 && <button className={c.btn} onClick={() => setTicked(new Set())}>Clear</button>}
          <CopyButton text={copyText} label={ticked.size ? 'Copy ticked list' : 'Copy list'} />
          {canRemove && (
            <button className={`${c.btn} ${c.btnPrimary}`} disabled={!removable.length || busy === 'preview'} onClick={() => void askPreview()}>
              {busy === 'preview' ? 'Checking…' : `Preview removal${removable.length ? ` (${removable.length})` : ''}`}
            </button>
          )}
        </div>
        {actionError && !preview && <div style={{ flexBasis: '100%' }}><Notice kind="error">{actionError}</Notice></div>}
        {!arrOn && <span style={{ flexBasis: '100%' }}>Without Sonarr or Radarr, Plex itself removes what you tick. Connect them in the Arr Stack plug-in so removed things are not downloaded again.</span>}
        {!canRemove && <span style={{ flexBasis: '100%' }}>Removing needs the operator role.</span>}
      </div>

      {preview && (
        <RemovalModal plan={preview} results={results} busy={busy === 'remove'} error={actionError}
          onRemove={() => void remove()} onClose={() => { setPreview(null); setResults(null); setActionError(null) }} />
      )}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const fn = reconfirm; setReconfirm(null); fn() }} />}
    </>
  )
}
