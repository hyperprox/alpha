// Checking for a newer HyperProx: version order, plain-English commits, the flags, and the two channels against a
// pretend GitHub API — ETags (a 304 reuses the cached answer), the unauthenticated rate limit (no request is made
// again until it resets, and the check falls through to the mirror), and a release that is not newer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compareVersions } from '../src/lib/app-updates/versions'
import { findUpdate, flagsFrom, plainCommit, tagVersion, type Installed } from '../src/lib/self-update/check'
import { GitHubUpstream, GitLabUpstream, HttpCache, RateLimitedError, githubRepo, gitlabProject, type Fetcher, type FetchResponse, type Upstream } from '../src/lib/self-update/upstream'
import { inWindow, mergeSettings, DEFAULT_SETTINGS, SettingsError } from '../src/lib/self-update/settings'
import { readVersionFile, resolveVersion } from '../src/lib/version'

const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40), SHA_C = 'c'.repeat(40), SHA_T = 'd'.repeat(40)
const installed = (over: Partial<Installed> = {}): Installed => ({ version: '0.2.0-alpha', sha: SHA_A, describe: 'v0.1.0-alpha-12-gaaaaaaa', branch: 'main', git: true, ...over })

test('version order: semver precedence, pre-releases below their release, tags with or without v', () => {
  assert.ok(compareVersions('0.3.0-alpha', '0.2.0-alpha') > 0)
  assert.ok(compareVersions('0.2.0', '0.2.0-alpha') > 0)
  assert.ok(compareVersions('0.2.0-alpha.2', '0.2.0-alpha.10') < 0)
  assert.ok(compareVersions('0.2.0-beta', '0.2.0-alpha') > 0)
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0)
  assert.equal(compareVersions('0.2.0-alpha', '0.2.0-alpha'), 0)
  assert.equal(tagVersion('v0.1.0-alpha'), '0.1.0-alpha')
  assert.equal(tagVersion('0.3.0'), '0.3.0')
  assert.equal(tagVersion('nightly'), null)
  assert.equal(tagVersion('v1.2'), null)
})

test('commits in plain words; breaking, migration and keyholder flags', () => {
  assert.equal(plainCommit('feat(updates): add the self-update'), 'Add the self-update')
  assert.equal(plainCommit('Merge fix/wizard-fit: Wizards fit the screen'), 'Wizards fit the screen')
  assert.equal(plainCommit("Merge branch 'main' into x"), null)
  assert.equal(plainCommit('fix!: drop the old API'), 'Drop the old API')
  const f = flagsFrom('## Notes\n- BREAKING: the old /api/x is gone\nMIGRATION: run nothing by hand\n- plain line', {
    status: 'ahead', total: 2,
    commits: [{ sha: SHA_B, subject: 'feat!: new thing', body: '', date: null }, { sha: SHA_C, subject: 'docs: x', body: 'BREAKING CHANGE: y', date: null }],
    files: ['apps/api/prisma/migrations/20261101_add/migration.sql', 'bin/hyperprox-keyholder', 'README.md'],
  })
  assert.equal(f.breaking.length, 4)
  assert.deepEqual(f.migrations, ['20261101_add'])
  assert.equal(f.keyholder, true)
  assert.equal(f.unknownBase, false)
  assert.equal(flagsFrom(null, { status: 'unknown', commits: [], files: null, total: 0 }).filesUnknown, true)
})

// --- a pretend GitHub ----------------------------------------------------------------------------------------

