// =============================================================================
//  HyperProx — self-update: the job and its progress file
//
//  The update runs in its own process (a transient systemd unit), because it
//  restarts the API that started it. The two talk through files only:
//
//    data/self-update/jobs/<id>.json   what to do, written once by the API (0600)
//    data/self-update/state.json       where it is, rewritten by the updater
//
//  The API reads the state file on every poll, so a page that lost its
//  connection while the API restarted picks up exactly where the updater is.
//
//  This file, redact.ts, shell.ts, runner.ts and updater-main.ts are copied out
//  of the build and run from that copy (the checkout under them is replaced
//  mid-run), so they import only Node's own modules and each other.
// =============================================================================

import fs from 'fs'
import path from 'path'

export type Channel = 'stable' | 'alpha'

export type StepId = 'preflight' | 'backup' | 'fetch' | 'build' | 'migrate' | 'restart' | 'health' | 'rollback'
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export const STEP_LABELS: Record<StepId, string> = {
  preflight: 'Check disk space, locks and local changes',
  backup:    'Back up the database and record the current commit',
  fetch:     'Fetch, verify and check out the new version',
  build:     'Install dependencies and build',
  migrate:   'Apply database migrations',
  restart:   'Restart HyperProx (it stays unlocked)',
  health:    'Health check: API, web app and the sign-in page',
  rollback:  'Roll back to the previous version',
}
export const STEP_ORDER: StepId[] = ['preflight', 'backup', 'fetch', 'build', 'migrate', 'restart', 'health', 'rollback']

export type JobStatus = 'running' | 'succeeded' | 'failed' | 'rolled-back' | 'rollback-failed' | 'interrupted'
export const FINAL: JobStatus[] = ['succeeded', 'failed', 'rolled-back', 'rollback-failed', 'interrupted']

export interface UpdateTarget {
  /** Full 40-hex commit. Pinned when the person confirmed; the updater refuses anything else. */
  sha:     string
  channel: Channel
  /** The tag (stable) or the branch (alpha) the commit must come from. */
  ref:     string
  /** "v0.3.0" or "main @ 1a2b3c4". */
  label:   string
  version: string | null
}

export interface UpdateJob {
  id:          string
  /** The install: a git checkout (install.sh clones one). */
  dir:         string
  by:          string
  target:      UpdateTarget
  from:        { sha: string; version: string; branch: string | null }
  /** The only places anything is fetched from. https, unless the install allows a local test upstream. */
  repoUrl:     string
  mirrorUrl:   string | null
  requireSigned: boolean
  /** ssh allowed_signers or an armoured GPG key file; null = none configured. */
  trustedKeys: string | null
  stateFile:   string
  logFile:     string
  backupDir:   string
  keepBackups: number
  minFreeMiB:  number
  health: { api: string; frontend: string; nginx: string; timeoutMs: number }
  /** True when the updater runs under the deploy lock (flock), so deploy.sh must not take it again. */
  lockHeld:    boolean
  createdAt:   string
}

export interface StepState { id: StepId; label: string; status: StepStatus; startedAt?: string; finishedAt?: string; detail?: string }

export interface UpdateState {
  id:         string
  status:     JobStatus
  by:         string
  from:       { sha: string; version: string }
  target:     UpdateTarget
  steps:      StepState[]
  /** The last lines of output, secrets already removed. */
  log:        string[]
  startedAt:  string
  finishedAt?: string
  /** One sentence on how it ended. */
  summary?:   string
  backupFile?: string
  migrationsApplied: boolean
  dbRestored: boolean
  /** The unit the updater runs in. */
  unit?:      string
}

export const LOG_TAIL = 300
const LINE_MAX = 400

export function initialState(job: UpdateJob, unit?: string): UpdateState {
  return {
    id: job.id, status: 'running', by: job.by,
    from: { sha: job.from.sha, version: job.from.version }, target: job.target,
    steps: STEP_ORDER.map(id => ({ id, label: STEP_LABELS[id], status: 'pending' as StepStatus })),
    log: [], startedAt: new Date().toISOString(), migrationsApplied: false, dbRestored: false, unit,
  }
}

export function readState(file: string): UpdateState | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return j && typeof j.id === 'string' && Array.isArray(j.steps) ? j as UpdateState : null
  } catch { return null }
}

export function writeJsonAtomic(file: string, data: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode })
  fs.renameSync(tmp, file)
}

/** What the runner reports through. The file one below; tests keep it in memory. */
export interface StateSink {
  get(): UpdateState
  update(fn: (s: UpdateState) => void): void
  line(text: string): void
  flush(): void
}

/** Keeps the state in memory and rewrites the file: at once for a step change, at most twice a second for log lines. */
export class FileStateSink implements StateSink {
  private dirty = false
  private timer: NodeJS.Timeout | null = null
  constructor(private file: string, private state: UpdateState, private logFile?: string) { this.flush() }
  get(): UpdateState { return this.state }
  update(fn: (s: UpdateState) => void): void { fn(this.state); this.flush() }
  line(text: string): void {
    const l = text.length > LINE_MAX ? text.slice(0, LINE_MAX) + '…' : text
    this.state.log.push(l)
    if (this.state.log.length > LOG_TAIL) this.state.log.splice(0, this.state.log.length - LOG_TAIL)
    if (this.logFile) { try { fs.appendFileSync(this.logFile, l + '\n', { mode: 0o600 }) } catch { /* the tail still has it */ } }
    this.dirty = true
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; if (this.dirty) this.flush() }, 500)
  }
  flush(): void {
    this.dirty = false
    writeJsonAtomic(this.file, this.state)
  }
}

export class MemoryStateSink implements StateSink {
  writes = 0
  constructor(public state: UpdateState) {}
  get(): UpdateState { return this.state }
  update(fn: (s: UpdateState) => void): void { fn(this.state); this.writes++ }
  line(text: string): void {
    this.state.log.push(text.length > LINE_MAX ? text.slice(0, LINE_MAX) + '…' : text)
    if (this.state.log.length > LOG_TAIL) this.state.log.splice(0, this.state.log.length - LOG_TAIL)
  }
  flush(): void { this.writes++ }
}
