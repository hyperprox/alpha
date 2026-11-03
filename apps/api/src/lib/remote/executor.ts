// =============================================================================
//  HyperProx — Remote access: reaching each kind of machine
//
//  Every script goes to the target on stdin and is run by `bash -s`. Nothing is
//  staged in a file, on the node or in the guest: the install's up step carries
//  a key, and a file in /tmp is a file someone can read or a crash can leave.
//
//    node   the node login over SSH                         bash -s
//    lxc    the node login, then pct exec                   pct exec <id> -- bash -s
//    qemu   the guest agent when it answers, from the node  qm guest exec <id> --pass-stdin 1 -- bash
//           otherwise the Terminal's saved login            bash -s (sudo -n when not root)
//    host   the Terminal's saved login for a manual host    bash -s (sudo -n when not root)
//
//  Host keys are the Terminal's pins (execOnNode checks them).
// =============================================================================

import { livePve } from '../pve-env'
import type { ProxmoxClient } from '../proxmox-client'
import { execOnNode, nodeCredential, type ExecResult } from '../node-exec'
import { loadCredential, type TerminalCredential } from '../ssh-broker'
import { listManualHosts, listHostAddresses } from '../terminal-hosts'
import type { Machine } from './types'

export type { ExecResult }

export interface RunOptions { timeoutMs?: number; onData?: (chunk: string) => void }

export interface RemoteExecutor {
  /** Nodes, guests (templates left out) and the Terminal's hand-added hosts. */
  listMachines(): Promise<Machine[]>
  run(m: Machine, script: string, o?: RunOptions): Promise<ExecResult>
  lxcConfig(m: Machine): Promise<Record<string, unknown>>
  /** Through the Proxmox API only. Never by editing or appending to the config file. */
  setLxcConfig(m: Machine, params: Record<string, string>): Promise<void>
}

export class TransportError extends Error {
  constructor(message: string) { super(message); this.name = 'TransportError' }
}

const asRoot = (cred: TerminalCredential) => (cred.username === 'root' ? 'bash -s' : 'sudo -n bash -s')

/** What the production executor reaches outside itself for, so a test can check every command it builds. */
export interface TransportDeps {
  ssh:               typeof execOnNode
  nodeCredential:    typeof nodeCredential
  loadCredential:    typeof loadCredential
  listManualHosts:   typeof listManualHosts
  listHostAddresses: typeof listHostAddresses
}

const realTransport: TransportDeps = { ssh: execOnNode, nodeCredential, loadCredential, listManualHosts, listHostAddresses }

