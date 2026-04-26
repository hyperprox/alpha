import { FastifyPluginAsync } from 'fastify'
import { startBroadcast }     from '../lib/ws-broadcast'

let started = false

export const wsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', { websocket: true }, (socket, req) => {
    // Start broadcast loop once on first connection
    if (!started) {
      startBroadcast(fastify)
      started = true
    }

    socket.send(JSON.stringify({
      type: 'connected',
      payload: { message: 'HyperProx WS connected' },
      ts: Date.now(),
    }))

    socket.on('message', (msg: any) => {
      try {
        const { type } = JSON.parse(msg.toString())
        if (type === 'ping') socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
      } catch { /* ignore malformed */ }
    })
  })
}
