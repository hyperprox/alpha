// =============================================================================
//  HyperProx — Infrastructure Routes (VM/CT management)
// =============================================================================

import { strictParams } from '../lib/route-params'
import { FastifyPluginAsync } from 'fastify'
import { livePve }            from '../lib/pve-env'
import { maskConfig }         from '../lib/guest-config/secrets'

/** The Proxmox tag that keeps HyperProx out of a guest (lib/remote/service.ts IGNORE_TAG). */
const IGNORE_TAG = 'hyperprox-ignore'


const wrap = async (reply: any, fn: () => Promise<any>) => {
  try   { return { success: true, data: await fn() } }
  catch (e: any) { return reply.status(500).send({ success: false, error: e.message }) }
}

type VMParams     = { Params: { node: string; vmid: string; type: 'qemu' | 'lxc' } }
type ActionParams = { Params: { node: string; vmid: string; type: 'qemu' | 'lxc'; action: 'start' | 'stop' | 'reboot' | 'shutdown' } }
const POWER_ACTIONS: string[] = ['start', 'stop', 'reboot', 'shutdown']
type SnapParams   = { Params: { node: string; vmid: string; type: 'qemu' | 'lxc'; snapname: string } }

export const infrastructureRoutes: FastifyPluginAsync = async (fastify) => {
  strictParams(fastify)   // node, vmid, type and snapshot names are checked before any handler (lib/route-params.ts)
  const pve = livePve()   // resolves the current token on every call (see lib/pve-env.ts)

  // Power actions. The last segment is a parameter, so anything else (an old `/vnc` call, say) is refused
  // here rather than sent on to Proxmox as `/status/<whatever>`.
  fastify.post<ActionParams>('/vms/:node/:vmid/:type/:action', async (req, r) => {
    const { node, vmid, type, action } = req.params
    if (!POWER_ACTIONS.includes(action)) return r.status(404).send({ success: false, error: `no such action: ${action}` })
    return wrap(r, () => pve.vmAction(node, Number(vmid), type, action))
  })

  // VM config, read-only, admin (lib/roles.ts). There is deliberately no console-ticket route (the browser must
  // never hold a Proxmox ticket) and no raw config write (it forwarded any body, `delete=` keys included).
  // Masked as the guest config editor masks it: passwords, keys, cloud-init secrets and the like are reported
  // as set or not set, never sent. A guest tagged hyperprox-ignore is one HyperProx does not look inside, so
  // only its tags come back.
  fastify.get<VMParams>('/vms/:node/:vmid/:type/config', async (req, r) => {
    const { node, vmid, type } = req.params
    return wrap(r, async () => {
      const cfg = (await pve.getVMConfig(node, Number(vmid), type)) as Record<string, any>
      const tags = String(cfg?.tags ?? '').split(/[;,\s]+/).filter(Boolean)
      if (tags.includes(IGNORE_TAG)) return { tags: cfg.tags, ignored: true }
      return maskConfig(cfg as any)
    })
  })

  // Snapshots
  fastify.get<VMParams>('/vms/:node/:vmid/:type/snapshots', async (req, r) => {
    const { node, vmid, type } = req.params
    return wrap(r, () => pve.getSnapshots(node, Number(vmid), type))
  })

  fastify.post<VMParams & { Body: { name: string; description?: string } }>('/vms/:node/:vmid/:type/snapshots', async (req, r) => {
    const { node, vmid, type } = req.params
    return wrap(r, () => pve.createSnapshot(node, Number(vmid), type, req.body.name, req.body.description))
  })

  fastify.delete<SnapParams>('/vms/:node/:vmid/:type/snapshots/:snapname', async (req, r) => {
    const { node, vmid, type, snapname } = req.params
    return wrap(r, () => pve.deleteSnapshot(node, Number(vmid), type, snapname))
  })

  fastify.post<SnapParams>('/vms/:node/:vmid/:type/snapshots/:snapname/rollback', async (req, r) => {
    const { node, vmid, type, snapname } = req.params
    return wrap(r, () => pve.rollbackSnapshot(node, Number(vmid), type, snapname))
  })

  // Migration
  fastify.post<VMParams & { Body: { target: string; online?: boolean } }>('/vms/:node/:vmid/:type/migrate', async (req, r) => {
    const { node, vmid, type } = req.params
    return wrap(r, () => pve.migrateVM(node, Number(vmid), type, req.body.target, req.body.online ?? true))
  })

  // HA management
  fastify.put<{ Params: { sid: string }; Body: { state: 'started' | 'stopped' | 'disabled' } }>('/ha/:sid', async (req, r) => {
    return wrap(r, () => pve.setHAState(req.params.sid, req.body.state))
  })

  // Cluster tasks
  fastify.get('/tasks', async (_, r) => wrap(r, () => pve.getClusterTasks()))

  // Node tasks
  fastify.get<{ Params: { node: string } }>('/nodes/:node/tasks', async (req, r) =>
    wrap(r, () => pve.getNodeTasks(req.params.node)))
}
