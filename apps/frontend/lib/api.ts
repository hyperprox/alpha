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

function goToLogin(locked: boolean) {
  if (redirecting || window.location.pathname === '/login') return
  redirecting = true
  const next = window.location.pathname + window.location.search
  const q = new URLSearchParams()
  if (locked) q.set('locked', '1')
  if (next !== '/') q.set('next', next)
  const qs = q.toString()
  window.location.assign('/login' + (qs ? `?${qs}` : ''))
}

/** Idempotent. Call once from a client component on mount. */
export function installAuthInterceptor(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const original = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const res = await original(input, init)
    const path = requestPath(input)
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
export async function apiJson<T = any>(path: string, method = 'GET', payload?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
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
