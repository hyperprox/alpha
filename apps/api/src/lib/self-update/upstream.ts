// =============================================================================
//  HyperProx — self-update: asking upstream what is new
//
//  Read-only, and no token: the public GitHub API, a GitLab mirror's API when
//  one is configured, and plain git (ls-remote / fetch into a private ref
//  namespace) for anything else. Each answers the same five questions, so the
//  check (check.ts) does not care which one it got.
//
//  Friendly to GitHub's limit of 60 unauthenticated requests an hour:
//    - every GET carries the ETag of the last answer; a 304 costs nothing
//      against the limit and the cached body is used;
//    - a 403/429 that says the limit is spent stops every request until the
//      reset time GitHub gives, and the check falls through to the mirror;
//    - a check makes at most four requests, and runs every 6 hours by default.
// =============================================================================

import fs from 'fs'
import path from 'path'
import type { Shell } from './shell'

export type Source = 'github' | 'gitlab' | 'git'

export interface Release { tag: string; name: string; notes: string; date: string | null; prerelease: boolean; url: string | null }
export interface TagInfo { tag: string; commit: string; annotated: boolean; signed: boolean | null; verified: boolean | null }
export interface CommitInfo { sha: string; subject: string; body: string; date: string | null }
export interface Comparison {
  /** ahead: head is newer than base. unknown: upstream does not know base (local commits, rewritten history). Commits oldest first. */
  status: 'ahead' | 'behind' | 'identical' | 'diverged' | 'unknown'
  commits: CommitInfo[]
  /** Paths the comparison changes; null when upstream did not say. */
  files: string[] | null
  total: number
}

export interface Upstream {
  source: Source
  /** Where it is, for the page ("github.com/hyperprox/alpha"). */
  where: string
  releases(): Promise<Release[]>
  tags(): Promise<string[]>
  tag(tag: string): Promise<TagInfo>
  head(branch: string): Promise<CommitInfo>
  compare(base: string, head: string): Promise<Comparison>
}

export class RateLimitedError extends Error {
  constructor(public until: Date) { super(`GitHub's limit for requests without a token is used up until ${until.toISOString()}`) }
}
export class UpstreamError extends Error {
  constructor(message: string, public status?: number) { super(message) }
}

// --- HTTP with ETags ----------------------------------------------------------------------------------

export interface FetchResponse { status: number; headers: { get(name: string): string | null }; text(): Promise<string> }
export type Fetcher = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponse>

interface CacheEntry { etag: string; body: string; at: string }

/** ETag cache, kept in a file so a restart does not spend requests again. */
export class HttpCache {
  private map = new Map<string, CacheEntry>()
  rateLimitedUntil = 0
  constructor(private file: string | null = null) {
    if (!file) return
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const [k, v] of Object.entries(j.entries ?? {})) this.map.set(k, v as CacheEntry)
      this.rateLimitedUntil = Number(j.rateLimitedUntil) || 0
    } catch { /* empty */ }
  }
  get(url: string) { return this.map.get(url) }
  set(url: string, e: CacheEntry) {
    if (e.body.length > 1_000_000) return
    this.map.set(url, e)
    if (this.map.size > 64) this.map.delete(this.map.keys().next().value as string)
    this.save()
  }
  save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(this.file, JSON.stringify({ rateLimitedUntil: this.rateLimitedUntil, entries: Object.fromEntries(this.map) }), { mode: 0o600 })
    } catch { /* a cache */ }
  }
}

export interface HttpDeps { fetch?: Fetcher; cache: HttpCache; now?: () => number; timeoutMs?: number }

