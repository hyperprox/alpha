// =============================================================================
//  HyperProx — Lock alert
//
//  When HyperProx locks by itself (idle timeout, keyholder stopped, restart while
//  unlocked) it posts one message to a phone-friendly channel with a link to the
//  sign-in page. A manual lock sends nothing: whoever locked it knows.
//
//  Where it goes: the notification channels marked "usable while locked"
//  (Settings → Notifications, lib/notify). Their secrets live in
//  data/notify-locked-channels.json, so delivery needs neither the vault nor
//  Postgres. On the first start of this version the old settings are moved
//  there once (lib/notify/service.ts seedLockChannel):
//    LOCK_ALERT_URL        where to post; unset: the Updates or Certificates
//                          webhook_url (config/updates.yaml, config/certs.yaml)
//    LOCK_ALERT_KIND       auto (default) | discord | ntfy | gotify | webhook
//    LOCK_ALERT_TOKEN      optional: ntfy access token / Gotify app token
//  Until that has happened they are still read here (the legacy path below).
//    HYPERPROX_PUBLIC_URL  the address you open HyperProx at, for the link
//
//  This file keeps the lock-specific rules: one message per lock, no message
//  for a manual lock, and the "was unlocked" marker for the alert after a
//  restart. The rendering per kind is the shared notification adapters'.
//
//  The message carries the reason and the link, never a secret, token or
//  session. Nothing here logs the channel address or the token.
// =============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { dataDir, idleLockMs } from './config'
import { isUnlocked, keyholderLastLock, onLock, onUnlock, type LockReason } from './state'
import { loadPolicy } from '../updates/policy'
import { loadCertsPolicy } from '../certs/policy'
import { buildRequest } from '../notify/adapters'
import { toMessage } from '../notify/render'
import { guardedSend } from '../notify/ssrf'
import { getNotifyService } from '../notify'
import { SELF_HOSTABLE, type NotifyEventInput } from '../notify/types'

export type AlertKind = 'discord' | 'ntfy' | 'gotify' | 'webhook'
export type AlertReason = Exclude<LockReason, 'manual'>

export interface LockAlertConfig { url: string; kind: AlertKind; token?: string; publicUrl?: string }

export interface AlertRequest { url: string; method: 'POST'; headers: Record<string, string>; body: string }

type Env = Record<string, string | undefined>

export function detectKind(url: string): AlertKind {
  let u: URL
  try { u = new URL(url) } catch { return 'webhook' }
  const host = u.hostname.toLowerCase()
  if ((host === 'discord.com' || host.endsWith('.discord.com') || host === 'discordapp.com' || host.endsWith('.discordapp.com'))
      && u.pathname.startsWith('/api/webhooks/')) return 'discord'
  if (/\/message\/?$/.test(u.pathname)) return 'gotify'
  if (host.includes('ntfy')) return 'ntfy'
  return 'webhook'
}

function httpUrl(v: string | undefined): string | undefined {
  if (!v) return undefined
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:' ? v : undefined
  } catch { return undefined }
}

/** The webhook the Updates or Certificates reports already use, when no LOCK_ALERT_URL is set. */
export function existingWebhook(): string | undefined {
  try { const u = loadPolicy().policy.webhookUrl; if (u) return u } catch { /* no policy */ }
  try { const u = loadCertsPolicy().policy.alerts.webhookUrl; if (u) return u } catch { /* no policy */ }
  return undefined
}

export function lockAlertConfig(env: Env = process.env, fallback: () => string | undefined = existingWebhook): LockAlertConfig | null {
  const url = httpUrl(env.LOCK_ALERT_URL) ?? httpUrl(fallback())
  if (!url) return null
  const k = (env.LOCK_ALERT_KIND || 'auto').toLowerCase()
  const kind: AlertKind = k === 'discord' || k === 'ntfy' || k === 'gotify' || k === 'webhook' ? k : detectKind(url)
  const publicUrl = httpUrl(env.HYPERPROX_PUBLIC_URL)?.replace(/\/+$/, '')
  return { url, kind, ...(env.LOCK_ALERT_TOKEN ? { token: env.LOCK_ALERT_TOKEN } : {}), ...(publicUrl ? { publicUrl } : {}) }
}

