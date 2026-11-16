// The 3proxy plug-in page's pieces, rendered to HTML: the traffic panel (trace, connections per protocol, who used it,
// refusals), "How to use this proxy", the shield with the self-check, the problem list with a fix button each, and the
// pure logic behind them (vault field, the network rule, the trace path).
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import "./css-stub"
import { renderToStaticMarkup } from 'react-dom/server'
import { ForwardProxyPanel, TrafficTrace } from '../components/plugins/fwdproxy/ForwardProxyPanel'
import { HowToUse, ProblemList, Shield } from '../components/plugins/fwdproxy/ThreeProxyPage'
import { areaPath, checkNetworks, endpoints, fieldFor, howTo, rate, ruleWords, size, type Reading } from '../components/plugins/fwdproxy/logic'

const reading = (o: Partial<Reading> = {}): Reading => ({
  at: 0, active: true, version: '0.9.9.2', listen: '10.20.30.37', minutes: 5,
  allow: ['10.20.30.0/24'], lanTargets: false, perClient: true, users: ['alice', 'laptop'], http: true, socks: true,
  conns: { http: 2, socks: 5 },
  perMinute: [0, 4, 8, 2, 6].map((n, i) => ({ at: i * 60_000, requests: n, bytes: n * 1024 })),
  totals: { requests: 20, bytes: 20 * 1024, denied: 4, errors: 0 },
  denied: [{ code: '7', label: 'No or wrong password', count: 3 }, { code: '1', label: 'Blocked by a rule', count: 1 }],
  services: [{ name: 'HTTP', requests: 12, bytes: 15_000 }, { name: 'SOCKS', requests: 8, bytes: 5_000 }],
  byUser: [{ name: 'alice', requests: 12, bytes: 15_000 }], byClient: [{ address: '10.20.30.55', requests: 12, bytes: 15_000 }],
  ...o,
})

test('the panel: trace, connections per protocol, requests per protocol, who used it, refusals in words', () => {
  const html = renderToStaticMarkup(<ForwardProxyPanel r={reading()} />)
  assert.match(html, /20 requests and 20\.0 KB in the last 5 minutes; busiest minute 8 requests/)
  assert.match(html, /HTTP connections: 2/)
  assert.match(html, /SOCKS connections: 5/)
  assert.match(html, /Requests per protocol/)
  assert.match(html, /Traffic by user/)
  assert.match(html, /Traffic by device/)
  assert.match(html, /No or wrong password/)
  assert.ok(!/from cache|Busiest sites/.test(html), '3proxy keeps no cache and no site list')
})

test('a protocol that is off has no ring; per-user figures off says so', () => {
  const html = renderToStaticMarkup(<ForwardProxyPanel r={reading({ socks: false, conns: { http: 1, socks: null }, perClient: false, byUser: [], byClient: [] })} />)
  assert.ok(!/SOCKS connections/.test(html))
  assert.match(html, /Per-user and per-device figures are off/)
})

test('an empty window draws a flat trace, not an error', () => {
  const html = renderToStaticMarkup(<TrafficTrace r={reading({ perMinute: [], totals: { requests: 0, bytes: 0, denied: 0, errors: 0 } })} />)
  assert.match(html, /0 requests and 0 B/)
})

test('How to use this proxy: the address and port per protocol, and where each device takes it', () => {
  const both = renderToStaticMarkup(<HowToUse listen="10.20.30.37" r={reading()} />)
  assert.match(both, /HTTP proxy/)
  assert.match(both, /10\.20\.30\.37:3128/)
  assert.match(both, /SOCKS5 proxy/)
  assert.match(both, /10\.20\.30\.37:1080/)
  assert.match(both, /Windows/)
  assert.match(both, /macOS/)
  assert.match(both, /Proxy DNS when using SOCKS v5/)
  assert.match(both, /Only devices on 10\.20\.30\.0\/24/)
  assert.deepEqual(endpoints('10.0.0.1', { http: true, socks: false }).map(e => e.port), [3128])
  assert.ok(!howTo('10.0.0.1', { http: true, socks: false }).some(h => h.where === 'Firefox'))
})

test('the shield: rules in words, a failed check is a problem, an allowed LAN is a warning', () => {
  const ok = renderToStaticMarkup(<Shield r={reading()} checks={[{ id: 'http_auth', state: 'ok', detail: 'Without a password: refused (407).' }]} />)
  assert.match(ok, /aria-label="Locked down"/)
  assert.match(ok, /Cannot reach your own network/)
  assert.match(ok, /HTTPS tunnels only to port 443/)
  assert.match(ok, /SOCKS never to port 25/)
  assert.match(ok, /At most 256 connections at once/)
  assert.match(ok, /Passed: Sign-in required \(HTTP\)/)
  assert.match(renderToStaticMarkup(<Shield r={reading({ lanTargets: true })} checks={null} />), /with an exception you allowed/)
  assert.match(renderToStaticMarkup(<Shield r={reading()} checks={[{ id: 'socks_lan', state: 'fail', detail: 'x' }]} />), /Needs a look[\s\S]*FAILED/)
  assert.ok(!ruleWords(reading({ http: false })).some(r => r.id === 'tls'))
})

test('problems: worst first, each with its fix button', () => {
  const html = renderToStaticMarkup(<ProblemList busy={null} onFix={() => {}} problems={[
    { id: 'lan_open', severity: 'warn', title: 'It can reach your own network', detail: 'd', fix: { id: 'block_lan', label: 'Block my network again', confirm: 'c' } },
    { id: 'stopped', severity: 'bad', title: '3proxy is not running', detail: 'd', fix: { id: 'reload', label: 'Start it again' } },
  ]} />)
  assert.ok(html.indexOf('not running') < html.indexOf('reach your own network'))
  assert.match(html, /Start it again/)
  assert.match(html, /Block my network again/)
  assert.match(renderToStaticMarkup(<ProblemList busy={null} onFix={() => {}} problems={[]} />), /No problems/)
})

test('logic: vault field per user, the network rule (masked, inside a private block), the trace path, sizes and rate', () => {
  assert.equal(fieldFor('alice', { admin_user: 'alice', admin_password: 'p' }), 'admin_password')
  assert.equal(fieldFor('laptop', { admin_user: 'alice', user_laptop: 'p' }), 'user_laptop')
  assert.equal(fieldFor('ghost', { admin_user: 'alice' }), null)
  assert.equal(checkNetworks('10.0.0.0/8, 10.0.5.0/24').ok, true)
  assert.match(checkNetworks('0.0.0.0/0').problem!, /not a private network/)
  assert.match(checkNetworks('203.0.113.0/24').problem!, /not a private network/)
  for (const bad of ['192.168.0.0/8', '172.16.0.0/8', '172.16.0.0/11', '192.168.1.0/8', '10.0.0.5/24']) assert.equal(checkNetworks(bad).ok, false, bad)
  for (const ok of ['10.0.0.0/8', '172.16.0.0/12', '192.168.1.0/24']) assert.equal(checkNetworks(ok).ok, true, ok)
  assert.equal(checkNetworks('').ok, false)
  const p = areaPath([0, 10, 5], 100, 50)
  assert.match(p.line, /^M0 48 L50 2 L100 25$/)
  assert.match(p.area, / Z$/)
  assert.equal(size(1536), '1.5 KB')
  assert.equal(rate(reading()), 4)
})
