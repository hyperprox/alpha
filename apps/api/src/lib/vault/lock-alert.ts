// =============================================================================
//  HyperProx — Lock alert
//
//  When HyperProx locks by itself (idle timeout, keyholder stopped, restart while
//  unlocked) it posts one message to a phone-friendly channel with a link to the
//  sign-in page. A manual lock sends nothing: whoever locked it knows.
//
//  The channel has to be readable while locked, so its address is ordinary
//  config, not a vault secret (like the metrics exporter's read-only token):
//    LOCK_ALERT_URL        where to post; unset: the Updates or Certificates
//                          webhook_url (config/updates.yaml, config/certs.yaml)
//    LOCK_ALERT_KIND       auto (default) | discord | ntfy | gotify | webhook
//    LOCK_ALERT_TOKEN      optional: ntfy access token / Gotify app token
//    HYPERPROX_PUBLIC_URL  the address you open HyperProx at, for the link
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

export function buildAlert(cfg: LockAlertConfig, reason: AlertReason, now = new Date(), idleMinutes?: number): AlertRequest {
  const title = 'HyperProx is locked'
  const text = lockMessage(reason, idleMinutes)
  const link = unlockLink(cfg.publicUrl, reason)
  const tail = link ? `Tap to unlock: ${link}` : 'Sign in at /login on HyperProx to unlock (set HYPERPROX_PUBLIC_URL for a one-tap link).'
  const json = { 'Content-Type': 'application/json' }
  switch (cfg.kind) {
    case 'discord':
      // <link> stops Discord from unfurling a preview; no mentions can ever ping.
      return { url: cfg.url, method: 'POST', headers: json, body: JSON.stringify({
        content: `**${title}**\n${text}\n${link ? `Tap to unlock: <${link}>` : tail}`,
        allowed_mentions: { parse: [] },
      }) }
    case 'ntfy': {
      const headers: Record<string, string> = { 'Content-Type': 'text/plain; charset=utf-8', Title: title, Tags: 'lock', Priority: '4' }
      if (link) { headers.Click = link; headers.Actions = `view, Unlock, ${link}, clear=true` }
      if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`
      return { url: cfg.url, method: 'POST', headers, body: `${text}\n${tail}` }
    }
    case 'gotify': {
      const headers: Record<string, string> = { ...json }
      if (cfg.token) headers['X-Gotify-Key'] = cfg.token
      return { url: cfg.url, method: 'POST', headers, body: JSON.stringify({
        title, message: `${text}\n${tail}`, priority: 8,
        extras: { 'client::display': { contentType: 'text/plain' }, ...(link ? { 'client::notification': { click: { url: link } } } : {}) },
      }) }
    }
    case 'webhook':
      // `content` for Discord-compatible receivers, `text` for Slack-compatible ones, the rest for anything else.
      return { url: cfg.url, method: 'POST', headers: json, body: JSON.stringify({
        event: 'hyperprox.locked', reason, at: now.toISOString(), title, message: text, url: link,
        content: `${title}: ${text} ${tail}`, text: `${title}: ${text} ${tail}`,
      }) }
  }
}

// ---------------------------------------------------------------------------
//  Sending, and the "was unlocked" marker for the alert after a restart
// ---------------------------------------------------------------------------

export interface AlertDeps {
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>
  log?: { info(msg: string): void; warn(msg: string): void }
  env?: Env
  fallback?: () => string | undefined
}

let lastSentAt = 0

export async function sendLockAlert(reason: AlertReason, deps: AlertDeps = {}): Promise<'sent' | 'unconfigured' | 'failed' | 'suppressed'> {
  const log = deps.log ?? { info: () => undefined, warn: () => undefined }
  const cfg = lockAlertConfig(deps.env ?? process.env, deps.fallback ?? existingWebhook)
  if (!cfg) { log.info('[vault] locked; no lock alert channel is set (LOCK_ALERT_URL)'); return 'unconfigured' }
  // One message per lock: the keyholder's event and its connection closing can both arrive.
  if (Date.now() - lastSentAt < 10_000) return 'suppressed'
  lastSentAt = Date.now()
  const req = buildAlert(cfg, reason)
  const f = deps.fetch ?? ((url, init) => fetch(url, init))
  try {
    const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) { log.warn(`[vault] lock alert (${cfg.kind}) was refused: HTTP ${res.status}`); return 'failed' }
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

function alertReason(r: string | undefined): AlertReason {
  return r === 'idle' ? 'idle' : r === 'stop' || r === 'keyholder' ? 'keyholder' : 'restart'
}

let installed = false

/**
 * Hooks the alert to the unlock state. Call once at startup, before attachUnlockState().
 * Then call startupCheck() after it: HyperProx was unlocked before this start and is locked now.
 */
export function installLockAlerts(deps: AlertDeps = {}): { startupCheck(): Promise<void> } {
  if (!installed) {
    installed = true
    onUnlock(() => writeMarker(true))
    onLock((reason) => {
      writeMarker(false)
      if (reason !== 'manual') void sendLockAlert(reason, deps)
    })
  }
  return {
    async startupCheck() {
      if (isUnlocked()) return   // restored from the keyholder: nothing was lost
      if (!readMarker()?.unlocked) return
      writeMarker(false)
      await sendLockAlert(alertReason(keyholderLastLock()?.reason), deps)
    },
  }
}

/** Tests only. */
export function resetLockAlertForTests(): void { lastSentAt = 0 }
