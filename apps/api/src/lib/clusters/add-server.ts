// =============================================================================
//  HyperProx — adding a server, with the setup chores done in the same step
//
//  The owner gives a name, an address, the token made on that server, and the master password once (the route is
//  re-confirmed: lib/roles.ts). Everything else happens here, in that one request:
//
//    1. The API certificate. Over a Tailscale address (or a WireGuard peer on a link HyperProx set up) the tunnel
//       already proves which device answers, so the certificate it presents is accepted as verified once the
//       server's API says it is the node that device is named after. On any other address there is no second
//       channel to check it against: nothing is saved and the owner compares the fingerprint once, by hand.
//    2. The token: it must work over the pinned connection and have administrator rights (as before).
//    3. Node addresses: from the server's own cluster status, preferring each node's tailnet address.
//    4. With a node login given: every node's SSH host key is verified (lib/hostkey-verify.ts), and the login is
//       tested and saved only for nodes whose key is verified. A node without evidence keeps the manual compare.
//    5. Optional, on by default: monitoring installed (its usual preview, then apply), and Send files checked.
//
//  A tailnet name that is not the server's node name stops it: nothing is saved, the audit log records it, and an
//  alert goes out. Steps 4 and 5 never undo the add: they report what they did and what is left.
// =============================================================================

import type { TerminalCredential } from '../ssh-broker'
import type { PresentedCertificate } from './tls-pin'
import { ClusterRefusal, looksLikeHome, HOME_DUPLICATE, type ClusterIdentity, type ClusterInfo, type NewRemote } from './registry'
import { isTailnetAddress, tailnetPeer, refuseTokenContext, type TailnetStatus, type WgLink, type NodeVerdict, type VerifyInput } from '../hostkey-verify'

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
  by: string
}

