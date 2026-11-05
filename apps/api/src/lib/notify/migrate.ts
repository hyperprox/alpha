// =============================================================================
//  HyperProx — Notifications: moving the three old senders onto channels
//
//  Before this feature, three places sent messages on their own:
//    - the lock alert: LOCK_ALERT_URL / _KIND / _TOKEN in .env, falling back
//      to the Updates or Certificates webhook_url;
//    - Updates: notify.webhook_url in config/updates.yaml;
//    - Certificates: alerts.webhook_url in config/certs.yaml.
//  They become channels, once each:
//    - the lock alert at the first start of this version, no unlock needed:
//      a "usable while locked" channel straight into the locked-channels file
//      (it was readable while locked before, and must still be);
//    - the YAML webhooks at the first Owner sign-in, into the vault.
//  The same URL behind several of them becomes ONE channel with the union of
//  their filters, so nobody gets a message twice.
//
//  Until a seed has run, the old setting still delivers (as a virtual channel
//  through the same adapters and guard), so nothing that alerts today goes
//  quiet. After it has run, the old keys are ignored and a line in the log says
//  where the channel now lives.
// =============================================================================

import { detectKind } from './adapters'
import { checkChannelUrl } from './ssrf'
import { SELF_HOSTABLE, severityRank, type ChannelKind, type ChannelRecord, type EventFilter, type Family, type Severity } from './types'
import type { VirtualChannel } from './dispatcher'

type Env = Record<string, string | undefined>

export interface LegacySources {
  updatesUrl(): string | undefined
  certsUrl(): string | undefined
}

export const SEED_IDS = {
  lock: 'seed-lock-alerts',
  updates: 'seed-updates',
  certs: 'seed-certificates',
  both: 'seed-updates-certificates',
} as const

export const YAML_STATE = 'seeded.yaml'

export function httpUrl(v: string | undefined | null): string | undefined {
  if (!v) return undefined
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:' ? v : undefined
  } catch { return undefined }
}

/** Same address, ignoring a trailing slash and the case of the host. */
export function sameUrl(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  try {
    const x = new URL(a), y = new URL(b)
    return x.protocol === y.protocol && x.host.toLowerCase() === y.host.toLowerCase() &&
      x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '') && x.search === y.search
  } catch { return a === b }
}

/**
 * The kind and the self-hosted switch for an address that used to be accepted as-is. A self-hosted
 * receiver on the LAN (or on http) keeps working; a pinned kind whose address does not fit is sent as a
 * generic webhook, which is what the old senders did with it anyway.
 */
export async function legacyShape(url: string, wanted: string | undefined, isPrivate: (url: string) => Promise<boolean>):
  Promise<{ kind: ChannelKind; lanOverride: boolean } | null> {
  const w = (wanted ?? 'auto').toLowerCase()
  let kind: ChannelKind = w === 'discord' || w === 'ntfy' || w === 'gotify' || w === 'webhook' ? w : detectKind(url)
  if (kind === 'telegram') kind = 'webhook'
  if (!checkChannelUrl(kind, url, true).ok) kind = 'webhook'
  const lanOverride = SELF_HOSTABLE.includes(kind) && (new URL(url).protocol === 'http:' || await isPrivate(url).catch(() => false))
  return checkChannelUrl(kind, url, lanOverride).ok ? { kind, lanOverride } : null
}

const lower = (a: Severity, b: Severity): Severity => (severityRank(a) <= severityRank(b) ? a : b)

export function unionFilter(a: EventFilter, b: Family[]): EventFilter {
  if (a === 'all') return 'all'
  return [...new Set([...a, ...b])]
}

interface Source { key: 'updates' | 'certs'; url: string; families: Family[]; min: Severity; yamlKey: string }

export function legacySourceList(l: LegacySources): Source[] {
  const out: Source[] = []
  const u = httpUrl(safe(l.updatesUrl)), c = httpUrl(safe(l.certsUrl))
  if (u) out.push({ key: 'updates', url: u, families: ['updates'], min: 'info', yamlKey: 'notify.webhook_url in config/updates.yaml' })
  if (c) out.push({ key: 'certs', url: c, families: ['certs'], min: 'warning', yamlKey: 'alerts.webhook_url in config/certs.yaml' })
  return out
}

function safe(f: () => string | undefined): string | undefined {
  try { return f() } catch { return undefined }
}

/** Sources grouped by address: one URL behind both is one channel. */
export function groupByUrl(sources: Source[]): Array<{ url: string; sources: Source[] }> {
  const groups: Array<{ url: string; sources: Source[] }> = []
  for (const s of sources) {
    const g = groups.find(x => sameUrl(x.url, s.url))
    if (g) g.sources.push(s)
    else groups.push({ url: s.url, sources: [s] })
  }
  return groups
}

export function seedName(sources: Source[]): string {
  const keys = sources.map(s => s.key)
  return keys.includes('updates') && keys.includes('certs') ? 'Updates and certificates' : keys[0] === 'updates' ? 'Updates reports' : 'Certificate alerts'
}

export function seedId(sources: Source[]): string {
  const keys = sources.map(s => s.key)
  return keys.includes('updates') && keys.includes('certs') ? SEED_IDS.both : keys[0] === 'updates' ? SEED_IDS.updates : SEED_IDS.certs
}

/** The old YAML webhooks as channels that live only in memory, until the Owner sign-in seeds them. */
export async function legacyVirtualChannels(l: LegacySources, isPrivate: (url: string) => Promise<boolean>): Promise<VirtualChannel[]> {
  const out: VirtualChannel[] = []
  for (const g of groupByUrl(legacySourceList(l))) {
    const shape = await legacyShape(g.url, undefined, isPrivate)
    if (!shape) continue
    const now = new Date(0)
    const channel: ChannelRecord = {
      id: `legacy:${g.sources.map(s => s.key).join('+')}`, name: seedName(g.sources), kind: shape.kind, enabled: true,
      minSeverity: g.sources.map(s => s.min).reduce(lower), eventFilter: [...new Set(g.sources.flatMap(s => s.families))],
      quietHours: null, lanOverride: shape.lanOverride, usableWhileLocked: true, private: false, nonSecret: {}, lastResult: null,
      lastSentAt: null, failingSince: null, seededFrom: null, createdBy: 'config', createdAt: now, updatedAt: now,
    }
    out.push({ channel, secret: { url: g.url } })
  }
  return out
}

/** LOCK_ALERT_URL, else the YAML webhook the lock alert used to fall back to. */
export function lockSource(env: Env, l: LegacySources): { url: string; kind?: string; token?: string } | null {
  const url = httpUrl(env.LOCK_ALERT_URL) ?? httpUrl(safe(l.updatesUrl)) ?? httpUrl(safe(l.certsUrl))
  if (!url) return null
  return { url, kind: env.LOCK_ALERT_KIND, ...(env.LOCK_ALERT_TOKEN ? { token: env.LOCK_ALERT_TOKEN } : {}) }
}

export { lower as lowerSeverity }
