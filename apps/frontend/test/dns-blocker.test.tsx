// The DNS blocker page's pieces, rendered to HTML: the 24-hour flow, the blocked domains with an Allow button each (admins
// only), the devices (or the note that they are hidden), the upstream rack with each server's state in words, the list
// freshness, the problem cards with their fix buttons (disabled with the reason for a role that cannot use them, and
// marked when they ask for the master password), pause controls, and the pure logic behind them.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import "./css-stub"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { Clients, ListFreshness, PauseControls, Problems, QueryFlow, TopBlocked, UpstreamRack } from '../components/plugins/dns-blocker/DnsBlockerVisual'
import {
  ageWords, allowPhrase, cleanDomainInput, hudChips, looksLikeDomain, num, pauseLeft, pointNetworkSteps, queryBars, shieldTone, whyNot, type ActionName, type Problem, type Reading,
} from '../components/plugins/dns-blocker/logic'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 16, 12, 30)

function reading(o: Partial<Reading> = {}): Reading {
  return {
    kind: 'pihole', fetchedAt: new Date(NOW).toISOString(), version: '2026.10.1', newerVersion: null,
    protection: { on: true, secondsLeft: null },
    totals: { queries: 12840, blocked: 3210, percentBlocked: 25, cached: 4000, clients: 3, avgMs: 31 },
    topBlocked: [{ domain: 'ads.example.net', count: 900 }, { domain: 'tracker.example.org', count: 450 }],
    topDomains: [{ domain: 'example.com', count: 300 }],
    clients: [{ name: 'laptop', ip: '192.0.2.205', count: 700 }, { name: null, ip: '192.0.2.206', count: 200 }],
    clientsHidden: false,
    upstreams: [
      { address: '1.1.1.1', name: 'one.one.one.one', queries: 800, avgMs: 22, state: 'ok', detail: 'answered a test lookup in 12 ms', probeMs: 12 },
      { address: '192.0.2.9', name: null, queries: 0, avgMs: null, state: 'failing', detail: 'did not answer a test lookup', probeMs: null },
    ],
    blocklists: { domains: 76105, lists: 1, updatedAt: new Date(NOW - 5 * HOUR).toISOString(), ageHours: 5, stale: false },
    history: Array.from({ length: 24 }, (_, i) => ({ at: NOW - (23 - i) * HOUR, total: i === 23 ? 900 : i * 10, blocked: i === 23 ? 300 : i * 2 })),
    answering: { ok: true, ms: 3, detail: 'answered' }, problems: [], missing: [], ...o,
  }
}

const noop = () => {}
const fixOf = (action: ActionName, secure: boolean, label = 'Fix it'): Problem['fix'] => ({ action, label, secure })

test('the 24-hour flow: a bar per hour, each with its words, and an honest note when nothing was asked', () => {
  const html = renderToStaticMarkup(<QueryFlow r={reading()} now={NOW} />)
  assert.equal((html.match(/<li /g) ?? []).length, 24)
  assert.match(html, /aria-label="This hour: 900 queries, 300 blocked"/)
  assert.match(html, /aria-label="23 hours ago: 0 queries, 0 blocked"/)
  assert.match(html, /Busiest: This hour: 900 queries, 300 blocked/)
  assert.match(html, /all queries[\s\S]*blocked[\s\S]*24 hours, oldest on the left/)
  const empty = renderToStaticMarkup(<QueryFlow r={reading({ history: reading().history.map(h => ({ ...h, total: 0, blocked: 0 })) })} now={NOW} />)
  assert.match(empty, /No queries in the last 24 hours yet/); assert.ok(!/<li /.test(empty))
})

test('blocked most: every domain has its count, and only an admin gets the Allow button', () => {
  const admin = renderToStaticMarkup(<TopBlocked r={reading()} canAllow onAllow={noop} />)
  assert.match(admin, /ads\.example\.net/); assert.match(admin, /900/)
  assert.match(admin, /aria-label="Allow ads\.example\.net"/); assert.equal((admin.match(/<button/g) ?? []).length, 2)
  const viewer = renderToStaticMarkup(<TopBlocked r={reading()} canAllow={false} onAllow={noop} />)
  assert.ok(!/<button/.test(viewer))
  assert.match(renderToStaticMarkup(<TopBlocked r={reading({ topBlocked: [] })} canAllow onAllow={noop} />), /Nothing has been blocked yet/)
})

