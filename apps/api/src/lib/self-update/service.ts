// =============================================================================
//  HyperProx — self-update: the API's side
//
//  Checks for a newer HyperProx (every N hours and on demand), previews an
//  update, refuses one when it is not safe to start, and starts the updater in
//  a process of its own. After the API comes back (the update restarts it) it
//  reads the updater's state file, so the page shows the run continuing, and
//  the API that is running at the end — the new one, or the old one after a
//  rollback — writes the closing audit row and sends the closing notification.
//
//  This updates HyperProx, in the directory it runs from, and nothing else: no
//  other guest, container or host is touched.
// =============================================================================

import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import type { Shell } from './shell'
import { FINAL, initialState, readState, writeJsonAtomic, STEP_LABELS, type UpdateJob, type UpdateState } from './state'
import { makeRedactor, envSecrets, type Redactor } from './redact'
import { findUpdate, type AvailableUpdate, type CheckResult, type Installed } from './check'
import { RateLimitedError, type Upstream } from './upstream'
import { inWindow, mergeSettings, SettingsError, SettingsStore, type SelfUpdateSettings } from './settings'
import { effectiveChannel, installedLabel, type ChannelSource } from './channel'
import type { Channel } from './state'
import { upstreamAllowed } from './runner'

export interface Refusal { code: string; text: string; detail?: string[] }

export interface SelfUpdateConfig {
  repoUrl:     string
  mirrorUrl:   string | null
  trustedKeys: string | null
  allowInsecure: boolean
}

export interface SelfUpdateDeps {
  dir:        string
  dataDir:    string
  sh:         Shell
  config:     SelfUpdateConfig
  upstreams:  () => Upstream[]
  isUnlocked: () => boolean
  publish:    (e: { type: string; severity: 'info' | 'warning' | 'critical'; title: string; lines?: string[]; link?: string; where?: string; fingerprint?: string }) => Promise<void>
  /** Throws when the row could not be written; an install is refused rather than left unaudited. */
  audit:      (action: string, details: Record<string, unknown>) => Promise<void>
  /** Starts the updater. Production: systemd-run (launchUpdater below). */
  launch:     (job: UpdateJob, jobFile: string) => Promise<void>
  lockFile:   string
  backupDir:  string
  /** The commit the running API was built from (lib/version.ts). */
  runningSha: string
  now?:       () => Date
  log?:       (m: string) => void
  minFreeMiB?: number
  health?:    UpdateJob['health']
}

const PATHS = (dataDir: string) => ({
  settings: path.join(dataDir, 'settings.json'),
  check:    path.join(dataDir, 'check.json'),
  state:    path.join(dataDir, 'state.json'),
  reported: path.join(dataDir, 'reported.json'),
  attempts: path.join(dataDir, 'auto-attempts.json'),
  jobs:     path.join(dataDir, 'jobs'),
  logs:     path.join(dataDir, 'logs'),
})

/** How long a just-started job may show "running" without its process before it counts as interrupted. */
const START_GRACE_MS = 90_000

export class SelfUpdateService {
  private p: ReturnType<typeof PATHS>
  private store: SettingsStore
  private timer: NodeJS.Timeout | null = null
  private checking: Promise<CheckResult> | null = null
  /** The last installed() answer, so the sync settings() can default the channel from it. */
  private lastInstalled: Installed | null = null
  private redact: Redactor
  constructor(private d: SelfUpdateDeps) {
    this.p = PATHS(d.dataDir)
    this.store = new SettingsStore(this.p.settings)
    let env = ''
    try { env = fs.readFileSync(path.join(d.dir, '.env'), 'utf8') } catch { /* shapes only */ }
    this.redact = makeRedactor(envSecrets(env))
  }
  private now() { return (this.d.now ?? (() => new Date()))() }
  config(): SelfUpdateConfig { return this.d.config }

  // --- settings --------------------------------------------------------------------------------------

