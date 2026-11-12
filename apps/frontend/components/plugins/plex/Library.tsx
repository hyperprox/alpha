'use client'

// =============================================================================
//  HyperProx — Plex Library: browse, and remove a show, a season, episodes or
//  a movie
//
//  Every list here comes from the API (routes/plex-clearout.ts /library). A
//  removal is always previewed by the API first, which decides which way each
//  item goes (Sonarr or Radarr when they manage it, else Plex itself), what it
//  costs and who it would upset; removing then needs the operator role and the
//  master password. This page never builds a delete itself.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Panel, Pill, bytes, styles as s } from '@/components/visual/kit'
import { Poster } from '@/components/plugins/visual/views'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { BusyNote, Notice } from '@/components/vault/ui'
import { RemovalModal, VIA_WORD, type ItemResult, type Plan, type Via } from './Removal'
import c from './clearout.module.css'

type Kind = 'movie' | 'show'
interface Row {
  id: string; kind: Kind; ratingKey: string; title: string; year: number | null; section: string; sectionTitle: string
  sizeBytes: number | null; plays: number; viewers: number; lastPlayed: number | null; addedAt: number; art: string | null
  via: Via; keptBy: string | null
  /** Why it cannot be removed (Sonarr or Radarr did not answer, a title matched without an id), or null. */
  refused: string | null
}
interface ListData { rows: Row[]; sections: Array<{ key: string; title: string; kind: Kind }>; arr: { sonarr: boolean; radarr: boolean }; plexDeletes: boolean | null; historySince: number | null }
interface Version { mediaId: string; label: string; sizeBytes: number | null; files: string[] }
interface Episode {
  ratingKey: string; season: number; episode: number; title: string; sizeBytes: number | null; quality: string
  plays: number; viewers: number; lastPlayed: number | null; watched: boolean; inProgress: boolean; nextUpFor: string[]; versions: Version[]; via: 'sonarr' | 'plex'
  refused: string | null
}
interface ShowView {
  show: { ratingKey: string; title: string; year: number | null; art: string | null; via: 'sonarr' | 'plex'; keptBy: string | null; sizeBytes: number | null; refused: string | null }
  seasons: Array<{ season: number; title: string; episodes: Episode[] }>
  plexDeletes: boolean | null
}
type Target = { kind: 'movie' | 'show' | 'season' | 'episodes'; ratingKey: string; season?: number; episodes?: string[]; mediaIds?: Record<string, string>; mediaId?: string }

const PAGE = 60
const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
const size = (b: number | null) => (b ? bytes(b) : 'size unknown')
const PLEX_OFF = 'Plex is not allowing deletions, so anything Sonarr and Radarr do not manage cannot be removed here. Turn it on in Plex: Settings → Server → Library → Allow media deletion.'

