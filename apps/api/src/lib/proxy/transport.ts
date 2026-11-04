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

export class SshFileTransport implements FileTransport {
  constructor(private t: SshTarget) {}
  describe() { return `SFTP ${this.t.username}@${this.t.host}:${this.t.port}` }

  private async with<T>(fn: (s: SFTPWrapper) => Promise<T>): Promise<T> {
    const c = await connect(this.t)
    try { return await fn(await sftpOf(c)) } finally { c.end() }
  }

  read(file: string): Promise<string | null> {
    return this.with(s => new Promise((res, rej) => s.readFile(file, (e: any, b) => {
      if (e) return e.code === 2 ? res(null) : rej(new Error(`Cannot read ${file}: ${e.message}`))
      res(b.toString('utf8'))
    })))
  }

  write(file: string, text: string): Promise<void> {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.hyperprox-${process.pid}-${Date.now()}`)
    return this.with(async s => {
      await new Promise<void>((res, rej) => s.writeFile(tmp, text, { mode: 0o644 }, (e: any) => (e ? rej(new Error(`Cannot write ${tmp}: ${e.message}`)) : res())))
      // OpenSSH's posix-rename replaces the target in one step; plain SFTP rename refuses an existing target.
      await new Promise<void>((res, rej) => {
        const done = (e: any) => (e ? rej(e) : res())
        if (typeof (s as any).ext_openssh_rename === 'function') (s as any).ext_openssh_rename(tmp, file, done)
        else s.rename(tmp, file, done)
      }).catch(async (e: any) => {
        await new Promise<void>(r => s.unlink(tmp, () => r()))
        throw new Error(`Cannot move the new file over ${file}: ${e.message}`)
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
