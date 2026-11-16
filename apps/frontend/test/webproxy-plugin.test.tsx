// The NGINX, Caddy and Envoy plug-in pages' pieces, rendered to HTML: problems with their fix buttons (admins only),
// the route map with every target's state in words, certificates as remaining-life bars, and the pure logic.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import "./css-stub"
import { renderToStaticMarkup } from 'react-dom/server'
import { CertBars, ProblemCards, RouteMap } from '../components/plugins/webproxy/WebProxyPage'
import { certLife, chipsOf, classBars, pct, routeRows, uptime, verdictOf, type CaddyDetail, type EnvoyDetail, type NginxDetail, type Reading } from '../components/plugins/webproxy/logic'
import { AUTO_CONNECT_PLUGINS, autoConnectWord } from '../lib/plugin-status'

const nginx: NginxDetail = {
  kind: 'nginx', version: '1.31.8', running: true, configOk: true, configMessage: '',
  status: { active: 3, accepts: 10, handled: 10, requests: 40, reading: 0, writing: 1, waiting: 2 },
  sites: [
    { file: '/etc/nginx/conf.d/shop.conf', names: ['shop.example.org'], listens: ['443'], ssl: true, proxyPass: 'http://app_pool', certificate: '/c.crt', kind: 'proxy', defaultServer: false, owned: false },
    { file: '/etc/nginx/conf.d/hyperprox-hosts.conf', names: ['app.example.org'], listens: ['80'], ssl: false, proxyPass: 'http://10.0.0.5:8080', certificate: null, kind: 'proxy', defaultServer: false, owned: true },
  ],
  upstreams: [{ file: '/etc/nginx/conf.d/shop.conf', name: 'app_pool', servers: ['10.0.0.6:9000', '10.0.0.7:9000'] }],
  certs: [], traffic: { total: 44, byClass: { '1': 0, '2': 32, '3': 0, '4': 5, '5': 7 }, errorRate: 7 / 44 }, certbot: false, openssl: true,
  reach: { '10.0.0.6:9000': true, '10.0.0.7:9000': false, '10.0.0.5:8080': true },
}
const reading = (detail: any, problems: any[] = []): Reading => ({ id: 'x', kind: detail?.kind ?? 'nginx', name: 'edge', vmid: 101, node: 'n1', at: 0, ok: true, detail, problems, actions: [] })

test('the route map: names, the wire through the proxy, and each target’s state in words', () => {
  const rows = routeRows(nginx)
  assert.deepEqual(rows[0].targets, [{ label: '10.0.0.6:9000', state: 'ok' }, { label: '10.0.0.7:9000', state: 'bad' }])
  assert.equal(rows[0].via, 'upstream app_pool')
  assert.equal(rows[1].mine, true)
  const html = renderToStaticMarkup(<RouteMap rows={rows} kind="nginx" />)
  assert.match(html, /shop\.example\.org/)
  assert.match(html, /aria-label="HTTPS"/)
  assert.match(html, /10\.0\.0\.7:9000<span[^>]*>, not reachable/)
  assert.match(html, /published from the Proxy page/)
  assert.match(renderToStaticMarkup(<RouteMap rows={[]} kind="caddy" />), /Publish one from the Proxy page/)
})

