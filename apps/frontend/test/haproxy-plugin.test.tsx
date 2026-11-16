// The HAProxy plug-in page's pieces, rendered to HTML: the traffic map (frontends → backends → servers, each state in
// words as well as colour), the problems with their fix buttons (a backend with no healthy server is an alert), the
// HUD chips, the "Load-balance this app" form and the pure logic behind them.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import './css-stub'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProblemList, TrafficMap, ServerPod, LoadBalanceForm, hudChips } from '../components/plugins/haproxy/HaproxyPage'
import { confirmText, layout, lbProblems, serverActions, since, summary, type LbForm, type Reading, type ServerView } from '../components/plugins/haproxy/logic'
import { autoConnectWord } from '../lib/plugin-status'

const srv = (o: Partial<ServerView> = {}): ServerView => ({
  name: 'web1', address: '198.51.100.11:8080', state: 'up', status: 'UP', weight: 100, sessions: 3, sessionsMax: 9, rate: 2, total: 40, queue: 0, errors: 0, http5xx: 0,
  responseMs: 12, check: { configured: true, enabled: true, code: 'L7OK', words: 'the check page answered correctly', durationMs: 1, failures: 0 },
  lastChangeS: 300, downtimeS: 0, dynamic: false, ...o,
})

const reading = (servers: ServerView[], o: Partial<Reading> = {}): Reading => ({
  fetchedAt: '2026-11-16T03:20:00Z', version: '3.4.7', uptimeS: 60, currentConnections: 4,
  frontends: [
    { name: 'http', status: 'OPEN', sessions: 4, rate: 3, requestRate: 5, errors: 0, http5xx: 0, binds: [':80'], backends: ['hpx_lb_web'], internal: false },
    { name: 'hpx_metrics', status: 'OPEN', sessions: 0, rate: 0, requestRate: 0, errors: 0, http5xx: 0, binds: [':8405'], backends: [], internal: true },
  ],
  backends: [
    { name: 'hpx_lb_web', status: 'UP', algorithm: 'roundrobin', sessions: 4, rate: 3, errors: 0, http5xx: 0, responseMs: 12, servers, healthy: servers.filter(s => s.state === 'up').length, internal: false },
    { name: 'hpx_spare', status: 'DOWN', algorithm: 'leastconn', sessions: 0, rate: 0, errors: 0, http5xx: 0, responseMs: null, servers: [], healthy: 0, internal: false },
  ],
  config: { ok: true, error: null }, problems: [], ...o,
})

test('the map: each public frontend with its backends and their servers; monitoring frontends and unrouted backends kept apart', () => {
  const r = reading([srv(), srv({ name: 'web2', state: 'drain', status: 'DRAIN', weight: 50 })])
  const html = renderToStaticMarkup(<TrafficMap r={r} />)
  assert.match(html, /aria-label="Frontend http"/)
  assert.doesNotMatch(html, /Frontend hpx_metrics/)
  assert.ok(html.indexOf('Frontend http') < html.indexOf('Backend hpx_lb_web'))
  assert.match(html, /Backends no public frontend sends to[\s\S]*Backend hpx_spare[\s\S]*No servers: every request sent here gets a 503/)
  assert.match(html, /web1: Up\. Open its actions/)
  assert.match(html, /web2: Draining\. Open its actions/)
  assert.match(html, /data-tone="warn"/)
  assert.match(html, /roundrobin/)
  assert.match(html, /listens on :80/)
  assert.deepEqual(layout(r).unrouted.map(b => b.name), ['hpx_spare'])
})

test('a server pod says its state, sessions and weight as bars, rate, response time and the check in words', () => {
  const html = renderToStaticMarkup(<ServerPod s={srv({ state: 'down', status: 'DOWN', check: { configured: true, enabled: true, code: 'L4CON', words: 'the connection was refused or could not be made', durationMs: 0, failures: 4 } })} max={{ sessions: 6, weight: 100 }} />)
  assert.match(html, /data-tone="bad"/)
  assert.match(html, />Down</)
  assert.match(html, /aria-label="sessions" aria-valuenow="3"/)
  assert.match(html, /width:50%/, 'three of the busiest six sessions')
  assert.match(html, /Check: the connection was refused or could not be made/)
  assert.match(html, /data-ok="false"/)
  assert.match(html, /2\/s · 12 ms · 0 err/)
  assert.match(renderToStaticMarkup(<ServerPod s={srv({ dynamic: true })} max={{ sessions: 1, weight: 1 }} />), /runtime only · not in the configuration/)
})

