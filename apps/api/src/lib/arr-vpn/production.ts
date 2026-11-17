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
import { VpnRefusal, VpnService, type AlertStore, type Located } from './service'
import { PrismaGiveUpStore } from '../arr-giveup/store'
import type { AlertState } from './parse'

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

/** Guests whose own address is `host`. Pure. */
export function matchingGuests<T>(rows: T[], addresses: (r: T) => string[], host: string): T[] {
  return rows.filter(r => addresses(r).includes(host))
}

let located: { at: number; v: Located | null; error?: string } | null = null

async function locate(): Promise<Located | null> {
  const now = Date.now()
  if (located && now - located.at < LOCATE_TTL_MS) {
    if (located.error) throw new VpnRefusal(409, 'ambiguous', located.error)
    return located.v
  }
  const settings = await getSettings('arrstack').catch(() => ({} as Record<string, string>))
  const qbitHost = hostOf(settings.qbit_url)
  const host = qbitHost ?? hostOf(settings.sonarr_url)
  const rows = (await guestRows()).filter(r => r.type === 'lxc' && r.running && !r.ignored)
  let hit: Row | undefined
  let byAddress = false
  if (host) {
    const addr = new Map<number, string[]>()
    for (const r of rows) {
      const cfg = await homePve().fetchStrict<Record<string, unknown>>(`/nodes/${encodeURIComponent(r.node)}/lxc/${r.vmid}/config`).catch(() => null)
      addr.set(r.vmid, cfg ? lxcAddresses(cfg) : [])
    }
    const hits = matchingGuests(rows, r => addr.get(r.vmid) ?? [], host)
    if (hits.length > 1) {
      // Never guess: the wrong container would get the fixes.
      const error = `${hits.length} running containers have the address the Arr Stack plug-in uses (${hits.map(h => h.name).join(', ')}), so HyperProx will not guess which one runs it. Give one of them a different address.`
      located = { at: now, v: null, error }
      throw new VpnRefusal(409, 'ambiguous', error)
    }
    hit = hits[0]
    byAddress = !!hit
  }
  if (!hit) {
    const { catalogue } = await sightingsOf(ARR_RECIPE_ID, 'sonarr', { guests: async () => rows, minVmid: 100, ignoreScanFailure: true }).catch(() => ({ catalogue: [] as any[] }))
    const ids = [...new Set(catalogue.map((s: any) => s.guest.vmid))]
    if (ids.length === 1) hit = rows.find(r => r.vmid === ids[0])
  }
  // Only a match on qBittorrent's own address proves the plug-in's qBittorrent connection is the one in this container.
  const v = hit ? { guest: { type: hit.type, vmid: hit.vmid }, name: hit.name, qbitProven: byAddress && !!qbitHost } : null
  located = { at: now, v }
  return v
}

/** The alert state in the Arr Stack's own settings rows (the give-up store's key/value table). */
function prismaAlertStore(prisma: unknown): AlertStore {
  const store = new PrismaGiveUpStore(prisma as any)
  return {
    load: () => store.getSetting<AlertState>('vpn:alerts'),
    save: s => store.setSetting('vpn:alerts', s, 'hyperprox'),
  }
}

const homeFetch: Pick<ProxmoxClient, 'fetchStrict'> = {
  fetchStrict: <T>(path: string, method?: string, body?: string, timeoutMs?: number) => homePve().fetchStrict<T>(path, method, body, timeoutMs),
}

let shared: VpnService | null = null

export function arrVpnService(log?: (m: string) => void, prisma?: unknown): VpnService {
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
    ...(prisma ? { alerts: prismaAlertStore(prisma) } : {}),
  })
  return shared
}

/** Tests set their own (or none). */
export function setArrVpnService(s: VpnService | null): void { shared = s }
export function currentArrVpnService(): VpnService | null { return shared }
