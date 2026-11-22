// =============================================================================
//  HyperProx — Arr Stack "Sort requests into the right folder": the rules
//
//  Request apps (Seerr, Overseerr, Jellyseerr) send every film to one root folder and every show to another; the
//  person asking cannot pick. The router moves each newly added item into the folder its rules pick, using only what
//  Radarr and Sonarr already know about it: TMDB genres, keywords, certification, studio and collection for a film;
//  genres, series type and status for a show.
//
//  Pure: no network, no clock, no database. The service (service.ts) feeds it arr answers; the tests feed it fixtures.
//
//  A rule is a condition and a target root folder, in the owner's order; the first enabled rule whose condition
//  matches wins. "Curated" never matches: it marks a hand-picked folder the router must never fill (and the library
//  test leaves its films out of the score, because a person put each one there). "Default" always matches.
// =============================================================================

export type App = 'radarr' | 'sonarr'
export const APPS: App[] = ['radarr', 'sonarr']

export const FILM_CONDITIONS = ['curated', 'documentary', 'christmas', 'horror', 'superhero', 'animated-family', 'family-live-action', 'default'] as const
/** The show conditions added later: off until a rule uses them, and always tried first, in this order (see SHOW_PRIORITY). */
export const SHOW_KIND_CONDITIONS = ['anime', 'preschool', 'adult-animation', 'docuseries', 'kids-teens'] as const
export const SHOW_CONDITIONS = [...SHOW_KIND_CONDITIONS, 'animated', 'ended', 'running', 'default'] as const
export type FilmCondition = typeof FILM_CONDITIONS[number]
export type ShowCondition = typeof SHOW_CONDITIONS[number]
export type Condition = FilmCondition | ShowCondition

/** What each condition is called on the page. */
export const CONDITION_LABEL: Record<Condition, string> = {
  curated: 'Hand-picked (never sorted into)',
  documentary: 'Documentary',
  christmas: 'Christmas and holiday',
  horror: 'Horror',
  superhero: 'Marvel and DC',
  'animated-family': 'Animated, for families',
  'family-live-action': 'Live-action family',
  default: 'Everything else',
  animated: 'Animated or anime',
  ended: 'Ended',
  running: 'Still running',
  anime: 'Anime (Japanese, Korean and Chinese animation)',
  preschool: 'Preschool shows',
  'adult-animation': 'Adult animation',
  docuseries: 'Documentary series',
  'kids-teens': 'Live-action kids and teens',
}

export interface Rule { condition: Condition; folder: string | null; enabled: boolean }

export interface AppSettings {
  /** The router acts on new items only while this is on. Off by default. */
  enabled: boolean
  /** The root folder the request app adds to; only items that land here are ever moved. */
  defaultRoot: string | null
  rules: Rule[]
  /** Films only: TMDB ids the owner says are photoreal remakes (never "animated"), on top of the built-in list. */
  photoreal: number[]
  /** Shows only: move a finished show from the running-shows folder to the ended-shows folder. Off by default. */
  graduate: boolean
  /** When the router was last switched on (ISO); nothing added before it is touched. Set by the service. */
  enabledAt: string | null
}

export const MAX_PHOTOREAL = 200

export function conditionsFor(app: App): readonly Condition[] { return app === 'radarr' ? FILM_CONDITIONS : SHOW_CONDITIONS }

// ── what the arrs tell us ───────────────────────────────────────────────────

export interface Film {
  id: number; tmdbId: number; title: string; year: number
  genres: string[]; keywords: string[]; certification: string; studio: string; collection: string; overview: string
  root: string; path: string; added: string; tags: number[]; hasFile: boolean
}
export interface Show {
  id: number; tvdbId: number; title: string; year: number
  genres: string[]; seriesType: string; status: string
  /** Upper-case rating (TV-Y, TV-MA...), the broadcaster, and the original language's name or code, lower-case; '' when unknown. */
  certification: string; network: string; language: string
  root: string; path: string; added: string; tags: number[]
  /** Episodes on disk, and the aired episodes Sonarr counts as wanted. */
  files: number; aired: number
}
export type Item = Film | Show

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const nums = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [])
/** A root folder path compared without a trailing slash. */
export const normRoot = (p: string) => p.replace(/[\\/]+$/, '')

