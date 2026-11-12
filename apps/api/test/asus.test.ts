// ASUS router plug-in: the login and its token against a pretend router, the parsers (client list, wanlink,
// firmware on stock and Merlin), rates from counter deltas, health reasons, what a viewer sees, the reboot's
// guards and read-back, that a bad password is never retried, and the certificate pinned on first use.
// Nothing real is contacted: every router here is test/asus-fake.ts on 127.0.0.1.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fakeRouter, listen, CLIENTLIST, WANLINK_UP, FAKE_UA } from './asus-fake'
import { AsusClient, AsusLoginError, readLogin, loginBody } from '../src/lib/asus/client'
import { DirectTransport, ASUS_USER_AGENT, type AsusTransport } from '../src/lib/asus/transport'
import {
  buildReading, parseClients, parseWanlink, firmwareOf, updateOf, bandsOf, ratesFrom, sampleOf, healthOf, viewerReading,
  looseJson, counter, connectSeconds, barsOf, addressLike, type CounterSample,
} from '../src/lib/asus/parse'
import { AsusInstanceStore, cleanUrl, type CredentialIO } from '../src/lib/asus/instances'
import { AsusService, confirmPhrase, viewerAction, type Actor, type PresentedCert } from '../src/lib/asus/service'
import { checkAsusAddresses, asusResolver } from '../src/lib/asus/target'
import { defaultGateways, asusLoginPage, findAsusRouters } from '../src/lib/asus/detect'
import { setAsusService, detailOf, allReadings } from '../src/lib/asus'
import { asusPlugin } from '../src/plugins/asus'
import type { PluginContext } from '../src/lib/plugin-host'
import { probeCertificate, normaliseFingerprint } from '../src/lib/clusters/tls-pin'
import { requiredRole, needsReconfirm } from '../src/lib/roles'

const closers: Array<() => Promise<void>> = []
after(async () => { for (const c of closers) await c() })

function memoryIO(): CredentialIO & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get: async (c, p, k) => data.get(`${c}/${p}/${k}`) ?? null,
    set: async (c, p, k, v) => { data.set(`${c}/${p}/${k}`, v) },
    remove: async (c, p) => { for (const k of [...data.keys()]) if (k.startsWith(`${c}/${p}/`)) data.delete(k) },
  }
}

const admin: Actor = { sid: 's-admin', email: 'admin@example.com', role: 'admin', token: null }
const operator: Actor = { sid: 's-op', email: 'op@example.com', role: 'operator', token: null }

/** A service over a fresh fake router on 127.0.0.1, with a clock and sleeps the test controls. */
async function setup(over: Parameters<typeof fakeRouter>[0] = {}, o: { tls?: { key: Buffer; cert: Buffer }; probe?: (url: string) => Promise<PresentedCert> } = {}) {
  const fake = fakeRouter(over)
  const srv = await listen(fake.handler, o.tls)
  closers.push(srv.close)
  let clock = 1_700_000_000_000
  const audits: Array<{ action: string; details: Record<string, unknown> }> = []
  const published: any[] = []
  const store = new AsusInstanceStore(memoryIO(), async () => '127.0.0.1')
  const svc = new AsusService({
    store,
    audit: async (action, _r, details) => { audits.push({ action, details }) },
    publish: async e => { published.push(e) },
    transportFor: ({ url, meta }) => new DirectTransport({ url, insecureTLS: meta.insecureTLS, fingerprint: meta.fingerprint, resolve: async () => '127.0.0.1' }),
    probe: o.probe,
    now: () => clock,
    sleep: async ms => { clock += ms },
    readBackAt: [60_000, 120_000],
  })
  const url = `${o.tls ? 'https' : 'http'}://127.0.0.1:${srv.port}`
  return { fake, svc, store, audits, published, url, tick: (ms: number) => { clock += ms }, now: () => clock }
}

// ── login and token ──────────────────────────────────────────────────────────

test('login: the app User-Agent, base64 user:password, the token as the asus_token cookie, logout ends it', async () => {
  const { fake, url } = await setup()
  const t = new DirectTransport({ url, insecureTLS: false, fingerprint: null, resolve: async () => '127.0.0.1' })
  const c = new AsusClient(t, { username: 'admin', password: 'correct horse' })
  const text = await c.hook('nvram_get(productid)')
  assert.equal(looseJson(text)?.productid, 'RT-XX9000')
  const [login, hook] = fake.seen
  assert.equal(login.path, '/login.cgi')
  assert.equal(login.ua, ASUS_USER_AGENT)
  assert.equal(ASUS_USER_AGENT, FAKE_UA)
  assert.equal(login.body, loginBody({ username: 'admin', password: 'correct horse' }))
  assert.equal(Buffer.from(decodeURIComponent(login.body.split('=').slice(1).join('=')), 'base64').toString(), 'admin:correct horse')
  assert.equal(login.cookie, undefined, 'nothing to send before the login')
  assert.match(hook.cookie ?? '', /^asus_token=tok1x$/)
  assert.ok(!hook.body.includes('correct horse') && !(hook.cookie ?? '').includes('correct'), 'the password goes only into the login')
  await c.hook('nvram_get(productid)')
  assert.equal(c.logins, 1, 'the token is reused')
  await c.logout()
  assert.equal(fake.seen.at(-1)!.path, '/Logout.asp')
  assert.equal(fake.tokens.size, 0)
})

test('login answers: a token, or the router\'s reason (3, 7 with the lockout time, 9, 10, 11, not an ASUS)', () => {
  assert.deepEqual(readLogin(200, '{"asus_token":"abc123"}'), { token: 'abc123' })
  const k = (s: string) => { const r = readLogin(200, s); assert.ok(r instanceof AsusLoginError); return r }
  assert.equal(k('{"error_status":"3"}').kind, 'refused')
  const locked = k('{"error_status":"7","remaining_lock_time":"240"}')
  assert.equal(locked.kind, 'locked'); assert.equal(locked.retryAfterSec, 240); assert.match(locked.message, /4 min/)
  assert.equal(k('{"error_status":"9"}').kind, 'busy')
  assert.equal(k('{"error_status":"10"}').kind, 'captcha')
  assert.equal(k('{"error_status":"11"}').kind, 'reset')
  assert.equal(k('<html><title>ASUS Login</title></html>').kind, 'not-asus')
  assert.equal(k('{"asus_token":"bad token\\r\\nX: y"}').kind, 'not-asus', 'a token that could break a header is refused')
})

test('a session the router dropped (error_status 8) gets exactly one fresh login, then carries on', async () => {
  const { fake, url } = await setup({ expireAfter: 1 })
  const c = new AsusClient(new DirectTransport({ url, insecureTLS: false, fingerprint: null, resolve: async () => '127.0.0.1' }), { username: 'admin', password: 'correct horse' })
  await c.hook('uptime()')
  const text = await c.hook('uptime()')
  assert.match(String(looseJson(text)?.uptime), /secs since boot/)
  assert.equal(fake.logins(), 2)
})

test('the session is reused across readings and logged out once idle (ASUS allows one admin session)', async () => {
  const { fake, svc, store, url, tick } = await setup()
  const p = await store.prepare(null, { url, username: 'admin', password: 'correct horse' })
  const m = await store.create(p, 'Home router', { model: null, firmware: null })
  await svc.reading(m.id)
  tick(10_000)
  await svc.reading(m.id)
  assert.equal(fake.logins(), 1)
  await svc.sweep(120_000)
  assert.equal(fake.tokens.size, 1, 'not idle yet')
  tick(121_000)
  await svc.sweep(120_000)
  assert.equal(fake.tokens.size, 0, 'logged out after two idle minutes')
  assert.equal(fake.seen.at(-1)!.path, '/Logout.asp')
})

// ── never retry a bad password ───────────────────────────────────────────────

test('a refused login is held: no second login from the page, the card or the AI page until it is saved again', async () => {
  const { fake, svc, store, url } = await setup({ pass: 'something else' })
  const p = await store.prepare(null, { url, username: 'admin', password: 'wrong' })
  const m = await store.create(p, 'Home router', { model: null, firmware: null })
  await assert.rejects(svc.reading(m.id), (e: any) => e instanceof AsusLoginError && e.kind === 'refused')
  for (let i = 0; i < 5; i++) await assert.rejects(svc.reading(m.id), (e: any) => e.code === 'login_held')
  assert.equal(fake.logins(), 1, 'exactly one login was ever sent')
  assert.match(svc.blockedReason(m.id)!, /saved again/)
  // Saving the right password lifts the hold, after proving it once.
  fake.st.pass = 'right now'
  await svc.edit(m.id, { password: 'right now' }, admin)
  assert.equal(svc.blockedReason(m.id), null)
  await svc.reading(m.id)
})

