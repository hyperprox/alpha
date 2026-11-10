// =============================================================================
//  HyperProx — the cluster registry
//
//  The home cluster is the Proxmox HyperProx was installed against, connected exactly as before (Settings ->
//  Proxmox, PROXMOX_* while unlocked). It always exists and needs no row; a row with id "home" only carries its
//  settings (display name, file roots). Every other cluster is a remote: a row here for the address and the
//  confirmed certificate fingerprint, and vault items for everything secret:
//
//    hyperprox:proxmox/<id>      token_id (user@realm!name), token_secret: the admin token made on that server
//    hyperprox:cluster-ssh/<id>  node-<node>: a saved node login (JSON), used for scans, monitoring and copies
//
//  Nothing secret is in the row, the database, a file, a log, an audit entry or an API answer.
// =============================================================================

import { randomBytes } from 'node:crypto'
import { itemName, setCredentials, deleteProviderCredentials, getCredential, setCredential, deleteCredential, listCredentialKeys, VaultLockedError } from '../credentials'
import { cachedSecret, isUnlocked } from '../vault/state'
import { MemoryClusterStore, type ClusterRow, type ClusterStore } from './store'
import { normaliseFingerprint, isServerAddress, allowedApiPort } from './tls-pin'

export const HOME_ID = 'home'
export const TOKEN_CATEGORY = 'proxmox'
export const SSH_CATEGORY = 'cluster-ssh'
const ID_RE = /^c[0-9a-f]{10}$/

export function validClusterId(id: string): boolean { return id === HOME_ID || ID_RE.test(id) }

export interface ClusterInfo {
  id: string
  name: string
  kind: 'home' | 'remote'
  address: string
  port: number
  note: string
  cert: { fingerprint: string | null; confirmedAt: string | null; confirmedBy: string | null }
  nodeAddresses: Record<string, string>
  allowedRoots: string[]
  monitoring: ClusterRow['monitoring']
  plexUrl: string | null
  ignoredGuests: string[]
}

let store: ClusterStore = new MemoryClusterStore()
const rows = new Map<string, ClusterRow>()
let loaded = false

export function setClusterStore(s: ClusterStore): void { store = s; rows.clear(); loaded = false }

/** Read every row into memory. Called at start-up; requests are answered from memory after that. */
export async function loadClusters(): Promise<void> {
  const list = await store.list()
  rows.clear()
  for (const r of list) if (validClusterId(r.id)) rows.set(r.id, r)
  loaded = true
}
export function clustersLoaded(): boolean { return loaded }

const homeDefaults = (): ClusterRow => ({
  id: HOME_ID, name: 'Home cluster', kind: 'home', address: '', port: 8006, note: '',
  certFingerprint: null, certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: {}, allowedRoots: [], monitoring: {},
  plexUrl: null, createdBy: 'system', createdAt: new Date(0), updatedAt: new Date(0),
})

function view(r: ClusterRow): ClusterInfo {
  return {
    id: r.id, name: r.name, kind: r.kind, address: r.kind === 'home' ? '' : r.address, port: r.port, note: r.note,
    cert: { fingerprint: r.certFingerprint, confirmedAt: r.certConfirmedAt ? r.certConfirmedAt.toISOString() : null, confirmedBy: r.certConfirmedBy },
    nodeAddresses: { ...r.nodeAddresses }, allowedRoots: [...r.allowedRoots], monitoring: structuredClone(r.monitoring), plexUrl: r.plexUrl,
    ignoredGuests: [...(r.ignoredGuests ?? [])],
  }
}

export function homeRow(): ClusterRow { return rows.get(HOME_ID) ?? homeDefaults() }

/** The row for an id (home included), or null. */
export function clusterRow(id: string): ClusterRow | null {
  if (id === HOME_ID) return homeRow()
  return rows.get(id) ?? null
}

export function getCluster(id: string): ClusterInfo | null {
  const r = clusterRow(id)
  return r ? view(r) : null
}

