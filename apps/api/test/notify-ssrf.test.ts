// The SSRF guard: which URLs a channel may use, which addresses a send may reach, and how a send behaves.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { checkChannelUrl, classifyAddress, checkResolved, guardedSend, ownServicePorts } from '../src/lib/notify/ssrf'

const lookupTo = (...addrs: string[]) => async () => addrs.map(a => ({ address: a, family: a.includes(':') ? 6 : 4 }))

test('address classes: link-local and friends are blocked, private and loopback are private-ish', () => {
  for (const a of ['169.254.169.254', 'fe80::1', '0.0.0.0', '::', '224.0.0.1', '255.255.255.255', 'ff02::1']) assert.equal(classifyAddress(a), 'blocked', a)
  for (const a of ['127.0.0.1', '127.8.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(classifyAddress(a), 'loopback', a)
  for (const a of ['10.0.0.5', '172.16.3.4', '192.168.1.10', '100.64.0.1', 'fd00::1', '::ffff:10.0.0.5']) assert.equal(classifyAddress(a), 'private', a)
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '172.32.0.1']) assert.equal(classifyAddress(a), 'public', a)
})

test('pinned hosts per kind', () => {
  assert.equal(checkChannelUrl('discord', 'https://discord.com/api/webhooks/1/abc', false).ok, true)
  assert.equal(checkChannelUrl('discord', 'https://evil.example.com/api/webhooks/1/abc', false).ok, false)
  assert.equal(checkChannelUrl('discord', 'https://discord.com/other', false).ok, false)
  assert.equal(checkChannelUrl('slack', 'https://hooks.slack.com/services/T/B/x', false).ok, true)
  assert.equal(checkChannelUrl('slack', 'https://hooks.slack.com.evil.example/services/x', false).ok, false)
  assert.equal(checkChannelUrl('teams', 'https://prod-01.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke', false).ok, true)
  assert.equal(checkChannelUrl('teams', 'https://example.com/workflows', false).ok, false)
  assert.equal(checkChannelUrl('ntfy', 'https://ntfy.sh/topic', false).ok, true)
})

test('http only with the self-hosted switch, and the switch only for ntfy, Gotify and webhook', () => {
  assert.equal(checkChannelUrl('ntfy', 'http://ntfy.example.com/t', false).ok, false)
  assert.equal(checkChannelUrl('ntfy', 'http://ntfy.example.com/t', true).ok, true)
  assert.equal(checkChannelUrl('discord', 'http://discord.com/api/webhooks/1/a', true).ok, false)
  assert.equal(checkChannelUrl('webhook', 'ftp://example.com/x', true).ok, false)
  assert.equal(checkChannelUrl('webhook', 'not a url', true).ok, false)
})

test('link-local is refused even with the override; loopback and RFC 1918 need the switch', () => {
  const ports = new Set([9090])
  assert.equal(checkResolved('webhook', ['169.254.169.254'], 80, true, ports).ok, false)
  assert.equal(checkResolved('webhook', ['fe80::1'], 80, true, ports).ok, false)
  assert.equal(checkResolved('ntfy', ['10.0.0.5'], 443, false, ports).ok, false)
  assert.equal(checkResolved('ntfy', ['10.0.0.5'], 443, true, ports).ok, true)
  assert.equal(checkResolved('discord', ['10.0.0.5'], 443, true, ports).ok, false, 'override never applies to pinned kinds')
  // One bad address among good ones is enough to refuse (a resolver can hand out either).
  assert.equal(checkResolved('ntfy', ['8.8.8.8', '127.0.0.1'], 443, false, ports).ok, false)
})

test("HyperProx's own service ports are refused on loopback even with the override", () => {
  const ports = ownServicePorts({ PORT: '3002' })
  for (const p of [3002, 9090, 9221, 3003, 11434, 5432, 6379, 8222, 9100]) assert.ok(ports.has(p), String(p))
  assert.equal(checkResolved('webhook', ['127.0.0.1'], 9090, true, ports).ok, false)
  assert.equal(checkResolved('ntfy', ['127.0.0.1'], 8080, true, ports).ok, true, 'a self-hosted ntfy on the same host works')
  assert.ok(ownServicePorts({ NOTIFY_BLOCKED_PORTS: '7000, 7001' }).has(7001))
})