test('a router lockout (error_status 7) is waited out, not hammered', async () => {
  const { fake, svc, store, url, tick } = await setup({ loginError: { status: 7, extra: { remaining_lock_time: '300' } } })
  const m = await store.create(await store.prepare(null, { url, username: 'admin', password: 'x' }), 'R', { model: null, firmware: null })
  await assert.rejects(svc.reading(m.id), (e: any) => e.kind === 'locked')
  tick(299_000)
  await assert.rejects(svc.reading(m.id), (e: any) => e.code === 'login_held')
  assert.equal(fake.logins(), 1)
  tick(2_000)
  fake.st.loginError = null; fake.st.pass = 'x'
  await svc.reading(m.id)
  assert.equal(fake.logins(), 2, 'one more login, once the router\'s own lockout has passed')
})

test('setup does the chores: one login proves it, the model and firmware are read, the name defaults to the model; a bad login saves nothing', async () => {
  const { fake, svc, store, url } = await setup({ flavour: 'merlin' })
  await assert.rejects(svc.add({ url, username: 'admin', password: 'nope' }, admin), (e: any) => e.code === 'login_refused' && /Nothing was saved/.test(e.message))
  assert.equal((await store.list()).length, 0)
  assert.equal(fake.logins(), 1)
  const { meta } = await svc.add({ url, username: 'admin', password: 'correct horse' }, admin)
  assert.equal(meta.name, 'RT-XX9000')
  assert.equal(meta.model, 'RT-XX9000')
  assert.equal(meta.firmware, '388.8_2')
  const again = await svc.add({ url, username: 'admin', password: 'correct horse' }, admin)
  assert.equal(again.meta.name, 'RT-XX9000 2', 'a second router of the same model is told apart')
  assert.equal(fake.seen.filter(s => s.path === '/Logout.asp').length, 2, 'setup logs out after itself')
  const v = (await store.views())[0]
  assert.equal(v.hasPassword, true)
  assert.ok(!JSON.stringify(await store.list()).includes('correct horse'), 'the index never holds the login')
})

test('addresses: a bare address gets http://, http only to a private address, paths and logins refused', () => {
  assert.equal(cleanUrl('10.0.0.1'), 'http://10.0.0.1')
  assert.equal(cleanUrl('https://router.example.lan:8443/'), 'https://router.example.lan:8443')
  assert.throws(() => cleanUrl('http://u:p@10.0.0.1'))
  assert.throws(() => cleanUrl('http://10.0.0.1/Main_Login.asp'))
  const env = { own: new Set<string>(), ports: new Set<number>(), bridges: new (require('node:net').BlockList)() }
  assert.equal(checkAsusAddresses('http:', 80, ['10.0.0.1'], env).ok, true)
  const pub = checkAsusAddresses('http:', 80, ['198.51.100.7'], env)
  assert.equal(pub.ok, false)
  assert.equal(checkAsusAddresses('https:', 443, ['198.51.100.7'], env).ok, true)
  assert.equal(checkAsusAddresses('http:', 80, ['127.0.0.1'], env).ok, false)
  assert.equal(checkAsusAddresses('http:', 80, ['169.254.169.254'], env).ok, false)
})

// ── parsers ──────────────────────────────────────────────────────────────────

test('client list: wired and per-band Wi-Fi, signal bars, online time, names falling back, offline counted, junk skipped', () => {
  const bands = bandsOf({ wl0_nband: '2', wl0_ssid: 'A', wl1_nband: '1', wl1_ssid: 'B' }, null)
  const { online, offline } = parseClients(CLIENTLIST.get_clientlist, 'a00000001', bands)
  assert.equal(offline, 1)
  assert.equal(online.length, 3)
  const by = Object.fromEntries(online.map(d => [d.mac, d]))
  assert.deepEqual({ ...by['00:00:5E:00:53:01'], key: '' }, { key: '', name: 'Desk PC', ip: '10.9.8.20', mac: '00:00:5E:00:53:01', vendor: 'Example Corp', connection: 'wired', band: null, rssi: null, bars: null, onlineSec: null })
  assert.equal(by['00:00:5E:00:53:02'].name, 'tablet', 'no nickname: the router\'s name')
  assert.equal(by['00:00:5E:00:53:02'].band, '2.4 GHz')
  assert.equal(by['00:00:5E:00:53:02'].bars, 4)
  assert.equal(by['00:00:5E:00:53:02'].onlineSec, 3723)
  assert.equal(by['00:00:5E:00:53:03'].name, 'Widget Co', 'no name at all: the vendor')
  assert.equal(by['00:00:5E:00:53:03'].band, '5 GHz')
  assert.equal(by['00:00:5E:00:53:03'].bars, 2)
  assert.equal(by['00:00:5E:00:53:03'].onlineSec, 2 * 86400 + 3 * 3600 + 4 * 60 + 5)
  for (const d of online) {
    assert.match(d.key, /^d[0-9a-f]{16}$/)
    assert.ok(!d.key.toLowerCase().includes('5e0053'), 'the key says nothing about the MAC')
  }
  assert.deepEqual(parseClients(null, 'a', bands), { online: [], offline: 0 })
  assert.deepEqual(parseClients('nonsense', 'a', bands), { online: [], offline: 0 })
  assert.equal(connectSeconds('bad'), null)
  assert.equal(barsOf(-90), 0); assert.equal(barsOf(0), null)
})

test('radios: labels by nband, the live channel when reported, "auto" when not, tri-band 5 GHz told apart', () => {
  const b = bandsOf({
    wl0_nband: '2', wl0_ssid: 'N', wl0_chanspec: '0', wl0_radio: '1',
    wl1_nband: '1', wl1_ssid: 'N5', wl1_chanspec: '36/80',
    wl2_nband: '1', wl2_ssid: 'N5b', wl2_chanspec: '149/160', wl2_radio: '0',
    wl3_nband: '4', wl3_ssid: 'N6', wl3_chanspec: '6g37/160',
  }, ['11', '0', '', '37'])
  assert.deepEqual(b.map(x => [x.label, x.channel, x.widthMhz, x.enabled]), [
    ['2.4 GHz', '11', null, true], ['5 GHz-1', '36', 80, true], ['5 GHz-2', '149', 160, false], ['6 GHz', '37', 160, true],
  ])
  assert.equal(bandsOf({ wl0_nband: '2', wl0_ssid: 'N', wl0_chanspec: '0' }, null)[0].channel, 'auto')
})

test('wanlink(): JavaScript function text, inside or outside a JSON wrapper', () => {
  assert.deepEqual(parseWanlink(WANLINK_UP)!.ipaddr, '198.51.100.7')
  assert.equal(parseWanlink(WANLINK_UP)!.status, '1')
  assert.equal(parseWanlink(`{"wanlink": function wanlink_status() { return 0;}\nfunction wanlink_statusstr() { return "Disconnected";}}`)!.statusstr, 'Disconnected')
  assert.equal(parseWanlink('<html>'), null)
})

test('firmware: stock and Merlin version strings and the update flag', () => {
  assert.deepEqual(firmwareOf({ firmver: '3.0.0.4', buildno: '388', extendno: '24198-gabc1234' }), { version: '3.0.0.4.388_24198', flavour: 'stock' })
  assert.deepEqual(firmwareOf({ firmver: '3.0.0.6', buildno: '102', extendno: '34791-g1234abcd' }), { version: '3.0.0.6.102_34791', flavour: 'stock' })
  assert.deepEqual(firmwareOf({ firmver: '3.0.0.4', buildno: '388.8', extendno: '2', '3rd-party': 'merlin' }), { version: '388.8_2', flavour: 'merlin' })
  assert.deepEqual(firmwareOf({ firmver: '3.0.0.4', buildno: '3004.388.8', extendno: '4_beta1' }), { version: '3004.388.8_4_beta1', flavour: 'merlin' })
  assert.deepEqual(firmwareOf({}), { version: null, flavour: null })
  assert.deepEqual(updateOf({ webs_state_flag: '1', webs_state_info: '3004_388_8_4' }, 'stock'), { available: true, version: '3.0.0.4.388_8_4' })
  assert.deepEqual(updateOf({ webs_state_flag: '0' }, 'stock'), { available: false, version: null })
  assert.deepEqual(updateOf({}, 'merlin'), { available: null, version: null })
})

