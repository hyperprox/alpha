// Generic JSON webhook: the documented payload (docs/notifications.md), version 1. `content` and `text` are
// there so Discord- and Slack-compatible receivers work without a transform. With a signing secret, the
// request carries X-HyperProx-Timestamp and X-HyperProx-Signature: sha256=HMAC(timestamp + "." + body).
import crypto from 'node:crypto'
import { linkLine, severityPrefix } from '../render'
import type { ChannelSecret, NotifyMessage, OutboundRequest } from '../types'
import { JSON_HEADERS } from './common'

export function webhookRequest(secret: ChannelSecret, m: NotifyMessage, now = new Date()): OutboundRequest {
  const summary = `${severityPrefix(m)}${m.title}: ${[...m.lines, linkLine(m)].join(' ')}`.slice(0, 1900)
  const body = JSON.stringify({
    version: 1,
    id: m.id,
    type: m.type,
    event: m.type,
    severity: m.severity,
    resolved: m.resolved,
    title: m.title,
    lines: m.lines,
    subject: m.subject ?? null,
    at: m.at,
    url: m.link,
    fingerprint: m.fingerprint ?? null,
    content: summary,
    text: summary,
  })
  const headers: Record<string, string> = { ...JSON_HEADERS }
  if (secret.signingSecret) {
    const ts = String(Math.floor(now.getTime() / 1000))
    headers['X-HyperProx-Timestamp'] = ts
    headers['X-HyperProx-Signature'] = `sha256=${crypto.createHmac('sha256', secret.signingSecret).update(`${ts}.${body}`).digest('hex')}`
  }
  return { url: secret.url ?? '', method: 'POST', headers, body }
}
