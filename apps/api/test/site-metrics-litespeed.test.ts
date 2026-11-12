// Site metrics on LiteSpeed (OpenLiteSpeed, and CyberPanel on top of it): reading its configuration into
// listeners and virtual hosts, picking a site's log, kind and lsphp, the extra log places the path rule allows
// (and everything it still refuses), LiteSpeed's quoted log lines, its dated rotation, the read-only WordPress
// card with lsphp, and the adopt notes when the log holds only the proxy's address. HyperProx never changes
// LiteSpeed: there is no logging change for it. The fixtures are filtered and sanitised copies of a real
// CyberPanel server's files (names replaced with example.com/example.org, users with siteuserN, addresses with
// documentation addresses).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, renameSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'

import {
  discoverScript, parseDiscover, parseLiteSpeedConfig, matchLsVhost, lsLogFor, lsFormatFacts, lsPath, inspectFor,
  buildCandidates, LITESPEED_PROXY_NOTE, type Target,
} from '../src/lib/site-metrics/discovery'
import { safeLogPath, safeNginxLogPath, safeWordPressPath, safePhpBin, isLiteSpeedLogPath } from '../src/lib/site-metrics/paths'
import { parseLogLine, isPrivateAddress } from '../src/lib/site-metrics/log-parser'
import { readLogScript } from '../src/lib/site-metrics/read-script'
import { inspectScript, planLogFormat } from '../src/lib/site-metrics/log-format'
import { wordpressScript, parseWordPressOutput } from '../src/lib/site-metrics/wordpress'
import { MemoryMetricsStore } from '../src/lib/site-metrics/store'
import { defaultState, pullLog, type CollectorDeps } from '../src/lib/site-metrics/collector'
import { detail } from '../src/lib/site-metrics/view'
import { buildSiteMetricsRoutes, checkAdoptInput, parseAdoptProbe, adoptProbeScript } from '../src/routes/site-metrics'
import type { SiteRecord } from '../src/lib/sites'

const FX = join(__dirname, 'fixtures', 'site-metrics')
const read = (f: string) => readFileSync(join(FX, f), 'utf8')
const SERVER = read('litespeed-httpd_config.txt')
const VHOSTS = [
  { name: 'example.com', text: read('litespeed-vhost-example.com.txt') },
  { name: 'example.org', text: read('litespeed-vhost-example.org.txt') },
  { name: 'mail.example.com', text: read('litespeed-vhost-mail.example.com.txt') },
]
const LOG = read('litespeed-access.log').split('\n').filter(Boolean)
const b64 = (s: string) => Buffer.from(s).toString('base64')

/** What discoverScript sends back from a CyberPanel container like the one the fixtures came from. */
const answer = (extra: string[] = [], server = SERVER) => [
  'HPXD1 listen 0050', 'HPXD1 listen 01BB', 'HPXD1 bin litespeed', `HPXD1 lsserver ${b64(server)}`,
  ...VHOSTS.map(v => `HPXD1 lsvhost ${v.name} ${b64(v.text)}`),
  'HPXD1 lsphp /usr/local/lsws/lsphp83/bin/php', ...extra, 'HPXD1 end', '',
].join('\n')

// ── configuration ──────────────────────────────────────────────────────────

test('LiteSpeed config: listeners and their maps, each vhost\'s roots, names, logs and lsphp, with variables filled in', () => {
  const c = parseLiteSpeedConfig(SERVER, VHOSTS)
  assert.deepEqual(c.listeners.map(l => [l.name, l.ports]), [['Default', [80]], ['SSL', [443]], ['SSL IPv6', [443]]])
  assert.deepEqual(c.listeners[0].maps.find(m => m.vhost === 'example.com'), { vhost: 'example.com', domains: ['example.com'] })
  assert.deepEqual(c.vhosts.map(v => v.name), ['Example', 'example.com', 'mail.example.com', 'example.org', 'mail.example.org'])
  assert.deepEqual(c.serverLog, { path: '/usr/local/lsws/logs/access.log', format: null })
  assert.equal(c.useIpInProxyHeader, null, 'the setting is not there: LiteSpeed logs the proxy\'s address')
  const site = c.vhosts.find(v => v.name === 'example.com')!
  assert.equal(site.vhRoot, '/home/example.com')
  assert.equal(site.docRoot, '/home/example.com/public_html')
  assert.deepEqual(site.names, ['example.com', 'www.example.com'])
  assert.equal(site.log!.path, '/home/example.com/logs/example.com.access_log')
  assert.equal(site.log!.format, '"%h %l %u %t "%r" %>s %b "%{Referer}i" "%{User-Agent}i""')
  assert.equal(site.errorLog, '/home/example.com/logs/example.com.error_log')
  assert.equal(site.lsphp, '/usr/local/lsws/lsphp83/bin/lsphp')
  const mail = c.vhosts.find(v => v.name === 'mail.example.com')!
  assert.equal(mail.vhRoot, '/home/example.com'); assert.equal(mail.docRoot, '/home/example.com/mail.example.com')
  assert.equal(mail.log!.path, '/home/example.com/logs/example.com.access_log', 'the mail vhost writes the site\'s log')
  assert.equal(c.vhosts.find(v => v.name === 'Example')!.vhRoot, '/usr/local/lsws/Example', 'a relative vhRoot is under the server root')
  assert.equal(lsPath('$SERVER_ROOT/conf/x/', {}), '/usr/local/lsws/conf/x')
})

