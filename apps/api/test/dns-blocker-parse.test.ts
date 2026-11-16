// Turning each product's recorded answers (test/fixtures/dns-blocker, captured from real installs with their addresses and
// names replaced) into one reading: the numbers, the pseudo-upstreams Pi-hole counts, AdGuard's single-key lists, the
// 24-hour fold, how old the lists are, how each upstream is judged, and the problems each state raises with their fixes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bare, hourly, judgeUpstreams, listAge, parseAdguard, parsePihole, problemsOf, SLOW_MS, STALE_HOURS, HOUR_MS, type PiholeAnswers, type AdguardAnswers } from '../src/lib/dns-blocker/parse'
import type { DnsReading, UpstreamRow } from '../src/lib/dns-blocker/types'
import { fixture, NOW } from './fakes/dns-blocker'

const P = (n: string) => fixture('pihole', n)
const A = (n: string) => fixture('adguard', n)

const pihole = (over: Partial<PiholeAnswers> = {}): PiholeAnswers => ({
  summary: P('summary.json'), blocking: P('blocking.json'), version: P('version.json'), topBlocked: P('top-blocked.json'), topDomains: P('top-domains.json'),
  topClients: P('top-clients.json'), upstreams: P('upstreams.json'), upstreamConfig: P('upstream-config.json'), history: P('history.json'), lists: P('lists.json'), failed: [], ...over,
})
const adguard = (over: Partial<AdguardAnswers> = {}): AdguardAnswers => ({
  status: A('status.json'), stats: A('stats.json'), filtering: A('filtering-status.json'), dnsInfo: A('dns-info.json'), clients: A('clients.json'), failed: [], ...over,
})

test('Pi-hole: the summary, the lists, the version and the 24-hour chart', () => {
  const r = parsePihole(pihole(), NOW, false)
  assert.equal(r.kind, 'pihole')
  assert.equal(r.totals.queries, P('summary.json').queries.total)
  assert.equal(r.totals.blocked, P('summary.json').queries.blocked)
  assert.equal(r.totals.percentBlocked, Math.round(P('summary.json').queries.percent_blocked * 10) / 10)
  assert.equal(r.protection.on, true)
  assert.match(r.version!, /^2026\.10\.1 \(core v6\.5, FTL v6\.8, web v6\.6\.1\)$/)
  assert.equal(r.newerVersion, '2026.11.0', 'the image release the blocker itself says is newer')
  assert.equal(r.blocklists.domains, 76105)
  assert.equal(r.blocklists.lists, 1)
  assert.equal(r.blocklists.ageHours, 0)
  assert.equal(r.blocklists.stale, false)
  assert.equal(r.history.length, 24)
  assert.equal(r.history.reduce((n, h) => n + h.total, 0), P('history.json').history.reduce((n: number, h: any) => n + h.total, 0), 'ten-minute buckets fold into hours without losing a query')
  assert.ok(r.history.every((h, i) => i === 0 || h.at - r.history[i - 1].at === HOUR_MS))
  assert.deepEqual(r.missing, [])
})

test('Pi-hole: the block list and the cache are not upstream servers; the configured servers are the truth', () => {
  const r = parsePihole(pihole(), NOW, false)
  assert.deepEqual(r.upstreams.map(u => u.address), ['1.1.1.1', '1.0.0.1'], 'from the configuration, in its order')
  const one = r.upstreams[0]
  assert.equal(one.name, 'one.one.one.one')
  assert.ok(one.avgMs! > 0 && one.avgMs! < 1000, 'seconds in the answer, milliseconds in the reading')
  assert.equal(r.upstreams[1].queries, null, 'a server nobody has asked yet is still listed')
  assert.ok(!r.upstreams.some(u => /blocklist|cache/.test(u.address)))
  // Without the configuration the statistics alone are used, still without the pseudo-upstreams. They also still hold a
  // server that was configured earlier (9.9.9.9): that is why the configuration decides.
  const stats = parsePihole(pihole({ upstreamConfig: null }), NOW, false)
  assert.deepEqual(stats.upstreams.map(u => u.address), ['1.1.1.1', '9.9.9.9'])
  // A server on another port keeps it in its name.
  const port = parsePihole(pihole({ upstreamConfig: { config: { dns: { upstreams: ['192.0.2.53#5353', '1.1.1.1#53'] } } } }), NOW, false)
  assert.deepEqual(port.upstreams.map(u => u.address), ['192.0.2.53#5353', '1.1.1.1#53'])
  assert.equal(port.upstreams[1].avgMs, one.avgMs, '1.1.1.1#53 and 1.1.1.1 are one server')
})

