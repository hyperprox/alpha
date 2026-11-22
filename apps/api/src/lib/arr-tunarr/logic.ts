// =============================================================================
//  HyperProx — Arr Stack, Live TV (Tunarr): turning Tunarr's answers into the tab's numbers
//
//  Pure, so it is tested with recorded answers and no Tunarr. Tunarr's API is read as of release 2026.11 (the
//  0.12 line answers the same routes): /api/channels, /api/guide/status, /api/guide/channels, /api/sessions,
//  /api/version, /api/system/health and /api/media-sources.
//
//  What the tab says is only what those answers prove. A channel "cannot stream" when Tunarr itself says there is
//  nothing to play (no programming, nothing in the guide now) or its stream session is in an error state; a media
//  source that does not answer is a warning on its own, because the API does not say which channels use it.
// =============================================================================

import { compareVersions, isVersion } from '../app-updates/versions'

/** A guide shorter than this is a problem: a player that asks for tomorrow's schedule gets nothing. */
export const GUIDE_MIN_HOURS = 24

export interface TvProgram { title: string; at: string; until: string }
export interface TvSession { state: string; viewers: number; who: Array<{ ip: string; agent: string }>; mode: string }
export interface TvChannel {
  id: string
  number: number
  name: string
  /** True when Tunarr has an icon HyperProx can show (served through /tunarr/icon/:id). */
  hasIcon: boolean
  programCount: number
  now: TvProgram | null
  next: TvProgram | null
  /** Hours of guide published from now on, or null when Tunarr did not say. */
  guideHours: number | null
  guideShort: boolean
  canStream: boolean
  problems: string[]
  /** People watching it now. */
  viewers: number
  sessions: TvSession[]
}
export interface TvSource { name: string; type: string; state: 'ok' | 'down' | 'unknown'; why: string | null }
export interface TvVersion {
  installed: string | null
  latest: string | null
  /** Behind: true or false, or null when either number cannot be compared (an edge build, an unreadable answer). */
  behind: boolean | null
  edge: boolean
  ffmpeg: string | null
}
export interface TvWarning { level: 'error' | 'warning' | 'notice'; text: string; fix?: 'refresh-guide' | 'stop-session'; channelId?: string }
export interface LiveTv {
  configured: boolean
  channels: TvChannel[]
  sources: TvSource[]
  version: TvVersion
  warnings: TvWarning[]
  summary: { channels: number; viewers: number; streaming: number; guideShort: number; cannotStream: number; shortestGuideHours: number | null }
  /** The fixes this Tunarr can take, said plainly. */
  actions: { refreshGuide: boolean; stopSession: boolean }
  readAt: string
  /** Sessions' addresses and player names are shown only when this is true (an admin). */
  detail: boolean
}

export interface RawReading {
  version?: any
  channels?: any
  guideStatus?: any
  guide?: any
  sessions?: any
  health?: any
  sources?: Array<{ source: any; status: any }> | null
  tasks?: any
  latest?: string | null
  now: number
}

const str = (v: unknown, max = 120): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '')
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null }
const rec = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {})
const ID = /^[A-Za-z0-9-]{8,64}$/

/** A version as Tunarr prints it: a leading v goes, and an edge build's "-<commit>" is kept apart. */
export function splitVersion(raw: unknown): { base: string | null; edge: boolean } {
  const s = str(raw, 64).replace(/^v/i, '')
  if (!s) return { base: null, edge: false }
  const m = /^(\d+\.\d+\.\d+)(-.+)?$/.exec(s)
  if (!m || !isVersion(m[1])) return { base: null, edge: false }
  return { base: m[1], edge: !!m[2] }
}

export function versionState(installed: unknown, latest: unknown, ffmpeg?: unknown): TvVersion {
  const a = splitVersion(installed)
  const b = splitVersion(latest)
  let behind: boolean | null = null
  if (a.base && b.base) {
    const c = compareVersions(a.base, b.base)
    // An edge build of the same number is ahead of the release, not behind it.
    behind = c < 0 ? true : false
  }
  return { installed: a.base ? (a.edge ? `${a.base} (edge build)` : a.base) : (str(installed, 40) || null), latest: b.base, behind, edge: a.edge, ffmpeg: str(ffmpeg, 60) || null }
}

function programOf(p: any): TvProgram | null {
  const start = num(p?.start), stop = num(p?.stop)
  if (start === null || stop === null) return null
  const title = str(p?.title, 120) || str(p?.subtitle, 120) || (p?.type === 'flex' ? 'Off air' : 'Untitled')
  return { title, at: new Date(start).toISOString(), until: new Date(stop).toISOString() }
}

/** The programme on at `now` and the one after, from a channel's guide rows. */
export function nowAndNext(programs: unknown, now: number): { now: TvProgram | null; next: TvProgram | null } {
  const list = (Array.isArray(programs) ? programs : []).filter(p => num(p?.start) !== null && num(p?.stop) !== null)
    .sort((a, b) => Number(a.start) - Number(b.start))
  const i = list.findIndex(p => Number(p.start) <= now && now < Number(p.stop))
  if (i < 0) return { now: null, next: programOf(list.find(p => Number(p.start) > now)) }
  return { now: programOf(list[i]), next: programOf(list[i + 1]) }
}

/** Hours of guide published after `now` for one channel, from /api/guide/status. */
export function guideHoursOf(status: any, id: string, now: number): number | null {
  const end = Date.parse(String(rec(rec(status).guideTimes)[id]?.end ?? ''))
  return Number.isFinite(end) ? Math.max(0, Math.round(((end - now) / 3_600_000) * 10) / 10) : null
}

