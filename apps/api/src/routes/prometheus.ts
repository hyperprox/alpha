// =============================================================================
//  HyperProx — Prometheus Query Proxy
//  Proxies requests to Prometheus so the frontend doesn't need direct access
// =============================================================================

import { FastifyInstance } from 'fastify'
import axios from 'axios'

const PROMETHEUS = 'http://192.168.2.251:9090'

export async function prometheusRoutes(fastify: FastifyInstance) {

  // -------------------------------------------------------------------------
  // GET /api/prometheus/alerts — active firing alerts
  // -------------------------------------------------------------------------
  fastify.get('/api/prometheus/alerts', async (req, reply) => {
    try {
      const { data } = await axios.get(`${PROMETHEUS}/api/v1/alerts`, { timeout: 5000 })
      const alerts = data?.data?.alerts || []

      // Map to clean format
      const mapped = alerts.map((a: any) => ({
        name:        a.labels?.alertname || 'Unknown',
        severity:    a.labels?.severity  || 'info',
        state:       a.state,
        node:        a.labels?.node      || a.labels?.instance || '',
        summary:     a.annotations?.summary     || '',
        description: a.annotations?.description || '',
        firedAt:     a.activeAt,
      }))

      return reply.send({ success: true, data: mapped })
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message })
    }
  })

  // -------------------------------------------------------------------------
  // GET /api/prometheus/query?q=<expr> — instant query
  // -------------------------------------------------------------------------
  fastify.get<{ Querystring: { q: string } }>('/api/prometheus/query', async (req, reply) => {
    try {
      const { q } = req.query
      if (!q) return reply.status(400).send({ error: 'Missing query param q' })

      const { data } = await axios.get(`${PROMETHEUS}/api/v1/query`, {
        params: { query: q },
        timeout: 5000,
      })
      return reply.send({ success: true, data: data.data })
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message })
    }
  })

  // -------------------------------------------------------------------------
  // GET /api/prometheus/range?q=<expr>&start=<>&end=<>&step=<>
  // -------------------------------------------------------------------------
  fastify.get<{ Querystring: { q: string; start: string; end: string; step?: string } }>(
    '/api/prometheus/range',
    async (req, reply) => {
      try {
        const { q, start, end, step = '60' } = req.query
        if (!q || !start || !end) return reply.status(400).send({ error: 'Missing params' })

        const { data } = await axios.get(`${PROMETHEUS}/api/v1/query_range`, {
          params: { query: q, start, end, step },
          timeout: 10000,
        })
        return reply.send({ success: true, data: data.data })
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message })
      }
    }
  )

  // -------------------------------------------------------------------------
  // GET /api/prometheus/nodes — current per-node stats from Prometheus
  // -------------------------------------------------------------------------
  fastify.get('/api/prometheus/nodes', async (req, reply) => {
    try {
      const queries = {
        cpu:    '100 - (avg by(node) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
        memory: '(1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100',
        disk:   '(1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100',
        load:   'node_load1',
      }

      const results = await Promise.all(
        Object.entries(queries).map(async ([key, expr]) => {
          const { data } = await axios.get(`${PROMETHEUS}/api/v1/query`, {
            params: { query: expr },
            timeout: 5000,
          })
          return { key, result: data.data.result }
        })
      )

      // Merge into per-node object
      const nodes: Record<string, any> = {}
      for (const { key, result } of results) {
        for (const r of result) {
          const node = r.metric.node || r.metric.instance
          if (!node) continue
          if (!nodes[node]) nodes[node] = { node }
          nodes[node][key] = parseFloat(r.value[1])
        }
      }

      return reply.send({ success: true, data: Object.values(nodes) })
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err.message })
    }
  })
}
