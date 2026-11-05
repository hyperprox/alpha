// =============================================================================
//  HyperProx — Prometheus target sync (lib/targets.ts does the work)
//  GET /status   the target files as they are
//  POST /sync    add every node, Ceph manager and GPU exporter that is missing
//  The lists also update by themselves: after setup, and whenever a node joins (lib/targets.ts watchTargets).
// =============================================================================
import { FastifyPluginAsync } from 'fastify'
import { readTargets, syncTargets } from '../lib/targets'

export const targetsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/status', async () => ({
    success: true,
    data: {
      nodes:     readTargets('nodes.json'),
      pve:       readTargets('pve.json'),
      intelGpu:  readTargets('intel-gpu.json'),
      nvidiaGpu: readTargets('nvidia.json'),
      ceph:      readTargets('ceph.json'),
    },
  }))

  fastify.post('/sync', async (_, r) => {
    try {
      const res = await syncTargets()
      const a = res.added
      return {
        success: true,
        data: {
          nodes:  { added: a['nodes.json'] },
          pve:    { added: a['pve.json'] },
          intel:  { added: a['intel-gpu.json'] },
          nvidia: { added: a['nvidia.json'] },
          ceph:   { added: a['ceph.json'] },
          at: res.at,
        },
      }
    } catch (e: any) {
      return r.status(500).send({ success: false, error: e.message })
    }
  })
}
