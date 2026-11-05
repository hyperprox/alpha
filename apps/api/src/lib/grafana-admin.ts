// =============================================================================
//  HyperProx — Grafana's admin password, kept only in the vault
//
//  Grafana reads GF_SECURITY_ADMIN_PASSWORD only when it first sets up its database. After the first owner
//  sign-in that variable is gone from .env, so a new database (a volume reset, say) would start with
//  Grafana's default admin/admin. ensureGrafanaAdmin closes that: on every owner or admin sign-in, and
//  after the charts are started, it makes Grafana's admin password the vault's, generating one first if
//  the vault has none. Its login form and basic auth are off, so the window is small; this removes it.
//
//  Order matters. A new password is written to the vault and read back before Grafana is changed, and if
//  Grafana then refuses it, the vault is put back as it was. Nothing is ever only in Grafana.
// =============================================================================

import { spawn, execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { getCredential, setCredential } from './credentials'
import { auditCredentialUse } from './audit'

export interface GrafanaAdminDeps {
  running(): Promise<boolean>
  /** Set Grafana's admin password; the value goes on stdin. */
  apply(password: string): Promise<void>
  read(): Promise<string | null>
  write(password: string): Promise<void>
  generate(): string
}

export function grafanaCliReset(password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['exec', '-i', 'hyperprox-grafana', 'grafana', 'cli', 'admin', 'reset-admin-password', '--password-from-stdin'],
      { stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { err += d })
    p.on('error', reject)
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`grafana cli exited ${code}: ${err.trim().split('\n').pop()}`)))
    p.stdin.end(password + '\n')
  })
}

export function productionGrafanaDeps(): GrafanaAdminDeps {
  return {
    running: () => new Promise(r => execFile('docker', ['inspect', '-f', '{{.State.Running}}', 'hyperprox-grafana'], (e, out) => r(!e && out.trim() === 'true'))),
    apply: grafanaCliReset,
    read: () => getCredential('system', 'grafana', 'admin_password'),
    write: pw => setCredential('system', 'grafana', 'admin_password', pw),
    generate: () => randomBytes(18).toString('base64url'),
  }
}

/** Write to the vault and prove it reads back, or throw having changed nothing usable. */
async function store(d: GrafanaAdminDeps, pw: string): Promise<void> {
  await d.write(pw)
  if ((await d.read()) !== pw) throw new Error('the vault did not keep the new Grafana password')
}

// Off until the API's own entry point turns it on (index.ts), so a test that signs in never reaches a
// real Grafana container on the machine it runs on.
let syncDeps: GrafanaAdminDeps | null = null
export function enableGrafanaAdminSync(d: GrafanaAdminDeps | null = productionGrafanaDeps()): void { syncDeps = d }

/** Make Grafana's admin password the vault's. Returns what it did. */
export async function ensureGrafanaAdmin(d: GrafanaAdminDeps | null = syncDeps, by = 'sign-in'): Promise<'off' | 'not-running' | 'applied' | 'generated'> {
  if (!d) return 'off'
  if (!(await d.running())) return 'not-running'
  let pw = await d.read()
  let made = false
  if (!pw) { pw = d.generate(); await store(d, pw); made = true }
  await d.apply(pw)
  await auditCredentialUse(made ? 'grafana_admin.generate' : 'grafana_admin.apply', 'system:grafana', { by })
  return made ? 'generated' : 'applied'
}

/** A new password: vault first (read back), then Grafana; if Grafana refuses, the vault goes back. */
export async function resetGrafanaAdmin(d: GrafanaAdminDeps = productionGrafanaDeps(), by = 'unknown'): Promise<void> {
  const old = await d.read()
  const pw = d.generate()
  await store(d, pw)
  try {
    await d.apply(pw)
  } catch (e) {
    await d.write(old ?? '').catch(() => undefined)
    throw e
  }
  await auditCredentialUse('grafana_admin.reset', 'system:grafana', { by })
}
