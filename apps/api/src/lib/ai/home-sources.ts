// =============================================================================
//  HyperProx — knowledge sources for what is attached to the home HyperProx
//
//  Each NAS (QNAP), the alerts Prometheus has firing and what the alert forwarder
//  did with them, the notification channels, every Home Assistant house by room,
//  the websites HyperProx made, and their visitor figures. Every one is read-only
//  and labelled with the NAS, house or site it is about, and each answers its
//  common questions by code ("is my NAS healthy", "which disk is failing", "what
//  alerts are firing", "why is the fan loud on node2", "which lights are on in the
//  living room", "is my website up", "how many visitors did <site> get today").
//
//  What the person may see decides what is read: a viewer gets no NAS serial
//  numbers, no security device states, and no notification channels or websites
//  (both are admin pages). Summaries never carry an address, a MAC, a URL of a
//  channel, a token or a password: the readers below never put one in, and every
//  line also goes through stripAddresses.
// =============================================================================

import type { AskSource, SourceSummary } from './ask'
import { LOCKED_NOTE } from './ask'
import type { CertLite } from './ask-sources'
import { hasRole, type Role } from '../roles'
import { stripAddresses } from '../redact-addresses'
import type { QnapReading } from '../qnap/parse'
import { conditionsOf, type Condition } from '../qnap/alerts'
import type { PromAlert, ForwarderState } from '../alerts/forwarder'
import { wording, placeOf, toSeverity, duration } from '../alerts/forwarder'
import type { SiteMetrics, SiteMetricsSource, MetricsRange } from './site-metrics'

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
const clean = (s: string) => stripAddresses(String(s ?? '')).replace(/\s+/g, ' ').trim()
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const low = (s: string) => s.toLowerCase()
const isViewer = (r: Role | undefined) => !r || !hasRole(r, 'operator')
const isAdmin = (r: Role | undefined) => !!r && hasRole(r, 'admin')
const bytes = (b: number | null) => (b === null ? 'unknown' : b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(1)} TB` : `${(b / 1024 ** 3).toFixed(0)} GB`)
/** Whole words of `name` in `prompt`, case-insensitive: "nas1" matches "is nas1 ok", not "nas10". */
const names = (prompt: string, name: string) => !!name && new RegExp(`(^|[^a-z0-9])${esc(low(name))}($|[^a-z0-9])`).test(low(prompt))

// ---------------------------------------------------------------------------
//  QNAP: each NAS
// ---------------------------------------------------------------------------

export interface NasEntry {
  id: string
  name: string
  /** The remote cluster it sits beside, when it is one; null for home. */
  beside: string | null
  diskTempWarnC: number | null
  reading: QnapReading | null
  /** Why it could not be read, in words. */
  error: string | null
}

export interface QnapSourceDeps {
  list(): Promise<NasEntry[]>
  role: Role | undefined
  unlocked(): boolean
}

interface NasFacts { label: string; name: string; conditions: Condition[]; reading: QnapReading | null; error: string | null }

/** What a viewer may see of a reading: no serials, host name, addresses or MACs (lib/qnap's viewerReading). */
export function forViewer(r: QnapReading): QnapReading {
  return {
    ...r, serial: null, hostname: null,
    disks: r.disks.map(d => ({ ...d, serial: null })),
    interfaces: r.interfaces.map(n => ({ ...n, ip: null, mask: null, mac: null })),
  }
}

function nasLines(f: NasFacts, viewer: boolean): string[] {
  const r = f.reading!
  const L = f.label
  const out: string[] = []
  const bad = f.conditions.filter(c => c.severity === 'critical').length
  const health = bad ? 'has a problem' : f.conditions.length ? 'needs attention' : r.health === 'bad' ? 'has a problem' : 'healthy'
  const fw = r.firmware.version ? `firmware ${r.firmware.version}${r.update.available ? `, update ${r.update.version ?? ''} available`.replace(/ ,/, ',') : r.update.available === false ? ', up to date' : ''}` : 'firmware unknown'
  out.push(`${L}: ${health}; ${r.model ?? 'model unknown'}, ${fw}${r.uptimeSec !== null ? `, up ${Math.floor(r.uptimeSec / 86400)} days` : ''}.`)
  if (r.disks.length) out.push(`${L} disks: ` + r.disks.map(d => {
    const smart = d.smartText ?? d.smart ?? 'unknown'
    const serial = !viewer && d.serial && (d.smart === 'bad' || d.smart === 'warning') ? `, serial ${d.serial}` : ''
    const test = d.lastTest.status ? `, last test ${[d.lastTest.type, d.lastTest.status].filter(Boolean).join(' ')}` : ''
    return `bay ${d.bay} ${d.model ?? 'disk'}${d.capacity ? ` ${d.capacity}` : ''}, SMART ${smart}${d.tempC !== null ? `, ${d.tempC} °C` : ''}${test}${serial}`
  }).join('; ') + '.')
  if (r.volumes.length) out.push(`${L} volumes: ` + r.volumes.map(v => {
    const pct = v.totalBytes && v.usedBytes !== null ? `${Math.round((v.usedBytes / v.totalBytes) * 100)}% used, ${bytes(v.freeBytes)} free` : 'size unknown'
    return `${v.name} ${v.status ?? v.health ?? ''}`.trim() + ` (${pct})`
  }).join('; ') + '.')
  const temps = [r.sysTempC !== null ? `system ${r.sysTempC} °C` : '', r.cpuTempC !== null ? `CPU ${r.cpuTempC} °C` : ''].filter(Boolean)
  const fans = r.fans.map(x => `fan ${x.index} ${x.rpm !== null ? `${x.rpm} rpm` : x.ok === false ? 'stopped' : 'unknown'}`)
  if (temps.length || fans.length) out.push(`${L} temperatures: ${[...temps, ...fans].join(', ') || 'not reported'}.`)
  out.push(f.conditions.length ? `${L} alerts: ${f.conditions.map(c => c.title).join('; ')}.` : `${L} alerts: none.`)
  return out.map(clean)
}

export function qnapSummary(list: NasEntry[], role: Role | undefined): SourceSummary {
  if (!list.length) return { headline: 'QNAP: no NAS is added.', lines: ['No QNAP NAS is added to HyperProx. An admin adds one on the QNAP plug-in page.'], data: { nas: [] } }
  const viewer = isViewer(role)
  const facts: NasFacts[] = list.map(n => {
    const label = n.beside ? `${n.name} (beside ${n.beside})` : n.name
    const reading = n.reading ? (viewer ? forViewer(n.reading) : n.reading) : null
    return { label, name: n.name, reading, error: n.error, conditions: reading ? conditionsOf({ name: label, diskTempWarnC: n.diskTempWarnC }, reading) : [] }
  })
  const lines: string[] = []
  const unread: string[] = []
  for (const f of facts) {
    if (!f.reading) { lines.push(clean(`${f.label}: could not be read (${f.error ?? 'no answer'}).`)); unread.push(f.label); continue }
    lines.push(...nasLines(f, viewer))
  }
  const read = facts.filter(f => f.reading)
  const problems = read.filter(f => f.conditions.length)
  const headline = `QNAP: ${plural(list.length, 'NAS', 'NAS')}, ${problems.length ? `${problems.length} need${problems.length === 1 ? 's' : ''} attention` : read.length ? 'all healthy' : 'none could be read'}.`
  return { headline, lines, unread: unread.length ? unread : undefined, data: { nas: facts } }
}

export function qnapAnswer(prompt: string, s: SourceSummary): string | null {
  const all = ((s.data as { nas?: NasFacts[] })?.nas ?? [])
  if (!all.length) return s.lines[0] ?? null
  const p = low(prompt)
  const named = all.filter(f => names(p, f.name))
  const pick = named.length ? named : all
  const unreadNote = (l: NasFacts[]) => l.filter(f => !f.reading).map(f => clean(`${f.label} could not be read (${f.error ?? 'no answer'}).`))
  if (/\b(fail\w*|failing|dying|broken|bad|smart|which (disk|drive|bay))\b/.test(p) && /\b(disks?|drives?|bays?|hdds?|ssds?|smart)\b/.test(p)) {
    const out: string[] = []
    for (const f of pick.filter(x => x.reading)) {
      const bad = f.reading!.disks.filter(d => d.smart === 'bad' || d.smart === 'warning')
      out.push(bad.length
        ? `${f.label}: ` + bad.map(d => `disk ${d.bay}${d.model ? ` (${d.model})` : ''} SMART says ${d.smartText ?? d.smart}${d.serial ? `, serial ${d.serial}` : ''}`).join('; ') + '.'
        : `${f.label}: no disk reports a SMART problem (${plural(f.reading!.disks.length, 'disk')} checked).`)
    }
    return [...out, ...unreadNote(pick)].map(clean).join(' ') || null
  }
  if (/\b(health\w*|ok|okay|fine|alright|all right|status|doing|problems?|issues?|wrong|alerts?|full|space|temperatures?|hot|firmware|updates?)\b/.test(p)) {
    const out = pick.filter(x => x.reading).map(f => {
      const crit = f.conditions.some(c => c.severity === 'critical')
      return f.conditions.length
        ? `${f.label} ${crit ? 'has a problem' : 'needs attention'}: ${f.conditions.map(c => c.title.replace(` on ${f.label}`, '')).join('; ')}.`
        : `${f.label} is healthy: ${plural(f.reading!.disks.length, 'disk')} with no SMART warning, ${f.reading!.volumes.map(v => v.totalBytes && v.usedBytes !== null ? `${v.name} ${Math.round(100 * v.usedBytes / v.totalBytes)}% used` : v.name).join(', ') || 'no volume reported'}, no alerts.`
    })
    return [...out, ...unreadNote(pick)].map(clean).join(' ') || null
  }
  return null
}

export function qnapSource(d: QnapSourceDeps): AskSource {
  return {
    id: 'qnap', title: 'QNAP NAS', blurb: 'each NAS: health, disks and SMART, volumes, temperatures, firmware, alerts',
    aliases: /\b(qnap|nas|disks?|drives?|bays?|smart|volumes?|raid|firmware)\b/,
    load: async () => (d.unlocked() ? qnapSummary(await d.list(), d.role) : { headline: 'QNAP: locked.', lines: [], locked: true }),
    answer: qnapAnswer,
  }
}

// ---------------------------------------------------------------------------
//  Alerts: what Prometheus has firing, and the forwarder's state
// ---------------------------------------------------------------------------

export interface AlertsDeps {
  /** Prometheus's alerts now; throws when it cannot be reached. */
  fetch(): Promise<PromAlert[]>
  /** What the forwarder has announced, and whether Prometheus was answering. */
  state(): ForwarderState
  notForwarded(): string[]
  clusterName(id: string): string | null
  now?: () => number
}

export interface AlertRow { name: string; place: string; node: string; title: string; plain: string; severity: string; state: 'firing' | 'pending'; sinceMs: number | null; forwarded: boolean; muted: boolean }

/** The hardware alerts (config/prometheus/rules/cluster.yml, group "hardware"). */
export const HARDWARE_ALERTS = ['GPUNotResponding', 'GPUHot', 'CPUHot', 'FanStuckAtMax', 'GPUHighTemperature']

export async function alertsSummary(d: AlertsDeps): Promise<SourceSummary> {
  const now = d.now ? d.now() : Date.now()
  const state = d.state()
  let raw: PromAlert[] | null = null
  try { raw = await d.fetch() } catch { raw = null }
  if (raw === null) {
    const since = state.prometheus.failingSince
    const line = state.prometheus.seenOk
      ? `Prometheus is not answering${since ? ` (since ${duration(now - Date.parse(since))} ago)` : ''}, so alerts cannot be checked right now.`
      : 'Prometheus has never answered here, so no alerts are checked. Monitoring is set up in Settings -> Setup checklist.'
    return { headline: 'Alerts: Prometheus is not answering.', lines: [line], data: { rows: [], prometheus: false } }
  }
  const muted = new Set(d.notForwarded())
  const forwarded = new Set(Object.values(state.firing).map(f => `${f.alertname}|${f.place}`))
  const rows: AlertRow[] = []
  for (const a of raw) {
    if (!a?.labels || (a.state !== 'firing' && a.state !== 'pending')) continue
    const place = clean(placeOf(a.labels, d.clusterName))
    const w = wording(a, place)
    const since = a.activeAt && !Number.isNaN(Date.parse(a.activeAt)) ? now - Date.parse(a.activeAt) : null
    const name = a.labels.alertname ?? 'alert'
    rows.push({ name, place, node: a.labels.scope === 'cluster' || /^CephHealth/.test(a.labels.alertname ?? '') ? '' : low(a.labels.hpx_node || (a.labels.node ?? '').split('@')[0] || ''), title: clean(w.title), plain: clean(w.plain),
      severity: toSeverity(a.labels.severity), state: a.state as 'firing' | 'pending', sinceMs: since, forwarded: forwarded.has(`${name}|${place}`), muted: muted.has(name) })
  }
  const firing = rows.filter(r => r.state === 'firing'), pending = rows.filter(r => r.state === 'pending')
  const lines = [`Prometheus is answering: ${plural(firing.length, 'alert')} firing, ${pending.length} pending.`]
  for (const r of firing.slice(0, 12)) {
    lines.push(`${r.title} (${r.severity}${r.sinceMs !== null ? `, for ${duration(r.sinceMs)}` : ''}): ${r.plain}` +
      (r.muted ? ' Not sent to notifications (on the not-forwarded list).' : r.forwarded ? ' Sent to notifications.' : ''))
  }
  for (const r of pending.slice(0, 6)) lines.push(`Pending, not firing yet: ${r.title}.`)
  return { headline: firing.length ? `Alerts: ${firing.length} firing.` : 'Alerts: none firing.', lines, data: { rows, prometheus: true } }
}

const FAN_LOUD = /\b(fans?)\b.*\b(loud|noisy|noise|full speed|max\w*|roar\w*|spinning|screaming|whin\w*)\b|\b(loud|noisy)\b/

export function alertsAnswer(prompt: string, s: SourceSummary): string | null {
  const d = s.data as { rows: AlertRow[]; prometheus: boolean }
  const p = low(prompt)
  if (!d.prometheus) return s.lines[0]
  const firing = d.rows.filter(r => r.state === 'firing')
  if (FAN_LOUD.test(p) || /\b(hot|overheat\w*|temperature|gpu.*(hung|respond\w*|stuck))\b/.test(p)) {
    const places = [...new Set(d.rows.map(r => r.node).filter(Boolean))]
    const where = places.find(n => names(p, n))
    const hw = firing.filter(r => HARDWARE_ALERTS.includes(r.name) && (!where || r.node === where))
    if (!hw.length) {
      return `No fan, temperature or graphics card alert is firing${where ? ` on ${where}` : ''}. ` +
        'HyperProx reads fan control and temperatures from node_exporter\'s hardware sensors; a node that reports none cannot show a loud fan here.'
    }
    const fan = hw.find(r => r.name === 'FanStuckAtMax')
    const why = hw.filter(r => r !== fan)
    const head = fan ? `${fan.title}: ${fan.plain}` : `${hw[0].title}: ${hw[0].plain}`
    const rest = (fan ? why : hw.slice(1)).map(r => `${r.title}: ${r.plain}`)
    return [head, ...(rest.length ? [`Also firing there, which would make the fans work hard: ${rest.join(' ')}`] : [])].join(' ')
  }
  if (/\b(alerts?|firing|alarms?|warnings?)\b/.test(p)) {
    if (!firing.length) return `No alerts are firing.${d.rows.length ? ` ${plural(d.rows.length, 'alert')} pending.` : ''}`
    return `${plural(firing.length, 'alert')} firing: ` + firing.slice(0, 8).map(r => `${r.title} (${r.plain.replace(/\.$/, '')})`).join('; ') + '.'
  }
  return null
}

export function alertsSource(d: AlertsDeps): AskSource {
  return {
    id: 'alerts', title: 'Alerts', blurb: 'alerts Prometheus has firing now, hardware ones included, and whether they were sent',
    aliases: /\b(alerts?|firing|alarms?|fans?|loud|noisy|hot|overheat\w*|temperatures?|hung)\b/,
    load: () => alertsSummary(d),
    answer: alertsAnswer,
  }
}

// ---------------------------------------------------------------------------
//  Notifications: which channels, what they receive, the last delivery
// ---------------------------------------------------------------------------

/** The fields of a channel view the assistant may read: never its mask, chat id, URL or token. */
export interface ChannelLite {
  name: string; kind: string; enabled: boolean; minSeverity: string; eventFilter: 'all' | string[]
  quietHours: { start: string; end: string } | null; private: boolean
  lastResult: { ok: boolean; status?: number; code?: string; at: string } | null
  lastSentAt: string | null; failingSince: string | null
}

/** A channel view (lib/notify/service.ts ChannelView) cut down to what the assistant may read. */
export function toChannelLite(v: { name: string; kind: string; enabled: boolean; minSeverity: string; eventFilter: unknown; quietHours: { start: string; end: string } | null;
  private: boolean; lastResult: { ok: boolean; status?: number; code?: string; at: string } | null; lastSentAt: string | null; failingSince: string | null }): ChannelLite {
  return {
    name: v.name, kind: v.kind, enabled: v.enabled, minSeverity: v.minSeverity, eventFilter: v.eventFilter === 'all' ? 'all' : Array.isArray(v.eventFilter) ? v.eventFilter.map(String) : 'all',
    quietHours: v.quietHours ? { start: v.quietHours.start, end: v.quietHours.end } : null, private: !!v.private,
    lastResult: v.lastResult ? { ok: v.lastResult.ok, status: v.lastResult.status, code: v.lastResult.code, at: v.lastResult.at } : null,
    lastSentAt: v.lastSentAt, failingSince: v.failingSince,
  }
}

export interface NotifyDeps { channels(): Promise<ChannelLite[] | null>; role: Role | undefined; now?: () => number }

export const ADMIN_ONLY_NOTIFY = 'Notification channels are on an admin page (Settings -> Notifications), so I show them to admins only.'

export function channelLine(c: ChannelLite, now = Date.now()): string {
  const gets = `${c.minSeverity} and above, ${c.eventFilter === 'all' ? 'every kind of event' : `${(c.eventFilter as string[]).join(', ')} events`}`
  const last = c.lastResult
    ? `last delivery ${c.lastResult.ok ? 'delivered' : `failed (${c.lastResult.code ?? (c.lastResult.status ? `HTTP ${c.lastResult.status}` : 'error')})`} ${duration(now - Date.parse(c.lastResult.at))} ago`
    : 'nothing sent yet'
  return clean(`${c.name} (${c.kind}): ${c.enabled ? 'on' : 'off'}; receives ${gets}` + (c.quietHours ? `; quiet ${c.quietHours.start}-${c.quietHours.end}` : '') +
    (c.private ? '; private (may receive sign-in links)' : '') + `; ${last}` + (c.failingSince ? `; failing for ${duration(now - Date.parse(c.failingSince))}` : '') + '.')
}

export function notifySource(d: NotifyDeps): AskSource {
  return {
    id: 'notifications', title: 'Notifications', blurb: 'notification channels, what each receives, last delivery',
    aliases: /\b(notif\w*|channels?|discord|slack|teams|ntfy|gotify|telegram|webhooks?|messages?|pinged|deliver\w*)\b/,
    load: async () => {
      if (!isAdmin(d.role)) return { headline: 'Notifications: admins only.', lines: [ADMIN_ONLY_NOTIFY] }
      const list = await d.channels()
      if (list === null) return { headline: 'Notifications: not running.', lines: ['The notification service is not running, so no channel can be read.'] }
      if (!list.length) return { headline: 'Notifications: no channel.', lines: ['No notification channel is set up. An admin adds one in Settings -> Notifications.'] }
      const now = d.now ? d.now() : Date.now()
      const failing = list.filter(c => c.enabled && c.lastResult && !c.lastResult.ok)
      return { headline: `Notifications: ${plural(list.length, 'channel')}, ${failing.length} failing.`, lines: list.map(c => channelLine(c, now)) }
    },
    answer: (_p, s) => s.lines.join(' '),
  }
}

// ---------------------------------------------------------------------------
//  Home Assistant: every house, devices by room
// ---------------------------------------------------------------------------

export interface HouseDevice { name: string; domain: string; kind: string; tier: 'normal' | 'security'; unavailable: boolean; state: string; unit?: string; deviceClass?: string; current?: number }
export interface HouseRead { name: string; beside: string | null; areas: Array<{ name: string; devices: HouseDevice[] }> | null; error: string | null }

export interface HousesDeps {
  /** Every house, with its devices read as `viewer` (security states hidden) or not. */
  houses(viewer: boolean): Promise<HouseRead[]>
  role: Role | undefined
  unlocked(): boolean
}

/** A security device's state in one word, never more: locked, unlocked, armed (away), disarmed, open, closed. */
export function securityWord(d: HouseDevice): string {
  const s = low(d.state)
  if (s === 'hidden') return 'state hidden for viewers'
  if (d.kind === 'alarm' || d.domain === 'alarm_control_panel') {
    if (s.startsWith('armed_')) return `armed (${s.slice(6).replace(/_/g, ' ')})`
    return ['disarmed', 'triggered', 'arming', 'pending'].includes(s) ? s : 'state unknown'
  }
  if (d.kind === 'lock' || d.domain === 'lock') return ['locked', 'unlocked', 'jammed', 'locking', 'unlocking', 'open'].includes(s) ? s : 'state unknown'
  if (d.domain === 'cover') return ['open', 'closed', 'opening', 'closing'].includes(s) ? s : 'state unknown'
  return ['on', 'off'].includes(s) ? s : 'state unknown'
}

function deviceWord(d: HouseDevice): string {
  if (d.unavailable) return 'unavailable'
  if (d.tier === 'security') return securityWord(d)
  if (d.kind === 'climate') return `${d.state}${d.current !== undefined ? `, ${d.current}°` : ''}`
  return `${String(d.state).slice(0, 24)}${d.unit ? ` ${d.unit}` : ''}`
}

const houseLabel = (h: HouseRead) => (h.beside ? `${h.name} (beside ${h.beside})` : h.name)

export function housesSummary(list: HouseRead[]): SourceSummary {
  if (!list.length) return { headline: 'Home Assistant: no house added.', lines: ['No Home Assistant house is added to HyperProx.'], data: { houses: [] } }
  const lines: string[] = []
  const unread: string[] = []
  for (const h of list) {
    if (!h.areas) { lines.push(clean(`${houseLabel(h)}: could not be read (${h.error ?? 'no answer'}).`)); unread.push(houseLabel(h)); continue }
    for (const a of h.areas) {
      // A long room is split so no line runs on: the prompt is trimmed per line.
      for (let i = 0; i < a.devices.length; i += 12) {
        lines.push(clean(`${houseLabel(h)} · ${a.name}: ` + a.devices.slice(i, i + 12).map(d => `${d.name} ${deviceWord(d)}`).join(', ') + '.'))
      }
    }
  }
  const n = list.reduce((k, h) => k + (h.areas?.reduce((m, a) => m + a.devices.length, 0) ?? 0), 0)
  return { headline: `Home Assistant: ${plural(list.length, 'house')}, ${plural(n, 'device')}.`, lines, unread: unread.length ? unread : undefined, data: { houses: list } }
}

const ROOM_STOP = new Set(['the', 'my', 'house', 'home', 'room'])

export function housesAnswer(prompt: string, s: SourceSummary): string | null {
  const list = ((s.data as { houses?: HouseRead[] })?.houses ?? []).filter(h => h.areas)
  if (!list.length) return null
  const p = low(prompt)
  const named = list.filter(h => names(p, h.name))
  const houses = named.length ? named : list
  const multi = list.length > 1
  const tag = (h: HouseRead, room: string) => (multi ? `${houseLabel(h)} · ${room}` : room)

  // "Which lights are on in the living room?"
  if (/\b(lights?|lamps?)\b/.test(p) && /\b(on|lit|left on)\b/.test(p)) {
    const want = /\bin\s+(?:the\s+)?([a-z][a-z' -]*?)(?=\s+(?:at|in|of|right|now)\b|[?.!,]|$)/.exec(p)?.[1]?.trim()
    const roomOk = (room: string) => !want || low(room) === want || low(room).includes(want) || want.includes(low(room))
    const rooms = houses.flatMap(h => h.areas!.filter(a => roomOk(a.name)).map(a => ({ h, a })))
    if (want && !rooms.length) {
      const all = [...new Set(houses.flatMap(h => h.areas!.map(a => a.name)))]
      if (!ROOM_STOP.has(want)) return `I could not find a room called "${want}". The rooms are: ${all.join(', ')}.`
    }
    const on = rooms.flatMap(({ h, a }) => a.devices.filter(d => d.kind === 'light' && !d.unavailable && low(d.state) === 'on').map(d => ({ h, a, d })))
    const where = want ? `in the ${want}` : ''
    if (!on.length) return `No light is on${where ? ` ${where}` : ''}.`
    const byRoom = new Map<string, string[]>()
    for (const x of on) byRoom.set(tag(x.h, x.a.name), [...(byRoom.get(tag(x.h, x.a.name)) ?? []), x.d.name])
    return [...byRoom].map(([room, l]) => `${room}: ${l.join(', ')} ${l.length === 1 ? 'is' : 'are'} on.`).join(' ')
  }

  // A device named in the question: "is the front door locked?", "is the outside light on?"
  const hits = houses.flatMap(h => h.areas!.flatMap(a => a.devices.filter(d => d.name.length > 2 && names(p, d.name)).map(d => ({ h, a, d }))))
  if (hits.length >= 1 && hits.length <= 3) return hits.map(x => `${x.d.name} (${tag(x.h, x.a.name)}): ${deviceWord(x.d)}.`).join(' ')
  return null
}

export function housesSource(d: HousesDeps): AskSource {
  return {
    id: 'houses', title: 'Home Assistant houses', blurb: 'every house: devices by room and their state, read-only',
    aliases: /\b(lights?|lamps?|rooms?|living room|kitchen|bedroom|hall\w*|garage|doors?|locks?|locked|unlocked|alarm|armed|thermostat|heating|switch(es)?|plugs?|sensors?|blinds?|curtains?|house|houses|home assistant)\b/,
    load: async () => (d.unlocked() ? housesSummary(await d.houses(isViewer(d.role))) : { headline: 'Home Assistant: locked.', lines: [], locked: true }),
    answer: housesAnswer,
  }
}

// ---------------------------------------------------------------------------
//  Web hosting: the sites HyperProx made
// ---------------------------------------------------------------------------

export interface SiteLite { id: string; name: string; kind: 'static-site' | 'wordpress' | string; kindName: string; domain: string | null; url: string | null; vmid: number; node: string; hasVault: boolean }
export interface SiteHealthLite { container: boolean | null; public: { ok: boolean; detail: string } | null }

export interface SitesDeps {
  sites(): Promise<SiteLite[]>
  health(id: string): Promise<SiteHealthLite>
  /** The certificate inventory, or null when it cannot be read (locked). */
  certs(): Promise<CertLite[] | null>
  role: Role | undefined
}

export const ADMIN_ONLY_SITES = 'The Sites page is admin only, so I show websites to admins only.'

interface SiteFacts { site: SiteLite; health: SiteHealthLite; cert: CertLite | null; certsRead: boolean }

/** The six-point standard (ROADMAP "Next" 1), for one site, as it stands in the code today. */
export function sixPoints(s: SiteLite): { has: string[]; missing: string[] } {
  const has: string[] = [], missing: string[] = []
  if (s.domain) has.push('a public address, proxy host and certificate'); else missing.push('a public address (it is LAN only)')
  if (s.kind === 'wordpress') (s.hasVault ? has : missing).push('its login in the vault')
  else has.push('no login to keep (a static site has none)')
  missing.push('a backup job', 'monitoring with alerts', 'a place under the update policy', 'a plug-in panel')
  return { has, missing }
}

function siteLine(f: SiteFacts): string {
  const s = f.site
  const where = s.url ?? 'LAN only'
  // The public address is the site's own and is said as it is; what a probe said about it is cleaned.
  const up = f.health.public ? (f.health.public.ok ? `${s.url} answers` : `${s.url} ${clean(f.health.public.detail)}`) : f.health.container === null ? 'health not checked' : ''
  const ct = f.health.container === null ? '' : f.health.container ? 'the container answers' : 'the container does not answer'
  const cert = !s.domain ? '' : !f.certsRead ? 'certificate not read (locked)' : f.cert?.daysLeft != null ? `certificate ${f.cert.daysLeft} days left (${(f.cert.notAfter ?? '').slice(0, 10)})` : 'no certificate found for it'
  const six = sixPoints(s)
  return `${clean(s.name)}: ${s.kindName}, ${where}, CT ${s.vmid} on ${clean(s.node)}; ${[up, ct, cert].filter(Boolean).join('; ')}. ` +
    `Six-point standard: has ${six.has.join(', ')}; not automatic yet: ${six.missing.join(', ')}.`
}

const certFor = (certs: CertLite[], domain: string | null) =>
  domain ? certs.filter(c => c.names.some(n => low(n) === low(domain) || (n.startsWith('*.') && low(domain).endsWith(low(n.slice(1)))))).sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9))[0] ?? null : null

export async function sitesSummary(d: SitesDeps): Promise<SourceSummary> {
  if (!isAdmin(d.role)) return { headline: 'Websites: admins only.', lines: [ADMIN_ONLY_SITES], data: { sites: [] } }
  const list = await d.sites()
  if (!list.length) return { headline: 'Websites: none yet.', lines: ['HyperProx has made no website yet. New website on the Sites page makes one.'], data: { sites: [] } }
  const certs = await d.certs().catch(() => null)
  const facts: SiteFacts[] = await Promise.all(list.slice(0, 15).map(async site => ({
    site, health: await d.health(site.id).catch(() => ({ container: null, public: null })), cert: certs ? certFor(certs, site.domain) : null, certsRead: certs !== null,
  })))
  const down = facts.filter(f => f.health.public && !f.health.public.ok)
  return { headline: `Websites: ${plural(list.length, 'site')}, ${down.length ? `${down.length} not answering` : 'all answering'}.`, lines: facts.map(siteLine), data: { sites: facts } }
}

export function siteNamed(prompt: string, list: SiteLite[]): SiteLite[] {
  const p = low(prompt)
  return list.filter(s => (s.domain && p.includes(low(s.domain))) || names(p, s.name))
}

export function sitesAnswer(prompt: string, s: SourceSummary): string | null {
  const all = ((s.data as { sites?: SiteFacts[] })?.sites ?? [])
  if (!all.length) return s.lines[0] ?? null
  const p = low(prompt)
  const named = siteNamed(p, all.map(f => f.site))
  const pick = named.length ? all.filter(f => named.includes(f.site)) : all
  if (/\b(certs?|certificates?|ssl|tls|expir\w*)\b/.test(p)) {
    return pick.map(f => {
      if (!f.site.domain) return `${f.site.name} is LAN only, so it has no public certificate.`
      if (!f.certsRead) return `${f.site.name}: ${LOCKED_NOTE}`
      return f.cert?.daysLeft != null ? `The certificate for ${f.site.domain} expires in ${f.cert.daysLeft} days, on ${(f.cert.notAfter ?? '').slice(0, 10)}.` : `I found no certificate for ${f.site.domain} in the inventory.`
    }).join(' ')
  }
  if (/\b(up|down|working|online|offline|reachable|answer\w*|alive|running|broken)\b/.test(p)) {
    return pick.map(f => {
      if (f.health.public) return f.health.public.ok ? `${f.site.name} is up: ${f.site.url} answers.` : `${f.site.name} is not answering at ${f.site.url}: it ${clean(f.health.public.detail)}.`
      if (f.health.container === null) return `${f.site.name}'s health could not be checked.`
      return `${f.site.name} is LAN only; its container ${f.health.container ? 'answers' : 'does not answer'}.`
    }).join(' ')
  }
  if (/\b(six.?point|standard|backed up|backup|monitor\w*|missing|covers?)\b/.test(p)) {
    return pick.map(f => { const x = sixPoints(f.site); return `${f.site.name} has ${x.has.join(', ')}; not automatic yet: ${x.missing.join(', ')}.` }).join(' ')
  }
  return null
}