test('tolerant JSON and counters: trailing commas, control characters, 0x hex and 64-bit values', () => {
  assert.deepEqual(looseJson('{"a":"1",}'), { a: '1' })
  assert.deepEqual(looseJson('{"a":"x\u0001y"}'), { a: 'xy' })
  assert.equal(looseJson('nope'), null)
  assert.equal(counter('0x00000001ffffffff'), 0x1ffffffffn)
  assert.equal(counter('18446744073709551615'), 18446744073709551615n)
  assert.equal(counter('zz'), null)
})

// ── rates ────────────────────────────────────────────────────────────────────

const sample = (at: number, rx: bigint | null, tx: bigint | null, used: number | null = null, total: number | null = null, cores = 2): CounterSample =>
  ({ at, rx, tx, cpuUsed: used, cpuTotal: total, cores })

test('rates: bits per second from byte counter deltas, CPU from time deltas; null when it cannot be said', () => {
  const a = sample(0, 1_000_000n, 2_000n, 1000, 10_000)
  const b = sample(2_000, 1_000_000n + 2_500_000n, 2_000n + 250_000n, 1000 + 450, 10_000 + 1000)
  assert.deepEqual(ratesFrom(a, b), { downBps: 10_000_000, upBps: 1_000_000, cpuPct: 45 })
  assert.deepEqual(ratesFrom(null, b), { downBps: null, upBps: null, cpuPct: null }, 'one sample is not a rate')
  assert.equal(ratesFrom(a, sample(100, 2_000_000n, 3_000n)).downBps, null, 'too close together')
  assert.equal(ratesFrom(a, sample(400_000, 2_000_000n, 3_000n)).downBps, null, 'too far apart to be "now"')
  assert.equal(ratesFrom(a, sample(2_000, 10n, 3_000n)).downBps, null, 'a counter that went backwards (a reboot) is not a negative rate')
  assert.equal(ratesFrom(a, sample(2_000, 2_000_000n, 3_000n, 900, 11_000)).cpuPct, null)
  // 64-bit counters past 2^53 still subtract exactly.
  const big = 2n ** 60n
  assert.equal(ratesFrom(sample(0, big, 0n), sample(1_000, big + 125n, 0n)).downBps, 1000)
  const s = sampleOf({ netdev: { INTERNET_rx: '0x10', INTERNET_tx: '0x20' }, cpu_usage: { cpu1_total: '100', cpu1_usage: '10', cpu2_total: '100', cpu2_usage: '30' } }, 5)
  assert.deepEqual(s, { at: 5, rx: 16n, tx: 32n, cpuUsed: 40, cpuTotal: 200, cores: 2 })
})

test('a cold reading takes a second counter sample so the first page already has live rates', async () => {
  const { svc, store, url } = await setup({ rxStep: 1_875_000n, txStep: 187_500n, cpuBusy: 0.3 })
  const m = await store.create(await store.prepare(null, { url, username: 'admin', password: 'correct horse' }), 'R', { model: null, firmware: null })
  const r = await svc.reading(m.id)
  // 1.5 s between samples: 1,875,000 bytes -> 10 Mbps, 187,500 -> 1 Mbps.
  assert.equal(r.wan.downBps, 10_000_000)
  assert.equal(r.wan.upBps, 1_000_000)
  assert.equal(r.cpuPct, 30)
  assert.equal(r.cpuCores, 2)
  assert.equal(r.model, 'RT-XX9000')
  assert.equal(r.firmware.version, '3.0.0.4.388_24198')
  assert.equal(r.uptimeSec, 86_400 * 3)
  assert.equal(r.wan.up, true); assert.equal(r.wan.ip, '198.51.100.7')
  assert.deepEqual(r.bands.map(b => [b.label, b.ssid, b.channel, b.clients]), [['2.4 GHz', 'Example Net', '6', 1], ['5 GHz', 'Example Net 5G', '36', 1]])
  assert.equal(r.devices.length, 3); assert.equal(r.offlineKnown, 1)
  assert.equal(r.mem!.pct, 40)
  assert.deepEqual(r.missing, [])
  assert.equal((await store.get(m.id))!.firmware, '3.0.0.4.388_24198', 'what the reading learned is kept for the list')
})

// ── health ───────────────────────────────────────────────────────────────────

test('health: needs attention when the WAN is down, CPU or memory is high, or firmware is waiting', () => {
  const ok = { wan: { up: true, status: 'Connected' } as any, cpuPct: 20, mem: { totalKiB: 1, usedKiB: 1, pct: 50 }, update: { available: false, version: null } }
  assert.deepEqual(healthOf(ok), { level: 'good', reasons: [] })
  const bad = healthOf({ wan: { up: false, status: 'Disconnected' } as any, cpuPct: 97, mem: { totalKiB: 1, usedKiB: 1, pct: 95 }, update: { available: true, version: '388.9_1' } })
  assert.equal(bad.level, 'attention')
  assert.deepEqual(bad.reasons, ['The internet connection is down (Disconnected).', 'CPU is at 97%.', 'Memory is at 95%.', 'A firmware update is available (388.9_1).'])
  assert.equal(healthOf({ ...ok, cpuPct: null, mem: null, update: { available: null, version: null }, wan: { up: null } as any }).level, 'good', 'unknown is not a problem')
})

test('health end to end: the fake router with its WAN down and an update offered', async () => {
  const { svc, store, url } = await setup({ wanUp: false, update: '3004_388_9_2', memUsedPct: 95 })
  const m = await store.create(await store.prepare(null, { url, username: 'admin', password: 'correct horse' }), 'R', { model: null, firmware: null })
  const r = await svc.reading(m.id)
  assert.equal(r.health.level, 'attention')
  assert.equal(r.wan.up, false); assert.equal(r.wan.ip, null, '0.0.0.0 is no address')
  assert.ok(r.health.reasons.some(x => /internet connection is down/.test(x)))
  assert.ok(r.health.reasons.some(x => /3\.0\.0\.4\.388_9_2/.test(x)))
  assert.ok(r.health.reasons.some(x => /Memory is at 95%/.test(x)))
})

// ── what each role sees ──────────────────────────────────────────────────────

const MAC = /([0-9A-F]{2}:){5}[0-9A-F]{2}/i
// The fixture's addresses (a firmware version such as 3.0.0.4 looks like an IP to a generic pattern).
const IP = /10\.9\.8\.\d|198\.51\.100\.\d/

test('a viewer sees no MACs, no client addresses and no WAN address; operators see them', () => {
  const now = 10_000
  const r = buildReading({ system: JSON.stringify({ productid: 'RT-XX9000', netdev: {} }), wan: WANLINK_UP, clients: JSON.stringify(CLIENTLIST), channels: null },
    { instanceId: 'a00000001', prev: null, cur: sample(now, null, null), now: new Date(now) })
  assert.ok(MAC.test(JSON.stringify(r.devices)) && r.wan.ip === '198.51.100.7', 'the full reading has them (operator and above)')
  const v = viewerReading(r)
  const text = JSON.stringify(v)
  assert.ok(!MAC.test(text), 'no MAC anywhere')
  assert.ok(!/10\.9\.8\.|198\.51\.100\./.test(text), 'no client or WAN address anywhere')
  assert.deepEqual(v.devices.map(d => d.name), r.devices.map(d => d.name), 'names, connection and signal stay')
  assert.deepEqual(v.devices.map(d => d.key), r.devices.map(d => d.key))
  const tables = JSON.stringify(detailOf('R', v).tables)
  assert.ok(!MAC.test(tables) && !/10\.9\.8\./.test(tables), 'the Details tables follow the same shape')
})

