// =============================================================================
//  HyperProx — "Sign in with Plex" (Plex's PIN sign-in)
//
//  1. start(): two PINs from plex.tv, a short one (the 4-character code typed at plex.tv/link) and a strong
//     one (for the "sign in in a new tab" link), both made with this install's own client identifier.
//  2. The API checks both PINs at plex.tv every 2 seconds until one carries an account token or they expire.
//     The page only ever asks HyperProx (status()); no token of any kind goes to the browser.
//  3. With the account token: the Plex username and the account's own servers (plex.tv resources). The account
//     token is then dropped: it lives in one local variable for those two calls and is never stored or logged.
//  4. connect(): the chosen server's own token (the resource's accessToken) is tested with one read of /identity
//     at the chosen address, then saved as the plug-in's Plex address and token, through the normal settings save.
//
//  Only an address plex.tv listed for that server is ever tried, so the server token cannot be sent anywhere
//  else. plex.tv and https://*.plex.direct are checked against the normal certificate authorities; plain http
//  works as it does for an address typed by hand. Falling back from the address picked never goes to plain http
//  on a remote address (the token would cross the internet unencrypted); only the person can pick one of those.
//
//  Server tokens are held in memory only while a choice is open: every flow is dropped at its expiresAt by a
//  timer, whatever its state, on a successful save, and all at once when HyperProx locks.
// =============================================================================

import { randomUUID } from 'node:crypto'

export const PLEX_PRODUCT = 'HyperProx'
export const PLEX_TV = 'https://plex.tv'
export const POLL_MS = 2000
/** How long a signed-in flow keeps its servers (and their tokens, in memory) for a choice to be made. */
export const CHOOSE_MS = 15 * 60_000

export interface PlexHttpResult { status: number; ok: boolean; json: () => Promise<any> }
/** One request. Certificates are always verified, and redirects are never followed. */
export type PlexHttp = (method: 'GET' | 'POST', url: string, headers: Record<string, string>, timeoutMs: number) => Promise<PlexHttpResult>

export interface PlexConnection {
  uri: string
  protocol: 'http' | 'https'
  address: string
  port: number
  local: boolean
}

/** A server as the page sees it: no token. */
export interface PlexServerView {
  id: string
  name: string
  version: string
  connections: PlexConnection[]
  /** The connection HyperProx would use: one matching the address already known, else the best local one. */
  preferred: string | null
  /** True when one of its connections is the address discovery (or the current settings) already found. */
  matchesKnown: boolean
}

interface PlexServer extends PlexServerView { accessToken: string }

export type FlowState = 'waiting' | 'signed-in' | 'expired' | 'error' | 'saved'

export interface FlowView {
  id: string
  state: FlowState
  code: string
  linkUrl: string
  authUrl: string
  expiresAt: number
  user?: string
  servers?: PlexServerView[]
  /** The server to preselect. */
  suggested?: string | null
  error?: string
}

export class PlexSigninError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly tried?: Array<{ uri: string; error: string }>, readonly skipped?: string[]) {
    super(message); this.name = 'PlexSigninError'
  }
}

// ── plex.tv answers ──────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

/** Plex.tv's resources list → the account's own servers, each with its token and its connections, best first. */
export function parseResources(body: unknown, known?: string | null): PlexServer[] {
  const rows: any[] = Array.isArray(body) ? body : Array.isArray((body as any)?.MediaContainer?.Device) ? (body as any).MediaContainer.Device : []
  const k = knownHost(known)
  const out: PlexServer[] = []
  for (const r of rows) {
    const provides = str(r?.provides).split(',').map(x => x.trim())
    if (!provides.includes('server')) continue
    if (!(r?.owned === true || r?.owned === 1 || r?.owned === '1')) continue
    const accessToken = str(r?.accessToken)
    const id = str(r?.clientIdentifier)
    if (!accessToken || !id) continue
    const connections = orderConnections((Array.isArray(r?.connections) ? r.connections : []).map(parseConnection).filter((c: PlexConnection | null): c is PlexConnection => !!c))
    const match = k ? bestMatch(connections, k) : undefined
    out.push({
      id, accessToken,
      name: str(r?.name).slice(0, 120) || 'Plex Media Server',
      version: str(r?.productVersion).slice(0, 40),
      connections,
      preferred: match?.uri ?? connections[0]?.uri ?? null,
      matchesKnown: !!match,
    })
  }
  return out
}

