// =============================================================================
//  HyperProx — Notifications: the bus and the dispatcher
//
//  publish(event) is the only way anything sends a message. It turns the event
//  into a scrubbed message and writes one outbox row per matching channel
//  (enabled, severity at least the channel's minimum, family in its filter).
//  The dispatcher then works the outbox:
//    - vault-only channel while locked → held-locked; on unlock one digest;
//      held rows older than 24 h are dropped;
//    - quiet hours → held-quiet (critical breaks through unless turned off);
//      at the end of the window one digest;
//    - something fired and resolved while held → both dropped;
//    - grouping: the first message goes at once, anything else within 60 s
//      of a send waits for the end of those 60 s and goes as one message;
//    - rate brake: at most 6 messages per 10 minutes, then one "many alerts"
//      message and nothing more until the window clears;
//    - retries 10 s, 1 min, 5 min, then failed; 429 honours Retry-After; any
//      other 4xx, a redirect or a blocked address fails at once. A failing
//      channel is announced to the OTHER channels, never to itself.
//  The outbox is in the database, so an API restart loses nothing: the next
//  dispatcher picks up what is queued. Logs carry ids, kinds and codes only.
// =============================================================================

import { buildRequest } from './adapters'
import { brakeMessage, digestMessage, groupMessage, toMessage } from './render'
import type { ChannelSecrets } from './secrets'
import type { NotifyStore, NewOutbox } from './store'
import {
  familyOf, severityRank,
  type ChannelRecord, type ChannelSecret, type DeliveryResult, type NotifyEventInput, type NotifyMessage, type OutboxRecord,
  type QuietHours, type SendOutcome, type Transport,
} from './types'

export const GROUP_WINDOW_MS = 60_000
export const BRAKE_WINDOW_MS = 10 * 60_000
export const BRAKE_MAX = 6
export const RETRY_DELAYS_MS = [10_000, 60_000, 300_000]
export const HELD_MAX_AGE_MS = 24 * 3_600_000
export const KEEP_HISTORY_MS = 30 * 24 * 3_600_000
const MAX_429_ATTEMPTS = 8

/** A channel that is not a database row: the old YAML webhooks, until they are seeded (see migrate.ts). */
export interface VirtualChannel { channel: ChannelRecord; secret: ChannelSecret }

export interface NotifyCoreDeps {
  store: NotifyStore
  secrets: ChannelSecrets
  transport: Transport
  publicUrl: () => string | undefined
  now?: () => Date
  log?: (m: string) => void
  virtualChannels?: () => Promise<VirtualChannel[]>
  /** A channel's whole pass (DNS, connect, retries bookkeeping) may take at most this long (default 30 s). */
  channelTimeoutMs?: number
  /** Work the outbox shortly after each publish (default). Tests call tick() themselves. */
  autoKick?: boolean
}

export interface PublishOptions {
  /** Do not deliver to these channels (a failing channel is not told about itself). */
  exclude?: string[]
  /** Only these channels. */
  only?: string[]
}

export function matches(c: Pick<ChannelRecord, 'enabled' | 'minSeverity' | 'eventFilter'>, m: Pick<NotifyMessage, 'type' | 'severity'>): boolean {
  if (!c.enabled) return false
  if (severityRank(m.severity) < severityRank(c.minSeverity)) return false
  if (c.eventFilter === 'all') return true
  const fam = familyOf(m.type)
  return !!fam && Array.isArray(c.eventFilter) && c.eventFilter.includes(fam)
}

function minutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  return h < 24 && mi < 60 ? h * 60 + mi : null
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Whether `now` is inside the window. Days are the day a window starts (Sunday 22:00 → Monday 07:00 is Sunday). */
export function inQuietHours(q: QuietHours | null | undefined, now: Date): boolean {
  if (!q) return false
  const start = minutes(q.start), end = minutes(q.end)
  if (start === null || end === null || start === end) return false
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: q.tz || undefined, hour12: false, hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(now)
  } catch { return false }
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const nowMin = (Number(get('hour')) % 24) * 60 + Number(get('minute'))
  const inside = start < end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end
  if (!inside) return false
  if (!q.days || !q.days.length) return true
  let day = DAYS.indexOf(get('weekday'))
  if (start > end && nowMin < end) day = (day + 6) % 7
  return q.days.includes(day)
}

