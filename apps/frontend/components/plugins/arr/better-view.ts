// =============================================================================
//  HyperProx — Arr Stack, "Find a better copy" and the VPN panel: the page's pure helpers
//
//  Shapes the API answers (routes/arr-better.ts, routes/arr-vpn.ts) take, and the words the panels build from them.
//  No fetching here, so the panels are tested by rendering (test/arr-better.test.tsx).
// =============================================================================

import type { App } from './giveup-view'

export type Verdict = 'ok' | 'anyway' | 'refused' | 'never'
export type Group = 'accepted' | 'queue' | 'mild' | 'refused' | 'never'
export interface BetterRelease {
  id: string; title: string; quality: string; resolution: number | null; source: string; codec: string; size: number
  protocol: 'torrent' | 'usenet' | 'unknown'; seeders: number | null; peers: number | null; ageDays: number | null; grabs: number | null
  indexer: string; languages: string[]; approved: boolean; reasons: string[]; slow: boolean; verdict: Verdict; why?: string
  /** Where it ranks, and the arr's own words for the "details" toggle (both missing from an older server). */
  group?: Group; rawReasons?: string[]
}
export interface BetterAnswer {
  rows: BetterRelease[]; found: number; accepted: number
  groups?: Record<Group, number>
  hidden: { av1: number; threeD: number; hfr: number; zeroSeed: number; executable: number }
  target: string; label: string; have: string | null; swap: { name: string } | null; searchedAt: string; reused: boolean; nextSearchAt: string
}
export interface BetterGrab { result: 'queued' | 'not-seen' | 'removed-executable'; summary: string; notes: string[]; swapped: boolean; top: boolean }
export interface FoundItem { target: string; title: string; detail: string; have: string }
export interface FoundShow { seriesId: number; title: string; detail: string; seasons: Array<{ season: number; episodes: number; files: number }> }

/** The search target for a download in the queue (only a real download id: "d:<hash or id>"). */
export function queueTarget(instance: App, downloadId: string): string | null {
  return /^d:[\x21-\x7e]{1,200}$/.test(downloadId) ? `queue:${instance}:${downloadId}` : null
}

/** What was left out, in one line. Null when nothing was. */
export function betterHidden(h: BetterAnswer['hidden']): string | null {
  const parts = [
    h.av1 ? `${h.av1} AV1` : '', h.threeD ? `${h.threeD} 3D` : '', h.hfr ? `${h.hfr} 48 fps` : '',
    h.executable ? `${h.executable} with a program file` : '', h.zeroSeed ? `${h.zeroSeed} with no seeders` : '',
  ].filter(Boolean)
  const n = h.av1 + h.threeD + h.hfr + h.executable + h.zeroSeed
  return n ? `${n} left out: ${parts.join(', ')}. These are never offered.` : null
}

/**
 * The search in one line: how many were found, and how many of them are in each group, mildest first.
 * "230 found: 0 accepted, 205 only refused because something is already downloading, ..."
 */
export function betterSummary(a: Pick<BetterAnswer, 'found' | 'accepted' | 'groups' | 'hidden' | 'swap'>): string {
  if (a.found === 0) return 'No release found at all on your indexers.'
  if (!a.groups) return `${a.found} found, ${a.accepted} your profile accepts.`
  const g = a.groups
  const left = a.hidden.av1 + a.hidden.threeD + a.hidden.hfr + a.hidden.executable + a.hidden.zeroSeed
  const parts = [
    `${a.accepted} accepted`,
    g.queue ? `${g.queue} only refused because ${a.swap ? 'the slow one is still downloading' : 'something is already downloading'}` : '',
    g.mild ? `${g.mild} refused for a size, seeder, subtitle or custom format reason` : '',
    g.refused ? `${g.refused} refused for other reasons` : '',
    g.never + left ? `${g.never + left} never offered` : '',
  ].filter(Boolean)
  return `${a.found} found: ${parts.join(', ')}.`
}

/** The badge a release wears. */
export function verdictWord(r: BetterRelease): { text: string; tone: 'good' | 'warn' | 'accent' | 'bad' } {
  if (r.verdict === 'ok') return { text: 'Your profile accepts it', tone: 'good' }
  if (r.verdict === 'anyway') return { text: 'Only refused because of the slow one', tone: 'accent' }
  if (r.verdict === 'never') return { text: 'Not offered', tone: 'bad' }
  if (r.group === 'queue') return { text: 'Refused: already downloading', tone: 'accent' }
  return { text: 'Refused', tone: 'warn' }
}

