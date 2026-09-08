// =============================================================================
//  HyperProx — service discovery
//
//  HyperProx already knows every guest on the cluster and its address. Asking
//  someone to type those addresses into a settings form is asking them to tell
//  the software something it can see for itself.
//
//  Each probe is a cheap unauthenticated request to a port a service is known to
//  answer on, matched against something only that service returns. A probe never
//  sends a credential — there is nothing to send yet — and never writes.
// =============================================================================

import { ProxmoxClient } from './proxmox-client'

export interface Probe {
  /** Which bundled plug-in this configures. */
  pluginId: string
  /** Which of that plug-in's settings takes the address. */
  setting:  string
  label:    string
  port:     number
  path:     string
  scheme?:  'http' | 'https'
  /** True when the response is unmistakably this service. */
  match:    (status: number, body: string) => boolean
  /** Settings the user must still supply — a key we cannot discover. */
  needs?:   string[]
}

export const PROBES: Probe[] = [
  {
    pluginId: 'arrstack', setting: 'qbit_url', label: 'qBittorrent',
    port: 8080, path: '/api/v2/app/version',
    // Answers with a bare version string like "v4.6.5" and nothing else.
    match: (s, b) => s === 200 && /^v?\d+\.\d+/.test(b.trim()),
  },
  {
    pluginId: 'unmanic', setting: 'url', label: 'Unmanic',
    port: 8888, path: '/unmanic/api/v2/workers/status',
    match: (s, b) => s === 200 && b.includes('workers_status'),
  },
  {
    pluginId: 'arrstack', setting: 'sonarr_url', label: 'Sonarr',
    port: 8989, path: '/ping',
    match: (s, b) => s === 200 && b.includes('"status"'),
    needs: ['sonarr_key'],
  },
  {
    pluginId: 'arrstack', setting: 'radarr_url', label: 'Radarr',
    port: 7878, path: '/ping',
    match: (s, b) => s === 200 && b.includes('"status"'),
    needs: ['radarr_key'],
  },
  {
    pluginId: 'arrstack', setting: 'prowlarr_url', label: 'Prowlarr',
    port: 9696, path: '/api/v1/system/status',
    // Answers 401 without a key, which is itself proof it is Prowlarr.
    match: (s, b) => s === 401 || (s === 200 && b.includes('appName')),
    needs: ['prowlarr_key'],
  },
  {
    pluginId: 'plex', setting: 'url', label: 'Tautulli',
    port: 8181, path: '/status',
    // Tautulli answers /status without a key; the login page also names itself.
    match: (s, b) => s < 500 && /tautulli/i.test(b),
    needs: ['apikey'],
  },
]

export interface Finding {
  pluginId: string
  setting:  string
  label:    string
  address:  string
  /** Where it was found, for a human to recognise. */
  source:   string
  needs:    string[]
}

/** One probe against one address. Never throws; a miss is just a miss. */
async function probeOne(host: string, probe: Probe): Promise<boolean> {
  const scheme = probe.scheme ?? 'http'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2500)
  try {
    const res = await fetch(`${scheme}://${host}:${probe.port}${probe.path}`, {
      signal: controller.signal,
      redirect: 'follow',
    })
    const body = (await res.text()).slice(0, 4000)
    return probe.match(res.status, body)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Pull an IPv4 out of an LXC netN line. */
function ipFromConfig(config: Record<string, any>): string | null {
  for (const [k, v] of Object.entries(config)) {
    if (!/^net\d+$/.test(k) || typeof v !== 'string') continue
    const m = v.match(/(?:^|,)ip=([0-9.]+)/)
    if (m && m[1] !== '0.0.0.0') return m[1]
  }
  return null
}

/**
 * Scan every running guest for services HyperProx has a plug-in for.
 *
 * Only guests the cluster already knows about — this is not a network sweep,
 * and it will not find anything Proxmox cannot see.
 */
export async function discoverServices(pve: ProxmoxClient): Promise<Finding[]> {
  const resources = await pve.getClusterResources()
  const guests = (resources as any[]).filter(r =>
    (r.type === 'lxc' || r.type === 'qemu') && r.status === 'running')

  // Addresses first. LXC gives one up from its config; a VM needs the guest
  // agent, which many do not run, so those are simply skipped.
  const targets: Array<{ ip: string; name: string }> = []
  await Promise.all(guests.map(async g => {
    if (g.type !== 'lxc') return
    try {
      const config = await pve.getVMConfig(g.node, Number(g.vmid), 'lxc')
      const ip = ipFromConfig(config as Record<string, any>)
      if (ip) targets.push({ ip, name: `${g.name} (${g.vmid})` })
    } catch { /* an unreadable config is not worth failing a scan over */ }
  }))

  const findings: Finding[] = []
  await Promise.all(targets.flatMap(t =>
    PROBES.map(async probe => {
      if (await probeOne(t.ip, probe)) {
        findings.push({
          pluginId: probe.pluginId,
          setting:  probe.setting,
          label:    probe.label,
          address:  `http://${t.ip}:${probe.port}`,
          source:   t.name,
          needs:    probe.needs ?? [],
        })
      }
    })))

  // Unmanic legitimately runs on several nodes; everything else, keep the first.
  const seen = new Set<string>()
  return findings
    .sort((a, b) => a.label.localeCompare(b.label))
    .filter(f => {
      if (f.pluginId === 'unmanic') return true
      const key = `${f.pluginId}:${f.setting}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
