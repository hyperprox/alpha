// =============================================================================
//  HyperProx — after an HA move, is the GPU still there?
//
//  Checks only; nothing is written. Every minute the watcher reads where each
//  HA-managed container with GPU entries is running. When one has moved and is
//  running again, it looks inside (read-only, over the node login) for a GPU
//  device node and says what it found through the notification channels: the
//  GPU it now uses, or that transcoding has fallen back to the CPU. Coming back
//  to the node it was first seen on is announced as "back on its home GPU".
// =============================================================================

import { detectGpu } from './gpu'
import type { GuestConfigService } from './service'
import type { PveConfig } from './keys'

export interface GpuSeen { node: string; device: string | null; deviceName: string | null; checkedAt: number }

export interface GpuMoveEvent {
  type: 'guest.gpu.moved' | 'guest.gpu.missing' | 'guest.gpu.home'
  severity: 'info' | 'warning'
  title: string
  guest: { vmid: number; name: string; from: string; to: string }
}

export class GpuMoveWatcher {
  /** Last node per guest, and the node it was first seen on (its home). */
  private last = new Map<number, string>()
  private home = new Map<number, string>()
  readonly seen = new Map<number, GpuSeen>()

  constructor(private svc: GuestConfigService, private publish: (e: GpuMoveEvent) => Promise<void>, private now = () => Date.now()) {}

  /** What the container can see now: the first GPU node inside it, named from the node's inventory. */
  async check(node: string, vmid: number): Promise<GpuSeen> {
    const out = await this.svc.shell().run(node, `pct exec ${vmid} -- sh -c 'ls -1 /dev/nvidia0 /dev/dri/renderD* 2>/dev/null'`, 20_000).catch(() => null)
    const device = out?.output.split('\n').map(l => l.trim()).find(Boolean) ?? null
    const inv = await this.svc.inventory(node).catch(() => null)
    const dev = device ? inv?.devices.find(d => d.kind === 'gpu' && d.paths.includes(device)) : undefined
    const s: GpuSeen = { node, device, deviceName: dev?.product ?? (device ? device : null), checkedAt: this.now() }
    this.seen.set(vmid, s)
    return s
  }

  async tick(): Promise<GpuMoveEvent[]> {
    const rows = await this.svc.haGpuGuests()
    const events: GpuMoveEvent[] = []
    for (const r of rows) {
      const prev = this.last.get(r.vmid)
      if (!this.home.has(r.vmid)) this.home.set(r.vmid, r.node)
      if (prev === undefined) { this.last.set(r.vmid, r.node); continue }
      if (prev === r.node || r.status !== 'running') continue
      this.last.set(r.vmid, r.node)
      const s = await this.check(r.node, r.vmid)
      const g = { vmid: r.vmid, name: r.name, from: prev, to: r.node }
      const backHome = r.node === this.home.get(r.vmid)
      const e: GpuMoveEvent = s.device
        ? { type: backHome ? 'guest.gpu.home' : 'guest.gpu.moved', severity: 'info', guest: g,
            title: backHome ? `${r.name} is back on ${r.node} and on its home GPU (${s.deviceName})` : `${r.name} moved from ${prev} to ${r.node} and is now using ${s.deviceName}` }
        : { type: 'guest.gpu.missing', severity: 'warning', guest: g, title: `${r.name} moved from ${prev} to ${r.node}, but no GPU is visible: transcoding is on the CPU` }
      events.push(e)
      await this.publish(e).catch(() => {})
    }
    return events
  }
}

export function hasGpu(cfg: PveConfig): boolean { return detectGpu('lxc', cfg).entries.length > 0 }
