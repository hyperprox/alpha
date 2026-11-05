// =============================================================================
//  HyperProx — WireGuard: servers, peers, machines, and the MikroTik router
//
//  Where each key lives:
//   - a server's and a machine's private key: only on that machine (`wg
//     genkey` there, loaded by wg-quick from its own file). A rebuilt machine
//     gets a new key and its peer is updated. A server's key can, by choice,
//     also be backed up into the vault;
//   - a phone or laptop client's keypair and config: one vault item per peer
//     (made in the browser, or on the server container when the browser
//     cannot), shown again only after a master-password re-confirmation;
//   - Postgres: public keys, addresses and names only.
//  Rotation replaces the vault item and keeps the previous key for seven days,
//  marked rotated, so it can be undone; a sweep deletes it after that.
//
//  Changes on a Proxmox node go through the remote-access node guard: no
//  default route or /1 split through the tunnel, no AllowedIPs over a cluster
//  network, snapshot before and after, automatic rollback.
// =============================================================================

import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto'
import type { RemoteAccessService, RemoteJob } from '../../remote/service'
import type { RemoteExecutor } from '../../remote/executor'
import { DETECT_SCRIPT, osSupport, parseFacts, type Support } from '../../remote/scripts'
import type { Machine } from '../../remote/types'
import { isWgKey } from './keys'
import {
  IFACE_RE, NAME_RE, checkAllowedIps, checkSpec, nextAddress, parseDump, renderClientConfig, validCidr,
  type WgInterfaceSpec, type WgPeerStatus,
} from './config'
import {
  SERVER_KEYGEN_SCRIPT, parsePrivateKey, parsePublicKey, wgApplyScript, wgInstallScript, wgKeyBackupScript, wgKeyScript, wgStatusScript,
} from './scripts'
import {
  MARK, WRITE_ACCESS_COMMANDS, WRITE_ACCESS_NOTE, firewallAllows, firewallRule, mapInterfaces, mapPeers, peerBody,
  type RouterApi, type RouterWgInterface, type RouterWgPeer,
} from './routeros'
import type { WgPeer, WgServer, WgStore } from './store'

export class WgInputError extends Error { constructor(m: string) { super(m); this.name = 'WgInputError' } }
export class WgNotFoundError extends Error { constructor(m: string) { super(m); this.name = 'WgNotFoundError' } }

/** One vault item per client peer (and per opted-in server key backup). */
export interface WgVault {
  put(item: string, fields: Record<string, string>): Promise<void>
  get(item: string): Promise<Record<string, string>>
  remove(item: string): Promise<void>
}

export interface WgDeps {
  remote:  RemoteAccessService
  exec:    Pick<RemoteExecutor, 'listMachines'>
  store:   WgStore
  vault:   WgVault
  /** The router: reads through the MikroTik plug-in, writes only with the limited login. Null: no router. */
  router?: () => Promise<RouterApi | null>
  now?:    () => number
}

const ROTATION_KEEP_MS = 7 * 86400_000
const msg = (e: unknown) => String((e as any)?.message ?? e)
const peerItem = (id: string) => `peer-${id}`
const serverItem = (id: string) => `server-${id}`

export const KEY_BACKUP_TRADE_OFF =
  'Keeps the server key in the vault too, so a rebuilt server keeps its key and no peer needs changing; but anyone ' +
  'who can reveal secrets in the vault could then impersonate the server.'

/** The public key of a raw X25519 private key, to check that a keypair from the browser belongs together. */
export function publicOf(privateKey: string): string {
  const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(privateKey, 'base64')])
  const jwk = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }) as { x: string }
  return Buffer.from(jwk.x, 'base64url').toString('base64')
}

export interface ClientKeys { publicKey?: string; privateKey?: string; keygen?: 'browser' | 'server' }

export class WireguardService {
  private readonly now: () => number
  constructor(private readonly d: WgDeps) { this.now = d.now ?? Date.now }

  private job(action: string, by: string): RemoteJob {
    return { id: randomUUID(), action: 'install', provider: 'tailscale', by, status: 'running', steps: [], log: `[WireGuard: ${action}]\n`, startedAt: new Date(this.now()).toISOString() }
  }

  private async machine(id: string): Promise<Machine> {
    const m = (await this.d.exec.listMachines()).find(x => x.id === id)
    if (!m) throw new WgNotFoundError(`No such machine: ${id}`)
    if (!m.running) throw new WgInputError(`${m.name} is not running`)
    // Excluded guests are never looked inside or changed (every script also goes through remote.run, which refuses).
    if (await this.d.remote.isExcluded(m)) throw new WgInputError(`${m.name} is excluded from VPN work; HyperProx never looks inside it or changes it.`)
    return m
  }

