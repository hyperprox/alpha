'use client'

// =============================================================================
//  HyperProx — Arr Stack, Queue actions
//
//  What a person can do about a problem in the queue: get another copy ("Fix"), remove (optionally blocklisting),
//  retry a blocked import, move a torrent to the top, swap a season's single episodes for a season pack, fix
//  every stalled download at once, clear the finished ones (everything already in the library) from the queue, and
//  "find a faster copy" (BetterCopy.tsx: a release search for what the download is for; the pick replaces it). Admins only: a viewer or operator sees no buttons at all, and the server refuses
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
import { BetterDialog } from './BetterCopy'
import { queueTarget } from './better-view'

export type Instance = 'sonarr' | 'radarr' | 'lidarr'
export interface ActReq {
  action: 'find-another' | 'remove' | 'retry-import' | 'prioritise' | 'swap-pack' | 'fix-stalled' | 'fix-many' | 'clear-done' | 'swap-check'
  instance: Instance
  downloadId?: string; downloadIds?: string[]; blocklist?: boolean; showKey?: string; seasonKey?: string; known?: string[]
}
interface PlanView {
  action: string; instance: Instance; blocklist: boolean; search: string[]; seasonLabel?: string
  items: Array<{ downloadId: string; name: string; rows: number; episodes: number; albums?: number }>
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

/** `admin` is only for a test or a preview: it stands in for the signed-in person's role. */
export function ActionsProvider({ children, refresh, canPrioritise, admin }: { children: ReactNode; refresh?: () => void; canPrioritise: boolean; admin?: boolean }) {
  const { role } = useSession()
  const canAct = admin ?? atLeast(role, 'admin')
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
const inst = (i: Instance) => (i === 'sonarr' ? 'Sonarr' : i === 'lidarr' ? 'Lidarr' : 'Radarr')

function Confirm({ k, f }: { k: string; f: Flow }) {
  const a = useAct()!
  const items = f.plans.flatMap(p => p.items.map(i => ({ ...i, instance: p.instance })))
  const search = f.plans.flatMap(p => p.search)
  const swap = f.spec.reqs.some(r => r.action === 'swap-pack')
  const remove = f.spec.reqs.every(r => r.action === 'remove')
  const blocklisted = f.spec.choice ? f.blocklist : f.plans.some(p => p.blocklist)
  const verb = f.spec.done ? 'Clear from queue' : remove ? 'Remove' : swap ? 'Swap for a pack' : 'Get another copy'
  return (
    <div className={c.actBox} role="group" aria-label={`Confirm: ${f.spec.title}`}>
      <p className={c.actLead}>{f.spec.title}: this will remove {plural(items.length, 'download')} from the download client and the queue.</p>
      <ul className={c.actList}>
        {items.map(i => (
          <li key={`${i.instance}${i.downloadId}`}>
            <span>{i.name}</span>
            <small>{i.episodes > 1 ? `${plural(i.episodes, 'episode')} · ` : ''}{(i.albums ?? 0) > 1 ? `${plural(i.albums!, 'album')} · ` : ''}{inst(i.instance)}</small>
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

const chunks = <T,>(xs: T[], n = 50): T[][] => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o }

/** What one menu or Fix button works on: a show, film or artist (all its downloads), or one download. */
export interface FixTarget {
  /** Anything unique for the row: keys the inline box. */
  id: string
  title: string
  instance: Instance
  downloadIds: string[]
  /** Downloads with a problem: the Fix gets a new copy for these. */
  problemIds: string[]
  /** The blocked imports among them, which can be tried again first. */
  retryIds: string[]
  /** Torrents that can be moved to the top. */
  torrentIds: string[]
  /** The one download "Find better copy" can search for (only when there is exactly one). */
  findable: string | null
  done: boolean
}
export const itemKey = (t: Pick<FixTarget, 'instance' | 'id'>) => `item:${t.instance}:${t.id}`

export interface FixOption { label: string; run: () => void }

/**
 * The one Fix for a row. A stuck, failed, incomplete or sample download: "Get another copy" (removes it, blocklists the
 * release and searches again; the server re-checks each download first). A blocked import adds "Try the import again",
 * and the page may add its own choice (`extra`). One option runs at once; several open a short list.
 */
export function useFix(t: FixTarget, extra: FixOption[] = []) {
  const a = useAct()
  const [choosing, setChoosing] = useState(false)
  const k = itemKey(t)
  const options: FixOption[] = []
  if (a && t.retryIds.length) {
    options.push({ label: 'Try the import again', run: () => a.start(k, { title: 'Try the import again', reqs: t.retryIds.slice(0, 50).map(id => ({ action: 'retry-import' as const, instance: t.instance, downloadId: id })), destructive: false }) })
  }
  if (a && t.problemIds.length) {
    options.push({ label: 'Get another copy', run: () => a.start(k, { title: 'Get another copy', reqs: chunks(t.problemIds).map(ids => ({ action: 'fix-many' as const, instance: t.instance, downloadIds: ids })), destructive: true }) })
  }
  options.push(...extra)
  const busy = ['asking', 'running', 'confirm'].includes(a?.flows[k]?.phase ?? '')
  return {
    k, options, choosing, busy, canFix: !!a?.canAct && options.length > 0,
    fix: () => { if (options.length === 1) options[0].run(); else if (options.length > 1) setChoosing(true) },
    go: (o: FixOption) => { setChoosing(false); o.run() },
    cancel: () => setChoosing(false),
  }
}
export type Fix = ReturnType<typeof useFix>

/** The short list under a Fix that has more than one way to go. */
export function FixChoices({ fix }: { fix: Fix }) {
  if (!fix.choosing) return null
  return (
    <div className={c.actBox} role="group" aria-label="How to fix it">
      <p className={c.actLead}>How should it be fixed?</p>
      <div className={c.actRow}>
        {fix.options.map(o => <button key={o.label} type="button" className={c.actGo} onClick={() => fix.go(o)}>{o.label}</button>)}
        <button type="button" className={c.actBtn} onClick={fix.cancel}>Cancel</button>
      </div>
    </div>
  )
}

/** The one Fix button of a "Needs you" entry. */
export function FixButton({ fix, label = 'Fix' }: { fix: Fix; label?: string }) {
  if (!fix.canFix) return null
  return <button type="button" className={c.actGo} disabled={fix.busy} onClick={fix.fix}>{label}</button>
}

/** Which entries a row's "⋯" menu offers. Fix only when there is something to fix; Find better copy only for a single download. */
export function menuPlan(t: FixTarget, hasFix: boolean, canPrioritise: boolean) {
  return {
    clear: t.done,
    fix: hasFix,
    better: !!t.findable && !!queueTarget(t.instance, t.findable),
    top: canPrioritise && t.torrentIds.length > 0,
    remove: !t.done,
  }
}

/**
 * The one "⋯" menu of a row: Fix, Find better copy, Move to top, Remove (which asks first). "Find better copy" is the
 * release search (BetterCopy.tsx) for a single download, and replaces what used to be two overlapping buttons, "Find
 * another" and "Find a faster copy": Fix is the automatic one. Admins only; everyone else sees no menu.
 */
export function ItemMenu({ t, fix }: { t: FixTarget; fix: Fix }) {
  const a = useAct()
  const [open, setOpen] = useState(false)
  const [better, setBetter] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  if (!a?.canAct) return null
  const k = itemKey(t)
  const swapTarget = t.findable ? queueTarget(t.instance, t.findable) : null
  const plan = menuPlan(t, fix.options.length > 0, a.canPrioritise)
  const item = (label: string, onClick: () => void, danger = false) => (
    <button type="button" role="menuitem" className={danger ? c.menuDanger : undefined} disabled={fix.busy} onClick={() => { setOpen(false); onClick() }}>{label}</button>
  )
  return (
    <span className={c.menuWrap} ref={root}>
      <button type="button" className={c.dots} aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${t.title}`} onClick={() => setOpen(o => !o)}>⋯</button>
      {open && (
        <div role="menu" className={c.menu} aria-label={`Actions for ${t.title}`}>
          {plan.clear && item('Clear from queue', () => a.start(k, { title: 'Clear from queue', reqs: chunks(t.downloadIds).map(ids => ({ action: 'clear-done' as const, instance: t.instance, downloadIds: ids })), destructive: true, done: true }))}
          {plan.fix && item('Fix', fix.fix)}
          {plan.better && item('Find better copy', () => setBetter(true))}
          {plan.top && item('Move to top', () => a.start(k, { title: 'Move to top', reqs: chunks(t.torrentIds).map(ids => ({ action: 'prioritise' as const, instance: t.instance, downloadIds: ids })), destructive: false }))}
          {plan.remove && item('Remove', () => a.start(k, { title: 'Remove', reqs: chunks(t.downloadIds).map(ids => ({ action: 'remove' as const, instance: t.instance, downloadIds: ids })), destructive: true, choice: true }), true)}
        </div>
      )}
      {better && swapTarget && <BetterDialog target={swapTarget} app={t.instance} title={t.title} onClose={() => setBetter(false)} />}
    </span>
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
  const reqs: ActReq[] = (['sonarr', 'radarr', 'lidarr'] as const)
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
  const groups = (['sonarr', 'radarr', 'lidarr'] as const)
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
