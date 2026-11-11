// Catalogue: finding apps already running (lib/catalogue-detect.ts), the catalogue list without the website
// recipes (they have their own section), and the nav map's Websites entry.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { DETECT, detectApps, probeTargets, DetectionCache, type ProbeAnswer, type Getter } from '../src/lib/catalogue-detect'
import type { Candidate, DiscoveryResult } from '../src/lib/site-metrics/discovery'
import { buildCatalogueRoutes, catalogueFingerprints, isCatalogueListed } from '../src/routes/catalogue'
import { CATALOGUE, findRecipe, wizardRecipes } from '../src/lib/catalogue'
import { requiredRole } from '../src/lib/roles'
import { resolvePageMeta } from '../../frontend/lib/page-title'
import { overviewTotals } from '../../frontend/components/sites/metrics/overview'

const ok = (body: unknown, status = 200): ProbeAnswer => ({ status, headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body) })
const hit = (id: string, a: ProbeAnswer) => DETECT[id].map(f => f.match(a)).find(Boolean) ?? null

// Fixtures: what each app answers at its fingerprint path (trimmed to the fields that matter).
const FIX: Record<string, { path: string; answer: ProbeAnswer; version: string | null }> = {
  nextcloud: { path: '/status.php', answer: ok({ installed: true, maintenance: false, needsDbUpgrade: false, version: '30.0.2.1', versionstring: '30.0.2', edition: '', productname: 'Nextcloud', extendedSupport: false }), version: '30.0.2' },
  jellyfin: { path: '/System/Info/Public', answer: ok({ LocalAddress: 'http://10.0.0.5:8096', ServerName: 'media', Version: '10.10.3', ProductName: 'Jellyfin Server', OperatingSystem: '', Id: 'x', StartupWizardCompleted: true }), version: '10.10.3' },
  gitea: { path: '/api/v1/version', answer: ok({ version: '1.22.3' }), version: '1.22.3' },
  vaultwarden: { path: '/api/config', answer: ok({ version: '2025.1.0', gitHash: 'abc', server: { name: 'Vaultwarden', url: 'https://github.com/dani-garcia/vaultwarden' }, environment: {} }), version: '2025.1.0' },
  grafana: { path: '/api/health', answer: ok({ commit: 'abc123', database: 'ok', version: '11.3.0' }), version: '11.3.0' },
  'uptime-kuma': { path: '/api/entry-page', answer: ok({ type: 'entryPage', entryPage: 'dashboard' }), version: null },
  homepage: { path: '/', answer: ok('<!DOCTYPE html><html><head><title>Homepage</title><link rel="preload" href="/_next/static/css/a.css"/></head><body></body></html>'), version: null },
  ollama: { path: '/api/tags', answer: ok({ models: [{ name: 'qwen3:8b' }] }), version: null },
  tautulli: { path: '/auth/login', answer: ok('<html><head><title>Tautulli - Login</title></head><body><form></form></body></html>'), version: null },
  'nginx-proxy-manager': { path: '/api/', answer: ok({ status: 'OK', setup: true, version: { major: 2, minor: 12, revision: 1 } }), version: '2.12.1' },
  wordpress: { path: '/wp-login.php', answer: ok('<html><link rel="stylesheet" href="https://blog.example.com/wp-includes/css/dashicons.min.css?ver=6.7.1"/><form name="loginform" id="loginform"></form></html>'), version: '6.7.1' },
}

test('fingerprints: each app is told by its own answer, with its version when it shows one', () => {
  for (const [id, f] of Object.entries(FIX)) {
    assert.ok(DETECT[id].some(x => x.path === f.path), `${id} probes ${f.path}`)
    assert.deepEqual(hit(id, f.answer), { version: f.version }, id)
  }
  assert.deepEqual(hit('vaultwarden', ok('"2026-11-11T10:30:00.123Z"')), { version: null }, '/alive answers a date')
})

test('fingerprints: no app answers another app\'s fixture, and error pages or wrong statuses are not a match', () => {
  for (const [id] of Object.entries(DETECT)) {
    for (const [other, f] of Object.entries(FIX)) {
      if (other === id) continue
      const got = DETECT[id].filter(x => x.path === f.path).map(x => x.match(f.answer)).find(Boolean)
      assert.equal(got ?? null, null, `${id} must not match ${other}'s answer`)
    }
  }
  assert.equal(hit('nextcloud', ok({ productname: 'Nextcloud' }, 503)), null)
  assert.equal(hit('wordpress', ok('<?php /* served as source */ id="loginform"')), null)
  assert.equal(hit('gitea', ok({ version: 'not a version' })), null)
  assert.equal(hit('ollama', ok('Not Found', 404)), null)
})