  private async support(job: RemoteJob, m: Machine): Promise<Extract<Support, { ok: true }>> {
    const s = osSupport(parseFacts((await this.d.remote.run(job, m, DETECT_SCRIPT, { timeoutMs: 60_000 })).output))
    if (!s.ok) throw new WgInputError(s.reason)
    return s
  }

  private async server(id: string): Promise<WgServer> {
    const s = await this.d.store.getServer(id)
    if (!s) throw new WgNotFoundError(`No WireGuard server ${id}`)
    return s
  }

  private async peer(id: string): Promise<WgPeer> {
    const p = await this.d.store.getPeer(id)
    if (!p) throw new WgNotFoundError(`No WireGuard peer ${id}`)
    return p
  }

  /** Every peer of a server, as its interface file lists them. */
  private async serverSpec(s: WgServer, extra?: WgPeer): Promise<WgInterfaceSpec> {
    const peers = (await this.d.store.listPeers()).filter(p => p.serverId === s.id && p.id !== extra?.id)
    return {
      iface: s.iface, address: s.address, listenPort: s.listenPort,
      peers: [...peers, ...(extra ? [extra] : [])].map(p => ({ publicKey: p.publicKey, allowedIps: p.allowedIps, keepalive: null })),
    }
  }

  /** Rewrite the server's interface and update it live (other peers are not dropped). */
  private async applyServer(job: RemoteJob, s: WgServer, extra?: WgPeer): Promise<void> {
    const spec = await this.serverSpec(s, extra)
    const bad = checkSpec(spec)
    if (bad) throw new WgInputError(bad)
    const m = await this.machine(s.machineId)
    const r = await this.d.remote.run(job, m, wgApplyScript(spec, { forwarding: true }), { timeoutMs: 2 * 60_000 })
    if (r.code !== 0) throw new Error(`updating ${s.iface} on ${m.name} failed (exit ${r.code})`)
  }

  // ── Servers ───────────────────────────────────────────────────────────────

