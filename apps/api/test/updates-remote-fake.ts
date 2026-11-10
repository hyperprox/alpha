// A pretend remote server for the Updates tests: the FakeCluster, plus what a one-node Proxmox VE server adds.
// Every command it is sent must pass the remote script guard (lib/clusters/script-guard.ts), as the production
// node runner enforces for any remote context; one that does not is recorded and refused. It also keeps the
// installed version of every package an upgrade moved, so the read-back can be checked.
// Names, addresses and ids are generic on purpose: this repo is public.

import { FakeCluster, node, guest, pkg, type FakeNode, type FakeGuest } from './updates-fake'
import type { ClusterStatus, BackupTask, GuestRef, ExecResult, LineSink } from '../src/lib/updates/executor'
import { assertSafeScript } from '../src/lib/clusters/script-guard'

export { node, guest, pkg }

export class RemoteFake extends FakeCluster {
  /** One node and no cluster row. */
  standalone = true
  installed = new Map<string, Map<string, string>>()
  backups: BackupTask[] = []
  refused: string[] = []
  /** Simulates a hold vanishing during an upgrade (never done by HyperProx); the read-back must catch it. */
  dropHoldsOnUpgrade = false
  /** An upgrade that leaves one package behind, for the read-back. */
  leaveBehind: string | null = null

  constructor(init?: { nodes?: FakeNode[]; guests?: FakeGuest[] }) {
    super(init)
    this.ceph = null
  }

  async clusterStatus(): Promise<ClusterStatus> {
    const s = await super.clusterStatus()
    return this.standalone && s.nodes.length === 1 ? { quorate: true, nodes: s.nodes, standalone: true } : s
  }

  async backupTasks(): Promise<BackupTask[]> { return [...this.backups] }

  private guard(where: string, script: string) {
    try { assertSafeScript(script) } catch (e) { this.refused.push(`${where}: ${script.slice(0, 80)}`); throw e }
  }

  async nodeExec(name: string, cmd: string, onLine?: LineSink): Promise<ExecResult> {
    this.guard(name, cmd)
    if (cmd.includes('HP_VERSIONS_BEGIN')) {
      this.calls.push({ where: name, cmd, t: this.t })
      const have = this.installed.get(name) ?? new Map()
      return { code: 0, timedOut: false, output: ['HP_VERSIONS_BEGIN', ...[...have].map(([p, v]) => `${p} ${v} ii `), 'HP_VERSIONS_END'].join('\n') }
    }
    if (/apt-get .* (dist-)?upgrade$/.test(cmd)) {
      const n = this.nodes.find(x => x.name === name)!
      const have = this.installed.get(name) ?? new Map<string, string>()
      for (const p of n.pending) if (p.name !== this.leaveBehind) have.set(p.name, p.to)
      this.installed.set(name, have)
      if (this.dropHoldsOnUpgrade) n.holds = []
    }
    return super.nodeExec(name, cmd, onLine)
  }

  async guestExec(g: GuestRef, script: string, onLine?: LineSink): Promise<ExecResult> {
    this.guard(String(g.vmid), script)
    return super.guestExec(g, script, onLine)
  }
}

/** A one-node server with one running container that bind-mounts its media (so it cannot be snapshotted). */
export function standaloneServer(over: { node?: Partial<FakeNode>; guest?: Partial<FakeGuest> } = {}): RemoteFake {
  return new RemoteFake({
    nodes: [node('pve1', {
      pending: [pkg('proxmox-kernel-7.0.2-1-pve-signed', '7.0.2-1', null), pkg('pve-manager', '9.2.2', '9.2.1'), pkg('openssl', '3.5.4-1', '3.5.1-1')],
      holds: [], ...over.node,
    })],
    guests: [guest(101, 'pve1', { name: 'media', config: { hostname: 'media', onboot: 1, mp0: '/srv/media,mp=/media' }, ...over.guest })],
  })
}