export function sitesSource(d: SitesDeps, siteWords: string[] = []): AskSource {
  const extra = siteWords.filter(Boolean).map(w => esc(low(w)))
  return {
    id: 'sites', title: 'Websites', blurb: 'the websites HyperProx made: kind, address, guest, health, certificate, six-point standard',
    aliases: new RegExp(`\\b(websites?|web sites?|sites?|blogs?|wordpress|static site|certificates?${extra.length ? '|' + extra.join('|') : ''})\\b`),
    load: () => sitesSummary(d),
    answer: sitesAnswer,
  }
}

// ---------------------------------------------------------------------------
//  Site metrics: visitors, page views, errors, p95, top pages, uptime
// ---------------------------------------------------------------------------

export interface SiteMetricsDeps { metrics: SiteMetricsSource; sites(): Promise<SiteLite[]>; role: Role | undefined }

export const METRICS_NOT_COLLECTED = 'Visitor figures are not collected yet: site metrics are not set up in this HyperProx.'

const RANGE_WORD: Record<MetricsRange, string> = { today: 'today', week: 'this week', month: 'this month' }

export function rangeOf(prompt: string): MetricsRange {
  const p = low(prompt)
  return /\b(this|last|past)\s+month\b|\bmonthly\b|\b30 days\b/.test(p) ? 'month' : /\b(this|last|past)\s+week\b|\bweekly\b|\b7 days\b/.test(p) ? 'week' : 'today'
}

