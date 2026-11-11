'use client'

// =============================================================================
//  HyperProx — Home Assistant: instances, Devices, health and settings
//
//  Phone first: one column of big controls per area, grouped the way Home
//  Assistant groups them. Every tap is optimistic and then shows what the device
//  really reads afterwards; when it did not change, the card says so.
//
//  Security devices (locks, alarms, sirens, garage/gate/door covers, anything
//  marked protected) carry a lock icon and always go through a confirm step that
//  names the device and the house, plus the master password (admin only).
//  An instance linked to a remote cluster is amber everywhere, home is teal.
// =============================================================================

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiJson, atLeast } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useClusters } from '@/lib/clusters'
import { ReconfirmModal } from '@/components/vault/ReconfirmModal'
import { BusyNote, GhostButton, INPUT, LABEL, Modal, Notice, PrimaryButton } from '@/components/vault/ui'
import { HudHeader, Icon, styles as vs } from '@/components/visual/kit'
import { PluginSwitcher } from '@/components/plugins/visual/plugin-kit'
import pv from '@/components/plugins/visual/pages.module.css'
import { ClimateCard, LightSheet, Sheet, Tile, ctl, isOn, kindOf } from './HomeVisual'

const API = '/api/plugins/home-assistant'

/** An everyday mark, recorded by HyperProx from what Home Assistant said the device was when it was marked. */
export interface EverydayMark { entity_id: string; domain: string; device_class: string | null; friendly_name: string }
export interface Policy { protected: string[]; securityDomains: string[]; everyday: EverydayMark[]; normalRole: 'operator' | 'admin'; notifySecurity: boolean }
export interface Instance {
  id: string; name: string; clusterId: string | null; insecureTLS: boolean; fingerprint?: string | null; policy: Policy
  url?: string; hasToken?: boolean
  cluster: { id: string; name: string; kind: 'home' | 'remote' } | null; remote: boolean
}
interface Control {
  action: string; kind: 'button' | 'range' | 'select'; label: string
  min?: number; max?: number; step?: number; unit?: string; value?: number | string | null; options?: string[]; confirm?: string
}
interface Device {
  entityId: string; name: string; domain: string; kind?: string; tier: 'normal' | 'security'; unavailable: boolean
  state: string; unit?: string; deviceClass?: string; current?: number; controls: Control[]
}
interface DevicesData { areas: Array<{ name: string; devices: Device[] }>; warnings?: string[]; areaSource?: string; hiddenLed?: number; unreachable?: boolean; error?: string }
interface Status { reachable: boolean; error: string | null; version: string | null; location: string | null; user: { name: string; isAdmin: boolean; isOwner: boolean } | null }

const colour = (i: Instance) => (i.remote ? 'var(--remote)' : 'var(--accent)')
const ink = (i: Instance) => (i.remote ? 'var(--remote-ink)' : 'var(--accent-ink)')

export function LockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg aria-label="security device" role="img" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

/** The instance's band: amber with the remote cluster's name, or teal for home. */
export function InstanceBand({ i }: { i: Instance }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 font-semibold" role="status" style={{ background: colour(i), color: ink(i) }}>
      <span className="uppercase" style={{ letterSpacing: '0.04em' }}>{i.remote ? 'Remote' : 'Home'} · {i.name}</span>
      {i.remote && i.cluster && <small className="font-medium" style={{ opacity: 0.85 }}>Beside {i.cluster.name}. Every control here acts in that house.</small>}
    </div>
  )
}

export function useInstances() {
  const [list, setList] = useState<Instance[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    const r = await apiJson<{ data: Instance[] }>(`${API}/instances`)
    if (r.ok) { setList(r.body!.data ?? []); setError(null) } else setError(r.error ?? 'Could not read the Home Assistant instances')
  }, [])
  useEffect(() => { void reload() }, [reload])
  return { list, error, reload }
}

function StatusLine({ i }: { i: Instance }) {
  const [s, setS] = useState<Status | null>(null)
  useEffect(() => { apiJson<{ data: Status }>(`${API}/instances/${i.id}/status`).then(r => setS(r.ok ? r.body!.data : { reachable: false, error: r.error ?? 'Could not check', version: null, location: null, user: null })) }, [i.id])
  if (!s) return <BusyNote>Checking {i.name}…</BusyNote>
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm" style={{ color: s.reachable ? 'var(--good)' : 'var(--crit-soft)' }}>
        {s.reachable ? `Reachable · Home Assistant ${s.version ?? '?'}${s.location ? ` · ${s.location}` : ''}` : `Not reachable: ${s.error}`}
      </p>
      {s.user?.isAdmin && (
        <Notice kind="warn">
          This token belongs to a Home Assistant <b>administrator</b> ({s.user.name || 'unnamed user'}). HyperProx only sends the controls listed here,
          but the token itself could change Home Assistant. Create a dedicated, non-admin user for HyperProx and use its token instead.
        </Notice>
      )}
    </div>
  )
}

// ── One device ───────────────────────────────────────────────────────────────

type Ask = (d: Device, c: Control, value?: number | string) => Promise<void>

