// =============================================================================
//  HyperProx — Catalogue: is this app already running somewhere?
//
//  A recipe used to show as installed only when its integration had a setting
//  (routes/catalogue.ts alreadySatisfied). An app with no integration, a
//  Nextcloud in Docker behind the proxy say, was offered for install although
//  it was already there. This finds it.
//
//  Each recipe may carry a `detect` fingerprint: one or more read-only GETs of
//  a path that only that app answers in its own way (Nextcloud's status.php,
//  Jellyfin's public system info, Grafana's health), and how to read a version
//  from the answer. They are asked of the places site discovery already knows
//  serve the web (lib/site-metrics/discovery.ts): every proxy host's forward
//  target and every container listening on 80/443 without one, each already
//  matched to its guest.
//
//  Every probe: GET only, no credentials, no cookies, redirects not followed,
//  3 second timeout, at most 64 KiB read. A forward target is asked with the
//  public name as its Host header, as the proxy would. Internal targets often
//  have self-signed certificates, so the certificate is not checked; nothing is
//  sent that a stranger could not send.
// =============================================================================

import http from 'node:http'
import https from 'node:https'
import type { Candidate, DiscoveryResult } from './site-metrics/discovery'
import { mapLimit } from './site-metrics/discovery'

export interface ProbeAnswer { status: number; headers: Record<string, string>; body: string }

/** One read-only probe of an app: the path, and how to tell the answer is that app (with its version when shown). */
export interface Fingerprint {
  path: string
  match(a: ProbeAnswer): { version: string | null } | null
}

const json = (a: ProbeAnswer): any => {
  if (a.status !== 200) return null
  try { return JSON.parse(a.body) } catch { return null }
}
const str = (v: unknown, max = 40): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const VERSIONISH = /^v?\d+(\.\d+){0,3}([-+.][0-9A-Za-z.+-]{0,30})?$/

