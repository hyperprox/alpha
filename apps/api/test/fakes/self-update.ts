// A pretend install for the self-update tests: a temp directory with an .env, a fake shell that plays git,
// df, docker (pg_dump/psql), systemctl and deploy.sh, and a fake HTTP for the health checks. Nothing real is
// run, fetched or restarted. Commits and secrets are invented.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Shell, RunOptions, RunResult, HttpGet } from '../../src/lib/self-update/shell'
import type { UpdateJob } from '../../src/lib/self-update/state'

export const FROM = 'a'.repeat(40)
export const TO = 'b'.repeat(40)
export const OTHER = 'c'.repeat(40)
export const SECRET_PW = 'pg-Pa55word-not-real-7781'
export const SECRET_TOKEN = 'vault-admin-token-not-real-4417'

export type FailAt = 'df' | 'dirty' | 'pg_dump' | 'fetch' | 'not-on-branch' | 'tag-moved' | 'staging' | 'build' | 'migrate' | 'restart' | 'health' | 'rollback-deploy' | null

export interface FakeOptions {
  failAt?: FailAt
  freeKiB?: number
  migrationsAdded?: number
  channel?: 'stable' | 'alpha'
  /** The annotated tag's text: '' = lightweight tag; include a signature block to make it "signed". */
  tagText?: string
  verifyTagCode?: number
  keyholderChanged?: boolean
}

