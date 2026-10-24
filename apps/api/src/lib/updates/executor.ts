// =============================================================================
//  HyperProx — Updates: the executor
//
//  Everything the Updates feature does to, or reads from, the cluster goes
//  through this interface. The runner, gates and inventory never import an SSH
//  or HTTP client; production binds them to proxmox-client and node-exec here,
//  and every test binds a fake. That is what lets a test fail an `apt` run on a
//  node, or keep a node from coming back, without a cluster.
// =============================================================================

import type { UpdatesPkgChange } from './types'
import { livePve } from '../pve-env'
import { execOnNode, execInGuest, nodeCredential, type ExecResult } from '../node-exec'
import { runPluginMetrics } from '../plugin-host'
import { plexPlugin } from '../../plugins/plex'
import { parsePveAptList } from './commands'

export type { ExecResult }

export interface ClusterNode { name: string; online: boolean; ip?: string }
export interface ClusterStatus { quorate: boolean; nodes: ClusterNode[] }

export interface HaService { sid: string; node: string; state: string }
export interface HaStatus { services: HaService[]; maintenanceNodes: string[] }

export interface CephHealth {
  status:     string                     // HEALTH_OK | HEALTH_WARN | HEALTH_ERR
  checks:     string[]                   // health codes currently raised
  numOsds:    number
  numUpOsds:  number
  numInOsds:  number
  /** PG states and counts, e.g. { 'active+clean': 411, 'active+clean+scrubbing': 1 } */
  pgStates:   Record<string, number>
}

export interface GuestRef { vmid: number; type: 'lxc' | 'qemu'; node: string; name: string }
export interface GuestListing extends GuestRef { running: boolean; template: boolean }

export type LineSink = (line: string) => void

export interface UpdatesExecutor {
  // -- reads ------------------------------------------------------------------
  clusterStatus(): Promise<ClusterStatus>
  haStatus(): Promise<HaStatus>
  /** HA resource ids, e.g. "ct:101", "vm:102". */
  haResources(): Promise<string[]>
  /** null when the cluster has no Ceph. */
  cephHealth(): Promise<CephHealth | null>
  listGuests(): Promise<GuestListing[]>
  guestConfig(guest: GuestRef): Promise<Record<string, any>>
  nodeAptPending(node: string): Promise<UpdatesPkgChange[]>
  /** Active Plex streams, or null when no Plex source is configured. Throws when the source does not answer. */
  plexStreams(): Promise<number | null>

  // -- actions --------------------------------------------------------------------
  /** `apt update` on a node, through the Proxmox API, waiting for the task. */
  nodeAptRefresh(node: string): Promise<void>
  nodeExec(node: string, command: string, onLine?: LineSink, timeoutMs?: number): Promise<ExecResult>
  guestExec(guest: GuestRef, script: string, onLine?: LineSink, timeoutMs?: number): Promise<ExecResult>
  snapshot(guest: GuestRef, name: string): Promise<void>

  // -- time, so tests do not wait ----------------------------------------------------
  now(): number
  sleep(ms: number): Promise<void>
}

// =============================================================================
//  Production binding
// =============================================================================

