// =============================================================================
//  HyperProx — Keyholder client
//
//  The keyholder (bin/hyperprox-keyholder, its own systemd unit) holds the
//  unlocked state so that an API restart does not lock HyperProx. This is the
//  API's end of its unix socket: one long-lived connection, one JSON object per
//  line. The keyholder pushes {"event":"locked"} when it locks (idle timeout,
//  a lock request); the connection closing means it stopped or crashed, which
//  is a lock too. Requests and replies are never logged here.
// =============================================================================

import net from 'node:net'

export const KEYHOLDER_PROTOCOL = 1

export class KeyholderError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? `keyholder: ${code}`)
    this.name = 'KeyholderError'
  }
}

export interface KeyholderLastLock { reason: string; at: number }

export interface KeyholderHello {
  v: number
  instance: string
  unlocked: boolean
  epoch: string | null
  lastLock: KeyholderLastLock | null
}

export interface KeyholderGet { unlocked: boolean; epoch?: string; snapshot?: string; remainingMs?: number; lastLock?: KeyholderLastLock | null }

export interface KeyholderEvents {
  /** The keyholder locked (and wiped) on its own: idle timeout, or a lock asked for on another connection. */
  locked(reason: string): void
  /** The connection closed: the keyholder stopped, crashed or restarted. Whatever it held is gone. */
  gone(): void
}

interface Pending { resolve(v: any): void; reject(e: Error): void; timer: NodeJS.Timeout }

export class KeyholderClient {
  private sock: net.Socket | null = null
  private buf = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private closed = false

  constructor(private path: string, private events: KeyholderEvents,
    private timeoutMs = Number(process.env.VAULT_KEYHOLDER_TIMEOUT_MS) || 5000) {}

  get connected(): boolean { return this.sock !== null && !this.closed }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ path: this.path })
      let up = false
      s.setEncoding('utf8')
      s.once('connect', () => { up = true; this.sock = s; resolve() })
      s.on('data', (chunk: string) => this.onData(chunk))
      s.on('error', (err) => { if (!up) reject(new KeyholderError('unreachable', `keyholder not reachable: ${(err as NodeJS.ErrnoException).code ?? err.message}`)) })
      s.on('close', () => {
        if (!up) return
        this.closed = true
        this.sock = null
        this.buf = ''
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new KeyholderError('gone')) }
        this.pending.clear()
        this.events.gone()
      })
    })
  }

  close(): void {
    this.sock?.destroy()
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      let msg: any
      try { msg = JSON.parse(line) } catch { continue }
      if (msg && typeof msg.event === 'string') {
        if (msg.event === 'locked') this.events.locked(String(msg.reason ?? 'idle'))
        continue
      }
      // A refused peer gets one line with no id, then the keyholder closes.
      if (msg && msg.id === undefined && msg.ok === false) {
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new KeyholderError(String(msg.error ?? 'refused'))) }
        this.pending.clear()
        continue
      }
      const p = this.pending.get(msg?.id)
      if (!p) continue
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg)
      else p.reject(new KeyholderError(String(msg.error ?? 'error')))
    }
  }

  private request(op: string, args: Record<string, unknown> = {}): Promise<any> {
    const s = this.sock
    if (!s || this.closed) return Promise.reject(new KeyholderError('gone'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new KeyholderError('timeout'))
      }, this.timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      s.write(JSON.stringify({ id, op, ...args }) + '\n')
    })
  }

  async hello(): Promise<KeyholderHello> {
    const r = await this.request('hello')
    return { v: Number(r.v), instance: String(r.instance ?? ''), unlocked: !!r.unlocked, epoch: r.epoch ?? null, lastLock: r.lastLock ?? null }
  }

  async get(): Promise<KeyholderGet> {
    return this.request('get')
  }

  /** Only while locked. Returns the epoch that update() must carry. */
  async unlock(snapshot: string, idleMs: number): Promise<string> {
    const r = await this.request('unlock', { snapshot, idleMs: Math.round(idleMs) })
    return String(r.epoch)
  }

  async update(epoch: string, snapshot: string): Promise<void> {
    await this.request('update', { epoch, snapshot })
  }

  async touch(): Promise<boolean> {
    return !!(await this.request('touch')).unlocked
  }

  async lock(reason: string): Promise<boolean> {
    return !!(await this.request('lock', { reason })).wasUnlocked
  }
}
