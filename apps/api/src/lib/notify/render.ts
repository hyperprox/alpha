// =============================================================================
//  HyperProx — Notifications: message shape
//
//  Every message is a title that makes sense on its own (a watch or a voice
//  assistant reads only that), two or three short lines, and a link. Nothing
//  URL- or token-shaped survives from what a publisher passed in: error text
//  from a remote system can carry both.
// =============================================================================

import crypto from 'node:crypto'
import { maxSeverity, severityRank, type NotifyEventInput, type NotifyMessage, type Severity } from './types'

export const TITLE_MAX = 60
export const LINE_MAX = 99
export const BODY_MAX = 399
export const LINES_MAX = 3
export const GROUP_LINES = 5
export const DIGEST_LINES = 10

export interface RenderContext { publicUrl?: string; id?: string; now?: Date; secrets?: string[] }

/** Strip URLs, bearer tokens, key=value secrets, long opaque strings and any known secret value. */
export function scrub(text: string, secrets: string[] = []): string {
  let s = String(text ?? '')
  for (const v of secrets) if (v && v.length >= 4) s = s.split(v).join('[hidden]')
  s = s
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link removed]')
    .replace(/\b(bearer|basic)\s+\S+/gi, '$1 [hidden]')
    .replace(/\b(token|key|secret|password|passwd|pwd|apikey|api_key|auth)(\s*[=:]\s*)\S+/gi, '$1$2[hidden]')
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, '[hidden]')
  return s
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