async function getJson(url: string, d: HttpDeps, headers: Record<string, string>, limitAware: boolean): Promise<any> {
  const now = d.now ?? Date.now
  if (limitAware && d.cache.rateLimitedUntil > now()) throw new RateLimitedError(new Date(d.cache.rateLimitedUntil))
  const f: Fetcher = d.fetch ?? ((u, i) => fetch(u, i as any) as any)
  const cached = d.cache.get(url)
  const h: Record<string, string> = { 'User-Agent': 'HyperProx-self-update', ...headers }
  if (cached) h['If-None-Match'] = cached.etag
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), d.timeoutMs ?? 15_000)
  let res: FetchResponse
  try { res = await f(url, { headers: h, signal: ac.signal }) }
  catch (e: any) { throw new UpstreamError(`${new URL(url).host} did not answer (${e?.name === 'AbortError' ? 'timeout' : e?.message ?? e})`) }
  finally { clearTimeout(timer) }
  if (res.status === 304 && cached) return JSON.parse(cached.body)
  if (limitAware && (res.status === 403 || res.status === 429)) {
    const remaining = res.headers.get('x-ratelimit-remaining')
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    const retry = Number(res.headers.get('retry-after'))
    if (remaining === '0' || res.status === 429 || Number.isFinite(retry) && retry > 0) {
      const until = Number.isFinite(reset) && reset > 0 ? reset * 1000 : now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60 * 60_000)
      d.cache.rateLimitedUntil = until
      d.cache.save()
      throw new RateLimitedError(new Date(until))
    }
  }
  if (res.status === 404) throw new UpstreamError(`not found: ${new URL(url).pathname}`, 404)
  if (res.status !== 200) throw new UpstreamError(`${new URL(url).host} answered ${res.status}`, res.status)
  const body = await res.text()
  const etag = res.headers.get('etag')
  if (etag) d.cache.set(url, { etag, body, at: new Date(now()).toISOString() })
  try { return JSON.parse(body) } catch { throw new UpstreamError(`${new URL(url).host} sent something that is not JSON`) }
}

const firstLine = (m: string) => (m ?? '').split('\n')[0].trim()
const restLines = (m: string) => (m ?? '').split('\n').slice(1).join('\n').trim()

/** owner/repo from a GitHub URL (https or ssh); null for anything else. */
export function githubRepo(url: string): { owner: string; repo: string } | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? { owner: m[1], repo: m[2] } : null
}

/** host and project path from a GitLab https URL. */
export function gitlabProject(url: string): { base: string; project: string } | null {
  const m = /^(https:\/\/[A-Za-z0-9.-]+(?::\d+)?)\/([A-Za-z0-9._\/-]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m && !m[2].includes('..') ? { base: m[1], project: m[2] } : null
}

const SAFE_REF = /^[A-Za-z0-9._\/+-]{1,128}$/
const checkRef = (r: string) => { if (!SAFE_REF.test(r) || r.includes('..')) throw new UpstreamError(`"${r}" is not a ref this check will ask for`); return r }

// --- GitHub -------------------------------------------------------------------------------------------------

export class GitHubUpstream implements Upstream {
  source: Source = 'github'
  where: string
  private api: string
  constructor(private repo: { owner: string; repo: string }, private d: HttpDeps, apiBase = 'https://api.github.com') {
    this.where = `github.com/${repo.owner}/${repo.repo}`
    this.api = `${apiBase}/repos/${repo.owner}/${repo.repo}`
  }
  private get(p: string) {
    return getJson(this.api + p, this.d, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, true)
  }
  async releases(): Promise<Release[]> {
    const list = await this.get('/releases?per_page=30')
    if (!Array.isArray(list)) return []
    return list.filter((r: any) => r && !r.draft && typeof r.tag_name === 'string').map((r: any) => ({
      tag: r.tag_name, name: r.name || r.tag_name, notes: String(r.body ?? ''), date: r.published_at ?? r.created_at ?? null,
      prerelease: !!r.prerelease, url: r.html_url ?? null,
    }))
  }
  async tags(): Promise<string[]> {
    const list = await this.get('/tags?per_page=100')
    return Array.isArray(list) ? list.map((t: any) => t?.name).filter((n: any) => typeof n === 'string') : []
  }
  async tag(tag: string): Promise<TagInfo> {
    const ref = await this.get(`/git/ref/tags/${encodeURIComponent(checkRef(tag))}`)
    const obj = ref?.object
    if (!obj?.sha) throw new UpstreamError(`tag ${tag} not found`)
    if (obj.type === 'commit') return { tag, commit: obj.sha, annotated: false, signed: false, verified: null }
    const t = await this.get(`/git/tags/${obj.sha}`)
    if (t?.object?.type !== 'commit') throw new UpstreamError(`tag ${tag} does not point at a commit`)
    const v = t.verification
    const signed = v ? v.reason !== 'unsigned' : null
    return { tag, commit: t.object.sha, annotated: true, signed, verified: v ? !!v.verified : null }
  }
  async head(branch: string): Promise<CommitInfo> {
    const c = await this.get(`/commits/${encodeURIComponent(checkRef(branch))}`)
    return { sha: c.sha, subject: firstLine(c.commit?.message), body: restLines(c.commit?.message), date: c.commit?.committer?.date ?? null }
  }
  async compare(base: string, head: string): Promise<Comparison> {
    try {
      const c = await this.get(`/compare/${checkRef(base)}...${checkRef(head)}`)
      const commits: CommitInfo[] = (c.commits ?? []).map((x: any) => ({ sha: x.sha, subject: firstLine(x.commit?.message), body: restLines(x.commit?.message), date: x.commit?.committer?.date ?? null }))
      // GitHub lists at most 250 commits and 300 files; past that the file list is not the whole story.
      const files = Array.isArray(c.files) && c.files.length < 300 ? c.files.map((f: any) => f.filename) : null
      return { status: c.status ?? 'unknown', commits, files, total: Number(c.total_commits) || commits.length }
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404) return { status: 'unknown', commits: [], files: null, total: 0 }
      throw e
    }
  }
}

