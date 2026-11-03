// =============================================================================
//  HyperProx — the PVE exporter's read-only Proxmox token
//
//  prometheus-pve-exporter (the hyperprox-pve-exporter container) reads Proxmox through its own token in
//  config/pve-exporter/pve.yml. The setup wizard and bootstrap.sh make it on a new install; this makes it
//  for an install that has none (or still runs the exporter on HyperProx's full token), from the admin
//  token HyperProx holds while unlocked. POST /api/monitoring/pve-exporter and `hyperprox pve-exporter`.
//
//  The token rules live in apps/setup/pve-exporter.js, shared with the wizard: `<user>!<HyperProx
//  token>-exporter`, privilege separation on, PVEAuditor on `/` and nothing else, so it can read what the
//  exporter reports and cannot change anything. Its secret is a file on disk because the exporter
//  container reads it there; docs/security.md says so.
// =============================================================================

import path from 'node:path'
import { execFile } from 'node:child_process'
import { ProxmoxClient } from './proxmox-client'

export interface ExporterToken { user: string; tokenName: string; secret: string }

/** The cluster as HyperProx's own token sees it, in the shape apps/setup/pve-exporter.js expects. */
export interface ExporterPve {
  listTokens(): Promise<Array<{ tokenid: string; comment?: string }>>
  createToken(name: string, opts: { privsep: number; comment: string }): Promise<{ value?: string; 'full-tokenid'?: string }>
  deleteToken(name: string): Promise<unknown>
  setAcl(acl: { path: string; role: string; token: string }): Promise<unknown>
  tokenWorks(fullTokenId: string, secret: string): Promise<boolean>
}

interface Shared {
  EXPORTER_ROLE: string
  exporterTokenName(adminTokenName: string): string
  renderPveYml(t: ExporterToken): string
  parsePveYml(text: string): ExporterToken | null
  readPveYml(file: string): ExporterToken | null
  writePveYml(file: string, content: string, uid?: number): boolean
  ensureExporterToken(pve: ExporterPve, o: { userid: string; adminTokenName: string; held: ExporterToken | null }):
    Promise<{ action: 'reuse' | 'create' | 'recreate'; user: string; tokenName: string; fullTokenId: string; secret: string }>
}

// The wizard's file, not a copy. src/lib and dist/lib are both two levels below apps/api.
// eslint-disable-next-line @typescript-eslint/no-var-requires
export const shared: Shared = require(path.join(__dirname, '../../../setup/pve-exporter.js'))

export const EXPORTER_CONTAINER = 'hyperprox-pve-exporter'

export function pveExporterConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.HYPERPROX_DIR || '/opt/hyperprox', 'config', 'pve-exporter', 'pve.yml')
}

/** HyperProx's own Proxmox access, as the vault put it in the environment at unlock. */
export interface PveAccess { host: string; port: number; user: string; tokenName: string; secret: string }

export function pveAccessFromEnv(env: NodeJS.ProcessEnv = process.env): PveAccess {
  const host = env.PROXMOX_HOST ?? '', user = env.PROXMOX_USER ?? '', tokenName = env.PROXMOX_TOKEN_ID ?? ''
  const secret = env.PROXMOX_TOKEN_SECRET ?? ''
  if (!host || !user || !tokenName || !secret) {
    throw new Error('Proxmox is not configured, or HyperProx is locked (sign in to unlock)')
  }
  return { host, port: Number(env.PROXMOX_PORT ?? 8006), user, tokenName, secret }
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString()

/** The adapter over HyperProx's admin token. `client` is injectable for tests. */
export function tokenPve(
  a: PveAccess,
  client: (tokenId: string, secret: string) => Pick<ProxmoxClient, 'fetchStrict'> =
    (id, s) => new ProxmoxClient(a.host, a.port, id, s),
): ExporterPve {
  const admin = client(`${a.user}!${a.tokenName}`, a.secret)
  const tokens = `/access/users/${encodeURIComponent(a.user)}/token`
  return {
    listTokens:  () => admin.fetchStrict<any[]>(tokens).then(r => r ?? []),
    createToken: (name, o) => admin.fetchStrict<any>(`${tokens}/${encodeURIComponent(name)}`, 'POST',
      form({ privsep: String(o.privsep), comment: o.comment })),
    deleteToken: (name) => admin.fetchStrict(`${tokens}/${encodeURIComponent(name)}`, 'DELETE'),
    setAcl:      (acl) => admin.fetchStrict('/access/acl', 'PUT',
      form({ path: acl.path, roles: acl.role, tokens: acl.token, propagate: '1' })),
    tokenWorks:  async (id, secret) => {
      try { await client(id, secret).fetchStrict('/version'); return true }
      catch (e: any) { if (/HTTP 401\b/.test(String(e?.message))) return false; throw e }
    },
  }
}

/** Restart the exporter so it reads the new pve.yml. False when it is not there to restart. */
export function restartExporter(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('docker', ['restart', EXPORTER_CONTAINER], { timeout: 60_000 }, err => resolve(!err))
  })
}

export interface ProvisionResult {
  action:    'reuse' | 'create' | 'recreate'
  tokenId:   string
  /** pve.yml was rewritten. */
  changed:   boolean
  /** The exporter was restarted to pick it up (false when nothing changed, or it is not running). */
  restarted: boolean
}

/** Make or repair the exporter token and pve.yml. Never returns the secret. */
export async function provisionPveExporter(deps: {
  access:   PveAccess
  pve?:     ExporterPve
  file?:    string
  restart?: () => Promise<boolean>
}): Promise<ProvisionResult> {
  const file = deps.file ?? pveExporterConfigPath()
  const pve = deps.pve ?? tokenPve(deps.access)
  const r = await shared.ensureExporterToken(pve, {
    userid: deps.access.user, adminTokenName: deps.access.tokenName, held: shared.readPveYml(file),
  })
  const changed = shared.writePveYml(file, shared.renderPveYml({ user: r.user, tokenName: r.tokenName, secret: r.secret }))
  const restarted = changed ? await (deps.restart ?? restartExporter)() : false
  return { action: r.action, tokenId: r.fullTokenId, changed, restarted }
}

export interface ExporterStatus {
  /** pve.yml holds a token at all. */
  configured: boolean
  /** user!token it holds, when configured. */
  tokenId?:   string
  /** The token is the read-only one HyperProx makes (named `<HyperProx token>-exporter`). */
  readOnly:   boolean
}

export function exporterStatus(file = pveExporterConfigPath()): ExporterStatus {
  const t = shared.readPveYml(file)
  if (!t) return { configured: false, readOnly: false }
  return { configured: true, tokenId: `${t.user}!${t.tokenName}`, readOnly: /-exporter$/.test(t.tokenName) }
}
