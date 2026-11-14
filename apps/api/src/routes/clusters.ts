// =============================================================================
//  HyperProx — clusters (/api/clusters): the Command center, adding a server, and actions on any cluster
//
//  Roles (lib/roles.ts): the list, the Command center and task status are viewer; power is operator; every
//  other call is admin. Anything that stores or replaces a credential, confirms a certificate or host key,
//  deletes, or installs is admin with the master password re-entered, which also keeps API tokens out.
//
//  Secrets go one way: into the vault. No answer here carries a token, a password, a key or a fingerprint of
//  one, and the audit log records who did what to which cluster, never a value.
// =============================================================================

import { pbsMountCleanup } from '../lib/pbs/setup-deps'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { currentContext, requestContext } from '../lib/auth'
import { strictParams } from '../lib/route-params'
import { hasRole } from '../lib/roles'
import { auditCredentialUse } from '../lib/audit'
import {
  listClusters, clusterRow, createRemote, updateCluster, removeCluster, confirmFingerprint, replaceRemoteToken,
  hasRemoteToken, remoteTokenId, saveRemoteNodeLogin, removeRemoteNodeLogin, remoteNodeLogins, ClusterRefusal, validClusterId, validateToken,
} from '../lib/clusters/registry'
import { runInCluster } from '../lib/clusters/context'
import { probeCertificate, normaliseFingerprint, PinnedAgent, isServerAddress, CertificateChangedError, allowedApiPort } from '../lib/clusters/tls-pin'
import { ProxmoxClient } from '../lib/proxmox-client'
import { pveFromEnv, homePve, forgetRemoteClient, CertificateNotConfirmedError } from '../lib/pve-env'
import { commandCenter } from '../lib/clusters/overview'
import { scanCluster } from '../lib/clusters/scan'
import { checkGuest, power, snapshot, backupNow, backupStorages, taskStatus, destroy, GuestActionRefusal, type PowerAction } from '../lib/clusters/guest-actions'
import { probeHostKey, execOnNode, nodeCredential } from '../lib/node-exec'
import { confirmPin, PinConfirmRefusal, forgetPin, pinnedKey, pinSource, isConfirmedSource, PinVerifyRefusal } from '../lib/hostkey-pins'
import { verifyNodes, productionVerifyDeps, VerifyRefusal, saveAnchors, ANCHOR_COMMAND, TAILSCALE_DEV } from '../lib/hostkey-verify'
import { addServer, linkDevice, inspectAddress, certNames, scriptHash, startAddJob, addJob, IdentityMismatch, MANUAL_CERT_WHY, type AddServerDeps, type AddServerResult } from '../lib/clusters/add-server'
import { discoverSend, sendDeps } from '../lib/clusters/send-simple'
import { remoteToken } from '../lib/clusters/registry'
import { anchorReplaced } from '../lib/setup-checklist'
import { forgetRemoteGuestConfigService } from './guest-config'
import { browse, setupSending, previewCopy, startCopy, jobStore, CopyRunner, setCopyKick, savePlex, deletePlexToken, checkPlexUrl, forgetClusterSending, type CopyInput } from '../lib/clusters/files'
import { writeRemoteTargets } from '../lib/clusters/monitoring'
import { prometheusBase } from '../lib/service-health'
import { updateCluster as updateClusterRow, looksLikeHome, homeAddresses, HOME_DUPLICATE, type ClusterIdentity } from '../lib/clusters/registry'
import { scanMonitoring, previewMonitoring, applyMonitoring, planSteps, MonitoringRefusal } from '../lib/clusters/monitoring'
import { afterCopyScan } from '../lib/clusters/send-simple'
import { sendRoutes } from './send'

const who = () => currentContext()?.email ?? 'unknown'

/** At most `max` calls a minute per signed-in session for the routes that open connections on request. */
const hits = new Map<string, number[]>()
export function overLimit(key: string, max = 10, windowMs = 60_000, now = Date.now()): boolean {
  const list = (hits.get(key) ?? []).filter(t => now - t < windowMs)
  const over = list.length >= max
  if (!over) list.push(now)
  hits.set(key, list)
  return over
}
const limited = (route: string, reply: FastifyReply) => {
  if (!overLimit(`${route}:${currentContext()?.sid ?? 'none'}`)) return false
  reply.status(429).send({ success: false, error: 'That was asked too often. Wait a minute and try again.' })
  return true
}

/** A failure as the status and body the page gets: shared by the routes and the add job. */
function failure(e: any): { status: number; body: Record<string, unknown> } {
  let out: { status: number; body: Record<string, unknown> } | null = null
  const fake: any = { status(s: number) { return { send(b: any) { out = { status: s, body: b }; return out } } } }
  fail(fake, e)
  return out!
}

function fail(reply: FastifyReply, e: any) {
  const msg = e?.message ?? String(e)
  if (e?.name === 'VaultLockedError' || /HyperProx is locked/i.test(msg)) return reply.status(423).send({ success: false, locked: true, error: 'HyperProx is locked. Sign in to unlock it, then try again. Nothing was done.' })
  if (e instanceof ClusterRefusal) return reply.status(e.code === 'not-found' ? 404 : e.code === 'conflict' ? 409 : 422).send({ success: false, code: e.code, error: msg })
  if (e instanceof GuestActionRefusal) return reply.status(e.code === 'not-found' ? 404 : e.code === 'confirm' ? 428 : 422).send({ success: false, code: e.code, error: msg })
  if (e instanceof CertificateChangedError) return reply.status(409).send({ success: false, code: 'cert_changed', error: msg, presented: e.presented })
  if (e instanceof CertificateNotConfirmedError) return reply.status(409).send({ success: false, code: 'cert_unconfirmed', error: msg })
  if (e instanceof MonitoringRefusal) return reply.status(409).send({ success: false, code: 'monitoring', error: msg })
  if (e instanceof PinConfirmRefusal || e instanceof PinVerifyRefusal) return reply.status(409).send({ success: false, code: 'hostkey', error: msg })
  if (e instanceof IdentityMismatch) return reply.status(409).send({ success: false, code: 'identity_mismatch', error: msg })
  if (e instanceof VerifyRefusal) return reply.status(403).send({ success: false, code: 'token_forbidden', error: msg })
  return reply.status(502).send({ success: false, error: msg })
}

