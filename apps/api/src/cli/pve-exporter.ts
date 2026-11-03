// =============================================================================
//  HyperProx — `hyperprox pve-exporter` (host CLI)
//
//  Gives the PVE exporter its own read-only Proxmox token (see lib/pve-exporter.ts). That needs
//  HyperProx's admin token, which exists only in the API's memory while HyperProx is unlocked, so the
//  work is done by the API: POST /api/monitoring/pve-exporter. To call it as root on the host, this mints
//  a one-off API token straight in the database (as `hyperprox token create` does), valid for ten
//  minutes, uses it once over loopback and revokes it: on success, on failure, and on Ctrl-C or SIGTERM.
//  Every run also revokes any earlier one-off token still active (a run killed with SIGKILL, or one from
//  before the ten-minute expiry). Locked: it says so and changes nothing.
//
//    hyperprox pve-exporter            make or repair the token; prints what it did
//    hyperprox pve-exporter --fresh    replace a token that is not read-only with a new one
//    hyperprox pve-exporter status     which token the exporter uses, and whether Proxmox says it is read-only
// =============================================================================

import { PrismaClient } from '@prisma/client'
import { PrismaApiTokenStore, createApiToken, revokeApiToken, tokenState, type ApiTokenStore } from '../lib/api-tokens'
import { CLI_ACTOR, type CliIo } from './api-token'

const USAGE = 'usage: hyperprox pve-exporter [status | --fresh]'
export const ONE_OFF_PREFIX = `${CLI_ACTOR}-pve-exporter-`
export const ONE_OFF_TTL_MS = 10 * 60_000

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
  Promise<{ status: number; json(): Promise<any> }>

export interface PveExporterCliDeps {
  store:  ApiTokenStore
  apiUrl: string
  fetch?: Fetch
  now?:   () => number
  /**
   * Called once with a handler for SIGINT/SIGTERM; returns the function that removes it. The handler
   * revokes the one-off token and resolves with the exit code to leave with.
   */
  onSignal?: (handler: (sig: string) => Promise<number>) => () => void
}

function explain(status: number, body: any): string {
  if (status === 423) return 'HyperProx is locked. Sign in at /login first: the admin token this uses is only in memory while unlocked.'
  return body?.error ? String(body.error) : `HTTP ${status}`
}

/** Revoke one-off tokens an earlier run left active. */
async function sweep(store: ApiTokenStore, io: CliIo, keep?: string): Promise<void> {
  for (const row of await store.list()) {
    if (!row.name.startsWith(ONE_OFF_PREFIX) || row.name === keep || tokenState(row) !== 'active') continue
    await revokeApiToken(row.id, CLI_ACTOR, store)
    io.err(`pve-exporter: revoked a one-off API token an earlier run left active (${row.name})`)
  }
}

/** Exit code: 0 ok, 1 failed, 2 usage. 130/143 after SIGINT/SIGTERM. */
export async function runPveExporterCli(argv: string[], deps: PveExporterCliDeps, io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') { io.out(USAGE); return 0 }
  if (rest.length || (cmd !== undefined && cmd !== 'status' && cmd !== 'setup' && cmd !== '--fresh')) { io.err(USAGE); return 2 }
  const method = cmd === 'status' ? 'GET' : 'POST'
  const fresh = cmd === '--fresh'
  const doFetch: Fetch = deps.fetch ?? ((url, init) => fetch(url, init) as any)
  const now = (deps.now ?? Date.now)()
  const name = `${ONE_OFF_PREFIX}${now}`

  await sweep(deps.store, io)
  // Admin is what the POST needs (the role matrix makes every write admin); reading the status, viewer.
  const { token } = await createApiToken({ name, role: method === 'GET' ? 'viewer' : 'admin' }, CLI_ACTOR, deps.store, now,
    { expiresInMs: ONE_OFF_TTL_MS })

  let revoked: Promise<void> | null = null
  const revoke = () => (revoked ??= revokeApiToken(name, CLI_ACTOR, deps.store).then(() => undefined)
    .catch(e => io.err(`pve-exporter: could not revoke the one-off API token ${name}: ${e?.message ?? e}`)))
  const unhook = deps.onSignal?.(async (sig) => {
    await revoke()
    io.err(`pve-exporter: stopped by ${sig}; the one-off API token was revoked`)
    return sig === 'SIGINT' ? 130 : 143
  })

  try {
    let res: Awaited<ReturnType<Fetch>>
    try {
      res = await doFetch(`${deps.apiUrl}/api/monitoring/pve-exporter`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(fresh ? { 'Content-Type': 'application/json' } : {}) },
        ...(fresh ? { body: JSON.stringify({ fresh: true }) } : {}),
      })
    } catch (e: any) {
      io.err(`pve-exporter: could not reach the API at ${deps.apiUrl} (${e?.cause?.code ?? e?.message ?? e}); is hyperprox-api running?`)
      return 1
    }
    const body = await res.json().catch(() => ({}))
    if (res.status < 200 || res.status >= 300 || !body?.success) {
      io.err(`pve-exporter: ${explain(res.status, body)}`)
      return 1
    }
    const d = body.data
    if (method === 'GET') {
      if (!d.configured) io.out('pve-exporter: no token yet (run: hyperprox pve-exporter)')
      else if (d.readOnly === true) io.out(`pve-exporter: uses ${d.tokenId} (read-only: privilege separation on, only PVEAuditor on /)`)
      else if (d.readOnly === false) io.out(`pve-exporter: uses ${d.tokenId}, which is NOT read-only: ${(d.reasons ?? []).join('; ')} (run: hyperprox pve-exporter --fresh)`)
      else io.out(`pve-exporter: uses ${d.tokenId}; could not ask Proxmox whether it is read-only (${d.checkError ?? 'unknown'})`)
      return 0
    }
    const what = d.action === 'reuse' ? 'already in place' : d.action === 'recreate' ? 'made again' : 'created'
    io.out(`pve-exporter: read-only token ${d.tokenId} ${what} (PVEAuditor on /)`)
    io.out(d.changed
      ? `pve-exporter: config/pve-exporter/pve.yml updated${d.restarted ? ', exporter restarted' : '; the exporter is not running, so it reads it when it starts'}`
      : 'pve-exporter: config/pve-exporter/pve.yml unchanged')
    return 0
  } finally {
    unhook?.()
    await revoke()
  }
}

if (require.main === module) {
  // DATABASE_URL and the API address come from bin/hyperprox.
  const db = new PrismaClient()
  const io = { out: (l: string) => process.stdout.write(l + '\n'), err: (l: string) => process.stderr.write(l + '\n') }
  const leave = async (code: number) => { await db.$disconnect().catch(() => {}); process.exit(code) }
  runPveExporterCli(process.argv.slice(2), {
    store: new PrismaApiTokenStore(db), apiUrl: process.env.HYPERPROX_API_URL || 'http://127.0.0.1:3002',
    onSignal: (handler) => {
      const on = (sig: NodeJS.Signals) => { void handler(sig).then(leave) }
      process.once('SIGINT', on); process.once('SIGTERM', on)
      return () => { process.off('SIGINT', on); process.off('SIGTERM', on) }
    },
  }, io)
    .then(leave)
    .catch(async (e: any) => { process.stderr.write(`pve-exporter: ${e?.message ?? e}\n`); await leave(1) })
}