/** What the page shows for a delivery. */
export function describeResult(r: Pick<DeliveryResult, 'ok' | 'status' | 'code'>): string {
  if (r.ok) return `Delivered${r.status ? ` (HTTP ${r.status})` : ''}`
  switch (r.code) {
    case 'redirect':        return `Refused: the address redirects${r.status ? ` (HTTP ${r.status})` : ''}; HyperProx does not follow redirects`
    case 'blocked-address': return 'Blocked: that address is on a private or reserved network'
    case 'blocked-url':     return 'Blocked: that address is not allowed for this kind of channel'
    case 'TimeoutError': case 'ETIMEDOUT': return 'No answer within 10 seconds'
    case 'ENOTFOUND': case 'EAI_AGAIN':   return 'Could not find that host'
    case 'locked':          return 'Waiting: HyperProx is locked and this channel is stored in the vault'
  }
  if (r.status) return `Refused: HTTP ${r.status}`
  return `Could not connect${r.code ? ` (${r.code})` : ''}`
}

type Target = { channel: ChannelRecord; secret: ChannelSecret | null; virtual: boolean }

export class NotifyCore {
  private running: Promise<void> | null = null
  private again = false
  private kickTimer: NodeJS.Timeout | null = null
  private lastPrune = 0
  /** Channels whose previous pass has not finished (a hung receiver): skipped until it does. */
  private busy = new Set<string>()

  constructor(private readonly d: NotifyCoreDeps) {}

  private now(): Date { return this.d.now?.() ?? new Date() }
  private log(m: string): void { this.d.log?.(`[notify] ${m}`) }

  /** Every channel an event could go to: database rows plus the not-yet-seeded legacy settings. */
  async targets(): Promise<Target[]> {
    const rows = await this.d.store.listChannels()
    const out: Target[] = rows.map(channel => ({ channel, secret: null, virtual: false }))
    for (const v of (await this.d.virtualChannels?.().catch(() => [])) ?? []) out.push({ channel: v.channel, secret: v.secret, virtual: true })
    return out
  }

  private secretFor(t: Target): ChannelSecret | null {
    return t.virtual ? t.secret : this.d.secrets.get(t.channel)
  }

  private readable(t: Target): boolean {
    return t.virtual || this.d.secrets.readable(t.channel)
  }

  /** The only way anything sends a message. Never throws: a publisher must not fail because a channel did. */
  async publish(e: NotifyEventInput, o: PublishOptions = {}): Promise<NotifyMessage | null> {
    try {
      const now = this.now()
      const msg = toMessage(e, { publicUrl: this.d.publicUrl(), now })
      const targets = (await this.targets()).filter(t =>
        matches(t.channel, msg) && !(o.exclude ?? []).includes(t.channel.id) && (!o.only || o.only.includes(t.channel.id)))
      if (!targets.length) return msg

      let dropIds: string[] = []
      const dropFor = new Set<string>()
      if (msg.resolved && msg.fingerprint) {
        // Fired and resolved while held: nothing is left to do, so neither is sent.
        const held = (await this.d.store.pendingOutbox(now)).filter(r =>
          r.fingerprint === msg.fingerprint && !r.resolved && (r.status === 'held-quiet' || r.status === 'held-locked'))
        dropIds = held.map(r => r.id)
        for (const r of held) dropFor.add(r.channelId)
      }
      const rows: NewOutbox[] = targets.map(t => ({
        eventId: msg.id, channelId: t.channel.id, type: msg.type, severity: msg.severity,
        fingerprint: msg.fingerprint ?? null, resolved: msg.resolved, payload: msg,
        status: dropFor.has(t.channel.id) ? 'dropped' : 'queued', createdAt: now, nextAttemptAt: now,
      }))
      if (dropIds.length) await this.d.store.updateOutbox(dropIds, { status: 'dropped' })
      await this.d.store.addOutbox(rows)
      this.kick()
      return msg
    } catch (err) {
      this.log(`could not queue ${e.type}: ${(err as any)?.code ?? (err as Error)?.name ?? 'error'}`)
      return null
    }
  }

  /** Work the outbox soon (debounced). */
  kick(): void {
    if (this.d.autoKick === false || this.kickTimer) return
    this.kickTimer = setTimeout(() => { this.kickTimer = null; void this.tick() }, 250)
    this.kickTimer.unref?.()
  }

  /** One pass over the outbox. One at a time; a call while one runs makes it run once more. */
  async tick(): Promise<void> {
    if (this.running) { this.again = true; return this.running }
    this.running = (async () => {
      do {
        this.again = false
        try { await this.pass() } catch (err) { this.log(`dispatch pass failed: ${(err as any)?.code ?? (err as Error)?.name ?? 'error'}`) }
      } while (this.again)
    })().finally(() => { this.running = null })
    return this.running
  }