test('Pi-hole: paused blocking says how long is left; the clients are left out when hidden', () => {
  const r = parsePihole(pihole({ blocking: P('blocking-paused.json') }), NOW, false)
  assert.equal(r.protection.on, false)
  assert.equal(r.protection.secondsLeft, 1800)
  const hidden = parsePihole(pihole({ topClients: null }), NOW, true)
  assert.equal(hidden.clients, null)
  assert.equal(hidden.clientsHidden, true)
  const shown = parsePihole(pihole(), NOW, false)
  assert.deepEqual(shown.clients!.find(c => c.ip === '192.0.2.205'), { name: 'laptop', ip: '192.0.2.205', count: 14 })
  assert.equal(shown.clients!.find(c => c.ip === '192.0.2.251')!.name, null, 'an empty name is no name')
})

test('Pi-hole: a missing answer is a note, never a thrown error', () => {
  const r = parsePihole(pihole({ summary: null, version: null, lists: null, failed: ['version (not permitted)'] }), NOW, false)
  assert.equal(r.totals.queries, 0)
  assert.equal(r.version, null)
  assert.equal(r.blocklists.lists, null)
  assert.deepEqual(r.missing, ['version (not permitted)'])
  assert.doesNotThrow(() => parsePihole({ ...pihole(), summary: 'nonsense', topBlocked: [], upstreams: 42, history: { history: 'x' } } as any, NOW, false))
})

test('AdGuard Home: totals, protection, lists, the servers from its settings with the numbers it measured', () => {
  const r = parseAdguard(adguard(), NOW, false)
  assert.equal(r.kind, 'adguard')
  assert.equal(r.version, 'v0.107.79')
  assert.equal(r.totals.queries, A('stats.json').num_dns_queries)
  assert.equal(r.totals.blocked, A('stats.json').num_blocked_filtering)
  assert.equal(r.totals.avgMs, Math.round(A('stats.json').avg_processing_time * 1000))
  assert.equal(r.protection.on, true)
  assert.deepEqual(r.upstreams.map(u => u.address), ['9.9.9.9:53', '1.1.1.1'], 'as written in its settings')
  const nine = r.upstreams[0]
  assert.equal(nine.avgMs, Math.round(A('stats.json').top_upstreams_avg_time.find((o: any) => '9.9.9.9:53' in o)['9.9.9.9:53'] * 1000))
  assert.equal(r.upstreams[1].queries, A('stats.json').top_upstreams_responses.find((o: any) => '1.1.1.1:53' in o)['1.1.1.1:53'], '1.1.1.1 and 1.1.1.1:53 are one server')
  assert.equal(r.blocklists.domains, 192134, 'only enabled lists count')
  assert.equal(r.blocklists.lists, 1)
  assert.deepEqual(r.topBlocked.map(d => d.domain).sort(), ['doubleclick.net', 'pagead2.googlesyndication.com'])
  assert.deepEqual(r.clients, [{ name: null, ip: '192.0.2.205', count: 7 }])
  assert.equal(r.history.length, 24)
  assert.equal(r.history[23].total, 7, 'the newest hour is last')
})

test('AdGuard Home: a pause comes in milliseconds; hidden clients are left out', () => {
  const r = parseAdguard(adguard({ status: A('status-paused.json') }), NOW, false)
  assert.equal(r.protection.on, false)
  assert.ok(r.protection.secondsLeft! > 1790 && r.protection.secondsLeft! <= 1800)
  assert.equal(parseAdguard(adguard({ clients: null }), NOW, true).clients, null)
  assert.doesNotThrow(() => parseAdguard({ ...adguard(), stats: 5, dnsInfo: 'x', filtering: [] } as any, NOW, false))
})

test('list age: hours since the newest update, stale after eight days, nothing known is never stale', () => {
  assert.deepEqual(listAge(NOW - 3 * HOUR_MS, NOW).ageHours, 3)
  assert.equal(listAge(NOW - (STALE_HOURS - 1) * HOUR_MS, NOW).stale, false)
  assert.equal(listAge(NOW - (STALE_HOURS + 1) * HOUR_MS, NOW).stale, true)
  assert.deepEqual(listAge(null, NOW), { updatedAt: null, ageHours: null, stale: false })
  assert.deepEqual(listAge(0, NOW), { updatedAt: null, ageHours: null, stale: false })
  assert.equal(listAge(NOW + 5 * HOUR_MS, NOW).ageHours, 0, 'a clock a little ahead is not a negative age')
})

test('hourly: always 24 points, oldest first, points outside the window are dropped', () => {
  const pts = [{ at: NOW - 30 * HOUR_MS, total: 99, blocked: 9 }, { at: NOW - 1000, total: 5, blocked: 2 }, { at: NOW - 1000, total: 1, blocked: 0 }]
  const h = hourly(pts, NOW)
  assert.equal(h.length, 24)
  assert.equal(h.reduce((n, p) => n + p.total, 0), 6)
  assert.deepEqual(h[23], { at: Math.floor(NOW / HOUR_MS) * HOUR_MS, total: 6, blocked: 2 })
})

test('bare: the default port makes no difference', () => {
  assert.equal(bare('1.1.1.1:53'), '1.1.1.1'); assert.equal(bare('1.1.1.1#53'), '1.1.1.1'); assert.equal(bare('1.1.1.1'), '1.1.1.1')
  assert.equal(bare('1.1.1.1#5353'), '1.1.1.1#5353')
})

