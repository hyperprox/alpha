// =============================================================================
//  HyperProx — Proxy providers: writing a file on the proxy's machine
//
//  Traefik's file provider reads its dynamic configuration from disk, so
//  HyperProx needs a way to put one file there. Two ways:
//    ssh    Bring Your Own: an SSH/SFTP login (password or key) and a pinned
//           host key. The file is written beside its target and renamed over
//           it, so Traefik never reads half a file.
//    guest  Managed: the container HyperProx installed, reached with the
//           node's vault-held login and `pct exec`, the way the Catalogue
//           installs. The content travels base64-encoded on stdin.
// =============================================================================

import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { createHash } from 'node:crypto'
import { posix as path } from 'node:path'

export interface FileTransport {
  /** The file's text, or null when it does not exist. */
  read(file: string): Promise<string | null>
  /** Replace the file in one step (write beside it, then rename over it). */
  write(file: string, text: string): Promise<void>
  describe(): string
}

export interface SshTarget {
  host:        string
  port:        number
  username:    string
  password?:   string
  privateKey?: string
  passphrase?: string
  /** OpenSSH-style SHA256 fingerprint. Required: an unpinned host is refused, with the key it offered. */
  hostKey?:    string
}

export function fingerprint(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

export class HostKeyMismatch extends Error {
  constructor(readonly offered: string, pinned: string | undefined) {
    super(pinned
      ? `The SSH host key changed: the server offered ${offered}, HyperProx pinned ${pinned}. Nothing was read or written.`
      : `The SSH host key is not pinned yet. The server offered ${offered}.`)
    this.name = 'HostKeyMismatch'
  }
}

function connect(t: SshTarget): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client()
    let offered = ''
    const cfg: ConnectConfig = {
      host: t.host, port: t.port, username: t.username, readyTimeout: 15_000,
      hostVerifier: (key: Buffer) => { offered = fingerprint(key); return !!t.hostKey && offered === t.hostKey },
    }
    if (t.privateKey) { cfg.privateKey = t.privateKey; if (t.passphrase) cfg.passphrase = t.passphrase }
    else if (t.password) cfg.password = t.password
    else return reject(new Error('The SSH login has neither a password nor a private key.'))
    c.on('ready', () => resolve(c))
    c.on('error', (e: any) => {
      if (offered && offered !== t.hostKey) reject(new HostKeyMismatch(offered, t.hostKey))
      else reject(new Error(`SSH to ${t.host}:${t.port} failed: ${e?.message ?? e}`))
    })
    c.connect(cfg)
  })
}

/** The fingerprint a server offers, for pinning when an instance is added. Authenticates nothing. */
export function learnHostKey(host: string, port: number, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = new Client()
    let done = false
    const finish = (f: () => void) => { if (!done) { done = true; try { c.end() } catch {} ; f() } }
    c.on('error', (e: any) => finish(() => offeredFp ? resolve(offeredFp) : reject(new Error(`SSH to ${host}:${port} failed: ${e?.message ?? e}`))))
    let offeredFp = ''
    c.connect({
      host, port, username: 'hyperprox-hostkey-probe', readyTimeout: timeoutMs,
      hostVerifier: (key: Buffer) => { offeredFp = fingerprint(key); finish(() => resolve(offeredFp)); return false },
    })
  })
}

function sftpOf(c: Client): Promise<SFTPWrapper> {
  return new Promise((res, rej) => c.sftp((e, s) => (e ? rej(e) : res(s))))
}

// One SSH connection per server and login, reused while it is busy and closed after a minute idle: a page
// refreshing every 30 s no longer means an SSH handshake every 30 s.
const IDLE_MS = 60_000
interface Pooled { client: Client; sftp: SFTPWrapper; timer: NodeJS.Timeout | null; busy: number }
const pool = new Map<string, Promise<Pooled>>()

function poolKey(t: SshTarget): string {
  const cred = createHash('sha256').update(`${t.password ?? ''}\n${t.privateKey ?? ''}\n${t.passphrase ?? ''}`).digest('hex')
  return `${t.username}@${t.host}:${t.port}|${t.hostKey ?? ''}|${cred}`
}

