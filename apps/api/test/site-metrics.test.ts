// Site metrics: the access log reader and its rotation handling (the real bash script, run on temporary files),
// the line parser, User-Agent and bot classification, hourly aggregation, visitor hashing and salt rotation,
// retention, path validation, alerts, the nginx log_format plan, the WordPress read, the Prometheus text, the
// routes' role trimming, and a parser run over a sanitised log from a real static site.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, readFileSync, rmSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'

import { parseLogLine, parseNginxTime, clientAddress, isPrivateAddress, splitLines } from '../src/lib/site-metrics/log-parser'
import { classifyUa, isBotUa, isOwnUa, isProbePath, isSpoofedUa, probeKind } from '../src/lib/site-metrics/user-agent'
import { aggregateLines, emptyAgg, mergeAgg, percentileMs, referrerHost, isPageView, isAssetLoad, isRevisit, trimTop, RT_BOUNDS, RULES } from '../src/lib/site-metrics/aggregate'
import { behavesLikeBrowser, newVisit } from '../src/lib/site-metrics/people'
import { ownUserAgent } from '../src/lib/own-user-agent'
import { plainAddress, envAddresses } from '../src/lib/site-metrics/own-addresses'
import { ownRequestPaths } from '../src/lib/site-metrics/own-paths'
import { realHealthDeps } from '../src/lib/site-metrics/health'
import { createServer } from 'node:http'
import { visitorHash, saltDayAllowed, makeSalt } from '../src/lib/site-metrics/visitors'
import { safeLogPath, safeWordPressPath, safeNginxConfPath, shq } from '../src/lib/site-metrics/paths'
import { readLogScript, parseReadOutput } from '../src/lib/site-metrics/read-script'
import { MemoryMetricsStore, DEFAULT_ALERTS, emptyHealth } from '../src/lib/site-metrics/store'
import { alertInputs, collectSite, countLines, defaultState, kindOf, pullLog, type CollectorDeps } from '../src/lib/site-metrics/collector'
import { evaluate, announce, scannerBurst } from '../src/lib/site-metrics/alerts'
import { inspectScript, parseInspect, planLogFormat, applyScript, parseApply, FORMAT_NAME, INCLUDE_FILE } from '../src/lib/site-metrics/log-format'
import { parseWordPressOutput, sanitizeErrorLine, wordpressScript } from '../src/lib/site-metrics/wordpress'
import { summary, detail, exposition } from '../src/lib/site-metrics/view'
import { buildSiteMetricsRoutes, checkAdoptInput, parseAdoptProbe, adoptProbeScript } from '../src/routes/site-metrics'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { STATIC_SITE_SCRIPT, WORDPRESS_SCRIPT } from '../src/lib/catalogue'
import type { SiteRecord } from '../src/lib/sites'

const T = '[11/Nov/2026:10:15:00 +0000]'
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
const combined = (ip: string, path: string, status = 200, ua = CHROME, ref = '-', time = T) => `${ip} - - ${time} "GET ${path} HTTP/1.1" ${status} 512 "${ref}" "${ua}"`
const extended = (ip: string, path: string, rt: string, xff = '-', status = 200, ua = CHROME) => `${ip} - - ${T} "GET ${path} HTTP/1.1" ${status} 100 "-" "${ua}" ${rt} "${xff}"`

const SITE: SiteRecord = { id: 's1', recipeId: 'static-site', name: 'Docs', vmid: 901, node: 'pve1', ip: '10.0.0.9', domain: 'www.example.com', url: 'https://www.example.com', jobId: 'j', owner: 'a@example.com', createdAt: 0 }

// ── parser ───────────────────────────────────────────────────────────────

test('parser: common, combined, extended and nginx "main" lines are read, with the query string dropped', () => {
  const c = parseLogLine('198.51.100.7 - - [11/Nov/2026:10:15:00 +0100] "GET /a?token=secret HTTP/1.1" 200 1234')!
  assert.equal(c.format, 'common'); assert.equal(c.path, '/a'); assert.equal(c.bytes, 1234); assert.equal(c.ua, '')
  assert.equal(c.time.toISOString(), '2026-11-11T09:15:00.000Z')
  const b = parseLogLine(combined('198.51.100.7', '/x?q=1', 404, CHROME, 'https://news.example.org/item'))!
  assert.equal(b.format, 'combined'); assert.equal(b.status, 404); assert.equal(b.referer, 'https://news.example.org/item'); assert.equal(b.requestTime, null)
  const e = parseLogLine(extended('198.51.100.7', '/', '0.042'))!
  assert.equal(e.format, 'extended'); assert.equal(e.requestTime, 0.042)
  const main = parseLogLine(`${combined('198.51.100.7', '/')} "-"`)!
  assert.equal(main.format, 'combined', 'nginx main = combined + X-Forwarded-For, no request time')
  const dash = parseLogLine(`198.51.100.7 - - ${T} "-" 400 0 "-" "-"`)!
  assert.equal(dash.method, ''); assert.equal(dash.path, '')
  const abs = parseLogLine(`198.51.100.7 - - ${T} "GET http://other.example.net/p?x HTTP/1.1" 200 1 "-" "-"`)!
  assert.equal(abs.path, '/p')
})

test('parser: malformed lines are refused, not guessed', () => {
  for (const l of ['', 'garbage', '198.51.100.7 - - [bad time] "GET / HTTP/1.1" 200 1', `198.51.100.7 - - ${T} "GET / HTTP/1.1" 2000 1`,
    `198.51.100.7 - - ${T} "GET / HTTP/1.1" 200 1 "only-one-quoted"`, `198.51.100.7 - - ${T} "GET / HTTP/1.1" 200 1 "a" "b" trailing junk`]) {
    assert.equal(parseLogLine(l), null, l)
  }
  assert.equal(parseNginxTime('31/Foo/2026:10:00:00 +0000'), null)
})

test('parser: X-Forwarded-For is believed only from a private proxy, and its last public entry wins', () => {
  assert.equal(clientAddress('10.0.0.2', '198.51.100.9'), '198.51.100.9')
  assert.equal(clientAddress('10.0.0.2', '203.0.113.66, 198.51.100.9'), '198.51.100.9', 'a visitor cannot choose the first entry')
  assert.equal(clientAddress('10.0.0.2', '198.51.100.9, 10.0.0.3'), '198.51.100.9')
  assert.equal(clientAddress('198.51.100.1', '203.0.113.66'), '198.51.100.1', 'a public remote is the visitor; its header is ignored')
  assert.equal(clientAddress('10.0.0.2', '-'), '10.0.0.2')
  assert.ok(isPrivateAddress('172.16.1.1') && isPrivateAddress('::ffff:10.1.2.3') && isPrivateAddress('fd00::1') && isPrivateAddress('100.100.0.1') && !isPrivateAddress('198.51.100.1'))
  assert.equal(parseLogLine(extended('10.0.0.2', '/', '0.010', '198.51.100.9'))!.client, '198.51.100.9')
})

test('splitLines keeps an unfinished last line for the next read', () => {
  const r = splitLines(Buffer.from('one\ntwo\nthr'))
  assert.deepEqual(r.lines, ['one', 'two']); assert.equal(r.consumed, 8)
  assert.deepEqual(splitLines(Buffer.from('one\ntwo'), true).lines, ['one', 'two'])
  assert.equal(splitLines(Buffer.from('no newline')).consumed, 0)
})

// ── User-Agent and bots ──────────────────────────────────────────────────

test('UA: browser, OS and device from common User-Agents', () => {
  assert.deepEqual(classifyUa(CHROME), { browser: 'Chrome', os: 'Windows', device: 'desktop', bot: false })
  assert.deepEqual(classifyUa(IPHONE), { browser: 'Safari', os: 'iOS', device: 'mobile', bot: false })
  assert.equal(classifyUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:139.0) Gecko/20100101 Firefox/139.0').browser, 'Firefox')
  assert.equal(classifyUa(`${CHROME} Edg/142.0.0.0`).browser, 'Edge')
  assert.equal(classifyUa('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36').device, 'tablet')
  assert.equal(classifyUa('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36').device, 'mobile')
  assert.equal(classifyUa('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0').os, 'Linux')
  assert.equal(classifyUa('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1').os, 'iPadOS')
})