export function sessionsOf(raw: unknown): TvSession[] {
  return (Array.isArray(raw) ? raw : []).map(s => ({
    state: str(s?.state, 20) || 'unknown',
    mode: str(s?.type, 30),
    viewers: Math.max(0, Math.round(num(s?.numConnections) ?? 0)),
    who: (Array.isArray(s?.connections) ? s.connections : []).slice(0, 20).map((c: any) => ({ ip: str(c?.ip, 45), agent: str(c?.userAgent, 80) })),
  }))
}

/** The tab's whole reading. */
export function buildLiveTv(r: RawReading, detail: boolean): LiveTv {
  const now = r.now
  const bySession = rec(r.sessions)
  const channelsRaw: any[] = Array.isArray(r.channels) ? r.channels : []
  const guideBy = rec(r.guide)
  const guideRead = r.guide !== undefined && r.guide !== null
  const channels: TvChannel[] = channelsRaw.filter(c => ID.test(String(c?.id ?? ''))).map(c => {
    const id = String(c.id)
    const sessions = sessionsOf(bySession[id] ?? c.sessions)
    const { now: on, next } = nowAndNext(rec(guideBy[id]).programs, now)
    const programCount = Math.max(0, Math.round(num(c.programCount) ?? 0))
    const hours = guideHoursOf(r.guideStatus, id, now)
    const problems: string[] = []
    if (programCount === 0) problems.push('It has no programming, so there is nothing to stream.')
    else if (guideRead && !on) problems.push('Nothing is scheduled on it right now, so a player gets no stream.')
    if (sessions.some(s => s.state === 'error')) problems.push('Its stream session has failed (Tunarr marks it as an error).')
    const guideShort = hours !== null && hours < GUIDE_MIN_HOURS
    return {
      id, number: Math.round(num(c.number) ?? 0), name: str(c.name, 80) || 'Unnamed channel',
      hasIcon: typeof c?.icon?.path === 'string' && c.icon.path.startsWith('/') && !c.icon.path.startsWith('//'),
      programCount, now: on, next, guideHours: hours, guideShort,
      canStream: problems.length === 0, problems,
      viewers: sessions.reduce((t, s) => t + s.viewers, 0), sessions,
    }
  }).sort((a, b) => a.number - b.number)

  const sources: TvSource[] = (r.sources ?? []).map(({ source, status }) => {
    const healthy = status && typeof status.healthy === 'boolean' ? status.healthy : null
    return {
      name: str(source?.name, 60) || 'Media source', type: str(source?.type, 20),
      state: healthy === true ? 'ok' : healthy === false ? 'down' : 'unknown',
      why: healthy === false ? (str(status?.status, 40) || 'did not answer') : null,
    } as TvSource
  })

  const version = versionState(rec(r.version).tunarr, r.latest, rec(r.version).ffmpeg)

  const warnings: TvWarning[] = []
  for (const c of channels) {
    for (const p of c.problems) {
      const failed = p.startsWith('Its stream session')
      warnings.push({ level: 'error', text: `Channel ${c.number} ${c.name}: ${p}`, channelId: c.id, ...(failed ? { fix: 'stop-session' as const } : {}) })
    }
  }
  const short = channels.filter(c => c.guideShort)
  if (short.length) {
    const worst = Math.min(...short.map(c => c.guideHours ?? 0))
    warnings.push({ level: 'warning', fix: 'refresh-guide',
      text: `${short.length === 1 ? `Channel ${short[0].number} ${short[0].name} has` : `${short.length} channels have`} less than ${GUIDE_MIN_HOURS} hours of guide published (the shortest has ${worst} h). Players that look a day ahead will show gaps.` })
  }
  for (const s of sources) {
    if (s.state === 'down') warnings.push({ level: 'error', text: `Media source ${s.name} is not answering (${s.why}). Channels that play from it cannot stream.` })
  }
  const health = rec(r.health)
  for (const [name, v] of Object.entries(health)) {
    const t = rec(v)
    if (t.type === 'warning' || t.type === 'error') warnings.push({ level: t.type, text: `Tunarr reports: ${str(name, 60)}${str(t.context, 200) ? ` — ${str(t.context, 200)}` : ''}` })
  }
  if (version.behind === true) warnings.push({ level: 'notice', text: `Tunarr ${version.installed} is behind the newest release, ${version.latest}.` })
  if (r.guideStatus === undefined || r.guideStatus === null) warnings.push({ level: 'notice', text: 'Tunarr did not report how much guide is published, so the guide length is not checked.' })

  const hrs = channels.map(c => c.guideHours).filter((h): h is number => h !== null)
  const tasks: any[] = Array.isArray(r.tasks) ? r.tasks : []
  return {
    configured: true, channels, sources, version, warnings, detail,
    summary: {
      channels: channels.length, viewers: channels.reduce((t, c) => t + c.viewers, 0),
      streaming: channels.filter(c => c.sessions.some(s => s.state === 'started')).length,
      guideShort: short.length, cannotStream: channels.filter(c => !c.canStream).length,
      shortestGuideHours: hrs.length ? Math.min(...hrs) : null,
    },
    actions: { refreshGuide: tasks.some(t => t?.id === 'UpdateXmlTvTask'), stopSession: true },
    readAt: new Date(now).toISOString(),
  }
}

/** What a viewer (or an API token) is not shown: who is connected, and from where. */
export function forViewer(t: LiveTv): LiveTv {
  return { ...t, detail: false, channels: t.channels.map(c => ({ ...c, sessions: c.sessions.map(s => ({ ...s, who: [] })) })) }
}
