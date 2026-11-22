// =============================================================================
//  HyperProx — Arr Stack, Live TV tab: the page's pure helpers
//
//  The shapes the API answers (routes/arr-tunarr.ts) take, and the words the tab builds from them. No fetching here,
//  so the tab is tested by rendering (test/arr-livetv.test.tsx). The confirmation sentences match the ones the server
//  asks for (lib/confirm-text.ts), which are the ones that count.
// =============================================================================

export const GUIDE_MIN_HOURS = 24

export interface TvProgram { title: string; episode: string | null; code: string | null; kind: 'movie' | 'episode' | 'other' | 'break'; at: string; until: string }
export interface TvReady { programmes: number; synced: number; pct: number }
export interface TvSession { state: string; viewers: number; who: Array<{ ip: string; agent: string }>; mode: string }
export interface TvChannel {
  id: string; number: number; name: string; hasIcon: boolean; programCount: number
  now: TvProgram | null; next: TvProgram | null; guideHours: number | null; guideShort: boolean
  group: string | null; ready: TvReady | null; canStream: boolean; problems: string[]; viewers: number; sessions: TvSession[]
}
export interface TvSource { name: string; type: string; state: 'ok' | 'down' | 'unknown'; why: string | null }
export interface TvVersion { installed: string | null; latest: string | null; behind: boolean | null; edge: boolean; ffmpeg: string | null }
export interface TvWarning { level: 'error' | 'warning' | 'notice'; text: string; fix?: 'refresh-guide' | 'stop-session'; channelId?: string }
export interface LiveTv {
  configured: boolean; channels: TvChannel[]; sources: TvSource[]; version: TvVersion; warnings: TvWarning[]
  summary: { channels: number; viewers: number; streaming: number; guideShort: number; cannotStream: number; shortestGuideHours: number | null; synced: number; unsynced: number; unsyncedProgrammes: number; notRescanning: number }
  actions: { refreshGuide: boolean; stopSession: boolean }
  readAt: string; detail: boolean
}
export interface ActResult { action: string; done: boolean; summary: string; notes: string[] }
export type Act = { action: 'refresh-guide' } | { action: 'stop-session'; channelId: string }

export const ACT_LABEL = { 'refresh-guide': 'Refresh guide', 'stop-session': 'Restart stream' } as const

/** The icon's HyperProx path, or null. */
export const iconPath = (c: Pick<TvChannel, 'id' | 'hasIcon'>): string | null => (c.hasIcon && /^[A-Za-z0-9-]{8,64}$/.test(c.id) ? `/api/plugins/arrstack/tunarr/icon/${c.id}` : null)

/** "10 h of guide", "no guide", "1 day 6 h". */
export function guideWord(h: number | null): string {
  if (h === null) return 'Guide length unknown'
  if (h <= 0) return 'No guide published'
  if (h < 48) return `${Math.round(h * 10) / 10} h of guide`
  return `${Math.floor(h / 24)} days ${Math.round(h % 24)} h of guide`
}

/** How full the guide bar is: 24 hours is the target, so it fills at one day. */
export const guideFill = (h: number | null): number => (h === null ? 0 : Math.max(0, Math.min(1, h / GUIDE_MIN_HOURS)))

