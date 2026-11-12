// =============================================================================
//  HyperProx — Arr Stack queue, "Why this download" (pure)
//
//  Says in a sentence why a download exists and what it will do: for each episode (or the film) it covers, compare
//  what is on disk now with the release's quality. No file → it fills it. A worse file → it upgrades it. The same or a
//  better file → it is already had and the release will be skipped. For a finished ("done") download the same facts
//  are told in the past tense: what was imported and which better copies were kept.
//
//  Pure: the caller fetches the episodes and files (lookup.ts) and passes them in. Nothing here touches the network.
// =============================================================================

/** What is on disk for one episode (or the film, keyed by movie id). `quality` is the Arr's quality name, e.g. "WEBDL-1080p". */
export interface FileInfo { hasFile: boolean; quality: string | null; season: number | null; number: number | null; /** The series' or film's quality profile, when it could be read. */ profile?: Profile | null }

// ── Quality profiles ─────────────────────────────────────────────────────────

/**
 * A quality profile, reduced to what decides an upgrade: the order of its items (lowest first; the qualities of one
 * group share a place), whether upgrades are allowed, and the place of the cutoff.
 */
export interface Profile { name: string; upgradeAllowed: boolean; order: Map<string, number>; allowed: Set<string>; cutoff: number | null }

/** Sonarr, Radarr and Lidarr profiles share one shape: items (a quality, or a group of qualities), cutoff (a quality or group id). Null when unreadable. */
export function compileProfile(p: any): Profile | null {
  if (!p || !Array.isArray(p.items) || !p.items.length) return null
  const order = new Map<string, number>(), allowed = new Set<string>()
  let cutoff: number | null = null
  const target = Number(p.cutoff)
  p.items.forEach((it: any, i: number) => {
    const group = Array.isArray(it?.items) && it.items.length > 0
    const names: unknown[] = group ? it.items.map((x: any) => x?.quality?.name) : [it?.quality?.name]
    for (const n of names) if (typeof n === 'string' && n) { order.set(n, i); if (it?.allowed !== false) allowed.add(n) }
    const id = group ? it?.id : it?.quality?.id
    if (Number.isFinite(target) && Number(id) === target) cutoff = i
  })
  return order.size ? { name: String(p.name ?? '').slice(0, 60), upgradeAllowed: p.upgradeAllowed === true, order, allowed, cutoff } : null
}

/**
 * What the profile says about replacing a file of quality `have` with a release of quality `rel`.
 *   upgrade  the profile allows upgrades, the file is below the cutoff and the release ranks higher in the profile
 *   target   the release ranks higher but the file already meets the target (at or above the cutoff, or upgrades are off)
 *   skip     the release does not rank higher than the file in the profile
 * Null when the profile does not list the file's quality (or has no cutoff to judge by): the caller falls back to the generic ranking.
 */
export function profileVerdict(prof: Profile | null | undefined, have: string | null, rel: string | null): 'upgrade' | 'target' | 'skip' | null {
  if (!prof || !have || !rel) return null
  const hp = prof.order.get(have)
  if (hp === undefined) return null
  if (have === rel) return 'skip'
  const rp = prof.allowed.has(rel) ? prof.order.get(rel) : undefined
  // A release the profile does not allow can never be an upgrade: the file stays, and it either meets the target or not.
  if (rp === undefined) return prof.upgradeAllowed && prof.cutoff !== null && hp < prof.cutoff ? 'skip' : 'target'
  if (rp <= hp) return 'skip'
  if (!prof.upgradeAllowed) return 'target'
  if (prof.cutoff === null) return null
  return hp < prof.cutoff ? 'upgrade' : 'target'
}

export interface Rank { res: number; src: number; resLabel: string; srcLabel: string }

const SOURCES: Array<[RegExp, number, string]> = [
  [/remux/i, 6, 'Remux'],
  [/blu-?ray|bdrip|brrip/i, 5, 'Bluray'],
  [/web[-\s]?dl/i, 4, 'WEB-DL'],
  [/web[-\s]?rip/i, 3, 'WEBRip'],
  [/hdtv|raw-?hd/i, 2, 'HDTV'],
  [/dvd/i, 1, 'DVD'],
  [/sdtv/i, 0, 'SDTV'],
]

