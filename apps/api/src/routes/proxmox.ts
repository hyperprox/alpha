// =============================================================================
//  HyperProx — Proxmox Routes (with GPU + NPM + cluster totals)
// =============================================================================

import { strictParams } from '../lib/route-params'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { getGPUInfo }         from '../lib/gpu'
import { NPMClient }          from '../lib/npm-client'
import { withCephMon, cephRefusal } from '../lib/ceph'
import { noteHomeClusterName } from '../lib/clusters/registry'
import { getProviderCredentials } from '../lib/credentials'
import { pveFromEnv } from '../lib/pve-env'
import { npmHealth, withTimeout } from '../lib/service-health'
import { isRemoteContext } from '../lib/clusters/context'
import { guardRawCreate } from '../lib/naming'
import { auditCredentialUse } from '../lib/audit'
import { sendFailure } from '../lib/failure'
import { answerData } from '../lib/http/answer'
import { ProxmoxUnreachableError, proxmoxUnanswered } from '../lib/proxmox-client'

// Not cached here: the token arrives from the vault after start-up and can change (lib/pve-env.ts).
const getClient = pveFromEnv

async function getNPM(): Promise<NPMClient | null> {
  try {
    const creds = await getProviderCredentials('proxy', 'npm')
    if (!creds?.url || !creds?.email || !creds?.password) return null
    return new NPMClient(creds.url, creds.email, creds.password)
  } catch { return null }
}

const wrap = (reply: FastifyReply, fn: () => Promise<unknown>, friendly = "HyperProx couldn't get that from Proxmox.") => answerData(reply, fn, { friendly })

// A cluster with no CEPH is a normal configuration, not a server fault — 503
// with a readable reason, so the UI can hide the panel instead of showing a
// stack trace about an empty node name.
const wrapCeph = (reply: FastifyReply, fn: () => Promise<unknown>) =>
  answerData(reply, fn, { refusal: cephRefusal, friendly: "HyperProx couldn't read Ceph's status from Proxmox." })