  private async pass(): Promise<void> {
    const now = this.now()
    const store = this.d.store
    const pending = await store.pendingOutbox(now)
    if (now.getTime() - this.lastPrune > 3_600_000) {
      this.lastPrune = now.getTime()
      await store.pruneOutbox(new Date(now.getTime() - KEEP_HISTORY_MS)).catch(() => 0)
    }
    if (!pending.length) return
    const targets = new Map((await this.targets()).map(t => [t.channel.id, t]))
    const byChannel = new Map<string, OutboxRecord[]>()
    for (const r of pending) byChannel.set(r.channelId, [...(byChannel.get(r.channelId) ?? []), r])

    // Channels are independent: each is worked at the same time, and a slow or hung one is given up on
    // after channelTimeoutMs so the others are not held behind it. A channel still busy from an earlier
    // pass is skipped, so its rows are never sent twice at once.
    const limit = this.d.channelTimeoutMs ?? 30_000
    await Promise.all([...byChannel].map(async ([channelId, rows]) => {
      if (this.busy.has(channelId)) return
      const t = targets.get(channelId)
      if (!t || !t.channel.enabled) { await store.updateOutbox(rows.map(r => r.id), { status: 'dropped' }); return }
      this.busy.add(channelId)
      const work = this.channelPass(t, rows, now)
        .catch(err => this.log(`channel ${channelId} pass failed: ${(err as any)?.code ?? (err as Error)?.name ?? 'error'}`))
        .finally(() => this.busy.delete(channelId))
      let timer: NodeJS.Timeout | undefined
      const late = new Promise<void>(res => { timer = setTimeout(() => { this.log(`channel ${channelId} (${t.channel.kind}) is slow; moving on`); res() }, limit) })
      await Promise.race([work, late])
      clearTimeout(timer)
    }))
  }

  private async channelPass(t: Target, rows: OutboxRecord[], now: Date): Promise<void> {
    const store = this.d.store
    const ch = t.channel
    const stale = rows.filter(r => r.status !== 'queued' && now.getTime() - r.createdAt.getTime() > HELD_MAX_AGE_MS)
    if (stale.length) await store.updateOutbox(stale.map(r => r.id), { status: 'dropped' })
    rows = rows.filter(r => !stale.includes(r))

    if (!this.readable(t)) {
      const hold = rows.filter(r => r.status !== 'held-locked')
      if (hold.length) await store.updateOutbox(hold.map(r => r.id), { status: 'held-locked' })
      return
    }
    const quiet = inQuietHours(ch.quietHours, now)
    const breaks = ch.quietHours?.criticalBreaksThrough !== false
    const lockedDigest: OutboxRecord[] = [], quietDigest: OutboxRecord[] = [], fresh: OutboxRecord[] = [], toHold: OutboxRecord[] = []
    for (const r of rows) {
      const through = r.severity === 'critical' && breaks
      if (quiet && !through) { if (r.status !== 'held-quiet') toHold.push(r); continue }
      if (r.status === 'held-locked') lockedDigest.push(r)
      else if (r.status === 'held-quiet') quietDigest.push(r)
      else fresh.push(r)
    }
    if (toHold.length) await store.updateOutbox(toHold.map(r => r.id), { status: 'held-quiet' })

    const ctx = { publicUrl: this.d.publicUrl(), now }
    const sends: Array<{ rows: OutboxRecord[]; msg: NotifyMessage }> = []
    if (lockedDigest.length) sends.push({ rows: lockedDigest, msg: lockedDigest.length === 1 ? lockedDigest[0].payload : digestMessage(lockedDigest.map(r => r.payload), 'locked', ctx) })
    if (quietDigest.length) sends.push({ rows: quietDigest, msg: digestMessage(quietDigest.map(r => r.payload), 'quiet', ctx) })
    if (fresh.length) {
      const recent = await store.sentSince(ch.id, new Date(now.getTime() - GROUP_WINDOW_MS))
      const last = recent.reduce((a, r) => Math.max(a, r.sentAt?.getTime() ?? 0), 0)
      if (last && !sends.length) {
        // Something went out less than a minute ago: wait for the end of that minute, then send what gathered as one.
        const at = new Date(last + GROUP_WINDOW_MS)
        const wait = fresh.filter(r => r.nextAttemptAt < at)
        if (wait.length) await store.updateOutbox(wait.map(r => r.id), { nextAttemptAt: at })
      } else {
        sends.push({ rows: fresh, msg: fresh.length === 1 ? fresh[0].payload : groupMessage(fresh.map(r => r.payload), ctx) })
      }
    }

    let offset = 0
    for (const s of sends) {
      const at = new Date(now.getTime() + offset++)
      if (await this.braked(t, s.rows, at)) continue
      await this.deliver(t, s.rows, s.msg, at)
    }
  }

