// =============================================================================
//  HyperProx — Updates: automatic reboots (settings, the window, and the pure rules)
//
//  The point of Updates is that nobody has to press Reboot after a kernel update. A node or guest that needs a
//  reboot is rebooted on its own, in a window the person chose, one machine at a time, through the same engine as
//  the Reboot button (lib/updates/runner.ts): quorum, Ceph and HA gates, noout and HA maintenance, the kernel pin
//  and holds read again before anything is set, HyperProx's own node last through a handoff.
//
//  This file holds what that engine needs and can be tested on its own:
//    - the settings, one set per cluster, OFF for a new install, kept in data/updates-reboots.json;
//    - the window in the cluster's time zone (start, length, days), now and next;
//    - which nodes and guests need a reboot, and which are left out (policy `auto_reboot: false`, leave-alone);
//    - whether a node's guests can move at all (a bind mount, a passed-through device, a strict HA rule);
//    - whether rebooting a node would cost the cluster its quorum.
// =============================================================================

import fs from 'node:fs'
import path from 'node:path'
import type { ClusterStatus } from './executor'
import type { NodeFacts } from './commands'
import type { GateResult } from './gates'
import { nodePolicy, type Policy } from './policy'
import { localParts } from '../placement/windows'
import type { UpdatesInventory, UpdatesRebootSettings, UpdatesRebootWindow } from './types'

// --- settings ---------------------------------------------------------------------------------

export function hostTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

/** Off for a new install: a person turns automatic reboots on. 03:00 to 06:00, every day, waiting for viewers. */
export function defaultRebootSettings(tz = hostTimezone()): UpdatesRebootSettings {
  return { nodes: false, guests: false, window: { start: '03:00', hours: 3, days: [0, 1, 2, 3, 4, 5, 6] }, timezone: tz, quiet: true }
}

export class RebootSettingsError extends Error {}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export function validTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

/** A full settings object from a partial one; throws RebootSettingsError with a sentence for anything wrong. */
export function mergeRebootSettings(base: UpdatesRebootSettings, patch: unknown): UpdatesRebootSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new RebootSettingsError('Settings must be an object.')
  const p = patch as Record<string, unknown>
  const known = new Set(['nodes', 'guests', 'window', 'timezone', 'quiet'])
  for (const k of Object.keys(p)) if (!known.has(k)) throw new RebootSettingsError(`"${k}" is not an automatic reboot setting.`)
  const out: UpdatesRebootSettings = { ...base, window: { ...base.window, days: [...base.window.days] } }
  for (const k of ['nodes', 'guests', 'quiet'] as const) {
    if (p[k] === undefined) continue
    if (typeof p[k] !== 'boolean') throw new RebootSettingsError(`"${k}" is on or off.`)
    out[k] = p[k] as boolean
  }
  if (p.timezone !== undefined) {
    if (typeof p.timezone !== 'string' || p.timezone.length > 64 || !validTimezone(p.timezone)) throw new RebootSettingsError('That time zone is not known.')
    out.timezone = p.timezone
  }
  if (p.window !== undefined) {
    const w = p.window as Record<string, unknown>
    if (!w || typeof w !== 'object' || Array.isArray(w)) throw new RebootSettingsError('The window needs a start, a length and days.')
    for (const k of Object.keys(w)) if (!['start', 'hours', 'days'].includes(k)) throw new RebootSettingsError(`"window.${k}" is not part of the window.`)
    if (w.start !== undefined) {
      if (typeof w.start !== 'string' || !HHMM.test(w.start)) throw new RebootSettingsError('The window starts at a time like 03:00.')
      out.window.start = w.start
    }
    if (w.hours !== undefined) {
      if (typeof w.hours !== 'number' || !Number.isInteger(w.hours) || w.hours < 1 || w.hours > 12) throw new RebootSettingsError('The window lasts 1 to 12 hours.')
      out.window.hours = w.hours
    }
    if (w.days !== undefined) {
      if (!Array.isArray(w.days) || !w.days.length || w.days.some(d => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) {
        throw new RebootSettingsError('Pick at least one day (0 is Sunday, 6 is Saturday).')
      }
      out.window.days = [...new Set(w.days as number[])].sort()
    }
  }
  return out
}

