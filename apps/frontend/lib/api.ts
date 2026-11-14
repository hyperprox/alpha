// =============================================================================
//  Vault gate — client plumbing
//
//  Pages call plain fetch('/api/...') all over the app, so the gate's two
//  refusals are handled once, at the bottom: window.fetch is wrapped.
//    423  HyperProx is locked (auto-lock, `lock now`, or a restart)  -> /login?locked=1
//    401  no valid session                                            -> /login
//  /api/auth/* is exempt: a wrong password there is a 401 the sign-in form must
//  show, not a reason to bounce the user back to the page they are already on.
//  The response is still handed back to the caller, so nothing downstream
//  changes shape.
// =============================================================================

export type Role = 'owner' | 'admin' | 'operator' | 'viewer'

export interface AuthStatus {
  locked:       boolean
  bootstrapped: boolean
  reachable:    boolean
  user?:        { email: string; role: Role }
  /** Only the demo API (apps/api/src/demo) sends this: invented data, every change refused. */
  demo?:        boolean
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 }

/** True when `role` is at least `min`. An unknown role (not signed in yet) is nothing. */
export function atLeast(role: Role | undefined, min: Role): boolean {
  return role !== undefined && ROLE_RANK[role] >= ROLE_RANK[min]
}

let installed = false
let redirecting = false

function requestPath(input: RequestInfo | URL): string | null {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const u = new URL(raw, window.location.origin)
    return u.origin === window.location.origin ? u.pathname : null
  } catch { return null }
}

/** Pages that work without a session: the sign-in page, and the invite page (its token rides in the #hash,
 *  which a bounce to /login would throw away). Nothing sends them to sign in. */
export const PUBLIC_PATHS = ['/login', '/join']

export function isPublicPath(pathname: string | null | undefined): boolean {
  return !!pathname && PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))
}

function goToLogin(locked: boolean) {
  if (redirecting || isPublicPath(window.location.pathname)) return
  redirecting = true
  const next = window.location.pathname + window.location.search
  const q = new URLSearchParams()
  if (locked) q.set('locked', '1')
  if (next !== '/') q.set('next', next)
  const qs = q.toString()
  window.location.assign('/login' + (qs ? `?${qs}` : ''))
}

/**
 * The remote cluster the current page is for, from its URL (/clusters/<id>/...), or null. The cluster follows
 * the page, never a remembered choice, so leaving a remote cluster's page can never leave later home pages
 * acting on it.
 */
export function pageClusterId(pathname: string): string | null {
  const m = /^\/clusters\/(c[0-9a-f]{10})(\/|$)/.exec(pathname)
  return m ? m[1] : null
}

export const CLUSTER_HEADER = 'X-HyperProx-Cluster'

/** Idempotent. Call once from a client component on mount. */
export function installAuthInterceptor(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const original = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const path = requestPath(input)
    // On a remote cluster's pages every API call is about that cluster (lib/clusters/context.ts on the API).
    const cluster = pageClusterId(window.location.pathname)
    if (cluster && path && path.startsWith('/api/') && !path.startsWith('/api/auth/') && !path.startsWith('/api/clusters')) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      if (!headers.has(CLUSTER_HEADER)) headers.set(CLUSTER_HEADER, cluster)
      init = { ...(init ?? {}), headers }
    }
    const res = await original(input, init)
    if (path && path.startsWith('/api/') && !path.startsWith('/api/auth/')) {
      if (res.status === 423) goToLogin(true)
      else if (res.status === 401) goToLogin(false)
    }
    return res
  }
}

/** Reads whatever error text the API sent, whichever envelope it used. */
export function errorText(body: any, fallback: string): string {
  if (!body) return fallback
  if (typeof body.error === 'string') return body.error
  if (typeof body.message === 'string') return body.message
  if (typeof body.error?.message === 'string') return body.error.message
  return fallback
}

export interface ApiResult<T = any> {
  ok:     boolean
  status: number
  body:   T | null
  code?:  string
  error?: string
}

/** JSON request that never throws: network failure becomes status 0. */
export async function apiJson<T = any>(path: string, method = 'GET', payload?: unknown, extraHeaders?: Record<string, string>): Promise<ApiResult<T>> {
  try {
    const headers = { ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...(extraHeaders ?? {}) }
    const res = await fetch(path, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body:    payload === undefined ? undefined : JSON.stringify(payload),
    })
    const body = await res.json().catch(() => null)
    const failed = !res.ok || body?.ok === false || body?.success === false
    return {
      ok: !failed, status: res.status, body,
      code:  typeof body?.code === 'string' ? body.code : undefined,
      error: failed ? errorText(body, `Request failed (${res.status})`) : undefined,
    }
  } catch {
    return { ok: false, status: 0, body: null, error: 'Could not reach the API' }
  }
}