  /** The settings in effect: with trusted keys configured in .env, signatures are required whatever the file says. */
  settings(): SelfUpdateSettings {
    const s = this.store.load()
    if (this.d.config.trustedKeys) s.requireSigned = true
    s.channel = this.channelInfo(s).channel
    return s
  }
  /** Which channel is in effect and why: a chosen one, or the default for this kind of install (channel.ts). */
  channelInfo(s = this.store.load()): { channel: Channel; source: ChannelSource; why: string } {
    return effectiveChannel({ chosen: this.store.chosenChannel(), installed: this.lastInstalled, autoInstall: s.autoInstall })
  }
  /** settings(), after reading what is installed (the channel default depends on it). */
  async effectiveSettings(): Promise<SelfUpdateSettings> {
    await this.installed().catch(() => null)
    return this.settings()
  }
  /** Settings the page cannot change, and why. */
  locks(): { requireSigned?: string } {
    return this.d.config.trustedKeys ? { requireSigned: 'Trusted keys are configured in .env (HYPERPROX_UPDATE_TRUSTED_KEYS), so signed releases are always required.' } : {}
  }
  /** Why automatic install cannot be turned on here, or null. */
  autoInstallBlocked(s = this.settings()): string | null {
    if (!this.d.config.trustedKeys || !s.requireSigned) return 'Automatic install needs every release checked against trusted keys: set HYPERPROX_UPDATE_TRUSTED_KEYS in .env (an SSH allowed_signers or GPG key file). Until then, updates are installed by a person.'
    return null
  }
  async saveSettings(patch: unknown, by: string): Promise<SelfUpdateSettings> {
    // From the settings in effect: saving the window must not quietly switch a defaulted channel.
    const before = await this.effectiveSettings()
    const chosen = this.store.chosenChannel() !== null || (patch as any)?.channel !== undefined
    if (this.d.config.trustedKeys && (patch as any)?.requireSigned === false) throw new SettingsError(this.locks().requireSigned!)
    const next = mergeSettings(before, patch)
    if (this.d.config.trustedKeys) next.requireSigned = true
    if (next.autoInstall) { const why = this.autoInstallBlocked(next); if (why) throw new SettingsError(why) }
    this.store.saveWithout(next, !chosen)
    const changed = Object.keys(next).filter(k => JSON.stringify((next as any)[k]) !== JSON.stringify((before as any)[k]))
    await this.d.audit('self-update.settings', { by, changed, channel: next.channel, autoInstall: next.autoInstall, requireSigned: next.requireSigned })
    return next
  }

  // --- what is installed -----------------------------------------------------------------------------

