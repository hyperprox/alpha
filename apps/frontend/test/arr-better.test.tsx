// The Arr Stack's "Find a better copy" and VPN pieces, rendered to HTML: a release card per verdict (the profile takes
// it, only the slow download objects, refused with its reason and no button), the slow flag, what was left out, the
// confirm wording, and the VPN panel (tunnel, ports side by side, the address hidden from viewers, a fix button per
// problem for admins only). All titles and addresses are made up.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import "./css-stub"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { BetterCard, BetterList, FoundRow } from '../components/plugins/arr/BetterCopy'
import { VpnView } from '../components/plugins/arr/Vpn'
import { betterConfirm, betterHidden, fixConfirm, portWord, queueTarget, type BetterAnswer, type BetterRelease, type VpnStatus } from '../components/plugins/arr/better-view'

const noop = () => {}
const rel = (o: Partial<BetterRelease> = {}): BetterRelease => ({
  id: 'a'.repeat(24), title: 'Paper.Lanterns.2011.1080p.BluRay.x265-GRPA', quality: 'Bluray-1080p', resolution: 1080, source: 'BluRay', codec: 'HEVC',
  size: 5.1 * 1024 ** 3, protocol: 'torrent', seeders: 42, peers: 3, ageDays: 40, grabs: null, indexer: 'Indexer A', languages: ['English'],
  approved: true, reasons: [], slow: false, verdict: 'ok', ...o,
})
const answer = (o: Partial<BetterAnswer> = {}): BetterAnswer => ({
  rows: [rel()], found: 10, accepted: 2, hidden: { av1: 1, threeD: 1, hfr: 0, zeroSeed: 1, executable: 1 },
  target: 'radarr:7', label: 'Paper Lanterns (2011)', have: 'WEBDL-1080p', swap: null,
  searchedAt: '2026-11-16T12:00:00Z', reused: false, nextSearchAt: '2026-11-16T12:10:00Z', ...o,
})
const vpn = (o: Partial<VpnStatus> = {}): VpnStatus => ({
  present: true, guest: 'arr-stack', tunnel: 'up', health: 'healthy', provider: 'example vpn', vpnType: 'WireGuard', location: 'Amsterdam, North Holland, Netherlands',
  chosen: 'Netherlands', publicIp: '198.51.100.23', portForwarding: true, forwardedPort: 40123, listenPort: 40123, portMatch: 'ok',
  downBps: 10_625_762, upBps: 1_722_791, connection: 'connected', startedAt: '2026-11-14T17:33:21Z', uptimeSec: 152_000, problems: [], readAt: '2026-11-16T12:00:00Z', ...o,
})

test('a release the profile takes: the quality big, the swarm, one button', () => {
  const html = renderToStaticMarkup(<BetterCard r={rel()} canGrab onGrab={noop} />)
  assert.match(html, /1080p/); assert.match(html, /BluRay · HEVC/); assert.match(html, /Your profile accepts it/); assert.match(html, /42 seeders · 3 peers/)
  assert.match(html, /Get this one/); assert.ok(!/Slow/.test(html))
  const slow = renderToStaticMarkup(<BetterCard r={rel({ seeders: 2, slow: true })} canGrab onGrab={noop} />)
  assert.match(slow, /Slow: 2 seeds/)
})

test('refused: its reason, and no button; only-the-slow-one: "Grab anyway"; a viewer sees no button at all', () => {
  const refused = renderToStaticMarkup(<BetterCard r={rel({ approved: false, verdict: 'refused', why: 'Radarr refuses it: Too small for its quality (likely a poor copy).' })} canGrab onGrab={noop} />)
  assert.match(refused, /Refused/); assert.match(refused, /Too small for its quality/); assert.ok(!/<button/.test(refused))
  const anyway = renderToStaticMarkup(<BetterCard r={rel({ approved: false, verdict: 'anyway', why: 'Only refused because the slow download is still in the queue; swapping it out resolves that.' })} canGrab onGrab={noop} />)
  assert.match(anyway, /Grab anyway/); assert.match(anyway, /Only refused because of the slow one/)
  assert.ok(!/<button/.test(renderToStaticMarkup(<BetterCard r={rel()} canGrab={false} onGrab={noop} />)))
})

test('the list: what you have, what was found, what was left out, and that nothing is deleted', () => {
  const html = renderToStaticMarkup(<BetterList a={answer()} app="radarr" canGrab onGrab={noop} />)
  assert.match(html, /You have/); assert.match(html, /WEBDL-1080p/)
  assert.match(html, /10 found, 2 your profile accepts/)
  assert.match(html, /4 left out: 1 AV1, 1 3D, 1 with a program file, 1 with no seeders\. These are never offered\./)
  assert.match(html, /No file in your library is deleted/)
  const swap = renderToStaticMarkup(<BetterList a={answer({ swap: { name: 'Paper.Lanterns.2011.1080p.WEB-DL-SLOW' } })} app="radarr" canGrab onGrab={noop} />)
  assert.match(swap, /Replacing/); assert.match(swap, /WEB-DL-SLOW/)
  assert.equal(betterHidden({ av1: 0, threeD: 0, hfr: 0, zeroSeed: 0, executable: 0 }), null)
})

