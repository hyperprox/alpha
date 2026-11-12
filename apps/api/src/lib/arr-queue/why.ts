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
export interface FileInfo { hasFile: boolean; quality: string | null; season: number | null; number: number | null }

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
    let imported = 0, kept = 0, none = 0
    for (const e of eps) {
      const have = parseQuality(e.f.quality)
      if (!e.f.hasFile) none++
      else if (rel && have && compareQuality(have, rel) > 0) kept++
      else imported++
    }
    const parts = [imported ? `Imported ${imported}` : '', kept ? `kept ${copies(kept)}` : '', none ? `${none} still without a file` : ''].filter(Boolean)
    return parts.length ? `${cap(parts.join(' · '))}; nothing left to import.` : null
  }

  const fills: Ep[] = [], have: Ep[] = []
  const ups = new Map<string, { label: string; verb: string; eps: Ep[] }>()
  for (const e of eps) {
    const kind = classify(e.f, rel)
    if (kind === null) continue
    if (kind.kind === 'fills') fills.push(at(e))
    else if (kind.kind === 'have') have.push(at(e))
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
  if (!parts.length) return null
  return cap(parts.length > 5 ? `${parts.slice(0, 5).join(' · ')} · +${parts.length - 5} more` : parts.join(' · '))
}

function classify(f: FileInfo, rel: Rank | null): { kind: Kind; label: string; verb: string } | null {
  if (!f.hasFile) return { kind: 'fills', label: '', verb: '' }
  const have = parseQuality(f.quality)
  if (!rel || !have) return null
  if (compareQuality(rel, have) <= 0) return { kind: 'have', label: '', verb: '' }
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

/** One line for a Radarr download. `file` is what is on disk for the film. */
export function whyRadarr(file: FileInfo | undefined, release: string | null, done: boolean): string | null {
  if (!file) return null
  const rel = parseQuality(release), have = parseQuality(file.quality)
  const full = (r: Rank) => `${r.resLabel}${r.srcLabel ? ` ${r.srcLabel}` : ''}`
  if (done) {
    if (!file.hasFile) return null
    return rel && have && compareQuality(have, rel) > 0 ? `Kept your better copy (${full(have)}); nothing left to import.` : 'Imported this release; nothing left to import.'
  }
  if (!file.hasFile) return 'Missing film: this will fill it.'
  if (!rel || !have) return null
  return compareQuality(rel, have) > 0 ? `Upgrades ${full(have)} → ${full(rel)}.` : `Already have ${full(have)}: this will be skipped.`
}