/** Radarr's answer for one film (GET /api/v3/movie, /movie/:id). */
export function filmOf(m: any): Film {
  return {
    id: num(m?.id), tmdbId: num(m?.tmdbId), title: str(m?.title), year: num(m?.year),
    genres: strs(m?.genres), keywords: strs(m?.keywords).map(k => k.toLowerCase()), certification: str(m?.certification).toUpperCase(),
    studio: str(m?.studio), collection: str(m?.collection?.title ?? m?.collection?.name), overview: str(m?.overview),
    root: normRoot(str(m?.rootFolderPath)), path: str(m?.path), added: str(m?.added), tags: nums(m?.tags), hasFile: m?.hasFile === true,
  }
}

/** Sonarr's answer for one series (GET /api/v3/series, /series/:id). */
export function showOf(s: any): Show {
  return {
    id: num(s?.id), tvdbId: num(s?.tvdbId), title: str(s?.title), year: num(s?.year),
    genres: strs(s?.genres), seriesType: str(s?.seriesType).toLowerCase(), status: str(s?.status).toLowerCase(),
    certification: str(s?.certification).toUpperCase(), network: str(s?.network).trim(),
    language: str(s?.originalLanguage?.name ?? s?.originalLanguage).toLowerCase(),
    root: normRoot(str(s?.rootFolderPath)), path: str(s?.path), added: str(s?.added), tags: nums(s?.tags),
    files: num(s?.statistics?.episodeFileCount), aired: num(s?.statistics?.episodeCount),
  }
}

// ── the film conditions ─────────────────────────────────────────────────────

const has = (list: string[], g: string) => list.includes(g)
const KID_RATINGS = new Set(['G', 'U', 'TV-Y', 'TV-Y7', 'TV-G'])
const KID_ONLY_RATINGS = new Set(['TV-Y', 'TV-Y7'])
/** PG counts as a children's rating only beside the Animation genre: on its own it covers half of all films. */
const KID_ANIMATED_RATINGS = new Set([...KID_RATINGS, 'PG', 'TV-PG'])

