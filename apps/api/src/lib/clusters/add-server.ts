// =============================================================================
//  HyperProx — adding a server, with the setup chores done in the same step
//
//  The owner gives a name, an address, the token made on that server, and the master password once (the route is
//  re-confirmed: lib/roles.ts). Everything else happens here, in that one request:
//
//    1. The API certificate. When the address the owner typed is a Tailscale IP that tailscaled says is an online
//       device owned by this tailnet's own account, and this machine routes it into the tunnel, the tunnel to
//       exactly that IP proves which device answers, so the certificate it presents is accepted as verified. On any
//       other address there is no second channel to check it against: nothing is saved and the owner compares the
//       fingerprint once, by hand.
//    2. The token: it must work over the pinned connection and have administrator rights (as before).
//    3. Node addresses: the typed address for the node that answered; another node's only when its cluster status
//       address is a tailnet IP owned by this tailnet's account. Never by name, never a cluster-network address.
//    4. With a node login given: every node's SSH host key is verified (lib/hostkey-verify.ts), and the login is
//       tested and saved only for nodes whose key is verified. A node without evidence keeps the manual compare.
//    5. Optional, on by default: monitoring installed (its usual preview, then apply), and Send files checked.
//
//  A tailnet name that is not the server's node name stops it: nothing is saved, the audit log records it, and an
//  alert goes out. Steps 4 and 5 never undo the add: they report what they did and what is left.
// =============================================================================

import { createHash } from 'node:crypto'
import net from 'node:net'
import type { TerminalCredential } from '../ssh-broker'
import { installScript } from './monitoring'
import type { PresentedCertificate } from './tls-pin'
import { ClusterRefusal, looksLikeHome, HOME_DUPLICATE, type ClusterIdentity, type ClusterInfo, type NewRemote } from './registry'
import { isTailnetAddress, tailnetIdentity, refuseTokenContext, TAILSCALE_DEV, type TailnetStatus, type TailnetWhois, type NodeVerdict, type VerifyInput } from '../hostkey-verify'

export interface TokenCheck {
  version: string
  missing: string[]
  nodes: string[]
  identity: { clusterName: string | null; nodes: { name: string; ip: string | null }[]; local: string | null }
}

export interface AddServerInput {
  name: string; address: string; port: number; note?: string
  tokenId: string; tokenSecret: string
  /** Only when HyperProx could not verify the certificate and the owner compared it by hand. */
  fingerprint?: string | null
  login?: { username: string; password?: string; privateKey?: string; passphrase?: string } | null
  monitoring?: boolean
  sending?: boolean
  /** The hash of the preview the owner saw (lib/clusters/add-server.ts inspectAddress): what is done must match it. */
  previewHash?: string | null
  by: string
}

export interface AddServerDeps {
  probeCertificate(address: string, port: number): Promise<PresentedCertificate>
  tryToken(address: string, port: number, fingerprint: string, tokenId: string, secret: string): Promise<TokenCheck>
  homeIdentity(): Promise<ClusterIdentity>
  tailnet(): Promise<TailnetStatus | null>
  whois(ip: string): Promise<TailnetWhois | null>
  route(ip: string): Promise<string | null>
  createRemote(n: NewRemote): Promise<ClusterInfo>
  /** The remote already saved at this address and port, if any (a retry of an add that stopped part way). */
  findRemote(address: string, port: number): ClusterInfo | null
  replaceToken(id: string, tokenId: string, secret: string): Promise<void>
  setNodeAddresses(id: string, addresses: Record<string, string>): Promise<ClusterInfo>
  verifyNodes(clusterId: string, input: VerifyInput): Promise<NodeVerdict[]>
  /** A test command over a session that requires the verified pin. */
  testLogin(clusterId: string, host: string, cred: TerminalCredential): Promise<boolean>
  saveLogin(clusterId: string, node: string, cred: TerminalCredential): Promise<void>
  /** Install monitoring, only the steps whose script hashes to `scriptHash` (what the owner was shown). */
  monitoring(clusterId: string, by: string, scriptHash: string): Promise<string>
  sending(clusterId: string): Promise<string>
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
  alert(title: string, lines: string[]): Promise<void>
}

