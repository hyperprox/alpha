// Demo fixtures: the Sites page and each site's Metrics tab (invented sites on example.com, invented numbers).
// Self-contained on purpose: the demo's import graph must not reach the real metrics store or the database.
import type { FixtureRoute } from './types'
import { DOMAIN, DEMO_OWNER, seeded, HOUR, DAY, GiB, MIN } from './data'

const ok = (data: unknown) => ({ success: true, data })

interface DemoSite { id: string; recipeId: string; kind: 'static' | 'wordpress'; name: string; vmid: number; node: string; ip: string; domain: string; base: number; botShare: number; certDays: number; p95: number; err: number }

export const DEMO_SITES: DemoSite[] = [
  { id: 'demo-docs', recipeId: 'static-site', kind: 'static', name: 'Project site', vmid: 207, node: 'pve-b', ip: '10.0.2.17', domain: `www.${DOMAIN}`, base: 14, botShare: 0.55, certDays: 71, p95: 38, err: 0 },
  { id: 'demo-blog', recipeId: 'wordpress', kind: 'wordpress', name: 'Family blog', vmid: 208, node: 'pve-b', ip: '10.0.2.18', domain: `blog.${DOMAIN}`, base: 4, botShare: 0.4, certDays: 12, p95: 610, err: 0.6 },
]

const hourStart = (t: number) => Math.floor(t / HOUR) * HOUR
const dayStart = (t: number) => Math.floor(t / DAY) * DAY

/** People and bots in one hour: a day curve, a quiet night, and (for the project site) a recent burst. */
function hourly(s: DemoSite, t: number) {
  const h = new Date(t).getUTCHours()
  const curve = 0.25 + 0.75 * Math.pow(Math.sin((Math.PI * (h + 2)) / 24), 2)
  const noise = 0.6 + 0.8 * seeded(`${s.id}:${t}`)
  const burst = s.id === 'demo-docs' && Date.now() - t < 5 * HOUR ? 2.6 : 1
  const people = Math.round(s.base * curve * noise * burst)
  const bots = Math.round(s.base * s.botShare * (0.6 + 0.6 * seeded(`${s.id}:b:${t}`)))
  return { people: people * 3, bots: bots * 2, visitors: people }
}

function dayTotals(s: DemoSite, day: number, upTo = day + DAY) {
  let people = 0, bots = 0, visitors = 0
  for (let t = day; t < Math.min(upTo, day + DAY); t += HOUR) { const x = hourly(s, t); people += x.people; bots += x.bots; visitors += x.visitors }
  return { people, bots, visitors: Math.round(visitors * 0.8) }
}

function summary(s: DemoSite) {
  const now = Date.now(), cur = hourStart(now), today = dayStart(now)
  const t = dayTotals(s, today, cur + HOUR), y = dayTotals(s, today - DAY, cur + HOUR - DAY)
  const spark: number[] = []
  for (let h = cur - 23 * HOUR; h <= cur; h += HOUR) spark.push(hourly(s, h).visitors)
  return {
    id: s.id, name: s.name, kind: s.kind, adopted: false, domain: s.domain, url: `https://${s.domain}`,
    up: true, latencyMs: s.kind === 'wordpress' ? 296 : 108, checkedAt: now - 2 * MIN,
    visitorsToday: t.visitors, trendPct: y.visitors ? Math.round(((t.visitors - y.visitors) / y.visitors) * 100) : null,
    pageViewsToday: Math.round(t.people * 0.45), spark, errorRatePct: s.err, p95Ms: s.p95, certDays: s.certDays,
    alerts: s.certDays < 14 ? [{ kind: 'cert', since: now - 3 * HOUR, detail: `The certificate expires in ${s.certDays} days.` }] : [],
  }
}

const PAGES: Record<string, Array<[string, number]>> = {
  'demo-docs': [['/', 412], ['/install/', 96], ['/tour/', 61], ['/security/', 38], ['/changelog/', 17]],
  'demo-blog': [['/', 58], ['/2026/11/first-snow/', 37], ['/about/', 14], ['/recipes/bread/', 9], ['/contact/', 6]],
}
const REFS: Record<string, Array<[string, number]>> = {
  'demo-docs': [['forum.example.org', 182], ['news.example.net', 74], ['git.example.org', 51], ['search.example', 22]],
  'demo-blog': [['search.example', 88], ['social.example', 19], ['mail.example.net', 7]],
}
const NOT_FOUND: Record<string, Array<[string, number]>> = {
  'demo-docs': [['/docs', 9], ['/install.html', 4]],
  'demo-blog': [['/wp-content/uploads/2024/old.jpg', 22], ['/sitemap.xml', 4]],
}

