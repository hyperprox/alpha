// =============================================================================
//  HyperProx — Arr Stack: one item's releases, as rows a person can read
//
//  The answer of ONE interactive release search (Sonarr/Radarr /api/v3/release, Lidarr /api/v1/release), turned
//  into rows a person can read: quality and resolution, source, codec, size, seeders and peers (torrents) or age
//  and grabs (usenet), indexer, language, and why the arr rejected it, in plain English. Shared by "See what's
//  available" (lib/arr-giveup) and "Find a better copy" (lib/arr-better).
//
//  Some releases are never offered, whatever the person picks (the hard rules):
//   - AV1, 3D and 48 fps releases are hidden, with a count.
//   - A torrent with no seeders is hidden unless the person asks to see them.
//   - A release whose name shows a program file (.exe, .scr, .bat, .msi, .lnk, .js ...) is shown, flagged, and
//     cannot be grabbed. Indexers do not list a torrent's files before it is downloaded, so after a grab the
//     file list is also read from qBittorrent once it has it, and the download is removed if a program file is in
//     it (lib/arr-release/grab.ts).
//
//  Pure: tested with recorded answers (test/arr-giveup.test.ts, test/arr-better.test.ts).
// =============================================================================

import crypto from 'node:crypto'

export interface ReleaseRow {
  /** HyperProx's own id for the row: a hash of the arr's guid and indexer, so the page never handles a guid. */
  id: string
  title: string
  quality: string
  resolution: number | null
  source: string
  codec: string
  size: number
  protocol: 'torrent' | 'usenet' | 'unknown'
  seeders: number | null
  peers: number | null
  ageDays: number | null
  grabs: number | null
  indexer: string
  languages: string[]
  approved: boolean
  /** The arr's own first choice among the approved ones. */
  topPick: boolean
  /** Why the arr rejected it, in plain English (empty when approved). */
  reasons: string[]
  /** A program file in its name: shown, never grabbable. */
  executable: boolean
  /** Not one of the qualities the item's profile accepts. */
  belowProfile: boolean
  /** The confirm wording when it is below the profile. */
  belowNote?: string
}

export interface ReleaseView {
  rows: ReleaseRow[]
  found: number
  approved: number
  hidden: { av1: number; threeD: number; hfr: number; zeroSeed: number }
  /** The most common rejection reasons, plain English, for the item's "why". */
  top: string[]
}

/** What the item's quality profile accepts, for the "below your profile" warning. */
export interface ProfileInfo { name: string; allowed: Set<number>; minResolution: number | null; upgradeAllowed: boolean }

export function profileInfo(p: any): ProfileInfo | null {
  if (!p || typeof p !== 'object') return null
  const allowed = new Set<number>()
  let minRes: number | null = null
  const walk = (items: any[]) => {
    for (const it of Array.isArray(items) ? items : []) {
      if (Array.isArray(it?.items) && it.items.length) {
        if (it.allowed) for (const q of it.items) { const id = Number(q?.quality?.id); if (Number.isInteger(id)) { allowed.add(id); const r = Number(q.quality.resolution); if (r > 0) minRes = minRes === null ? r : Math.min(minRes, r) } }
        continue
      }
      if (!it?.allowed) continue
      const id = Number(it?.quality?.id)
      if (Number.isInteger(id)) allowed.add(id)
      const r = Number(it?.quality?.resolution)
      if (r > 0) minRes = minRes === null ? r : Math.min(minRes, r)
    }
  }
  walk(p.items)
  return { name: String(p.name ?? 'your profile').slice(0, 60), allowed, minResolution: minRes, upgradeAllowed: p.upgradeAllowed !== false }
}

// Tokens are matched between non-alphanumerics, not \b: in "Film_3D_1080p" the underscore is a word character, so
// \b would miss it.
const token = (body: string) => new RegExp(`(?<![A-Za-z0-9])(?:${body})(?![A-Za-z0-9])`, 'i')
export const AV1 = token('AV1|AV01')
export const THREE_D = token('3D|F?SBS|Full-?SBS|H-?SBS|Half-?SBS|TAB|H-?OU|Half-?OU|MVC')
export const HFR = token('48[\\W_]?fps|HFR')
/** A program file, by the final extension of a file's own name (not its folders). */
export const EXECUTABLE = /\.(exe|scr|bat|cmd|com|msi|lnk|js|vbs|ps1|jar|apk)$/i
export const isProgramFile = (name: string) => EXECUTABLE.test(String(name ?? '').split(/[\\/]/).pop()!.trim())

