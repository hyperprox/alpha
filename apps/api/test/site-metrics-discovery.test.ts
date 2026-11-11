// Site metrics: "Add an existing site" discovery — proxy hosts to guests, the look inside a container, the log
// it writes, the kind of site, and the admin-only route that lists them with nothing secret in it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'

import {
  discoverScript, parseDiscover, parseNginxConfig, parseApacheConfig, matchServer, nginxLogFor, apacheLogFor, matchVhost, inspectFor,
  linkHosts, buildCandidates, unresolvedAddresses, discover, nameMatches,
  type DiscoverOutput, type GuestInfo, type ProxyHostLike, type DiscoveryDeps, type InspectAnswer,
} from '../src/lib/site-metrics/discovery'
import { buildSiteMetricsRoutes } from '../src/routes/site-metrics'
import { MemoryMetricsStore } from '../src/lib/site-metrics/store'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import type { SiteRecord } from '../src/lib/sites'

const FIXTURE = readFileSync(join(__dirname, 'fixtures/site-metrics/nginx-T-several-servers.txt'), 'utf8')
const b64 = (s: string) => Buffer.from(s).toString('base64')
const answer = (nginx: string | null, extra: string[] = [], ports = ['0050', '0016']) =>
  [...ports.map(p => `HPXD1 listen ${p}`), ...(nginx === null ? [] : ['HPXD1 bin nginx', `HPXD1 nginx ${b64(nginx)}`]), ...extra, 'HPXD1 end', ''].join('\n')

// ── nginx: servers, logs, formats ──────────────────────────────────────────

test('nginx -T: each server, its log and its format; comments, mime types and stream blocks do not count', () => {
  const c = parseNginxConfig(FIXTURE)
  assert.deepEqual(c.servers.map(s => s.names[0]), ['blog.example.com', 'docs.example.com', 'app.example.com', 'quiet.example.com', '*.shop.example.com'])
  assert.deepEqual(c.httpLogs, [{ path: '/var/log/nginx/access.log', format: null }], 'the commented-out access_log is not read')
  assert.deepEqual(c.formats.main, { requestTime: false, forwardedFor: true }, 'a format split over three lines is read whole')
  assert.deepEqual(c.formats.timed, { requestTime: true, forwardedFor: true }, 'a quoted { in a JSON format is not a block')
  const docs = c.servers[1]
  assert.equal(docs.defaultServer, true); assert.deepEqual(docs.ports, [80]); assert.equal(docs.root, '/var/www/docs')
  assert.equal(c.servers[0].php, true); assert.equal(c.servers[2].proxied, true); assert.deepEqual(c.servers[2].ports, [8080])
  assert.equal(c.servers[4].root, '/var/www/shop', 'a quoted root is unquoted')
  const withStream = parseNginxConfig(`${FIXTURE}\nstream {\n server { listen 3306; proxy_pass db; }\n}\n`)
  assert.equal(withStream.servers.length, 5, 'a stream server is not a website')
})

test('nginx -T: the log path is the matching server_name\'s, then the inherited one, then the default server\'s', () => {
  const c = parseNginxConfig(FIXTURE)
  const log = (host: string | null, port: number | null = 80) => { const m = matchServer(c, host, port)!; return { how: m.how, ...nginxLogFor(c, m.server) } }
  assert.deepEqual(log('blog.example.com'), { how: 'name', logPath: '/var/log/nginx/blog.access.log', format: { name: 'main', requestTime: false, forwardedFor: true } })
  assert.deepEqual(log('WWW.Blog.Example.com'), log('blog.example.com'), 'names match without case')
  assert.deepEqual(log('docs.example.com'), { how: 'name', logPath: '/var/log/nginx/access.log', format: { name: 'combined', requestTime: false, forwardedFor: false } })
  assert.deepEqual(log('app.example.com', 8080), { how: 'name', logPath: '/var/log/nginx/app.log', format: { name: 'timed', requestTime: true, forwardedFor: true } })
  assert.equal(log('nobody.example.org').how, 'default'); assert.equal(log('nobody.example.org').logPath, '/var/log/nginx/access.log')
  assert.equal(log('quiet.example.com').logPath, null); assert.match(log('quiet.example.com').note!, /turned off/)
  assert.equal(log('a.shop.example.com').logPath, null); assert.match(log('a.shop.example.com').note!, /variables/)
  // No access_log anywhere: nginx's own default, in the combined format.
  assert.deepEqual(nginxLogFor(parseNginxConfig('server { listen 80; root /var/www/x; }'), parseNginxConfig('server { listen 80; }').servers[0]),
    { logPath: '/var/log/nginx/access.log', format: { name: 'combined', requestTime: false, forwardedFor: false } })
  // A log outside /var/log is never offered.
  const odd = parseNginxConfig('server { listen 80; server_name x.example.com; access_log /tmp/x.log; }')
  assert.equal(nginxLogFor(odd, odd.servers[0]).logPath, null)
  assert.equal(nameMatches('.example.com', 'example.com'), 'wildcard'); assert.equal(nameMatches('www.*', 'www.example.net'), 'wildcard'); assert.equal(nameMatches('example.com', 'xexample.com'), null)
})