export function PlexLibrary() {
  const { role } = useSession()
  const canRemove = atLeast(role, 'operator')
  const [data, setData] = useState<ListData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Kind>('show')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'size' | 'added' | 'played'>('size')
  const [section, setSection] = useState('all')
  const [shown, setShown] = useState(PAGE)
  const [open, setOpen] = useState<string | null>(null)
  const [show, setShow] = useState<ShowView | null>(null)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [versions, setVersions] = useState<Record<string, string>>({})
  // The removal in progress: what was asked, its preview, and how it went.
  const [target, setTarget] = useState<Target | null>(null)
  const [keepMonitored, setKeepMonitored] = useState(false)
  const [plan, setPlan] = useState<(Plan & { versions?: Version[] }) | null>(null)
  const [results, setResults] = useState<ItemResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)

  const load = useCallback(async () => {
    const r = await apiJson<{ data: ListData }>('/api/plugins/plex/library')
    if (!r.ok || !r.body?.data) { setError(r.code === 'plex_not_set' ? 'The Library reads your Plex server directly. Add the Plex server address and token in this plug-in’s settings on the Plug-ins page.' : r.error ?? 'The library could not be read.'); return }
    setError(null); setData(r.body.data)
  }, [])
  useEffect(() => { void load() }, [load])

  const loadShow = useCallback(async (rk: string) => {
    setShow(null); setTicked(new Set()); setVersions({})
    const r = await apiJson<{ data: ShowView }>(`/api/plugins/plex/library/show/${encodeURIComponent(rk)}`)
    if (r.ok && r.body?.data) setShow(r.body.data); else setError(r.error ?? 'That show could not be read.')
  }, [])
  useEffect(() => { if (open) void loadShow(open) }, [open, loadShow])

  const rows = useMemo(() => {
    if (!data) return []
    const needle = q.trim().toLowerCase()
    const out = data.rows.filter(r => r.kind === tab && (section === 'all' || r.section === section) && (!needle || r.title.toLowerCase().includes(needle)))
    if (sort === 'added') out.sort((a, b) => b.addedAt - a.addedAt)
    else if (sort === 'played') out.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
    else out.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))
    return out
  }, [data, tab, section, q, sort])
  const biggest = Math.max(1, ...rows.map(r => r.sizeBytes ?? 0))

  async function askPreview(t: Target, keep = keepMonitored) {
    setTarget(t); setBusy(true); setActionError(null); setResults(null)
    const r = await apiJson<{ data: Plan & { versions?: Version[] } }>('/api/plugins/plex/library/preview', 'POST', { ...t, keepMonitored: keep })
    setBusy(false)
    if (!r.ok || !r.body?.data) { setActionError(r.error ?? 'The preview could not be made.'); setPlan(null); return }
    setPlan(r.body.data)
  }
  async function remove() {
    if (!plan) return
    setBusy(true); setActionError(null)
    const r = await apiJson<{ data: { results: ItemResult[] } }>('/api/plugins/plex/library/remove', 'POST', { previewId: plan.id })
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void remove()); return }
    if (!r.ok || !r.body?.data) { setActionError(r.error ?? 'Nothing was removed.'); return }
    setResults(r.body.data.results)
    setTicked(new Set())
    void load()
    if (open && target?.kind !== 'show') void loadShow(open)
    if (target?.kind === 'show') setOpen(null)
  }
  const closeModal = () => { setPlan(null); setResults(null); setActionError(null); setTarget(null); setKeepMonitored(false) }

  if (error && !data) return <Panel title="Library" sub="SHOWS AND FILMS"><p className={s.empty}>{error}</p></Panel>
  if (!data) return <Panel title="Library" sub="SHOWS AND FILMS"><BusyNote>Reading your whole Plex library. A big one takes a minute.</BusyNote></Panel>

  const arrOn = tab === 'show' ? data.arr.sonarr : data.arr.radarr
  const sections = data.sections.filter(x => x.kind === tab)
  const notes = (
    <>
      {!arrOn && <p className={c.note} style={{ marginTop: 8 }}>
        {tab === 'show' ? 'Sonarr' : 'Radarr'} is not connected, so Plex itself removes what you choose, and whatever downloads your media may bring it back.
        Connect {tab === 'show' ? 'Sonarr' : 'Radarr'} in the Arr Stack plug-in (its address and API key) so a removed item is not downloaded again.
      </p>}
      {data.plexDeletes === false && <p className={c.caveat} style={{ marginTop: 8 }}>{PLEX_OFF}</p>}
    </>
  )

  const viaSonarr = plan?.items.some(i => i.via === 'sonarr' && target && (target.kind === 'season' || target.kind === 'episodes'))
  const modal = plan && (
    <RemovalModal plan={plan} results={results} busy={busy} error={actionError} onRemove={() => void remove()} onClose={closeModal}
      extra={results ? undefined : target?.kind === 'movie' && (plan.versions?.length ?? 0) > 1 ? (
        <label className="flex flex-col gap-1 text-sm" style={{ color: 'var(--text-soft)' }}>
          This film has {plan.versions!.length} versions in Plex:
          <select className={c.input} value={target.mediaId ?? ''} onChange={e => void askPreview({ kind: 'movie', ratingKey: target.ratingKey, ...(e.target.value ? { mediaId: e.target.value } : {}) })}>
            <option value="">The whole film (every version)</option>
            {plan.versions!.map(v => <option key={v.mediaId} value={v.mediaId}>Only {v.label} ({size(v.sizeBytes)}), through Plex</option>)}
          </select>
        </label>
      ) : viaSonarr ? (
        <label className="flex items-center gap-3 text-sm" style={{ color: 'var(--text-soft)', cursor: 'pointer' }}>
          <input type="checkbox" checked={keepMonitored} style={{ width: 20, height: 20, accentColor: 'var(--accent)' }}
            onChange={e => { setKeepMonitored(e.target.checked); if (target) void askPreview(target, e.target.checked) }} />
          Keep monitored so a better copy downloads (for replacing a bad file)
        </label>
      ) : undefined} />
  )

  // ── one show ──
  if (open) {
    const sh = show?.show
    const tickedEps = show ? show.seasons.flatMap(x => x.episodes).filter(e => ticked.has(e.ratingKey)) : []
    const tickedBytes = tickedEps.reduce((a, e) => a + ((versions[e.ratingKey] ? e.versions.find(v => v.mediaId === versions[e.ratingKey])?.sizeBytes : e.sizeBytes) ?? 0), 0)
    const toggle = (rk: string) => setTicked(t => { const n = new Set(t); if (n.has(rk)) n.delete(rk); else n.add(rk); return n })
    return (
      <>
        <Panel title={sh ? `${sh.title}${sh.year ? ` (${sh.year})` : ''}` : 'Show'} sub={sh ? `${VIA_WORD[sh.via].toUpperCase()} · ${size(sh.sizeBytes)}` : undefined}
          actions={<button className={c.btn} onClick={() => { setOpen(null); setShow(null) }}>Back to the library</button>}>
          {!show ? <BusyNote>Reading its seasons and episodes…</BusyNote> : (
            <>
              <div className={c.bar} style={{ marginBottom: 10 }}>
                <Poster title={sh!.title} art={sh!.art} className={c.thumb} style={{ width: '4rem' }} />
                {sh!.keptBy && <Pill tone="violet">kept by rule: {sh!.keptBy}</Pill>}
                {sh!.refused && <span className={c.note} style={{ flexBasis: '100%', color: 'var(--warn)' }}>Nothing in this show can be removed right now: {sh!.refused}</span>}
                {canRemove && <button className={`${c.btn} ${c.btnDanger}`} style={{ marginLeft: 'auto' }} onClick={() => void askPreview({ kind: 'show', ratingKey: sh!.ratingKey })}>Remove the whole show…</button>}
              </div>
              {show.seasons.map(se => {
                const firstUnwatched = se.episodes.findIndex(e => !e.watched)
                return (
                  <section key={se.season} style={{ marginTop: 14 }} aria-label={se.title}>
                    <div className={c.bar} style={{ marginBottom: 8 }}>
                      <h3 className={c.title}>{se.title} <small>· {se.episodes.length} episodes · {size(se.episodes.reduce((a, e) => a + (e.sizeBytes ?? 0), 0))}</small></h3>
                      <div className={c.acts}>
                        <button className={c.btn} onClick={() => setTicked(t => new Set([...t, ...se.episodes.filter(e => e.watched && !e.refused).map(e => e.ratingKey)]))}>Tick watched</button>
                        <button className={c.btn} disabled={firstUnwatched <= 0} title="Every episode before the first one nobody has watched"
                          onClick={() => setTicked(t => new Set([...t, ...se.episodes.slice(0, firstUnwatched).filter(e => !e.refused).map(e => e.ratingKey)]))}>Tick everything before the next unwatched</button>
                        {canRemove && <button className={`${c.btn} ${c.btnDanger}`} onClick={() => void askPreview({ kind: 'season', ratingKey: sh!.ratingKey, season: se.season })}>Remove season…</button>}
                      </div>
                    </div>
                    <ul className={c.rows} aria-label={`${se.title} episodes`}>
                      {se.episodes.map(e => {
                        const on = ticked.has(e.ratingKey)
                        return (
                          <li key={e.ratingKey} className={c.row} data-on={on} style={{ gridTemplateColumns: 'auto minmax(0, 1fr)' }}>
                            <input type="checkbox" className={c.check} checked={on} disabled={!!e.refused} onChange={() => toggle(e.ratingKey)} aria-label={`Tick S${e.season}E${e.episode}`} />
                            <div className={c.body}>
                              <div className={c.head}>
                                <span className={c.title}>E{e.episode} · {e.title}</span>
                                {e.watched ? <Pill tone="good">watched</Pill> : <Pill>not watched</Pill>}
                                {e.inProgress && <Pill tone="warn">partly watched</Pill>}
                                {e.nextUpFor.length > 0 && <Pill tone="warn" title="Watched the episode before it in the last 14 days">next up for {e.nextUpFor.join(', ')}</Pill>}
                                <span className={c.size}>{size(e.sizeBytes)}</span>
                              </div>
                              {e.refused && <div className={c.meta} style={{ color: 'var(--warn)' }}>Cannot be removed: {e.refused}</div>}
                              <div className={c.meta}>
                                {e.quality} · {e.plays} {e.plays === 1 ? 'play' : 'plays'} · {e.viewers} {e.viewers === 1 ? 'viewer' : 'viewers'} · last played {e.lastPlayed ? day(e.lastPlayed) : 'never'} · {VIA_WORD[e.via]}
                              </div>
                              {e.versions.length > 1 && (
                                <select className={c.input} aria-label={`Which version of S${e.season}E${e.episode}`} value={versions[e.ratingKey] ?? ''}
                                  onChange={ev => setVersions(v => { const n = { ...v }; if (ev.target.value) n[e.ratingKey] = ev.target.value; else delete n[e.ratingKey]; return n })}>
                                  <option value="">All {e.versions.length} versions</option>
                                  {e.versions.map(v => <option key={v.mediaId} value={v.mediaId}>Only {v.label} ({size(v.sizeBytes)}), through Plex</option>)}
                                </select>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                )
              })}
              {notes}
            </>
          )}
        </Panel>
        {show && (
          <div className={c.dock} role="region" aria-label="Ticked episodes">
            <b>{ticked.size ? `${ticked.size} ticked` : 'Nothing ticked'}</b>
            <span>{ticked.size ? `frees about ${bytes(tickedBytes)}` : 'tick episodes, or use a quick pick'}</span>
            <div className={c.acts}>
              {ticked.size > 0 && <button className={c.btn} onClick={() => setTicked(new Set())}>Clear</button>}
              {canRemove && (
                <button className={`${c.btn} ${c.btnPrimary}`} disabled={!ticked.size || busy}
                  onClick={() => void askPreview({ kind: 'episodes', ratingKey: show.show.ratingKey, episodes: [...ticked], mediaIds: Object.fromEntries(Object.entries(versions).filter(([k]) => ticked.has(k))) })}>
                  {busy && !plan ? 'Checking…' : 'Preview removal'}
                </button>
              )}
            </div>
            {!canRemove && <span style={{ flexBasis: '100%' }}>Removing needs the operator role.</span>}
            {actionError && !plan && <div style={{ flexBasis: '100%' }}><Notice kind="error">{actionError}</Notice></div>}
          </div>
        )}
        {modal}
        {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const fn = reconfirm; setReconfirm(null); fn() }} />}
      </>
    )
  }

  // ── the whole library ──
  return (
    <>
      <Panel title="Library" sub={`${rows.length} ${tab === 'show' ? 'SHOWS' : 'FILMS'}`}>
        <div className={c.bar} style={{ marginBottom: 12 }}>
          <div className={c.seg} role="group" aria-label="Library type">
            <button aria-pressed={tab === 'show'} onClick={() => { setTab('show'); setSection('all'); setShown(PAGE) }}>TV</button>
            <button aria-pressed={tab === 'movie'} onClick={() => { setTab('movie'); setSection('all'); setShown(PAGE) }}>Movies</button>
          </div>
          {sections.length > 1 && (
            <select className={c.input} aria-label="Library" value={section} onChange={e => setSection(e.target.value)}>
              <option value="all">Every library</option>
              {sections.map(x => <option key={x.key} value={x.key}>{x.title}</option>)}
            </select>
          )}
          <select className={c.input} aria-label="Order" value={sort} onChange={e => setSort(e.target.value as typeof sort)}>
            <option value="size">Largest first</option>
            <option value="added">Newest in Plex first</option>
            <option value="played">Played most recently first</option>
          </select>
          <input className={`${c.input} ${c.search}`} type="search" placeholder="Search titles" aria-label="Search titles" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        {notes}
        <ul className={c.rows} aria-label={tab === 'show' ? 'Shows' : 'Films'} style={{ marginTop: 10 }}>
          {rows.slice(0, shown).map(r => (
            <li key={r.id} className={c.row} style={{ gridTemplateColumns: '2.6rem minmax(0, 1fr)' }}>
              <Poster title={r.title} art={r.art} className={c.thumb} />
              <div className={c.body}>
                <div className={c.head}>
                  {r.kind === 'show'
                    ? <button className={c.title} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', textDecoration: 'underline', textUnderlineOffset: 3 }} onClick={() => setOpen(r.ratingKey)}>{r.title}{r.year ? <small> ({r.year})</small> : null}</button>
                    : <span className={c.title}>{r.title}{r.year ? <small> ({r.year})</small> : null}</span>}
                  <Pill tone={r.via === 'plex' ? undefined : 'accent'}>{VIA_WORD[r.via]}</Pill>
                  {r.keptBy && <Pill tone="violet">kept by rule</Pill>}
                  <span className={c.size}>{size(r.sizeBytes)}</span>
                </div>
                <div className={c.meter} aria-hidden><i style={{ width: `${Math.max(2, ((r.sizeBytes ?? 0) / biggest) * 100)}%` }} /></div>
                <div className={c.meta}>
                  {r.plays} {r.plays === 1 ? 'play' : 'plays'} · {r.viewers} {r.viewers === 1 ? 'viewer' : 'viewers'} · last played {r.lastPlayed ? day(r.lastPlayed) : 'never'} · added {day(r.addedAt)} · {r.sectionTitle}
                </div>
                <div className={c.bar}>
                  {r.kind === 'show' && <button className={c.btn} onClick={() => setOpen(r.ratingKey)}>Seasons and episodes</button>}
                  {r.refused && <span className={c.meta} style={{ color: 'var(--warn)' }}>Cannot be removed: {r.refused}</span>}
                  {r.kind === 'movie' && canRemove && !r.refused && <button className={`${c.btn} ${c.btnDanger}`} onClick={() => void askPreview({ kind: 'movie', ratingKey: r.ratingKey })}>Remove…</button>}
                </div>
              </div>
            </li>
          ))}
        </ul>
        {rows.length === 0 && <p className={s.empty}>Nothing matches.</p>}
        {rows.length > shown && (
          <div className={c.bar} style={{ marginTop: 10, justifyContent: 'center' }}>
            <button className={c.btn} onClick={() => setShown(n => n + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more of {rows.length - shown}</button>
          </div>
        )}
        {actionError && !plan && <div style={{ marginTop: 10 }}><Notice kind="error">{actionError}</Notice></div>}
      </Panel>
      {modal}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const fn = reconfirm; setReconfirm(null); fn() }} />}
    </>
  )
}
