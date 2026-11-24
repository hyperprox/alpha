// The Arr Stack's Live TV tab rendered to HTML: a card per channel with what is on now and next, the guide bar and its
// warning under 24 hours, viewers (addresses for admins only), the problems each with the fix button only an admin sees
// and only where it applies, the confirmation words, and the tab's honest "read-only elsewhere" note. All names and
// addresses are made up.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import "./css-stub"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChannelRow, ConfirmBox, LiveTvView } from '../components/plugins/arr/LiveTv'
import { confirmText, filterChannels, groupChannels, guideDiffers, leftWord, needsAttention, pollDue, guideWord, iconPath, programText, progressOf, syncedWord, typicalGuideHours, versionWord, viewersWord, type LiveTv, type TvChannel } from '../components/plugins/arr/livetv-view'

const noop = () => {}
const CH = 'aaaaaaaa-1111-4111-8111-111111111111'
const NOW_MS = Date.parse('2026-11-20T10:30:00Z')
const ch = (o: Partial<TvChannel> = {}): TvChannel => ({
  id: CH, number: 4, name: 'Channel Four', hasIcon: true, programCount: 40,
  now: { title: 'Example Heroes', episode: 'Frozen Heart', code: 'S2E20', kind: 'episode', at: '2026-11-20T10:00:00Z', until: '2026-11-20T11:00:00Z' },
  next: { title: 'Late Film', episode: null, code: null, kind: 'movie', at: '2026-11-20T11:00:00Z', until: '2026-11-20T13:00:00Z' },
  guideHours: 30, guideShort: false, group: null, ready: { programmes: 10, synced: 10, pct: 100 }, canStream: true, problems: [], viewers: 0, sessions: [], ...o,
})
const tv = (o: Partial<LiveTv> = {}): LiveTv => ({
  configured: true, channels: [ch()], sources: [{ name: 'Library Server', type: 'plex', state: 'ok', why: null }],
  version: { installed: '2026.11.1', latest: '2026.11.2', behind: true, edge: false, ffmpeg: '7.1' }, warnings: [],
  summary: { channels: 1, viewers: 0, streaming: 0, guideShort: 0, cannotStream: 0, shortestGuideHours: 30, synced: 1, unsynced: 0, unsyncedProgrammes: 0, notRescanning: 0 },
  actions: { refreshGuide: true, stopSession: true }, readAt: '2026-11-20T12:00:00Z', detail: true, ...o,
})

const row = (c: TvChannel, canAct = true, typical: number | null = 30) => renderToStaticMarkup(<ChannelRow ch={c} canAct={canAct} onAct={noop} nowMs={NOW_MS} typical={typical} />)

test('a channel row: number, icon through HyperProx, show and episode, progress, what is next; no repeated chips', () => {
  const html = row(ch())
  assert.match(html, /Channel Four/); assert.match(html, />4<\/b>/); assert.match(html, /src="\/api\/plugins\/arrstack\/tunarr\/icon\/aaaaaaaa-1111-4111-8111-111111111111"/)
  assert.match(html, /<b>Example Heroes<\/b> — Frozen Heart/); assert.match(html, /S2E20/); assert.match(html, /Late Film/); assert.match(html, /30 min left/)
  assert.match(html, /aria-valuenow="50"/); assert.match(html, /width:50%/); assert.ok(!/Untitled/.test(html))
  // nothing differs, so no chips at all: not the guide hours, not the programme count, not "nobody watching"
  assert.ok(!/of guide/.test(html)); assert.ok(!/programme/.test(html)); assert.ok(!/Nobody/.test(html)); assert.ok(!/<button/.test(html)); assert.ok(!/class="[^"]*chips/.test(html))
  assert.ok(!/<img/.test(row(ch({ hasIcon: false }))), 'no icon from Tunarr: the letter stands in')
  assert.match(row(ch({ hasIcon: false })), />C<\/span>/)
  assert.match(row(ch({ now: null, next: null })), /Nothing on right now/)
  assert.match(row(ch({ now: { ...ch().now!, kind: 'break', title: 'Break', episode: null, code: null } })), /Between programmes/)
})

test('a channel whose guide differs, or is short, gets its own chip; the rest say it once at the top', () => {
  assert.match(row(ch({ guideHours: 6, guideShort: true })), /6 h of guide/)
  assert.match(row(ch({ guideHours: 12 })), /12 h of guide/)
  assert.ok(!/of guide/.test(row(ch({ guideHours: 31 }))))
  assert.equal(guideDiffers(ch({ guideHours: 6, guideShort: true }), 30), true); assert.equal(guideDiffers(ch(), 30), false)
  assert.equal(typicalGuideHours([ch({ guideHours: 46.3 }), ch({ guideHours: 46.4 }), ch({ guideHours: 10 })]), 46)
  assert.equal(typicalGuideHours([ch({ guideHours: null })]), null)
  assert.equal(guideWord(null), 'Guide length unknown'); assert.equal(guideWord(0), 'No guide published'); assert.equal(guideWord(60), '2 days 12 h of guide')
})

