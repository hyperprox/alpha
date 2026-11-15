// =============================================================================
//  HyperProx — placement advisor: quiet windows
//
//  A move is safest when nothing else is leaning on the network and nobody is
//  using what moves: outside backup jobs (read from the cluster's own backup
//  schedules) and outside the hours the person said the cluster is in use.
//  Schedules are Proxmox calendar events in the cluster's local time:
//    "02:00", "sun 01:00", "mon..fri 22:30", "sat,sun 03:00", "*:00/15",
//    "daily", "weekly", "hourly".
//  A schedule HyperProx cannot read is reported, never guessed at.
//
//  Pure: the clock, the time zone and the task log are passed in.
// =============================================================================

import type { BusyHours, PlacementSettings } from './types'

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export interface CalendarSpec { days: Set<number>; hours: Set<number>; minutes: Set<number> }

function field(s: string, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of s.split(',')) {
    const p = part.trim()
    if (!p) return null
    const [base, stepRaw] = p.split('/')
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1) return null
    let lo: number, hi: number
    if (base === '*') { lo = 0; hi = max }
    else if (/^\d+\.\.\d+$/.test(base)) { [lo, hi] = base.split('..').map(Number) }
    else if (/^\d+$/.test(base)) { lo = Number(base); hi = stepRaw === undefined ? lo : max }
    else return null
    if (lo > hi || hi > max) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size ? out : null
}

function dayField(s: string): Set<number> | null {
  const out = new Set<number>()
  for (const part of s.toLowerCase().split(',')) {
    const r = part.trim().split('..')
    const a = DAYS.indexOf(r[0]?.slice(0, 3) ?? '')
    const b = r.length > 1 ? DAYS.indexOf(r[1]?.slice(0, 3) ?? '') : a
    if (a < 0 || b < 0 || r.length > 2) return null
    // mon..sun wraps the week, as Proxmox reads it.
    for (let d = a, n = 0; n < 7; d = (d + 1) % 7, n++) { out.add(d); if (d === b) break }
  }
  return out
}

/** A Proxmox calendar event, or null when HyperProx cannot read it. Dates (2026-12-24) are not supported. */
export function parseCalendar(raw: string): CalendarSpec | null {
  const s = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!s) return null
  const all = new Set([0, 1, 2, 3, 4, 5, 6])
  const range = (n: number) => new Set(Array.from({ length: n }, (_, i) => i))
  if (s === 'minutely') return { days: all, hours: range(24), minutes: range(60) }
  if (s === 'hourly') return { days: all, hours: range(24), minutes: new Set([0]) }
  if (s === 'daily') return { days: all, hours: new Set([0]), minutes: new Set([0]) }
  if (s === 'weekly') return { days: new Set([1]), hours: new Set([0]), minutes: new Set([0]) }
  let tokens = s.split(' ')
  let days: Set<number> = all
  if (tokens[0] && /^[a-z]/.test(tokens[0])) {
    const d = dayField(tokens[0])
    if (!d) return null
    days = d
    tokens = tokens.slice(1)
  }
  if (tokens[0] === '*-*-*') tokens = tokens.slice(1)
  if (tokens.length > 1) return null
  const time = tokens[0] ?? '00:00'
  if (/-/.test(time)) return null
  const tp = time.split(':')
  if (tp.length < 1 || tp.length > 3) return null
  // "*/15" alone is minutes in Proxmox's reading ("every 15 minutes").
  const [hRaw, mRaw] = tp.length === 1 ? ['*', tp[0]] : [tp[0], tp[1]]
  const hours = field(hRaw, 23), minutes = field(mRaw, 59)
  if (!hours || !minutes) return null
  return { days, hours, minutes }
}

// --- local time -----------------------------------------------------------------------------------

export interface LocalParts { dow: number; hour: number; minute: number }

const fmts = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmts.get(tz)
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }
    catch { f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }
    fmts.set(tz, f)
  }
  return f
}

export function localParts(ms: number, tz: string): LocalParts {
  const parts = fmt(tz).formatToParts(new Date(ms))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return { dow: DAYS.indexOf(get('weekday').toLowerCase().slice(0, 3)), hour: Number(get('hour')) % 24, minute: Number(get('minute')) }
}

export function matches(spec: CalendarSpec, p: LocalParts): boolean {
  return spec.days.has(p.dow) && spec.hours.has(p.hour) && spec.minutes.has(p.minute)
}

