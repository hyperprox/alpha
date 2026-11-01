// ntfy: plain-text body, the title and priority in headers, a Click URL and a view action to the page.
// The access token is only ever the Authorization header. Header values must be ASCII, so anything else
// is sent as an RFC 2047 encoded word, which ntfy decodes.
import type { ChannelSecret, NotifyMessage, OutboundRequest } from '../types'
import { bodyText, titleOf } from './common'

export function headerValue(s: string): string {
  const clean = s.replace(/[\r\n]+/g, ' ')
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

function tags(m: NotifyMessage): string {
  const t = [m.resolved ? 'white_check_mark' : m.severity === 'critical' ? 'rotating_light' : m.severity === 'warning' ? 'warning' : 'information_source']
  if (m.type.startsWith('vault.')) t.push('lock')
  return t.join(',')
}

export function ntfyRequest(secret: ChannelSecret, m: NotifyMessage): OutboundRequest {
  const priority = m.resolved ? 3 : m.severity === 'critical' ? 5 : m.severity === 'warning' ? 4 : 3
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8', Title: headerValue(titleOf(m)), Priority: String(priority), Tags: tags(m),
  }
  if (m.link) { headers.Click = m.link; headers.Actions = headerValue(`view, ${m.linkLabel.replace(/[,;]/g, ' ')}, ${m.link}, clear=true`) }
  if (secret.token) headers.Authorization = `Bearer ${secret.token}`
  // ntfy's message limit is 4096 bytes; stay well inside it whatever the encoding.
  return { url: secret.url ?? '', method: 'POST', headers, body: bodyText(m, 2000) }
}