/** Home first, then remotes in the order they were added. */
export function listClusters(): ClusterInfo[] {
  const remotes = [...rows.values()].filter(r => r.kind === 'remote').sort((a, b) => +a.createdAt - +b.createdAt)
  return [view(homeRow()), ...remotes.map(view)]
}

export function remoteCount(): number { return [...rows.values()].filter(r => r.kind === 'remote').length }

export class ClusterRefusal extends Error {
  constructor(message: string, readonly code: 'invalid' | 'not-found' | 'conflict' | 'confirm' | 'locked' = 'invalid') { super(message) }
}

function cleanName(n: unknown): string {
  const s = String(n ?? '').replace(/[\u0000-\u001f]/g, '').trim()
  if (!s || s.length > 60) throw new ClusterRefusal('Give it a name of 1 to 60 characters.')
  return s
}
// Words the assistant reads as something other than a cluster's name (lib/ai/clusters.ts RESERVED_NAMES).
const RESERVED = ['home', 'remote', 'all', 'each', 'every', 'both']

/**
 * A new or changed name must not be one of those words, nor the name of another cluster (case ignored): the
 * assistant finds clusters by name. A name saved before this rule stays as it is until it is changed.
 */
function checkNewName(name: string, selfId: string | null): void {
  const low = name.toLowerCase()
  if (RESERVED.includes(low)) throw new ClusterRefusal(`"${name}" cannot be a server's name: the assistant reads it as a word of its own. Pick another name.`)
  const others = [homeRow(), ...rows.values()].filter(r => r.id !== selfId)
  if (others.some(r => r.name.trim().toLowerCase() === low)) throw new ClusterRefusal(`Another server is already called ${name}. Pick a different name.`, 'conflict')
}

function cleanPort(p: unknown): number {
  const n = p === undefined || p === '' || p === null ? 8006 : Number(p)
  if (!allowedApiPort(n)) throw new ClusterRefusal('The port must be 8006 (Proxmox\'s own), 443, 8443, or a number from 1024 to 65535.')
  return n
}
function cleanAddress(a: unknown): string {
  const s = String(a ?? '').trim()
  if (!isServerAddress(s)) throw new ClusterRefusal('The address must be a name or an IP address only, with no https:// and no port (the port has its own box).')
  return s
}

/** Absolute, normalised, no "..", no control characters. A root is a folder copies may write into. */
export function cleanRoot(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (!s.startsWith('/') || s.length > 400 || /[\u0000-\u001f]/.test(s)) throw new ClusterRefusal(`"${s}" is not an absolute folder path.`)
  const parts = s.split('/').filter(Boolean)
  if (parts.some(p => p === '..' || p === '.')) throw new ClusterRefusal(`"${s}" may not contain . or .. parts.`)
  if (!parts.length) throw new ClusterRefusal('The whole disk (/) cannot be a file root. Pick the media folder itself.')
  const p = '/' + parts.join('/')
  // A system folder, or anything inside one, is never a place copies may write.
  if (/^\/(etc|proc|sys|dev|boot|root|run|usr|bin|sbin|lib|lib32|lib64|libx32|tmp|lost\+found|snap)(\/|$)/.test(p) ||
      /^\/var(\/|$)/.test(p))
    throw new ClusterRefusal(`${p} is a system folder, or inside one; it cannot be a file root.`)
  return p
}

function newId(): string { return 'c' + randomBytes(5).toString('hex') }

export interface NewRemote {
  name: string; address: string; port?: number; note?: string
  /** The fingerprint the owner compared and confirmed. */
  fingerprint: string
  tokenId: string; tokenSecret: string
  by: string
}

const TOKEN_ID_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+![A-Za-z][A-Za-z0-9._-]*$/
const SECRET_RE = /^[0-9a-fA-F-]{20,80}$/

