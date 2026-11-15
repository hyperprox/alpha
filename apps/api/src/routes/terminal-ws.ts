// =============================================================================
//  HyperProx — Deck Terminal WebSocket
//
//  Registered under /ws so nginx's upgrade block carries it (see
//  config/nginx/conf.d/hyperprox.conf — /api does not proxy upgrades).
//  Auth is the ordinary session cookie: the upgrade request passes through the
//  same onRequest guard as every other route.
// =============================================================================

import { FastifyPluginAsync } from 'fastify'
import { connect, loadCredential, HostKeyChangedError } from '../lib/ssh-broker'
import { resolveTerminalTarget, terminalIdProblem, terminalTargetDeps } from '../lib/terminal-targets'
import { trackSocket } from '../lib/session-sockets'

interface TermQuery {
  /** Ignored: the address is worked out on the server from the id (lib/terminal-targets.ts). */
  host?:  string
  port?:  string
  /** '0' for a device with no shell to run tmux in — an appliance CLI. */
  tmux?:  string
  id?:    string
  cols?:  string
  rows?:  string
  session?: string
}

/** Server -> client frames. Kept small and explicit; no binary muxing. */
type OutFrame =
  | { t: 'status'; state: 'connecting' | 'ready' | 'closed'; detail?: string; persistent?: boolean; session?: string; hostKeyLearned?: boolean; fingerprint?: string }
  | { t: 'data';   d: string }
  | { t: 'error';  m: string }
  /** The pinned key differs from the one offered: the pane asks the API to check it with Proxmox. */
  | { t: 'hostkey'; host: string; port: number; pinned: string; offered: string; offeredType: string }


/**
 * A failed SSH connection in words for the pane. HyperProx's own refusals (a host key that needs confirming, say)
 * carry their message; anything from the SSH library is described, never quoted. The error itself is in the log.
 */
export function terminalConnectText(e: any, host: string, port: number): string {
  const name = String(e?.name ?? '')
  if (/(Refusal|Refused|NotPinned|NotConfirmed|Mismatch)/.test(name) || /HostKey/.test(name)) return String(e?.message ?? 'Refused.')
  const m = `${e?.message ?? ''} ${e?.code ?? ''} ${e?.level ?? ''}`
  if (/authentication|client-authentication|permission denied/i.test(m)) return 'The login was refused. Check the saved username and password or key.'
  if (/ECONNREFUSED/.test(m)) return `Nothing is accepting SSH at ${host}:${port}.`
  if (/ETIMEDOUT|timed? ?out|EHOSTUNREACH|ENETUNREACH/i.test(m)) return `${host}:${port} did not answer.`
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return `${host} could not be found.`
  return 'Could not connect. The details are in the log.'
}

export const terminalWsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: TermQuery }>('/term', { websocket: true }, async (socket, req) => {
    const q     = req.query
    const id    = (q.id   ?? '').trim()
    const cols  = Math.min(Math.max(Number(q.cols) || 80, 20), 500)
    const rows  = Math.min(Math.max(Number(q.rows) || 24, 5),  200)

    const send = (frame: OutFrame) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
    }

    const bail = (message: string) => {
      send({ t: 'error', m: message })
      send({ t: 'status', state: 'closed' })
      socket.close()
    }

    // A shell outlives nothing: signing out, a lock or the session ending closes it (and the SSH session with it).
    if (!req.session) return bail('Sign in again.')
    trackSocket(req.session, socket as any, 'terminal')
    if (!id)   return bail('No host id was given for this pane.')
    // A node's root login shares the credential store with the Terminal's logins; no pane may open one.
    const refused = terminalIdProblem(id)
    if (refused) return bail(refused)

    let cred
    try {
      cred = await loadCredential(id)
    } catch (e: any) {
      fastify.log.error({ err: e, id }, '[terminal] could not read the saved login')
      return bail(e?.name === 'VaultLockedError' ? 'HyperProx is locked. Sign in again, then reconnect.' : 'The saved login could not be read. The details are in the log.')
    }
    if (!cred) return bail(`No saved login for ${id}. Add one and reconnect.`)

    // Where the login goes is HyperProx's to decide, never the browser's: the address the client sent is ignored.
    let target
    try { target = await resolveTerminalTarget(id, cred.port, terminalTargetDeps()) }
    catch (e: any) { return bail(e.message) }
    const { host, port } = target
    send({ t: 'status', state: 'connecting', detail: `${host}:${port}` })

    const started = Date.now()
    let result
    try {
      result = await connect({ host, port, cred, cols, rows, session: q.session, useTmux: target.tmux && q.tmux !== '0' })
    } catch (e: any) {
      fastify.log.warn({ host, port, user: cred.username, err: e }, '[terminal] connect failed')
      if (e instanceof HostKeyChangedError) {
        send({ t: 'hostkey', host: e.host, port: e.port, pinned: e.pinned, offered: e.offered, offeredType: e.offeredType })
        return bail(e.message)
      }
      return bail(terminalConnectText(e, host, port))
    }

    const { channel, client, persistent, session, hostKeyLearned, fingerprint } = result

    // Audit: who opened what, and for how long. Deliberately not the credential.
    fastify.log.info({ host, port, user: cred.username, persistent }, '[terminal] session opened')

    send({
      t: 'status',
      state:   'ready',
      persistent,
      session: persistent ? session : undefined,
      hostKeyLearned,
      fingerprint,
    })

    channel.on('data',  (d: Buffer) => send({ t: 'data', d: d.toString('utf8') }))
    channel.stderr?.on('data', (d: Buffer) => send({ t: 'data', d: d.toString('utf8') }))

    const teardown = (why: string) => {
      fastify.log.info(
        { host, port, user: cred!.username, seconds: Math.round((Date.now() - started) / 1000), why },
        '[terminal] session closed',
      )
      try { channel.end() } catch { /* already gone */ }
      try { client.end()  } catch { /* already gone */ }
      if (socket.readyState === socket.OPEN) {
        send({ t: 'status', state: 'closed', detail: why })
        socket.close()
      }
    }

    channel.on('close', () => teardown('remote closed'))
    client.on('error', (e: any) => {
      fastify.log.warn({ host, port, err: e }, '[terminal] ssh connection error')
      send({ t: 'error', m: 'Connection lost.' })
      teardown('ssh error')
    })

    socket.on('message', (raw: any) => {
      let msg: any
      try { msg = JSON.parse(raw.toString()) } catch { return }

      if (msg.t === 'data' && typeof msg.d === 'string') {
        channel.write(msg.d)
      } else if (msg.t === 'resize') {
        const c = Math.min(Math.max(Number(msg.cols) || cols, 20), 500)
        const r = Math.min(Math.max(Number(msg.rows) || rows, 5),  200)
        channel.setWindow(r, c, 0, 0)
      }
    })

    socket.on('close', () => teardown('browser disconnected'))
  })
}
