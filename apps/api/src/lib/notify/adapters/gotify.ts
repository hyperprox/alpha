// Gotify: POST /message with the app token in X-Gotify-Key; priority 8 / 5 / 2; the link as the click URL.
import type { ChannelSecret, NotifyMessage, OutboundRequest } from '../types'
import { JSON_HEADERS, bodyText, titleOf } from './common'

export function gotifyRequest(secret: ChannelSecret, m: NotifyMessage): OutboundRequest {
  const headers: Record<string, string> = { ...JSON_HEADERS }
  if (secret.token) headers['X-Gotify-Key'] = secret.token
  const priority = m.resolved ? 2 : m.severity === 'critical' ? 8 : m.severity === 'warning' ? 5 : 2
  return { url: secret.url ?? '', method: 'POST', headers, body: JSON.stringify({
    title: titleOf(m),
    message: bodyText(m, 4000),
    priority,
    extras: { 'client::display': { contentType: 'text/plain' }, ...(m.link ? { 'client::notification': { click: { url: m.link } } } : {}) },
  }) }
}
