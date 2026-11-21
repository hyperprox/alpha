'use client'

// =============================================================================
//  HyperProx — Arr Stack, Requests
//
//  What people have asked Seerr (formerly Jellyseerr and Overseerr) for, as cards with a poster: waiting, approved,
//  downloading, available, failed and declined, and where each one is now ("sorted into" the folder the folder sorter
//  chose, when it did). Who asked is for admins; everyone else sees "a family member". An admin gets Approve, Decline
//  and Try again for a failed one. Above the cards, anything wrong with Seerr itself
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
  ACT_LABEL, FIELDS, FIELD_WORD, GROUP_ORDER, GROUP_WORD, ago, confirmText, firstGroup, fixSentence, fixTarget, kindWord, needsChoice, posterPath, reconnectLabel, rowsIn,
  type Act, type ActResult, type FixChoice, type FixField, type Group, type Health, type HealthProblem, type Listing, type Prof, type RequestRow, type StaleField, type StaleServer,
} from './requests-view'

export function ConfirmBox({ text, yes, busy, onYes, onNo }: { text: string; yes: string; busy?: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <div className={c.confirm} role="alertdialog" aria-label="Confirm">
      <p>{text}</p>
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
        <p className={c.where}>{r.where}</p>
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

/** One stale field: what Seerr points at now, and either what it would use or a menu where nothing has the same name. */
function StaleLine({ s, field, choices, onChoice }: { s: StaleServer; field: FixField; choices: FixChoice[]; onChoice: (c: FixChoice) => void }) {
  const f = s[field] as StaleField<Prof | string> | undefined
  if (!f) return null
  const to = fixTarget(s, field, choices)
  const picked = choices.find(x => x.app === s.app && x.serverId === s.serverId && x.field === field)?.value ?? ''
  return (
    <p>
      Seerr&apos;s {s.name} points at the {FIELD_WORD[field]} &quot;{f.now}&quot;, which {s.app === 'radarr' ? 'Radarr' : 'Sonarr'} no longer has.{' '}
      {f.want !== null ? <>It would use &quot;{to}&quot;.</> : (
        <label>Nothing has the same name. Pick the one to use:{' '}
          <select value={picked} aria-label={`New ${FIELD_WORD[field]} for ${s.name}`} onChange={e => e.target.value && onChoice({ app: s.app, serverId: s.serverId, field, value: e.target.value })}>
            <option value="">Choose…</option>
            {(f.options as Array<Prof | string>).map(o => typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.id} value={String(o.id)}>{o.name}</option>)}
          </select>
        </label>
      )}
    </p>
  )
}

/** What is wrong with Seerr itself, each with its fix for an admin. */
export function HealthView({ h, canAct, onAct, choices = [], onChoice = () => {} }: {
  h: Health; canAct: boolean; onAct: (a: Act, title: string) => void; choices?: FixChoice[]; onChoice?: (c: FixChoice) => void
}) {
  const stale: StaleServer[] = h.stale
  if (!h.problems.length && !stale.length) return <p className={c.allwell} role="status"><Pill tone="good">All well</Pill> Seerr can reach Radarr, Sonarr and your media server.</p>
  const open = needsChoice(stale, choices)
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
          {stale.map(x => FIELDS.map(f => <StaleLine key={`${x.app}-${x.serverId}-${f}`} s={x} field={f} choices={choices} onChoice={onChoice} />))}
          <p>Requests sent there fail.</p>
          {canAct && <div className={c.row}><button type="button" className={c.primary} disabled={open} onClick={() => onAct({ action: 'fix-settings', baseId: h.staleId, choices }, '')}>{ACT_LABEL['fix-settings']}</button></div>}
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
  const [choices, setChoices] = useState<FixChoice[]>([])
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

  const ask = (act: Act, title: string) => { setResult(null); setPending({ act, title }) }
  const choose = (ch: FixChoice) => setChoices(cs => [...cs.filter(x => !(x.app === ch.app && x.serverId === ch.serverId && x.field === ch.field)), ch])
  const run = async () => {
    if (!pending) return
    setBusy(true)
    const r = await apiJson<{ data: ActResult }>('/api/plugins/arrstack/requests/actions', 'POST', pending.act, IN_PAGE)
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
        <ConfirmBox text={pending.act.action === 'fix-settings' && h ? fixSentence(h.stale, pending.act.choices) : confirmText(pending.act, pending.title)} yes={pending.act.action === 'reconnect' ? 'Reconnect' : ACT_LABEL[pending.act.action]} busy={busy}
          onYes={() => void run()} onNo={() => setPending(null)} />
      )}
      {h && <HealthView h={h} canAct={canAct && !pending} onAct={ask} choices={choices} onChoice={choose} />}
      {l && <RequestsView l={l} group={group} onGroup={setGroup} canAct={canAct && !pending} onAct={ask} />}
    </Panel>
  )
}
