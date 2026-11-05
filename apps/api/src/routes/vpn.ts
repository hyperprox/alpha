// =============================================================================
//  HyperProx — WireGuard routes (/api/vpn/wg)
//
//  Admin only, reads included (they list endpoints and keys' public halves).
//  Everything that changes something, reveals a client config or rotates a key
//  needs a fresh master-password re-confirmation (lib/roles.ts), which also
//  keeps API tokens out. Responses that carry a config are never cached.
// =============================================================================

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { hasRole } from '../lib/roles'
import { onUnlock } from '../lib/vault/state'
import { getProviderCredentials, setCredentials } from '../lib/credentials'
import { pluginAddress, pluginRead } from '../lib/plugin-host'
import { mikrotikPlugin } from '../plugins/mikrotik'
import { livePve } from '../lib/pve-env'
import { productionRemoteExecutor } from '../lib/remote/executor'
import { RemoteAccessService } from '../lib/remote/service'
import { PrismaRemoteStore } from '../lib/remote/store'
import { providerFromVault, providerSettingsFromVault } from '../lib/remote/providers'
import { WireguardService, WgInputError, WgNotFoundError, type WgVault } from '../lib/vpn/wireguard/service'
import { PrismaWgStore } from '../lib/vpn/wireguard/store'
import { restWriter, type RouterApi } from '../lib/vpn/wireguard/routeros'

export interface VpnRouteDeps { service?: WireguardService; sweep?: boolean }

const WG_CATEGORY = 'wireguard'
/** Every field a WireGuard vault item can have; a missing one is written empty, so a write replaces the item. */
const WG_FIELDS = ['private_key', 'config', 'previous_private_key', 'previous_config', 'rotated_at', 'status_previous']

/** WireGuard vault items through the credential store: one item per peer, replaced whole on each write. */
export const vaultWg: WgVault = {
  async put(item, fields) {
    await setCredentials(WG_CATEGORY, item, Object.fromEntries(WG_FIELDS.map(k => [k, fields[k] ?? ''])))
  },
  async get(item) {
    const v = await getProviderCredentials(WG_CATEGORY, item)
    return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ''))
  },
  async remove(item) {
    await setCredentials(WG_CATEGORY, item, Object.fromEntries(WG_FIELDS.map(k => [k, ''])))
  },
}

/** Reads through the MikroTik plug-in; writes only with the limited login from the vault. */
export async function productionRouter(): Promise<RouterApi | null> {
  const address = await pluginAddress(mikrotikPlugin)
  if (!address) return null
  const cred = await getProviderCredentials('remote', 'routeros-write')
  return {
    read: path => pluginRead(mikrotikPlugin, path, 10_000),
    write: cred.username && cred.password ? restWriter(address, { username: cred.username, password: cred.password }) : null,
  }
}

async function adminOnly(req: FastifyRequest, reply: FastifyReply) {
  const s = req.session
  if (!s) return reply.status(401).send({ ok: false, code: 'unauthenticated', error: 'Authentication required' })
  if (!hasRole(s.role, 'admin')) return reply.status(403).send({ ok: false, code: 'forbidden', error: 'WireGuard needs the admin role', required: 'admin', role: s.role })
}

function sendError(reply: FastifyReply, e: any) {
  if (e instanceof WgInputError) return reply.status(400).send({ error: e.message })
  if (e instanceof WgNotFoundError) return reply.status(404).send({ error: e.message })
  if (e?.name === 'VaultLockedError') throw e   // 423 from the gate's error handler
  return reply.status(503).send({ error: e?.message ?? String(e) })
}

const ID = /^[A-Za-z0-9_-]{1,64}$/
const MACHINE = /^(node|lxc|qemu|host)-[A-Za-z0-9._-]{1,120}$/

