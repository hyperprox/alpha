// =============================================================================
//  HyperProx — Arr Stack, Live TV tab: the page's pure helpers
//
//  The shapes the API answers (routes/arr-tunarr.ts) take, and the words the tab builds from them. No fetching here,
//  so the tab is tested by rendering (test/arr-livetv.test.tsx). The confirmation sentences match the ones the server
//  asks for (lib/confirm-text.ts), which are the ones that count.
// =============================================================================

export const GUIDE_MIN_HOURS = 24

export interface TvProgram { title: string; at: string; until: string }
export interface TvSession { state: string; viewers: number; who: Array<{ ip: string; agent: string }>; mode: string }
export interface TvChannel {
  id: string; number: number; name: string; hasIcon: boolean; programCount: number
  now: TvProgram | null; next: TvProgram | null; guideHours: number | null; guideShort: boolean
  canStream: boolean; problems: string[]; viewers: number; sessions: TvSession[]
}
export interface TvSource { name: string; type: string; state: 'ok' | 'down' | 'unknown'; why: string | null }
export interface TvVersion { installed: string | null; latest: string | null; behind: boolean | null; edge: boolean; ffmpeg: string | null }
export interface TvWarning { level: 'error' | 'warning' | 'notice'; text: string; fix?: 'refresh-guide' | 'stop-session'; channelId?: string }
export interface LiveTv {
  configured: boolean; channels: TvChannel[]; sources: TvSource[]; version: TvVersion; warnings: TvWarning[]
  summary: { channels: number; viewers: number; streaming: number; guideShort: number; cannotStream: number; shortestGuideHours: number | null }
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
