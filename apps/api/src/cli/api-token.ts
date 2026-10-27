// =============================================================================
//  HyperProx — `hyperprox token` (host CLI)
//  Run by bin/hyperprox as root on the HyperProx machine, against the database
//  directly: root there already owns HyperProx, so this needs no session and
//  works while locked (a token is simply refused with 423 until someone signs in).
//
//    hyperprox token create <name> [--role viewer|operator|admin] [--expires-days N]
//    hyperprox token list
//    hyperprox token revoke <name|id>
//
//  create prints the token once, on stdout, alone on its line; everything else
//  goes to stderr so `TOKEN=$(hyperprox token create ci)` captures only it.
//  A revoke here reaches a running API within lib/api-tokens.ts CACHE_MS.
// =============================================================================

import { PrismaClient } from '@prisma/client'
import {
  ApiTokenInputError, ApiTokenNotFoundError, PrismaApiTokenStore, createApiToken, revokeApiToken, tokenView,
  type ApiTokenStore,
} from '../lib/api-tokens'

export const CLI_ACTOR = 'host-cli'

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}

const USAGE = [
  'usage: hyperprox token create <name> [--role viewer|operator|admin] [--expires-days N]',
  '       hyperprox token list',
  '       hyperprox token revoke <name|id>',
].join('\n')

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue }
      const v = args[i + 1]
      if (v === undefined || v.startsWith('--')) throw new ApiTokenInputError(`${a} needs a value`)
      flags[a.slice(2)] = v
      i++
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

function pad(s: string, n: number) { return s.length >= n ? s : s + ' '.repeat(n - s.length) }
const day = (s: string | null) => (s ? s.slice(0, 16).replace('T', ' ') : '-')

/** Exit code: 0 ok, 1 failed, 2 usage. */
export async function runTokenCli(argv: string[], store: ApiTokenStore, io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv
  try {
    switch (cmd) {
      case 'create': {
        const { positional, flags } = parseFlags(rest)
        const unknown = Object.keys(flags).filter(k => k !== 'role' && k !== 'expires-days')
        if (positional.length !== 1 || unknown.length) { io.err(USAGE); return 2 }
        let expiresDays: number | undefined
        if (flags['expires-days'] !== undefined) {
          if (!/^\d+$/.test(flags['expires-days'])) throw new ApiTokenInputError('--expires-days must be a whole number of days')
          expiresDays = Number(flags['expires-days'])
        }
        const { token, record } = await createApiToken({ name: positional[0], role: (flags.role ?? 'admin') as any, expiresDays }, CLI_ACTOR, store)
        io.err(`created API token "${record.name}" (role ${record.role}${record.expiresAt ? `, expires ${day(record.expiresAt.toISOString())} UTC` : ', no expiry'})`)
        io.err('this is the only time it is shown - store it now:')
        io.out(token)
        io.err('it works only while HyperProx is unlocked; use it as: Authorization: Bearer <token>')
        return 0
      }
      case 'list': {
        if (rest.length) { io.err(USAGE); return 2 }
        const rows = (await store.list()).map(r => tokenView(r))
        if (!rows.length) { io.err('no API tokens'); return 0 }
        const w = Math.max(4, ...rows.map(r => r.name.length))
        io.out(`${pad('NAME', w)}  ${pad('ROLE', 8)}  ${pad('STATE', 7)}  ${pad('CREATED', 16)}  ${pad('LAST USED', 16)}  ${pad('EXPIRES', 16)}  ID`)
        for (const r of rows) {
          io.out(`${pad(r.name, w)}  ${pad(r.role, 8)}  ${pad(r.state, 7)}  ${pad(day(r.createdAt), 16)}  ${pad(day(r.lastUsedAt), 16)}  ${pad(day(r.expiresAt), 16)}  ${r.id}`)
        }
        return 0
      }
      case 'revoke': {
        if (rest.length !== 1) { io.err(USAGE); return 2 }
        const before = (await store.findById(rest[0])) ?? (await store.findByName(rest[0]))
        const row = await revokeApiToken(rest[0], CLI_ACTOR, store)
        io.out(before?.revokedAt ? `API token "${row.name}" was already revoked` : `revoked API token "${row.name}"`)
        return 0
      }
      case undefined: case '-h': case '--help': case 'help':
        (cmd === undefined ? io.err : io.out)(USAGE)
        return cmd === undefined ? 2 : 0
      default:
        io.err(`hyperprox token: unknown command '${cmd}'\n${USAGE}`)
        return 2
    }
  } catch (e) {
    if (e instanceof ApiTokenInputError || e instanceof ApiTokenNotFoundError) { io.err(`token: ${e.message}`); return 1 }
    throw e
  }
}

if (require.main === module) {
  // DATABASE_URL comes from bin/hyperprox (read from .env, as deploy.sh does).
  const db = new PrismaClient()
  runTokenCli(process.argv.slice(2), new PrismaApiTokenStore(db), {
    out: l => process.stdout.write(l + '\n'),
    err: l => process.stderr.write(l + '\n'),
  })
    .then(async code => { await db.$disconnect(); process.exit(code) })
    .catch(async (e: any) => {
      process.stderr.write(`token: ${e?.message ?? e}\n`)
      await db.$disconnect().catch(() => {})
      process.exit(1)
    })
}