function clusterOr404(id: string, reply: FastifyReply) {
  if (!validClusterId(id) || !clusterRow(id)) { reply.status(404).send({ success: false, error: 'No such cluster.' }); return null }
  return clusterRow(id)!
}

/** The admin-rights check: the token must be able to change guests, storage and the system on "/". */
export const ADMIN_PRIVS = ['VM.Allocate', 'VM.PowerMgmt', 'VM.Config.Disk', 'VM.Snapshot', 'VM.Backup', 'Datastore.Allocate', 'Sys.Modify', 'Sys.Audit']
export function missingAdminPrivs(perms: any): string[] {
  const root = perms?.['/'] ?? {}
  return ADMIN_PRIVS.filter(p => !root[p])
}

/** The commands the owner pastes into the remote server's shell (step 2). Nothing secret in them. */
export function tokenCommands(user = 'hyperprox@pve', token = 'main'): string[] {
  return [
    `pveum user add ${user} --comment "HyperProx"`,
    `pveum aclmod / -user ${user} -role Administrator`,
    `pveum user token add ${user} ${token} --privsep 0`,
  ]
}

/** Connect with a candidate token over a pinned connection; nothing is stored. */
async function tryToken(address: string, port: number, fingerprint: string, tokenId: string, secret: string) {
  const c = new ProxmoxClient(address, port, tokenId.trim(), secret.trim(), { agent: new PinnedAgent(fingerprint) })
  const version = await c.fetchStrict<any>('/version', 'GET', undefined, 10_000)
  const perms = await c.fetchStrict<any>('/access/permissions?path=/', 'GET', undefined, 10_000).catch(() => null)
  const nodes = await c.fetchStrict<any[]>('/nodes', 'GET', undefined, 10_000).catch(() => [])
  const status = await c.fetchStrict<any[]>('/cluster/status', 'GET', undefined, 10_000).catch(() => [])
  return {
    version: String(version?.version ?? ''), missing: perms ? missingAdminPrivs(perms) : ADMIN_PRIVS, nodes: (nodes ?? []).map(n => String(n.node)),
    identity: statusIdentity(status),
  }
}

/** Cluster name, nodes, and the node that answered (`local`), from a /cluster/status answer. */
function statusIdentity(rows: unknown): { clusterName: string | null; nodes: { name: string; ip: string | null }[]; local: string | null } {
  const list = Array.isArray(rows) ? rows : []
  const cluster = list.find((r: any) => r?.type === 'cluster')
  const local = list.find((r: any) => r?.type === 'node' && Number(r?.local) === 1)
  return {
    clusterName: cluster?.name ? String(cluster.name) : null,
    nodes: list.filter((r: any) => r?.type === 'node').map((r: any) => ({ name: String(r.name), ip: r.ip ? String(r.ip) : null })),
    local: local?.name ? String(local.name) : null,
  }
}

/** What an add's outcome reads as on the page (the status and body the request used to answer with). */
function addAnswer(r: AddServerResult | null, e: any): { status: number; body: Record<string, unknown> } {
  if (r?.kind === 'manual-certificate') return { status: 409, body: { success: false, code: 'cert_manual', error: r.why, certificate: r.certificate } }
  if (r) return { status: 200, body: { success: true, data: { cluster: r.cluster, version: r.version, nodes: r.nodes, setup: r.setup } } }
  if (e instanceof ClusterRefusal && e.code === 'conflict' && (e as any).presented) return { status: 409, body: { success: false, code: 'cert_changed', error: e.message, presented: (e as any).presented } }
  if (e instanceof ClusterRefusal && /^This is your home cluster/.test(e.message)) return { status: 409, body: { success: false, code: 'home_cluster', error: e.message } }
  return failure(e)
}

/** The live wiring for the one-step add (lib/clusters/add-server.ts). */
function addServerDeps(log: (m: string) => void): AddServerDeps {
  const v = productionVerifyDeps()
  return {
    probeCertificate: (a, p) => probeCertificate(a, p),
    tryToken: (a, p, fp, id, secret) => tryToken(a, p, fp, id, secret),
    homeIdentity: () => homeIdentity(),
    tailnet: () => v.tailnet(),
    whois: ip => v.whois(ip),
    route: ip => v.route(ip),
    createRemote: n => createRemote(n),
    findRemote: (address, port) => listClusters().find(c => c.kind === 'remote' && c.address.toLowerCase() === address.toLowerCase() && c.port === port) ?? null,
    replaceToken: (id, tokenId, secret) => replaceRemoteToken(id, tokenId, secret),
    setNodeAddresses: (id, m) => updateCluster(id, { nodeAddresses: m }),
    verifyNodes: (id, input) => runInCluster(id, () => verifyNodes(input, v)),
    testLogin: (id, host, cred) => runInCluster(id, async () => (await execOnNode({ host, cred, command: 'true', requirePin: true, timeoutMs: 20_000 })).code === 0),
    saveLogin: (id, node, cred) => saveRemoteNodeLogin(id, node, JSON.stringify(cred)),
    async monitoring(id, by, shown) {
      const p = await previewMonitoring(id, by, 'install', { 'server-metrics': true })
      // Only what the owner was shown before the password: node_exporter, with that exact script, nothing else.
      const plan = planSteps(p.planId)
      if (!plan.length || plan.some(s => s.what !== 'node-exporter' || scriptHash(s.script) !== shown)) return 'Monitoring was not installed: what it would run is not what you were shown. The Edit page shows it again.'
      const r = await applyMonitoring(p.planId, by, undefined, id)
      await auditCredentialUse('cluster.monitoring.apply', `cluster:${id}`, { by, ok: r.ok, nodes: r.results.map(x => x.node), source: 'add server' })
      const failed = r.results.filter(x => x.status === 'failed').map(x => x.node)
      return r.ok ? `Monitoring installed on ${r.results.map(x => x.node).filter(Boolean).join(', ')}, and Prometheus is collecting from it.`
        : failed.length ? `Monitoring did not install on ${failed.join(', ')}; the Edit page shows why and can try again.`
        : 'Monitoring is installed; Prometheus has not collected from it yet (it scrapes every 15 seconds).'
    },
    async sending(id) {
      const plan = await discoverSend(id, sendDeps(), { fresh: true })
      if (plan.problems.length) return `Send files is not ready yet: ${plan.problems.join(' ')}`
      return `Send files is ready: HyperProx can send from ${plan.sourceNode} to ${plan.libraries.length} ${plan.libraries.length === 1 ? 'library' : 'libraries'} there. Pick what to send in Send files.`
    },
    audit: (a, r, d) => auditCredentialUse(a, r, d),
    async alert(title, lines) { log(`${title}: ${lines.join(' ')}`); await v.alert(title, lines) },
  }
}