export class IdentityMismatch extends Error { readonly code = 'identity_mismatch' }

export interface NodeSetup { node: string; address: string; key: NodeVerdict['state'] | 'skipped'; how: string; login: 'saved' | 'not-saved' | 'none-given' }

export type AddServerResult =
  | { kind: 'manual-certificate'; certificate: PresentedCertificate; why: string }
  | {
      kind: 'added'; cluster: ClusterInfo; version: string; nodes: string[]
      setup: { certificate: string; nodes: NodeSetup[]; monitoring: string | null; sending: string | null }
    }

/** One plain sentence for the fallback, shown above the fingerprint. */
export const MANUAL_CERT_WHY = "HyperProx could not check this server's certificate on its own, because this address is not a Tailscale or WireGuard address it can vouch for; compare the fingerprint below with the one on that server's own Proxmox page (the node, then System, then Certificates) once, and HyperProx will refuse it if it ever changes."

/**
 * Which tunnel vouches for the device at exactly `address` (the address the owner typed, never one looked up by a
 * name), before anything is sent to it. Null: none does.
 */
export function linkDevice(address: string, status: TailnetStatus | null, whois: TailnetWhois | null, routes: Array<string | null> = []): { device: string; owner: string | null; how: string } | null {
  // Only Tailscale: WireGuard evidence is for home nodes (lib/hostkey-verify.ts wireguardIdentity), never a remote.
  const t = tailnetIdentity(address, status, whois, routes)
  if (t.ok) return { device: t.device, owner: t.owner, how: `reached over your tailnet at this exact address, the device ${t.device} owned by ${t.owner}` }
  return null
}

/**
 * Each node's address. The node that answered gets the address the owner typed. Another node gets the address the
 * server's own cluster status reports only when that is a tailnet IP HyperProx can vouch for (whois: owned by this
 * tailnet's own account); its cluster-network addresses are never filled in. The owner enters the rest on Edit.
 */
export async function nodeAddresses(identity: TokenCheck['identity'], nodes: string[], address: string, status: TailnetStatus | null, whois: (ip: string) => Promise<TailnetWhois | null>, route: (ip: string) => Promise<string | null> = async () => null): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const local = identity.local ?? (nodes.length === 1 ? nodes[0] : null)
  for (const n of nodes) {
    if (n === local) { out[n] = address; continue }
    const ip = identity.nodes.find(x => x.name === n)?.ip ?? null
    if (ip && isTailnetAddress(ip) && tailnetIdentity(ip, status, await whois(ip).catch(() => null), [await route(ip).catch(() => null)]).ok) out[n] = ip
  }
  return out
}

/** The names a certificate is for: its common name and DNS alt names, first label, lower case. IPs are left out. */
export function certNames(c: PresentedCertificate): string[] {
  const cn = /(?:^|,\s*)CN=([^,]+)/.exec(c.subject)?.[1] ?? ''
  return [...new Set([cn, ...c.altNames].map(x => x.trim()).filter(x => x && !net.isIP(x)).map(x => x.toLowerCase().split('.')[0]))]
}

/**
 * What monitoring on a new server would do, shown before the master password and bound by the script's hash: only
 * node_exporter, with no GPU extras, on each node whose key HyperProx verifies.
 */
export function monitoringPreview(): { steps: string[]; hash: string } {
  return {
    steps: ["On each of that server's nodes whose key HyperProx verifies: install prometheus-node-exporter from that server's own packages " +
      '(nothing is upgraded or removed), listening on port 9100 of the Tailscale or WireGuard address HyperProx reaches it on, and only there. ' +
      "Then HyperProx's Prometheus collects from it."],
    hash: scriptHash(installScript({ amdGpu: false, intelGpu: false })),
  }
}
export const scriptHash = (script: string) => createHash('sha256').update(script).digest('hex')