/**
 * What is never offered, whatever the arr says and whatever the person picks: the one list. "See what's available"
 * hides the first four (counted); "Find a better copy" hides those too and shows the last two as "Not offered", with
 * the reason and no button, and its grab refuses them however the request is written.
 */
export const NEVER_OFFERED = {
  av1: 'AV1, which many players cannot play',
  threeD: 'A 3D copy',
  hfr: 'A 48 fps copy',
  zeroSeed: 'Nobody is sharing it (no seeders)',
  executable: 'It has a program file in it',
  disc: "A raw disc copy most players can't play",
} as const
export type NeverOffered = keyof typeof NEVER_OFFERED

/** A raw disc image (BR-DISK, ISO, BDMV, a DVD folder), by its quality, custom formats, name or the arr's own reasons. */
const DISC = token('BR-?DISK|BDMV|ISO|IMG|VIDEO_TS|BD(?:25|50|66|100)|DVD(?:5|9)|DVD-?R|COMPLETE[\\W_]+(?:UHD[\\W_]+)?BLU-?RAY')
export function isDiscImage(r: any): boolean {
  const q = r?.quality?.quality ?? {}
  if (/BR-?DISK/i.test(String(q.name ?? '')) || String(q.modifier ?? '').toLowerCase() === 'brdisk') return true
  const formats = Array.isArray(r?.customFormats) ? r.customFormats.map((f: any) => String(f?.name ?? '')) : []
  if (formats.some((f: string) => DISC.test(f))) return true
  if (DISC.test(String(r?.title ?? ''))) return true
  const rej = (Array.isArray(r?.rejections) ? r.rejections : []).map((x: any) => (typeof x === 'string' ? x : String(x?.reason ?? '')))
  return rej.some((s: string) => /BR-?DISK/i.test(s))
}

/** Is this a hard-rule release (never offered)? */
export function hardRule(title: string, formats: string[] = []): 'av1' | 'threeD' | 'hfr' | null {
  const all = [title, ...formats].join(' ')
  if (AV1.test(all)) return 'av1'
  if (THREE_D.test(all)) return 'threeD'
  if (HFR.test(all)) return 'hfr'
  return null
}

const SOURCE: Record<string, string> = {
  bluray: 'BluRay', blurayraw: 'BluRay', remux: 'BluRay', webdl: 'WEB', web: 'WEB', webrip: 'WEBRip', tv: 'HDTV', television: 'HDTV',
  televisionraw: 'HDTV', dvd: 'DVD', cam: 'CAM', telesync: 'Telesync', telecine: 'Telecine', workprint: 'Workprint', unknown: 'Unknown',
}

export function codecOf(title: string): string {
  if (/\b(x|h)\.?265\b|\bHEVC\b/i.test(title)) return 'HEVC'
  if (/\b(x|h)\.?264\b|\bAVC\b/i.test(title)) return 'H.264'
  if (AV1.test(title)) return 'AV1'
  if (/\bXviD\b|\bDivX\b/i.test(title)) return 'XviD'
  if (/\bVC-?1\b/i.test(title)) return 'VC-1'
  if (/\bMPEG-?2\b/i.test(title)) return 'MPEG-2'
  if (/\bFLAC\b/i.test(title)) return 'FLAC'
  if (/\bMP3\b/i.test(title)) return 'MP3'
  return ''
}

/** The arr's objection that something for the item is already downloading, in its Sonarr, Radarr and Lidarr wordings. */
export const IN_QUEUE = /release in queue|already in (?:the )?queue|another release is queued|queued release/i
export const QUEUED_TEXT = 'Something as good is already downloading'

/** A custom format name that means "low quality" (the common LQ and Low Quality formats). */
const LOW_QUALITY = /(?<![A-Za-z0-9])LQ(?![A-Za-z0-9])|low[\s_-]?quality/i

