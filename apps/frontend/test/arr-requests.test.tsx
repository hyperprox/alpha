// The Arr Stack's Requests tab rendered to HTML: a card per request with its poster, where it is now and who asked (a
// name for admins, "a family member" for everyone else), the buttons only an admin sees and only where they apply, the
// folder sorter's "sorted into", the problems with Seerr each with its fix button, and the confirmation words. All
// titles, names and folders are made up.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import "./css-stub"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfirmBox, HealthView, RequestCard, RequestsView } from '../components/plugins/arr/Requests'
import { ago, confirmText, firstGroup, kindWord, posterPath, reconnectLabel, rowsIn, staleWords, type Health, type Listing, type RequestRow } from '../components/plugins/arr/requests-view'
import { seerrNote } from '../components/catalogue/ArrPicker'

const NOW = Date.parse('2026-11-20T12:00:00Z')
const noop = () => {}
const row = (o: Partial<RequestRow> = {}): RequestRow => ({
  id: 1, kind: 'movie', title: 'Paper Lanterns', year: 2011, poster: 'pl1aaa.jpg', group: 'pending', where: 'Waiting for an admin to approve it.', progress: null,
  who: 'Robin', at: '2026-11-18T10:00:00Z', seasons: null, sortedInto: null, reason: null, is4k: false, ...o,
})
const listing = (rows: RequestRow[]): Listing => {
  const counts = { pending: 0, approved: 0, downloading: 0, available: 0, failed: 0, declined: 0 }
  for (const r of rows) counts[r.group]++
  return { configured: true, rows, counts, readAt: '2026-11-20T12:00:00Z', capped: false }
}

test('a waiting request: poster through HyperProx, who asked, Approve and Decline for an admin, nothing for a viewer', () => {
  const adm = renderToStaticMarkup(<RequestCard r={row()} canAct onAct={noop} now={NOW} />)
  assert.match(adm, /src="\/api\/plugins\/arrstack\/requests\/poster\/pl1aaa\.jpg"/); assert.match(adm, /Paper Lanterns/); assert.match(adm, /2011/)
  assert.match(adm, /Asked by Robin · 2 days ago/); assert.match(adm, />Approve</); assert.match(adm, />Decline</); assert.ok(!/Try again/.test(adm))
  const view = renderToStaticMarkup(<RequestCard r={row({ who: 'a family member' })} canAct={false} onAct={noop} now={NOW} />)
  assert.match(view, /Asked by a family member/); assert.ok(!/<button/.test(view)); assert.ok(!/Robin/.test(view))
})

test('a failed request offers Try again, only to an admin; approved, downloading and available offer nothing to do', () => {
  const failed = renderToStaticMarkup(<RequestCard r={row({ group: 'failed', where: 'Seerr could not send it to Radarr.' })} canAct onAct={noop} now={NOW} />)
  assert.match(failed, /Try again/); assert.ok(!/>Approve</.test(failed)); assert.match(failed, /data-group="failed"/)
  for (const g of ['approved', 'downloading', 'available', 'declined'] as const) assert.ok(!/<button/.test(renderToStaticMarkup(<RequestCard r={row({ group: g })} canAct onAct={noop} now={NOW} />)), g)
})

test('downloading shows a progress bar; available shows where the folder sorter put it; declined shows the reason', () => {
  const dl = renderToStaticMarkup(<RequestCard r={row({ group: 'downloading', progress: 0.75, where: 'Downloading, 75% done.' })} canAct onAct={noop} now={NOW} />)
  assert.match(dl, /role="progressbar"[^>]*aria-valuenow="75"/); assert.match(dl, /width:75%/)
  const done = renderToStaticMarkup(<RequestCard r={row({ group: 'available', where: 'In the library, ready to watch.', sortedInto: 'Scary Films' })} canAct onAct={noop} now={NOW} />)
  assert.match(done, /Sorted into Scary Films/)
  assert.match(renderToStaticMarkup(<RequestCard r={row({ group: 'declined', where: 'Declined.', reason: 'Already on a disc' })} canAct onAct={noop} now={NOW} />), /Reason: Already on a disc/)
  assert.ok(!/Sorted into/.test(dl))
})

