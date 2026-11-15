// =============================================================================
//  HyperProx — load balancing: reading the cluster
//
//  Everything the engine needs, in as few Proxmox calls as the facts allow:
//  the HA snapshot (with every guest's config, not only HA guests'), each
//  node's CPU, where each storage is active, the task log (backups and moves
//  running now, past migrations) and the network settings. Reads only. A part
//  that cannot be read is listed in `unread` and the engine says "unknown".
//
//  History comes from Prometheus (the Proxmox exporter's series), through one
//  range query per figure.
// =============================================================================

import { buildSnapshot, sidOf } from '../ha/parse'
import { readRaw, type HaPve } from '../ha/read'
import type { HaSnapshot, Sid } from '../ha/types'
import { parseFlags, type NodeCpu } from './cpu'
import { networkCost } from './network'
import { observedDurations, type BackupJob } from './windows'
import type { GuestSeries, NetworkCost, NodeSeries, Sample } from './types'
import type { EngineInput } from './engine'
import type { GuestLocations } from './balance'

const enc = encodeURIComponent

export interface ClusterRead {
  input:   Omit<EngineInput, 'network' | 'settings'>
  network: NetworkCost
  jobs:    BackupJob[]
  /** False when /cluster/backup could not be read: quiet windows are then unknown. */
  jobsRead: boolean
  tz:      string
  tasks:   any[]
}

/** True for a task that has not finished (Proxmox leaves endtime and status off until it does). */
export const taskRunning = (t: any) => !t?.endtime && (!t?.status || t.status === 'running')

export async function readCluster(pve: HaPve, opts: { suggestedBwlimit?: number; now?: number } = {}): Promise<ClusterRead> {
  const unread: string[] = []
  let tasksRead = true, jobsRead = true
  const vms = await pve.fetchStrict<any[]>('/cluster/resources?type=vm')
  const sids = (vms ?? []).filter(v => v.type === 'lxc' || v.type === 'qemu').map(v => sidOf(v.type, v.vmid))
  const [raw, tasks, corosyncNodes, backups] = await Promise.all([
    readRaw(pve, { configs: 'ha', extra: sids }),
    pve.fetchStrict<any[]>('/cluster/tasks').catch(() => { unread.push('the cluster task log'); tasksRead = false; return [] as any[] }),
    pve.fetchStrict<any[]>('/cluster/config/nodes').catch(() => { unread.push('the corosync node list'); return null }),
    pve.fetchStrict<any[]>('/cluster/backup').catch(() => { unread.push('the backup jobs'); jobsRead = false; return [] as any[] }),
  ])
  const snap: HaSnapshot = buildSnapshot(raw)
  const configs: Record<Sid, Record<string, unknown> | null> = { ...(raw.configs ?? {}) }
  for (const sid of sids) {
    // Not read (the node did not answer): null, so the engine says "unknown" for it instead of seeing no hardware.
    if (configs[sid] === undefined) configs[sid] = null
    if (configs[sid] === null) unread.push(`the config of ${sid}`)
  }

  const online = snap.nodes.filter(n => n.online).map(n => n.node)
  const nodeCpu: Record<string, NodeCpu> = {}
  let tz = ''
  await Promise.all(snap.nodes.map(async n => {
    if (!n.online) { nodeCpu[n.node] = { model: null, vendor: null, flags: null }; return }
    const st = await pve.fetchStrict<any>(`/nodes/${enc(n.node)}/status`).catch(() => null)
    const c = st?.cpuinfo
    if (!c) unread.push(`the CPU of ${n.node}`)
    nodeCpu[n.node] = { model: c?.model ? String(c.model) : null, vendor: c?.vendor ? String(c.vendor) : null, flags: parseFlags(c?.flags) }
  }))
  if (online[0]) {
    const t = await pve.fetchStrict<any>(`/nodes/${enc(online[0])}/time`).catch(() => null)
    tz = t?.timezone ? String(t.timezone) : ''
  }
  if (!tz) { unread.push("the cluster's time zone (UTC is assumed)"); tz = 'UTC' }

  const storageNodes: Record<string, string[]> = {}
  for (const s of raw.storage ?? []) {
    if (s?.status && s.status !== 'available') continue
    const id = String(s.storage ?? ''); if (!id) continue
    ;(storageNodes[id] ??= []).push(String(s.node))
  }

  const usage: EngineInput['usage'] = {}
  for (const v of vms ?? []) {
    if (v.type !== 'lxc' && v.type !== 'qemu') continue
    usage[sidOf(v.type, v.vmid)] = { cores: (Number(v.cpu) || 0) * (Number(v.maxcpu) || 0), mem: Number(v.mem) || 0 }
  }

  const running = (tasks ?? []).filter(taskRunning)
  const backupsRunning = running.filter(t => t.type === 'vzdump').map(t => ({ node: String(t.node), ...(/^\d+$/.test(String(t.id ?? '')) ? { vmid: Number(t.id) } : {}) }))
  const migrating = running.filter(t => /^(qmigrate|vzmigrate|hamigrate)$/.test(String(t.type))).map(t => {
    const vm = (vms ?? []).find(v => String(v.vmid) === String(t.id))
    return vm ? sidOf(vm.type, vm.vmid) : null
  }).filter((x): x is string => !!x)

  const lastMoveSec: Record<Sid, number> = {}
  for (const t of [...(tasks ?? [])].sort((a, b) => Number(a.starttime) - Number(b.starttime))) {
    if (t.type !== 'vzmigrate' || t.status !== 'OK' || !t.endtime) continue
    lastMoveSec[`ct:${t.id}`] = Math.max(1, Number(t.endtime) - Number(t.starttime))
  }

  const jobs0: BackupJob[] = (backups ?? []).filter(j => (j.type ?? 'vzdump') === 'vzdump').map(j => ({
    id: String(j.id), schedule: String(j.schedule ?? (j.dow || j.starttime ? `${j.dow ?? ''} ${j.starttime ?? ''}`.trim() : '')),
    enabled: j.enabled === undefined ? true : Number(j.enabled) === 1,
  }))
  const durations = observedDurations(jobs0, tasks ?? [], tz)
  const jobs = jobs0.map(j => ({ ...j, durationSec: durations[j.id] ?? null }))

  const network = networkCost({ corosyncNodes, options: raw.options ?? null, suggestedBwlimit: opts.suggestedBwlimit })
  return {
    input: { snap, configs, nodeCpu, storageNodes, usage, backupsRunning, migrating: Array.from(new Set(migrating)), lastMoveSec, unread, tasksRead, now: opts.now },
    network, jobs, jobsRead, tz, tasks: tasks ?? [],
  }
}