/** One of the arr's rejection strings in plain English. Unknown ones are passed through as written. */
export function plainRejection(raw: string): string {
  const s = String(raw ?? '').trim()
  let m: RegExpExecArray | null
  if (/BR-?DISK/i.test(s)) return NEVER_OFFERED.disc
  if ((m = /^(.+?) is not wanted in profile/i.exec(s))) return `Below your quality profile (${m[1]})`
  if ((m = /Custom Formats? (.+?) ha(?:ve|s) score (-?\d+) below .*minimum/i.exec(s))) {
    return LOW_QUALITY.test(m[1]) ? `Tagged low quality by your custom formats (${m[1]})` : `Custom format score too low (${m[1]}: ${m[2]})`
  }
  if (/Custom Formats? .*score .*below/i.test(s)) return 'Custom format score too low'
  if ((m = /Not enough seeders: (\d+)\. Minimum seeders: (\d+)/i.exec(s))) return `Too few seeders (${m[1]}; your indexer setting needs ${m[2]})`
  if (/smaller than minimum allowed/i.test(s)) return 'Smaller than your size limit (likely a poor copy)'
  if (/larger than maximum allowed/i.test(s)) return 'Larger than your size limit'
  if ((m = /Language .* is wanted, but found (.+)$/i.exec(s))) return `Wrong language (${m[1]})`
  if (/language/i.test(s) && /not wanted|unwanted|wanted/i.test(s)) return 'Wrong language'
  if (/hardcode(d)? subs/i.test(s)) return 'Has burned-in (hardcoded) subtitles'
  if (/blocklist/i.test(s)) return 'You blocklisted this release before'
  if (IN_QUEUE.test(s)) return QUEUED_TEXT
  if (/already meets cutoff|not an upgrade|existing file/i.test(s)) return 'Not better than what you already have'
  if (/older than|maximum age|retention/i.test(s)) return 'Too old for your usenet retention'
  if (/delay/i.test(s)) return 'Held back by a delay profile'
  if (/not monitored/i.test(s)) return 'It is not being searched for (unmonitored)'
  if (/sample/i.test(s)) return 'Only a sample'
  if (/full season|season pack|partial season/i.test(s)) return 'A season pack where one episode was asked for (or the other way round)'
  if (/unknown (series|movie|artist|album)|unable to (parse|identify)|wrong (series|movie)/i.test(s)) return 'Could not tell what it is'
  if (/(must|does not) contain/i.test(s)) return 'A release-name rule rejects it'
  if (/indexer.*disabled|download client/i.test(s)) return s
  return s.slice(0, 160)
}

export const releaseId = (guid: string, indexerId: number) => crypto.createHash('sha256').update(`${indexerId}\u0000${guid}`).digest('hex').slice(0, 24)