const hm = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim())
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  return h <= 24 && mi < 60 && h * 60 + mi <= 1440 ? h * 60 + mi : null
}

/** Busy hours that are not well formed, in words (for the settings form). */
export function busyHoursProblems(list: BusyHours[]): string[] {
  const out: string[] = []
  list.forEach((b, i) => {
    if (hm(b.start) === null || hm(b.end) === null) out.push(`Busy hours ${i + 1}: times must be HH:MM.`)
    if (!Array.isArray(b.days) || !b.days.length || b.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) out.push(`Busy hours ${i + 1}: pick at least one day.`)
    if (hm(b.start) !== null && hm(b.start) === hm(b.end)) out.push(`Busy hours ${i + 1}: start and end are the same.`)
  })
  return out
}

/** True when the local minute falls in one of the busy-hour ranges. An end before the start runs past midnight. */
export function inBusyHours(p: LocalParts, list: BusyHours[]): BusyHours | null {
  const m = p.hour * 60 + p.minute
  for (const b of list) {
    const s = hm(b.start), e = hm(b.end)
    if (s === null || e === null || s === e) continue
    const days = new Set(b.days)
    if (s < e) { if (days.has(p.dow) && m >= s && m < e) return b }
    else if ((days.has(p.dow) && m >= s) || (days.has((p.dow + 6) % 7) && m < e)) return b
  }
  return null
}

// --- backup jobs ----------------------------------------------------------------------------------

export interface BackupJob { id: string; schedule: string; enabled: boolean; durationSec?: number | null }

/**
 * How long each job ran, from the task log: vzdump tasks that started at one of the job's start minutes, grouped
 * per run (every node runs its share at once), from the first start to the last end. The longest run is kept.
 */
export function observedDurations(jobs: BackupJob[], tasks: any[], tz: string): Record<string, number> {
  const out: Record<string, number> = {}
  const dumps = (tasks ?? []).filter(t => t?.type === 'vzdump' && Number(t.starttime) > 0 && Number(t.endtime) > 0)
  for (const j of jobs) {
    const spec = parseCalendar(j.schedule)
    if (!spec) continue
    const runs = new Map<number, { start: number; end: number }>()
    for (const t of dumps) {
      const st = Number(t.starttime)
      // Tolerate a few minutes of lag between the scheduled minute and the task's start.
      let k: number | null = null
      for (let back = 0; back <= 5 && k === null; back++) {
        const at = (Math.floor(st / 60) - back) * 60
        if (matches(spec, localParts(at * 1000, tz))) k = at
      }
      if (k === null) continue
      const r = runs.get(k) ?? { start: st, end: Number(t.endtime) }
      r.start = Math.min(r.start, st); r.end = Math.max(r.end, Number(t.endtime))
      runs.set(k, r)
    }
    const longest = Math.max(0, ...[...runs.values()].map(r => r.end - r.start))
    if (longest > 0) out[j.id] = longest
  }
  return out
}

// --- the timeline ---------------------------------------------------------------------------------

export interface QuietWindow { start: number; end: number; reason: string }

export interface QuietStatus {
  /** Now is quiet: no backup window and no busy hours. */
  quietNow:   boolean
  /** Why now is not quiet, in words. */
  nowWhy:     string[]
  /** The next stretch of at least `needSec` that is quiet throughout (ms), or null within the horizon. */
  nextQuiet:  { start: number; end: number } | null
  /** Not-quiet stretches in the next 48 hours, for the page. */
  upcoming:   QuietWindow[]
  /** Backup schedules HyperProx could not read: treated as unknown, said so. */
  unread:     string[]
  tz:         string
}

const MIN = 60_000