/** The confirm wording for a grab. */
export function betterConfirm(r: BetterRelease, a: Pick<BetterAnswer, 'label' | 'have' | 'swap'>, app: App): string {
  const name = app === 'sonarr' ? 'Sonarr' : app === 'radarr' ? 'Radarr' : 'Lidarr'
  const what = `Download ${r.title} for ${a.label} and move it to the top of qBittorrent's queue?`
  const swap = a.swap ? ` Once it is in the queue, the slow download (${a.swap.name}) is removed and blocklisted so it is not grabbed again.` : ''
  const anyway = r.verdict === 'anyway' ? ` ${name} only objects because the slow download is still queued; this grabs it anyway.` : ''
  const keep = a.have ? ` What you have now (${a.have}) stays until ${name} imports the new copy.` : ''
  const slow = r.slow ? ' Note: it has few seeders, so it may be slow too.' : ''
  if (r.verdict === 'refused') {
    const why = overrideReasons(r, !!a.swap).map(x => x.charAt(0).toLowerCase() + x.slice(1)).join('; ') || 'no reason given'
    return `${name} refuses this because: ${why}. Download it anyway? It goes to the top of qBittorrent's queue.${swap}${keep}${slow}`
  }
  return `${what}${swap}${anyway}${keep}${slow}`
}

/** The reasons a "Download anyway" goes past (in a swap, the slow one being queued is what the swap resolves). */
export function overrideReasons(r: Pick<BetterRelease, 'reasons'>, swap: boolean): string[] {
  return r.reasons.filter(x => !(swap && x === 'Something as good is already downloading'))
}

// ── the VPN panel ────────────────────────────────────────────────────────────

export type FixName = 'set-port' | 'reconnect' | 'restart-qbit'
export interface VpnProblem { code: string; text: string; fix?: FixName }
export interface VpnStatus {
  present: boolean; unavailable?: string; guest?: string
  tunnel: 'up' | 'down' | 'unknown'; health: string | null; provider: string | null; vpnType: string | null
  location: string | null; chosen: string | null; publicIp: string | null; publicIpHidden?: boolean
  portForwarding: boolean; forwardedPort: number | null; listenPort: number | null; portMatch: 'ok' | 'mismatch' | 'no-port' | 'off' | 'unknown'
  downBps: number | null; upBps: number | null; connection: 'connected' | 'firewalled' | 'disconnected' | null
  startedAt: string | null; uptimeSec: number | null; problems: VpnProblem[]; readAt: string
}
export interface VpnActResult { action: FixName; done: boolean; summary: string; notes: string[]; status: VpnStatus }

export const FIX_LABEL: Record<FixName, string> = {
  'set-port': 'Put the forwarded port into qBittorrent',
  reconnect: 'Reconnect the tunnel',
  'restart-qbit': 'Restart qBittorrent',
}

/** What each fix does, said before it runs. */
export function fixConfirm(f: FixName, s: Pick<VpnStatus, 'forwardedPort' | 'listenPort'>): string {
  if (f === 'set-port') return `Tell qBittorrent to listen on ${s.forwardedPort ?? 'the forwarded port'} (it listens on ${s.listenPort ?? 'another port'} now)? Downloads keep running.`
  if (f === 'reconnect') return 'Stop and start the VPN tunnel? Downloads pause while it reconnects, usually under a minute. If Gluetun does not accept the request, the VPN container and qBittorrent are restarted instead, which takes about a minute.'
  return 'Restart qBittorrent? Downloads pause for a few seconds and carry on where they were.'
}

/** The tunnel in one word. */
export function tunnelWord(s: VpnStatus): string {
  return s.tunnel === 'up' ? 'Tunnel up' : s.tunnel === 'down' ? 'Tunnel down' : 'Tunnel state unknown'
}

/** The port pair in words, for the panel and its screen-reader label. */
export function portWord(s: VpnStatus): string {
  switch (s.portMatch) {
    case 'off': return 'Port forwarding is off for this VPN.'
    case 'no-port': return 'The VPN has not handed out a port.'
    case 'unknown': return `The VPN forwards ${s.forwardedPort}; qBittorrent's port could not be read.`
    case 'ok': return `The VPN forwards ${s.forwardedPort} and qBittorrent listens on it.`
    case 'mismatch': return `The VPN forwards ${s.forwardedPort}, but qBittorrent listens on ${s.listenPort}.`
  }
}
