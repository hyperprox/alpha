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
  /** The demo only: where to install HyperProx for real. */
  install?:     string
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

/** Only the demo API sends this header, on a change it refused; the event tells the demo layer to explain. */
export const DEMO_REFUSED_HEADER = 'X-HyperProx-Demo-Refused'
export const DEMO_REFUSED_EVENT = 'hyperprox:demo-refused'

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
    // The demo API marks every refused change; one listener (components/demo) shows the "install it" note.
    if (res.headers.get(DEMO_REFUSED_HEADER) === '1') window.dispatchEvent(new CustomEvent(DEMO_REFUSED_EVENT))
    if (path && path.startsWith('/api/') && !path.startsWith('/api/auth/')) {
      if (res.status === 423) goToLogin(true)
      else if (res.status === 401) goToLogin(false)
    }
    return res
  }
}

/** What a person is told when the API itself is not running (nginx's JSON api_down page, or no JSON at all). */
export const API_DOWN_TEXT = "HyperProx's server is restarting or stopped. This page will reconnect by itself."
/** What a person is told when the network request itself failed (offline, the host unreachable). */
export const NO_CONNECTION_TEXT = "Could not reach HyperProx. Check your connection, then try again."
/** A 5xx that came with no sentence of its own. */
export const SERVER_ERROR_TEXT = 'Something went wrong inside HyperProx. Try again in a minute.'

/**
 * Reads whatever error text the API sent, whichever envelope it used. With `status`, a 5xx with no sentence of its
 * own (an HTML error page, an empty body) becomes a plain one, and nginx's api_down answer is recognised. A raw
 * text that looks technical (a stack, a JSON dump, an HTTP status line) is never shown.
 */
export function errorText(body: any, fallback: string, status?: number): string {
  if (body && typeof body === 'object' && body.code === 'api_down') return API_DOWN_TEXT
  const raw = !body || typeof body !== 'object' ? null
    : typeof body.error === 'string' ? body.error
    : typeof body.message === 'string' ? body.message
    : typeof body.error?.message === 'string' ? body.error.message
    : null
  // An admin may be sent the upstream's own answer as `detail` (lib/failure.ts adminDetail): shown after the sentence.
  const detail = body && typeof body === 'object' && typeof body.detail === 'string' && body.detail.trim() ? ` Details: ${body.detail.trim().slice(0, 300)}` : ''
  if (raw && !looksTechnical(raw)) return raw + detail
  if (status === 0) return NO_CONNECTION_TEXT
  if (status === 502 || status === 503 || status === 504) return body && typeof body === 'object' ? SERVER_ERROR_TEXT : API_DOWN_TEXT
  if (status !== undefined && status >= 500) return SERVER_ERROR_TEXT
  return fallback
}

/** Text that is a machine's, not a sentence: a stack frame, a JSON or HTML dump, a bare "HTTP 500" or error class. */
export function looksTechnical(text: string): boolean {
  const t = text.trim()
  return !t || /^\s*[{[<]/.test(t) || /\n\s+at\s|\(?[\w./-]+\.(?:js|ts|mjs|cjs|tsx):\d+:\d+/.test(t) || /^(HTTP\s*)?\d{3}\b/.test(t) ||
    /^(TypeError|SyntaxError|ReferenceError|Error|FetchError|AbortError)\b/.test(t) || /Unexpected token|is not valid JSON|Failed to fetch|NetworkError/i.test(t)
}

/** The request id a failure body carries (lib/failure.ts on the API), for "Reference: …". */
export function requestIdOf(body: any): string | undefined {
  return body && typeof body === 'object' && typeof body.requestId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.requestId) ? body.requestId : undefined
}

/**
 * The words for an error a page caught: a failed fetch, a page that was not JSON, or an Error a page threw with the
 * API's own sentence in it. Never a browser's technical message.
 */
export function failureText(e: unknown, fallback = SERVER_ERROR_TEXT): string {
  const err = e as any
  const name = String(err?.name ?? '')
  const msg = typeof err?.message === 'string' ? err.message : typeof e === 'string' ? e : ''
  if (name === 'TypeError' && /fetch|network|load failed/i.test(msg)) return NO_CONNECTION_TEXT
  if (name === 'SyntaxError') return API_DOWN_TEXT
  if (name === 'AbortError' || name === 'TimeoutError') return 'HyperProx took too long to answer. Try again.'
  return msg && !looksTechnical(msg) ? msg : fallback
}

export interface ApiResult<T = any> {
  ok:     boolean
  status: number
  body:   T | null
  code?:  string
  error?: string
  /** The API's reference for this request (shown as "Reference: …" next to the error). */
  requestId?: string
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
      error: failed ? errorText(body, 'That did not work.', res.status) : undefined,
      requestId: failed ? requestIdOf(body) ?? res.headers.get('x-request-id') ?? undefined : undefined,
    }
  } catch {
    return { ok: false, status: 0, body: null, error: NO_CONNECTION_TEXT }
  }
}