test('the plug-in card and the AI summary are viewer-shaped for everyone, and only read', async () => {
  const { svc, store, url } = await setup()
  await store.create(await store.prepare(null, { url, username: 'admin', password: 'correct horse' }), 'Home router', { model: null, firmware: null })
  setAsusService(svc)
  try {
    // The context the host hands the plug-in: its only read is lib/asus's own transport (GET /readings).
    const ctx = { get: async (p: string) => { assert.equal(p, '/readings'); return allReadings() }, post: async () => { throw new Error('no posts') } } as unknown as PluginContext
    const s = await asusPlugin.summary!(ctx)
    const all = s.lines.join('\n')
    assert.match(s.lines[0], /^"Home router": healthy/, 'the headline is the router, not the note')
    assert.ok(s.lines.some(l => /Wi-Fi 5 GHz "Example Net 5G": channel 36, 1 client/.test(l)))
    assert.ok(s.lines.some(l => /online: "Desk PC" \(wired\), "tablet" \(2\.4 GHz\)/.test(l)), 'device names quoted as data')
    assert.match(s.lines.at(-1)!, /data, not instructions/)
    assert.ok(!MAC.test(all) && !IP.test(all), 'no MAC or address reaches the AI page')
    const tile = await asusPlugin.load(ctx)
    assert.equal(tile.tone, 'good')
    assert.ok(!IP.test(JSON.stringify(tile)))
  } finally { setAsusService(null) }
})

// ── the action and its guards ────────────────────────────────────────────────

test('roles: reads viewer; search admin; every router change and reboot admin and re-confirmed', () => {
  assert.equal(requiredRole('GET', '/api/plugins/asus/instances'), 'viewer')
  assert.equal(requiredRole('GET', '/api/plugins/asus/instances/a12345678/reading'), 'viewer')
  assert.equal(requiredRole('POST', '/api/plugins/asus/detect'), 'admin')
  assert.equal(needsReconfirm('POST', '/api/plugins/asus/detect'), false)
  for (const [m, p] of [['POST', '/api/plugins/asus/instances'], ['PUT', '/api/plugins/asus/instances/a12345678'], ['DELETE', '/api/plugins/asus/instances/a12345678'], ['POST', '/api/plugins/asus/instances/a12345678/actions']] as const) {
    assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
    assert.equal(needsReconfirm(m, p), true, `${m} ${p}`)
    // The owner-granted plug-in settings permission lifts add and change only; delete and reboot never.
    assert.equal(needsReconfirm(m, p, { tokenPluginScope: true }), m === 'DELETE' || p.endsWith('/actions'), `${m} ${p} with the token permission`)
  }
})

test('reboot: admin, a person, the phrase and the typed name; every attempt audited; anything else refused', async () => {
  const { fake, svc, store, url, audits } = await setup()
  const m = await store.create(await store.prepare(null, { url, username: 'admin', password: 'correct horse' }), 'Home router', { model: null, firmware: null })
  const good = { action: 'reboot', confirm: confirmPhrase('Home router'), typed: 'home router' }
  await assert.rejects(svc.act(m.id, { action: 'block_client' }, admin), (e: any) => e.code === 'action_not_allowed')
  await assert.rejects(svc.act(m.id, good, operator), (e: any) => e.code === 'forbidden' && e.status === 403)
  await assert.rejects(svc.act(m.id, good, { ...admin, token: 'ci' }), (e: any) => e.code === 'token_forbidden')
  await assert.rejects(svc.act(m.id, { ...good, typed: 'other' }, admin), (e: any) => e.code === 'confirm_required')
  await assert.rejects(svc.act(m.id, { ...good, confirm: 'Reboot' }, admin), (e: any) => e.code === 'confirm_required')
  assert.equal(fake.seen.filter(s => s.path === '/applyapp.cgi').length, 0, 'nothing reached the router')
  assert.deepEqual(audits.map(a => a.details.result), ['refused:action_not_allowed', 'refused:forbidden', 'refused:token_forbidden', 'refused:confirm_required', 'refused:confirm_required'])
  const out = await svc.act(m.id, good, admin)
  assert.match(out.message, /is rebooting/)
  const sent = fake.seen.filter(s => s.path === '/applyapp.cgi')
  assert.equal(sent.length, 1)
  assert.deepEqual(JSON.parse(sent[0].body), { action_mode: 'apply', rc_service: 'reboot' })
  assert.equal(audits.at(-1)!.details.result, 'sent')
  assert.equal(svc.lastAction(m.id)!.state, 'sent')
  await assert.rejects(svc.act(m.id, good, admin), (e: any) => e.code === 'in_progress', 'no second reboot while the first is coming back')
  // Read back: the fake came back with a 5-second uptime, which is younger than the reboot.
  await svc.readBacks.get(m.id)
  assert.equal(svc.lastAction(m.id)!.state, 'back')
  assert.deepEqual(audits.at(-1), { action: 'asus.action.verify', details: { by: 'admin@example.com', router: 'Home router', routerId: m.id, action: 'reboot', result: 'back', uptimeSec: 5 } })
})

test('reboot: a dropped connection is "unconfirmed", read back, and a router that never returns is reported', async () => {
  const { fake, svc, store, url, audits, published } = await setup({ reboot: 'drop' })
  const m = await store.create(await store.prepare(null, { url, username: 'admin', password: 'correct horse' }), 'R', { model: null, firmware: null })
  const out = await svc.act(m.id, { action: 'reboot', confirm: 'Reboot R', typed: 'R' }, admin)
  assert.match(out.message, /did not confirm/)
  // It answers again but with the same long uptime: it never restarted.
  await svc.readBacks.get(m.id)
  assert.equal(svc.lastAction(m.id)!.state, 'not_back')
  assert.equal(audits.at(-1)!.details.result, 'not_restarted')
  assert.ok(published.some(p => p.type === 'alert.asus.power'))
  assert.ok(fake.logins() >= 2)
})

test('reboot: a held login refuses before anything is sent; three an hour at most', async () => {
  const { svc, store, url, tick } = await setup({ pass: 'other' })
  const m = await store.create(await store.prepare(null, { url, username: 'admin', password: 'wrong' }), 'R', { model: null, firmware: null })
  await assert.rejects(svc.reading(m.id))
  await assert.rejects(svc.act(m.id, { action: 'reboot', confirm: 'Reboot R', typed: 'R' }, admin), (e: any) => e.code === 'login_held')
  const s2 = await setup()
  const m2 = await s2.store.create(await s2.store.prepare(null, { url: s2.url, username: 'admin', password: 'correct horse' }), 'R', { model: null, firmware: null })
  for (let i = 0; i < 3; i++) { await s2.svc.act(m2.id, { action: 'reboot', confirm: 'Reboot R', typed: 'R' }, admin); await s2.svc.readBacks.get(m2.id); s2.tick(60_000) }
  await assert.rejects(s2.svc.act(m2.id, { action: 'reboot', confirm: 'Reboot R', typed: 'R' }, admin), (e: any) => e.code === 'rate_limited')
  // Per router and per person, not per browser session: a new sign-in or another admin gets no extra reboot.
  await assert.rejects(s2.svc.act(m2.id, { action: 'reboot', confirm: 'Reboot R', typed: 'R' }, { ...admin, sid: 's-new' }), (e: any) => e.code === 'rate_limited')
  await assert.rejects(s2.svc.act(m2.id, { action: 'reboot', confirm: 'Reboot R', typed: 'R' }, { ...admin, sid: 's-other', email: 'other@example.com' }), (e: any) => e.code === 'rate_limited')
  void tick
})

test('reboot: two at once send one; the pending mark is set before anything is awaited', async () => {
  const { fake, svc, store, url } = await setup()
  const m = await store.create(await store.prepare(null, { url, username: 'admin', password: 'correct horse' }), 'R', { model: null, firmware: null })
  const req = { action: 'reboot', confirm: 'Reboot R', typed: 'R' }
  const both = await Promise.allSettled([svc.act(m.id, req, admin), svc.act(m.id, req, { ...admin, sid: 's-2', email: 'second@example.com' })])
  assert.equal(both.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal((both.find(x => x.status === 'rejected') as PromiseRejectedResult).reason.code, 'in_progress')
  assert.equal(fake.seen.filter(x => x.path === '/applyapp.cgi').length, 1)
  await svc.readBacks.get(m.id)
})

// ── the certificate pin ──────────────────────────────────────────────────────

const haveOpenssl = spawnSync('openssl', ['version']).status === 0
function makeCert(dir: string, name: string) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '30',
    '-subj', '/CN=router.example.lan', '-keyout', path.join(dir, `${name}.key`), '-out', path.join(dir, `${name}.crt`)], { stdio: 'ignore' })
  return { key: fs.readFileSync(path.join(dir, `${name}.key`)), cert: fs.readFileSync(path.join(dir, `${name}.crt`)) }
}

