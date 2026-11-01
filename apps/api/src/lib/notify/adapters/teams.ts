// Microsoft Teams: the Workflows "When a Teams webhook request is received" trigger takes an Adaptive Card.
// (The old Office 365 connector webhooks are retired.) Severity is the container style.
import type { ChannelSecret, NotifyMessage, OutboundRequest } from '../types'
import { fitLines } from '../render'
import { JSON_HEADERS, titleOf } from './common'

function style(m: NotifyMessage): string {
  if (m.resolved) return 'good'
  return m.severity === 'critical' ? 'attention' : m.severity === 'warning' ? 'warning' : 'accent'
}

export function teamsRequest(secret: ChannelSecret, m: NotifyMessage): OutboundRequest {
  const lines = fitLines(m.lines, 4000)
  const items = [
    { type: 'TextBlock', text: titleOf(m), weight: 'Bolder', size: 'Medium', wrap: true },
    ...lines.map(text => ({ type: 'TextBlock', text, wrap: true })),
    ...(m.link ? [] : [{ type: 'TextBlock', text: m.hint, wrap: true, isSubtle: true }]),
  ]
  return { url: secret.url ?? '', method: 'POST', headers: { ...JSON_HEADERS }, body: JSON.stringify({
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [{ type: 'Container', style: style(m), items }],
        actions: m.link ? [{ type: 'Action.OpenUrl', title: m.linkLabel, url: m.link }] : [],
      },
    }],
  }) }
}
