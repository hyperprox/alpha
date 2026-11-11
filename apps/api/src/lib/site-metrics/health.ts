// =============================================================================
//  HyperProx — site metrics: is the site up, how fast, and its certificate
//
//  The public check fetches what a visitor would (the public address, or the
//  container's own when the site is not published) and times it. The
//  certificate is read by a TLS handshake with the public name, every six
//  hours, through the same probe the Certificates page uses.
// =============================================================================

import { findRecipe, healthProblem } from '../catalogue'
import { probeEndpoint } from '../certs/probe'
import type { SiteRecord } from '../sites'
import type { HealthState } from './store'
import { ownHeaders } from '../own-user-agent'

export const CERT_EVERY_MS = 6 * 60 * 60_000

export interface HealthDeps {
  fetch(url: string): Promise<{ status: number; body: string } | null>
  tls(host: string): Promise<{ notAfter: number | null; issuer: string | null; trusted: boolean | null; error: string | null }>
  now(): number
}

export const realHealthDeps = (): HealthDeps => ({
  // Says it is HyperProx, so the site's own metrics leave the check out.
  fetch: url => fetch(url, { headers: ownHeaders('site-check'), redirect: 'manual', signal: AbortSignal.timeout(8000) })
    .then(async r => ({ status: r.status, body: (await r.text().catch(() => '')).slice(0, 200_000) })).catch(() => null),
  tls: async host => {
    const r = await probeEndpoint({ host, port: 443, starttls: 'none' }).catch((e: any) => ({ ok: false, error: e?.message } as any))
    return { notAfter: r.leaf?.notAfter ? new Date(r.leaf.notAfter).getTime() : null, issuer: r.leaf?.issuer ?? null,
      trusted: r.trusted ?? null, error: r.ok ? null : (r.error ?? 'no certificate') }
  },
  now: Date.now,
})

/** The address checked and the path on it: the recipe's health path for a site HyperProx made, "/" for an adopted one. */
export function checkTarget(site: SiteRecord): { url: string; path: string } | null {
  const base = site.url ?? site.localUrl
  if (!base) return null
  const recipe = findRecipe(site.recipeId)
  return { url: base, path: recipe?.healthPath ?? '/' }
}

export function publicHost(site: SiteRecord): string | null {
  if (site.domain) return site.domain.toLowerCase()
  try { const u = new URL(site.url ?? ''); return u.protocol === 'https:' ? u.hostname : null } catch { return null }
}

/** One check. Returns the new health and what to add to the hour (checks, ok, latency). */
export async function checkSite(site: SiteRecord, prev: HealthState, d: HealthDeps): Promise<{ health: HealthState; ok: boolean; latencyMs: number }> {
  const t = checkTarget(site)
  const health: HealthState = { ...prev }
  if (!t) { health.lastProblem = 'This site has no address to check.'; return { health, ok: false, latencyMs: 0 } }
  const started = d.now()
  const r = await d.fetch(t.url + t.path)
  const latencyMs = Math.max(0, d.now() - started)
  const recipe = findRecipe(site.recipeId)
  let problem: string | null
  if (!r) problem = 'did not answer'
  else if (recipe) problem = healthProblem(recipe, r.status, r.body)
  else problem = r.status >= 200 && r.status < 400 ? null : `answered ${r.status}`
  health.url = t.url
  health.lastCheckAt = d.now()
  health.lastOk = !problem
  health.lastStatus = r?.status ?? null
  health.lastLatencyMs = r ? latencyMs : null
  health.lastProblem = problem
  health.failsInRow = problem ? prev.failsInRow + 1 : 0
  const host = publicHost(site)
  if (host && (!prev.cert || d.now() - prev.cert.checkedAt >= CERT_EVERY_MS)) {
    const c = await d.tls(host).catch(() => ({ notAfter: null, issuer: null, trusted: null, error: 'probe failed' }))
    health.cert = { checkedAt: d.now(), ...c }
  }
  return { health, ok: !problem, latencyMs: r ? latencyMs : 0 }
}

export function certDaysLeft(h: HealthState, now: number): number | null {
  if (!h.cert?.notAfter) return null
  return Math.floor((h.cert.notAfter - now) / 86_400_000)
}
