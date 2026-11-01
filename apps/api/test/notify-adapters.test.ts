// The exact request each channel kind sends for one message.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { buildRequest, detectKind } from '../src/lib/notify/adapters'
import type { NotifyMessage } from '../src/lib/notify/types'

const MSG: NotifyMessage = {
  id: 'evt_1', type: 'certs.verdict.changed', severity: 'critical', resolved: false,
  title: 'Certificate problem on mail', lines: ['mail.example.com:993: CRITICAL', 'Expires in 2 days.'],
  link: 'https://hyperprox.example.com/certificates', linkLabel: 'Open', hint: 'Open the Certificates page in HyperProx.',
  fingerprint: 'certs:mail', at: '2026-11-01T10:00:00.000Z',
}
const NOLINK: NotifyMessage = { ...MSG, link: null }

test('detectKind from a pasted URL', () => {
  assert.equal(detectKind('https://discord.com/api/webhooks/1/abc'), 'discord')
  assert.equal(detectKind('https://hooks.slack.com/services/T/B/x'), 'slack')
  assert.equal(detectKind('https://prod-01.westus.logic.azure.com/workflows/x'), 'teams')
  assert.equal(detectKind('https://gotify.example.com/message'), 'gotify')
  assert.equal(detectKind('https://ntfy.sh/topic'), 'ntfy')
  assert.equal(detectKind('https://api.telegram.org/bot1:abc/sendMessage'), 'telegram')
  assert.equal(detectKind('https://hooks.example.com/x'), 'webhook')
  assert.equal(detectKind('https://evil.example.com/discord.com/api/webhooks/1'), 'webhook')
})

test('Discord: one embed with the severity colour, the link, and no mention can ping', () => {
  const r = buildRequest('discord', { url: 'https://discord.com/api/webhooks/1/abc' }, {}, MSG)
  assert.equal(r.url, 'https://discord.com/api/webhooks/1/abc')
  assert.deepEqual(JSON.parse(r.body), {
    embeds: [{
      title: 'Certificate problem on mail',
      description: 'mail.example.com:993: CRITICAL\nExpires in 2 days.\nOpen: https://hyperprox.example.com/certificates',
      color: 0xE5484D, url: 'https://hyperprox.example.com/certificates', timestamp: '2026-11-01T10:00:00.000Z',
    }],
    allowed_mentions: { parse: [] },
  })
})