interface Route { status?: number; body?: unknown; etag?: string; headers?: Record<string, string> }
function fakeGitHub(routes: Record<string, Route | (() => Route)>) {
  const log: Array<{ url: string; headers: Record<string, string> }> = []
  const fetcher: Fetcher = async (url, init) => {
    log.push({ url, headers: init.headers })
    const p = new URL(url).pathname + new URL(url).search
    const r0 = routes[p]
    if (!r0) return resp(404, { message: 'Not Found' })
    const r = typeof r0 === 'function' ? r0() : r0
    if (r.etag && init.headers['If-None-Match'] === r.etag) return resp(304, '', { etag: r.etag })
    return resp(r.status ?? 200, r.body, { ...(r.etag ? { etag: r.etag } : {}), ...(r.headers ?? {}) })
  }
  return { fetcher, log }
}
function resp(status: number, body: unknown, headers: Record<string, string> = {}): FetchResponse {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { status, headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
}
const R = '/repos/example/hyperprox'
const commit = (sha: string, msg: string) => ({ sha, commit: { message: msg, committer: { date: '2026-11-10T10:00:00Z' } } })

function gh(routes: Record<string, Route | (() => Route)>, cache = new HttpCache(null), now?: () => number) {
  const f = fakeGitHub(routes)
  return { up: new GitHubUpstream({ owner: 'example', repo: 'hyperprox' }, { cache, fetch: f.fetcher, now }), log: f.log, cache }
}

test('stable: the newest release newer than the installed version, with notes, commits and signature', async () => {
  const { up } = gh({
    [`${R}/releases?per_page=30`]: { body: [
      { tag_name: 'v0.3.0-alpha', name: 'v0.3.0-alpha', body: 'Self-update.\n- BREAKING: x', published_at: '2026-11-10T00:00:00Z', prerelease: true, html_url: 'https://github.com/example/hyperprox/releases/tag/v0.3.0-alpha' },
      { tag_name: 'v0.1.0-alpha', name: 'old', body: '', published_at: '2026-04-26T00:00:00Z', prerelease: true },
      { tag_name: 'v9.9.9', draft: true },
    ] },
    [`${R}/git/ref/tags/v0.3.0-alpha`]: { body: { object: { type: 'tag', sha: SHA_T } } },
    [`${R}/git/tags/${SHA_T}`]: { body: { object: { type: 'commit', sha: SHA_B }, verification: { verified: true, reason: 'valid' } } },
    [`${R}/compare/${SHA_A}...${SHA_B}`]: { body: { status: 'ahead', total_commits: 2, commits: [commit(SHA_C, 'feat: one'), commit(SHA_B, 'fix: two')], files: [{ filename: 'apps/api/prisma/migrations/2026_x/migration.sql' }] } },
  })
  const r = await findUpdate(installed(), 'stable', up)
  assert.ok(r.available, r.note)
  assert.equal(r.available!.label, 'v0.3.0-alpha')
  assert.equal(r.available!.sha, SHA_B)
  assert.equal(r.available!.notes, 'Self-update.\n- BREAKING: x')
  assert.deepEqual(r.available!.commits.map(c => c.text), ['Two', 'One'], 'newest first, in plain words')
  assert.deepEqual(r.available!.flags.migrations, ['2026_x'])
  assert.deepEqual(r.available!.signature, { annotated: true, signed: true, verifiedByHost: true })
})

test('stable: nothing newer, an older release, and the same version with newer commits', async () => {
  const rel = (tag: string) => ({ [`${R}/releases?per_page=30`]: { body: [{ tag_name: tag, body: '' }] } })
  const none = await findUpdate(installed(), 'stable', gh({ [`${R}/releases?per_page=30`]: { body: [] }, [`${R}/tags?per_page=100`]: { body: [] } }).up)
  assert.equal(none.available, null); assert.match(none.note, /No releases/)
  const older = await findUpdate(installed(), 'stable', gh(rel('v0.1.0-alpha')).up)
  assert.equal(older.available, null); assert.match(older.note, /newer than the newest release/)
  const same = gh({ ...rel('v0.2.0-alpha'),
    [`${R}/git/ref/tags/v0.2.0-alpha`]: { body: { object: { type: 'commit', sha: SHA_B } } },
    [`${R}/compare/${SHA_A}...${SHA_B}`]: { body: { status: 'ahead', total_commits: 1, commits: [commit(SHA_B, 'Release v0.2.0-alpha')], files: [] } } })
  const s = await findUpdate(installed(), 'stable', same.up)
  assert.ok(s.available); assert.match(s.note, /commits newer than this build/)
  const behind = gh({ ...rel('v0.2.0-alpha'),
    [`${R}/git/ref/tags/v0.2.0-alpha`]: { body: { object: { type: 'commit', sha: SHA_B } } },
    [`${R}/compare/${SHA_A}...${SHA_B}`]: { body: { status: 'behind', total_commits: 0, commits: [], files: [] } } })
  assert.equal((await findUpdate(installed(), 'stable', behind.up)).available, null)
  // No releases: the tags stand in.
  const tagsOnly = gh({ [`${R}/releases?per_page=30`]: { body: [] }, [`${R}/tags?per_page=100`]: { body: [{ name: 'v0.4.0' }, { name: 'junk' }] },
    [`${R}/git/ref/tags/v0.4.0`]: { body: { object: { type: 'commit', sha: SHA_B } } } })
  const t = await findUpdate(installed(), 'stable', tagsOnly.up)
  assert.equal(t.available, null, 'compare 404: upstream does not know the installed commit, so stable offers nothing')
  assert.match(t.note, /does not contain this install's commit/)
  const withCmp = gh({ [`${R}/releases?per_page=30`]: { body: [] }, [`${R}/tags?per_page=100`]: { body: [{ name: 'v0.4.0' }] },
    [`${R}/git/ref/tags/v0.4.0`]: { body: { object: { type: 'commit', sha: SHA_B } } },
    [`${R}/compare/${SHA_A}...${SHA_B}`]: { body: { status: 'ahead', total_commits: 1, commits: [commit(SHA_B, 'x')], files: [] } } })
  assert.equal((await findUpdate(installed(), 'stable', withCmp.up)).available?.label, 'v0.4.0')
})

test('stable: a newer version number that does not contain the installed commit (a renamed old tag) is never offered', async () => {
  const mk = (status: string) => gh({
    [`${R}/releases?per_page=30`]: { body: [{ tag_name: 'v9.0.0', body: '' }] },
    [`${R}/git/ref/tags/v9.0.0`]: { body: { object: { type: 'commit', sha: SHA_C } } },
    [`${R}/compare/${SHA_A}...${SHA_C}`]: { body: { status, total_commits: 1, commits: [commit(SHA_C, 'x')], files: [] } },
  }).up
  const r = await findUpdate(installed(), 'stable', mk('behind'))
  assert.equal(r.available, null)
  assert.match(r.note, /already contains v9\.0\.0/)
  assert.equal((await findUpdate(installed(), 'stable', mk('diverged'))).available, null, 'diverged is not ahead')
})

test('stable: pre-releases only with "include pre-releases" (on by default)', async () => {
  const routes = {
    [`${R}/releases?per_page=30`]: { body: [{ tag_name: 'v0.3.0-alpha', body: '', prerelease: true }, { tag_name: 'v0.1.0', body: '', prerelease: false }] },
    [`${R}/git/ref/tags/v0.3.0-alpha`]: { body: { object: { type: 'commit', sha: SHA_B } } },
    [`${R}/compare/${SHA_A}...${SHA_B}`]: { body: { status: 'ahead', total_commits: 1, commits: [commit(SHA_B, 'x')], files: [] } },
  }
  assert.equal((await findUpdate(installed(), 'stable', gh(routes).up)).available?.label, 'v0.3.0-alpha')
  const off = await findUpdate(installed(), 'stable', gh(routes).up, { includePrereleases: false })
  assert.equal(off.available, null, 'v0.1.0 is older than the installed 0.2.0-alpha, and the pre-release is excluded')
  const onlyPre = gh({ [`${R}/releases?per_page=30`]: { body: [{ tag_name: 'v0.3.0-alpha', body: '', prerelease: true }] } })
  assert.match((await findUpdate(installed(), 'stable', onlyPre.up, { includePrereleases: false })).note, /Only pre-releases/)
})

test('alpha: a stale GitLab mirror behind this install is "behind", never offered as an update', async () => {
  const P = '/api/v4/projects/root%2Fhyperprox/repository'
  const gl = fakeGitHub({
    [`${P}/commits/main`]: { body: { id: SHA_C, title: 'old', message: 'old', committed_date: null } },
    [`${P}/compare?from=${SHA_A}&to=${SHA_C}&straight=false`]: { body: { commits: [], diffs: [] } },
    [`${P}/compare?from=${SHA_C}&to=${SHA_A}&straight=false`]: { body: { commits: [{ id: SHA_A, title: 'newer, installed' }], diffs: [] } },
  })
  const mirror = new GitLabUpstream(gitlabProject('https://gitlab.example.com/root/hyperprox.git')!, { cache: new HttpCache(null), fetch: gl.fetcher })
  assert.equal(mirror.mirror, true)
  assert.equal((await mirror.compare(SHA_A, SHA_C)).status, 'behind')
  const r = await findUpdate(installed(), 'alpha', mirror)
  assert.equal(r.available, null)
  assert.match(r.note, /ahead of main/)
})

test('alpha: the newest commit on main, the commits since, and nothing when up to date or ahead', async () => {
  const routes = {
    [`${R}/commits/main`]: { body: commit(SHA_B, 'Wizards fit the screen\n\nbody') },
    [`${R}/compare/${SHA_A}...${SHA_B}`]: { body: { status: 'ahead', total_commits: 3, commits: [commit(SHA_C, 'one'), commit('e'.repeat(40), "Merge branch 'x'"), commit(SHA_B, 'Wizards fit the screen')], files: ['bin/hyperprox-keyholder'].map(filename => ({ filename })) } },
  }
  const r = await findUpdate(installed(), 'alpha', gh(routes).up)
  assert.equal(r.available?.label, 'main @ bbbbbbb')
  assert.deepEqual(r.available?.commits.map(c => c.text), ['Wizards fit the screen', 'One'], 'merge noise dropped')
  assert.equal(r.available?.totalCommits, 3)
  assert.equal(r.available?.flags.keyholder, true)
  assert.equal((await findUpdate(installed({ sha: SHA_B }), 'alpha', gh(routes).up)).available, null)
  const ahead = gh({ [`${R}/commits/main`]: { body: commit(SHA_B, 'x') }, [`${R}/compare/${SHA_A}...${SHA_B}`]: { body: { status: 'behind', commits: [], files: [] } } })
  const a = await findUpdate(installed(), 'alpha', ahead.up)
  assert.equal(a.available, null); assert.match(a.note, /ahead of main/)
})

test('ETags: the second request carries If-None-Match, and a 304 answers from the cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-etag-'))
  try {
    const cache = new HttpCache(path.join(dir, 'cache.json'))
    const routes = { [`${R}/commits/main`]: { body: commit(SHA_B, 'x'), etag: 'W/"abc"' } }
    const { up, log } = gh(routes, cache)
    assert.equal((await up.head('main')).sha, SHA_B)
    assert.equal(log[0].headers['If-None-Match'], undefined)
    assert.equal(log[0].headers['User-Agent'], 'HyperProx-self-update')
    assert.equal(log[0].headers.Authorization, undefined, 'never a token')
    assert.equal((await up.head('main')).sha, SHA_B)
    assert.equal(log[1].headers['If-None-Match'], 'W/"abc"')
    // A restart keeps the cache: the next process sends the ETag too.
    const again = gh(routes, new HttpCache(path.join(dir, 'cache.json')))
    await again.up.head('main')
    assert.equal(again.log[0].headers['If-None-Match'], 'W/"abc"')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('rate limit: a spent limit stops every request until its reset, and a mirror answers instead', async () => {
  let now = 1_800_000_000_000
  const reset = Math.floor(now / 1000) + 600
  const { up, log, cache } = gh({ [`${R}/commits/main`]: { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } } }, new HttpCache(null), () => now)
  await assert.rejects(up.head('main'), RateLimitedError)
  assert.equal(log.length, 1)
  await assert.rejects(up.head('main'), (e: any) => e instanceof RateLimitedError && e.until.getTime() === reset * 1000)
  assert.equal(log.length, 1, 'no second request while limited')
  now = reset * 1000 + 1
  await assert.rejects(up.head('main'), RateLimitedError)
  assert.equal(log.length, 2, 'asks again after the reset')
  assert.equal(cache.rateLimitedUntil, reset * 1000)

  // The mirror: GitLab's API, tried next.
  const gl = fakeGitHub({
    '/api/v4/projects/root%2Fhyperprox/repository/commits/main': { body: { id: SHA_B, title: 'from the mirror', message: 'from the mirror', committed_date: '2026-11-11T00:00:00Z' } },
    ['/api/v4/projects/root%2Fhyperprox/repository/compare?from=' + SHA_A + '&to=' + SHA_B + '&straight=false']: { body: { commits: [{ id: SHA_B, title: 'from the mirror' }], diffs: [] } },
    ['/api/v4/projects/root%2Fhyperprox/repository/compare?from=' + SHA_B + '&to=' + SHA_A + '&straight=false']: { body: { commits: [], diffs: [] } },
  })
  const mirror = new GitLabUpstream(gitlabProject('https://gitlab.example.com/root/hyperprox.git')!, { cache: new HttpCache(null), fetch: gl.fetcher })
  const ups: Upstream[] = [up, mirror]
  now = reset * 1000 - 1
  ;(up as any).d.cache.rateLimitedUntil = reset * 1000
  let got = null as any, errors: string[] = []
  for (const u of ups) { try { got = await findUpdate(installed(), 'alpha', u); break } catch (e: any) { errors.push(e.message) } }
  assert.equal(got?.available?.sha, SHA_B)
  assert.match(errors[0], /limit/)
})

test('repo URLs: GitHub and GitLab parsing', () => {
  assert.deepEqual(githubRepo('https://github.com/hyperprox/alpha.git'), { owner: 'hyperprox', repo: 'alpha' })
  assert.deepEqual(githubRepo('git@github.com:hyperprox/alpha.git'), { owner: 'hyperprox', repo: 'alpha' })
  assert.equal(githubRepo('https://gitlab.example.com/root/hyperprox.git'), null)
  assert.deepEqual(gitlabProject('https://gitlab.example.com/root/hyperprox.git'), { base: 'https://gitlab.example.com', project: 'root/hyperprox' })
  assert.equal(gitlabProject('http://gitlab.example.com/root/x'), null)
})

test('settings: defaults off, validated, auto-install only on stable; the maintenance window', () => {
  assert.deepEqual({ ...DEFAULT_SETTINGS, window: undefined }, { channel: 'stable', checkEveryHours: 6, notify: false, requireSigned: false, includePrereleases: true, autoInstall: false, window: undefined })
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { channel: 'nightly' }), SettingsError)
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { checkEveryHours: 0 }), SettingsError)
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { repoUrl: 'https://evil.example/x.git' }), /not a self-update setting/)
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { channel: 'alpha', autoInstall: true }), /stable/)
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { window: { start: '25:00' } }), SettingsError)
  const s = mergeSettings(DEFAULT_SETTINGS, { autoInstall: true, window: { days: [1, 3], start: '22:00', end: '02:00' } })
  assert.equal(s.autoInstall, true)
  const at = (d: string) => new Date(d)
  assert.equal(inWindow(s.window, at('2026-11-09T23:00:00')), true, 'Monday 23:00')
  assert.equal(inWindow(s.window, at('2026-11-10T01:30:00')), true, 'Tuesday 01:30 belongs to Monday night')
  assert.equal(inWindow(s.window, at('2026-11-10T23:00:00')), false, 'Tuesday night is not in the window')
  assert.equal(inWindow(s.window, at('2026-11-09T12:00:00')), false)
  assert.equal(inWindow({ days: [0, 1, 2, 3, 4, 5, 6], start: '03:00', end: '05:00' }, at('2026-11-12T04:59:00')), true)
})

