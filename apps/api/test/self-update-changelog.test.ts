// What's new on the HyperProx update page: CHANGELOG.md entries in plain English only (technical sub-notes,
// markdown and HTML comments dropped), the range an update brings (dated on or after the first commit the install
// does not have), the fallbacks (no CHANGELOG change, an unreadable file, no notes at all), and that the notes
// always come from the OFFERED commit, never the installed copy. Also checks the repository's own CHANGELOG.md.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { entriesSince, notesFor, notesSummary, parseChangelog, plainText } from '../src/lib/self-update/changelog'
import { changelogFor, findUpdate, type Installed } from '../src/lib/self-update/check'
import { GitHubUpstream, HttpCache, type Comparison, type FetchResponse, type Upstream } from '../src/lib/self-update/upstream'

const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40)
const installed = (over: Partial<Installed> = {}): Installed => ({ version: '0.2.0-alpha', sha: SHA_A, describe: 'x', branch: 'main', git: true, date: '2026-11-10T09:00:00+00:00', ...over })

const MD = `# Changelog

Intro text that is not an entry.

<!--
## 2099-01-01 — A commented-out entry
- never shown
-->

## 2026-11-15 — Load balancing and **Updates**

### Fixed
- Typing in a dialog no longer jumps to the close button.

### New
- **Load balancing** replaces Placement. It evens out your nodes
  with as few moves as possible.
  - Technical: \`/balance\`; table \`PlacementPlan\` (additive migration).
    More technical text on a wrapped line.
- Users and invites, with a [one-time link](https://example.invalid/x).
  <details><summary>Technical</summary>
  routes under /api/users
  </details>

### Before you update
- Placement is now Load balancing.
  - Technical: /placement redirects to /balance.

## 2026-11-12 · v0.3.0-alpha — Websites
### New
- Websites, a section of its own.

## 2026-11-01 — Certificates
### Improved
- Restarting no longer locks it.
`

test('plain lines only: technical sub-notes, details blocks, markdown and comments are dropped', () => {
  const e = parseChangelog(MD)
  assert.deepEqual(e.map(x => x.date), ['2026-11-15', '2026-11-12', '2026-11-01'])
  assert.equal(e[0].title, 'Load balancing and Updates')
  assert.equal(e[1].version, 'v0.3.0-alpha')
  assert.equal(e[1].id, '2026-11-12-v0.3.0-alpha')
  // "Before you update" is put first, then New, Improved, Fixed.
  assert.deepEqual(e[0].sections.map(s => s.kind), ['before', 'new', 'fixed'])
  assert.deepEqual(e[0].sections[1].items, [
    'Load balancing replaces Placement. It evens out your nodes with as few moves as possible.',
    'Users and invites, with a one-time link.',
  ])
  assert.deepEqual(e[0].sections[0].items, ['Placement is now Load balancing.'])
  const all = JSON.stringify(e)
  for (const bad of ['Technical', 'PlacementPlan', '/balance', '/api/users', 'example.invalid', '2099', '**', '`']) assert.ok(!all.includes(bad), `"${bad}" leaked into the plain notes`)
  assert.equal(plainText('A `code` and _emphasis_ and <b>tag</b>'), 'A code and emphasis and tag')
})

test('range: entries dated on or after the first new commit, newest first; unknown start maps nothing', () => {
  const e = parseChangelog(MD)
  assert.deepEqual(entriesSince(e, '2026-11-12').map(x => x.date), ['2026-11-15', '2026-11-12'])
  assert.deepEqual(entriesSince(e, '2026-11-13').map(x => x.date), ['2026-11-15'])
  assert.deepEqual(entriesSince(e, '2026-11-16'), [])
  assert.deepEqual(entriesSince(e, null), [])
  const n = notesFor(MD, '2026-11-12')
  assert.equal(n.read, true)
  assert.deepEqual(notesSummary(n), { count: 2, before: true, titles: ['Load balancing and Updates', 'Websites'] })
  assert.deepEqual(notesFor(null, '2026-11-12'), { entries: [], read: false, fromDay: '2026-11-12' })
  assert.deepEqual(notesSummary(undefined), { count: 0, before: false, titles: [] })
})

// An upstream whose CHANGELOG.md differs per commit, recording which commit it was asked for.
function upstreamWithFiles(files: Record<string, string | null>, cmp: Partial<Comparison> = {}) {
  const asked: string[] = []
  const up: Upstream = {
    source: 'github', where: 'github.com/example/hyperprox',
    async releases() { return [] }, async tags() { return [] },
    async tag() { throw new Error('unused') },
    async head() { return { sha: SHA_B, subject: 'feat: something', body: '', date: '2026-11-15T10:00:00Z' } },
    async compare() {
      return { status: 'ahead' as const, commits: [{ sha: SHA_B, subject: 'feat: something', body: '', date: '2026-11-12T08:00:00+02:00' }], files: ['CHANGELOG.md'], total: 7, ...cmp }
    },
    async file(ref: string, p: string) { asked.push(`${ref}:${p}`); return files[ref] ?? null },
  }
  return { up, asked }
}