test('LiteSpeed config: useServer 1 writes the server log; useIpInProxyHeader is read; a catch-all map is last', () => {
  const server = `useIpInProxyHeader 1\nvirtualHost a.example.net {\n  vhRoot /srv/a\n}\nvirtualHost any {\n  vhRoot /srv/any\n}\nlistener L {\n  address *:8088\n  map a.example.net a.example.net, *.a.example.net\n  map any *\n}\n`
  const c = parseLiteSpeedConfig(server, [{ name: 'a.example.net', text: 'docRoot $VH_ROOT/html\naccesslog $VH_ROOT/logs/a.log {\n  useServer 1\n}\n' }])
  assert.equal(c.useIpInProxyHeader, 1)
  const a = c.vhosts.find(v => v.name === 'a.example.net')!
  assert.equal(a.log, null)
  assert.equal(matchLsVhost(c, 'x.a.example.net', 8088)!.vhost.name, 'a.example.net', 'a wildcard map')
  assert.equal(matchLsVhost(c, 'other.example.org', 8088)!.vhost.name, 'any', 'the catch-all only when nothing else fits')
  const log = lsLogFor(c, a)
  assert.equal(log.logPath, '/usr/local/lsws/logs/access.log'); assert.equal(log.realClientIp, true)
  assert.equal(log.format!.forwardedFor, true, 'with the setting on, the logged address is the visitor\'s')
  assert.match(log.note!, /shared server log: it includes every site on this server/)
  assert.equal(lsLogFor(parseLiteSpeedConfig(SERVER, VHOSTS), parseLiteSpeedConfig(SERVER, VHOSTS).vhosts.find(v => v.name === 'example.com')!).note, undefined, 'a site\'s own log is not shared')
})

test('LiteSpeed: the vhost for a name and port, its log and its format facts', () => {
  const c = parseLiteSpeedConfig(SERVER, VHOSTS)
  assert.equal(matchLsVhost(c, 'example.com', 80)!.vhost.name, 'example.com')
  assert.equal(matchLsVhost(c, 'EXAMPLE.com', 443)!.how, 'map')
  assert.deepEqual([matchLsVhost(c, 'www.example.com', 80)!.vhost.name, matchLsVhost(c, 'www.example.com', 80)!.how], ['example.com', 'name'], 'by vhAliases')
  assert.equal(matchLsVhost(c, 'mail.example.com', 443)!.vhost.name, 'mail.example.com')
  assert.equal(matchLsVhost(c, 'nobody.example.net', 80), null)
  assert.deepEqual(lsFormatFacts('"%h %l %u %t "%r" %>s %b "%{Referer}i" "%{User-Agent}i""'), { name: 'combined', requestTime: false, forwardedFor: false })
  assert.deepEqual(lsFormatFacts('%h %l %u %t "%r" %>s %b %D "%{X-Forwarded-For}i"'), { name: 'custom', requestTime: true, forwardedFor: true })
  assert.deepEqual(lsFormatFacts(null), { name: 'combined', requestTime: false, forwardedFor: false })
})

// ── one container, inspected ───────────────────────────────────────────────