export function buildVpnRoutes(deps: VpnRouteDeps = {}): FastifyPluginAsync {
  return async (fastify) => {
    const service = deps.service ?? (() => {
      const remote = new RemoteAccessService({
        store: new PrismaRemoteStore((fastify as any).prisma), exec: productionRemoteExecutor(livePve()),
        provider: id => providerFromVault(id), providerSettings: id => providerSettingsFromVault(id), log: m => fastify.log.info(m),
      })
      return new WireguardService({ remote, exec: productionRemoteExecutor(livePve()), store: new PrismaWgStore((fastify as any).prisma), vault: vaultWg, router: productionRouter })
    })()
    if (deps.sweep !== false) {
      let t: NodeJS.Timeout | null = null
      fastify.addHook('onReady', async () => { void service.sweepRotations().catch(() => 0); t = setInterval(() => { void service.sweepRotations().catch(() => 0) }, 3600_000); t.unref?.() })
      fastify.addHook('onClose', async () => { if (t) clearInterval(t) })
      onUnlock(() => { void service.sweepRotations().catch(() => 0) })
    }
    fastify.addHook('preHandler', adminOnly)
    const by = (req: FastifyRequest) => req.session?.email ?? 'unknown'
    const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store')
    const id = (v: string) => { if (!ID.test(v)) throw new WgInputError('Unknown id'); return v }
    const wrap = <T>(fn: () => Promise<T>) => async (_req: FastifyRequest, reply: FastifyReply) => { try { return await fn() } catch (e) { return sendError(reply, e) } }

    fastify.get('/wg', async (_req, reply) => {
      try { return { servers: await (service as any).d.store.listServers(), peers: await (service as any).d.store.listPeers() } } catch (e) { return sendError(reply, e) }
    })
    fastify.get<{ Params: { id: string } }>('/wg/servers/:id/status', async (req, reply) => {
      try { return await service.serverStatus(id(req.params.id)) } catch (e) { return sendError(reply, e) }
    })
    fastify.post<{ Body: any }>('/wg/servers', async (req, reply) => {
      try {
        const b: any = req.body ?? {}
        if (!MACHINE.test(String(b.machineId ?? ''))) throw new WgInputError('Choose a machine')
        return reply.status(201).send({ server: await service.createServer({ machineId: b.machineId, iface: b.iface, listenPort: b.listenPort, address: String(b.address ?? ''), endpoint: String(b.endpoint ?? ''), backupKey: b.backupKey === true }, by(req)) })
      } catch (e) { return sendError(reply, e) }
    })
    fastify.post<{ Body: any }>('/wg/servers/adopt', async (req, reply) => {
      try {
        const b: any = req.body ?? {}
        if (!MACHINE.test(String(b.machineId ?? ''))) throw new WgInputError('Choose a machine')
        return { server: await service.adoptServer({ machineId: b.machineId, iface: b.iface, address: String(b.address ?? ''), endpoint: String(b.endpoint ?? '') }, by(req)) }
      } catch (e) { return sendError(reply, e) }
    })
    fastify.post<{ Params: { id: string } }>('/wg/servers/:id/backup-key', async (req, reply) => {
      try { await service.backupServerKey(id(req.params.id), by(req)); return { ok: true } } catch (e) { return sendError(reply, e) }
    })
    fastify.post<{ Params: { id: string }; Body: any }>('/wg/servers/:id/devices', async (req, reply) => {
      try {
        const b: any = req.body ?? {}
        noStore(reply)
        return reply.status(201).send(await service.addDevice(id(req.params.id), { name: b.name, allowedIps: b.allowedIps, keepalive: b.keepalive, dns: b.dns, publicKey: b.publicKey, privateKey: b.privateKey, keygen: b.keygen }, by(req)))
      } catch (e) { return sendError(reply, e) }
    })
    fastify.patch<{ Params: { id: string }; Body: any }>('/wg/peers/:id', async (req, reply) => {
      try { const b: any = req.body ?? {}; return { peer: await service.updatePeer(id(req.params.id), { name: b.name, clientAllowedIps: b.clientAllowedIps, keepalive: b.keepalive }, by(req)) } } catch (e) { return sendError(reply, e) }
    })
    fastify.delete<{ Params: { id: string } }>('/wg/peers/:id', async (req, reply) => {
      try { await service.removePeer(id(req.params.id), by(req)); return { ok: true } } catch (e) { return sendError(reply, e) }
    })
    fastify.post<{ Params: { id: string } }>('/wg/peers/:id/reveal', async (req, reply) => {
      try { noStore(reply); return await service.revealDevice(id(req.params.id), by(req)) } catch (e) { return sendError(reply, e) }
    })
    fastify.post<{ Params: { id: string }; Body: any }>('/wg/peers/:id/rotate', async (req, reply) => {
      try { const b: any = req.body ?? {}; noStore(reply); return await service.rotateDevice(id(req.params.id), { publicKey: b.publicKey, privateKey: b.privateKey, keygen: b.keygen }, by(req)) } catch (e) { return sendError(reply, e) }
    })
    fastify.post<{ Params: { id: string } }>('/wg/peers/:id/rollback', async (req, reply) => {
      try { return { peer: await service.rollbackRotation(id(req.params.id), by(req)) } } catch (e) { return sendError(reply, e) }
    })
    fastify.post<{ Params: { id: string }; Body: any }>('/wg/machines/:id/connect', async (req, reply) => {
      try {
        if (!MACHINE.test(req.params.id)) throw new WgInputError('Unknown machine id format')
        const b: any = req.body ?? {}
        return await service.connectMachine({ machineId: req.params.id, serverId: b.serverId, router: b.router, allowedIps: b.allowedIps ?? [], siteSubnets: b.siteSubnets, remoteSubnets: b.remoteSubnets, keepalive: b.keepalive, iface: b.iface }, by(req))
      } catch (e) { return sendError(reply, e) }
    })
    fastify.get('/wg/router', wrap(() => service.routerView()))
    fastify.post<{ Body: any }>('/wg/router/peers/preview', async (req, reply) => {
      try { const b: any = req.body ?? {}; return await service.routerPeerPreview({ iface: String(b.iface ?? ''), publicKey: String(b.publicKey ?? ''), allowedAddress: b.allowedAddress ?? [], keepalive: b.keepalive, name: String(b.name ?? '') }) } catch (e) { return sendError(reply, e) }
    })
    fastify.post<{ Body: any }>('/wg/router/devices', async (req, reply) => {
      try {
        const b: any = req.body ?? {}
        noStore(reply)
        return reply.status(201).send(await service.addRouterDevice({ iface: String(b.iface ?? ''), endpoint: String(b.endpoint ?? ''), address: String(b.address ?? ''), allowedIps: b.allowedIps ?? [], name: String(b.name ?? ''), keepalive: b.keepalive, dns: b.dns, publicKey: b.publicKey, privateKey: b.privateKey }, by(req)))
      } catch (e) { return sendError(reply, e) }
    })
    fastify.delete<{ Params: { id: string } }>('/wg/router/peers/:id', async (req, reply) => {
      try { if (!/^\*[0-9A-F]{1,8}$/.test(req.params.id)) throw new WgInputError('Not a RouterOS id'); await service.removeRouterPeer(req.params.id, by(req)); return { ok: true } } catch (e) { return sendError(reply, e) }
    })
  }
}

export const vpnRoutes: FastifyPluginAsync = buildVpnRoutes()