/** One cluster's saved state: its settings, a one-off request for the next window, and the last window it ran in. */
export interface ClusterRebootState {
  settings?:   UpdatesRebootSettings
  /** "Reboot automatically in the next window", ticked when an update run was started. Used once. */
  queued?:     { at: string; by: string; jobId?: string } | null
  /** Start (ISO) of the last window a rolling reboot was considered in: one run per window. */
  lastWindow?: string | null
}

export interface RebootStateStore {
  get(clusterId: string): ClusterRebootState
  set(clusterId: string, s: ClusterRebootState): void
}

export const DEFAULT_REBOOTS_PATH = '/opt/hyperprox/data/updates-reboots.json'

/** data/updates-reboots.json: settings and timestamps only, no secrets. */
export class FileRebootState implements RebootStateStore {
  constructor(private file = process.env.UPDATES_REBOOTS_PATH || DEFAULT_REBOOTS_PATH) {}
  private all(): Record<string, ClusterRebootState> {
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); return j && typeof j === 'object' && j.clusters ? j.clusters : {} } catch { return {} }
  }
  get(id: string): ClusterRebootState { return this.all()[id] ?? {} }
  set(id: string, s: ClusterRebootState): void {
    const clusters = { ...this.all(), [id]: s }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ clusters }, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}

export class MemoryRebootState implements RebootStateStore {
  data: Record<string, ClusterRebootState> = {}
  get(id: string): ClusterRebootState { return structuredClone(this.data[id] ?? {}) }
  set(id: string, s: ClusterRebootState): void { this.data[id] = structuredClone(s) }
}

/** A cluster's settings, with anything missing or unreadable filled from the defaults. */
export function settingsOf(st: ClusterRebootState, tz?: string): UpdatesRebootSettings {
  const base = defaultRebootSettings(tz)
  if (!st.settings) return base
  try { return mergeRebootSettings(base, st.settings) } catch { return base }
}

// --- the window -------------------------------------------------------------------------------

const MIN = 60_000
const DAY = 1440

function startMinutes(w: UpdatesRebootWindow): number { return Number(w.start.slice(0, 2)) * 60 + Number(w.start.slice(3)) }

/** The local minute of day at a start time `ms`, against the wanted start: off by an hour around a clock change. */
function alignTo(ms: number, wanted: number, tz: string): number {
  const p = localParts(ms, tz)
  let diff = p.hour * 60 + p.minute - wanted
  if (diff > DAY / 2) diff -= DAY
  if (diff < -DAY / 2) diff += DAY
  return ms - diff * MIN
}

export interface WindowState {
  inWindow: boolean
  /** The window we are in now. */
  current:  { start: number; end: number } | null
  /** The next window that starts after now. */
  next:     { start: number; end: number } | null
}

/**
 * Where `now` stands against the window, read in the window's time zone. A window belongs to the day it starts on,
 * so one that starts at 23:00 on Saturday runs into Sunday whatever Sunday's own setting is.
 */
export function windowState(now: number, w: UpdatesRebootWindow, tz: string): WindowState {
  const days = new Set(w.days)
  const s = startMinutes(w)
  const len = w.hours * 60
  const t0 = Math.floor(now / MIN) * MIN
  const p = localParts(t0, tz)
  const m = p.hour * 60 + p.minute
  let current: WindowState['current'] = null
  // Today's start, or yesterday's for a window that runs past midnight.
  for (const back of [0, 1]) {
    const since = m - s + back * DAY
    if (since < 0 || since >= len) continue
    const start = alignTo(t0 - since * MIN, s, tz)
    if (!days.has(localParts(start, tz).dow)) continue
    const end = start + len * MIN
    if (now >= start && now < end) { current = { start, end }; break }
  }
  let next: WindowState['next'] = null
  for (let d = 0; d <= 8 && !next; d++) {
    const start = alignTo(t0 - (m - s) * MIN + d * DAY * MIN, s, tz)
    if (start <= now || !days.has(localParts(start, tz).dow)) continue
    next = { start, end: start + len * MIN }
  }
  return { inWindow: !!current, current, next }
}

