// =============================================================================
//  HyperProx — Notifications: the service
//
//  Channels (create, edit, delete, Send test), the bus (publish), the lock
//  alert's direct path, and the one-time seeding of the old settings. Routes
//  and publishers talk to this; nothing else sends a message.
//
//  Secrets go into the vault (or the locked-channels file) and never come back
//  out through here: views carry a mask, results carry a status and a code.
// =============================================================================

import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import type { PrismaClient } from '@prisma/client'
import { buildRequest, TELEGRAM_CHAT, TELEGRAM_TOKEN } from './adapters'
import { NotifyCore, describeResult, inQuietHours, matches, type PublishOptions } from './dispatcher'
import {
  SEED_IDS, YAML_STATE, groupByUrl, legacyShape, legacySourceList, legacyVirtualChannels, lockSource, lowerSeverity,
  sameUrl, seedId, seedName, unionFilter, type LegacySources,
} from './migrate'
import { testMessage, toMessage } from './render'
import { ChannelSecrets, LockedChannelsFile, maskSecret, vaultSecretBackend, type LockedEntry } from './secrets'
import { checkChannelUrl, classifyAddress, guardedSend, withTimeout } from './ssrf'
import { PrismaNotifyStore, type NotifyStore } from './store'
import {
  CHANNEL_KINDS, FAMILIES, LOCKED_OK, SELF_HOSTABLE, isFamily, isKind, isSeverity,
  type ChannelKind, type ChannelRecord, type ChannelSecret, type DeliveryResult, type EventFilter, type NotifyEventInput,
  type QuietHours, type SendOutcome, type Severity, type Transport,
} from './types'

type Env = Record<string, string | undefined>
export interface Actor { email: string; role: 'owner' | 'admin' | 'operator' | 'viewer' }

export class NotifyInputError extends Error { name = 'NotifyInputError' }
export class NotifyNotFoundError extends Error { name = 'NotifyNotFoundError' }
export class NotifyForbiddenError extends Error { name = 'NotifyForbiddenError' }
export class NotifyUnavailableError extends Error { name = 'NotifyUnavailableError' }

export interface ChannelInput {
  name?: string
  kind?: ChannelKind
  enabled?: boolean
  minSeverity?: Severity
  eventFilter?: EventFilter
  quietHours?: QuietHours | null
  lanOverride?: boolean
  usableWhileLocked?: boolean
  /** Only private channels receive sign-in links. */
  private?: boolean
  chatId?: string
  // Secrets: required on create; blank or absent on edit keeps the stored value.
  url?: string
  token?: string
  botToken?: string
  signingSecret?: string
  clearToken?: boolean
  clearSigningSecret?: boolean
}

export interface ChannelView {
  id: string; name: string; kind: ChannelKind; enabled: boolean; minSeverity: Severity; eventFilter: EventFilter
  quietHours: QuietHours | null; lanOverride: boolean; usableWhileLocked: boolean; private: boolean; chatId: string | null
  mask: string; secretReadable: boolean; hasToken: boolean; hasSigningSecret: boolean
  lastResult: (DeliveryResult & { text: string }) | null; lastSentAt: string | null; failingSince: string | null
  seededFrom: string | null; createdBy: string; createdAt: string; updatedAt: string
}

export interface DeliveryView {
  id: string; channelId: string; type: string; severity: Severity; title: string; status: string; attempts: number
  httpStatus: number | null; errorCode: string | null; createdAt: string; sentAt: string | null; text: string
}

export interface NotifyServiceDeps {
  store: NotifyStore
  secrets: ChannelSecrets
  transport: Transport
  legacy: LegacySources
  env?: Env
  publicUrl?: () => string | undefined
  isPrivate?: (url: string) => Promise<boolean>
  now?: () => Date
  log?: (m: string) => void
  /** Runs before the YAML seeding at an Owner sign-in (the credential migration). */
  beforeOwnerSeed?: () => Promise<unknown>
  autoKick?: boolean
  tickMs?: number
}