test('Caddy and Envoy rows: failing upstreams warn, unhealthy hosts say why', () => {
  const caddy: CaddyDetail = { kind: 'caddy', version: '2.11.7', unit: 'caddy-api', running: true, adminOk: true, servers: [{ name: 'srv0', listen: [':80', ':443'] }],
    routes: [{ id: 'hpx-a', server: 'srv0', hosts: ['a.example.org'], upstreams: ['10.0.0.5:80'], handler: 'proxy' }, { id: 'hpx-health', server: 'srv0', hosts: [], upstreams: [], handler: 'static' }],
    upstreams: [{ address: '10.0.0.5:80', requests: 0, fails: 2, reachable: true }], certs: [], missingCerts: ['a.example.org'], persist: true, openssl: true }
  const r = routeRows(caddy)
  assert.equal(r.length, 1, 'a route with no name (the health answer) is not on the map')
  assert.deepEqual([r[0].tls, r[0].targets[0].state], [true, 'warn'])
  const envoy: EnvoyDetail = { kind: 'envoy', version: '1.40.2', running: true, admin: '127.0.0.1:9901', adminOk: true, state: 'LIVE', uptimeSeconds: 7200, draining: false,
    listeners: [{ name: 'http', address: '0.0.0.0:80' }], clusters: [{ name: 'app', hosts: [{ address: '10.0.0.8:80', healthy: false, flags: ['active health check'], requests: 0, errors: 3 }] }],
    requests: { total: 10, byClass: { '1': 0, '2': 7, '3': 0, '4': 0, '5': 3 }, errorRate: 0.3 }, dynamicFiles: ['/etc/envoy/dynamic/cds.yaml'], unit: true }
  const e = routeRows(envoy)
  assert.deepEqual(e[0].targets, [{ label: '10.0.0.8:80', state: 'bad' }])
  assert.match(e[0].note!, /active health check/)
  assert.deepEqual(chipsOf(reading(envoy)).find(c => c.label === 'hosts unhealthy'), { label: 'hosts unhealthy', value: 1, tone: 'crit' })
  assert.equal(uptime(7200), '2 h')
})

test('problems: worst first, a fix button for admins, words for everyone else', () => {
  const problems = [
    { id: 'cert:a', severity: 'warning' as const, title: 'The certificate for a ends in 5 days', detail: 'Renew it.', fix: { id: 'renew', label: 'Renew certificates', confirm: '' } },
    { id: 'stopped', severity: 'error' as const, title: 'NGINX is not running', detail: 'Nothing is served.', fix: { id: 'start', label: 'Start NGINX', confirm: '' } },
  ]
  const html = renderToStaticMarkup(<ProblemCards problems={problems} admin onFix={() => {}} />)
  assert.ok(html.indexOf('NGINX is not running') < html.indexOf('The certificate'))
  assert.match(html, /<button[^>]*>Start NGINX<\/button>/)
  const viewer = renderToStaticMarkup(<ProblemCards problems={problems} admin={false} onFix={() => {}} />)
  assert.doesNotMatch(viewer, /<button/)
  assert.match(viewer, /An admin can fix this: start nginx/)
  assert.match(renderToStaticMarkup(<ProblemCards problems={[]} admin onFix={() => {}} />), /Nothing needs attention/)
})

test('certificates: remaining life as a bar and in words; a name still waiting says so', () => {
  const html = renderToStaticMarkup(<CertBars certs={[
    { name: 'a.example.org', path: '/a', notAfter: null, daysLeft: 60, ending: false, expired: false },
    { name: 'b.example.org', path: '/b', notAfter: null, daysLeft: -2, ending: false, expired: true },
  ]} waiting={['c.example.org']} />)
  assert.match(html, /60 days left/)
  assert.match(html, /expired/)
  assert.match(html, /c\.example\.org[\s\S]*waiting for a certificate/)
  assert.deepEqual(certLife({ name: 'x', path: '/x', notAfter: null, daysLeft: 0, ending: true, expired: false }), { value: 0, words: 'ends within a day', tone: 'warn' })
})

test('the verdict, the error share and the bars', () => {
  assert.deepEqual(verdictOf(reading(nginx)), { text: 'healthy', tone: 'good', score: 1 })
  assert.equal(verdictOf(reading(nginx, [{ id: 's', severity: 'error', title: '', detail: '' }])).tone, 'bad')
  assert.equal(verdictOf(reading(null)).text, 'unreachable')
  assert.equal(pct(7 / 44), '16%')
  assert.equal(pct(0.004), '0.4%')
  assert.deepEqual(classBars(nginx.traffic.byClass).map(b => b.label), ['2xx', '3xx', '4xx', '5xx'])
  assert.equal(chipsOf(reading(nginx)).find(c => c.label === '5xx · 5 min')!.tone, 'crit')
})

test('the three plug-ins connect by themselves and have nothing to type', () => {
  for (const k of ['nginx', 'caddy', 'envoy']) {
    assert.ok(AUTO_CONNECT_PLUGINS.includes(k))
    assert.deepEqual(autoConnectWord(k, { pending: {}, lastRun: null, waitingForUnlock: false } as any), { word: 'connecting automatically…', pick: false })
  }
})
