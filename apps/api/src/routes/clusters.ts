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

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { currentContext } from '../lib/auth'
import { auditCredentialUse } from '../lib/audit'
import {
  listClusters, clusterRow, createRemote, updateCluster, removeCluster, confirmFingerprint, replaceRemoteToken,
  hasRemoteToken, remoteTokenId, saveRemoteNodeLogin, removeRemoteNodeLogin, remoteNodeLogins, ClusterRefusal, validClusterId, validateToken,
} from '../lib/clusters/registry'
import { runInCluster } from '../lib/clusters/context'
import { probeCertificate, normaliseFingerprint, PinnedAgent, isServerAddress, CertificateChangedError } from '../lib/clusters/tls-pin'
import { ProxmoxClient } from '../lib/proxmox-client'
import { pveFromEnv, forgetRemoteClient, CertificateNotConfirmedError } from '../lib/pve-env'
import { commandCenter } from '../lib/clusters/overview'
import { scanCluster } from '../lib/clusters/scan'
import { checkGuest, power, snapshot, backupNow, backupStorages, taskStatus, destroy, GuestActionRefusal, type PowerAction } from '../lib/clusters/guest-actions'
import { probeHostKey, execOnNode } from '../lib/node-exec'
import { confirmPin, PinConfirmRefusal } from '../lib/hostkey-pins'
import { forgetRemoteGuestConfigService } from './guest-config'
import { browse, setupSending, previewCopy, startCopy, jobStore, CopyRunner, savePlex, type CopyInput } from '../lib/clusters/files'
import { updateCluster as updateClusterRow } from '../lib/clusters/registry'
import { scanMonitoring, previewMonitoring, applyMonitoring, MonitoringRefusal } from '../lib/clusters/monitoring'

const who = () => currentContext()?.email ?? 'unknown'

function fail(reply: FastifyReply, e: any) {
  const msg = e?.message ?? String(e)
  if (e?.name === 'VaultLockedError' || /HyperProx is locked/i.test(msg)) return reply.status(423).send({ success: false, locked: true, error: 'HyperProx is locked. Sign in to unlock it, then try again. Nothing was done.' })
  if (e instanceof ClusterRefusal) return reply.status(e.code === 'not-found' ? 404 : e.code === 'conflict' ? 409 : 422).send({ success: false, code: e.code, error: msg })
  if (e instanceof GuestActionRefusal) return reply.status(e.code === 'not-found' ? 404 : e.code === 'confirm' ? 428 : 422).send({ success: false, code: e.code, error: msg })
  if (e instanceof CertificateChangedError) return reply.status(409).send({ success: false, code: 'cert_changed', error: msg, presented: e.presented })
  if (e instanceof CertificateNotConfirmedError) return reply.status(409).send({ success: false, code: 'cert_unconfirmed', error: msg })
  if (e instanceof MonitoringRefusal) return reply.status(409).send({ success: false, code: 'monitoring', error: msg })
  if (e instanceof PinConfirmRefusal) return reply.status(409).send({ success: false, code: 'hostkey', error: msg })
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
  return { version: String(version?.version ?? ''), missing: perms ? missingAdminPrivs(perms) : ADMIN_PRIVS, nodes: (nodes ?? []).map(n => String(n.node)) }
}