function DeviceCard({ d, inst, canNormal, canSecurity, ask, busy, note }: {
  d: Device; inst: Instance; canNormal: boolean; canSecurity: boolean; ask: Ask; busy: boolean; note?: { text: string; ok: boolean }
}) {
  const security = d.tier === 'security'
  const allowed = security ? canSecurity : canNormal
  const [draft, setDraft] = useState<Record<string, number>>({})
  return (
    <div className="rounded-lg border p-3 flex flex-col gap-2" style={{
      background: 'var(--surface)', borderColor: security ? 'color-mix(in srgb, var(--warn) 45%, transparent)' : 'var(--border)',
      opacity: d.unavailable ? 0.6 : 1,
    }}>
      <div className="flex items-start gap-2">
        {security && <span style={{ color: 'var(--warn-2)', marginTop: 2 }}><LockIcon /></span>}
        <div className="min-w-0 flex-1">
          <b className="block truncate" style={{ color: 'var(--text-bright)', fontSize: 15 }}>{d.name}</b>
          <small className="font-mono" style={{ color: 'var(--text-dim)', fontSize: 11 }}>{d.entityId}</small>
        </div>
        <span className="font-mono text-sm shrink-0" style={{ color: d.unavailable ? 'var(--crit-soft)' : d.state === 'on' || d.state === 'unlocked' || d.state === 'open' ? colour(inst) : 'var(--text-soft)' }}>
          {busy ? '…' : `${d.state}${d.unit ? ` ${d.unit}` : ''}`}
        </span>
      </div>
      {d.unavailable ? <small style={{ color: 'var(--text-dimmer)' }}>Unavailable in Home Assistant.</small> : !allowed ? (
        <small style={{ color: 'var(--text-dimmer)' }}>{security ? 'Security device: admins only, with the master password.' : `Controls need the ${inst.policy.normalRole} role.`}</small>
      ) : (
        <div className="flex flex-wrap gap-2 items-center">
          {d.controls.map(c => c.kind === 'button' ? (
            <button key={c.action} disabled={busy} onClick={() => void ask(d, c)}
              className="rounded-md border px-4 font-semibold disabled:opacity-40 flex items-center gap-1.5"
              style={{ minHeight: 44, minWidth: 64, borderColor: security ? 'var(--warn)' : colour(inst), color: security ? 'var(--warn-2)' : colour(inst), background: 'transparent' }}>
              {security && <LockIcon size={12} />}{c.label}
            </button>
          ) : c.kind === 'range' ? (
            <label key={c.action} className="flex items-center gap-2 w-full text-sm" style={{ color: 'var(--text-muted)' }}>
              <span className="shrink-0" style={{ minWidth: '5.5rem' }}>{c.label}</span>
              <input type="range" min={c.min} max={c.max} step={c.step} disabled={busy} className="flex-1" style={{ minHeight: 36, accentColor: colour(inst) }}
                value={draft[c.action] ?? (typeof c.value === 'number' ? c.value : c.min)}
                onChange={e => setDraft(x => ({ ...x, [c.action]: Number(e.target.value) }))}
                onPointerUp={() => { if (draft[c.action] !== undefined) void ask(d, c, draft[c.action]) }}
                onKeyUp={e => { if (['Enter', ' '].includes(e.key) && draft[c.action] !== undefined) void ask(d, c, draft[c.action]) }} />
              <span className="font-mono shrink-0" style={{ minWidth: '3.5rem', textAlign: 'right' }}>{draft[c.action] ?? c.value ?? '—'}{c.unit}</span>
            </label>
          ) : (
            <label key={c.action} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
              {c.label}
              <select disabled={busy} value={String(c.value ?? '')} onChange={e => void ask(d, c, e.target.value)}
                style={{ ...INPUT, width: 'auto', height: 40 }}>
                {(c.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}
      {note && <small style={{ color: note.ok ? 'var(--good)' : 'var(--warn-2)' }} role="status">{note.text}</small>}
    </div>
  )
}

// ── The Devices view ─────────────────────────────────────────────────────────

const OPTIMISTIC: Record<string, string> = { turn_on: 'on', turn_off: 'off', lock: 'locking', unlock: 'unlocking', open: 'opening', close: 'closing', play: 'playing', pause: 'paused' }

/** What one tap on a tile does: toggle it, play or pause it, lock or unlock it, run it. Null: open its controls. */
function primaryControl(d: Device): Control | null {
  const k = kindOf(d)
  if (['light', 'switch', 'outlet', 'fan', 'siren'].includes(k)) return ctl(d, isOn(d) ? 'turn_off' : 'turn_on') ?? null
  if (k === 'media') return ctl(d, d.state === 'playing' ? 'pause' : 'play') ?? null
  if (k === 'lock') return ctl(d, d.state === 'locked' ? 'unlock' : 'lock') ?? null
  if (k === 'scene' || k === 'script') return ctl(d, 'run') ?? null
  if (k === 'button') return ctl(d, 'press') ?? null
  return null
}

export function DevicesView({ inst }: { inst: Instance }) {
  const { role } = useSession()
  const [data, setData] = useState<DevicesData | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [bulk, setBulk] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, { text: string; ok: boolean }>>({})
  const [last, setLast] = useState<{ text: string; ok: boolean } | null>(null)
  const [filter, setFilter] = useState('')
  const [room, setRoom] = useState('All')
  const [sheet, setSheet] = useState<null | { id: string; kind: 'light' | 'controls' }>(null)
  const [confirm, setConfirm] = useState<null | { phrase: string; name: string; run: (typed: string) => void }>(null)
  const [typed, setTyped] = useState('')
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    const r = await apiJson<{ data: DevicesData }>(`${API}/instances/${inst.id}/devices`)
    inFlight.current = false
    setData(r.ok ? r.body!.data : { areas: [], unreachable: true, error: r.error })
  }, [inst.id])

  // Live state: every 5 seconds while the tab is visible and nothing is being changed.
  useEffect(() => {
    void load()
    const t = setInterval(() => { if (!document.hidden && !busy && !bulk) void load() }, 5000)
    return () => clearInterval(t)
  }, [load, busy, bulk])

  const patch = (entityId: string, state: string) => setData(d => d && ({ ...d, areas: d.areas.map(a => ({ ...a, devices: a.devices.map(x => x.entityId === entityId ? { ...x, state } : x) })) }))

  /** One action through the house's action route. Resolves true when Home Assistant accepted it. */
  const send = useCallback(async (d: Device, c: Control, value: number | string | undefined, phrase?: string, typedName?: string, quiet = false): Promise<boolean> => {
    const secure = d.tier === 'security'
    setBusy(d.entityId)
    const before = d.state
    if (OPTIMISTIC[c.action]) patch(d.entityId, OPTIMISTIC[c.action])
    const r = await apiJson<{ data: { changed: boolean; message: string; after: { state: string } | null } }>(
      `${API}/instances/${inst.id}/${secure ? 'secure-actions' : 'actions'}`, 'POST', { entityId: d.entityId, action: c.action, value, confirm: phrase, typed: typedName })
    setBusy(null)
    if (r.ok) {
      const res = r.body!.data
      patch(d.entityId, res.after?.state ?? before)
      const note = { text: res.message, ok: res.changed }
      setNotes(n => ({ ...n, [d.entityId]: note }))
      if (!quiet) setLast(note)
      if (!quiet) void load()
      return true
    }
    patch(d.entityId, before)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void send(d, c, value, phrase, typedName)); return false }
    const note = { text: `${d.name}: ${r.error ?? 'That did not work.'}`, ok: false }
    setNotes(n => ({ ...n, [d.entityId]: note }))
    setLast(note)
    return false
  }, [inst.id, load])

  const ask: Ask = useCallback(async (d, c, value) => {
    // The phrase names the device, the house and (for a slider or a list) the value; the person also types the
    // device's name. The server builds the same phrase from the checked value and compares both.
    if (d.tier === 'security' && c.confirm) {
      const phrase = c.confirm.replace('{value}', value === undefined ? '' : String(value))
      setTyped('')
      setSheet(null)
      setConfirm({ phrase, name: d.name, run: t => void send(d, c, value, phrase, t) }); return
    }
    await send(d, c, value)
  }, [send])

  const canNormal = atLeast(role, inst.policy.normalRole)
  const canSecurity = atLeast(role, 'admin')
  const allowedFor = (d: Device) => d.tier === 'security' ? canSecurity : canNormal
  const whyNot = (d: Device) => d.tier === 'security' ? 'Security device: admins only, with the master password.' : `Controls need the ${inst.policy.normalRole} role.`

  const all = useMemo(() => (data?.areas ?? []).flatMap(a => a.devices.map(d => ({ d, area: a.name }))), [data])
  const areas = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!data) return []
    return data.areas
      .filter(a => room === 'All' || a.name === room)
      .map(a => ({ ...a, devices: a.devices.filter(d => !d.unavailable && (!q || `${a.name} ${d.name} ${d.entityId}`.toLowerCase().includes(q))) }))
      .filter(a => a.devices.length)
  }, [data, filter, room])
  const offline = all.filter(x => x.d.unavailable)
  const online = all.length - offline.length
  const lightsOn = all.filter(x => kindOf(x.d) === 'light' && isOn(x.d))
  const playing = all.filter(x => kindOf(x.d) === 'media' && x.d.state === 'playing')
  const climate = all.find(x => kindOf(x.d) === 'climate' && !x.d.unavailable)
  const target = climate ? ctl(climate.d, 'target_temperature')?.value : undefined

  /**
   * A quick action is several ordinary actions, one after another, each through the same route with its own tier
   * check and audit row. Security-tier devices are left out: each of those needs its own confirm step.
   */
  const runAll = async (label: string, list: Array<{ d: Device; c: Control }>, skipped: number) => {
    setBulk(label)
    let ok = 0
    for (const { d, c } of list) if (await send(d, c, undefined, undefined, undefined, true)) ok++
    setBulk(null)
    setLast({ ok: ok === list.length, text: `${label}: ${ok} of ${list.length} done.${skipped ? ` ${skipped} security device${skipped === 1 ? ' was' : 's were'} left alone; open each to confirm.` : ''}` })
    void load()
  }
  const quick = (want: (d: Device) => boolean, action: string) => {
    const hits = all.map(x => x.d).filter(d => !d.unavailable && want(d) && ctl(d, action))
    return { list: hits.filter(d => d.tier === 'normal').map(d => ({ d, c: ctl(d, action)! })), skipped: hits.filter(d => d.tier === 'security').length }
  }
  const lightsOff = quick(d => kindOf(d) === 'light' && isOn(d), 'turn_off')
  const pauseAudio = quick(d => kindOf(d) === 'media' && d.state === 'playing', 'pause')

  const press = (d: Device) => {
    if (!allowedFor(d)) { setSheet({ id: d.entityId, kind: 'controls' }); return }
    const c = primaryControl(d)
    if (c) void ask(d, c)
    else setSheet({ id: d.entityId, kind: 'controls' })
  }
  const open = sheet ? all.find(x => x.d.entityId === sheet.id) : undefined
  const roomNames = (data?.areas ?? []).map(a => a.name)

  return (
    <div className={`${vs.page} ${inst.remote ? vs.remote : ''}`}>
      <InstanceBand i={inst} />
      {!data && <BusyNote>Reading {inst.name}…</BusyNote>}
      {data?.unreachable && <Notice kind="error">{data.error ?? `${inst.name} is not answering.`} The page keeps trying every few seconds.</Notice>}
      {data && !data.unreachable && (
        <>
          <HudHeader level={2} label={`${inst.name} overview`} eyebrow={`${inst.remote ? 'Remote' : 'Home'} · Home Assistant · live 5 s`} title={inst.name}
            ring={{ value: all.length ? online / all.length : 0, text: `${online}/${all.length}`, label: 'devices online' }}
            chips={[
              { label: 'lights on', value: lightsOn.length, tone: lightsOn.length ? 'warm' : 'dim' },
              { label: 'playing', value: playing.length, tone: playing.length ? 'accent' : 'dim' },
              { label: 'A/C target', value: typeof target === 'number' ? `${target}°` : '—', tone: 'violet' },
              { label: 'offline', value: offline.length, tone: offline.length ? 'crit' : 'dim' },
            ]} />

          {canNormal && (
            <div className={pv.actions} role="group" aria-label="Quick actions">
              <button type="button" className={pv.action} disabled={!!bulk || !lightsOff.list.length} onClick={() => void runAll('All lights off', lightsOff.list, lightsOff.skipped)}>
                <Icon name="power" />{bulk === 'All lights off' ? 'Turning off…' : `All lights off${lightsOff.list.length ? ` (${lightsOff.list.length})` : ''}`}
              </button>
              <button type="button" className={pv.action} disabled={!!bulk || !pauseAudio.list.length} onClick={() => void runAll('Pause all audio', pauseAudio.list, pauseAudio.skipped)}>
                <Icon name="mute" />{bulk === 'Pause all audio' ? 'Pausing…' : `Pause all audio${pauseAudio.list.length ? ` (${pauseAudio.list.length})` : ''}`}
              </button>
            </div>
          )}
          {last && <p className={pv.toast} role="status" style={{ color: last.ok ? 'var(--good)' : 'var(--warn-2)' }}>{last.text}</p>}

          {roomNames.length > 1 && (
            <div className={pv.rooms} role="group" aria-label="Rooms">
              {['All', ...roomNames].map(r => (
                <button key={r} type="button" className={pv.roomChip} aria-pressed={room === r} onClick={() => setRoom(r)}>
                  {r}<i>{r === 'All' ? online : (data.areas.find(a => a.name === r)?.devices.filter(d => !d.unavailable).length ?? 0)}</i>
                </button>
              ))}
            </div>
          )}
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Find a device or room" aria-label="Find a device or room" style={INPUT} />
          {(data.warnings ?? []).map(w => <Notice key={w} kind="warn">{w}</Notice>)}
          {data.areaSource === 'none' && <small style={{ color: 'var(--text-dimmer)' }}>Home Assistant did not share its rooms with this token, so rooms are worked out from device names. Rooms set in Home Assistant take over when it shares them.</small>}
          {!!data.hiddenLed && <small style={{ color: 'var(--text-dimmer)' }}>{data.hiddenLed} indicator-light switch{data.hiddenLed === 1 ? ' is' : 'es are'} hidden (a switch&apos;s own status LED).</small>}
          {areas.length === 0 && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{filter ? 'Nothing matches.' : offline.length ? 'Every device here is offline.' : 'No devices HyperProx can control.'}</p>}

          {areas.map(a => {
            const active = a.devices.filter(isOn).length
            return (
              <section key={a.name} className={pv.room} aria-label={a.name}>
                <div className={pv.roomHead}><h2>{a.name}</h2><small>{active ? `${active} ACTIVE` : 'ALL QUIET'}</small><span aria-hidden /></div>
                <div className={pv.grid}>
                  {a.devices.map(d => kindOf(d) === 'climate' && (ctl(d, 'target_temperature') || ctl(d, 'hvac_mode')) ? (
                    <ClimateCard key={d.entityId} d={d} allowed={allowedFor(d)} busy={busy === d.entityId} why={whyNot(d)} onSet={(c, v) => void ask(d, c, v)} />
                  ) : (
                    <Tile key={d.entityId} d={d} busy={busy === d.entityId}
                      pressLabel={!allowedFor(d) ? 'Shows why it cannot be controlled.' : primaryControl(d) ? `Tap to ${primaryControl(d)!.label.toLowerCase()}.` : 'Tap for its controls.'}
                      onPress={() => press(d)}
                      onMore={d.controls.length > 0 && (kindOf(d) === 'light' ? !!(ctl(d, 'brightness') || ctl(d, 'color_temp')) : d.controls.some(c => c.kind !== 'button') || d.controls.length > 2)
                        ? () => setSheet({ id: d.entityId, kind: kindOf(d) === 'light' && d.tier === 'normal' ? 'light' : 'controls' }) : undefined}
                      moreLabel={kindOf(d) === 'light' ? `Brightness and warmth for ${d.name}` : `All controls for ${d.name}`} />
                  ))}
                </div>
              </section>
            )
          })}

          {offline.length > 0 && (
            <details className={pv.offline}>
              <summary><span>Offline devices</span><em>{offline.length} NOT ANSWERING</em></summary>
              <ul>{offline.map(x => <li key={x.d.entityId}>{x.d.name}</li>)}</ul>
            </details>
          )}
        </>
      )}
      {open && sheet?.kind === 'light' && (
        <LightSheet d={open.d} room={open.area} allowed={allowedFor(open.d)} busy={busy === open.d.entityId} note={notes[open.d.entityId]} why={whyNot(open.d)}
          onClose={() => setSheet(null)} onSet={(c, v) => void ask(open.d, c, v)}
          onToggle={() => { const c = ctl(open.d, isOn(open.d) ? 'turn_off' : 'turn_on'); if (c) void ask(open.d, c) }} />
      )}
      {open && sheet?.kind === 'controls' && (
        <Sheet title={open.d.name} sub={`${open.area}${open.d.tier === 'security' ? ' · security device' : ''}`} onClose={() => setSheet(null)}>
          <div className={pv.controls}>
            <DeviceCard d={open.d} inst={inst} busy={busy === open.d.entityId} note={notes[open.d.entityId]} ask={ask} canNormal={canNormal} canSecurity={canSecurity} />
          </div>
          <div className={vs.sheetRow}><button type="button" className={vs.btn} onClick={() => setSheet(null)}>Close</button></div>
        </Sheet>
      )}
      {confirm && (
        <Modal title="Confirm a security action" onClose={() => setConfirm(null)}>
          <div className="flex flex-col gap-4">
            <p className="flex items-center gap-2 text-base font-semibold" style={{ color: 'var(--warn-2)' }}><LockIcon size={18} />{confirm.phrase}</p>
            <p className="text-sm" style={{ color: 'var(--text-soft)' }}>This acts on a real device{inst.remote ? `, in ${inst.name}` : ''}. It is recorded with your name{inst.policy.notifySecurity ? ' and sent to your notification channels' : ''}.</p>
            <label><span style={LABEL}>Type the device&apos;s name to confirm: <b>{confirm.name}</b></span>
              <input style={INPUT} autoFocus autoComplete="off" value={typed} onChange={e => setTyped(e.target.value)} aria-label="Device name" /></label>
            <div className="flex gap-2 justify-end">
              <GhostButton type="button" onClick={() => setConfirm(null)}>Cancel</GhostButton>
              <PrimaryButton type="button" style={{ background: 'var(--warn)' }} disabled={typed.trim().toLowerCase() !== confirm.name.toLowerCase()}
                onClick={() => { const f = confirm.run; setConfirm(null); f(typed) }}>{confirm.phrase.split(' at ')[0]}</PrimaryButton>
            </div>
          </div>
        </Modal>
      )}
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const f = reconfirm; setReconfirm(null); f() }} />}
    </div>
  )
}