test('the confirm says what happens: the top of the queue, the swap, grab anyway, what stays, slow', () => {
  const t = betterConfirm(rel({ verdict: 'anyway', slow: true, seeders: 2 }), { label: 'Paper Lanterns (2011)', have: 'WEBDL-1080p', swap: { name: 'Old.Slow.Copy' } }, 'radarr')
  assert.match(t, /move it to the top of qBittorrent's queue/)
  assert.match(t, /the slow download \(Old\.Slow\.Copy\) is removed and blocklisted/)
  assert.match(t, /Radarr only objects because the slow download is still queued; this grabs it anyway/)
  assert.match(t, /What you have now \(WEBDL-1080p\) stays until Radarr imports the new copy/)
  assert.match(t, /few seeders/)
  assert.doesNotMatch(betterConfirm(rel(), { label: 'x', have: null, swap: null }, 'sonarr'), /removed|anyway|stays|few seeders/)
})

test('queue downloads are searched by their download id only', () => {
  assert.equal(queueTarget('radarr', `d:${'a'.repeat(40)}`), `queue:radarr:d:${'a'.repeat(40)}`)
  assert.equal(queueTarget('radarr', 'i:12'), null); assert.equal(queueTarget('sonarr', 'n:0'), null)
})

test('a found item: what is on disk and the button', () => {
  const html = renderToStaticMarkup(<FoundRow f={{ target: 'radarr:7', title: 'Paper Lanterns', detail: '2011', have: 'WEBDL-1080p' }} onPick={noop} />)
  assert.match(html, /Paper Lanterns/); assert.match(html, /2011 · WEBDL-1080p/); assert.match(html, /Find a better copy/)
})

test('the VPN panel: where it comes out, the ports side by side, speeds and uptime', () => {
  const html = renderToStaticMarkup(<VpnView v={vpn()} canAct onFix={noop} />)
  assert.match(html, /Amsterdam, North Holland, Netherlands/); assert.match(html, /Tunnel up/); assert.match(html, /Public address 198\.51\.100\.23/)
  assert.match(html, /VPN forwards<\/span><b>40123/); assert.match(html, /qBittorrent listens<\/span><b>40123/)
  assert.match(html, /data-match="ok"/); assert.match(html, /10\.1 MB\/s/); assert.match(html, /1\.8d/)
  assert.ok(!/<button/.test(html), 'no problem, no button')
})

test('a viewer sees "hidden" for the address; problems carry their fix for an admin only', () => {
  const v = vpn({ publicIp: null, publicIpHidden: true, listenPort: 6881, portMatch: 'mismatch', problems: [{ code: 'mismatch', text: 'The VPN forwards port 40123, but qBittorrent listens on 6881.', fix: 'set-port' }] })
  const viewer = renderToStaticMarkup(<VpnView v={v} canAct={false} onFix={noop} />)
  assert.match(viewer, /Public address hidden/); assert.doesNotMatch(viewer, /198\.51/); assert.ok(!/<button/.test(viewer))
  assert.match(viewer, /data-match="mismatch"/)
  const admin = renderToStaticMarkup(<VpnView v={v} canAct onFix={noop} />)
  assert.match(admin, /Put the forwarded port into qBittorrent/)
  const down = renderToStaticMarkup(<VpnView v={vpn({ tunnel: 'down', location: null, publicIp: null, problems: [{ code: 'down', text: 'The tunnel is down.', fix: 'reconnect' }] })} canAct onFix={noop} />)
  assert.match(down, /Tunnel down/); assert.match(down, /Reconnect the tunnel/)
  const notBehind = renderToStaticMarkup(<VpnView v={vpn({ problems: [{ code: 'not-behind', text: 'qBittorrent is not using the VPN\'s network.' }] })} canAct onFix={noop} />)
  assert.match(notBehind, /not using the VPN/); assert.ok(!/<button/.test(notBehind), 'no button for what only the compose file can fix')
})

test('the fix confirms say what they do, and that a reconnect pauses downloads', () => {
  assert.match(fixConfirm('set-port', { forwardedPort: 40123, listenPort: 6881 }), /listen on 40123 \(it listens on 6881 now\)/)
  assert.match(fixConfirm('reconnect', { forwardedPort: null, listenPort: null }), /Downloads pause/)
  assert.match(portWord(vpn({ portMatch: 'no-port', forwardedPort: null })), /has not handed out a port/)
  assert.match(portWord(vpn({ portForwarding: false, portMatch: 'off' })), /off for this VPN/)
})