  async installed(): Promise<Installed> {
    const git = async (args: string[]) => {
      const r = await this.d.sh.run('git', args, { cwd: this.d.dir })
      return r.code === 0 ? r.stdout.trim() : ''
    }
    const sha = await git(['rev-parse', 'HEAD'])
    let version = 'unknown'
    try { version = JSON.parse(fs.readFileSync(path.join(this.d.dir, 'package.json'), 'utf8')).version ?? 'unknown' } catch { /* stays unknown */ }
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      // An unpacked archive: VERSION carries what `git archive` wrote into it.
      const v = readVersionFile(this.d.dir)
      const inst: Installed = { version: v?.version || version, sha: v?.sha ?? '', describe: v?.describe || version, branch: null, git: false }
      const l = installedLabel(inst)
      return (this.lastInstalled = { ...inst, tagged: l.tagged, label: l.label, display: l.display })
    }
    const branch = await git(['symbolic-ref', '--short', '-q', 'HEAD'])
    const describe = await git(['describe', '--tags', '--always'])
    const inst: Installed = { version, sha, describe: describe || sha.slice(0, 7), branch: branch || null, git: true }
    const l = installedLabel(inst)
    return (this.lastInstalled = { ...inst, tagged: l.tagged, label: l.label, display: l.display })
  }

  // --- check -------------------------------------------------------------------------------------------

  lastCheck(): CheckResult | null {
    try { return JSON.parse(fs.readFileSync(this.p.check, 'utf8')) } catch { return null }
  }

  /** Ask upstream (one check at a time). Never throws: the result carries the error. */
  check(): Promise<CheckResult> {
    if (!this.checking) this.checking = this.doCheck().finally(() => { this.checking = null })
    return this.checking
  }

  private async doCheck(): Promise<CheckResult> {
    const inst = await this.installed()
    const s = this.settings()
    const errors: string[] = []
    let result: CheckResult | null = null
    if (!inst.git) {
      result = { checkedAt: this.now().toISOString(), source: null, available: null, note: '', error: 'This install is not a git checkout, so it cannot update itself. Reinstall with install.sh to get updates here.' }
    } else {
      for (const up of this.d.upstreams()) {
        try {
          const r = await findUpdate(inst, s.channel, up, { includePrereleases: s.includePrereleases })
          result = { checkedAt: this.now().toISOString(), source: up.where, fromMirror: !!up.mirror, available: r.available, note: r.note, error: null }
          break
        } catch (e: any) {
          errors.push(e instanceof RateLimitedError ? `${up.where}: rate limit reached until ${e.until.toISOString()}` : `${up.where}: ${e?.message ?? e}`)
        }
      }
      if (!result) result = { checkedAt: this.now().toISOString(), source: null, available: null, note: '', error: `Could not check for updates. ${errors.join('; ')}` }
    }
    const prev = this.lastCheck() as (CheckResult & { notifiedSha?: string }) | null
    let notifiedSha = prev?.notifiedSha
    if (result.available && s.notify && result.available.sha !== notifiedSha) {
      try {
        await this.d.publish({
          type: 'updates.self.available', severity: result.available.flags.breaking.length ? 'warning' : 'info',
          title: `HyperProx ${result.available.label} is available`,
          lines: [`Installed: ${inst.version} (${inst.sha.slice(0, 7)})`, `Channel: ${s.channel}`,
                  ...(result.available.flags.breaking.length ? [`Breaking or migration notes: ${result.available.flags.breaking.length}`] : [])],
          link: '/updates#hyperprox', where: 'Updates page', fingerprint: `updates.self.available:${result.available.sha}`,
        })
        notifiedSha = result.available.sha
      } catch (e: any) { this.d.log?.(`[self-update] could not send the notification: ${e?.message ?? e}`) }
    }
    writeJsonAtomic(this.p.check, { ...result, channel: s.channel, notifiedSha })
    return result
  }

  // --- the job ------------------------------------------------------------------------------------------

  /** The current or last run, read from the updater's state file; a run whose process is gone is marked interrupted. */
  async job(): Promise<UpdateState | null> {
    const s = readState(this.p.state)
    if (!s) return null
    if (s.status === 'running' && Date.now() - Date.parse(s.startedAt) > START_GRACE_MS && !(await this.updaterAlive(s))) {
      s.status = 'interrupted'
      s.finishedAt = this.now().toISOString()
      s.summary = 'The updater stopped without finishing (the machine restarted, or it was killed). Check the version below and the log; deploy.sh can finish or redo a deploy by hand.'
      for (const x of s.steps) if (x.status === 'running') x.status = 'failed'
      writeJsonAtomic(this.p.state, s)
    }
    // Written already redacted by the updater; redacted again on the way out.
    return { ...s, log: s.log.map(this.redact), summary: s.summary && this.redact(s.summary), steps: s.steps.map(x => ({ ...x, detail: x.detail && this.redact(x.detail) })) }
  }

  private async updaterAlive(s: UpdateState): Promise<boolean> {
    if (await this.lockBusy()) return true
    if (!s.unit) return false
    const r = await this.d.sh.run('systemctl', ['is-active', '--quiet', s.unit])
    return r.code === 0
  }

  /** The deploy lock: held by deploy.sh while it runs, and by the updater for the whole update. */
  async lockBusy(): Promise<boolean> {
    if (!fs.existsSync(this.d.lockFile)) return false
    const r = await this.d.sh.run('flock', ['-n', '-E', '75', this.d.lockFile, 'true'])
    return r.code === 75
  }

  // --- guards ---------------------------------------------------------------------------------------------

  async refusals(available: AvailableUpdate | null, settings = this.settings()): Promise<{ refusals: Refusal[]; inst: Installed; untracked: string[] }> {
    const out: Refusal[] = []
    const inst = await this.installed()
    let untracked: string[] = []
    if (!this.d.isUnlocked()) out.push({ code: 'locked', text: 'HyperProx is locked. Sign in first.' })
    const job = await this.job()
    if (job?.status === 'running') out.push({ code: 'update_running', text: 'An update is already running.' })
    else if (await this.lockBusy()) out.push({ code: 'deploy_running', text: 'A deploy (deploy.sh) is running right now. Try again when it has finished.' })
    if (!inst.git) out.push({ code: 'not_git', text: 'This install is not a git checkout, so it cannot update itself. Reinstall with install.sh.' })
    else {
      // An exec bit is not a local change: the installer marks bin/* executable (and the updater ignores modes too).
      const st = await this.d.sh.run('git', ['-c', 'core.fileMode=false', 'status', '--porcelain', '--untracked-files=normal'], { cwd: this.d.dir })
      const lines = st.stdout.split('\n').filter(Boolean)
      const changed = lines.filter(l => !l.startsWith('??'))
      untracked = lines.filter(l => l.startsWith('??')).map(l => l.slice(3))
      if (st.code !== 0) out.push({ code: 'git_status', text: 'Could not read the install\'s git status.' })
      else if (changed.length) out.push({ code: 'dirty', text: `The install has ${changed.length} local change${changed.length === 1 ? '' : 's'}. Commit, stash or undo ${changed.length === 1 ? 'it' : 'them'} first; an update never overwrites local work.`, detail: changed.slice(0, 50).map(l => l.trim()) })
    }
    if (inst.git && this.d.runningSha && inst.sha && !inst.sha.startsWith(this.d.runningSha)) {
      out.push({ code: 'not_deployed', text: `The checkout (${inst.sha.slice(0, 7)}) is not what is running (${this.d.runningSha}). Finish that deploy first (deploy.sh).` })
    }
    if (settings.requireSigned && settings.channel === 'alpha') out.push({ code: 'unsigned_channel', text: 'Signed releases are required, and the alpha channel follows unsigned commits. Switch to stable, or turn the requirement off.' })
    if (settings.requireSigned && !this.d.config.trustedKeys) out.push({ code: 'no_trusted_keys', text: 'Signed releases are required, but no trusted keys are configured (HYPERPROX_UPDATE_TRUSTED_KEYS).' })
    if (!upstreamAllowed(this.d.config.repoUrl, this.d.config.allowInsecure)) out.push({ code: 'bad_upstream', text: `The configured upstream ${this.d.config.repoUrl} is not an https URL.` })
    if (!available) out.push({ code: 'no_update', text: 'There is no update to install.' })
    return { refusals: out, inst, untracked }
  }

  async preview() {
    const check = this.lastCheck()
    const available = check?.available ?? null
    const settings = await this.effectiveSettings()
    const { refusals, inst, untracked } = await this.refusals(available, settings)
    const warnings: string[] = []
    const free = await this.freeMiB()
    const need = this.d.minFreeMiB ?? 3072
    if (free !== null && free < need) refusals.push({ code: 'disk', text: `Only ${free} MiB free; an update needs ${need} MiB.` })
    if (available) {
      if (available.flags.unknownBase) warnings.push(`Upstream does not contain this install's commit ${inst.sha.slice(0, 7)} (local commits, or upstream rewrote its history). The update would move ${inst.branch ?? 'the checkout'} to ${available.label}, which may be older; type its name to confirm. The commit being left is kept as refs/hyperprox-update/previous.`)
      if (available.flags.migrations.length) warnings.push(`${available.flags.migrations.length} database migration${available.flags.migrations.length === 1 ? '' : 's'} will run. Migrations only go forward: if the update then fails, the database is restored from the backup taken first, and anything written in between is lost.`)
      else if (available.flags.filesUnknown) warnings.push('Upstream did not say which files change; whether migrations run is checked after fetching.')
      if (available.flags.keyholder) warnings.push('This version changes the keyholder, so HyperProx locks once when it restarts: someone has to sign in again.')
      if (available.flags.breaking.length) warnings.push(`Breaking or migration notes: ${available.flags.breaking.join(' · ')}`)
      if (available.channel === 'stable' && available.signature) {
        const sig = available.signature
        if (!sig.signed) warnings.push(settings.requireSigned ? 'This release is not signed; it will be refused.' : 'This release is not a signed tag.')
        else if (!this.d.config.trustedKeys) warnings.push('This release is signed, but no trusted keys are configured here to check it with.')
      }
    }
    if (untracked.length) warnings.push(`${untracked.length} untracked file${untracked.length === 1 ? '' : 's'} in the install (left alone): ${untracked.slice(0, 5).join(', ')}${untracked.length > 5 ? ', …' : ''}`)
    const keyholder = await this.d.sh.run('systemctl', ['is-active', '--quiet', 'hyperprox-keyholder'])
    if (keyholder.code !== 0) warnings.push('The keyholder is not running, so the restart will lock HyperProx: someone has to sign in again.')
    const steps = [
      `${STEP_LABELS.preflight}: at least ${need} MiB free`,
      `${STEP_LABELS.backup}: pg_dump to ${this.d.backupDir}/hyperprox-pre-update-${inst.version}-${inst.sha.slice(0, 7)}.sql (the newest 3 are kept); commit ${inst.sha.slice(0, 7)} saved`,
      `${STEP_LABELS.fetch}: ${available ? `${available.label} (${available.sha.slice(0, 7)})` : 'nothing'} from ${this.d.config.repoUrl}${this.d.config.mirrorUrl ? ` (mirror: ${this.d.config.mirrorUrl})` : ''}; checked into a staging worktree before anything in it runs`,
      `${STEP_LABELS.build}, ${STEP_LABELS.migrate.toLowerCase()} and restart: deploy.sh from the new version, as when updating by hand`,
      `${STEP_LABELS.health}`,
      'If anything after the checkout fails: back to the previous commit, rebuilt and restarted; the database is restored from the backup only if its record of applied migrations changed',
    ]
    return { installed: inst, target: available, refusals, warnings, steps, disk: { freeMiB: free, needMiB: need }, untracked,
             confirmUnrelated: available?.flags.unknownBase ? available.label : null }
  }

  private async freeMiB(): Promise<number | null> {
    const r = await this.d.sh.run('df', ['-Pk', this.d.dir])
    const n = Number((r.stdout.trim().split('\n').pop() ?? '').split(/\s+/)[3])
    return r.code === 0 && Number.isFinite(n) ? Math.floor(n / 1024) : null
  }

  /** Start an update to `sha`, which must be the update the last check offered. */
  async install(by: string, sha: string, how: 'manual' | 'auto' = 'manual', opts: { confirmUnrelated?: string } = {}): Promise<UpdateState> {
    const check = this.lastCheck()
    const available = check?.available ?? null
    const settings = await this.effectiveSettings()
    const { refusals, inst } = await this.refusals(available, settings)
    if (available && sha !== available.sha) refusals.push({ code: 'stale_target', text: 'The update on offer has changed since this page loaded. Check again.' })
    if (how === 'auto' && (available?.channel !== 'stable' || settings.channel !== 'stable')) refusals.push({ code: 'auto_stable_only', text: 'Automatic install only installs stable releases.' })
    if (how === 'auto') {
      const blocked = this.autoInstallBlocked(settings)
      if (blocked) refusals.push({ code: 'auto_unsigned', text: blocked })
      if ((check as any)?.fromMirror) refusals.push({ code: 'auto_mirror', text: 'This update was found on the mirror, not the configured upstream; automatic install never takes it from a mirror.' })
      if (this.autoAttemptRefused(sha)) refusals.push({ code: 'auto_attempted', text: 'Automatic install already tried this version and it did not succeed; it is not tried again on its own.' })
    }
    // A move to a commit that does not contain the installed one: a person types the label, and never automatically.
    const unrelated = !!available?.flags.unknownBase
    if (unrelated && how === 'auto') refusals.push({ code: 'auto_unrelated', text: 'This update does not contain the installed commit; automatic install never makes that move.' })
    else if (unrelated && opts.confirmUnrelated !== available!.label) {
      refusals.push({ code: 'confirm_unrelated', text: `Upstream does not contain this install's commit ${inst.sha.slice(0, 7)} (other history, or local commits). To move to ${available!.label} anyway, type "${available!.label}" to confirm.` })
    }
    const free = await this.freeMiB()
    const need = this.d.minFreeMiB ?? 3072
    if (free !== null && free < need) refusals.push({ code: 'disk', text: `Only ${free} MiB free; an update needs ${need} MiB.` })
    if (refusals.length) throw new RefusedError(refusals)

    const id = `${this.now().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`
    const job: UpdateJob = {
      id, dir: this.d.dir, by, target: { sha: available!.sha, channel: available!.channel, ref: available!.ref, label: available!.label, version: available!.version },
      from: { sha: inst.sha, version: inst.version, branch: inst.branch },
      repoUrl: this.d.config.repoUrl, mirrorUrl: this.d.config.mirrorUrl, requireSigned: settings.requireSigned, trustedKeys: this.d.config.trustedKeys,
      stateFile: this.p.state, logFile: path.join(this.p.logs, `${id}.log`), backupDir: this.d.backupDir, keepBackups: 3, minFreeMiB: need,
      health: this.d.health ?? { api: 'http://127.0.0.1:3002/health', frontend: 'http://127.0.0.1:3000/login', nginx: 'https://127.0.0.1/login', timeoutMs: 180_000 },
      lockHeld: true, createdAt: this.now().toISOString(), how, allowUnrelated: unrelated && how === 'manual',
    }
    // One automatic attempt per release, kept on disk: a release that rolled back is not retried every minute, nor
    // after a restart (autoAttemptRefused).
    if (how === 'auto') this.recordAutoAttempt(sha)
    // Audited before anything starts: an update that cannot be recorded does not run.
    await this.d.audit('self-update.start', { by, how, from: inst.sha, fromVersion: inst.version, to: job.target.sha, toLabel: job.target.label, channel: job.target.channel, job: id })
    fs.mkdirSync(this.p.jobs, { recursive: true, mode: 0o700 })
    fs.mkdirSync(this.p.logs, { recursive: true, mode: 0o700 })
    const jobFile = path.join(this.p.jobs, `${id}.json`)
    writeJsonAtomic(jobFile, job)
    // The page shows the run at once; the updater rewrites this file as it goes.
    const st = initialState(job, `hyperprox-update-${id}`)
    writeJsonAtomic(this.p.state, st)
    try { await this.d.launch(job, jobFile) }
    catch (e: any) {
      st.status = 'failed'; st.finishedAt = this.now().toISOString(); st.summary = `The updater could not be started: ${e?.message ?? e}`
      writeJsonAtomic(this.p.state, st)
      throw e
    }
    return st
  }

  // --- after a restart, and the timer --------------------------------------------------------------

  /** The closing audit row and notification for a finished run, once (whichever API is running at the end). */
  async reportFinished(): Promise<boolean> {
    const s = await this.job()
    if (!s || !FINAL.includes(s.status)) return false
    let reported = ''
    try { reported = JSON.parse(fs.readFileSync(this.p.reported, 'utf8')).id } catch { /* none yet */ }
    if (reported === s.id) return false
    writeJsonAtomic(this.p.reported, { id: s.id, at: this.now().toISOString() })
    await this.d.audit('self-update.finish', {
      job: s.id, status: s.status, by: s.by, from: s.from.sha, to: s.target.sha, toLabel: s.target.label,
      migrationsApplied: s.migrationsApplied, dbRestored: s.dbRestored, failedStep: s.steps.find(x => x.status === 'failed')?.id ?? null,
    }).catch(e => this.d.log?.(`[self-update] could not write the closing audit row: ${e?.message ?? e}`))
    const ok = s.status === 'succeeded'
    await this.d.publish({
      type: ok ? 'updates.self.succeeded' : 'updates.self.failed',
      severity: ok ? 'info' : s.status === 'rolled-back' ? 'warning' : 'critical',
      title: ok ? `HyperProx updated to ${s.target.label}` : s.status === 'rolled-back' ? `HyperProx update to ${s.target.label} failed and was rolled back` : `HyperProx update to ${s.target.label} failed`,
      lines: [s.summary ?? '', ...(s.dbRestored ? ['The database was restored from the backup taken before the update.'] : [])].filter(Boolean),
      link: '/updates#hyperprox', where: 'Updates page', fingerprint: `updates.self.${s.id}`,
    }).catch(e => this.d.log?.(`[self-update] could not send the closing notification: ${e?.message ?? e}`))
    return true
  }

  /** Every minute: a check when one is due, then an automatic install when everything allows it. */
  async tick(): Promise<void> {
    await this.reportFinished().catch(() => false)
    const s = await this.effectiveSettings()
    const last = this.lastCheck() as (CheckResult & { channel?: string }) | null
    const due = !last || last.channel !== s.channel || Date.parse(last.checkedAt) + s.checkEveryHours * 3_600_000 <= this.now().getTime()
    const result = due ? await this.check() : last!
    if (!s.autoInstall || s.channel !== 'stable' || !result.available || result.available.channel !== 'stable') return
    if (!inWindow(s.window, this.now()) || this.autoAttemptRefused(result.available.sha)) return
    try { await this.install('automatic install', result.available.sha, 'auto') }
    catch (e: any) { this.d.log?.(`[self-update] automatic install of ${result.available.label} not started: ${e instanceof RefusedError ? e.refusals.map(r => r.text).join(' ') : e?.message ?? e}`) }
  }

  private autoAttempts(): Record<string, { at: string }> {
    try { const j = JSON.parse(fs.readFileSync(this.p.attempts, 'utf8')); return j && typeof j === 'object' ? j : {} } catch { return {} }
  }
  private recordAutoAttempt(sha: string): void {
    const a = this.autoAttempts()
    a[sha] = { at: this.now().toISOString() }
    writeJsonAtomic(this.p.attempts, a)
  }
  /** An automatic install of `sha` was tried before and its last run did not succeed. */
  autoAttemptRefused(sha: string): boolean {
    if (!this.autoAttempts()[sha]) return false
    const last = readState(this.p.state)
    return !(last && last.target.sha === sha && last.status === 'succeeded')
  }

  start(everyMs = 60_000): void {
    if (this.timer) return
    const run = () => this.tick().catch(e => this.d.log?.(`[self-update] ${e?.message ?? e}`))
    setTimeout(run, 20_000).unref?.()
    this.timer = setInterval(run, everyMs)
    this.timer.unref?.()
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }
}

