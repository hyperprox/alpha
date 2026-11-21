'use client'

// =============================================================================
//  HyperProx — MikroTik router manager: fixed addresses, port forwards, device blocks, change history
//
//  Every button here asks the API for a PLAN first (what exactly would change, in words), shows it with its warnings,
//  and only then asks for the change; the API answers with the confirmation (the shared dialog, lib/confirm-bus.ts),
//  re-checks that the plan is still the same, saves the router's settings, arms the router's own undo and applies.
//  Nothing here writes to the router itself. Admin only; an API token is refused by the API.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { Icon, Panel, Pill, styles as s } from '@/components/visual/kit'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'

const BASE = '/api/plugins/mikrotik'

export interface Device { mac: string; address: string; name: string | null; fixed: boolean }
export interface Lease { id: string; address: string; mac: string; name: string; comment: string; words: string }
export interface Forward { id: string; name: string; words: string; disabled: boolean; mine: boolean; risky: string | null; proto: string; port: string; toAddress: string; toPort: string }
export interface Block { id: string; name: string; target: string; schedule: string | null; disabled: boolean; words: string }
export interface Change { id: string; at: string; by: string; title: string; steps: string[]; status: 'applied' | 'undone' | 'rolled-back' | 'failed'; canUndo: boolean; undoOf?: string; note?: string; backup?: { bytes: number; truncated: boolean } }
export interface Control {
  canWrite: boolean | null; wans: string[]; devices: Device[]; leases: Lease[]; forwards: Forward[]; blocks: Block[]
  hairpin: { present: boolean; note: string | null }; risky: Array<{ port: number; why: string }>; history: Change[]
}
export interface Plan { hash: string; title: string; steps: string[]; warnings: string[]; needsTick: string | null }
export interface Pending { action: string; params: Record<string, unknown>; plan: Plan }

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const nameOf = (d: Device) => d.name ?? d.address

/** The words on a history row's status pill. */
export function statusWords(c: Pick<Change, 'status' | 'undoOf'>): { text: string; tone: 'good' | 'warn' | 'bad' | 'accent' } {
  if (c.undoOf) return { text: 'Undo', tone: 'accent' }
  switch (c.status) {
    case 'applied': return { text: 'In place', tone: 'good' }
    case 'undone': return { text: 'Undone', tone: 'accent' }
    case 'rolled-back': return { text: 'Put back automatically', tone: 'warn' }
    default: return { text: 'Failed', tone: 'bad' }
  }
}

/** The parameters for adding a forward, from the form. Null when the form is not complete. */
export function forwardParams(f: { address: string; proto: string; extPort: string; toPort: string; name: string }): Record<string, unknown> | null {
  if (!f.address || !f.extPort.trim()) return null
  return { address: f.address, proto: f.proto, extPort: f.extPort.trim(), ...(f.toPort.trim() ? { toPort: f.toPort.trim() } : {}), ...(f.name.trim() ? { name: f.name.trim() } : {}) }
}

export function blockParams(f: { mac: string; scheduled: boolean; from: string; to: string; days: string[] }): Record<string, unknown> | null {
  if (!f.mac) return null
  return { mac: f.mac, ...(f.scheduled ? { schedule: { from: f.from, to: f.to, days: f.days } } : {}) }
}

// ── pieces ───────────────────────────────────────────────────────────────────