  /** The rate brake. True when these rows were dropped instead of sent. */
  private async braked(t: Target, rows: OutboxRecord[], at: Date): Promise<boolean> {
    const store = this.d.store
    const recent = await store.sentSince(t.channel.id, new Date(at.getTime() - BRAKE_WINDOW_MS))
    const sends = new Set(recent.filter(r => r.type !== 'notify.brake').map(r => r.sentAt!.getTime()))
    if (sends.size < BRAKE_MAX) return false
    await store.updateOutbox(rows.map(r => r.id), { status: 'dropped', errorCode: 'rate-brake' })
    if (!recent.some(r => r.type === 'notify.brake')) {
      const msg = brakeMessage({ publicUrl: this.d.publicUrl(), now: at })
      const [row] = await store.addOutbox([{
        eventId: msg.id, channelId: t.channel.id, type: msg.type, severity: msg.severity, fingerprint: null, resolved: false,
        payload: msg, status: 'queued', createdAt: at, nextAttemptAt: at,
      }])
      await this.deliver(t, [row], msg, at)
    }
    return true
  }

  private async deliver(t: Target, rows: OutboxRecord[], msg: NotifyMessage, at: Date): Promise<void> {
    const store = this.d.store
    const ch = t.channel
    const secret = this.secretFor(t)
    if (!secret) { await store.updateOutbox(rows.map(r => r.id), { status: 'held-locked' }); return }
    let out: SendOutcome
    try {
      out = await this.d.transport(buildRequest(ch.kind, secret, ch.nonSecret, msg, at), { kind: ch.kind, lanOverride: ch.lanOverride })
    } catch (err) {
      out = { ok: false, code: (err as any)?.code ?? 'error' }
    }
    const ids = rows.map(r => r.id)
    const result: DeliveryResult = { ok: out.ok, ...(out.status ? { status: out.status } : {}), ...(out.code ? { code: out.code } : {}), at: at.toISOString() }
    if (out.ok) {
      await store.updateOutbox(ids, { status: 'sent', sentAt: at, httpStatus: out.status ?? null, errorCode: null })
      if (!t.virtual) await store.updateChannel(ch.id, { lastResult: result, lastSentAt: at, failingSince: null }).catch(() => undefined)
      return
    }
    const attempts = Math.max(...rows.map(r => r.attempts)) + 1
    const patch = { attempts, httpStatus: out.status ?? null, errorCode: out.code ?? null }
    const status = out.status ?? 0
    let final = false
    if (status === 429) {
      if (attempts >= MAX_429_ATTEMPTS) final = true
      else await store.updateOutbox(ids, { ...patch, status: 'queued', nextAttemptAt: new Date(at.getTime() + Math.min(3600, out.retryAfterSec ?? 60) * 1000) })
    } else if ((status >= 300 && status < 500) || out.code === 'redirect' || out.code === 'blocked-address' || out.code === 'blocked-url') {
      final = true   // configuration, not luck
    } else if (attempts > RETRY_DELAYS_MS.length) {
      final = true
    } else {
      await store.updateOutbox(ids, { ...patch, status: 'queued', nextAttemptAt: new Date(at.getTime() + RETRY_DELAYS_MS[attempts - 1]) })
    }
    this.log(`delivery to channel ${ch.id} (${ch.kind}) ${final ? 'failed' : 'will retry'}: ${out.status ? `HTTP ${out.status}` : out.code ?? 'error'}`)
    if (t.virtual) { if (final) await store.updateOutbox(ids, { ...patch, status: 'failed' }); return }
    await store.updateChannel(ch.id, { lastResult: result }).catch(() => undefined)
    if (!final) return
    await store.updateOutbox(ids, { ...patch, status: 'failed' })
    if (!ch.failingSince) {
      await store.updateChannel(ch.id, { failingSince: at }).catch(() => undefined)
      await this.publish({
        type: 'notify.channel.failing', severity: 'warning',
        title: `Alerts to ${ch.name} are failing`,
        lines: [`HyperProx could not deliver to this channel: ${describeResult(result)}.`, 'Check it under Settings, Notifications.'],
        link: '/settings/notifications', where: 'Settings, Notifications page',
        subject: { kind: 'channel', name: ch.name },
      }, { exclude: [ch.id] })
    }
  }

  /** Stop the debounce timer (tests, shutdown). */
  stop(): void { if (this.kickTimer) { clearTimeout(this.kickTimer); this.kickTimer = null } }
}
