// =============================================================================
//  HyperProx — the package cache: reading what its helper prints
//
//  `hpx-aptcache stats HOURS` prints key=value lines, then H| (one hour), P|
//  (a package), R| (a repository) and C| (a client address) rows. Only figures:
//  no request, no path. `selftest` prints check=<id> <ok|fail|info> <detail>.
// =============================================================================

import type { CacheReading, HourBucket, SelfCheck } from './types'

const num = (v: string | undefined) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0 }
const NAME = /^[A-Za-z0-9._+-]{1,80}$/
const ADDR = /^[0-9a-fA-F.:]{2,45}$/

export const CHECK_TITLE: Record<string, string> = {
  running: 'Running',
  listen:  'Listens only on its LAN address',
  clients: 'Only allowed networks may use it',
  fetch:   'A package index comes through the cache',
  https:   'HTTPS repositories pass through',
  admin:   'Admin actions need the password',
  no_private_tunnel: 'No tunnel to a private or loopback address',
  managed_only: 'Only package archives are fetched',
}

export function parseSelfTest(output: string): SelfCheck[] {
  const out: SelfCheck[] = []
  for (const line of String(output ?? '').split('\n')) {
    const m = /^check=([a-z_]{1,30}) (ok|fail|info) (.{0,300})$/.exec(line.trim())
    if (m) out.push({ id: m[1], state: m[2] as SelfCheck['state'], detail: m[3] })
  }
  return out
}

/** The helper's figures as a reading. `now` (ms) fills the hours with no traffic. Throws on output that is not stats. */
export function parseStats(output: string, nowMs: number): CacheReading {
  const kv: Record<string, string> = {}
  const hours: HourBucket[] = []
  const packages: CacheReading['packages'] = []
  const repos: CacheReading['repos'] = []
  const clients: CacheReading['clients'] = []
  for (const raw of String(output ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.includes('|')) {
      const f = line.split('|')
      if (f[0] === 'H' && f.length === 7) hours.push({ at: num(f[1]) * 1000, requests: num(f[2]), hits: num(f[3]), bytes: num(f[4]), hitBytes: num(f[5]), fetchedBytes: num(f[6]) })
      else if (f[0] === 'P' && f.length === 5 && NAME.test(f[1])) packages.push({ name: f[1], requests: num(f[2]), hits: num(f[3]), bytes: num(f[4]) })
      else if (f[0] === 'R' && f.length === 5 && NAME.test(f[1])) repos.push({ name: f[1], requests: num(f[2]), hits: num(f[3]), bytes: num(f[4]) })
      else if (f[0] === 'C' && f.length === 4 && ADDR.test(f[1])) clients.push({ address: f[1], requests: num(f[2]), bytes: num(f[3]) })
      continue
    }
    const i = line.indexOf('=')
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1)
  }
  if (kv.kind !== 'apt-cacher-ng') throw new Error('The cache\'s helper did not answer with its figures.')
  const window = Math.min(720, Math.max(1, Math.floor(num(kv.hours)) || 24))
  const nowS = num(kv.now) || Math.floor(nowMs / 1000)
  // One bucket per hour of the window, oldest first, zeros where nothing happened.
  const end = Math.floor(nowS / 3600) * 3600
  const byAt = new Map(hours.map(h => [h.at, h]))
  const perHour: HourBucket[] = []
  for (let t = end - (window - 1) * 3600; t <= end; t += 3600) {
    perHour.push(byAt.get(t * 1000) ?? { at: t * 1000, requests: 0, hits: 0, bytes: 0, hitBytes: 0, fetchedBytes: 0 })
  }
  const [tr, th, tb, thb, tf] = (kv.totals ?? '').split(' ').map(num)
  const disk = /^(\d+) (\d+) (\d+)$/.exec(kv.disk ?? '')
  const exp = /^(\d+) (done|skipped|errors)$/.exec(kv.expiry ?? '')
  const totals = { requests: tr ?? 0, hits: th ?? 0, bytes: tb ?? 0, hitBytes: thb ?? 0, fetchedBytes: tf ?? 0 }
  return {
    at: nowS * 1000,
    active: kv.active === '1',
    version: kv.version && /^[0-9A-Za-z.+:~-]{1,40}$/.test(kv.version) ? kv.version : null,
    listen: /^\d{1,3}(\.\d{1,3}){3}$/.test(kv.listen ?? '') ? kv.listen : null,
    allow: (kv.allow ?? '').split(/\s+/).filter(Boolean),
    report: kv.report === '1',
    hours: window,
    disk: disk ? { sizeKb: Number(disk[1]), usedKb: Number(disk[2]), freeKb: Number(disk[3]) } : null,
    cacheGb: kv.cache_gb && /^\d{1,5}$/.test(kv.cache_gb) ? Number(kv.cache_gb) : null,
    totals,
    hitRatio: totals.requests ? totals.hits / totals.requests : null,
    byteHitRatio: totals.bytes ? totals.hitBytes / totals.bytes : null,
    perHour,
    packages: packages.sort((a, b) => b.requests - a.requests || b.bytes - a.bytes).slice(0, 15),
    repos: repos.sort((a, b) => b.requests - a.requests || b.bytes - a.bytes).slice(0, 15),
    clients: clients.sort((a, b) => b.bytes - a.bytes).slice(0, 50),
    expiry: exp ? { at: Number(exp[1]) * 1000, outcome: exp[2] as 'done' | 'skipped' | 'errors' } : null,
    refused: num(kv.refused),
    errors: num(kv.errors),
  }
}

/** What the maint verb printed. */
export function parseMaint(output: string): 'done' | 'skipped' | 'failed' | null {
  return (/^result=(done|skipped|failed)$/m.exec(String(output ?? ''))?.[1] as 'done' | 'skipped' | 'failed' | undefined) ?? null
}
