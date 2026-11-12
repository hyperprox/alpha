// =============================================================================
//  HyperProx — reading Plex itself (no Tautulli needed)
//
//  Pure parsers for Plex's own answers, so each is tested without a Plex:
//    /status/sessions                 now streaming: who, on what, direct play,
//                                     direct stream or transcode, local or
//                                     remote, bandwidth and progress
//    /status/sessions/history/all     plays, for "who watches most", "most
//    + /accounts                      watched" and recent history (Plex keeps
//                                     no watch time, so these count plays)
//    /library/sections (+ totalSize)  each library and its size
//
//  Every title and name here came from Plex and is treated as text only.
// =============================================================================

import type { PlexSessionVisual, PlexVisual } from './plugin-visual-types'
import { artRef } from './plex-art'

const n0 = (v: unknown): number => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : 0 }
const str = (v: unknown, fallback = '—', max = 160): string =>
  (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : fallback).slice(0, max)
const mc = (b: any): any => b?.MediaContainer ?? {}
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

/** How a stream is being played: Plex says transcode in TranscodeSession, and nothing at all for direct play. */
export function streamMode(m: any): 'transcode' | 'copy' | 'direct play' {
  const t = m?.TranscodeSession
  if (!t || typeof t !== 'object') return 'direct play'
  if (t.videoDecision === 'transcode' || t.audioDecision === 'transcode') return 'transcode'
  return 'copy'
}

/** Local when Plex says the session is on the LAN, or the player says it is local. */
export function isLocal(m: any): boolean {
  const loc = m?.Session?.location
  if (loc === 'lan') return true
  if (loc === 'wan') return false
  return truthy(m?.Player?.local)
}

/** /status/sessions as the page's live part. Bandwidth is kbps from Plex, shown in Mbps. */
export function plexSessions(body: any): Pick<PlexVisual, 'sessions' | 'counts' | 'bandwidth'> {
  const rows: any[] = Array.isArray(mc(body).Metadata) ? mc(body).Metadata : []
  let lan = 0, wan = 0, transcodes = 0, direct = 0
  const sessions: PlexSessionVisual[] = rows.slice(0, 50).map(m => {
    const episode = m?.type === 'episode'
    const mode = streamMode(m)
    if (mode === 'transcode') transcodes++
    if (mode === 'direct play') direct++
    const kbps = n0(m?.Session?.bandwidth)
    if (isLocal(m)) lan += kbps; else wan += kbps
    const duration = n0(m?.duration)
    const res = str(m?.Media?.[0]?.videoResolution, '', 10)
    return {
      title:     str(episode ? m.grandparentTitle : m.title, 'Something'),
      episode:   episode && m.title ? str(m.title) : null,
      number:    episode && n0(m.index) ? `S${n0(m.parentIndex)} · E${n0(m.index)}` : null,
      year:      n0(m?.year) || null,
      mediaType: str(m?.type, 'unknown', 20),
      user:      str(m?.User?.title, 'someone', 60),
      player:    str(m?.Player?.title || m?.Player?.product, '—', 60),
      quality:   res ? (/^\d+$/.test(res) ? `${res}p` : res.toUpperCase()) : '—',
      mode,
      state:     str(m?.Player?.state, 'playing', 20),
      progress:  duration ? Math.max(0, Math.min(100, Math.round((n0(m?.viewOffset) / duration) * 1000) / 10)) : 0,
      art:       artRef(episode ? (m.grandparentThumb || m.thumb) : m.thumb),
      sessionKey: m?.sessionKey != null ? String(m.sessionKey).slice(0, 40) : null,
    }
  })
  const mbps = (k: number) => Math.round(k / 100) / 10
  return {
    sessions: sessions.slice(0, 12),
    counts: { streams: rows.length, transcodes, direct },
    bandwidth: { totalMbps: mbps(lan + wan), lanMbps: mbps(lan), wanMbps: mbps(wan) },
  }
}

/** Tautulli's quality wording ("4 Mbps 720p", "Original") is richer than Plex's; used where the stream matches. */
export function withTautulliQuality(sessions: PlexSessionVisual[], activity: any): PlexSessionVisual[] {
  const t: any[] = activity?.response?.data?.sessions ?? []
  const byKey = new Map(t.filter(x => x?.session_key != null).map(x => [String(x.session_key), x]))
  return sessions.map(s => {
    const hit = s.sessionKey ? byKey.get(s.sessionKey) : undefined
    return hit && typeof hit.quality_profile === 'string' && hit.quality_profile.trim() ? { ...s, quality: hit.quality_profile.trim().slice(0, 40) } : s
  })
}

/** /accounts: Plex's account id to the name it shows. */
export function accountNames(body: any): Map<number, string> {
  const out = new Map<number, string>()
  for (const a of Array.isArray(mc(body).Account) ? mc(body).Account : []) {
    if (a && Number.isFinite(Number(a.id))) out.set(Number(a.id), str(a.name, `account ${a.id}`, 60))
  }
  return out
}

/** Plays from Plex's history: who watches most, what is watched most, and the newest plays. */
export function historyStats(rows: any[], names: Map<number, string>): Pick<PlexVisual, 'topWatchers' | 'topTitles' | 'recent'> {
  const who = new Map<string, number>()
  const what = new Map<string, number>()
  for (const r of rows) {
    const user = names.get(n0(r?.accountID)) ?? `account ${n0(r?.accountID)}`
    who.set(user, (who.get(user) ?? 0) + 1)
    const title = str(r?.type === 'episode' ? (r.grandparentTitle ?? r.title) : r?.title)
    what.set(title, (what.get(title) ?? 0) + 1)
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10)
  const sorted = [...rows].sort((a, b) => n0(b?.viewedAt) - n0(a?.viewedAt))
  return {
    topWatchers: top(who).map(([user, plays]) => ({ user, plays, minutes: 0 })),
    topTitles:   top(what).map(([title, plays]) => ({ title, plays, minutes: 0 })),
    recent: sorted.slice(0, 12).map(r => ({
      at:      n0(r?.viewedAt) ? n0(r.viewedAt) * 1000 : null,
      user:    names.get(n0(r?.accountID)) ?? `account ${n0(r?.accountID)}`,
      title:   r?.type === 'episode' && r.grandparentTitle ? `${str(r.grandparentTitle)} - ${str(r.title)}` : str(r?.title),
      player:  '—',
      minutes: 0,
    })),
  }
}

/** /library/sections plus each one's totalSize. */
export function librarySections(body: any): Array<{ key: string; title: string; kind: string }> {
  return (Array.isArray(mc(body).Directory) ? mc(body).Directory : [])
    .filter((d: any) => /^\d+$/.test(String(d?.key ?? '')))
    .map((d: any) => ({ key: String(d.key), title: str(d.title, 'Library', 60), kind: str(d.type, 'other', 20) }))
}
export const sectionCount = (body: any): number => n0(mc(body).totalSize ?? mc(body).size)
