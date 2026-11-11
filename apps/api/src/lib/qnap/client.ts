// =============================================================================
//  HyperProx — QNAP: one NAS's QTS session
//
//  QTS's CGI API: POST /cgi-bin/authLogin.cgi with the user and the password
//  encoded the way the QTS login page does it (base64, which QTS calls
//  "ezEncode"; it is an encoding, not protection, and the request goes over
//  the LAN, a tailnet, HTTPS or an SSH session). The answer carries a session
//  id (authSid) that every later call names, and the session is logged out at
//  the end of the same batch. So a reading is two round trips: log in, then
//  every read plus the logout.
//
//  The password goes into that one form body and nowhere else: never a URL, an
//  error, a log line or an answer. The session id goes only into query strings
//  of this NAS's own calls.
//
//  Every path is fixed text here. A disk bay is the only value that reaches a
//  path, as a checked integer.
// =============================================================================

import { buildReading, parseLogin, parseSmart, sessionValid, type QnapDisk, type QnapReading, type RawAnswers } from './parse'
import { QnapUnreachableError, type QnapRequest, type QnapResponse, type QnapTransport } from './transport'

/** The reads, by name, in the order they are sent. */
export const READS: Array<[keyof RawAnswers, string]> = [
  ['sysinfo',   '/cgi-bin/management/manaRequest.cgi?subfunc=sysinfo&hd=yes&multicpu=1'],
  ['health',    '/cgi-bin/management/manaRequest.cgi?subfunc=sysinfo&sysHealth=yes'],
  ['usage',     '/cgi-bin/management/chartReq.cgi?chart_func=disk_usage&disk_select=all&include=all'],
  ['smart',     '/cgi-bin/disk/qsmart.cgi?func=all_hd_data'],
  ['firmware',  '/cgi-bin/sys/sysRequest.cgi?subfunc=firm_update'],
  ['bandwidth', '/cgi-bin/management/chartReq.cgi?chart_func=QSM40bandwidth&total=yes'],
  ['shares',    '/cgi-bin/filemanager/utilRequest.cgi?func=get_tree&is_iso=0&node=share_root'],
  // Storage pools exist on storage-v2 firmware only; legacy firmware answers this with an HTML error page.
  ['pools',     '/cgi-bin/disk/disk_manage.cgi?store=poolInfo&func=extra_get&Pool_Info=1'],
]

/** The writes. None of them deletes or changes data. */
export const WRITES = {
  /** A short SMART self-test of one disk (test_type 0 = quick). */
  smartTest: (bay: number) => `/cgi-bin/disk/qsmart.cgi?func=start_test&disk_select=${bay}&test_type=0`,
  restart:   '/cgi-bin/sys/sysRequest.cgi?subfunc=power_mgmt&apply=restart',
  shutdown:  '/cgi-bin/sys/sysRequest.cgi?subfunc=power_mgmt&apply=shutdown',
} as const

const LOGOUT = '/cgi-bin/authLogout.cgi?logout=1'

/** The NAS turned the login down. Never retried automatically: QTS can lock an account after repeated failures. */
export class QnapLoginError extends Error {
  constructor(message: string, public kind: 'refused' | 'two-step' | 'no-answer') { super(message); this.name = 'QnapLoginError' }
}

export interface QnapCredentials { username: string; password: string }

/** QTS's login encoding: base64 of the UTF-8 password. */
export function ezEncode(password: string): string { return Buffer.from(password, 'utf8').toString('base64') }

export function loginForm(c: QnapCredentials): string {
  return new URLSearchParams({ user: c.username, pwd: ezEncode(c.password) }).toString()
}

const withSid = (path: string, sid: string) => `${path}${path.includes('?') ? '&' : '?'}sid=${encodeURIComponent(sid)}`

export interface ActionAnswer { accepted: boolean; detail: string | null }

export class QnapClient {
  constructor(private t: QnapTransport, private c: QnapCredentials, private timeoutMs = 15_000) {}

  get via(): string { return this.t.via }

  private async login(): Promise<string> {
    const [r] = await this.t.batch([{ method: 'POST', path: '/cgi-bin/authLogin.cgi', form: loginForm(this.c) }], this.timeoutMs)
    if (!r || r.status === 0) throw new QnapUnreachableError('The NAS did not answer the login.')
    if (r.status >= 400) throw new QnapLoginError(`The NAS answered the login with HTTP ${r.status}.`, 'no-answer')
    const a = parseLogin(r.text)
    if (a.needs2sv) throw new QnapLoginError('This QNAP user has 2-step verification on, which HyperProx cannot answer. Use a dedicated user without it.', 'two-step')
    if (!a.passed || !a.sid) {
      if (!/<QDocRoot/i.test(r.text)) throw new QnapLoginError('That address answered, but not as a QNAP login.', 'no-answer')
      throw new QnapLoginError('The NAS refused the user name or password.', 'refused')
    }
    return a.sid
  }

  /** Log in, send these calls and a logout in one go, and return the calls' answers. */
  private async session(paths: string[], timeoutMs = this.timeoutMs): Promise<QnapResponse[]> {
    const sid = await this.login()
    const reqs: QnapRequest[] = [...paths.map(p => ({ method: 'GET' as const, path: withSid(p, sid) })), { method: 'GET', path: withSid(LOGOUT, sid) }]
    const res = await this.t.batch(reqs, timeoutMs)
    return res.slice(0, paths.length)
  }

  /** Everything the page shows, in one reading. */
  async read(now = new Date()): Promise<QnapReading> {
    const res = await this.session(READS.map(r => r[1]))
    const raw: RawAnswers = {}
    READS.forEach(([k], i) => { const a = res[i]; raw[k] = a && a.status >= 200 && a.status < 300 ? a.text : null })
    if (raw.sysinfo && !sessionValid(raw.sysinfo)) throw new QnapUnreachableError('The NAS ended the session straight after the login.')
    return buildReading(raw, now)
  }

  /** Start a quick SMART test on one bay, then read that disk back. */
  async smartTest(bay: number): Promise<{ answer: ActionAnswer; disk: QnapDisk | null }> {
    if (!Number.isInteger(bay) || bay < 1 || bay > 255) throw new Error('refused: not a bay number')
    const [r, after] = await this.session([WRITES.smartTest(bay), READS.find(x => x[0] === 'smart')![1]])
    const disk = parseSmart(after?.text ?? null).disks.find(d => d.bay === bay) ?? null
    return { answer: answerOf(r), disk }
  }

  /** Restart or shut down. The logout after it may well go unanswered: the NAS is going away. */
  async power(kind: 'restart' | 'shutdown'): Promise<ActionAnswer> {
    const [r] = await this.session([WRITES[kind]], 20_000)
    return answerOf(r)
  }
}

/** Did QTS take a write? A 2xx answer with a valid session and no error code counts. */
export function answerOf(r: QnapResponse | undefined): ActionAnswer {
  if (!r || r.status === 0) return { accepted: false, detail: 'no answer' }
  if (r.status >= 400) return { accepted: false, detail: `HTTP ${r.status}` }
  if (!sessionValid(r.text)) return { accepted: false, detail: 'session refused' }
  const m = /<(?:result|Result|errorValue|error_code)>\s*(?:<!\[CDATA\[)?\s*(-?\d+)/.exec(r.text)
  if (m && Number(m[1]) < 0) return { accepted: false, detail: `QTS error ${m[1]}` }
  return { accepted: true, detail: null }
}