// ── Health (the plug-in's view, for any instance) ────────────────────────────

function HealthView({ inst }: { inst: Instance }) {
  const [d, setD] = useState<any>(null)
  useEffect(() => { setD(null); apiJson<{ data: any }>(`${API}/instances/${inst.id}/health`).then(r => setD(r.ok ? r.body!.data : { ok: false, error: r.error })) }, [inst.id])
  if (!d) return <BusyNote>Reading {inst.name}…</BusyNote>
  if (!d.ok) return <Notice kind="error">{d.error}</Notice>
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(9rem,1fr))' }}>
        {(d.stats ?? []).map((s: any) => (
          <div key={s.label} className="rounded-lg border px-3 py-2" style={{ background: 'var(--surface)', borderColor: 'var(--border-soft)' }}>
            <small className="font-mono uppercase" style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{s.label}</small>
            <b className="block font-display" style={{ fontSize: 19, color: s.tone === 'bad' ? 'var(--crit)' : s.tone === 'warn' ? 'var(--warn)' : s.tone === 'good' ? 'var(--good)' : 'var(--text-bright)' }}>{s.value}</b>
          </div>
        ))}
      </div>
      {(d.tables ?? []).filter((t: any) => /Needs you|Batteries|Unavailable/.test(t.title)).map((t: any) => (
        <details key={t.title} open={t.rows.length > 0 && t.rows.length <= 12} className="rounded-lg border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <summary className="cursor-pointer px-3 py-2 font-semibold" style={{ color: 'var(--text-bright)' }}>{t.title} <small style={{ color: 'var(--text-dimmer)' }}>{t.rows.length}</small></summary>
          {t.rows.length === 0 ? <p className="px-3 pb-3 text-sm" style={{ color: 'var(--text-muted)' }}>{t.empty}</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <tbody>{t.rows.map((r: any, n: number) => (
                <tr key={n} className="border-t" style={{ borderColor: 'var(--border-dim)' }}>
                  {t.columns.map((c: any) => <td key={c.key} className="px-3 py-1.5" style={{ color: 'var(--text-soft)', textAlign: c.align ?? 'left' }}>{String(r[c.key] ?? '—')}</td>)}
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </details>
      ))}
    </div>
  )
}

// ── Settings: add, edit, remove (admin, re-confirmed) ────────────────────────

const ADVICE = 'Home Assistant long-lived tokens carry everything their user can do. Make a dedicated, non-admin user for HyperProx in Home Assistant (Settings → People → Add person, "Allow person to login", administrator off), sign in as it, then Profile → Security → Long-lived access tokens. The token is kept in the vault and never shown again.'

function InstanceForm({ inst, onSaved, onCancel }: { inst: Instance | null; onSaved: () => void; onCancel?: () => void }) {
  const { clusters } = useClusters()
  const [f, setF] = useState({
    name: inst?.name ?? '', url: inst?.url ?? '', token: '', clusterId: inst?.clusterId ?? '', insecureTLS: inst?.insecureTLS ?? false,
    normalRole: inst?.policy.normalRole ?? 'operator', notifySecurity: inst?.policy.notifySecurity ?? true,
    protectedText: (inst?.policy.protected ?? []).join('\n'), domainsText: (inst?.policy.securityDomains ?? []).join(', '),
    everydayText: (inst?.policy.everyday ?? []).map(e => e.entity_id).join('\n'), fingerprint: inst?.fingerprint ?? '',
  })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reconfirm, setReconfirm] = useState<null | (() => void)>(null)
  const set = (k: keyof typeof f, v: any) => setF(x => ({ ...x, [k]: v }))
  const [probe, setProbe] = useState<null | { fingerprint: string; subject: string; validTo: string }>(null)
  const readCert = async () => {
    setErr(null)
    const r = await apiJson<{ data: { fingerprint: string; subject: string; validTo: string } }>(`${API}/instances/probe-certificate`, 'POST', { url: f.url })
    if (r.ok) setProbe(r.body!.data); else setErr(r.error ?? 'Could not read the certificate')
  }

  const save = async () => {
    setBusy(true); setErr(null)
    const body: Record<string, unknown> = {
      name: f.name, url: f.url, clusterId: f.clusterId || null,
      policy: {
        normalRole: f.normalRole, notifySecurity: f.notifySecurity,
        protected: f.protectedText.split(/[\s,]+/).filter(Boolean), securityDomains: f.domainsText.split(/[\s,]+/).filter(Boolean),
        everyday: f.everydayText.split(/[\s,]+/).filter(Boolean),
      },
      insecureTLS: f.insecureTLS, fingerprint: f.fingerprint || null,
    }
    if (f.token || !inst) body.token = f.token
    const r = await apiJson(inst ? `${API}/instances/${inst.id}` : `${API}/instances`, inst ? 'PUT' : 'POST', body)
    setBusy(false)
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void save()); return }
    if (!r.ok) { setErr(r.error ?? 'Could not save'); return }
    set('token', '')
    onSaved()
  }

  const remove = async () => {
    if (!inst || !window.confirm(`Remove ${inst.name} from HyperProx? Its token is deleted from the vault. Home Assistant itself is not touched.`)) return
    const r = await apiJson(`${API}/instances/${inst.id}`, 'DELETE')
    if (r.status === 403 && r.code === 'reconfirm_required') { setReconfirm(() => () => void remove()); return }
    if (!r.ok) { setErr(r.error ?? 'Could not remove'); return }
    onSaved()
  }

  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <h3 className="font-display font-semibold" style={{ fontSize: 18, color: 'var(--text-bright)' }}>{inst ? `Settings: ${inst.name}` : 'Add a Home Assistant'}</h3>
      <Notice kind="info">{ADVICE}</Notice>
      <label><span style={LABEL}>Name</span><input style={INPUT} value={f.name} onChange={e => set('name', e.target.value)} placeholder="Second home" /></label>
      <label><span style={LABEL}>Address</span><input style={INPUT} value={f.url} onChange={e => set('url', e.target.value)} placeholder="http://homeassistant.local:8123" /></label>
      <label><span style={LABEL}>Long-lived access token {inst?.hasToken ? '(saved; leave blank to keep it)' : ''}</span>
        <input style={INPUT} type="password" autoComplete="off" value={f.token} onChange={e => set('token', e.target.value)} /></label>
      <label><span style={LABEL}>Beside which server</span>
        <select style={INPUT} value={f.clusterId} onChange={e => set('clusterId', e.target.value)}>
          <option value="">Not linked (home)</option>
          {(clusters ?? []).map(c => <option key={c.id} value={c.id}>{c.name}{c.kind === 'remote' ? ' (remote)' : ''}</option>)}
        </select>
        <small style={{ color: 'var(--text-dimmer)' }}>Linked to a remote server, this house shows on that server&apos;s page and in the Command center, in amber.</small>
      </label>
      {inst && f.url !== (inst.url ?? '') && <small style={{ color: 'var(--warn-2)' }}>A new address needs the token again: enter it above in the same save.</small>}
      {f.url.startsWith('https:') && (
        <div className="flex flex-col gap-2 rounded-md border p-3" style={{ borderColor: 'var(--border-strong)' }}>
          <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Certificate</span>
          <small style={{ color: 'var(--text-muted)' }}>
            A normal certificate is checked as usual. For Home Assistant&apos;s own self-signed one, read it here, compare the fingerprint with the one
            your browser shows for that address, and pin it: only that certificate is then accepted.
          </small>
          {f.fingerprint ? <small className="font-mono break-all" style={{ color: 'var(--good)' }}>Pinned: {f.fingerprint}</small> : null}
          {probe && <small className="font-mono break-all" style={{ color: 'var(--text-soft)' }}>Presented: {probe.fingerprint} ({probe.subject}, valid to {probe.validTo})</small>}
          <div className="flex flex-wrap gap-2">
            <GhostButton type="button" onClick={() => void readCert()}>Read certificate</GhostButton>
            {probe && probe.fingerprint !== f.fingerprint && <GhostButton type="button" onClick={() => set('fingerprint', probe.fingerprint)}>Pin this certificate</GhostButton>}
            {f.fingerprint && <GhostButton type="button" onClick={() => set('fingerprint', '')}>Remove the pin</GhostButton>}
          </div>
          <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-soft)' }}>
            <input type="checkbox" checked={f.insecureTLS} onChange={e => set('insecureTLS', e.target.checked)} /> Accept any certificate (not recommended; pin it instead)
          </label>
        </div>
      )}
      <fieldset className="flex flex-col gap-2 rounded-md border p-3" style={{ borderColor: 'var(--border-strong)' }}>
        <legend className="px-1 text-sm font-semibold" style={{ color: 'var(--text)' }}>Safety</legend>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Locks, alarm panels, sirens and garage, gate and door covers are always security devices: admins only, with the master password, a confirm
          step and the device&apos;s name typed. So are, until you say otherwise, covers other than blinds, curtains, shades, shutters, awnings and dampers;
          scenes, scripts and buttons; and switches and toggles, except plug sockets (outlets, including plugs Home Assistant&apos;s device list names as
          plugs, outlets or strips), switches named as a light or lamp, and every TP-Link switch. Switches and buttons of routers, access points and
          firewalls are always security devices. (Plugs, TP-Link and network gear are recognised from Home Assistant&apos;s device list, when it
          shares it with this token.) Anything whose name sounds like a door, gate, lock or alarm, in English or the common European
          languages, is always a security device. API tokens can never use security controls.
        </p>
        <label><span style={LABEL}>Everyday controls are for</span>
          <select style={INPUT} value={f.normalRole} onChange={e => set('normalRole', e.target.value)}>
            <option value="operator">Operators and above</option><option value="admin">Admins and above</option>
          </select></label>
        <label><span style={LABEL}>Protected devices (entity ids, one per line)</span>
          <textarea style={{ ...INPUT, height: 90, padding: 8 }} value={f.protectedText} onChange={e => set('protectedText', e.target.value)} placeholder="switch.water_heater" /></label>
        <label><span style={LABEL}>Everyday devices (entity ids, one per line): scenes, scripts, buttons, or a switch HyperProx took for a door or lock</span>
          <textarea style={{ ...INPUT, height: 70, padding: 8 }} value={f.everydayText} onChange={e => set('everydayText', e.target.value)} placeholder="scene.movie_night" />
          <small style={{ color: 'var(--text-dimmer)' }}>These lose the confirm step. HyperProx records each one as Home Assistant describes it now; if its name or class changes later, it needs the confirm step again. Locks, alarms, sirens, garage, gate and door covers, and anything whose name sounds like a door, gate, lock or alarm can never be made everyday. Each change is recorded.</small></label>
        <label><span style={LABEL}>Whole kinds to protect too (e.g. climate, cover)</span>
          <input style={INPUT} value={f.domainsText} onChange={e => set('domainsText', e.target.value)} /></label>
        <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-soft)' }}>
          <input type="checkbox" checked={f.notifySecurity} onChange={e => set('notifySecurity', e.target.checked)} /> Notify my channels after every security action
        </label>
      </fieldset>
      {err && <Notice kind="error">{err}</Notice>}
      <div className="flex flex-wrap gap-2 justify-end">
        {inst && inst.id !== 'default' && <GhostButton type="button" onClick={() => void remove()} style={{ color: 'var(--crit-soft)' }}>Remove</GhostButton>}
        {onCancel && <GhostButton type="button" onClick={onCancel}>Cancel</GhostButton>}
        <PrimaryButton type="button" disabled={busy || !f.name || !f.url || (!inst && !f.token)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</PrimaryButton>
      </div>
      {reconfirm && <ReconfirmModal onClose={() => setReconfirm(null)} onDone={() => { const fn = reconfirm; setReconfirm(null); fn() }} />}
    </div>
  )
}

