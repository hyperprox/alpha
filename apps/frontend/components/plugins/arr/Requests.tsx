'use client'

// =============================================================================
//  HyperProx — Arr Stack, Requests
//
//  What people have asked Seerr (formerly Jellyseerr and Overseerr) for, as cards with a poster: waiting, approved,
//  downloading, available, failed and declined, and where each one is now ("sorted into" the folder the folder sorter
//  chose, when it did). Who asked is for admins; everyone else sees "a family member". An admin gets Approve, Decline
//  (with a reason if they like) and Try again for a failed one. Above the cards, anything wrong with Seerr itself
//  carries its fix button: reconnect Radarr, Sonarr or the media server with the keys HyperProx has, and "Fix Seerr's
//  settings" when a quality profile or folder it points at is gone. Every button asks first, and the server asks again
//  (IN_PAGE sends the confirmation the server's token stands for). Read from routes/arr-requests.ts every 15 s while the
//  tab is visible. No address or key of Seerr, Radarr, Sonarr or the media server is ever on this page.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { IN_PAGE } from '@/lib/confirm-bus'
import { useSession } from '@/lib/session'
import { Panel, Pill, styles as s } from '@/components/visual/kit'
import c from './requests.module.css'
import {
  ACT_LABEL, GROUP_ORDER, GROUP_WORD, ago, confirmText, firstGroup, kindWord, posterPath, reconnectLabel, rowsIn, staleWords,
  type Act, type ActResult, type Group, type Health, type HealthProblem, type Listing, type RequestRow, type StaleServer,
} from './requests-view'

export function ConfirmBox({ text, yes, busy, onYes, onNo, reason }: {
  text: string; yes: string; busy?: boolean; onYes: () => void; onNo: () => void
  reason?: { value: string; onChange: (v: string) => void }
}) {
  return (
    <div className={c.confirm} role="alertdialog" aria-label="Confirm">
      <p>{text}</p>
      {reason && <input type="text" maxLength={200} value={reason.value} onChange={e => reason.onChange(e.target.value)} aria-label="Reason (optional)" placeholder="Reason (optional)" />}
      <div className={c.row}>
        <button type="button" className={c.primary} disabled={busy} onClick={onYes}>{busy ? 'Working…' : yes}</button>
        <button type="button" className={c.ghost} disabled={busy} onClick={onNo}>Cancel</button>
      </div>
    </div>
  )
}

/** One request, as a card. */
export function RequestCard({ r, canAct, onAct, now }: { r: RequestRow; canAct: boolean; onAct: (a: Act, title: string) => void; now?: number }) {
  const poster = posterPath(r)
  const [broken, setBroken] = useState(false)
  return (
    <li className={c.card} data-group={r.group} data-kind={r.kind}>
      <div className={c.poster} aria-hidden>
        <span>{r.title}</span>
        {poster && !broken && <img src={poster} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />}
      </div>
      <div className={c.body}>
        <h3 className={c.title}>{r.title}{r.year ? <small>{r.year}</small> : null}</h3>
        <div className={c.row}>
          <Pill tone={r.group === 'failed' ? 'warn' : r.group === 'available' ? 'good' : r.group === 'downloading' || r.group === 'pending' ? 'accent' : undefined}>{GROUP_WORD[r.group]}</Pill>
          <Pill>{kindWord(r)}</Pill>
          {r.is4k && <Pill>4K</Pill>}
          {r.sortedInto && <Pill tone="good">Sorted into {r.sortedInto}</Pill>}
        </div>
        <p className={c.where}>{r.where}{r.reason ? ` Reason: ${r.reason}` : ''}</p>
        {r.progress !== null && <div className={c.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r.progress * 100)}><i style={{ width: `${Math.round(r.progress * 100)}%` }} /></div>}
        <span className={c.meta}>{[`Asked by ${r.who}`, ago(r.at, now)].filter(Boolean).join(' · ')}</span>
        {canAct && (r.group === 'pending' || r.group === 'failed') && (
          <div className={c.row}>
            {r.group === 'pending' && <button type="button" className={c.primary} onClick={() => onAct({ action: 'approve', id: r.id }, r.title)}>Approve</button>}
            {r.group === 'pending' && <button type="button" className={c.ghost} onClick={() => onAct({ action: 'decline', id: r.id }, r.title)}>Decline</button>}
            {r.group === 'failed' && <button type="button" className={c.primary} onClick={() => onAct({ action: 'retry', id: r.id }, r.title)}>Try again</button>}
          </div>
        )}
      </div>
    </li>
  )
}

/** What is wrong with Seerr itself, each with its fix for an admin. */
export function HealthView({ h, canAct, onAct }: { h: Health; canAct: boolean; onAct: (a: Act, title: string) => void }) {
  const stale: StaleServer[] = h.stale
  if (!h.problems.length && !stale.length) return <p className={c.allwell} role="status"><Pill tone="good">All well</Pill> Seerr can reach Radarr, Sonarr and your media server.</p>
  return (
    <ul className={c.health} aria-label="Problems with Seerr">
      {h.problems.map((p: HealthProblem, i) => (
        <li key={`${p.kind}-${p.serverId ?? i}`} className={c.problem} data-problem={p.kind}>
          <p>{p.text}</p>
          {canAct && <div className={c.row}><button type="button" className={c.primary} onClick={() => onAct({ action: 'reconnect', target: p.kind }, '')}>{reconnectLabel(p.kind)}</button></div>}
        </li>
      ))}
      {stale.length > 0 && (
        <li className={c.problem} data-problem="stale">
          {stale.map(x => <p key={`${x.app}-${x.serverId}`}>{staleWords(x)}</p>)}
          {canAct && <div className={c.row}><button type="button" className={c.primary} onClick={() => onAct({ action: 'fix-settings' }, '')}>{ACT_LABEL['fix-settings']}</button></div>}
        </li>
      )}
    </ul>
  )
}