/** The fingerprints, by recipe id. Recipes take theirs from here (lib/catalogue.ts `detect`). */
export const DETECT: Record<string, Fingerprint[]> = {
  nextcloud: [{
    path: '/status.php',
    match: a => { const j = json(a); return j && j.productname === 'Nextcloud' ? { version: str(j.versionstring) } : null },
  }],
  jellyfin: [{
    path: '/System/Info/Public',
    match: a => { const j = json(a); return j && /jellyfin/i.test(String(j.ProductName ?? '')) ? { version: str(j.Version) } : null },
  }],
  gitea: [{
    path: '/api/v1/version',
    match: a => { const j = json(a); return j && Object.keys(j).length === 1 && typeof j.version === 'string' && VERSIONISH.test(j.version) ? { version: str(j.version) } : null },
  }],
  vaultwarden: [
    { path: '/api/config', match: a => { const j = json(a); return j && /vaultwarden/i.test(String(j.server?.name ?? '')) ? { version: str(j.version) } : null } },
    { path: '/alive', match: a => (a.status === 200 && /^"\d{4}-\d\d-\d\dT[\d:.]+Z?"$/.test(a.body.trim()) ? { version: null } : null) },
  ],
  grafana: [{
    path: '/api/health',
    match: a => { const j = json(a); return j && typeof j.database === 'string' && typeof j.version === 'string' ? { version: str(j.version) } : null },
  }],
  'uptime-kuma': [{
    path: '/api/entry-page',
    match: a => { const j = json(a); return j && j.type === 'entryPage' ? { version: null } : null },
  }],
  homepage: [{
    path: '/',
    match: a => (a.status === 200 && a.body.includes('/_next/') && /<title>[^<]*homepage[^<]*<\/title>/i.test(a.body) ? { version: null } : null),
  }],
  ollama: [{
    path: '/api/tags',
    match: a => { const j = json(a); return j && Array.isArray(j.models) && Object.keys(j).length === 1 ? { version: null } : null },
  }],
  tautulli: [{
    path: '/auth/login',
    match: a => (a.status === 200 && /<title>[^<]*Tautulli/i.test(a.body) ? { version: null } : null),
  }],
  // The Arr Stack shows as installed when a Sonarr, Radarr or Prowlarr answers behind a proxy host: its sign-in page
  // (or, with sign-in off, its own page) carries the app's name in the title. One reached only on its own port,
  // with no proxy host, is found by the Arr Stack plug-in's discovery (lib/discovery.ts) instead, not here.
  'arr-stack': ['Sonarr', 'Radarr', 'Prowlarr'].flatMap(name => ['/login', '/'].map(path => ({
    path,
    match: (a: ProbeAnswer) => (a.status === 200 && new RegExp(`<title>[^<]*\\b${name}\\b[^<]*</title>`).test(a.body) ? { version: null } : null),
  }))),
  'nginx-proxy-manager': [{
    path: '/api/',
    match: a => { const j = json(a); const v = j?.version; return j && j.status === 'OK' && v && typeof v.major === 'number' ? { version: `${v.major}.${v.minor ?? 0}.${v.revision ?? 0}` } : null },
  }],
  // Its web interface, through whatever forwards to it: the page title and the GUI's own script, which no other
  // app serves. (A PBS reached only on :8007 with no proxy host is not among the places site discovery looks.)
  'proxmox-backup-server': [{
    path: '/',
    match: a => (a.status === 200 && /<title>[^<]*Proxmox Backup Server<\/title>/i.test(a.body) && a.body.includes('proxmox-backup-gui') ? { version: null } : null),
  }],
  wordpress: [{
    path: '/wp-login.php',
    match: a => (a.status === 200 && a.body.includes('id="loginform"') && !a.body.includes('<?php')
      ? { version: /wp-includes\/[^"']*\?ver=(\d+\.\d+(?:\.\d+)?)/.exec(a.body)?.[1] ?? null } : null),
  }],
}

/** Recipes that are found by what site discovery saw inside the container rather than by a probe. */
export const DETECT_BY_KIND: Record<string, 'static' | 'wordpress'> = { 'static-site': 'static', wordpress: 'wordpress' }

export interface Running {
  guest: Candidate['guest']
  /** host:port the probe reached (the proxy's forward target, or the container's own address). */
  target: string
  publicUrl: string | null
  domains: string[]
  version: string | null
  via: 'probe' | 'site-scan'
  /** For WordPress and static: the Sites candidate, so "Add to Sites" can open on it. */
  candidateId?: string
  alreadyASite?: boolean
}

export interface DetectResult {
  apps: Record<string, Running[]>
  builtAt: number
  probed: number
  errors: string[]
}

export type Getter = (url: string, host: string | null) => Promise<ProbeAnswer | null>

interface ProbeTarget { base: string; target: string; host: string | null; candidates: Candidate[] }

/** Where to probe: each distinct forward target (asked with its public name) and each listening container. */
export function probeTargets(candidates: Candidate[]): ProbeTarget[] {
  const out = new Map<string, ProbeTarget>()
  for (const c of candidates) {
    let base: string | null = null, target = '', host: string | null = null
    if (c.proxy) {
      const f = c.proxy.forward
      if (!/^https?$/.test(f.scheme) || !/^[A-Za-z0-9.-]{1,253}$/.test(f.host) || !(f.port > 0 && f.port < 65536)) continue
      base = `${f.scheme}://${f.host}:${f.port}`; target = `${f.host}:${f.port}`
      host = c.domains.find(d => !d.includes('*')) ?? null
    } else if (c.url) {
      try { const u = new URL(c.url); base = `${u.protocol}//${u.host}`; target = u.host } catch { continue }
    }
    if (!base) continue
    const t = out.get(base) ?? { base, target, host, candidates: [] }
    t.candidates.push(c)
    out.set(base, t)
  }
  return [...out.values()]
}

/**
 * Probe every target for every fingerprint (each distinct path once per target) and say, per recipe, where it
 * runs. A target answers for one app at most: the first recipe (in `order`) whose fingerprint matches.
 */
export type FingerprintList = Array<[recipeId: string, fingerprints: Fingerprint[]]>

export async function detectApps(candidates: Candidate[], get: Getter, order: FingerprintList = Object.entries(DETECT), now = Date.now,
  byKind: Record<string, 'static' | 'wordpress'> = DETECT_BY_KIND): Promise<DetectResult> {
  const apps: Record<string, Running[]> = {}
  const add = (id: string, r: Running) => {
    const list = apps[id] ?? (apps[id] = [])
    if (!list.some(x => x.target === r.target && x.publicUrl === r.publicUrl)) list.push(r)
  }
  const targets = probeTargets(candidates)
  const paths = [...new Set(order.flatMap(([, fps]) => fps.map(f => f.path)))]
  await mapLimit(targets, 4, async t => {
    const answers = new Map<string, ProbeAnswer | null>()
    await mapLimit(paths, 4, async p => { answers.set(p, await get(t.base + p, t.host).catch(() => null)) })
    for (const [id, fps] of order) {
      let hit: { version: string | null } | null = null
      for (const f of fps) {
        const a = answers.get(f.path)
        if (a && (hit = f.match(a))) break
      }
      if (!hit) continue
      const c = t.candidates[0]
      add(id, { guest: c.guest, target: t.target, publicUrl: c.url && c.proxy ? c.url : null, domains: t.candidates.flatMap(x => x.domains), version: hit.version, via: 'probe',
        ...(byKind[id] ? { candidateId: c.id, alreadyASite: c.alreadyASite } : {}) })
      break
    }
  })
  // What the look inside each container found: a plain nginx root is a static site, a wp-config.php a WordPress.
  for (const [id, kind] of Object.entries(byKind)) {
    for (const c of candidates) {
      if (c.kind !== kind || !c.guest) continue
      if ((apps[id] ?? []).some(r => r.guest?.vmid === c.guest!.vmid && (!c.url || r.publicUrl === c.url || r.domains.some(d => c.domains.includes(d))))) continue
      add(id, { guest: c.guest, target: c.proxy ? `${c.proxy.forward.host}:${c.proxy.forward.port}` : (c.url ?? '').replace(/^https?:\/\//, ''),
        publicUrl: c.proxy ? c.url : null, domains: c.domains, version: null, via: 'site-scan', candidateId: c.id, alreadyASite: c.alreadyASite })
    }
  }
  for (const list of Object.values(apps)) list.sort((a, b) => (a.guest?.vmid ?? 1e9) - (b.guest?.vmid ?? 1e9) || a.target.localeCompare(b.target))
  return { apps, builtAt: now(), probed: targets.length, errors: [] }
}

export const PROBE_TIMEOUT_MS = 3000
export const PROBE_MAX_BYTES = 64 * 1024

/** The real probe: one GET, nothing sent but the Host header, no redirects, short timeout, capped body. */
export const realGet: Getter = (url, host) => new Promise(resolve => {
  let u: URL
  try { u = new URL(url) } catch { resolve(null); return }
  const mod = u.protocol === 'https:' ? https : http
  const req = mod.request(u, {
    method: 'GET', timeout: PROBE_TIMEOUT_MS,
    headers: { 'user-agent': 'HyperProx-catalogue-detect', accept: 'application/json, text/html;q=0.9, */*;q=0.5', ...(host ? { host } : {}) },
    ...(u.protocol === 'https:' ? { rejectUnauthorized: false, servername: host ?? undefined } : {}),
  }, res => {
    const chunks: Buffer[] = []
    let n = 0
    res.on('data', (c: Buffer) => { n += c.length; if (n <= PROBE_MAX_BYTES) chunks.push(c); else res.destroy() })
    const done = () => {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v
      resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') })
    }
    res.on('end', done); res.on('close', done); res.on('error', () => resolve(null))
  })
  req.on('timeout', () => { req.destroy(); resolve(null) })
  req.on('error', () => resolve(null))
  req.end()
})

export const DETECT_TTL_MS = 5 * 60_000

/** The detection, cached for five minutes over a candidate list (shared with "Add an existing site"). */
export class DetectionCache {
  private found: DetectResult | null = null
  private finding: Promise<DetectResult> | null = null
  constructor(private candidates: (refresh: boolean) => Promise<DiscoveryResult>, private get: Getter = realGet, private now: () => number = Date.now, private order?: FingerprintList, private byKind?: Record<string, 'static' | 'wordpress'>) {}
  async result(refresh = false): Promise<DetectResult> {
    if (this.found && !refresh && this.now() - this.found.builtAt < DETECT_TTL_MS) return this.found
    if (this.finding) return this.finding
    this.finding = (async () => {
      const d = await this.candidates(refresh)
      const r = await detectApps(d.candidates, this.get, this.order, this.now, this.byKind)
      r.errors = d.errors
      return (this.found = r)
    })().finally(() => { this.finding = null })
    return this.finding
  }
}
