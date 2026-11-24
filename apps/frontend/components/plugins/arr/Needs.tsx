'use client'

// =============================================================================
//  HyperProx — Arr Stack, Needs you
//
//  The first tab. Everything that waits on a person, in one list with one Fix button each, and "All good ✓" when
//  there is nothing: downloads that are stuck, failed or cannot be added to the library (from the queue reading's
//  `plain.needs`, the same one the header and the dashboard tile count), requests that failed, faults in Seerr's links
//  to Radarr, Sonarr and the media server, and finished downloads that cannot be filed (Map by filename). A Fix that
//  has more than one way to go opens a short list. Everything that changes something asks first and is audited
//  server-side; only admins see the buttons, and everyone else is told to ask one.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { IN_PAGE } from '@/lib/confirm-bus'
import { useSession } from '@/lib/session'
import { Panel, Pill, styles as s } from '@/components/visual/kit'
import c from './arrux.module.css'
import q from './queue.module.css'
import type { QueueData } from './Queue'
import { ActionBox, FixButton, FixChoices, FixStalled, useFix, type FixOption, type FixTarget } from './QueueActions'
import { ConfirmBox, HealthView } from './Requests'
import type { Stuck } from '../visual/views'
import { KIND_WORD, type NeedItem } from './arr-plain'
import { ACT_LABEL, confirmText, kindWord, type Act, type ActResult, type FixChoice, type Health, type Listing, type RequestRow } from './requests-view'

/** A finished download the library cannot file (what the page's "stuck imports" reading gives). */
export type UnfiledImport = Stuck

const queueId = (rawId: string) => `d:${rawId}`

/** One stuck show, film or artist: what is wrong, and its Fix. */
export function NeedCard({ n, canAct, stuck, onMap }: { n: NeedItem; canAct: boolean; stuck: UnfiledImport[]; onMap: (u: UnfiledImport) => void }) {
  // "Map by filename" is offered for a blocked import the page has already read the files of.
  const mapped = stuck.find(u => n.problemIds.includes(queueId(u.id)) && u.mappable > 0)
  const extra: FixOption[] = mapped ? [{ label: `Map by filename (${mapped.mappable} of ${mapped.files})`, run: () => onMap(mapped) }] : []
  const target: FixTarget = { id: n.key, title: n.title, instance: n.instance, downloadIds: n.problemIds, problemIds: n.problemIds, retryIds: n.retryIds, torrentIds: [], findable: null, done: false }
  const fix = useFix(target, extra)
  return (
    <li className={c.need} data-sev={n.severity}>
      <div className={c.needHead}>
        <b className={c.needTitle}>{n.title}</b>
        <Pill tone={n.severity}>{KIND_WORD[n.kind]}</Pill>
      </div>
      <p className={c.needWhat}>{n.what}</p>
      {canAct ? <div className={c.needAct}><FixButton fix={fix} /></div> : <p className={c.needAsk}>Ask an admin to fix this.</p>}
      <FixChoices fix={fix} />
      <ActionBox k={fix.k} />
    </li>
  )
}

/** A failed request, with its one button. */
export function FailedRequest({ r, canAct, onAct }: { r: RequestRow; canAct: boolean; onAct: (a: Act, title: string) => void }) {
  return (
    <li className={c.need} data-sev="bad">
      <div className={c.needHead}>
        <b className={c.needTitle}>{r.title}{r.year ? ` (${r.year})` : ''}</b>
        <Pill>{kindWord(r)}</Pill>
      </div>
      <p className={c.needWhat}>The request failed: {r.where}</p>
      {canAct ? <div className={c.needAct}><button type="button" className={q.actGo} onClick={() => onAct({ action: 'retry', id: r.id }, r.title)}>Fix: try again</button></div> : <p className={c.needAsk}>Ask an admin to fix this.</p>}
    </li>
  )
}

/** What the tab shows for one set of readings (rendered in tests; `n` is what the queue reading says). */
export function NeedsView({ needs, failed, health, stuck, unfiled, canAct, onMap, onAct, choices, onChoice, ready, summary, stalledAll = [] }: {
  needs: NeedItem[]; failed: RequestRow[]; health: Health | null
  /** Every finished download the page has read the files of; and the ones among them no queue entry shows. */
  stuck: UnfiledImport[]; unfiled: UnfiledImport[]; canAct: boolean
  onMap: (u: UnfiledImport) => void; onAct: (a: Act, title: string) => void; choices: FixChoice[]; onChoice: (c: FixChoice) => void
  /** True once the queue has been read: before that there is nothing to call "all good". */
  ready: boolean; summary?: string
  /** Every stalled download in the queue, for "Fix all stuck" (shown when there are two or more). */
  stalledAll?: Array<{ instance: 'sonarr' | 'radarr' | 'lidarr'; id: string }>
}) {
  const seerr = !!health && (health.problems.length > 0 || health.stale.length > 0)
  const nothing = needs.length === 0 && failed.length === 0 && !seerr && unfiled.length === 0
  if (!ready) return <p className={s.empty}>Reading the queue…</p>
  if (nothing) {
    return (
      <div className={c.allgood} role="status">
        <span className={c.tick} aria-hidden>✓</span>
        <div><b>All good ✓</b><p>{summary ?? 'Nothing is stuck and nothing needs you.'}</p></div>
      </div>
    )
  }
  return (
    <>
      {canAct && stalledAll.length >= 2 && <FixStalled keyName="all" label={`Fix all stuck (${stalledAll.length})`} items={stalledAll} />}
      {needs.length > 0 && (
        <ul className={c.needs} aria-label="Downloads that need you">
          {needs.map(n => <NeedCard key={`${n.instance}:${n.key}`} n={n} canAct={canAct} stuck={stuck} onMap={onMap} />)}
        </ul>
      )}
      {unfiled.length > 0 && (
        <ul className={c.needs} aria-label="Finished downloads that cannot be filed">
          {unfiled.map(u => (
            <li key={u.id} className={c.need} data-sev="warn">
              <div className={c.needHead}><b className={c.needTitle}>{u.series}</b><Pill>Show</Pill></div>
              <p className={c.needWhat}>It finished downloading, but the library cannot read the season and episode out of the file names, so waiting will not file it. {u.mappable} of {u.files} can be mapped by name.</p>
              {canAct ? <div className={c.needAct}><button type="button" className={q.actGo} disabled={!u.mappable} onClick={() => onMap(u)}>Fix: map by filename</button></div> : <p className={c.needAsk}>Ask an admin to fix this.</p>}
            </li>
          ))}
        </ul>
      )}
      {failed.length > 0 && (
        <ul className={c.needs} aria-label="Requests that failed">
          {failed.map(r => <FailedRequest key={r.id} r={r} canAct={canAct} onAct={onAct} />)}
        </ul>
      )}
      {seerr && health && <HealthView h={health} canAct={canAct} onAct={onAct} choices={choices} onChoice={onChoice} />}
    </>
  )
}

