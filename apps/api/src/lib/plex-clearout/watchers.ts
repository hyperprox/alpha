// =============================================================================
//  HyperProx — Plex clear-out: who has watched what, for every account
//
//  Plex's play history starts when the server's records start, and has nothing
//  for a title someone marked as watched by hand. Plex's own view state does:
//  every movie carries viewCount and lastViewedAt, every show viewedLeafCount
//  out of leafCount, per account. The owner's comes with the library reading
//  (the server token is the owner's). Everyone else's is read with their own
//  token for this server, which plex.tv lists for the owner:
//
//    GET https://plex.tv/api/servers/<machineIdentifier>/shared_servers
//
//  with the owner's account token (what Sign in with Plex saves; the server's
//  PlexOnlineToken). Plex Home managed users are on the same list. A token that
//  plex.tv refuses (a server-only token typed in by hand) means only the owner's
//  marks are read, and the page says so.
//
//  The per-account tokens live in this object's private fields only: never
//  stored, logged, returned or put in an error, and dropped when HyperProx
//  locks. A reading walks each account × each library, so it runs in the
//  background, at most once every ten minutes, and reports its progress.
// =============================================================================

import type { CoreEndpointClient } from '../plugin-host'

/** One account's view state for one item, as Plex keeps it. */
export interface AccountView {
  /** Movie or episode: times played to the end, or marked watched. */
  viewCount:    number
  /** Show or season: episodes watched (or marked), out of leaves. */
  viewedLeaves: number
  leaves:       number
  /** Milliseconds, or null. */
  lastViewedAt: number | null
  /** Part-way through (viewOffset), not yet watched. */
  inProgress:   boolean
}

/** ratingKey → account id (the server's own /accounts id, as in the history) → that account's view. */
export type ViewMap = Map<string, Map<number, AccountView>>

export const OWNER_ACCOUNT = 1
export const PLEX_TV = 'https://plex.tv'
export const WATCHERS_TTL = 10 * 60_000

const n0 = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** Plex's view fields of one metadata row, or null when that account has neither watched nor started it. */
export function viewOf(m: any): AccountView | null {
  const viewCount = n0(m?.viewCount)
  const viewedLeaves = n0(m?.viewedLeafCount)
  const last = n0(m?.lastViewedAt)
  const inProgress = n0(m?.viewOffset) > 0
  if (!viewCount && !viewedLeaves && !last && !inProgress) return null
  return { viewCount, viewedLeaves, leaves: n0(m?.leafCount), lastViewedAt: last > 0 ? last * 1000 : null, inProgress }
}

/** Watched, for clear-out: played or marked to the end, any episode of a show, or any lastViewedAt. */
export const hasWatched = (v: AccountView | undefined | null): boolean =>
  !!v && (v.viewCount > 0 || v.viewedLeaves > 0 || v.lastViewedAt !== null)

/** Adds one account's rows (a library page, or a show's episodes) to a view map. */
export function addViews(into: ViewMap, rows: any[], account: number): void {
  for (const m of Array.isArray(rows) ? rows : []) {
    const k = String(m?.ratingKey ?? '')
    if (!/^\d+$/.test(k)) continue
    const v = viewOf(m)
    if (!v) continue
    let per = into.get(k)
    if (!per) into.set(k, (per = new Map()))
    per.set(account, v)
  }
}

/** Two view maps as one (`b` wins for an account both have). */
export function mergeViews(a: ViewMap | null | undefined, b: ViewMap | null | undefined): ViewMap {
  const out: ViewMap = new Map()
  for (const src of [a, b]) {
    if (!src) continue
    for (const [k, per] of src) {
      let o = out.get(k)
      if (!o) out.set(k, (o = new Map()))
      for (const [acct, v] of per) o.set(acct, v)
    }
  }
  return out
}

const xmlAttr = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&')

export interface SharedAccount { account: number; name: string; token: string }