test('version identity: describe from git, or from VERSION in an unpacked archive', () => {
  const v = resolveVersion()
  assert.ok(v.version && v.describe, 'a version and a describe')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-ver-'))
  try {
    fs.writeFileSync(path.join(dir, 'VERSION'), '$Format:%(describe:tags) %H$\n')
    assert.equal(readVersionFile(path.join(dir, 'VERSION')), null, 'a checkout keeps the placeholder')
    fs.writeFileSync(path.join(dir, 'VERSION'), `v0.3.0-2-gbbbbbbb ${SHA_B}\n`)
    assert.deepEqual(readVersionFile(path.join(dir, 'VERSION')), { describe: 'v0.3.0-2-gbbbbbbb', sha: SHA_B })
    fs.writeFileSync(path.join(dir, 'VERSION'), ` ${SHA_B}\n`)
    assert.deepEqual(readVersionFile(path.join(dir, 'VERSION')), { describe: 'bbbbbbb', sha: SHA_B }, 'no tag: only the commit')
    const root = path.resolve(__dirname, '..', '..', '..')
    assert.match(fs.readFileSync(path.join(root, 'VERSION'), 'utf8'), /^\$Format:%\(describe:tags\) %H\$$/m)
    assert.match(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'), /^VERSION export-subst$/m)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
