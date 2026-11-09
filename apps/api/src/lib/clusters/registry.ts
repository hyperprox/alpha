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
import { normaliseFingerprint, isServerAddress } from './tls-pin'

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
function cleanPort(p: unknown): number {
  const n = p === undefined || p === '' || p === null ? 8006 : Number(p)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ClusterRefusal('The port must be a number from 1 to 65535.')
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
  if (/^\/(etc|proc|sys|dev|boot|root|run|usr|bin|sbin|lib|lib64|var\/lib\/pve-cluster|etc\/pve)(\/|$)/.test(p)) throw new ClusterRefusal(`${p} is a system folder; it cannot be a file root.`)
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

/** Store the token in the vault first, then the row; a vault failure leaves nothing behind. */
export async function createRemote(n: NewRemote): Promise<ClusterInfo> {
  const fingerprint = normaliseFingerprint(n.fingerprint)
  if (!fingerprint) throw new ClusterRefusal('That is not a SHA-256 certificate fingerprint.')
  validateToken(n.tokenId, n.tokenSecret)
  const name = cleanName(n.name), address = cleanAddress(n.address), port = cleanPort(n.port)
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

export interface ClusterPatch {
  name?: string; note?: string; address?: string; port?: number
  allowedRoots?: string[]; nodeAddresses?: Record<string, string>; plexUrl?: string | null
}

/**
 * Change a cluster's settings. A new address or port clears the confirmed fingerprint: the owner confirms the
 * certificate at the new place before anything is sent there.
 */
export async function updateCluster(id: string, patch: ClusterPatch): Promise<ClusterInfo> {
  const prev = clusterRow(id)
  if (!prev) throw new ClusterRefusal('No such cluster.', 'not-found')
  const next: ClusterRow = structuredClone(prev)
  if (patch.name !== undefined) next.name = cleanName(patch.name)
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
