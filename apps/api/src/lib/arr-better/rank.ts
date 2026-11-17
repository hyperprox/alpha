// =============================================================================
//  HyperProx — Arr Stack "Find a better copy": the ranked list (pure)
//
//  One interactive release search, as rows a person can pick from (built on lib/arr-release/releases.ts):
//   - never offered: AV1, 3D (and half side-by-side), 48 fps, torrents with no seeders, and anything whose name shows
//     a program file (the stack's own blocker removes those anyway, so offering one would only waste a grab);
//   - ranked: what the item's quality profile accepts first, then by quality tier (the arr's own quality order), then
//     by seeders (grabs for usenet), then size;
//   - "slow": a torrent with 3 seeders or fewer;
//   - each row says whether it can be grabbed:
//       ok       the profile accepts it;
//       anyway   the ONLY objection is that something for this item is already downloading ("release in queue already
//                meets cutoff" and its wordings). Offered as "grab anyway" only when swapping that download out;
//       refused  anything else ("already meets cutoff", "smaller than minimum", ...): said plainly, never grabbed.
//
//  Tested with recorded answers (test/arr-better.test.ts).
// =============================================================================

import { IN_QUEUE, QUEUED_TEXT, releaseId, releaseView, type ProfileInfo, type ReleaseRow } from '../arr-release/releases'

/** A torrent with this many seeders or fewer is flagged slow. */
export const SLOW_SEEDS = 3

export type Verdict = 'ok' | 'anyway' | 'refused'

export interface BetterRow extends ReleaseRow {
  /** A torrent with few seeders: likely to crawl. */
  slow: boolean
  verdict: Verdict
  /** Why it cannot be grabbed (or, for `anyway`, what grabbing it overrides), in plain English. */
  why?: string
}

export interface BetterView {
  rows: BetterRow[]
  found: number
  accepted: number
  hidden: { av1: number; threeD: number; hfr: number; zeroSeed: number; executable: number }
}

export function rejectionKind(raw: string): 'queue' | 'other' {
  return IN_QUEUE.test(String(raw ?? '')) ? 'queue' : 'other'
}

const APP_WORD = { sonarr: 'Sonarr', radarr: 'Radarr', lidarr: 'Lidarr' } as const
const rawReasons = (r: any): string[] => (Array.isArray(r?.rejections) ? r.rejections : []).map((x: any) => (typeof x === 'string' ? x : String(x?.reason ?? ''))).filter(Boolean)

/**
 * The rows, ranked, with the hard rules applied. `swap`: the person is replacing a download that is in the queue, so
 * an objection that only says "something is already queued" is what the swap resolves.
 */
export function betterView(raw: any[], o: { app: 'sonarr' | 'radarr' | 'lidarr'; profile?: ProfileInfo | null; swap: boolean }): BetterView & { all: Array<BetterRow & { guid: string; indexerId: number }> } {
  const list = Array.isArray(raw) ? raw : []
  const base = releaseView(list, { app: o.app, profile: o.profile, showZeroSeed: false })
  const extra = new Map<string, { tier: number; reasons: string[] }>()
  for (const r of list) {
    const guid = typeof r?.guid === 'string' ? r.guid : ''
    const idx = Number(r?.indexerId)
    if (!guid || !Number.isInteger(idx)) continue
    extra.set(releaseId(guid, idx), { tier: Number(r.qualityWeight) || 0, reasons: rawReasons(r) })
  }
  let executable = 0
  const rows: Array<BetterRow & { guid: string; indexerId: number; tier: number }> = []
  for (const r of base.all) {
    if (r.executable) { executable += 1; continue }
    const x = extra.get(r.id) ?? { tier: 0, reasons: [] }
    const slow = r.protocol === 'torrent' && r.seeders !== null && r.seeders <= SLOW_SEEDS
    let verdict: Verdict = 'ok'
    let why: string | undefined
    if (!r.approved) {
      const onlyQueue = x.reasons.length > 0 && x.reasons.every(s => rejectionKind(s) === 'queue')
      if (onlyQueue && o.swap) { verdict = 'anyway'; why = 'Only refused because the slow download is still in the queue; swapping it out resolves that.' }
      else if (onlyQueue) { verdict = 'refused'; why = 'Something for it is already downloading. Use "Find a faster copy" on that download in the Queue tab.' }
      else { verdict = 'refused'; why = `${APP_WORD[o.app]} refuses it: ${r.reasons.filter(s => !(o.swap && s === QUEUED_TEXT)).join('; ') || 'no reason given'}.` }
    }
    rows.push({ ...r, slow, verdict, ...(why ? { why } : {}), tier: x.tier })
  }
  rows.sort((a, b) =>
    Number(b.approved) - Number(a.approved) ||
    b.tier - a.tier || (b.resolution ?? 0) - (a.resolution ?? 0) ||
    (b.seeders ?? b.grabs ?? 0) - (a.seeders ?? a.grabs ?? 0) || b.size - a.size)
  const all = rows.map(({ tier: _t, ...r }) => r)
  return {
    all, rows: all.map(({ guid: _g, indexerId: _i, ...r }) => r),
    found: base.found, accepted: rows.filter(r => r.approved).length,
    hidden: { ...base.hidden, executable },
  }
}
