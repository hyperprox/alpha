// =============================================================================
//  HyperProx — Arr Stack, "Sort requests into the right folder": the page's pure helpers
//
//  Shapes the API answers (routes/arr-router.ts) take, and the words the panel builds from them. No fetching here,
//  so the panel is tested by rendering (test/arr-router.test.tsx).
// =============================================================================

export type RouterApp = 'radarr' | 'sonarr'
export type Condition = string

export interface Rule { condition: Condition; folder: string | null; enabled: boolean }
export interface RouterSettings { enabled: boolean; defaultRoot: string | null; rules: Rule[]; photoreal: number[]; graduate: boolean; enabledAt: string | null }
export interface Tick { at: string; looked: number; moved: number; failed: number; waiting?: number; error?: string }
export interface RouterAppStatus {
  app: RouterApp; label: string; name: string; configured: boolean; roots: string[]
  conditions: Array<{ id: Condition; label: string }>
  settings: RouterSettings | null; saved: boolean; lastTick: Tick | null; error?: string
  /** For suggested rules: where the folder requests arrive in came from. */
  suggestedFrom?: 'seerr' | 'guess'
  /** The latest "Sort my library" run. */
  library?: LibraryJob | null
}
export interface LibraryJob {
  id: string; app: RouterApp; by: string; startedAt: string; finishedAt?: string; state: 'running' | 'stopped' | 'done'
  total: number; moved: number; failed: number; skipped: number; remaining: number; groups: string[]; stoppedBy?: string; rescan?: string
}
export interface PlanItem { id: number; title: string; year: number; detail: string; episodes?: { files: number; aired: number } }
export interface PlanGroup { key: string; from: string; to: string; condition: Condition; count: number; items: PlanItem[]; word: string }
export interface LibraryPreview { previewId: string; app: RouterApp; total: number; groups: PlanGroup[] }
export interface Move {
  key: string; at: string; app: RouterApp; id: number; title: string; year: number; from: string; to: string
  kind: 'sorted' | 'graduated' | 'moved' | 'library'; condition: Condition | null; why: string; detail: string; by: string; ok: boolean; error?: string
  files?: 'moved' | 'none' | 'pending' | 'failed' | 'unconfirmed'
}
export interface RouterStatus { apps: RouterAppStatus[]; recent: Move[]; everySeconds: number; lookbackHours: number }
export interface Disagreement { actual: string; pick: string; condition: Condition | null; count: number; examples: string[] }
export interface LibraryTest {
  app: RouterApp; testId: string; at: string; scored: number; agree: number; agreement: number | null; curated: number
  byFolder: Array<{ folder: string; actual: number; picked: number }>; disagreements: Disagreement[]
}
export interface GraduatePreview { previewId: string; from: string; to: string; shows: Array<{ id: number; title: string; year: number; files: number; aired: number }> }