function drop(key: string, p?: Pooled): void {
  pool.delete(key)
  if (p) { if (p.timer) clearTimeout(p.timer); try { p.client.end() } catch { /* gone */ } }
}

async function acquire(t: SshTarget): Promise<{ key: string; p: Pooled }> {
  const key = poolKey(t)
  let pending = pool.get(key)
  if (!pending) {
    pending = (async () => {
      const client = await connect(t)
      const sftp = await sftpOf(client).catch(e => { client.end(); throw e })
      const p: Pooled = { client, sftp, timer: null, busy: 0 }
      client.on('close', () => { if (pool.get(key) === pending) pool.delete(key) })
      client.on('error', () => { if (pool.get(key) === pending) pool.delete(key) })
      return p
    })()
    pool.set(key, pending)
    pending.catch(() => { if (pool.get(key) === pending) pool.delete(key) })
  }
  const p = await pending
  if (p.timer) { clearTimeout(p.timer); p.timer = null }
  p.busy++
  return { key, p }
}

function release(key: string, p: Pooled): void {
  p.busy--
  if (p.busy === 0 && pool.has(key)) { p.timer = setTimeout(() => drop(key, p), IDLE_MS); p.timer.unref?.() }
}

/** Tests and shutdown: close every pooled connection. */
export function closeSshPool(): void { for (const [k, v] of [...pool]) v.then(p => drop(k, p), () => pool.delete(k)) }
export function sshPoolSize(): number { return pool.size }

export class SshFileTransport implements FileTransport {
  constructor(private t: SshTarget) {}
  describe() { return `SFTP ${this.t.username}@${this.t.host}:${this.t.port}` }

  private async with<T>(fn: (s: SFTPWrapper) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const { key, p } = await acquire(this.t)
      try { return await fn(p.sftp) }
      catch (e: any) {
        // A connection the server closed while idle: try once more on a fresh one. A file error is final.
        const broken = !e?.code || /No response|not connected|ECONNRESET|channel|closed/i.test(String(e?.message))
        if (broken && !(e instanceof HostKeyMismatch)) drop(key, p)
        if (!broken || attempt > 0) throw e
      } finally { release(key, p) }
    }
  }

  read(file: string): Promise<string | null> {
    return this.with(s => new Promise((res, rej) => s.readFile(file, (e: any, b) => {
      if (e) return e.code === 2 ? res(null) : rej(Object.assign(new Error(`Cannot read ${file}: ${e.message}`), { code: e.code }))
      res(b.toString('utf8'))
    })))
  }

  write(file: string, text: string): Promise<void> {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.hyperprox-${process.pid}-${Date.now()}`)
    return this.with(async s => {
      await new Promise<void>((res, rej) => s.writeFile(tmp, text, { mode: 0o644 }, (e: any) => (e ? rej(Object.assign(new Error(`Cannot write ${tmp}: ${e.message}`), { code: e.code ?? 'EWRITE' })) : res())))
      // OpenSSH's posix-rename replaces the target in one step; plain SFTP rename refuses an existing target.
      await new Promise<void>((res, rej) => {
        const done = (e: any) => (e ? rej(e) : res())
        if (typeof (s as any).ext_openssh_rename === 'function') (s as any).ext_openssh_rename(tmp, file, done)
        else s.rename(tmp, file, done)
      }).catch(async (e: any) => {
        await new Promise<void>(r => s.unlink(tmp, () => r()))
        throw Object.assign(new Error(`Cannot move the new file over ${file}: ${e.message}`), { code: e.code ?? 'ERENAME' })
      })
    })
  }
}

/** The slice of node-exec the guest transport uses, so tests can stand in for it. */
export type GuestExec = (script: string) => Promise<{ code: number; output: string }>

const BEGIN = '---HYPERPROX-FILE-BEGIN---'
const END = '---HYPERPROX-FILE-END---'

function shq(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'` }

export class GuestFileTransport implements FileTransport {
  constructor(private exec: GuestExec, private label: string) {}
  describe() { return this.label }

