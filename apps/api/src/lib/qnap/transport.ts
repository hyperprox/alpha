// =============================================================================
//  HyperProx — QNAP: how a request reaches a NAS
//
//  Two ways, behind one interface (QnapTransport.batch: several requests, the
//  answers in the same order):
//
//    direct    HyperProx makes the HTTP request itself, to the address checked
//              by target.ts at that moment, with the certificate pin if one is
//              set, no redirects and one deadline per request.
//
//    cluster   The NAS sits on a remote cluster's LAN that HyperProx cannot
//              route to. HyperProx already has an SSH login to that cluster's
//              nodes (the same pinned, audited login file copies and updates
//              use, lib/node-exec.ts). One SSH session runs `bash -s` on the
//              node; the script is curl calls and nothing else, and only the
//              answers come back. Nothing is installed or left running on the
//              node, no port is opened, no relay exists between calls.
//
//              The script arrives on stdin, never on a command line, and each
//              curl reads its URL and form body from a here-document (`-K -`),
//              so the NAS password and session id never appear in the node's
//              process list. Every script passes the remote-script guard
//              (lib/clusters/script-guard.ts) like every other one.
// =============================================================================

import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import net from 'node:net'
import { PinnedAgent, CertificateChangedError } from '../clusters/tls-pin'
import { QnapTargetError, resolveQnapTarget, type TargetResolver } from './target'

export interface QnapRequest {
  method: 'GET' | 'POST'
  /** Path and query, already encoded: "/cgi-bin/...?a=b". */
  path:   string
  /** application/x-www-form-urlencoded body, already encoded. */
  form?:  string
}

export interface QnapResponse { status: number; text: string }

export interface QnapTransport {
  /** Run the requests in order. A request that failed on its own comes back with status 0. */
  batch(reqs: QnapRequest[], timeoutMs?: number): Promise<QnapResponse[]>
  /** Plain words for where this goes, for errors and the audit log ("direct", "through <cluster>"). */
  readonly via: string
}

export class QnapUnreachableError extends Error {
  constructor(message: string) { super(message); this.name = 'QnapUnreachableError' }
}

/** The most HyperProx reads from one answer. */
export const MAX_ANSWER_BYTES = 4 * 1024 * 1024

/** Strip anything address-, password- or session-shaped out of an error before it is shown. */
export function plainError(e: any): QnapUnreachableError {
  if (e instanceof QnapUnreachableError) return e
  if (e instanceof QnapTargetError) return new QnapUnreachableError(`NAS address refused: ${e.message}`)
  if (e instanceof CertificateChangedError) return new QnapUnreachableError('The NAS presented a different certificate from the one you pinned, so HyperProx sent it nothing. Pin the new one in Settings if it was renewed on purpose.')
  const code = e?.code ?? e?.cause?.code
  const why = code === 'ECONNREFUSED' ? 'connection refused'
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'the address does not resolve'
    : code === 'ETIMEDOUT' || /timed out|abort/i.test(String(e?.message)) ? 'it did not answer in time'
    : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? 'no route to it'
    : /too large/i.test(String(e?.message)) ? 'its answer was too large'
    : /certificate|self.signed|CERT_/i.test(String(e?.message ?? code)) ? 'its certificate is not trusted (pin it in Settings, or accept a self-signed certificate)'
    : 'it could not be reached'
  return new QnapUnreachableError(`The NAS is unreachable: ${why}.`)
}

// ── direct ───────────────────────────────────────────────────────────────────

export interface DirectOptions { url: string; insecureTLS: boolean; fingerprint: string | null; resolve?: TargetResolver }

export class DirectTransport implements QnapTransport {
  readonly via = 'direct'
  private base: URL
  constructor(private o: DirectOptions) {
    this.base = new URL(o.url.replace(/\/+$/, '') + '/')
    if (!['http:', 'https:'].includes(this.base.protocol)) throw new QnapUnreachableError('The NAS address must start with http:// or https://.')
  }

  private async one(r: QnapRequest, timeoutMs: number): Promise<QnapResponse> {
    const u = new URL(r.path.replace(/^\//, ''), this.base)
    const address = await (this.o.resolve ?? resolveQnapTarget)(u)
    const mod = u.protocol === 'https:' ? https : http
    const opts: https.RequestOptions = {
      host: address, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: r.method, timeout: timeoutMs,
      headers: { Host: u.host, Accept: '*/*', ...(r.form !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(r.form)) } : {}) },
    }
    if (u.protocol === 'https:') {
      if (!net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) opts.servername = u.hostname
      if (this.o.fingerprint) opts.agent = new PinnedAgent(this.o.fingerprint)
      else opts.rejectUnauthorized = !this.o.insecureTLS
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (err: Error | null, v?: QnapResponse) => {
        if (settled) return
        settled = true; clearTimeout(deadline)
        err ? reject(err) : resolve(v!)
      }
      const req = mod.request(opts, res => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => { size += c.length; if (size > MAX_ANSWER_BYTES) { req.destroy(new Error('answer too large')); return } chunks.push(c) })
        res.on('end', () => done(null, { status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', e => done(e))
      })
      const deadline = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs)
      req.on('timeout', () => req.destroy(new Error('timed out')))
      req.on('error', e => done(e))
      if (r.form !== undefined) req.write(r.form)
      req.end()
    })
  }

  async batch(reqs: QnapRequest[], timeoutMs = 15_000): Promise<QnapResponse[]> {
    const out: QnapResponse[] = []
    for (let i = 0; i < reqs.length; i++) {
      try { out.push(await this.one(reqs[i], timeoutMs)) }
      catch (e) {
        // The first request failing means the NAS is not there: say why. A later one failing is that call only.
        if (i === 0) throw plainError(e)
        out.push({ status: 0, text: '' })
      }
    }
    return out
  }
}