/** The last part of a root folder's path: what the owner calls the folder. */
export function folderName(p: string | null | undefined): string {
  if (!p) return '—'
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

export function conditionLabel(st: Pick<RouterAppStatus, 'conditions'>, c: Condition | null): string {
  if (!c) return 'By hand'
  return st.conditions.find(x => x.id === c)?.label ?? c
}

/** Move a rule up (-1) or down (+1) in the list, returning a new list. */
export function moveRule(rules: Rule[], i: number, by: -1 | 1): Rule[] {
  const j = i + by
  if (j < 0 || j >= rules.length) return rules
  const out = [...rules]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

/** What a rule says, in one line: "Horror → Frights", or why it does nothing. */
export function ruleLine(st: Pick<RouterAppStatus, 'conditions'>, r: Rule): string {
  const what = conditionLabel(st, r.condition)
  if (r.condition === 'curated') return r.folder ? `${folderName(r.folder)} is hand-picked: nothing is ever sorted into it` : `${what}: no folder chosen`
  if (!r.folder) return `${what}: pick a folder`
  if (!r.enabled) return `${what}: off`
  return `${what} → ${folderName(r.folder)}`
}

/** "88.7% agree with where things already are", or why there is nothing to say. */
export function agreementWord(t: LibraryTest): string {
  if (t.agreement === null) return 'Nothing to compare yet: the library is empty.'
  return `${t.agreement}% of ${t.scored} ${t.app === 'radarr' ? 'films' : 'shows'} are already where these rules would put them.`
}

export function sinceWord(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return 'never'
  if (ms < 90_000) return 'just now'
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3600_000)} h ago`
  return `${Math.round(ms / 86_400_000)} days ago`
}

export function tickWord(t: Tick | null, now = Date.now()): string {
  if (!t) return 'Not looked yet.'
  if (t.error) return `Last look ${sinceWord(t.at, now)} failed: ${t.error}`
  const parts = [`Last look ${sinceWord(t.at, now)}`]
  if (t.looked) parts.push(`${t.looked} new`)
  if (t.moved) parts.push(`${t.moved} sorted`)
  if (t.failed) parts.push(`${t.failed} not moved`)
  if (t.waiting) parts.push(`${t.waiting} waiting for an import to finish`)
  return `${parts.join(' · ')}.`
}

/** The confirmation the page shows before switching sorting on (the server's matches it). */
export function switchOnWord(app: RouterApp, s: RouterSettings): string {
  return `Sort new ${app === 'radarr' ? 'films' : 'shows'} into folders? From now on, each new request that lands in ${folderName(s.defaultRoot)} is moved into the folder its rules pick about a minute after it is added. Nothing already in your library moves.`
}

export function moveWord(m: Pick<Move, 'title' | 'year'>, folder: string): string {
  return `Move ${m.year ? `${m.title} (${m.year})` : m.title} to ${folderName(folder)}? Its files move with it.`
}

export function graduateWord(p: GraduatePreview): string {
  const n = p.shows.length
  return `Move ${n} finished ${n === 1 ? 'show' : 'shows'} to ${folderName(p.to)}? Their files move with them, and shows that finish from now on move on their own.`
}

/** Where the suggested rules came from, or null once the owner saved their own. */
export function suggestedWord(st: Pick<RouterAppStatus, 'saved' | 'suggestedFrom'>): string | null {
  if (st.saved) return null
  return st.suggestedFrom === 'seerr'
    ? 'Suggested rules, matched to your folders by name. Requests arrive where Seerr sends them.'
    : 'Suggested rules, matched to your folders by name. Requests arrive where most new items went: check that folder, or add Seerr in the plug-in\'s settings so HyperProx reads it from there.'
}

/** The pill on a Recently sorted card: why it moved, or what is wrong with the move. */
export function moveState(m: Pick<Move, 'ok' | 'why' | 'files'>): { tone: 'accent' | 'warn'; text: string } {
  if (m.ok) return { tone: 'accent', text: m.why }
  if (m.files === 'pending') return { tone: 'accent', text: 'Files moving' }
  if (m.files === 'failed') return { tone: 'warn', text: 'Files not moved' }
  if (m.files === 'unconfirmed') return { tone: 'warn', text: 'Files not confirmed' }
  return { tone: 'warn', text: 'Not moved' }
}

/** "142 of 300 moved, 3 failed": a library sort's progress in words. */
export function jobWord(j: LibraryJob): string {
  const parts = [`${j.moved} of ${j.total} moved`]
  if (j.failed) parts.push(`${j.failed} failed`)
  if (j.skipped) parts.push(`${j.skipped} skipped (moved or changed since the preview)`)
  const head = parts.join(', ')
  if (j.state === 'running') return `${head}. The rest move 20 a minute.`
  if (j.state === 'stopped') return `${head}. Stopped${j.stoppedBy && j.stoppedBy !== 'hyperprox' ? ` by ${j.stoppedBy}` : ''}; the rest stayed where they were.`
  return `${head}. Finished.${j.rescan ? ` ${j.rescan}` : ''}`
}

/** Tick or untick a whole group in a selection, returning a new selection. */
export function toggleGroup(sel: ReadonlySet<number>, g: Pick<PlanGroup, 'items'>, on: boolean): Set<number> {
  const out = new Set(sel)
  for (const i of g.items) { if (on) out.add(i.id); else out.delete(i.id) }
  return out
}
export function toggleItem(sel: ReadonlySet<number>, id: number, on: boolean): Set<number> {
  const out = new Set(sel)
  if (on) out.add(id); else out.delete(id)
  return out
}
/** How many of a group's items are ticked: all, some or none. */
export function groupTicked(sel: ReadonlySet<number>, g: Pick<PlanGroup, 'items'>): 'all' | 'some' | 'none' {
  const n = g.items.filter(i => sel.has(i.id)).length
  return n === 0 ? 'none' : n === g.items.length ? 'all' : 'some'
}
/** The confirm the page shows before moving the ticked items (the server's names the same count and groups). */
export function libraryWord(p: LibraryPreview, sel: ReadonlySet<number>): string {
  const groups = p.groups.map(g => ({ g, n: g.items.filter(i => sel.has(i.id)).length })).filter(x => x.n > 0)
  const n = groups.reduce((a, x) => a + x.n, 0)
  return `Move ${n} ${n === 1 ? 'item' : 'items'} in your library into the folders your rules pick? ${groups.map(x => `${x.g.word} (${x.n})`).join('; ')}. Their files move with them, 20 a minute.`
}

/** A TMDB number typed by a person: a positive whole number, or null. */
export function parseTmdb(v: string): number | null {
  const t = v.trim().replace(/^tmdb[:\s]*/i, '')
  if (!/^\d{1,9}$/.test(t)) return null
  const n = Number(t)
  return n > 0 ? n : null
}

/** A rule list ready to send: only what the API reads. */
export function draftBody(s: RouterSettings): Omit<RouterSettings, 'enabledAt'> {
  return { enabled: s.enabled, defaultRoot: s.defaultRoot, rules: s.rules.map(r => ({ condition: r.condition, folder: r.folder, enabled: r.enabled })), photoreal: s.photoreal, graduate: s.graduate }
}