test('devices: names or addresses; hidden says so and offers to show them again (admins); a viewer is told why', () => {
  const shown = renderToStaticMarkup(<Clients r={reading()} canHide hidden={false} onToggleHide={noop} />)
  assert.match(shown, /laptop/); assert.match(shown, /192\.0\.2\.206/); assert.match(shown, /Hide per-device numbers/)
  assert.ok(!/Hide per-device numbers/.test(renderToStaticMarkup(<Clients r={reading()} canHide={false} hidden={false} onToggleHide={noop} />)))
  const hidden = renderToStaticMarkup(<Clients r={reading({ clients: null, clientsHidden: true })} canHide hidden onToggleHide={noop} />)
  assert.match(hidden, /hidden for this blocker, so HyperProx does not even ask/); assert.match(hidden, /3 devices asked something/); assert.match(hidden, /Show devices again/)
  assert.ok(!/192\.0\.2\./.test(hidden), 'no address in the hidden view')
  const viewer = renderToStaticMarkup(<Clients r={reading({ clients: null, clientsHidden: true })} canHide={false} hidden={false} onToggleHide={noop} />)
  assert.match(viewer, /shown to operators and admins only/); assert.ok(!/<button/.test(viewer))
})

test('the upstream rack says each server\'s state in words, with its time', () => {
  const html = renderToStaticMarkup(<UpstreamRack r={reading()} />)
  assert.match(html, /data-state="ok"/); assert.match(html, /data-state="failing"/)
  assert.match(html, /answering/); assert.match(html, /not answering/)
  assert.match(html, /12 ms/); assert.match(html, /one\.one\.one\.one/)
  assert.match(html, /did not answer a test lookup/)
  assert.match(renderToStaticMarkup(<UpstreamRack r={reading({ upstreams: [] })} />), /No upstream servers reported/)
})

test('block lists: the age in words, overdue said in words as well as colour', () => {
  assert.match(renderToStaticMarkup(<ListFreshness r={reading()} />), /5 hours ago/)
  const stale = reading({ blocklists: { domains: 100, lists: 1, updatedAt: null, ageHours: 400, stale: true } })
  assert.match(renderToStaticMarkup(<ListFreshness r={stale} />), /17 days ago \(overdue\)/)
  assert.match(renderToStaticMarkup(<ListFreshness r={reading({ blocklists: { domains: null, lists: null, updatedAt: null, ageHours: null, stale: false } })} />), /not reported/)
})

test('problems: each card says how bad it is, and has its fix button; a role that cannot use it sees why', () => {
  const problems: Problem[] = [
    { id: 'protection_off', severity: 'warn', text: 'Blocking is turned off.', fix: fixOf('resume', false, 'Turn blocking back on') },
    { id: 'not_answering', severity: 'bad', text: 'It did not answer.', fix: fixOf('restart_service', true, 'Restart Pi-hole') },
    { id: 'no_queries', severity: 'info', text: 'No device has asked yet.', fix: null },
  ]
  const op = renderToStaticMarkup(<Problems problems={problems} role="operator" busy={null} onFix={noop} onHowTo={noop} />)
  assert.match(op, /Needs a look/); assert.match(op, /Not working/); assert.match(op, /To know/)
  assert.match(op, /Turn blocking back on/); assert.ok(!/Turn blocking back on \(master password\)/.test(op), 'a normal action asks for no password')
  assert.match(op, /Restart Pi-hole[^<]*<\/button>/); assert.match(op, /disabled=""[^>]*title="Only an admin can do this\."/)
  assert.match(op, /How to point my network at it/)
  const admin = renderToStaticMarkup(<Problems problems={problems} role="admin" busy={null} onFix={noop} onHowTo={noop} />)
  assert.match(admin, /Restart Pi-hole \(master password\)/)
  const viewer = renderToStaticMarkup(<Problems problems={problems} role="viewer" busy={null} onFix={noop} onHowTo={noop} />)
  assert.match(viewer, /Only an operator or admin can do this\./)
  const busy = renderToStaticMarkup(<Problems problems={problems} role="admin" busy="protection_off" onFix={noop} onHowTo={noop} />)
  assert.match(busy, /Working…/)
  assert.match(renderToStaticMarkup(<Problems problems={[]} role="admin" busy={null} onFix={noop} onHowTo={noop} />), /Nothing needs a look/)
})