function detail(s: DemoSite, range: string) {
  const now = Date.now(), cur = hourStart(now), today = dayStart(now)
  const r = range === '24h' || range === '30d' ? range : '7d'
  const series: Array<{ at: number; people: number; bots: number; visitors: number }> = []
  if (r === '24h') for (let t = cur - 23 * HOUR; t <= cur; t += HOUR) series.push({ at: t, ...hourly(s, t) })
  else for (let d = today - ((r === '7d' ? 7 : 30) - 1) * DAY; d <= today; d += DAY) series.push({ at: d, ...dayTotals(s, d, d === today ? cur + HOUR : d + DAY) })
  const people = series.reduce((x, p) => x + p.people, 0), bots = series.reduce((x, p) => x + p.bots, 0)
  const requests = people + bots
  const scale = (rows: Array<[string, number]>) => rows.map(([key, v]) => ({ key, value: Math.max(1, Math.round(v * (r === '24h' ? 0.2 : r === '30d' ? 3.5 : 1))) }))
  const s5 = Math.round(requests * s.err / 100), s4 = Math.round(requests * 0.016), s3 = Math.round(requests * 0.03)
  const wp = s.kind === 'wordpress' ? {
    checkedAt: now - 22 * MIN, wpCli: true, core: '6.9.1', php: '8.4', fpm: [{ unit: 'php8.4-fpm', active: true }],
    updates: [{ kind: 'core', name: 'WordPress', version: '6.9.1', available: '6.9.2' }, { kind: 'plugin', name: 'redis-cache', version: '2.6.4', available: '2.6.5' },
      { kind: 'theme', name: 'twentytwentysix', version: '1.1', available: '1.2' }],
    plugins: 4, themes: 2,
    errors: [{ level: 'Warning', at: '2026/11/11 08:12:40', text: 'PHP Warning: Undefined array key "w" in …/plugins/gallery-lite/render.php on line 88' }],
  } : undefined
  return {
    summary: summary(s), range: r,
    hud: { visitors: series.reduce((x, p) => x + p.visitors, 0), pageViews: Math.round(people * 0.45), requests, errorRatePct: s.err,
      p95Ms: s.p95, p50Ms: Math.round(s.p95 / 4), bytes: requests * (s.kind === 'wordpress' ? 48_000 : 61_000), uptimePct: s.kind === 'wordpress' ? 99.8 : 100, hasRequestTime: true },
    series, status: { s2xx: requests - s5 - s4 - s3, s3xx: s3, s4xx: s4, s5xx: s5 },
    devices: s.kind === 'wordpress' ? [{ key: 'mobile', value: 52, pct: 52 }, { key: 'desktop', value: 44, pct: 44 }, { key: 'tablet', value: 4, pct: 4 }]
      : [{ key: 'desktop', value: 61, pct: 61 }, { key: 'mobile', value: 35, pct: 35 }, { key: 'tablet', value: 4, pct: 4 }],
    browsers: [['Chrome', 52], ['Firefox', 21], ['Safari', 19], ['Edge', 8]].map(([key, pct]) => ({ key, value: pct, pct })),
    os: [['Windows', 38], ['Android', 24], ['iOS', 18], ['macOS', 12], ['Linux', 8]].map(([key, pct]) => ({ key, value: pct, pct })),
    pages: scale(PAGES[s.id]), referrers: scale(REFS[s.id]), notFound: scale(NOT_FOUND[s.id]),
    where: { vmid: s.vmid, node: s.node },
    collector: { logPath: '/var/log/nginx/access.log', format: 'extended', lastReadAt: now - 3 * MIN, lastError: null, gaps: 0, malformed: 0 },
    wordpress: wp, alertSettings: { enabled: true, errorRatePct: 5, downChecks: 2, certDays: 14, spikeFactor: 10 },
    health: { up: true, status: 200, latencyMs: s.kind === 'wordpress' ? 296 : 108, problem: null, certDays: s.certDays, certIssuer: 'Example CA R11', certError: null },
    container: s.kind === 'wordpress'
      ? { status: 'running', cpuPct: 11, cores: 2, memPct: 46, memUsed: 0.92 * GiB, memMax: 2 * GiB, diskPct: 38, diskUsed: 3.8 * GiB, diskMax: 10 * GiB, uptimeS: 3 * 86_400, netIn7d: 210 * 1024 ** 2, netOut7d: 9 * 1024 ** 2 }
      : { status: 'running', cpuPct: 3, cores: 1, memPct: 18, memUsed: 92 * 1024 ** 2, memMax: 512 * 1024 ** 2, diskPct: 21, diskUsed: 0.84 * GiB, diskMax: 4 * GiB, uptimeS: 6 * 3600, netIn7d: 1.1 * GiB, netOut7d: 41 * 1024 ** 2 },
    canAdmin: true,
  }
}

const record = (s: DemoSite) => ({
  id: s.id, recipeId: s.recipeId, name: s.name, vmid: s.vmid, node: s.node, ip: s.ip, domain: s.domain, url: `https://${s.domain}`,
  localUrl: `http://${s.ip}`, adminUser: s.kind === 'wordpress' ? 'alex' : null, vaultItem: s.kind === 'wordpress' ? `catalogue/wordpress-${s.vmid}` : null,
  adminUrl: s.kind === 'wordpress' ? `https://${s.domain}/wp-admin/` : null, createdAt: Date.now() - 41 * DAY, owner: DEMO_OWNER.email,
})

export const SITE_ROUTES: FixtureRoute[] = [
  { path: '/api/sites', get: () => ok({ sites: DEMO_SITES.map(record) }) },
  { path: '/api/sites/:id/health', get: p => ok({ checks: DEMO_SITES.filter(s => s.id === p.id).map(s => ({ url: `https://${s.domain}/`, ok: true, detail: 'answered 200' })) }) },
  { path: '/api/site-metrics/sites', get: () => ok({ sites: DEMO_SITES.map(summary) }) },
  { path: '/api/site-metrics/alerts', get: () => ok({ alerts: DEMO_SITES.flatMap(s => summary(s).alerts.map(a => ({ siteId: s.id, site: s.domain, ...a }))) }) },
  { path: '/api/site-metrics/sites/:id', get: (p, q) => { const s = DEMO_SITES.find(x => x.id === p.id); return s ? ok(detail(s, q.range ?? '7d')) : { success: false, error: 'No such site' } } },
  { path: '/api/site-metrics/adopt/guests', get: () => ok({ guests: [{ vmid: 204, name: 'gitea', node: 'pve-b', status: 'running', type: 'lxc' }], defaults: { logPath: '/var/log/nginx/access.log', wpPath: '/var/www/wordpress' } }) },
]