export function ArrNeeds({ data, error, stuck, unfiled, rescueNote, onMap, summary }: {
  data: QueueData | null; error: string | null; stuck: UnfiledImport[]; unfiled: UnfiledImport[]; rescueNote: string | null; onMap: (u: UnfiledImport) => void; summary?: string
}) {
  const { role } = useSession()
  const canAct = atLeast(role, 'admin')
  const [list, setList] = useState<Listing | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pending, setPending] = useState<{ act: Act; title: string } | null>(null)
  const [choices, setChoices] = useState<FixChoice[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ActResult | null>(null)

  const load = useCallback(async () => {
    const r = await apiJson<{ data: Listing }>('/api/plugins/arrstack/requests')
    if (r.ok && r.body?.data) setList(r.body.data)
  }, [])
  const loadHealth = useCallback(async () => {
    const r = await apiJson<{ data: Health }>('/api/plugins/arrstack/requests/health')
    if (r.ok && r.body?.data) setHealth(r.body.data)
  }, [])
  useEffect(() => {
    void load(); void loadHealth()
    const t = setInterval(() => { if (!document.hidden) void load() }, 15_000)
    const t2 = setInterval(() => { if (!document.hidden) void loadHealth() }, 90_000)
    return () => { clearInterval(t); clearInterval(t2) }
  }, [load, loadHealth])

  const run = async () => {
    if (!pending) return
    setBusy(true)
    const r = await apiJson<{ data: ActResult }>('/api/plugins/arrstack/requests/actions', 'POST', pending.act, IN_PAGE)
    setBusy(false); setPending(null)
    if (!r.ok || !r.body?.data) { setErr(r.error ?? 'That did not work.'); return }
    setErr(null); setResult(r.body.data)
    void load(); void loadHealth()
  }
  const failed = (list?.configured ? list.rows.filter(r => r.group === 'failed') : [])
  const stalledAll = useMemo(() => {
    const out: Array<{ instance: 'sonarr' | 'radarr' | 'lidarr'; id: string }> = []
    for (const sh of data?.shows ?? []) for (const se of sh.seasons) for (const d of se.downloads) if (d.problem === 'stalled') out.push({ instance: 'sonarr', id: d.id })
    for (const m of data?.movies ?? []) if (m.problem === 'stalled') out.push({ instance: 'radarr', id: m.id })
    for (const ar of data?.artists ?? []) for (const al of ar.albums) for (const d of al.downloads) if (d.problem === 'stalled') out.push({ instance: 'lidarr', id: d.id })
    return out
  }, [data])
  return (
    <div className={c.tab}>
      <Panel title="Needs you" sub={data ? undefined : 'READING'} className={q.panel}>
        {error && <p className={q.err} role="alert">{data ? `Showing the last reading. ${error}` : error}</p>}
        {err && <p className={q.err} role="alert">{err}</p>}
        {rescueNote && <p className={q.actNote} role="status">{rescueNote}</p>}
        {result && <div className={q.actResult} data-ok={result.done} role="status"><p>{result.summary}</p>{result.notes.map(n => <p key={n} className={q.actNote}>{n}</p>)}</div>}
        {pending && <ConfirmBox text={confirmText(pending.act, pending.title)} yes={pending.act.action === 'reconnect' ? 'Reconnect' : ACT_LABEL[pending.act.action]} busy={busy} onYes={() => void run()} onNo={() => setPending(null)} />}
        <NeedsView needs={data?.plain.needs ?? []} failed={failed} health={health} stuck={stuck} unfiled={unfiled} canAct={canAct && !pending} onMap={onMap}
          onAct={(a, t) => { setResult(null); setPending({ act: a, title: t }) }} choices={choices}
          onChoice={ch => setChoices(cs => [...cs.filter(x => !(x.app === ch.app && x.serverId === ch.serverId && x.field === ch.field)), ch])}
          ready={!!data} summary={summary} stalledAll={stalledAll} />
      </Panel>
    </div>
  )
}

