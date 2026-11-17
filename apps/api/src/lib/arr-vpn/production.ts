// =============================================================================
//  HyperProx — Arr Stack VPN panel: production wiring
//
//  Which guest runs the stack: the Arr Stack plug-in's qBittorrent address (Sonarr's when there is none) matched to a
//  running container's own address in its Proxmox config, or, when that does not settle it, the one container the
//  Catalogue installed the Arr Stack in. Read again every ten minutes. A guest HyperProx must leave alone (the
//  hyperprox-ignore tag, or Remote access's "never look inside" list: lib/guest-guard.ts) is never entered: the list is
//  read on every command, failing closed, and the executor refuses it too.
//
//  Scripts reach the guest the way the other plug-ins' do (lib/remote/executor.ts): the node's own login, then pct exec,
//  the script on stdin. Home cluster only.
// =============================================================================

import { findPlugin } from '../../plugins'
import { getSettings, pluginEndpointClient, type CoreEndpointClient } from '../plugin-host'
import { auditOrThrow } from '../audit'
import { publish } from '../notify'
import { isUnlocked } from '../vault/state'
import { homePve } from '../pve-env'
import { productionRemoteExecutor } from '../remote/executor'
import type { ProxmoxClient } from '../proxmox-client'
import { GuestExcludedRefusal, IGNORE_TAG, excludedMachineIds, guestExcluded } from '../guest-guard'
import { machineId, type GuestRef } from '../guest-id'
import { listGuests } from '../pve/guests'
import { sightingsOf } from '../catalogue/sightings'
import { ARR_RECIPE_ID } from '../arr/recipe'
import type { Machine } from '../remote/types'
import { VpnService } from './service'

const LOCATE_TTL_MS = 10 * 60_000

interface Row { type: 'lxc' | 'qemu'; vmid: number; name: string; node: string; running: boolean; ignored: boolean; excludedBy: string | null }

async function guestRows(): Promise<Row[]> {
  const rows = await listGuests(homePve())
  const ids = await excludedMachineIds()
  return rows.filter(r => !r.template).map(r => {
    const why = guestExcluded({ kind: r.type, vmid: r.vmid, tags: r.tags }, { excludedMachines: ids })
    return { type: r.type, vmid: r.vmid, name: r.name, node: r.node, running: r.running, ignored: !!why, excludedBy: why }
  })
}

/** The host part of a saved address, or null. */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try { return new URL(url).hostname.replace(/^\[|\]$/g, '') || null } catch { return null }
}

/** A container's own IPv4 address from its net0..net9 lines. */
export function lxcAddresses(cfg: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(cfg ?? {})) {
    if (!/^net\d$/.test(k)) continue
    const m = /(?:^|,)ip=(\d{1,3}(?:\.\d{1,3}){3})\//.exec(String(v ?? ''))
    if (m) out.push(m[1])
  }
  return out
}

let located: { at: number; v: { guest: GuestRef; name: string } | null } | null = null

async function locate(): Promise<{ guest: GuestRef; name: string } | null> {
  const now = Date.now()
  if (located && now - located.at < LOCATE_TTL_MS) return located.v
  const settings = await getSettings('arrstack').catch(() => ({} as Record<string, string>))
  const host = hostOf(settings.qbit_url) ?? hostOf(settings.sonarr_url)
  const rows = (await guestRows()).filter(r => r.type === 'lxc' && r.running && !r.ignored)
  let hit: Row | undefined
  if (host) {
    for (const r of rows) {
      const cfg = await homePve().fetchStrict<Record<string, unknown>>(`/nodes/${encodeURIComponent(r.node)}/lxc/${r.vmid}/config`).catch(() => null)
      if (cfg && lxcAddresses(cfg).includes(host)) { hit = r; break }
    }
  }
  if (!hit) {
    const { catalogue } = await sightingsOf(ARR_RECIPE_ID, 'sonarr', { guests: async () => rows, minVmid: 100, ignoreScanFailure: true }).catch(() => ({ catalogue: [] as any[] }))
    const ids = [...new Set(catalogue.map((s: any) => s.guest.vmid))]
    if (ids.length === 1) hit = rows.find(r => r.vmid === ids[0])
  }
  const v = hit ? { guest: { type: hit.type, vmid: hit.vmid }, name: hit.name } : null
  located = { at: now, v }
  return v
}

const homeFetch: Pick<ProxmoxClient, 'fetchStrict'> = {
  fetchStrict: <T>(path: string, method?: string, body?: string, timeoutMs?: number) => homePve().fetchStrict<T>(path, method, body, timeoutMs),
}

let shared: VpnService | null = null

export function arrVpnService(log?: (m: string) => void): VpnService {
  if (shared) return shared
  const executor = productionRemoteExecutor(homeFetch)
  shared = new VpnService({
    locate,
    exec: async (g, script, timeoutMs) => {
      // The guard is read again for every command, failing closed.
      const row = (await guestRows()).find(r => r.type === g.type && r.vmid === g.vmid)
      if (!row) throw new Error(`Container ${g.vmid} was not found.`)
      if (row.ignored) throw new GuestExcludedRefusal(row.name, row.excludedBy ?? `the ${IGNORE_TAG} tag`)
      if (!row.running) throw new Error(`${row.name} is not running.`)
      const m: Machine = { id: machineId(g), kind: g.type, name: row.name, node: row.node, vmid: g.vmid, running: true }
      return executor.run(m, script, { timeoutMs, maxOutputBytes: 100_000 })
    },
    qbit: async (): Promise<CoreEndpointClient | null> => {
      const p = findPlugin('arrstack')
      return p ? pluginEndpointClient(p, 'qbit').catch(() => null) : null
    },
    audit: (action, details) => auditOrThrow(action, 'plugin:arrstack', details),
    publish: e => publish(e),
    now: () => Date.now(),
    unlocked: () => isUnlocked(),
    log,
  })
  return shared
}

/** Tests set their own (or none). */
export function setArrVpnService(s: VpnService | null): void { shared = s }
export function currentArrVpnService(): VpnService | null { return shared }