test('a poster that is not a plain file name is never put in a page; a show says how many seasons', () => {
  assert.equal(posterPath(row({ poster: '../x.jpg' })), null); assert.equal(posterPath(row({ poster: null })), null)
  assert.ok(!/<img/.test(renderToStaticMarkup(<RequestCard r={row({ poster: 'http://x.example/a.jpg' })} canAct onAct={noop} now={NOW} />)))
  assert.equal(kindWord({ kind: 'tv', seasons: 2 }), 'Show, 2 seasons'); assert.equal(kindWord({ kind: 'tv', seasons: 1 }), 'Show, 1 season'); assert.equal(kindWord({ kind: 'movie', seasons: null }), 'Film')
})

test('the group buttons carry counts; the shown group filters; an empty tab says so in words', () => {
  const l = listing([row({ id: 1 }), row({ id: 2, group: 'failed' }), row({ id: 3, group: 'failed' }), row({ id: 4, group: 'available' })])
  const html = renderToStaticMarkup(<RequestsView l={l} group="failed" onGroup={noop} canAct onAct={noop} now={NOW} />)
  assert.match(html, /Waiting <b>1<\/b>/); assert.match(html, /Failed <b>2<\/b>/); assert.match(html, /Available <b>1<\/b>/); assert.ok(!/Approved <b>/.test(html), 'a group with none has no button')
  assert.equal((html.match(/<li class="card"/g) ?? []).length, 2)
  assert.match(renderToStaticMarkup(<RequestsView l={listing([])} group="all" onGroup={noop} canAct onAct={noop} />), /Nobody has asked for anything yet/)
  assert.match(renderToStaticMarkup(<RequestsView l={l} group="approved" onGroup={noop} canAct onAct={noop} />), /Nothing here right now/)
  assert.equal(rowsIn(l.rows, 'all').length, 4); assert.equal(firstGroup(l.counts), 'pending'); assert.equal(firstGroup(listing([row({ group: 'failed' })]).counts), 'failed'); assert.equal(firstGroup(listing([row({ group: 'available' })]).counts), 'all')
})