  /** Set up a WireGuard server in a container or VM (never on a Proxmox node). */
  async createServer(o: { machineId: string; iface?: string; listenPort?: number; address: string; endpoint: string; backupKey?: boolean }, by: string): Promise<WgServer & { log: string }> {
    const m = await this.machine(o.machineId)
    if (m.kind === 'node') throw new WgInputError('A WireGuard server runs in a container or VM, never on a Proxmox node.')
    const iface = o.iface ?? 'hp-wg0'
    const listenPort = o.listenPort ?? 51820
    const bad = checkSpec({ iface, address: o.address, listenPort, peers: [] })
    if (bad) throw new WgInputError(bad)
    if (!/^(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]{1,253}):\d{1,5}$/.test(o.endpoint)) throw new WgInputError('The endpoint clients use must be host:port')
    const job = this.job('create server', by)
    const s = await this.support(job, m)
    if ((await this.d.remote.run(job, m, wgInstallScript(s), { timeoutMs: 10 * 60_000 })).code !== 0) throw new Error('installing wireguard-tools failed')
    const key = await this.d.remote.run(job, m, wgKeyScript(iface), { timeoutMs: 60_000 })
    const publicKey = parsePublicKey(key.output)
    if (!publicKey || !isWgKey(publicKey)) throw new Error('the server key could not be made')
    const up = await this.d.remote.run(job, m, wgApplyScript({ iface, address: o.address, listenPort, peers: [] }, { forwarding: true }), { timeoutMs: 2 * 60_000 })
    if (up.code !== 0 || parsePublicKey(up.output) !== publicKey) throw new Error(`${iface} did not come up with its key`)
    const server = await this.d.store.addServer({ machineId: m.id, iface, listenPort, address: o.address, endpoint: o.endpoint, publicKey, keyBackedUp: false })
    if (o.backupKey) await this.backupServerKey(server.id, by, job)
    await this.d.store.audit('wireguard.server.create', m.id, { by, iface, listenPort, backupKey: !!o.backupKey })
    return { ...(await this.server(server.id)), log: job.log }
  }

  /** Record a server the Catalogue recipe set up (its key was made in the container; only the public half is read). */
  async adoptServer(o: { machineId: string; iface?: string; address: string; endpoint: string }, by: string): Promise<WgServer> {
    const m = await this.machine(o.machineId)
    const iface = o.iface ?? 'hp-wg0'
    if (!IFACE_RE.test(iface)) throw new WgInputError('The interface name must look like hp-wg0')
    const job = this.job('adopt server', by)
    const st = await this.d.remote.run(job, m, wgStatusScript(iface), { timeoutMs: 60_000 })
    const publicKey = parsePublicKey(st.output)
    const port = Number(/^HP_WG_PORT=(\d+)$/m.exec(st.output)?.[1])
    if (!publicKey || !port) throw new WgInputError(`${iface} is not up on ${m.name}`)
    const server = await this.d.store.addServer({ machineId: m.id, iface, listenPort: port, address: o.address, endpoint: o.endpoint, publicKey, keyBackedUp: false })
    await this.d.store.audit('wireguard.server.adopt', m.id, { by, iface })
    return server
  }

  /** The opt-in backup: the server key, read once from output that is never logged, into the vault. */
  async backupServerKey(serverId: string, by: string, job = this.job('back up server key', by)): Promise<void> {
    const s = await this.server(serverId)
    const m = await this.machine(s.machineId)
    const r = await this.d.remote.run(job, m, wgKeyBackupScript(s.iface), { timeoutMs: 60_000, quiet: 'output withheld: it contains the server key' })
    const priv = parsePrivateKey(r.output)
    if (!priv || !isWgKey(priv) || publicOf(priv) !== s.publicKey) throw new Error('the server key could not be read for the backup')
    await this.d.vault.put(serverItem(s.id), { private_key: priv })
    await this.d.store.audit('wireguard.vault.write', serverItem(s.id), { by, what: 'server key backup' })
    // Only now that the vault has it does the table say so.
    await this.d.store.updateServer(s.id, { keyBackedUp: true })
  }

  // ── Client peers (phones, laptops) ───────────────────────────────────────

  /** A keypair for a client: the browser's (checked to belong together), or one made on the server container. */
  private async clientKeys(job: RemoteJob, s: WgServer, k: ClientKeys): Promise<{ publicKey: string; privateKey: string }> {
    if (k.keygen === 'server') {
      const r = await this.d.remote.run(job, await this.machine(s.machineId), SERVER_KEYGEN_SCRIPT, { timeoutMs: 60_000, quiet: 'output withheld: it contains a client key' })
      const privateKey = parsePrivateKey(r.output), publicKey = parsePublicKey(r.output)
      if (!privateKey || !publicKey || !isWgKey(privateKey) || publicOf(privateKey) !== publicKey) throw new Error('the server could not make a client key')
      return { privateKey, publicKey }
    }
    if (!isWgKey(k.privateKey) || !isWgKey(k.publicKey)) throw new WgInputError('Send the keypair the browser made (two WireGuard keys), or ask the server to make one')
    if (publicOf(k.privateKey) !== k.publicKey) throw new WgInputError('That public key does not belong to that private key')
    return { privateKey: k.privateKey, publicKey: k.publicKey }
  }

  /**
   * Add a phone or laptop to a server. Its keypair and config go into one vault item; the config is returned
   * once, for the QR code or download.
   */
  async addDevice(serverId: string, o: { name: string; allowedIps?: string[]; keepalive?: number; dns?: string } & ClientKeys, by: string): Promise<{ peer: WgPeer; config: string }> {
    if (!NAME_RE.test(o.name ?? '')) throw new WgInputError('Give the peer a name (letters, numbers, spaces, dots, dashes)')
    const s = await this.server(serverId)
    const clientAllowed = o.allowedIps?.length ? o.allowedIps : [s.address.replace(/\.\d+\//, '.0/')]
    if (!clientAllowed.every(validCidr)) throw new WgInputError('Allowed IPs must be addresses with prefixes')
    if (o.dns && !/^[0-9A-Fa-f.:, ]{2,100}$/.test(o.dns)) throw new WgInputError('DNS must be one or more addresses')
    const job = this.job('add device', by)
    const keys = await this.clientKeys(job, s, o)
    const used = (await this.d.store.listPeers()).filter(p => p.serverId === s.id).map(p => p.address)
    const address = nextAddress(s.address, [s.address, ...used])
    if (!address) throw new WgInputError(`${s.address} has no free address left`)
    const draft: WgPeer = {
      id: randomUUID(), serverId: s.id, routerIface: null, routerPeerId: null, kind: 'device', name: o.name, machineId: null, iface: null,
      publicKey: keys.publicKey, address, allowedIps: [address], clientAllowedIps: clientAllowed, keepalive: o.keepalive ?? 25,
      previousPublicKey: null, previousUntil: null, rotatedAt: null, createdAt: new Date(this.now()),
    }
    const config = renderClientConfig({ privateKey: keys.privateKey, address, serverPublicKey: s.publicKey, endpoint: s.endpoint, allowedIps: clientAllowed, keepalive: draft.keepalive, dns: o.dns })
    // The vault first: a peer whose config cannot be kept is not created.
    await this.d.vault.put(peerItem(draft.id), { private_key: keys.privateKey, config })
    await this.d.store.audit('wireguard.vault.write', peerItem(draft.id), { by, what: 'client config' })
    try {
      await this.applyServer(job, s, draft)
    } catch (e) {
      await this.d.vault.remove(peerItem(draft.id)).catch(() => undefined)
      throw e
    }
    const { createdAt: _c, ...row } = draft
    const peer = await this.d.store.addPeer(row)
    await this.d.store.audit('wireguard.peer.add', peer.id, { by, server: s.id, name: o.name, keygen: o.keygen ?? 'browser' })
    return { peer, config }
  }

  /** Show a client's config again (QR or download). Re-confirmation is checked by the route; audited here. */
  async revealDevice(peerId: string, by: string): Promise<{ config: string; rotatedConfig: string | null }> {
    const p = await this.peer(peerId)
    if (p.kind !== 'device') throw new WgInputError('Only a phone or laptop peer has a config in the vault')
    const v = await this.d.vault.get(peerItem(p.id))
    await this.d.store.audit('wireguard.vault.read', peerItem(p.id), { by, what: 'client config' })
    if (!v.config) throw new WgNotFoundError('This peer has no config in the vault')
    return { config: v.config, rotatedConfig: v.previous_config ?? null }
  }

  async updatePeer(peerId: string, o: { name?: string; clientAllowedIps?: string[]; keepalive?: number | null }, by: string): Promise<WgPeer> {
    const p = await this.peer(peerId)
    if (o.name !== undefined && !NAME_RE.test(o.name)) throw new WgInputError('Give the peer a name (letters, numbers, spaces, dots, dashes)')
    if (o.clientAllowedIps && (!o.clientAllowedIps.length || !o.clientAllowedIps.every(validCidr))) throw new WgInputError('Allowed IPs must be addresses with prefixes')
    if (o.keepalive != null && !(Number.isInteger(o.keepalive) && o.keepalive >= 0 && o.keepalive <= 3600)) throw new WgInputError('Keepalive must be 0-3600 seconds')
    // A machine routes what it was connected with, checked and guarded then; changing it means connecting again.
    if (p.kind === 'machine' && o.clientAllowedIps) throw new WgInputError('To change what a machine routes, connect it again: that is checked and, on a node, guarded')
    const next = await this.d.store.updatePeer(p.id, { ...(o.name !== undefined ? { name: o.name } : {}), ...(o.clientAllowedIps ? { clientAllowedIps: o.clientAllowedIps } : {}), ...(o.keepalive !== undefined ? { keepalive: o.keepalive } : {}) })
    if (p.kind === 'device' && p.serverId && (o.clientAllowedIps || o.keepalive !== undefined)) {
      const s = await this.server(p.serverId)
      const v = await this.d.vault.get(peerItem(p.id))
      if (v.private_key) {
        await this.d.vault.put(peerItem(p.id), { ...v, config: renderClientConfig({ privateKey: v.private_key, address: next.address, serverPublicKey: s.publicKey, endpoint: s.endpoint, allowedIps: next.clientAllowedIps, keepalive: next.keepalive }) })
        await this.d.store.audit('wireguard.vault.write', peerItem(p.id), { by, what: 'client config' })
      }
    }
    await this.d.store.audit('wireguard.peer.update', p.id, { by, ...o })
    return next
  }

  async removePeer(peerId: string, by: string): Promise<void> {
    const p = await this.peer(peerId)
    const job = this.job('remove peer', by)
    if (p.routerIface && p.routerPeerId) await this.removeRouterPeer(p.routerPeerId, by)
    await this.d.store.removePeer(p.id)
    if (p.serverId) await this.applyServer(job, await this.server(p.serverId))
    if (p.kind === 'device') {
      await this.d.vault.remove(peerItem(p.id)).catch(() => undefined)
      await this.d.store.audit('wireguard.vault.remove', peerItem(p.id), { by })
    }
    await this.d.store.audit('wireguard.peer.remove', p.id, { by, name: p.name })
  }

  // ── Rotation ──────────────────────────────────────────────────────────────

  /** A new keypair for a client. The vault item is replaced; the previous key is kept seven days, marked rotated. */
  async rotateDevice(peerId: string, k: ClientKeys, by: string): Promise<{ peer: WgPeer; config: string }> {
    const p = await this.peer(peerId)
    if (p.kind !== 'device' || !p.serverId) throw new WgInputError('Only a phone or laptop peer on a HyperProx server is rotated here')
    const s = await this.server(p.serverId)
    const job = this.job('rotate', by)
    const keys = await this.clientKeys(job, s, k)
    const v = await this.d.vault.get(peerItem(p.id))
    const config = renderClientConfig({ privateKey: keys.privateKey, address: p.address, serverPublicKey: s.publicKey, endpoint: s.endpoint, allowedIps: p.clientAllowedIps, keepalive: p.keepalive })
    const until = new Date(this.now() + ROTATION_KEEP_MS)
    await this.d.vault.put(peerItem(p.id), {
      private_key: keys.privateKey, config,
      ...(v.private_key ? { previous_private_key: v.private_key, previous_config: v.config ?? '', rotated_at: new Date(this.now()).toISOString(), status_previous: 'rotated' } : {}),
    })
    await this.d.store.audit('wireguard.vault.write', peerItem(p.id), { by, what: 'rotated client config' })
    const next = { ...p, publicKey: keys.publicKey }
    try { await this.applyServer(job, s, next) } catch (e) { await this.d.vault.put(peerItem(p.id), v); throw e }
    const peer = await this.d.store.updatePeer(p.id, { publicKey: keys.publicKey, previousPublicKey: p.publicKey, previousUntil: until, rotatedAt: new Date(this.now()) })
    await this.d.store.audit('wireguard.peer.rotate', p.id, { by })
    return { peer, config }
  }

  /** Undo a rotation within seven days: the previous key comes back, on the server and in the vault. */
  async rollbackRotation(peerId: string, by: string): Promise<WgPeer> {
    const p = await this.peer(peerId)
    if (!p.previousPublicKey || !p.previousUntil || new Date(p.previousUntil).getTime() < this.now()) throw new WgInputError('There is no rotation to undo (they are kept for seven days)')
    const s = await this.server(p.serverId!)
    const v = await this.d.vault.get(peerItem(p.id))
    if (!v.previous_private_key) throw new WgInputError('The previous key is no longer in the vault')
    await this.applyServer(this.job('undo rotation', by), s, { ...p, publicKey: p.previousPublicKey })
    await this.d.vault.put(peerItem(p.id), { private_key: v.previous_private_key, config: v.previous_config ?? '' })
    await this.d.store.audit('wireguard.vault.write', peerItem(p.id), { by, what: 'rotation undone' })
    const peer = await this.d.store.updatePeer(p.id, { publicKey: p.previousPublicKey, previousPublicKey: null, previousUntil: null })
    await this.d.store.audit('wireguard.peer.rotate.undo', p.id, { by })
    return peer
  }

  /** Delete rotated keys older than seven days. Locked: the vault cannot be written, so it waits for the next run. */
  async sweepRotations(): Promise<number> {
    let n = 0
    for (const p of (await this.d.store.listPeers()).filter(x => x.previousUntil && new Date(x.previousUntil).getTime() < this.now())) {
      try {
        if (p.kind === 'device') {
          const { previous_private_key: _k, previous_config: _c, rotated_at: _r, status_previous: _s, ...keep } = await this.d.vault.get(peerItem(p.id))
          await this.d.vault.put(peerItem(p.id), keep)
          await this.d.store.audit('wireguard.vault.write', peerItem(p.id), { by: 'sweep', what: 'rotated key deleted after seven days' })
        }
        await this.d.store.updatePeer(p.id, { previousPublicKey: null, previousUntil: null })
        n++
      } catch { return n }
    }
    return n
  }

  // ── Machines (nodes and guests) as clients ────────────────────────────────

  /**
   * Connect a node or guest to a HyperProx server or to the router. Its key is made on it and never leaves it.
   * `allowedIps` is what it routes through the tunnel; `remoteSubnets` (site-to-site) are the other side's
   * networks it also routes there, declared so a node may reach a site larger than the coverage limit allows;
   * `siteSubnets` (site-to-site) is what the other end routes
   * to it. A rebuilt machine (same machine, same target) gets a new key, and the other end is updated.
   */
  async connectMachine(o: {
    machineId: string; serverId?: string; router?: { iface: string; endpoint: string; address: string }
    allowedIps: string[]; siteSubnets?: string[]; remoteSubnets?: string[]; keepalive?: number; iface?: string
  }, by: string): Promise<{ peer: WgPeer; log: string }> {
    const m = await this.machine(o.machineId)
    if (!!o.serverId === !!o.router) throw new WgInputError('Connect to either a HyperProx server or the router')
    if (!o.allowedIps?.length || !o.allowedIps.every(validCidr)) throw new WgInputError('Allowed IPs must be addresses with prefixes')
    const sites = o.siteSubnets ?? []
    if (!sites.every(validCidr)) throw new WgInputError('Site subnets must be addresses with prefixes')
    const iface = o.iface ?? 'hp-wg1'
    if (!IFACE_RE.test(iface)) throw new WgInputError('The interface name must look like hp-wg1')
    const remoteSites = o.remoteSubnets ?? []
    if (!remoteSites.every(validCidr)) throw new WgInputError('Remote site subnets must be addresses with prefixes')
    const clientAllowed = [...new Set([...o.allowedIps, ...remoteSites])]

    let serverPub: string, endpoint: string, address: string
    const existing = (await this.d.store.listPeers()).find(p => p.machineId === m.id && (o.serverId ? p.serverId === o.serverId : p.routerIface === o.router!.iface))
    let server: WgServer | null = null
    if (o.serverId) {
      server = await this.server(o.serverId)
      serverPub = server.publicKey; endpoint = server.endpoint
      const used = (await this.d.store.listPeers()).filter(p => p.serverId === server!.id && p.id !== existing?.id).map(p => p.address)
      address = existing?.address ?? nextAddress(server.address, [server.address, ...used]) ?? ''
      if (!address) throw new WgInputError(`${server.address} has no free address left`)
    } else {
      const rif = (await this.routerInterfaces()).find(i => i.name === o.router!.iface)
      if (!rif?.publicKey) throw new WgInputError(`The router has no WireGuard interface ${o.router!.iface}`)
      serverPub = rif.publicKey; endpoint = o.router!.endpoint
      if (!/^[0-9.]+\/32$/.test(o.router!.address) || !validCidr(o.router!.address)) throw new WgInputError('The tunnel address must be one IPv4 address, like 192.0.2.10/32')
      address = o.router!.address
    }

    // The overlay pool (the server's network, or this machine's own tunnel address on the router) and the
    // declared remote sites do not count toward a node's coverage limit; everything is checked for overlaps.
    const pool = server ? [server.address] : [address]
    const nets = await this.d.remote.clusterNetworksFor(m)
    const bad = checkAllowedIps(clientAllowed, { node: m.kind === 'node', clusterNets: nets, pool, sites: remoteSites })
      ?? checkAllowedIps(sites, { node: false, clusterNets: nets })
    if (bad) throw new WgInputError(bad)
    const spec: WgInterfaceSpec = { iface, address, peers: [{ publicKey: serverPub, allowedIps: clientAllowed, endpoint, keepalive: o.keepalive ?? 25 }] }
    const specBad = checkSpec(spec)
    if (specBad) throw new WgInputError(specBad)

    const job = this.job('connect machine', by)
    const s = await this.support(job, m)
    let publicKey = ''
    let peer: WgPeer | null = null
    let routerPeerAdded: string | null = null, routerPeerRemoved = false

    // In order: install, key (a rebuilt machine has none, so a new one is made), tell the other end, then bring
    // this side up, so its first handshake is answered. On a node all of it runs under the guard.
    const change = async () => {
      const inst = await this.d.remote.run(job, m, wgInstallScript(s), { timeoutMs: 10 * 60_000 })
      if (inst.code !== 0) throw new Error(/HP_WG_REFUSED=(.*)/.exec(inst.output)?.[1] ?? 'installing wireguard-tools failed')
      const k = await this.d.remote.run(job, m, wgKeyScript(iface), { timeoutMs: 60_000 })
      publicKey = parsePublicKey(k.output) ?? ''
      if (!isWgKey(publicKey)) throw new Error('the machine key could not be made')
      const row = {
        serverId: o.serverId ?? null, routerIface: o.router?.iface ?? null, routerPeerId: existing?.routerPeerId ?? null, kind: 'machine' as const,
        name: m.name, machineId: m.id, iface, publicKey, address, allowedIps: [address, ...sites], clientAllowedIps: clientAllowed,
        keepalive: o.keepalive ?? 25, previousPublicKey: null, previousUntil: null, rotatedAt: null,
      }
      peer = existing ? await this.d.store.updatePeer(existing.id, row) : await this.d.store.addPeer(row)
      if (server) {
        await this.applyServer(job, server)
      } else if (!existing?.routerPeerId || existing.publicKey !== publicKey) {
        if (existing?.routerPeerId) { await this.removeRouterPeer(existing.routerPeerId, by); routerPeerRemoved = true }
        const added = await this.addRouterPeer({ iface: o.router!.iface, publicKey, allowedAddress: row.allowedIps, keepalive: null, id: peer.id, name: m.name }, by)
        routerPeerAdded = added.id
        peer = await this.d.store.updatePeer(peer.id, { routerPeerId: added.id })
      }
      const up = await this.d.remote.run(job, m, wgApplyScript(spec), { timeoutMs: 2 * 60_000 })
      if (up.code !== 0 || parsePublicKey(up.output) !== publicKey) throw new Error(`${iface} did not come up on ${m.name}`)
    }

    try {
      if (m.kind === 'node') {
        const prev = await this.d.remote.run(job, m, `cat /etc/wireguard/${iface}.conf 2>/dev/null || true`, { timeoutMs: 30_000 })
        const previousConf = /\[Interface\]/.test(prev.output) ? prev.output : null
        const subject = { dev: iface.replace(/[^a-z0-9-]/g, ''), prefixes: [...clientAllowed, address], pool: [...pool, address], sites: remoteSites }
        await this.d.remote.guardWireguard(job, m, subject, { plan: { kind: 'wg-restore', provider: 'wireguard', subject, iface, previousConf } }, change)
      } else {
        await change()
      }
    } catch (e) {
      await this.undoConnect(job, { existing, peer, server, routerPeerAdded, routerPeerRemoved, by })
      throw e
    }

    await this.d.store.audit('wireguard.machine.connect', m.id, { by, iface, target: o.serverId ? `server:${o.serverId}` : `router:${o.router!.iface}`, rebuilt: !!existing && existing.publicKey !== publicKey })
    return { peer: peer!, log: job.log }
  }

  /**
   * This side did not come up: put the other end back as it was. A new peer is taken off the server or router;
   * a rebuilt machine's old key goes back on, so nothing is left pointing at a key no machine holds.
   */
  private async undoConnect(job: RemoteJob, u: { existing: WgPeer | undefined; peer: WgPeer | null; server: WgServer | null; routerPeerAdded: string | null; routerPeerRemoved: boolean; by: string }): Promise<void> {
    const quiet = async (f: () => Promise<unknown>) => { try { await f() } catch (e) { job.log += `[undo] ${(e as Error).message}\n` } }
    if (u.routerPeerAdded) await quiet(() => this.removeRouterPeer(u.routerPeerAdded!, u.by))
    if (!u.existing) {
      if (u.peer) await quiet(() => this.d.store.removePeer(u.peer!.id))
    } else {
      const { id: _id, createdAt: _c, ...old } = u.existing as WgPeer & { createdAt?: unknown }
      await quiet(() => this.d.store.updatePeer(u.existing!.id, { ...old, routerPeerId: u.existing!.routerPeerId }))
      if (!u.server && (u.routerPeerRemoved || u.routerPeerAdded) && u.existing.routerIface) {
        await quiet(async () => {
          const back = await this.addRouterPeer({ iface: u.existing!.routerIface!, publicKey: u.existing!.publicKey, allowedAddress: u.existing!.allowedIps, keepalive: null, id: u.existing!.id, name: u.existing!.name }, u.by)
          await this.d.store.updatePeer(u.existing!.id, { routerPeerId: back.id })
        })
      }
    }
    if (u.server) await quiet(() => this.applyServer(job, u.server!))
    await this.d.store.audit('wireguard.machine.connect.undone', u.existing?.id ?? u.peer?.id ?? '', { by: u.by, restoredOldKey: !!u.existing })
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async serverStatus(serverId: string): Promise<{ server: WgServer; up: boolean; peers: Array<WgPeer & { live: WgPeerStatus | null }> }> {
    const s = await this.server(serverId)
    const r = await this.d.remote.run(this.job('status', 'status'), await this.machine(s.machineId), wgStatusScript(s.iface), { timeoutMs: 60_000 })
    const live = parseDump(r.output)
    const peers = (await this.d.store.listPeers()).filter(p => p.serverId === s.id)
    return { server: s, up: !/HP_WG_DOWN/.test(r.output), peers: peers.map(p => ({ ...p, live: live.find(l => l.publicKey === p.publicKey) ?? null })) }
  }

  // ── The router ────────────────────────────────────────────────────────────

  private async api(): Promise<RouterApi> {
    const a = await this.d.router?.()
    if (!a) throw new WgInputError('No MikroTik router is configured (the MikroTik plug-in has no address).')
    return a
  }

  async routerInterfaces(): Promise<RouterWgInterface[]> {
    return mapInterfaces(await (await this.api()).read('/rest/interface/wireguard'))
  }

  /** The router's WireGuard as it is: interfaces, peers with handshakes and traffic, and whether HyperProx may write. */
  async routerView(): Promise<{
    interfaces: Array<RouterWgInterface & { firewallOk: boolean | null; firewallCommand: string | null }>
    peers: RouterWgPeer[]; writable: boolean; setup: string[] | null; setupNote: string
  }> {
    const api = await this.api()
    const [ifs, peers, rules] = await Promise.all([
      api.read('/rest/interface/wireguard'), api.read('/rest/interface/wireguard/peers'), api.read('/rest/ip/firewall/filter').catch(() => null),
    ])
    return {
      interfaces: mapInterfaces(ifs).map(i => ({
        ...i,
        firewallOk: rules && i.listenPort ? firewallAllows(rules, i.listenPort) : null,
        firewallCommand: rules && i.listenPort && !firewallAllows(rules, i.listenPort) ? firewallRule(i.listenPort, i.name).command : null,
      })),
      peers: mapPeers(peers), writable: !!api.write,
      setup: api.write ? null : WRITE_ACCESS_COMMANDS, setupNote: WRITE_ACCESS_NOTE,
    }
  }

  /** The exact peer HyperProx would add, as a REST body and a RouterOS command. Changes nothing. */
  async routerPeerPreview(o: { iface: string; publicKey: string; allowedAddress: string[]; keepalive?: number | null; name: string }): Promise<{ body: Record<string, string>; command: string; writable: boolean }> {
    if (!isWgKey(o.publicKey)) throw new WgInputError('Not a WireGuard public key')
    if (!o.allowedAddress.length || !o.allowedAddress.every(validCidr)) throw new WgInputError('Allowed addresses must have prefixes')
    if (!NAME_RE.test(o.name)) throw new WgInputError('Give the peer a name')
    if (!(await this.routerInterfaces()).some(i => i.name === o.iface)) throw new WgInputError(`The router has no WireGuard interface ${o.iface}`)
    const p = peerBody({ ...o, id: 'new' })
    return { ...p, writable: !!(await this.api()).write }
  }

  /** Add a peer to a router WireGuard interface, marked as HyperProx's, and read it back. */
  async addRouterPeer(o: { iface: string; publicKey: string; allowedAddress: string[]; keepalive?: number | null; id: string; name: string }, by: string): Promise<RouterWgPeer> {
    const api = await this.api()
    if (!api.write) throw new WgInputError('HyperProx has no write access to the router. Create the limited login with the commands shown, then add it under Settings → Credentials → Remote access.')
    const { body } = peerBody(o)
    const made = await api.write.put('/rest/interface/wireguard/peers', body)
    const back = mapPeers(await api.read('/rest/interface/wireguard/peers')).find(p => p.publicKey === o.publicKey && p.comment === body.comment)
    if (!back) throw new Error('The router did not show the new peer when read back')
    await this.d.store.audit('wireguard.router.peer.add', back.id, { by, iface: o.iface, credential: 'remote/routeros-write', made: !!made })
    return back
  }

  /** Remove a router peer, only if HyperProx created it (comment=hyperprox:...). */
  async removeRouterPeer(routerPeerId: string, by: string): Promise<void> {
    const api = await this.api()
    if (!api.write) throw new WgInputError('HyperProx has no write access to the router.')
    const peer = mapPeers(await api.read('/rest/interface/wireguard/peers')).find(p => p.id === routerPeerId)
    if (!peer) return
    if (!peer.managed) throw new WgInputError(`Router peer ${routerPeerId} was not created by HyperProx (no ${MARK} comment), so it is left alone`)
    await api.write.del(`/rest/interface/wireguard/peers/${encodeURIComponent(routerPeerId)}`)
    if (mapPeers(await api.read('/rest/interface/wireguard/peers')).some(p => p.id === routerPeerId)) throw new Error('The router still shows the peer after removing it')
    await this.d.store.audit('wireguard.router.peer.remove', routerPeerId, { by, credential: 'remote/routeros-write' })
  }

  /** A phone or laptop on the router's WireGuard: browser keypair into the vault, peer on the router, config once. */
  async addRouterDevice(o: { iface: string; endpoint: string; address: string; allowedIps: string[]; name: string; keepalive?: number; dns?: string } & ClientKeys, by: string): Promise<{ peer: WgPeer; config: string }> {
    if (!NAME_RE.test(o.name ?? '')) throw new WgInputError('Give the peer a name')
    if (!/^[0-9.]+\/32$/.test(o.address)) throw new WgInputError('The tunnel address must be one IPv4 address, like 192.0.2.10/32')
    if (!o.allowedIps.length || !o.allowedIps.every(validCidr)) throw new WgInputError('Allowed IPs must have prefixes')
    if (!/^(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]{1,253}):\d{1,5}$/.test(o.endpoint)) throw new WgInputError('The router endpoint must be host:port')
    if (o.keygen === 'server') throw new WgInputError('For a router peer the browser must make the keypair')
    const rif = (await this.routerInterfaces()).find(i => i.name === o.iface)
    if (!rif?.publicKey) throw new WgInputError(`The router has no WireGuard interface ${o.iface}`)
    if (!isWgKey(o.privateKey) || !isWgKey(o.publicKey) || publicOf(o.privateKey) !== o.publicKey) throw new WgInputError('Send the keypair the browser made')
    const id = randomUUID()
    const config = renderClientConfig({ privateKey: o.privateKey, address: o.address, serverPublicKey: rif.publicKey, endpoint: o.endpoint, allowedIps: o.allowedIps, keepalive: o.keepalive ?? 25, dns: o.dns })
    await this.d.vault.put(peerItem(id), { private_key: o.privateKey, config })
    await this.d.store.audit('wireguard.vault.write', peerItem(id), { by, what: 'client config' })
    let added: RouterWgPeer
    try {
      added = await this.addRouterPeer({ iface: o.iface, publicKey: o.publicKey, allowedAddress: [o.address], keepalive: null, id, name: o.name }, by)
    } catch (e) {
      await this.d.vault.remove(peerItem(id)).catch(() => undefined)
      throw e
    }
    const peer = await this.d.store.addPeer({
      id, serverId: null, routerIface: o.iface, routerPeerId: added.id, kind: 'device', name: o.name, machineId: null, iface: null,
      publicKey: o.publicKey, address: o.address, allowedIps: [o.address], clientAllowedIps: o.allowedIps, keepalive: o.keepalive ?? 25,
      previousPublicKey: null, previousUntil: null, rotatedAt: null,
    })
    return { peer, config }
  }
}

export { msg as wgMessage }