test('problems: an outage is an alert first, each problem with its own fix buttons; none says so plainly', () => {
  const html = renderToStaticMarkup(<ProblemList busy={null} onFix={() => {}} problems={[
    { id: 'nohealthy:hpx_lb_web', severity: 'critical', backend: 'hpx_lb_web', title: 'hpx_lb_web has no healthy server: visitors get errors', detail: 'All 2 servers are down.', fixes: [{ id: 'retry', label: 'Check every server again' }] },
    { id: 'down:hpx_lb_web/web2', severity: 'bad', backend: 'hpx_lb_web', server: 'web2', title: 'web2 in hpx_lb_web is down', detail: 'Its health check says the port did not answer in time.',
      fixes: [{ id: 'drain', label: 'Drain and investigate', confirm: 'sure?' }, { id: 'retry', label: 'Check it again now' }] },
  ]} />)
  assert.match(html, /role="alert"[^>]*>|data-severity="critical"[^>]*role="alert"/)
  assert.ok(html.indexOf('no healthy server') < html.indexOf('web2 in hpx_lb_web is down'))
  assert.match(html, /Outage<\/span>/)
  assert.match(html, />Drain and investigate</); assert.match(html, />Check it again now</)
  assert.match(renderToStaticMarkup(<ProblemList problems={[]} busy={null} onFix={() => {}} />), /No problems/)
  assert.match(renderToStaticMarkup(<ProblemList problems={[{ id: 'config', severity: 'bad', title: 'x', detail: 'y', fixes: [{ id: 'check-config', label: 'Check again' }] }]} busy="config:check-config" onFix={() => {}} />), /Working…/)
})

test('HUD chips and summary: servers up, down, parked, and whether the configuration passes', () => {
  const r = reading([srv(), srv({ name: 'b', state: 'down' }), srv({ name: 'c', state: 'maint' })], { config: { ok: false, error: 'line 75: …' } })
  assert.deepEqual(summary(r), { backends: 2, servers: 3, up: 1, down: 1, parked: 1, worst: null })
  const chips = Object.fromEntries(hudChips(r).map(c => [c.label, c]))
  assert.equal(chips['servers up'].value, '1/3'); assert.equal(chips['servers up'].tone, 'crit')
  assert.equal(chips.configuration.value, 'fails check')
})

test('server actions by state, and destructive ones confirmed in words saying runtime or saved', () => {
  assert.deepEqual(serverActions(srv()).map(a => a.id), ['drain', 'maint'])
  assert.deepEqual(serverActions(srv({ state: 'drain' })).map(a => a.id), ['ready', 'maint'])
  assert.deepEqual(serverActions(srv({ state: 'maint' })).map(a => a.id), ['ready'])
  assert.match(String(confirmText('drain', 'be', 'web1', false)), /lasts until HAProxy restarts/)
  assert.match(String(confirmText('maint', 'be', 'web1', true)), /saved to the configuration/)
  assert.match(String(confirmText('remove-server', 'be', 'web1', false)), /comes back when HAProxy restarts/)
  assert.equal(confirmText('ready', 'be', 'web1', false), null)
  assert.equal(since(45), '45s'); assert.equal(since(7200), '2h'); assert.equal(since(null), '—')
})

test('"Load-balance this app": two guests or more, a port, an optional name, publishing checked against the domain', () => {
  const f: LbForm = { name: 'shop', guests: ['lxc-151', 'lxc-152'], port: '3000', hostname: '', algorithm: 'roundrobin', checkPath: '/', publish: false, zone: '', proxyInstanceId: '' }
  assert.deepEqual(lbProblems(f), [])
  assert.match(lbProblems({ ...f, guests: ['lxc-151'] })[0], /at least two/)
  assert.match(lbProblems({ ...f, port: '0' })[0], /1 to 65535/)
  assert.match(lbProblems({ ...f, hostname: 'shop.example.com', publish: true, zone: 'example.org', proxyInstanceId: 'px-1' })[0], /not in example\.org/)
  assert.deepEqual(lbProblems({ ...f, hostname: 'shop.example.com', publish: true, zone: 'example.com', proxyInstanceId: 'px-1' }), [])
  const html = renderToStaticMarkup(<LoadBalanceForm f={{ ...f, hostname: 'shop.example.com', publish: true }} set={() => {}} zones={['example.com']} proxies={[{ id: 'px-1', name: 'Edge NPM' }]}
    algorithms={{ roundrobin: 'Takes turns.', leastconn: 'Fewest connections.' }}
    guests={[{ kind: 'lxc', vmid: 151, name: 'app-a', node: 'n1', address: '10.0.0.51' }, { kind: 'lxc', vmid: 152, name: 'app-b', node: 'n2', address: '10.0.0.52' }]} />)
  assert.match(html, /Guests running it \(pick two or more\)/)
  assert.equal((html.match(/type="checkbox" checked=""/g) ?? []).length, 3, 'both guests and the publish box')
  assert.match(html, /Takes turns\./)
  assert.match(html, /Also publish it: a DNS record, a proxy host and a certificate/)
  assert.match(html, /Edge NPM/)
})

test('the plug-in card connects by itself: no form to fill', () => {
  assert.deepEqual(autoConnectWord('haproxy', { pending: {}, lastRun: null, waitingForUnlock: true }), { word: 'connects automatically once HyperProx is unlocked', pick: false })
})