// ── through a remote cluster's node ──────────────────────────────────────────

/** Runs a script on a remote cluster's node over HyperProx's saved login; resolves with its output. */
export type NodeScriptRunner = (script: string, timeoutMs: number) => Promise<{ code: number; output: string }>

export interface ClusterOptions { url: string; insecureTLS: boolean; clusterName: string; run: NodeScriptRunner }

const MARK = '@@hpx-qnap'

/** A curl config value: double-quoted, with backslash and quote escaped. Newlines can never be in one. */
function cfgValue(v: string): string {
  if (/[\r\n\u0000]/.test(v)) throw new QnapUnreachableError('Refused: a request value contained a line break.')
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The script one batch runs on the node. Pure, so tests can read exactly what a node would run. `tag` makes the
 * here-document delimiter unguessable, so nothing in a request can end it early.
 */
export function clusterScript(base: URL, reqs: QnapRequest[], o: { insecureTLS: boolean; timeoutSec: number; tag: string }): string {
  if (!/^[a-f0-9]{16}$/.test(o.tag)) throw new Error('bad tag')
  const lines = ['set -u', 'command -v curl >/dev/null 2>&1 || { echo "' + MARK + ' nocurl"; exit 0; }']
  reqs.forEach((r, i) => {
    const u = new URL(r.path.replace(/^\//, ''), base)
    const cfg = [
      `url = ${cfgValue(u.toString())}`,
      'silent', 'show-error',
      `max-time = ${Math.max(1, Math.min(120, Math.round(o.timeoutSec)))}`,
      `max-filesize = ${MAX_ANSWER_BYTES}`,
      'proto = "=http,https"',
      // \n here is curl's own escape inside a quoted config value (a backslash and an n, not a line break).
      `write-out = "\\n${MARK} status ${i} %{http_code}\\n"`,
      ...(o.insecureTLS ? ['insecure'] : []),
      ...(r.form !== undefined ? [`data = ${cfgValue(r.form)}`] : []),
    ]
    lines.push(`echo "${MARK} begin ${i}"`, `curl -K - <<'HPXQ_${o.tag}'`, ...cfg, `HPXQ_${o.tag}`, `echo "${MARK} end ${i} $?"`)
  })
  return lines.join('\n') + '\n'
}

/** Read the answers back out of the node's output. A request with no clean answer is status 0. */
export function parseClusterOutput(out: string, count: number): QnapResponse[] {
  if (out.includes(`${MARK} nocurl`)) throw new QnapUnreachableError('The remote server has no curl, so it cannot reach the NAS for HyperProx.')
  const res: QnapResponse[] = []
  for (let i = 0; i < count; i++) {
    const b = out.indexOf(`${MARK} begin ${i}\n`)
    const s = b < 0 ? -1 : out.indexOf(`\n${MARK} status ${i} `, b)
    if (b < 0 || s < 0) { res.push({ status: 0, text: '' }); continue }
    const text = out.slice(b + `${MARK} begin ${i}\n`.length, s)
    const status = Number(/^(\d{3})/.exec(out.slice(s + `\n${MARK} status ${i} `.length))?.[1] ?? 0)
    res.push({ status, text: status ? text : '' })
  }
  return res
}

export class ClusterTransport implements QnapTransport {
  readonly via: string
  private base: URL
  constructor(private o: ClusterOptions) {
    this.base = new URL(o.url.replace(/\/+$/, '') + '/')
    this.via = `through ${o.clusterName}`
  }

  async batch(reqs: QnapRequest[], timeoutMs = 15_000): Promise<QnapResponse[]> {
    const tag = crypto.randomBytes(8).toString('hex')
    const script = clusterScript(this.base, reqs, { insecureTLS: this.o.insecureTLS, timeoutSec: timeoutMs / 1000, tag })
    let r: { code: number; output: string }
    try { r = await this.o.run(script, timeoutMs * reqs.length + 15_000) }
    catch (e: any) {
      // The runner's own refusals (no login saved, host key not confirmed) are already plain words.
      const msg = String(e?.message ?? '')
      if (e?.name === 'ClusterRefusal' || /host key|login/i.test(msg)) throw new QnapUnreachableError(`${this.o.clusterName}: ${msg.slice(0, 200)}`)
      throw new QnapUnreachableError(`HyperProx could not reach ${this.o.clusterName} to ask the NAS.`)
    }
    const res = parseClusterOutput(r.output, reqs.length)
    if (res[0]?.status === 0) throw new QnapUnreachableError(`${this.o.clusterName} could not reach the NAS on its LAN (check the address and that the NAS is on).`)
    return res
  }
}