export function metricsSentence(name: string, m: SiteMetrics): string {
  const extra = [m.errorRate !== null ? `error rate ${(m.errorRate * 100).toFixed(1)}%` : '', m.p95Ms !== null ? `p95 ${Math.round(m.p95Ms)} ms` : '', m.uptimePct !== null ? `uptime ${m.uptimePct.toFixed(2)}%` : ''].filter(Boolean)
  return `${name} had ${plural(m.visitors, 'visitor')} and ${plural(m.pageViews, 'page view')} ${RANGE_WORD[m.range]}${extra.length ? ` (${extra.join(', ')})` : ''}.`
}

export function siteMetricsSource(d: SiteMetricsDeps): AskSource {
  return {
    id: 'site-metrics', title: 'Site metrics', blurb: 'visitors, page views, error rate, p95, top pages and referrers, uptime per website',
    aliases: /\b(visitors?|visits?|page ?views?|traffic|hits|referr\w*|top pages?|popular|p95|latency|response times?|error rate|uptime)\b/,
    load: async () => {
      if (!isAdmin(d.role)) return { headline: 'Site metrics: admins only.', lines: [ADMIN_ONLY_SITES], data: { rows: [], available: true } }
      if (!d.metrics.available()) return { headline: 'Site metrics: not collected.', lines: [METRICS_NOT_COLLECTED], data: { rows: [], available: false } }
      const list = (await d.sites()).slice(0, 10)
      const rows = await Promise.all(list.map(async site => ({
        site,
        by: Object.fromEntries(await Promise.all((['today', 'week', 'month'] as MetricsRange[]).map(async r => [r, await d.metrics.siteMetrics(site.id, r).catch(() => null)] as const))) as Record<MetricsRange, SiteMetrics | null>,
      })))
      const lines = rows.flatMap(r => (['today', 'week'] as MetricsRange[]).map(k => r.by[k] ? metricsSentence(r.site.domain ?? r.site.name, r.by[k]!) : `${r.site.name}: no figures ${RANGE_WORD[k]}.`))
      return { headline: `Site metrics: ${plural(rows.length, 'site')}.`, lines: lines.map(clean), data: { rows, available: true } }
    },
    answer: (prompt, s) => {
      const d0 = s.data as { rows: Array<{ site: SiteLite; by: Record<MetricsRange, SiteMetrics | null> }>; available: boolean }
      if (!d0.available || !d0.rows.length) return s.lines[0] ?? null
      const named = siteNamed(prompt, d0.rows.map(r => r.site))
      const pick = named.length ? d0.rows.filter(r => named.includes(r.site)) : d0.rows.length === 1 ? d0.rows : null
      if (!pick) return `Which site? I have figures for ${d0.rows.map(r => r.site.domain ?? r.site.name).join(', ')}.`
      const range = rangeOf(prompt), p = low(prompt)
      return pick.map(r => {
        const m = r.by[range], name = r.site.domain ?? r.site.name
        if (!m) return `${name} has no figures ${RANGE_WORD[range]}.`
        if (/\btop pages?|popular|most (visited|viewed)\b/.test(p)) return `${name}'s top pages ${RANGE_WORD[range]}: ${m.topPages.slice(0, 5).map(x => `${x.path} (${x.views})`).join(', ') || 'none recorded'}.`
        if (/\breferr\w*|where .* from\b/.test(p)) return `${name}'s top referrers ${RANGE_WORD[range]}: ${m.topReferrers.slice(0, 5).map(x => `${x.source} (${x.visits})`).join(', ') || 'none recorded'}.`
        return clean(metricsSentence(name, m))
      }).join(' ')
    },
  }
}
