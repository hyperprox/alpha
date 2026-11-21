// =============================================================================
//  HyperProx — Updates: "Install updates automatically"
//
//  One switch on the simple Updates page, off by default. It turns on the home cluster's existing scheduled run
//  (the same one the policy file's `schedule:` section describes) every night, without editing that file: the
//  switch lives in data/updates-auto.json (no secrets), and while it is on it overrides the policy's schedule with
//  the morning time below. Reboots stay with Automatic reboots and their window. Changing it is an admin's act,
//  confirmed on the page and audited with before and after (routes/updates.ts).
// =============================================================================

import fs from 'node:fs'
import path from 'node:path'
import type { PolicyLoad } from './policy'

// 08:00 in the cluster's time zone: after the busiest hours of the day. Choose an Automatic reboots window that opens
// after installs have finished.
export const AUTO_INSTALL_TIME = '08:00'
export const AUTO_INSTALL_CRON = '0 8 * * *'
export const DEFAULT_AUTO_INSTALL_PATH = '/opt/hyperprox/data/updates-auto.json'

export interface AutoInstallState { enabled: boolean; by?: string; at?: string }
export interface AutoInstallStore { load(): AutoInstallState; save(s: AutoInstallState): void }

export class FileAutoInstall implements AutoInstallStore {
  constructor(private file = process.env.UPDATES_AUTO_PATH || DEFAULT_AUTO_INSTALL_PATH) {}
  load(): AutoInstallState {
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); return { enabled: j?.enabled === true, by: typeof j?.by === 'string' ? j.by : undefined, at: typeof j?.at === 'string' ? j.at : undefined } }
    catch { return { enabled: false } }
  }
  save(s: AutoInstallState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}

export class MemoryAutoInstall implements AutoInstallStore {
  state: AutoInstallState = { enabled: false }
  load(): AutoInstallState { return { ...this.state } }
  save(s: AutoInstallState): void { this.state = { ...s } }
}

/** The policy as the home scheduler reads it: every morning while the switch is on, the policy file's own schedule otherwise. */
export function withAutoInstall(load: PolicyLoad, st: AutoInstallState): PolicyLoad {
  if (!st.enabled || !load.loaded) return load
  return { ...load, policy: { ...load.policy, schedule: { ...load.policy.schedule, enabled: true, cron: AUTO_INSTALL_CRON } } }
}
