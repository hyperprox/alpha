// =============================================================================
//  HyperProx — Notifications: shared types
//
//  An event is something that happened; a channel is somewhere to tell people.
//  Nothing in these types is secret except ChannelSecret, which never leaves
//  lib/notify/secrets.ts and the adapters.
// =============================================================================

export const CHANNEL_KINDS = ['discord', 'slack', 'teams', 'ntfy', 'gotify', 'telegram', 'webhook'] as const
export type ChannelKind = typeof CHANNEL_KINDS[number]

export const SEVERITIES = ['info', 'warning', 'critical'] as const
export type Severity = typeof SEVERITIES[number]

export const FAMILIES = ['vault', 'updates', 'certs', 'jobs', 'backups', 'resources', 'vpn', 'home', 'media'] as const
export type Family = typeof FAMILIES[number]

/** Kinds people run on their own network: only these may use a private address. */
export const SELF_HOSTABLE: ChannelKind[] = ['ntfy', 'gotify', 'webhook']

/** Kinds whose secret may live outside the vault (a send-only capability; Telegram with a warning). */
export const LOCKED_OK: ChannelKind[] = ['discord', 'slack', 'teams', 'ntfy', 'gotify', 'webhook', 'telegram']

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 }
export const severityRank = (s: Severity): number => RANK[s] ?? 0
export const maxSeverity = (a: Severity, b: Severity): Severity => (RANK[a] >= RANK[b] ? a : b)
export const isSeverity = (v: unknown): v is Severity => typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v)
export const isKind = (v: unknown): v is ChannelKind => typeof v === 'string' && (CHANNEL_KINDS as readonly string[]).includes(v)
export const isFamily = (v: unknown): v is Family => typeof v === 'string' && (FAMILIES as readonly string[]).includes(v)

/** `wizard.job.finished` and `files.copy.failed` → jobs. Unknown prefixes have no family (only "all events" channels get them). */
export function familyOf(type: string): Family | null {
  const head = type.split('.')[0]
  switch (head) {
    case 'vault': case 'updates': case 'certs': case 'vpn': return head
    case 'wizard': case 'catalogue': case 'files': return 'jobs'
    case 'backup': return 'backups'
    case 'alert': return 'resources'
    case 'ha': return 'home'
    case 'plex': return 'media'
    default: return null
  }
}

export interface QuietHours {
  start: string              // "22:00"
  end: string                // "07:00"
  tz?: string                // IANA zone; default the server's
  days?: number[]            // 0 = Sunday; default every day
  criticalBreaksThrough: boolean
}

export interface NotifyEventInput {
  type: string
  severity: Severity
  title: string
  lines?: string[]
  /** An absolute URL, or an app path ("/updates") joined to HYPERPROX_PUBLIC_URL. */
  link?: string | null
  linkLabel?: string
  /** Where to look when there is no public URL ("Updates page"). */
  where?: string
  /** The whole line to show instead of a link when there is no public URL (default: "Open the <where> in HyperProx."). */
  hint?: string
  subject?: { kind: string; name: string }
  fingerprint?: string
  resolved?: boolean
  at?: Date
  /**
   * Values that came from outside HyperProx (a device name, its OS, the user who added it). Channels that
   * render markdown (Discord, Teams) show them as plain text: markdown escaped, links not clickable.
   */
  plain?: string[]
  /**
   * A link that must not be stored or shown to anyone but its owner (a sign-in URL). It goes only to channels
   * marked private, lives in memory until `sensitiveUntil`, and is never written to the outbox.
   */
  sensitiveLink?: string
  sensitiveUntil?: Date
}

/** An event after the limits and scrubbing: what the outbox stores and the adapters render. */
export interface NotifyMessage {
  id: string
  type: string
  severity: Severity
  resolved: boolean
  title: string
  lines: string[]
  link: string | null
  linkLabel: string
  /** Shown instead of the link when there is none. */
  hint: string
  subject?: { kind: string; name: string }
  fingerprint?: string
  at: string
  /** Its link is held in memory only (see NotifyEventInput.sensitiveLink); private channels only. */
  sensitive?: boolean
}

export interface ChannelSecret {
  url?: string
  token?: string
  botToken?: string
  signingSecret?: string
}

export interface ChannelNonSecret { chatId?: string }

export interface DeliveryResult {
  ok: boolean
  status?: number
  /** ECONNREFUSED, TimeoutError, redirect, blocked-address ... never a message or a body. */
  code?: string
  at: string
}

export type EventFilter = 'all' | Family[]

export interface ChannelRecord {
  id: string
  name: string
  kind: ChannelKind
  enabled: boolean
  minSeverity: Severity
  eventFilter: EventFilter
  quietHours: QuietHours | null
  lanOverride: boolean
  usableWhileLocked: boolean
  /** Read only by people trusted with sign-in links. Only private channels receive sensitive events. */
  private: boolean
  nonSecret: ChannelNonSecret
  lastResult: DeliveryResult | null
  lastSentAt: Date | null
  failingSince: Date | null
  seededFrom: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

export type OutboxStatus = 'queued' | 'held-quiet' | 'held-locked' | 'sent' | 'failed' | 'dropped'

export interface OutboxRecord {
  id: string
  eventId: string
  channelId: string
  type: string
  severity: Severity
  fingerprint: string | null
  resolved: boolean
  payload: NotifyMessage
  status: OutboxStatus
  attempts: number
  nextAttemptAt: Date
  httpStatus: number | null
  errorCode: string | null
  createdAt: Date
  sentAt: Date | null
}

export interface OutboundRequest {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
}

export interface SendOutcome {
  ok: boolean
  status?: number
  code?: string
  retryAfterSec?: number
}

/** Delivers one request. Production: ssrf.guardedSend. Tests: a fake. */
export type Transport = (req: OutboundRequest, ch: { kind: ChannelKind; lanOverride: boolean }) => Promise<SendOutcome>
