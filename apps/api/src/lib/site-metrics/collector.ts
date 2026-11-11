// =============================================================================
//  HyperProx — site metrics: the five-minute collector
//
//  For each site, one at a time:
//    1. pull the access log's new lines (read-script.ts), parse and count them
//       by hour, hash visitors with the day's salt, and move the cursor only
//       once the counts are saved;
//    2. check the public address and, every six hours, its certificate;
//    3. compare with the alert settings and announce what changed;
//    4. for a WordPress site, refresh the WP-CLI read once an hour.
//  The log pull and WP-CLI need the node logins in the vault, so they wait
//  while HyperProx is locked; the public check does not.
//  Raw lines live only in this function's memory and are dropped at its end.
// =============================================================================

import { execOnNode, containerScriptCommand, nodeCredential } from '../node-exec'
import { homePve } from '../pve-env'
import { isUnlocked } from '../vault/state'
import { publish as busPublish } from '../notify'
import type { NotifyEventInput } from '../notify/types'
import { listSites, type SiteRecord } from '../sites'
import { aggregateLines, bump, dayKey, emptyAgg, hourStart, sumAggs, type Agg } from './aggregate'
import { parseLogLine, splitLines, type LogLine } from './log-parser'
import { parseReadOutput, readLogScript, READ_CHUNK } from './read-script'
import { makeSalt, saltDayAllowed, visitorHash } from './visitors'
import { checkSite, realHealthDeps, publicHost, type HealthDeps } from './health'
import { announce, evaluate } from './alerts'
import { parseWordPressOutput, wordpressScript, WP_CACHE_MS } from './wordpress'
import { metricsStore, DEFAULT_ALERTS, emptyHealth, type MetricsStore, type SiteKind, type SiteState } from './store'
import { DEFAULT_ACCESS_LOG, DEFAULT_ERROR_LOG, DEFAULT_WP_PATH } from './paths'

export const TICK_MS = 5 * 60_000
/** Read rounds per site per tick: up to 4 × 4 MiB, the rest next time. */
export const ROUNDS = 4
const HOUR = 3_600_000

export interface CollectorDeps {
  sites(): Promise<SiteRecord[]>
  /** Run a fixed script inside the site's container; output capped at `maxBytes`. */
  run(site: SiteRecord, script: string, maxBytes: number): Promise<{ code: number | null; output: string }>
  health: HealthDeps
  publish(e: NotifyEventInput): Promise<void>
  store: MetricsStore
  unlocked(): boolean
  now(): Date
  log(m: string): void
}

/** What kind of site a record is, from the recipe that made it or the kind chosen when it was adopted. */
export function kindOf(site: SiteRecord): SiteKind {
  const r = site.recipeId.replace(/^adopted-/, '')
  return r === 'static-site' || r === 'static' ? 'static' : r === 'wordpress' ? 'wordpress' : 'other'
}

export function isAdopted(site: SiteRecord): boolean { return site.recipeId.startsWith('adopted-') }

export function defaultState(site: SiteRecord): SiteState {
  const kind = kindOf(site)
  return {
    siteId: site.id, logPath: DEFAULT_ACCESS_LOG, errorLog: DEFAULT_ERROR_LOG, wpPath: kind === 'wordpress' ? DEFAULT_WP_PATH : null,
    kind, adopted: isAdopted(site), enabled: true, inode: '', offset: 0, format: null, lastReadAt: null, lastError: null,
    gaps: 0, malformed: 0, health: emptyHealth(), alerts: { ...DEFAULT_ALERTS }, alertState: {}, wordpress: null,
  }
}

async function realRun(site: SiteRecord, script: string, maxBytes: number) {
  const cred = await nodeCredential(site.node).catch(() => null)
  if (!cred) throw new Error(`No node login is stored for ${site.node}.`)
  const row = ((await homePve().fetchNode<any[]>('/cluster/status').catch(() => [])) ?? []).find((r: any) => r.type === 'node' && r.name === site.node)
  if (!row?.ip) throw new Error(`Could not find an address for node ${site.node}.`)
  const vmid = Number(site.vmid)
  if (!Number.isSafeInteger(vmid) || vmid < 100) throw new Error('This site has no valid container id.')
  const r = await execOnNode({ host: row.ip, cred, command: containerScriptCommand(vmid), input: script, timeoutMs: 2 * 60_000, maxOutputBytes: maxBytes })
  return { code: r.truncated ? -2 : r.code, output: r.output }
}