const cand = (over: Partial<Candidate>): Candidate => ({
  id: 'c', domains: [], url: null, source: 'proxy', proxy: null, guest: null, notAGuest: null, server: null, kind: null, logPath: null, logFormat: null, wpPath: null,
  alreadyASite: false, alreadyAdopted: false, siteId: null, up: null, adoptable: false, whyNot: null, notes: [], ...over,
})
const CANDS: Candidate[] = [
  cand({ id: 'c1', domains: ['cloud.example.com'], url: 'https://cloud.example.com', guest: { vmid: 425, name: 'nextcloud', node: 'pve1', type: 'lxc', status: 'running' },
    proxy: { instances: [{ instanceName: 'NPM', kind: 'npm' }], tls: true, forward: { scheme: 'http', host: '10.0.0.25', port: 80 } } }),
  cand({ id: 'c2', domains: ['talk.example.com'], url: 'https://talk.example.com', guest: { vmid: 425, name: 'nextcloud', node: 'pve1', type: 'lxc', status: 'running' },
    proxy: { instances: [{ instanceName: 'NPM', kind: 'npm' }], tls: true, forward: { scheme: 'http', host: '10.0.0.25', port: 8081 } } }),
  cand({ id: 'c3', domains: ['docs.example.com'], url: 'https://docs.example.com', kind: 'static', guest: { vmid: 426, name: 'web', node: 'pve2', type: 'lxc', status: 'running' },
    proxy: { instances: [{ instanceName: 'NPM', kind: 'npm' }], tls: true, forward: { scheme: 'http', host: '10.0.0.26', port: 80 } } }),
  cand({ id: 'c4', source: 'listener', url: 'http://10.0.0.30', guest: { vmid: 430, name: 'kuma', node: 'pve2', type: 'lxc', status: 'running' } }),
  cand({ id: 'c5', domains: ['nas.example.com'], url: 'https://nas.example.com', notAGuest: 'an address that is not a guest',
    proxy: { instances: [{ instanceName: 'NPM', kind: 'npm' }], tls: true, forward: { scheme: 'https', host: '10.0.0.99', port: 8080 } } }),
]

function fakeGet(map: Record<string, ProbeAnswer>, seen: Array<{ url: string; host: string | null }> = []): Getter {
  return async (url, host) => { seen.push({ url, host }); return map[url] ?? ok('Not Found', 404) }
}

test('detection: forward targets and listening containers are probed once per path, matched to their guests', async () => {
  assert.deepEqual(probeTargets(CANDS).map(t => [t.base, t.host]), [
    ['http://10.0.0.25:80', 'cloud.example.com'], ['http://10.0.0.25:8081', 'talk.example.com'], ['http://10.0.0.26:80', 'docs.example.com'],
    ['http://10.0.0.30', null], ['https://10.0.0.99:8080', 'nas.example.com'],
  ])
  const seen: Array<{ url: string; host: string | null }> = []
  const r = await detectApps(CANDS, fakeGet({
    'http://10.0.0.25:80/status.php': FIX.nextcloud.answer,
    'http://10.0.0.30/api/entry-page': FIX['uptime-kuma'].answer,
    'https://10.0.0.99:8080/api/v1/version': FIX.gitea.answer,
  }, seen), catalogueFingerprints(), () => 1, {})
  assert.deepEqual(r.apps.nextcloud, [{ guest: CANDS[0].guest, target: '10.0.0.25:80', publicUrl: 'https://cloud.example.com', domains: ['cloud.example.com'], version: '30.0.2', via: 'probe' }])
  assert.equal(r.apps['uptime-kuma'][0].guest!.vmid, 430); assert.equal(r.apps['uptime-kuma'][0].publicUrl, null)
  assert.equal(r.apps.gitea[0].guest, null, 'a non-guest target is still reported, by its address')
  assert.equal(r.apps['static-site'], undefined, 'the catalogue does not list websites')
  const perTarget = seen.filter(s => s.url.startsWith('http://10.0.0.25:80/'))
  assert.equal(new Set(perTarget.map(s => s.url)).size, perTarget.length, 'each path once per target')
  assert.ok(perTarget.every(s => s.host === 'cloud.example.com'), 'asked with the public name, as the proxy would')
  assert.ok(seen.every(s => !/password|token|Authorization/i.test(s.url)))
  // With the website kinds on (the Websites section's view), the plain nginx root counts as a static site.
  const all = await detectApps(CANDS, fakeGet({}), [], () => 1)
  assert.equal(all.apps['static-site'][0].guest!.vmid, 426); assert.equal(all.apps['static-site'][0].via, 'site-scan'); assert.equal(all.apps['static-site'][0].candidateId, 'c3')
})