/** Words in a title that mean Christmas or the winter holidays. */
const XMAS_TITLE = /\b(christmas|xmas|x-mas|santa'?s?|claus|noel|yule(tide)?|mistletoe|grinch|nutcrackers?|reindeer|sleigh|scrooge|hanukkah|chanukah|jingle|navidad|nativity|elf)\b/i
/** Unmistakable on their own: these win even over an action film's genres. */
const XMAS_STRONG = /\b(christmas|xmas|x-mas|santa|hanukkah|chanukah|grinch|scrooge)\b/i
const XMAS_OVERVIEW = /\b(christmas|xmas|santa claus|hanukkah|chanukah|yuletide|the holidays|holiday season)\b/i
/** A film set at Christmas is not a Christmas film when it is an action film, a thriller or a horror film, unless it is
 *  also a comedy or a family film (a Christmas action comedy, a Christmas horror comedy, a Christmas cartoon adventure). */
const XMAS_VETO = ['Action', 'Thriller', 'Horror', 'Crime', 'War']
const XMAS_UNVETO = ['Comedy', 'Family']
const XMAS_FESTIVE_GENRES = ['TV Movie', 'Family', 'Animation', 'Fantasy', 'Comedy']
const XMAS_KEYWORDS = ['santa claus', 'hanukkah', 'nativity', 'holiday season']

function christmas(f: Film): string | null {
  const vetoed = XMAS_VETO.some(g => has(f.genres, g)) && !XMAS_UNVETO.some(g => has(f.genres, g))
  if (XMAS_STRONG.test(f.title)) return 'Christmas in the title'
  if (vetoed) return null
  if (XMAS_TITLE.test(f.title)) return 'a holiday word in the title'
  if (/\bholidays?\b/i.test(f.title) && (has(f.genres, 'Romance') || has(f.genres, 'TV Movie') || has(f.genres, 'Family'))) return '"holiday" in the title'
  // TMDB tags plenty of films "christmas" because one scene is set then. One such keyword counts for a TV film, a
  // family film, a cartoon or a fantasy; anything else needs two (a Christmas party and Santa Claus, say).
  const kws = f.keywords.filter(k => k.includes('christmas') || XMAS_KEYWORDS.includes(k))
  const festive = XMAS_FESTIVE_GENRES.some(g => has(f.genres, g))
  if (kws.length >= 2 || (kws.length === 1 && festive)) return `keyword "${kws[0]}"`
  if (festive && f.keywords.includes('holiday') && (has(f.genres, 'TV Movie') || has(f.genres, 'Romance'))) return 'keyword "holiday"'
  if (festive) {
    const m = XMAS_OVERVIEW.exec(f.overview)
    if (m) return `"${m[1].toLowerCase()}" in the summary`
    if (has(f.genres, 'TV Movie') && has(f.genres, 'Romance') && /\bholiday\b/i.test(f.overview)) return '"holiday" in the summary'
  }
  return null
}

const HERO_STUDIO = /^(marvel( studios| enterprises| entertainment| knights| animation)?|dc( studios| films| entertainment| comics)?)$/i
const HERO_KEYWORD = /marvel cinematic universe|\bmcu\b|dc extended universe|\bdceu\b|\bdc universe\b|\bdcu\b|dc animated movie universe|\bdcamu\b|marvel comics|\bdc comics\b|based on marvel|based on dc/i
/** Marvel and DC characters and teams, matched in the title or the collection when TMDB calls the film a comic one. */
export const HERO_PROPERTIES = [
  'batman', 'superman', 'spider-man', 'spiderman', 'spider-verse', 'x-men', 'x2', 'wolverine', 'logan', 'avengers', 'justice league', 'wonder woman',
  'aquaman', 'joker', 'shazam', 'the flash', 'green lantern', 'fantastic four', 'venom', 'deadpool', 'hulk', 'iron man', 'thor',
  'captain america', 'captain marvel', 'daredevil', 'punisher', 'blade', 'ghost rider', 'morbius', 'madame web', 'kraven',
  'suicide squad', 'watchmen', 'constantine', 'catwoman', 'supergirl', 'black adam', 'blue beetle', 'birds of prey', 'harley quinn',
  'teen titans', 'elektra', 'guardians of the galaxy', 'ant-man', 'doctor strange', 'black panther', 'black widow', 'eternals',
  'shang-chi', 'the marvels', 'thunderbolts', 'man of steel', 'dark knight', 'swamp thing', 'jonah hex', 'new mutants', 'dark phoenix', 'gotham',
]
const HERO_WORDS = new RegExp(`(^|[^a-z0-9])(${HERO_PROPERTIES.map(p => p.replace(/[-]/g, '[- ]?')).join('|')})([^a-z0-9]|$)`, 'i')
const COMIC_KEYWORDS = ['superhero', 'based on comic', 'based on graphic novel', 'super power', 'super villain', 'superhero team', 'cartoon']

function superhero(f: Film): string | null {
  // A cartoon for children (The Incredibles, a family Batman cartoon) belongs with the other cartoons.
  if (has(f.genres, 'Animation') && (has(f.genres, 'Family') || KID_RATINGS.has(f.certification))) return null
  if (HERO_STUDIO.test(f.studio.trim())) return `studio ${f.studio}`
  const kw = f.keywords.find(k => HERO_KEYWORD.test(k))
  if (kw) return `keyword "${kw}"`
  if (f.keywords.some(k => COMIC_KEYWORDS.includes(k))) {
    const m = HERO_WORDS.exec(f.title) ?? HERO_WORDS.exec(f.collection)
    if (m) return `a Marvel or DC name (${m[2]})`
  }
  return null
}

/**
 * Not cartoons, though TMDB may file them under Animation: remakes drawn to look like live action (the 2019 lion
 * remake), and films that mix live actors with cartoon characters. Both sit with live-action family films.
 */
export const PHOTOREAL_TMDB = [420818, 762509, 278927]
const PHOTOREAL_KEYWORDS = ['live action remake', 'photorealistic', 'photorealism', 'photo-realistic', 'live action and animation']

export function photoreal(f: Film, extra: ReadonlySet<number>): boolean {
  return extra.has(f.tmdbId) || PHOTOREAL_TMDB.includes(f.tmdbId) || f.keywords.some(k => PHOTOREAL_KEYWORDS.includes(k))
}

function animatedFamily(f: Film, extra: ReadonlySet<number>): string | null {
  if (!has(f.genres, 'Animation')) return null
  if (photoreal(f, extra)) return null
  if (has(f.genres, 'Family')) return 'genres Animation and Family'
  if (KID_ANIMATED_RATINGS.has(f.certification)) return `genre Animation, rated ${f.certification}`
  return null
}

function familyLiveAction(f: Film, extra: ReadonlySet<number>): string | null {
  if (has(f.genres, 'Horror')) return null
  if (has(f.genres, 'Animation') && !photoreal(f, extra)) return null
  const real = has(f.genres, 'Animation') ? ', not a cartoon' : ''
  if (has(f.genres, 'Family')) return `genre Family${real}`
  // G and U alone also cover old epics and space operas; only ratings made for children count without the genre.
  if (KID_ONLY_RATINGS.has(f.certification)) return `rated ${f.certification}${real}`
  return null
}

/** Why this film matches the condition, or null when it does not. */
export function filmMatch(c: Condition, f: Film, extra: ReadonlySet<number> = new Set()): string | null {
  switch (c) {
    case 'curated': return null
    case 'documentary': return has(f.genres, 'Documentary') ? 'genre Documentary' : null
    case 'christmas': return christmas(f)
    case 'horror': return has(f.genres, 'Horror') ? 'genre Horror' : null
    case 'superhero': return superhero(f)
    case 'animated-family': return animatedFamily(f, extra)
    case 'family-live-action': return familyLiveAction(f, extra)
    case 'default': return 'no other rule matched'
    default: return null
  }
}

// ── the show-kind conditions ────────────────────────────────────────────────

/** Broadcasters that make preschool television; a TV-G children's show from one of them is a preschool show. */
export const PRESCHOOL_NETWORKS = ['nick jr.', 'nick jr', 'nickelodeon jr.', 'disney junior', 'disney jr.', 'playhouse disney', 'cbeebies', 'pbs kids', 'treehouse', 'treehouse tv', 'abc kids', 'cbc kids', 'sprout', 'universal kids preschool']
const EAST_ASIAN_LANGUAGES = ['japanese', 'korean', 'chinese', 'mandarin', 'cantonese', 'ja', 'ko', 'zh']
const isAnimation = (s: Show) => s.seriesType === 'anime' || has(s.genres, 'Animation') || has(s.genres, 'Anime')

function anime(s: Show): string | null {
  if (s.seriesType === 'anime') return 'series type anime'
  if (has(s.genres, 'Anime')) return 'genre Anime'
  if (has(s.genres, 'Animation') && EAST_ASIAN_LANGUAGES.includes(s.language)) return `animation in ${s.language}`
  return null
}

function preschool(s: Show): string | null {
  if (s.certification === 'TV-Y') return 'rated TV-Y'
  if (s.certification === 'TV-G' && has(s.genres, 'Children')) {
    if (PRESCHOOL_NETWORKS.includes(s.network.toLowerCase())) return `rated TV-G on ${s.network}`
    if (has(s.genres, 'Preschool')) return 'rated TV-G, genre Preschool'
  }
  return null
}

function adultAnimation(s: Show): string | null {
  if (!isAnimation(s) || anime(s)) return null
  return s.certification === 'TV-MA' || s.certification === 'TV-14' ? `animated, rated ${s.certification}` : null
}

function kidsTeens(s: Show): string | null {
  if (isAnimation(s)) return null
  if (!['TV-Y7', 'TV-G', 'TV-PG'].includes(s.certification)) return null
  return has(s.genres, 'Children') || has(s.genres, 'Family') ? `live action, rated ${s.certification}` : null
}

/** The order the show-kind conditions are tried in, whatever order the owner's rules are listed in. */
export const SHOW_PRIORITY: readonly Condition[] = SHOW_KIND_CONDITIONS

/** The rules in the order they are tried: show-kind rules first, in priority order; every other rule keeps the owner's order. */
export function orderedRules(app: App, rules: Rule[]): Rule[] {
  if (app !== 'sonarr') return rules
  const kind = SHOW_PRIORITY.flatMap(c => rules.filter(r => r.condition === c))
  return [...kind, ...rules.filter(r => !SHOW_PRIORITY.includes(r.condition))]
}

/** Saved rules plus a switched-off, folderless rule for every condition they lack, so the page can offer it. Display only. */
export function withMissingRules(app: App, rules: Rule[]): Rule[] {
  const have = new Set<string>(rules.map(r => r.condition))
  const missing: Rule[] = conditionsFor(app).filter(c => !have.has(c)).map(condition => ({ condition, folder: null, enabled: false }))
  return app === 'sonarr' ? [...missing.filter(r => SHOW_PRIORITY.includes(r.condition)), ...rules, ...missing.filter(r => !SHOW_PRIORITY.includes(r.condition))] : [...rules, ...missing]
}

/** Why this show matches the condition, or null. */
export function showMatch(c: Condition, s: Show): string | null {
  switch (c) {
    case 'anime': return anime(s)
    case 'preschool': return preschool(s)
    case 'adult-animation': return adultAnimation(s)
    case 'docuseries': return has(s.genres, 'Documentary') ? 'genre Documentary' : null
    case 'kids-teens': return kidsTeens(s)
    case 'animated':
      if (s.seriesType === 'anime') return 'series type anime'
      return has(s.genres, 'Animation') ? 'genre Animation' : null
    case 'ended': return s.status === 'ended' ? 'it has ended' : null
    case 'running': return s.status === 'continuing' || s.status === 'upcoming' ? `it is ${s.status}` : null
    case 'default': return 'no other rule matched'
    default: return null
  }
}

export interface Pick { condition: Condition; folder: string; why: string }

/** The first enabled rule with a folder that matches; null when none does (the item stays where it is). */
export function pickFolder(app: App, settings: Pick_<AppSettings, 'rules' | 'photoreal'>, item: Item): Pick | null {
  const extra = new Set(settings.photoreal ?? [])
  const curated = curatedFolders(settings.rules)
  for (const r of orderedRules(app, settings.rules)) {
    // A hand-picked folder is never a target, whichever rule points at it.
    if (!r.enabled || !r.folder || r.condition === 'curated' || curated.has(normRoot(r.folder))) continue
    const why = app === 'radarr' ? filmMatch(r.condition, item as Film, extra) : showMatch(r.condition, item as Show)
    if (why) return { condition: r.condition, folder: normRoot(r.folder), why }
  }
  return null
}
type Pick_<T, K extends keyof T> = { [P in K]: T[P] }

/** The hand-picked folders: every folder a "curated" rule names. Nothing is ever sorted or graduated into them. */
export function curatedFolders(rules: Rule[]): Set<string> {
  return new Set(rules.filter(r => r.condition === 'curated' && r.folder).map(r => normRoot(r.folder!)))
}

// ── defaults, matched to the owner's folders by name ────────────────────────

/** Name patterns for the default rules, tried against each root folder's last path part. */
const FOLDER_HINTS: Record<Condition, RegExp | null> = {
  curated: /\b(curated|hand[- ]?picked|favou?rites?|best of|cinema)\b/i,
  documentary: /documentar|\bdocs?\b/i,
  christmas: /christmas|xmas|holiday|festive/i,
  horror: /horror|scary|spooky|halloween|fright/i,
  superhero: /marvel|\bdc\b|super ?hero|comic/i,
  'animated-family': /animat|cartoon/i,
  'family-live-action': /child|kids?\b|family|famil/i,
  default: null,
  animated: /animat|cartoon|anime/i,
  ended: /complete|ended|finished|archive|full series/i,
  running: null,
  anime: null, preschool: null, 'adult-animation': null, docuseries: null, 'kids-teens': null,
}

const leaf = (p: string) => normRoot(p).split(/[\\/]/).pop() ?? p

/** The default rule list for an app, each mapped to the first root folder whose name fits (or none). */
export function defaultRules(app: App, roots: string[], defaultRoot: string | null): Rule[] {
  const used = new Set<string>()
  const fit = (c: Condition, avoid?: RegExp): string | null => {
    const re = FOLDER_HINTS[c]
    if (!re) return null
    const hit = roots.find(r => !used.has(normRoot(r)) && re.test(leaf(r)) && !(avoid && avoid.test(leaf(r))))
    if (hit) used.add(normRoot(hit))
    return hit ? normRoot(hit) : null
  }
  const def = defaultRoot ? normRoot(defaultRoot) : null
  if (app === 'radarr') {
    const curated = fit('curated')
    const rules: Rule[] = []
    rules.push({ condition: 'curated', folder: curated, enabled: !!curated })
    for (const c of ['documentary', 'christmas', 'horror', 'superhero', 'animated-family'] as const) {
      const f = fit(c); rules.push({ condition: c, folder: f, enabled: !!f })
    }
    const fam = fit('family-live-action', /animat|cartoon/i)
    rules.push({ condition: 'family-live-action', folder: fam, enabled: !!fam })
    rules.push({ condition: 'default', folder: def, enabled: !!def })
    return rules
  }
  const anim = fit('animated')
  const ended = fit('ended')
  const running = def && !used.has(def) ? def : roots.map(normRoot).find(r => !used.has(r)) ?? null
  return [
    { condition: 'animated', folder: anim, enabled: !!anim },
    { condition: 'ended', folder: ended, enabled: !!ended },
    { condition: 'running', folder: running, enabled: !!running },
    { condition: 'default', folder: def, enabled: !!def },
  ]
}

/** The request app's folder: the one most of the latest additions went to (a person can change it). */
export function guessDefaultRoot(items: Array<{ root: string; added: string }>, latest = 50): string | null {
  const recent = [...items].filter(i => i.root).sort((a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : 0)).slice(0, latest)
  const count = new Map<string, number>()
  for (const i of recent) count.set(i.root, (count.get(i.root) ?? 0) + 1)
  let best: string | null = null, n = 0
  for (const [r, c] of count) if (c > n) { best = r; n = c }
  return best
}

export function defaultSettings(app: App, roots: string[], defaultRoot: string | null): AppSettings {
  return { enabled: false, defaultRoot: defaultRoot ? normRoot(defaultRoot) : null, rules: defaultRules(app, roots, defaultRoot), photoreal: [], graduate: false, enabledAt: null }
}

/** A person's settings from a request body, checked; a string is the plain-English reason it was refused. */
export function parseSettings(app: App, raw: unknown, roots: string[] | null): AppSettings | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Send the rules.'
  const b = raw as Record<string, unknown>
  const known = roots ? new Set(roots.map(normRoot)) : null
  const okFolder = (v: unknown): string | null | false => {
    if (v === null || v === undefined || v === '') return null
    if (typeof v !== 'string' || v.length > 400 || /[\u0000-\u001f]/.test(v)) return false
    const n = normRoot(v)
    return known && !known.has(n) ? false : n
  }
  const def = okFolder(b.defaultRoot)
  if (def === false) return 'The folder requests arrive in is not one of this app\'s root folders.'
  if (!Array.isArray(b.rules) || b.rules.length > 20) return 'Send the rules as a list.'
  const allowed = conditionsFor(app)
  const seen = new Set<string>()
  const rules: Rule[] = []
  for (const r of b.rules) {
    if (!r || typeof r !== 'object') return 'Each rule needs a condition and a folder.'
    const c = (r as any).condition
    if (!allowed.includes(c)) return `"${String(c).slice(0, 30)}" is not a condition for ${app === 'radarr' ? 'films' : 'shows'}.`
    if (seen.has(c)) return 'Each condition can be used once.'
    seen.add(c)
    const folder = okFolder((r as any).folder)
    if (folder === false) return 'A rule points at a folder that is not one of this app\'s root folders.'
    const enabled = (r as any).enabled === true
    if (enabled && !folder) return `Pick a folder for "${CONDITION_LABEL[c as Condition]}" or turn it off.`
    rules.push({ condition: c, folder, enabled })
  }
  const hand = curatedFolders(rules)
  if (def && hand.has(def)) return 'The folder requests arrive in is marked hand-picked. Pick another, or take it off the hand-picked rule.'
  const into = rules.find(r => r.condition !== 'curated' && r.enabled && r.folder && hand.has(r.folder))
  if (into) return `"${CONDITION_LABEL[into.condition]}" points at a hand-picked folder. Nothing is ever sorted into it: pick another folder.`
  const photo = b.photoreal === undefined ? [] : b.photoreal
  if (!Array.isArray(photo) || photo.length > MAX_PHOTOREAL || !photo.every(n => Number.isInteger(n) && n > 0 && n < 1e9)) return 'The photoreal remakes are a list of TMDB numbers.'
  const enabled = b.enabled === true
  if (enabled && !def) return 'Pick the folder requests arrive in first.'
  if (enabled && !rules.some(r => r.enabled)) return 'Turn on at least one rule first.'
  return { enabled, defaultRoot: def, rules, photoreal: [...new Set(photo as number[])], graduate: app === 'sonarr' && b.graduate === true, enabledAt: null }
}

