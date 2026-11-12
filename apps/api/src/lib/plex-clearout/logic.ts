// =============================================================================
//  HyperProx — Plex clear-out: what nobody watches
//
//  Pure, so every rule here is tested without a Plex or an Arr:
//    - plays are matched to library items by ratingKey (an episode by its show's
//      key) and ALSO by normalised title, because a re-download gets a new
//      ratingKey while the old plays stay under the old one;
//    - "never watched" is no play in the whole history and in Plex longer than
//      a minimum age; "idle" is played before, but not for N months;
//    - keep rules take an item off both lists, and say how many each one kept.
//
//  Plex's history only goes back as far as the server's own records, so the
//  report carries the date of the oldest play it saw, and the page says it.
// =============================================================================

import { artRef } from '../plex-art'

export type MediaKind = 'movie' | 'show'
export type ClearoutList = 'never' | 'idle'

/** One row of Plex's /status/sessions/history/all. */
export interface PlayRow {
  ratingKey:         string
  /** For an episode: /library/metadata/<show ratingKey>. */
  grandparentKey?:   string | null
  type:              string
  title:             string
  grandparentTitle?: string | null
  /** Unix seconds, as Plex sends it. */
  viewedAt:          number
  accountID:         number
}

export interface ArrRef { service: 'sonarr' | 'radarr'; id: number }

/** One movie or show in Plex, with whatever the Arr Stack adds. */
export interface LibItem {
  kind:         MediaKind
  ratingKey:    string
  title:        string
  year:         number | null
  /** Milliseconds. */
  addedAt:      number
  section:      string
  sectionTitle: string
  sizeBytes:    number | null
  genres:       string[]
  path:         string | null
  /** Sonarr's seriesType: standard, daily or anime. */
  seriesType:   string | null
  arr:          ArrRef | null
  /** Plex's own poster path (/library/metadata/<id>/thumb/<n>), turned into a HyperProx path for the page. */
  thumb?:       string | null
}

export interface PlayStat { plays: number; viewers: number; lastPlayed: number | null }

export interface PlayIndex {
  byKey:   Map<string, Set<number>>
  byTitle: Map<string, Set<number>>
  rows:    PlayRow[]
  /** Milliseconds of the oldest play seen, or null with no history at all. */
  since:   number | null
}

/** "The Show: Part II (2019)" and "the show part ii" read as one title. */
export function normTitle(t: string | null | undefined): string {
  return String(t ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\(\d{4}\)\s*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '')
}

const keyTail = (k: string | null | undefined): string | null => {
  const m = /(\d+)\s*$/.exec(String(k ?? ''))
  return m ? m[1] : null
}

/** The library item a play counts towards: a movie by itself, an episode by its show. */
export function playTarget(row: PlayRow): { key: string | null; title: string } {
  if (row.type === 'episode' || row.grandparentKey) {
    return { key: keyTail(row.grandparentKey), title: normTitle(row.grandparentTitle ?? row.title) }
  }
  return { key: keyTail(row.ratingKey), title: normTitle(row.title) }
}

export function indexPlays(rows: PlayRow[]): PlayIndex {
  const byKey = new Map<string, Set<number>>()
  const byTitle = new Map<string, Set<number>>()
  let since: number | null = null
  const add = (m: Map<string, Set<number>>, k: string, i: number) => {
    let s = m.get(k)
    if (!s) m.set(k, (s = new Set()))
    s.add(i)
  }
  rows.forEach((r, i) => {
    const t = playTarget(r)
    if (t.key) add(byKey, t.key, i)
    if (t.title) add(byTitle, t.title, i)
    const at = Number(r.viewedAt) * 1000
    if (Number.isFinite(at) && at > 0 && (since === null || at < since)) since = at
  })
  return { byKey, byTitle, rows, since }
}

/** Plays for one item: those under its ratingKey and those under its title, each play counted once. */
export function playsFor(index: PlayIndex, item: Pick<LibItem, 'ratingKey' | 'title'>): PlayStat {
  const ids = new Set<number>([...(index.byKey.get(item.ratingKey) ?? []), ...(index.byTitle.get(normTitle(item.title)) ?? [])])
  const viewers = new Set<number>()
  let last: number | null = null
  for (const i of ids) {
    const r = index.rows[i]
    viewers.add(Number(r.accountID))
    const at = Number(r.viewedAt) * 1000
    if (Number.isFinite(at) && (last === null || at > last)) last = at
  }
  return { plays: ids.size, viewers: viewers.size, lastPlayed: last }
}

// ---------------------------------------------------------------------------
//  Keep rules
// ---------------------------------------------------------------------------

export type KeepRuleId = 'beforeYear' | 'anime' | 'folderPattern' | 'folders' | 'genres' | 'names' | 'recent'

export interface KeepRules {
  /** Keep anything released before this year. Null: off. */
  beforeYear:    number | null
  /** Keep series Sonarr marks as anime. */
  anime:         boolean
  /** Keep anything whose folder path contains this, ignoring case ("complete series"). Null: off. */
  folderPattern: string | null
  /** Keep anything under these folders (path prefixes). */
  folders:       string[]
  /** Keep anything with one of these genres. */
  genres:        string[]
  /** Keep anything whose title starts with one of these names. */
  names:         string[]
  /** Keep anything added in the last N days. 0: off. */
  recentDays:    number
}