// --- GitLab (a mirror) -------------------------------------------------------------------------------------

export class GitLabUpstream implements Upstream {
  source: Source = 'gitlab'
  where: string
  private api: string
  constructor(p: { base: string; project: string }, private d: HttpDeps) {
    this.where = `${new URL(p.base).host}/${p.project}`
    this.api = `${p.base}/api/v4/projects/${encodeURIComponent(p.project)}`
  }
  private get(p: string) { return getJson(this.api + p, this.d, { Accept: 'application/json' }, false) }
  async releases(): Promise<Release[]> {
    const list = await this.get('/releases?per_page=30')
    if (!Array.isArray(list)) return []
    return list.filter((r: any) => typeof r?.tag_name === 'string' && !r.upcoming_release).map((r: any) => ({
      tag: r.tag_name, name: r.name || r.tag_name, notes: String(r.description ?? ''), date: r.released_at ?? null,
      prerelease: /-/.test(r.tag_name), url: r._links?.self ?? null,
    }))
  }
  async tags(): Promise<string[]> {
    const list = await this.get('/repository/tags?per_page=100')
    return Array.isArray(list) ? list.map((t: any) => t?.name).filter((n: any) => typeof n === 'string') : []
  }
  async tag(tag: string): Promise<TagInfo> {
    const t = await this.get(`/repository/tags/${encodeURIComponent(checkRef(tag))}`)
    if (!t?.commit?.id) throw new UpstreamError(`tag ${tag} not found`)
    return { tag, commit: t.commit.id, annotated: !!t.message || (t.target && t.target !== t.commit.id), signed: null, verified: null }
  }
  async head(branch: string): Promise<CommitInfo> {
    const c = await this.get(`/repository/commits/${encodeURIComponent(checkRef(branch))}`)
    return { sha: c.id, subject: c.title ?? firstLine(c.message), body: restLines(c.message), date: c.committed_date ?? null }
  }
  async compare(base: string, head: string): Promise<Comparison> {
    try {
      const c = await this.get(`/repository/compare?from=${encodeURIComponent(checkRef(base))}&to=${encodeURIComponent(checkRef(head))}`)
      const commits: CommitInfo[] = (c.commits ?? []).map((x: any) => ({ sha: x.id, subject: x.title ?? firstLine(x.message), body: restLines(x.message), date: x.committed_date ?? null }))
      const files = Array.isArray(c.diffs) ? c.diffs.map((f: any) => f.new_path) : null
      return { status: commits.length ? 'ahead' : base === head ? 'identical' : 'unknown', commits, files, total: commits.length }
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404) return { status: 'unknown', commits: [], files: null, total: 0 }
      throw e
    }
  }
}

