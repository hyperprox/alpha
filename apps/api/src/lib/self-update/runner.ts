// =============================================================================
//  HyperProx — self-update: the steps, and the way back
//
//  Runs in the updater process (updater-main.ts), never inside the API.
//
//    1 preflight  disk space; the tree is clean; HEAD is still what was previewed
//    2 backup     pg_dump to <backupDir>/hyperprox-pre-update-<version>-<commit>.sql (newest 3 kept);
//                 the current commit saved as refs/hyperprox-update/previous
//    3 fetch      fetch from the configured upstream only, into refs/hyperprox-update/*;
//                 the commit must be the one confirmed and reachable from the channel's
//                 branch or tag; a signed tag is verified (required when the setting says so);
//                 checked out into a staging worktree and looked over; only then checked out
//    4 build      } deploy.sh from the new version, the same script a person runs by hand:
//    5 migrate    } install, build, migrate, keyholder, restart, nginx, monitoring. Its
//    6 restart    } "→ ..." lines say which of the three steps it is in
//    7 health     the API answers with the new commit, the web app answers, and the
//                 signed-out sign-in page answers through nginx
//
//  Anything failing after the checkout rolls back: the previous commit is checked
//  out again and deploy.sh rebuilds and restarts it. Prisma migrations only go
//  forward, so when this update applied migrations (step 5 started and the new
//  version adds some) the database is restored from the step 2 backup as well,
//  and the state says so in as many words. Before the checkout nothing has
//  changed, and nothing is undone.
//
//  Builtins only (see state.ts).
// =============================================================================

import fs from 'fs'
import path from 'path'
import type { Shell, HttpGet, RunOptions } from './shell'
import { FINAL, type StateSink, type StepId, type UpdateJob, type UpdateState } from './state'
import type { Redactor } from './redact'

export interface RunnerDeps {
  sh:     Shell
  http:   HttpGet
  state:  StateSink
  redact: Redactor
  sleep?: (ms: number) => Promise<void>
  now?:   () => Date
}

export class StepFailure extends Error {
  constructor(public step: StepId, message: string) { super(message) }
}

const SHA = /^[0-9a-f]{40}$/
const REF_NS = 'refs/hyperprox-update'
const MIGRATIONS = 'apps/api/prisma/migrations'
/** What must be in a checkout before deploy.sh from it is run. */
const REQUIRED_FILES = ['deploy.sh', 'package.json', 'pnpm-lock.yaml', 'apps/api/package.json', 'apps/api/prisma/schema.prisma', 'apps/frontend/package.json']

/** The upstream URLs an install will fetch from: https; http and local paths only for a test upstream. */
export function upstreamAllowed(url: string, allowInsecure: boolean): boolean {
  if (/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~\/-]+$/.test(url)) return true
  if (!allowInsecure) return false
  return /^http:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~\/-]+$/.test(url) || /^(file:\/\/)?\/[A-Za-z0-9._\/-]+$/.test(url)
}

/** Which of build/migrate/restart a deploy.sh "→ ..." line belongs to; null for any other line. */
export function deployPhase(line: string): 'build' | 'migrate' | 'restart' | null {
  const m = /^\s*→\s+(.*)$/.exec(line)
  if (!m) return null
  const t = m[1]
  if (/database migrations/i.test(t)) return 'migrate'
  if (/keyholder|loopback|Restarting|Swapping|gated|monitoring|Prometheus/i.test(t)) return 'restart'
  return 'build'
}

function tagName(ref: string): string | null {
  const m = /^(?:refs\/tags\/)?(v?\d+\.\d+\.\d+[0-9A-Za-z.+-]*)$/.exec(ref)
  return m ? m[1] : null
}

