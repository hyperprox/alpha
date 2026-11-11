// =============================================================================
//  HyperProx — where a Terminal pane connects
//
//  A pane names a host by its id (lxc-711, qemu-340, ssh-router, plugin-mikrotik). The address and port are
//  worked out here, on the server, from what HyperProx already knows about that id: the guest's own config or
//  the address saved for it, the hand-added host, the plug-in's base URL. The browser's idea of the address is
//  never used, so a saved login can only ever be sent to the machine it was saved for.
//
//  Node logins (node-<name>) are not Terminal hosts: they are HyperProx's root logins to the hypervisors, kept
//  for the node runner, and no Terminal route or socket will use, show or replace one.
// =============================================================================

import { listManualHosts, listHostAddresses, type ManualHost } from './terminal-hosts'
import { credentialId } from './ssh-broker'

/** The ids a Terminal pane can open: a cluster guest, a hand-added host, a plug-in's device. */
export const GUEST_TERMINAL_ID = /^(lxc|qemu)-\d{1,9}$/
const MANUAL_TERMINAL_ID = /^ssh-[a-z0-9._-]{1,60}$/
const PLUGIN_TERMINAL_ID = /^plugin-[a-z0-9._-]{1,60}$/

export type TerminalIdKind = 'guest' | 'manual' | 'plugin'

/** What kind of Terminal host an id is, or null when it is none (a node login, the shared login, anything else). */
export function terminalIdKind(raw: string): TerminalIdKind | null {
  const id = String(raw ?? '')
  if (id !== credentialId(id)) return null
  if (GUEST_TERMINAL_ID.test(id)) return 'guest'
  if (MANUAL_TERMINAL_ID.test(id)) return 'manual'
  if (PLUGIN_TERMINAL_ID.test(id)) return 'plugin'
  return null
}

/** A node login's id (node-<name>), however the caller spelled it. */
export function isNodeLoginId(raw: string): boolean {
  return credentialId(String(raw ?? '')).toLowerCase().startsWith('node-')
}

/** Why an id is refused by the Terminal routes, or null when it is a Terminal host id. */
export function terminalIdProblem(raw: string): string | null {
  if (isNodeLoginId(raw)) return 'Node logins are kept for HyperProx\'s own node runner and are managed on Settings → Setup checklist, not in the Terminal.'
  return terminalIdKind(raw) ? null : 'That is not a Terminal host.'
}

/** Pull an IPv4 out of an LXC netN line: name=eth0,...,ip=10.0.0.11/24,... */
export function ipFromLxcNet(config: Record<string, any>): string | null {
  for (const [k, v] of Object.entries(config)) {
    if (!/^net\d+$/.test(k) || typeof v !== 'string') continue
    const m = v.match(/(?:^|,)ip=([0-9.]+)(?:\/\d+)?/)
    if (m && m[1] !== '0.0.0.0') return m[1]
  }
  return null
}

export interface TerminalTarget { host: string; port: number; tmux: boolean }

export interface TargetDeps {
  clusterResources(): Promise<any[]>
  guestConfig(node: string, vmid: number, type: 'lxc' | 'qemu'): Promise<Record<string, any>>
  manualHosts(): Promise<ManualHost[]>
  hostAddresses(): Promise<Record<string, string>>
  /** The plug-in's console: its base URL from its settings, and the console's default port. Null when it has none. */
  pluginConsole(pluginId: string): Promise<{ baseUrl: string; defaultPort: number; tmux: boolean } | null>
}

export class TerminalTargetError extends Error {
  constructor(message: string) { super(message); this.name = 'TerminalTargetError' }
}

/**
 * The address and port a pane for `id` connects to, from HyperProx's own records. `credPort` is the port saved
 * with the login (the sign-in dialog asks for it); a hand-added host keeps the port it was added with.
 * Throws TerminalTargetError when the id is not a Terminal host or no address is known for it.
 */
export async function resolveTerminalTarget(id: string, credPort: number | undefined, deps: TargetDeps): Promise<TerminalTarget> {
  const problem = terminalIdProblem(id)
  if (problem) throw new TerminalTargetError(problem)
  const kind = terminalIdKind(id)
  if (!kind) throw new TerminalTargetError('That is not a Terminal host.')

  if (kind === 'guest') {
    const [type, vmidRaw] = id.split('-') as ['lxc' | 'qemu', string]
    const vmid = Number(vmidRaw)
    const guest = (await deps.clusterResources()).find(r => r?.type === type && Number(r?.vmid) === vmid)
    if (!guest) throw new TerminalTargetError(`There is no ${type === 'lxc' ? 'container' : 'VM'} ${vmid} in this cluster.`)
    let ip: string | null = null
    if (type === 'lxc' && guest.status === 'running') {
      try { ip = ipFromLxcNet(await deps.guestConfig(guest.node, vmid, 'lxc')) } catch { /* the saved address below */ }
    }
    if (!ip) ip = (await deps.hostAddresses())[id] ?? null
    if (!ip) throw new TerminalTargetError(`No address is known for ${guest.name ?? id}. Save its address with its login first.`)
    return { host: ip, port: credPort || 22, tmux: true }
  }

  if (kind === 'manual') {
    const m = (await deps.manualHosts()).find(h => h.id === id)
    if (!m) throw new TerminalTargetError('That host is no longer in the Terminal\'s list.')
    return { host: m.address, port: Number(m.port) || 22, tmux: true }
  }

  const pluginId = id.slice('plugin-'.length)
  const c = await deps.pluginConsole(pluginId)
  if (!c) throw new TerminalTargetError('That plug-in has no console, or its address is not set.')
  let host = (await deps.hostAddresses())[id] ?? ''
  if (!host) {
    try { host = new URL(c.baseUrl).hostname } catch { throw new TerminalTargetError('That plug-in\'s address is not a valid URL.') }
  }
  return { host, port: credPort || c.defaultPort || 22, tmux: c.tmux }
}

/** The production lookups: the home cluster through its API token, the Terminal's own stores, the plug-ins' settings. */
export function productionTargetDeps(): TargetDeps {
  return {
    clusterResources: async () => {
      const { livePve } = await import('./pve-env')
      return (await livePve().getClusterResources()) as any[]
    },
    guestConfig: async (node, vmid, type) => {
      const { livePve } = await import('./pve-env')
      return (await livePve().getVMConfig(node, vmid, type)) as Record<string, any>
    },
    manualHosts: () => listManualHosts(),
    hostAddresses: () => listHostAddresses(),
    pluginConsole: async (pluginId) => {
      const { PLUGINS } = await import('../plugins')
      const { getSettings } = await import('./plugin-host')
      const plugin = PLUGINS.find(p => p.manifest.id === pluginId)
      const console_ = plugin?.manifest.consoleAccess
      if (!plugin || !console_) return null
      const base = (await getSettings(plugin.manifest.id))[plugin.manifest.baseUrlSetting]
      if (!base) return null
      return { baseUrl: base, defaultPort: console_.defaultPort, tmux: console_.tmux !== false }
    },
  }
}

let depsOverride: TargetDeps | null = null
/** Tests stand in for the cluster and the stores; null puts the production lookups back. */
export function setTerminalTargetDeps(d: TargetDeps | null): void { depsOverride = d }
export function terminalTargetDeps(): TargetDeps { return depsOverride ?? productionTargetDeps() }
