// A stand-in keyholder that misbehaves on purpose: it can error or never answer `unlock` and `lock`,
// so the API's handling of a keyholder that does not confirm can be tested. Speaks the real protocol.
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type Mode = 'ok' | 'error' | 'hang'

export class FakeKeyholderServer {
  readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khtest-fake-'))
  readonly socket = path.join(this.dir, 'keyholder.sock')
  ops: string[] = []
  unlockMode: Mode = 'ok'
  lockMode: Mode = 'ok'
  unlocked = false
  private server: net.Server | null = null
  private conns = new Set<net.Socket>()
  /** Shared with other recorders, to check the order of events across components. */
  constructor(private timeline?: string[]) {}

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = net.createServer((c) => {
        this.conns.add(c)
        c.on('close', () => this.conns.delete(c))
        let buf = ''
        c.setEncoding('utf8')
        c.on('data', (d: string) => {
          buf += d
          let i: number
          while ((i = buf.indexOf('\n')) >= 0) {
            const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
            this.ops.push(req.op)
            this.timeline?.push(`keyholder:${req.op}`)
            const reply = (o: object) => c.write(JSON.stringify({ id: req.id, ...o }) + '\n')
            const mode = req.op === 'unlock' ? this.unlockMode : req.op === 'lock' ? this.lockMode : 'ok'
            if (mode === 'hang') continue
            if (mode === 'error') { reply({ ok: false, error: 'internal' }); continue }
            switch (req.op) {
              case 'hello':  reply({ ok: true, v: 1, instance: 'fake', unlocked: this.unlocked, epoch: null, lastLock: null }); break
              case 'get':    reply({ ok: true, unlocked: false, lastLock: null }); break
              case 'unlock': this.unlocked = true; reply({ ok: true, epoch: 'e1' }); break
              case 'update': reply({ ok: true }); break
              case 'touch':  reply({ ok: true, unlocked: this.unlocked }); break
              case 'lock':   { const was = this.unlocked; this.unlocked = false; reply({ ok: true, wasUnlocked: was }); break }
              default:       reply({ ok: false, error: 'unknown_op' })
            }
          }
        })
      })
      this.server.listen(this.socket, () => resolve())
    })
  }

  /** What a keyholder restart does: drop every connection and forget everything. */
  async restart(): Promise<void> {
    for (const c of this.conns) c.destroy()
    this.unlocked = false
  }

  async stop(): Promise<void> {
    for (const c of this.conns) c.destroy()
    await new Promise<void>(r => this.server ? this.server.close(() => r()) : r())
  }
}