test('programmes Tunarr marks missing say how much, and count as needing attention', () => {
  const c = ch({ ready: { programmes: 12, synced: 3, pct: 25 } })
  assert.match(row(c), /25% present/); assert.equal(needsAttention(c), true); assert.equal(needsAttention(ch()), false)
  assert.ok(!/present/.test(row(ch())))
  assert.equal(needsAttention(ch({ ready: null })), false, 'no reading, no claim')
})

test('progress and words: through the programme, time left, show and episode', () => {
  const p = ch().now!
  assert.equal(progressOf(p, NOW_MS), 0.5); assert.equal(progressOf(p, Date.parse('2026-11-20T09:00:00Z')), 0); assert.equal(progressOf(p, Date.parse('2026-11-20T12:00:00Z')), 1); assert.equal(progressOf(null, NOW_MS), 0)
  assert.equal(leftWord(p, NOW_MS), '30 min left'); assert.equal(leftWord({ ...p, until: '2026-11-20T11:35:00Z' }, NOW_MS), '1 h 5 min left')
  assert.equal(programText(p), 'Example Heroes — Frozen Heart'); assert.equal(programText(ch().next!), 'Late Film')
})

test('groups: Tunarr\'s own groups when there are several, else bands of ten by number; search and filters narrow them', () => {
  const many = [1, 2, 9, 10, 19, 40].map(n => ch({ id: `aaaaaaaa-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, number: n, name: `Chan ${n}` }))
  assert.deepEqual(groupChannels(many).map(g => [g.label, g.channels.length]), [['Channels 1\u20139', 3], ['Channels 10\u201319', 2], ['Channels 40\u201349', 1]])
  assert.deepEqual(groupChannels([ch({ group: 'Kids', number: 1 }), ch({ group: 'Movies', number: 2 }), ch({ group: 'Kids', number: 3 })]).map(g => [g.label, g.channels.length]), [['Kids', 2], ['Movies', 1]])
  assert.deepEqual(groupChannels([ch({ group: 'Same', number: 1 }), ch({ group: 'Same', number: 2 })]).map(g => g.label), ['Channels 1\u20139'], 'one shared group says nothing: bands instead')
  assert.deepEqual(filterChannels(many, 'chan 19', 'all').map(c => c.number), [19])
  assert.deepEqual(filterChannels(many, 'frozen heart', 'all').length, 6, 'matches what is on')
  assert.deepEqual(filterChannels(many, 'zzz', 'all'), [])
  const mix = [ch({ number: 1 }), ch({ number: 2, viewers: 1 }), ch({ number: 3, guideHours: 5, guideShort: true })]
  assert.deepEqual(filterChannels(mix, '', 'watching').map(c => c.number), [2]); assert.deepEqual(filterChannels(mix, '', 'attention').map(c => c.number), [3])
})

test('viewers: a count for everyone, addresses and players only when the API sent them (admins)', () => {
  const session = { state: 'started', viewers: 2, mode: 'hls', who: [{ ip: '198.51.100.7', agent: 'Example Player/1.0' }, { ip: '198.51.100.8', agent: '' }] }
  const adm = row(ch({ viewers: 2, sessions: [session] }))
  assert.match(adm, /2 viewers/); assert.match(adm, /198\.51\.100\.7 · Example Player\/1\.0/); assert.match(adm, /data-live="true"/)
  const view = row(ch({ viewers: 2, sessions: [{ ...session, who: [] }] }), false)
  assert.match(view, /2 viewers/); assert.ok(!/198\.51\.100/.test(view)); assert.equal(viewersWord(0), 'Nobody watching'); assert.equal(viewersWord(1), '1 viewer')
})

test('a channel that cannot stream says why; a failed session offers Restart stream, only to an admin', () => {
  const bad = ch({ canStream: false, problems: ['Its stream session has failed (Tunarr marks it as an error).'], sessions: [{ state: 'error', viewers: 0, mode: 'hls', who: [] }] })
  const adm = renderToStaticMarkup(<ChannelRow ch={bad} canAct onAct={noop} nowMs={NOW_MS} typical={30} />)
  assert.match(adm, /Cannot stream/); assert.match(adm, /stream session has failed/); assert.match(adm, />Restart stream</); assert.match(adm, /data-ok="false"/)
  assert.ok(!/<button/.test(row(bad, false)))
  const noSession = ch({ canStream: false, problems: ['It has no programming, so there is nothing to stream.'] })
  assert.ok(!/<button/.test(row(noSession)), 'no fix where Tunarr offers none')
})

test('the tab: summary, version, media sources, warnings with their fix buttons, and the read-only note', () => {
  const t = tv({
    warnings: [{ level: 'warning', fix: 'refresh-guide', text: 'Channel 4 Channel Four has less than 24 hours of guide published (the shortest has 6 h).' },
      { level: 'error', text: 'Media source Library Server is not answering (unreachable). Channels that play from it cannot stream.' },
      { level: 'notice', text: 'Tunarr 2026.11.1 is behind the newest release, 2026.11.2.' }],
    sources: [{ name: 'Library Server', type: 'plex', state: 'down', why: 'unreachable' }],
    summary: { channels: 1, viewers: 0, streaming: 0, guideShort: 1, cannotStream: 0, shortestGuideHours: 6, synced: 1, unsynced: 0, unsyncedProgrammes: 0, notRescanning: 0 },
  })
  const adm = renderToStaticMarkup(<LiveTvView tv={t} canAct onAct={noop} nowMs={NOW_MS} />)
  assert.match(adm, /Shortest guide 6 h/); assert.match(adm, /Tunarr 2026\.11\.1, newest is 2026\.11\.2/); assert.match(adm, /FFmpeg 7\.1/); assert.match(adm, /Library Server: not answering/)
  assert.match(adm, />Refresh guide</); assert.equal((adm.match(/>Refresh guide</g) ?? []).length, 1)
  assert.match(adm, /Refresh guide and Restart stream are the only changes/); assert.match(adm, /read-only here/)
  const view = renderToStaticMarkup(<LiveTvView tv={t} canAct={false} onAct={noop} />)
  assert.ok(!/>Refresh guide</.test(view) && !/>Restart stream</.test(view)); assert.match(view, /less than 24 hours/)
  // an old Tunarr with no guide task never gets a button that cannot work, and the note says so
  const old = renderToStaticMarkup(<LiveTvView tv={{ ...t, actions: { refreshGuide: false, stopSession: true } }} canAct onAct={noop} />)
  assert.ok(!/>Refresh guide</.test(old)); assert.match(old, /no guide task to run/)
})

test('all well, and no channels, say so in words', () => {
  assert.match(renderToStaticMarkup(<LiveTvView tv={tv()} canAct onAct={noop} />), /All well/)
  assert.match(renderToStaticMarkup(<LiveTvView tv={tv({ channels: [], summary: { channels: 0, viewers: 0, streaming: 0, guideShort: 0, cannotStream: 0, shortestGuideHours: null, synced: 0, unsynced: 0, unsyncedProgrammes: 0, notRescanning: 0 } })} canAct onAct={noop} />), /Tunarr has no channels yet/)
})

test('words: versions, icon paths, and the confirmations match the server\'s sentences', () => {
  assert.equal(versionWord({ installed: '2026.11.2', latest: '2026.11.2', behind: false, edge: false, ffmpeg: null }), '2026.11.2, up to date')
  assert.equal(versionWord({ installed: null, latest: null, behind: null, edge: false, ffmpeg: null }), 'Version unknown')
  assert.equal(iconPath({ id: '../x', hasIcon: true }), null); assert.equal(iconPath({ id: CH, hasIcon: false }), null)
  assert.equal(confirmText({ action: 'refresh-guide' }), 'Rebuild Tunarr\'s TV guide now? Tunarr re-reads every channel\'s schedule in the background and rewrites its guide file. Nothing is deleted.')
  assert.equal(confirmText({ action: 'stop-session', channelId: CH }, '4 Channel Four'), 'Stop the stream on channel 4 Channel Four? Tunarr ends its ffmpeg, so anyone watching it is cut off until their player reconnects. Nothing is deleted.')
  const box = renderToStaticMarkup(<ConfirmBox text="Sure?" yes="Do it" onYes={noop} onNo={noop} />)
  assert.match(box, /role="alertdialog"/); assert.match(box, />Do it</); assert.match(box, />Cancel</)
})

test('no address or key of Tunarr is in the tab\'s source', () => {
  const dir = path.join(__dirname, '..', 'components', 'plugins', 'arr')
  const src = ['LiveTv.tsx', 'livetv-view.ts'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
  assert.doesNotMatch(src, /tunarr_url|192\.168\.|https?:\/\/(?!github)/)
})

test('polling: a tick is skipped while the tab is hidden or the last reading is still running, and the tab guards its load with one flag', () => {
  assert.equal(pollDue(false, false), true); assert.equal(pollDue(true, false), false); assert.equal(pollDue(false, true), false); assert.equal(pollDue(true, true), false)
  const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'plugins', 'arr', 'LiveTv.tsx'), 'utf8')
  assert.match(src, /if \(loading\.current\) return/); assert.match(src, /finally \{ loading\.current = false \}/); assert.match(src, /pollDue\(document\.hidden, loading\.current\)/)
})

test('the top: sync ring and one sentence; FFmpeg is short; the guide length is said once; no "can stream" claim', () => {
  const bad = tv({
    channels: [ch(), ch({ id: 'bbbbbbbb-2222-4222-8222-222222222222', number: 5, ready: { programmes: 10, synced: 4, pct: 40 } })],
    summary: { channels: 2, viewers: 0, streaming: 0, guideShort: 0, cannotStream: 0, shortestGuideHours: 46.3, synced: 1, unsynced: 1, unsyncedProgrammes: 6, notRescanning: 2 },
    version: { installed: '2026.11.2', latest: '2026.11.2', behind: false, edge: false, ffmpeg: '7.1' },
  })
  const html = renderToStaticMarkup(<LiveTvView tv={bad} canAct onAct={noop} nowMs={NOW_MS} />)
  assert.match(html, />1\/2</); assert.match(html, /Present/); assert.ok(!/Can stream|CAN STREAM/i.test(html))
  assert.ok(!/marks as missing/.test(html), 'the library-sync sentence belongs to the warning alone, never to the summary as well')
  const warned = renderToStaticMarkup(<LiveTvView tv={{ ...bad, warnings: [{ level: 'warning', text: '1 channel has programmes that Tunarr marks as missing from their library (6 in the next 48 h of guide), so they may not play.' }] }} canAct onAct={noop} nowMs={NOW_MS} />)
  assert.equal((warned.match(/marks as missing/g) ?? []).length, 1, 'said once')
  assert.match(html, /2 libraries are not rescanning in Tunarr\. That does not stop their programmes playing/)
  assert.match(html, /FFmpeg 7\.1/); assert.ok(!/N7\.1-214/i.test(html)); assert.match(html, /Guide 46\.3 h or more/)
  assert.equal((html.match(/of guide/g) ?? []).length, 0, 'not repeated on every row')
  assert.equal(syncedWord(tv({ channels: [ch({ ready: null })] })), null)
  // an older Tunarr that gives nothing to judge by falls back to "playable"
  assert.match(renderToStaticMarkup(<LiveTvView tv={tv({ channels: [ch({ ready: null })] })} canAct onAct={noop} nowMs={NOW_MS} />), /Playable/)
})

test('a long list is grouped and collapsed: only groups to look at are open; a short list is all open; search and filters are there', () => {
  const many = Array.from({ length: 30 }, (_, i) => ch({ id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, number: i + 1, name: `Chan ${i + 1}`, ...(i === 24 ? { guideHours: 5, guideShort: true } : {}) }))
  const html = renderToStaticMarkup(<LiveTvView tv={tv({ channels: many, summary: { ...tv().summary, channels: 30, synced: 30, notRescanning: 0 } })} canAct onAct={noop} nowMs={NOW_MS} />)
  const opens = [...html.matchAll(/<details([^>]*)><summary[^>]*><span>(Channels [^<]*)</g)].map(m => [m[2], /\sopen=""/.test(m[1])])
  assert.deepEqual(opens, [['Channels 1\u20139', true], ['Channels 10\u201319', false], ['Channels 20\u201329', true], ['Channels 30\u201339', false]])
  assert.match(html, /1 to check/); assert.match(html, /type="search"/); assert.match(html, /aria-pressed="true"[^>]*>All 30/); assert.match(html, /Needs attention 1/); assert.match(html, /Watching 0/)
  const short = renderToStaticMarkup(<LiveTvView tv={tv({ channels: many.slice(0, 10) })} canAct onAct={noop} nowMs={NOW_MS} />)
  assert.ok(/<details[^>]* open=""/.test(short))
})

test('the Arr header and tab bar park under the top bar and scroll sideways instead of wrapping', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'components', 'plugins', 'arr', 'arrux.module.css'), 'utf8')
  assert.match(css, /\.head \{ position: sticky; top: var\(--hx-top-h, 0px\)/); assert.match(css, /\.tabs \{ display: flex;[^}]*overflow-x: auto/)
  const page = fs.readFileSync(path.join(__dirname, '..', 'app', 'plugins', '[id]', 'page.tsx'), 'utf8')
  assert.match(page, /<div className="overflow-x-clip">/, 'a clipping (not scrolling) wrapper, or the header cannot stick')
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'components', 'layout', 'TopBar.tsx'), 'utf8'), /--hx-top-h/)
})