/** "now until 14:30" in this browser's time. */
export function untilWord(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const viewersWord = (n: number) => (n === 0 ? 'Nobody watching' : n === 1 ? '1 viewer' : `${n} viewers`)

export function versionWord(v: TvVersion): string {
  if (!v.installed) return 'Version unknown'
  if (v.behind === true) return `${v.installed}, newest is ${v.latest}`
  if (v.behind === false) return v.latest ? `${v.installed}, up to date` : v.installed
  return v.latest ? `${v.installed} (newest is ${v.latest})` : v.installed
}

/** The sentence a button's confirmation shows (the server's own sentence is what binds the action). */
export function confirmText(a: Act, channelName?: string): string {
  if (a.action === 'refresh-guide') return 'Rebuild Tunarr\'s TV guide now? Tunarr re-reads every channel\'s schedule in the background and rewrites its guide file. Nothing is deleted.'
  return `Stop the stream on ${channelName ? `channel ${channelName}` : 'this channel'}? Tunarr ends its ffmpeg, so anyone watching it is cut off until their player reconnects. Nothing is deleted.`
}

/** Whether a timer tick should read Tunarr: not while the tab is hidden, and not while the last reading is still running. */
export const pollDue = (hidden: boolean, loading: boolean): boolean => !hidden && !loading

// ── the guide view: text, progress, groups, filters ────────────────────────────────────────────────

/** "Show — Episode" for an episode, the title alone for a film or a break. */
export const programText = (p: TvProgram): string => (p.episode ? `${p.title} — ${p.episode}` : p.title)

/** How far through the programme on now is, 0 to 1 (0 when there is none or the times are unreadable). */
export function progressOf(p: TvProgram | null, nowMs: number): number {
  if (!p) return 0
  const a = Date.parse(p.at), b = Date.parse(p.until)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0
  return Math.max(0, Math.min(1, (nowMs - a) / (b - a)))
}

/** "1 h 5 min left", "12 min left". */
export function leftWord(p: TvProgram | null, nowMs: number): string {
  if (!p) return ''
  const mins = Math.max(0, Math.round((Date.parse(p.until) - nowMs) / 60_000))
  if (!Number.isFinite(mins)) return ''
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min left` : `${mins} min left`
}

/** Anything about the channel a person should look at. */
export const needsAttention = (c: TvChannel): boolean =>
  !c.canStream || c.guideShort || (!!c.ready && c.ready.synced < c.ready.programmes) || c.sessions.some(x => x.state === 'error')

/** The guide length most channels share, rounded to the hour; null when none reported one. */
export function typicalGuideHours(channels: TvChannel[]): number | null {
  const counts = new Map<number, number>()
  for (const c of channels) if (c.guideHours !== null) counts.set(Math.round(c.guideHours), (counts.get(Math.round(c.guideHours)) ?? 0) + 1)
  let best: number | null = null, n = 0
  for (const [h, k] of counts) if (k > n || (k === n && best !== null && h < best)) { best = h; n = k }
  return best
}

/** A channel's own guide length is worth a chip only when it is short or not the one the rest share. */
export const guideDiffers = (c: TvChannel, typical: number | null): boolean =>
  c.guideHours !== null && (c.guideShort || (typical !== null && Math.abs(c.guideHours - typical) >= 1.5))

export interface TvGroup { key: string; label: string; channels: TvChannel[] }

/**
 * Channels in groups: Tunarr's own channel groups when it has more than one, otherwise bands of ten by number
 * (1 to 9, 10 to 19, ...). Always in channel order.
 */
export function groupChannels(channels: TvChannel[]): TvGroup[] {
  const sorted = [...channels].sort((a, b) => a.number - b.number)
  const named = new Set(sorted.map(c => c.group).filter((g): g is string => !!g))
  const out = new Map<string, TvGroup>()
  for (const c of sorted) {
    let key: string, label: string
    if (named.size > 1) { key = `g:${c.group ?? ''}`; label = c.group ?? 'Other' }
    else { const lo = Math.floor(c.number / 10) * 10; const from = Math.max(1, lo), to = lo + 9; key = `n:${lo}`; label = `Channels ${from}\u2013${to}` }
    const g = out.get(key) ?? { key, label, channels: [] }
    g.channels.push(c); out.set(key, g)
  }
  return [...out.values()]
}

export type TvFilter = 'all' | 'attention' | 'watching'

/** Channels matching the search words (number, name, or what is on now or next) and the filter. */
export function filterChannels(channels: TvChannel[], query: string, filter: TvFilter): TvChannel[] {
  const q = query.trim().toLowerCase()
  return channels.filter(c => {
    if (filter === 'attention' && !needsAttention(c)) return false
    if (filter === 'watching' && c.viewers === 0) return false
    if (!q) return true
    const hay = [String(c.number), c.name, c.now && programText(c.now), c.next && programText(c.next)].filter(Boolean).join(' ').toLowerCase()
    return q.split(/\s+/).every(w => hay.includes(w))
  })
}

/** How many channels are free of programmes Tunarr marks missing, or null when this Tunarr gave nothing to judge by. */
export const syncedWord = (tv: LiveTv): { value: number; text: string } | null => {
  const judged = tv.channels.filter(c => c.ready).length
  return judged ? { value: tv.summary.synced / judged, text: `${tv.summary.synced}/${judged}` } : null
}