export class RefusedError extends Error {
  constructor(public refusals: Refusal[]) { super(refusals.map(r => r.text).join(' ')) }
}

/** VERSION, as `git archive` fills it in (export-subst): "<describe> <sha>". Unfilled, it says $Format. */
export function readVersionFile(dir: string): { version: string; sha: string; describe: string } | null {
  try {
    const t = fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim()
    if (t.includes('$Format')) return null
    const parts = t.split(/\s+/)
    if (parts.length === 1 && /^[0-9a-f]{40}$/.test(parts[0])) return { version: '', sha: parts[0], describe: parts[0].slice(0, 7) }
    const [describe, sha] = parts
    if (!describe) return null
    const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+?)?)(?:-\d+-g[0-9a-f]+)?$/.exec(describe)
    return { version: m ? m[1] : describe, sha: /^[0-9a-f]{40}$/.test(sha ?? '') ? sha : '', describe }
  } catch { return null }
}

// --- production wiring -------------------------------------------------------------------------------------

/** The files the updater runs from, copied out of the build (they import only each other and Node). */
export const UPDATER_FILES = ['state.js', 'redact.js', 'shell.js', 'runner.js', 'updater-main.js']

/** Copy the updater out of the build and start it in a transient unit that outlives the API's restart. */
export function launchUpdater(sh: Shell, opts: { distDir: string; dataDir: string; lockFile: string; nodeBin: string; allowInsecure: boolean }) {
  return async (job: UpdateJob, jobFile: string) => {
    const missing = UPDATER_FILES.filter(f => !fs.existsSync(path.join(opts.distDir, f)))
    if (missing.length) throw new Error(`the updater is not in this build (${missing.join(', ')}); self-update runs from a built install`)
    const runDir = path.join(opts.dataDir, `run-${job.id}`)
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
    for (const f of UPDATER_FILES) fs.copyFileSync(path.join(opts.distDir, f), path.join(runDir, f))
    // Old copies: only the newest few are kept.
    for (const old of fs.readdirSync(opts.dataDir).filter(n => /^run-\d{14}-[0-9a-f]{4}$/.test(n)).sort().slice(0, -3)) {
      fs.rmSync(path.join(opts.dataDir, old), { recursive: true, force: true })
    }
    const args = [
      `--unit=hyperprox-update-${job.id}`, '--description=HyperProx self-update', '--collect', '--quiet',
      '--property=Type=exec', `--working-directory=${job.dir}`,
      `--setenv=PATH=${process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`,
      // A system unit gets no HOME; pnpm and npx keep their store and cache under it.
      `--setenv=HOME=${process.env.HOME || '/root'}`,
      ...(opts.allowInsecure ? ['--setenv=HYPERPROX_UPDATE_INSECURE_UPSTREAM=1'] : []),
      '/usr/bin/flock', '-n', '-E', '75', opts.lockFile, opts.nodeBin, path.join(runDir, 'updater-main.js'), jobFile,
    ]
    const r = await sh.run('systemd-run', args)
    if (r.code !== 0) throw new Error(`systemd-run failed: ${(r.stderr || r.stdout).trim()}`)
  }
}