test('kind: WordPress when wp-config.php is in the root, static for a plain root, other for PHP or a proxy', () => {
  const out = parseDiscover(answer(FIXTURE, ['HPXD1 wp /var/www/blog']))
  const blog = inspectFor(out, 'blog.example.com', 80)
  assert.equal(blog.kind, 'wordpress'); assert.equal(blog.wpPath, '/var/www/blog'); assert.equal(blog.server, 'nginx')
  assert.ok(blog.notes.some(n => /no request time/.test(n)) && !blog.notes.some(n => /X-Forwarded-For/.test(n)), 'main has the address but not the time')
  assert.equal(inspectFor(parseDiscover(answer(FIXTURE)), 'blog.example.com', 80).kind, 'other', 'PHP-FPM without WordPress')
  const docs = inspectFor(out, 'docs.example.com', 80)
  assert.equal(docs.kind, 'static'); assert.ok(docs.notes.some(n => /no visitor address \(X-Forwarded-For\) and no request time; HyperProx offers the logging change/.test(n)))
  assert.equal(inspectFor(out, 'app.example.com', 8080).kind, 'other')
  assert.equal(inspectFor(out, 'docs.example.com', 8443).forwardPortOpen, false)
  const caddy = inspectFor(parseDiscover('HPXD1 listen 01BB\nHPXD1 bin caddy\nHPXD1 end\n'), 'x.example.com', 443)
  assert.equal(caddy.server, 'caddy'); assert.equal(caddy.logPath, null)
  const none = inspectFor(parseDiscover('HPXD1 listen 0050\nHPXD1 end\n'), 'x.example.com', 80)
  assert.equal(none.server, null); assert.match(none.notes[0], /No nginx, Apache or Caddy/)
  const broken = inspectFor(parseDiscover('HPXD1 bin nginx\nHPXD1 nginxbad\nHPXD1 end\n'), 'x.example.com', 80)
  assert.equal(broken.server, 'nginx'); assert.match(broken.notes[0], /nginx -T fails/)
  assert.throws(() => parseDiscover('HPXD1 listen 0050\n'), /did not finish/)
})

test('Apache: the vhost by ServerName/ServerAlias, its CustomLog with APACHE_LOG_DIR, and LogFormat facts', () => {
  const a = parseApacheConfig([
    'LogFormat "%h %l %u %t \\"%r\\" %>s %O \\"%{Referer}i\\" \\"%{User-Agent}i\\" %D \\"%{X-Forwarded-For}i\\"" timed',
    '<VirtualHost *:80>', '  ServerName shop.example.com', '  ServerAlias www.shop.example.com', '  DocumentRoot /var/www/shop',
    '  CustomLog ${APACHE_LOG_DIR}/shop.log timed', '</VirtualHost>',
    '<VirtualHost *:80>', '  ServerName plain.example.com', '  DocumentRoot /var/www/plain', '</VirtualHost>',
  ].join('\n'))
  const shop = matchVhost(a, 'www.shop.example.com', 80)!
  assert.deepEqual(apacheLogFor(a, shop), { logPath: '/var/log/apache2/shop.log', format: { name: 'timed', requestTime: true, forwardedFor: true } })
  assert.equal(apacheLogFor(a, matchVhost(a, 'plain.example.com', 80)).logPath, null, 'no CustomLog: the shared vhost log is not offered')
  const out: DiscoverOutput = { complete: true, ports: [80], bins: ['apache2'], nginx: null, nginxBroken: false, apache: a, wpRoots: ['/var/www/shop'] }
  const ins = inspectFor(out, 'shop.example.com', 80)
  assert.equal(ins.server, 'apache'); assert.equal(ins.kind, 'wordpress'); assert.equal(ins.wpPath, '/var/www/shop')
})

// ── the script itself, run against a stand-in nginx ────────────────────────