/** The group buttons and the cards under them (rendered in tests). */
export function RequestsView({ l, group, onGroup, canAct, onAct, now }: {
  l: Listing; group: Group | 'all'; onGroup: (g: Group | 'all') => void; canAct: boolean; onAct: (a: Act, title: string) => void; now?: number
}) {
  const shown = rowsIn(l.rows, group)
  return (
    <>
      <div className={c.tabs} role="group" aria-label="Show requests">
        <button type="button" className={c.tab} aria-pressed={group === 'all'} onClick={() => onGroup('all')}>All <b>{l.rows.length}</b></button>
        {GROUP_ORDER.filter(g => l.counts[g] > 0 || g === group).map(g => (
          <button key={g} type="button" className={c.tab} data-group={g} aria-pressed={group === g} onClick={() => onGroup(g)}>{GROUP_WORD[g]} <b>{l.counts[g]}</b></button>
        ))}
      </div>
      {shown.length === 0
        ? <p className={s.empty}>{l.rows.length === 0 ? 'Nobody has asked for anything yet.' : 'Nothing here right now.'}</p>
        : <ul className={c.list}>{shown.map(r => <RequestCard key={r.id} r={r} canAct={canAct} onAct={onAct} now={now} />)}</ul>}
      {l.capped && <p className={c.note}>Showing the newest {l.rows.length}. Older ones are in Seerr.</p>}
    </>
  )
}

export function ArrRequests() {
  const { role } = useSession()
  const canAct = atLeast(role, 'admin')
  const [l, setL] = useState<Listing | null>(null)
  const [h, setH] = useState<Health | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [group, setGroup] = useState<Group | 'all'>('all')
  const [picked, setPicked] = useState(false)
  const [pending, setPending] = useState<{ act: Act; title: string } | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ActResult | null>(null)

  const load = useCallback(async () => {
    const r = await apiJson<{ data: Listing }>('/api/plugins/arrstack/requests')
    if (!r.ok || !r.body?.data) { setErr(r.error ?? 'Seerr\'s requests could not be read.'); return }
    setErr(null); setL(r.body.data)
    if (!picked) { setGroup(firstGroup(r.body.data.counts)); setPicked(true) }
  }, [picked])
  const loadHealth = useCallback(async () => {
    const r = await apiJson<{ data: Health }>('/api/plugins/arrstack/requests/health')
    if (r.ok && r.body?.data) setH(r.body.data)
  }, [])
  useEffect(() => {
    void load(); void loadHealth()
    const t = setInterval(() => { if (!document.hidden) void load() }, 15_000)
    const t2 = setInterval(() => { if (!document.hidden) void loadHealth() }, 90_000)
    return () => { clearInterval(t); clearInterval(t2) }
  }, [load, loadHealth])

  const ask = (act: Act, title: string) => { setResult(null); setReason(''); setPending({ act, title }) }
  const run = async () => {
    if (!pending) return
    const body = pending.act.action === 'decline' && reason.trim() ? { ...pending.act, reason: reason.trim() } : pending.act
    setBusy(true)
    const r = await apiJson<{ data: ActResult }>('/api/plugins/arrstack/requests/actions', 'POST', body, IN_PAGE)
    setBusy(false); setPending(null)
    if (!r.ok || !r.body?.data) { setErr(r.error ?? 'That did not work.'); return }
    setErr(null); setResult(r.body.data)
    void load(); void loadHealth()
  }

  if (!l && !err) return null
  if (l && !l.configured) {
    return (
      <Panel title="Requests" sub="SEERR (FORMERLY JELLYSEERR AND OVERSEERR)">
        <p className={c.note}>Seerr is not connected here yet. Add its address and API key in the Arr Stack settings and the requests appear on this tab.</p>
      </Panel>
    )
  }
  return (
    <Panel title="Requests" sub="SEERR (FORMERLY JELLYSEERR AND OVERSEERR)">
      {err && <p className={c.bad} role="alert">{err}</p>}
      {result && (
        <div className={c.result} data-done={result.done} role="status">
          <p>{result.summary}</p>{result.notes.map(n => <p key={n} className={c.note}>{n}</p>)}
        </div>
      )}
      {pending && (
        <ConfirmBox text={confirmText(pending.act, pending.title)} yes={pending.act.action === 'reconnect' ? 'Reconnect' : ACT_LABEL[pending.act.action]} busy={busy}
          onYes={() => void run()} onNo={() => setPending(null)}
          reason={pending.act.action === 'decline' ? { value: reason, onChange: setReason } : undefined} />
      )}
      {h && <HealthView h={h} canAct={canAct && !pending} onAct={ask} />}
      {l && <RequestsView l={l} group={group} onGroup={setGroup} canAct={canAct && !pending} onAct={ask} />}
    </Panel>
  )
}
