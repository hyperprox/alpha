// =============================================================================
//  HyperProx — Infrastructure Routes (VM/CT management)
// =============================================================================

import { FastifyPluginAsync } from 'fastify'
import { ProxmoxClient }      from '../lib/proxmox-client'

function getClient() {
  return new ProxmoxClient(
    process.env.PROXMOX_HOST!,
    Number(process.env.PROXMOX_PORT ?? 8006),
    `${process.env.PROXMOX_USER}!${process.env.PROXMOX_TOKEN_ID}`,
    process.env.PROXMOX_TOKEN_SECRET!,
  )
}

const wrap = async (reply: any, fn: () => Promise<any>) => {
  try   { return { success: true, data: await fn() } }
  catch (e: any) { return reply.status(500).send({ success: false, error: e.message }) }
}

type VMParams     = { Params: { node: string; vmid: string; type: 'qemu' | 'lxc' } }
type ActionParams = { Params: { node: string; vmid: string; type: 'qemu' | 'lxc'; action: 'start' | 'stop' | 'reboot' | 'shutdown' } }
type SnapParams   = { Params: { node: string; vmid: string; type: 'qemu' | 'lxc'; snapname: string } }

export const infrastructureRoutes: FastifyPluginAsync = async (fastify) => {
  const pve = getClient()

  // Power actions
  fastify.post<ActionParams>('/vms/:node/:vmid/:type/:action', async (req, r) => {
    const { node, vmid, type, action } = req.params
    return wrap(r, () => pve.vmAction(node, Number(vmid), type, action))
  })

  // VNC console ticket
  fastify.post<VMParams>('/vms/:node/:vmid/:type/vnc', async (req, r) => {
    const { node, vmid, type } = req.params
    return wrap(r, () => pve.getVNCTicket(node, Number(vmid), type))
  })

  // VM config
  fastify.get<VMParams>('/vms/:node/:vmid/:type/config', async (req, r) => {
    const { node, vmid, type } = req.params
    return wrap(r, () => pve.getVMConfig(node, Number(vmid), type))
  })

  fastify.put<VMParams & { Body: any }>('/vms/:node/:vmid/:type/config', async (req, r) => {
    const { node, vmid, type } = req.params
    return wrap(r, () => pve.updateVMConfig(node, Number(vmid), type, req.body as any))
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