export interface Cutoffs { neverMinMonths: number; idleMonths: number }

export const DEFAULT_RULES: KeepRules = {
  beforeYear: 2000, anime: true, folderPattern: 'complete series', folders: [], genres: ['Science Fiction'], names: [], recentDays: 90,
}
export const DEFAULT_CUTOFFS: Cutoffs = { neverMinMonths: 6, idleMonths: 6 }

export const RULE_LABEL: Record<KeepRuleId, string> = {
  beforeYear:    'Released before the cut-off year',
  anime:         'Anime',
  folderPattern: 'In a complete-series folder',
  folders:       'In a curated folder',
  genres:        'In a kept genre',
  names:         'On the keep-names list',
  recent:        'Added recently',
}

/** The setting keys (stored like every other plug-in setting) and what each means. */
export const RULE_SETTINGS = {
  beforeYear:     'keep_before_year',
  anime:          'keep_anime',
  folderPattern:  'keep_folder_pattern',
  folders:        'keep_folders',
  genres:         'keep_genres',
  names:          'keep_names',
  recentDays:     'keep_added_days',
  neverMinMonths: 'never_min_months',
  idleMonths:     'idle_months',
} as const

/** "none" (or "off") switches a list or a pattern off, since a blank setting means "use the default". */
const OFF = /^(none|off|no|-)$/i
const listOf = (v: string | undefined, fallback: string[]): string[] => {
  if (v === undefined || v.trim() === '') return fallback
  if (OFF.test(v.trim())) return []
  return v.split(/[\n,;]/).map(x => x.trim()).filter(Boolean).slice(0, 200)
}
const intOf = (v: string | undefined, fallback: number, min: number, max: number): number => {
  if (v === undefined || v.trim() === '') return fallback
  if (OFF.test(v.trim())) return 0
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

export function parseRules(opt: (key: string) => string | undefined): { rules: KeepRules; cutoffs: Cutoffs } {
  const year = intOf(opt(RULE_SETTINGS.beforeYear), DEFAULT_RULES.beforeYear ?? 0, 0, 3000)
  const anime = opt(RULE_SETTINGS.anime)
  const pattern = opt(RULE_SETTINGS.folderPattern)
  return {
    rules: {
      beforeYear:    year > 0 ? year : null,
      anime:         anime === undefined || anime.trim() === '' ? DEFAULT_RULES.anime : !OFF.test(anime.trim()) && !/^false$/i.test(anime.trim()),
      folderPattern: pattern === undefined || pattern.trim() === '' ? DEFAULT_RULES.folderPattern : OFF.test(pattern.trim()) ? null : pattern.trim().slice(0, 120),
      folders:       listOf(opt(RULE_SETTINGS.folders), DEFAULT_RULES.folders),
      genres:        listOf(opt(RULE_SETTINGS.genres), DEFAULT_RULES.genres),
      names:         listOf(opt(RULE_SETTINGS.names), DEFAULT_RULES.names),
      recentDays:    intOf(opt(RULE_SETTINGS.recentDays), DEFAULT_RULES.recentDays, 0, 3650),
    },
    cutoffs: {
      neverMinMonths: intOf(opt(RULE_SETTINGS.neverMinMonths), DEFAULT_CUTOFFS.neverMinMonths, 0, 240),
      idleMonths:     Math.max(1, intOf(opt(RULE_SETTINGS.idleMonths), DEFAULT_CUTOFFS.idleMonths, 1, 240)),
    },
  }
}

/**
 * A keep name matches a title by prefix, on whole words: "Night Desk" keeps "Night Desk: Harbour" but not "Night Deskwork".
 * A name of three characters or fewer must match the whole title, or "Up" would keep "Up in the Air" and
 * "It" every film starting with the word "it".
 */
export function nameMatches(name: string, title: string): boolean {
  const n = normTitle(name)
  const t = normTitle(title)
  if (!n || !t) return false
  if (n.length <= 3) return t === n
  return t === n || t.startsWith(n + ' ')
}

const pathNorm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** The first rule that keeps this item, or null. */
export function keptBy(item: LibItem, rules: KeepRules, now: number): KeepRuleId | null {
  if (rules.beforeYear && item.year && item.year < rules.beforeYear) return 'beforeYear'
  if (rules.anime && item.kind === 'show' && (item.seriesType ?? '').toLowerCase() === 'anime') return 'anime'
  if (rules.folderPattern && item.path && item.path.toLowerCase().includes(rules.folderPattern.toLowerCase())) return 'folderPattern'
  if (item.path && rules.folders.some(f => { const a = pathNorm(item.path!), b = pathNorm(f); return !!b && (a === b || a.startsWith(b + '/')) })) return 'folders'
  if (rules.genres.length) {
    const want = new Set(rules.genres.map(g => g.trim().toLowerCase()))
    if (item.genres.some(g => want.has(g.trim().toLowerCase()))) return 'genres'
  }
  if (rules.names.some(n => nameMatches(n, item.title))) return 'names'
  if (rules.recentDays > 0 && item.addedAt > now - rules.recentDays * 86_400_000) return 'recent'
  return null
}

/** The same calendar day N months back (the 31st falls back to the month's last day). */
export function monthsAgo(now: number, n: number): number {
  const d = new Date(now)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - n)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d.getTime()
}

