'use client'

// =============================================================================
//  HyperProx — Arr Stack, Queue actions
//
//  What a person can do about a problem in the queue: find another copy, remove (optionally blocklisting),
//  retry a blocked import, move a torrent to the top, swap a season's single episodes for a season pack, fix
//  every stalled download at once, and clear the finished ones (everything already in the library) from the queue. Admins only: a viewer or operator sees no buttons at all, and the server refuses
//  them anyway. Queue downloads only; library files are never touched.
//
//  Anything that removes something goes through a confirm step first. The page asks the server for a preview (the
//  server reads the queue fresh and says exactly which downloads it found) and shows that list, never its own guess.
//  The page sends only an instance and download ids, never a queue row id.
// =============================================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import c from './queue.module.css'

export type Instance = 'sonarr' | 'radarr'
export interface ActReq {
  action: 'find-another' | 'remove' | 'retry-import' | 'prioritise' | 'swap-pack' | 'fix-stalled' | 'clear-done' | 'swap-check'
  instance: Instance
  downloadId?: string; downloadIds?: string[]; blocklist?: boolean; showKey?: string; seasonKey?: string; known?: string[]
}
interface PlanView {
  action: string; instance: Instance; blocklist: boolean; search: string[]; seasonLabel?: string
  items: Array<{ downloadId: string; name: string; rows: number; episodes: number }>
  skipped: Array<{ name: string; reason: string }>
}
interface Spec { title: string; reqs: ActReq[]; destructive: boolean; /** Offer the "blocklist this release" box. */ choice?: boolean; /** Clearing finished downloads: calm wording, never blocklisted. */ done?: boolean }
interface Flow {
  spec: Spec
  phase: 'asking' | 'confirm' | 'running' | 'done' | 'error'
  plans: PlanView[]
  blocklist: boolean
  message: string
  details: string[]
  hint: string | null
}

interface Ctx {
  canAct: boolean
  canPrioritise: boolean
  flows: Record<string, Flow>
  start: (key: string, spec: Spec) => void
  confirm: (key: string) => void
  setBlocklist: (key: string, v: boolean) => void
  dismiss: (key: string) => void
}
const ActCtx = createContext<Ctx | null>(null)
const useAct = () => useContext(ActCtx)

const SWAP_CHECK_MS = 20_000

