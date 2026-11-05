// =============================================================================
//  HyperProx — migration preflight: for every node, can this guest go there?
//
//  PVE already answers (GET /nodes/{node}/{type}/{id}/migrate), but in two
//  spellings (allowed-nodes for containers, allowed_nodes for VMs) and with
//  gaps: for a container it does not mention a plain bind mount or a passed-
//  through device, which is exactly what stops `pct migrate`. Those come from
//  the guest's config. Memory comes from /nodes. Every reason is a sentence.
// =============================================================================

import { hardwareOf } from './parse'
import type { GuestHardware, GuestType, HaRule, HaSnapshot, Sid } from './types'
import { labelOf } from './insight'
import { homeOf, list } from './rules'

export interface PreflightRow {
  node:    string
  current: boolean
  allowed: boolean
  reasons: string[]
  notes:   string[]
}

export interface Preflight { sid: Sid; node: string; running: boolean; rows: PreflightRow[]; summary: string }

const gib = (b: number) => `${(b / 1024 ** 3).toFixed(b >= 10 * 1024 ** 3 ? 0 : 1)} GiB`

/**
 * Builds the grid. `pve` is PVE's own answer for the guest; `config` its config (for bind mounts and devices).
 */
export function preflightGrid(snap: HaSnapshot, guest: { sid: Sid; type: GuestType; node: string; maxmem: number; cpus?: number }, pve: any, config: Record<string, unknown> | null, hw?: GuestHardware): Preflight {
  const label = labelOf(snap)
  const notAllowed: Record<string, any> = pve?.['not-allowed-nodes'] ?? pve?.not_allowed_nodes ?? {}
  const allowedList: string[] = (pve?.['allowed-nodes'] ?? pve?.allowed_nodes ?? []).map(String)
  const hardware = hw ?? hardwareOf(guest.type, config, snap.sharedStorage)
  const localDisks: any[] = pve?.local_disks ?? []
  const localRes: string[] = (pve?.local_resources ?? []).map(String)
  const running = Number(pve?.running ?? 0) === 1
  const relation = (other: Sid): string => {
    const r = snap.rules.find((x: HaRule) => x.type === 'resource-affinity' && !x.disabled && x.resources.includes(guest.sid) && x.resources.includes(other))
    return r?.affinity === 'negative' ? 'kept apart from' : 'kept together with'
  }
  const home = homeOf(snap.rules, guest.sid)
  const homeBlock = (node: string) => !home.rule || home.rule.strict || home.avoid.length
    ? `Its home rule does not allow ${node}.`
    : `Its home rule ranks ${node} below its first choice (${list(home.choice.tiers[0] ?? [], 'or')}); Proxmox only moves an HA guest by hand to its highest-ranked online nodes.`
  const rows: PreflightRow[] = snap.nodes.map(n => {
    const current = n.node === guest.node
    const reasons: string[] = []
    const notes: string[] = []
    if (current) return { node: n.node, current, allowed: false, reasons: [], notes: ['It is here now.'] }
    if (!n.online) reasons.push(`${n.node} is offline.`)
    if (n.maintenance) reasons.push(`${n.node} is in maintenance mode: HA starts nothing there.`)
    const na = notAllowed[n.node]
    if (na) {
      for (const b of na['blocking-ha-resources'] ?? []) {
        const sid = String(b.sid)
        if (b.cause === 'node-affinity') reasons.push(sid === guest.sid ? homeBlock(n.node) : `${label(sid)}, which it is kept together with, may not go to ${n.node}.`)
        else reasons.push(`It must be ${relation(sid)} ${label(sid)}, which rules out ${n.node}.`)
      }
      for (const s of na['unavailable-storages'] ?? na.unavailable_storages ?? []) reasons.push(`Missing storage: "${s}" is not available on ${n.node}.`)
      if (na['unavailable-resources'] ?? na.unavailable_resources) for (const s of na['unavailable-resources'] ?? na.unavailable_resources) reasons.push(`Missing mapped device "${s}" on ${n.node}.`)
    }
    for (const b of hardware.bindMounts) reasons.push(`A local bind mount (${b.path}) cannot move between nodes.`)
    for (const d of hardware.devices) {
      if (d.required && !(d.nodes ?? [guest.node]).includes(n.node)) reasons.push(`It uses local devices: ${d.what}. It will not start on ${n.node} without it.`)
      else if (!d.required && !(d.nodes ?? [guest.node]).includes(n.node)) notes.push(`It runs on ${n.node} without ${d.what.replace(/^(an?) /, 'its ')}.`)
    }
    if (guest.type === 'lxc') for (const l of hardware.localVolumes) if (!reasons.some(r => r.includes(`"${l.storage}"`))) reasons.push(`A disk is on node-local storage "${l.storage}", which a container cannot take with it.`)
    for (const d of localDisks) notes.push(`Its disk ${d.volid ?? ''} is on local storage: it is copied across, which takes time.`.replace('  ', ' '))
    for (const r of localRes) if (!hardware.devices.some(d => d.key === r)) reasons.push(`It uses a local device (${r}), such as a GPU or USB device.`)
    if (guest.cpus && n.maxcpu && n.maxcpu < guest.cpus) {
      // A VM with more vCPUs than the node has threads is refused at start; a container just runs on fewer.
      if (guest.type === 'qemu') reasons.push(`Not enough CPUs: it has ${guest.cpus} vCPUs, ${n.node} has ${n.maxcpu}.`)
      else notes.push(`It will be limited to ${n.maxcpu} CPUs on ${n.node} (it has ${guest.cpus}).`)
    }
    const free = n.maxmem - n.mem
    if (n.maxmem && guest.maxmem && free < guest.maxmem) reasons.push(`Not enough memory: it needs ${gib(guest.maxmem)}, ${n.node} has ${gib(Math.max(0, free))} free.`)
    if (!reasons.length && allowedList.length && !allowedList.includes(n.node) && !na) notes.push('Proxmox did not list this node as allowed.')
    if (guest.type === 'lxc' && running) notes.push('A running container moves with a restart: a short outage.')
    return { node: n.node, current, allowed: reasons.length === 0, reasons: Array.from(new Set(reasons)), notes }
  })
  const ok = rows.filter(r => r.allowed).map(r => r.node)
  const summary = ok.length ? `It can move to ${ok.join(', ')}.` : 'It cannot move to any other node right now.'
  return { sid: guest.sid, node: guest.node, running, rows, summary }
}