function parseConnection(c: any): PlexConnection | null {
  if (c?.relay === true || c?.relay === 1 || c?.relay === '1') return null
  const uri = str(c?.uri)
  let u: URL
  try { u = new URL(uri) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password || (u.pathname && u.pathname !== '/') || u.search || u.hash) return null
  const protocol = u.protocol === 'https:' ? 'https' : 'http'
  return {
    uri: `${u.protocol}//${u.host}`, protocol,
    address: str(c?.address) || u.hostname,
    port: Number(c?.port) || Number(u.port) || (protocol === 'https' ? 443 : 80),
    local: c?.local === true || c?.local === 1 || c?.local === '1',
  }
}

/** Local before remote; within each, https (plex.direct, a certificate that verifies) before plain http. */
export function orderConnections(cs: PlexConnection[]): PlexConnection[] {
  const rank = (c: PlexConnection) => (c.local ? 0 : 2) + (c.protocol === 'https' ? 0 : 1)
  const seen = new Set<string>()
  return cs.filter(c => (seen.has(c.uri) ? false : (seen.add(c.uri), true))).sort((a, b) => rank(a) - rank(b))
}

function knownHost(known?: string | null): { protocol: string | null; host: string; port: number | null } | null {
  if (!known) return null
  try {
    const scheme = /^[a-z]+:\/\//i.test(known)
    const u = new URL(scheme ? known : `http://${known}`)
    return { protocol: scheme ? u.protocol.replace(':', '') : null, host: u.hostname.toLowerCase().replace(/^\[|\]$/g, ''), port: u.port ? Number(u.port) : null }
  } catch { return null }
}

/**
 * The connection that is the address already known: the same address exactly (scheme, host and port) first, then
 * the same host name, then a connection whose IP address is that host (Plex lists its plex.direct names by IP).
 */
function bestMatch(cs: PlexConnection[], k: { protocol: string | null; host: string; port: number | null }): PlexConnection | undefined {
  const portOk = (c: PlexConnection) => k.port === null || k.port === c.port
  const hostOf = (c: PlexConnection) => { try { return new URL(c.uri).hostname.toLowerCase() } catch { return '' } }
  return cs.find(c => portOk(c) && hostOf(c) === k.host && (k.protocol === null || k.protocol === c.protocol))
    ?? cs.find(c => portOk(c) && hostOf(c) === k.host)
    ?? cs.find(c => portOk(c) && c.address.toLowerCase() === k.host)
}

// ── the flows ────────────────────────────────────────────────────────────────

interface Pin { id: string; code: string }

interface Flow {
  id: string
  sid: string
  clientId: string
  short: Pin
  strong: Pin | null
  expiresAt: number
  state: FlowState
  user?: string
  servers?: PlexServer[]
  known: string | null
  error?: string
  timer?: ReturnType<typeof setTimeout>
  /** Drops the flow at expiresAt, whatever its state. */
  endTimer?: ReturnType<typeof setTimeout>
  /** Set while a check of plex.tv is in flight, so two never overlap. */
  busy?: boolean
}

export interface SigninDeps {
  http: PlexHttp
  /** This install's stable Plex client identifier (made once, kept in the plug-in's settings). */
  clientId(): Promise<string>
  /** Save the address and server token as the plug-in's Plex endpoint. */
  save(url: string, serverToken: string): Promise<void>
  audit(action: string, details: Record<string, unknown>): Promise<void>
  log?(msg: string, fields?: Record<string, unknown>): void
  now?(): number
  /** The timer; tests pass their own and drive tick() by hand. */
  schedule?(fn: () => void, ms: number): ReturnType<typeof setTimeout> | undefined
  cancel?(t: ReturnType<typeof setTimeout> | undefined): void
  /** The end-of-life timer (drops a flow at expiresAt); tests pass their own. */
  expire?(fn: () => void, ms: number): ReturnType<typeof setTimeout> | undefined
}

/**
 * Plain http to an address that is not on the local network: the server token would cross the internet
 * unencrypted. Never tried on HyperProx's own initiative, only when the person picked that address.
 */