// ── The plug-in page ─────────────────────────────────────────────────────────

export function HomeAssistantPage() {
  const { role } = useSession()
  const { list, error, reload } = useInstances()
  const [sel, setSel] = useState<string | null>(null)
  const [tab, setTab] = useState<'devices' | 'health' | 'settings'>('devices')
  const [adding, setAdding] = useState(false)
  const inst = list?.find(i => i.id === sel) ?? list?.[0] ?? null
  const admin = atLeast(role, 'admin')

  return (
    <div className="overflow-x-hidden">
      <div className="flex flex-wrap items-center gap-3 pb-4">
        <Link href="/plugins" className="font-mono text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--accent)' }}>← plug-ins</Link>
        {admin && <span className="ml-auto"><PrimaryButton type="button" onClick={() => setAdding(true)}>Add a house</PrimaryButton></span>}
      </div>
      <div className="flex flex-col gap-4 min-w-0">
        <PluginSwitcher current="home-assistant" />
        {error && <Notice kind="error">{error}</Notice>}
        {!list && !error && <BusyNote>Reading…</BusyNote>}
        {adding && <InstanceForm inst={null} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); void reload() }} />}
        {list && list.length === 0 && !adding && <Notice kind="info">No Home Assistant is set up yet.{admin ? ' Use "Add a house".' : ' An admin can add one.'}</Notice>}
        {list && list.length > 0 && inst && (
          <>
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Houses">
              {list.map(i => (
                <button key={i.id} role="tab" aria-selected={i.id === inst.id} onClick={() => setSel(i.id)} className="rounded-md border px-3 font-semibold"
                  style={{ minHeight: 40, borderColor: colour(i), background: i.id === inst.id ? colour(i) : 'transparent', color: i.id === inst.id ? ink(i) : colour(i) }}>
                  {i.name}{i.remote ? ' · remote' : ''}
                </button>
              ))}
            </div>
            <StatusLine i={inst} />
            <div className="flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
              {(['devices', 'health', ...(admin ? ['settings'] : [])] as const).map(t => (
                <button key={t} onClick={() => setTab(t as any)} className="px-3 py-2 text-sm capitalize"
                  style={{ borderBottom: `2px solid ${tab === t ? colour(inst) : 'transparent'}`, color: tab === t ? 'var(--text-bright)' : 'var(--text-muted)', fontWeight: tab === t ? 600 : 400 }}>{t}</button>
              ))}
            </div>
            {tab === 'devices' && <DevicesView key={inst.id} inst={inst} />}
            {tab === 'health' && <HealthView inst={inst} />}
            {tab === 'settings' && admin && <InstanceForm key={inst.id} inst={inst} onSaved={() => void reload()} />}
          </>
        )}
      </div>
    </div>
  )
}