export interface AddressInspection {
  certificate: PresentedCertificate
  /** The private link that vouches for exactly this address, and what its certificate says, or null. */
  link: { device: string; owner: string | null; how: string } | null
  /** Why HyperProx cannot verify the certificate by itself (one plain sentence), or null when it can. */
  why: string | null
  monitoring: { steps: string[]; hash: string }
  /** Binds what is done to what was shown: certificate, device, owner and monitoring. */
  hash: string
}

/**
 * Read-only look at an address, before any token or password is involved: the certificate it presents, and whether
 * the private link vouches for exactly that address AND the certificate is for the device the link names. This is
 * what the add dialog shows ("Connecting to <device> owned by <owner>") above the one password.
 */
export async function inspectAddress(address: string, port: number, deps: Pick<AddServerDeps, 'probeCertificate' | 'tailnet' | 'whois' | 'route'>): Promise<AddressInspection> {
  // The route is read before and after the certificate is: both times it must go into the tunnel.
  const before = isTailnetAddress(address) ? await deps.route(address).catch(() => null) : null
  const certificate = await deps.probeCertificate(address, port)
  const after = isTailnetAddress(address) ? await deps.route(address).catch(() => null) : null
  const [status, who] = await Promise.all([deps.tailnet().catch(() => null), deps.whois(address).catch(() => null)])
  let link = linkDevice(address, status, who, [before, after])
  let why: string | null = link ? null : MANUAL_CERT_WHY
  if (link && !certNames(certificate).includes(link.device.toLowerCase())) {
    why = `The certificate at that address is for ${certNames(certificate).join(', ') || 'no name'}, not for the device ${link.device} your tailnet has there, so HyperProx cannot vouch for it by itself; compare the fingerprint below with the one on that server's own Proxmox page (the node, then System, then Certificates) once.`
    link = null
  }
  const monitoring = monitoringPreview()
  const hash = createHash('sha256').update(JSON.stringify([certificate.fingerprint, link?.device ?? null, link?.owner ?? null, monitoring.hash])).digest('hex')
  return { certificate, link, why, monitoring, hash }
}

function credOf(l: AddServerInput['login']): TerminalCredential | null {
  if (!l) return null
  const username = String(l.username ?? 'root').trim()
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) throw new ClusterRefusal('That is not a user name.')
  if (l.privateKey) return { username, port: 22, privateKey: String(l.privateKey), ...(l.passphrase ? { passphrase: String(l.passphrase) } : {}) } as TerminalCredential
  if (l.password) return { username, port: 22, password: String(l.password) } as TerminalCredential
  return null
}