export function ActionsProvider({ children, refresh, canPrioritise }: { children: ReactNode; refresh?: () => void; canPrioritise: boolean }) {
  const { role } = useSession()
  const canAct = atLeast(role, 'admin')
  const [flows, setFlows] = useState<Record<string, Flow>>({})
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const alive = useRef(true)
  useEffect(() => { alive.current = true; const t = timers.current; return () => { alive.current = false; t.forEach(clearTimeout) } }, [])

  const patch = useCallback((key: string, p: Partial<Flow>) => {
    if (!alive.current) return
    setFlows(f => (f[key] ? { ...f, [key]: { ...f[key], ...p } } : f))
  }, [])
  const poke = useCallback(() => {
    refresh?.()
    const t = setTimeout(() => { timers.current.delete(t); refresh?.() }, 1500)
    timers.current.add(t)
  }, [refresh])

  const run = useCallback(async (key: string, spec: Spec, blocklist: boolean, plansShown: PlanView[] = []) => {
    patch(key, { phase: 'running' })
    const messages: string[] = [], details: string[] = []
    let hint: string | null = null
    for (const [idx, r0] of spec.reqs.entries()) {
      // A swap is confirmed against the exact downloads that were previewed.
      const r: ActReq = r0.action === 'swap-pack' ? { ...r0, downloadIds: (plansShown[idx]?.items ?? []).map(i => i.downloadId) } : r0
      const body: ActReq & { confirmed?: boolean } = { ...r, ...(spec.choice ? { blocklist } : {}), ...(spec.destructive ? { confirmed: true } : {}) }
      const res = await apiJson<{ data: any }>('/api/plugins/arrstack/queue/actions', 'POST', body)
      if (!res.ok) { messages.push(res.error ?? 'It did not work.'); patch(key, { phase: 'error', message: messages.join(' '), details }); poke(); return }
      const d = res.body?.data
      messages.push(d?.summary ?? 'Done.')
      for (const n of d?.notes ?? []) details.push(n)
      for (const m of d?.messages ?? []) details.push(m)
      if (d?.hint) hint = d.hint
      if (r.action === 'swap-pack') {
        const known: string[] = d?.packsBefore ?? []
        const t = setTimeout(async () => {
          timers.current.delete(t)
          const chk = await apiJson<{ data: any }>('/api/plugins/arrstack/queue/actions', 'POST', { action: 'swap-check', instance: r.instance, showKey: r.showKey, seasonKey: r.seasonKey, known })
          patch(key, { message: chk.ok ? (chk.body?.data?.summary ?? 'Checked.') : (chk.error ?? 'Could not check for a pack.') })
          poke()
        }, SWAP_CHECK_MS)
        timers.current.add(t)
      }
    }
    patch(key, { phase: 'done', message: messages.join(' '), details, hint })
    poke()
  }, [patch, poke])

  const start = useCallback((key: string, spec: Spec) => {
    const first: Flow = { spec, phase: spec.destructive ? 'asking' : 'running', plans: [], blocklist: false, message: '', details: [], hint: null }
    setFlows(f => ({ ...f, [key]: first }))
    if (!spec.destructive) { void run(key, spec, false); return }
    void (async () => {
      const plans: PlanView[] = []
      for (const r of spec.reqs) {
        const res = await apiJson<{ data: any }>('/api/plugins/arrstack/queue/actions', 'POST', { ...r, preview: true })
        if (!res.ok) { patch(key, { phase: 'error', message: res.error ?? 'It could not be checked.' }); return }
        plans.push(res.body!.data.plan)
      }
      patch(key, { phase: 'confirm', plans })
    })()
  }, [patch, run])

  const value = useMemo<Ctx>(() => ({
    canAct, canPrioritise, flows, start,
    confirm: key => { const f = flows[key]; if (f && f.phase === 'confirm') void run(key, f.spec, f.blocklist, f.plans) },
    setBlocklist: (key, v) => patch(key, { blocklist: v }),
    dismiss: key => setFlows(f => { const n = { ...f }; delete n[key]; return n }),
  }), [canAct, canPrioritise, flows, start, run, patch])

  return <ActCtx.Provider value={value}>{children}</ActCtx.Provider>
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const inst = (i: Instance) => (i === 'sonarr' ? 'Sonarr' : 'Radarr')

function Confirm({ k, f }: { k: string; f: Flow }) {
  const a = useAct()!
  const items = f.plans.flatMap(p => p.items.map(i => ({ ...i, instance: p.instance })))
  const search = f.plans.flatMap(p => p.search)
  const swap = f.spec.reqs.some(r => r.action === 'swap-pack')
  const remove = f.spec.reqs.every(r => r.action === 'remove')
  const blocklisted = f.spec.choice ? f.blocklist : f.plans.some(p => p.blocklist)
  const verb = f.spec.done ? 'Clear from queue' : remove ? 'Remove' : swap ? 'Swap for a pack' : 'Find another'
  return (
    <div className={c.actBox} role="group" aria-label={`Confirm: ${f.spec.title}`}>
      <p className={c.actLead}>{f.spec.title}: this will remove {plural(items.length, 'download')} from the download client and the queue.</p>
      <ul className={c.actList}>
        {items.map(i => (
          <li key={`${i.instance}${i.downloadId}`}>
            <span>{i.name}</span>
            <small>{i.episodes > 1 ? `${plural(i.episodes, 'episode')} · ` : ''}{inst(i.instance)}</small>
          </li>
        ))}
      </ul>
      {f.plans.some(p => p.skipped.length > 0) && (
        <p className={c.actNote}>Left alone because they changed: {f.plans.flatMap(p => p.skipped).map(s => `${s.name} (${s.reason})`).join('; ')}.</p>
      )}
      {f.spec.choice && (
        <label className={c.chk}>
          <input type="checkbox" checked={f.blocklist} onChange={e => a.setBlocklist(k, e.target.checked)} />
          <span>Blocklist this release so it is not grabbed again</span>
        </label>
      )}
      {!f.spec.choice && blocklisted && <p className={c.actNote}>The release will be blocklisted, so it is not grabbed again.</p>}
      {f.spec.done && <p className={c.actNote}>Everything these cover is already in your library. They are not blocklisted, and nothing is searched for.</p>}
      {swap && <p className={c.actNote}>Not blocklisted: if no season pack exists, the singles can come back.</p>}
      {search.length > 0 && <p className={c.actNote}>Then it searches for another copy of: {search.join(', ')}.</p>}
      <p className={c.actNote}>Nothing in your library is deleted.</p>
      <div className={c.actRow}>
        <button type="button" className={c.actGo} onClick={() => a.confirm(k)}>{verb}</button>
        <button type="button" className={c.actBtn} onClick={() => a.dismiss(k)}>Cancel</button>
      </div>
    </div>
  )
}

/** The inline step or result for one set of buttons. */
export function ActionBox({ k }: { k: string }) {
  const a = useAct()
  const f = a?.flows[k]
  if (!a || !f) return null
  if (f.phase === 'confirm') return <Confirm k={k} f={f} />
  if (f.phase === 'asking' || f.phase === 'running') return <p className={c.actNote} role="status">{f.phase === 'asking' ? 'Checking the queue…' : 'Working…'}</p>
  return (
    <div className={c.actResult} data-ok={f.phase === 'done'} role={f.phase === 'error' ? 'alert' : 'status'}>
      <p>{f.message}</p>
      {f.details.map((m, i) => <p key={i} className={c.actNote}>{m}</p>)}
      {f.hint && <p className={c.actNote}>{f.hint}</p>}
      <button type="button" className={c.actBtn} onClick={() => a.dismiss(k)}>Dismiss</button>
    </div>
  )
}

/** Finished results from every set of buttons, kept at the top so one whose row has left the queue is not lost. */
export function ActionResults() {
  const a = useAct()
  if (!a) return null
  const done = Object.entries(a.flows).filter(([, f]) => f.phase === 'done' || f.phase === 'error')
  if (!done.length) return null
  return (
    <ul className={c.strip} aria-label="Recent actions">
      {done.slice(-4).map(([k, f]) => (
        <li key={k} data-ok={f.phase === 'done'}>
          <span>{f.message}</span>
          <button type="button" className={c.actBtn} onClick={() => a.dismiss(k)} aria-label="Dismiss this result">Dismiss</button>
        </li>
      ))}
    </ul>
  )
}

export interface ActDownload { id: string; name: string; state: string; done?: boolean; problem: string | null; protocol: string | null; sizeLeft: number; episodes: number }

const TORRENT_ID = /^d:(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/

export function DownloadActions({ instance, d }: { instance: Instance; d: ActDownload }) {
  const a = useAct()
  if (!a?.canAct) return null
  const k = `dl:${instance}:${d.id}`
  const busy = ['asking', 'running', 'confirm'].includes(a.flows[k]?.phase ?? '')
  const incomplete = d.problem === 'incomplete'
  const blocked = !incomplete && (d.state === 'importBlocked' || d.state === 'importFailed')
  if (d.done) {
    // Finished: everything it covers is in the library. The only thing to do is clear it (Remove, never blocklisted).
    return (
      <>
        <div className={c.actRow}>
          <button type="button" className={c.actGo} disabled={busy} onClick={() => a.start(k, { title: 'Clear from queue', reqs: [{ action: 'clear-done', instance, downloadIds: [d.id] }], destructive: true, done: true })}>Clear from queue</button>
        </div>
        <ActionBox k={k} />
      </>
    )
  }
  return (
    <>
      <div className={c.actRow}>
        <button type="button" className={incomplete ? c.actGo : c.actBtn} disabled={busy} onClick={() => a.start(k, { title: 'Find another', reqs: [{ action: 'find-another', instance, downloadId: d.id }], destructive: true })}>Find another</button>
        <button type="button" className={c.actBtn} disabled={busy} onClick={() => a.start(k, { title: 'Remove', reqs: [{ action: 'remove', instance, downloadId: d.id }], destructive: true, choice: true })}>Remove</button>
        {blocked && <button type="button" className={c.actBtn} disabled={busy} onClick={() => a.start(k, { title: 'Retry import', reqs: [{ action: 'retry-import', instance, downloadId: d.id }], destructive: false })}>Retry import</button>}
        {a.canPrioritise && d.protocol === 'torrent' && TORRENT_ID.test(d.id) && (
          <button type="button" className={c.actBtn} disabled={busy} onClick={() => a.start(k, { title: 'Prioritise', reqs: [{ action: 'prioritise', instance, downloadId: d.id }], destructive: false })}>Move to top</button>
        )}
      </div>
      <ActionBox k={k} />
    </>
  )
}

/** Swap a season's single-episode downloads for a season pack. Shown only when two or more are still downloading. */
export function SeasonActions({ showKey, seasonKey, singles }: { showKey: string; seasonKey: string; singles: number }) {
  const a = useAct()
  if (!a?.canAct || singles < 2 || !/^s:\d+$/.test(showKey) || !/^\d+$/.test(seasonKey)) return null
  const k = `season:${showKey}|${seasonKey}`
  const busy = ['asking', 'running', 'confirm'].includes(a.flows[k]?.phase ?? '')
  return (
    <>
      <div className={c.actRow}>
        <button type="button" className={c.actBtn} disabled={busy} onClick={() => a.start(k, { title: 'Swap for a season pack', reqs: [{ action: 'swap-pack', instance: 'sonarr', showKey, seasonKey }], destructive: true })}>
          Swap {singles} singles for a season pack
        </button>
      </div>
      <ActionBox k={k} />
    </>
  )
}

/** Find another for every stalled download in `items` (one show, or the whole queue). */
export function FixStalled({ keyName, items, label }: { keyName: string; items: Array<{ instance: Instance; id: string }>; label: string }) {
  const a = useAct()
  if (!a?.canAct || !items.length) return null
  const k = `stalled:${keyName}`
  const busy = ['asking', 'running', 'confirm'].includes(a.flows[k]?.phase ?? '')
  const reqs: ActReq[] = (['sonarr', 'radarr'] as const)
    .map(i => ({ i, ids: items.filter(x => x.instance === i).map(x => x.id).slice(0, 50) }))
    .filter(x => x.ids.length)
    .map(x => ({ action: 'fix-stalled' as const, instance: x.i, downloadIds: x.ids }))
  return (
    <>
      <div className={c.actRow}>
        <button type="button" className={c.actBtn} disabled={busy} onClick={() => a.start(k, { title: 'Fix stalled', reqs, destructive: true })}>{label}</button>
      </div>
      <ActionBox k={k} />
    </>
  )
}

/** Clear every finished download in `items` (the whole queue). Never blocklisted; the server re-checks each one. */
export function ClearDone({ items }: { items: Array<{ instance: Instance; id: string }> }) {
  const a = useAct()
  if (!a?.canAct || !items.length) return null
  const k = 'done:all'
  const busy = ['asking', 'running', 'confirm'].includes(a.flows[k]?.phase ?? '')
  const groups = (['sonarr', 'radarr'] as const)
    .map(i => ({ i, ids: items.filter(x => x.instance === i).map(x => x.id).slice(0, 50) }))
    .filter(x => x.ids.length)
  const reqs: ActReq[] = groups.map(x => ({ action: 'clear-done' as const, instance: x.i, downloadIds: x.ids }))
  // The count on the button is what will be sent: at most 50 per instance.
  const sending = groups.reduce((t, x) => t + x.ids.length, 0)
  return (
    <>
      <div className={c.actRow}>
        <button type="button" className={c.actBtn} disabled={busy} onClick={() => a.start(k, { title: 'Clear all done', reqs, destructive: true, done: true })}>Clear all done ({sending})</button>
      </div>
      <ActionBox k={k} />
    </>
  )
}
