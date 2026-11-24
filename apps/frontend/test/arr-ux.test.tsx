// The Arr Stack page, reworked: "Needs you" first with one Fix button per item and "All good ✓" when empty, one
// consistent summary, a compact queue (one line per show or film, plain status, jargon only under technical details),
// one "⋯" menu per row, six tabs, and the same words everywhere. Rendered to static HTML. All names are made up.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import "./css-stub"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { ArrHeader, ARR_TABS, readTab } from '../components/plugins/arr/ArrHeader'
import { NeedsView, type UnfiledImport } from '../components/plugins/arr/Needs'
import { ArrDownloadingView, FileRow, ItemRow, type QDownload, type QueueData } from '../components/plugins/arr/Queue'
import { ActionsProvider, menuPlan, type FixTarget } from '../components/plugins/arr/QueueActions'
import { ArrBehindNumbers } from '../components/plugins/arr/Advanced'
import { findableId, leftWord, needsCount, summaryLine, type NeedItem, type PlainData, type PlainItem } from '../components/plugins/arr/arr-plain'

const noop = () => {}
const H = (n: number) => String(n).padStart(40, 'a')

const dl = (n: number, over: Partial<QDownload> = {}): QDownload => ({
  id: `d:${H(n).toUpperCase()}`, name: `Example.Show.S01.1080p.WEB.h264-GROUP${n}`, size: 12.5e9, sizeLeft: 1.1e9, progress: 91.2, etaSec: 14_040, status: 'downloading', state: 'downloading',
  quality: 'WEBDL-1080p', protocol: 'torrent', client: 'qBittorrent', indexer: 'TorrentDownload (Prowlarr)', episodes: 24, episodeRange: 'E01–E24', problem: null, messages: [], ...over,
})
const item = (o: Partial<PlainItem> = {}): PlainItem => ({
  key: 's:1', kind: 'show', instance: 'sonarr', title: 'Example Show', detail: '2 seasons · 25 episodes', order: 1, state: 'downloading', text: 'downloading · 3.9 h', line: null,
  progress: 86, sizeLeft: 1.9e9, etaSec: 14_040, problem: null, downloadIds: [`d:${H(1).toUpperCase()}`], problemIds: [], torrentIds: [`d:${H(1).toUpperCase()}`],
  children: [{ key: '2', label: 'S02 · 24 episodes', state: 'downloading', text: 'downloading · 3.9 h', progress: 91, sizeLeft: 1.1e9,
    downloads: [{ id: `d:${H(1).toUpperCase()}`, state: 'downloading', text: 'downloading · 3.9 h', progress: 91.2, size: 12.5e9, sizeLeft: 1.1e9, episodes: 24, problem: null, torrent: true }] }], ...o,
})
const need = (o: Partial<NeedItem> = {}): NeedItem => ({ key: 's:2', kind: 'show', instance: 'sonarr', title: 'Stuck Show', severity: 'warn', what: 'The download is stuck. Nobody is sharing it.', problemIds: [`d:${H(2).toUpperCase()}`], retryIds: [], blocked: false, ...o })
const plain = (items: PlainItem[], needs: NeedItem[] = [], text = '2 shows · 1 film · 1 downloading now · 9.2 MB/s · nothing stuck', stuck = needs.length): PlainData => ({
  summary: { shows: 2, films: 1, artists: 0, downloading: 1, waiting: 1, stuck, requestsStuck: 0, done: 0, sizeLeft: 3e9, speedBps: 9_200_000, text, unit: 'Counted as shows, films and artists. A season pack, or twenty single episodes of one show, is one show.' },
  items, needs,
})
const queueData = (p: PlainData, over: Partial<QueueData> = {}): QueueData => ({
  at: Date.now(), services: { sonarr: { ok: true, configured: true }, radarr: { ok: true, configured: true } },
  summary: { downloads: 2, shows: 2, movies: 1, rows: 30, sizeLeft: 3e9, attention: 0, stalled: 0, warnings: 0 }, shows: [], movies: [], capabilities: { prioritise: true }, plain: p, ...over,
})
const Admin = ({ children }: { children: React.ReactNode }) => <ActionsProvider admin canPrioritise>{children}</ActionsProvider>
const Viewer = ({ children }: { children: React.ReactNode }) => <ActionsProvider admin={false} canPrioritise={false}>{children}</ActionsProvider>