/** The sign-in page, with why it locked. No token or session in it: signing in is the unlock. */
export function unlockLink(publicUrl: string | undefined, reason: AlertReason): string | null {
  return publicUrl ? `${publicUrl}/login?locked=1&reason=${reason}` : null
}

export function lockMessage(reason: AlertReason, idleMinutes = Math.round(idleLockMs() / 60_000)): string {
  switch (reason) {
    case 'idle':      return `HyperProx locked itself after ${idleMinutes} minutes with nobody signed in.`
    case 'keyholder': return 'HyperProx locked: its keyholder service stopped or restarted.'
    case 'restart':   return 'HyperProx locked: it restarted while unlocked (host reboot or keyholder restart).'
  }
}

/** The lock alert as a notification event: critical, family vault, the sign-in page as its link. */
export function lockEvent(reason: AlertReason, idleMinutes?: number): NotifyEventInput {
  return {
    type: 'vault.locked', severity: 'critical', title: 'HyperProx is locked',
    lines: [lockMessage(reason, idleMinutes)],
    link: `/login?locked=1&reason=${reason}`, linkLabel: 'Unlock',
    hint: 'Sign in at /login on HyperProx to unlock (set HYPERPROX_PUBLIC_URL for a one-tap link).',
    subject: { kind: 'vault', name: reason }, fingerprint: 'vault.locked',
  }
}

/** The request for one channel, through the shared adapter for its kind. */
export function buildAlert(cfg: LockAlertConfig, reason: AlertReason, now = new Date(), idleMinutes?: number): AlertRequest {
  const msg = toMessage(lockEvent(reason, idleMinutes), { publicUrl: cfg.publicUrl, now })
  const req = buildRequest(cfg.kind, { url: cfg.url, ...(cfg.token ? { token: cfg.token } : {}) }, {}, msg, now)
  return { url: req.url, method: 'POST', headers: req.headers, body: req.body }
}

// ---------------------------------------------------------------------------
//  Sending, and the "was unlocked" marker for the alert after a restart
// ---------------------------------------------------------------------------

export interface LockNotifier {
  lockSeeded(): boolean
  deliverLocked(e: NotifyEventInput): Promise<{ result: 'sent' | 'failed' | 'unconfigured'; kinds: string[]; failures: string[] }>
}

export interface AlertDeps {
  /** Legacy path only: replaces the guarded send (tests). */
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>
  log?: { info(msg: string): void; warn(msg: string): void }
  env?: Env
  fallback?: () => string | undefined
  /** The notification channels; default the installed service. null: the legacy path only. */
  notify?: LockNotifier | null
}

let lastSentAt = 0

export async function sendLockAlert(reason: AlertReason, deps: AlertDeps = {}): Promise<'sent' | 'unconfigured' | 'failed' | 'suppressed'> {
  const log = deps.log ?? { info: () => undefined, warn: () => undefined }
  const notify = deps.notify === undefined ? getNotifyService() : deps.notify
  if (notify?.lockSeeded()) {
    // One message per lock: the keyholder's event and its connection closing can both arrive.
    if (Date.now() - lastSentAt < 10_000) return 'suppressed'
    lastSentAt = Date.now()
    const r = await notify.deliverLocked(lockEvent(reason))
    if (r.result === 'unconfigured') { log.info('[vault] locked; no notification channel is set to receive lock alerts (Settings, Notifications)'); return 'unconfigured' }
    for (const f of r.failures) log.warn(`[vault] lock alert (${f}) could not be sent`)
    if (r.result === 'sent') log.info(`[vault] lock alert sent (${r.kinds.join(', ')}, ${reason})`)
    return r.result
  }

  // Legacy: the .env settings, until the first start of this version has moved them onto a channel.
  const cfg = lockAlertConfig(deps.env ?? process.env, deps.fallback ?? existingWebhook)
  if (!cfg) { log.info('[vault] locked; no lock alert channel is set (LOCK_ALERT_URL)'); return 'unconfigured' }
  if (Date.now() - lastSentAt < 10_000) return 'suppressed'
  lastSentAt = Date.now()
  const req = buildAlert(cfg, reason)
  try {
    let res: { ok: boolean; status?: number; code?: string }
    if (deps.fetch) res = await deps.fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(10_000) })
    else res = await guardedSend(req, cfg.kind, { lanOverride: SELF_HOSTABLE.includes(cfg.kind) })
    if (!res.ok) {
      log.warn(res.status ? `[vault] lock alert (${cfg.kind}) was refused: HTTP ${res.status}` : `[vault] lock alert (${cfg.kind}) could not be sent: ${res.code ?? 'error'}`)
      return 'failed'
    }
    log.info(`[vault] lock alert sent (${cfg.kind}, ${reason})`)
    return 'sent'
  } catch (e) {
    // The error text could carry the address; only its kind is logged.
    const code = (e as any)?.cause?.code ?? (e as Error)?.name ?? 'error'
    log.warn(`[vault] lock alert (${cfg.kind}) could not be sent: ${code}`)
    return 'failed'
  }
}