export const realCollectorDeps = (log: (m: string) => void = () => {}): CollectorDeps => ({
  sites: listSites,
  run: realRun,
  health: realHealthDeps(),
  publish: e => busPublish(e),
  store: metricsStore(),
  unlocked: isUnlocked,
  now: () => new Date(),
  log,
})

/** Count one batch of lines into the store. Returns how many lines it counted. */
export async function countLines(site: SiteRecord, st: SiteState, raw: string[], d: CollectorDeps): Promise<{ counted: number; malformed: number; format: string | null }> {
  const parsed: LogLine[] = []
  let malformed = 0
  for (const l of raw) { const p = parseLogLine(l); if (p) parsed.push(p); else malformed++ }
  if (!parsed.length) return { counted: 0, malformed, format: null }
  const now = d.now()
  const salts = new Map<string, string | null>()
  for (const day of new Set(parsed.map(p => dayKey(p.time)))) {
    salts.set(day, await d.store.salt(day, () => (saltDayAllowed(day, now) ? makeSalt() : null)))
  }
  const host = publicHost(site)
  const res = aggregateLines(parsed, {
    ownHosts: host ? [host] : [], kind: st.kind,
    visitorHash: (day, client, ua) => { const s = salts.get(day); return s ? visitorHash(s, site.id, client, ua) : null },
  })
  for (const [h, hb] of res.hours) {
    const hour = new Date(h)
    const fresh = new Set(await d.store.addVisitors(site.id, hour, [...hb.visitors.keys()]))
    for (const [hash, c] of hb.visitors) if (fresh.has(hash)) { bump(hb.agg.browsers, c.browser); bump(hb.agg.os, c.os); bump(hb.agg.devices, c.device) }
    await d.store.merge(site.id, hour, hb.agg)
    await d.store.recountVisitors(site.id, hour)
  }
  const fmt = Object.entries(res.formats).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  return { counted: parsed.length, malformed, format: fmt }
}

/** Pull and count new log lines. Moves the cursor in `st`; throws when the read itself failed. */
export async function pullLog(site: SiteRecord, st: SiteState, d: CollectorDeps): Promise<number> {
  let total = 0
  for (let round = 0; round < ROUNDS; round++) {
    const r = await d.run(site, readLogScript(st.logPath, { inode: st.inode, offset: st.offset }), Math.ceil(READ_CHUNK * 2 * 1.4) + 4096)
    if (r.code !== 0) throw new Error(r.code === -2 ? 'The log reader sent more than expected.' : `The log reader exited ${r.code}.`)
    const out = parseReadOutput(r.output)
    if (out.missing) { st.lastError = `${st.logPath} does not exist in the container.`; return total }
    if (out.unreadable) { st.lastError = `${st.logPath} cannot be read.`; return total }
    if (out.gap) st.gaps++
    const lines: string[] = []
    let inode = st.inode, offset = st.offset, more = false
    const rot = out.sections.find(s => s.kind === 'rotated')
    const cur = out.sections.find(s => s.kind === 'current')
    let rotDone = true
    if (rot) {
      const final = rot.from + rot.data.length >= rot.size
      const s = splitLines(rot.data, final)
      lines.push(...s.lines)
      if (!final) { rotDone = false; inode = rot.inode; offset = rot.from + (s.consumed || rot.data.length); more = true }
    }
    if (cur && rotDone) {
      let data = cur.data, skipped = 0
      if (out.skipFirst) { const nl = data.indexOf(0x0a); skipped = nl + 1; data = data.subarray(skipped) }
      const s = splitLines(data, false)
      lines.push(...s.lines)
      let consumed = skipped + s.consumed
      // One line longer than a whole chunk: skip it rather than stall on it for ever.
      if (s.consumed === 0 && cur.data.length >= READ_CHUNK) consumed = cur.data.length
      inode = cur.inode; offset = cur.from + consumed
      more = cur.from + cur.data.length < cur.size
    }
    const c = await countLines(site, st, lines, d)
    total += c.counted
    st.malformed += c.malformed
    if (c.format) st.format = c.format
    st.inode = inode; st.offset = offset
    st.lastReadAt = d.now().getTime(); st.lastError = null
    await d.store.putState(st)
    if (!more) break
  }
  return total
}