// ── judging upstreams and the problems that follow ──────────────────────────

const row = (address: string, over: Partial<UpstreamRow> = {}): UpstreamRow => ({ address, name: null, queries: 4, avgMs: 20, state: 'unknown', detail: null, probeMs: null, ...over })

test('upstreams: a test lookup decides failing or slow; with none, the blocker\'s own timing does', () => {
  const rows = [row('a'), row('b'), row('c'), row('d', { avgMs: SLOW_MS + 100 }), row('e', { avgMs: null, queries: null }), row('f', { avgMs: null })]
  const probes = new Map<string, { ok: boolean; ms: number | null } | null>([['a', { ok: true, ms: 12 }], ['b', { ok: false, ms: null }], ['c', { ok: true, ms: SLOW_MS + 1 }]])
  const j = judgeUpstreams(rows, probes)
  assert.deepEqual(j.map(u => u.state), ['ok', 'failing', 'slow', 'slow', 'unknown', 'unknown'])
  assert.match(j[0].detail!, /12 ms/)
  assert.equal(j[1].detail, 'did not answer a test lookup')
  assert.equal(j[4].detail, 'no queries yet')
  // The blocker's own test says only yes: the measured time says fast or slow.
  assert.equal(judgeUpstreams([row('x', { avgMs: 30 })], new Map([['x', { ok: true, ms: null }]]))[0].state, 'ok')
  assert.equal(judgeUpstreams([row('x', { avgMs: 900 })], new Map([['x', { ok: true, ms: null }]]))[0].state, 'slow')
})

function reading(over: Partial<DnsReading> = {}): Omit<DnsReading, 'problems'> {
  return {
    ...parsePihole(pihole(), NOW, false),
    answering: { ok: true, ms: 3, detail: 'answered' },
    upstreams: judgeUpstreams(parsePihole(pihole(), NOW, false).upstreams, new Map([['1.1.1.1', { ok: true, ms: 10 }], ['1.0.0.1', { ok: true, ms: 12 }]])),
    ...over,
  }
}

test('problems: a healthy reading has none', () => {
  assert.deepEqual(problemsOf(reading(), 'Pi-hole'), [])
})

test('problems: every one that has a fix names the action, and the tier it needs', () => {
  const off = problemsOf(reading({ protection: { on: false, secondsLeft: 300 } }), 'Pi-hole')
  assert.deepEqual(off.map(p => [p.id, p.severity, p.fix?.action, p.fix?.secure]), [['protection_off', 'warn', 'resume', false]])
  assert.match(off[0].text, /back on in 5 minutes/)
  assert.match(problemsOf(reading({ protection: { on: false, secondsLeft: null } }), 'x')[0].text, /turned off/)
  const down = problemsOf(reading({ answering: { ok: false, ms: null, detail: null } }), 'AdGuard Home')
  assert.deepEqual(down.map(p => [p.id, p.severity, p.fix?.action, p.fix?.secure]), [['not_answering', 'bad', 'restart_service', true]])
  assert.match(down[0].fix!.label, /Restart AdGuard Home/)
  const stale = problemsOf(reading({ blocklists: { ...reading().blocklists, ageHours: 400, stale: true } }), 'x')
  assert.deepEqual(stale.map(p => [p.id, p.fix?.action, p.fix?.secure]), [['lists_stale', 'update_lists', false]])
  assert.match(stale[0].text, /17 days ago/)
})

test('problems: one failing upstream keeps the others; all failing offers a provider; neither blames the blocker', () => {
  const some = problemsOf(reading({ upstreams: [row('1.1.1.1', { state: 'ok' }), row('192.0.2.9', { state: 'failing' })], answering: { ok: false, ms: null, detail: null } }), 'x')
  assert.deepEqual(some.map(p => p.id), ['upstream_failing'])
  assert.deepEqual(some[0].fix?.params, { to: 'healthy' })
  const all = problemsOf(reading({ upstreams: [row('192.0.2.8', { state: 'failing' }), row('192.0.2.9', { state: 'failing' })] }), 'x')
  assert.deepEqual(all.map(p => p.id), ['all_upstreams_failing'])
  assert.deepEqual(all[0].fix?.params, { to: 'cloudflare' })
  assert.match(all[0].text, /192\.0\.2\.8, 192\.0\.2\.9/)
})

test('problems: no queries yet is a note about pointing the network at it, with no fix button', () => {
  const none = problemsOf(reading({ totals: { ...reading().totals, queries: 0, blocked: 0 } }), 'x')
  assert.deepEqual(none.map(p => [p.id, p.severity, p.fix]), [['no_queries', 'info', null]])
  assert.match(none[0].text, /router/)
  assert.deepEqual(problemsOf(reading({ protection: { on: false, secondsLeft: null }, totals: { ...reading().totals, queries: 0 } }), 'x').map(p => p.id), ['protection_off'], 'not said while blocking is off')
})