// --- Prometheus history ---------------------------------------------------------------------------

export interface PromRange { (expr: string, startSec: number, endSec: number, stepSec: number): Promise<Array<{ metric: Record<string, string>; values: Sample[] }>> }

export const livePromRange = (base: string): PromRange => async (expr, start, end, step) => {
  const q = new URLSearchParams({ query: expr, start: String(start), end: String(end), step: String(step) })
  const res = await fetch(`${base}/api/v1/query_range?${q}`, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Prometheus answered HTTP ${res.status}`)
  const j: any = await res.json()
  return (j?.data?.result ?? []).map((r: any) => ({
    metric: r.metric ?? {},
    values: (r.values ?? []).map((v: any) => [Number(v[0]), Number(v[1])] as Sample).filter((v: Sample) => Number.isFinite(v[1])),
  }))
}

/** The home cluster's series carry no hpx_cluster label; this selects exactly them. */
const HOME = 'hpx_cluster=""'

export async function readHistory(prom: PromRange, opts: { hours: number; now: number; guests: Sid[] }): Promise<{
  nodes: NodeSeries[]; guests: GuestSeries[]; stepSec: number; start: number; end: number
  /** Where the history saw each guest (null when that could not be read). */
  locations: GuestLocations | null
}> {
  const end = Math.floor(opts.now / 1000 / 60) * 60
  const start = end - Math.round(opts.hours * 3600)
  const stepSec = Math.max(300, Math.ceil((end - start) / 1000 / 60) * 60)
  const node = 'id=~"node/.+"', guest = 'id=~"(qemu|lxc)/.+"'
  const [cpu, mem, gcores, gmem] = await Promise.all([
    prom(`max by (id) (pve_cpu_usage_ratio{${node},${HOME}})`, start, end, stepSec),
    prom(`max by (id) (pve_memory_usage_bytes{${node},${HOME}}) / max by (id) (pve_memory_size_bytes{${node},${HOME}})`, start, end, stepSec),
    prom(`max by (id) (pve_cpu_usage_ratio{${guest},${HOME}}) * on (id) max by (id) (pve_cpu_usage_limit{${guest},${HOME}})`, start, end, stepSec),
    prom(`max by (id) (pve_memory_usage_bytes{${guest},${HOME}})`, start, end, stepSec),
  ])
  // The node each guest ran on: the exporter's guest info carries it (as exported_node when Prometheus relabels it).
  const where = await prom(`max by (id, exported_node, node) (pve_guest_info{${guest},${HOME}})`, start, end, stepSec).catch(() => null)
  const byNode = new Map<string, NodeSeries>()
  const nodeOf = (id: string) => id.replace(/^node\//, '')
  for (const r of cpu) { const n = nodeOf(r.metric.id ?? ''); byNode.set(n, { node: n, cpu: r.values, mem: byNode.get(n)?.mem ?? [] }) }
  for (const r of mem) { const n = nodeOf(r.metric.id ?? ''); byNode.set(n, { node: n, cpu: byNode.get(n)?.cpu ?? [], mem: r.values }) }
  const want = new Set(opts.guests)
  const byGuest = new Map<string, GuestSeries>()
  const sidOfId = (id: string): Sid | null => { const m = /^(qemu|lxc)\/(\d+)$/.exec(id); return m ? sidOf(m[1] as 'qemu' | 'lxc', m[2]) : null }
  for (const r of gcores) { const s = sidOfId(r.metric.id ?? ''); if (s && want.has(s)) byGuest.set(s, { sid: s, cores: r.values, mem: byGuest.get(s)?.mem ?? [] }) }
  for (const r of gmem) { const s = sidOfId(r.metric.id ?? ''); if (s && want.has(s)) byGuest.set(s, { sid: s, cores: byGuest.get(s)?.cores ?? [], mem: r.values }) }
  let locations: GuestLocations | null = null
  if (where) {
    locations = {}
    for (const r of where) {
      const s = sidOfId(r.metric.id ?? ''), node = r.metric.exported_node ?? r.metric.node
      if (!s || !want.has(s) || !r.values.length) continue
      // A series that does not say which node: where the guests ran is not known at all.
      if (!node) { locations = null; break }
      ;(locations[s] ??= []).push({ node, first: r.values[0][0], last: r.values[r.values.length - 1][0] })
    }
    if (locations) for (const l of Object.values(locations)) l.sort((a, b) => a.last - b.last)
  }
  return { nodes: [...byNode.values()], guests: [...byGuest.values()], stepSec, start, end, locations }
}