test('TLS: an https router is pinned on first use, and a different certificate gets nothing, not even the login', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-asus-'))
  const a = makeCert(dir, 'a'), b = makeCert(dir, 'b')
  const probe = async (u: string): Promise<PresentedCert> => { const c = await probeCertificate('127.0.0.1', Number(new URL(u).port)); return { fingerprint: c.fingerprint, subject: c.subject, issuer: c.issuer, validTo: c.validTo } }
  const s = await setup({}, { tls: a, probe })
  const { meta, pinnedNow } = await s.svc.add({ url: s.url, username: 'admin', password: 'correct horse' }, admin)
  assert.equal(pinnedNow, true)
  const fpA = normaliseFingerprint(new (require('node:crypto').X509Certificate)(a.cert).fingerprint256)
  assert.equal(meta.fingerprint, fpA)
  await s.svc.reading(meta.id)

  // The same address now presents another certificate: refused before a byte of the request is written.
  const other = fakeRouter()
  const srvB = await listen(other.handler, b)
  closers.push(srvB.close)
  const t: AsusTransport = new DirectTransport({ url: `https://127.0.0.1:${srvB.port}`, insecureTLS: false, fingerprint: meta.fingerprint, resolve: async () => '127.0.0.1' })
  const c = new AsusClient(t, { username: 'admin', password: 'correct horse' })
  await assert.rejects(c.hook('uptime()'), (e: any) => /different certificate/.test(e.message))
  assert.equal(other.seen.length, 0, 'the router with the other certificate was sent nothing')

  // Without a pin and without "accept any", a self-signed certificate is refused outright.
  const plain = new AsusClient(new DirectTransport({ url: `https://127.0.0.1:${srvB.port}`, insecureTLS: false, fingerprint: null, resolve: async () => '127.0.0.1' }), { username: 'admin', password: 'x' })
  await assert.rejects(plain.hook('uptime()'), (e: any) => /certificate|unreachable/i.test(e.message))
  assert.equal(other.seen.length, 0)

  // An existing router is never re-pinned to "whatever it presents": removing the pin needs the password, and with
  // it the save is proved against strict certificate checks, which a self-signed router fails, so nothing changes.
  await assert.rejects(s.svc.edit(meta.id, { fingerprint: '' }, admin), (e: any) => /password again/.test(e.message))
  await assert.rejects(s.svc.edit(meta.id, { fingerprint: '', password: 'correct horse' }, admin), (e: any) => /certificate|Nothing was saved/.test(e.message))
  assert.equal((await s.store.get(meta.id))!.fingerprint, fpA)
  // A renewed certificate is pinned through the probe a person confirms: exactly that fingerprint, nothing else.
  s.tick(61_000)   // past the per-minute limit on setup changes
  const presented = await s.svc.probeCertificate(s.url, admin)
  assert.equal(presented.fingerprint, fpA)
  await assert.rejects(s.svc.probeCertificate('http://127.0.0.1:1', admin), (e: any) => /Only an https/.test(e.message))
  const fpB = normaliseFingerprint(new (require('node:crypto').X509Certificate)(b.cert).fingerprint256)!
  const repinned = await s.svc.edit(meta.id, { fingerprint: fpB }, admin)
  assert.equal(repinned.pinnedNow, false)
  assert.equal(repinned.meta.fingerprint, fpB, 'the confirmed fingerprint, not one HyperProx read for itself')
  await assert.rejects(s.svc.reading(meta.id), (e: any) => /different certificate/.test(e.message), 'and it holds: router A no longer matches')
})

test('http on the LAN needs no pin and none is taken', async () => {
  const s = await setup({}, { probe: async () => { throw new Error('should not probe') } })
  const { meta, pinnedNow } = await s.svc.add({ url: s.url, username: 'admin', password: 'correct horse' }, admin)
  assert.equal(pinnedNow, false); assert.equal(meta.fingerprint, null)
})

// ── finding the router ───────────────────────────────────────────────────────

test('detection: the default gateway from the routing table, and the Asuswrt login page told from anything else', async () => {
  const table = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\nnet0\t00000000\t0108090A\t0003\t0\t0\t0\t00000000\nnet0\t0008090A\t00000000\t0001\t0\t0\t0\t00FFFFFF\n'
  assert.deepEqual(defaultGateways(table), ['10.9.8.1'])
  const page = '<html><head><title>ASUS Login</title></head><body><form action="login.cgi"></form><div class="prod_madelName">RT-XX9000</div></body></html>'
  assert.deepEqual(asusLoginPage(200, page), { model: 'RT-XX9000' })
  assert.equal(asusLoginPage(200, '<html><title>Some other router</title><form action="/login"></form></html>'), null)
  assert.equal(asusLoginPage(404, page), null)
  const asked: string[] = []
  const found = await findAsusRouters({ gateways: ['10.9.8.1', '198.51.100.1'], get: async u => { asked.push(u); return u.startsWith('http://10.9.8.1') ? { status: 200, body: page } : null } })
  assert.deepEqual(found, [{ url: 'http://10.9.8.1', model: 'RT-XX9000', source: 'default gateway' }])
  assert.ok(!asked.includes('http://198.51.100.1/Main_Login.asp'), 'never plain http to a public address')
})

// ── review follow-ups ────────────────────────────────────────────────────────

test('"not an ASUS router" is held for 15 minutes, then backed off, not until a re-save; a bad password still is', async () => {
  const { fake, svc, store, url, tick } = await setup({ loginError: { status: 42 } })
  const m = await store.create(await store.prepare(null, { url, username: 'admin', password: 'correct horse' }), 'R', { model: null, firmware: null })
  await assert.rejects(svc.reading(m.id), (e: any) => e.kind === 'not-asus')
  await assert.rejects(svc.reading(m.id), (e: any) => e.code === 'login_held')
  assert.match(svc.blockedReason(m.id)!, /15 min/)
  tick(15 * 60_000 + 1)
  await assert.rejects(svc.reading(m.id), (e: any) => e.kind === 'not-asus')
  assert.equal(fake.logins(), 2)
  assert.match(svc.blockedReason(m.id)!, /30 min/, 'twice as long the second time')
  tick(30 * 60_000 + 1)
  fake.st.loginError = null
  await svc.reading(m.id)
  assert.equal(svc.blockedReason(m.id), null)
})