export function validateToken(tokenId: string, tokenSecret: string): void {
  if (!TOKEN_ID_RE.test(String(tokenId ?? '').trim())) throw new ClusterRefusal('The token ID looks like user@realm!name, for example hyperprox@pve!main.')
  if (!SECRET_RE.test(String(tokenSecret ?? '').trim())) throw new ClusterRefusal('The token secret is the long code Proxmox showed once, like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.')
}

export const HOME_DUPLICATE = 'This is your home cluster; it is already managed as Home.'

/** How a cluster identifies itself: its address, certificate, cluster name and nodes (from /cluster/status). */
export interface ClusterIdentity {
  addresses:   string[]
  fingerprint: string | null
  clusterName: string | null
  nodes:       { name: string; ip?: string | null }[]
}

/** Every address the home cluster is reached on that HyperProx knows without asking it. */
export function homeAddresses(): string[] {
  const out = [process.env.PROXMOX_HOST ?? '', ...Object.values(homeRow().nodeAddresses)]
  return [...new Set(out.map(a => a.trim().toLowerCase()).filter(Boolean))]
}

/**
 * Whether a server being added is in fact the home cluster (or one of its nodes): the same address, the same
 * certificate, the same cluster name, the same set of node names on a cluster, or a lone node with the home node's
 * name AND address. Managing home twice would let a remote's rules (or none) reach the home nodes.
 */
export function looksLikeHome(remote: ClusterIdentity, home: ClusterIdentity): boolean {
  const low = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase()
  const homeAddrs = new Set([...home.addresses, ...home.nodes.map(n => n.ip ?? '')].map(low).filter(Boolean))
  if (remote.addresses.some(a => homeAddrs.has(low(a)))) return true
  if (remote.fingerprint && home.fingerprint && remote.fingerprint === home.fingerprint) return true
  if (low(remote.clusterName) && low(remote.clusterName) === low(home.clusterName)) return true
  const names = (c: ClusterIdentity) => c.nodes.map(n => low(n.name)).filter(Boolean).sort().join(',')
  if (remote.nodes.length > 1 && names(remote) === names(home)) return true
  if (remote.nodes.length === 1 && home.nodes.length === 1 && names(remote) === names(home)) {
    const ip = low(remote.nodes[0].ip)
    if (ip && ip === low(home.nodes[0].ip)) return true
  }
  return false
}

/** Store the token in the vault first, then the row; a vault failure leaves nothing behind. */
export async function createRemote(n: NewRemote): Promise<ClusterInfo> {
  const fingerprint = normaliseFingerprint(n.fingerprint)
  if (!fingerprint) throw new ClusterRefusal('That is not a SHA-256 certificate fingerprint.')
  validateToken(n.tokenId, n.tokenSecret)
  const name = cleanName(n.name), address = cleanAddress(n.address), port = cleanPort(n.port)
  checkNewName(name, null)
  if (homeAddresses().includes(address.toLowerCase())) throw new ClusterRefusal(HOME_DUPLICATE, 'conflict')
  if ([...rows.values()].some(r => r.kind === 'remote' && r.address.toLowerCase() === address.toLowerCase() && r.port === port))
    throw new ClusterRefusal(`${address}:${port} is already added.`, 'conflict')
  let id = newId()
  while (rows.has(id)) id = newId()
  await setCredentials(TOKEN_CATEGORY, id, { token_id: n.tokenId.trim(), token_secret: n.tokenSecret.trim() })
  try {
    const row = await store.upsert({
      id, name, kind: 'remote', address, port, note: String(n.note ?? '').slice(0, 500),
      certFingerprint: fingerprint, certConfirmedAt: new Date(), certConfirmedBy: n.by,
      nodeAddresses: {}, allowedRoots: [], monitoring: {}, plexUrl: null, createdBy: n.by,
    })
    rows.set(id, row)
    return view(row)
  } catch (e) {
    await deleteProviderCredentials(TOKEN_CATEGORY, id).catch(() => undefined)
    throw e
  }
}

/**
 * A check other features add on a rename (the Updates policy: a rename must not quietly attach a section written
 * for another server). Returns the refusal in words, or null.
 */
