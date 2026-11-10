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
import type { ProxmoxClient } from '../proxmox-client'
import { execOnNode, execInGuest, nodeCredential, vmScriptCommand, containerScriptCommand, type ExecResult } from '../node-exec'
import { runInCluster } from '../clusters/context'
import { remoteNodeAddress } from '../clusters/nodes'
import { runPluginMetrics } from '../plugin-host'
import { plexPlugin } from '../../plugins/plex'
import { parsePveAptList } from './commands'

export type { ExecResult }

export interface ClusterNode { name: string; online: boolean; ip?: string }
export interface ClusterStatus {
  quorate: boolean
  nodes: ClusterNode[]
  /** One node and no cluster at all (a standalone server): there is no quorum or HA to check. */
  standalone?: boolean
}

/** A vzdump task as the node's task list shows it. `ok` null: still running. */
export interface BackupTask { node: string; at: number; ok: boolean | null; vmid: number | null }

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
  /**
   * Whether this cluster runs Ceph at all, from /etc/pve/ceph.conf. Asked once
   * per job, explicitly, so that a failed health read can never be mistaken for
   * "no Ceph here".
   */
  cephPresent(): Promise<boolean>
  /** Throws when health cannot be read. Only meaningful when cephPresent() is true. */
  cephHealth(): Promise<CephHealth>
  listGuests(): Promise<GuestListing[]>
  guestConfig(guest: GuestRef): Promise<Record<string, any>>
  nodeAptPending(node: string): Promise<UpdatesPkgChange[]>
  /** Active Plex streams, or null when no Plex source is configured. Throws when the source does not answer. */
  plexStreams(): Promise<number | null>
  /** Recent vzdump tasks on every online node, newest first. Optional: without it no backup is reported. */
  backupTasks?(): Promise<BackupTask[]>

  // -- actions --------------------------------------------------------------------
  /** `apt update` on a node, through the Proxmox API, waiting for the task. */
  nodeAptRefresh(node: string): Promise<void>
  nodeExec(node: string, command: string, onLine?: LineSink, timeoutMs?: number): Promise<ExecResult>
  guestExec(guest: GuestRef, script: string, onLine?: LineSink, timeoutMs?: number): Promise<ExecResult>
  snapshot(guest: GuestRef, name: string): Promise<void>
  listSnapshots(guest: GuestRef): Promise<{ name: string; snaptime?: number }[]>
  deleteSnapshot(guest: GuestRef, name: string): Promise<void>
  /** Roll back to a snapshot and start the guest again. Only on a person's request (see runner.rollbackGuest). */
  rollbackSnapshot(guest: GuestRef, name: string): Promise<void>

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

/** Every read below fails on an error answer: a gate that cannot read must not pass. */
function mustArray<T = any>(v: unknown, what: string): T[] {
  if (!Array.isArray(v)) throw new Error(`Proxmox returned no ${what}`)
  return v as T[]
}

function mustObject(v: unknown, what: string): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`Proxmox returned no ${what}`)
  return v as Record<string, any>
}