/** Turn an arr's release list into rows, best first, with the hard rules applied. */
export function releaseView(raw: any[], o: { app: 'sonarr' | 'radarr' | 'lidarr'; profile?: ProfileInfo | null; showZeroSeed?: boolean; now?: number }): ReleaseView & { all: Array<ReleaseRow & { guid: string; indexerId: number }> } {
  const list = Array.isArray(raw) ? raw : []
  const hidden = { av1: 0, threeD: 0, hfr: 0, zeroSeed: 0 }
  const reasonCount = new Map<string, number>()
  const all: Array<ReleaseRow & { guid: string; indexerId: number; weight: number; qWeight: number }> = []
  const appWord = o.app === 'sonarr' ? 'Sonarr' : o.app === 'radarr' ? 'Radarr' : 'Lidarr'
  for (const r of list) {
    const guid = typeof r?.guid === 'string' ? r.guid : ''
    const indexerId = Number(r?.indexerId)
    if (!guid || !Number.isInteger(indexerId)) continue
    const title = String(r.title ?? '').slice(0, 300)
    const q = r.quality?.quality ?? {}
    const formats = Array.isArray(r.customFormats) ? r.customFormats.map((f: any) => String(f?.name ?? '')) : []
    const reasons = (Array.isArray(r.rejections) ? r.rejections : []).map((x: any) => plainRejection(typeof x === 'string' ? x : String(x?.reason ?? '')))
    if (!r.approved) for (const x of new Set<string>(reasons)) reasonCount.set(generalise(x), (reasonCount.get(generalise(x)) ?? 0) + 1)
    const protocol = r.protocol === 'torrent' ? 'torrent' : r.protocol === 'usenet' ? 'usenet' : 'unknown'
    const seeders = protocol === 'torrent' && Number.isFinite(Number(r.seeders)) ? Number(r.seeders) : null
    const res = Number(q.resolution) > 0 ? Number(q.resolution) : null
    const qid = Number(q.id)
    const below = !!o.profile && Number.isInteger(qid) && !o.profile.allowed.has(qid)
    const row = {
      id: releaseId(guid, indexerId), guid, indexerId, title,
      quality: String(q.name ?? 'Unknown'), resolution: res, source: SOURCE[String(q.source ?? '').toLowerCase()] ?? (q.source ? String(q.source) : ''),
      codec: codecOf(title), size: Number(r.size) || 0, protocol: protocol as ReleaseRow['protocol'],
      seeders, peers: protocol === 'torrent' && Number.isFinite(Number(r.leechers)) ? Number(r.leechers) : null,
      ageDays: Number.isFinite(Number(r.age)) ? Number(r.age) : null,
      grabs: protocol === 'usenet' && Number.isFinite(Number(r.grabs)) ? Number(r.grabs) : null,
      indexer: String(r.indexer ?? '').replace(/\s*\(Prowlarr\)$/, '').slice(0, 60),
      languages: Array.isArray(r.languages) ? r.languages.map((l: any) => String(l?.name ?? '')).filter(Boolean).slice(0, 4) : [],
      approved: r.approved === true, topPick: false, reasons: r.approved ? [] : [...new Set<string>(reasons)],
      executable: isProgramFile(title), belowProfile: below,
      ...(below ? { belowNote: belowNote(String(q.name ?? 'this quality'), o.profile!, appWord) } : {}),
      weight: Number.isFinite(Number(r.releaseWeight)) ? Number(r.releaseWeight) : 1e9,
      qWeight: Number(r.qualityWeight) || 0,
    }
    const hard = hardRule(title, formats)
    if (hard) { hidden[hard] += 1; continue }
    if (protocol === 'torrent' && seeders === 0 && !o.showZeroSeed) { hidden.zeroSeed += 1; continue }
    all.push(row)
  }
  // The arr's own first choice: the approved release with the lowest release weight (its ranking).
  const approved = all.filter(r => r.approved && !r.executable).sort((a, b) => a.weight - b.weight)
  if (approved[0]) approved[0].topPick = true
  all.sort((a, b) =>
    Number(b.approved) - Number(a.approved) || Number(b.topPick) - Number(a.topPick) ||
    (b.resolution ?? 0) - (a.resolution ?? 0) || b.qWeight - a.qWeight ||
    (b.seeders ?? b.grabs ?? 0) - (a.seeders ?? a.grabs ?? 0) || b.size - a.size)
  const top = [...reasonCount].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} (${n})`)
  const clean = all.map(({ weight: _w, qWeight: _q, ...r }) => r)
  return {
    all: clean, rows: clean.map(({ guid: _g, indexerId: _i, ...r }) => r) as any,
    found: list.length, approved: list.filter(r => r?.approved === true).length, hidden, top,
  }
}

/** A reason without its numbers, so "Too few seeders (0...)" and "(1...)" count together. */
function generalise(reason: string): string {
  return reason.replace(/\s*\([^)]*\)$/, '')
}

function belowNote(quality: string, p: ProfileInfo, app: string): string {
  const want = p.minResolution ? `${p.minResolution}p or better` : `a quality in "${p.name}"`
  return p.upgradeAllowed
    ? `This is ${quality}; your profile wants ${want}. ${app} will keep looking for a better copy and replace it when one appears.`
    : `This is ${quality}; your profile wants ${want}. Upgrades are off in that profile, so ${app} will keep this copy.`
}