export function quietStatus(input: {
  now: number; tz: string; jobs: BackupJob[]; settings: Pick<PlacementSettings, 'avoidBackups' | 'backupHours' | 'backupMarginMin' | 'busyHours'>
  /** The quiet stretch has to last this long (the move's estimate). */
  needSec?: number
  horizonDays?: number
}): QuietStatus {
  const { now, tz, settings } = input
  const need = Math.max(1, Math.ceil((input.needSec ?? 600) / 60))
  const horizon = (input.horizonDays ?? 8) * 24 * 60
  const unread: string[] = []
  const jobs = (input.jobs ?? []).filter(j => j.enabled).map(j => {
    const spec = parseCalendar(j.schedule)
    if (!spec) unread.push(`backup schedule "${j.schedule}" (${j.id})`)
    const dur = Math.max(15, Math.ceil(((j.durationSec ?? 0) > 0 ? j.durationSec! : settings.backupHours * 3600) / 60))
    return { j, spec, dur }
  })
  const margin = Math.max(0, Math.round(settings.backupMarginMin))
  const maxDur = Math.max(0, ...jobs.map(x => x.dur))
  const t0 = Math.floor(now / MIN) * MIN
  // One pass over every minute from the longest backup's length before now to the horizon: which minute starts
  // a backup, and which is in busy hours. Then each minute's state is a lookup.
  const from = -maxDur, to = horizon + need + margin
  const busy: Array<string | null> = []
  const starts: Array<string[]> = []
  for (let i = from; i <= to; i++) {
    const p = localParts(t0 + i * MIN, tz)
    const b = inBusyHours(p, settings.busyHours ?? [])
    busy.push(b ? `busy hours${b.label ? ` (${b.label})` : ''}` : null)
    starts.push(settings.avoidBackups ? jobs.filter(x => x.spec && matches(x.spec, p)).map(x => x.j.id) : [])
  }
  const idx = (i: number) => i - from
  const backupAt = (i: number): string | null => {
    if (!settings.avoidBackups) return null
    for (const x of jobs) {
      if (!x.spec) continue
      for (let k = i - x.dur; k <= i + margin; k++) {
        if (k < from || k > to) continue
        if (starts[idx(k)].includes(x.j.id)) return k > i ? `a backup job starts at ${clock(t0 + k * MIN, tz)}` : `backup job (${x.j.schedule})`
      }
    }
    return null
  }
  const why = (i: number): string | null => backupAt(i) ?? busy[idx(i)]
  const nowWhy = [backupAt(0), busy[idx(0)]].filter((x): x is string => !!x)
  let nextQuiet: QuietStatus['nextQuiet'] = null
  let run = 0
  for (let i = 0; i <= horizon; i++) {
    if (why(i) === null) { run++; if (run >= need) { const s = i - need + 1; let e = i; while (e < horizon && why(e + 1) === null) e++; nextQuiet = { start: t0 + s * MIN, end: t0 + (e + 1) * MIN }; break } }
    else run = 0
  }
  const upcoming: QuietWindow[] = []
  for (let i = 0; i < 48 * 60; i++) {
    const w = why(i)
    if (!w) continue
    const kind = w.startsWith('busy') ? w : 'backup job'
    const last = upcoming[upcoming.length - 1]
    if (last && last.reason === kind && last.end === t0 + i * MIN) last.end += MIN
    else upcoming.push({ start: t0 + i * MIN, end: t0 + (i + 1) * MIN, reason: kind })
  }
  return { quietNow: nowWhy.length === 0, nowWhy, nextQuiet, upcoming, unread, tz }
}

/** "02:00" in the cluster's local time. */
export function clock(ms: number, tz: string): string {
  const p = localParts(ms, tz)
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

/** Minutes of a backup window, for the imbalance check: true when a sample at `sec` is inside one. */
export function backupMask(input: { tz: string; jobs: BackupJob[]; backupHours: number; marginMin?: number }): (sec: number) => boolean {
  const jobs = input.jobs.filter(j => j.enabled).map(j => ({ spec: parseCalendar(j.schedule), dur: Math.ceil(((j.durationSec ?? 0) > 0 ? j.durationSec! : input.backupHours * 3600) / 60) }))
    .filter(x => x.spec)
  const cache = new Map<number, boolean>()
  const startAt = (minute: number): boolean => {
    let v = cache.get(minute)
    if (v === undefined) { const p = localParts(minute * MIN, input.tz); v = jobs.some(x => matches(x.spec!, p)); cache.set(minute, v) }
    return v
  }
  const maxDur = Math.max(0, ...jobs.map(j => j.dur))
  return (sec: number) => {
    const m = Math.floor(sec / 60)
    for (let k = m - maxDur; k <= m; k++) {
      if (!startAt(k)) continue
      const p = localParts(k * MIN, input.tz)
      if (jobs.some(x => matches(x.spec!, p) && m - k <= x.dur)) return true
    }
    return false
  }
}