async function waitForTask(pve: ProxmoxClient, node: string, upid: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const st = mustObject(await pve.fetchStrict<any>(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`), 'task status')
    if (st.status === 'stopped') {
      if (st.exitstatus !== 'OK') throw new Error(`task ${upid} ended: ${st.exitstatus}`)
      return
    }
    await sleep(2000)
  }
  throw new Error(`task ${upid} did not finish within ${Math.round(timeoutMs / 1000)}s`)
}

export interface ExecutorOptions {
  /**
   * A remote cluster: nodes are reached on the address saved for them (never the one the node reports), only
   * over a login whose host key an admin confirmed (requirePin), and every script passes the script guard
   * (node-exec does that for any remote context). No Plex wait: the home Plex says nothing about a remote.
   */
  remote?: boolean
}

export function productionExecutor(pve: ProxmoxClient = livePve(), opts: ExecutorOptions = {}): UpdatesExecutor {
  let ips: Record<string, string> = {}
  const remote = !!opts.remote

  async function hostFor(node: string): Promise<string> {
    if (remote) {
      const a = remoteNodeAddress(node)
      if (!a) throw new Error(`No address is saved for node ${node} on this server. Add it under Edit server, Nodes and logins.`)
      return a
    }
    if (!ips[node]) await exec.clusterStatus()
    return ips[node] ?? node
  }

  async function credFor(node: string) {
    const cred = await nodeCredential(node)
    if (!cred) throw new Error(remote
      ? `No saved login for node ${node} on this server. Add one under Edit server, Nodes and logins.`
      : `No saved login for node ${node}. Add one in the Terminal before running updates.`)
    return cred
  }

  // Remote only: the pinned login's own port, and a host key an admin confirmed. Home is unchanged.
  const pin = (cred: { port?: number }) => (remote ? { requirePin: true, port: Number(cred.port) || 22 } : {})

  const exec: UpdatesExecutor = {
    async clusterStatus() {
      const rows = mustArray(await pve.fetchStrict<any[]>('/cluster/status'), 'cluster status')
      const cluster = rows.find(r => r.type === 'cluster')
      const nodes = rows.filter(r => r.type === 'node').map(r => ({ name: String(r.name), online: r.online === 1, ip: r.ip }))
      if (!nodes.length) throw new Error('Proxmox cluster status lists no nodes')
      ips = Object.fromEntries(nodes.filter(n => n.ip).map(n => [n.name, n.ip as string]))
      // A single-node install has no cluster row and is quorate by definition.
      const standalone = !cluster && nodes.length === 1
      return standalone ? { quorate: true, nodes, standalone } : { quorate: cluster ? cluster.quorate === 1 : nodes.length === 1, nodes }
    },

    async haStatus() {
      const rows = mustArray(await pve.fetchStrict<any[]>('/cluster/ha/status/current'), 'HA status')
      return {
        services: rows.filter(r => r.type === 'service').map(r => ({ sid: String(r.sid), node: String(r.node), state: String(r.state ?? r.crm_state ?? '') })),
        maintenanceNodes: rows.filter(r => r.type === 'lrm' && /maintenance/i.test(String(r.status))).map(r => String(r.node)),
      }
    },

    async haResources() {
      return mustArray(await pve.fetchStrict<any[]>('/cluster/ha/resources'), 'HA resource list').map(r => String(r.sid))
    },

    async cephPresent() {
      const s = await exec.clusterStatus()
      const node = s.nodes.filter(n => n.online).map(n => n.name).sort()[0]
      if (!node) throw new Error('no online node to ask whether Ceph is configured')
      // /etc/pve is the cluster filesystem, so any node answers for all of them.
      const r = await exec.nodeExec(node, '[ -e /etc/pve/ceph.conf ] && echo HP_CEPH_YES || echo HP_CEPH_NO', undefined, 30_000)
      if (/HP_CEPH_YES/.test(r.output)) return true
      if (/HP_CEPH_NO/.test(r.output)) return false
      throw new Error(`could not tell whether Ceph is configured: ${r.output.slice(0, 200)}`)
    },

    async cephHealth() {
      const s = mustObject(await pve.fetchStrict<any>('/cluster/ceph/status'), 'Ceph status')
      if (!s.health?.status) throw new Error('Proxmox returned Ceph status without health')
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
      return mustArray(await pve.fetchStrict<any[]>('/cluster/resources?type=vm'), 'guest list')
        .filter((r: any) => r.type === 'lxc' || r.type === 'qemu')
        .map((r: any) => ({
          vmid: Number(r.vmid), type: r.type, node: String(r.node), name: String(r.name ?? ''),
          running: r.status === 'running', template: r.template === 1,
        }))
    },

    async guestConfig(g) {
      return mustObject(await pve.fetchStrict<any>(`/nodes/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}/config`), `config for ${g.vmid}`)
    },

    async nodeAptPending(node) {
      // GET lists what the node's last `apt update` already knows; it changes nothing.
      return parsePveAptList(mustArray(await pve.fetchStrict<any[]>(`/nodes/${encodeURIComponent(node)}/apt/update`), `pending list for ${node}`))
    },

    async backupTasks() {
      const s = await exec.clusterStatus()
      const out: BackupTask[] = []
      for (const n of s.nodes.filter(x => x.online)) {
        const rows = await pve.fetchStrict<any[]>(`/nodes/${encodeURIComponent(n.name)}/tasks?typefilter=vzdump&limit=20&source=all`).catch(() => [])
        for (const t of Array.isArray(rows) ? rows : []) {
          const at = Number(t.starttime) * 1000
          if (!Number.isFinite(at)) continue
          const running = t.status === undefined || t.status === null || t.status === '' || t.status === 'running'
          const vmid = /^\d{1,9}$/.test(String(t.id ?? '')) ? Number(t.id) : null
          out.push({ node: n.name, at, ok: running ? null : t.status === 'OK', vmid })
        }
      }
      return out.sort((a, b) => b.at - a.at)
    },

    async plexStreams() {
      if (remote) return null
      try {
        const rows = await runPluginMetrics(plexPlugin)
        const all = rows.find(r => r.name === 'plex_streams' && r.labels?.decision === 'all')
        if (!all) throw new Error('the Plex plug-in reported no stream count')
        return all.value
      } catch (e: any) {
        if (/Not configured yet/.test(String(e?.message))) return null
        throw e
      }
    },

    async nodeAptRefresh(node) {
      const upid = await pve.fetchStrict<string>(`/nodes/${encodeURIComponent(node)}/apt/update`, 'POST')
      if (typeof upid !== 'string' || !upid.startsWith('UPID:')) throw new Error(`apt update on ${node} was not started`)
      await waitForTask(pve, node, upid, 10 * 60_000)
    },

    async nodeExec(node, command, onLine, timeoutMs) {
      const cred = await credFor(node)
      return execOnNode({ host: await hostFor(node), cred, command, timeoutMs, onData: lineSplitter(onLine), ...pin(cred) })
    },

    async guestExec(g, script, onLine, timeoutMs) {
      const host = await hostFor(g.node)
      const cred = await credFor(g.node)
      if (g.type === 'lxc') {
        if (remote) return execOnNode({ host, cred, command: containerScriptCommand(g.vmid), input: script, timeoutMs, onData: lineSplitter(onLine), ...pin(cred) })
        return execInGuest({ host, cred, vmid: g.vmid, script, timeoutMs, onData: lineSplitter(onLine) })
      }
      // VMs through the QEMU guest agent. The script goes on stdin, never on a command line: no quoting layer
      // can mangle it, and a certificate deploy's private key is not left in any process list.
      const secs = Math.ceil((timeoutMs ?? 30 * 60_000) / 1000)
      const r = await execOnNode({
        host, cred, timeoutMs: (secs + 30) * 1000,
        command: vmScriptCommand(g.vmid, secs), input: script, ...pin(cred),
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
      const upid = await pve.fetchStrict<string>(`/nodes/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}/snapshot`, 'POST',
        new URLSearchParams({ snapname: name, description: 'Taken by HyperProx before updating' }).toString(), 60_000)
      if (typeof upid !== 'string' || !upid.startsWith('UPID:')) throw new Error('Proxmox refused the snapshot')
      await waitForTask(pve, g.node, upid, 10 * 60_000)
    },

    async listSnapshots(g) {
      return mustArray(await pve.fetchStrict<any[]>(`/nodes/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}/snapshot`), `snapshots of ${g.vmid}`)
        .filter((x: any) => x.name && x.name !== 'current')
        .map((x: any) => ({ name: String(x.name), snaptime: x.snaptime ? Number(x.snaptime) : undefined }))
    },

    async deleteSnapshot(g, name) {
      const upid = await pve.fetchStrict<string>(`/nodes/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}/snapshot/${encodeURIComponent(name)}`, 'DELETE', undefined, 60_000)
      if (typeof upid === 'string' && upid.startsWith('UPID:')) await waitForTask(pve, g.node, upid, 10 * 60_000)
    },

    async rollbackSnapshot(g, name) {
      const upid = await pve.fetchStrict<string>(`/nodes/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}/snapshot/${encodeURIComponent(name)}/rollback`, 'POST',
        new URLSearchParams({ start: '1' }).toString(), 60_000)
      if (typeof upid !== 'string' || !upid.startsWith('UPID:')) throw new Error('Proxmox refused the rollback')
      await waitForTask(pve, g.node, upid, 15 * 60_000)
    },

    now: () => Date.now(),
    sleep,
  }
  return exec
}

const EXECUTOR_METHODS: (keyof UpdatesExecutor)[] = [
  'clusterStatus', 'haStatus', 'haResources', 'cephPresent', 'cephHealth', 'listGuests', 'guestConfig', 'nodeAptPending',
  'plexStreams', 'backupTasks', 'nodeAptRefresh', 'nodeExec', 'guestExec', 'snapshot', 'listSnapshots', 'deleteSnapshot',
  'rollbackSnapshot', 'now', 'sleep',
]

/**
 * Every call of `exec` runs as if a request for cluster `id` had arrived: the Proxmox client, node logins and
 * node addresses it reaches are that cluster's, whatever context the caller (a background job, the scheduler,
 * the daily check) happens to be in. Time stays the caller's.
 */
export function clusterBound(id: string, exec: UpdatesExecutor): UpdatesExecutor {
  const out: any = {}
  for (const key of EXECUTOR_METHODS) {
    const v = (exec as any)[key]
    if (typeof v !== 'function') continue
    out[key] = key === 'now' || key === 'sleep' ? v.bind(exec) : (...args: any[]) => runInCluster(id, () => v.apply(exec, args))
  }
  return out as UpdatesExecutor
}

/** The production executor for a remote cluster, bound to it. */
export function remoteExecutor(id: string): UpdatesExecutor {
  return clusterBound(id, productionExecutor(livePve(), { remote: true }))
}