test('loosening TLS (accept any certificate, or no pin) needs the password in the same save', async () => {
  const { svc, store, url } = await setup()
  const { meta } = await svc.add({ url, username: 'admin', password: 'correct horse' }, admin)
  await assert.rejects(svc.edit(meta.id, { insecureTLS: true }, admin), (e: any) => /Accepting any certificate needs the router's password/.test(e.message))
  assert.equal((await store.get(meta.id))!.insecureTLS, false)
  const ok = await svc.edit(meta.id, { insecureTLS: true, password: 'correct horse' }, admin)
  assert.equal(ok.meta.insecureTLS, true)
  assert.equal((await svc.edit(meta.id, { name: 'Renamed' }, admin)).meta.name, 'Renamed', 'a rename needs nothing more')
})

test('viewers: no "by" on the last reboot, address-shaped device names masked, generic errors on the card and AI page', async () => {
  assert.deepEqual(viewerAction({ action: 'reboot', at: 'x', by: 'admin@example.com', state: 'back', detail: null }), { action: 'reboot', at: 'x', state: 'back', detail: null })
  assert.equal(viewerAction(null), null)
  for (const n of ['00:00:5E:00:53:09', '00-00-5e-00-53-09', '00005E005309', '0000.5e00.5309', '10.9.8.30', 'host 10.9.8.30', 'fe80::1', '2001:db8::5']) assert.ok(addressLike(n), n)
  for (const n of ['Desk PC', 'tablet', 'Kitchen speaker 2', 'TV-5G']) assert.ok(!addressLike(n), n)
  const raw = { get_clientlist: {
    '00:00:5E:00:53:09': { mac: '00:00:5E:00:53:09', name: '00:00:5E:00:53:09', nickName: '', ip: '10.9.8.30', isWL: '0', isOnline: '1' },
    '00:00:5E:00:53:0A': { mac: '00:00:5E:00:53:0A', name: '10.9.8.31', nickName: '', ip: '10.9.8.31', isWL: '0', isOnline: '1' },
  } }
  const r = buildReading({ system: '{}', wan: null, clients: JSON.stringify(raw), channels: null }, { instanceId: 'a00000001', prev: null, cur: sample(1, null, null) })
  const v = viewerReading(r)
  assert.deepEqual(v.devices.map(d => d.name), ['Unnamed device', 'Unnamed device'])
  assert.ok(!/5E:00:53|10\.9\.8\./i.test(JSON.stringify(v)))

  const { svc, store, url } = await setup({ pass: 'other' })
  await store.create(await store.prepare(null, { url, username: 'admin', password: 'wrong' }), 'R', { model: null, firmware: null })
  setAsusService(svc)
  try {
    const first = await allReadings()
    assert.equal(first[0].error, 'not reachable right now')
    const second = await allReadings()
    assert.equal(second[0].error, 'waiting before it signs in again')
    assert.ok(!/password|refused|127\.0\.0\.1/i.test(JSON.stringify(second)), 'no router or address text reaches the card')
  } finally { setAsusService(null) }
})

test('request time: a name that later resolves to loopback (DNS rebinding) is refused, and nothing is sent', async () => {
  const fake = fakeRouter()
  const srv = await listen(fake.handler)
  closers.push(srv.close)
  const env = { own: new Set<string>(['10.9.8.5']), ports: new Set<number>([443]), bridges: new (require('node:net').BlockList)() }
  let answer = ['10.9.8.1']
  const resolve = asusResolver({ lookup: async () => answer, env })
  const u = `http://router.example.lan:${srv.port}`
  assert.equal(await resolve(new URL(u)), '10.9.8.1', 'when saved, the name is a LAN address')
  answer = ['127.0.0.1']
  const c = new AsusClient(new DirectTransport({ url: u, insecureTLS: false, fingerprint: null, resolve }), { username: 'admin', password: 'correct horse' })
  await assert.rejects(c.hook('uptime()'), (e: any) => /Router address refused: .*loopback/.test(e.message))
  answer = ['10.9.8.1', '127.0.0.1']
  await assert.rejects(c.hook('uptime()'), (e: any) => /loopback/.test(e.message), 'one bad address among several is enough to refuse')
  assert.equal(fake.seen.length, 0, 'the login never left HyperProx')
})

test("request time: loopback, and HyperProx's own addresses on any port, are refused", async () => {
  const env = { own: new Set<string>(['10.9.8.5']), ports: new Set<number>([443]), bridges: new (require('node:net').BlockList)() }
  const resolve = asusResolver({ lookup: async () => ['10.9.8.5'], env })
  for (const url of ['http://10.9.8.5', 'http://10.9.8.5:8080', 'https://10.9.8.5:8443', 'https://hyperprox.example.lan:443']) {
    await assert.rejects(resolve(new URL(url)), (e: any) => /HyperProx's own machine/.test(e.message), url)
  }
  await assert.rejects(asusResolver({ env })(new URL('http://127.0.0.1:8080')), (e: any) => /loopback/.test(e.message))
  await assert.rejects(asusResolver({ env })(new URL('http://[::1]:80')), (e: any) => /loopback/.test(e.message))
  await assert.rejects(asusResolver({ env })(new URL('http://198.51.100.7')), (e: any) => /only allowed to a private address/.test(e.message))
  assert.equal(await asusResolver({ env })(new URL('http://10.9.8.1:8080')), '10.9.8.1')
  assert.equal(checkAsusAddresses('http:', 8080, ['10.9.8.5'], env).ok, false, 'not just the ports HyperProx itself serves')
})

// ── operation mode and diagnostics ───────────────────────────────────────────

import { modeOf, loosePairs } from '../src/lib/asus/parse'
import { redactAnswer, MacMasker, DIAGNOSTIC_HOOKS, SECRET_RE } from '../src/lib/asus/diagnostics'

test('mode: router, access point, AiMesh main and node, repeater and media bridge', () => {
  assert.deepEqual(modeOf({ sw_mode: '1' }), { kind: 'router', label: 'Router', aimesh: null })
  assert.deepEqual(modeOf({ sw_mode: '1', cfg_master: '1' }), { kind: 'router', label: 'Router · AiMesh main', aimesh: 'main' })
  assert.deepEqual(modeOf({ sw_mode: '3', cfg_master: '1', re_mode: '0' }), { kind: 'ap', label: 'Access point · AiMesh main', aimesh: 'main' })
  assert.deepEqual(modeOf({ sw_mode: '3', re_mode: '1' }), { kind: 'node', label: 'AiMesh node', aimesh: 'node' })
  assert.equal(modeOf({ sw_mode: '2' }).kind, 'repeater')
  assert.equal(modeOf({ sw_mode: '4' }).kind, 'bridge')
  assert.deepEqual(modeOf(null), { kind: null, label: null, aimesh: null })
  assert.deepEqual(modeOf({}), { kind: null, label: null, aimesh: null })
})

test('an access point leading AiMesh: no WAN panel data, no internet alarm, mode in the reading, upstream for operators', async () => {
  const { svc, store, url } = await setup({ mode: 'ap-main', wanUp: false })
  const m = await store.create(await store.prepare(null, { url, username: 'admin', password: 'correct horse' }), 'Mesh main', { model: null, firmware: null })
  const r = await svc.reading(m.id)
  assert.deepEqual(r.mode, { kind: 'ap', label: 'Access point · AiMesh main', aimesh: 'main' })
  assert.equal(r.health.level, 'good', 'an unused WAN reporting "Disconnected" is not a problem')
  assert.ok(!r.health.reasons.some(x => /internet/i.test(x)))
  assert.deepEqual({ ...r.wan }, { up: null, status: null, type: null, ip: null, gateway: null, unit: null, downBps: null, upBps: null })
  assert.deepEqual(r.uplink, { gateway: '10.9.8.1' })
  assert.deepEqual(viewerReading(r).uplink, { gateway: null })
  assert.equal(r.bands.length, 2, 'radios still read')
  assert.ok(!r.missing.includes('wan'))
  const node = await setup({ mode: 'node', wanUp: false })
  const n = await node.store.create(await node.store.prepare(null, { url: node.url, username: 'admin', password: 'correct horse' }), 'Node', { model: null, firmware: null })
  const rn = await node.svc.reading(n.id)
  assert.equal(rn.mode.kind, 'node'); assert.equal(rn.health.level, 'good')
  // A router with its WAN down still raises it.
  const rt = await setup({ mode: 'router', wanUp: false })
  const t = await rt.store.create(await rt.store.prepare(null, { url: rt.url, username: 'admin', password: 'correct horse' }), 'R', { model: null, firmware: null })
  assert.ok((await rt.svc.reading(t.id)).health.reasons.some(x => /internet connection is down/.test(x)))
})

test('a system answer that is not valid JSON as a whole still yields every flat value that parses', () => {
  const broken = '{"productid":"RT-XX9000","firmver":"3.0.0.4","buildno":"388","extendno":"24198-gabc","wl0_ssid":"Bad "quote" net","wl0_nband":"2","wl1_ssid":"Fine","wl1_nband":"1",'
  assert.equal(looseJson(broken), null)
  const pairs = loosePairs(broken)!
  assert.equal(pairs.productid, 'RT-XX9000')
  const r = buildReading({ system: broken, wan: null, clients: null, channels: null }, { instanceId: 'a00000001', prev: null, cur: sample(1, null, null) })
  assert.equal(r.model, 'RT-XX9000')
  assert.equal(r.firmware.version, '3.0.0.4.388_24198')
  assert.ok(r.bands.some(b => b.ssid === 'Fine'))
  assert.ok(r.missing.includes('system'), 'and the page still says that part was malformed')
})

test('diagnostics redaction: secret keys and nvram names, wanlink fields, every MAC (keys too), consistent placeholders, capped', () => {
  const masks = new MacMasker()
  const j = redactAnswer(JSON.stringify({
    wl0_wpa_psk: 'wifi-password-1', http_passwd: 'admin-password-2', wps_device_pin: '12345670', asus_token: 'tok-3', 'nvram_get(wl1_auth_mode_x)': 'psk2',
    get_clientlist: { '00:00:5E:00:53:01': { mac: '00:00:5E:00:53:01', name: 'Desk PC', keeparp: 'x' }, maclist: ['00:00:5e:00:53:01', '00-00-5E-00-53-02'] },
    nested: [{ deep: { secret_thing: 'hidden-4', bare: '00005E005303', dotted: '0000.5e00.5304', counter: '0x00000000005e0053' } }],
  }), masks)
  assert.equal(j.json, true)
  const b = j.body!
  for (const secret of ['wifi-password-1', 'admin-password-2', '12345670', 'tok-3', 'psk2', 'hidden-4']) assert.ok(!b.includes(secret), secret)
  assert.ok(!/([0-9A-F]{2}[:-]){5}[0-9A-F]{2}/i.test(b), 'no MAC with separators')
  assert.ok(!/00005E005303|0000\.5e00\.5304/i.test(b), 'no bare or dotted MAC')
  assert.ok(b.includes('"MAC-01"') && (b.match(/MAC-01/g) ?? []).length >= 3, 'one MAC, one placeholder, as key and value')
  assert.ok(b.includes('0x00000000005e0053'), 'a 0x counter is not a MAC')
  assert.ok(b.includes('Desk PC'))
  const t = redactAnswer(`function wanlink_status() { return 1;}\nfunction wanlink_xpassword() { return 'pppoe-secret-5';}\nfunction wanlink_ipaddr() { return '198.51.100.7';}\n{"wl0_wpa_psk":"x6", "ok":"00:00:5E:00:53:01"`, masks)
  assert.equal(t.json, false)
  assert.ok(!t.body!.includes('pppoe-secret-5') && !t.body!.includes('x6'))
  assert.ok(t.body!.includes('wanlink_status() { return 1;}') && t.body!.includes('MAC-01'), 'same MAC, same placeholder across answers')
  const big = redactAnswer(JSON.stringify({ a: 'x'.repeat(100_000) }))
  assert.ok(big.truncated && big.body!.length <= 24_000)
  assert.ok(DIAGNOSTIC_HOOKS.every(([, h]) => !SECRET_RE.test(h.replace(/wl[0-3]_|wl_/g, ''))), 'the read never asks for a secret by name')
})

test('diagnostics end to end: admin read, every hook on its own, nothing secret or MAC-shaped in the answer, refused while held', async () => {
  assert.equal(requiredRole('GET', '/api/plugins/asus/instances/a12345678/diagnostics'), 'admin')
  assert.equal(needsReconfirm('GET', '/api/plugins/asus/instances/a12345678/diagnostics'), false, 'an admin API token may call it')
  const { fake, svc, store, url, audits } = await setup({ mode: 'ap-main', meshList: true })
  const m = await store.create(await store.prepare(null, { url, username: 'admin', password: 'correct horse' }), 'Mesh main', { model: null, firmware: null })
  const d = await svc.diagnostics(m.id, { ...admin, token: 'ops' })
  assert.equal(d.calls.length, DIAGNOSTIC_HOOKS.length)
  assert.ok(d.calls.every(c => c.status === 'ok'))
  const all = JSON.stringify(d)
  assert.ok(!all.includes('mesh-secret-value') && !all.includes('correct horse') && !/tok\dx/.test(all))
  assert.ok(!/([0-9A-F]{2}[:-]){5}[0-9A-F]{2}/i.test(all) && !/00005E005321/i.test(all))
  assert.ok(d.calls.find(c => c.name === 'aimesh.cfg_clientlist')!.body!.includes('XX-NODE'))
  assert.ok(d.calls.find(c => c.name === 'plugin.mode')!.body!.includes('"sw_mode": "3"'))
  assert.equal(fake.seen.filter(x => x.path === '/applyapp.cgi').length, 0, 'reads only')
  assert.deepEqual(audits.at(-1), { action: 'asus.diagnostics', details: { by: 'admin@example.com', via: 'api:ops', router: 'Mesh main' } })
  await svc.diagnostics(m.id, admin)
  await assert.rejects(svc.diagnostics(m.id, { ...admin, sid: 's-x' }), (e: any) => e.code === 'rate_limited', 'two a minute per router')
  const bad = await setup({ pass: 'other' })
  const b = await bad.store.create(await bad.store.prepare(null, { url: bad.url, username: 'admin', password: 'wrong' }), 'R', { model: null, firmware: null })
  await assert.rejects(bad.svc.reading(b.id))
  await assert.rejects(bad.svc.diagnostics(b.id, admin), (e: any) => e.code === 'login_held')
  assert.equal(bad.fake.logins(), 1)
})

// ── real firmware: one hook per request, AiMesh ──────────────────────────────
//
// test/fixtures/asus/*-mode.json are real answers from an Asuswrt 388 build (one unit in router mode leading a
// three-unit AiMesh network, one in access-point mode), anonymised: names, SSIDs, addresses, vendors, models and
// firmware numbers replaced, MACs in the documentation range. That build answered nvram values only one per
// request, so the nvram values below are constructed in the shape it uses, not captured.

import { readHooks } from '../src/lib/asus/service'
import { parseMesh, hookKey, staticHooks, radioCount } from '../src/lib/asus/parse'
import type { AsusRequest, AsusResponse } from '../src/lib/asus/transport'

const FX = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'asus', `${name}-mode.json`), 'utf8'))