test('problems with Seerr: a reconnect button each and "Fix Seerr\'s settings", for admins only; all well says so', () => {
  const h: Health = {
    configured: true, readAt: '2026-11-20T12:00:00Z',
    problems: [{ kind: 'radarr', serverId: 0, why: 'key', text: 'Seerr cannot sign in to Radarr: the key or sign-in it holds was refused.' }, { kind: 'media', why: 'down', text: 'Seerr cannot reach Plex. Requests cannot be sent or checked until it can.' }],
    stale: [{ app: 'radarr', serverId: 0, name: 'Radarr', nowProfile: 'HD-1080p', nowFolder: '/old/films', profileStale: true, folderStale: true, wantProfileId: 4, wantProfile: 'HD-1080p', wantFolder: '/library/films' }],
  }
  const adm = renderToStaticMarkup(<HealthView h={h} canAct onAct={noop} />)
  assert.match(adm, /Reconnect Radarr/); assert.match(adm, /Reconnect the media server/); assert.match(adm, /Fix Seerr&#x27;s settings/)
  assert.match(adm, /still points at the quality profile &quot;HD-1080p&quot;, which Radarr no longer has, so it would use &quot;HD-1080p&quot; and the folder \/old\/films, which is gone, so it would use \/library\/films/)
  assert.equal((adm.match(/<button/g) ?? []).length, 3)
  const view = renderToStaticMarkup(<HealthView h={{ ...h, stale: [] }} canAct={false} onAct={noop} />)
  assert.match(view, /cannot sign in to Radarr/); assert.ok(!/<button/.test(view))
  assert.match(renderToStaticMarkup(<HealthView h={{ ...h, problems: [], stale: [] }} canAct onAct={noop} />), /All well/)
  assert.equal(reconnectLabel('sonarr'), 'Reconnect Sonarr')
  assert.match(staleWords({ ...h.stale[0], folderStale: false, wantFolder: null }), /^Seerr's Radarr still points at the quality profile "HD-1080p"/)
})

test('the confirmation says what will happen, names the title, and a decline asks for an optional reason', () => {
  assert.equal(confirmText({ action: 'approve', id: 1 }, 'Paper Lanterns'), 'Approve "Paper Lanterns"? Seerr sends it to Radarr or Sonarr to download.')
  assert.equal(confirmText({ action: 'decline', id: 1, reason: 'x' }, 'Paper Lanterns'), 'Decline "Paper Lanterns" with your reason? It will not be downloaded.')
  assert.equal(confirmText({ action: 'retry', id: 1 }, 'Paper Lanterns'), 'Send "Paper Lanterns" to Radarr or Sonarr again?')
  assert.match(confirmText({ action: 'reconnect', target: 'sonarr' }), /Sonarr key HyperProx has saved back into Seerr/)
  assert.match(confirmText({ action: 'fix-settings' }), /Only Seerr's own settings change/)
  const box = renderToStaticMarkup(<ConfirmBox text="Decline?" yes="Decline" onYes={noop} onNo={noop} reason={{ value: '', onChange: noop }} />)
  assert.match(box, /role="alertdialog"/); assert.match(box, /aria-label="Reason \(optional\)"/); assert.match(box, />Decline</); assert.match(box, />Cancel</)
  assert.ok(!/aria-label="Reason/.test(renderToStaticMarkup(<ConfirmBox text="Approve?" yes="Approve" onYes={noop} onNo={noop} />)))
  assert.equal(ago('2026-11-20T08:00:00Z', NOW), 'today'); assert.equal(ago('2026-11-19T08:00:00Z', NOW), 'yesterday'); assert.equal(ago('2026-10-01T08:00:00Z', NOW), '7 weeks ago'); assert.equal(ago('2026-08-01T08:00:00Z', NOW), '4 months ago')
})

test('the picker says which media server Seerr signs in with, and what is missing, in plain words', () => {
  assert.match(seerrNote({ mediaServer: { kind: 'plex', url: 'x' }, mediaServers: { plex: true, jellyfin: false, jellyfinLogin: false } }), /Plex server HyperProx knows/)
  assert.match(seerrNote({ mediaServer: { kind: 'plex', url: 'x' }, mediaServers: { plex: true, jellyfin: true, jellyfinLogin: true } }, 'jellyfin'), /Jellyfin server HyperProx knows/)
  assert.match(seerrNote({ mediaServer: { kind: 'jellyfin', url: 'x' }, mediaServers: { plex: false, jellyfin: true, jellyfinLogin: false } }), /not an administrator sign-in.*not started/)
  assert.match(seerrNote({ mediaServer: null }), /no Plex or Jellyfin server yet/)
  assert.match(seerrNote({ mediaServer: { kind: 'plex', url: 'x' } }), /Plex server/, 'an older API answer without the list')
})

test('phone first: the cards are a wrapping grid in theme colours, with no table and no fixed colours', () => {
  const css = fs.readFileSync(path.join(__dirname, '../components/plugins/arr/requests.module.css'), 'utf8')
  assert.match(css, /auto-fill, minmax\(min\(100%, 340px\), 1fr\)/); assert.match(css, /flex-wrap: wrap/)
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'colours are theme variables'); assert.ok(!/min-width: \d{3,}px/.test(css))
  const tsx = fs.readFileSync(path.join(__dirname, '../components/plugins/arr/Requests.tsx'), 'utf8')
  assert.ok(!/<table/.test(tsx)); assert.ok(!/seerr_key|X-Api-Key|192\.168/.test(tsx))
})