export function publicUrlFrom(env: Env): string | undefined {
  const v = env.HYPERPROX_PUBLIC_URL
  if (!v) return undefined
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:' ? v.replace(/\/+$/, '') : undefined
  } catch { return undefined }
}

/** Whether a URL's host is (or resolves to) a private or loopback address. */
export async function resolvesPrivate(url: string): Promise<boolean> {
  const h = new URL(url).hostname.replace(/^\[|\]$/g, '')
  const addrs = classifyAddress(h) !== 'blocked' ? [h] : (await withTimeout(dns.lookup(h, { all: true }), 5_000, 'DNSTimeout')).map(a => a.address)
  return addrs.some(a => { const c = classifyAddress(a); return c === 'private' || c === 'loopback' })
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const newId = () => `ch_${crypto.randomBytes(8).toString('hex')}`

export class NotifyService {
  readonly core: NotifyCore
  private readonly d: NotifyServiceDeps
  private yamlSeeded: boolean | null = null
  private timer: NodeJS.Timeout | null = null
  private seeding: Promise<void> | null = null

  constructor(d: NotifyServiceDeps) {
    this.d = d
    this.core = new NotifyCore({
      store: d.store, secrets: d.secrets, transport: d.transport, publicUrl: () => this.publicUrl(), now: d.now, log: d.log,
      autoKick: d.autoKick, virtualChannels: () => this.virtualChannels(),
    })
  }

  private env(): Env { return this.d.env ?? process.env }
  private publicUrl(): string | undefined { return this.d.publicUrl ? this.d.publicUrl() : publicUrlFrom(this.env()) }
  private now(): Date { return this.d.now?.() ?? new Date() }
  private log(m: string): void { this.d.log?.(`[notify] ${m}`) }
  private isPrivate(url: string): Promise<boolean> { return (this.d.isPrivate ?? resolvesPrivate)(url) }

  // --- Bus -------------------------------------------------------------------

  publish(e: NotifyEventInput, o?: PublishOptions) { return this.core.publish(e, o) }

  private async virtualChannels() {
    if (this.yamlSeeded === null) {
      try { this.yamlSeeded = !!(await this.d.store.getState(YAML_STATE)) } catch { return [] }
    }
    return this.yamlSeeded ? [] : legacyVirtualChannels(this.d.legacy, u => this.isPrivate(u))
  }

  // --- Start-up --------------------------------------------------------------

  /**
   * Seed the lock channel (file only, so it works with Postgres down), copy file channels that have no
   * database row yet, say which old keys are now ignored, and start working the outbox.
   */
  async start(): Promise<void> {
    await this.seedLockChannel().catch(e => this.log(`lock alert channel was not moved: ${(e as Error)?.name ?? 'error'}`))
    await this.reconcile().catch(() => undefined)
    try { this.yamlSeeded = !!(await this.d.store.getState(YAML_STATE)) } catch { this.yamlSeeded = null }
    if (this.yamlSeeded) {
      for (const s of legacySourceList(this.d.legacy)) this.log(`${s.yamlKey} is no longer read: it is a channel under Settings, Notifications`)
    }
    if (this.lockSeeded() && this.env().LOCK_ALERT_URL) {
      this.log('LOCK_ALERT_URL in .env is no longer read: the lock alert is a channel under Settings, Notifications')
    }
    if (!this.timer && this.d.tickMs !== 0) {
      this.timer = setInterval(() => { void this.reconcile().catch(() => undefined).then(() => this.core.tick()) }, this.d.tickMs ?? 5_000)
      this.timer.unref?.()
    }
    void this.core.tick()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.core.stop()
  }

  lockSeeded(): boolean {
    return !!this.d.secrets.file.read().seeded.lockAlert
  }

  private async seedLockChannel(): Promise<void> {
    const file = this.d.secrets.file
    if (file.read().seeded.lockAlert) return
    const src = lockSource(this.env(), this.d.legacy)
    if (src) {
      const shape = await legacyShape(src.url, src.kind, u => this.isPrivate(u))
      if (!shape) { this.log('the lock alert address cannot be used as a channel; it keeps working from .env'); return }
      file.upsert({
        id: SEED_IDS.lock, name: 'Lock alerts', kind: shape.kind, enabled: true, minSeverity: 'critical', eventFilter: ['vault'],
        quietHours: null, lanOverride: shape.lanOverride, nonSecret: {},
      }, { url: src.url, ...(src.token && (shape.kind === 'ntfy' || shape.kind === 'gotify') ? { token: src.token } : {}) })
      this.log(`the lock alert is now the channel "Lock alerts" (${shape.kind}, usable while locked) under Settings, Notifications`)
    }
    file.markSeeded('lockAlert', this.now())
  }

  /** Channels in the locked file with no database row (seeded while Postgres was down). */
  private async reconcile(): Promise<void> {
    const entries = Object.values(this.d.secrets.file.read().channels)
    if (!entries.length) return
    const have = new Set((await this.d.store.listChannels()).map(c => c.id))
    for (const e of entries) {
      if (have.has(e.id)) continue
      await this.d.store.createChannel({
        id: e.id, name: e.name, kind: e.kind, enabled: e.enabled, minSeverity: e.minSeverity, eventFilter: e.eventFilter,
        quietHours: e.quietHours, lanOverride: e.lanOverride, usableWhileLocked: true, private: false, nonSecret: e.nonSecret,
        seededFrom: e.id === SEED_IDS.lock ? 'lock-alert' : null, createdBy: 'migration',
      })
    }
  }

  /** The first Owner sign-in: the YAML webhooks become channels, once. Never throws. */
  seedOnOwnerUnlock(): Promise<void> {
    if (this.seeding) return this.seeding
    this.seeding = (async () => {
      try {
        await this.d.beforeOwnerSeed?.().catch(() => undefined)
        await this.reconcile().catch(() => undefined)
        await this.seedYaml()
      } catch (e) {
        this.log(`moving the Updates/Certificates webhooks failed (${(e as any)?.code ?? (e as Error)?.name ?? 'error'}); the old settings keep working and the next Owner sign-in tries again`)
      }
    })().finally(() => { this.seeding = null })
    return this.seeding
  }

  private async seedYaml(): Promise<void> {
    const store = this.d.store
    if (await store.getState(YAML_STATE)) { this.yamlSeeded = true; return }
    const moved: string[] = []
    const channels = await store.listChannels()
    for (const g of groupByUrl(legacySourceList(this.d.legacy))) {
      const families = [...new Set(g.sources.flatMap(s => s.families))]
      const min = g.sources.map(s => s.min).reduce(lowerSeverity)
      const existing = channels.find(c => sameUrl(this.d.secrets.get(c)?.url, g.url))
      let where: string
      if (existing) {
        const patched = await store.updateChannel(existing.id, {
          eventFilter: unionFilter(existing.eventFilter, families), minSeverity: lowerSeverity(existing.minSeverity, min),
        })
        this.d.secrets.syncLocked(patched)
        where = `"${existing.name}"`
      } else {
        const shape = await legacyShape(g.url, undefined, u => this.isPrivate(u))
        if (!shape) { this.log(`${g.sources.map(s => s.yamlKey).join(' and ')} cannot be used as a channel; it is left as it is`); continue }
        const id = seedId(g.sources)
        const rec = {
          id, name: seedName(g.sources), kind: shape.kind, enabled: true, minSeverity: min, eventFilter: families as EventFilter,
          quietHours: null, lanOverride: shape.lanOverride, usableWhileLocked: false, private: false, nonSecret: {},
          seededFrom: g.sources.map(s => s.key).join('+'), createdBy: 'migration',
        }
        const now = this.now()
        await this.d.secrets.put({ ...rec, lastResult: null, lastSentAt: null, failingSince: null, createdAt: now, updatedAt: now }, { url: g.url })
        if (!(await store.getChannel(id))) await store.createChannel(rec)
        where = `"${rec.name}"`
      }
      for (const s of g.sources) { moved.push(s.key); this.log(`${s.yamlKey} is now the channel ${where} under Settings, Notifications; the YAML key is no longer read`) }
    }
    await store.setState(YAML_STATE, { at: this.now().toISOString(), moved })
    this.yamlSeeded = true
  }

  // --- The lock alert --------------------------------------------------------

  /**
   * vault.locked goes straight from the locked-channels file to the usable-while-locked channels: no
   * Postgres, no vault. The outbox gets a record afterwards, best effort.
   */
  async deliverLocked(e: NotifyEventInput): Promise<{ result: 'sent' | 'failed' | 'unconfigured'; kinds: string[]; failures: string[] }> {
    const now = this.now()
    const msg = toMessage(e, { publicUrl: this.publicUrl(), now })
    const entries = Object.values(this.d.secrets.file.read().channels).filter(en => matches(en, msg) &&
      !(inQuietHours(en.quietHours, now) && !(msg.severity === 'critical' && en.quietHours?.criticalBreaksThrough !== false)))
    if (!entries.length) return { result: 'unconfigured', kinds: [], failures: [] }
    const results = await Promise.all(entries.map(async (en: LockedEntry) => {
      try {
        return { en, out: await this.d.transport(buildRequest(en.kind, en.secret, en.nonSecret, msg, now), { kind: en.kind, lanOverride: en.lanOverride }) }
      } catch (err) { return { en, out: { ok: false, code: (err as any)?.code ?? 'error' } as SendOutcome } }
    }))
    void (async () => {
      try {
        await this.d.store.addOutbox(results.map(({ en, out }) => ({
          eventId: msg.id, channelId: en.id, type: msg.type, severity: msg.severity, fingerprint: msg.fingerprint ?? null,
          resolved: false, payload: msg, status: out.ok ? 'sent' : 'failed', attempts: 1, httpStatus: out.status ?? null,
          errorCode: out.code ?? null, createdAt: now, nextAttemptAt: now, sentAt: out.ok ? now : null,
        })))
        for (const { en, out } of results) {
          const lastResult: DeliveryResult = { ok: out.ok, ...(out.status ? { status: out.status } : {}), ...(out.code ? { code: out.code } : {}), at: now.toISOString() }
          await this.d.store.updateChannel(en.id, { lastResult, ...(out.ok ? { lastSentAt: now, failingSince: null } : {}) }).catch(() => undefined)
        }
      } catch { /* Postgres down: the message went anyway */ }
    })()
    const ok = results.filter(r => r.out.ok)
    return {
      result: ok.length ? 'sent' : 'failed',
      kinds: ok.map(r => r.en.kind),
      failures: results.filter(r => !r.out.ok).map(r => `${r.en.kind}: ${r.out.status ? `HTTP ${r.out.status}` : r.out.code ?? 'error'}`),
    }
  }

  // --- Channels --------------------------------------------------------------

  private view(c: ChannelRecord): ChannelView {
    const secret = this.d.secrets.get(c)
    return {
      id: c.id, name: c.name, kind: c.kind, enabled: c.enabled, minSeverity: c.minSeverity, eventFilter: c.eventFilter,
      quietHours: c.quietHours, lanOverride: c.lanOverride, usableWhileLocked: c.usableWhileLocked, private: !!c.private, chatId: c.nonSecret.chatId ?? null,
      mask: maskSecret(c.kind, secret, c.nonSecret), secretReadable: !!secret, hasToken: !!secret?.token,
      hasSigningSecret: !!secret?.signingSecret,
      lastResult: c.lastResult ? { ...c.lastResult, text: describeResult(c.lastResult) } : null,
      lastSentAt: iso(c.lastSentAt), failingSince: iso(c.failingSince), seededFrom: c.seededFrom, createdBy: c.createdBy,
      createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
    }
  }

  async listChannels(): Promise<ChannelView[]> {
    return (await this.d.store.listChannels()).map(c => this.view(c))
  }

  async getChannel(id: string): Promise<ChannelView> {
    return this.view(await this.mustGet(id))
  }

  private async mustGet(id: string): Promise<ChannelRecord> {
    const c = await this.d.store.getChannel(id)
    if (!c) throw new NotifyNotFoundError('No such channel')
    return c
  }

  /** Validate an input against what is stored (if anything). Returns the record fields and the secret to store, if it changed. */
  private validate(input: ChannelInput, prev: ChannelRecord | null, actor: Actor):
    { fields: Omit<ChannelRecord, 'id' | 'createdAt' | 'updatedAt' | 'lastResult' | 'lastSentAt' | 'failingSince' | 'seededFrom' | 'createdBy'>; secret: ChannelSecret | null } {
    const bad = (m: string): never => { throw new NotifyInputError(m) }
    const kind = input.kind ?? prev?.kind
    if (!isKind(kind)) bad(`Choose a kind: ${CHANNEL_KINDS.join(', ')}.`)
    const k = kind as ChannelKind
    const name = (input.name ?? prev?.name ?? '').trim()
    if (!name || name.length > 60) bad('Give the channel a name of up to 60 characters.')
    const minSeverity = input.minSeverity ?? prev?.minSeverity ?? 'warning'
    if (!isSeverity(minSeverity)) bad('Minimum severity is info, warning or critical.')
    const eventFilter = input.eventFilter ?? prev?.eventFilter ?? 'all'
    if (eventFilter !== 'all' && (!Array.isArray(eventFilter) || !eventFilter.length || !eventFilter.every(isFamily)))
      bad(`Events are "all" or a list of: ${FAMILIES.join(', ')}.`)
    const quietHours = input.quietHours === undefined ? prev?.quietHours ?? null : input.quietHours
    if (quietHours) checkQuiet(quietHours, bad)
    const lanOverride = !!(input.lanOverride ?? prev?.lanOverride ?? false)
    if (lanOverride && !SELF_HOSTABLE.includes(k)) bad('"Self-hosted on my network" is only for ntfy, Gotify and generic webhooks.')
    const usableWhileLocked = !!(input.usableWhileLocked ?? prev?.usableWhileLocked ?? false)
    if (usableWhileLocked && !LOCKED_OK.includes(k)) bad('This kind cannot be used while locked.')
    if (usableWhileLocked !== !!prev?.usableWhileLocked && actor.role !== 'owner') {
      throw new NotifyForbiddenError('Only an owner can change "Usable while locked": it moves a secret in or out of the vault.')
    }
    const chatId = (input.chatId ?? prev?.nonSecret.chatId ?? '').trim()
    if (k === 'telegram' && !TELEGRAM_CHAT.test(chatId)) bad('A Telegram chat id is a number (e.g. -1001234567890) or @channelname.')

    // Secrets: blank keeps what is stored, unless the kind changed.
    const kindChanged = !!prev && prev.kind !== k
    const stored = prev ? this.d.secrets.get(prev) : null
    if (prev && !stored && (kindChanged || usableWhileLocked !== prev.usableWhileLocked)) {
      throw new NotifyUnavailableError('The stored secret cannot be read right now; enter it again.')
    }
    const base: ChannelSecret = kindChanged || !stored ? {} : { ...stored }
    const given = (v: string | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    const next: ChannelSecret = { ...base }
    let changed = !prev || kindChanged || usableWhileLocked !== !!prev?.usableWhileLocked
    if (k === 'telegram') {
      if (given(input.botToken)) { next.botToken = given(input.botToken); changed = true }
      delete next.url; delete next.token; delete next.signingSecret
      if (!next.botToken || !TELEGRAM_TOKEN.test(next.botToken)) bad('Paste the bot token from @BotFather (digits, a colon, then letters).')
    } else {
      if (given(input.url)) { next.url = given(input.url); changed = true }
      if (!next.url) bad('Paste the address to send to.')
      const check = checkChannelUrl(k, next.url!, lanOverride)
      if (!check.ok) bad(check.reason)
      if (given(input.token)) { next.token = given(input.token); changed = true }
      if (input.clearToken) { delete next.token; changed = true }
      if (given(input.signingSecret)) { next.signingSecret = given(input.signingSecret); changed = true }
      if (input.clearSigningSecret) { delete next.signingSecret; changed = true }
      if (k !== 'ntfy' && k !== 'gotify') delete next.token
      if (k !== 'webhook') delete next.signingSecret
      delete next.botToken
      if (k === 'gotify' && !next.token) bad('Gotify needs the application token.')
    }
    return {
      fields: {
        name, kind: k, enabled: input.enabled ?? prev?.enabled ?? true, minSeverity, eventFilter, quietHours,
        lanOverride, usableWhileLocked, private: !!(input.private ?? prev?.private ?? false), nonSecret: k === 'telegram' ? { chatId } : {},
      },
      secret: changed ? next : null,
    }
  }

  async createChannel(input: ChannelInput, actor: Actor): Promise<ChannelView> {
    const { fields, secret } = this.validate(input, null, actor)
    const id = newId()
    const now = this.now()
    const rec: ChannelRecord = { ...fields, id, lastResult: null, lastSentAt: null, failingSince: null, seededFrom: null, createdBy: actor.email, createdAt: now, updatedAt: now }
    await this.d.secrets.put(rec, secret!)
    let row: ChannelRecord
    try {
      row = await this.d.store.createChannel({ ...fields, id, seededFrom: null, createdBy: actor.email })
    } catch (e) {
      await this.d.secrets.remove(rec).catch(() => undefined)
      throw e
    }
    await this.d.store.audit('notify.channel.create', id, { name: row.name, kind: row.kind, by: actor.email })
    return this.view(row)
  }

  async updateChannel(id: string, input: ChannelInput, actor: Actor): Promise<ChannelView> {
    const prev = await this.mustGet(id)
    const { fields, secret } = this.validate(input, prev, actor)
    const merged: ChannelRecord = { ...prev, ...fields }
    if (secret) await this.d.secrets.put(merged, secret)
    const row = await this.d.store.updateChannel(id, { ...fields, ...(secret ? { failingSince: null } : {}) })
    this.d.secrets.syncLocked(row)
    await this.d.store.audit('notify.channel.update', id, { name: row.name, kind: row.kind, by: actor.email, ...(secret ? { secretChanged: true } : {}) })
    return this.view(row)
  }

  async deleteChannel(id: string, actor: Actor): Promise<void> {
    const prev = await this.mustGet(id)
    await this.d.secrets.remove(prev)
    await this.d.store.deleteChannel(id)
    await this.d.store.audit('notify.channel.delete', id, { name: prev.name, kind: prev.kind, by: actor.email })
  }

  /** A real message through the same adapter and guard. Recorded as the channel's last result. */
  async testChannel(id: string, actor: Actor): Promise<{ ok: boolean; status?: number; code?: string; text: string }> {
    const c = await this.mustGet(id)
    const secret = this.d.secrets.get(c)
    if (!secret) throw new NotifyUnavailableError('The channel secret cannot be read right now.')
    const now = this.now()
    const msg = testMessage(c.name, { publicUrl: this.publicUrl(), now })
    let out: SendOutcome
    try { out = await this.d.transport(buildRequest(c.kind, secret, c.nonSecret, msg, now), { kind: c.kind, lanOverride: c.lanOverride }) }
    catch (err) { out = { ok: false, code: (err as any)?.code ?? 'error' } }
    const lastResult: DeliveryResult = { ok: out.ok, ...(out.status ? { status: out.status } : {}), ...(out.code ? { code: out.code } : {}), at: now.toISOString() }
    await this.d.store.updateChannel(id, { lastResult, ...(out.ok ? { lastSentAt: now, failingSince: null } : {}) })
    await this.d.store.addOutbox([{
      eventId: msg.id, channelId: id, type: msg.type, severity: 'info', fingerprint: null, resolved: false, payload: msg,
      status: out.ok ? 'sent' : 'failed', attempts: 1, httpStatus: out.status ?? null, errorCode: out.code ?? null,
      createdAt: now, nextAttemptAt: now, sentAt: out.ok ? now : null,
    }])
    await this.d.store.audit('notify.channel.test', id, { name: c.name, kind: c.kind, by: actor.email, ok: out.ok, ...(out.status ? { status: out.status } : {}) })
    return { ok: out.ok, ...(out.status ? { status: out.status } : {}), ...(out.code ? { code: out.code } : {}), text: describeResult(lastResult) }
  }

  async deliveries(channelId: string | undefined, limit = 50): Promise<DeliveryView[]> {
    return (await this.d.store.listOutbox({ channelId, limit: Math.min(Math.max(1, limit), 200) })).map(r => ({
      id: r.id, channelId: r.channelId, type: r.type, severity: r.severity, title: r.payload?.title ?? '', status: r.status,
      attempts: r.attempts, httpStatus: r.httpStatus, errorCode: r.errorCode, createdAt: r.createdAt.toISOString(), sentAt: iso(r.sentAt),
      text: r.status === 'sent' ? describeResult({ ok: true, status: r.httpStatus ?? undefined })
        : r.status === 'failed' ? describeResult({ ok: false, status: r.httpStatus ?? undefined, code: r.errorCode ?? undefined })
        : r.status === 'held-quiet' ? 'Held: quiet hours' : r.status === 'held-locked' ? 'Held: HyperProx is locked'
        : r.status === 'dropped' ? (r.errorCode === 'rate-brake' ? 'Not sent: too many at once' : 'Not sent: no longer relevant')
        : r.attempts ? `Retrying (${describeResult({ ok: false, status: r.httpStatus ?? undefined, code: r.errorCode ?? undefined })})` : 'Queued',
    }))
  }
}

function checkQuiet(q: QuietHours, bad: (m: string) => never): void {
  const hm = /^([01]?\d|2[0-3]):[0-5]\d$/
  if (!q || typeof q !== 'object' || !hm.test(String(q.start)) || !hm.test(String(q.end))) bad('Quiet hours need a start and end like 22:00 and 07:00.')
  if (q.start === q.end) bad('Quiet hours need different start and end times.')
  if (q.tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: q.tz }) } catch { bad('That time zone is not known.') } }
  if (q.days !== undefined && (!Array.isArray(q.days) || !q.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6))) bad('Days are 0 (Sunday) to 6 (Saturday).')
  if (typeof q.criticalBreaksThrough !== 'boolean') bad('Say whether critical alerts break through quiet hours.')
}

// --- Production -------------------------------------------------------------

export const productionTransport: Transport = (req, ch) => guardedSend(req, ch.kind, { lanOverride: ch.lanOverride })

export function productionNotifyService(db: PrismaClient, legacy: LegacySources, log: (m: string) => void,
                                        beforeOwnerSeed?: () => Promise<unknown>): NotifyService {
  return new NotifyService({
    store: new PrismaNotifyStore(db),
    secrets: new ChannelSecrets(vaultSecretBackend(), new LockedChannelsFile()),
    transport: productionTransport,
    legacy, log, beforeOwnerSeed,
  })
}