export const unsafeFallback = (c: PlexConnection): boolean => !c.local && c.protocol === 'http'

const MAX_FLOWS = 20

export class PlexSignin {
  private flows = new Map<string, Flow>()
  constructor(private d: SigninDeps) {}

  private now() { return (this.d.now ?? Date.now)() }

  private headers(clientId: string, token?: string): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json',
      'X-Plex-Product': PLEX_PRODUCT,
      'X-Plex-Client-Identifier': clientId,
    }
    if (token) h['X-Plex-Token'] = token
    return h
  }

  private async newPin(clientId: string, strong: boolean): Promise<{ id: string; code: string; expiresAt: number }> {
    const r = await this.d.http('POST', `${PLEX_TV}/api/v2/pins?strong=${strong}`, this.headers(clientId), 10_000)
    if (!r.ok) throw new PlexSigninError(502, 'plex_tv', `plex.tv did not give a sign-in code (HTTP ${r.status}). Try again in a minute.`)
    const b = await r.json().catch(() => null)
    const id = str(b?.id), code = str(b?.code)
    if (!id || !code) throw new PlexSigninError(502, 'plex_tv', 'plex.tv answered without a sign-in code. Try again in a minute.')
    const secs = Number(b?.expiresIn) > 0 ? Number(b.expiresIn) : 900
    const at = Date.parse(str(b?.expiresAt))
    return { id, code, expiresAt: Number.isFinite(at) ? Math.min(at, this.now() + secs * 1000) : this.now() + secs * 1000 }
  }

  /** A new sign-in for this session. Any earlier one of the same session is cancelled. */
  async start(sid: string, known?: string | null): Promise<FlowView> {
    this.sweep()
    for (const f of this.flows.values()) if (f.sid === sid) this.drop(f)
    if (this.flows.size >= MAX_FLOWS) throw new PlexSigninError(429, 'slow_down', 'Too many Plex sign-ins are open at once. Try again in a few minutes.')
    let clientId: string
    try { clientId = await this.d.clientId() } catch { throw new PlexSigninError(500, 'client_id', 'HyperProx could not read or save its Plex client identifier.') }
    let short: Awaited<ReturnType<PlexSignin['newPin']>>
    try { short = await this.newPin(clientId, false) } catch (e) {
      if (e instanceof PlexSigninError) throw e
      throw new PlexSigninError(502, 'plex_tv', 'HyperProx could not reach plex.tv to get a sign-in code. Check this server can reach the internet.')
    }
    // The strong PIN is only for the new-tab link: without it, the 4-character code still works.
    const strong = await this.newPin(clientId, true).catch(() => null)
    const flow: Flow = {
      id: randomUUID(), sid, clientId,
      short: { id: short.id, code: short.code },
      strong: strong ? { id: strong.id, code: strong.code } : null,
      expiresAt: short.expiresAt, state: 'waiting',
      known: typeof known === 'string' && known.trim() ? known.trim().slice(0, 300) : null,
    }
    this.flows.set(flow.id, flow)
    this.arm(flow)
    this.later(flow)
    return this.view(flow)
  }

  /** (Re)set the timer that drops this flow, and every token it holds, at its expiresAt. */
  private arm(flow: Flow) {
    ;(this.d.cancel ?? clearTimeout)(flow.endTimer as any)
    const expire = this.d.expire ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
    flow.endTimer = expire(() => { if (this.flows.get(flow.id) === flow) this.drop(flow) }, Math.max(0, flow.expiresAt - this.now()))
  }

  /** Forget every sign-in at once (HyperProx locked): no server token is held past a lock. */
  dropAll(): void {
    for (const f of [...this.flows.values()]) this.drop(f)
  }

  private later(flow: Flow) {
    const schedule = this.d.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
    flow.timer = schedule(() => { void this.tick(flow.id) }, POLL_MS)
  }

  /** One check of plex.tv for this flow. Public so tests can drive it. */
  async tick(id: string): Promise<void> {
    const flow = this.flows.get(id)
    if (!flow || flow.state !== 'waiting' || flow.busy) return
    if (this.now() >= flow.expiresAt) { this.drop(flow); return }
    flow.busy = true
    try {
      let accountToken = ''
      let gone = 0
      for (const pin of [flow.short, flow.strong]) {
        if (!pin || accountToken) continue
        const r = await this.d.http('GET', `${PLEX_TV}/api/v2/pins/${encodeURIComponent(pin.id)}`, this.headers(flow.clientId), 10_000).catch(() => null)
        if (!r) continue
        if (r.status === 404) { gone++; continue }
        if (!r.ok) continue
        const b = await r.json().catch(() => null)
        accountToken = str(b?.authToken)
      }
      if (!accountToken) {
        if (gone && gone === [flow.short, flow.strong].filter(Boolean).length) flow.state = 'expired'
        return
      }
      await this.signedIn(flow, accountToken)
      accountToken = ''
    } finally {
      flow.busy = false
      if (flow.state === 'waiting' && this.flows.has(flow.id)) this.later(flow)
    }
  }

  /** The account token is used for these two reads and nothing else, and goes out of scope with this call. */
  private async signedIn(flow: Flow, accountToken: string): Promise<void> {
    try {
      const h = this.headers(flow.clientId, accountToken)
      const [u, res] = await Promise.all([
        this.d.http('GET', `${PLEX_TV}/api/v2/user`, h, 10_000).catch(() => null),
        this.d.http('GET', `${PLEX_TV}/api/v2/resources?includeHttps=1&includeRelay=0`, h, 15_000),
      ])
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const user = u?.ok ? await u.json().catch(() => null) : null
      flow.user = (str(user?.username) || str(user?.title) || 'your Plex account').slice(0, 80)
      flow.servers = parseResources(await res.json(), flow.known)
      flow.state = 'signed-in'
      if (!flow.servers.length) {
        flow.state = 'error'
        flow.error = `You signed in as ${flow.user}, but that Plex account owns no Plex server. Sign in with the account that owns the server, or enter the address and token by hand.`
        flow.servers = undefined
      }
    } catch {
      flow.state = 'error'
      flow.error = 'You signed in, but HyperProx could not read your Plex servers from plex.tv. Try again with a new code.'
      flow.servers = undefined
    }
    // Signed in (or failed after signing in): a fresh window to choose a server or read the error, then dropped.
    flow.expiresAt = this.now() + CHOOSE_MS
    if (this.flows.get(flow.id) === flow) this.arm(flow)
    this.d.log?.('[plex] sign-in: account signed in', { user: flow.user, servers: flow.servers?.length ?? 0 })
  }

  private own(id: string, sid: string): Flow {
    this.sweep()
    const f = this.flows.get(id)
    if (!f || f.sid !== sid) throw new PlexSigninError(404, 'no_signin', 'That Plex sign-in has ended. Start again.')
    return f
  }

  status(id: string, sid: string): FlowView {
    return this.view(this.own(id, sid))
  }

  cancel(id: string, sid: string): void {
    const f = this.flows.get(id)
    if (f && f.sid === sid) this.drop(f)
  }

  /** Test the chosen server at the chosen address (then its other listed ones), and save the first that answers. */
  async connect(id: string, sid: string, by: string, serverId: unknown, uri: unknown): Promise<{ url: string; server: string; user: string; tried: Array<{ uri: string; error: string }>; note?: string }> {
    const f = this.own(id, sid)
    if (f.state !== 'signed-in' || !f.servers) throw new PlexSigninError(409, 'not_signed_in', f.state === 'waiting' ? 'Plex has not confirmed the sign-in yet.' : 'This sign-in cannot be used. Start again.')
    const server = f.servers.find(s => s.id === serverId)
    if (!server) throw new PlexSigninError(400, 'no_server', 'Choose one of the servers shown.')
    if (uri !== undefined && uri !== null && uri !== '' && !server.connections.some(c => c.uri === uri)) {
      throw new PlexSigninError(400, 'no_connection', 'Choose one of the addresses shown for that server.')
    }
    // The address picked is tried whatever it is; the fallback never sends the token over plain http to a remote address.
    const others = server.connections.filter(c => c.uri !== uri)
    const order = [...server.connections.filter(c => c.uri === uri), ...others.filter(c => !unsafeFallback(c))]
    const skipped = others.filter(unsafeFallback).map(c => c.uri)
    if (!order.length) {
      throw new PlexSigninError(502, 'unreachable', server.connections.length
        ? `${server.name}'s only addresses are plain http over the internet, which would send its token unencrypted. Choose one yourself if you accept that, or enter an address by hand.`
        : `plex.tv lists no address for ${server.name}. Enter its address and token by hand instead.`, [], skipped)
    }
    const tried: Array<{ uri: string; error: string }> = []
    for (const c of order) {
      const err = await this.identity(c.uri, server)
      if (err) { tried.push({ uri: c.uri, error: err }); continue }
      await this.d.save(c.uri, server.accessToken)
      const user = f.user ?? 'your Plex account'
      // Saved: the flow, and the server token it held, end here whatever the audit does.
      f.state = 'saved'
      this.drop(f)
      let note: string | undefined
      try {
        await this.d.audit('plex.signin', {
          message: `Plex signed in as ${user}, server ${server.name}`, user, server: server.name, address: c.uri, by,
        })
      } catch {
        note = 'The server was saved, but the audit log row for this sign-in could not be written.'
      }
      this.d.log?.('[plex] sign-in: server saved', { server: server.name, address: c.uri, audited: !note })
      return { url: c.uri, server: server.name, user, tried, ...(note ? { note } : {}) }
    }
    throw new PlexSigninError(502, 'unreachable', `HyperProx could not reach ${server.name} at any of its addresses. Check the server is on and that HyperProx can reach it, or enter its address by hand.`, tried, skipped)
  }

  /** null when the address answers /identity with this server's own identifier; otherwise why not, in words. */
  private async identity(base: string, server: PlexServer): Promise<string | null> {
    try {
      const r = await this.d.http('GET', `${base}/identity`, { Accept: 'application/json', 'X-Plex-Token': server.accessToken }, 6000)
      if (r.status === 401 || r.status === 403) return 'the server refused the sign-in'
      if (!r.ok) return `the server answered HTTP ${r.status}`
      const b = await r.json().catch(() => null)
      const machine = str(b?.MediaContainer?.machineIdentifier)
      if (!machine) return 'that address did not answer like a Plex server'
      if (machine !== server.id) return 'a different Plex server answered at that address'
      return null
    } catch (e: any) {
      const m = String(e?.cause?.code ?? e?.code ?? e?.message ?? '')
      if (/CERT|SSL|TLS|self.signed|UNABLE_TO_VERIFY/i.test(m)) return 'its certificate could not be verified'
      if (/timed out|abort|timeout/i.test(m)) return 'no answer in time'
      if (/redirect/i.test(m)) return 'it answered with a redirect'
      return 'could not connect'
    }
  }

  private view(f: Flow): FlowView {
    const v: FlowView = {
      id: f.id, state: f.state, code: f.short.code,
      linkUrl: 'https://plex.tv/link',
      authUrl: f.strong ? authUrl(f.clientId, f.strong.code) : '',
      expiresAt: f.expiresAt,
    }
    if (f.user) v.user = f.user
    if (f.error) v.error = f.error
    if (f.state === 'expired') v.error = 'The code expired before it was used. Get a new code and try again.'
    if (f.servers) {
      v.servers = f.servers.map(({ accessToken: _t, ...rest }) => ({ ...rest, connections: rest.connections.map(c => ({ ...c })) }))
      v.suggested = (f.servers.find(s => s.matchesKnown) ?? f.servers[0])?.id ?? null
    }
    return v
  }

  private drop(f: Flow) {
    ;(this.d.cancel ?? clearTimeout)(f.timer as any)
    ;(this.d.cancel ?? clearTimeout)(f.endTimer as any)
    f.servers = undefined
    this.flows.delete(f.id)
  }

  /** The end timer's backstop: any flow past its expiresAt is dropped, whatever its state. */
  private sweep() {
    const now = this.now()
    for (const f of [...this.flows.values()]) if (now >= f.expiresAt) this.drop(f)
  }

  /** For tests: how many flows are held. */
  get size(): number { return this.flows.size }
}

export function authUrl(clientId: string, code: string): string {
  const q = new URLSearchParams()
  q.set('clientID', clientId)
  q.set('code', code)
  q.set('context[device][product]', PLEX_PRODUCT)
  return `https://app.plex.tv/auth#?${q.toString()}`
}