  async read(file: string): Promise<string | null> {
    const r = await this.exec(`set -e\nif [ ! -e ${shq(file)} ]; then echo NOFILE; exit 0; fi\necho ${BEGIN}\nbase64 -w0 ${shq(file)}\necho\necho ${END}\n`)
    if (r.code !== 0) throw new Error(`Reading ${file} in the container failed (exit ${r.code})`)
    if (/^NOFILE\s*$/m.test(r.output) && !r.output.includes(BEGIN)) return null
    const m = new RegExp(`${BEGIN}\\s*([A-Za-z0-9+/=]*)\\s*${END}`).exec(r.output)
    if (!m) throw new Error(`Reading ${file} in the container gave no file`)
    return Buffer.from(m[1], 'base64').toString('utf8')
  }

  async write(file: string, text: string): Promise<void> {
    const tmp = `${path.dirname(file)}/.${path.basename(file)}.hyperprox`
    const b64 = Buffer.from(text, 'utf8').toString('base64')
    const r = await this.exec(`set -e\numask 022\nprintf '%s' '${b64}' | base64 -d > ${shq(tmp)}\nmv -f ${shq(tmp)} ${shq(file)}\necho WROTE\n`)
    if (r.code !== 0 || !/WROTE/.test(r.output)) throw new Error(`Writing ${file} in the container failed (exit ${r.code})`)
  }
}

// --- HTTP through the container (Managed Caddy and HAProxy, whose APIs listen on loopback only) ---------

const HTTP_BEGIN = '---HYPERPROX-HTTP---'
const HTTP_END = '---HYPERPROX-HTTP-END---'

/**
 * A fetch that runs curl inside the Managed container, so an admin API bound to 127.0.0.1 there is reachable
 * by HyperProx and by nothing else on the network. Headers (credentials included) and the body travel as
 * files, never on curl's command line. Redirects are never followed.
 */
export function guestFetch(exec: GuestExec): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init = {}) => {
    const u = new URL(url)
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '[::1]') throw new Error('guestFetch reaches loopback addresses only')
    const method = (init.method ?? 'GET').toUpperCase()
    if (!/^[A-Z]+$/.test(method)) throw new Error('bad method')
    const headers = Object.entries((init.headers ?? {}) as Record<string, string>)
      .filter(([k]) => /^[A-Za-z0-9-]+$/.test(k)).map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]/g, '')}`).join('\n')
    const body = typeof init.body === 'string' ? init.body : init.body ? String(init.body) : null
    const b64 = (x: string) => Buffer.from(x, 'utf8').toString('base64')
    const script = [
      'set -e', 'd=$(mktemp -d)', "trap 'rm -rf \"$d\"' EXIT",
      `printf '%s' '${b64(headers)}' | base64 -d > "$d/h"`,
      body !== null ? `printf '%s' '${b64(body)}' | base64 -d > "$d/b"` : ': > "$d/b"',
      `code=$(curl -sS --max-redirs 0 --max-time 30 -X ${method} -H @"$d/h" ${body !== null ? '--data-binary @"$d/b"' : ''} -D "$d/rh" -o "$d/rb" -w '%{http_code}' ${shq(u.toString())})`,
      `echo ${HTTP_BEGIN} "$code"`, 'base64 -w0 "$d/rh"; echo', 'base64 -w0 "$d/rb"; echo', `echo ${HTTP_END}`,
    ].join('\n') + '\n'
    const r = await exec(script)
    const m = new RegExp(`${HTTP_BEGIN} (\\d{3})\\s*\\n([A-Za-z0-9+/=]*)\\s*\\n([A-Za-z0-9+/=]*)\\s*\\n${HTTP_END}`).exec(r.output)
    if (r.code !== 0 || !m) throw Object.assign(new Error(`The request through the container failed (exit ${r.code})`), { cause: { code: 'EGUEST' } })
    const rh = new Headers()
    for (const line of Buffer.from(m[2], 'base64').toString('utf8').split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i > 0 && !/^HTTP\//.test(line)) rh.append(line.slice(0, i).trim(), line.slice(i + 1).trim())
    }
    const status = Number(m[1])
    return new Response(status === 204 || status === 304 ? null : Buffer.from(m[3], 'base64'), { status, headers: rh })
  }
}