// --- what needs a reboot ------------------------------------------------------------------------

/** Versions of the installed kernels, newest last. */
export function newestKernel(f: Pick<NodeFacts, 'kernelPackages'>): string | null {
  const versions = f.kernelPackages.map(p => p.replace(/^(proxmox|pve)-kernel-/, '').replace(/-signed$/, ''))
  const cmp = (a: string, b: string) => {
    const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d }
    return 0
  }
  return versions.sort(cmp).at(-1) ?? null
}

/**
 * A node needs a reboot when it says so (/run/reboot-required), or when the kernel it would boot is not the one it
 * runs: the pinned one when a kernel is pinned (a pin is never moved, so a newer kernel alone is not a reason),
 * otherwise the newest installed.
 */
export function nodeRebootNeeded(f: Pick<NodeFacts, 'rebootRequired' | 'runningKernel' | 'pinned' | 'kernelPackages'>): boolean {
  if (f.rebootRequired) return true
  if (!f.runningKernel) return false
  const boots = f.pinned ?? newestKernel(f)
  return Boolean(boots && boots !== f.runningKernel)
}

export interface RebootTargets {
  nodes:   string[]
  guests:  number[]
  /** Needed a reboot, but left out, with the reason. */
  skipped: { target: string; reason: string }[]
  /** Nodes the policy says never to reboot automatically. */
  never:   string[]
}

/**
 * What a rolling reboot would take on, from the inventory as last read. Nodes in the order a run updates them
 * (HyperProx's own node last); guests only those Updates manages (leave-alone, excluded and ignored guests are not
 * managed) that are running and ask for a reboot.
 */
export function rebootTargets(inv: UpdatesInventory, policy: Policy, want: { nodes: boolean; guests: boolean; allNodes?: boolean },
                              order: (nodes: UpdatesInventory['nodes']) => UpdatesInventory['nodes']): RebootTargets {
  const out: RebootTargets = { nodes: [], guests: [], skipped: [], never: [] }
  for (const n of order(inv.nodes)) {
    const never = nodePolicy(policy, n.node).autoReboot === false
    if (never) out.never.push(n.node)
    if (!want.nodes) continue
    const needs = want.allNodes || n.rebootRequired || n.rebootPending
    if (!needs) continue
    if (never) { out.skipped.push({ target: n.node, reason: 'the policy says never to reboot it automatically (auto_reboot: false)' }); continue }
    if (!n.online) { out.skipped.push({ target: n.node, reason: 'offline' }); continue }
    if (n.factsUnknown) { out.skipped.push({ target: n.node, reason: 'its holds and kernel pin could not be read' }); continue }
    out.nodes.push(n.node)
  }
  if (want.guests) {
    for (const g of [...inv.guests].sort((a, b) => a.vmid - b.vmid)) {
      if (!g.rebootRequired) continue
      if (!g.managed) { out.skipped.push({ target: String(g.vmid), reason: 'left alone (not managed by Updates)' }); continue }
      if (!g.running) continue
      out.guests.push(g.vmid)
    }
  }
  return out
}

// --- guests that cannot move ----------------------------------------------------------------------

export interface HaRule { rule: string; type: string; resources: string[]; nodes: string[]; strict: boolean; disabled: boolean }