/** The parts of the settings that decide where things go (what a library test is bound to). */
export function ruleFingerprint(app: App, s: AppSettings): string {
  return JSON.stringify([app, s.defaultRoot, s.rules.map(r => [r.condition, r.folder, r.enabled]), [...s.photoreal].sort((a, b) => a - b)])
}

// ── "Test on my library" ────────────────────────────────────────────────────

export interface Disagreement { actual: string; pick: string; condition: Condition | null; count: number; examples: string[] }
export interface LibraryTest {
  app: App
  /** Items scored: everything except what sits in a hand-picked folder. */
  scored: number
  agree: number
  /** Whole percent, or null with nothing to score. */
  agreement: number | null
  /** Items in a hand-picked folder, left out of the score. */
  curated: number
  /** Where the rules would put things, folder by folder. */
  byFolder: Array<{ folder: string; actual: number; picked: number }>
  disagreements: Disagreement[]
}

const label = (i: Item) => (i.year ? `${i.title} (${i.year})` : i.title)

/** Run the rules over the whole library, read-only, and compare with where everything already is. */
export function testLibrary(app: App, settings: AppSettings, items: Item[], maxGroups = 12, maxExamples = 6): LibraryTest {
  const handPicked = curatedFolders(settings.rules)
  const groups = new Map<string, Disagreement>()
  const actual = new Map<string, number>(), picked = new Map<string, number>()
  let scored = 0, agree = 0, curated = 0
  for (const it of items) {
    if (handPicked.has(it.root)) { curated++; continue }
    const p = pickFolder(app, settings, it)
    const to = p?.folder ?? it.root
    scored++
    actual.set(it.root, (actual.get(it.root) ?? 0) + 1)
    picked.set(to, (picked.get(to) ?? 0) + 1)
    if (to === it.root) { agree++; continue }
    const k = `${it.root}\u0000${to}`
    const g = groups.get(k) ?? { actual: it.root, pick: to, condition: p?.condition ?? null, count: 0, examples: [] }
    g.count++
    if (g.examples.length < maxExamples) g.examples.push(label(it))
    groups.set(k, g)
  }
  const folders = [...new Set([...actual.keys(), ...picked.keys()])].sort()
  return {
    app, scored, agree, curated,
    agreement: scored ? Math.round((agree / scored) * 1000) / 10 : null,
    byFolder: folders.map(f => ({ folder: f, actual: actual.get(f) ?? 0, picked: picked.get(f) ?? 0 })),
    disagreements: [...groups.values()].sort((a, b) => b.count - a.count || a.actual.localeCompare(b.actual) || a.pick.localeCompare(b.pick)).slice(0, maxGroups),
  }
}

