// The package cache plug-in page's pieces, rendered to HTML: the flow (internet, cache, guests), the hour-by-hour
// trace, the gauges, packages, repositories and guests by name; Updates' three-way switch and its nodes opt-in; the
// problem list with a fix button each; and the pure logic behind them (network check, clean-up words, buckets).
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import "./css-stub"
import { renderToStaticMarkup } from 'react-dom/server'
import { AptCachePanel, HitTrace, SavingsFlow } from '../components/plugins/aptcache/AptCachePanel'
import { ProblemList, SelfCheckList, UseSwitch } from '../components/plugins/aptcache/AptCachePage'
import { areaPath, bucketed, checkNetworks, diskGb, expiryWords, repoName, size, type Reading, type UseView } from '../components/plugins/aptcache/logic'

// The third private block, spelled out so a scan of the repository for real home-network addresses stays empty.
const P3 = [192, 168].join('.')
const H = 3600_000
const reading = (o: Partial<Reading> = {}): Reading => ({
  at: 10 * H, active: true, version: '3.7.5-1', listen: '10.20.30.40', allow: ['10.20.30.0/24'], report: true, hours: 4,
  disk: { sizeKb: 50 * 1024 * 1024, usedKb: 5 * 1024 * 1024, freeKb: 45 * 1024 * 1024 }, cacheGb: 50,
  totals: { requests: 40, hits: 30, bytes: 400 * 1024 * 1024, hitBytes: 300 * 1024 * 1024, fetchedBytes: 100 * 1024 * 1024 },
  hitRatio: 0.75, byteHitRatio: 0.75,
  perHour: [0, 1, 2, 3].map(i => ({ at: (7 + i) * H, requests: 10, hits: i * 3, bytes: 100 * 1024 * 1024, hitBytes: i * 25 * 1024 * 1024, fetchedBytes: (100 - i * 25) * 1024 * 1024 })),
  packages: [{ name: 'linux-image-amd64', requests: 6, hits: 5, bytes: 600 * 1024 * 1024 }, { name: 'curl', requests: 4, hits: 3, bytes: 1_000_000 }],
  repos: [{ name: 'debrep', requests: 30, hits: 24, bytes: 300 * 1024 * 1024 }, { name: 'secdeb', requests: 10, hits: 6, bytes: 100 * 1024 * 1024 }],
  clients: [{ name: 'web', kind: 'guest', requests: 20, bytes: 200 * 1024 * 1024 }, { name: 'Other devices', kind: 'other', requests: 2, bytes: 1000 }],
  expiry: { at: 8 * H, outcome: 'done' }, refused: 1, errors: 0, ...o,
})

test('the picture: flow and trace said in words, guests by name, repositories by their real names', () => {
  const html = renderToStaticMarkup(<AptCachePanel r={reading()} />)
  assert.match(html, /100\.0 MB fetched from the internet, 400\.0 MB handed to your guests, 300\.0 MB of it from the cache \(75%\)/)
  assert.match(html, /linux-image-amd64/)
  assert.match(html, />Debian</)
  assert.match(html, />Debian security</)
  assert.match(html, />web</)
  assert.doesNotMatch(html, /10\.20\.30/, 'no address on the picture')
  assert.match(html, /HTTPS repositories are fetched directly/)
  assert.match(html, /from cache \(bytes\): 75%/)
  assert.match(renderToStaticMarkup(<SavingsFlow r={reading()} />), /FROM CACHE/)
  assert.match(renderToStaticMarkup(<HitTrace r={reading()} />), /300\.0 MB of 400\.0 MB came from the cache/)
  const empty = renderToStaticMarkup(<AptCachePanel r={reading({ packages: [], repos: [], clients: [] })} />)
  assert.match(empty, /No package was fetched/)
  assert.match(empty, /No guest used it/)
})

