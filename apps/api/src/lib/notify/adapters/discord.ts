// Discord: one embed. Severity is the embed colour; allowed_mentions is always empty, so no title, name or
// error text can ping anyone. Embed description limit 4096.
import type { ChannelSecret, NotifyMessage, OutboundRequest } from '../types'
import { JSON_HEADERS, bodyText, colour, titleOf } from './common'

export function discordRequest(secret: ChannelSecret, m: NotifyMessage): OutboundRequest {
  return { url: secret.url ?? '', method: 'POST', headers: { ...JSON_HEADERS }, body: JSON.stringify({
    embeds: [{
      title: titleOf(m).slice(0, 256),
      description: bodyText(m, 4096),
      color: colour(m),
      ...(m.link ? { url: m.link } : {}),
      timestamp: m.at,
    }],
    allowed_mentions: { parse: [] },
  }) }
}