test('inspect: a CyberPanel WordPress site behind a proxy is LiteSpeed, WordPress, its own log, lsphp, visitors approximate', () => {
  const out = parseDiscover(answer(['HPXD1 wp /home/example.com/public_html', 'HPXD1 php /home/example.com/public_html']))
  assert.ok(out.bins.includes('litespeed')); assert.ok(out.litespeed)
  const i = inspectFor(out, 'example.com', 80)
  assert.equal(i.server, 'litespeed')
  assert.equal(i.kind, 'wordpress'); assert.equal(i.wpPath, '/home/example.com/public_html')
  assert.equal(i.logPath, '/home/example.com/logs/example.com.access_log')
  assert.equal(i.errorLog, '/home/example.com/logs/example.com.error_log')
  assert.equal(i.phpBin, '/usr/local/lsws/lsphp83/bin/php')
  assert.deepEqual(i.logFormat, { name: 'combined', requestTime: false, forwardedFor: false })
  assert.equal(i.visitorsApproximate, true)
  assert.ok(i.notes.includes(LITESPEED_PROXY_NOTE))
  assert.match(LITESPEED_PROXY_NOTE, /requests and page views are exact but unique visitors are approximated/)
  assert.match(LITESPEED_PROXY_NOTE, /Use Client IP in Header/); assert.match(LITESPEED_PROXY_NOTE, /does not change LiteSpeed or CyberPanel/)
  assert.ok(!i.notes.some(n => /offers the logging change/.test(n)), 'no logging change is offered for LiteSpeed')
  // Not behind a proxy (found listening): nothing to approximate.
  assert.equal(inspectFor(out, 'example.com', 80, false).visitorsApproximate, false)
})

test('inspect: plain files are static, .php files are other; the setting on means exact visitors', () => {
  const plain = inspectFor(parseDiscover(answer()), 'example.org', 443)
  assert.equal(plain.server, 'litespeed'); assert.equal(plain.kind, 'static'); assert.equal(plain.phpBin, null)
  assert.equal(plain.logPath, '/home/example.org/logs/example.org.access_log')
  assert.equal(inspectFor(parseDiscover(answer(['HPXD1 php /home/example.org/public_html'])), 'example.org', 443).kind, 'other')
  const on = inspectFor(parseDiscover(answer([], `useIpInProxyHeader 2\n${SERVER}`)), 'example.org', 443)
  assert.equal(on.visitorsApproximate, false); assert.ok(!on.notes.includes(LITESPEED_PROXY_NOTE))
  const none = inspectFor(parseDiscover(answer()), 'nobody.example.net', 80)
  assert.equal(none.logPath, null); assert.match(none.notes[0], /No LiteSpeed listener maps nobody\.example\.net/)
  // A log LiteSpeed writes somewhere HyperProx does not read is not offered.
  const odd = inspectFor(parseDiscover(answer([], SERVER.replace('virtualHost example.org {\n  vhRoot                  /home/$VH_NAME', 'virtualHost example.org {\n  vhRoot                  /opt/sites/$VH_NAME'))), 'example.org', 443)
  assert.equal(odd.logPath, null); assert.match(odd.notes.join(' '), /outside \/var\/log, \/usr\/local\/lsws\/logs/)
  // lsphp named in the vhost but without a php beside it: WP-CLI uses the PATH's php, and says so.
  const noPhp = parseDiscover(answer(['HPXD1 wp /home/example.com/public_html']).replace('HPXD1 lsphp /usr/local/lsws/lsphp83/bin/php\n', ''))
  const w = inspectFor(noPhp, 'example.com', 80)
  assert.equal(w.phpBin, null); assert.ok(w.notes.some(n => /has no php command beside it/.test(n)))
})

test('candidates: a LiteSpeed site is adoptable and carries its error log, lsphp and the approximation', () => {
  const target: Target = { key: 'g710:80', domains: ['example.com'], tls: true, forward: { scheme: 'http', host: '10.0.0.10', port: 80 },
    proxies: [{ instanceName: 'Edge NPM', kind: 'npm' }], guest: { vmid: 710, name: 'panel', node: 'pve1', type: 'lxc', status: 'running', addresses: ['10.0.0.10'] }, matchedBy: 'address', source: 'proxy' }
  const out = parseDiscover(answer(['HPXD1 wp /home/example.com/public_html']))
  const [c] = buildCandidates([target], new Map([[710, { ok: true, out }]]), [])
  assert.equal(c.adoptable, true, c.whyNot ?? '')
  assert.equal(c.server, 'litespeed'); assert.equal(c.kind, 'wordpress'); assert.equal(c.url, 'https://example.com')
  assert.equal(c.errorLog, '/home/example.com/logs/example.com.error_log'); assert.equal(c.phpBin, '/usr/local/lsws/lsphp83/bin/php')
  assert.equal(c.visitorsApproximate, true)
  assert.ok(!JSON.stringify(c).includes('%{User-Agent}') && !JSON.stringify(c).includes('vhRoot'), 'no configuration text in a candidate')
})

// ── the script itself, against a stand-in LiteSpeed tree ───────────────────