test('Discord: the embed stays within 4096 characters however long the lines', () => {
  const long = { ...MSG, lines: Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(80)}`) }
  const b = JSON.parse(buildRequest('discord', { url: 'https://discord.com/api/webhooks/1/abc' }, {}, long).body)
  assert.ok(b.embeds[0].description.length <= 4096)
  assert.match(b.embeds[0].description, /more/)
})

test('Slack: attachment colour, escaped text, title link', () => {
  const m = { ...MSG, lines: ['<!channel> a & b'] }
  const r = buildRequest('slack', { url: 'https://hooks.slack.com/services/T/B/x' }, {}, m)
  assert.deepEqual(JSON.parse(r.body), {
    text: 'Critical: Certificate problem on mail',
    attachments: [{ color: '#E5484D', title: 'Certificate problem on mail', title_link: 'https://hyperprox.example.com/certificates',
      text: '&lt;!channel&gt; a &amp; b\n<https://hyperprox.example.com/certificates|Open>' }],
  })
})

test('Teams: an Adaptive Card with the container style for the severity', () => {
  const r = buildRequest('teams', { url: 'https://prod-01.westus.logic.azure.com/workflows/x' }, {}, { ...MSG, severity: 'warning' })
  const b = JSON.parse(r.body)
  assert.equal(b.type, 'message')
  const card = b.attachments[0]
  assert.equal(card.contentType, 'application/vnd.microsoft.card.adaptive')
  assert.equal(card.content.type, 'AdaptiveCard')
  assert.equal(card.content.body[0].style, 'warning')
  assert.deepEqual(card.content.body[0].items.map((i: any) => i.text),
    ['Certificate problem on mail', 'mail.example.com:993: CRITICAL', 'Expires in 2 days.'])
  assert.deepEqual(card.content.actions, [{ type: 'Action.OpenUrl', title: 'Open', url: 'https://hyperprox.example.com/certificates' }])
  const resolved = JSON.parse(buildRequest('teams', { url: 'https://prod-01.westus.logic.azure.com/workflows/x' }, {}, { ...MSG, resolved: true }).body)
  assert.equal(resolved.attachments[0].content.body[0].style, 'good')
})

test('ntfy: priority by severity, Click and a view action, the token only in Authorization', () => {
  const r = buildRequest('ntfy', { url: 'https://ntfy.example.com/alerts', token: 'tk_1' }, {}, MSG)
  assert.deepEqual(r.headers, {
    'Content-Type': 'text/plain; charset=utf-8', Title: 'Certificate problem on mail', Priority: '5', Tags: 'rotating_light',
    Click: MSG.link!, Actions: `view, Open, ${MSG.link}, clear=true`, Authorization: 'Bearer tk_1',
  })
  assert.equal(r.body, 'mail.example.com:993: CRITICAL\nExpires in 2 days.\nOpen: https://hyperprox.example.com/certificates')
  const warn = buildRequest('ntfy', { url: 'https://ntfy.example.com/alerts' }, {}, { ...NOLINK, severity: 'warning' })
  assert.equal(warn.headers.Priority, '4')
  assert.equal(warn.headers.Click, undefined)
  assert.equal(warn.headers.Authorization, undefined)
  assert.match(warn.body, /Open the Certificates page/)
  const utf = buildRequest('ntfy', { url: 'https://ntfy.example.com/alerts' }, {}, { ...MSG, title: 'Disque plein — nœud' })
  assert.match(utf.headers.Title, /^=\?UTF-8\?B\?/)
})

test('Gotify: priority 8/5/2, app token header, click URL in extras', () => {
  const r = buildRequest('gotify', { url: 'https://gotify.example.com/message', token: 'A1' }, {}, MSG)
  assert.equal(r.headers['X-Gotify-Key'], 'A1')
  assert.deepEqual(JSON.parse(r.body), {
    title: 'Certificate problem on mail',
    message: 'mail.example.com:993: CRITICAL\nExpires in 2 days.\nOpen: https://hyperprox.example.com/certificates',
    priority: 8,
    extras: { 'client::display': { contentType: 'text/plain' }, 'client::notification': { click: { url: MSG.link } } },
  })
  assert.equal(JSON.parse(buildRequest('gotify', { url: 'https://g.example.com/message', token: 'A' }, {}, { ...MSG, severity: 'info' }).body).priority, 2)
})

test('Telegram: plain text starting with the severity word; the bot token only in the URL path', () => {
  const r = buildRequest('telegram', { botToken: '123:ABC' }, { chatId: '-1001' }, MSG)
  assert.equal(r.url, 'https://api.telegram.org/bot123:ABC/sendMessage')
  assert.deepEqual(JSON.parse(r.body), {
    chat_id: '-1001',
    text: 'Critical: Certificate problem on mail\nmail.example.com:993: CRITICAL\nExpires in 2 days.\nOpen: https://hyperprox.example.com/certificates',
    disable_web_page_preview: true,
  })
  assert.equal(r.body.includes('123:ABC'), false)
})

test('generic webhook: the documented payload, and an HMAC signature when a secret is set', () => {
  const plain = buildRequest('webhook', { url: 'https://hooks.example.com/x' }, {}, MSG)
  assert.deepEqual(JSON.parse(plain.body), {
    version: 1, id: 'evt_1', type: 'certs.verdict.changed', event: 'certs.verdict.changed', severity: 'critical', resolved: false,
    title: 'Certificate problem on mail', lines: MSG.lines, subject: null, at: MSG.at, url: MSG.link, fingerprint: 'certs:mail',
    content: 'Critical: Certificate problem on mail: mail.example.com:993: CRITICAL Expires in 2 days. Open: https://hyperprox.example.com/certificates',
    text: 'Critical: Certificate problem on mail: mail.example.com:993: CRITICAL Expires in 2 days. Open: https://hyperprox.example.com/certificates',
  })
  assert.equal(plain.headers['X-HyperProx-Signature'], undefined)
  const signed = buildRequest('webhook', { url: 'https://hooks.example.com/x', signingSecret: 's3cret' }, {}, MSG, new Date('2026-11-01T10:00:05Z'))
  const ts = signed.headers['X-HyperProx-Timestamp']
  assert.equal(ts, String(Date.parse('2026-11-01T10:00:05Z') / 1000))
  const want = crypto.createHmac('sha256', 's3cret').update(`${ts}.${signed.body}`).digest('hex')
  assert.equal(signed.headers['X-HyperProx-Signature'], `sha256=${want}`)
  assert.equal(signed.body.includes('s3cret'), false)
})