function cut(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 3).trimEnd()}...`
}

/** Whole lines while they fit in `limit` characters (joined by newlines), then "and N more". */
export function fitLines(lines: string[], limit: number, more = (n: number) => `...and ${n} more`): string[] {
  const out: string[] = []
  let used = 0
  for (let i = 0; i < lines.length; i++) {
    const add = (out.length ? 1 : 0) + lines[i].length
    const restAfter = lines.length - i - 1
    const reserve = restAfter ? 1 + more(restAfter + 1).length : 0
    if (used + add + reserve > limit) {
      const tail = more(lines.length - i)
      while (out.length && used + 1 + tail.length > limit) { used -= out.pop()!.length + (out.length ? 1 : 0) }
      out.push(tail)
      return out
    }
    out.push(lines[i]); used += add
  }
  return out
}

function joinLink(link: string | null | undefined, publicUrl: string | undefined): string | null {
  if (!link) return null
  if (link === '/') return publicUrl ? publicUrl.replace(/\/+$/, '') : null
  if (link.startsWith('/')) return publicUrl ? `${publicUrl.replace(/\/+$/, '')}${link}` : null
  try {
    const u = new URL(link)
    return u.protocol === 'https:' || u.protocol === 'http:' ? link : null
  } catch { return null }
}

export function newEventId(): string {
  return `evt_${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`
}

/** An event as it will be stored and sent: limits applied, secrets scrubbed. */
export function toMessage(e: NotifyEventInput, ctx: RenderContext): NotifyMessage {
  const secrets = ctx.secrets ?? []
  const where = oneLine(scrub(e.where ?? 'HyperProx', secrets)) || 'HyperProx'
  const title = cut(oneLine(scrub(markPlain(e.title, e.plain), secrets)) || 'HyperProx', TITLE_MAX)
  let lines = (e.lines ?? []).map(l => cut(oneLine(scrub(markPlain(l, e.plain), secrets)), LINE_MAX)).filter(Boolean)
  const seeMore = (n: number) => `...and ${n} more; see the ${where}`
  if (lines.length > LINES_MAX) lines = [...lines.slice(0, LINES_MAX - 1), cut(seeMore(lines.length - (LINES_MAX - 1)), LINE_MAX)]
  // A sensitive link is never part of the message that is stored; the dispatcher adds it at send time.
  const link = e.sensitiveLink ? null : joinLink(e.link ?? null, ctx.publicUrl)
  const hint = cut(oneLine(e.hint ?? `Open the ${where} in HyperProx.`), LINE_MAX)
  const budget = BODY_MAX - (link ? link.length + 10 : hint.length + 1)
  while (lines.length && lines.join('\n').length > budget) lines = lines.slice(0, -1)
  return {
    id: ctx.id ?? newEventId(),
    type: e.type,
    severity: e.severity,
    resolved: !!e.resolved,
    title, lines, link,
    linkLabel: cut(oneLine(e.linkLabel ?? 'Open'), 20),
    hint,
    ...(e.subject ? { subject: { kind: oneLine(e.subject.kind).slice(0, 40), name: cut(oneLine(scrub(e.subject.name, secrets)), 80) } } : {}),
    ...(e.fingerprint ? { fingerprint: e.fingerprint.slice(0, 200) } : {}),
    at: (e.at ?? ctx.now ?? new Date()).toISOString(),
    ...(e.sensitiveLink ? { sensitive: true } : {}),
  }
}

/**
 * Outside values (NotifyEventInput.plain) are wrapped in two private-use characters before the text is scrubbed
 * and cut, so they can be found again however the line was shortened. buildRequest makes them plain text for
 * markdown channels and removes the marks for every other kind.
 */
export const PLAIN_OPEN = '\uE000', PLAIN_CLOSE = '\uE001'
const PLAIN_MARKS = /[\uE000\uE001]/g

function markPlain(text: string, values: string[] | undefined): string {
  const vals = (values ?? []).map(v => String(v ?? '').replace(PLAIN_MARKS, '')).filter(v => v.length > 0).sort((a, b) => b.length - a.length)
  const t = String(text ?? '').replace(PLAIN_MARKS, '')
  if (!vals.length) return t
  const re = new RegExp(vals.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  return t.replace(re, v => `${PLAIN_OPEN}${v}${PLAIN_CLOSE}`)
}

/** Each marked span (to its close mark, or the end of the text when a cut removed it) through `f`; marks removed. */
export function mapPlain(text: string, f: (v: string) => string): string {
  return text.replace(/\uE000([^\uE000\uE001]*)(?:\uE001|$)/g, (_x, v) => f(v)).replace(PLAIN_MARKS, '')
}

export function unmarkPlain(text: string): string {
  return text.replace(PLAIN_MARKS, '')
}

const worst = (ms: NotifyMessage[]): Severity => ms.reduce<Severity>((a, m) => maxSeverity(a, m.severity), 'info')
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function system(type: string, severity: Severity, title: string, lines: string[], ctx: RenderContext, link = '/'): NotifyMessage {
  return {
    id: ctx.id ?? newEventId(), type, severity, resolved: false, title: cut(title, TITLE_MAX), lines,
    link: joinLink(link, ctx.publicUrl), linkLabel: 'Open HyperProx', hint: 'Open HyperProx to see them.',
    at: (ctx.now ?? new Date()).toISOString(),
  }
}

/** Messages that became due for one channel at the same time: one message, at most five lines. */
export function groupMessage(ms: NotifyMessage[], ctx: RenderContext): NotifyMessage {
  const titles = ms.map(m => (m.resolved ? `Resolved: ${m.title}` : m.title))
  const lines = titles.length > GROUP_LINES ? [...titles.slice(0, GROUP_LINES - 1), `...and ${titles.length - (GROUP_LINES - 1)} more; open HyperProx`] : titles
  return system('notify.group', worst(ms), `${plural(ms.length, 'new alert')}`, lines, ctx)
}

/** What was held (quiet hours, or locked for a vault-only channel): worst first, at most ten lines. */
export function digestMessage(ms: NotifyMessage[], why: 'quiet' | 'locked', ctx: RenderContext): NotifyMessage {
  const sorted = [...ms].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
  const titles = sorted.map(m => (m.resolved ? `Resolved: ${m.title}` : `${m.severity === 'info' ? '' : `${cap(m.severity)}: `}${m.title}`))
  const lines = titles.length > DIGEST_LINES ? [...titles.slice(0, DIGEST_LINES - 1), `...and ${titles.length - (DIGEST_LINES - 1)} more; open HyperProx`] : titles
  const title = why === 'quiet' ? `${plural(ms.length, 'alert')} held during quiet hours` : `${plural(ms.length, 'alert')} while HyperProx was locked`
  return system('notify.digest', worst(ms), title, lines, ctx)
}

export function brakeMessage(ctx: RenderContext): NotifyMessage {
  return system('notify.brake', 'warning', 'Many alerts at once - open HyperProx',
    ['More than 6 messages in 10 minutes.', 'This channel is quiet until it calms down; the rest is in HyperProx.'], ctx)
}

export function testMessage(channelName: string, ctx: RenderContext): NotifyMessage {
  const name = cut(oneLine(channelName), 40)
  return { ...system('notify.test', 'info', 'HyperProx test', [`If you can read this, alerts to ${name} work.`], ctx), linkLabel: 'Open HyperProx' }
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The word a channel without colour shows first: "Critical: ...", "Resolved: ...". Info has none. */
export function severityPrefix(m: NotifyMessage): string {
  if (m.resolved) return 'Resolved: '
  return m.severity === 'info' ? '' : `${cap(m.severity)}: `
}

/** The link line, or the hint when there is no link. */
export function linkLine(m: NotifyMessage): string {
  return m.link ? `${m.linkLabel}: ${m.link}` : m.hint
}