// ── header and tabs ─────────────────────────────────────────────────────────────────────────────────────────────

test('header: the six tabs in order, the summary sentence, a count on Needs you, and Pause and Refresh', () => {
  const html = renderToStaticMarkup(<ArrHeader summary="56 shows · 3 films · 15 downloading now · 9.2 MB/s · 1 stuck" live fresh lastWord={null} onLive={noop} onRefresh={noop} loading={false} tab="needs" onTab={noop} needs={1} />)
  assert.deepEqual(ARR_TABS.map(t => t[1]), ['Needs you', 'Downloading', 'Requests', 'Coming up', 'Live TV', 'Advanced'])
  const labels = [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map(m => m[1])
  assert.deepEqual(labels, ['Needs you', 'Downloading', 'Requests', 'Coming up', 'Live TV', 'Advanced'])
  assert.match(html, /56 shows · 3 films · 15 downloading now · 9\.2 MB\/s · 1 stuck/)
  assert.match(html, /aria-selected="true"[^>]*>Needs you/); assert.match(html, /aria-label="1 need you"/)
  assert.match(html, />Pause</); assert.match(html, />Refresh</)
  assert.ok(!/aria-label="\d+ need you"/.test(renderToStaticMarkup(<ArrHeader summary="x" live fresh lastWord={null} onRefresh={noop} loading={false} tab="needs" onTab={noop} needs={0} />)), 'no badge when nothing needs you')
})

test('a tab remembered by the old page opens the one that replaced it', () => {
  assert.equal(readTab('queue'), 'downloading'); assert.equal(readTab('upcoming'), 'comingup'); assert.equal(readTab('overview'), 'advanced')
  assert.equal(readTab('sorting'), 'advanced'); assert.equal(readTab('livetv'), 'livetv'); assert.equal(readTab('needs'), 'needs')
  assert.equal(readTab('nonsense'), null); assert.equal(readTab(null), null)
})

test('one summary: the same sentence and count from the same reading; unfiled imports are added the same way in both', () => {
  const p = plain([], [need(), need({ key: 's:3' })], '2 shows · 1 film · 1 downloading now · 9.2 MB/s · 2 stuck')
  assert.equal(summaryLine(p), p.summary.text); assert.equal(needsCount(p), 2)
  assert.equal(summaryLine(p, 1), '2 shows · 1 film · 1 downloading now · 9.2 MB/s · 3 stuck'); assert.equal(needsCount(p, 1), 3)
  const calm = plain([], [], '2 shows · 1 film · 1 downloading now · nothing stuck')
  assert.match(summaryLine(calm, 2), /2 stuck$/)
  assert.equal(summaryLine(null), 'Reading the queue…'); assert.equal(needsCount(null), 0)
})

// ── Needs you ───────────────────────────────────────────────────────────────────────────────────────────────────

const view = (o: Partial<Parameters<typeof NeedsView>[0]> = {}, admin = true) => renderToStaticMarkup(
  (admin ? Admin : Viewer)({ children: <NeedsView needs={[]} failed={[]} health={null} stuck={[]} unfiled={[]} canAct={admin} onMap={noop} onAct={noop} choices={[]} onChoice={noop} ready {...o} /> }))

test('nothing needs you: "All good ✓" with the summary, and no list', () => {
  const html = view({ summary: '2 shows and 1 film are on their way.' })
  assert.match(html, /All good ✓/); assert.match(html, /2 shows and 1 film are on their way\./); assert.ok(!/<ul/.test(html))
  assert.match(view({ ready: false }), /Reading the queue/); assert.ok(!/All good/.test(view({ ready: false })), 'never "all good" before the first reading')
  // a Seerr that is fine does not count as a problem either
  assert.match(view({ health: { configured: true, problems: [], stale: [], staleId: 'x', readAt: '' } }), /All good ✓/)
})

test('needs you: one Fix button per item, the plain sentence, no client or release words; a viewer is told to ask an admin', () => {
  const needs = [need({ key: 's:2', title: 'Stuck Show' }), need({ key: 's:9', title: 'Broken Film', kind: 'film', instance: 'radarr', severity: 'bad', what: 'The download failed.', problemIds: [`d:${H(9).toUpperCase()}`] })]
  const html = view({ needs })
  assert.equal((html.match(/>Fix</g) ?? []).length, 2, 'exactly one Fix per item')
  assert.match(html, /Stuck Show/); assert.match(html, /The download is stuck\. Nobody is sharing it\./); assert.match(html, /Broken Film/); assert.match(html, /The download failed\./)
  assert.ok(!/All good/.test(html))
  assert.ok(!/stalledDL|queuedDL|importBlocked|WEBDL|TorrentDownload/.test(html))
  const v = view({ needs }, false)
  assert.ok(!/<button/.test(v)); assert.equal((v.match(/Ask an admin to fix this\./g) ?? []).length, 2)
})

test('needs you: "Fix all stuck" appears for two or more stalled downloads, for an admin only', () => {
  const two = [{ instance: 'sonarr' as const, id: 'd:A' }, { instance: 'radarr' as const, id: 'd:B' }]
  const needs = [need(), need({ key: 's:3', title: 'Other Show' })]
  assert.match(view({ needs, stalledAll: two }), /Fix all stuck \(2\)/)
  assert.ok(!/Fix all stuck/.test(view({ needs, stalledAll: two.slice(0, 1) })), 'one is just its own Fix')
  assert.ok(!/Fix all stuck/.test(view({ needs, stalledAll: two }, false)), 'a viewer sees no buttons')
})

test('needs you: failed requests and finished downloads that cannot be filed each get their one button too', () => {
  const failedRequest = { id: 7, kind: 'tv' as const, title: 'Example Series', year: 2026, poster: null, group: 'failed' as const, where: 'Sonarr could not add it.', progress: null, who: 'a family member', at: '2026-11-20T00:00:00Z', seasons: 2, sortedInto: null, is4k: false }
  const unfiled: UnfiledImport = { id: 'HASH1', title: 'x', series: 'Odd Names Show', path: '', reason: 'no episode numbers', files: 5, mappable: 4, unmappable: ['a'] }
  const html = view({ failed: [failedRequest], unfiled: [unfiled] })
  assert.match(html, /Example Series/); assert.match(html, /Fix: try again/); assert.match(html, /Odd Names Show/); assert.match(html, /Fix: map by filename/)
  assert.ok(!/All good/.test(html))
})

// ── Downloading ─────────────────────────────────────────────────────────────────────────────────────────────────

test('downloading: one line per show or film in the given order, plain status, a "⋯" menu each, no jargon, no episode-level clutter', () => {
  const items = [
    item(),
    item({ key: 's:3', title: 'Waiting Show', order: 2, state: 'waiting', text: 'waiting · 1st in line', line: 1, progress: 0, children: [], torrentIds: [], downloadIds: [`d:${H(3).toUpperCase()}`] }),
    item({ key: `d:${H(5).toUpperCase()}`, kind: 'film', instance: 'radarr', title: 'Example Film', detail: '2026', order: 3, state: 'waiting', text: 'waiting · 2nd in line', line: 2, children: [] }),
  ]
  const html = renderToStaticMarkup(<Admin><ArrDownloadingView q={{ data: queueData(plain(items)), error: null, at: Date.now() }} /></Admin>)
  assert.deepEqual([...html.matchAll(/<b>([^<]+)<\/b>/g)].map(m => m[1]), ['Example Show', 'Waiting Show', 'Example Film'])
  assert.match(html, /downloading · 3\.9 h/); assert.match(html, /waiting · 1st in line/); assert.match(html, /waiting · 2nd in line/)
  assert.equal((html.match(/aria-haspopup="menu"/g) ?? []).length, 3, 'one menu per row')
  assert.ok(!/Find another|Find a faster copy/.test(html), 'the two overlapping buttons are gone')
  assert.ok(!/WEBDL|queuedDL|stalledDL|TorrentDownload|h264|\d+\.\dd left|no ETA/i.test(html), 'collapsed rows show no jargon and no fake ETA')
  assert.ok(!/S02 · 24 episodes/.test(html), 'seasons only appear after a tap')
  assert.match(html, /Counted as shows, films and artists/)
  // a viewer sees the lines but no menu
  const v = renderToStaticMarkup(<Viewer><ArrDownloadingView q={{ data: queueData(plain(items)), error: null, at: Date.now() }} /></Viewer>)
  assert.ok(!/aria-haspopup/.test(v)); assert.match(v, /Example Show/)
})

test('downloading: empty and error states are plain', () => {
  assert.match(renderToStaticMarkup(<Admin><ArrDownloadingView q={{ data: queueData(plain([])), error: null, at: 1 }} /></Admin>), /Nothing is downloading/)
  assert.match(renderToStaticMarkup(<Admin><ArrDownloadingView q={{ data: null, error: null, at: null }} /></Admin>), /Reading the queue/)
  const down = queueData(plain([]), { services: { sonarr: { ok: false, configured: true, error: 'timed out' }, radarr: { ok: true, configured: true } } })
  assert.match(renderToStaticMarkup(<Admin><ArrDownloadingView q={{ data: down, error: null, at: 1 }} /></Admin>), /Sonarr is not answering: timed out\. Its downloads are missing here\./)
})

test('an opened show lists its seasons; a season lists its files; release names and client words appear only under "Technical details"', () => {
  const d = dl(1)
  const html = renderToStaticMarkup(<Admin><ItemRow it={item()} dmap={new Map([[d.id, d]])} swapSingles={false} /></Admin>)
  assert.ok(!/S02/.test(html), 'closed by default')
  const file = renderToStaticMarkup(<Admin><FileRow pd={item().children[0].downloads[0]} d={d} instance="sonarr" title="Example Show" canFindBetter /></Admin>)
  const [before, after] = file.split('<details')
  assert.match(before, /1\.1 GB left of 12\.5 GB/); assert.match(before, /24 episodes/); assert.match(before, /downloading · 3\.9 h/)
  assert.ok(!/WEBDL|qBittorrent|TorrentDownload|h264/.test(before), 'nothing technical before the fold')
  assert.match(after, /Technical details/); assert.match(after, /Example\.Show\.S01\.1080p\.WEB\.h264-GROUP1/); assert.match(after, /WEBDL-1080p/); assert.match(after, /TorrentDownload \(Prowlarr\)/)
})

test('a stuck file shows the Arr\'s plain reason up front (no state names) and the menu', () => {
  const d = dl(2, { problem: 'stalled', messages: ['The download is stalled with no connections'], state: 'downloading', progress: 0, sizeLeft: 791e6, size: 791e6, episodes: 1, episodeRange: 'E07' })
  const html = renderToStaticMarkup(<Admin><FileRow pd={{ id: d.id, state: 'stuck', text: 'stuck', progress: 0, size: 791e6, sizeLeft: 791e6, episodes: 1, problem: 'stalled', torrent: true }} d={d} instance="sonarr" title="Stuck Show" canFindBetter /></Admin>)
  assert.match(html, /stalled with no connections/); assert.match(html, /stuck/); assert.match(html, /aria-label="Actions for Stuck Show"/)
})

// ── the "⋯" menu ────────────────────────────────────────────────────────────────────────────────────────────────

const target = (o: Partial<FixTarget> = {}): FixTarget => ({ id: 's:1', title: 'Example Show', instance: 'sonarr', downloadIds: [`d:${H(1).toUpperCase()}`], problemIds: [], retryIds: [], torrentIds: [`d:${H(1).toUpperCase()}`], findable: `d:${H(1).toUpperCase()}`, done: false, ...o })

test('the menu offers Fix, Find better copy, Move to top and Remove, each only where it applies', () => {
  assert.deepEqual(menuPlan(target({ problemIds: ['x'] }), true, true), { clear: false, fix: true, better: true, top: true, remove: true })
  assert.deepEqual(menuPlan(target(), false, true), { clear: false, fix: false, better: true, top: true, remove: true }, 'nothing to fix: no Fix')
  assert.equal(menuPlan(target({ findable: null }), true, true).better, false, 'a show with many downloads has no single copy to search for')
  assert.equal(menuPlan(target(), true, false).top, false, 'moving up needs qBittorrent')
  assert.equal(menuPlan(target({ torrentIds: [] }), true, true).top, false, 'a usenet download has no queue position to move')
  assert.deepEqual(menuPlan(target({ done: true }), false, true), { clear: true, fix: false, better: true, top: true, remove: false }, 'a finished one is cleared, not removed')
  assert.equal(findableId({ downloadIds: ['d:ABC', 'd:DEF'] }), null); assert.equal(findableId({ downloadIds: ['i:12'] }), null); assert.equal(findableId({ downloadIds: ['d:ABC'] }), 'd:ABC')
})

// ── Advanced ────────────────────────────────────────────────────────────────────────────────────────────────────

test('Advanced names each count\'s unit: shows, downloads, queue rows and the client\'s torrents', () => {
  const html = renderToStaticMarkup(<ArrBehindNumbers data={queueData(plain([item()]))} v={{ kind: 'arrstack', pipeline: { indexersOn: 1, indexersTotal: 1, indexersFailing: 0, queued: 30, downloading: 15, stalled: 2, seeding: 0, importBlocked: 0, downBps: 1, upBps: 1 } } as any} />)
  assert.match(html, /Shows in the queue/); assert.match(html, /Downloads \(a season pack counts once\)/); assert.match(html, /Queue rows \(one per episode or album\)/); assert.match(html, /<td>30<\/td>/)
  assert.match(html, /Torrents downloading \(download client\)/); assert.match(html, /Counted as shows, films and artists/)
})

test('leftWord: sizes in plain units, nothing for nothing', () => {
  assert.equal(leftWord(1.9e9), '1.9 GB left'); assert.equal(leftWord(791e6), '791 MB left'); assert.equal(leftWord(0), ''); assert.equal(leftWord(40e9), '40.0 GB left')
})

// ── the page wiring ─────────────────────────────────────────────────────────────────────────────────────────────

test('the plug-in page: six tabs, Needs you first, the seven detail tables inside Advanced only, no second Live TV warning', () => {
  const page = fs.readFileSync(path.join(__dirname, '../app/plugins/[id]/page.tsx'), 'utf8')
  assert.match(page, /useState<ArrTab>\('needs'\)/)
  const adv = page.slice(page.indexOf("arrTab === 'advanced'"))
  assert.match(adv.slice(0, 900), /<DetailsSection count=\{tableCount\}>/)
  assert.ok(!/arrTab === 'queue'|arrTab === 'overview'|arrTab === 'sorting'/.test(page), 'the old tabs are gone')
  assert.equal((page.match(/<DetailsSection /g) ?? []).length, 2, 'once in Advanced, once for every other plug-in')
  const tv = fs.readFileSync(path.join(__dirname, '../components/plugins/arr/LiveTv.tsx'), 'utf8')
  assert.ok(!/marks as missing by Tunarr\.`/.test(tv) && !/c\.note\}>\{sync\.value === 1/.test(tv), 'the library-sync sentence is said once, as the warning')
})
