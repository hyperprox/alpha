// =============================================================================
//  HyperProx — `hyperprox pve-exporter` (host CLI)
//
//  Gives the PVE exporter its own read-only Proxmox token (see lib/pve-exporter.ts). That needs
//  HyperProx's admin token, which exists only in the API's memory while HyperProx is unlocked, so the
//  work is done by the API: POST /api/monitoring/pve-exporter. To call it as root on the host, this mints
//  a one-off admin API token straight in the database (as `hyperprox token create` does), uses it once
//  over loopback and revokes it, whatever happens. Locked: it says so and changes nothing.
//
//    hyperprox pve-exporter          make or repair the token; prints what it did
//    hyperprox pve-exporter status   which token the exporter uses now
// =============================================================================

import { PrismaClient } from '@prisma/client'
import { PrismaApiTokenStore, createApiToken, revokeApiToken, type ApiTokenStore } from '../lib/api-tokens'
import { CLI_ACTOR, type CliIo } from './api-token'

const USAGE = 'usage: hyperprox pve-exporter [status]'

type Fetch = (url: string, init: { method: string; headers: Record<string, string> }) =>
  Promise<{ status: number; json(): Promise<any> }>

export interface PveExporterCliDeps {
  store:  ApiTokenStore
  apiUrl: string
  fetch?: Fetch
  now?:   () => number
}

function explain(status: number, body: any): string {
  if (status === 423) return 'HyperProx is locked. Sign in at /login first: the admin token this uses is only in memory while unlocked.'
  return body?.error ? String(body.error) : `HTTP ${status}`
}

/** Exit code: 0 ok, 1 failed, 2 usage. */
export async function runPveExporterCli(argv: string[], deps: PveExporterCliDeps, io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv
  if (rest.length || (cmd !== undefined && cmd !== 'status' && cmd !== 'setup')) {
    if (cmd === '-h' || cmd === '--help' || cmd === 'help') { io.out(USAGE); return 0 }
    io.err(USAGE); return 2
  }
  const doFetch: Fetch = deps.fetch ?? ((url, init) => fetch(url, init) as any)
  const method = cmd === 'status' ? 'GET' : 'POST'
  const name = `${CLI_ACTOR}-pve-exporter-${(deps.now ?? Date.now)()}`
  // Admin is what the POST needs (the role matrix makes every write admin); reading the status, viewer.
  const { token } = await createApiToken({ name, role: method === 'GET' ? 'viewer' : 'admin', expiresDays: 1 }, CLI_ACTOR, deps.store)
  try {
    let res: Awaited<ReturnType<Fetch>>
    try {
      res = await doFetch(`${deps.apiUrl}/api/monitoring/pve-exporter`, { method, headers: { Authorization: `Bearer ${token}` } })
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
      else io.out(`pve-exporter: uses ${d.tokenId}${d.readOnly ? ' (read-only, PVEAuditor)' : ' (not the read-only token HyperProx makes; run: hyperprox pve-exporter)'}`)
      return 0
    }
    const what = d.action === 'reuse' ? 'already in place' : d.action === 'recreate' ? 'made again' : 'created'
    io.out(`pve-exporter: read-only token ${d.tokenId} ${what} (PVEAuditor on /)`)
    io.out(d.changed
      ? `pve-exporter: config/pve-exporter/pve.yml updated${d.restarted ? ', exporter restarted' : '; the exporter is not running, so it reads it when it starts'}`
      : 'pve-exporter: config/pve-exporter/pve.yml unchanged')
    return 0
  } finally {
    await revokeApiToken(name, CLI_ACTOR, deps.store).catch(e => io.err(`pve-exporter: could not revoke the one-off API token ${name}: ${e?.message ?? e}`))
  }
}

if (require.main === module) {
  // DATABASE_URL and the API address come from bin/hyperprox.
  const db = new PrismaClient()
  runPveExporterCli(process.argv.slice(2), {
    store: new PrismaApiTokenStore(db), apiUrl: process.env.HYPERPROX_API_URL || 'http://127.0.0.1:3002',
  }, {
    out: l => process.stdout.write(l + '\n'),
    err: l => process.stderr.write(l + '\n'),
  })
    .then(async code => { await db.$disconnect(); process.exit(code) })
    .catch(async (e: any) => {
      process.stderr.write(`pve-exporter: ${e?.message ?? e}\n`)
      await db.$disconnect().catch(() => {})
      process.exit(1)
    })
}
