// =============================================================================
//  HyperProx — Deck Terminal WebSocket
//
//  Registered under /ws so nginx's upgrade block carries it (see
//  config/nginx/conf.d/hyperprox.conf — /api does not proxy upgrades).
//  Auth is the ordinary session cookie: the upgrade request passes through the
//  same onRequest guard as every other route.
// =============================================================================

import { FastifyPluginAsync } from 'fastify'
import { connect, loadCredential, TMUX_SESSION } from '../lib/ssh-broker'

interface TermQuery {
  host?:  string
  port?:  string
  id?:    string
  cols?:  string
  rows?:  string
}

/** Server -> client frames. Kept small and explicit; no binary muxing. */
type OutFrame =
  | { t: 'status'; state: 'connecting' | 'ready' | 'closed'; detail?: string; persistent?: boolean; session?: string; hostKeyLearned?: boolean; fingerprint?: string }
  | { t: 'data';   d: string }
  | { t: 'error';  m: string }

export const deckWsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: TermQuery }>('/term', { websocket: true }, async (socket, req) => {
    const q     = req.query
    const host  = (q.host ?? '').trim()
    const id    = (q.id   ?? '').trim()
    const port  = Number(q.port) || 22
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

    if (!host) return bail('No host was given for this pane.')
    if (!id)   return bail('No host id was given for this pane.')

    send({ t: 'status', state: 'connecting', detail: `${host}:${port}` })

    let cred
    try {
      cred = await loadCredential(id)
    } catch (e: any) {
      return bail(e.message)
    }
    if (!cred) return bail(`No saved login for ${host}. Add one and reconnect.`)

    const started = Date.now()
    let result
    try {
      result = await connect({ host, port, cred, cols, rows })
    } catch (e: any) {
      fastify.log.warn({ host, port, user: cred.username, err: e.message }, '[deck] connect failed')
      return bail(e.message)
    }

    const { channel, client, persistent, hostKeyLearned, fingerprint } = result

    // Audit: who opened what, and for how long. Deliberately not the credential.
    fastify.log.info({ host, port, user: cred.username, persistent }, '[deck] session opened')

    send({
      t: 'status',
      state:   'ready',
      persistent,
      session: persistent ? TMUX_SESSION : undefined,
      hostKeyLearned,
      fingerprint,
    })

    channel.on('data',  (d: Buffer) => send({ t: 'data', d: d.toString('utf8') }))
    channel.stderr?.on('data', (d: Buffer) => send({ t: 'data', d: d.toString('utf8') }))

    const teardown = (why: string) => {
      fastify.log.info(
        { host, port, user: cred!.username, seconds: Math.round((Date.now() - started) / 1000), why },
        '[deck] session closed',
      )
      try { channel.end() } catch { /* already gone */ }
      try { client.end()  } catch { /* already gone */ }
      if (socket.readyState === socket.OPEN) {
        send({ t: 'status', state: 'closed', detail: why })
        socket.close()
      }
    }

    channel.on('close', () => teardown('remote closed'))
    client.on('error', (e: any) => { send({ t: 'error', m: e.message }); teardown('ssh error') })

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