export const clusterRoutes: FastifyPluginAsync = async (fastify) => {

  // ── Reads ─────────────────────────────────────────────────────────────────

  fastify.get('/', async () => ({
    success: true,
    data: listClusters().map(c => ({ ...c, token: c.kind === 'remote' ? { saved: hasRemoteToken(c.id), id: remoteTokenId(c.id) } : null })),
    commands: tokenCommands(),
  }))

  fastify.get('/overview', async (_req, reply) => {
    try { return { success: true, data: await commandCenter() } } catch (e) { return fail(reply, e) }
  })

  // ── Adding a server ───────────────────────────────────────────────────────

  // Step 4: what the server presents now, for the owner to compare. Nothing is sent to it.
  fastify.post<{ Body: { address?: string; port?: number } }>('/probe-certificate', async (req, reply) => {
    const address = String(req.body?.address ?? '').trim(), port = Number(req.body?.port ?? 8006)
    if (!isServerAddress(address)) return reply.status(422).send({ success: false, error: 'The address must be a name or an IP address only, with no https:// and no port.' })
    try { return { success: true, data: await probeCertificate(address, port) } } catch (e) { return fail(reply, e) }
  })

  // Steps 3 and 4 together: the confirmed fingerprint and the token. The certificate must still be the one the
  // owner confirmed, the token must work over that pinned connection and have administrator rights; only then is
  // anything stored (vault first, then the row).
  fastify.post<{ Body: { name?: string; address?: string; port?: number; note?: string; tokenId?: string; tokenSecret?: string; fingerprint?: string } }>('/', async (req, reply) => {
    const b = req.body ?? {}
    try {
      const address = String(b.address ?? '').trim(), port = Number(b.port ?? 8006)
      const fp = normaliseFingerprint(String(b.fingerprint ?? ''))
      if (!fp) throw new ClusterRefusal('Confirm the certificate fingerprint first (step 4).')
      if (!isServerAddress(address)) throw new ClusterRefusal('The address must be a name or an IP address only.')
      validateToken(String(b.tokenId ?? ''), String(b.tokenSecret ?? ''))
      const now = await probeCertificate(address, port)
      if (now.fingerprint !== fp) return reply.status(409).send({ success: false, code: 'cert_changed', error: `The server now presents a different certificate (${now.fingerprint}) from the one you confirmed. Nothing was saved. Compare again.`, presented: now.fingerprint })
      const t = await tryToken(address, port, fp, String(b.tokenId ?? ''), String(b.tokenSecret ?? '')).catch((e: any) => {
        if (/HTTP 401/.test(String(e?.message))) throw new ClusterRefusal('The server refused that token. Check the token ID and secret and paste them again. Nothing was saved.')
        throw e
      })
      if (t.missing.length) throw new ClusterRefusal(`That token works but lacks administrator rights (${t.missing.join(', ')}). Run the step 2 commands as shown, including "--privsep 0", then try again. Nothing was saved.`)
      const c = await createRemote({ name: String(b.name ?? ''), address, port, note: b.note, fingerprint: fp, tokenId: String(b.tokenId ?? ''), tokenSecret: String(b.tokenSecret ?? ''), by: who() })
      // A one-node server is reached on the address it was added with; a cluster's nodes are entered on Edit.
      const saved = t.nodes.length === 1 ? await updateCluster(c.id, { nodeAddresses: { [t.nodes[0]]: address } }) : c
      await auditCredentialUse('cluster.add', `cluster:${c.id}`, { by: who(), name: c.name, nodes: t.nodes.length, version: t.version })
      return { success: true, data: { cluster: saved, version: t.version, nodes: t.nodes } }
    } catch (e) { return fail(reply, e) }
  })

  // ── One cluster ───────────────────────────────────────────────────────────

  fastify.post<{ Params: { id: string } }>('/:id/test', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    try {
      return await runInCluster(row.id, async () => {
        const pve = pveFromEnv()
        const t0 = Date.now()
        const version = await pve.fetchStrict<any>('/version', 'GET', undefined, 10_000)
        const latencyMs = Date.now() - t0
        const nodes = await pve.fetchStrict<any[]>('/nodes').catch(() => [])
        return { success: true, data: { latencyMs, version: version?.version ?? null, nodes: (nodes ?? []).map(n => ({ node: n.node, status: n.status })) } }
      })
    } catch (e) { return fail(reply, e) }
  })

  fastify.patch<{ Params: { id: string }; Body: Record<string, any> }>('/:id', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    try {
      const b: Record<string, any> = req.body ?? {}
      const c = await updateCluster(row.id, { name: b.name, note: b.note, address: b.address, port: b.port, allowedRoots: b.allowedRoots, nodeAddresses: b.nodeAddresses, plexUrl: b.plexUrl })
      forgetRemoteClient(row.id)
      await auditCredentialUse('cluster.edit', `cluster:${row.id}`, { by: who(), fields: Object.keys(b).filter(k => b[k] !== undefined) })
      return { success: true, data: c, certNeedsConfirming: c.kind === 'remote' && !c.cert.fingerprint }
    } catch (e) { return fail(reply, e) }
  })

  // Re-confirm a renewed certificate. The fingerprint must be the one presented right now.
  fastify.post<{ Params: { id: string }; Body: { fingerprint?: string } }>('/:id/certificate', async (req, reply) => {
    const row = clusterOr404(req.params.id, reply); if (!row) return
    if (row.kind !== 'remote') return reply.status(422).send({ success: false, error: 'The home cluster has no certificate to confirm here.' })
    try {
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
      await removeCluster(row.id)
      forgetRemoteClient(row.id)
      forgetRemoteGuestConfigService(row.id)
      await auditCredentialUse('cluster.remove', `cluster:${row.id}`, { by: who(), name: row.name })
      const [user, token] = (tokenId ?? 'hyperprox@pve!main').split('!')
      return { success: true, data: { removed: true, cleanup: [`pveum user token remove ${user} ${token}`, `pveum user delete ${user}`] } }
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

  // The host key a node presents, for the owner to compare with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` there.
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
      // The owner checked this fingerprint on the machine; it must be what the node presents now.
      await confirmPin(addr, 22, String(b.fingerprint ?? ''), (h, p) => probeHostKey(h, p))
      const cred = { username, port: 22, ...(b.privateKey ? { privateKey: String(b.privateKey), ...(b.passphrase ? { passphrase: String(b.passphrase) } : {}) } : { password: String(b.password) }) }
      const r = await execOnNode({ host: addr, cred, command: 'true', requirePin: true, timeoutMs: 20_000 })
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
      const r = await applyMonitoring(String(req.body?.planId ?? ''), who())
      await auditCredentialUse('cluster.monitoring.apply', `cluster:${row.id}`, { by: who(), ok: r.ok, nodes: r.results.map(x => x.node) })
      return { success: true, data: r }
    } catch (e) { return fail(reply, e) }
  })

  // ── Files (Send files) ───────────────────────────────────────────────────

  const copies = new CopyRunner(undefined, undefined, m => fastify.log.warn(m))
  copies.start()
  fastify.addHook('onClose', async () => copies.stop())

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
      await updateClusterRow(row.id, { plexUrl: req.body?.url ? String(req.body.url) : null })
      if (req.body?.token) await savePlex(row.id, String(req.body.token))
      await auditCredentialUse('cluster.plex.save', `cluster:${row.id}`, { by: who() })
      return { success: true }
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
  fastify.post<G & { Body: { confirmName?: string } }>('/:id/guests/:node/:type/:vmid/delete', guestRoute((g, b) => destroy({ pve: pveFromEnv() }, g, String(b.confirmName ?? '')), 'delete'))

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
