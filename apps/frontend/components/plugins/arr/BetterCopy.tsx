'use client'

// =============================================================================
//  HyperProx — Arr Stack, "Find a better copy"
//
//  For any film, episode, season or album (found by title in the library), or for a download in the queue that crawls
//  ("find a faster copy"): ONE release search (the server allows one per item every ten minutes), ranked: what your
//  profile accepts first, then quality, then seeders. AV1, 3D, program files and dead torrents are never shown; few
//  seeders are marked slow. One tap downloads the pick and moves it to the top of qBittorrent's queue; for a queue
//  download the slow one is then removed and blocklisted. What the profile refuses is shown with its reason and no
//  button, except "Grab anyway" when the only objection is the slow download being swapped out.
//  Admins only: the server refuses everyone else. Everything comes from routes/arr-better.ts.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { ModalFrame } from '@/components/layout/ModalFrame'
import { Panel, Pill, styles as s } from '@/components/visual/kit'
import c from './giveup.module.css'
import b from './better.module.css'
import { APP_NAME, sizeWord, swarm, type App } from './giveup-view'
import { betterConfirm, betterHidden, verdictWord, type BetterAnswer, type BetterGrab, type BetterRelease, type FoundItem, type FoundShow } from './better-view'
import { ConfirmBox } from './GiveUp'

// ── presentational parts (rendered in tests) ─────────────────────────────────

/** One release: the quality big, the swarm as a bar, whether the profile takes it, and the one button it allows. */
export function BetterCard({ r, canGrab, onGrab }: { r: BetterRelease; canGrab: boolean; onGrab: (r: BetterRelease) => void }) {
  const v = verdictWord(r)
  return (
    <li className={c.rel} data-approved={r.approved} data-top={r.verdict === 'ok'} data-verdict={r.verdict}>
      <div className={c.relQ}>
        <span className={c.res}>{r.resolution ? `${r.resolution}p` : r.quality}</span>
        <span className={c.relSrc}>{[r.source, r.codec].filter(Boolean).join(' · ')}</span>
      </div>
      <div className={c.relBody}>
        <div className={c.itemHead}>
          <span className={c.relTitle}>{r.title}</span>
          <Pill tone={v.tone}>{v.text}</Pill>
          {r.slow && <Pill tone="warn">Slow: {r.seeders} {r.seeders === 1 ? 'seed' : 'seeds'}</Pill>}
        </div>
        <span className={c.meta}>
          {[r.quality, sizeWord(r.size), r.indexer, r.languages.join(', '),
            r.protocol === 'usenet' ? [r.ageDays !== null ? `${r.ageDays} days old` : '', r.grabs !== null ? `${r.grabs} grabs` : ''].filter(Boolean).join(', ') : ''].filter(Boolean).join(' · ')}
        </span>
        {r.protocol === 'torrent' && (
          <div className={c.swarm} aria-label={`${r.seeders ?? '?'} seeders, ${r.peers ?? '?'} peers`}>
            <span className={c.swarmBar}><i style={{ width: `${Math.round(swarm(r.seeders) * 100)}%` }} /></span>
            <span>{r.seeders ?? '?'} seeders · {r.peers ?? '?'} peers</span>
          </div>
        )}
        {r.why && <p className={r.verdict === 'refused' ? c.bad : c.note}>{r.why}</p>}
        {canGrab && r.verdict !== 'refused' && (
          <div className={c.row}>
            <button type="button" className={c.primary} onClick={() => onGrab(r)}>{r.verdict === 'anyway' ? 'Grab anyway' : 'Get this one'}</button>
          </div>
        )}
      </div>
    </li>
  )
}

