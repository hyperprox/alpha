// =============================================================================
//  HyperProx — remote access the installer set up, taken over by the VPN page
//
//  bootstrap.sh can set up Tailscale in HyperProx's own container, or a WireGuard server in a small container
//  of its own, before HyperProx has a vault or an owner. It cannot call this API then, so it leaves a marker:
//  data/setup/vpn-pending.json (next to .env), mode 0600, holding public facts only (addresses, the WireGuard
//  server's public key, container IDs). Nothing secret is ever in it, and a marker that names a secret-looking
//  field is refused whole.
//
//  When HyperProx is unlocked (the owner's first sign-in, and every start that finds it unlocked) the marker
//  is read and each entry adopted the normal way, so it is a managed entry like any other:
//   - wireguard: WireguardService.adoptServer, which reads the interface with `wg show` in that container (the
//     key it reports must be the one the marker names). The VPN page then lists it and adds peers to it.
//   - tailscale: HyperProx's own client, recorded in remote access as adopted, from what the client itself says
//     (`tailscale status --json`, read here; this is HyperProx's own container). No Tailscale API key is needed;
//     adding one later links the record to its device.
//  Taking over is idempotent: an entry already managed is left as it is. Entries that are done leave the marker;
//  one that fails stays, with its error, and is tried again at the next unlock (or with Retry on the VPN page).
// =============================================================================

import { readFileSync, writeFileSync, renameSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { isIP } from 'net'
import type { RemoteRecordInput, RemoteStore } from '../remote/store'
import type { ClientStatus } from '../remote/scripts'
import type { WgServer } from './wireguard/store'
import { isWgKey } from './wireguard/keys'
import { validCidr } from './wireguard/config'

export interface WgEntry {
  kind: 'wireguard'; ctid: number; machineId: string; iface: string; address: string; listenPort: number; endpoint: string; publicKey: string
}
export interface TsEntry { kind: 'tailscale'; ctid: number; machineId: string; hostname: string; ip: string; dnsName: string }
export type InstallVpnEntry = (WgEntry | TsEntry) & { lastError?: string; attempts?: number }

export interface InstallHandoffDeps {
  /** Default: data/setup/vpn-pending.json next to ENV_FILE_PATH, or HPX_VPN_MARKER. */
  file?: string
  wg: {
    listServers(): Promise<WgServer[]>
    adoptServer(o: { machineId: string; iface?: string; address: string; endpoint: string }, by: string): Promise<WgServer>
  }
  remote: Pick<RemoteStore, 'get' | 'upsert' | 'audit'>
  /** This container's own Tailscale client, as `tailscale status --json` reports it (parseStatus). */
  tailscaleStatus(): Promise<ClientStatus>
  log?: (m: string) => void
}

export interface HandoffResult { adopted: string[]; already: string[]; failed: Array<{ entry: string; error: string }>; left: number }

export function markerPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HPX_VPN_MARKER || join(dirname(env.ENV_FILE_PATH || '/opt/hyperprox/.env'), 'data/setup/vpn-pending.json')
}

const MACHINE = /^lxc-\d{3,9}$/
const IFACE = /^hp-wg\d{1,3}$/
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
const ENDPOINT = /^(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]{1,253}):\d{1,5}$/
/** Field names that would mean a secret was written down, and Tailscale auth keys anywhere: either rejects the marker. */
const SECRETISH = /priv|secret|auth.?key|password|token/i
function secretish(v: unknown): boolean {
  if (typeof v === 'string') return /tskey-/i.test(v)
  if (Array.isArray(v)) return v.some(secretish)
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => SECRETISH.test(k) || secretish(x))
  return false
}

