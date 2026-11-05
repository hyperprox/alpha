// =============================================================================
//  HyperProx — which guest is HyperProx itself
//
//  Found by network identity, not by name: the MAC addresses of this
//  machine's own interfaces against each guest's netN config (`hwaddr=` for a
//  container, `virtio=`/`e1000=`… for a VM), then, when no MAC matches, a
//  static address (`ip=192.0.2.30/24`). Exactly one match, or nothing is
//  assumed. Done once at start-up, before any job may run.
// =============================================================================

import os from 'node:os'
import type { Machine } from './types'

export interface LocalIdentity { macs: string[]; ips: string[] }

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/

/** This machine's own MACs and IPv4 addresses, loopback and all-zero MACs left out. */
export function localIdentity(): LocalIdentity {
  const macs = new Set<string>(), ips = new Set<string>()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal) continue
      const mac = a.mac.toLowerCase()
      if (MAC.test(mac) && mac !== '00:00:00:00:00:00') macs.add(mac)
      if (a.family === 'IPv4') ips.add(a.address)
    }
  }
  return { macs: [...macs], ips: [...ips] }
}

/** Every MAC and static IPv4 address in a guest's network config. */
function guestIdentity(cfg: Record<string, unknown>): LocalIdentity {
  const macs: string[] = [], ips: string[] = []
  for (const [k, v] of Object.entries(cfg)) {
    if (!/^net\d+$/.test(k) || typeof v !== 'string') continue
    for (const part of v.split(',')) {
      const [key, val = ''] = part.split('=')
      const lv = val.toLowerCase()
      if (MAC.test(lv) && (key === 'hwaddr' || /^(virtio|e1000e?|rtl8139|vmxnet3|ne2k_pci|i82551|i82557b|i82559er|pcnet)$/.test(key))) macs.push(lv)
      if (key === 'ip' && /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(val)) ips.push(val.split('/')[0])
    }
  }
  return { macs, ips }
}

/** The one running guest whose MAC (or, failing that, static address) is this machine's; null when not exactly one. */
export async function findSelf(machines: Machine[], configOf: (m: Machine) => Promise<Record<string, unknown>>, local: LocalIdentity): Promise<string | null> {
  const guests = machines.filter(m => (m.kind === 'lxc' || m.kind === 'qemu') && m.running)
  const ids = await Promise.all(guests.map(async m => ({ m, id: guestIdentity(await configOf(m).catch(() => ({}))) })))
  const mine = new Set(local.macs.map(x => x.toLowerCase()))
  const byMac = ids.filter(x => x.id.macs.some(mac => mine.has(mac)))
  if (byMac.length) return byMac.length === 1 ? byMac[0].m.id : null
  const addr = new Set(local.ips)
  const byIp = ids.filter(x => x.id.ips.some(ip => addr.has(ip)))
  return byIp.length === 1 ? byIp[0].m.id : null
}