function lineSplitter(sink?: LineSink): ((chunk: string) => void) | undefined {
  if (!sink) return undefined
  let buf = ''
  return (chunk: string) => {
    buf += chunk.replace(/\r/g, '\n')
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const p of parts) if (p.trim()) sink(p)
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function waitForTask(node: string, upid: string, timeoutMs: number): Promise<void> {
  const pve = livePve()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const st = await pve.fetchNode<any>(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`)
    if (st?.status === 'stopped') {
      if (st.exitstatus !== 'OK') throw new Error(`task ${upid} ended: ${st.exitstatus}`)
      return
    }
    await sleep(2000)
  }
  throw new Error(`task ${upid} did not finish within ${Math.round(timeoutMs / 1000)}s`)
}

export function productionExecutor(): UpdatesExecutor {
  const pve = livePve()
  let ips: Record<string, string> = {}

  async function hostFor(node: string): Promise<string> {
    if (!ips[node]) await exec.clusterStatus()
    return ips[node] ?? node
  }

  async function credFor(node: string) {
    const cred = await nodeCredential(node)
    if (!cred) throw new Error(`No saved login for node ${node}. Add one in the Terminal before running updates.`)
    return cred
  }

  const exec: UpdatesExecutor = {
    async clusterStatus() {
      const rows = await pve.fetchNode<any[]>('/cluster/status')
      if (!Array.isArray(rows)) throw new Error('Proxmox returned no cluster status')
      const cluster = rows.find(r => r.type === 'cluster')
      const nodes = rows.filter(r => r.type === 'node').map(r => ({ name: String(r.name), online: r.online === 1, ip: r.ip }))
      ips = Object.fromEntries(nodes.filter(n => n.ip).map(n => [n.name, n.ip as string]))
      // A single-node install has no cluster row and is quorate by definition.
      return { quorate: cluster ? cluster.quorate === 1 : nodes.length === 1, nodes }
    },

    async haStatus() {
      const rows = await pve.fetchNode<any[]>('/cluster/ha/status/current')
      if (!Array.isArray(rows)) return { services: [], maintenanceNodes: [] }
      return {
        services: rows.filter(r => r.type === 'service').map(r => ({ sid: String(r.sid), node: String(r.node), state: String(r.state ?? r.crm_state ?? '') })),
        maintenanceNodes: rows.filter(r => r.type === 'lrm' && /maintenance/i.test(String(r.status))).map(r => String(r.node)),
      }
    },

    async haResources() {
      const rows = await pve.fetchNode<any[]>('/cluster/ha/resources')
      return Array.isArray(rows) ? rows.map(r => String(r.sid)) : []
    },

    async cephHealth() {
      let s: any
      try { s = await pve.fetchNode<any>('/cluster/ceph/status') } catch { return null }
      // PVE answers an error, including "Ceph not installed", as {"data":null}.
      if (!s || !s.health) return null
      const pgStates: Record<string, number> = {}
      for (const r of s.pgmap?.pgs_by_state ?? []) pgStates[String(r.state_name)] = Number(r.count)
      return {
        status:    String(s.health.status),
        checks:    Object.keys(s.health.checks ?? {}),
        numOsds:   Number(s.osdmap?.num_osds ?? 0),
        numUpOsds: Number(s.osdmap?.num_up_osds ?? 0),
        numInOsds: Number(s.osdmap?.num_in_osds ?? 0),
        pgStates,
      }
    },

    async listGuests() {
      const rows = await pve.getClusterResources('vm')
      return (rows ?? [])
        .filter((r: any) => r.type === 'lxc' || r.type === 'qemu')
        .map((r: any) => ({
          vmid: Number(r.vmid), type: r.type, node: String(r.node), name: String(r.name ?? ''),
          running: r.status === 'running', template: r.template === 1,
        }))
    },

    async guestConfig(g) {
      return (await pve.getVMConfig(g.node, g.vmid, g.type)) ?? {}
    },

    async nodeAptPending(node) {
      // GET lists what the node's last `apt update` already knows; it changes nothing.
      return parsePveAptList(await pve.fetchNode<any[]>(`/nodes/${encodeURIComponent(node)}/apt/update`))
    },

    async plexStreams() {
      try {
        const rows = await runPluginMetrics(plexPlugin)
        const all = rows.find(r => r.name === 'plex_streams' && r.labels?.decision === 'all')
        return all ? all.value : 0
      } catch (e: any) {
        if (/Not configured yet/.test(String(e?.message))) return null
        throw e
      }
    },

    async nodeAptRefresh(node) {
      const upid = await pve.fetchNode<string>(`/nodes/${encodeURIComponent(node)}/apt/update`, 'POST')
      if (typeof upid !== 'string' || !upid.startsWith('UPID:')) throw new Error(`apt update on ${node} was not started`)
      await waitForTask(node, upid, 10 * 60_000)
    },

    async nodeExec(node, command, onLine, timeoutMs) {
      return execOnNode({ host: await hostFor(node), cred: await credFor(node), command, timeoutMs, onData: lineSplitter(onLine) })
    },

    async guestExec(g, script, onLine, timeoutMs) {
      const host = await hostFor(g.node)
      const cred = await credFor(g.node)
      if (g.type === 'lxc') {
        return execInGuest({ host, cred, vmid: g.vmid, script, timeoutMs, onData: lineSplitter(onLine) })
      }
      // VMs through the QEMU guest agent. The script travels base64-encoded so no quoting layer can mangle it.
      const b64 = Buffer.from(script).toString('base64')
      const secs = Math.ceil((timeoutMs ?? 30 * 60_000) / 1000)
      const r = await execOnNode({
        host, cred, timeoutMs: (secs + 30) * 1000,
        command: `qm guest exec ${g.vmid} --timeout ${secs} -- bash -c 'echo ${b64} | base64 -d | bash'`,
      })
      if (r.code !== 0) return r
      try {
        const j = JSON.parse(r.output)
        const output = `${j['out-data'] ?? ''}${j['err-data'] ?? ''}`
        lineSplitter(onLine)?.(output + '\n')
        return { code: j.exited ? Number(j.exitcode ?? 0) : -1, output, timedOut: !j.exited }
      } catch {
        return { code: -1, output: r.output, timedOut: false }
      }
    },

    async snapshot(g, name) {
      const upid = await pve.fetchNode<string>(`/nodes/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}/snapshot`, 'POST',
        new URLSearchParams({ snapname: name, description: 'Taken by HyperProx before updating' }).toString())
      if (typeof upid !== 'string' || !upid.startsWith('UPID:')) throw new Error('Proxmox refused the snapshot')
      await waitForTask(g.node, upid, 10 * 60_000)
    },

    now: () => Date.now(),
    sleep,
  }
  return exec
}