export class FakeInstall implements Shell {
  dir: string
  calls: string[] = []
  head = FROM
  deployed = FROM
  restored = false
  apiStopped = false
  stagingSeen = false
  constructor(public o: FakeOptions = {}) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-selfupd-'))
    fs.mkdirSync(path.join(this.dir, 'data', 'self-update'), { recursive: true })
    fs.writeFileSync(path.join(this.dir, '.env'), [
      'POSTGRES_USER=hyperprox', 'POSTGRES_DB=hyperprox', `POSTGRES_PASSWORD=${SECRET_PW}`,
      `DATABASE_URL=postgresql://hyperprox:${SECRET_PW}@localhost:5432/hyperprox`, `VAULT_ADMIN_TOKEN=${SECRET_TOKEN}`, 'API_PORT=3002',
    ].join('\n') + '\n')
  }

  job(over: Partial<UpdateJob> = {}): UpdateJob {
    const channel = this.o.channel ?? 'stable'
    return {
      id: '20261112000000-abcd', dir: this.dir, by: 'admin@example.com',
      target: channel === 'stable'
        ? { sha: TO, channel, ref: 'v0.3.0', label: 'v0.3.0', version: '0.3.0' }
        : { sha: TO, channel, ref: 'main', label: 'main @ bbbbbbb', version: null },
      from: { sha: FROM, version: '0.2.0-alpha', branch: 'main' },
      repoUrl: 'https://github.com/example/hyperprox.git', mirrorUrl: null, requireSigned: false, trustedKeys: null,
      stateFile: path.join(this.dir, 'data', 'self-update', 'state.json'), logFile: path.join(this.dir, 'data', 'self-update', 'log.txt'),
      backupDir: path.join(this.dir, 'backups'), keepBackups: 3, minFreeMiB: 3072,
      health: { api: 'http://127.0.0.1:3002/health', frontend: 'http://127.0.0.1:3000/login', nginx: 'https://127.0.0.1/login', timeoutMs: 1 },
      lockHeld: true, createdAt: new Date().toISOString(), ...over,
    }
  }

  async run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const a = cmd === 'git' ? args.filter((x, i) => !(x === '-c' || args[i - 1] === '-c')) : args
    this.calls.push([cmd, ...a].join(' '))
    const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' })
    const fail = (code = 1, stderr = 'failed'): RunResult => ({ code, stdout: '', stderr })
    const f = this.o.failAt
    if (cmd === 'df') {
      return ok(`Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 100000000 1 ${f === 'df' ? 1024 : this.o.freeKiB ?? 50_000_000} 1% /\n`)
    }
    if (cmd === 'git') {
      const [sub, ...rest] = a
      switch (sub) {
        case 'status': return ok(f === 'dirty' ? ' M apps/api/src/index.ts\n' : '')
        case 'rev-parse': {
          const ref = rest[rest.length - 1]
          if (ref === 'HEAD') return ok(this.head + '\n')
          if (ref.endsWith(':bin/hyperprox-keyholder')) return ok((this.o.keyholderChanged && ref.startsWith(TO) ? 'k2' : 'k1') + '\n')
          if (ref.endsWith('^{commit}')) return ok((f === 'tag-moved' ? OTHER : TO) + '\n')
          if (ref.includes('/heads/')) return ok(OTHER + '\n')   // the branch tip, ahead of TO
          return fail(1, '')
        }
        case 'update-ref': return ok()
        case 'fetch': return f === 'fetch' ? fail(128, 'fatal: unable to access upstream') : ok()
        case 'cat-file': {
          if (rest[0] === '-t') return ok(this.o.tagText ? 'tag\n' : 'commit\n')
          return ok(this.o.tagText ?? '')
        }
        case 'verify-tag': return { code: this.o.verifyTagCode ?? 1, stdout: '', stderr: '' }
        case 'merge-base': return f === 'not-on-branch' ? fail(1, '') : ok()
        case 'worktree': {
          if (rest[0] === 'add') {
            const dir = rest[rest.length - 2]
            this.stagingSeen = true
            const files = ['deploy.sh', 'package.json', 'pnpm-lock.yaml', 'apps/api/package.json', 'apps/api/prisma/schema.prisma', 'apps/frontend/package.json']
            for (const x of f === 'staging' ? files.slice(1) : files) {
              fs.mkdirSync(path.dirname(path.join(dir, x)), { recursive: true })
              fs.writeFileSync(path.join(dir, x), x === 'deploy.sh' ? 'prisma migrate deploy\nsystemctl restart hyperprox-api\n' : x === 'package.json' ? '{"version":"0.3.0"}' : '')
            }
            return ok()
          }
          if (rest[0] === 'remove') { fs.rmSync(rest[rest.length - 1], { recursive: true, force: true }); return ok() }
          return fail()
        }
        case 'diff': {
          const n = this.o.migrationsAdded ?? 0
          return ok(Array.from({ length: n }, (_, i) => `apps/api/prisma/migrations/2026111${i}_x/migration.sql`).join('\n'))
        }
        case 'checkout': { this.head = rest[rest.length - 1]; return ok() }
        default: return fail(1, `unexpected git ${sub}`)
      }
    }
    if (cmd === 'docker') {
      if (a.includes('pg_dump')) {
        if (f === 'pg_dump') { fs.writeFileSync(opts.stdoutFile!, '-- partial\n'); return fail(1, 'pg_dump: error') }
        fs.writeFileSync(opts.stdoutFile!, '-- dump\n-- PostgreSQL database dump complete\n')
        return ok()
      }
      if (a.includes('psql')) { this.restored = true; return ok() }
      return fail()
    }
    if (cmd === 'systemctl') { if (a[0] === 'stop') this.apiStopped = true; return ok() }
    if (cmd === 'gpg') return ok()
    if (cmd === 'bash' && a[0].endsWith('deploy.sh')) {
      const target = this.head === TO
      const line = (l: string) => opts.onLine?.(l)
      line(`→ Bringing this install's configuration up to date...`)
      line(`  connecting with DATABASE_URL=postgresql://hyperprox:${SECRET_PW}@localhost:5432/hyperprox`)
      line(`→ Installing dependencies...`)
      line(`→ Building API...`)
      if (target && f === 'build') { line('src/index.ts(1,1): error TS1005'); return fail(2) }
      line(`→ Building Frontend...`)
      line(`→ Applying database migrations...`)
      if (target && f === 'migrate') { line('Error: P3018 A migration failed to apply'); return fail(1) }
      line(`  token=${SECRET_TOKEN} printed by a careless script`)
      line(`→ Checking the keyholder...`)
      line(`→ Restarting services...`)
      if (target && f === 'restart') return fail(1)
      if (!target && f === 'rollback-deploy') return fail(1)
      this.deployed = this.head
      line(`✓ Deploy complete`)
      return ok()
    }
    return fail(127, `unexpected ${cmd}`)
  }

  http: HttpGet = async (url) => {
    if (url.endsWith('/health')) {
      const bad = this.o.failAt === 'health' && this.deployed === TO
      return { status: 200, body: JSON.stringify({ status: 'ok', commit: bad ? 'deadbee' : this.deployed.slice(0, 7) }) }
    }
    return { status: 200, body: '<html>sign in</html>' }
  }

  cleanup() { fs.rmSync(this.dir, { recursive: true, force: true }) }
}