// ── which items the router may touch ────────────────────────────────────────

export const ROUTED_TAG = 'hpx-routed'

/**
 * May the router move this item? Only something that landed in the request app's folder, added after the router was
 * switched on and within the look-back window, not yet marked as routed, and not one a person moved back.
 */
export function routable(item: Item, s: AppSettings, opts: { routedTag: number | null; now: number; lookbackMs: number; leaveAlone: ReadonlySet<number> }): boolean {
  if (!s.enabled || !s.defaultRoot || !s.enabledAt) return false
  if (item.root !== normRoot(s.defaultRoot)) return false
  if (opts.routedTag !== null && item.tags.includes(opts.routedTag)) return false
  if (opts.leaveAlone.has(item.id)) return false
  const added = Date.parse(item.added)
  if (!Number.isFinite(added)) return false
  return added >= Date.parse(s.enabledAt) && added >= opts.now - opts.lookbackMs
}

// ── "Graduate finished shows" ───────────────────────────────────────────────

/** The running-shows and ended-shows folders of the enabled rules, or null when either is off or they are the same. */
export function graduateFolders(s: Pick_<AppSettings, 'rules'>): { from: string; to: string } | null {
  const running = s.rules.find(r => r.condition === 'running' && r.enabled && r.folder)?.folder
  const ended = s.rules.find(r => r.condition === 'ended' && r.enabled && r.folder)?.folder
  if (!running || !ended || normRoot(running) === normRoot(ended)) return null
  if (curatedFolders(s.rules).has(normRoot(ended))) return null
  return { from: normRoot(running), to: normRoot(ended) }
}