test('discoverScript: read-only, and sends back the lines that place a log but not headers, passwords or comments', () => {
  const script = discoverScript()
  assert.ok(!/\b(rm|mv|cp|tee|sed -i|chmod|chown|systemctl|reload|restart|install)\b|>\s*\/(?!dev\/null)/.test(script.replace(/2>\/dev\/null|>\/dev\/null/g, '')), 'nothing in it writes')
  const dir = mkdtempSync(join(tmpdir(), 'hpx-discover-'))
  try {
    writeFileSync(join(dir, 'fixture.txt'), FIXTURE)
    writeFileSync(join(dir, 'nginx'), `#!/bin/sh\n[ "$1" = "-T" ] && cat ${JSON.stringify(join(dir, 'fixture.txt'))}\n`)
    chmodSync(join(dir, 'nginx'), 0o755)
    const r = spawnSync('bash', ['-c', script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const out = parseDiscover(r.stdout)
    assert.ok(out.bins.includes('nginx'))
    const sent = Buffer.from(/^HPXD1 nginx (\S*)$/m.exec(r.stdout)![1], 'base64').toString('utf8')
    assert.ok(!/Bearer|not-a-real-token|commented-out|text\/css|worker_connections/.test(sent), 'headers, comments and mime types stay in the container')
    assert.deepEqual(out.nginx, parseNginxConfig(FIXTURE), 'the filtered lines read the same as the whole configuration')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── proxy hosts to guests, and candidates ──────────────────────────────────

const guest = (vmid: number, name: string, addresses: string[], over: Partial<GuestInfo> = {}): GuestInfo =>
  ({ vmid, name, node: 'pve1', type: 'lxc', status: 'running', addresses, ...over })
const host = (domains: string[], forwardHost: string, forwardPort = 80, over: Partial<ProxyHostLike> = {}): ProxyHostLike =>
  ({ instanceId: 'npm', instanceName: 'Edge NPM', kind: 'npm', domains, forwardScheme: 'http', forwardHost, forwardPort, enabled: true, tls: { kind: 'certificate' }, ...over })

const GUESTS = [
  guest(901, 'docs', ['10.0.0.21']),
  guest(902, 'blog', ['10.0.0.22']),
  guest(903, 'old-blog', ['10.0.0.22'], { status: 'stopped' }),
  guest(904, 'shop', ['10.0.0.24'], { type: 'qemu' }),
  guest(905, 'quiet', ['10.0.0.25']),
]

test('linking: forward address to guest, running first; hosts to the same guest and port merge; disabled hosts drop', () => {
  const t = linkHosts([
    host(['docs.example.com'], '10.0.0.21'),
    host(['www.docs.example.com'], '10.0.0.21', 80, { instanceName: 'Second NPM', tls: { kind: 'none' } }),
    host(['blog.example.com'], '10.0.0.22'),
    host(['shop.example.com'], '10.0.0.24', 8080),
    host(['nas.example.com'], '10.0.0.99', 8080),
    host(['pve.example.com'], '10.0.0.2', 8006, { forwardScheme: 'https' }),
    host(['named.example.com'], 'quiet', 80),
    host(['gone.example.com'], '10.0.0.21', 80, { enabled: false }),
  ], GUESTS, [{ name: 'pve1', ip: '10.0.0.2' }])
  const by = (d: string) => t.find(x => x.domains.includes(d))!
  assert.deepEqual(by('docs.example.com').domains, ['docs.example.com', 'www.docs.example.com'])
  assert.equal(by('docs.example.com').proxies.length, 2); assert.equal(by('docs.example.com').tls, true)
  assert.equal(by('blog.example.com').guest!.vmid, 902, 'the running guest keeps the address, not its stopped copy')
  assert.equal(by('shop.example.com').guest!.type, 'qemu')
  assert.equal(by('nas.example.com').guest, null); assert.equal(by('nas.example.com').notGuest, 'an address that is not a guest')
  assert.equal(by('pve.example.com').notGuest, 'node pve1')
  assert.equal(by('named.example.com').guest!.vmid, 905); assert.equal(by('named.example.com').matchedBy, 'name')
  assert.equal(t.find(x => x.domains.includes('gone.example.com')), undefined)
  assert.deepEqual(unresolvedAddresses([host(['a.example.com'], '10.0.0.77'), host(['b.example.com'], '10.0.0.21')], GUESTS), ['10.0.0.77'])
})

test('candidates: adoptable containers first; VMs, non-guests and existing sites shown but not adoptable; split by log', () => {
  const targets = linkHosts([
    host(['docs.example.com'], '10.0.0.21'), host(['blog.example.com', 'app.example.com'], '10.0.0.22'),
    host(['shop.example.com'], '10.0.0.24'), host(['nas.example.com'], '10.0.0.99'),
  ], GUESTS)
  const inspected = new Map<number, InspectAnswer>([
    [901, { ok: true, out: parseDiscover(answer(FIXTURE)) }],
    [902, { ok: true, out: parseDiscover(answer(FIXTURE, ['HPXD1 wp /var/www/blog'])) }],
  ])
  const sites = [{ id: 'a1', vmid: 901, domain: 'docs.example.com', recipeId: 'adopted-static' }]
  const c = buildCandidates(targets, inspected, sites, new Map([['https://blog.example.com', true]]))
  const by = (d: string) => c.find(x => x.domains.includes(d))!
  assert.equal(by('docs.example.com').alreadyAdopted, true); assert.equal(by('docs.example.com').adoptable, false); assert.equal(by('docs.example.com').siteId, 'a1')
  const blog = by('blog.example.com')
  assert.equal(blog.adoptable, true); assert.equal(blog.kind, 'wordpress'); assert.equal(blog.logPath, '/var/log/nginx/blog.access.log')
  assert.equal(blog.url, 'https://blog.example.com'); assert.equal(blog.up, true); assert.deepEqual(blog.domains, ['blog.example.com'])
  // app.example.com on the same container falls to the default server's log, so it is a separate candidate.
  assert.equal(by('app.example.com').logPath, '/var/log/nginx/access.log'); assert.notEqual(by('app.example.com').id, blog.id)
  assert.match(by('shop.example.com').whyNot!, /VM/)
  assert.equal(by('nas.example.com').notAGuest, 'an address that is not a guest'); assert.equal(by('nas.example.com').adoptable, false)
  assert.equal(c[0].adoptable, true, 'adoptable first')
  // A site HyperProx made (not adopted) is matched by its domain too.
  const made = buildCandidates(linkHosts([host(['blog.example.com'], '10.0.0.22')], GUESTS), inspected, [{ id: 's9', vmid: 1, domain: 'blog.example.com', recipeId: 'static-site' }])
  assert.equal(made[0].alreadyASite, true); assert.equal(made[0].alreadyAdopted, false); assert.match(made[0].whyNot!, /HyperProx made/)
})

function fakeDeps(over: Partial<DiscoveryDeps> = {}, calls: { inspect: number[]; live: number; head: string[] } = { inspect: [], live: 0, head: [] }): DiscoveryDeps {
  let t = 0
  return {
    hosts: async () => ({ hosts: [host(['docs.example.com', 'www.docs.example.com'], '10.0.0.21'), host(['dyn.example.com'], '10.0.0.77')], errors: [{ instanceName: 'Edge Caddy', error: 'HyperProx is locked' }] }),
    guests: async () => [...GUESTS, guest(906, 'dyn', []), guest(907, 'web', ['10.0.0.27']), guest(908, 'db', ['10.0.0.28'])],
    liveAddresses: async () => { calls.live++; return new Map([[906, ['10.0.0.77']]]) },
    nodes: async () => [],
    sites: async () => [],
    inspect: async g => {
      calls.inspect.push(g.vmid)
      if (g.vmid === 908) return answer(null, [], ['1538'])
      return answer(FIXTURE, [], ['0050'])
    },
    head: async u => { calls.head.push(u); return true },
    now: () => (t += 1000),
    ...over,
  }
}

test('discover: dynamic addresses asked only when needed; containers listening on 80 without a proxy host are found', async () => {
  const calls = { inspect: [] as number[], live: 0, head: [] as string[] }
  const r = await discover(fakeDeps({}, calls), { budgetMs: 60_000 })
  assert.equal(calls.live, 1)
  const dyn = r.candidates.find(c => c.domains.includes('dyn.example.com'))!
  assert.equal(dyn.guest!.vmid, 906, 'matched through the address the running container reports')
  const web = r.candidates.find(c => c.source === 'listener' && c.guest?.vmid === 907)!
  assert.equal(web.url, 'http://10.0.0.27'); assert.equal(web.logPath, '/var/log/nginx/access.log'); assert.equal(web.proxy, null)
  assert.ok(!web.notes.some(n => /X-Forwarded-For/.test(n)), 'no proxy in front: the missing X-Forwarded-For does not matter')
  assert.equal(r.candidates.some(c => c.guest?.vmid === 908), false, 'a container with nothing on 80/443 is not a website')
  assert.equal(r.listenerScan.state, 'done')
  assert.deepEqual(r.errors, ['Edge Caddy: HyperProx is locked'])
  assert.ok(calls.head.includes('https://docs.example.com'))
  assert.equal(calls.inspect.filter(v => v === 901).length, 1, 'each container is looked at once')
  // Nothing unresolved: the running guests are not asked.
  const c2 = { inspect: [] as number[], live: 0, head: [] as string[] }
  await discover(fakeDeps({ hosts: async () => ({ hosts: [host(['docs.example.com'], '10.0.0.21')], errors: [] }) }, c2), { listeners: false })
  assert.equal(c2.live, 0)
  // A tight budget stops the listener scan and says so.
  const tight = await discover(fakeDeps(), { budgetMs: 1500 })
  assert.equal(tight.listenerScan.state, 'partial'); assert.match(tight.listenerScan.note!, /Time ran out/)
  // A container that cannot be read is listed with the reason, not dropped.
  const failing = await discover(fakeDeps({ inspect: async () => { throw new Error('No node login is stored for pve1.') } }), { listeners: false })
  assert.match(failing.candidates.find(c => c.domains.includes('docs.example.com'))!.whyNot!, /No node login/)
})

// ── the route ──────────────────────────────────────────────────────────────

async function app(role: string, runs: string[] = [], sites: SiteRecord[] = []) {
  const f = Fastify()
  f.addHook('onRequest', async (req: any) => { req.session = { role, email: `${role}@example.com` } })
  const deps = fakeDeps()
  await f.register(buildSiteMetricsRoutes({
    store: new MemoryMetricsStore(), sites: async () => sites, site: async id => sites.find(s => s.id === id), record: async s => { sites.push(s) }, forget: async () => {},
    run: async (_s, script) => { runs.push(script); return { code: 0, output: answer(FIXTURE, ['HPXD1 wp /var/www/blog'], ['0050']) } },
    container: async () => null, guests: async () => [], guestIp: async () => null, audit: async () => {}, now: () => new Date('2026-11-11T10:30:00Z'),
    discovery: { hosts: deps.hosts, guests: deps.guests, liveAddresses: deps.liveAddresses, nodes: deps.nodes, head: deps.head },
  }), { prefix: '/api/site-metrics' })
  return f
}

test('route: candidates are admin only, cached, and carry no configuration text', async () => {
  assert.equal(requiredRole('GET', '/api/site-metrics/adopt/candidates'), 'admin')
  assert.equal(needsReconfirm('GET', '/api/site-metrics/adopt/candidates'), false)
  for (const role of ['viewer', 'operator']) assert.equal((await (await app(role)).inject({ url: '/api/site-metrics/adopt/candidates' })).statusCode, 403)
  const runs: string[] = []
  const sites: SiteRecord[] = []
  const a = await app('admin', runs, sites)
  const res = await a.inject({ url: '/api/site-metrics/adopt/candidates' })
  assert.equal(res.statusCode, 200, res.body)
  const data = res.json().data
  const docs = data.candidates.find((c: any) => c.domains.includes('docs.example.com'))
  assert.equal(docs.guest.vmid, 901); assert.equal(docs.kind, 'static'); assert.equal(docs.logPath, '/var/log/nginx/access.log'); assert.equal(docs.adoptable, true)
  assert.deepEqual(data.defaults, { logPath: '/var/log/nginx/access.log', wpPath: '/var/www/wordpress' })
  for (const secret of ['Bearer', 'not-a-real-token', 'htpasswd', 'auth_basic', 'fastcgi', 'php8.2-fpm', 'proxy_pass', '127.0.0.1:3000', 'try_files', 'log_format', 'server {', 'HPXD1'])
    assert.ok(!res.body.includes(secret), `the response holds no "${secret}"`)
  assert.ok(runs.length > 0 && runs.every(s => s === discoverScript()), 'only the read-only script runs')
  const n = runs.length
  await a.inject({ url: '/api/site-metrics/adopt/candidates' })
  assert.equal(runs.length, n, 'a second look within a minute is the cached list')
  // A site added after the list was built shows as added straight away.
  sites.push({ id: 'a7', recipeId: 'adopted-static', name: 'docs', vmid: 901, node: 'pve1', jobId: 'adopted', owner: 'admin@example.com', createdAt: 1 })
  const again = (await a.inject({ url: '/api/site-metrics/adopt/candidates' })).json().data.candidates.find((c: any) => c.domains.includes('docs.example.com'))
  assert.equal(again.alreadyAdopted, true); assert.equal(again.adoptable, false); assert.equal(again.siteId, 'a7')
})