/** The entries of a marker, checked field by field; anything off is dropped (and logged by the caller). */
export function parseMarker(text: string): { entries: InstallVpnEntry[]; rejected: string[] } {
  let j: any
  try { j = JSON.parse(text) } catch { return { entries: [], rejected: ['not JSON'] } }
  if (secretish(j)) return { entries: [], rejected: ['the marker names a secret-looking field or holds an auth key; it is ignored whole'] }
  if (j?.version !== 1 || !Array.isArray(j.entries)) return { entries: [], rejected: ['not a version 1 marker'] }
  const entries: InstallVpnEntry[] = []
  const rejected: string[] = []
  for (const e of j.entries.slice(0, 10)) {
    const ctid = Number(e?.ctid)
    const base = { ...(typeof e?.lastError === 'string' ? { lastError: e.lastError.slice(0, 500) } : {}), ...(Number.isInteger(e?.attempts) ? { attempts: e.attempts } : {}) }
    if (e?.kind === 'wireguard' && Number.isInteger(ctid) && e.machineId === `lxc-${ctid}` && MACHINE.test(e.machineId) && IFACE.test(e.iface)
        && typeof e.address === 'string' && validCidr(e.address) && isIP(e.address.split('/')[0]) === 4
        && Number.isInteger(e.listenPort) && e.listenPort > 0 && e.listenPort < 65536
        && typeof e.endpoint === 'string' && ENDPOINT.test(e.endpoint) && typeof e.publicKey === 'string' && isWgKey(e.publicKey)) {
      entries.push({ kind: 'wireguard', ctid, machineId: e.machineId, iface: e.iface, address: e.address, listenPort: e.listenPort, endpoint: e.endpoint, publicKey: e.publicKey, ...base })
    } else if (e?.kind === 'tailscale' && Number.isInteger(ctid) && e.machineId === `lxc-${ctid}` && MACHINE.test(e.machineId)
        && typeof e.hostname === 'string' && HOST.test(e.hostname) && typeof e.ip === 'string' && isIP(e.ip) === 4
        && typeof e.dnsName === 'string' && (e.dnsName === '' || HOST.test(e.dnsName))) {
      entries.push({ kind: 'tailscale', ctid, machineId: e.machineId, hostname: e.hostname, ip: e.ip, dnsName: e.dnsName, ...base })
    } else {
      rejected.push(`entry ${String(e?.kind ?? '?')} ${String(e?.machineId ?? '')}`.trim())
    }
  }
  return { entries, rejected }
}

const label = (e: InstallVpnEntry) => `${e.kind} on ${e.machineId}`
const msg = (e: unknown) => String((e as any)?.message ?? e)

/** The pending entries, for the VPN page (public facts and the last error only). */
export function pendingEntries(file = markerPath()): InstallVpnEntry[] {
  try { return parseMarker(readFileSync(file, 'utf8')).entries } catch { return [] }
}

async function takeOver(e: InstallVpnEntry, d: InstallHandoffDeps): Promise<'adopted' | 'already'> {
  if (e.kind === 'wireguard') {
    const have = (await d.wg.listServers()).find(s => s.machineId === e.machineId && s.iface === e.iface)
    if (have) return 'already'
    const s = await d.wg.adoptServer({ machineId: e.machineId, iface: e.iface, address: e.address, endpoint: e.endpoint }, 'installer')
    // adoptServer read the key from the interface itself; it must be the one the installer saw made.
    if (s.publicKey !== e.publicKey) d.log?.(`[vpn-handoff] ${label(e)}: the interface reports another public key than the installer recorded`)
    return 'adopted'
  }
  if (await d.remote.get(e.machineId, 'tailscale')) return 'already'
  const st = await d.tailscaleStatus()
  if (!st.installed) throw new Error('Tailscale is not installed in this container')
  const rec: RemoteRecordInput = {
    // The MagicDNS name, when there is one, so the VPN page can show it without a Tailscale API key.
    machineId: e.machineId, provider: 'tailscale', deviceId: null, nodeKey: st.nodeKey ?? null, hostname: e.dnsName || st.hostname || e.hostname,
    address: st.ip ?? e.ip, mode: 'kernel', version: st.version, routes: [], exitNode: false, routeIds: [], adopted: true,
    forwardingBefore: null, connected: st.connected, checkedAt: new Date(), lastError: null,
  }
  await d.remote.upsert(rec)
  await d.remote.audit('remote.adopt', e.machineId, { by: 'installer', provider: 'tailscale', source: 'bootstrap' })
  return 'adopted'
}

let running: Promise<HandoffResult> | null = null

/** Take over what the marker lists. Safe to call any number of times, and at the same time: one run at once. */
export function consumeInstallMarker(d: InstallHandoffDeps): Promise<HandoffResult> {
  if (running) return running
  running = (async () => {
    const file = d.file ?? markerPath()
    const res: HandoffResult = { adopted: [], already: [], failed: [], left: 0 }
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { return res }
    const { entries, rejected } = parseMarker(text)
    for (const r of rejected) d.log?.(`[vpn-handoff] ignored: ${r}`)
    const left: InstallVpnEntry[] = []
    for (const e of entries) {
      try {
        const how = await takeOver(e, d)
        res[how].push(label(e))
      } catch (err) {
        const error = msg(err).slice(0, 500)
        res.failed.push({ entry: label(e), error })
        left.push({ ...e, lastError: error, attempts: (e.attempts ?? 0) + 1 })
      }
    }
    res.left = left.length
    if (!left.length) rmSync(file, { force: true })
    else {
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, source: 'bootstrap', entries: left }) + '\n', { mode: 0o600 })
      renameSync(tmp, file)
    }
    if (res.adopted.length || res.failed.length) d.log?.(`[vpn-handoff] adopted ${res.adopted.join(', ') || 'nothing'}; ${res.failed.length} left to retry`)
    return res
  })().finally(() => { running = null })
  return running
}