export async function addServer(input: AddServerInput, deps: AddServerDeps): Promise<AddServerResult> {
  refuseTokenContext()
  const { address, port } = input
  const cred = credOf(input.login)

  // 1. The certificate, checked BEFORE the token goes anywhere: the private link must vouch for exactly this address
  //    and the certificate must be for the device it names; otherwise the owner compares it by hand. What is found
  //    must be what the owner was shown (the preview's hash).
  const seen = await inspectAddress(address, port, deps)
  const presented = seen.certificate
  if (input.previewHash && input.previewHash !== seen.hash) throw new ClusterRefusal('What HyperProx finds at that address changed since you looked (its certificate, its tailnet device, or what monitoring would install). Nothing was saved. Look again.', 'conflict')
  let fp: string, verified: string | null = null
  const device = input.fingerprint ? null : seen.link
  if (input.fingerprint) {
    if (presented.fingerprint !== input.fingerprint) throw Object.assign(new ClusterRefusal(`The server now presents a different certificate (${presented.fingerprint}) from the one you confirmed. Nothing was saved. Compare again.`, 'conflict'), { presented: presented.fingerprint })
    fp = presented.fingerprint
  } else {
    if (!device) return { kind: 'manual-certificate', certificate: presented, why: seen.why ?? MANUAL_CERT_WHY }
    fp = presented.fingerprint
  }

  // 2. The token, over a connection pinned to that certificate (and, over a tailnet, still routed into the tunnel).
  if (device && !TAILSCALE_DEV.test(String(await deps.route(address).catch(() => null))))
    throw new ClusterRefusal('The route to that address no longer goes through Tailscale on this machine, so nothing was sent to it. Try again.', 'conflict')
  const t = await deps.tryToken(address, port, fp, input.tokenId, input.tokenSecret).catch((e: any) => {
    if (/HTTP 401/.test(String(e?.message))) throw new ClusterRefusal('The server refused that token. Check the token ID and secret and paste them again. Nothing was saved.')
    throw e
  })
  if (device) {
    // The server's own API must name itself as a node the certificate is for.
    const local = t.identity.local ?? (t.nodes.length === 1 ? t.nodes[0] : null)
    if (!local || !certNames(presented).includes(local.toLowerCase())) {
      const why = `The server at ${address} says it is ${local ?? 'an unnamed node'}, but its certificate is for ${certNames(presented).join(', ') || 'no name'}. Nothing was saved.`
      await deps.audit('cluster.add.blocked', `address:${address}`, { by: input.by, reason: 'the API node name is not in the certificate', device: device.device, node: local ?? '' })
      await deps.alert('A server being added did not match its own certificate', [why])
      throw new IdentityMismatch(why)
    }
    verified = `${device.how}; its certificate is for ${device.device}, which its own API confirms`
  }
  const home = await deps.homeIdentity().catch(() => ({ addresses: [], fingerprint: null, clusterName: null, nodes: [] } as ClusterIdentity))
  if (looksLikeHome({ addresses: [address], fingerprint: fp, clusterName: t.identity.clusterName, nodes: t.identity.nodes }, home)) {
    throw new ClusterRefusal(`${HOME_DUPLICATE} Nothing was saved.`, 'conflict')
  }
  if (t.missing.length) throw new ClusterRefusal(`That token works but lacks administrator rights (${t.missing.join(', ')}). Run the step 2 commands as shown, including "--privsep 0", then try again. Nothing was saved.`)

  // A retry of an add that stopped part way: the same name at the same address and certificate is picked up where it
  // stopped (its token replaced with this one), instead of being refused as a duplicate.
  const prior = deps.findRemote(address, port)
  const resume = !!prior && prior.name.trim().toLowerCase() === input.name.trim().toLowerCase() && prior.cert.fingerprint === fp
  if (resume) await deps.replaceToken(prior!.id, input.tokenId, input.tokenSecret)
  const c = resume ? prior! : await deps.createRemote({ name: input.name, address, port, note: input.note, fingerprint: fp, verified, tokenId: input.tokenId, tokenSecret: input.tokenSecret, by: input.by })
  if (resume) await deps.audit('cluster.add.resume', `cluster:${c.id}`, { by: input.by, name: c.name })
  else await deps.audit('cluster.add', `cluster:${c.id}`, { by: input.by, name: c.name, nodes: t.nodes.length, version: t.version, certificate: verified ? 'verified automatically' : 'compared by the owner', how: verified ?? 'fingerprint compared by hand' })

  // 3. Where each node is.
  const status = await deps.tailnet().catch(() => null)
  const addrs = await nodeAddresses(t.identity, t.nodes, address, status, ip => deps.whois(ip), ip => deps.route(ip))
  const cluster = Object.keys(addrs).length ? await deps.setNodeAddresses(c.id, addrs) : c

  // 4. Host keys, then the login, only where the key is verified.
  const nodes: NodeSetup[] = []
  let saved = 0
  if (cred) {
    const verdicts = await deps.verifyNodes(c.id, { cluster: c.name, anchorScope: c.id, scope: 'remote', by: input.by, nodes: Object.entries(addrs).map(([name, a]) => ({ name, address: a, cred })) })
    for (const n of t.nodes) {
      const v = verdicts.find(x => x.node === n)
      if (!v || !addrs[n]) { nodes.push({ node: n, address: addrs[n] ?? '', key: 'skipped', how: 'no address found for it; add one under Edit server', login: 'not-saved' }); continue }
      if (v.state !== 'verified' && v.state !== 'already') { nodes.push({ node: n, address: v.host, key: v.state, how: v.why, login: 'not-saved' }); continue }
      const ok = await deps.testLogin(c.id, v.host, cred).catch(() => false)
      if (ok) {
        await deps.saveLogin(c.id, n, cred)
        await deps.audit('cluster.node_login.save', `cluster:${c.id}`, { by: input.by, node: n, source: 'add server' })
        saved++
      }
      nodes.push({ node: n, address: v.host, key: v.state, how: v.why, login: ok ? 'saved' : 'not-saved' })
    }
  } else {
    for (const n of t.nodes) nodes.push({ node: n, address: addrs[n] ?? '', key: 'skipped', how: 'no node login was given, so keys were not checked yet', login: 'none-given' })
  }

  // 5. Optional chores. A failure here is reported, never fatal: the server is added.
  const monitoring = input.monitoring === false ? null
    : !input.previewHash ? 'Monitoring was not installed: it is installed here only after its preview is shown. The Edit page offers it.'
    : saved ? await deps.monitoring(c.id, input.by, seen.monitoring.hash).catch((e: any) => `Monitoring was not installed: ${e?.message ?? e}`)
    : 'Monitoring needs a node login saved for at least one node; it is offered on the Edit page once one is.'
  const sending = input.sending === false ? null : await deps.sending(c.id).catch((e: any) => `Send files could not be checked: ${e?.message ?? e}`)

  return {
    kind: 'added', cluster, version: t.version, nodes: t.nodes,
    setup: { certificate: verified ? `Certificate verified automatically: ${verified}.` : 'Certificate confirmed by you.', nodes, monitoring, sending },
  }
}