/** plex.tv's shared_servers XML → each account with its own token for this server. One row per account. */
export function parseSharedServers(xml: string): SharedAccount[] {
  const out = new Map<number, SharedAccount>()
  for (const m of String(xml ?? '').matchAll(/<SharedServer\b([^>]*)>/g)) {
    const a: Record<string, string> = {}
    for (const x of m[1].matchAll(/([A-Za-z]+)="([^"]*)"/g)) a[x[1]] = xmlAttr(x[2])
    const account = n0(a.userID)
    const token = (a.accessToken ?? '').trim()
    if (!account || account === OWNER_ACCOUNT || !token || /[\s<>"]/.test(token)) continue
    out.set(account, { account, name: (a.username || a.name || a.email || `account ${account}`).slice(0, 60), token })
  }
  return [...out.values()]
}

export interface WatchersStatus {
  /** Accounts whose watched marks are in the reading: the owner, plus every shared account read. */
  accounts:  number
  /** Shared accounts plex.tv listed. */
  shared:    number
  /** A reading is running now. */
  reading:   boolean
  done:      number
  total:     number
  /** When the last reading finished, or null before the first. */
  at:        number | null
  /** Why other accounts are not counted, or what went wrong, in plain words; null when all is well. */
  note:      string | null
  /** Plex cannot list other accounts at all (no plex.tv access): the owner's marks are all there is. */
  ownerOnly: boolean
}

const PAGE = 1000
const SLOW = 60_000
const PARALLEL = 3

const NOT_ACCOUNT_TOKEN = "Only the server owner's watched marks are counted: plex.tv did not accept the Plex token in this plug-in's settings as the owner's account token. Use Sign in with Plex in the settings to count everyone the server is shared with."
const NO_PLEX_TV = "Only the server owner's watched marks are counted: HyperProx could not reach plex.tv to list who the server is shared with. It tries again in ten minutes."

/** Every account's watched marks, read in the background. Tokens are private fields: not even JSON.stringify sees them. */
export class PlexWatchers {
  #tokens = new Map<number, string>()
  #views: ViewMap = new Map()
  #names = new Map<number, string>()
  #gen = 0
  #lastStart = -Infinity
  #running: Promise<void> | null = null
  #episodes = new Map<string, { at: number; views: ViewMap }>()
  #status: WatchersStatus = { accounts: 1, shared: 0, reading: false, done: 0, total: 0, at: null, note: null, ownerOnly: false }
  /** Bumped whenever the reading changes, so a cached report knows to re-assemble. */
  version = 0

  constructor(private now: () => number = Date.now, private ttl = WATCHERS_TTL) {}

  status(): WatchersStatus { return { ...this.#status } }
  /** Other accounts' marks (the owner's come with the library reading). */
  views(): ViewMap { return this.#views }
  /** Names plex.tv gave for the shared accounts, for when the server's own /accounts has none. */
  names(): Map<number, string> { return new Map(this.#names) }
  /** A first reading is under way and nothing is known yet about other accounts. */
  pending(): boolean { return this.#status.reading && this.#status.at === null }

  /**
   * Start a reading unless one ran in the last ten minutes or is running. Returns at once; `done` resolves when
   * this reading (or the one already running) ends. A client that cannot reach plex.tv is owner-only straight away.
   */
  kick(plex: CoreEndpointClient | null): { started: boolean; done: Promise<void> } {
    if (this.#running) return { started: false, done: this.#running }
    if (!plex) return { started: false, done: Promise.resolve() }
    if (!plex.getAs || !plex.textAt) {
      if (!this.#status.ownerOnly) { this.#status = { ...this.#status, ownerOnly: true, reading: false, note: null }; this.version++ }
      return { started: false, done: Promise.resolve() }
    }
    if (this.now() - this.#lastStart < this.ttl) return { started: false, done: Promise.resolve() }
    this.#lastStart = this.now()
    const gen = this.#gen
    this.#status = { ...this.#status, reading: true, done: 0, total: 0 }
    this.version++
    const run = this.#read(plex, gen).catch(() => {
      if (gen === this.#gen) this.#status = { ...this.#status, note: NO_PLEX_TV }
    }).finally(() => {
      if (gen === this.#gen) { this.#status = { ...this.#status, reading: false, at: this.now() }; this.version++ }
      if (this.#running === run) this.#running = null
    })
    this.#running = run
    return { started: true, done: run }
  }

  async #read(plex: CoreEndpointClient, gen: number): Promise<void> {
    const machine = String((await plex.get('/identity', 15_000))?.MediaContainer?.machineIdentifier ?? '')
    if (!/^[A-Za-z0-9-]{8,80}$/.test(machine)) throw new Error('no machine id')
    let xml: string
    try { xml = await plex.textAt!(PLEX_TV, `/api/servers/${machine}/shared_servers`, 20_000) }
    catch (e: any) {
      if (gen !== this.#gen) return
      // 401/403: the stored token is not the owner's plex.tv account token. Anything else: plex.tv not reachable.
      const refused = /HTTP 40[13]\b/.test(String(e?.message ?? ''))
      this.#tokens = new Map(); this.#views = new Map(); this.#episodes.clear()
      this.#status = { ...this.#status, accounts: 1, shared: 0, note: refused ? NOT_ACCOUNT_TOKEN : NO_PLEX_TV }
      return
    }
    const shared = parseSharedServers(xml)
    const dirs = (await plex.get('/library/sections', SLOW))?.MediaContainer?.Directory
    const sections = (Array.isArray(dirs) ? dirs : [])
      .filter((s: any) => (s?.type === 'movie' || s?.type === 'show') && /^\d+$/.test(String(s?.key)))
      .map((s: any) => ({ key: String(s.key), type: s.type === 'movie' ? 1 : 2 }))
    if (gen !== this.#gen) return
    this.#status = { ...this.#status, shared: shared.length, total: shared.length, done: 0 }

    const views: ViewMap = new Map()
    const tokens = new Map<number, string>()
    const names = new Map<number, string>()
    let ok = 0, failed = 0
    const queue = [...shared]
    const worker = async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        if (gen !== this.#gen) return
        let read = 0
        for (const s of sections) {
          try {
            for (let start = 0; start < 200_000; start += PAGE) {
              const body = (await plex.getAs!(`/library/sections/${s.key}/all?type=${s.type}&X-Plex-Container-Start=${start}&X-Plex-Container-Size=${PAGE}`, a.token, SLOW))?.MediaContainer ?? {}
              const rows: any[] = Array.isArray(body.Metadata) ? body.Metadata : []
              addViews(views, rows, a.account)
              if (rows.length < PAGE) break
            }
            read++
          } catch { /* a library this account cannot see */ }
        }
        if (read || !sections.length) { ok++; tokens.set(a.account, a.token); names.set(a.account, a.name) } else failed++
        if (gen === this.#gen) this.#status = { ...this.#status, done: this.#status.done + 1 }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, Math.max(1, shared.length)) }, worker))
    if (gen !== this.#gen) return
    this.#tokens = tokens
    this.#views = views
    this.#names = names
    this.#episodes.clear()
    this.#status = {
      ...this.#status, accounts: 1 + ok,
      note: failed ? `${failed} of ${shared.length} shared ${shared.length === 1 ? 'account' : 'accounts'} could not be read, so their watched marks are not counted this time.` : null,
    }
  }

  /**
   * Every shared account's view of one show's episodes, read with their own tokens (kept ten minutes per show).
   * Empty before the first reading, or when only the owner's marks can be read.
   */
  async episodes(plex: CoreEndpointClient | null, showKey: string): Promise<ViewMap> {
    if (!/^\d{1,10}$/.test(showKey) || !plex?.getAs || !this.#tokens.size) return new Map()
    const hit = this.#episodes.get(showKey)
    if (hit && this.now() - hit.at < this.ttl) return hit.views
    const gen = this.#gen
    const views: ViewMap = new Map()
    const list = [...this.#tokens.entries()]
    const worker = async () => {
      for (let e = list.shift(); e; e = list.shift()) {
        try { addViews(views, (await plex.getAs!(`/library/metadata/${showKey}/allLeaves`, e[1], SLOW))?.MediaContainer?.Metadata ?? [], e[0]) } catch { /* skipped */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker))
    if (gen === this.#gen) {
      this.#episodes.set(showKey, { at: this.now(), views })
      if (this.#episodes.size > 50) this.#episodes.delete(this.#episodes.keys().next().value!)
    }
    return views
  }

  /** HyperProx locked: every token, and everything read with them, is forgotten; a running reading is discarded. */
  drop(): void {
    this.#gen++
    this.#tokens = new Map()
    this.#views = new Map()
    this.#names = new Map()
    this.#episodes.clear()
    this.#running = null
    this.#lastStart = -Infinity
    this.#status = { accounts: 1, shared: 0, reading: false, done: 0, total: 0, at: null, note: null, ownerOnly: false }
    this.version++
  }

  /** How many tokens are held (for tests: never the tokens themselves). */
  get heldTokens(): number { return this.#tokens.size }
}