export async function runUpdate(job: UpdateJob, d: RunnerDeps): Promise<UpdateState> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const now = d.now ?? (() => new Date())
  const st = d.state
  const say = (l: string) => st.line(d.redact(l))
  const short = (s: string) => s.slice(0, 7)

  const setStep = (id: StepId, status: 'running' | 'done' | 'failed' | 'skipped', detail?: string) => st.update(s => {
    const x = s.steps.find(y => y.id === id)!
    x.status = status
    if (status === 'running') x.startedAt = now().toISOString()
    else x.finishedAt = now().toISOString()
    if (detail !== undefined) x.detail = d.redact(detail)
  })
  const run = async (step: StepId, cmd: string, args: string[], opts: RunOptions & { quiet?: boolean; ok?: number[] } = {}) => {
    const r = await d.sh.run(cmd, args, { cwd: job.dir, ...opts, onLine: opts.onLine ?? (opts.quiet ? undefined : say) })
    if (!(opts.ok ?? [0]).includes(r.code)) {
      const why = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' / ')
      throw new StepFailure(step, `${cmd} ${args[0] ?? ''} exited ${r.code}${why ? `: ${d.redact(why)}` : ''}`)
    }
    return r
  }
  const git = (step: StepId, args: string[], opts: RunOptions & { quiet?: boolean; ok?: number[] } = {}) =>
    // core.fileMode=false: the installer marks bin/* executable, and an exec bit is not a local change.
    run(step, 'git', ['-c', 'protocol.ext.allow=never', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fileMode=false', ...args],
        { ...opts, env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', ...(opts.env ?? {}) } })

  let checkedOut = false
  let migrationStarted = false
  let newMigrations = 0
  let failedStep: StepId | null = null
  let current: StepId = 'preflight'

  say(`Updating HyperProx ${job.from.version} (${short(job.from.sha)}) to ${job.target.label} (${short(job.target.sha)}), started by ${job.by}`)

  try {
    if (!SHA.test(job.target.sha) || !SHA.test(job.from.sha)) throw new StepFailure('preflight', 'The job names a commit that is not a full commit id.')
    const allowInsecure = process.env.HYPERPROX_UPDATE_INSECURE_UPSTREAM === '1'
    for (const u of [job.repoUrl, job.mirrorUrl].filter(Boolean) as string[]) {
      if (!upstreamAllowed(u, allowInsecure)) throw new StepFailure('preflight', `The upstream ${u} is not an https URL; nothing was fetched.`)
    }

    // --- 1 preflight -------------------------------------------------------------------------
    current = 'preflight'; setStep('preflight', 'running')
    const df = await run('preflight', 'df', ['-Pk', job.dir], { quiet: true })
    const freeKiB = Number((df.stdout.trim().split('\n').pop() ?? '').split(/\s+/)[3])
    if (!Number.isFinite(freeKiB)) throw new StepFailure('preflight', 'Could not read the free disk space.')
    const freeMiB = Math.floor(freeKiB / 1024)
    if (freeMiB < job.minFreeMiB) throw new StepFailure('preflight', `Only ${freeMiB} MiB free where HyperProx is installed; an update needs ${job.minFreeMiB} MiB (dependencies, two builds and a database backup).`)
    const dirty = (await git('preflight', ['status', '--porcelain', '--untracked-files=no'], { quiet: true })).stdout.trim()
    if (dirty) throw new StepFailure('preflight', `The install has local changes, so it was not updated: ${dirty.split('\n').slice(0, 10).map(l => l.trim()).join(', ')}`)
    const head = (await git('preflight', ['rev-parse', 'HEAD'], { quiet: true })).stdout.trim()
    if (head !== job.from.sha) throw new StepFailure('preflight', `The install is at ${short(head)}, not ${short(job.from.sha)} as when this update was previewed. Preview it again.`)
    setStep('preflight', 'done', `${freeMiB} MiB free, no local changes`)

    // --- 2 backup ----------------------------------------------------------------------------
    current = 'backup'; setStep('backup', 'running')
    const env = readEnv(path.join(job.dir, '.env'))
    const pgUser = env.POSTGRES_USER, pgDb = env.POSTGRES_DB
    if (!pgUser || !pgDb) throw new StepFailure('backup', 'POSTGRES_USER and POSTGRES_DB are not in .env, so the database could not be backed up.')
    fs.mkdirSync(job.backupDir, { recursive: true, mode: 0o700 })
    const safeVer = job.from.version.replace(/[^0-9A-Za-z.+-]/g, '_')
    const backupFile = path.join(job.backupDir, `hyperprox-pre-update-${safeVer}-${short(job.from.sha)}.sql`)
    const partial = `${backupFile}.partial`
    await run('backup', 'docker', ['exec', 'hyperprox-postgres', 'pg_dump', '-U', pgUser, '-d', pgDb, '--no-owner'], { stdoutFile: partial, quiet: true, timeoutMs: 15 * 60_000 })
    const tail = readTail(partial, 4096)
    if (!/PostgreSQL database dump complete/.test(tail)) throw new StepFailure('backup', 'The database backup did not finish (no "dump complete" at its end).')
    fs.renameSync(partial, backupFile)
    fs.chmodSync(backupFile, 0o600)
    st.update(s => { s.backupFile = backupFile })
    pruneBackups(job.backupDir, job.keepBackups, backupFile)
    await git('backup', ['update-ref', `${REF_NS}/previous`, job.from.sha], { quiet: true })
    setStep('backup', 'done', `${backupFile} (${fs.statSync(backupFile).size} bytes); previous commit ${short(job.from.sha)}`)

    // --- 3 fetch, verify, stage, check out -----------------------------------------------------
    current = 'fetch'; setStep('fetch', 'running')
    const tag = job.target.channel === 'stable' ? tagName(job.target.ref) : null
    if (job.target.channel === 'stable' && !tag) throw new StepFailure('fetch', `"${job.target.ref}" is not a release tag.`)
    const branch = job.target.channel === 'alpha' ? job.target.ref : 'main'
    if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(branch) || branch.includes('..')) throw new StepFailure('fetch', `"${branch}" is not a branch name.`)
    const refspecs = [`+refs/heads/${branch}:${REF_NS}/heads/${branch}`]
    if (tag) refspecs.push(`+refs/tags/${tag}:${REF_NS}/tags/${tag}`)
    let fetchedFrom = job.repoUrl
    const fetchArgs = (url: string) => ['-c', 'protocol.file.allow=' + (allowInsecure ? 'always' : 'never'), 'fetch', '--no-tags', '--no-recurse-submodules', '--quiet', url, ...refspecs]
    try { await git('fetch', fetchArgs(job.repoUrl), { timeoutMs: 10 * 60_000 }) }
    catch (e) {
      if (!job.mirrorUrl) throw e
      say(`! ${job.repoUrl} could not be fetched; trying the mirror ${job.mirrorUrl}`)
      fetchedFrom = job.mirrorUrl
      await git('fetch', fetchArgs(job.mirrorUrl), { timeoutMs: 10 * 60_000 })
    }
    const revParse = async (r: string) => (await git('fetch', ['rev-parse', '--verify', '--quiet', r], { quiet: true, ok: [0, 1] })).stdout.trim()
    if (tag) {
      const peeled = await revParse(`${REF_NS}/tags/${tag}^{commit}`)
      if (peeled !== job.target.sha) throw new StepFailure('fetch', `The tag ${tag} at ${fetchedFrom} points at ${short(peeled || 'nothing')}, not ${short(job.target.sha)} as confirmed. Nothing was changed.`)
      const kind = (await git('fetch', ['cat-file', '-t', `${REF_NS}/tags/${tag}`], { quiet: true })).stdout.trim()
      const raw = kind === 'tag' ? (await git('fetch', ['cat-file', 'tag', `${REF_NS}/tags/${tag}`], { quiet: true })).stdout : ''
      const signed = /-----BEGIN (PGP|SSH) SIGNATURE-----/.exec(raw)
      if (!signed) {
        if (job.requireSigned) throw new StepFailure('fetch', `The release ${tag} is not signed, and this install requires signed releases. Nothing was changed.`)
        say(`  ${tag} is not a signed tag (signed releases are not required here)`)
      } else if (!job.trustedKeys) {
        if (job.requireSigned) throw new StepFailure('fetch', `The release ${tag} is signed, but no trusted keys are configured to check it against, and this install requires signed releases. Nothing was changed.`)
        say(`  ${tag} is signed (${signed[1]}); no trusted keys are configured here, so the signature was not checked`)
      } else {
        const ok = await verifyTag(d, job, `${REF_NS}/tags/${tag}`, signed[1] as 'PGP' | 'SSH')
        if (!ok) throw new StepFailure('fetch', `The signature on ${tag} does not verify against the trusted keys. Nothing was changed.`)
        say(`  ${tag}: signature verified against the trusted keys`)
      }
    } else {
      if (job.requireSigned) throw new StepFailure('fetch', 'The alpha channel follows unsigned commits on main, and this install requires signed releases. Switch to the stable channel or turn the setting off.')
      const tip = await revParse(`${REF_NS}/heads/${branch}`)
      if (!tip) throw new StepFailure('fetch', `${branch} was not found at ${fetchedFrom}.`)
      const anc = await git('fetch', ['merge-base', '--is-ancestor', job.target.sha, tip], { quiet: true, ok: [0, 1, 128] })
      if (anc.code !== 0) throw new StepFailure('fetch', `${short(job.target.sha)} is not on ${branch} at ${fetchedFrom}, so it was refused. Nothing was changed.`)
    }

    // Staging: look the new version over in a worktree of its own before running any of it.
    const staging = path.join(job.dir, 'data', 'self-update', `staging-${job.id}`)
    await git('fetch', ['worktree', 'add', '--detach', '--quiet', staging, job.target.sha], { quiet: true })
    let stagedVersion: string | null = null
    try {
      const missing = REQUIRED_FILES.filter(f => !fs.existsSync(path.join(staging, f)))
      if (missing.length) throw new StepFailure('fetch', `The new version is missing ${missing.join(', ')}; it was not installed.`)
      const deploy = fs.readFileSync(path.join(staging, 'deploy.sh'), 'utf8')
      if (!/prisma migrate deploy/.test(deploy) || !/systemctl restart hyperprox-api/.test(deploy)) throw new StepFailure('fetch', 'The new version\'s deploy.sh is not one this updater knows how to follow; it was not installed.')
      try { stagedVersion = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8')).version ?? null } catch { stagedVersion = null }
    } finally {
      await git('fetch', ['worktree', 'remove', '--force', staging], { quiet: true, ok: [0, 1, 128] }).catch(() => undefined)
    }
    const added = (await git('fetch', ['diff', '--name-only', '--diff-filter=A', job.from.sha, job.target.sha, '--', MIGRATIONS], { quiet: true, ok: [0, 128] })).stdout
    newMigrations = added.split('\n').filter(l => /\/migration\.sql$/.test(l)).length
    // By content (blob id): a mode-only change does not make install-keyholder restart it.
    const blob = async (sha: string) => (await git('fetch', ['rev-parse', '--verify', '--quiet', `${sha}:bin/hyperprox-keyholder`], { quiet: true, ok: [0, 1, 128] })).stdout.trim()
    const keyholderChanged = (await blob(job.from.sha)) !== (await blob(job.target.sha))
    if (keyholderChanged) say('! This version changes the keyholder: HyperProx locks when it restarts, and someone has to sign in again.')

    await checkout(job, job.target.sha, git, 'fetch')
    checkedOut = true
    setStep('fetch', 'done', `${job.target.label} from ${fetchedFrom}${stagedVersion ? `, version ${stagedVersion}` : ''}; ${newMigrations} new database migration${newMigrations === 1 ? '' : 's'}`)

    // --- 4-6 deploy.sh ---------------------------------------------------------------------------
    current = 'build'; setStep('build', 'running')
    const r = await deploy(job, d, (phase) => {
      if (phase === current || (phase === 'build' && current !== 'build')) return
      setStep(current, 'done')
      current = phase
      if (phase === 'migrate') { migrationStarted = true; st.update(s => { s.migrationsApplied = newMigrations > 0 }) }
      setStep(phase, 'running')
    }, say)
    if (r.code !== 0) throw new StepFailure(current, `deploy.sh stopped during "${STEP_TITLE[current]}" (exit ${r.code}).`)
    for (const id of ['build', 'migrate', 'restart'] as StepId[]) {
      const x = st.get().steps.find(y => y.id === id)!
      if (x.status === 'running') setStep(id, 'done')
      else if (x.status === 'pending') setStep(id, 'skipped')
    }

    // --- 7 health ----------------------------------------------------------------------------------
    current = 'health'; setStep('health', 'running')
    const h = await healthCheck(job, d, job.target.sha, sleep)
    if (!h.ok) throw new StepFailure('health', h.why)
    setStep('health', 'done', h.why)
    setStep('rollback', 'skipped')
    st.update(s => { s.status = 'succeeded'; s.finishedAt = now().toISOString(); s.summary = `HyperProx is now ${job.target.label} (${short(job.target.sha)}).` })
    say(`✓ ${st.get().summary}`)
    st.flush()
    return st.get()
  } catch (e: any) {
    failedStep = e instanceof StepFailure ? e.step : current
    const why = d.redact(String(e?.message ?? e))
    setStep(failedStep, 'failed', why)
    for (const x of st.get().steps) if (x.status === 'pending' && x.id !== 'rollback') setStep(x.id, 'skipped')
    say(`✗ ${why}`)
    if (!checkedOut) {
      setStep('rollback', 'skipped', 'Nothing had been changed, so there was nothing to roll back.')
      st.update(s => { s.status = 'failed'; s.finishedAt = now().toISOString(); s.summary = `The update stopped before anything was changed: ${why}` })
      st.flush()
      return st.get()
    }
  }

  // --- rollback ----------------------------------------------------------------------------------------
  setStep('rollback', 'running')
  const restoreDb = migrationStarted && newMigrations > 0
  say(`↩ Rolling back to ${job.from.version} (${short(job.from.sha)})${restoreDb ? ' and restoring the database from the backup' : ''}`)
  try {
    await checkout(job, job.from.sha, git, 'rollback')
    if (restoreDb) {
      const file = st.get().backupFile
      if (!file) throw new StepFailure('rollback', 'There is no database backup to restore.')
      say(`↩ This update applied database migrations, which only go forward. Restoring the database from ${file}; anything written to HyperProx since the update started is lost.`)
      await run('rollback', 'systemctl', ['stop', 'hyperprox-api'], { ok: [0, 5] })
      const env = readEnv(path.join(job.dir, '.env'))
      await run('rollback', 'docker', ['exec', '-i', 'hyperprox-postgres', 'psql', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB],
        { stdin: [{ text: 'DROP SCHEMA public CASCADE;\nCREATE SCHEMA public;\n' }, { file }], quiet: true, timeoutMs: 15 * 60_000 })
      st.update(s => { s.dbRestored = true })
      say('↩ Database restored from the backup taken before the update.')
    }
    const r = await deploy(job, d, () => undefined, say)
    if (r.code !== 0) throw new StepFailure('rollback', `deploy.sh of the previous version failed too (exit ${r.code}).`)
    const h = await healthCheck(job, d, job.from.sha, sleep)
    if (!h.ok) throw new StepFailure('rollback', `The previous version is back but not healthy: ${h.why}`)
    setStep('rollback', 'done', `Back on ${job.from.version} (${short(job.from.sha)})${st.get().dbRestored ? '; the database was restored from the backup' : '; the database was not touched'}`)
    st.update(s => {
      s.status = 'rolled-back'; s.finishedAt = now().toISOString()
      s.summary = `The update failed at "${STEP_TITLE[failedStep!]}" and was rolled back to ${job.from.version} (${short(job.from.sha)}).` +
        (s.dbRestored ? ' The database was restored from the backup taken before the update.' : ' The database was not restored (no migration had run).')
    })
  } catch (e: any) {
    const why = d.redact(String(e?.message ?? e))
    setStep('rollback', 'failed', why)
    st.update(s => {
      s.status = 'rollback-failed'; s.finishedAt = now().toISOString()
      s.summary = `The update failed at "${STEP_TITLE[failedStep!]}", and rolling back failed too: ${why} The previous commit is saved as ${REF_NS}/previous` +
        (s.backupFile ? ` and the database backup is ${s.backupFile}.` : '.') + ' Run deploy.sh by hand once it is fixed.'
    })
  }
  say(`${st.get().status === 'rolled-back' ? '↩' : '✗'} ${st.get().summary}`)
  st.flush()
  return st.get()
}

const STEP_TITLE: Record<StepId, string> = {
  preflight: 'preflight checks', backup: 'database backup', fetch: 'fetch and verify', build: 'install and build',
  migrate: 'database migrations', restart: 'restart', health: 'health check', rollback: 'rollback',
}

async function checkout(job: UpdateJob, sha: string, git: (s: StepId, a: string[], o?: any) => Promise<any>, step: StepId) {
  // Stay on the branch the install is on (main, for an install.sh clone), so a later install.sh or a
  // person's `git pull` still works. The tree is clean (preflight), so nothing local is lost; the commit
  // being left is kept as refs/hyperprox-update/previous.
  if (job.from.branch) await git(step, ['checkout', '--quiet', '-B', job.from.branch, sha], { quiet: true })
  else await git(step, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', sha], { quiet: true })
}

async function deploy(job: UpdateJob, d: RunnerDeps, onPhase: (p: 'build' | 'migrate' | 'restart') => void, say: (l: string) => void) {
  return d.sh.run('bash', [path.join(job.dir, 'deploy.sh')], {
    cwd: job.dir,
    env: { HYPERPROX_DIR: job.dir, ...(job.lockHeld ? { HYPERPROX_DEPLOY_LOCK_HELD: '1' } : {}), CI: '1', NO_COLOR: '1' },
    timeoutMs: 60 * 60_000,
    onLine: (l) => { const p = deployPhase(l); if (p) onPhase(p); say(l) },
  })
}

async function verifyTag(d: RunnerDeps, job: UpdateJob, ref: string, kind: 'PGP' | 'SSH'): Promise<boolean> {
  const base = ['-c', 'protocol.ext.allow=never']
  if (kind === 'SSH') {
    const r = await d.sh.run('git', [...base, '-c', `gpg.ssh.allowedSignersFile=${job.trustedKeys}`, 'verify-tag', ref], { cwd: job.dir })
    return r.code === 0
  }
  // GPG: a keyring of only the trusted keys, thrown away afterwards.
  const home = fs.mkdtempSync(path.join(job.dir, 'data', 'self-update', 'gnupg-'))
  try {
    fs.chmodSync(home, 0o700)
    const imp = await d.sh.run('gpg', ['--batch', '--quiet', '--import', job.trustedKeys!], { env: { GNUPGHOME: home } })
    if (imp.code !== 0) return false
    const r = await d.sh.run('git', [...base, 'verify-tag', ref], { cwd: job.dir, env: { GNUPGHOME: home } })
    return r.code === 0
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

/** Polls until the API answers with `sha`, the web app answers, and nginx serves the signed-out sign-in page. */
export async function healthCheck(job: UpdateJob, d: RunnerDeps, sha: string, sleep: (ms: number) => Promise<void>): Promise<{ ok: boolean; why: string }> {
  const deadline = Date.now() + job.health.timeoutMs
  let last = 'nothing answered yet'
  for (let i = 0; ; i++) {
    const api = await d.http(job.health.api, { timeoutMs: 5000 })
    let commit = ''
    try { commit = String(JSON.parse(api.body)?.commit ?? '') } catch { /* not json */ }
    if (api.status !== 200) last = `the API answered ${api.status || 'nothing'}`
    else if (!commit || !sha.startsWith(commit)) last = `the API is running ${commit || 'an unknown commit'}, not ${sha.slice(0, 7)}`
    else {
      const fe = await d.http(job.health.frontend, { timeoutMs: 5000 })
      if (fe.status !== 200) last = `the web app answered ${fe.status || 'nothing'}`
      else {
        const ng = await d.http(job.health.nginx, { insecure: true, timeoutMs: 5000 })
        if (ng.status !== 200) last = `the sign-in page through nginx answered ${ng.status || 'nothing'}`
        else return { ok: true, why: `API on ${commit}, web app and sign-in page answer` }
      }
    }
    if (Date.now() >= deadline) return { ok: false, why: `Health check failed: ${last}.` }
    await sleep(i < 5 ? 2000 : 4000)
  }
}

export function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return out }
  for (const raw of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

function readTail(file: string, n: number): string {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const len = Math.min(n, size)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len)
      return buf.toString('utf8')
    } finally { fs.closeSync(fd) }
  } catch { return '' }
}

/** Keep the newest `keep` pre-update backups (by modification time); `current` is never removed. */
export function pruneBackups(dir: string, keep: number, current?: string): string[] {
  const all = fs.readdirSync(dir)
    .filter(f => /^hyperprox-pre-update-.+\.sql$/.test(f))
    .map(f => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t || (a.f === current ? -1 : b.f === current ? 1 : 0))
  const removed: string[] = []
  for (const x of all.slice(Math.max(keep, 1))) {
    if (x.f === current) continue
    fs.rmSync(x.f, { force: true })
    removed.push(x.f)
  }
  return removed
}

export const isFinal = (s: UpdateState | null) => !!s && FINAL.includes(s.status)