test('bots: known names, libraries, empty and too-short User-Agents, and scanner paths', () => {
  for (const ua of ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)', 'curl/8.14.1',
    'python-requests/2.32.3', 'Mozilla/5.0', '', '-', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (l9scan/2.0.0; +https://leakix.net)', 'Mozilla/5.0 (personal certificate monitor)']) assert.ok(isBotUa(ua), ua)
  assert.ok(!isBotUa(CHROME) && !isBotUa(IPHONE))
  for (const p of ['/.env', '/.git/config', '/wp-config.php', '/actuator/env', '/server-status', '/vendor/phpunit/x', '/@vite/env']) assert.ok(isProbePath(p), p)
  for (const p of ['/', '/about', '/.well-known/acme-challenge/x', '/img/a.png']) assert.ok(!isProbePath(p), p)
})

test('bots: security crawlers, HTTP clients and the fake User-Agents scanners copy; Chrome on Android is not one', () => {
  for (const ua of ['AgentTrustBot/1.0 (id=000000000000; +https://agenttru.st/crawler)', 'AgentDataBot/1.0 (+https://agentdata.run/bot)',
    'node', 'node-fetch/1.0', 'Go-http-client/2.0', 'python-requests/2.32.3', 'curl/8.14.1', 'Mozilla/5.0 (compatible; Databot)',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1',
    'Mozilla/5.062334851 Mozilla/5.0 (Windows NT 6.3; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_9_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/33.0.1750.152 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'http://example.com/wp-admin/install.php?step=1']) assert.ok(isBotUa(ua), ua)
  const ANDROID_REDUCED = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'
  assert.ok(!isBotUa(ANDROID_REDUCED) && !isSpoofedUa(ANDROID_REDUCED), 'every current Chrome on Android says "Android 10; K"')
  assert.ok(!isSpoofedUa(CHROME) && !isSpoofedUa(IPHONE))
  // HyperProx's own, and only when it starts the User-Agent.
  assert.ok(isOwnUa('HyperProx-catalogue-detect') && isOwnUa(ownUserAgent('site-check')) && isOwnUa('HyperProx'))
  assert.ok(!isOwnUa(`${CHROME} HyperProx`) && !isOwnUa('HyperProxy/1.0'))
})

test('probes: kinds, and the guesses that depend on what the site is', () => {
  assert.equal(probeKind('/.env', 'static'), 'secrets'); assert.equal(probeKind('/.git/config'), 'secrets'); assert.equal(probeKind('/.vscode/sftp.json'), 'secrets')
  assert.equal(probeKind('/backup.sql'), 'secrets'); assert.equal(probeKind('/@vite/env'), 'secrets')
  assert.equal(probeKind('/info.php', 'wordpress'), 'php'); assert.equal(probeKind('/vendor/phpunit/src/x.php'), 'php')
  assert.equal(probeKind('/phpmyadmin/'), 'admin'); assert.equal(probeKind('/actuator/env'), 'admin'); assert.equal(probeKind('/cgi-bin/luci'), 'admin')
  assert.equal(probeKind('/___proxy_subdomain_whm/login'), 'admin'); assert.equal(probeKind('/trace.axd'), 'other')
  // On a static site: WordPress, PHP, an API and an admin page are probes; elsewhere they may be the site.
  assert.equal(probeKind('/wp-admin/', 'static', 404), 'admin'); assert.equal(probeKind('/wp-login.php', 'wordpress', 200), null)
  assert.equal(probeKind('/index.php', 'static', 200), 'php', 'a static site has no PHP, whatever a catch-all answered')
  assert.equal(probeKind('/api/session', 'static', 404), 'api'); assert.equal(probeKind('/api/session', 'static', 200), null, 'it has an /api/ after all')
  assert.equal(probeKind('/api/session', 'other', 404), null); assert.equal(probeKind('/admin/', 'static', 404), 'admin')
  assert.equal(probeKind('/config.json', 'static', 404), 'secrets'); assert.equal(probeKind('/config.json', 'static', 200), null, 'an app\'s own settings file')
  for (const p of ['/', '/about', '/img/a.png', '/.well-known/acme-challenge/x', '/.well-known/agent.json', '/docs/v2/install']) assert.equal(probeKind(p, 'static', 404), null, p)
  assert.equal(probeKind('/.well-known/security.txt'), 'other')
  assert.ok(isAssetLoad({ method: 'GET', status: 304, path: '/app.css' }), 'a 304 is a cached copy being used')
  assert.ok(!isAssetLoad({ method: 'GET', status: 200, path: '/favicon.ico' }), 'bots fetch favicons too')
  assert.ok(!isAssetLoad({ method: 'GET', status: 404, path: '/a.png' }))
  assert.ok(isRevisit({ method: 'GET', status: 304, path: '/' }) && !isRevisit({ method: 'GET', status: 304, path: '/a.js' }))
})

// ── aggregation ──────────────────────────────────────────────────────────

const noHash = { visitorHash: (_d: string, c: string, u: string) => `${c}|${u}` }

test('aggregation: people behave like browsers; page views, assets, statuses, referrers, broken links and bots', () => {
  const lines = [
    combined('198.51.100.1', '/', 200, CHROME, 'https://www.search.example/q?secret=1'),
    combined('198.51.100.1', '/style.css'),
    combined('198.51.100.1', '/about', 200, CHROME, 'https://www.example.com/'),
    combined('198.51.100.1', '/old-page', 404),
    combined('198.51.100.2', '/missing', 404, IPHONE),
    combined('198.51.100.2', '/', 304, IPHONE),
    combined('198.51.100.3', '/', 500),
    combined('198.51.100.4', '/', 200, IPHONE),
    combined('203.0.113.9', '/.env', 404, CHROME),
    combined('203.0.113.9', '/', 200, CHROME),
    combined('203.0.113.10', '/', 200, 'curl/8.0'),
  ].map(l => parseLogLine(l)!)
  const r = aggregateLines(lines, { ...noHash, ownHosts: ['www.example.com'], kind: 'static' })
  assert.equal(r.hours.size, 1)
  const a = [...r.hours.values()][0].agg
  assert.equal(a.requests, 11); assert.equal(a.bots, 3, 'the .env prober and curl are bots, and all the prober\'s requests are')
  assert.equal(a.human, 4, 'only the visitor who opened pages and fetched their stylesheet')
  assert.equal(a.unconfirmedReq, 4, 'a page view without assets, a 304 with no earlier page, a 500')
  assert.equal(a.visitors, 1); assert.equal(a.unconfirmed, 2, 'opened a page, never loaded anything else'); assert.equal(a.botVisitors, 2)
  assert.equal(a.pageViews, 2, '/ and /about by the person; not CSS, the unconfirmed or the bots')
  assert.equal(a.unconfirmedPageViews, 2)
  assert.deepEqual(a.pages, { '/': 1, '/about': 1 })
  assert.deepEqual(a.referrers, { 'search.example': 1 })
  assert.deepEqual(a.notFound, { '/old-page': 1 }, 'broken links are people\'s 404s only')
  assert.deepEqual(a.probes, { secrets: 1, 'secrets:refused': 1 })
  assert.deepEqual([a.s2xx, a.s3xx, a.s4xx, a.s5xx], [6, 1, 3, 1])
  assert.equal(a.bytes, 11 * 512)
  assert.deepEqual(a.browsers, { Chrome: 1 }, 'devices and browsers are people\'s')
  assert.equal(a.rules, RULES)
  assert.equal(JSON.stringify(a).includes('198.51.100'), false, 'no address in the counts')
})

test('aggregation: robots.txt and .php on a static site mark a visitor as a bot; WordPress .php is a page', () => {
  const lines = [combined('198.51.100.1', '/robots.txt'), combined('198.51.100.1', '/'), combined('198.51.100.2', '/index.php')].map(l => parseLogLine(l)!)
  assert.equal([...aggregateLines(lines, { ...noHash, kind: 'static' }).hours.values()][0].agg.bots, 3)
  const wp = [...aggregateLines([combined('198.51.100.2', '/index.php'), combined('198.51.100.2', '/wp-content/themes/t/style.css')].map(l => parseLogLine(l)!), { ...noHash, kind: 'wordpress' }).hours.values()][0].agg
  assert.equal(wp.pageViews, 1); assert.equal(wp.bots, 0)
  assert.ok(isPageView({ method: 'GET', status: 200, path: '/blog/post/' }))
  assert.ok(!isPageView({ method: 'POST', status: 200, path: '/' }))
  assert.ok(!isPageView({ method: 'GET', status: 200, path: '/wp-json/wp/v2/posts' }))
})

test('aggregation: lines split across hours, request-time percentiles, merges add up', () => {
  const lines = [extended('198.51.100.1', '/', '0.004'), extended('198.51.100.1', '/', '0.040'), extended('198.51.100.1', '/', '0.300'),
    extended('198.51.100.1', '/', '2.000'), combined('198.51.100.1', '/logo.png'), combined('198.51.100.1', '/', 200, CHROME, '-', '[11/Nov/2026:11:00:01 +0000]')].map(l => parseLogLine(l)!)
  const r = aggregateLines(lines, noHash)
  assert.equal(r.hours.size, 2)
  const a = r.hours.get(Date.parse('2026-11-11T10:00:00Z'))!.agg
  assert.equal(a.timed, 4)
  assert.equal(percentileMs(emptyAgg().rtHist, 0.5), null)
  const p95 = percentileMs(a.rtHist, 0.95)!
  assert.ok(p95 > 1000 && p95 <= 2500, String(p95))
  const p50 = percentileMs(a.rtHist, 0.5)!
  assert.ok(p50 > 25 && p50 <= 50, String(p50))
  const m = mergeAgg(a, a)
  assert.equal(m.requests, 10); assert.equal(m.rtHist.reduce((x, y) => x + y, 0), 8); assert.equal(m.pages['/'], 8)
  assert.equal(r.hours.get(Date.parse('2026-11-11T11:00:00Z'))!.agg.visitors, 1, 'confirmed at 10:00, still a person at 11:00 the same day')
  assert.equal(r.hours.get(Date.parse('2026-11-11T11:00:00Z'))!.agg.timed, 0, 'a combined line has no time')
  assert.equal(a.rtHist.length, RT_BOUNDS.length + 1)
})

test('top lists are trimmed deterministically', () => {
  assert.deepEqual(trimTop({ b: 2, a: 2, c: 5, d: 1 }, 3), { c: 5, a: 2, b: 2 })
  assert.equal(referrerHost('not a url'), null)
  assert.equal(referrerHost('https://WWW.Other.example/x'), 'other.example')
})

// ── hashing and salts ────────────────────────────────────────────────────

test('visitors: the hash depends on salt, site, address and UA; salts are random; old days get no new salt', () => {
  const s1 = makeSalt(), s2 = makeSalt()
  assert.notEqual(s1, s2); assert.equal(Buffer.from(s1, 'base64').length, 32)
  const h = visitorHash(s1, 'site', '198.51.100.1', CHROME)
  assert.match(h, /^[0-9a-f]{32}$/)
  assert.equal(h, visitorHash(s1, 'site', '198.51.100.1', CHROME))
  assert.notEqual(h, visitorHash(s2, 'site', '198.51.100.1', CHROME), 'a new day\'s salt makes a different visitor')
  assert.notEqual(h, visitorHash(s1, 'other', '198.51.100.1', CHROME), 'two sites cannot be linked')
  assert.notEqual(h, visitorHash(s1, 'site', '198.51.100.2', CHROME))
  assert.ok(!h.includes('198'))
  const now = new Date('2026-11-11T08:00:00Z')
  assert.ok(saltDayAllowed('2026-11-11', now)); assert.ok(saltDayAllowed('2026-11-10', now))
  assert.ok(!saltDayAllowed('2026-11-09', now)); assert.ok(!saltDayAllowed('2026-11-12', now)); assert.ok(!saltDayAllowed('nope', now))
})

test('retention: hours 30 days, days 13 months, visitor hashes and salts two days', async () => {
  const st = new MemoryMetricsStore()
  const now = new Date('2026-11-11T12:00:00Z')
  const at = (days: number) => new Date(now.getTime() - days * 86_400_000)
  for (const d of [0, 29, 31, 399, 401]) await st.merge('s', new Date(Math.floor(at(d).getTime() / 3_600_000) * 3_600_000), { ...emptyAgg(), requests: 1 })
  const v = newVisit({ browser: 'Chrome', os: 'Windows', device: 'desktop' })
  await st.putVisitorRows('s', [{ hour: new Date('2026-11-11T10:00:00Z'), hash: 'a', data: v }, { hour: new Date('2026-11-10T10:00:00Z'), hash: 'b', data: v },
    { hour: new Date('2026-11-09T10:00:00Z'), hash: 'c', data: v }])
  for (const d of ['2026-11-11', '2026-11-10', '2026-11-09']) await st.salt(d, () => makeSalt())
  const r = await st.prune(now)
  assert.equal(r.hours, 3, '31, 399 and 401 days old: hourly rows past 30 days')
  assert.equal(r.days, 1, 'only the 401-day-old daily row')
  assert.equal(r.visitors, 1); assert.equal(r.salts, 1)
  assert.deepEqual([...st.salts.keys()].sort(), ['2026-11-10', '2026-11-11'])
  assert.equal(await st.salt('2026-11-09', () => null), null, 'a deleted salt is never recreated')
})

// ── paths ────────────────────────────────────────────────────────────────

test('paths: logs under /var/log (LiteSpeed\'s places: site-metrics-litespeed.test.ts), absolute, no "..", no odd characters', () => {
  assert.equal(safeLogPath('/var/log/nginx/access.log'), '/var/log/nginx/access.log')
  for (const p of ['/var/log/../etc/shadow', 'var/log/x', '/etc/passwd', "/var/log/a'b", '/var/log/a b', '/var/log/nginx//x', '/var/log/', '/var/log/x;rm', '/var/log/$(id)', 42, null, '/var/log/./x'])
    assert.equal(safeLogPath(p), null, String(p))
  assert.equal(safeWordPressPath('/var/www/wordpress'), '/var/www/wordpress')
  assert.equal(safeWordPressPath('/srv/site'), '/srv/site')
  assert.equal(safeWordPressPath('/root/wp'), null)
  assert.equal(safeNginxConfPath('/etc/nginx/nginx.conf'), '/etc/nginx/nginx.conf')
  assert.equal(safeNginxConfPath('/etc/nginx/../shadow'), null)
  assert.equal(shq("a'b"), `'a'\\''b'`)
  assert.throws(() => readLogScript('/var/log/../x', { inode: '0', offset: 0 }), /Refused/)
  assert.throws(() => wordpressScript('/root'), /Refused/)
})

// ── the real read script, on real files ──────────────────────────────────

function bashRun(script: string) {
  const r = spawnSync('bash', [], { input: script, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status, output: r.stdout }
}

/** A collector whose "container" is this machine: the read script runs in bash against a temporary folder under /var/log is not
 *  possible here, so the test rewrites only the path check by pointing a symlink-free folder through LOG=. */
function localDeps(store: MemoryMetricsStore, logFile: string, now = new Date('2026-11-11T10:30:00Z')): CollectorDeps {
  return {
    sites: async () => [SITE], store, unlocked: () => true, now: () => now, log: () => {},
    // HyperProx's own address in the fixtures: its catalogue detection comes from 10.0.0.51.
    ownAddresses: async () => new Set(['10.0.0.51']),
    publish: async () => {},
    health: { fetch: async () => ({ status: 200, body: 'ok' }), tls: async () => ({ notAfter: null, issuer: null, trusted: null, error: null }), now: () => now.getTime() },
    // The script is generated for /var/log/test/access.log; the test swaps that one quoted value for the temp file.
    run: async (_s, script) => bashRun(script.replace(`LOG='/var/log/test/access.log'`, `LOG='${logFile}'`)),
  }
}

test('read script: reads from the cursor, keeps an unfinished line, follows logrotate (create + .1) and copytruncate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hpx-sm-'))
  try {
    const log = join(dir, 'access.log')
    writeFileSync(log, combined('198.51.100.1', '/one') + '\n' + combined('198.51.100.1', '/two') + '\n' + combined('198.51.100.1', '/thr').slice(0, 20))
    const store = new MemoryMetricsStore()
    const d = localDeps(store, log)
    const st = { ...defaultState(SITE), logPath: '/var/log/test/access.log' }
    assert.equal(await pullLog(SITE, st, d), 2)
    const firstOffset = st.offset
    // The rest of the third line arrives, plus one more, then logrotate moves the file and starts a new one.
    appendFileSync(log, combined('198.51.100.1', '/thr').slice(20) + '\n' + combined('198.51.100.1', '/four') + '\n')
    renameSync(log, `${log}.1`)
    writeFileSync(log, combined('198.51.100.1', '/five') + '\n')
    assert.equal(await pullLog(SITE, st, d), 3, 'the rest of .1 (thr, four), then the new file (five)')
    assert.ok(st.offset < firstOffset, 'the cursor is now in the new file')
    // Nothing new: nothing counted.
    assert.equal(await pullLog(SITE, st, d), 0)
    // copytruncate: same file, cut to zero, then written again.
    truncateSync(log, 0)
    appendFileSync(log, combined('198.51.100.1', '/six') + '\n')
    assert.equal(await pullLog(SITE, st, d), 1)
    // Rotated and compressed at once: the old inode is gone, which is a gap, and the new file is read from 0.
    appendFileSync(log, combined('198.51.100.1', '/lost') + '\n')
    renameSync(log, `${log}.1.gz`)
    writeFileSync(log, combined('198.51.100.1', '/seven') + '\n')
    assert.equal(await pullLog(SITE, st, d), 1)
    assert.equal(st.gaps, 1)
    const day = (await store.days('s1', new Date('2026-11-11T00:00:00Z'), new Date('2026-11-12T00:00:00Z')))[0].agg
    // Every line read once: seven page views, from one visitor who never fetched an asset, so not confirmed as a person.
    assert.equal(day.requests, 7)
    assert.equal(day.unconfirmedPageViews, 7); assert.equal(day.pageViews, 0)
    assert.equal(day.unconfirmed, 1); assert.equal(day.visitors, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('read script: a missing log is reported, not an error; a broken answer never moves the cursor', async () => {
  const r = bashRun(readLogScript('/var/log/hpx-does-not-exist-here.log', { inode: '0', offset: 0 }))
  assert.equal(parseReadOutput(r.output).missing, true)
  assert.throws(() => parseReadOutput('HPXM1 section current 1 2 0\nnot base64!!\n'), /base64|finish/)
  assert.throws(() => parseReadOutput('half an answer'), /did not finish/)
  const script = readLogScript('/var/log/nginx/access.log', { inode: '12;rm -rf /', offset: -5 })
  assert.match(script, /^OLD=0$/m); assert.match(script, /^OFF=0$/m)
  assert.match(script, /^LOG='\/var\/log\/nginx\/access\.log'$/m)
})

// ── collector, health and alerts ─────────────────────────────────────────

test('collector: checks the public address and counts the check; nothing is read while locked', async () => {
  const store = new MemoryMetricsStore()
  let ran = 0
  const now = new Date('2026-11-11T10:30:00Z')
  const d: CollectorDeps = { ...localDeps(store, '/nonexistent'), unlocked: () => false, run: async () => { ran++; return { code: 0, output: '' } },
    health: { fetch: async () => null, tls: async () => ({ notAfter: now.getTime() + 5 * 86_400_000, issuer: 'Example CA', trusted: true, error: null }), now: () => now.getTime() } }
  const st = await collectSite(SITE, d)
  assert.equal(ran, 0)
  assert.equal(st.health.lastOk, false); assert.equal(st.health.failsInRow, 1)
  assert.equal(st.health.cert?.issuer, 'Example CA')
  const h = (await store.hours('s1', new Date('2026-11-11T10:00:00Z'), new Date('2026-11-11T11:00:00Z')))[0].agg
  assert.equal(h.checks, 1); assert.equal(h.checksOk, 0)
  assert.equal(kindOf({ ...SITE, recipeId: 'adopted-wordpress' }), 'wordpress')
})

test('alerts: down, 5xx rate, certificate and spike fire once and resolve once', async () => {
  const st = defaultState(SITE)
  const now = Date.parse('2026-11-11T10:30:00Z')
  st.health = { ...emptyHealth(), failsInRow: 2, lastProblem: 'did not answer', cert: { checkedAt: now, notAfter: now + 3 * 86_400_000, issuer: null, trusted: true, error: null } }
  const busy = { ...emptyAgg(), requests: 1200, human: 1200, s5xx: 120 }
  const fired = evaluate(st, { recent: busy, lastHour: busy, usualPerHour: 50, now })
  assert.deepEqual(Object.keys(fired).sort(), ['cert', 'down', 'errors', 'spike'])
  assert.match(fired.errors!, /10\.0%/)
  assert.deepEqual(evaluate(st, { recent: { ...emptyAgg(), requests: 10, s5xx: 10 }, lastHour: null, usualPerHour: null, now }).errors, undefined, 'too few requests to judge')
  assert.deepEqual(evaluate({ ...st, alerts: { ...DEFAULT_ALERTS, enabled: false } }, { recent: busy, lastHour: busy, usualPerHour: 50, now }), {})
  const sent: any[] = []
  st.alertState = await announce(SITE, st, fired, async e => { sent.push(e) }, now)
  assert.equal(sent.length, 4)
  assert.ok(sent.every(e => e.type === 'alert.firing' && e.fingerprint.startsWith('site:s1:')))
  assert.equal(sent.find(e => e.fingerprint.endsWith(':down')).severity, 'critical')
  st.alertState = await announce(SITE, st, fired, async e => { sent.push(e) }, now + 60_000)
  assert.equal(sent.length, 4, 'still firing: nothing new')
  st.alertState = await announce(SITE, st, {}, async e => { sent.push(e) }, now + 600_000)
  assert.equal(sent.length, 8)
  assert.ok(sent.slice(4).every(e => e.type === 'alert.resolved' && e.resolved))
  assert.deepEqual(st.alertState, {})
  // A publish that fails is tried again next time.
  st.alertState = await announce(SITE, st, { down: 'x' }, async () => { throw new Error('bus down') }, now)
  assert.deepEqual(st.alertState, {})
})

// ── log_format ───────────────────────────────────────────────────────────

const INSPECT = [
  'HPXF1 file /etc/nginx/nginx.conf ' + 'a'.repeat(64),
  '17:http {',
  '41:\taccess_log /var/log/nginx/access.log;',
  'HPXF1 file /etc/nginx/sites-enabled/site ' + 'b'.repeat(64),
  '9:  access_log /var/log/nginx/access.log buffer=32k;',
  '10:  access_log /var/log/nginx/other.log;',
  'HPXF1 end',
].join('\n')

test('log_format: the plan changes only plain lines for this log, defines the format after "http {", and skips the rest', () => {
  const plan = planLogFormat(parseInspect(INSPECT), '/var/log/nginx/access.log')
  assert.equal(plan.refusal, undefined)
  assert.deepEqual(plan.edits, [{ file: '/etc/nginx/nginx.conf', line: 41, before: '\taccess_log /var/log/nginx/access.log;', after: `\taccess_log /var/log/nginx/access.log ${FORMAT_NAME};` }])
  assert.deepEqual(plan.insert, { file: '/etc/nginx/nginx.conf', afterLine: 17, text: `\tinclude ${INCLUDE_FILE};` })
  assert.equal(plan.skipped.length, 1); assert.match(plan.skipped[0].text, /buffer=32k/)
  assert.match(plan.includeFile!.content, /\$request_time "\$http_x_forwarded_for"';/)
  const s = applyScript(plan)
  assert.match(s, /sha256sum -- '\/etc\/nginx\/nginx\.conf'/)
  assert.match(s, /nginx -t/); assert.match(s, /systemctl reload nginx/); assert.ok(!/restart/.test(s), 'reload, never restart')
  assert.match(s, /restore;/)
  // Found on a test container: Debian's mawk reads "--" as a file name, so awk gets none.
  assert.ok(!/awk [^\n]*' -- /.test(s), 'no "--" for awk')
  // Any failure after the include file is written removes it again.
  assert.match(s, /restore\(\) \{[^\n]*\[ "\$MADE" = 1 \] && rm -f \/etc\/nginx\/hyperprox-metrics-log\.conf/)
  assert.ok(s.indexOf('MADE=1') < s.indexOf("cat > /etc/nginx/hyperprox-metrics-log.conf"), 'marked as made before it is written')
  // A tampered plan cannot inject.
  assert.throws(() => applyScript({ ...plan, edits: [{ ...plan.edits[0], after: 'access_log /var/log/x hyperprox_metrics; include /tmp/evil;' }] }), /Refused/)
  assert.throws(() => applyScript({ ...plan, hashes: { '/etc/passwd': 'a'.repeat(64) } }), /Refused/)
  assert.throws(() => applyScript({ ...plan, insert: { ...plan.insert!, afterLine: 1.5 } }), /Refused/)
})

test('log_format: refusals when nothing is safe to change, or it is already done', () => {
  assert.match(planLogFormat(parseInspect('HPXF1 nonginx\nHPXF1 end'), '/var/log/nginx/access.log').refusal!, /not installed/)
  assert.match(planLogFormat(parseInspect(INSPECT), '/var/log/nginx/none.log').refusal!, /No configuration file/)
  const done = ['HPXF1 defined', 'HPXF1 file /etc/nginx/nginx.conf ' + 'a'.repeat(64), `41:\taccess_log /var/log/nginx/access.log ${FORMAT_NAME};`, 'HPXF1 end'].join('\n')
  assert.equal(planLogFormat(parseInspect(done), '/var/log/nginx/access.log').already, true)
  assert.throws(() => parseInspect('HPXF1 file /etc/nginx/x ' + 'a'.repeat(64)), /did not finish/)
  assert.equal(parseInspect('HPXF1 file /etc/../shadow ' + 'a'.repeat(64) + '\n1:http {\nHPXF1 end').files.length, 0)
  assert.match(inspectScript('/var/log/nginx/access.log'), /nginx -T/)
  assert.deepEqual(parseApply('HPXF1 backup /etc/nginx/nginx.conf.hyperprox-bak-1\nHPXF1 ok\n', 0).ok, true)
  assert.match(parseApply('HPXF1 testfailed\nHPXF1 restored\n', 4).message, /put back/)
  assert.match(parseApply('HPXF1 failed changed /etc/nginx/nginx.conf\n', 3).message, /changed since the preview/)
})

test('recipes: both web recipes log in the hyperprox_metrics format', () => {
  for (const s of [STATIC_SITE_SCRIPT, WORDPRESS_SCRIPT]) {
    assert.match(s, /cat > \/etc\/nginx\/conf\.d\/hyperprox-metrics-log\.conf <<'NGINX'/)
    assert.match(s, /log_format hyperprox_metrics '\$remote_addr .* \$request_time "\$http_x_forwarded_for"';/)
    assert.match(s, /access_log \/var\/log\/nginx\/access\.log hyperprox_metrics;/)
  }
  // The recipe's own format is one the parser reads as extended.
  assert.equal(parseLogLine(extended('10.0.0.2', '/', '0.001', '198.51.100.5'))!.format, 'extended')
})

// ── WordPress ────────────────────────────────────────────────────────────

test('WordPress: versions, updates, PHP-FPM and sanitised PHP errors', () => {
  const out = ['HPXW1 wpcli yes', 'HPXW1 core', '6.9.1', '', 'HPXW1 coreupd', '[{"version":"6.9.2","update_type":"minor"}]',
    'HPXW1 plugins', '[{"name":"akismet","status":"active","version":"5.3","update_version":"5.4","update":"available"},{"name":"hello","status":"inactive","version":"1.7","update_version":"","update":"none"}]',
    'HPXW1 themes', '[{"name":"twentytwentysix","status":"active","version":"1.1","update_version":"1.2","update":"available"}]',
    'HPXW1 php', '8.4', 'HPXW1 fpm', 'php8.4-fpm.service active',
    'HPXW1 errors', '2026/11/11 10:00:00 [error] 123#123: *4 FastCGI sent in stderr: "PHP message: PHP Warning:  Undefined variable $x in /var/www/wordpress/wp-content/plugins/foo/bar.php on line 3" while reading response header from upstream, client: 198.51.100.4, server: _, request: "GET /?mail=a@example.com HTTP/1.1"',
    'HPXW1 end'].join('\n')
  const i = parseWordPressOutput(out, 1)
  assert.equal(i.core, '6.9.1'); assert.equal(i.php, '8.4'); assert.deepEqual(i.fpm, [{ unit: 'php8.4-fpm', active: true }])
  assert.deepEqual(i.updates.map(u => `${u.kind}:${u.name}:${u.available}`), ['core:WordPress:6.9.2', 'plugin:akismet:5.4', 'theme:twentytwentysix:1.2'])
  assert.equal(i.plugins, 2)
  assert.equal(i.errors.length, 1)
  const e = i.errors[0]
  assert.equal(e.level, 'Warning'); assert.equal(e.at, '2026/11/11 10:00:00')
  assert.ok(!/198\.51|a@example|\/var\/www|client:|request:/.test(e.text), e.text)
  assert.match(e.text, /…\/wp-content\/plugins\/foo\/bar\.php|…\/foo\/bar\.php/)
  assert.match(parseWordPressOutput('HPXW1 wpcli no\nHPXW1 php\n8.2\nHPXW1 end', 1).problem!, /WP-CLI is not installed/)
  assert.match(parseWordPressOutput('cut off', 1).problem!, /did not finish/)
  assert.ok(!/198\.51/.test(sanitizeErrorLine('PHP Fatal error: x from 198.51.100.1').text))
  const script = wordpressScript()
  assert.match(script, /--skip-plugins --skip-themes/)
  assert.ok(!/\b(plugin|theme|core|option|db|cache|transient) (install|update|activate|deactivate|delete|set|reset|flush|query|import)\b/.test(script), 'read-only commands only')
})

// ── adopting ─────────────────────────────────────────────────────────────

test('adopt: input is checked, and the probe returns facts, never the log lines', () => {
  assert.deepEqual(checkAdoptInput({ vmid: 426, url: 'https://www.example.com/', kind: 'static' }).input,
    { vmid: 426, url: 'https://www.example.com', logPath: '/var/log/nginx/access.log', kind: 'static', wpPath: null, name: '', errorLog: null, phpBin: null })
  assert.ok(checkAdoptInput({ vmid: 1, url: 'ftp://x', kind: 'x', logPath: '/etc/passwd' }).errors.length >= 4)
  assert.match(checkAdoptInput({ vmid: 500, url: 'https://u:p@www.example.com', kind: 'static' }).errors.join(), /no path or login/)
  assert.equal(checkAdoptInput({ vmid: 500, url: 'https://www.example.com', kind: 'wordpress' }).input!.wpPath, '/var/www/wordpress')
  const script = adoptProbeScript(checkAdoptInput({ vmid: 500, url: 'https://www.example.com', kind: 'wordpress' }).input!)
  assert.match(script, /tail -n 50/); assert.match(script, /wp-load\.php/)
  const sample = [combined('10.0.0.2', '/'), combined('10.0.0.2', '/x')].join('\n') + '\n'
  const f = parseAdoptProbe(`HPXA1 log yes\nHPXA1 readable yes\nHPXA1 tail ${Buffer.from(sample).toString('base64')}\nHPXA1 nginx yes\nHPXA1 end\n`)
  assert.deepEqual(f.sample, { lines: 2, formats: { combined: 2 }, malformed: 0 })
  assert.equal(f.behindProxyWithoutForwardedFor, true)
  assert.ok(!JSON.stringify(f).includes('10.0.0.2'))
})

// ── roles and routes ─────────────────────────────────────────────────────

test('roles: metric reads are open to signed-in roles (trimmed by the route); adopt reads are admin; changes re-confirmed', () => {
  assert.equal(requiredRole('GET', '/api/site-metrics/sites'), 'viewer')
  assert.equal(requiredRole('GET', '/api/site-metrics/sites/s1?range=24h'), 'viewer')
  assert.equal(requiredRole('GET', '/api/site-metrics/adopt/guests'), 'admin')
  for (const [m, p] of [['POST', '/api/site-metrics/adopt'], ['POST', '/api/site-metrics/adopt/check'], ['DELETE', '/api/site-metrics/adopt/a1'],
    ['POST', '/api/site-metrics/sites/s1/log-format/preview'], ['POST', '/api/site-metrics/sites/s1/log-format/apply'], ['PUT', '/api/site-metrics/sites/s1/alerts']] as const)
    assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
  assert.equal(needsReconfirm('POST', '/api/site-metrics/adopt'), true)
  assert.equal(needsReconfirm('DELETE', '/api/site-metrics/adopt/a1'), true)
  assert.equal(needsReconfirm('POST', '/api/site-metrics/sites/s1/log-format/apply'), true)
  assert.equal(needsReconfirm('POST', '/api/site-metrics/sites/s1/log-format/preview'), false)
  assert.equal(needsReconfirm('POST', '/api/site-metrics/adopt/check'), false)
})

async function app(role: string, store = new MemoryMetricsStore(), runs: string[] = []) {
  const f = Fastify()
  f.addHook('onRequest', async (req: any) => { req.session = { role, email: `${role}@example.com` } })
  const sites: SiteRecord[] = [SITE]
  await f.register(buildSiteMetricsRoutes({
    store, sites: async () => sites, site: async id => sites.find(s => s.id === id), record: async s => { sites.push(s) }, forget: async () => {},
    run: async (_s, script) => { runs.push(script); return { code: 0, output: 'HPXA1 log yes\nHPXA1 readable yes\nHPXA1 nginx yes\nHPXA1 end\n' } },
    container: async () => ({ status: 'running', cpuPct: 3, cores: 1, memPct: 20, memUsed: 1, memMax: 5, diskPct: 10, diskUsed: 1, diskMax: 10, uptimeS: 60, netIn7d: 1, netOut7d: 2 }),
    guests: async () => [{ vmid: 901, name: 'docs', node: 'pve1', status: 'running', type: 'lxc' }, { vmid: 902, name: 'blog', node: 'pve1', status: 'running', type: 'lxc' }],
    guestIp: async () => '10.0.0.12', audit: async () => {}, now: () => new Date('2026-11-11T10:30:00Z'),
  }), { prefix: '/api/site-metrics' })
  return f
}

test('routes: a viewer gets totals only; an operator gets pages, referrers and 404s; no address ever', async () => {
  const store = new MemoryMetricsStore()
  await store.merge('s1', new Date('2026-11-11T10:00:00Z'), { ...emptyAgg(), requests: 5, human: 5, pageViews: 3, pages: { '/secret-page': 3 }, referrers: { 'search.example': 2 }, notFound: { '/old': 1 } })
  const v = await (await app('viewer', store)).inject({ url: '/api/site-metrics/sites/s1?range=24h' })
  assert.equal(v.statusCode, 200)
  const vb = v.json().data
  assert.equal(vb.hud.pageViews, 3)
  assert.equal(vb.pages, undefined); assert.equal(vb.referrers, undefined); assert.equal(vb.notFound, undefined); assert.equal(vb.where, undefined)
  assert.ok(!v.body.includes('/secret-page'))
  const o = (await (await app('operator', store)).inject({ url: '/api/site-metrics/sites/s1?range=24h' })).json().data
  assert.deepEqual(o.pages, [{ key: '/secret-page', value: 3 }]); assert.deepEqual(o.referrers, [{ key: 'search.example', value: 2 }])
  assert.equal(o.series.length, 24)
  const list = await (await app('viewer', store)).inject({ url: '/api/site-metrics/sites' })
  assert.equal(list.json().data.sites[0].spark.length, 24)
  for (const r of [v, list]) assert.ok(!/10\.0\.0\.9|198\.51/.test(r.body))
})

test('routes: adopt and log-format need admin in the route too; adopt records a read-only site', async () => {
  for (const role of ['viewer', 'operator']) {
    const a = await app(role)
    assert.equal((await a.inject({ url: '/api/site-metrics/adopt/guests' })).statusCode, 403)
    assert.equal((await a.inject({ method: 'POST', url: '/api/site-metrics/adopt', payload: {} })).statusCode, 403)
    assert.equal((await a.inject({ method: 'POST', url: '/api/site-metrics/sites/s1/log-format/apply', payload: {} })).statusCode, 403)
  }
  const store = new MemoryMetricsStore(), runs: string[] = []
  const a = await app('admin', store, runs)
  const g = (await a.inject({ url: '/api/site-metrics/adopt/guests' })).json().data.guests
  assert.deepEqual(g.map((x: any) => x.vmid), [902], 'a container that is already a site is not offered')
  const bad = await a.inject({ method: 'POST', url: '/api/site-metrics/adopt', payload: { vmid: 902, url: 'https://blog.example.com', kind: 'static', logPath: '/var/log/../etc/shadow' } })
  assert.equal(bad.statusCode, 400); assert.equal(runs.length, 0, 'a refused path never reaches the container')
  const ok = await a.inject({ method: 'POST', url: '/api/site-metrics/adopt', payload: { vmid: 902, url: 'https://blog.example.com', kind: 'static' } })
  assert.equal(ok.statusCode, 200, ok.body)
  const id = ok.json().data.id
  const st = await store.getState(id)
  assert.equal(st!.adopted, true); assert.equal(st!.logPath, '/var/log/nginx/access.log')
  assert.ok(runs.every(s => !/\b(rm|mv|cp|sed -i|tee|>\s*\/)/.test(s.replace(/2>\/dev\/null|>\/dev\/null/g, ''))), 'the adopt probe only reads')
  assert.equal((await a.inject({ method: 'POST', url: '/api/site-metrics/sites/s1/log-format/apply', payload: { planId: 'nope' } })).statusCode, 409)
  assert.equal((await a.inject({ method: 'DELETE', url: '/api/site-metrics/adopt/s1' })).statusCode, 400, 'a site HyperProx made is not forgotten here')
})

test('views: summary trend, uptime and the Prometheus text carry the site name only', async () => {
  const store = new MemoryMetricsStore()
  const now = new Date('2026-11-11T10:30:00Z')
  await store.merge('s1', new Date('2026-11-11T10:00:00Z'), { ...emptyAgg(), requests: 10, s5xx: 1, checks: 4, checksOk: 3, visitors: 6 })
  await store.merge('s1', new Date('2026-11-10T10:00:00Z'), { ...emptyAgg(), visitors: 3 })
  const st = defaultState(SITE)
  st.health = { ...emptyHealth(), lastOk: true, lastLatencyMs: 120, cert: { checkedAt: 0, notAfter: now.getTime() + 40 * 86_400_000, issuer: null, trusted: true, error: null } }
  const s = await summary(SITE, st, store, now)
  assert.equal(s.trendPct, 100); assert.equal(s.errorRatePct, 10); assert.equal(s.certDays, 40); assert.equal(s.up, true)
  const d = await detail(SITE, st, store, now, '24h', false)
  assert.equal(d.hud.uptimePct, 75)
  const text = exposition([{ name: 'www.example.com', s, today: { ...emptyAgg(), visitors: 6, s2xx: 9, s5xx: 1 } }])
  assert.match(text, /^hyperprox_site_up\{site="www\.example\.com"\} 1$/m)
  assert.match(text, /^hyperprox_site_requests_total\{site="www\.example\.com",class="5xx"\} 1$/m)
  assert.match(text, /^hyperprox_site_cert_days_left\{site="www\.example\.com"\} 40$/m)
  assert.match(text, /^hyperprox_site_visitors_total\{site="www\.example\.com"\} 6$/m)
  assert.equal(exposition([{ name: 'a"b\\c', s, today: emptyAgg() }]).includes('site="a\\"b\\\\c"'), true)
})

// ── people, HyperProx's own requests, probes ─────────────────────────────

const at = (hhmmss: string) => `[11/Nov/2026:${hhmmss} +0000]`

const US = new Set(['10.0.0.51'])

test('people: HyperProx\'s own requests are counted only as such, never as people, bots, 404s or statuses', () => {
  const lines = [
    combined('10.0.0.51', '/api/health', 404, 'HyperProx-catalogue-detect'), combined('10.0.0.51', '/status.php', 404, 'HyperProx-catalogue-detect'),
    combined('10.0.0.51', '/', 200, ownUserAgent('site-check')),
    // The name is public: on anything HyperProx does not ask for, it is a scanner borrowing it.
    combined('203.0.113.7', '/.env', 404, 'HyperProx-catalogue-detect'), combined('203.0.113.7', '/phpmyadmin/', 404, ownUserAgent('site-check')),
    combined('203.0.113.7', '/info.php', 404, 'HyperProx-x/1'), combined('203.0.113.7', '/api/secret', 404, 'HyperProx-x/1'),
  ].map(l => parseLogLine(l)!)
  const a = [...aggregateLines(lines, { ...noHash, kind: 'static', ownPaths: ownRequestPaths(), ownAddresses: US }).hours.values()][0].agg
  assert.equal(a.own, 3)
  assert.equal(a.requests, 4); assert.equal(a.bots, 4); assert.equal(a.s4xx, 4); assert.equal(a.s2xx, 0)
  assert.deepEqual(a.notFound, {})
  assert.deepEqual(a.probes, { secrets: 1, 'secrets:refused': 1, admin: 1, 'admin:refused': 1, php: 1, 'php:refused': 1, api: 1, 'api:refused': 1 })
  // Without the list of HyperProx's own paths, its detection on a static site would look like probes.
  const bare = [...aggregateLines(lines.slice(0, 2), { ...noHash, kind: 'static', ownAddresses: US }).hours.values()][0].agg
  assert.equal(bare.own, 0)
  // Without HyperProx's own addresses, its name alone is believed for nothing.
  const noAddr = [...aggregateLines(lines.slice(0, 3), { ...noHash, kind: 'static', ownPaths: ownRequestPaths() }).hours.values()][0].agg
  assert.equal(noAddr.own, 0)
})

test('people: HyperProx\'s name from another address is a scanner borrowing it, on its own paths too', () => {
  const lines = [
    combined('10.0.0.51', '/login', 302, 'HyperProx-catalogue-detect'),
    combined('203.0.113.9', '/login', 404, 'HyperProx-catalogue-detect'),
    combined('203.0.113.9', '/status.php', 404, 'HyperProx-catalogue-detect'),
    combined('203.0.113.9', '/', 200, ownUserAgent('site-check')),
  ].map(l => parseLogLine(l)!)
  const a = [...aggregateLines(lines, { ...noHash, kind: 'static', ownPaths: ownRequestPaths(), ownAddresses: US }).hours.values()][0].agg
  assert.equal(a.own, 1, 'only the line from HyperProx\'s own address')
  assert.equal(a.requests, 3)
  assert.equal(a.probes.admin, 1, 'the spoofed /login is counted as an admin probe')
  assert.equal(a.bots, 3)
  // ::ffff:-mapped addresses and the WAN address are matched as plain addresses.
  assert.equal(plainAddress('::FFFF:10.0.0.51'), '10.0.0.51')
  assert.deepEqual(envAddresses('203.0.113.4, 2001:db8::1 nope;value'), ['203.0.113.4', '2001:db8::1'])
})

test('own paths: everything HyperProx asks sites for is listed, never a secret, and only three app logins look like admin', () => {
  const paths = ownRequestPaths()
  for (const p of ['/', '/status.php', '/api/health', '/api/tags', '/auth/login', '/wp-login.php', '/alive']) assert.ok(paths.has(p), p)
  for (const p of paths) {
    for (const kind of ['static', 'wordpress', 'other'] as const) {
      const k = probeKind(p, kind, 404)
      assert.notEqual(k, 'secrets', `${p} on ${kind}`)
      // /login: the Arr Stack's detection reads Sonarr's, Radarr's and Prowlarr's sign-in page title (their "/" only redirects).
      if (k === 'admin') assert.ok(['/wp-login.php', '/auth/login', '/login'].includes(p), `${p} on ${kind} is an admin probe`)
    }
  }
})

test('people: an asset within two minutes confirms a page view; later, never, or only a favicon does not', () => {
  const run = (...l: string[]) => [...aggregateLines(l.map(x => parseLogLine(x)!), { ...noHash, kind: 'static' }).hours.values()][0].agg
  assert.equal(run(combined('198.51.100.1', '/', 200, CHROME, '-', at('10:00:00')), combined('198.51.100.1', '/a.png', 200, CHROME, '-', at('10:01:59'))).visitors, 1)
  assert.equal(run(combined('198.51.100.1', '/', 200, CHROME, '-', at('10:00:00')), combined('198.51.100.1', '/a.png', 200, CHROME, '-', at('10:02:01'))).visitors, 0, 'too late')
  assert.equal(run(combined('198.51.100.1', '/', 200, CHROME, '-', at('10:00:00')), combined('198.51.100.1', '/favicon.ico', 200, CHROME, '-', at('10:00:01'))).visitors, 0)
  assert.equal(run(combined('198.51.100.1', '/a.png', 200, CHROME, '-', at('10:00:00'))).visitors, 0, 'assets alone are not a visit')
  // HTTP/2 and caching: the stylesheet answered 304 still shows a browser drawing the page.
  const cached = run(combined('198.51.100.1', '/', 200, CHROME, '-', at('10:00:00')), combined('198.51.100.1', '/app.css', 304, CHROME, '-', at('10:00:00')))
  assert.equal(cached.visitors, 1); assert.equal(cached.pageViews, 1)
  // A revisit answered 304 counts once the visitor has loaded a page that day; on its own it does not.
  const back = run(combined('198.51.100.1', '/', 200, CHROME, '-', at('09:00:00')), combined('198.51.100.1', '/', 304, CHROME, '-', at('10:30:00')))
  assert.equal(back.visitors, 1)
  assert.equal(run(combined('198.51.100.1', '/', 304, CHROME, '-', at('10:30:00'))).visitors, 0)
  assert.ok(behavesLikeBrowser([{ ...newVisit({ browser: 'Chrome', os: 'Windows', device: 'desktop' }), pageAt: [1000], assetAt: [1000 + 120_000] }]))
  // A bot that loads images like a browser is still a bot: the lists apply first.
  const gpt = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)'
  const b = run(combined('198.51.100.9', '/', 200, gpt, '-', at('10:00:00')), combined('198.51.100.9', '/a.png', 200, gpt, '-', at('10:00:02')))
  assert.equal(b.visitors, 0); assert.equal(b.botVisitors, 1); assert.equal(b.bots, 2)
})

test('people: a scanner\'s path makes the visitor a bot for the whole batch, browser-like requests and all', () => {
  const lines = [combined('198.51.100.5', '/', 200, CHROME, '-', at('10:00:00')), combined('198.51.100.5', '/a.png', 200, CHROME, '-', at('10:00:01')),
    combined('198.51.100.5', '/.git/config', 404, CHROME, '-', at('10:00:02'))].map(l => parseLogLine(l)!)
  const a = [...aggregateLines(lines, { ...noHash, kind: 'static' }).hours.values()][0].agg
  assert.equal(a.visitors, 0); assert.equal(a.bots, 3); assert.equal(a.botPageViews, 1)
})

/** Count one read the way the collector does, into `store`. */
async function read(store: MemoryMetricsStore, lines: string[], now = new Date('2026-11-11T10:30:00Z')) {
  const st = defaultState(SITE)
  await countLines(SITE, st, lines, { ...localDeps(store, '/nonexistent', now) })
}
const hourOf = async (store: MemoryMetricsStore, iso: string) => (await store.hours('s1', new Date(iso), new Date(Date.parse(iso) + 3_600_000)))[0]?.agg
const dayOf = async (store: MemoryMetricsStore) => (await store.days('s1', new Date('2026-11-11T00:00:00Z'), new Date('2026-11-12T00:00:00Z')))[0]?.agg

test('collector: a page view in one read and its images in the next still make a person, and the lists follow', async () => {
  const store = new MemoryMetricsStore()
  await read(store, [combined('198.51.100.1', '/guide', 200, CHROME, 'https://news.example.org/x', at('10:04:59'))])
  let h = (await hourOf(store, '2026-11-11T10:00:00Z'))!
  assert.equal(h.visitors, 0); assert.equal(h.unconfirmed, 1); assert.deepEqual(h.pages, {}, 'not listed until confirmed')
  await read(store, [combined('198.51.100.1', '/guide.css', 200, CHROME, '-', at('10:05:01')), combined('198.51.100.1', '/nope', 404, CHROME, '-', at('10:05:02'))])
  h = (await hourOf(store, '2026-11-11T10:00:00Z'))!
  assert.equal(h.visitors, 1); assert.equal(h.unconfirmed, 0); assert.equal(h.human, 3); assert.equal(h.pageViews, 1)
  assert.deepEqual(h.pages, { '/guide': 1 }); assert.deepEqual(h.referrers, { 'news.example.org': 1 }); assert.deepEqual(h.notFound, { '/nope': 1 })
  assert.deepEqual(h.browsers, { Chrome: 1 })
  const d = (await dayOf(store))!
  assert.equal(d.visitors, 1); assert.equal(d.human, 3); assert.deepEqual(d.pages, { '/guide': 1 })
  // A third read of the same person adds to the lists without counting them twice.
  await read(store, [combined('198.51.100.1', '/more', 200, CHROME, '-', at('10:20:00'))])
  h = (await hourOf(store, '2026-11-11T10:00:00Z'))!
  assert.equal(h.visitors, 1); assert.deepEqual(h.pages, { '/guide': 1, '/more': 1 }); assert.deepEqual(h.browsers, { Chrome: 1 })
  assert.equal(JSON.stringify([...store.visitorMap.values()].map(m => [...m.values()])).includes('198.51.100'), false, 'no address kept')
})

test('collector: a confirmed person stays one for the day, however many cached pages they open', async () => {
  const store = new MemoryMetricsStore()
  await read(store, [combined('198.51.100.3', '/', 200, CHROME, '-', at('10:00:00')), combined('198.51.100.3', '/site.css', 200, CHROME, '-', at('10:00:01'))])
  assert.equal((await hourOf(store, '2026-11-11T10:00:00Z'))!.visitors, 1)
  // 18 more pages, assets all from the browser's cache (no requests), over two reads: more than the 16 times kept.
  const pages = Array.from({ length: 18 }, (_, i) => combined('198.51.100.3', `/p${i}`, 200, CHROME, '-', at(`10:${String(6 + i).padStart(2, '0')}:00`)))
  await read(store, pages.slice(0, 9)); await read(store, pages.slice(9))
  const h = (await hourOf(store, '2026-11-11T10:00:00Z'))!
  assert.equal(h.visitors, 1); assert.equal(h.unconfirmed, 0); assert.equal(h.pageViews, 19); assert.equal(h.human, 20)
  assert.equal((await dayOf(store))!.visitors, 1)
})

test('collector: a probe in a later read turns the visitor into a bot for that hour, earlier requests included', async () => {
  const store = new MemoryMetricsStore()
  await read(store, [combined('198.51.100.2', '/', 200, CHROME, '-', at('10:00:00')), combined('198.51.100.2', '/a.png', 200, CHROME, '-', at('10:00:01'))])
  assert.equal((await hourOf(store, '2026-11-11T10:00:00Z'))!.visitors, 1)
  await read(store, [combined('198.51.100.2', '/.env', 404, CHROME, '-', at('10:06:00'))])
  const h = (await hourOf(store, '2026-11-11T10:00:00Z'))!
  assert.equal(h.visitors, 0); assert.equal(h.botVisitors, 1); assert.equal(h.bots, 3); assert.equal(h.human, 0)
  assert.equal((await dayOf(store))!.visitors, 0)
})

test('collector: rows from before the fix stay marked, and the alerts ignore them for "usual"', async () => {
  const store = new MemoryMetricsStore()
  await store.merge('s1', new Date('2026-11-11T09:00:00Z'), { ...emptyAgg(), rules: 1, requests: 50, human: 50, visitors: 29 })
  await read(store, [combined('198.51.100.1', '/', 200, CHROME, '-', at('09:30:00'))])
  assert.equal((await hourOf(store, '2026-11-11T09:00:00Z'))!.rules, 1, 'a row with any part counted the old way stays old')
  await read(store, [combined('198.51.100.1', '/', 200, CHROME, '-', at('10:10:00'))])
  assert.equal((await hourOf(store, '2026-11-11T10:00:00Z'))!.rules, RULES)
  assert.equal((await dayOf(store))!.rules, 1)
  for (let i = 30; i >= 2; i--) await store.merge('s1', new Date(Date.parse('2026-11-11T10:00:00Z') - i * 3_600_000), { ...emptyAgg(), rules: 1, requests: 500, human: 500, bots: 5 })
  assert.equal((await alertInputs(store, 's1', new Date('2026-11-11T10:30:00Z'))).usualPerHour, null, 'old hours are not a "usual"')
  const st = defaultState(SITE)
  const s = await summary(SITE, st, store, new Date('2026-11-11T10:30:00Z'))
  assert.equal(s.countedBeforeFix, true); assert.equal(s.trendPct, null, 'no trend across the two ways of counting')
})

test('alerts: a spike is people\'s traffic; a burst of scanners is a note, never an alert', () => {
  const st = defaultState(SITE)
  const now = Date.parse('2026-11-11T10:30:00Z')
  const scanners = { ...emptyAgg(), requests: 900, bots: 880, human: 20 }
  const i = { recent: scanners, lastHour: scanners, usualPerHour: 10, usualBotsPerHour: 20, now }
  assert.equal(evaluate(st, i).spike, undefined)
  assert.match(scannerBurst(st, i)!, /880 requests from bots and scanners.*44×/)
  const people = { ...emptyAgg(), requests: 500, human: 480, bots: 20 }
  assert.match(evaluate(st, { ...i, recent: people, lastHour: people }).spike!, /480 requests from people/)
  assert.equal(scannerBurst(st, { ...i, recent: people, lastHour: people }), null)
  assert.equal(scannerBurst(st, { ...i, usualBotsPerHour: null }), null, 'no history, no "usual" to burst past')
})

test('security: probes by kind, a 2xx answer flagged as a possible exposure unless it was the home page; paths for operators only', async () => {
  const lines = [
    combined('203.0.113.1', '/', 200), combined('203.0.113.9', '/.env', 404, 'curl/8.0'), combined('203.0.113.9', '/.git/config', 403, 'curl/8.0'),
    `203.0.113.9 - - ${T} "GET /.env.bak HTTP/1.1" 200 77 "-" "curl/8.0"`, combined('203.0.113.9', '/wp-login.php', 200, 'curl/8.0'),
    combined('203.0.113.9', '/api/v1', 404, 'curl/8.0'),
  ].map(l => parseLogLine(l)!)
  const a = [...aggregateLines(lines, { ...noHash, kind: 'static' }).hours.values()][0].agg
  assert.equal(a.probes.secrets, 3); assert.equal(a.probes['secrets:refused'], 2); assert.equal(a.probes['secrets:ok'], 1)
  assert.equal(a.probes.admin, 1); assert.equal(a.probes.api, 1)
  assert.deepEqual(a.exposed, { '/.env.bak': 1 }, 'a different answer from the home page')
  assert.deepEqual(a.catchAll, { '/wp-login.php': 1 }, 'the home page again: a catch-all, nothing given away')
  const later = [...aggregateLines([parseLogLine(combined('203.0.113.9', '/wp-login.php', 200, 'curl/8.0'))!], { ...noHash, kind: 'static', homeSizes: [512] }).hours.values()][0].agg
  assert.deepEqual(later.catchAll, { '/wp-login.php': 1 }, 'the home page\'s size is remembered from earlier reads'); assert.deepEqual(later.exposed, {})
  const store = new MemoryMetricsStore()
  await store.merge('s1', new Date('2026-11-11T10:00:00Z'), a)
  const now = new Date('2026-11-11T10:30:00Z')
  const viewer = await detail(SITE, null, store, now, '24h', false)
  assert.equal(viewer.security.total, 5); assert.equal(viewer.security.exposedCount, 1); assert.equal(viewer.security.exposed, undefined)
  assert.deepEqual(viewer.security.kinds.find(k => k.kind === 'secrets'), { kind: 'secrets', requests: 3, refused: 2, answered: 1, moved: 0, errors: 0 })
  const op = await detail(SITE, null, store, now, '24h', true)
  assert.deepEqual(op.security.exposed, [{ key: '/.env.bak', value: 1 }])
  assert.equal(JSON.stringify(op).includes('203.0.113'), false, 'never an address')
})

test('own User-Agent: the public check says it is HyperProx', async () => {
  let seen = ''
  const srv = createServer((req, res) => { seen = String(req.headers['user-agent']); res.end('ok') })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  try {
    const port = (srv.address() as any).port
    const r = await realHealthDeps().fetch(`http://127.0.0.1:${port}/`)
    assert.equal(r?.status, 200)
    assert.equal(seen, ownUserAgent('site-check')); assert.ok(isOwnUa(seen))
  } finally { srv.close() }
})

// ── a real log, sanitised ────────────────────────────────────────────────

test('fixture: a sanitised access log from a hand-built static site behind a proxy parses completely', () => {
  // 170 lines from a real nginx (combined format), addresses replaced with documentation addresses, the domain
  // with example.com and scanner ids zeroed. Most of its traffic is scanners and crawlers, as a new public site's is.
  const raw = readFileSync(join(__dirname, 'fixtures', 'site-metrics', 'static-site-access.log'), 'utf8').split('\n').filter(Boolean)
  const parsed = raw.map(parseLogLine)
  assert.equal(raw.length, 170)
  assert.equal(parsed.filter(p => !p).length, 0, 'every line parses')
  assert.ok(parsed.every(p => p!.format === 'combined'))
  const r = aggregateLines(parsed as any, { ...noHash, ownHosts: ['example.com'], kind: 'static' })
  const a = [...r.hours.values()].reduce((x, h) => mergeAgg(x, h.agg), emptyAgg())
  assert.equal(a.requests, 170)
  assert.ok(a.bots > a.human, `bots ${a.bots} vs people ${a.human}`)
  assert.equal(a.s4xx, 85)
  assert.ok(!Object.keys(a.notFound).some(p => /\.env|\.git/.test(p)), 'scanner probes are not broken links')
  assert.deepEqual(a.referrers, {}, 'referrers from the site itself are not counted')
  assert.ok(a.probes.secrets > 0 && !a.probes['secrets:ok'], 'secret files asked for, none given')
})

test('fixture: a site\'s launch day, read the way the collector reads it, finds the two real people', async () => {
  // 252 lines from a static site's first three hours in public (combined, then the hyperprox_metrics format):
  // the proxy in front is 10.0.0.x, visitors' own addresses (from X-Forwarded-For, at the end) are 203.0.113.x,
  // the domain is example.com and scanner ids are zeroed. Before the accuracy fix this log gave 29 visitors and
  // 59 requests from "people". Two of its visitors opened the page and loaded its images in a real browser.
  const raw = readFileSync(join(__dirname, 'fixtures', 'site-metrics', 'launch-day-access.log'), 'utf8').split('\n').filter(Boolean)
  assert.equal(raw.length, 252)
  assert.ok(raw.every(l => parseLogLine(l)), 'every line parses')
  const store = new MemoryMetricsStore()
  const st = defaultState(SITE)
  // Five-minute reads, as the collector makes them.
  const reads = new Map<number, string[]>()
  for (const l of raw) { const k = Math.floor(parseLogLine(l)!.time.getTime() / 300_000); reads.set(k, [...(reads.get(k) ?? []), l]) }
  for (const k of [...reads.keys()].sort((x, y) => x - y)) await countLines(SITE, st, reads.get(k)!, { ...localDeps(store, '/nonexistent', new Date((k + 1) * 300_000)) })
  const d = (await dayOf(store))!
  assert.equal(d.own, 33, 'HyperProx\'s own catalogue detection, counted only as that')
  assert.equal(d.requests, 219)
  assert.equal(d.visitors, 2, 'people')
  assert.equal(d.unconfirmed, 14)
  assert.equal(d.botVisitors, 24)
  assert.equal(d.human, 20); assert.equal(d.bots, 176); assert.equal(d.unconfirmedReq, 23)
  assert.equal(d.pageViews, 4)
  assert.deepEqual(d.notFound, { '/favicon.ico': 3 }, 'the one broken link people hit')
  const probes = Object.entries(d.probes).filter(([k]) => !k.includes(':')).reduce((x, [, v]) => x + v, 0)
  assert.equal(probes, 65)
  assert.equal(d.probes.secrets, 24); assert.equal(d.probes['secrets:refused'], 24)
  assert.deepEqual(d.exposed, {}, 'nothing a scanner asked for was given')
  // The same log read in one go gives the same answer.
  const one = [...aggregateLines(raw.map(l => parseLogLine(l)!), { visitorHash: (_d, c, u) => `${c}|${u}`, ownHosts: ['example.com'], kind: 'static', ownPaths: ownRequestPaths(), ownAddresses: new Set(['10.0.0.51']) }).hours.values()]
    .reduce((x, h) => mergeAgg(x, h.agg), emptyAgg())
  assert.deepEqual([one.human, one.bots, one.unconfirmedReq, one.own], [d.human, d.bots, d.unconfirmedReq, d.own])
})
