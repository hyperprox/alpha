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
import { ChannelCard, ConfirmBox, LiveTvView } from '../components/plugins/arr/LiveTv'
import { confirmText, guideFill, guideWord, iconPath, versionWord, viewersWord, type LiveTv, type TvChannel } from '../components/plugins/arr/livetv-view'

const noop = () => {}
const CH = 'aaaaaaaa-1111-4111-8111-111111111111'
const ch = (o: Partial<TvChannel> = {}): TvChannel => ({
  id: CH, number: 4, name: 'Channel Four', hasIcon: true, programCount: 40,
  now: { title: 'Morning Show', at: '2026-11-20T10:00:00Z', until: '2026-11-20T11:00:00Z' }, next: { title: 'Late Film', at: '2026-11-20T11:00:00Z', until: '2026-11-20T13:00:00Z' },
  guideHours: 30, guideShort: false, canStream: true, problems: [], viewers: 0, sessions: [], ...o,
})
const tv = (o: Partial<LiveTv> = {}): LiveTv => ({
  configured: true, channels: [ch()], sources: [{ name: 'Library Server', type: 'plex', state: 'ok', why: null }],
  version: { installed: '2026.11.1', latest: '2026.11.2', behind: true, edge: false, ffmpeg: '7.1' }, warnings: [],
  summary: { channels: 1, viewers: 0, streaming: 0, guideShort: 0, cannotStream: 0, shortestGuideHours: 30 },
  actions: { refreshGuide: true, stopSession: true }, readAt: '2026-11-20T12:00:00Z', detail: true, ...o,
})

test('a channel card: number, icon through HyperProx, on now and next, programme count, guide hours', () => {
  const html = renderToStaticMarkup(<ChannelCard ch={ch()} canAct onAct={noop} />)
  assert.match(html, /Channel Four/); assert.match(html, /Channel 4/); assert.match(html, /src="\/api\/plugins\/arrstack\/tunarr\/icon\/aaaaaaaa-1111-4111-8111-111111111111"/)
  assert.match(html, /On now: <b>Morning Show<\/b>/); assert.match(html, /Next: Late Film/); assert.match(html, /40 programmes/); assert.match(html, /30 h of guide/)
  assert.match(html, /aria-valuenow="30"/); assert.match(html, /width:100%/); assert.match(html, /data-short="false"/); assert.ok(!/<button/.test(html))
  assert.ok(!/<img/.test(renderToStaticMarkup(<ChannelCard ch={ch({ hasIcon: false })} canAct onAct={noop} />)))
  assert.match(renderToStaticMarkup(<ChannelCard ch={ch({ programCount: 1, now: null, next: null })} canAct onAct={noop} />), /Nothing on right now.*1 programme</)
})

test('a short guide turns the bar warm and says how many hours', () => {
  const html = renderToStaticMarkup(<ChannelCard ch={ch({ guideHours: 6, guideShort: true })} canAct onAct={noop} />)
  assert.match(html, /data-short="true"/); assert.match(html, /width:25%/); assert.match(html, /6 h of guide/)
  assert.equal(guideFill(null), 0); assert.equal(guideFill(48), 1); assert.equal(guideWord(null), 'Guide length unknown'); assert.equal(guideWord(0), 'No guide published'); assert.equal(guideWord(60), '2 days 12 h of guide')
})

test('viewers: a count for everyone, addresses and players only when the API sent them (admins)', () => {
  const session = { state: 'started', viewers: 2, mode: 'hls', who: [{ ip: '198.51.100.7', agent: 'Example Player/1.0' }, { ip: '198.51.100.8', agent: '' }] }
  const adm = renderToStaticMarkup(<ChannelCard ch={ch({ viewers: 2, sessions: [session] })} canAct onAct={noop} />)
  assert.match(adm, /2 viewers/); assert.match(adm, /198\.51\.100\.7 · Example Player\/1\.0/); assert.match(adm, /data-live="true"/)
  const view = renderToStaticMarkup(<ChannelCard ch={ch({ viewers: 2, sessions: [{ ...session, who: [] }] })} canAct={false} onAct={noop} />)
  assert.match(view, /2 viewers/); assert.ok(!/198\.51\.100/.test(view)); assert.equal(viewersWord(0), 'Nobody watching'); assert.equal(viewersWord(1), '1 viewer')
})

test('a channel that cannot stream says why; a failed session offers Restart stream, only to an admin', () => {
  const bad = ch({ canStream: false, problems: ['Its stream session has failed (Tunarr marks it as an error).'], sessions: [{ state: 'error', viewers: 0, mode: 'hls', who: [] }] })
  const adm = renderToStaticMarkup(<ChannelCard ch={bad} canAct onAct={noop} />)
  assert.match(adm, /Cannot stream/); assert.match(adm, /stream session has failed/); assert.match(adm, />Restart stream</); assert.match(adm, /data-ok="false"/)
  assert.ok(!/<button/.test(renderToStaticMarkup(<ChannelCard ch={bad} canAct={false} onAct={noop} />)))
  const noSession = ch({ canStream: false, problems: ['It has no programming, so there is nothing to stream.'] })
  assert.ok(!/<button/.test(renderToStaticMarkup(<ChannelCard ch={noSession} canAct onAct={noop} />)), 'no fix where Tunarr offers none')
})

test('the tab: summary, version, media sources, warnings with their fix buttons, and the read-only note', () => {
  const t = tv({
    warnings: [{ level: 'warning', fix: 'refresh-guide', text: 'Channel 4 Channel Four has less than 24 hours of guide published (the shortest has 6 h).' },
      { level: 'error', text: 'Media source Library Server is not answering (unreachable). Channels that play from it cannot stream.' },
      { level: 'notice', text: 'Tunarr 2026.11.1 is behind the newest release, 2026.11.2.' }],
    sources: [{ name: 'Library Server', type: 'plex', state: 'down', why: 'unreachable' }],
    summary: { channels: 1, viewers: 0, streaming: 0, guideShort: 1, cannotStream: 0, shortestGuideHours: 6 },
  })
  const adm = renderToStaticMarkup(<LiveTvView tv={t} canAct onAct={noop} />)
  assert.match(adm, /Shortest guide 6 h/); assert.match(adm, /Tunarr 2026\.11\.1, newest is 2026\.11\.2/); assert.match(adm, /ffmpeg 7\.1/); assert.match(adm, /Library Server: not answering/)
  assert.match(adm, />Refresh guide</); assert.equal((adm.match(/>Refresh guide</g) ?? []).length, 1)
  assert.match(adm, /Refresh guide and Restart stream are the only changes/); assert.match(adm, /read-only here/)
  const view = renderToStaticMarkup(<LiveTvView tv={t} canAct={false} onAct={noop} />)
  assert.ok(!/<button/.test(view)); assert.match(view, /less than 24 hours/)
  // an old Tunarr with no guide task never gets a button that cannot work, and the note says so
  const old = renderToStaticMarkup(<LiveTvView tv={{ ...t, actions: { refreshGuide: false, stopSession: true } }} canAct onAct={noop} />)
  assert.ok(!/>Refresh guide</.test(old)); assert.match(old, /no guide task to run/)
})

test('all well, and no channels, say so in words', () => {
  assert.match(renderToStaticMarkup(<LiveTvView tv={tv()} canAct onAct={noop} />), /All well/)
  assert.match(renderToStaticMarkup(<LiveTvView tv={tv({ channels: [], summary: { channels: 0, viewers: 0, streaming: 0, guideShort: 0, cannotStream: 0, shortestGuideHours: null } })} canAct onAct={noop} />), /Tunarr has no channels yet/)
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
