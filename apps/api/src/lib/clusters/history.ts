// =============================================================================
//  HyperProx — guest config history for a remote cluster
//
//  The history table keys rows by guest ("lxc/100"). Two clusters can both have a CT 100, so a remote's rows are
//  stored as "@<clusterId>/lxc/100" and the prefix is taken off again on the way out. The home cluster's rows
//  keep their plain keys: nothing about them changes, and the home service can never match a remote's row (its
//  revert checks the row's guest against "lxc/100", which a prefixed row is not).
// =============================================================================

import type { HistoryStore, HistoryRow, GpuState } from '../guest-config/history/store'

export class ClusterHistoryStore implements HistoryStore {
  private readonly prefix: string
  constructor(private readonly inner: HistoryStore, clusterId: string) { this.prefix = `@${clusterId}/` }

  private wrap(guest: string): string { return this.prefix + guest }
  private mine(guest: string): boolean { return guest.startsWith(this.prefix) }
  private unwrapRow(r: HistoryRow): HistoryRow { return { ...r, guest: r.guest.slice(this.prefix.length) } }
  private unwrapGpu(s: GpuState): GpuState { return { ...s, guest: s.guest.slice(this.prefix.length) } }

  async add(r: Omit<HistoryRow, 'id' | 'createdAt'>) { return this.unwrapRow(await this.inner.add({ ...r, guest: this.wrap(r.guest) })) }
  async list(guest: string, limit?: number) { return (await this.inner.list(this.wrap(guest), limit)).map(r => this.unwrapRow(r)) }
  async get(id: string) {
    const r = await this.inner.get(id)
    return r && this.mine(r.guest) ? this.unwrapRow(r) : null
  }
  async getGpu(guest: string) { return this.unwrapGpu(await this.inner.getGpu(this.wrap(guest))) }
  async setGpu(s: GpuState) { await this.inner.setGpu({ ...s, guest: this.wrap(s.guest) }) }
  /** Legacy GPU keys predate clusters and all belong to the home cluster. */
  async adoptLegacyGpu() { return false }
  async updateGpu(guest: string, fn: (s: GpuState) => GpuState) {
    const out = await this.inner.updateGpu(this.wrap(guest), s => {
      const next = fn(this.unwrapGpu(s))
      return { ...next, guest: this.wrap(next.guest) }
    })
    return this.unwrapGpu(out)
  }
  async listGpu() { return (await this.inner.listGpu()).filter(s => this.mine(s.guest)).map(s => this.unwrapGpu(s)) }
}