/** A router that, like that firmware, answers only the first hook of a semicolon list. */
class OneHookRouter implements AsusTransport {
  sent: string[] = []
  private ticks = 0
  constructor(private fx: any, private nv: Record<string, string>) {}
  async send(r: AsusRequest): Promise<AsusResponse> {
    const j = (v: unknown) => ({ status: 200, text: typeof v === 'string' ? v : JSON.stringify(v) })
    if (r.path === '/login.cgi') return j({ asus_token: 'tok1' })
    if (r.path === '/Logout.asp') return j('')
    const hook = decodeURIComponent((r.body ?? '').replace(/^hook=/, ''))
    this.sent.push(hook)
    const first = hook.split(';')[0]
    const k = hookKey(first)!
    if (first.startsWith('nvram_get(')) return j({ [k]: this.nv[k] ?? '' })
    if (first === 'cpu_usage(appobj)') {
      const n = ++this.ticks, c = { ...this.fx.cpu_usage.cpu_usage }
      for (let i = 1; c[`cpu${i}_total`]; i++) { c[`cpu${i}_total`] = String(Number(c[`cpu${i}_total`]) + n * 1000); c[`cpu${i}_usage`] = String(Number(c[`cpu${i}_usage`]) + n * 250) }
      return j({ cpu_usage: c })
    }
    const by: Record<string, unknown> = {
      'uptime()': this.fx.uptime, 'memory_usage(appobj)': this.fx.memory_usage, 'netdev(appobj)': this.fx.netdev,
      'wl_control_channel()': this.fx.wl_control_channel, 'wanlink()': this.fx.wanlink, 'get_clientlist()': this.fx.get_clientlist,
      'get_cfg_clientlist()': this.fx.get_cfg_clientlist, 'get_allclientlist()': this.fx.get_allclientlist, 'get_wan_unit()': { get_wan_unit: '0' },
    }
    return j(by[first] ?? {})
  }
}

const NV = (mode: 'router' | 'ap') => ({
  productid: mode === 'router' ? 'XX-MESH9' : 'XX-AP7', odmpid: '', firmver: '3.0.0.4', buildno: '388', extendno: '20971-gabc1234', '3rd-party': '',
  webs_state_flag: '0', webs_state_info: '', sw_mode: mode === 'router' ? '1' : '3', re_mode: '0', cfg_master: '1', wlc_psta: '0',
  lan_gateway: mode === 'router' ? '' : '10.9.8.1', wl_ifnames: 'eth4 eth5 eth6',
  wl0_ssid: 'ExampleNet', wl0_nband: '2', wl0_radio: '1', wl0_chanspec: '0', wl0_bw: '1',
  wl1_ssid: 'ExampleNet', wl1_nband: '1', wl1_radio: '1', wl1_chanspec: '149/80', wl1_bw: '3',
  wl2_ssid: 'ExampleNet_6G', wl2_nband: '4', wl2_radio: '1', wl2_chanspec: '0', wl2_bw: '5',
})