test('detection: a target answers for one app; a generic page comes last; the result is cached five minutes', async () => {
  const both = fakeGet({ 'http://10.0.0.25:80/status.php': FIX.nextcloud.answer, 'http://10.0.0.25:80/': FIX.homepage.answer })
  const r = await detectApps([CANDS[0]], both, catalogueFingerprints(), () => 1, {})
  assert.ok(r.apps.nextcloud && !r.apps.homepage)
  assert.equal(catalogueFingerprints().at(-1)![0], 'homepage')
  let builds = 0, t = 0
  const c = new DetectionCache(async () => { builds++; return { candidates: [CANDS[0]], errors: ['NPM: locked'], listenerScan: { state: 'done', looked: 0, of: 0 }, builtAt: t } as DiscoveryResult },
    fakeGet({ 'http://10.0.0.25:80/status.php': FIX.nextcloud.answer }), () => t, catalogueFingerprints(), {})
  assert.deepEqual((await c.result()).errors, ['NPM: locked'])
  t = 4 * 60_000; await c.result(); assert.equal(builds, 1)
  t = 6 * 60_000; await c.result(); assert.equal(builds, 2)
  await c.result(true); assert.equal(builds, 3, 'refresh builds again')
})

test('catalogue: the list leaves out the website recipes (sent apart for the Websites section); /detected is admin', async () => {
  assert.equal(requiredRole('GET', '/api/catalogue/detected'), 'admin')
  assert.equal(requiredRole('GET', '/api/catalogue/detected?refresh=1'), 'admin')
  assert.equal(requiredRole('GET', '/api/catalogue'), 'viewer')
  const a = Fastify()
  let role = 'admin'
  a.addHook('onRequest', async (req: any) => { req.session = { role, email: 'a@example.com' } })
  a.register(buildCatalogueRoutes({ whoami: () => 'a@example.com', detected: async () => ({ apps: { nextcloud: [] }, builtAt: 1, probed: 0, errors: [] }) }))
  const list = (await a.inject({ url: '/' })).json().data
  assert.ok(list.recipes.length > 0)
  assert.ok(list.recipes.every((r: any) => r.category !== 'web'), 'no web recipe in the catalogue')
  assert.deepEqual(list.websites.map((r: any) => r.id).sort(), ['static-site', 'wordpress'])
  assert.equal(list.recipes.find((r: any) => r.id === 'nextcloud').detectable, true)
  assert.equal((await a.inject({ url: '/detected' })).statusCode, 200)
  role = 'operator'
  assert.equal((await a.inject({ url: '/detected' })).statusCode, 403)
  // The engine is untouched: both web recipes are still recipes, offered to the wizard and the AI.
  assert.equal(findRecipe('wordpress')?.category, 'web'); assert.equal(findRecipe('static-site')?.category, 'web')
  assert.ok(CATALOGUE.filter(r => !isCatalogueListed(r)).every(r => wizardRecipes().includes(r) || !r.wizard))
  assert.ok(CATALOGUE.filter(r => r.category !== 'web').every(r => r.id === 'static-site' || r.detect?.length), 'every catalogue app can be detected')
})

test('nav: Websites is its own rail item at /sites; a site page is titled under it and links back', async () => {
  // nav.tsx draws its icons with JSX; the API's compiler emits React.createElement, so stand one in to load the map.
  ;(globalThis as any).React ??= { createElement: () => null }
  const { NAV, pageMeta } = await import('../../frontend/components/layout/nav')
  const web = NAV.find(g => g.section === 'Web')!
  assert.deepEqual(web.items.map(i => [i.href, i.label]), [['/sites', 'Websites']])
  assert.ok(!NAV.flatMap(g => g.items).some(i => i.href === '/sites' && NAV.find(g => g.items.includes(i))!.section !== 'Web'))
  assert.deepEqual(pageMeta('/sites'), { crumb: 'Web', title: 'Websites' })
  const site = pageMeta('/sites/a1b2c3')
  assert.deepEqual(site, { crumb: 'Websites', title: 'Site metrics' })
  assert.equal(resolvePageMeta(site, '/sites/a1b2c3').crumbHref, '/sites')
  assert.equal(pageMeta('/catalogue').title, 'Catalogue')
})

test('websites overview: totals across sites', () => {
  const s = (o: Record<string, unknown>) => ({ id: 'x', name: 'x', kind: 'static', adopted: false, domain: null, url: null, up: null, latencyMs: null, checkedAt: null,
    visitorsToday: 0, trendPct: null, pageViewsToday: 0, spark: [], errorRatePct: null, p95Ms: null, certDays: null, alerts: [], ...o }) as any
  const t = overviewTotals([s({ visitorsToday: 12, pageViewsToday: 30, up: true, errorRatePct: 1.5, certDays: 60 }),
    s({ visitorsToday: 3, up: false, errorRatePct: 7, certDays: 5, alerts: [{ kind: 'down', since: 1, detail: '' }] }), s({})])
  assert.deepEqual(t, { visitorsToday: 15, pageViewsToday: 30, up: 1, down: 1, unchecked: 1, worstErrorPct: 7, certsSoon: 1, alerts: 1 })
})