/**
 * Shows in the running-shows folder that have ended and have every aired episode on disk. `leaveAlone` holds the shows
 * a person moved by hand and the ones already graduated once (one back in the running folder was moved back by hand).
 */
export function graduates(s: Pick_<AppSettings, 'rules'>, shows: Show[], leaveAlone: ReadonlySet<number> = new Set()): { from: string; to: string; shows: Show[] } | null {
  const f = graduateFolders(s)
  if (!f) return null
  const { from, to } = f
  return {
    from, to,
    shows: shows.filter(x => x.root === from && x.status === 'ended' && x.aired > 0 && x.files >= x.aired && !leaveAlone.has(x.id))
      .sort((a, b) => a.title.localeCompare(b.title)),
  }
}

/** "Horror → Scary Films": the condition and the folder's own name, for the page and the audit log. */
export function whyWord(c: Condition, folder: string): string { return `${CONDITION_LABEL[c]} → ${leaf(folder)}` }
export { leaf as folderName }

// ── "Sort my library" ───────────────────────────────────────────────────────

export interface PlanItem { id: number; title: string; year: number; detail: string; episodes?: { files: number; aired: number } }
export interface PlanGroup { key: string; from: string; to: string; condition: Condition; count: number; items: PlanItem[] }

/** The folders an enabled rule sends things to (never a hand-picked one). */
export function filledFolders(rules: Rule[]): Set<string> {
  const hand = curatedFolders(rules)
  return new Set(rules.filter(r => r.enabled && r.folder && r.condition !== 'curated' && !hand.has(normRoot(r.folder))).map(r => normRoot(r.folder!)))
}