/** /cluster/ha/rules rows as Proxmox answers them (PVE 9: rules replace groups). */
export function parseHaRules(rows: unknown): HaRule[] {
  if (!Array.isArray(rows)) return []
  const list = (v: unknown) => String(v ?? '').split(',').map(x => x.trim()).filter(Boolean)
  return rows.filter(r => r && typeof r === 'object').map((r: any) => ({
    rule: String(r.rule ?? ''), type: String(r.type ?? ''),
    resources: list(r.resources), nodes: list(r.nodes).map(n => n.split(':')[0]),
    strict: r.strict === 1 || r.strict === true || r.strict === '1', disabled: r.disable === 1 || r.disable === true || r.disable === '1',
  }))
}

/** Raw `lxc.*` lines of a container's config, as the Proxmox API returns them (pairs) or as text. */
function rawLxc(cfg: Record<string, any>): [string, string][] {
  const v = cfg.lxc
  if (!Array.isArray(v)) return []
  return v.map((x: any) => (Array.isArray(x) ? [String(x[0]), String(x[1] ?? '')] : String(x).split(/[:=]\s*/, 2) as [string, string]))
}

/**
 * Why a guest cannot be moved to another node, in words, or null. A plain bind mount (no shared=1), a passed-through
 * device (GPU, USB, PCI) and a strict HA rule holding it to one node all keep it where it is: HA maintenance could
 * never move it, so a node holding one is rebooted without maintenance and HA restarts it in place.
 */
export function immovableReason(g: { vmid: number; type: 'lxc' | 'qemu' }, cfg: Record<string, any>, rules: HaRule[]): string | null {
  for (const [k, v] of Object.entries(cfg)) {
    if (g.type === 'lxc' && /^mp\d+$/.test(k)) {
      const s = String(v)
      if (s.split(',')[0].startsWith('/') && !/(^|,)shared=1(,|$)/.test(s)) return `a local bind mount (${k})`
    }
    if (g.type === 'lxc' && /^dev\d+$/.test(k)) return `a passed-through device (${k})`
    if (g.type === 'qemu' && /^hostpci\d+$/.test(k)) return `PCI passthrough (${k})`
    if (g.type === 'qemu' && /^usb\d+$/.test(k) && /host=/.test(String(v))) return `USB passthrough (${k})`
  }
  if (g.type === 'lxc' && rawLxc(cfg).some(([k, v]) => /^lxc\.(cgroup2?\.devices\.allow|mount\.entry)$/.test(k) && /\/dev\/|^c \d+:/.test(v))) {
    return 'passed-through devices (raw lxc lines)'
  }
  const sid = `${g.type === 'lxc' ? 'ct' : 'vm'}:${g.vmid}`
  const held = rules.find(r => !r.disabled && r.type === 'node-affinity' && r.strict && r.nodes.length === 1 && r.resources.includes(sid))
  if (held) return `a strict HA rule (${held.rule}) keeps it on ${held.nodes[0]}`
  return null
}

// --- quorum ------------------------------------------------------------------------------------------

/**
 * Before a node goes down: every node online, the cluster quorate, and still quorate with this node gone. Counted
 * in nodes (one vote each), so a two-node cluster never reboots a node on its own.
 */
export function rebootQuorumGate(s: ClusterStatus, node: string): GateResult {
  if (s.standalone) return { ok: true, reason: 'one-node server: no quorum to keep' }
  if (!s.quorate) return { ok: false, reason: 'the cluster is not quorate' }
  const off = s.nodes.filter(n => !n.online).map(n => n.name)
  if (off.length) return { ok: false, reason: `not every node is online (${off.join(', ')})` }
  const total = s.nodes.length
  const need = Math.floor(total / 2) + 1
  const left = s.nodes.filter(n => n.online && n.name !== node).length
  if (left < need) return { ok: false, reason: `rebooting ${node} would leave ${left} of ${total} nodes, fewer than the ${need} the cluster needs for quorum` }
  return { ok: true, reason: `${left} of ${total} nodes stay up while ${node} reboots (quorum needs ${need})` }
}
