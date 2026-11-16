// =============================================================================
//  HyperProx — HAProxy: what a Catalogue install does after the script
//
//  Installed is not done. Once HAProxy answers on port 80:
//    1. the Proxy page gets it as a Managed HAProxy (its Data Plane login moves
//       from the install's vault item into the instance's own), so proxy hosts
//       can be added to it like to any other proxy;
//    2. the HAProxy plug-in connects it, linked to that instance, so the
//       proxy load balancing page works at once and saved changes go through the
//       Data Plane API;
//    3. Prometheus gets its /metrics address.
//  Each step says what it did; a failure names what is left and where.
// =============================================================================

import { managedInstanceInput } from '../proxy/managed-recipes'
import type { InstanceInput } from '../proxy/service'
import type { HaproxyInstanceStore } from './instances'
import { HAPROXY_SOCKET, METRICS_PORT } from './recipe'

export const HAPROXY_SETUP_STEPS = [
  { id: 'haproxy-proxy',   label: 'Add it to the Proxy page' },
  { id: 'haproxy-plugin',  label: 'Connect the HAProxy plug-in' },
  { id: 'haproxy-metrics', label: 'Add its metrics to Prometheus' },
] as const

export interface HaproxySetupDeps {
  /** proxyService().createInstance, as the install's owner. Returns the new instance's id. */
  createProxyInstance(input: InstanceInput, owner: string): Promise<string>
  store: Pick<HaproxyInstanceStore, 'list' | 'add' | 'update'>
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
  syncTargets(): Promise<boolean>
  /** The install's own vault item (the Data Plane password before the Proxy page held it). */
  deleteSecrets(category: string, provider: string): Promise<void>
}

export interface HaproxySetupInput {
  name: string; ip: string; node: string; vmid: number; secret: string; owner: string
  vault: { category: string; provider: string }
}

type Step = { status: string; detail?: string }

export async function runHaproxySetup(o: HaproxySetupInput, step: (id: string) => Step, d: HaproxySetupDeps): Promise<{ proxyInstanceId: string; pluginInstanceId: string; vaultCopyRemoved: boolean }> {
  // 1. The Proxy page.
  let s = step('haproxy-proxy'); s.status = 'running'
  const proxyInstanceId = await d.createProxyInstance(managedInstanceInput('haproxy', { name: o.name, ip: o.ip, node: o.node, vmid: o.vmid, secret: o.secret }), o.owner)
  // The Proxy page's instance holds the login now: the install's copy goes, so the vault keeps it once.
  let vaultCopyRemoved = true
  let left = ''
  try { await d.deleteSecrets(o.vault.category, o.vault.provider) } catch (e: any) {
    vaultCopyRemoved = false
    left = `. The install's own copy of the Data Plane password (${o.vault.category}/${o.vault.provider}) could not be removed from the vault (${String(e?.message ?? e).slice(0, 160)}); the Proxy page has its own, so delete that item when you can`
  }
  s.status = 'done'; s.detail = `"${o.name}" on the Proxy page, reached through its container (Data Plane API on its loopback)${left}`

  // 2. The plug-in, linked to that instance.
  s = step('haproxy-plugin'); s.status = 'running'
  const have = (await d.store.list()).find(i => i.guest.kind === 'lxc' && i.guest.vmid === o.vmid)
  let pluginInstanceId: string
  if (have) {
    await d.store.update(have.id, { proxyInstanceId })
    pluginInstanceId = have.id
  } else {
    await d.audit('haproxy.autoconnect', `haproxy:lxc-${o.vmid}`, { guest: o.vmid, evidence: ['installed from the Catalogue', `admin socket ${HAPROXY_SOCKET}`], proxyInstance: proxyInstanceId, by: o.owner })
    pluginInstanceId = (await d.store.add({ name: o.name, guest: { kind: 'lxc', vmid: o.vmid }, socket: HAPROXY_SOCKET, proxyInstanceId, via: 'catalogue' })).id
  }
  s.status = 'done'; s.detail = 'Open Plug-ins → HAProxy to see its frontends, backends and servers'

  // 3. Prometheus.
  s = step('haproxy-metrics'); s.status = 'running'
  await d.syncTargets()
  s.status = 'done'; s.detail = `${o.ip}:${METRICS_PORT}/metrics, readable by HyperProx only`
  return { proxyInstanceId, pluginInstanceId, vaultCopyRemoved }
}