export function PlanCard({ pending, busy, tick, onTick, onApply, onCancel }: {
  pending: Pending; busy: boolean; tick: boolean; onTick: (v: boolean) => void; onApply: () => void; onCancel: () => void
}) {
  const p = pending.plan
  return (
    <div className={`${s.alert} ${p.needsTick ? s.alertWarn : ''}`} role="group" aria-label="What this will change" style={{ marginTop: 12 }}>
      <Icon name={p.needsTick ? 'warn' : 'check'} size={22} label={p.needsTick ? 'Warning' : 'Plan'} />
      <div className={s.alertBody}>
        <b>{p.title}</b>
        <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>{p.steps.map((x, i) => <li key={i}>{x}</li>)}</ol>
        {p.warnings.filter(w => w !== p.needsTick).map((w, i) => <small key={i} style={{ display: 'block', marginTop: 6, color: 'var(--text-muted)' }}>{w}</small>)}
        {p.needsTick && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 8, color: 'var(--warn)' }}>
            <input type="checkbox" checked={tick} onChange={e => onTick(e.target.checked)} aria-label="I understand this opens a risky port" />
            <span>{p.needsTick}</span>
          </label>
        )}
        <small style={{ display: 'block', marginTop: 6, color: 'var(--text-muted)' }}>
          Before it runs HyperProx saves the router&apos;s settings and puts a safety switch on the router: if HyperProx cannot confirm the change within 90 seconds, the router undoes it by itself.
        </small>
      </div>
      <div className={s.alertAct} style={{ display: 'flex', gap: 8 }}>
        <button type="button" className={`${s.btn} ${s.btnPri}`} disabled={busy || (!!p.needsTick && !tick)} onClick={onApply}>Apply this change</button>
        <button type="button" className={s.btn} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

const li = { border: '1px solid var(--border, rgba(255,255,255,.12))', borderRadius: 10, padding: '10px 12px' } as const
const list = { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 } as const
const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const