/**
 * Folders "Sort my library" leaves alone because no enabled rule fills them (hand-picked folders are listed apart):
 * forgetting to mark a hand-kept folder can never empty it. With how many items each holds.
 */
export function leftAloneFolders(settings: Pick_<AppSettings, 'rules'>, items: Item[]): Array<{ folder: string; count: number }> {
  const hand = curatedFolders(settings.rules)
  const filled = filledFolders(settings.rules)
  const count = new Map<string, number>()
  for (const it of items) if (it.root && !hand.has(it.root) && !filled.has(it.root)) count.set(it.root, (count.get(it.root) ?? 0) + 1)
  return [...count].map(([folder, n]) => ({ folder, count: n })).sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder))
}

/** "Horror in Movies → Frights": a group's name, from the owner's own folder names. */
export function groupWord(g: Pick_<PlanGroup, 'condition' | 'from' | 'to'>): string {
  return `${CONDITION_LABEL[g.condition]} in ${leaf(g.from)} → ${leaf(g.to)}`
}

/**
 * The saved rules over everything already in the library: every item whose pick differs from where it is, grouped by
 * from → to and the rule that picked it. Nothing ever comes out of a hand-picked folder or goes into one, and nothing a
 * person moved back by hand is proposed again. Read-only: this only says what would move.
 */