async function fixtureService(mode: 'router' | 'ap') {
  const fx = FX(mode)
  const router = new OneHookRouter(fx, NV(mode))
  let clock = 1_700_000_000_000
  const store = new AsusInstanceStore(memoryIO(), async () => '10.9.8.2')
  const svc = new AsusService({ store, audit: async () => {}, transportFor: () => router, now: () => clock, sleep: async ms => { clock += ms } })
  const m = await store.create(await store.prepare(null, { url: 'http://10.9.8.2', username: 'admin', password: 'correct horse' }), 'Unit', { model: null, firmware: null })
  return { fx, router, svc, m, tick: (ms: number) => { clock += ms } }
}

test('readHooks: one list on a firmware that answers lists, one hook per call on one that answers only the first', async () => {
  const hooks = ['nvram_get(a)', 'nvram_get(b)', 'uptime()']
  const all = { calls: [] as string[], hook: async (h: string) => { all.calls.push(h); return JSON.stringify(Object.fromEntries(h.split(';').map(x => [hookKey(x), 'v']))) } }
  const r1 = await readHooks(all as any, hooks, undefined)
  assert.deepEqual(r1, { values: { a: 'v', b: 'v', uptime: 'v' }, multi: true })
  assert.equal(all.calls.length, 1)
  const one = { calls: [] as string[], hook: async (h: string) => { one.calls.push(h); const f = h.split(';')[0]; return JSON.stringify({ [hookKey(f)!]: 'v' }) } }
  const r2 = await readHooks(one as any, hooks, undefined)
  assert.deepEqual(r2, { values: { a: 'v', b: 'v', uptime: 'v' }, multi: false })
  assert.deepEqual(one.calls, ['nvram_get(a);nvram_get(b);uptime()', 'nvram_get(b)', 'uptime()'])
  one.calls = []
  await readHooks(one as any, hooks, false)
  assert.deepEqual(one.calls, hooks, 'once known, no list is sent')
  const fail = { hook: async (h: string) => { if (h === 'nvram_get(b)') throw new Error('one bad call'); return JSON.stringify({ [hookKey(h.split(';')[0])!]: 'v' }) } }
  assert.deepEqual((await readHooks(fail as any, hooks, false)).values, { a: 'v', uptime: 'v' }, 'a single failing hook costs only its value')
  const locked = { hook: async () => { throw new AsusLoginError('refused', 'refused') } }
  await assert.rejects(readHooks(locked as any, hooks, false), (e: any) => e instanceof AsusLoginError)
  assert.equal(radioCount({ wl_ifnames: 'eth4 eth5 eth6' }), 3)
  assert.equal(radioCount({}), 4)
  assert.equal(staticHooks(3).filter(h => /wl\d_/.test(h)).length, 15)
})

test('real firmware, router mode: firmware, uptime, CPU, RAM, three radios, clients and the AiMesh network', async () => {
  const { router, svc, m, tick } = await fixtureService('router')
  const r = await svc.reading(m.id)
  assert.deepEqual(r.mode, { kind: 'router', label: 'Router · AiMesh main', aimesh: 'main' })
  assert.equal(r.model, 'XX-MESH9')
  assert.deepEqual(r.firmware, { version: '3.0.0.4.388_20971', flavour: 'stock' })
  assert.equal(r.update.available, false)
  assert.ok(r.uptimeSec! > 100_000)
  assert.equal(r.cpuCores, 4)
  assert.ok(r.cpuPct !== null && r.cpuPct > 0 && r.cpuPct <= 100, `cpu ${r.cpuPct}`)
  assert.equal(r.mem!.pct, Math.round((366052 / 524288) * 100))
  assert.deepEqual(r.bands.map(b => [b.label, b.ssid, b.channel, b.widthMhz]), [['2.4 GHz', 'ExampleNet', '3', 20], ['5 GHz', 'ExampleNet', '153', 80], ['6 GHz', 'ExampleNet_6G', '197', 160]])
  assert.ok(r.devices.length >= 15, `devices ${r.devices.length}`)
  assert.ok(r.bands.reduce((t, b) => t + b.clients, 0) > 0, 'clients per band')
  assert.equal(r.wan.up, true); assert.equal(r.wan.type, 'dhcp')
  assert.ok(r.wan.downBps !== null, 'live rates from INTERNET counters')
  assert.deepEqual(r.missing, [])
  // The mesh: main first, then each node with its backhaul, signal and clients.
  assert.equal(r.mesh.length, 3)
  assert.deepEqual(r.mesh.map(n => [n.name, n.main, n.backhaul, n.rssi, n.online]), [['Main unit', true, null, null, true], ['Garage', false, '5 GHz', -51, true], ['Upstairs', false, '5 GHz', -51, true]])
  assert.ok(r.mesh.every(n => n.clients >= 0) && r.mesh[0].clients > r.mesh[1].clients)
  assert.equal(r.mesh[0].firmware, '3.0.0.4.388_20971')
  assert.ok(r.devices.some(d => d.node === 'Upstairs') && r.devices.some(d => d.node === 'Main unit'), 'each device says which unit it is on')
  assert.equal(r.health.level, 'good')
  // After the first reading the firmware is known as one-hook: no more lists, and the slow values are not re-read.
  router.sent = []
  tick(10_000)
  await svc.reading(m.id)
  assert.ok(!router.sent.some(h => h.includes(';')), 'no lists once known')
  assert.ok(!router.sent.some(h => h.startsWith('nvram_get(')), 'firmware, mode and radio settings come from the 5-minute cache')
  assert.ok(router.sent.length <= 10, `${router.sent.length} calls for a warm reading`)
  // A viewer sees the mesh without addresses or MAC-derived anything.
  const v = viewerReading(r)
  assert.ok(v.mesh.every(n => n.ip === null))
  assert.ok(!/00:00:5E|10\.9\.8\./i.test(JSON.stringify(v)))
})

test('real firmware, access point mode: no WAN, no alarm, radios and clients read, no mesh when the list is empty', async () => {
  const { svc, m, router } = await fixtureService('ap')
  const r = await svc.reading(m.id)
  assert.deepEqual(r.mode, { kind: 'ap', label: 'Access point · AiMesh main', aimesh: 'main' })
  assert.equal(r.health.level, 'good')
  assert.equal(r.wan.up, null)
  assert.deepEqual(r.uplink, { gateway: '10.9.8.1' })
  assert.equal(r.firmware.version, '3.0.0.4.388_20971')
  assert.ok(r.uptimeSec! > 1_000_000)
  assert.ok(r.cpuPct !== null)
  assert.equal(r.mem!.pct, Math.round((265000 / 524288) * 100))
  assert.deepEqual(r.bands.map(b => [b.label, b.channel]), [['2.4 GHz', '1'], ['5 GHz', '149'], ['6 GHz', 'auto']])
  assert.ok(r.devices.length >= 15, `devices ${r.devices.length}`)
  assert.deepEqual(r.mesh, [])
  assert.ok(!router.sent.includes('wanlink()'), 'an access point is not asked about a WAN it does not use')
  assert.ok(!router.sent.includes('get_allclientlist()'), 'nor for mesh clients when it leads no mesh')
})

test('mesh parsing: backhaul from re_path bits, wired, offline, and nothing for an empty list', () => {
  assert.deepEqual(parseMesh([], {}, 'a'), { nodes: [], byMac: new Map(), main: null })
  assert.deepEqual(parseMesh(undefined, undefined, 'a').nodes, [])
  const nodes = parseMesh([
    { alias: 'Hub', mac: '00:00:5E:00:53:01', level: '0', re_path: '0', online: '1', ui_model_name: 'XX-MESH9', fwver: '3.0.0.4.388_1-gabc', newfwver: '' },
    { alias: 'Den', mac: '00:00:5E:00:53:02', level: '1', re_path: '1', online: '1', fwver: '' },
    { alias: 'Loft', mac: '00:00:5E:00:53:03', level: '1', re_path: '16', rssi6g: '-70', online: '0', newfwver: '3.0.0.4.388_2-gdef' },
    { alias: 'bad', mac: 'nope' },
  ], { '00:00:5E:00:53:01': { '2G': { x: {}, y: {} }, wired_mac: { z: {} } }, '00:00:5E:00:53:02': { '5G': ['p', 'q'] } }, 'a').nodes
  assert.deepEqual(nodes.map(n => [n.name, n.main, n.backhaul, n.rssi, n.online, n.clients, n.update]), [
    ['Hub', true, null, null, true, 3, null], ['Den', false, 'wired', null, true, 2, null], ['Loft', false, '6 GHz', -70, false, 0, '3.0.0.4.388_2'],
  ])
})
