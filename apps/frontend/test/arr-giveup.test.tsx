// The Arr Stack's "give up after X tries" and "See what's available" pieces, rendered to HTML: a given-up item with
// its tries, reason and buttons (none for a viewer), a release card (the arr's pick, the swarm, the reasons, no
// download button for a program file), the hidden counts, the rule card and the preview. All titles are made up.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import "./css-stub"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { ItemCard, PreviewView, ReleaseCard, ReleaseList, RuleCard } from '../components/plugins/arr/GiveUp'
import { grabConfirm, hiddenWord, missingTarget, rowTarget, ruleWord, sizeWord, swarm, type AppStatus, type Release, type ReleaseAnswer, type Row } from '../components/plugins/arr/giveup-view'

const noop = () => {}
const NOW = Date.parse('2026-11-16T12:00:00Z')
const row = (o: Partial<Row> = {}): Row => ({
  key: 'radarr:7', app: 'radarr', keys: ['radarr:7'], title: 'Harbour Lights', detail: '1996', tries: 15, since: '2026-09-26T00:00:00Z',
  reason: { code: 'all-rejected', text: '20 releases found, every one rejected: Below your quality profile (12).' }, ...o,
})
const rel = (o: Partial<Release> = {}): Release => ({
  id: 'a'.repeat(24), title: 'Harbour.Lights.1996.1080p.BluRay.x265-GRP', quality: 'Bluray-1080p', resolution: 1080, source: 'BluRay', codec: 'HEVC',
  size: 5.1 * 1024 ** 3, protocol: 'torrent', seeders: 11, peers: 3, ageDays: 120, grabs: null, indexer: 'Indexer A', languages: ['English'],
  approved: true, topPick: true, reasons: [], executable: false, belowProfile: false, ...o,
})

test('the Missing panel ids map to item keys; a season row is searched as a season', () => {
  assert.equal(missingTarget('tv-12'), 'sonarr:12'); assert.equal(missingTarget('film-3'), 'radarr:3'); assert.equal(missingTarget('music-9'), 'lidarr:9')
  assert.equal(missingTarget('tv-12; x'), null)
  assert.equal(rowTarget(row()), 'radarr:7')
  assert.equal(rowTarget(row({ key: 'sonarr-season:11:2', app: 'sonarr', keys: ['sonarr:1', 'sonarr:2'], season: { number: 2, episodes: 2 } })), 'sonarr-season:11:2')
})