export function libraryPlan(app: App, settings: Pick_<AppSettings, 'rules' | 'photoreal'>, items: Item[], leaveAlone: ReadonlySet<number> = new Set()): PlanGroup[] {
  const hand = curatedFolders(settings.rules)
  const filled = filledFolders(settings.rules)
  const groups = new Map<string, PlanGroup>()
  for (const it of items) {
    // A folder no enabled rule fills is kept by hand, like a hand-picked one: nothing is taken out of it.
    if (hand.has(it.root) || !filled.has(it.root) || leaveAlone.has(it.id)) continue
    const p = pickFolder(app, settings, it)
    if (!p || p.folder === it.root || hand.has(p.folder)) continue
    const key = `${it.root}\u0000${p.folder}\u0000${p.condition}`
    const g = groups.get(key) ?? { key, from: it.root, to: p.folder, condition: p.condition, count: 0, items: [] }
    const row: PlanItem = { id: it.id, title: it.title, year: it.year, detail: p.why }
    if (app === 'sonarr') row.episodes = { files: (it as Show).files, aired: (it as Show).aired }
    g.items.push(row)
    g.count++
    groups.set(key, g)
  }
  for (const g of groups.values()) g.items.sort((a, b) => a.title.localeCompare(b.title) || a.year - b.year)
  return [...groups.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
}