// --- plain git ---------------------------------------------------------------------------------------------
//
// For any other upstream (a self-hosted mirror, a test one). Fetches into refs/hyperprox-update/check/* in the
// install's own repository: objects only, nothing checked out, nothing run.

export class GitUpstream implements Upstream {
  source: Source = 'git'
  where: string
  constructor(private url: string, private dir: string, private sh: Shell, private allowFile = false) { this.where = url }
  private async git(args: string[], ok = [0]): Promise<string> {
    const r = await this.sh.run('git', ['-c', 'protocol.ext.allow=never', '-c', `protocol.file.allow=${this.allowFile ? 'always' : 'never'}`, ...args],
      { cwd: this.dir, env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' }, timeoutMs: 120_000 })
    if (!ok.includes(r.code)) throw new UpstreamError(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').pop() ?? r.code}`)
    return r.stdout
  }
  private async lsRemote(): Promise<Map<string, string>> {
    const out = await this.git(['ls-remote', '--heads', '--tags', this.url])
    const m = new Map<string, string>()
    for (const l of out.split('\n')) { const [sha, ref] = l.trim().split(/\s+/); if (sha && ref) m.set(ref, sha) }
    return m
  }
  async releases(): Promise<Release[]> { return [] }
  async tags(): Promise<string[]> {
    return [...(await this.lsRemote()).keys()].filter(r => r.startsWith('refs/tags/') && !r.endsWith('^{}')).map(r => r.slice(10))
  }
  async tag(tag: string): Promise<TagInfo> {
    checkRef(tag)
    await this.git(['fetch', '--no-tags', '--quiet', this.url, `+refs/tags/${tag}:refs/hyperprox-update/check/tags/${tag}`])
    const ref = `refs/hyperprox-update/check/tags/${tag}`
    const commit = (await this.git(['rev-parse', `${ref}^{commit}`])).trim()
    const kind = (await this.git(['cat-file', '-t', ref])).trim()
    const raw = kind === 'tag' ? await this.git(['cat-file', 'tag', ref]) : ''
    return { tag, commit, annotated: kind === 'tag', signed: /-----BEGIN (PGP|SSH) SIGNATURE-----/.test(raw), verified: null }
  }
  async head(branch: string): Promise<CommitInfo> {
    checkRef(branch)
    await this.git(['fetch', '--no-tags', '--quiet', this.url, `+refs/heads/${branch}:refs/hyperprox-update/check/heads/${branch}`])
    const [c] = await this.log([`-1`, `refs/hyperprox-update/check/heads/${branch}`])
    if (!c) throw new UpstreamError(`${branch} not found`)
    return c
  }
  private async log(args: string[]): Promise<CommitInfo[]> {
    const out = await this.git(['log', '--format=%H%x1f%s%x1f%cI%x1f%b%x1e', ...args])
    return out.split('\x1e').map(s => s.trim()).filter(Boolean).map(s => {
      const [sha, subject, date, body] = s.split('\x1f')
      return { sha, subject, date: date || null, body: (body ?? '').trim() }
    })
  }
  async compare(base: string, head: string): Promise<Comparison> {
    const known = (await this.sh.run('git', ['cat-file', '-e', `${checkRef(base)}^{commit}`], { cwd: this.dir })).code === 0
    if (!known) return { status: 'unknown', commits: [], files: null, total: 0 }
    if (base === head) return { status: 'identical', commits: [], files: [], total: 0 }
    const isAnc = async (a: string, b: string) => (await this.sh.run('git', ['merge-base', '--is-ancestor', a, b], { cwd: this.dir })).code === 0
    const status = await isAnc(base, head) ? 'ahead' : await isAnc(head, base) ? 'behind' : 'diverged'
    const commits = (await this.log(['--reverse', `${base}..${checkRef(head)}`])).slice(-250)
    const files = (await this.git(['diff', '--name-only', base, head])).split('\n').filter(Boolean)
    return { status, commits, files, total: commits.length }
  }
}