let renameGuard: ((c: { id: string; name: string; kind: 'home' | 'remote' }, newName: string) => string | null) | null = null
export function setRenameGuard(fn: typeof renameGuard): void { renameGuard = fn }

export interface ClusterPatch {
  name?: string; note?: string; address?: string; port?: number
  allowedRoots?: string[]; nodeAddresses?: Record<string, string>; plexUrl?: string | null; ignoredGuests?: string[]
}

/**
 * Change a cluster's settings. A new address or port clears the confirmed fingerprint: the owner confirms the
 * certificate at the new place before anything is sent there.
 */
export async function updateCluster(id: string, patch: ClusterPatch): Promise<ClusterInfo> {
  const prev = clusterRow(id)
  if (!prev) throw new ClusterRefusal('No such cluster.', 'not-found')
  const next: ClusterRow = structuredClone(prev)
  if (patch.name !== undefined) {
    next.name = cleanName(patch.name)
    if (next.name !== prev.name) {
      checkNewName(next.name, prev.id)
      const no = renameGuard?.({ id: prev.id, name: prev.name, kind: prev.kind }, next.name)
      if (no) throw new ClusterRefusal(no, 'conflict')
    }
  }
  if (patch.note !== undefined) next.note = String(patch.note ?? '').slice(0, 500)
  if (prev.kind === 'remote') {
    if (patch.address !== undefined) next.address = cleanAddress(patch.address)
    if (patch.port !== undefined) next.port = cleanPort(patch.port)
    if (next.address !== prev.address || next.port !== prev.port) { next.certFingerprint = null; next.certConfirmedAt = null; next.certConfirmedBy = null }
  } else if (patch.address !== undefined || patch.port !== undefined) {
    throw new ClusterRefusal('The home cluster is connected in Settings -> Proxmox, not here.')
  }
  if (patch.allowedRoots !== undefined) {
    if (!Array.isArray(patch.allowedRoots) || patch.allowedRoots.length > 20) throw new ClusterRefusal('Give at most 20 file roots.')
    next.allowedRoots = [...new Set(patch.allowedRoots.map(cleanRoot))]
  }
  if (patch.ignoredGuests !== undefined) {
    const ids = Array.isArray(patch.ignoredGuests) ? patch.ignoredGuests.map(x => String(x).trim()).filter(Boolean) : null
    if (!ids || ids.length > 200 || ids.some(x => !/^\d{1,9}$/.test(x))) throw new ClusterRefusal('Give container numbers only (such as 101), at most 200.')
    next.ignoredGuests = [...new Set(ids)].sort((a, b) => Number(a) - Number(b))
  }
  if (patch.nodeAddresses !== undefined) {
    const out: Record<string, string> = {}
    for (const [node, addr] of Object.entries(patch.nodeAddresses ?? {})) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/.test(node)) throw new ClusterRefusal(`"${node}" is not a node name.`)
      if (addr === '' || addr === null) continue
      out[node] = cleanAddress(addr)
    }
    next.nodeAddresses = out
  }
  if (patch.plexUrl !== undefined) {
    const u = patch.plexUrl ? String(patch.plexUrl).trim() : null
    if (u && !/^https?:\/\/[A-Za-z0-9.:[\]-]+(:\d+)?\/?$/.test(u)) throw new ClusterRefusal('The Plex address looks like http://10.0.0.5:32400 (no path).')
    next.plexUrl = u ? u.replace(/\/$/, '') : null
  }
  const saved = await store.upsert({ ...next })
  rows.set(id, saved)
  return view(saved)
}