export async function refreshWordPress(site: SiteRecord, st: SiteState, d: Pick<CollectorDeps, 'run' | 'now'>): Promise<void> {
  const wp = st.wpPath ?? DEFAULT_WP_PATH
  const r = await d.run(site, wordpressScript(wp, st.errorLog), 512 * 1024)
  st.wordpress = parseWordPressOutput(r.output, d.now().getTime(), wp)
  if (r.code !== 0 && !st.wordpress.problem) st.wordpress.problem = `The check exited ${r.code}.`
}

/** The rows the alerts look at: the hour in progress, the last complete hour, and the usual hour before it. */
export async function alertInputs(store: MetricsStore, siteId: string, now: Date) {
  const cur = hourStart(now).getTime()
  const rows = await store.hours(siteId, new Date(cur - 8 * 24 * HOUR), new Date(cur + HOUR))
  const at = (t: number) => rows.find(r => r.at.getTime() === t)?.agg ?? null
  const current = at(cur), last = at(cur - HOUR)
  const before = rows.filter(r => r.at.getTime() < cur - HOUR && r.at.getTime() >= cur - 8 * 24 * HOUR)
  // At least a day of history, or there is no "usual" to compare with.
  const span = before.length ? (cur - HOUR - before[0].at.getTime()) / HOUR : 0
  const usual = span >= 24 ? before.reduce((s, r) => s + r.agg.requests, 0) / span : null
  const recent = current && current.requests >= 20 ? current : last
  return { recent, lastHour: last, usualPerHour: usual, now: now.getTime() }
}

/** Everything for one site, once. Errors are recorded on the site, never thrown. */
export async function collectSite(site: SiteRecord, d: CollectorDeps): Promise<SiteState> {
  const st = (await d.store.getState(site.id)) ?? defaultState(site)
  if (!st.enabled) return st
  if (d.unlocked()) {
    try { await pullLog(site, st, d) } catch (e: any) { st.lastError = String(e?.message ?? 'the log could not be read').slice(0, 300) }
    if (st.kind === 'wordpress' && (!st.wordpress || d.now().getTime() - st.wordpress.checkedAt >= WP_CACHE_MS)) {
      try { await refreshWordPress(site, st, d) } catch (e: any) { st.wordpress = { ...(st.wordpress ?? emptyWp(d.now().getTime())), checkedAt: d.now().getTime(), problem: String(e?.message ?? 'failed').slice(0, 200) } }
    }
  }
  const h = await checkSite(site, st.health, d.health)
  st.health = h.health
  const add: Agg = { ...emptyAgg(), checks: 1, checksOk: h.ok ? 1 : 0, latencyMs: h.latencyMs }
  await d.store.merge(site.id, hourStart(d.now()), add)
  const now = d.now()
  st.alertState = await announce(site, st, evaluate(st, await alertInputs(d.store, site.id, now)), e => d.publish(e), now.getTime())
  await d.store.putState(st)
  return st
}

const emptyWp = (t: number) => ({ checkedAt: t, wpCli: false, core: null, php: null, fpm: [], updates: [], plugins: 0, themes: 0, errors: [] })

export class SiteMetricsCollector {
  private timer: NodeJS.Timeout | null = null
  private first: NodeJS.Timeout | null = null
  private running = false
  private lastPrune = 0
  constructor(private d: CollectorDeps) {}

  async tick(): Promise<number> {
    if (this.running) return 0
    this.running = true
    try {
      const sites = await this.d.sites()
      for (const s of sites) {
        try { await collectSite(s, this.d) } catch (e: any) { this.d.log(`[site-metrics] ${s.id}: ${e?.message ?? 'failed'}`) }
      }
      const now = this.d.now()
      if (now.getTime() - this.lastPrune >= HOUR) {
        this.lastPrune = now.getTime()
        await this.d.store.prune(now).catch(e => this.d.log(`[site-metrics] prune failed: ${e?.message ?? 'error'}`))
      }
      return sites.length
    } finally { this.running = false }
  }

  start(intervalMs = TICK_MS, firstDelayMs = 60_000): void {
    if (this.timer) return
    const run = () => { this.tick().catch(e => this.d.log(`[site-metrics] tick failed: ${e?.message ?? 'error'}`)) }
    this.first = setTimeout(run, firstDelayMs); this.first.unref?.()
    this.timer = setInterval(run, intervalMs); this.timer.unref?.()
  }

  stop(): void {
    if (this.first) clearTimeout(this.first)
    if (this.timer) clearInterval(this.timer)
    this.first = this.timer = null
  }
}

export { sumAggs }
