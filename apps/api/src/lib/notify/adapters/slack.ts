// Slack incoming webhook: an attachment carries the colour. &, < and > are escaped, so <!channel> in a
// name cannot notify anyone.
import { severityPrefix } from '../render'
import type { ChannelSecret, NotifyMessage, OutboundRequest } from '../types'
import { JSON_HEADERS, colour, hex, titleOf } from './common'
import { fitLines } from '../render'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function slackRequest(secret: ChannelSecret, m: NotifyMessage): OutboundRequest {
  const tail = m.link ? `<${m.link}|${esc(m.linkLabel)}>` : esc(m.hint)
  const lines = fitLines(m.lines.map(esc), 3000 - tail.length - 1)
  return { url: secret.url ?? '', method: 'POST', headers: { ...JSON_HEADERS }, body: JSON.stringify({
    text: esc(`${severityPrefix(m)}${m.title}`),
    attachments: [{
      color: hex(colour(m)),
      title: esc(titleOf(m)),
      ...(m.link ? { title_link: m.link } : {}),
      text: [...lines, tail].join('\n'),
    }],
  }) }
}