test('the notes come from the offered commit, never the installed copy', async () => {
  const installedCopy = '# Changelog\n\n## 2026-11-14 — Only in the installed copy\n### New\n- installed-only line\n'
  const { up, asked } = upstreamWithFiles({ [SHA_A]: installedCopy, [SHA_B]: MD })
  const r = await findUpdate(installed(), 'alpha', up)
  assert.ok(r.available)
  assert.deepEqual(asked, [`${SHA_B}:CHANGELOG.md`])
  // From the first new commit's own day (2026-11-12), not the installed commit's (2026-11-10).
  assert.equal(r.available!.changelog.fromDay, '2026-11-12')
  assert.deepEqual(r.available!.changelog.entries.map(e => e.title), ['Load balancing and Updates', 'Websites'])
  assert.ok(!JSON.stringify(r.available!.changelog).includes('installed-only'))
})

test('fallbacks: no CHANGELOG change fetches nothing; unreadable or absent gives no notes; the check still succeeds', async () => {
  const unchanged = upstreamWithFiles({ [SHA_B]: MD }, { files: ['README.md'] })
  const n1 = await changelogFor(unchanged.up, SHA_B, installed(), await unchanged.up.compare(SHA_A, SHA_B))
  assert.deepEqual(unchanged.asked, [])
  assert.deepEqual(n1.entries, [])

  const missing = upstreamWithFiles({})
  const r = await findUpdate(installed(), 'alpha', missing.up)
  assert.equal(r.available!.changelog.read, false)
  assert.deepEqual(r.available!.changelog.entries, [])
  assert.equal(r.available!.totalCommits, 7)

  const broken = upstreamWithFiles({})
  broken.up.file = async () => { throw new Error('network down') }
  const n2 = await changelogFor(broken.up, SHA_B, installed(), await broken.up.compare(SHA_A, SHA_B))
  assert.equal(n2.read, false)

  const noFile = upstreamWithFiles({ [SHA_B]: MD })
  delete noFile.up.file
  assert.equal((await changelogFor(noFile.up, SHA_B, installed(), null)).read, false)

  // No commit dates (some mirrors): the installed commit's day is the start.
  const undated = upstreamWithFiles({ [SHA_B]: MD }, { commits: [{ sha: SHA_B, subject: 'x', body: '', date: null }] })
  const n3 = await changelogFor(undated.up, SHA_B, installed({ date: '2026-11-13T23:00:00Z' }), await undated.up.compare(SHA_A, SHA_B))
  assert.deepEqual(n3.entries.map(e => e.date), ['2026-11-15'])
})

test('GitHub: CHANGELOG.md is read at the offered commit through the contents API, and no other file can be', async () => {
  const urls: string[] = []
  const resp = (status: number, body: unknown): FetchResponse => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) })
  const up = new GitHubUpstream({ owner: 'example', repo: 'hyperprox' }, {
    cache: new HttpCache(null),
    fetch: async url => {
      urls.push(url)
      return new URL(url).pathname.endsWith('/contents/CHANGELOG.md') ? resp(200, { encoding: 'base64', content: Buffer.from(MD).toString('base64') }) : resp(404, {})
    },
  })
  assert.equal(await up.file(SHA_B, 'CHANGELOG.md'), MD)
  assert.ok(urls[0].endsWith(`/repos/example/hyperprox/contents/CHANGELOG.md?ref=${SHA_B}`))
  await assert.rejects(up.file(SHA_B, '.env'))
})

test('the repository CHANGELOG.md: dated entries, plain lines without code, paths or technical notes', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8')
  const entries = parseChangelog(md)
  assert.ok(entries.length >= 1)
  for (const e of entries) {
    assert.ok(e.title, `${e.date} has a title`)
    assert.ok(e.sections.length, `${e.date} has sections`)
    for (const s of e.sections) for (const t of s.items) {
      assert.ok(!/Technical:|`|\/api\/|\.tsx?\b|\.ya?ml\b|\.env\b|https?:\/\//.test(t), `technical text in a plain line: ${t}`)
    }
  }
  const dates = entries.map(e => e.date)
  assert.deepEqual([...dates].sort().reverse(), dates, 'newest entry first')
})