export function markerPath(): string {
  return path.join(dataDir(), 'vault-lock-state.json')
}

/** Only whether HyperProx was unlocked, and since when. Nothing secret. */
export function writeMarker(unlocked: boolean): void {
  try {
    const p = markerPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = `${p}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ unlocked, at: new Date().toISOString() }) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, p)
  } catch { /* best effort: only the alert after a restart depends on it */ }
}

export function readMarker(): { unlocked: boolean } | null {
  try { return JSON.parse(fs.readFileSync(markerPath(), 'utf8')) } catch { return null }
}

/**
 * Why the keyholder is about to be restarted, left by whoever restarts it on purpose (`hyperprox lock`
 * with the API down). A fresh 'manual' turns the "keyholder restarted" alert into no alert. Not secret.
 */
export function restartReasonPath(): string {
  return path.join(dataDir(), 'keyholder-restart-reason.json')
}

export function writeRestartReason(reason: 'manual', at = Date.now()): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true })
    fs.writeFileSync(restartReasonPath(), JSON.stringify({ reason, at }) + '\n', { mode: 0o600 })
  } catch { /* best effort */ }
}

/** The reason, if one was left in the last two minutes; consumed either way. */
export function takeRestartReason(maxAgeMs = 120_000): 'manual' | null {
  let v: any = null
  try { v = JSON.parse(fs.readFileSync(restartReasonPath(), 'utf8')) } catch { return null }
  try { fs.rmSync(restartReasonPath(), { force: true }) } catch { /* best effort */ }
  const at = typeof v?.at === 'number' ? v.at : Date.parse(String(v?.at ?? ''))
  return v?.reason === 'manual' && Number.isFinite(at) && Date.now() - at <= maxAgeMs ? 'manual' : null
}

function alertReason(r: string | undefined): AlertReason {
  return r === 'idle' ? 'idle' : r === 'stop' || r === 'keyholder' ? 'keyholder' : 'restart'
}

let installed = false
let currentDeps: AlertDeps = {}

/**
 * Hooks the alert to the unlock state. Call once at startup, before attachUnlockState().
 * Then call startupCheck() after it: HyperProx was unlocked before this start and is locked now.
 */
export function installLockAlerts(deps: AlertDeps = {}): { startupCheck(): Promise<void> } {
  currentDeps = deps
  if (!installed) {
    installed = true
    onUnlock(() => writeMarker(true))
    onLock((reason) => {
      writeMarker(false)
      if (reason === 'manual') return
      // The keyholder went away because someone locked by restarting it: that is a manual lock.
      if ((reason === 'keyholder' || reason === 'restart') && takeRestartReason() === 'manual') return
      void sendLockAlert(reason, currentDeps)
    })
  }
  return {
    async startupCheck() {
      if (isUnlocked()) return   // restored from the keyholder: nothing was lost
      if (!readMarker()?.unlocked) return
      writeMarker(false)
      if (takeRestartReason() === 'manual') return
      await sendLockAlert(alertReason(keyholderLastLock()?.reason), deps)
    },
  }
}

/** Tests only. */
export function resetLockAlertForTests(): void { lastSentAt = 0 }
