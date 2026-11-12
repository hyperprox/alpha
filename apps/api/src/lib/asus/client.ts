// =============================================================================
//  HyperProx — ASUS router: one router's admin session
//
//  The ASUS app protocol: POST /login.cgi with login_authorization set to
//  base64("user:password") — an encoding, not protection, which is why an
//  https router is pinned and http is allowed only on a private address. A
//  good login answers {"asus_token": "..."}; that token goes back as the
//  asus_token cookie on every appGet.cgi / applyapp.cgi call and is ended with
//  Logout.asp.
//
//  Asuswrt holds ONE admin session. So a token is reused while readings keep
//  coming (the page polls), and the session is logged out once it has been
//  idle for a short while (endIfIdle), rather than logging in and out every
//  ten seconds and filling the router's log.
//
//  A login is never retried on its own. What the router says about a refused
//  login (error_status) is turned into a reason and handed up, and the service
//  holds that router until the login is saved again or the router's own
//  lockout has passed:
//     3  wrong user or password       7  locked out for remaining_lock_time s
//     9  someone else is signed in    10 the router wants a CAPTCHA
//     11 the router needs a password reset
//  A token the router has since dropped (error_status 2 or 8 on a later call)
//  gets exactly one fresh login with the password that just worked.
// =============================================================================

import { looseJson } from './parse'
import { AsusUnreachableError, type AsusTransport } from './transport'

export type LoginErrorKind = 'refused' | 'locked' | 'busy' | 'captcha' | 'reset' | 'not-asus'

export class AsusLoginError extends Error {
  constructor(message: string, public kind: LoginErrorKind, public retryAfterSec: number | null = null) {
    super(message); this.name = 'AsusLoginError'
  }
}

export interface AsusCredentials { username: string; password: string }

export function loginBody(c: AsusCredentials): string {
  return 'login_authorization=' + encodeURIComponent(Buffer.from(`${c.username}:${c.password}`, 'utf8').toString('base64'))
}

const TOKEN_RE = /^[A-Za-z0-9+/=_-]{1,256}$/
const errorStatus = (j: Record<string, any> | null): number | null => {
  const v = j?.error_status
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,3}$/.test(v.trim()) ? Number(v) : null
  return n
}

/** A login answer as a token, or the reason it was refused. Pure. */
export function readLogin(status: number, text: string): { token: string } | AsusLoginError {
  const j = looseJson(text)
  const tok = j?.asus_token
  if (status >= 200 && status < 300 && typeof tok === 'string' && TOKEN_RE.test(tok)) return { token: tok }
  switch (errorStatus(j)) {
    case 2: case 3: return new AsusLoginError('The router refused the user name or password.', 'refused')
    case 7: {
      const s = Number(j?.remaining_lock_time)
      const secs = Number.isFinite(s) && s > 0 && s < 86_400 ? Math.ceil(s) : null
      return new AsusLoginError(`The router has locked logins after too many failures${secs ? ` for another ${Math.ceil(secs / 60)} min` : ''}.`, 'locked', secs)
    }
    case 9: return new AsusLoginError('Someone is signed in to the router\'s web page, and ASUS allows one admin session at a time.', 'busy', 60)
    case 10: return new AsusLoginError('The router is asking for a CAPTCHA after failed logins. Sign in once on its own web page, then save the login here again.', 'captcha')
    case 11: return new AsusLoginError('The router wants its admin password changed before anything signs in. Change it on the router, then save the new one here.', 'reset')
  }
  return new AsusLoginError('That address answered, but not as an ASUS router login.', 'not-asus')
}

export interface ActionAnswer { accepted: boolean; detail: string | null }

const expired = (status: number, j: Record<string, any> | null) =>
  status === 401 || status === 403 || errorStatus(j) === 2 || errorStatus(j) === 8

export class AsusClient {
  private token: string | null = null
  private lastUsed = 0
  /** How many logins this client has sent: tests read it, and nothing retries one. */
  logins = 0

  constructor(private t: AsusTransport, private c: AsusCredentials, private o: { now?: () => number; timeoutMs?: number } = {}) {}

  private now(): number { return (this.o.now ?? Date.now)() }

  hasSession(): boolean { return this.token !== null }

  private async login(): Promise<string> {
    this.logins++
    let r
    try { r = await this.t.send({ method: 'POST', path: '/login.cgi', body: loginBody(this.c) }, this.o.timeoutMs) }
    catch (e) { throw e instanceof AsusUnreachableError ? e : new AsusUnreachableError('The router did not answer the login.') }
    const a = readLogin(r.status, r.text)
    if (a instanceof AsusLoginError) throw a
    this.token = a.token
    this.lastUsed = this.now()
    return a.token
  }

  /** POST to a fixed path with the session token; one fresh login if the router had dropped the session. */
  private async call(path: string, body: string, contentType?: string, timeoutMs?: number): Promise<{ status: number; text: string; json: Record<string, any> | null }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = this.token ?? await this.login()
      const r = await this.t.send({ method: 'POST', path, body, contentType, token }, timeoutMs ?? this.o.timeoutMs)
      const json = looseJson(r.text)
      if (expired(r.status, json) && attempt === 0) { this.token = null; continue }
      this.lastUsed = this.now()
      return { ...r, json }
    }
    throw new AsusUnreachableError('The router keeps ending the session straight after the login.')
  }

  /** One appGet.cgi call. The hook text is a fixed string from parse.ts HOOKS. Null when that call had no good answer. */
  async hook(hooks: string): Promise<string | null> {
    if (/[&=\r\n]/.test(hooks)) throw new Error('refused: not a hook list')
    const r = await this.call('/appGet.cgi', `hook=${hooks}`)
    return r.status >= 200 && r.status < 300 ? r.text : null
  }

  /** Reboot. The router may well drop the connection as it goes down; that is "unconfirmed", not a failure. */
  async reboot(): Promise<ActionAnswer> {
    try {
      const r = await this.call('/applyapp.cgi', JSON.stringify({ action_mode: 'apply', rc_service: 'reboot' }), 'application/json', 20_000)
      if (r.status >= 400) return { accepted: false, detail: `HTTP ${r.status}` }
      if (r.json?.run_service === 'reboot') return { accepted: true, detail: null }
      return { accepted: false, detail: 'the router did not confirm it' }
    } catch (e) {
      if (e instanceof AsusLoginError) throw e
      return { accepted: false, detail: 'no answer (it may already be restarting)' }
    } finally {
      // The router is going away: its session goes with it.
      this.token = null
    }
  }

  /** End the session. Never throws: a router that has gone away has ended it already. */
  async logout(): Promise<void> {
    const token = this.token
    this.token = null
    if (!token) return
    await this.t.send({ method: 'GET', path: '/Logout.asp', token }, 5_000).catch(() => {})
  }

  /** Log out when the session has been unused for `idleMs`. Returns true when it did. */
  async endIfIdle(idleMs: number): Promise<boolean> {
    if (!this.token || this.now() - this.lastUsed < idleMs) return false
    await this.logout()
    return true
  }
}