test('the classic SSRF targets are all refused at send time', async () => {
  const sent: string[] = []
  const o = { lanOverride: false, blockedPorts: new Set([9090]), connect: async () => { sent.push('x'); return { status: 200 } } }
  const r1 = await guardedSend({ url: 'http://127.0.0.1:9090/-/quit', method: 'POST', headers: {}, body: '' }, 'webhook', { ...o, lanOverride: true })
  assert.equal(r1.ok, false); assert.equal(r1.code, 'blocked-address')
  const r2 = await guardedSend({ url: 'http://169.254.169.254/', method: 'POST', headers: {}, body: '' }, 'webhook', { ...o, lanOverride: true })
  assert.equal(r2.code, 'blocked-address')
  const r3 = await guardedSend({ url: 'https://inside.example.com/x', method: 'POST', headers: {}, body: '' }, 'webhook', { ...o, lookup: lookupTo('10.0.0.5') })
  assert.equal(r3.code, 'blocked-address')
  assert.deepEqual(sent, [], 'nothing was connected to')
})

test('checked at send time: a name that turns into loopback later is refused (DNS rebinding)', async () => {
  let addr = '8.8.8.8'
  const connected: string[] = []
  const o = {
    lanOverride: false, blockedPorts: new Set<number>(),
    lookup: async () => [{ address: addr, family: 4 }],
    connect: async (_req: any, pinned: string) => { connected.push(pinned); return { status: 204 } },
  }
  const req = { url: 'https://hooks.example.com/x', method: 'POST' as const, headers: {}, body: '{}' }
  assert.equal((await guardedSend(req, 'webhook', o)).ok, true)
  addr = '127.0.0.1'
  assert.equal((await guardedSend(req, 'webhook', o)).code, 'blocked-address')
  assert.deepEqual(connected, ['8.8.8.8'], 'the request goes to the checked address')
})

test('a 302 is a failure and is not followed; only 1 KB of a body is read', async () => {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:9090/-/quit' }); res.end(); return }
    if (req.url === '/big') { res.writeHead(500); res.end('x'.repeat(1_000_000)); return }
    if (req.url === '/slow') { res.writeHead(429, { 'Retry-After': '42' }); res.end(); return }
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => { res.writeHead(204); res.end() })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  const o = { lanOverride: true, blockedPorts: new Set<number>() }
  try {
    const base = `http://127.0.0.1:${port}`
    const red = await guardedSend({ url: `${base}/redirect`, method: 'POST', headers: {}, body: '{}' }, 'webhook', o)
    assert.equal(red.ok, false); assert.equal(red.code, 'redirect'); assert.equal(red.status, 302)
    const big = await guardedSend({ url: `${base}/big`, method: 'POST', headers: {}, body: '{}' }, 'webhook', o)
    assert.equal(big.ok, false); assert.equal(big.status, 500)
    const slow = await guardedSend({ url: `${base}/slow`, method: 'POST', headers: {}, body: '{}' }, 'webhook', o)
    assert.equal(slow.status, 429); assert.equal(slow.retryAfterSec, 42)
    const ok = await guardedSend({ url: `${base}/ok`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' }, 'webhook', o)
    assert.equal(ok.ok, true); assert.equal(ok.status, 204)
    assert.deepEqual(hits, ['/redirect', '/big', '/slow', '/ok'], 'the redirect target was never requested')
    const refused = await guardedSend({ url: `http://127.0.0.1:1/x`, method: 'POST', headers: {}, body: '' }, 'webhook', o)
    assert.equal(refused.ok, false); assert.equal(refused.code, 'ECONNREFUSED')
  } finally { server.close() }
})
