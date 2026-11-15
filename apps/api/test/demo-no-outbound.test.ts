// The demo's no-outbound guard (src/demo/no-outbound.ts). Node runs each test file in its own process, so
// installing the guard here touches nothing else.
//
//  - TCP, TLS, http, https and fetch to anything but loopback fail, without a packet leaving.
//  - DNS: no lookup or resolver query for any name but localhost.
//  - UDP: no send to anything but loopback.
//  - Loopback keeps working, so the demo can still serve its pages and talk to its own frontend.
//  - The demo entrypoint installs it before anything else.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import dns from 'node:dns'
import dgram from 'node:dgram'
import { installNoOutbound, isLoopback, refusedTargets } from '../src/demo/no-outbound'

before(() => installNoOutbound())

const failure = (start: (done: (e: unknown) => void) => void) => new Promise<any>(resolve => {
  const t = setTimeout(() => resolve(new Error('no error within 3 s')), 3000)
  start(e => { clearTimeout(t); resolve(e) })
})

test('loopback is the only place allowed', () => {
  for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1', undefined, '']) assert.equal(isLoopback(h), true, String(h))
  for (const h of ['10.0.0.1', '192.0.2.1', 'example.com', '0.0.0.0', '::', 'localhost.example.com', '128.0.0.1']) assert.equal(isLoopback(h), false, String(h))
})

test('tcp, tls, http and https to another machine are refused', async () => {
  const tcp = await failure(done => net.connect(80, '192.0.2.1').on('error', done))
  assert.equal(tcp.code, 'EDEMO_OUTBOUND')
  const tcpOpts = await failure(done => net.connect({ host: '198.51.100.7', port: 443 }).on('error', done))
  assert.equal(tcpOpts.code, 'EDEMO_OUTBOUND')
  const tlsErr = await failure(done => tls.connect({ host: '203.0.113.5', port: 443 }).on('error', done))
  assert.equal(tlsErr.code, 'EDEMO_OUTBOUND')
  const h = await failure(done => http.get('http://192.0.2.10/', () => done(null)).on('error', done))
  assert.equal(h.code, 'EDEMO_OUTBOUND')
  const hs = await failure(done => https.get('https://203.0.113.20/', () => done(null)).on('error', done))
  assert.equal(hs.code, 'EDEMO_OUTBOUND')
})

test('fetch to another machine, by address or by name, is refused', async () => {
  for (const url of ['http://192.0.2.30/', 'https://example.com/']) {
    const err = await fetch(url).then(() => null, e => e)
    assert.ok(err, `${url} should fail`)
    const cause = (err as any).cause
    assert.ok(/EDEMO_OUTBOUND/.test(String(cause?.code)) || /no outbound/.test(String(cause?.message ?? err.message)), `${url}: ${String(cause?.code ?? err.message)}`)
  }
})

test('dns: no lookups or queries for any name but localhost', async () => {
  const cb = await failure(done => dns.lookup('example.com', e => done(e)))
  assert.equal(cb.code, 'EDEMO_OUTBOUND')
  await assert.rejects(dns.promises.lookup('example.org'), { code: 'EDEMO_OUTBOUND' })
  await assert.rejects(dns.promises.resolve4('example.net'), { code: 'EDEMO_OUTBOUND' })
  await assert.rejects(new dns.promises.Resolver().resolveTxt('example.com'), { code: 'EDEMO_OUTBOUND' })
  const r = await failure(done => dns.resolveMx('example.com', e => done(e)))
  assert.equal(r.code, 'EDEMO_OUTBOUND')
  const local = await dns.promises.lookup('localhost')
  assert.ok(isLoopback(local.address))
  // An address written out asks no server (listening on a LAN address looks it up); connecting to it is still refused.
  assert.equal((await dns.promises.lookup('192.0.2.77')).address, '192.0.2.77')
  const viaLiteral = await failure(done => net.connect(80, '192.0.2.77').on('error', done))
  assert.equal(viaLiteral.code, 'EDEMO_OUTBOUND')
})

test('udp: no sends to another machine', async () => {
  const sock = dgram.createSocket('udp4')
  try {
    const err = await failure(done => sock.send(Buffer.from('x'), 53, '192.0.2.53', e => done(e)))
    assert.equal(err?.code, 'EDEMO_OUTBOUND')
    assert.throws(() => sock.connect(53, '198.51.100.53'), { code: 'EDEMO_OUTBOUND' })
  } finally { sock.close() }
})

test('loopback still works: the demo talks to its own frontend', async () => {
  const srv = http.createServer((_q, s) => s.end('ok'))
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  try {
    const port = (srv.address() as net.AddressInfo).port
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok')
    assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), 'ok')
  } finally { srv.close() }
  assert.ok(refusedTargets().length >= 8, 'every refusal above was recorded')
})

test('the demo entrypoint installs the guard before it loads anything else', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/demo/main.ts'), 'utf8')
  const code = src.split('\n').filter(l => l.trim() && !l.trim().startsWith('//'))
  assert.match(code[0], /^import \{ installNoOutbound \} from '\.\/no-outbound'/)
  assert.match(code[1], /^installNoOutbound\(\)/)
})