// ---------------------------------------------------------------------------
//  The add as a background job: the request returns at once, the page polls
// ---------------------------------------------------------------------------

export interface AddJob {
  id: string
  status: 'running' | 'done' | 'failed'
  startedAt: string
  finishedAt?: string
  /** What the request would have answered: an HTTP status and its body. */
  answer?: { status: number; body: Record<string, unknown> }
}
interface HeldJob extends AddJob { owner: string; key: string }

const addJobs = new Map<string, HeldJob>()
const JOB_MS = 30 * 60_000

/**
 * Start (or rejoin) an add. The same owner asking again for the same server while it runs gets the same job, so a
 * double click or a reload never adds twice; once it has finished, asking again runs it again (a retry resumes).
 * `answer` turns the outcome into what the page shows.
 */
export function startAddJob(owner: string, input: AddServerInput, run: () => Promise<AddServerResult>, answer: (r: AddServerResult | null, e: unknown) => { status: number; body: Record<string, unknown> }): AddJob {
  for (const [id, j] of addJobs) if (Date.now() - Date.parse(j.startedAt) > JOB_MS) addJobs.delete(id)
  const key = createHash('sha256').update(JSON.stringify([input.name.trim().toLowerCase(), input.address.toLowerCase(), input.port, input.tokenId])).digest('hex')
  const same = [...addJobs.values()].find(j => j.owner === owner && j.key === key && j.status === 'running')
  if (same) return view(same)
  const job: HeldJob = { id: createHash('sha256').update(`${key}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 24), status: 'running', startedAt: new Date().toISOString(), owner, key }
  addJobs.set(job.id, job)
  void run().then(r => { job.answer = answer(r, null); job.status = job.answer.status < 300 ? 'done' : 'failed' },
    e => { job.answer = answer(null, e); job.status = 'failed' })
    .finally(() => { job.finishedAt = new Date().toISOString() })
  return view(job)
}

/** A job, only for the owner who started it. */
export function addJob(owner: string, id: string): AddJob | null {
  const j = addJobs.get(id)
  return j && j.owner === owner ? view(j) : null
}
const view = (j: HeldJob): AddJob => ({ id: j.id, status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt, answer: j.answer })
export function forgetAddJobs(): void { addJobs.clear() }
