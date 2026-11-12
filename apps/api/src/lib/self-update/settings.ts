// =============================================================================
//  HyperProx — self-update: settings
//
//  data/self-update/settings.json. Everything off or conservative by default:
//  the stable channel, a check every 6 hours, no notification, signatures not
//  required, and no automatic install. Automatic install, when someone turns it
//  on, only ever installs a stable release, and only inside its window.
//
//  Where updates come from is not a setting a page can change: it is the
//  install's .env (HYPERPROX_UPDATE_REPO, HYPERPROX_UPDATE_MIRROR), so a signed-in
//  session cannot point HyperProx at someone else's code.
// =============================================================================

import fs from 'fs'
import { writeJsonAtomic, type Channel } from './state'

export interface MaintenanceWindow { days: number[]; start: string; end: string }

export interface SelfUpdateSettings {
  channel:         Channel
  checkEveryHours: number
  notify:          boolean
  requireSigned:   boolean
  /** Stable: also offer releases GitHub marks as pre-releases. On while every HyperProx version is an -alpha. */
  includePrereleases: boolean
  autoInstall:     boolean
  window:          MaintenanceWindow
}

export const DEFAULT_SETTINGS: SelfUpdateSettings = {
  channel: 'stable', checkEveryHours: 6, notify: false, requireSigned: false, includePrereleases: true, autoInstall: false,
  window: { days: [0, 1, 2, 3, 4, 5, 6], start: '03:00', end: '05:00' },
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

export class SettingsError extends Error {}

/** A full settings object from a partial one; throws SettingsError with a sentence for anything wrong. */
export function mergeSettings(base: SelfUpdateSettings, patch: unknown): SelfUpdateSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError('Settings must be an object.')
  const p = patch as Record<string, unknown>
  const known = new Set(['channel', 'checkEveryHours', 'notify', 'requireSigned', 'includePrereleases', 'autoInstall', 'window'])
  for (const k of Object.keys(p)) if (!known.has(k)) throw new SettingsError(`"${k}" is not a self-update setting.`)
  const out: SelfUpdateSettings = { ...base, window: { ...base.window, days: [...base.window.days] } }
  if (p.channel !== undefined) {
    if (p.channel !== 'stable' && p.channel !== 'alpha') throw new SettingsError('The channel is "stable" or "alpha".')
    out.channel = p.channel
  }
  if (p.checkEveryHours !== undefined) {
    const n = p.checkEveryHours
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 168) throw new SettingsError('Check every 1 to 168 hours.')
    out.checkEveryHours = n
  }
  for (const k of ['notify', 'requireSigned', 'includePrereleases', 'autoInstall'] as const) {
    if (p[k] === undefined) continue
    if (typeof p[k] !== 'boolean') throw new SettingsError(`"${k}" is on or off.`)
    out[k] = p[k] as boolean
  }
  if (p.window !== undefined) {
    const w = p.window as Record<string, unknown>
    if (!w || typeof w !== 'object') throw new SettingsError('The maintenance window needs days, a start and an end.')
    if (w.days !== undefined) {
      if (!Array.isArray(w.days) || !w.days.length || w.days.some(d => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) throw new SettingsError('Window days are 0 (Sunday) to 6, at least one.')
      out.window.days = [...new Set(w.days as number[])].sort()
    }
    for (const k of ['start', 'end'] as const) {
      if (w[k] === undefined) continue
      if (typeof w[k] !== 'string' || !HHMM.test(w[k] as string)) throw new SettingsError(`The window ${k} is a time like 03:00.`)
      out.window[k] = w[k] as string
    }
    if (out.window.start === out.window.end) throw new SettingsError('The window must not start and end at the same time.')
  }
  if (out.autoInstall && out.channel !== 'stable') throw new SettingsError('Automatic install only installs stable releases. Switch to the stable channel first.')
  return out
}

/** Whether `at` (server local time) falls inside the window; a window may cross midnight (22:00–02:00). */
export function inWindow(w: MaintenanceWindow, at: Date): boolean {
  const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3))
  const m = at.getHours() * 60 + at.getMinutes()
  const start = mins(w.start), end = mins(w.end)
  if (start < end) return w.days.includes(at.getDay()) && m >= start && m < end
  // Crosses midnight: the part after midnight belongs to the day the window started.
  if (m >= start) return w.days.includes(at.getDay())
  if (m < end) return w.days.includes((at.getDay() + 6) % 7)
  return false
}

export class SettingsStore {
  constructor(private file: string) {}
  load(): SelfUpdateSettings {
    try { return mergeSettings(DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(this.file, 'utf8'))) }
    catch { return { ...DEFAULT_SETTINGS, window: { ...DEFAULT_SETTINGS.window } } }
  }
  save(s: SelfUpdateSettings): void { writeJsonAtomic(this.file, s) }
}
