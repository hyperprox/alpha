// =============================================================================
//  HyperProx — Service Health Checks
//
//  Every probe ends in one of three states within a few seconds, never in a
//  fourth "still working on it" one: the dashboard used to print "checking..."
//  for any service that was not connected, so a refused connection and an
//  unfinished one looked the same, forever.
//
//  Where to look is not one fixed address. The API normally runs on the host
//  (loopback reaches Prometheus on the host network and Grafana's published
//  port), but nothing guarantees HOST_IP is right, and when the API is itself
//  in a container the siblings answer to their compose service names. So each
//  service has an explicit override (GRAFANA_URL / PROMETHEUS_URL) and an
//  ordered list of candidates, all tried at once; the first that answers wins.
// =============================================================================

export type ServiceState = 'connected' | 'unreachable' | 'not-configured'

export interface ServiceHealth {
  state:     ServiceState
  /** Kept for older readers: true exactly when state is 'connected'. */
  connected: boolean
  url?:      string
  version?:  string
  message?:  string
}

/** How long one candidate gets. The whole probe is bounded by this, not by their sum. */
export const PROBE_TIMEOUT_MS = 2500

const GRAFANA_PORT    = 3003
const PROMETHEUS_PORT = 9090

function trimSlash(u: string): string { return u.replace(/\/+$/, '') }

/** Ordered candidate base URLs for a service. An explicit override is the only candidate. */
export function candidateUrls(
  override: string | undefined, port: number, composeName: string, env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (override && override.trim()) return [trimSlash(override.trim())]
  const out = [`http://127.0.0.1:${port}`]
  if (env.HOST_IP && env.HOST_IP.trim()) out.push(`http://${env.HOST_IP.trim()}:${port}`)
  out.push(`http://${composeName}:${port}`)
  return out
}

export const grafanaCandidates    = (env = process.env) => candidateUrls(env.GRAFANA_URL,    GRAFANA_PORT,    'grafana',    env)
export const prometheusCandidates = (env = process.env) => candidateUrls(env.PROMETHEUS_URL, PROMETHEUS_PORT, 'prometheus', env)

interface Hit { url: string; res: Response }

/** First candidate to answer with a 2xx, or null. All are tried at once. */
async function firstOk(bases: string[], path: string, timeoutMs: number): Promise<Hit | null> {
  return new Promise<Hit | null>(resolve => {
    let pending = bases.length
    if (!pending) return resolve(null)
    for (const url of bases) {
      fetch(`${url}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
        .then(res => { if (res.ok) resolve({ url, res }); else if (--pending === 0) resolve(null) })
        .catch(() => { if (--pending === 0) resolve(null) })
    }
  })
}

export async function checkGrafana(bases = grafanaCandidates(), timeoutMs = PROBE_TIMEOUT_MS): Promise<ServiceHealth> {
  const hit = await firstOk(bases, '/api/health', timeoutMs)
  if (!hit) return { state: 'unreachable', connected: false, message: `no answer from ${bases.join(', ')}` }
  const json = await hit.res.json().catch(() => ({})) as any
  return { state: 'connected', connected: true, url: hit.url, version: json.version, message: json.database }
}

export async function checkPrometheus(bases = prometheusCandidates(), timeoutMs = PROBE_TIMEOUT_MS): Promise<ServiceHealth> {
  const hit = await firstOk(bases, '/-/healthy', timeoutMs)
  if (!hit) return { state: 'unreachable', connected: false, message: `no answer from ${bases.join(', ')}` }
  return { state: 'connected', connected: true, url: hit.url, message: 'healthy' }
}

// The base URL other code should query. Cached briefly: power and the metrics
// pages call this on every refresh and should not each probe three addresses.
let promCache: { url: string; at: number } | null = null
const PROM_CACHE_MS = 30_000

export async function resolvePrometheusUrl(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const bases = prometheusCandidates(env)
  if (bases.length === 1) return bases[0]            // explicit override: trust it, even if it is down
  if (promCache && Date.now() - promCache.at < PROM_CACHE_MS) return promCache.url
  const hit = await firstOk(bases, '/-/healthy', PROBE_TIMEOUT_MS)
  if (hit) { promCache = { url: hit.url, at: Date.now() }; return hit.url }
  return bases[0]                                    // nothing answered; the caller's own timeout reports it
}

export function _resetPrometheusCache(): void { promCache = null }

// ── NPM ──────────────────────────────────────────────────────────────────────

/** Rejects after ms instead of waiting on a socket that will never answer. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>
  const timer = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms) })
  return Promise.race([p, timer]).finally(() => clearTimeout(t))
}

/**
 * NPM's state from what the caller found: no credentials at all is
 * 'not-configured' (nothing is wrong, nothing was asked); credentials that did
 * not produce stats is 'unreachable' (something is wrong, and `message` says what).
 */
export function npmHealth(
  input: { configured: boolean; stats?: Record<string, unknown> | null; error?: string | null; url?: string },
): ServiceHealth & Record<string, unknown> {
  if (!input.configured) return { state: 'not-configured', connected: false, message: 'no Nginx Proxy Manager credentials saved' }
  if (!input.stats)      return { state: 'unreachable', connected: false, url: input.url, message: input.error || 'no answer' }
  return { ...input.stats, state: 'connected', connected: true, url: input.url }
}