/** A cluster's "Home Assistant" tab: the houses linked to it (home: also the unlinked ones). */
export function ClusterHomeTab({ clusterId, kind }: { clusterId: string; kind: 'home' | 'remote' }) {
  const { list, error } = useInstances()
  const mine = (list ?? []).filter(i => i.clusterId === clusterId || (kind === 'home' && !i.clusterId))
  const [sel, setSel] = useState<string | null>(null)
  if (error) return <Notice kind="error">{error}</Notice>
  if (!list) return <BusyNote>Reading…</BusyNote>
  if (!mine.length) return <Notice kind="info">No Home Assistant is linked to this server. Link one in Plug-ins → Home Assistant → Settings.</Notice>
  const inst = mine.find(i => i.id === sel) ?? mine[0]
  return (
    <div className="flex flex-col gap-3">
      {mine.length > 1 && (
        <div className="flex flex-wrap gap-2">{mine.map(i => (
          <button key={i.id} onClick={() => setSel(i.id)} className="rounded-md border px-3" style={{ minHeight: 40, borderColor: colour(i), color: i.id === inst.id ? ink(i) : colour(i), background: i.id === inst.id ? colour(i) : 'transparent' }}>{i.name}</button>
        ))}</div>
      )}
      <StatusLine i={inst} />
      <DevicesView key={inst.id} inst={inst} />
    </div>
  )
}

/** For the Command center's panels: the houses beside each cluster, as links. */
export function useLinkedHouses() {
  const { list } = useInstances()
  return useCallback((clusterId: string, kind: 'home' | 'remote') =>
    (list ?? []).filter(i => i.clusterId === clusterId || (kind === 'home' && !i.clusterId)), [list])
}
