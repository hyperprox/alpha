// =============================================================================
//  HyperProx — Arr Stack "Find a better copy": the ranked list (pure)
//
//  One interactive release search, as rows a person can pick from (built on lib/arr-release/releases.ts):
//   - never offered (lib/arr-release/releases.ts NEVER_OFFERED, the one list): AV1, 3D (and half side-by-side),
//     48 fps and torrents with no seeders are left out with a count, and so is anything whose name shows a program file
//     (the stack's own blocker removes those anyway). Raw disc copies (BR-DISK, ISO, BDMV...) are listed last as
//     "Not offered", with the reason and no button;
//   - ranked in groups: what the profile accepts together with what is ONLY refused because something for the item is
//     already downloading; then what is refused for a mild reason (size, seeders, custom formats, burned-in subtitles);
//     then the rest of what is refused; then what is never offered. Inside a group: quality tier (the arr's own quality
//     order), resolution, accepted first, seeders (grabs for usenet), size;
//   - "slow": a torrent with 3 seeders or fewer;
//   - each row says whether it can be grabbed:
//       ok       the profile accepts it;
//       anyway   the ONLY objection is that something for this item is already downloading ("release in queue already
//                meets cutoff" and its wordings), while that download is being swapped out: "grab anyway";
//       refused  anything else: said plainly, and an admin may still choose "Download anyway" (confirmed, naming the
//                arr's reasons, and audited as an override);
//       never    a hard stop: never grabbed, whatever the request says.
//
//  Tested with recorded answers (test/arr-better.test.ts).
// =============================================================================

import { IN_QUEUE, NEVER_OFFERED, QUEUED_TEXT, isDiscImage, releaseId, releaseView, type ProfileInfo, type ReleaseRow } from '../arr-release/releases'

/** A torrent with this many seeders or fewer is flagged slow. */
export const SLOW_SEEDS = 3

export type Verdict = 'ok' | 'anyway' | 'refused' | 'never'
/** How far down the list a row goes: accepted (and queue-only) first, never-offered last. */
export type Group = 'accepted' | 'queue' | 'mild' | 'refused' | 'never'
const GROUP_ORDER: Record<Group, number> = { accepted: 0, queue: 0, mild: 1, refused: 2, never: 3 }

export interface BetterRow extends ReleaseRow {
  /** A torrent with few seeders: likely to crawl. */
  slow: boolean
  verdict: Verdict
  group: Group
  /** Why it cannot be grabbed as it is (or, for `anyway`, what grabbing it overrides), in plain English. */
  why?: string
  /** The arr's own words, for the "details" toggle. */
  rawReasons: string[]
}

export interface BetterView {
  rows: BetterRow[]
  found: number
  accepted: number
  /** How many rows are in each group, for the one-line summary. */
  groups: Record<Group, number>
  hidden: { av1: number; threeD: number; hfr: number; zeroSeed: number; executable: number }
}

export function rejectionKind(raw: string): 'queue' | 'other' {
  return IN_QUEUE.test(String(raw ?? '')) ? 'queue' : 'other'
}

/** A refusal that a person may well accept: the size limit, the seeders, a custom format score, burned-in subtitles. */
const MILD = /smaller than minimum|larger than maximum|not enough seeders|custom formats?.*score|hardcode(?:d)? subs/i
export const isMildRejection = (raw: string) => MILD.test(String(raw ?? ''))

export const APP_WORD = { sonarr: 'Sonarr', radarr: 'Radarr', lidarr: 'Lidarr' } as const
const rawReasons = (r: any): string[] => (Array.isArray(r?.rejections) ? r.rejections : []).map((x: any) => (typeof x === 'string' ? x : String(x?.reason ?? ''))).filter(Boolean)

/** The never-offered kind of a row that is listed (a disc image), or of one that is hidden. */
export function hardStop(row: Pick<ReleaseRow, 'executable'>, raw: any): 'executable' | 'disc' | null {
  if (row.executable) return 'executable'
  return isDiscImage(raw) ? 'disc' : null
}

/**
 * The rows, ranked, with the hard rules applied. `swap`: the person is replacing a download that is in the queue, so
 * an objection that only says "something is already queued" is what the swap resolves.
 */
export function betterView(raw: any[], o: { app: 'sonarr' | 'radarr' | 'lidarr'; profile?: ProfileInfo | null; swap: boolean }): BetterView & { all: Array<BetterRow & { guid: string; indexerId: number }> } {
  const list = Array.isArray(raw) ? raw : []
  const base = releaseView(list, { app: o.app, profile: o.profile, showZeroSeed: false })
  const extra = new Map<string, { tier: number; reasons: string[]; raw: any }>()
  for (const r of list) {
    const guid = typeof r?.guid === 'string' ? r.guid : ''
    const idx = Number(r?.indexerId)
    if (!guid || !Number.isInteger(idx)) continue
    extra.set(releaseId(guid, idx), { tier: Number(r.qualityWeight) || 0, reasons: rawReasons(r), raw: r })
  }
  let executable = 0
  const rows: Array<BetterRow & { guid: string; indexerId: number; tier: number }> = []
  for (const r of base.all) {
    if (r.executable) { executable += 1; continue }
    const x = extra.get(r.id) ?? { tier: 0, reasons: [], raw: null }
    const slow = r.protocol === 'torrent' && r.seeders !== null && r.seeders <= SLOW_SEEDS
    const raws = x.reasons.map(s => s.slice(0, 200))
    let verdict: Verdict = 'ok'
    let group: Group = 'accepted'
    let why: string | undefined
    const stop = hardStop(r, x.raw)
    if (stop) { verdict = 'never'; group = 'never'; why = `Not offered: ${NEVER_OFFERED[stop]}.` }
    else if (!r.approved) {
      const onlyQueue = x.reasons.length > 0 && x.reasons.every(s => rejectionKind(s) === 'queue')
      const rest = x.reasons.filter(s => rejectionKind(s) !== 'queue')
      if (onlyQueue && o.swap) { verdict = 'anyway'; group = 'queue'; why = 'Only refused because the slow download is still in the queue; swapping it out resolves that.' }
      else if (onlyQueue) { verdict = 'refused'; group = 'queue'; why = 'Something as good is already downloading. To replace it, use "Find a faster copy" on that download in the Queue tab.' }
      else {
        verdict = 'refused'
        group = rest.every(isMildRejection) ? 'mild' : 'refused'
        why = `${APP_WORD[o.app]} refuses it: ${r.reasons.filter(s => !(o.swap && s === QUEUED_TEXT)).join('; ') || 'no reason given'}.`
      }
    }
    rows.push({ ...r, slow, verdict, group, ...(why ? { why } : {}), rawReasons: raws, tier: x.tier })
  }
  rows.sort((a, b) =>
    GROUP_ORDER[a.group] - GROUP_ORDER[b.group] ||
    b.tier - a.tier || (b.resolution ?? 0) - (a.resolution ?? 0) ||
    Number(b.approved) - Number(a.approved) ||
    (b.seeders ?? b.grabs ?? 0) - (a.seeders ?? a.grabs ?? 0) || b.size - a.size)
  const all = rows.map(({ tier: _t, ...r }) => r)
  const groups: Record<Group, number> = { accepted: 0, queue: 0, mild: 0, refused: 0, never: 0 }
  for (const r of all) groups[r.group] += 1
  return {
    all, rows: all.map(({ guid: _g, indexerId: _i, ...r }) => r),
    found: base.found, accepted: rows.filter(r => r.approved && r.verdict !== 'never').length, groups,
    hidden: { ...base.hidden, executable },
  }
}