export function BetterList({ a, app, canGrab, onGrab }: { a: BetterAnswer; app: App; canGrab: boolean; onGrab: (r: BetterRelease) => void }) {
  const hidden = betterHidden(a.hidden)
  return (
    <div className={c.rels}>
      <div className={b.have}>
        <span>{a.swap ? 'Replacing' : 'You have'}</span>
        <b>{a.swap ? a.swap.name : a.have ?? 'nothing yet'}</b>
      </div>
      <p className={c.note}>
        {a.found === 0 ? 'No release found at all on your indexers.' : `${a.found} found, ${a.accepted} your profile accepts. Best first: accepted, then quality, then seeders.`}
        {a.reused ? ` Results from a few minutes ago; a new search is possible after ${new Date(a.nextSearchAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}
      </p>
      {hidden && <p className={c.note} role="note">{hidden}</p>}
      {a.rows.length === 0 && a.found > 0 && <p className={s.empty}>Nothing left to offer once those are left out.</p>}
      {a.rows.length > 0 && <ul className={c.relList}>{a.rows.map(r => <BetterCard key={r.id} r={r} canGrab={canGrab} onGrab={onGrab} />)}</ul>}
      <p className={c.note}>{APP_NAME[app]} keeps what you have until the new copy is imported. No file in your library is deleted.</p>
    </div>
  )
}

// ── the dialog ───────────────────────────────────────────────────────────────

export function BetterDialog({ target, app, title, onClose }: { target: string; app: App; title: string; onClose: () => void }) {
  const [a, setA] = useState<BetterAnswer | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pick, setPick] = useState<BetterRelease | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<BetterGrab | null>(null)

  useEffect(() => {
    let gone = false
    void (async () => {
      const r = await apiJson<{ data: BetterAnswer }>('/api/plugins/arrstack/better/search', 'POST', { target })
      if (gone) return
      if (!r.ok || !r.body?.data) { setErr(r.error ?? 'The search did not work.'); return }
      setA(r.body.data)
    })()
    return () => { gone = true }
  }, [target])

  const grab = async () => {
    if (!pick) return
    setBusy(true)
    const r = await apiJson<{ data: BetterGrab }>('/api/plugins/arrstack/better/grab', 'POST', { target, releaseId: pick.id, confirmed: true, ...(pick.verdict === 'anyway' ? { anyway: true } : {}) })
    setBusy(false); setPick(null)
    if (!r.ok || !r.body?.data) { setErr(r.error ?? 'The download could not be started.'); return }
    setDone(r.body.data)
  }

  return (
    <ModalFrame label={`A better copy of ${title}`} onClose={onClose} width="sm:max-w-3xl"
      header={<div className={c.dlgHead}><h2>{a?.swap ? 'Find a faster copy' : 'Find a better copy'}</h2><span>{a?.label ?? title}</span></div>}
      footer={<button type="button" className={c.ghost} onClick={onClose}>Close</button>}>
      {!a && !err && <p className={s.empty}>Asking every indexer… this can take a minute.</p>}
      {err && <p className={c.bad} role="alert">{err}</p>}
      {done && <div className={c.result} data-result={done.result} role="status"><p>{done.summary}</p>{done.notes.map(n => <p key={n} className={c.note}>{n}</p>)}</div>}
      {pick && a && <ConfirmBox text={betterConfirm(pick, a, app)} yes={pick.verdict === 'anyway' ? 'Grab anyway' : 'Download it'} busy={busy} onYes={grab} onNo={() => setPick(null)} />}
      {a && !done && <BetterList a={a} app={app} canGrab={!pick} onGrab={r => setPick(r)} />}
    </ModalFrame>
  )
}

// ── finding something in the library ────────────────────────────────────────

const KINDS: Array<[App, string]> = [['radarr', 'Films'], ['sonarr', 'TV'], ['lidarr', 'Music']]

/** One found film, album, episode or season, with what is on disk and the button. */
export function FoundRow({ f, onPick }: { f: FoundItem; onPick: (f: FoundItem) => void }) {
  return (
    <li className={b.found}>
      <div className={b.foundText}>
        <b>{f.title}</b>
        <span>{[f.detail, f.have].filter(Boolean).join(' · ')}</span>
      </div>
      <button type="button" className={c.link} onClick={() => onPick(f)}>Find a better copy</button>
    </li>
  )
}

export function FindBetter({ lidarr }: { lidarr: boolean }) {
  const { role } = useSession()
  const canAct = atLeast(role, 'admin')
  const [app, setApp] = useState<App>('radarr')
  const [q, setQ] = useState('')
  const [items, setItems] = useState<FoundItem[] | null>(null)
  const [shows, setShows] = useState<FoundShow[] | null>(null)
  const [season, setSeason] = useState<{ show: FoundShow; n: number; season: FoundItem; episodes: FoundItem[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [look, setLook] = useState<{ target: string; app: App; title: string } | null>(null)

  const find = useCallback(async () => {
    setErr(null); setSeason(null)
    if (q.trim().length < 2) { setItems(null); setShows(null); return }
    const r = await apiJson<{ data: { items?: FoundItem[]; shows?: FoundShow[] } }>(`/api/plugins/arrstack/better/find?app=${app}&q=${encodeURIComponent(q.trim())}`)
    if (!r.ok || !r.body?.data) { setErr(r.error ?? 'The library could not be read.'); return }
    setItems(r.body.data.items ?? null); setShows(r.body.data.shows ?? null)
  }, [app, q])

  const openSeason = async (show: FoundShow, n: number) => {
    setErr(null)
    const r = await apiJson<{ data: { season: FoundItem; episodes: FoundItem[] } }>(`/api/plugins/arrstack/better/episodes?seriesId=${show.seriesId}&season=${n}`)
    if (!r.ok || !r.body?.data) { setErr(r.error ?? 'The season could not be read.'); return }
    setSeason({ show, n, ...r.body.data })
  }

  if (!canAct) return null
  const pick = (f: FoundItem, title?: string) => setLook({ target: f.target, app: f.target.startsWith('sonarr') ? 'sonarr' : f.target.startsWith('lidarr') ? 'lidarr' : 'radarr', title: title ?? `${f.title} ${f.detail}`.trim() })
  return (
    <Panel title="Find a better copy" sub="ANY FILM, EPISODE, SEASON OR ALBUM">
      <form className={b.bar} onSubmit={e => { e.preventDefault(); void find() }}>
        <div className={c.seg} role="group" aria-label="Look in">
          {KINDS.filter(([k]) => k !== 'lidarr' || lidarr).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={app === k} onClick={() => { setApp(k); setItems(null); setShows(null); setSeason(null) }}>{label}</button>
          ))}
        </div>
        <label className={b.search}>
          <span className={s.srOnly}>Title</span>
          <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={app === 'sonarr' ? 'Show title' : app === 'lidarr' ? 'Album or artist' : 'Film title'} maxLength={80} />
        </label>
        <button type="submit" className={c.primary}>Find</button>
      </form>
      {err && <p className={c.bad} role="alert">{err}</p>}
      {items && (items.length ? <ul className={b.list}>{items.map(f => <FoundRow key={f.target} f={f} onPick={x => pick(x)} />)}</ul> : <p className={s.empty}>Nothing in the library matches.</p>)}
      {shows && !season && (shows.length ? (
        <ul className={b.list}>
          {shows.map(sh => (
            <li key={sh.seriesId} className={b.show}>
              <div className={b.foundText}><b>{sh.title}</b><span>{sh.detail}</span></div>
              <div className={b.seasons} role="group" aria-label={`${sh.title} seasons`}>
                {sh.seasons.map(se => (
                  <button key={se.season} type="button" className={b.chip} data-full={se.episodes > 0 && se.files >= se.episodes} onClick={() => void openSeason(sh, se.season)}
                    aria-label={`${se.season === 0 ? 'Specials' : `Season ${se.season}`}: ${se.files} of ${se.episodes} episodes`}>
                    {se.season === 0 ? 'Specials' : `S${se.season}`}<small>{se.files}/{se.episodes}</small>
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      ) : <p className={s.empty}>No show in the library matches.</p>)}
      {season && (
        <div className={c.rels}>
          <div className={c.row}>
            <button type="button" className={c.link} onClick={() => setSeason(null)}>← {season.show.title}</button>
          </div>
          <ul className={b.list}>
            <FoundRow f={{ ...season.season, title: `${season.show.title}, the whole ${season.n === 0 ? 'specials' : `season ${season.n}`}` }} onPick={() => pick(season.season, `${season.show.title} ${season.season.detail}`)} />
            {season.episodes.map(e => <FoundRow key={e.target} f={e} onPick={x => pick(x, `${season.show.title} ${x.detail}`)} />)}
          </ul>
        </div>
      )}
      {look && <BetterDialog target={look.target} app={look.app} title={look.title} onClose={() => setLook(null)} />}
    </Panel>
  )
}