/** Which list an item is on, before keep rules: never watched, idle, or neither. */
export function classify(stat: PlayStat, addedAt: number, now: number, c: Cutoffs): ClearoutList | null {
  if (stat.plays === 0) return addedAt > 0 && addedAt <= monthsAgo(now, c.neverMinMonths) ? 'never' : null
  return stat.lastPlayed !== null && stat.lastPlayed < monthsAgo(now, c.idleMonths) ? 'idle' : null
}

// ---------------------------------------------------------------------------
//  The report
// ---------------------------------------------------------------------------

export interface ClearoutRow {
  /** `${kind}:${ratingKey}`: what a preview names. */
  id:           string
  kind:         MediaKind
  title:        string
  year:         number | null
  section:      string
  sectionTitle: string
  sizeBytes:    number | null
  plays:        number
  viewers:      number
  lastPlayed:   number | null
  addedAt:      number
  list:         ClearoutList
  /** Matched to a Sonarr series or Radarr movie, so it can be removed there. */
  removable:    boolean
  /** The poster through HyperProx's image route, or null for the title card. */
  art:          string | null
}

export interface KindTotals {
  items:          number
  /** Items with no play at all in the history. */
  unwatched:      number
  unwatchedShare: number
  never:          number
  idle:           number
  /** What the never and idle lists add up to. */
  listBytes:      number
}

export interface ClearoutReport {
  generatedAt:   number
  historySince:  number | null
  historyPlays:  number
  sizesFrom:     { tv: 'arr' | 'plex'; movies: 'arr' | 'plex' }
  arr:           { sonarr: boolean; radarr: boolean }
  sections:      Array<{ key: string; title: string; kind: MediaKind }>
  rows:          ClearoutRow[]
  kept:          Array<{ rule: KeepRuleId; label: string; tv: number; movies: number }>
  totals:        { tv: KindTotals; movies: KindTotals }
  rules:         KeepRules
  cutoffs:       Cutoffs
  notes:         string[]
}

export function buildReport(input: {
  items: LibItem[]; plays: PlayRow[]; rules: KeepRules; cutoffs: Cutoffs; now: number
  sections: Array<{ key: string; title: string; kind: MediaKind }>
  arr: { sonarr: boolean; radarr: boolean }; sizesFrom: ClearoutReport['sizesFrom']; notes?: string[]
}): ClearoutReport {
  const index = indexPlays(input.plays)
  const keptCount = new Map<KeepRuleId, { tv: number; movies: number }>()
  const blank = (): KindTotals => ({ items: 0, unwatched: 0, unwatchedShare: 0, never: 0, idle: 0, listBytes: 0 })
  const totals = { tv: blank(), movies: blank() }
  const rows: ClearoutRow[] = []

  for (const item of input.items) {
    const t = item.kind === 'show' ? totals.tv : totals.movies
    const stat = playsFor(index, item)
    t.items++
    if (stat.plays === 0) t.unwatched++
    const list = classify(stat, item.addedAt, input.now, input.cutoffs)
    if (!list) continue
    const rule = keptBy(item, input.rules, input.now)
    if (rule) {
      const k = keptCount.get(rule) ?? { tv: 0, movies: 0 }
      if (item.kind === 'show') k.tv++; else k.movies++
      keptCount.set(rule, k)
      continue
    }
    t[list]++
    t.listBytes += item.sizeBytes ?? 0
    rows.push({
      id: `${item.kind}:${item.ratingKey}`, kind: item.kind, title: item.title, year: item.year,
      section: item.section, sectionTitle: item.sectionTitle, sizeBytes: item.sizeBytes,
      plays: stat.plays, viewers: stat.viewers, lastPlayed: stat.lastPlayed, addedAt: item.addedAt,
      list, removable: !!item.arr, art: artRef(item.thumb),
    })
  }
  for (const t of [totals.tv, totals.movies]) t.unwatchedShare = t.items ? Math.round((t.unwatched / t.items) * 1000) / 10 : 0

  // Largest first: in a mostly-movie library most films are rarely rewatched, so size is what decides.
  rows.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || a.title.localeCompare(b.title))

  const order: KeepRuleId[] = ['beforeYear', 'anime', 'folderPattern', 'folders', 'genres', 'names', 'recent']
  return {
    generatedAt: input.now,
    historySince: index.since,
    historyPlays: input.plays.length,
    sizesFrom: input.sizesFrom,
    arr: input.arr,
    sections: input.sections,
    rows,
    kept: order.filter(r => keptCount.has(r)).map(r => ({ rule: r, label: RULE_LABEL[r], ...keptCount.get(r)! })),
    totals,
    rules: input.rules,
    cutoffs: input.cutoffs,
    notes: input.notes ?? [],
  }
}