test('discoverScript on LiteSpeed: read-only, sends only the lines that place a site, finds WordPress and PHP roots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hpx-ls-'))
  try {
    const lsw = join(dir, 'lsws')
    for (const d of ['bin', 'conf/vhosts/wp.example.com', 'conf/vhosts/plain.example.com', 'conf/vhosts/evil', 'lsphp83/bin']) mkdirSync(join(lsw, d), { recursive: true })
    for (const b of ['bin/openlitespeed', 'lsphp83/bin/php']) { writeFileSync(join(lsw, b), '#!/bin/sh\n'); chmodSync(join(lsw, b), 0o755) }
    const home = join(dir, 'home')
    mkdirSync(join(home, 'wp.example.com/public_html'), { recursive: true }); writeFileSync(join(home, 'wp.example.com/public_html/wp-config.php'), '<?php // not-a-real-secret\n')
    mkdirSync(join(home, 'plain.example.com/public_html'), { recursive: true }); writeFileSync(join(home, 'plain.example.com/public_html/index.html'), 'hi\n')
    const pwned = join(dir, 'pwned')
    writeFileSync(join(lsw, 'conf/httpd_config.conf'), [
      'adminEmails admin@example.com', '# accessLog /commented/out {',
      'accessLog logs/access.log {', '  logReferer 1', '}',
      `virtualHost wp.example.com {`, `  vhRoot ${home}/$VH_NAME`, `  configFile $SERVER_ROOT/conf/vhosts/$VH_NAME/vhost.conf`, '}',
      `virtualHost plain.example.com {`, `  vhRoot ${home}/$VH_NAME`, '}',
      // A vhRoot that would be a sed "e" (run a command) if it reached sed's script unchecked; no spaces, so awk keeps it whole.
      `virtualHost evil {`, `  vhRoot /x|g;etouch$IFS${pwned};s|y`, '}',
      'listener SSL {', '  address *:443', '  keyFile /etc/letsencrypt/live/wp.example.com/privkey.pem', '  map wp.example.com wp.example.com', '  map plain.example.com plain.example.com', '}',
    ].join('\n') + '\n')
    const vh = (extra: string[] = []) => ['docRoot $VH_ROOT/public_html', 'vhDomain $VH_NAME', 'accesslog $VH_ROOT/logs/$VH_NAME.access_log {', '  useServer 0',
      '  logFormat "%h %l %u %t "%r" %>s %b "%{Referer}i" "%{User-Agent}i""', '}',
      'extprocessor siteuser1 {', '  path /usr/local/lsws/lsphp83/bin/lsphp', '  env LSAPI_CHILDREN=10', '}',
      'rewrite {', '  rules <<<END_rules', 'RewriteRule ^secret-rewrite$ /x [L]', '  END_rules', '}', ...extra].join('\n') + '\n'
    writeFileSync(join(lsw, 'conf/vhosts/wp.example.com/vhost.conf'), vh(['realm Private {', '  userDB {', '    location /home/not-a-real-htpasswd', '  }', '}']))
    writeFileSync(join(lsw, 'conf/vhosts/plain.example.com/vhost.conf'), vh())
    writeFileSync(join(lsw, 'conf/vhosts/evil/vhost.conf'), 'docRoot $VH_ROOT/public_html\n')
    const script = discoverScript()
    assert.ok(!/\b(rm|mv|cp|tee|sed -i|chmod|chown|systemctl|reload|restart|install)\b|>\s*\/(?!dev\/null)/.test(script.replace(/2>\/dev\/null|>\/dev\/null/g, '')), 'nothing in it writes')
    // This machine's own nginx (if any) is hidden behind one that fails, so only the stand-in LiteSpeed answers.
    mkdirSync(join(dir, 'shim')); writeFileSync(join(dir, 'shim', 'nginx'), '#!/bin/sh\nexit 1\n'); chmodSync(join(dir, 'shim', 'nginx'), 0o755)
    const r = spawnSync('bash', ['-c', script.replace('LSW=/usr/local/lsws', `LSW=${lsw}`)], { encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'shim')}:${process.env.PATH}` } })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(existsSync(pwned), false, 'a vhRoot is never run as a sed command')
    const out = parseDiscover(r.stdout)
    assert.ok(out.bins.includes('litespeed'))
    assert.deepEqual(out.wpRoots, [join(home, 'wp.example.com/public_html')])
    assert.deepEqual(out.phpRoots, [join(home, 'wp.example.com/public_html')], 'wp-config.php is a .php file; the plain root has none')
    assert.deepEqual(out.lsphp, [], 'a stand-in lsphp outside /usr/local/lsws is not believed')
    const sent = [...r.stdout.matchAll(/^HPXD1 ls(?:server|vhost \S+) (\S*)$/gm)].map(m => Buffer.from(m[1], 'base64').toString('utf8')).join('\n')
    for (const secret of ['privkey', 'keyFile', 'admin@example.com', 'secret-rewrite', 'not-a-real-htpasswd', 'LSAPI_CHILDREN', '/commented/out', 'not-a-real-secret'])
      assert.ok(!sent.includes(secret), `"${secret}" stays in the container`)
    const wp = inspectFor(out, 'wp.example.com', 443)
    assert.equal(wp.kind, 'wordpress'); assert.equal(wp.wpPath, null, 'outside /home/<site>/public_html (a temp folder) the folder is not offered')
    assert.equal(inspectFor(out, 'plain.example.com', 443).kind, 'static')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── paths ──────────────────────────────────────────────────────────────────

test('paths: LiteSpeed and CyberPanel log places are read; everything else is still refused', () => {
  for (const p of ['/usr/local/lsws/logs/access.log', '/usr/local/lsws/logs/error.log', '/home/example.com/logs/example.com.access_log', '/home/example.com/logs/example.com.error_log']) {
    assert.equal(safeLogPath(p), p, p); assert.equal(isLiteSpeedLogPath(p), true, p)
    assert.equal(safeNginxLogPath(p), null, `${p} is never one the nginx change may name`)
  }
  assert.equal(safeLogPath('/var/log/nginx/access.log'), '/var/log/nginx/access.log')
  for (const p of [
    '/home/example.com/logs/../../etc/shadow', '/home/example.com/public_html/../logs/example.com.access_log', '/home/example.com/logs/example.com.log',
    '/home/example.com/x/logs/example.com.access_log', '/home/.hidden/logs/x.access_log', '/home/example.com/logs/.x.access_log',
    "/home/example.com/logs/a'b.access_log", '/home/example.com/logs/a b.access_log', '/home/example.com/logs/x.access_log;id', '/home//logs/x.access_log',
    '/home/example.com/logs/', '/home/example.com/logs/x.access_log/', '/usr/local/lsws/logs/', '/usr/local/lsws/logs/sub/x.log', '/usr/local/lsws/logs/../conf/httpd_config.conf',
    '/usr/local/lsws/conf/httpd_config.conf', '/usr/local/lsws/admin/conf/htpasswd', '/home/example.com/public_html/wp-config.php', '/root/.ssh/id_rsa',
    'home/example.com/logs/x.access_log', '/usr/local/lsws/logs/$(id)',
  ]) assert.equal(safeLogPath(p), null, p)
  assert.equal(safeWordPressPath('/home/example.com/public_html'), '/home/example.com/public_html')
  assert.equal(safeWordPressPath('/home/example.com/public_html/blog'), '/home/example.com/public_html/blog')
  for (const p of ['/home/example.com', '/home/example.com/private', '/home/example.com/public_html/../x', '/home/.x/public_html']) assert.equal(safeWordPressPath(p), null, p)
  assert.equal(safePhpBin('/usr/local/lsws/lsphp83/bin/php'), '/usr/local/lsws/lsphp83/bin/php')
  for (const p of ['/usr/bin/php', '/usr/local/lsws/lsphp83/bin/lsphp', '/usr/local/lsws/lsphp8/bin/php', '/usr/local/lsws/lsphp83/bin/php;id', '/tmp/php']) assert.equal(safePhpBin(p), null, p)
  // The read script takes them, single-quoted; the nginx change never does.
  assert.match(readLogScript('/home/example.com/logs/example.com.access_log', { inode: '0', offset: 0 }), /^LOG='\/home\/example\.com\/logs\/example\.com\.access_log'$/m)
  assert.throws(() => readLogScript('/home/example.com/logs/../../x', { inode: '0', offset: 0 }), /Refused/)
  assert.throws(() => inspectScript('/home/example.com/logs/example.com.access_log'), /never LiteSpeed/)
  assert.match(planLogFormat({ nginx: true, configOk: true, defined: false, includeFileExists: false, files: [] }, '/usr/local/lsws/logs/access.log').refusal!, /only nginx/)
})

// ── the log ────────────────────────────────────────────────────────────────

test('fixture: LiteSpeed\'s quoted combined lines from a real CyberPanel site parse completely', () => {
  assert.equal(LOG.length, 80)
  const parsed = LOG.map(parseLogLine)
  assert.equal(parsed.filter(p => !p).length, 0, 'every line parses')
  assert.ok(LOG.every(l => l.startsWith('"') && l.endsWith('""')), 'the fixture keeps the outer quotes LiteSpeed writes')
  assert.ok(parsed.every(p => p!.format === 'combined'))
  assert.ok(parsed.every(p => !p!.ua.endsWith('"') && p!.remote.startsWith('198.51.100.')), 'the outer quotes are taken off')
  const cron = parsed.find(p => p!.path === '/wp-cron.php')!
  assert.equal(cron.method, 'POST'); assert.equal(cron.status, 200); assert.equal(cron.bytes, 0)
  assert.equal(parsed.filter(p => p!.status === 404).length > 40, true)
  // The same lines with the proxy's real (private) address: every one is "from the proxy", nothing to tell visitors apart.
  const lan = LOG.map(l => l.replace(/^"198\.51\.100\.\d+ /, '"10.0.0.30 ')).map(parseLogLine)
  assert.ok(lan.every(p => isPrivateAddress(p!.remote) && p!.client === p!.remote))
  // Unchanged: a plain combined line, and a quoted line that is not one LiteSpeed would write.
  assert.ok(parseLogLine('203.0.113.9 - - [11/Nov/2026:10:15:00 +0000] "GET / HTTP/1.1" 200 5 "-" "curl/8.14.1"'))
  assert.equal(parseLogLine('"203.0.113.9 - - [11/Nov/2026:10:15:00 +0000] "GET / HTTP/1.1" 200 5 "-" "curl/8.14.1" junk"'), null)
})

function bashRun(script: string) {
  const r = spawnSync('bash', [], { input: script, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status, output: r.stdout }
}

const LSITE: SiteRecord = { id: 'ls1', recipeId: 'adopted-wordpress', name: 'Panel', vmid: 710, node: 'pve1', domain: 'example.com', url: 'https://example.com', jobId: 'adopted', owner: 'a@example.com', createdAt: 0 }
const LPATH = '/home/example.com/logs/example.com.access_log'

test('read script: LiteSpeed\'s dated rotation (<log>.YYYY_MM_DD) is followed like .1; the proxy-only log is marked approximate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hpx-lsr-'))
  try {
    const log = join(dir, 'example.com.access_log')
    const line = (path: string) => `"10.0.0.30 - - [11/Nov/2026:10:15:00 +0000] "GET ${path} HTTP/1.1" 200 5 "-" "Mozilla/5.0 (X11; Linux x86_64) Firefox/148.0""`
    writeFileSync(log, line('/one') + '\n')
    const store = new MemoryMetricsStore()
    const d: CollectorDeps = {
      sites: async () => [LSITE], store, unlocked: () => true, now: () => new Date('2026-11-11T10:30:00Z'), log: () => {}, publish: async () => {},
      health: { fetch: async () => ({ status: 200, body: 'ok' }), tls: async () => ({ notAfter: null, issuer: null, trusted: null, error: null }), now: () => 0 },
      run: async (_s, script) => bashRun(script.split(`LOG='${LPATH}'`).join(`LOG='${log}'`)),
    }
    const st = { ...defaultState(LSITE), logPath: LPATH }
    assert.equal(await pullLog(LSITE, st, d), 1)
    appendFileSync(log, line('/two') + '\n')
    renameSync(log, `${log}.2026_11_11`)
    writeFileSync(log, line('/three') + '\n')
    assert.equal(await pullLog(LSITE, st, d), 2, 'the rest of the dated file, then the new log')
    assert.equal(st.gaps, 0)
    assert.equal(st.visitorsApproximate, true)
    // Rolled and compressed: the old inode is gone, which is a gap, as for logrotate.
    appendFileSync(log, line('/lost') + '\n')
    renameSync(log, `${log}.2026_11_12.gz`)
    writeFileSync(log, line('/four') + '\n')
    assert.equal(await pullLog(LSITE, st, d), 1); assert.equal(st.gaps, 1)
    const full = await detail(LSITE, st, store, new Date('2026-11-11T10:30:00Z'), '24h', true)
    assert.equal(full.hud.visitorsApproximate, true)
    assert.equal(full.collector!.litespeed, true); assert.equal(full.collector!.visitorsApproximate, true)
    const viewer = await detail(LSITE, st, store, new Date('2026-11-11T10:30:00Z'), '24h', false)
    assert.equal(viewer.hud.visitorsApproximate, true, 'a viewer is told too'); assert.equal(viewer.collector, undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── WordPress through lsphp ────────────────────────────────────────────────

test('WordPress on LiteSpeed: WP-CLI runs with the given lsphp, read-only, for a CyberPanel folder', () => {
  const s = wordpressScript('/home/example.com/public_html', '/home/example.com/logs/example.com.error_log', 10, '/usr/local/lsws/lsphp83/bin/php')
  assert.match(s, /^PHPBIN='\/usr\/local\/lsws\/lsphp83\/bin\/php'$/m)
  assert.match(s, /^WPP='\/home\/example\.com\/public_html'$/m)
  assert.match(s, /\$\{PHPBIN:\+"\$PHPBIN"\} "\$WPBIN" --path="\$WPP" --skip-plugins --skip-themes/)
  assert.match(s, /"\$\{PHPBIN:-php\}" -r/)
  assert.ok(!/\b(plugin|theme|core|option|db|cache|transient) (install|update|activate|deactivate|delete|set|reset|flush|query|import)\b/.test(s), 'read-only commands only')
  assert.match(wordpressScript(), /^PHPBIN=''$/m, 'without one, the php on the PATH as before')
  assert.throws(() => wordpressScript('/home/example.com/public_html', '/home/example.com/logs/example.com.error_log', 10, '/usr/bin/php;id'), /Refused/)
  // WP-CLI runs as the folder's owner, never as a system account.
  assert.match(s, /case "\$OWNER" in root\|lsadm\|nobody\) echo "HPXW1 owner \$OWNER"; echo "HPXW1 end"; exit 0/)
  assert.ok(!/OWNER=www-data/.test(s), 'a root-owned folder is no longer run as www-data')
  for (const who of ['root', 'lsadm', 'nobody']) {
    const own = spawnSync('bash', ['-c', `OWNER=${who}\n${/^case "\$OWNER".*$/m.exec(s)![0]}\necho ran`], { encoding: 'utf8' })
    assert.equal(own.stdout, `HPXW1 owner ${who}\nHPXW1 end\n`, who)
    const info = parseWordPressOutput(own.stdout, 1)
    assert.match(info.problem!, new RegExp(`belongs to ${who}, a system account.*WordPress card is skipped`)); assert.equal(info.core, null)
  }
  assert.match(parseWordPressOutput('HPXW1 owner x;rm\nHPXW1 end\n', 1).problem!, /belongs to a system account/)
  // The PHP line, run: with no lsphp given and none on the PATH it says nothing, rather than guessing.
  const php = /^echo "HPXW1 php".*$/m.exec(s)![0]
  const r = spawnSync('bash', ['-c', `PHPBIN=/nonexistent/php\n${php}`], { encoding: 'utf8' })
  assert.equal(r.stdout.trim(), 'HPXW1 php')
})

// ── adopting ───────────────────────────────────────────────────────────────

test('adopt: the error log and lsphp are checked; the probe knows LiteSpeed', () => {
  const ok = checkAdoptInput({ vmid: 710, url: 'https://example.com', kind: 'wordpress', logPath: LPATH, wpPath: '/home/example.com/public_html',
    errorLog: '/home/example.com/logs/example.com.error_log', phpBin: '/usr/local/lsws/lsphp83/bin/php' })
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.input, { vmid: 710, url: 'https://example.com', logPath: LPATH, kind: 'wordpress', wpPath: '/home/example.com/public_html', name: '',
    errorLog: '/home/example.com/logs/example.com.error_log', phpBin: '/usr/local/lsws/lsphp83/bin/php' })
  assert.match(checkAdoptInput({ vmid: 710, url: 'https://example.com', kind: 'static', logPath: LPATH, errorLog: '/etc/shadow' }).errors.join(), /error log/)
  assert.match(checkAdoptInput({ vmid: 710, url: 'https://example.com', kind: 'wordpress', logPath: LPATH, wpPath: '/home/example.com/public_html', phpBin: '/bin/sh' }).errors.join(), /PHP for WP-CLI/)
  assert.equal(checkAdoptInput({ vmid: 710, url: 'https://example.com', kind: 'static', logPath: LPATH, phpBin: '/usr/local/lsws/lsphp83/bin/php' }).input!.phpBin, null, 'lsphp only matters for WordPress')
  const script = adoptProbeScript(ok.input!)
  assert.match(script, /HPXA1 litespeed yes/); assert.match(script, /\[ -x '\/usr\/local\/lsws\/lsphp83\/bin\/php' \]/)
  const tail = b64(LOG.slice(0, 20).map(l => l.replace(/^"198\.51\.100\.\d+ /, '"10.0.0.30 ')).join('\n') + '\n')
  const f = parseAdoptProbe(`HPXA1 log yes\nHPXA1 readable yes\nHPXA1 tail ${tail}\nHPXA1 litespeed yes\nHPXA1 wordpress yes\nHPXA1 wpcli yes\nHPXA1 php yes\nHPXA1 end\n`)
  assert.equal(f.litespeed, true); assert.equal(f.nginx, false); assert.equal(f.php, true)
  assert.deepEqual(f.sample, { lines: 20, formats: { combined: 20 }, malformed: 0 })
  assert.equal(f.behindProxyWithoutForwardedFor, true)
})

const audits: Array<{ action: string; details?: Record<string, unknown> }> = []
async function app(store: MemoryMetricsStore, runs: string[], probe: string) {
  const f = Fastify()
  f.addHook('onRequest', async (req: any) => { req.session = { role: 'admin', email: 'admin@example.com' } })
  const sites: SiteRecord[] = []
  await f.register(buildSiteMetricsRoutes({
    store, sites: async () => sites, site: async id => sites.find(s => s.id === id), record: async s => { sites.push(s) }, forget: async () => {},
    run: async (_s, script) => { runs.push(script); return { code: 0, output: probe } },
    container: async () => null,
    guests: async () => [{ vmid: 710, name: 'panel', node: 'pve1', status: 'running', type: 'lxc' }],
    guestIp: async () => '10.0.0.10', audit: async (action, _r, details) => { audits.push({ action, details }) }, now: () => new Date('2026-11-11T10:30:00Z'),
  }), { prefix: '/api/site-metrics' })
  return { f, sites }
}

test('routes: a LiteSpeed site behind a proxy is adoptable, the notes say visitors are approximated, and no change is offered', async () => {
  const tail = b64(LOG.slice(0, 20).map(l => l.replace(/^"198\.51\.100\.\d+ /, '"10.0.0.30 ')).join('\n') + '\n')
  const probe = `HPXA1 log yes\nHPXA1 readable yes\nHPXA1 tail ${tail}\nHPXA1 litespeed yes\nHPXA1 wordpress yes\nHPXA1 wpcli yes\nHPXA1 php yes\nHPXA1 end\n`
  const store = new MemoryMetricsStore(), runs: string[] = []
  const { f, sites } = await app(store, runs, probe)
  const body = { vmid: 710, url: 'https://example.com', kind: 'wordpress', logPath: LPATH, wpPath: '/home/example.com/public_html',
    errorLog: '/home/example.com/logs/example.com.error_log', phpBin: '/usr/local/lsws/lsphp83/bin/php' }
  const check = (await f.inject({ method: 'POST', url: '/api/site-metrics/adopt/check', payload: body })).json().data
  assert.equal(check.ok, true, JSON.stringify(check.errors))
  const w = check.warnings.join('\n')
  assert.match(w, /requests and page views are exact but unique visitors are approximated/)
  assert.match(w, /Use Client IP in Header/)
  assert.match(w, /does not change LiteSpeed or CyberPanel, so no logging change is offered/)
  assert.ok(!/offered after adopting|the same change adds it|nginx is not installed/.test(w), w)
  assert.ok(!JSON.stringify(check).includes('10.0.0.30'), 'no log line or address in the answer')
  assert.ok(!/every site on this server/.test(w), 'the site\'s own log is not called shared')
  const shared = (await f.inject({ method: 'POST', url: '/api/site-metrics/adopt/check', payload: { ...body, logPath: '/usr/local/lsws/logs/access.log' } })).json().data
  assert.match(shared.warnings.join('\n'), /shared server log: it includes every site on this server/)
  const added = await f.inject({ method: 'POST', url: '/api/site-metrics/adopt', payload: body })
  assert.equal(added.statusCode, 200, added.body)
  const st = (await store.getState(added.json().data.id))!
  assert.equal(st.logPath, LPATH); assert.equal(st.errorLog, '/home/example.com/logs/example.com.error_log')
  assert.equal(st.phpBin, '/usr/local/lsws/lsphp83/bin/php'); assert.equal(st.wpPath, '/home/example.com/public_html')
  assert.equal(sites[0].recipeId, 'adopted-wordpress')
  const a = audits.find(x => x.action === 'site.adopt')!
  assert.equal(a.details!.errorLog, '/home/example.com/logs/example.com.error_log'); assert.equal(a.details!.phpBin, '/usr/local/lsws/lsphp83/bin/php')
  // The log-format preview refuses without running anything in the container.
  const n = runs.length
  const pre = (await f.inject({ method: 'POST', url: `/api/site-metrics/sites/${sites[0].id}/log-format/preview`, payload: {} })).json().data
  assert.equal(pre.planId, null); assert.match(pre.plan.refusal, /only nginx/)
  assert.equal(runs.length, n, 'nothing ran for the refused preview')
  assert.ok(runs.every(s => !/\b(rm|mv|cp|sed -i|tee|systemctl|lswsctrl|reload|restart)\b|>\s*\/(?!dev\/null)/.test(s.replace(/2>\/dev\/null|>\/dev\/null/g, ''))), 'every script that ran only reads')
})