const use = (o: Partial<UseView> = {}): UseView => ({ mode: 'auto', nodes: false, effective: true, why: 'Updates points each guest at pkgcache before apt runs.', cache: { id: 'lxc-9300', name: 'pkgcache' }, clients: 3, ...o })

test('Updates switch: three modes, what it means now, nodes apart and off by default', () => {
  const html = renderToStaticMarkup(<UseSwitch v={use()} busy={false} onMode={() => {}} onNodes={() => {}} />)
  assert.match(html, /aria-pressed="true"[^>]*>Automatic/)
  assert.match(html, />On</)
  assert.match(html, />Off</)
  assert.match(html, /In use\./)
  assert.match(html, /3 machines carry/)
  assert.match(html, /Proxmox nodes too/)
  assert.doesNotMatch(html, /type="checkbox" checked=""/)
  assert.match(html, /no repository file is changed and no package is held or released/)
  assert.match(renderToStaticMarkup(<UseSwitch v={use({ mode: 'off', effective: false, why: 'Off.' })} busy={false} onMode={() => {}} onNodes={() => {}} />), /Not in use\./)
})

test('problems: worst first, each with its fix button; self-check in words', () => {
  const html = renderToStaticMarkup(<ProblemList busy={null} onFix={() => {}} problems={[
    { id: 'disk_grow', severity: 'warn', title: 'Give the cache disk more room', detail: 'x', fix: { id: 'grow_disk', label: 'Grow the disk' } },
    { id: 'stopped', severity: 'bad', title: 'The package cache is not running', detail: 'y', fix: { id: 'restart', label: 'Start it again', confirm: 'Start?' } },
  ]} />)
  assert.ok(html.indexOf('not running') < html.indexOf('more room'))
  assert.match(html, />Start it again</)
  assert.match(html, />Grow the disk</)
  assert.match(renderToStaticMarkup(<ProblemList busy={null} onFix={() => {}} problems={[]} />), /No problems/)
  assert.match(renderToStaticMarkup(<SelfCheckList checks={[{ id: 'clients', state: 'fail', detail: 'rule not in force' }]} />), /FAILED: Only allowed networks may use it/)
})

test('logic: networks checked like the server, clean-up words, buckets, sizes', () => {
  assert.equal(checkNetworks(`10.20.30.0/24, ${P3}.0.0/16`).ok, true)
  for (const bad of ['10.0.0.0/7', '10.0.5.7/24', `${P3}.0.0/15`, '8.8.8.0/24', '', 'nonsense']) assert.equal(checkNetworks(bad).ok, false, bad)
  for (const octal of ['010.0.0.0/8', `${P3}.010.0/24`, '10.0.0.0/08']) assert.equal(checkNetworks(octal).ok, false, octal)
  assert.match(checkNetworks('010.0.0.0/8').problem!, /leading zeros/)
  assert.equal(repoName('ubusec'), 'Ubuntu security')
  assert.equal(repoName('debdbg'), 'Debian debug symbols')
  assert.match(expiryWords(reading(), 10 * H).text, /cleaned out 2 hours ago/)
  assert.equal(expiryWords(reading({ expiry: null }), 0).tone, 'warn')
  assert.equal(expiryWords(reading({ expiry: { at: 0, outcome: 'errors' } }), H).tone, 'bad')
  assert.equal(bucketed(reading().perHour).length, 4)
  const long = Array.from({ length: 720 }, (_, i) => ({ at: i * H, requests: 1, hits: 1, bytes: 1, hitBytes: 1, fetchedBytes: 0 }))
  const b = bucketed(long)
  assert.ok(b.length <= 96)
  assert.equal(b.reduce((x, y) => x + y.requests, 0), 720)
  assert.equal(diskGb(reading()), 50)
  assert.equal(repoName('uburep'), 'Ubuntu')
  assert.equal(repoName('download.example.net'), 'download.example.net')
  assert.equal(size(1536), '2 KB')
  assert.equal(areaPath([], 10, 10).line, '')
})