export const proxmoxRoutes: FastifyPluginAsync = async (fastify) => {
  strictParams(fastify)   // node, vmid, type and snapshot names are checked before any handler (lib/route-params.ts)

  // Whether Proxmox answers: the reason in plain words (ping() never throws), the raw detail only in the log.
  fastify.get('/ping', async (req, r) => {
    const p = await getClient().ping()
    if (p.ok) return { success: true, data: p }
    req.log.warn({ code: p.code, detail: p.detail }, '[proxmox] ping failed')
    return r.status(502).send({ ok: false, success: false, code: p.code, error: p.error, data: { ok: false, code: p.code, error: p.error } })
  })
  // The cluster's own name (PVE /cluster/status), for the page header. null on a standalone node or when unreachable.
  fastify.get('/cluster-name', async () => {
    try {
      const rows = await getClient().fetchStrict<any[]>('/cluster/status')
      const name = (rows ?? []).find(x => x?.type === 'cluster')?.name
      const n = typeof name === 'string' && name ? name : null
      // The cluster list then says this name for home too (lib/clusters/registry.ts homeDisplayName).
      if (!isRemoteContext()) noteHomeClusterName(n)
      return { name: n }
    } catch { return { name: null } }
  })
  fastify.get('/nodes',     async (_, r) => wrap(r, () => getClient().getNodes()))
  fastify.get('/resources', async (_, r) => wrap(r, () => getClient().getClusterResources()))
  fastify.get('/storage',   async (_, r) => wrap(r, () => getClient().getAllStorage()))
  fastify.get('/ha',        async (_, r) => wrap(r, () => getClient().getHAStatus()))
  fastify.get('/ha/resources', async (_, r) => wrap(r, () => getClient().getHAResources()))
  fastify.get('/gpu',       async (_, r) => wrap(r, () => getGPUInfo()))

  fastify.get<{ Params: { node: string } }>('/nodes/:node', async (req, r) =>
    wrap(r, () => getClient().getNodeStatus(req.params.node)))

  fastify.get<{ Params: { node: string } }>('/nodes/:node/tasks', async (req, r) =>
    wrap(r, () => getClient().getNodeTasks(req.params.node)))

  fastify.get('/vms', async (_, r) => {
    const vms = await getClient().getAllVMs()
    return { success: true, data: vms, meta: { total: vms.length } }
  })

  fastify.get('/ceph/status', async (_, r) =>
    wrapCeph(r, () => getClient().getClusterCephStatus()))

  fastify.get('/ceph/osds', async (_, r) =>
    wrapCeph(r, () => withCephMon(getClient(), n => getClient().getCephOSDs(n))))

  fastify.get('/ceph/pools', async (_, r) =>
    wrapCeph(r, () => withCephMon(getClient(), n => getClient().getCephPools(n))))

  // POST /api/proxmox/vms/:node/:vmid/:type/:action
  fastify.post<{
    Params: { node: string; vmid: string; type: 'qemu' | 'lxc'; action: 'start' | 'stop' | 'reboot' | 'shutdown' }
  }>('/vms/:node/:vmid/:type/:action', async (req, r) => {
    const { node, vmid, type, action } = req.params
    // Only the four power actions: anything else would be sent on to Proxmox as /status/<whatever>.
    if (!['start', 'stop', 'reboot', 'shutdown'].includes(action)) return r.status(404).send({ success: false, error: `no such action: ${action}` })
    return wrap(r, () => getClient().vmAction(node, Number(vmid), type, action))
  })

  // ==========================================================================
  //  SUMMARY — single call, everything the dashboard needs
  // ==========================================================================

  // ── CT/VM Creation ───────────────────────────────────────────────────────────
  fastify.get('/isos', async (_, r) =>
    wrap(r, () => getClient().getISOs()))

  fastify.get<{ Params: { node: string } }>('/nodes/:node/aplinfo', async (req, r) =>
    wrap(r, () => getClient().getDownloadableTemplates(req.params.node)))

  fastify.post<{ Body: { node: string; storage: string; template: string } }>('/templates/download', async (req, r) =>
    wrap(r, () => getClient().downloadTemplate(req.body.node, req.body.storage, req.body.template)))

  fastify.delete<{ Params: { node: string; vmid: string; type: string } }>('/nodes/:node/:type/:vmid', async (req, r) =>
    wrap(r, () => {
      const vmid = Number(req.params.vmid)
      if (req.params.type === 'lxc') return getClient().deleteLXC(req.params.node, vmid)
      if (req.params.type === 'qemu') return getClient().deleteVM(req.params.node, vmid)
      throw new Error(`Unknown type: ${req.params.type}`)
    }))


  fastify.get('/templates', async (_, r) =>
    wrap(r, () => getClient().getTemplates()))

  fastify.get('/nextid', async (_, r) =>
    wrap(r, () => getClient().getNextVMID()))

  // A container made from the raw form follows Settings → Naming & addresses like every wizard: DHCP under "never"
  // or an address outside the range needs the person's typed confirmation (namingConfirm), and is audited. A remote
  // cluster has its own network, so the home cluster's settings are not applied to it.
  fastify.post<{ Body: { node: string; params: any; namingConfirm?: string } }>('/lxc', async (req, r) => {
    const b = req.body ?? ({} as any)
    if (!isRemoteContext()) {
      let g
      try {
        g = await guardRawCreate({ node: b.node, vmid: Number(b.params?.vmid), net0: b.params?.net0 },
          typeof b.namingConfirm === 'string' ? b.namingConfirm.slice(0, 64) : undefined)
      } catch (e: any) {
        return r.status(503).send({ success: false, code: 'naming_unreadable', error: `Nothing was created: ${e?.message ?? 'the naming settings could not be read.'}` })
      }
      if (g.errors.length) return r.status(422).send({ success: false, code: 'naming', error: g.errors.join(' '), problems: g.errors })
      if (g.override) {
        await auditCredentialUse('naming.override', `ct/${Number(b.params?.vmid)}`, {
          kind: g.override.kind, value: g.override.value, node: String(b.node ?? ''), via: 'create-container form',
        })
      }
    }
    return wrap(r, () => getClient().createLXC(b.node, b.params))
  })

  fastify.post<{ Body: { node: string; params: any } }>('/vm', async (req, r) =>
    wrap(r, () => getClient().createVM(req.body.node, req.body.params)))


  fastify.get('/summary', async (req, r) => {
    try {
      // A remote cluster's summary is its Proxmox only: the GPU reader and the proxy are the home cluster's.
      const remote = isRemoteContext()
      const npm = remote ? null : await getNPM()

      // Get VMs first so GPU consumer lookup can resolve CT names
      const [nodesR, vmsR] = await Promise.allSettled([
        getClient().getNodes(),
        getClient().getAllVMs(),
      ])
      const vmList = vmsR.status === 'fulfilled' ? vmsR.value : undefined
      // No node list means no summary: a refused token (proxmox_auth) or no answer (proxmox_unreachable) is said as
      // such, never shown as an empty cluster.
      if (nodesR.status === 'rejected') {
        const e = nodesR.reason
        // Already typed by getNodes (refused token, no answer, changed certificate); anything else as it is.
        return sendFailure(req, r, proxmoxUnanswered(e) && e?.name !== 'ProxmoxUnreachableError' ? new ProxmoxUnreachableError(e) : e, "HyperProx couldn't read your Proxmox's node list.", { status: 502 })
      }

      const [cephR, osdR, haR, storageR, gpuR, npmR, pingR] = await Promise.allSettled([
        getClient().getClusterCephStatus(),
        withCephMon(getClient(), n => getClient().getCephOSDs(n)),
        getClient().getHAStatus(),
        getClient().getAllStorage(),
        remote ? Promise.resolve(null) : getGPUInfo(vmList),
        // A login that never answers must not hold the whole dashboard hostage.
        npm ? withTimeout(npm.getStats(), 6000, 'Nginx Proxy Manager') : Promise.resolve(null),
        getClient().ping(),
      ])

      const nodes   = nodesR.status   === 'fulfilled' ? nodesR.value   : []
      const vms     = vmsR.status     === 'fulfilled' ? vmsR.value     : []
      const ceph    = cephR.status    === 'fulfilled' ? cephR.value    : null
      const osds    = osdR.status     === 'fulfilled' ? osdR.value     : []
      const ha      = haR.status      === 'fulfilled' ? haR.value      : []
      const storage = storageR.status === 'fulfilled' ? storageR.value : []
      const gpu     = gpuR.status     === 'fulfilled' ? gpuR.value     : null
      const npmStats = npmR.status    === 'fulfilled' ? npmR.value     : null
      // The cluster's own name (PVE's /cluster/status), for the page subtitle. Absent on a standalone node.
      const clusterName = pingR.status === 'fulfilled' ? (pingR.value as any).cluster ?? null : null

      // Cluster totals — aggregate across all nodes
      const clusterTotals = nodes.reduce((acc, n) => ({
        cpu_used:  acc.cpu_used  + (n.cpu * n.maxcpu),
        cpu_total: acc.cpu_total + n.maxcpu,
        mem_used:  acc.mem_used  + n.mem,
        mem_total: acc.mem_total + n.maxmem,
        disk_used: acc.disk_used + n.disk,
        disk_total:acc.disk_total+ n.maxdisk,
      }), { cpu_used: 0, cpu_total: 0, mem_used: 0, mem_total: 0, disk_used: 0, disk_total: 0 })

      return {
        success: true,
        data: {
          nodes, vms, ceph, osds, ha, storage, gpu, clusterName,
          cluster: {
            ...clusterTotals,
            cpu_pct:  clusterTotals.cpu_total  ? Math.round((clusterTotals.cpu_used  / clusterTotals.cpu_total)  * 100) : 0,
            mem_pct:  clusterTotals.mem_total  ? Math.round((clusterTotals.mem_used  / clusterTotals.mem_total)  * 100) : 0,
            disk_pct: clusterTotals.disk_total ? Math.round((clusterTotals.disk_used / clusterTotals.disk_total) * 100) : 0,
          },
          services: {
            npm: npmHealth({
              configured: !!npm,
              stats:      npmStats as any,
              error:      npmR.status === 'rejected' ? String(npmR.reason?.message ?? npmR.reason) : null,
              url:        process.env.NPM_URL,
            }),
          },
        },
      }
    } catch (e: any) {
      return sendFailure(req, r, e, "HyperProx couldn't put the cluster summary together.")
    }
  })
}