test('pause controls: three lengths when blocking is on; the way back, with the time left, when it is off', () => {
  const on = renderToStaticMarkup(<PauseControls r={reading()} role="operator" busy={false} onPause={noop} onResume={noop} />)
  for (const m of ['5 min', '30 min', '60 min']) assert.match(on, new RegExp(m))
  assert.ok(!/Turn blocking back on/.test(on))
  const off = renderToStaticMarkup(<PauseControls r={reading({ protection: { on: false, secondsLeft: 300 } })} role="operator" busy={false} onPause={noop} onResume={noop} />)
  assert.match(off, /Blocking is off, back on in 5 minutes/); assert.match(off, /Turn blocking back on/)
  assert.match(renderToStaticMarkup(<PauseControls r={reading()} role="viewer" busy={false} onPause={noop} onResume={noop} />), /disabled=""/, 'a viewer cannot pause')
})

test('logic: the shield, the chips, the bars, the words', () => {
  assert.equal(shieldTone(reading()), 'good')
  assert.equal(shieldTone(reading({ problems: [{ id: 'lists_stale', severity: 'warn', text: 'x', fix: null }] })), 'warn')
  assert.equal(shieldTone(reading({ protection: { on: false, secondsLeft: null } })), 'crit')
  assert.equal(shieldTone(reading({ answering: { ok: false, ms: null, detail: null } })), 'crit')
  assert.deepEqual(hudChips(reading()).map(c => [c.label, c.value]), [['status', 'protected'], ['blocking', 'on'], ['queries', '12,840'], ['blocked', '25%'], ['answer time', '3 ms']])
  const bars = queryBars(reading().history, NOW)
  assert.equal(bars.length, 24); assert.equal(bars[23].totalPct, 100); assert.equal(bars[23].blockedPct, 33)
  assert.equal(ageWords(0), 'just now'); assert.equal(ageWords(1), '1 hour ago'); assert.equal(ageWords(47), '47 hours ago'); assert.equal(ageWords(72), '3 days ago'); assert.equal(ageWords(null), 'not reported')
  assert.equal(pauseLeft(45), '45 seconds'); assert.equal(pauseLeft(1800), '30 minutes'); assert.equal(pauseLeft(null), 'until you turn it back on')
  assert.equal(num(null), '—'); assert.equal(num(1234567), '1,234,567')
})

test('logic: the allow-list confirm phrase and what counts as one domain', () => {
  assert.equal(allowPhrase(' Ads.Example.NET '), 'Allow ads.example.net')
  assert.equal(cleanDomainInput(' Ads.Example.NET. '), 'ads.example.net')
  for (const ok of ['ads.example.net', 'a-b.example.co.uk', 'x_y.example.com']) assert.ok(looksLikeDomain(ok), ok)
  for (const bad of ['', 'example', '*.example.com', 'ads.example.net/path', 'a b.example.com', '1.2.3.4']) assert.ok(!looksLikeDomain(bad), bad)
})

test('logic: who may press what', () => {
  assert.equal(whyNot(false, 'operator'), ''); assert.equal(whyNot(false, 'viewer'), 'Only an operator or admin can do this.')
  assert.equal(whyNot(true, 'admin'), ''); assert.equal(whyNot(true, 'owner'), ''); assert.equal(whyNot(true, 'operator'), 'Only an admin can do this.')
})

test('point your network at it: says what to do and that nothing else changes by itself, with the address filled in', () => {
  const steps = pointNetworkSteps('192.0.2.10', 'Pi-hole')
  assert.match(steps[0], /never changes another machine's DNS by itself/)
  assert.match(steps.join(' '), /router/); assert.match(steps.join(' '), /DHCP/)
  assert.ok(steps.filter(s => s.includes('192.0.2.10')).length >= 2)
  assert.match(pointNetworkSteps(null, 'AdGuard Home')[1], /the AdGuard Home address/)
})
