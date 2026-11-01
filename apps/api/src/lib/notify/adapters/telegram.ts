// Telegram Bot API sendMessage: plain text (no parse mode, so nothing is interpreted), no link preview.
// The title starts with the severity word, as Telegram has no colour. The bot token is in the URL path,
// which is one more reason no URL is ever logged.
import type { ChannelNonSecret, ChannelSecret, NotifyMessage, OutboundRequest } from '../types'
import { JSON_HEADERS, plainText } from './common'

export const TELEGRAM_TOKEN = /^\d{3,20}:[A-Za-z0-9_-]{20,80}$/
export const TELEGRAM_CHAT = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,40})$/

export function telegramUrl(botToken: string): string {
  return `https://api.telegram.org/bot${botToken}/sendMessage`
}

export function telegramRequest(secret: ChannelSecret, ns: ChannelNonSecret, m: NotifyMessage): OutboundRequest {
  return { url: telegramUrl(secret.botToken ?? ''), method: 'POST', headers: { ...JSON_HEADERS }, body: JSON.stringify({
    chat_id: ns.chatId ?? '',
    text: plainText(m, 4096),
    disable_web_page_preview: true,
  }) }
}
