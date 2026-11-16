'use client'

// =============================================================================
//  HyperProx — HAProxy: each load balancer, visual first
//
//  Phone first: one column. The HUD on top (servers up as a ring, the counts),
//  then the problems with their fix buttons (a backend with no healthy server
//  is a pulsing red alarm), then the traffic map: each public frontend, a lit
//  trunk to each backend it routes to, each backend's servers as glowing pods
//  that say their state in words, with sessions and weight as bars, request
//  rate, response time and the health check's last word. Tap a pod for its
//  actions; tap a backend's "Manage" for its balance algorithm and adding a
//  server. Every change is marked "runtime only" or "saved"; destructive ones
//  ask first. Admins only (the API refuses everyone else).
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { BusyNote, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { HudHeader, Panel, Icon, styles as vs, type StatChip } from '@/components/visual/kit'
import { PluginSwitcher } from '@/components/plugins/visual/plugin-kit'
import { AutoConnectPanel } from '@/components/plugins/AutoConnect'
import { Sheet } from '@/components/plugins/home-assistant/HomeVisual'
import {
  STATE, SEVERITY_WORD, busiest, confirmText, layout, lbProblems, ms, serverActions, share, since, summary,
  type BackendView, type Instance, type LbForm, type PickGuest, type Problem, type Reading, type ServerView,
} from './logic'
import h from './haproxy.module.css'

const API = '/api/plugins/haproxy'

type Note = { text: string; ok: boolean; scope?: 'runtime' | 'saved' | 'none' }

// ── pure parts (rendered in tests) ───────────────────────────────────────────

/** Problems, worst first, each with its own fix buttons; none says so plainly. */
export function ProblemList({ problems, busy, onFix }: { problems: Problem[]; busy: string | null; onFix: (p: Problem, fix: Problem['fixes'][number]) => void }) {
  if (!problems.length) return <p className={h.none}><Icon name="check" size={14} /> No problems: every backend has a healthy server and the configuration passes haproxy -c.</p>
  return (
    <ul className={h.problems}>
      {problems.map(p => (
        <li key={p.id} className={h.problem} data-severity={p.severity} aria-label={p.severity === 'critical' ? 'Outage' : 'Problem'} role={p.severity === 'critical' ? 'alert' : undefined}>
          <h3><span>{SEVERITY_WORD[p.severity]}</span>{p.title}</h3>
          <p>{p.detail}</p>
          <div className={h.fixes}>
            {p.fixes.map(f => (
              <button key={f.id} type="button" className={`${vs.btn} ${f.id === 'drain' ? '' : vs.btnPri}`} disabled={busy === `${p.id}:${f.id}`} onClick={() => onFix(p, f)}>
                {busy === `${p.id}:${f.id}` ? 'Working…' : f.label}
              </button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  )
}

function Meter({ label, value, frac, text }: { label: string; value: number; frac: number; text: string }) {
  return (
    <div className={h.meter} role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0}>
      <span>{label}</span><i><span style={{ width: `${Math.round(frac * 100)}%` }} /></i><em>{text}</em>
    </div>
  )
}

/** One server as a pod: state in words and glow, sessions and weight as bars, rate, response time, the check's last word. */
export function ServerPod({ s, max, onOpen }: { s: ServerView; max: { sessions: number; weight: number }; onOpen?: (s: ServerView) => void }) {
  const st = STATE[s.state]
  return (
    <button type="button" className={h.pod} data-tone={st.tone} onClick={() => onOpen?.(s)} aria-label={`${s.name}: ${st.word}. Open its actions`}>
      <div className={h.podTop}><b>{s.name}</b><span className={h.state}>{st.word}</span></div>
      <span className={h.addr}>{s.address || '—'}</span>
      <Meter label="sessions" value={s.sessions} frac={share(s.sessions, max.sessions)} text={String(s.sessions)} />
      <Meter label="weight" value={s.weight} frac={share(s.weight, Math.max(256, max.weight))} text={String(s.weight)} />
      <span className={h.addr}>{s.rate}/s · {ms(s.responseMs)} · {s.errors + s.http5xx} err{s.queue ? ` · ${s.queue} queued` : ''}</span>
      <span className={h.check} data-ok={s.check.enabled ? String(s.state !== 'down') : undefined}>
        {s.check.enabled ? `Check: ${s.check.words}` : s.check.configured ? 'Check off' : 'No health check'}{s.lastChangeS !== null ? ` · changed ${since(s.lastChangeS)} ago` : ''}
      </span>
      {s.dynamic && <span className={h.tag}>runtime only · not in the configuration</span>}
    </button>
  )
}

export function BackendCard({ b, max, onServer, onManage }: { b: BackendView; max: { sessions: number; weight: number }; onServer?: (b: BackendView, s: ServerView) => void; onManage?: (b: BackendView) => void }) {
  const health = !b.servers.length || b.healthy === 0 ? 'none' : b.healthy < b.servers.length ? 'part' : 'all'
  return (
    <section className={h.backend} data-health={health} aria-label={`Backend ${b.name}`}>
      <div className={h.beHead}>
        <h4>{b.name}</h4>
        {b.algorithm && <span className={h.algo} title="How it spreads visitors">{b.algorithm}</span>}
        <span className={h.health}>{b.healthy}/{b.servers.length} healthy · {b.sessions} sessions · {b.rate}/s · {ms(b.responseMs)}</span>
        {onManage && <button type="button" className={vs.btn} onClick={() => onManage(b)}>Manage</button>}
      </div>
      {b.servers.length
        ? <div className={h.pods}>{b.servers.map(s => <ServerPod key={s.name} s={s} max={max} onOpen={x => onServer?.(b, x)} />)}</div>
        : <p className={h.empty}>No servers: every request sent here gets a 503.</p>}
    </section>
  )
}

/** Frontends → backends → servers. */
export function TrafficMap({ r, onServer, onManage }: { r: Reading; onServer?: (b: BackendView, s: ServerView) => void; onManage?: (b: BackendView) => void }) {
  const { lanes, unrouted } = layout(r)
  const max = busiest(r)
  return (
    <div className="flex flex-col gap-6">
      {lanes.map(({ frontend: f, backends }) => (
        <div key={f.name} className={h.lane}>
          <section className={h.feNode} aria-label={`Frontend ${f.name}`}>
            <span className={h.eyebrow}>Frontend · {f.status === 'OPEN' ? 'open' : f.status.toLowerCase()}</span>
            <h3>{f.name}</h3>
            <div className={h.nums}>
              <div><b>{f.sessions}</b><small>sessions</small></div>
              <div><b>{f.requestRate}/s</b><small>requests</small></div>
              <div><b>{f.errors + f.http5xx}</b><small>errors</small></div>
            </div>
            {f.binds.length > 0 && <div className={h.binds}>listens on {f.binds.join(', ')}</div>}
          </section>
          <div className={h.trunk}>
            {f.requestRate > 0 && <span className={h.flow} aria-hidden />}
            {backends.length ? backends.map(b => <BackendCard key={b.name} b={b} max={max} onServer={onServer} onManage={onManage} />)
              : <p className={h.empty}>No rules yet: HAProxy answers every visitor here with 503. Use “Load-balance an app”, or add a proxy host on the Proxy page.</p>}
          </div>
        </div>
      ))}
      {unrouted.length > 0 && (
        <div className="flex flex-col gap-3">
          <span className={h.eyebrow}>Backends no public frontend sends to</span>
          {unrouted.map(b => <BackendCard key={b.name} b={b} max={max} onServer={onServer} onManage={onManage} />)}
        </div>
      )}
    </div>
  )
}

export function hudChips(r: Reading): StatChip[] {
  const s = summary(r)
  return [
    { label: 'servers up', value: `${s.up}/${s.servers}`, tone: s.down ? 'crit' : 'good' },
    { label: 'down', value: s.down, tone: s.down ? 'crit' : undefined },
    { label: 'drain / maintenance', value: s.parked, tone: s.parked ? 'warn' : undefined },
    { label: 'backends', value: s.backends },
    { label: 'connections', value: r.currentConnections ?? '—' },
    { label: 'configuration', value: r.config.ok ? 'valid' : 'fails check', tone: r.config.ok ? 'good' : 'crit' },
  ]
}

// ── one HAProxy ──────────────────────────────────────────────────────────────

function LoadBalancer({ inst, algorithms, onRemoved }: { inst: Instance; algorithms: Record<string, string>; onRemoved: () => void }) {
  const [data, setData] = useState<{ ok: boolean; reading?: Reading; error?: string } | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [sel, setSel] = useState<{ b: BackendView; s: ServerView } | null>(null)
  const [manage, setManage] = useState<BackendView | null>(null)
  const [lb, setLb] = useState(false)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    const r = await apiJson<{ data: { ok: boolean; reading?: Reading; error?: string } }>(`${API}/instances/${inst.id}/reading`)
    inFlight.current = false
    setData(r.ok ? r.body!.data : { ok: false, error: r.error ?? 'Could not read HAProxy.' })
  }, [inst.id])

  // Live: every 10 seconds while the tab is visible (one socket read in the guest each time).
  useEffect(() => {
    void load()
    const t = setInterval(() => { if (!document.hidden) void load() }, 10_000)
    return () => clearInterval(t)
  }, [load])

  const act = async (action: string, body: Record<string, unknown>, key = action): Promise<boolean> => {
    setBusy(key); setNote(null)
    const r = await apiJson<{ data: { message: string; scope: Note['scope'] } }>(`${API}/instances/${inst.id}/actions/${action}`, 'POST', body)
    setBusy(null)
    setNote(r.ok ? { text: r.body!.data.message, ok: true, scope: r.body!.data.scope } : { text: r.error ?? 'That did not work.', ok: false })
    void load()
    return r.ok
  }

  const fix = (p: Problem, f: Problem['fixes'][number]) => {
    if (f.id === 'add-server') { const b = data?.reading?.backends.find(x => x.name === p.backend); if (b) setManage(b); return }
    if (f.confirm && !window.confirm(f.confirm)) return
    let server = p.server
    if (f.id === 'ready' && !server) server = data?.reading?.backends.find(x => x.name === p.backend)?.servers.find(s => s.state === 'maint' || s.state === 'drain')?.name
    void act(f.id, { backend: p.backend, ...(server ? { server } : {}) }, `${p.id}:${f.id}`)
  }

  const disconnect = async () => {
    if (!window.confirm(`Disconnect ${inst.name} from HyperProx? HAProxy itself keeps running untouched, and HyperProx will not connect it again by itself.`)) return
    const r = await apiJson(`${API}/instances/${inst.id}`, 'DELETE')
    if (r.ok) onRemoved(); else setNote({ text: r.error ?? 'Could not disconnect.', ok: false })
  }

  const r = data?.reading
  const s = r ? summary(r) : null
  return (
    <div className={vs.page}>
      {!data && <BusyNote>Reading {inst.name}…</BusyNote>}
      {data && !data.ok && <Notice kind="error">{data.error} The page tries again every 10 seconds.</Notice>}
      {r && s && (
        <>
          <HudHeader level={2} label={`${inst.name} overview`} eyebrow={`HAProxy ${r.version ?? ''} · ${inst.guest.kind === 'lxc' ? 'CT' : 'VM'} ${inst.guest.vmid}`} title={inst.name}
            ring={{ value: s.servers ? s.up / s.servers : 0, text: s.servers ? `${s.up}/${s.servers}` : '—', label: 'servers up' }}
            chips={hudChips(r)}
            actions={
              <div className={h.toolbar}>
                <button type="button" className={vs.btn} onClick={() => void load()}><Icon name="check" size={14} /> Refresh</button>
                {inst.saves && <button type="button" className={`${vs.btn} ${vs.btnPri}`} onClick={() => setLb(true)}>Load-balance an app</button>}
                <button type="button" className={vs.btn} onClick={() => void disconnect()}>Disconnect</button>
                <small>live · every 10 s</small>
              </div>
            } />
          {!inst.saves && <Notice kind="info">This HAProxy has no Data Plane API connected, so changes made here are runtime only: they last until it restarts. A HAProxy installed from the Catalogue can save changes too.</Notice>}
          {note && <p className="text-sm" role="status" style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }}>
            {note.scope && note.scope !== 'none' && <span className={h.scope} data-scope={note.scope}>{note.scope === 'runtime' ? 'Runtime only · ' : 'Saved · '}</span>}{note.text}</p>}
          <Panel title="Problems" sub={r.problems.length ? `${r.problems.length}` : undefined}>
            <ProblemList problems={r.problems} busy={busy} onFix={fix} />
          </Panel>
          <Panel title="Traffic" sub="frontends → backends → servers · tap a server for its actions">
            <TrafficMap r={r} onServer={(b, x) => setSel({ b, s: x })} onManage={b => setManage(b)} />
          </Panel>
        </>
      )}
      {sel && <ServerSheet b={sel.b} s={sel.s} saves={inst.saves} busy={busy} onClose={() => setSel(null)} act={act} />}
      {manage && <BackendSheet b={manage} saves={inst.saves} algorithms={algorithms} busy={busy} onClose={() => setManage(null)} act={act} />}
      {lb && <LoadBalanceModal inst={inst} algorithms={algorithms} onClose={() => setLb(false)} onDone={(m, ok = true) => { setLb(false); setNote({ text: m, ok, scope: 'saved' }); void load() }} />}
    </div>
  )
}

function Persist({ saves, value, onChange, what }: { saves: boolean; value: boolean; onChange: (v: boolean) => void; what: string }) {
  if (!saves) return <small style={{ color: 'var(--text-dim)' }}>Runtime only: lasts until HAProxy restarts.</small>
  return (
    <label className={h.persist}>
      <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />
      <span>Save {what} to the configuration (checked with haproxy -c, then HAProxy reloads). Unticked: runtime only, until HAProxy restarts.</span>
    </label>
  )
}

function ServerSheet({ b, s, saves, busy, onClose, act }: { b: BackendView; s: ServerView; saves: boolean; busy: string | null; onClose: () => void; act: (a: string, body: Record<string, unknown>, key?: string) => Promise<boolean> }) {
  const [weight, setWeight] = useState(String(s.weight))
  const [persist, setPersist] = useState(false)
  const base = { backend: b.name, server: s.name }
  const run = async (action: string, body: Record<string, unknown>, confirmId?: string) => {
    const c = confirmId ? confirmText(confirmId, b.name, s.name, persist) : null
    if (c && !window.confirm(c)) return
    if (await act(action, { ...base, ...body, persist }, action)) onClose()
  }
  return (
    <Sheet title={s.name} sub={`${STATE[s.state].word} · in ${b.name}`} onClose={onClose}>
      <dl className={h.dl}>
        <dt>Address</dt><dd className="font-mono">{s.address || '—'}</dd>
        <dt>State</dt><dd>{STATE[s.state].word} ({s.status}){s.lastChangeS !== null ? `, for ${since(s.lastChangeS)}` : ''}</dd>
        <dt>Check</dt><dd>{s.check.enabled ? s.check.words : s.check.configured ? 'off' : 'none configured'}{s.check.durationMs !== null ? ` · ${s.check.durationMs} ms` : ''}{s.check.failures ? ` · ${s.check.failures} failed so far` : ''}</dd>
        <dt>Sessions</dt><dd>{s.sessions} now · {s.sessionsMax} peak · {s.total} total</dd>
        <dt>Response</dt><dd>{ms(s.responseMs)} average</dd>
        <dt>Errors</dt><dd>{s.errors} connection/response · {s.http5xx} 5xx</dd>
        <dt>Downtime</dt><dd>{since(s.downtimeS)}</dd>
      </dl>
      <div className={h.group}><span>State</span>
        <div className={h.row}>
          {serverActions(s).filter(a => !(persist && a.id === 'drain')).map(a => (
            <button key={a.id} type="button" className={`${vs.btn} ${a.destructive ? '' : vs.btnPri}`} disabled={busy !== null}
              onClick={() => void run('state', { state: a.id }, a.destructive ? a.id : undefined)}>{a.label}</button>
          ))}
        </div>
        {persist && <small style={{ color: 'var(--text-dim)' }}>Drain is runtime only: HAProxy has no saved drain state.</small>}
      </div>
      <div className={h.group}><span>Weight (0–256: its share of new visitors)</span>
        <div className={h.row}>
          <input type="range" min={0} max={256} value={Number(weight) || 0} onChange={e => setWeight(e.target.value)} aria-label="Weight" style={{ flex: 1, minWidth: 140 }} />
          <input style={{ ...INPUT, width: 84 }} inputMode="numeric" value={weight} onChange={e => setWeight(e.target.value.replace(/[^0-9]/g, ''))} aria-label="Weight value" />
          <button type="button" className={`${vs.btn} ${vs.btnPri}`} disabled={busy !== null || weight === String(s.weight)} onClick={() => void run('weight', { weight: Number(weight) })}>Set weight</button>
        </div>
      </div>
      <div className={h.group}><span>Health check</span>
        <div className={h.row}>
          {s.check.enabled
            ? <><button type="button" className={vs.btn} disabled={busy !== null} onClick={() => void run('health', { on: false }, 'health-off')}>Turn the check off</button>
                <button type="button" className={`${vs.btn} ${vs.btnPri}`} disabled={busy !== null} onClick={() => void act('retry', base).then(ok => ok && onClose())}>Check again now</button></>
            : <button type="button" className={`${vs.btn} ${vs.btnPri}`} disabled={busy !== null} onClick={() => void run('health', { on: true })}>Turn the check on</button>}
        </div>
      </div>
      <div className={h.group}><span>Remove</span>
        <div className={h.row}><button type="button" className={vs.btn} style={{ color: 'var(--crit)' }} disabled={busy !== null} onClick={() => void run('remove-server', {}, 'remove-server')}>Remove {s.name} from {b.name}</button></div>
      </div>
      <div className={h.group}><Persist saves={saves} value={persist} onChange={setPersist} what="these changes" /></div>
      <div className={vs.sheetRow}><button type="button" className={vs.btn} onClick={onClose}>Close</button></div>
    </Sheet>
  )
}

function useGuests() {
  const [guests, setGuests] = useState<PickGuest[] | null>(null)
  useEffect(() => { void apiJson<{ data: PickGuest[] }>(`${API}/guests`).then(r => setGuests(r.ok ? r.body!.data : [])) }, [])
  return guests
}

function BackendSheet({ b, saves, algorithms, busy, onClose, act }: { b: BackendView; saves: boolean; algorithms: Record<string, string>; busy: string | null; onClose: () => void; act: (a: string, body: Record<string, unknown>, key?: string) => Promise<boolean> }) {
  const guests = useGuests()
  const [algo, setAlgo] = useState(b.algorithm ?? 'roundrobin')
  const [mode, setMode] = useState<'guest' | 'address'>('guest')
  const [f, setF] = useState({ guest: '', address: '', port: '', name: '', weight: '100' })
  const [persist, setPersist] = useState(saves)
  const add = async () => {
    const g = guests?.find(x => `${x.kind}-${x.vmid}` === f.guest)
    const body: Record<string, unknown> = { backend: b.name, port: Number(f.port), weight: Number(f.weight || 100), persist, ...(f.name ? { name: f.name } : {}) }
    if (mode === 'guest') { if (!g) return; body.guest = { kind: g.kind, vmid: g.vmid } } else body.address = f.address
    if (await act('add-server', body)) onClose()
  }
  return (
    <Sheet title={`Manage ${b.name}`} sub={`${b.servers.length} server${b.servers.length === 1 ? '' : 's'}`} onClose={onClose}>
      <div className={h.group}><span>How it spreads visitors</span>
        {saves ? (<>
          <select style={INPUT} value={algo} onChange={e => setAlgo(e.target.value)} aria-label="Balance algorithm">
            {Object.keys(algorithms).map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <small style={{ color: 'var(--text-soft)' }}>{algorithms[algo]}</small>
          <div className={h.row}><button type="button" className={`${vs.btn} ${vs.btnPri}`} disabled={busy !== null || algo === b.algorithm}
            onClick={() => { const c = confirmText('balance', b.name, null, true); if (c && window.confirm(c)) void act('balance', { backend: b.name, algorithm: algo }).then(ok => ok && onClose()) }}>Use {algo} (saved)</button></div>
        </>) : <small style={{ color: 'var(--text-dim)' }}>Currently {b.algorithm ?? 'unknown'}. Changing it needs the Data Plane API (a Catalogue install has it): HAProxy cannot change it at runtime.</small>}
      </div>
      <div className={h.group}><span>Add a server</span>
        <div className={h.row} role="radiogroup" aria-label="Where the server is">
          <label className={h.persist}><input type="radio" checked={mode === 'guest'} onChange={() => setMode('guest')} /> A guest on the cluster</label>
          <label className={h.persist}><input type="radio" checked={mode === 'address'} onChange={() => setMode('address')} /> An address</label>
        </div>
        {mode === 'guest'
          ? <label><span style={LABEL}>Guest</span>
              <select style={INPUT} value={f.guest} onChange={e => setF(x => ({ ...x, guest: e.target.value }))}>
                <option value="">{guests === null ? 'Reading the cluster…' : 'Pick a guest'}</option>
                {(guests ?? []).map(g => <option key={`${g.kind}-${g.vmid}`} value={`${g.kind}-${g.vmid}`}>{g.name} ({g.vmid}) · {g.address}</option>)}
              </select></label>
          : <label><span style={LABEL}>Address</span><input style={INPUT} value={f.address} onChange={e => setF(x => ({ ...x, address: e.target.value.trim() }))} placeholder="10.0.0.21" /></label>}
        <div className={h.row}>
          <label style={{ flex: 1 }}><span style={LABEL}>Port</span><input style={INPUT} inputMode="numeric" value={f.port} onChange={e => setF(x => ({ ...x, port: e.target.value.replace(/[^0-9]/g, '') }))} placeholder="8080" /></label>
          <label style={{ flex: 1 }}><span style={LABEL}>Weight</span><input style={INPUT} inputMode="numeric" value={f.weight} onChange={e => setF(x => ({ ...x, weight: e.target.value.replace(/[^0-9]/g, '') }))} /></label>
        </div>
        <label><span style={LABEL}>Name (optional: made from the guest)</span><input style={INPUT} value={f.name} onChange={e => setF(x => ({ ...x, name: e.target.value.trim() }))} placeholder="app-2" /></label>
        <Persist saves={saves} value={persist} onChange={setPersist} what="the new server" />
        <div className={h.row}><button type="button" className={`${vs.btn} ${vs.btnPri}`} disabled={busy !== null || !f.port || (mode === 'guest' ? !f.guest : !f.address)} onClick={() => void add()}>Add to {b.name}</button></div>
      </div>
      <div className={vs.sheetRow}><button type="button" className={vs.btn} onClick={onClose}>Close</button></div>
    </Sheet>
  )
}

/** Pick 2+ guests running the same app → one backend with health checks, a frontend rule, optionally a public name. */
export function LoadBalanceForm({ f, set, guests, zones, proxies, algorithms }: {
  f: LbForm; set: (patch: Partial<LbForm>) => void; guests: PickGuest[] | null; zones: string[]; proxies: Array<{ id: string; name: string }>; algorithms: Record<string, string>
}) {
  const toggle = (k: string) => set({ guests: f.guests.includes(k) ? f.guests.filter(x => x !== k) : [...f.guests, k] })
  return (
    <div className="flex flex-col gap-3">
      <label><span style={LABEL}>App name</span><input style={INPUT} value={f.name} onChange={e => set({ name: e.target.value })} placeholder="shop" /></label>
      <fieldset className="flex flex-col gap-2"><legend style={LABEL}>Guests running it (pick two or more)</legend>
        {guests === null ? <BusyNote>Reading the cluster…</BusyNote> : (
          <div className={h.guests}>
            {guests.map(g => { const k = `${g.kind}-${g.vmid}`; return (
              <label key={k} className={h.guest}><input type="checkbox" checked={f.guests.includes(k)} onChange={() => toggle(k)} />
                <span>{g.name}<small>{g.vmid} · {g.address}</small></span></label>
            ) })}
          </div>
        )}
      </fieldset>
      <div className={h.row}>
        <label style={{ flex: 1 }}><span style={LABEL}>Port the app answers on</span><input style={INPUT} inputMode="numeric" value={f.port} onChange={e => set({ port: e.target.value.replace(/[^0-9]/g, '') })} placeholder="8080" /></label>
        <label style={{ flex: 1 }}><span style={LABEL}>Health check page</span><input style={INPUT} value={f.checkPath} onChange={e => set({ checkPath: e.target.value.trim() })} /></label>
      </div>
      <label><span style={LABEL}>How to spread visitors</span>
        <select style={INPUT} value={f.algorithm} onChange={e => set({ algorithm: e.target.value })}>{Object.keys(algorithms).map(a => <option key={a} value={a}>{a}</option>)}</select>
        <small style={{ color: 'var(--text-dim)' }}>{algorithms[f.algorithm]}</small></label>
      <label><span style={LABEL}>Host name (optional)</span><input style={INPUT} value={f.hostname} onChange={e => set({ hostname: e.target.value.trim().toLowerCase() })} placeholder="shop.example.com" />
        <small style={{ color: 'var(--text-dim)' }}>Blank: HAProxy sends it every visitor no other rule matches.</small></label>
      {f.hostname && (
        <label className={h.persist}><input type="checkbox" checked={f.publish} onChange={e => set({ publish: e.target.checked })} />
          <span>Also publish it: a DNS record, a proxy host and a certificate, pointed at this HAProxy.</span></label>
      )}
      {f.publish && (
        <div className={h.row}>
          <label style={{ flex: 1 }}><span style={LABEL}>Domain</span>
            <select style={INPUT} value={f.zone} onChange={e => set({ zone: e.target.value })}><option value="">Pick a domain</option>{zones.map(z => <option key={z} value={z}>{z}</option>)}</select></label>
          <label style={{ flex: 1 }}><span style={LABEL}>Public proxy</span>
            <select style={INPUT} value={f.proxyInstanceId} onChange={e => set({ proxyInstanceId: e.target.value })}><option value="">Pick a proxy</option>{proxies.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        </div>
      )}
    </div>
  )
}

function LoadBalanceModal({ inst, algorithms, onClose, onDone }: { inst: Instance; algorithms: Record<string, string>; onClose: () => void; onDone: (m: string, ok?: boolean) => void }) {
  const guests = useGuests()
  const [f, setF] = useState<LbForm>({ name: '', guests: [], port: '', hostname: '', algorithm: 'roundrobin', checkPath: '/', publish: false, zone: '', proxyInstanceId: '' })
  const [zones, setZones] = useState<string[]>([])
  const [proxies, setProxies] = useState<Array<{ id: string; name: string }>>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState<{ id: string; steps: Array<{ id: string; label: string; status: string; detail?: string }>; status: string; error?: string; cleanup?: string[] } | null>(null)
  useEffect(() => {
    if (!f.publish) return
    void apiJson<{ data: Array<{ domain: string }> }>('/api/dns/domains').then(r => setZones(r.ok ? (r.body!.data ?? []).map(d => d.domain) : []))
    void apiJson<{ data: Array<{ id: string; name: string; kind: string }> }>('/api/proxy/instances').then(r => setProxies(r.ok ? (r.body!.data ?? []).filter(p => p.id !== inst.proxyInstanceId) : []))
  }, [f.publish, inst.proxyInstanceId])
  useEffect(() => {
    if (!job || job.status !== 'running') return
    const t = setInterval(() => void apiJson<{ data: any }>(`${API}/publish-jobs/${job.id}`).then(r => r.ok && setJob(r.body!.data)), 3000)
    return () => clearInterval(t)
  }, [job])
  const problems = lbProblems(f)
  const go = async () => {
    if (!window.confirm(`Create the backend for ${f.name} across ${f.guests.length} guests${f.hostname ? ` for ${f.hostname}` : ''}? It is saved to HAProxy's configuration (checked with haproxy -c, then HAProxy reloads).`)) return
    setBusy(true); setErr(null)
    const body = { ...f, guests: f.guests.map(k => { const [kind, vmid] = k.split('-'); return { kind, vmid: Number(vmid) } }), port: Number(f.port), hostname: f.hostname || undefined }
    const r = await apiJson<{ data: { message: string; publishJob?: string; publishProblem?: string } }>(`${API}/instances/${inst.id}/load-balance`, 'POST', body)
    setBusy(false)
    if (!r.ok) { setErr(r.error ?? 'That did not work.'); return }
    if (r.body!.data.publishJob) setJob({ id: r.body!.data.publishJob, steps: [], status: 'running' })
    // Saved either way; a publish that could not start is said beside it, in the warning colour.
    else onDone(r.body!.data.message, !r.body!.data.publishProblem)
  }
  return (
    <Modal title="Load-balance an app" onClose={onClose}>
      {job ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm" style={{ color: 'var(--good)' }}>HAProxy is balancing it. Publishing the name:</p>
          <ul className="text-sm" style={{ color: 'var(--text-soft)' }}>{job.steps.map(s => <li key={s.id}>{s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'running' ? '…' : '·'} {s.label}{s.detail ? `: ${s.detail}` : ''}</li>)}</ul>
          {job.status === 'failed' && <Notice kind="error">{job.error}{job.cleanup?.length ? ` ${job.cleanup.join(' ')}` : ''} HAProxy keeps balancing the app on its own address.</Notice>}
          {job.status !== 'running' && <div className="flex justify-end"><PrimaryButton type="button" onClick={() => onDone(job.status === 'done' ? 'Balanced and published.' : 'Balanced; publishing the name did not finish (see above).')}>Close</PrimaryButton></div>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <LoadBalanceForm f={f} set={p => setF(x => ({ ...x, ...p }))} guests={guests} zones={zones} proxies={proxies} algorithms={algorithms} />
          {problems.length > 0 && f.name && <small style={{ color: 'var(--warn-2)' }}>{problems[0]}</small>}
          {err && <Notice kind="error">{err}</Notice>}
          <div className="flex justify-end gap-2">
            <GhostButton type="button" onClick={onClose}>Cancel</GhostButton>
            <PrimaryButton type="button" disabled={busy || problems.length > 0} onClick={() => void go()}>{busy ? 'Working…' : 'Balance it'}</PrimaryButton>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ── the plug-in page ─────────────────────────────────────────────────────────

export function HaproxyPage() {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [list, setList] = useState<Instance[] | null>(null)
  const [algorithms, setAlgorithms] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const reload = useCallback(async () => {
    const r = await apiJson<{ data: { instances: Instance[]; algorithms: Record<string, string> } }>(`${API}/instances`)
    if (r.ok) { setList(r.body!.data.instances ?? []); setAlgorithms(r.body!.data.algorithms ?? {}); setError(null) } else setError(r.error ?? 'Could not read the HAProxy list.')
  }, [])
  useEffect(() => { if (admin) void reload() }, [admin, reload])
  const inst = list?.find(i => i.id === sel) ?? list?.[0] ?? null

  return (
    <div className="min-h-full overflow-x-hidden" style={{ background: 'var(--ground)' }}>
      <div className="flex min-w-0 flex-col gap-4 py-4">
        <PluginSwitcher current="haproxy" />
        {!admin && <Notice kind="info">The HAProxy page is for admins: it shows every backend&apos;s addresses and changes live traffic.</Notice>}
        {admin && <AutoConnectPanel plugins={['haproxy']} onChanged={() => void reload()} />}
        {error && <Notice kind="error">{error}</Notice>}
        {admin && list && !list.length && (
          <Notice kind="info">No HAProxy connected yet. HyperProx connects one it finds by itself (the service scan, the Proxy page, or a Catalogue install). <Link href="/catalogue" style={{ textDecoration: 'underline' }}>Install HAProxy from the Catalogue</Link>.</Notice>
        )}
        {list && list.length > 1 && (
          <div className={h.picker} role="group" aria-label="Load balancers">
            {list.map(i => <button key={i.id} type="button" aria-pressed={i.id === inst?.id} onClick={() => setSel(i.id)}>{i.name}</button>)}
          </div>
        )}
        {inst && <LoadBalancer key={inst.id} inst={inst} algorithms={algorithms} onRemoved={() => { setSel(null); void reload() }} />}
      </div>
    </div>
  )
}
