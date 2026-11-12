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
  looseJson, counter, connectSeconds, barsOf, type CounterSample,
} from '../src/lib/asus/parse'
import { AsusInstanceStore, cleanUrl, type CredentialIO } from '../src/lib/asus/instances'
import { AsusService, confirmPhrase, type Actor } from '../src/lib/asus/service'
import { checkAsusAddresses } from '../src/lib/asus/target'
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
async function setup(over: Parameters<typeof fakeRouter>[0] = {}, o: { tls?: { key: Buffer; cert: Buffer }; probe?: (url: string) => Promise<string> } = {}) {
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
    assert.ok(s.lines.some(l => /Home router: healthy/.test(l)))
    assert.ok(s.lines.some(l => /Wi-Fi 5 GHz "Example Net 5G": channel 36, 1 client/.test(l)))
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
    assert.equal(needsReconfirm(m, p, { tokenPluginScope: true }), true, 'no token permission lifts it')
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
  void tick
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
  const probe = async (u: string) => (await probeCertificate('127.0.0.1', Number(new URL(u).port))).fingerprint
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

  // Clearing the pin on an https router pins again on the next save (first use again).
  const edited = await s.svc.edit(meta.id, { fingerprint: '' }, admin)
  assert.equal(edited.pinnedNow, true)
  assert.equal(edited.meta.fingerprint, fpA)
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
