// =============================================================================
//  HyperProx — Proxy providers: the HTTP client they share
//  One place for timeouts, auth headers and error text. Errors name the method,
//  path and status, never a credential or a full response body.
// =============================================================================

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface HttpAuth {
  basic?:  { user: string; password: string }
  bearer?: string
  /** Extra headers on every request (e.g. Pangolin's CSRF header is not needed on the integration API). */
  headers?: Record<string, string>
}

export class ProxyHttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) { super(message); this.name = 'ProxyHttpError' }
}

export interface HttpResult<T> { status: number; headers: Headers; body: T }

const DEFAULT_TIMEOUT_MS = 15_000

export class ProxyHttp {
  private base: string
  constructor(base: string, private auth: HttpAuth = {}, private fetchImpl: FetchLike = fetch, private label = 'proxy',
              private timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.base = base.replace(/\/+$/, '')
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...(this.auth.headers ?? {}), ...extra }
    if (this.auth.basic) h.Authorization = 'Basic ' + Buffer.from(`${this.auth.basic.user}:${this.auth.basic.password}`).toString('base64')
    if (this.auth.bearer) h.Authorization = `Bearer ${this.auth.bearer}`
    return h
  }

  async raw(method: string, path: string, opts: { body?: unknown; text?: string; headers?: Record<string, string>; okStatuses?: number[] } = {}): Promise<HttpResult<string>> {
    const headers = this.headers(opts.headers)
    let body: string | undefined
    if (opts.text !== undefined) { body = opts.text; headers['Content-Type'] ??= 'text/plain' }
    else if (opts.body !== undefined) { body = JSON.stringify(opts.body); headers['Content-Type'] ??= 'application/json' }
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs)
    let res: Response
    try {
      // Never follow a redirect: it would carry the credentials to wherever the answer points.
      res = await this.fetchImpl(this.base + path, { method, headers, body, signal: ctl.signal, redirect: 'manual' })
    } catch (e: any) {
      const why = e?.name === 'AbortError' ? `no answer within ${this.timeoutMs / 1000}s` : (e?.cause?.code ?? e?.message ?? String(e))
      throw new ProxyHttpError(`${this.label}: ${method} ${path} could not be sent (${why})`, 0, '')
    } finally { clearTimeout(timer) }
    const text = await res.text()
    const ok = opts.okStatuses ? opts.okStatuses.includes(res.status) : res.ok
    if (res.status >= 300 && res.status < 400 && !(opts.okStatuses ?? []).includes(res.status)) {
      throw new ProxyHttpError(`${this.label}: ${method} ${path} answered with a redirect (${res.status}); HyperProx does not follow redirects`, res.status, '')
    }
    if (!ok) {
      throw new ProxyHttpError(`${this.label}: ${method} ${path} answered ${res.status}${summarise(text)}`, res.status, text)
    }
    return { status: res.status, headers: res.headers, body: text }
  }

  async json<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResult<T>> {
    const r = await this.raw(method, path, { body, headers })
    let parsed: any = null
    if (r.body.trim()) {
      try { parsed = JSON.parse(r.body) } catch { throw new ProxyHttpError(`${this.label}: ${method} ${path} did not answer JSON`, r.status, '') }
    }
    return { status: r.status, headers: r.headers, body: parsed as T }
  }

  async get<T>(path: string): Promise<T> { return (await this.json<T>('GET', path)).body }
}

/** A short reason from an error body: a JSON message field if there is one, else the first line, capped. */
function summarise(text: string): string {
  if (!text) return ''
  let msg = ''
  try {
    const j = JSON.parse(text)
    msg = String(j?.message ?? j?.error?.message ?? j?.error ?? '')
  } catch { msg = text.split('\n')[0] }
  msg = msg.replace(/\s+/g, ' ').trim().slice(0, 300)
  return msg ? `: ${msg}` : ''
}