/** Record that the owner compared and confirmed this fingerprint for the cluster's current address. */
export async function confirmFingerprint(id: string, fingerprint: string, by: string): Promise<ClusterInfo> {
  const prev = clusterRow(id)
  if (!prev || prev.kind !== 'remote') throw new ClusterRefusal('No such remote cluster.', 'not-found')
  const fp = normaliseFingerprint(fingerprint)
  if (!fp) throw new ClusterRefusal('That is not a SHA-256 certificate fingerprint.')
  const saved = await store.upsert({ ...prev, certFingerprint: fp, certConfirmedAt: new Date(), certConfirmedBy: by })
  rows.set(id, saved)
  return view(saved)
}

export async function setMonitoring(id: string, monitoring: ClusterRow['monitoring']): Promise<void> {
  const prev = clusterRow(id)
  if (!prev) throw new ClusterRefusal('No such cluster.', 'not-found')
  const saved = await store.upsert({ ...prev, monitoring })
  rows.set(id, saved)
}

/** Remove a remote: its vault items first, then its row. Nothing on that server is touched. */
export async function removeCluster(id: string): Promise<void> {
  const prev = clusterRow(id)
  if (!prev || prev.kind !== 'remote') throw new ClusterRefusal('Only a remote cluster can be removed.', 'not-found')
  await deleteProviderCredentials(TOKEN_CATEGORY, id)
  await deleteProviderCredentials(SSH_CATEGORY, id)
  await deleteProviderCredentials('cluster-monitoring', id).catch(() => undefined)
  await deleteProviderCredentials('cluster-plex', id).catch(() => undefined)
  await store.remove(id)
  rows.delete(id)
}

// ---------------------------------------------------------------------------
//  Secrets (vault only)
// ---------------------------------------------------------------------------

export interface RemoteToken { tokenId: string; secret: string }

/** The remote's admin token, from the unlocked vault. Synchronous: the client is built per call. */
export function remoteToken(id: string): RemoteToken {
  if (!isUnlocked()) throw new VaultLockedError(`the token for this cluster`)
  const f = cachedSecret(itemName(TOKEN_CATEGORY, id))?.fields ?? {}
  if (!f.token_id || !f.token_secret) throw new ClusterRefusal('This cluster has no token saved. Paste its token again (Edit server).', 'invalid')
  return { tokenId: f.token_id, secret: f.token_secret }
}

export function hasRemoteToken(id: string): boolean | null {
  if (!isUnlocked()) return null
  const f = cachedSecret(itemName(TOKEN_CATEGORY, id))?.fields ?? {}
  return !!(f.token_id && f.token_secret)
}

/** The token ID (not the secret), to show which token is in use. */
export function remoteTokenId(id: string): string | null {
  if (!isUnlocked()) return null
  return cachedSecret(itemName(TOKEN_CATEGORY, id))?.fields?.token_id ?? null
}

export async function replaceRemoteToken(id: string, tokenId: string, tokenSecret: string): Promise<void> {
  const prev = clusterRow(id)
  if (!prev || prev.kind !== 'remote') throw new ClusterRefusal('No such remote cluster.', 'not-found')
  validateToken(tokenId, tokenSecret)
  await setCredentials(TOKEN_CATEGORY, id, { token_id: tokenId.trim(), token_secret: tokenSecret.trim() })
}

export const nodeLoginKey = (node: string) => `node-${node}`.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 120)

export async function remoteNodeLoginRaw(id: string, node: string): Promise<string | null> {
  return getCredential(SSH_CATEGORY, id, nodeLoginKey(node))
}
export async function saveRemoteNodeLogin(id: string, node: string, json: string): Promise<void> {
  await setCredential(SSH_CATEGORY, id, nodeLoginKey(node), json, true)
}
export async function removeRemoteNodeLogin(id: string, node: string): Promise<void> {
  await deleteCredential(SSH_CATEGORY, id, nodeLoginKey(node))
}
export async function remoteNodeLogins(id: string): Promise<string[]> {
  return (await listCredentialKeys(SSH_CATEGORY, id)).map(r => r.key.replace(/^node-/, ''))
}

/** Test seam: forget everything in memory. */
export function resetClustersForTests(): void { rows.clear(); loaded = false; store = new MemoryClusterStore() }
