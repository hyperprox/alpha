// =============================================================================
//  HyperProx — Nextcloud: the shapes the service, routes and page share
// =============================================================================

import type { Role } from '../roles'
import type { Deployment } from './detect'
import type { LogEntry, NcStatus, ServerInfo, Severity, UpdateInfo } from './parse'
import type { ActionId, Remedy, Suggestions } from './checks'

// Defined beside suggestWindow, its reader, so checks.ts does not import this file back.
export type { BusyHoursLike } from './checks'

export interface Actor { sid: string; email: string; role: Role; token: string | null }

export class NcRefusal extends Error {
  constructor(public code: string, message: string, public status = 400, public extra: Record<string, unknown> = {}) { super(message); this.name = 'NcRefusal' }
}

/** Which guest holds Nextcloud. The node is looked up each time: a guest may have moved. */
export interface GuestRef { kind: 'lxc' | 'qemu'; vmid: number }

export interface NcMeta {
  id:        string
  name:      string
  guest:     GuestRef
  /** The deployment as last detected (re-detected before any update). */
  deployment: Deployment | null
  /** Snoozed or dismissed checks: check id -> ISO time it comes back, or 'forever'. */
  snoozed:   Record<string, string>
  addedAt:   string
  /** Set when HyperProx connected it by itself (lib/auto-connect): when, how it was found, how the web login was made. */
  autoConnected?: {
    at: string; evidence: string[]; webLogin: string | null
    /** When the background pass last tried the web login, and how many tries in a row failed (its back-off). */
    webLoginTriedAt?: string; webLoginFailures?: number
    /** Why the background pass stopped trying the web login for good (until a person acts), or absent. */
    webLoginStopped?: string
    /** App passwords HyperProx made but could not revoke: a person deletes them under that user's Security settings. */
    orphans?: Array<{ user: string; id: number | null; at: string }>
  } | null
}

export interface NcView extends NcMeta { url: string | null; user: string | null; hasAppPassword: boolean; appPasswordMadeByHyperProx: boolean }

export interface CheckView {
  id: string; category: string; name: string; severity: Severity; description: string; doc: string | null
  remedy: Remedy
  /** Snoozed until (ISO) or 'forever'; the page folds these away. */
  snoozed: string | null
}

export interface Reading {
  fetchedAt: string
  status: NcStatus | null
  update: UpdateInfo & { webUpdaterDisabled: boolean }
  /** Where the checks came from: the admin page's own endpoint (it knows the request) or occ. */
  checksFrom: 'web' | 'occ' | null
  checks: CheckView[]
  counts: { error: number; warning: number; info: number }
  background: { mode: string; lastRun: number | null }
  config: {
    maintenanceWindowStart: number | null; phoneRegion: string | null; serverId: number | null
    timezone: string | null; locale: string | null; language: string | null
    mail: { mode: string | null; host: string | null; port: string | null; secure: string | null; from: string | null; domain: string | null }
  }
  users: { total: number | null; disabled: number | null }
  /** Below admin these are left out. */
  twoFactor: { enforced: boolean | null; checked: number; without: string[] | null; providers: string[] }
  log: LogEntry[] | null
  server: ServerInfo | null
  serverError: string | null
  talk: {
    installed: boolean
    hpb: { version: string | null; image: string | null; container: string | null; missing: string[] } | null
    activeCalls: number | null
    push: { app: 'enabled' | 'disabled' | 'missing'; daemon: 'running' | 'stopped' | 'missing'; endpoint: string | null }
  }
  apps: { enabled: number; exApps: number | null }
  deployment: Deployment | null
  suggest: Suggestions
  php: string | null
  dbVersion: string | null
  /** Reads that failed, in words; the rest of the page is real. */
  missing: string[]
}

export interface JobStep { key: string; label: string; state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'; detail?: string }

export interface Job {
  id: string
  instanceId: string
  action: ActionId
  by: string
  /** problems: the job said done, but HyperProx's own check afterwards did not agree (both are in `result`). */
  state: 'running' | 'done' | 'failed' | 'problems'
  steps: JobStep[]
  lines: string[]
  startedAt: string
  endedAt: string | null
  result: string | null
  /** Rollback in words, when the job changed something that a person may need to undo. */
  rollback: string | null
  /** Set for work that runs detached in the guest (the update): where its state file and log are, and the guest. */
  detached: { guest: GuestRef; backupDir: string } | null
  /** Maintenance mode as the job last knew it. */
  maintenance: 'on' | 'off' | 'unknown' | null
}