/** The home cluster's identity, read through its own connection. Parts it cannot read stay empty. */
async function homeIdentity(): Promise<ClusterIdentity> {
  const status = await homePve().fetchStrict<any[]>('/cluster/status', 'GET', undefined, 10_000).catch(() => [])
  const host = process.env.PROXMOX_HOST ?? ''
  const fp = host ? await probeCertificate(host, Number(process.env.PROXMOX_PORT ?? 8006), 5_000).then(c => c.fingerprint).catch(() => null) : null
  return { addresses: homeAddresses(), fingerprint: fp, ...statusIdentity(status) }
}

export const clusterRoutes: FastifyPluginAsync = async (fastify) => {
  strictParams(fastify)

  // ── Reads ─────────────────────────────────────────────────────────────────

  // Addresses, folders, Plex, the token id and the certificate are for admins. Everyone else sees which
  // clusters exist and how they are doing, nothing about how to reach them.
  const isAdmin = () => { const c = currentContext(); return !!c && hasRole(c.role, 'admin') }

  fastify.get('/', async () => {
    if (!isAdmin()) return { success: true, data: listClusters().map(c => ({ id: c.id, name: c.name, kind: c.kind })) }
    return {
      success: true,
      data: listClusters().map(c => ({ ...c, token: c.kind === 'remote' ? { saved: hasRemoteToken(c.id), id: remoteTokenId(c.id) } : null })),
      commands: tokenCommands(),
    }
  })

  fastify.get('/overview', async (_req, reply) => {
    try {
      const data = await commandCenter()
      if (isAdmin()) return { success: true, data }
      // Connection errors can name addresses and fingerprints: below admin they become plain words.
      const plain = (t: string) => (/certificate/i.test(t) ? 'Its certificate changed; an admin needs to check it.' : 'Not answering right now.')
      const scrub = (a: any) => (a.severity === 'crit' && /answer|connect|certificate/i.test(a.title) ? { ...a, detail: plain(`${a.title} ${a.detail}`) } : a)
      return { success: true, data: { panels: data.panels.map(p => ({ ...p, error: p.error ? plain(p.error) : undefined, attention: p.attention.map(scrub) })), attention: data.attention.map(scrub) } }
    } catch (e) { return fail(reply, e) }
  })

  // ── Adding a server ───────────────────────────────────────────────────────

  // Step 4: what the server presents now, for the owner to compare. Nothing is sent to it.
  fastify.post<{ Body: { address?: string; port?: number } }>('/probe-certificate', async (req, reply) => {
    if (limited('probe', reply)) return
    const address = String(req.body?.address ?? '').trim(), port = Number(req.body?.port ?? 8006)
    if (!allowedApiPort(port)) return reply.status(422).send({ success: false, error: 'The port must be 8006 (Proxmox\'s own), 443, 8443, or a number from 1024 to 65535.' })
    if (!isServerAddress(address)) return reply.status(422).send({ success: false, error: 'The address must be a name or an IP address only, with no https:// and no port.' })
    try { return { success: true, data: await probeCertificate(address, port) } } catch (e) { return fail(reply, e) }
  })

  // Before the password: what is at that address (certificate, the private-link device and its owner) and what
  // monitoring would install. Reads only; no token, no login. The add then refuses if any of it changed (its hash).
  fastify.post<{ Body: { address?: string; port?: number } }>('/add-preview', async (req, reply) => {
    if (limited('probe', reply)) return
    const address = String(req.body?.address ?? '').trim(), port = Number(req.body?.port ?? 8006)
    if (!allowedApiPort(port)) return reply.status(422).send({ success: false, error: 'The port must be 8006 (Proxmox\'s own), 443, 8443, or a number from 1024 to 65535.' })
    if (!isServerAddress(address)) return reply.status(422).send({ success: false, error: 'The address must be a name or an IP address only, with no https:// and no port.' })
    try {
      const i = await inspectAddress(address, port, addServerDeps(m => fastify.log.warn(m)))
      return { success: true, data: { certificate: i.certificate, connectingTo: i.link ? { device: i.link.device, owner: i.link.owner } : null, why: i.why, monitoring: i.monitoring.steps, hash: i.hash } }
    } catch (e) { return fail(reply, e) }
  })

  // Adding a server, in one step under the one master-password re-confirmation (lib/roles.ts): the certificate
  // (verified over a private link, or the fingerprint the owner compared when that is not possible), the token, the
  // node addresses, and with a node login, host keys verified and the login saved, then monitoring and Send files.
  // Nothing is stored until the certificate and the token have both passed (vault first, then the row).
  fastify.post<{ Body: { name?: string; address?: string; port?: number; note?: string; tokenId?: string; tokenSecret?: string; fingerprint?: string; login?: any; monitoring?: boolean; sending?: boolean; previewHash?: string } }>('/', async (req, reply) => {
    const b = req.body ?? {}
    try {
      if ((req as any).apiToken) return reply.status(403).send({ success: false, code: 'token_forbidden', error: 'Adding a server needs a person with the master password, not an API token.' })
      const address = String(b.address ?? '').trim(), port = Number(b.port ?? 8006)
      if (!isServerAddress(address)) throw new ClusterRefusal('The address must be a name or an IP address only.')
      if (!allowedApiPort(port)) throw new ClusterRefusal('The port must be 8006 (Proxmox\'s own), 443, 8443, or a number from 1024 to 65535.')
      validateToken(String(b.tokenId ?? ''), String(b.tokenSecret ?? ''))
      const fp = b.fingerprint ? normaliseFingerprint(String(b.fingerprint)) : null
      if (b.fingerprint && !fp) throw new ClusterRefusal('That is not a SHA-256 certificate fingerprint.')
      const login = b.login && typeof b.login === 'object' && (b.login.password || b.login.privateKey) ? b.login : null
      const input = {
        name: String(b.name ?? ''), address, port, note: b.note, tokenId: String(b.tokenId ?? ''), tokenSecret: String(b.tokenSecret ?? ''),
        fingerprint: fp, login, monitoring: b.monitoring !== false, sending: b.sending !== false, previewHash: typeof b.previewHash === 'string' ? b.previewHash : null, by: who(),
      }
      // The work (certificate, token, keys, logins, monitoring) can take minutes: it runs as a job, as this signed-in
      // person (whose vault session it needs), and the page polls GET /add-jobs/:id for the answer.
      const ctx = currentContext()!
      const deps = addServerDeps(m => fastify.log.warn(m))
      const job = startAddJob(`${ctx.email}:${ctx.sid}`, input, () => requestContext.run(ctx, () => addServer(input, deps)), addAnswer)
      return reply.status(202).send({ success: true, data: { jobId: job.id, status: job.status } })
    } catch (e: any) { return fail(reply, e) }
  })

  fastify.get<{ Params: { jobId: string } }>('/add-jobs/:jobId', async (req, reply) => {
    const ctx = currentContext()
    const j = ctx ? addJob(`${ctx.email}:${ctx.sid}`, req.params.jobId) : null
    if (!j) return reply.status(404).send({ success: false, error: 'No such job.' })
    return { success: true, data: j }
  })

  // ── One cluster ───────────────────────────────────────────────────────────

  fastify.post<{ Params: { id: string } }>('/:id/test', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    if (limited('test', reply)) return
    try {
      return await runInCluster(row.id, async () => {
        const pve = pveFromEnv()
        const t0 = Date.now()
        const version = await pve.fetchStrict<any>('/version', 'GET', undefined, 10_000)
        const latencyMs = Date.now() - t0
        const nodes = await pve.fetchStrict<any[]>('/nodes').catch(() => [])
        return { success: true, data: { latencyMs, version: version?.version ?? null, nodes: (nodes ?? []).map(n => ({ node: n.node, status: n.status })) } }
      })
    } catch (e: any) {
      // A changed certificate, a locked vault or a missing token say so; any network failure reads the same.
      if (e instanceof CertificateChangedError || e instanceof CertificateNotConfirmedError || e?.name === 'VaultLockedError' || e instanceof ClusterRefusal) return fail(reply, e)
      return reply.status(502).send({ success: false, error: 'Not answering at its address. Check that it is on and that HyperProx can reach it.' })
    }
  })

  // Name and note only: nothing here changes where HyperProx connects or what it may write.
  fastify.patch<{ Params: { id: string }; Body: Record<string, any> }>('/:id', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    const b: Record<string, any> = req.body ?? {}
    const other = Object.keys(b).filter(k => !['name', 'note'].includes(k) && b[k] !== undefined)
    if (other.length) return reply.status(422).send({ success: false, error: `Change ${other.join(', ')} through the connection settings (they need your master password), not here.` })
    try {
      const c = await updateCluster(row.id, { name: b.name, note: b.note })
      await auditCredentialUse('cluster.edit', `cluster:${row.id}`, { by: who(), fields: Object.keys(b) })
      return { success: true, data: c }
    } catch (e) { return fail(reply, e) }
  })

  // Where HyperProx connects and what copies may write into. Re-confirmed (lib/roles.ts). A node whose address
  // changes loses its saved login and host-key pin: the new address is confirmed afresh before a login goes there.
  fastify.post<{ Params: { id: string }; Body: Record<string, any> }>('/:id/connection', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    const b: Record<string, any> = req.body ?? {}
    try {
      const before = { ...row.nodeAddresses }
      const c = await updateCluster(row.id, { address: b.address, port: b.port, allowedRoots: b.allowedRoots, nodeAddresses: b.nodeAddresses, ignoredGuests: b.ignoredGuests })
      const cleared: string[] = []
      if (b.nodeAddresses !== undefined) {
        for (const [node, old] of Object.entries(before)) {
          if (c.nodeAddresses[node] === old) continue
          // A remote's pin is scoped to it. An unscoped pin on the same address is left alone: it may be a home machine's.
          await forgetPin(old, 22, row.kind === 'remote' ? row.id : null).catch(() => undefined)
          if (row.kind === 'remote') await removeRemoteNodeLogin(row.id, node).catch(() => undefined)
          cleared.push(node)
        }
      }
      forgetRemoteClient(row.id)
      await auditCredentialUse('cluster.connection.edit', `cluster:${row.id}`, { by: who(), fields: Object.keys(b).filter(k => b[k] !== undefined), cleared })
      return { success: true, data: c, certNeedsConfirming: c.kind === 'remote' && !c.cert.fingerprint, loginsCleared: cleared }
    } catch (e) { return fail(reply, e) }
  })

  // Confirm the certificate at the server's (new) address. With no fingerprint given HyperProx verifies it itself over
  // a private link, as when adding; that is never done for a certificate that CHANGED from the one pinned (that is
  // refused, and only a fingerprint the owner compared replaces it). Otherwise the fingerprint must be the one
  // presented right now.
  fastify.post<{ Params: { id: string }; Body: { fingerprint?: string } }>('/:id/certificate', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    if (row.kind !== 'remote') return reply.status(422).send({ success: false, error: 'The home cluster has no certificate to confirm here.' })
    try {
      if (!req.body?.fingerprint) {
        if ((req as any).apiToken) return reply.status(403).send({ success: false, code: 'token_forbidden', error: 'An API token cannot confirm a certificate.' })
        const v = productionVerifyDeps()
        // The route into the tunnel is read before the certificate, after it, and again before the token goes.
        const routes = [await v.route(row.address).catch(() => null)]
        const now = await probeCertificate(row.address, row.port)
        if (row.certFingerprint && row.certFingerprint !== now.fingerprint) return reply.status(409).send({ success: false, code: 'cert_changed', error: `The server presents ${now.fingerprint}, not the certificate you confirmed. A changed certificate is never accepted automatically: compare the new one on its Proxmox page and confirm it.`, presented: now.fingerprint })
        // Identity first, before the token is sent: the link vouches for exactly this address, and the certificate is
        // for the device it names. Then the server's own API must name itself as a node the certificate is for.
        routes.push(await v.route(row.address).catch(() => null))
        const device = linkDevice(row.address, await v.tailnet().catch(() => null), await v.whois(row.address).catch(() => null), routes)
        const names = certNames(now)
        if (!device || !names.includes(device.device.toLowerCase())) return reply.status(409).send({ success: false, code: 'cert_manual', error: MANUAL_CERT_WHY, certificate: now })
        if (!TAILSCALE_DEV.test(String(await v.route(row.address).catch(() => null)))) return reply.status(409).send({ success: false, code: 'cert_manual', error: MANUAL_CERT_WHY, certificate: now })
        const tok = remoteToken(row.id)
        const t = await tryToken(row.address, row.port, now.fingerprint, tok.tokenId, tok.secret)
        const local = t.identity.local ?? (t.nodes.length === 1 ? t.nodes[0] : null)
        if (!local || !names.includes(local.toLowerCase())) {
          const why = `The server at ${row.address} says it is ${local ?? 'an unnamed node'}, but its certificate is for ${names.join(', ') || 'no name'}. Nothing was changed.`
          await auditCredentialUse('cluster.certificate.blocked', `cluster:${row.id}`, { by: who(), device: device.device, node: local ?? '' })
          await v.alert(`${row.name}: the certificate check failed`, [why])
          return reply.status(409).send({ success: false, code: 'identity_mismatch', error: why })
        }
        const how = `${device.how}; its certificate is for ${device.device}, which its own API confirms`
        const c = await confirmFingerprint(row.id, now.fingerprint, who(), how)
        forgetRemoteClient(row.id)
        await auditCredentialUse('cluster.certificate.verify', `cluster:${row.id}`, { by: who(), how })
        return { success: true, data: c }
      }
      const fp = normaliseFingerprint(String(req.body?.fingerprint ?? ''))
      if (!fp) throw new ClusterRefusal('That is not a SHA-256 certificate fingerprint.')
      const now = await probeCertificate(row.address, row.port)
      if (now.fingerprint !== fp) return reply.status(409).send({ success: false, code: 'cert_changed', error: `The server presents ${now.fingerprint} right now, not the fingerprint you confirmed. Nothing was changed.`, presented: now.fingerprint })
      const c = await confirmFingerprint(row.id, fp, who())
      forgetRemoteClient(row.id)
      await auditCredentialUse('cluster.certificate.confirm', `cluster:${row.id}`, { by: who() })
      return { success: true, data: c }
    } catch (e) { return fail(reply, e) }
  })

  fastify.post<{ Params: { id: string }; Body: { tokenId?: string; tokenSecret?: string } }>('/:id/token', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    if (row.kind !== 'remote') return reply.status(422).send({ success: false, error: 'The home cluster token is in Settings -> Proxmox.' })
    try {
      if (!row.certFingerprint) throw new CertificateNotConfirmedError(row.name)
      validateToken(String(req.body?.tokenId ?? ''), String(req.body?.tokenSecret ?? ''))
      const t = await tryToken(row.address, row.port, row.certFingerprint, String(req.body?.tokenId ?? ''), String(req.body?.tokenSecret ?? '')).catch((e: any) => {
        if (/HTTP 401/.test(String(e?.message))) throw new ClusterRefusal('The server refused that token. Nothing was changed.')
        throw e
      })
      if (t.missing.length) throw new ClusterRefusal(`That token lacks administrator rights (${t.missing.join(', ')}). Nothing was changed.`)
      await replaceRemoteToken(row.id, String(req.body?.tokenId ?? ''), String(req.body?.tokenSecret ?? ''))
      forgetRemoteClient(row.id)
      await auditCredentialUse('cluster.token.replace', `cluster:${row.id}`, { by: who() })
      return { success: true, data: { saved: true } }
    } catch (e) { return fail(reply, e) }
  })

  // Remove a remote from HyperProx: type its name. Nothing on that server changes; the answer says how to
  // delete the token there too.
  fastify.delete<{ Params: { id: string }; Body: { confirmName?: string } }>('/:id', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    if (row.kind !== 'remote') return reply.status(422).send({ success: false, error: 'The home cluster cannot be removed.' })
    if (String(req.body?.confirmName ?? '') !== row.name) return reply.status(428).send({ success: false, code: 'confirm', error: `Type the server's name exactly (${row.name}) to remove it.` })
    try {
      const tokenId = remoteTokenId(row.id)
      // Standing access first, while its logins still exist: sending keys on destination nodes and in the
      // vault, and Prometheus collecting from it.
      const sending = await forgetClusterSending(row.id)
      if (writeRemoteTargets(row.id, [])) await fetch(`${prometheusBase()}/-/reload`, { method: 'POST' }).catch(() => undefined)
      await removeCluster(row.id)
      forgetRemoteClient(row.id)
      forgetRemoteGuestConfigService(row.id)
      await auditCredentialUse('cluster.remove', `cluster:${row.id}`, { by: who(), name: row.name })
      const [user, token] = (tokenId ?? 'hyperprox@pve!main').split('!')
      return { success: true, data: { removed: true, cleanup: [`pveum user token remove ${user} ${token}`, `pveum user delete ${user}`], sendingKeysRemoved: sending.removed, sendingKeysManual: sending.manual } }
    } catch (e) { return fail(reply, e) }
  })

  // ── Node logins (for scans, monitoring and file copies) ──────────────────

  fastify.get<{ Params: { id: string } }>('/:id/nodes', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    try {
      return await runInCluster(row.id, async () => {
        const nodes = await pveFromEnv().fetchStrict<any[]>('/nodes')
        const logins = row.kind === 'remote' ? new Set(await remoteNodeLogins(row.id)) : null
        return { success: true, data: (nodes ?? []).map(n => ({ node: n.node, status: n.status, address: row.kind === 'remote' ? row.nodeAddresses[n.node] ?? null : null, login: logins ? logins.has(n.node) : null })) }
      })
    } catch (e) { return fail(reply, e) }
  })

  // Verify every node's host key with evidence (lib/hostkey-verify.ts), with the saved logins (or one given here,
  // which is saved for each node whose key is verified). Re-confirmed (lib/roles.ts).
  // `record`: what the one-line command (ANCHOR_COMMAND) printed on one of that server's nodes, kept as its anchor first.
  fastify.post<{ Params: { id: string }; Body: { login?: any; record?: string } }>('/:id/verify-keys', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    if (row.kind !== 'remote') return reply.status(422).send({ success: false, error: 'Home node keys are verified on Settings -> Setup checklist.' })
    if ((req as any).apiToken) return reply.status(403).send({ success: false, code: 'token_forbidden', error: 'An API token cannot verify or change host keys.' })
    if (limited('verify', reply)) return
    try {
      const l = req.body?.login
      const given = l && typeof l === 'object' && (l.password || l.privateKey) && /^[a-z_][a-z0-9_-]{0,31}$/.test(String(l.username ?? 'root').trim())
        ? { username: String(l.username ?? 'root').trim(), port: 22, ...(l.privateKey ? { privateKey: String(l.privateKey), ...(l.passphrase ? { passphrase: String(l.passphrase) } : {}) } : { password: String(l.password) }) } as any
        : null
      if (typeof req.body?.record === 'string' && req.body.record.trim()) {
        const anchored = await saveAnchors(row.id, req.body.record, 'pasted')
        await auditCredentialUse('host_key.anchor.save', `cluster:${row.id}`, { by: who(), source: 'pasted', nodes: anchored.nodes, added: anchored.added, skipped: anchored.skipped })
        if (anchored.replaced.length) await anchorReplaced(row.name, `cluster:${row.id}`, who(), anchored.replaced)
      }
      const out = await runInCluster(row.id, async () => {
        const names = ((await pveFromEnv().fetchStrict<any[]>('/nodes').catch(() => [])) ?? []).map(n => String(n.node))
        const nodes = await Promise.all(names.filter(n => row.nodeAddresses[n]).map(async n => ({ name: n, address: row.nodeAddresses[n], cred: given ?? await nodeCredential(n).catch(() => null) })))
        const verdicts = await verifyNodes({ cluster: row.name, anchorScope: row.id, scope: 'remote', nodes, by: who() })
        const saved: string[] = []
        if (given) for (const v of verdicts) {
          if (v.state !== 'verified' && v.state !== 'already') continue
          const r = await execOnNode({ host: v.host, cred: given, command: 'true', requirePin: true, timeoutMs: 20_000 }).catch(() => null)
          if (r?.code !== 0) continue
          await saveRemoteNodeLogin(row.id, v.node, JSON.stringify(given))
          await auditCredentialUse('cluster.node_login.save', `cluster:${row.id}`, { by: who(), node: v.node, source: 'verify keys' })
          saved.push(v.node)
        }
        return { nodes: verdicts.map(v => ({ node: v.node, state: v.state, how: v.why, login: saved.includes(v.node) ? 'saved' : null })), missingAddress: names.filter(n => !row.nodeAddresses[n]),
          command: verdicts.some(v => v.state === 'no-evidence') ? ANCHOR_COMMAND : null }
      })
      return { success: true, data: out }
    } catch (e) { return fail(reply, e) }
  })

  // The host key a node presents, for the owner to compare with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` there,
  // when HyperProx found no evidence to verify it by itself.
  fastify.post<{ Params: { id: string; node: string } }>('/:id/nodes/:node/hostkey', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    if (row.kind !== 'remote') return reply.status(422).send({ success: false, error: 'Home node logins are in Settings -> Setup checklist.' })
    const addr = row.nodeAddresses[req.params.node]
    if (!addr) return reply.status(422).send({ success: false, error: `No address is saved for ${req.params.node}. Add it first.` })
    try { return { success: true, data: { address: addr, fingerprint: await probeHostKey(addr, 22) } } } catch (e) { return fail(reply, e) }
  })

  fastify.post<{ Params: { id: string; node: string }; Body: { username?: string; password?: string; privateKey?: string; passphrase?: string; fingerprint?: string } }>('/:id/nodes/:node/login', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    if (row.kind !== 'remote') return reply.status(422).send({ success: false, error: 'Home node logins are in Settings -> Setup checklist.' })
    const node = req.params.node
    const addr = row.nodeAddresses[node]
    if (!addr) return reply.status(422).send({ success: false, error: `No address is saved for ${node}. Add it first.` })
    const b = req.body ?? {}
    const username = String(b.username ?? 'root').trim()
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) return reply.status(422).send({ success: false, error: 'That is not a user name.' })
    if (!b.password && !b.privateKey) return reply.status(422).send({ success: false, error: 'Give a password or a private key.' })
    try {
      // A key HyperProx verified (or someone confirmed) needs no fingerprint. Otherwise the owner checked this one on
      // the machine, and it must be what the node presents now.
      // This remote's pins (scoped to it), and the test login, run as that server.
      const [pin, src] = await runInCluster(row.id, () => Promise.all([pinnedKey(addr, 22), pinSource(addr, 22)]))
      const trustedNow = !!pin && isConfirmedSource(src) && (!b.fingerprint || b.fingerprint === pin)
      if (!trustedNow) await runInCluster(row.id, () => confirmPin(addr, 22, String(b.fingerprint ?? ''), (h, p) => probeHostKey(h, p)))
      const cred = { username, port: 22, ...(b.privateKey ? { privateKey: String(b.privateKey), ...(b.passphrase ? { passphrase: String(b.passphrase) } : {}) } : { password: String(b.password) }) }
      const r = await runInCluster(row.id, () => execOnNode({ host: addr, cred, command: 'true', requirePin: true, timeoutMs: 20_000 }))
      if (r.code !== 0) throw new ClusterRefusal('The login was accepted but a test command failed. Nothing was saved.')
      await saveRemoteNodeLogin(row.id, node, JSON.stringify(cred))
      await auditCredentialUse('cluster.node_login.save', `cluster:${row.id}`, { by: who(), node })
      return { success: true, data: { saved: true } }
    } catch (e: any) {
      if (/authentication/i.test(String(e?.message))) return reply.status(422).send({ success: false, error: 'That login was refused. Nothing was saved.' })
      return fail(reply, e)
    }
  })

  fastify.delete<{ Params: { id: string; node: string } }>('/:id/nodes/:node/login', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    try {
      await removeRemoteNodeLogin(row.id, req.params.node)
      await auditCredentialUse('cluster.node_login.remove', `cluster:${row.id}`, { by: who(), node: req.params.node })
      return { success: true }
    } catch (e) { return fail(reply, e) }
  })

  // ── Hardware scan ────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string }; Querystring: { login?: string } }>('/:id/hardware', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    try { return { success: true, data: await scanCluster(row.id, { useLogin: req.query.login === '1' }) } } catch (e) { return fail(reply, e) }
  })

  // ── Monitoring on a remote server (step 5) ───────────────────────────────

  fastify.get<{ Params: { id: string } }>('/:id/monitoring/scan', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    try { return { success: true, data: await scanMonitoring(row.id) } } catch (e) { return fail(reply, e) }
  })

  fastify.post<{ Params: { id: string }; Body: { kind?: string; answers?: Record<string, boolean> } }>('/:id/monitoring/preview', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    const kind = req.body?.kind === 'remove' ? 'remove' : 'install'
    const answers = Object.fromEntries(Object.entries(req.body?.answers ?? {}).map(([k, v]) => [k, v === true]))
    try { return { success: true, data: await previewMonitoring(row.id, who(), kind, answers) } } catch (e) { return fail(reply, e) }
  })

  fastify.post<{ Params: { id: string }; Body: { planId?: string } }>('/:id/monitoring/apply', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    try {
      const r = await applyMonitoring(String(req.body?.planId ?? ''), who(), undefined, row.id)
      await auditCredentialUse('cluster.monitoring.apply', `cluster:${row.id}`, { by: who(), ok: r.ok, nodes: r.results.map(x => x.node) })
      return { success: true, data: r }
    } catch (e) { return fail(reply, e) }
  })

  // ── Files (Send files) ───────────────────────────────────────────────────

  // A copy from the simple flow asks only its own library's Plex to scan (lib/clusters/send-simple.ts).
  const copies = new CopyRunner(undefined, afterCopyScan, m => fastify.log.warn(m))
  copies.start()
  setCopyKick(() => { void copies.tick() })
  fastify.addHook('onClose', async () => copies.stop())

  // Send files, the simple way: pick what, pick where, Send (routes/send.ts).
  await fastify.register(sendRoutes)

  fastify.get<{ Params: { id: string }; Querystring: { node?: string; path?: string } }>('/:id/files/browse', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    try { return { success: true, data: await browse(row.id, String(req.query.node ?? ''), String(req.query.path ?? '')) } } catch (e) { return fail(reply, e) }
  })

  fastify.post<{ Body: { src?: string; dst?: string; dstNode?: string; root?: string } }>('/files/keys', async (req, reply) => {
    const b = req.body ?? {}
    try { return { success: true, data: await setupSending({ src: String(b.src ?? ''), dst: String(b.dst ?? ''), dstNode: String(b.dstNode ?? ''), root: String(b.root ?? ''), by: who() }) } } catch (e) { return fail(reply, e) }
  })

  const endpoint = (x: any) => ({ cluster: String(x?.cluster ?? ''), node: String(x?.node ?? ''), path: String(x?.path ?? '') })
  fastify.post<{ Body: { src?: any; dst?: any; speedKBps?: number; plexScan?: boolean; mode?: string } }>('/files/preview', async (req, reply) => {
    const b = req.body ?? {}
    if (b.mode && b.mode !== 'copy') return reply.status(422).send({ success: false, error: 'Only Copy is offered. Sync and Move are coming soon.' })
    try {
      const input: CopyInput = { src: endpoint(b.src), dst: endpoint(b.dst), speedKBps: Math.round(Number(b.speedKBps ?? 0)), plexScan: b.plexScan === true }
      return { success: true, data: await previewCopy(who(), input) }
    } catch (e) { return fail(reply, e) }
  })

  fastify.post<{ Body: { previewId?: string } }>('/files/jobs', async (req, reply) => {
    try { const j = await startCopy(String(req.body?.previewId ?? ''), who()); void copies.tick(); return { success: true, data: j } } catch (e) { return fail(reply, e) }
  })
  fastify.get('/files/jobs', async (_req, reply) => {
    try { return { success: true, data: await jobStore().list() } } catch (e) { return fail(reply, e) }
  })
  fastify.get<{ Params: { jobId: string } }>('/files/jobs/:jobId', async (req, reply) => {
    try { const j = await jobStore().get(req.params.jobId); return j ? { success: true, data: j } : reply.status(404).send({ success: false, error: 'No such job.' }) } catch (e) { return fail(reply, e) }
  })
  fastify.post<{ Params: { jobId: string } }>('/files/jobs/:jobId/cancel', async (req, reply) => {
    try { return { success: true, data: await copies.cancel(req.params.jobId) } } catch (e) { return fail(reply, e) }
  })
  fastify.post<{ Params: { jobId: string } }>('/files/jobs/:jobId/resume', async (req, reply) => {
    try { const j = await copies.resume(req.params.jobId); void copies.tick(); return { success: true, data: j } } catch (e) { return fail(reply, e) }
  })

  // A Plex on that cluster to ask for a scan after a copy: its address on the row, its token in the vault.
  fastify.post<{ Params: { id: string }; Body: { url?: string; token?: string } }>('/:id/plex', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    try {
      const url = req.body?.url ? String(req.body.url).trim() : null
      if (url) checkPlexUrl(url)
      const hostOf = (u: string | null) => { try { return u ? new URL(u).host.toLowerCase() : null } catch { return null } }
      // A token saved for one Plex is never sent to another: a new host drops it, and a new one must be given.
      const moved = hostOf(row.plexUrl) !== hostOf(url)
      if (moved) await deletePlexToken(row.id)
      await updateClusterRow(row.id, { plexUrl: url })
      if (req.body?.token) await savePlex(row.id, String(req.body.token))
      await auditCredentialUse('cluster.plex.save', `cluster:${row.id}`, { by: who(), tokenDropped: moved && !req.body?.token })
      return { success: true, data: { tokenDropped: moved && !req.body?.token } }
    } catch (e) { return fail(reply, e) }
  })

  // ── Guest actions (every one read back) ──────────────────────────────────

  type G = { Params: { id: string; node: string; type: string; vmid: string } }
  const guestRoute = (fn: (g: ReturnType<typeof checkGuest>, body: any, rowName: string) => Promise<any>, action: string) =>
    async (req: any, reply: FastifyReply) => {
      const row = clusterOr404(req.params.id, reply); if (!row) return
      try {
        const g = checkGuest(req.params.node, req.params.type, req.params.vmid)
        const out = await runInCluster(row.id, () => fn(g, req.body ?? {}, row.name))
        await auditCredentialUse(`cluster.guest.${action}`, `cluster:${row.id}`, { by: who(), node: g.node, guest: `${g.type}/${g.vmid}`, ok: out?.ok ?? null, ...(req.body?.action ? { action: String(req.body.action) } : {}) })
        return reply.status(out?.ok === false ? 502 : 200).send({ success: out?.ok !== false, data: { ...out, cluster: row.name }, ...(out?.ok === false ? { error: out.words } : {}) })
      } catch (e) { return fail(reply, e) }
    }

  fastify.post<G & { Body: { action?: PowerAction } }>('/:id/guests/:node/:type/:vmid/power', guestRoute((g, b) => power({ pve: pveFromEnv() }, g, b.action), 'power'))
  fastify.post<G & { Body: { name?: string; description?: string } }>('/:id/guests/:node/:type/:vmid/snapshot', guestRoute((g, b) => snapshot({ pve: pveFromEnv() }, g, String(b.name ?? ''), String(b.description ?? '')), 'snapshot'))
  fastify.post<G & { Body: { storage?: string } }>('/:id/guests/:node/:type/:vmid/backup', guestRoute((g, b) => backupNow({ pve: pveFromEnv() }, g, String(b.storage ?? '')), 'backup'))
  fastify.post<G & { Body: { confirmName?: string } }>('/:id/guests/:node/:type/:vmid/delete', guestRoute((g, b) => destroy({ pve: pveFromEnv(), afterDestroy: pbsMountCleanup }, g, String(b.confirmName ?? '')), 'delete'))

  fastify.get<{ Params: { id: string; node: string } }>('/:id/nodes/:node/backup-storages', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    try { return { success: true, data: await runInCluster(row.id, () => backupStorages(pveFromEnv(), req.params.node)) } } catch (e) { return fail(reply, e) }
  })

  fastify.get<{ Params: { id: string; node: string; upid: string } }>('/:id/tasks/:node/:upid', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    try { return { success: true, data: await runInCluster(row.id, () => taskStatus(pveFromEnv(), req.params.node, req.params.upid)) } } catch (e) { return fail(reply, e) }
  })

  fastify.get<{ Params: { id: string } }>('/:id/tasks', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    try {
      const tasks = await runInCluster(row.id, () => pveFromEnv().fetchStrict<any[]>('/cluster/tasks'))
      return { success: true, data: (tasks ?? []).slice(0, 50).map(t => ({ upid: t.upid, node: t.node, type: t.type, id: t.id ?? null, user: t.user, starttime: t.starttime, endtime: t.endtime ?? null, status: t.status ?? null })) }
    } catch (e) { return fail(reply, e) }
  })

}