export function productionRemoteExecutor(
  pve: Pick<ProxmoxClient, 'fetchStrict'> = livePve(),
  t: TransportDeps = realTransport,
): RemoteExecutor {
  const execOnNode = t.ssh
  const { nodeCredential, loadCredential, listManualHosts, listHostAddresses } = t
  let nodeIps: Record<string, string> = {}

  async function nodeHost(node: string): Promise<string> {
    if (!nodeIps[node]) {
      const rows = await pve.fetchStrict<any[]>('/cluster/status')
      nodeIps = Object.fromEntries((rows ?? []).filter(r => r.type === 'node' && r.ip).map(r => [String(r.name), String(r.ip)]))
    }
    const ip = nodeIps[node]
    if (!ip) throw new TransportError(`Could not find an address for node ${node}`)
    return ip
  }

  async function nodeCred(node: string): Promise<TerminalCredential> {
    const c = await nodeCredential(node)
    if (!c) throw new TransportError(`No login saved for node ${node}. Add one in the Terminal (node logins are never borrowed from guests).`)
    return c
  }

  async function agentAnswers(m: Machine): Promise<boolean> {
    try { await pve.fetchStrict(`/nodes/${encodeURIComponent(m.node!)}/qemu/${m.vmid}/agent/ping`, 'POST', '', 10_000); return true }
    catch { return false }
  }

  async function overSsh(hostId: string, address: string | undefined, script: string, o: RunOptions, cred?: TerminalCredential | null): Promise<ExecResult> {
    const c = cred ?? await loadCredential(hostId)
    if (!c) throw new TransportError(`No login saved for ${hostId} in the Terminal`)
    if (!address) throw new TransportError(`No address known for ${hostId}; connect to it once in the Terminal so HyperProx remembers it`)
    return execOnNode({ host: address, port: c.port || 22, cred: c, command: asRoot(c), input: script, timeoutMs: o.timeoutMs, onData: o.onData })
  }

  return {
    async listMachines() {
      const [status, resources, manual] = await Promise.all([
        pve.fetchStrict<any[]>('/cluster/status'),
        pve.fetchStrict<any[]>('/cluster/resources?type=vm'),
        listManualHosts().catch(() => []),
      ])
      const nodes = (status ?? []).filter(r => r.type === 'node')
      nodeIps = Object.fromEntries(nodes.filter(r => r.ip).map(r => [String(r.name), String(r.ip)]))
      const out: Machine[] = nodes.map(r => ({
        id: `node-${r.name}`, kind: 'node' as const, name: String(r.name), node: String(r.name), running: r.online === 1, address: r.ip,
      }))
      for (const g of (resources ?? []).filter((r: any) => (r.type === 'lxc' || r.type === 'qemu') && r.template !== 1)) {
        out.push({
          id: `${g.type}-${g.vmid}`, kind: g.type, name: String(g.name ?? g.vmid), node: String(g.node), vmid: Number(g.vmid),
          running: g.status === 'running', ostype: undefined,
        })
      }
      for (const h of manual) out.push({ id: `host-${h.id}`, kind: 'host', name: h.name, running: true, address: h.address })
      // ostype is in each guest's config; read only for VMs, where it decides Windows (manual) or not.
      await Promise.all(out.filter(m => m.kind === 'qemu').map(async m => {
        try { m.ostype = String((await pve.fetchStrict<any>(`/nodes/${encodeURIComponent(m.node!)}/qemu/${m.vmid}/config`))?.ostype ?? '') }
        catch { /* unreadable: the planner reads the OS itself */ }
      }))
      const rank = (m: Machine) => (m.kind === 'node' ? 0 : m.kind === 'host' ? 2 : 1)
      return out.sort((a, b) => rank(a) - rank(b) || (a.vmid ?? 0) - (b.vmid ?? 0) || a.name.localeCompare(b.name))
    },

    async run(m, script, o = {}) {
      if (m.kind === 'node') {
        return execOnNode({ host: await nodeHost(m.node!), cred: await nodeCred(m.node!), command: 'bash -s', input: script, timeoutMs: o.timeoutMs, onData: o.onData })
      }
      if (m.kind === 'lxc') {
        return execOnNode({
          host: await nodeHost(m.node!), cred: await nodeCred(m.node!),
          command: `pct exec ${Number(m.vmid)} -- bash -s`, input: script, timeoutMs: o.timeoutMs, onData: o.onData,
        })
      }
      if (m.kind === 'qemu') {
        if (await agentAnswers(m)) {
          const secs = Math.ceil((o.timeoutMs ?? 15 * 60_000) / 1000)
          const r = await execOnNode({
            host: await nodeHost(m.node!), cred: await nodeCred(m.node!), timeoutMs: (secs + 30) * 1000,
            command: `qm guest exec ${Number(m.vmid)} --timeout ${secs} --pass-stdin 1 -- bash`, input: script,
          })
          if (r.code !== 0) return r
          try {
            const j = JSON.parse(r.output)
            const output = `${j['out-data'] ?? ''}${j['err-data'] ?? ''}`
            o.onData?.(output)
            return { code: j.exited ? Number(j.exitcode ?? 0) : -1, output, timedOut: !j.exited }
          } catch { return { code: -1, output: r.output, timedOut: false } }
        }
        const id = `qemu-${m.vmid}`
        return overSsh(id, (await listHostAddresses().catch(() => ({} as Record<string, string>)))[id], script, o)
      }
      // A hand-added host: its id is the Terminal's ("ssh-..."), stored without our "host-" prefix.
      const hostId = m.id.replace(/^host-/, '')
      return overSsh(hostId, m.address, script, o)
    },

    async lxcConfig(m) {
      return (await pve.fetchStrict<any>(`/nodes/${encodeURIComponent(m.node!)}/lxc/${Number(m.vmid)}/config`)) ?? {}
    },

    async setLxcConfig(m, params) {
      await pve.fetchStrict(`/nodes/${encodeURIComponent(m.node!)}/lxc/${Number(m.vmid)}/config`, 'PUT', new URLSearchParams(params).toString())
    },
  }
}