export interface AddServerDeps {
  probeCertificate(address: string, port: number): Promise<PresentedCertificate>
  tryToken(address: string, port: number, fingerprint: string, tokenId: string, secret: string): Promise<TokenCheck>
  homeIdentity(): Promise<ClusterIdentity>
  tailnet(): Promise<TailnetStatus | null>
  wireguard(): Promise<WgLink[]>
  createRemote(n: NewRemote): Promise<ClusterInfo>
  setNodeAddresses(id: string, addresses: Record<string, string>): Promise<ClusterInfo>
  verifyNodes(clusterId: string, input: VerifyInput): Promise<NodeVerdict[]>
  /** A test command over a session that requires the verified pin. */
  testLogin(clusterId: string, host: string, cred: TerminalCredential): Promise<boolean>
  saveLogin(clusterId: string, node: string, cred: TerminalCredential): Promise<void>
  monitoring(clusterId: string, by: string): Promise<string>
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

/** Which tunnel vouches for the device at `address`, before anything is sent to it. Null: none does. */
export function linkDevice(address: string, status: TailnetStatus | null, links: WgLink[]): { hostname: string; how: string } | null {
  const wg = links.find(l => l.address === address && l.up)
  if (wg) return { hostname: wg.peer, how: `reached over HyperProx's own WireGuard link ${wg.iface}, where this address is the peer ${wg.peer}` }
  const t = tailnetPeer(address, status)
  if ('peer' in t) {
    const name = t.peer.hostName || t.peer.dnsName.replace(/\.$/, '').split('.')[0]
    return { hostname: name, how: `reached over your tailnet, where this address is the online device ${name}` }
  }
  return null
}

/**
 * Each node's address. The node that answered gets the address the owner typed. The other nodes' addresses in the
 * server's cluster status are its internal cluster-network addresses, which HyperProx may not be able to reach and
 * which can collide with addresses at home, so they are never filled in from there (lib/hostkey-verify.ts adds
 * tailnet ones it can vouch for; the rest the owner enters on the Edit page).
 */
export function nodeAddresses(identity: TokenCheck['identity'], nodes: string[], address: string, status: TailnetStatus | null): Record<string, string> {
  const out: Record<string, string> = {}
  const local = identity.local ?? (nodes.length === 1 ? nodes[0] : null)
  for (const n of nodes) {
    const peer = status?.running ? status.peers.find(p => !p.sharee && p.online && [p.hostName.toLowerCase(), p.dnsName.replace(/\.$/, '').split('.')[0].toLowerCase()].includes(n.toLowerCase())) : null
    const ts = peer?.ips.find(ip => isTailnetAddress(ip) && !ip.includes(':'))
    if (n === local) out[n] = address
    else if (ts) out[n] = ts
  }
  return out
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

  // 1. The certificate: verified over a private link, or compared by hand.
  const presented = await deps.probeCertificate(address, port)
  let fp: string, verified: string | null = null, device: { hostname: string; how: string } | null = null
  if (input.fingerprint) {
    if (presented.fingerprint !== input.fingerprint) throw Object.assign(new ClusterRefusal(`The server now presents a different certificate (${presented.fingerprint}) from the one you confirmed. Nothing was saved. Compare again.`, 'conflict'), { presented: presented.fingerprint })
    fp = presented.fingerprint
  } else {
    const [status, links] = await Promise.all([deps.tailnet().catch(() => null), deps.wireguard().catch(() => [] as WgLink[])])
    device = linkDevice(address, status, links)
    if (!device) return { kind: 'manual-certificate', certificate: presented, why: MANUAL_CERT_WHY }
    fp = presented.fingerprint
  }

  // 2. The token, over a connection pinned to that certificate.
  const t = await deps.tryToken(address, port, fp, input.tokenId, input.tokenSecret).catch((e: any) => {
    if (/HTTP 401/.test(String(e?.message))) throw new ClusterRefusal('The server refused that token. Check the token ID and secret and paste them again. Nothing was saved.')
    throw e
  })
  if (device) {
    const local = t.identity.local ?? (t.nodes.length === 1 ? t.nodes[0] : null)
    if (!local) return { kind: 'manual-certificate', certificate: presented, why: MANUAL_CERT_WHY }
    if (local.toLowerCase() !== device.hostname.toLowerCase()) {
      const why = `The device at ${address} is called ${device.hostname}, but the Proxmox server there says it is ${local}. Nothing was saved.`
      await deps.audit('cluster.add.blocked', `address:${address}`, { by: input.by, reason: 'link identity does not match the node name', device: device.hostname, node: local })
      await deps.alert('A server being added did not match its tailnet identity', [why])
      throw new IdentityMismatch(why)
    }
    verified = `${device.how}, and named ${local} by its own API`
  }
  const home = await deps.homeIdentity().catch(() => ({ addresses: [], fingerprint: null, clusterName: null, nodes: [] } as ClusterIdentity))
  if (looksLikeHome({ addresses: [address], fingerprint: fp, clusterName: t.identity.clusterName, nodes: t.identity.nodes }, home)) {
    throw new ClusterRefusal(`${HOME_DUPLICATE} Nothing was saved.`, 'conflict')
  }
  if (t.missing.length) throw new ClusterRefusal(`That token works but lacks administrator rights (${t.missing.join(', ')}). Run the step 2 commands as shown, including "--privsep 0", then try again. Nothing was saved.`)

  const c = await deps.createRemote({ name: input.name, address, port, note: input.note, fingerprint: fp, verified, tokenId: input.tokenId, tokenSecret: input.tokenSecret, by: input.by })
  await deps.audit('cluster.add', `cluster:${c.id}`, { by: input.by, name: c.name, nodes: t.nodes.length, version: t.version, certificate: verified ? 'verified automatically' : 'compared by the owner', how: verified ?? 'fingerprint compared by hand' })

  // 3. Where each node is.
  const status = await deps.tailnet().catch(() => null)
  const addrs = nodeAddresses(t.identity, t.nodes, address, status)
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
    : saved ? await deps.monitoring(c.id, input.by).catch((e: any) => `Monitoring was not installed: ${e?.message ?? e}`)
    : 'Monitoring needs a node login saved for at least one node; it is offered on the Edit page once one is.'
  const sending = input.sending === false ? null : await deps.sending(c.id).catch((e: any) => `Send files could not be checked: ${e?.message ?? e}`)

  return {
    kind: 'added', cluster, version: t.version, nodes: t.nodes,
    setup: { certificate: verified ? `Certificate verified automatically: ${verified}.` : 'Certificate confirmed by you.', nodes, monitoring, sending },
  }
}