/** "WEBDL-1080p" → 1080 / WEB-DL. Null when the name says neither (e.g. "Unknown"). Higher resolution wins, then higher source. */
export function parseQuality(name: string | null | undefined): Rank | null {
  const n = String(name ?? '')
  if (!n) return null
  const src = SOURCES.find(([re]) => re.test(n))
  const m = /(\d{3,4})p/i.exec(n)
  if (!src && !m) return null
  const res = m ? Number(m[1]) : (src && src[1] <= 1 ? 480 : 1080)
  return { res, src: src ? src[1] : 2, resLabel: `${res}p`, srcLabel: src ? src[2] : '' }
}

/** Positive when `a` is better than `b`: resolution first, then source (Bluray above WEB-DL above WEBRip above HDTV). */
export function compareQuality(a: Rank, b: Rank): number {
  return a.res - b.res || a.src - b.src
}

type Kind = 'fills' | 'upgrade' | 'have'
interface Ep { season: number | null; number: number | null }

const two = (n: number) => String(n).padStart(2, '0')

/** [E01,E02,E03,E05] → "E01–E03, E05"; with `withSeason`, "S01E01–E03". Runs only join inside one season. */
export function rangeText(eps: Ep[], withSeason: boolean): string {
  const u = [...new Map(eps.filter(e => e.number !== null).map(e => [`${e.season ?? -1}:${e.number}`, e])).values()]
    .sort((a, b) => (a.season ?? -1) - (b.season ?? -1) || (a.number as number) - (b.number as number))
  const runs: string[] = []
  let i = 0
  while (i < u.length) {
    let j = i
    while (j + 1 < u.length && u[j + 1].season === u[i].season && (u[j + 1].number as number) === (u[j].number as number) + 1) j++
    const pre = withSeason && u[i].season !== null ? `S${two(u[i].season as number)}` : ''
    runs.push(i === j ? `${pre}E${two(u[i].number as number)}` : `${pre}E${two(u[i].number as number)}–E${two(u[j].number as number)}`)
    i = j + 1
  }
  return runs.length > 4 ? `${runs.slice(0, 4).join(', ')} +${runs.length - 4} more` : runs.join(', ')
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const copies = (n: number) => `${n} better ${n === 1 ? 'copy' : 'copies'}`

/**
 * One line for a Sonarr download. `ids` are the episode ids the queue rows cover, `info` what is on disk for them,
 * `release` the release's quality name. Null when nothing is known about any of them.
 */
export function whySonarr(ids: number[], info: Map<number, FileInfo>, release: string | null, done: boolean): string | null {
  const rel = parseQuality(release)
  const eps = [...new Set(ids)].map(id => ({ id, f: info.get(id) })).filter((x): x is { id: number; f: FileInfo } => !!x.f)
  if (!eps.length) return null
  const withSeason = new Set(eps.map(e => e.f.season)).size > 1
  const at = (e: { f: FileInfo }): Ep => ({ season: e.f.season, number: e.f.number })

  if (done) {
    let imported = 0, kept = 0, atTarget = 0, none = 0
    for (const e of eps) {
      const have = parseQuality(e.f.quality)
      if (!e.f.hasFile) none++
      else if (rel && have && compareQuality(have, rel) > 0) kept++
      // A different quality that the profile says is not worth replacing (at the cutoff, or upgrades off): kept as it was.
      else if (e.f.quality !== release && profileVerdict(e.f.profile, e.f.quality, release) === 'target') atTarget++
      else imported++
    }
    const parts = [imported ? `Imported ${imported}` : '', kept ? `kept ${copies(kept)}` : '', atTarget ? `kept ${atTarget} (already at your quality target)` : '', none ? `${none} still without a file` : ''].filter(Boolean)
    return parts.length ? `${cap(parts.join(' · '))}; nothing left to import.` : null
  }

  const fills: Ep[] = [], have: Ep[] = [], target: Ep[] = []
  const ups = new Map<string, { label: string; verb: string; eps: Ep[] }>()
  for (const e of eps) {
    const kind = classify(e.f, rel, release)
    if (kind === null) continue
    if (kind.kind === 'fills') fills.push(at(e))
    else if (kind.kind === 'have') (kind.target ? target : have).push(at(e))
    else {
      const k = `${kind.verb}|${kind.label}`
      const g = ups.get(k) ?? { label: kind.label, verb: kind.verb, eps: [] }
      g.eps.push(at(e)); ups.set(k, g)
    }
  }
  const parts: string[] = []
  if (fills.length) parts.push(`fills ${rangeText(fills, withSeason)}`)
  for (const g of ups.values()) parts.push(`${g.verb} ${rangeText(g.eps, withSeason)} (${g.label})`)
  if (have.length) parts.push(`already have ${rangeText(have, withSeason)} (will be skipped)`)
  if (target.length) parts.push(`already have ${rangeText(target, withSeason)} (meets your quality target, will be skipped)`)
  if (!parts.length) return null
  return cap(parts.length > 5 ? `${parts.slice(0, 5).join(' · ')} · +${parts.length - 5} more` : parts.join(' · '))
}

function classify(f: FileInfo, rel: Rank | null, relName: string | null): { kind: Kind; label: string; verb: string; target?: boolean } | null {
  if (!f.hasFile) return { kind: 'fills', label: '', verb: '' }
  const have = parseQuality(f.quality)
  // The series' own profile decides when it can: the generic ranking only stands in when the profile is unknown.
  const v = profileVerdict(f.profile, f.quality, relName)
  if (v === 'skip') return { kind: 'have', label: '', verb: '' }
  if (v === 'target') return { kind: 'have', label: '', verb: '', target: true }
  if (v === 'upgrade' && (!rel || !have)) return { kind: 'upgrade', verb: 'may replace', label: `${f.quality} → ${relName}` }
  if (!rel || !have) return null
  if (v === null && compareQuality(rel, have) <= 0) return { kind: 'have', label: '', verb: '' }
  // A new resolution is an upgrade. The same resolution from a better source is only "may replace": the Arr decides.
  return rel.res !== have.res
    ? { kind: 'upgrade', verb: 'upgrades', label: `${have.resLabel} → ${rel.resLabel}` }
    : { kind: 'upgrade', verb: 'may replace', label: `${have.srcLabel} → ${rel.srcLabel}` }
}

/** The episodes a release's per-file messages name: "Example.Show.S02E01E02.1080p" → S02E01, S02E02. */
export function containedEpisodes(titles: string[]): Ep[] {
  const out: Ep[] = []
  for (const t of titles) {
    for (const m of t.matchAll(/S(\d{1,2})((?:[ ._-]?E\d{1,3})+)/gi)) {
      for (const e of m[2].matchAll(/E(\d{1,3})/gi)) out.push({ season: Number(m[1]), number: Number(e[1]) })
    }
  }
  return out
}

/** How many of the covered episodes still have no file, and whether every one of them could be looked up. */
export function coverage(ids: number[], info: Map<number, FileInfo>): { unknown: number; missing: Ep[]; have: Ep[] } {
  const missing: Ep[] = [], have: Ep[] = []
  let unknown = 0
  for (const id of new Set(ids)) {
    const f = info.get(id)
    if (!f) unknown++
    else (f.hasFile ? have : missing).push({ season: f.season, number: f.number })
  }
  return { unknown, missing, have }
}

/**
 * An import-blocked pack that says everything is already imported while some episodes it covers still have no file:
 * Sonarr counts them as queued, so it never searches for them. `titles` are the per-file names in its messages.
 */
export function whyIncomplete(ids: number[], info: Map<number, FileInfo>, titles: string[]): string | null {
  const all = ids.map(id => info.get(id)).filter((f): f is FileInfo => !!f).map(f => ({ season: f.season, number: f.number }))
  const cov = coverage(ids, info)
  if (!all.length || !cov.missing.length) return null
  const withSeason = new Set(all.map(e => e.season)).size > 1
  const seasons = [...new Set(all.map(e => e.season).filter((n): n is number => n !== null))]
  const claimed = !withSeason && seasons.length === 1 ? `S${two(seasons[0])} (${rangeText(all, false)})` : rangeText(all, true)
  const named = containedEpisodes(titles)
  const contained = named.length ? named : cov.have
  const n = cov.missing.length
  const held = contained.length ? `only contained ${rangeText(contained, withSeason)}` : 'none of its episodes has a file yet'
  return `This release claims ${claimed} but ${held}; ${n} ${n === 1 ? 'episode is' : 'episodes are'} still missing and won't be searched while it sits here.`
}

const sizeText = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`)

/**
 * A download whose only message is "Sample": Sonarr and Radarr judge that from the file's length against the episode's
 * or film's runtime. The file's own length is not read here (that takes a manual-import preview per download), so this
 * gives the runtime when the queue row carries it and the size either way. Pure: reads the queue rows only.
 */
export function whySample(rows: any[], episodic: boolean): string {
  const first = rows[0] ?? {}
  const runtime = Number(episodic ? (first.episode?.runtime ?? first.series?.runtime) : first.movie?.runtime)
  const size = Number(first.size)
  const what = episodic ? 'the episode' : 'the film'
  const who = episodic ? 'Sonarr' : 'Radarr'
  const big = Number.isFinite(size) && size > 0 ? sizeText(size) : null
  if (Number.isFinite(runtime) && runtime > 0) {
    return `${who} thinks this is a preview clip, not ${what}: ${episodic ? 'episodes of this show run' : 'this film runs'} about ${Math.round(runtime)} min${big ? `, and this download is only ${big}` : ''}.`
  }
  return `${who} thinks this is a preview clip, not ${what}${big ? `: ${big}, much smaller than ${episodic ? "this show's other episodes" : 'a full film'}` : ''}.`
}

/** One line for a Radarr download. `file` is what is on disk for the film. */
export function whyRadarr(file: FileInfo | undefined, release: string | null, done: boolean): string | null {
  if (!file) return null
  const rel = parseQuality(release), have = parseQuality(file.quality)
  const full = (r: Rank) => `${r.resLabel}${r.srcLabel ? ` ${r.srcLabel}` : ''}`
  const v = file.hasFile && file.quality !== release ? profileVerdict(file.profile, file.quality, release) : null
  if (done) {
    if (!file.hasFile) return null
    if (rel && have && compareQuality(have, rel) > 0) return `Kept your better copy (${full(have)}); nothing left to import.`
    return v === 'target' ? 'Kept your copy (already at your quality target); nothing left to import.' : 'Imported this release; nothing left to import.'
  }
  if (!file.hasFile) return 'Missing film: this will fill it.'
  if (!rel || !have) return null
  if (v === 'target') return `Already have ${full(have)} (meets your quality target): this will be skipped.`
  if (v === 'skip') return `Already have ${full(have)}: this will be skipped.`
  if (v === 'upgrade') return `Upgrades ${full(have)} → ${full(rel)}.`
  return compareQuality(rel, have) > 0 ? `Upgrades ${full(have)} → ${full(rel)}.` : `Already have ${full(have)}: this will be skipped.`
}

// ── Lidarr (music) ───────────────────────────────────────────────────────────

/**
 * What is on disk for one album: the tracks it should have (null when Lidarr does not say), how many have a file, and
 * the quality of those files ("FLAC", "MP3-320"), counted by name.
 */
export interface AlbumInfo { title: string | null; total: number | null; have: number; files: Array<{ quality: string | null; count: number }>; profile?: Profile | null }

export interface AudioRank { rank: number; label: string; lossless: boolean }

/**
 * "FLAC" → lossless; "MP3-320" → 320 kbps MP3; "MP3-VBR-V0" → about 245 kbps. Higher rank is better: any lossless
 * format beats any lossy one, then bitrate. Null when the name says neither (e.g. "Unknown").
 */
export function parseAudioQuality(name: string | null | undefined): AudioRank | null {
  const n = String(name ?? '').trim()
  if (!n || /^unknown$/i.test(n)) return null
  const lossless = /flac|alac|wav|ape|wavpack|lossless/i.test(n)
  if (lossless) {
    const fmt = /alac/i.test(n) ? 'ALAC' : /wav(?!pack)/i.test(n) ? 'WAV' : /wavpack/i.test(n) ? 'WavPack' : /\bape\b/i.test(n) ? 'APE' : 'FLAC'
    const deep = /24\s*-?\s*bit/i.test(n)
    return { rank: deep ? 1100 : 1000, label: deep ? `${fmt} 24-bit` : fmt, lossless: true }
  }
  const codec = /aac/i.test(n) ? 'AAC' : /mp3/i.test(n) ? 'MP3' : /vorbis|ogg/i.test(n) ? 'Vorbis' : /opus/i.test(n) ? 'Opus' : /wma/i.test(n) ? 'WMA' : null
  if (!codec) return null
  const vbr = /v(\d)\b/i.exec(n)
  if (vbr) return { rank: 245 - 55 * Math.min(4, Number(vbr[1])) / 2, label: `${codec} VBR V${vbr[1]}`, lossless: false }
  const kbps = /(\d{2,3})/.exec(n)
  if (!kbps) return { rank: 128, label: codec, lossless: false }
  return { rank: Number(kbps[1]), label: `${codec} ${Number(kbps[1])}`, lossless: false }
}

/** Positive when `a` is better than `b`. */
export const compareAudio = (a: AudioRank, b: AudioRank): number => a.rank - b.rank

const noun = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The worst quality among the files on disk (the first one a better release would replace). Null when none is readable. */
function worstOnDisk(albums: AlbumInfo[]): AudioRank | null {
  let worst: AudioRank | null = null
  for (const a of albums) for (const f of a.files) {
    const r = parseAudioQuality(f.quality)
    if (r && (worst === null || compareAudio(r, worst) < 0)) worst = r
  }
  return worst
}
function bestOnDisk(albums: AlbumInfo[]): AudioRank | null {
  let best: AudioRank | null = null
  for (const a of albums) for (const f of a.files) {
    const r = parseAudioQuality(f.quality)
    if (r && (best === null || compareAudio(r, best) > 0)) best = r
  }
  return best
}

/** The raw quality name of the worst file on disk (what the profile is asked about). */
function worstNameOnDisk(albums: AlbumInfo[]): string | null {
  let worst: { r: AudioRank; name: string } | null = null
  for (const a of albums) for (const f of a.files) {
    const r = parseAudioQuality(f.quality)
    if (r && f.quality && (worst === null || compareAudio(r, worst.r) < 0)) worst = { r, name: f.quality }
  }
  return worst ? worst.name : null
}

/** Totals over the albums a download covers. `total` is null when any album's track count is not known. */
function tally(albums: AlbumInfo[]): { total: number | null; have: number; missing: number | null } {
  const have = albums.reduce((t, a) => t + a.have, 0)
  if (albums.some(a => a.total === null)) return { total: null, have, missing: null }
  const total = albums.reduce((t, a) => t + (a.total as number), 0)
  const missing = albums.reduce((t, a) => t + Math.max(0, (a.total as number) - a.have), 0)
  return { total, have, missing }
}

/**
 * One line for a Lidarr download: "Fills 4 of 12 tracks · upgrades MP3 320 → FLAC". `release` is the release's quality
 * name. Done: the same facts in the past tense. Null when nothing is known about any album.
 */
export function whyLidarr(albums: AlbumInfo[], release: string | null, done: boolean): string | null {
  if (!albums.length) return null
  const rel = parseAudioQuality(release)
  const t = tally(albums)
  // The artist's quality profile decides when it can; the generic ranking stands in when it is unknown.
  const prof = albums.find(a => a.profile)?.profile ?? null
  const worstName = worstNameOnDisk(albums)
  const v = worstName && worstName !== release ? profileVerdict(prof, worstName, release) : null
  if (done) {
    const best = bestOnDisk(albums)
    if (rel && best && compareAudio(best, rel) > 0) return `Kept your better copy (${best.label}); nothing left to import.`
    return v === 'target' ? 'Kept your copy (already at your quality target); nothing left to import.' : 'Imported this release; nothing left to import.'
  }
  const parts: string[] = []
  if (t.missing !== null && t.total !== null) {
    if (t.missing > 0) parts.push(`fills ${t.missing} of ${noun(t.total, 'track')}`)
  } else if (t.have === 0) parts.push('fills a missing album')
  if (t.have > 0 && rel) {
    const worst = worstOnDisk(albums)
    if (v === 'upgrade' && worst) parts.push(`upgrades ${worst.label} → ${rel.label}`)
    else if (v === 'target' && worst && t.missing === 0) parts.push(`already have ${bestOnDisk(albums)!.label} (meets your quality target, will be skipped)`)
    else if (v === 'skip' && worst && t.missing === 0) parts.push(`already have ${bestOnDisk(albums)!.label} (will be skipped)`)
    else if (v === null && worst && compareAudio(rel, worst) > 0) parts.push(`upgrades ${worst.label} → ${rel.label}`)
    else if (v === null && worst && t.missing === 0) parts.push(`already have ${bestOnDisk(albums)!.label} (will be skipped)`)
  }
  return parts.length ? cap(parts.join(' · ')) : null
}

/**
 * A pack whose messages say everything is already imported while some tracks it covers still have no file: Lidarr
 * counts them as queued, so it never searches for them.
 */
export function whyIncompleteLidarr(albums: AlbumInfo[]): string | null {
  const t = tally(albums)
  if (t.missing === null || t.missing === 0 || t.total === null) return null
  const n = t.missing
  const what = albums.length === 1 && albums[0].title ? `"${albums[0].title}"` : noun(albums.length, 'album')
  return `This release claims ${what} (${noun(t.total, 'track')}) but only ${t.have} ${t.have === 1 ? 'has a file' : 'have files'}; ${n} ${n === 1 ? 'track is' : 'tracks are'} still missing and won't be searched while it sits here.`
}