test('a given-up item: tries, since, reason and what was done; buttons only for an admin, no search for a removed film', () => {
  const r = row({ gaveUpAt: '2026-11-15T00:00:00Z', action: 'unmonitor' })
  const html = renderToStaticMarkup(<ItemCard r={r} canAct onTryAgain={noop} onLook={noop} now={NOW} />)
  assert.match(html, /Harbour Lights/); assert.match(html, /<b>15<\/b> tries/); assert.match(html, /every one rejected/)
  assert.match(html, /Stopped searching/); assert.match(html, /See what&#x27;s available/); assert.match(html, /Try again/)
  assert.match(html, /given up yesterday/)
  const viewer = renderToStaticMarkup(<ItemCard r={r} canAct={false} onTryAgain={noop} onLook={noop} now={NOW} />)
  assert.ok(!/<button/.test(viewer), 'a viewer sees the item and why, with no buttons')
  const removed = renderToStaticMarkup(<ItemCard r={{ ...r, action: 'remove' }} canAct onTryAgain={noop} onLook={noop} now={NOW} />)
  assert.match(removed, /Removed from the library/); assert.ok(!/See what/.test(removed))
})

test("a release card: the arr's pick, the swarm in words, rejections in plain English; never a download for a program file", () => {
  const html = renderToStaticMarkup(<ReleaseCard r={rel()} app="radarr" canGrab onGrab={noop} />)
  assert.match(html, /1080p/); assert.match(html, /BluRay · HEVC/); assert.match(html, /Radarr&#x27;s pick/); assert.match(html, /11 seeders · 3 peers/)
  assert.match(html, /5\.1 GB/); assert.match(html, /Download this/)
  const rej = renderToStaticMarkup(<ReleaseCard r={rel({ approved: false, topPick: false, quality: 'DVD', resolution: null, reasons: ['Below your quality profile (DVD)'] })} app="radarr" canGrab onGrab={noop} />)
  assert.match(rej, /Rejected/); assert.match(rej, /Below your quality profile \(DVD\)/); assert.match(rej, /Download this/, 'a rejected one can still be downloaded on purpose')
  const exe = renderToStaticMarkup(<ReleaseCard r={rel({ executable: true, topPick: false })} app="radarr" canGrab onGrab={noop} />)
  assert.match(exe, /program file/); assert.ok(!/Download this/.test(exe))
  const usenet = renderToStaticMarkup(<ReleaseCard r={rel({ protocol: 'usenet', seeders: null, peers: null, grabs: 40, ageDays: 900 })} app="sonarr" canGrab={false} onGrab={noop} />)
  assert.match(usenet, /900 days old, 40 grabs/); assert.ok(!/seeders/.test(usenet)); assert.ok(!/<button/.test(usenet))
})

test('the list says what was found and hidden; the 0-seed toggle shows its count', () => {
  const a: ReleaseAnswer = { rows: [rel()], found: 22, approved: 0, hidden: { av1: 1, threeD: 1, hfr: 0, zeroSeed: 4 }, top: ['Below your quality profile (12)'], target: 'radarr:7', label: 'Harbour Lights (1996)', searchedAt: new Date(NOW).toISOString(), reused: false, nextSearchAt: new Date(NOW + 600_000).toISOString() }
  const html = renderToStaticMarkup(<ReleaseList a={a} app="radarr" canGrab showZero={false} onToggleZero={noop} onGrab={noop} />)
  assert.match(html, /22 found, 0 acceptable to Radarr/); assert.match(html, /Most often rejected for: Below your quality profile \(12\)/)
  assert.match(html, /2 hidden: 1 AV1, 1 3D\. These are never offered\./)
  assert.match(html, /Show torrents with no seeders \(4 hidden\)/)
  assert.equal(hiddenWord({ av1: 0, threeD: 0, hfr: 0, zeroSeed: 3 }), null)
})

test('the confirm says when a release is below the profile, and that the profile is not changed when it was rejected', () => {
  const below = rel({ approved: false, belowProfile: true, belowNote: 'This is DVD; your profile wants 720p or better. Radarr will keep looking for a better copy and replace it when one appears.' })
  assert.match(grabConfirm(below, 'Harbour Lights (1996)', 'radarr'), /your profile wants 720p or better/)
  assert.match(grabConfirm(rel({ approved: false, reasons: ['Too few seeders (1; your indexer setting needs 5)'] }), 'X', 'radarr'), /rejected it \(Too few seeders.*nothing about your quality profile changes/)
})

test('the rule card: counts, the rule in words, the form only for an admin; TV cannot be removed', () => {
  const st: AppStatus = { app: 'sonarr', configured: true, settings: { enabled: false, tries: 14, minAgeDays: 30, ageFrom: 'released', action: 'unmonitor' }, tracking: 1129, givenUp: 0, soon: 0, observedAt: null, lastRun: null }
  const html = renderToStaticMarkup(<RuleCard st={st} canAct onPreview={noop} onOff={noop} />)
  assert.match(html, /<b>1129<\/b> counted/); assert.match(html, /After 14 tries and at least 30 days since it aired, stop searching/)
  assert.match(html, /Preview, then turn on/); assert.ok(!/remove from library/.test(html))
  const films = renderToStaticMarkup(<RuleCard st={{ ...st, app: 'radarr' }} canAct onPreview={noop} onOff={noop} />)
  assert.match(films, /remove from library/)
  const viewer = renderToStaticMarkup(<RuleCard st={st} canAct={false} onPreview={noop} onOff={noop} />)
  assert.ok(!/<input|<button/.test(viewer))
  assert.equal(ruleWord({ ...st.settings, action: 'remove' }, 'radarr'), 'After 14 tries and at least 30 days since it was released, remove it from the library (no files are deleted).')
})

test('the preview: the sentence, the reasons and the items', () => {
  const html = renderToStaticMarkup(<PreviewView p={{ previewId: 'x', app: 'sonarr', summary: 'This would give up on 3 TV episodes (1 series).', count: 3, series: 1,
    rows: [row({ key: 'sonarr-season:11:2', app: 'sonarr', title: 'Quiet Harbour', detail: 'Season 2 (3 episodes)', season: { number: 2, episodes: 3 } })],
    reasons: [{ code: 'nothing-usable', text: 'Nothing usable found', count: 3 }], tracking: 5, capped: false, observedAt: null }} />)
  assert.match(html, /This would give up on 3 TV episodes \(1 series\)\./); assert.match(html, /Season 2 \(3 episodes\)/); assert.match(html, /Nothing usable found/)
  assert.ok(!/<button/.test(html), 'items in a preview have no buttons')
  assert.equal(sizeWord(500 * 1024 ** 2), '500 MB'); assert.equal(swarm(0), 0); assert.equal(swarm(50), 1)
})