export function FixedAddresses({ c, canAct, busy, onPlan }: { c: Control; canAct: boolean; busy: boolean; onPlan: (action: string, params: Record<string, unknown>) => void }) {
  const loose = c.devices.filter(d => !d.fixed)
  const [editing, setEditing] = useState<string | null>(null)
  const [addr, setAddr] = useState('')
  const [note, setNote] = useState('')
  return (
    <Panel title="Fixed addresses" sub={`${c.leases.length} FIXED`} label="Fixed addresses">
      <p className={s.note}>A fixed address means the router always gives that device the same address, so port forwards and firewall rules keep pointing at the right thing.</p>
      {loose.length === 0 ? <p className={s.empty}>Every device the router can see already has a fixed address.</p> : (
        <ul style={list} aria-label="Devices whose address can change">
          {loose.map(d => (
            <li key={d.mac} style={li}>
              <div style={row}>
                <b>{nameOf(d)}</b><code>{d.address}</code><small style={{ color: 'var(--text-muted)' }}>{d.mac}</small>
                <button type="button" className={s.btn} style={{ marginLeft: 'auto' }} disabled={!canAct || busy} onClick={() => onPlan('lease.make-static', { mac: d.mac })}>Make this address permanent</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {c.leases.length > 0 && (
        <ul style={{ ...list, marginTop: 14 }} aria-label="Fixed addresses">
          {c.leases.map(l => (
            <li key={l.id} style={li}>
              <div style={row}>
                <Icon name="check" size={14} /><b>{l.comment || l.name || l.mac}</b><code>{l.address}</code><small style={{ color: 'var(--text-muted)' }}>{l.mac}</small>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button type="button" className={s.btn} disabled={!canAct || busy} onClick={() => { setEditing(editing === l.id ? null : l.id); setAddr(l.address); setNote(l.comment) }}>Edit</button>
                  <button type="button" className={s.btn} disabled={!canAct || busy} onClick={() => onPlan('lease.remove', { id: l.id })}>Remove</button>
                </span>
              </div>
              {editing === l.id && (
                <form style={{ ...row, marginTop: 8 }} onSubmit={e => { e.preventDefault(); onPlan('lease.edit', { id: l.id, address: addr, comment: note }); setEditing(null) }}>
                  <label>Address <input value={addr} onChange={e => setAddr(e.target.value)} aria-label="Fixed address" inputMode="decimal" /></label>
                  <label>Note <input value={note} onChange={e => setNote(e.target.value)} aria-label="Note" maxLength={60} /></label>
                  <button type="submit" className={`${s.btn} ${s.btnPri}`} disabled={busy}>Review the change</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

export function Forwards({ c, canAct, busy, onPlan }: { c: Control; canAct: boolean; busy: boolean; onPlan: (action: string, params: Record<string, unknown>) => void }) {
  const [f, setF] = useState({ address: '', proto: 'tcp', extPort: '', toPort: '', name: '' })
  const params = forwardParams(f)
  return (
    <Panel title="Port forwards" sub={`${c.forwards.filter(x => !x.disabled).length} ON`} label="Port forwards">
      {c.forwards.length === 0 ? <p className={s.empty}>Nothing from the internet is forwarded to a device on your network.</p> : (
        <ul style={list} aria-label="Port forwards">
          {c.forwards.map(x => (
            <li key={x.id} style={{ ...li, ...(x.risky ? { borderColor: 'var(--warn)' } : {}) }}>
              <div style={row}>
                <Pill tone={x.disabled ? 'warn' : 'good'}>{x.disabled ? 'Off' : 'On'}</Pill>
                <b>{x.words}</b>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button type="button" className={s.btn} disabled={!canAct || busy} onClick={() => onPlan('forward.toggle', { id: x.id, disabled: !x.disabled })}>{x.disabled ? 'Switch on' : 'Switch off'}</button>
                  <button type="button" className={s.btn} disabled={!canAct || busy} onClick={() => onPlan('forward.remove', { id: x.id })}>Remove</button>
                </span>
              </div>
              {x.risky && <small style={{ display: 'block', color: 'var(--warn)', marginTop: 4 }}>{x.risky}</small>}
            </li>
          ))}
        </ul>
      )}
      <form style={{ ...row, marginTop: 14 }} aria-label="Add a port forward" onSubmit={e => { e.preventDefault(); if (params) onPlan('forward.add', params) }}>
        <label>Device
          <select value={f.address} onChange={e => setF({ ...f, address: e.target.value })} aria-label="Device">
            <option value="">Pick a device</option>
            {c.devices.map(d => <option key={d.mac} value={d.address}>{nameOf(d)} ({d.address})</option>)}
          </select>
        </label>
        <label>Protocol
          <select value={f.proto} onChange={e => setF({ ...f, proto: e.target.value })} aria-label="Protocol"><option value="tcp">TCP</option><option value="udp">UDP</option></select>
        </label>
        <label>Outside port <input value={f.extPort} onChange={e => setF({ ...f, extPort: e.target.value })} aria-label="Outside port" inputMode="numeric" size={9} /></label>
        <label>Port on the device <input value={f.toPort} onChange={e => setF({ ...f, toPort: e.target.value })} aria-label="Port on the device" inputMode="numeric" size={9} placeholder="same" /></label>
        <label>Name <input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} aria-label="Name" maxLength={40} /></label>
        <button type="submit" className={`${s.btn} ${s.btnPri}`} disabled={!canAct || busy || !params}>Review the forward</button>
      </form>
      {c.hairpin.note && <p className={s.note} style={{ color: 'var(--text-muted)', marginTop: 8 }}>{c.hairpin.note}</p>}
    </Panel>
  )
}

export function Blocks({ c, canAct, busy, onPlan }: { c: Control; canAct: boolean; busy: boolean; onPlan: (action: string, params: Record<string, unknown>) => void }) {
  const [f, setF] = useState({ mac: '', scheduled: false, from: '22:00', to: '06:00', days: DAYS })
  const params = blockParams(f)
  const blocked = new Set(c.blocks.map(b => b.target))
  return (
    <Panel title="Block internet for a device" sub={`${c.blocks.length} BLOCKED`} label="Block internet for a device">
      <p className={s.note}>The device keeps its own network and the router; only its way out to the internet is cut. A schedule limits it to certain hours.</p>
      {c.blocks.length === 0 ? <p className={s.empty}>No device is blocked.</p> : (
        <ul style={list} aria-label="Blocked devices">
          {c.blocks.map(b => (
            <li key={b.id} style={li}>
              <div style={row}>
                <Pill tone={b.disabled ? 'warn' : 'bad'}>{b.disabled ? 'Off' : 'Blocked'}</Pill>
                <b>{b.words}</b>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button type="button" className={s.btn} disabled={!canAct || busy} onClick={() => onPlan('block.unblock', { id: b.id })}>Give the internet back</button>
                  {b.schedule && <button type="button" className={s.btn} disabled={!canAct || busy} onClick={() => onPlan('block.schedule', { id: b.id, schedule: null })}>Block all the time</button>}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form style={{ ...row, marginTop: 14 }} aria-label="Block a device" onSubmit={e => { e.preventDefault(); if (params) onPlan('block.block', params) }}>
        <label>Device
          <select value={f.mac} onChange={e => setF({ ...f, mac: e.target.value })} aria-label="Device to block">
            <option value="">Pick a device</option>
            {c.devices.filter(d => !blocked.has(d.mac)).map(d => <option key={d.mac} value={d.mac}>{nameOf(d)} ({d.address})</option>)}
          </select>
        </label>
        <label><input type="checkbox" checked={f.scheduled} onChange={e => setF({ ...f, scheduled: e.target.checked })} aria-label="Only at certain times" /> Only at certain times</label>
        {f.scheduled && (
          <>
            <label>From <input type="time" value={f.from} onChange={e => setF({ ...f, from: e.target.value })} aria-label="From" /></label>
            <label>To <input type="time" value={f.to} onChange={e => setF({ ...f, to: e.target.value })} aria-label="To" /></label>
            <span role="group" aria-label="Days" style={row}>
              {DAYS.map(d => <label key={d}><input type="checkbox" checked={f.days.includes(d)} onChange={e => setF({ ...f, days: e.target.checked ? [...f.days, d] : f.days.filter(x => x !== d) })} aria-label={d} /> {d}</label>)}
            </span>
          </>
        )}
        <button type="submit" className={`${s.btn} ${s.btnPri}`} disabled={!canAct || busy || !params}>Review the block</button>
      </form>
    </Panel>
  )
}

export function History({ c, canAct, busy, onUndo }: { c: Control; canAct: boolean; busy: boolean; onUndo: (id: string) => void }) {
  return (
    <Panel title="Change history" sub={`${c.history.length} RECORDED`} label="Change history">
      {c.history.length === 0 ? <p className={s.empty}>HyperProx has not changed this router yet.</p> : (
        <ul style={list} aria-label="Changes made to the router, newest first">
          {c.history.map(h => {
            const st = statusWords(h)
            return (
              <li key={h.id} style={li}>
                <div style={row}>
                  <Pill tone={st.tone}>{st.text}</Pill><b>{h.title}</b>
                  <small style={{ color: 'var(--text-muted)' }}>{new Date(h.at).toLocaleString()} · {h.by}</small>
                  {h.canUndo && <button type="button" className={s.btn} style={{ marginLeft: 'auto' }} disabled={!canAct || busy} onClick={() => onUndo(h.id)}>Undo</button>}
                </div>
                <small style={{ display: 'block', color: 'var(--text-muted)', marginTop: 4 }}>{h.steps.join(' · ')}</small>
                {h.note && <small style={{ display: 'block', color: 'var(--warn)', marginTop: 2 }}>{h.note}</small>}
                {h.backup && <small style={{ display: 'block', color: 'var(--text-muted)', marginTop: 2 }}>The router&apos;s settings were saved first{h.backup.truncated ? ' (cut short by the router)' : ''}.</small>}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

/** All four panels. Pure: the state lives in RouterControl. */
export function ControlPanels(p: {
  c: Control; canAct: boolean; busy: boolean; pending: Pending | null; tick: boolean; msg?: string | null; err?: string | null
  onPlan: (action: string, params: Record<string, unknown>) => void; onTick: (v: boolean) => void; onApply: () => void; onCancel: () => void; onUndo: (id: string) => void
}) {
  const note = p.canAct && p.c.canWrite === false ? 'This router login can only read, so HyperProx cannot change anything. Give that router user a group with the write policy first.' : !p.canAct ? 'Only an admin can change the router.' : null
  return (
    <>
      {note && <p className={s.note} style={{ color: 'var(--warn)' }}>{note}</p>}
      {p.pending && <PlanCard pending={p.pending} busy={p.busy} tick={p.tick} onTick={p.onTick} onApply={p.onApply} onCancel={p.onCancel} />}
      {p.err && <p role="alert" style={{ color: 'var(--crit)' }}>{p.err}</p>}
      {p.msg && <p role="status">{p.msg}</p>}
      <FixedAddresses c={p.c} canAct={p.canAct && p.c.canWrite !== false} busy={p.busy} onPlan={p.onPlan} />
      <Forwards c={p.c} canAct={p.canAct && p.c.canWrite !== false} busy={p.busy} onPlan={p.onPlan} />
      <Blocks c={p.c} canAct={p.canAct && p.c.canWrite !== false} busy={p.busy} onPlan={p.onPlan} />
      <History c={p.c} canAct={p.canAct && p.c.canWrite !== false} busy={p.busy} onUndo={p.onUndo} />
    </>
  )
}

/** The panels wired to the API. Admin only: anyone else sees nothing, the API would refuse them anyway. */
export function RouterControl({ onChanged }: { onChanged?: () => void }) {
  const { role } = useSession()
  const admin = atLeast(role, 'admin')
  const [c, setC] = useState<Control | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [tick, setTick] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await apiJson<{ data: Control }>(`${BASE}/control`)
    if (res.ok && res.body?.data) { setC(res.body.data); setErr(null) } else setErr(res.error ?? 'The router manager could not be loaded.')
  }, [])
  useEffect(() => { if (admin) void load() }, [admin, load])
  if (!admin) return null

  const plan = async (action: string, params: Record<string, unknown>) => {
    setBusy(true); setErr(null); setMsg(null); setTick(false)
    const res = await apiJson<{ data: Plan }>(`${BASE}/change/plan`, 'POST', { action, params })
    setBusy(false)
    if (res.ok && res.body?.data) setPending({ action, params, plan: res.body.data }); else { setPending(null); setErr(res.error ?? 'That did not work.') }
  }
  const apply = async () => {
    if (!pending) return
    setBusy(true); setErr(null)
    const res = await apiJson<{ data: { message: string } }>(`${BASE}/change/apply`, 'POST', { action: pending.action, params: pending.params, planHash: pending.plan.hash, ...(pending.plan.needsTick ? { riskTick: tick } : {}) })
    setBusy(false)
    if (res.ok) { setMsg(res.body?.data?.message ?? 'Done.'); setPending(null); await load(); onChanged?.() }
    else { setErr(res.error ?? 'That did not work.'); if (res.code === 'plan_changed') { setPending(null); await load() } }
  }
  const undo = async (id: string) => {
    setBusy(true); setErr(null); setMsg(null)
    const res = await apiJson<{ data: { message: string } }>(`${BASE}/changes/${encodeURIComponent(id)}/undo`, 'POST', {})
    setBusy(false)
    if (res.ok) { setMsg(res.body?.data?.message ?? 'Undone.'); await load(); onChanged?.() } else setErr(res.error ?? 'That did not work.')
  }
  if (!c) return err ? <p role="alert" style={{ color: 'var(--crit)' }}>{err}</p> : null
  return <ControlPanels c={c} canAct={admin} busy={busy} pending={pending} tick={tick} msg={msg} err={err} onPlan={plan} onTick={setTick} onApply={apply} onCancel={() => setPending(null)} onUndo={undo} />
}
