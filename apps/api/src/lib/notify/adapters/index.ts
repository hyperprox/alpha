// =============================================================================
//  HyperProx — Notifications: one adapter per channel kind
//  Each turns a NotifyMessage into the exact request that kind expects. They
//  only build requests; sending (and the SSRF guard) is ssrf.guardedSend.
// =============================================================================

import { withPlainValues, withoutMarks } from './common'
import type { ChannelKind, ChannelNonSecret, ChannelSecret, NotifyMessage, OutboundRequest } from '../types'
import { discordRequest } from './discord'
import { slackRequest } from './slack'
import { teamsRequest } from './teams'
import { ntfyRequest } from './ntfy'
import { gotifyRequest } from './gotify'
import { telegramRequest } from './telegram'
import { webhookRequest } from './webhook'

export { telegramUrl, TELEGRAM_CHAT, TELEGRAM_TOKEN } from './telegram'

export function buildRequest(kind: ChannelKind, secret: ChannelSecret, nonSecret: ChannelNonSecret, marked: NotifyMessage, now = new Date()): OutboundRequest {
  // Outside values (a device name, its OS, a user) are plain text where markdown renders; elsewhere as they are.
  const m = kind === 'discord' || kind === 'teams' ? withPlainValues(marked) : withoutMarks(marked)
  switch (kind) {
    case 'discord':  return discordRequest(secret, m)
    case 'slack':    return slackRequest(secret, m)
    case 'teams':    return teamsRequest(secret, m)
    case 'ntfy':     return ntfyRequest(secret, m)
    case 'gotify':   return gotifyRequest(secret, m)
    case 'telegram': return telegramRequest(secret, nonSecret, m)
    case 'webhook':  return webhookRequest(secret, m, now)
  }
}

/** A best guess from a pasted URL; the user can always pick the kind. */
export function detectKind(url: string): ChannelKind {
  let u: URL
  try { u = new URL(url) } catch { return 'webhook' }
  const host = u.hostname.toLowerCase()
  const under = (d: string) => host === d || host.endsWith(`.${d}`)
  if ((under('discord.com') || under('discordapp.com')) && u.pathname.startsWith('/api/webhooks/')) return 'discord'
  if (host === 'hooks.slack.com') return 'slack'
  if (under('logic.azure.com') || under('powerplatform.com') || under('webhook.office.com')) return 'teams'
  if (host === 'api.telegram.org') return 'telegram'
  if (/\/message\/?$/.test(u.pathname)) return 'gotify'
  if (host.includes('ntfy')) return 'ntfy'
  return 'webhook'
}
