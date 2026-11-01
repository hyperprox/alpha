// The SSRF guard: which URLs a channel may use, which addresses a send may reach, and how a send behaves.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import net from 'node:net'
import { checkChannelUrl, classifyAddress, checkResolved, guardedSend, ownServicePorts, canonicalIp, bridgeNets } from '../src/lib/notify/ssrf'

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

// --- Fix round 1 -------------------------------------------------------------------------------

const OWN = '192.168.50.7'
const OWN_FORMS = [
  '::ffff:192.168.50.7', '::ffff:c0a8:3207', '::FFFF:C0A8:3207', '0:0:0:0:0:ffff:c0a8:3207',
  '0000:0000:0000:0000:0000:ffff:c0a8:3207', '::0:ffff:c0a8:3207',
  '64:ff9b::c0a8:3207', '64:ff9b::192.168.50.7', '[::ffff:c0a8:3207]',
]

test('every spelling of an IPv4 inside IPv6 is the same address', () => {
  for (const f of OWN_FORMS) assert.equal(canonicalIp(f), OWN, f)
  assert.equal(canonicalIp('2001:db8::1'), '2001:db8:0:0:0:0:0:1')
  assert.equal(canonicalIp('2001:0DB8:0000:0000:0000:0000:0000:0001'), '2001:db8:0:0:0:0:0:1')
  assert.equal(canonicalIp('fe80::1%eth0'), 'fe80:0:0:0:0:0:0:1')
  assert.equal(canonicalIp('not-an-ip'), null)
  for (const a of ['::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:0001', '64:ff9b::7f00:1', '::127.0.0.1']) assert.equal(classifyAddress(a), 'loopback', a)
  assert.equal(classifyAddress('::ffff:a9fe:a9fe'), 'blocked', 'metadata, hex-mapped')
  assert.equal(classifyAddress('64:ff9b::a9fe:a9fe'), 'blocked', 'metadata through NAT64')
  assert.equal(classifyAddress('64:ff9b::808:808'), 'public')
  assert.equal(classifyAddress('::ffff:c0a8:3207'), 'private')
})

test("this host's own address on a service port is refused in every spelling, self-hosted switch on", async () => {
  const ports = ownServicePorts({})
  for (const f of [OWN, ...OWN_FORMS]) {
    assert.equal(checkResolved('webhook', [f], 9090, true, ports, new Set([OWN])).ok, false, f)
    // ...and the own-address set itself may be in any spelling.
    assert.equal(checkResolved('webhook', [OWN], 9090, true, ports, new Set([f])).ok, false, `own as ${f}`)
  }
  assert.equal(checkResolved('webhook', [OWN], 8080, true, ports, new Set([OWN])).ok, true, 'another port on this host is fine')
  const connected: string[] = []
  const o = { lanOverride: true, blockedPorts: ports, ownAddresses: [OWN], bridges: new net.BlockList(), connect: async (_r: any, a: string) => { connected.push(a); return { status: 200 } } }
  for (const u of ['http://[::ffff:c0a8:3207]:9090/-/quit', 'http://[::ffff:192.168.50.7]:9090/-/quit', 'http://[0:0:0:0:0:ffff:c0a8:3207]:9090/-/quit',
                   'http://[64:ff9b::c0a8:3207]:9090/-/quit', 'http://[::ffff:7f00:1]:9090/-/quit']) {
    assert.equal((await guardedSend({ url: u, method: 'POST', headers: {}, body: '' }, 'webhook', o)).code, 'blocked-address', u)
  }
  assert.deepEqual(connected, [])
})

test('NPM admin port 81 is one of the blocked ports', () => {
  assert.ok(ownServicePorts({}).has(81))
  assert.equal(checkResolved('webhook', ['127.0.0.1'], 81, true, ownServicePorts({})).ok, false)
})

test('Docker bridge networks are refused, self-hosted or not, in any spelling', () => {
  const ifaces: any = {
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', cidr: '127.0.0.1/8', internal: true, mac: '' }],
    eth0: [{ address: '10.1.2.3', netmask: '255.255.255.0', family: 'IPv4', cidr: '10.1.2.3/24', internal: false, mac: '' }],
    docker0: [{ address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', cidr: '172.17.0.1/16', internal: false, mac: '' }],
    'br-0123456789ab': [{ address: '172.18.0.1', netmask: '255.255.0.0', family: 'IPv4', cidr: '172.18.0.1/16', internal: false, mac: '' }],
  }
  const b = bridgeNets(ifaces)
  const ports = ownServicePorts({})
  for (const a of ['172.17.0.2', '172.18.0.5', '::ffff:172.18.0.5', '::ffff:ac12:5']) {
    assert.equal(checkResolved('ntfy', [a], 8080, true, ports, new Set(), b).ok, false, a)
  }
  assert.equal(checkResolved('ntfy', ['10.1.2.50'], 8080, true, ports, new Set(), b).ok, true, 'the LAN is not a bridge')
  assert.equal(checkResolved('ntfy', ['172.19.0.5'], 8080, true, ports, new Set(), b).ok, true, 'another 172.16/12 network without a bridge')
})

test('a DNS answer that never comes times out', async () => {
  const r = await guardedSend({ url: 'https://slow.example.com/x', method: 'POST', headers: {}, body: '' }, 'webhook',
    { lanOverride: false, dnsTimeoutMs: 50, lookup: () => new Promise(() => undefined), connect: async () => ({ status: 200 }) })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DNSTimeout')
})
