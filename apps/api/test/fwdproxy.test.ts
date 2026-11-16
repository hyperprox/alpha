// 3proxy forward proxy: the recipe and its option checks (networks masked by their prefix and kept inside a private
// block), the install script (valid bash, pinned and checksummed, safe to send), the helper's output parsed from
// recordings of a real install (addresses and names invented), the service (vault first, then the guest; rollback, but
// not on a timeout; the leave-alone rule; auto-connect), the install's self-check step, the plug-in card and detail
// (no users or client addresses), and the role and re-confirm rules for every fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { CATALOGUE, checkOptions, findRecipe } from '../src/lib/catalogue'
import { installScript } from '../src/lib/install-script'
import { proxyScript, THREEPROXY_VERSION, THREEPROXY_SHA256, HELPER_SCRIPT } from '../src/lib/fwdproxy/scripts'
import { checkNetworks, isPrivateV4, networkProblem, userProblem } from '../src/lib/fwdproxy/net'
import { parseStats, parseSelfTest } from '../src/lib/fwdproxy/parse'
import { FwdProxyService, FwdProxyRefusal, selfTestScript, PROBE_SCRIPT, type FwdDeps, type GuestRow, type InstallRow } from '../src/lib/fwdproxy/service'
import { runFwdProxySetup, proxyUrl } from '../src/lib/fwdproxy/setup'
import type { ProxyInstance } from '../src/lib/fwdproxy/types'
import { tileOf, detailOf } from '../src/plugins/threeproxy'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { assertSafeScript } from '../src/lib/clusters/script-guard'
import { SYSTEM_ACTOR, type AdapterContext } from '../src/lib/auto-connect/core'

// Recorded from a real install; every address and name in them is rewritten to an invented one.
const fx = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'fwdproxy', name), 'utf8')
const STATS = fx('3proxy-stats.txt'), SELFTEST_OK = fx('3proxy-selftest.txt'), SELFTEST_STOPPED = fx('3proxy-selftest-stopped.txt')

// ── the recipe ─────────────────────────────────────────────────────────────

test('3proxy is in the Catalogue, locked down, with a generated first user and its own setup', () => {
  const r = findRecipe('3proxy')!
  assert.equal(r.category, 'forward-proxy')
  assert.equal(r.setup, 'fwdproxy')
  assert.equal(r.wizard, false, 'the AI assistant cannot hand the password back')
  assert.deepEqual(r.firstRun, { kind: 'env-admin', user: 'proxyuser', userOption: 'FP_USER', passwordEnv: 'FP_PASSWORD' })
  assert.equal(r.needsDocker, false)
  assert.equal(r.options!.find(o => o.key === 'FP_LAN_TARGETS')!.default, '0', 'your network is refused unless you say so')
  assert.ok(r.notes!.some(n => /forward a port/i.test(n)), 'warns against forwarding a port to it')
  assert.ok(r.notes!.some(n => /256 connections/.test(n)), 'says the cap it really has')
  assert.deepEqual(CATALOGUE.filter(x => x.category === 'forward-proxy').map(x => x.id), ['3proxy'])
})

test('options: defaults pass; networks are masked by their prefix and must stay inside a private block', () => {
  const r = findRecipe('3proxy')!
  const ok = checkOptions(r, {})
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.values.FP_USER, 'proxyuser')
  assert.equal(ok.values.FP_ALLOW, '', 'blank: the container\'s own network, worked out in the container')
  assert.equal(checkOptions(r, { FP_ALLOW: '10.0.0.0/8, 10.40.0.0/16;172.16.0.0/12' }).values.FP_ALLOW, '10.0.0.0/8 10.40.0.0/16 172.16.0.0/12')
  for (const bad of ['192.168.0.0/8', '172.16.0.0/8', '172.16.0.0/11', '192.168.1.0/8', '10.0.0.0/7', '10.0.0.5/24', '010.0.0.0/8',
    '0.0.0.0/0', '198.51.100.0/24', '8.8.8.8/32', '300.1.1.0/24', '192.168.1.1']) {
    assert.ok(checkOptions(r, { FP_ALLOW: bad }).errors.length, bad)
  }
  for (const good of ['10.0.0.0/8', '172.16.0.0/12', '192.168.1.0/24', '172.31.0.0/16', '10.20.30.40/32']) {
    assert.deepEqual(checkOptions(r, { FP_ALLOW: good }).errors, [], good)
  }
  assert.match(networkProblem('192.168.0.0/8')!, /host bits set: write the network address, 192\.0\.0\.0\/8/)
  assert.match(networkProblem('10.0.0.0/7')!, /too wide: it reaches outside 10\.0\.0\.0\/8/)
  assert.match(networkProblem('198.51.100.0/24')!, /not a private network/)
  assert.ok(checkOptions(r, { FP_USER: 'root' }).errors.length, 'root is never a proxy user')
  assert.ok(checkOptions(r, { FP_HTTP: '0', FP_SOCKS: '0' }).errors.length, 'one protocol at least')
})

test('the guest checks the networks the same way (the helper\'s own check_allow, run in bash)', () => {
  const one = (n: string) => new RegExp(`^${n}\\(\\) \\{.*\\}$`, 'm').exec(HELPER_SCRIPT)![0]
  const block = (n: string) => new RegExp(`^${n}\\(\\) \\{\\n[\\s\\S]*?\\n\\}`, 'm').exec(HELPER_SCRIPT)![0]
  const fns = [one('die'), block('check_allow')].join('\n')
  const run = (c: string) => spawnSync('bash', ['-c', `${fns}\ncheck_allow "$1"`, 'x', c], { encoding: 'utf8' }).status
  for (const bad of ['192.168.0.0/8', '172.16.0.0/8', '172.16.0.0/11', '192.168.1.0/8', '192.168.1.5/24', '8.8.8.0/24', '0.0.0.0/0', '010.0.0.0/8']) assert.notEqual(run(bad), 0, bad)
  for (const good of ['10.0.0.0/8', '172.16.0.0/12', '192.168.1.0/24', '10.0.5.0/24 192.168.0.0/16']) assert.equal(run(good), 0, good)
})

test('net: private addresses only, user names checked', () => {
  for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.0.1']) assert.equal(isPrivateV4(ip), true, ip)
  for (const ip of ['172.15.0.1', '172.32.0.1', '192.0.2.1', '100.64.0.1', '8.8.8.8', 'example', '10.0.0.256']) assert.equal(isPrivateV4(ip), false, ip)
  assert.equal(checkNetworks('', { allowEmpty: false }).problems.length, 1)
  assert.equal(checkNetworks(Array.from({ length: 33 }, (_, i) => `10.${i}.0.0/16`).join(','), { allowEmpty: false }).problems[0], 'Give at most 32 networks.')
  assert.equal(userProblem('laptop-2'), null)
  assert.ok(userProblem('Laptop'))
  assert.ok(userProblem('www-data'))
})

// ── the scripts ────────────────────────────────────────────────────────────

test('the install script: valid bash, safe to send, pinned and checksummed, private address only', () => {
  const s = installScript(findRecipe('3proxy')!, 'debian', { FP_PASSWORD: 'x'.repeat(24) })
  assert.equal(spawnSync('bash', ['-n'], { input: s }).status, 0, 'valid bash')
  assertSafeScript(s)
  assert.match(THREEPROXY_VERSION, /^\d+(\.\d+)+$/)
  assert.match(THREEPROXY_SHA256, /^[0-9a-f]{64}$/)
  assert.ok(s.includes(THREEPROXY_SHA256) && /sha256sum -c/.test(s), 'the download is checked')
  assert.ok(!/latest/i.test(s), 'nothing unpinned')
  assert.match(s, /is_private "\$LISTEN_IP"/, 'refuses a public address')
  assert.ok(!/0\.0\.0\.0:|-i0\.0\.0\.0/.test(s), 'never binds every interface')
  assert.ok(!/\/tmp\/\.hpx|\$\$/.test(s), 'no predictable temporary name')
  assert.match(s, /export -n FP_PASSWORD/, 'the password stays out of children\'s environments')
  assert.ok(s.includes('${LISTEN_IP%/*}') || s.includes('${ADDR%/*}'), 'shell expansions survive the template')
  assert.ok(s.includes(HELPER_SCRIPT), 'the helper is embedded verbatim (no replacement patterns read into it)')
  assert.equal(s, installScript(findRecipe('3proxy')!, 'debian', { FP_PASSWORD: 'x'.repeat(24) }))
  assert.ok(proxyScript().length > 1000)
  assert.throws(() => installScript(findRecipe('3proxy')!, 'debian', {}), /FP_PASSWORD/, 'never installed without the generated password')
})

test('the helper: the rules, exact user names, emptied logs, escaped self-check login', () => {
  assert.equal(spawnSync('bash', ['-n'], { input: HELPER_SCRIPT }).status, 0, 'valid bash')
  assert.match(HELPER_SCRIPT, /auth strong/)
  assert.match(HELPER_SCRIPT, /allow \* \$\(echo "\$ALLOW" \| tr ' ' ','\) \* 443 HTTPS/, 'HTTPS tunnels only to 443')
  assert.match(HELPER_SCRIPT, /deny \* \* \* 25/, 'SOCKS never to port 25')
  assert.match(HELPER_SCRIPT, /maxconn 256/, 'the cap the notes promise')
  assert.match(HELPER_SCRIPT, /http:\/\/localhost\//, 'the self-check asks for localhost by name')
  assert.ok(!/grep -v "\^\$name:"|grep -x "\$name"/.test(HELPER_SCRIPT), 'user names are never patterns')
  assert.match(HELPER_SCRIPT, /grep -Fx -- "\$name"/)
  assert.match(HELPER_SCRIPT, /awk -F: -v n="\$1" '\$1 != n'/)
  assert.match(HELPER_SCRIPT, /forget_clients/, 'per-user figures off empties the log written so far')
  // The self-check's curl config: a password with " or \ must stay one quoted value.
  const esc = /local q=.*\n/.exec(HELPER_SCRIPT)![0]
  const out = spawnSync('bash', ['-c', `f() { pw='a\\b"c'; ${esc} printf '%s' "$q"; }; f`], { encoding: 'utf8' }).stdout
  assert.equal(out, 'a\\\\b\\"c')
})

test('the self-check and probe scripts carry only checked values', () => {
  assert.match(selfTestScript('proxyuser', 'Abc_def-123456789012'), /selftest 'proxyuser' <<'HPX_PW'\nAbc_def-123456789012\nHPX_PW$/)
  assert.throws(() => selfTestScript('proxyuser', "x'; rm -rf / #"), FwdProxyRefusal)
  assert.throws(() => selfTestScript('Bad User', 'Abc_def-123456789012'), FwdProxyRefusal)
  assertSafeScript(PROBE_SCRIPT)
  assert.equal(spawnSync('bash', ['-n'], { input: PROBE_SCRIPT }).status, 0)
})

// ── parsing (recorded from a real install) ─────────────────────────────────

test('stats: connections per protocol, traffic, refusals in words, users', () => {
  const r = parseStats(STATS)
  assert.equal(r.active, true)
  assert.equal(r.version, THREEPROXY_VERSION)
  assert.equal(r.listen, '10.20.30.37')
  assert.deepEqual(r.allow, ['10.20.30.0/24'])
  assert.equal(r.perMinute.length, 60, 'one bucket per minute, zeros included')
  assert.deepEqual(r.users, ['alice'])
  assert.ok(r.services.some(s => s.name === 'HTTP') && r.services.some(s => s.name === 'SOCKS'))
  assert.equal(r.conns.http, 0)
  assert.equal(r.conns.socks, 0)
  assert.ok(r.totals.requests > 0 && r.totals.denied > 0 && r.totals.bytes > 0)
  assert.ok(r.denied.some(d => d.code === '1' && d.label === 'Blocked by a rule'))
  assert.ok(r.denied.some(d => d.code === '4' && d.label === 'No or wrong password'))
  assert.ok(r.byClient.some(c => c.address === '10.20.30.55'))
})

test('parse drops what does not fit, and per-user figures off means none are shown', () => {
  const r = parseStats('meta\tnow\t600000\nmeta\tminutes\t5\ncfg\tperclient\t0\ncfg\tsocks\t0\nwho\tuser\talice\t3\t100\nuser\tRoot User\nmin\tx\t1\t1\ntot\trequests\tabc\ndeny\tx;y\t3\n')
  assert.deepEqual(r.byUser, [])
  assert.deepEqual(r.users, [])
  assert.deepEqual(r.denied, [])
  assert.equal(r.totals.requests, 0)
  assert.equal(r.perMinute.length, 5)
  assert.equal(r.conns.socks, null, 'a protocol that is off has no count')
})

test('self-check output, recorded running and stopped', () => {
  const ok = parseSelfTest(SELFTEST_OK)
  assert.equal(ok.length, 12)
  assert.ok(ok.every(c => c.state === 'ok'))
  for (const id of ['running', 'http_auth', 'connect_443', 'localhost', 'lan', 'socks_auth', 'socks_localhost', 'socks_lan']) assert.ok(ok.some(c => c.id === id), id)
  assert.deepEqual(parseSelfTest(SELFTEST_STOPPED).map(c => [c.id, c.state]), [['running', 'fail']])
})

// ── the service ────────────────────────────────────────────────────────────

interface World { deps: FwdDeps; scripts: string[]; vault: Record<string, Record<string, string>>; audits: Array<[string, string, any]>; store: Map<string, ProxyInstance>; guests: GuestRow[]; installs: InstallRow[]; fail: RegExp | null; dismissed: string[] }

const V = 'apps/3proxy-210'

function world(o: { tags?: string[]; excluded?: string[] } = {}): World {
  const w: World = {
    scripts: [], vault: { [V]: { admin_user: 'alice', admin_password: 'Abc_def-123456789012' } }, audits: [], store: new Map(), dismissed: [],
    guests: [{ type: 'lxc', vmid: 210, node: 'n1', name: 'proxy', running: true, tags: o.tags ?? [] }],
    installs: [{ recipeId: '3proxy', vmid: 210, status: 'completed', hostname: 'proxy', ip: '10.20.30.37/24', vaultItem: { category: 'apps', provider: '3proxy-210' } }],
    fail: null, deps: null as any,
  }
  let n = 0
  w.deps = {
    store: { get: async id => structuredClone(w.store.get(id) ?? null), put: async i => { w.store.set(i.id, structuredClone(i)) }, list: async () => [...w.store.values()], delete: async id => { w.store.delete(id) } },
    guests: async () => w.guests,
    exclusions: async () => o.excluded ?? [],
    exec: async (_g, script) => {
      w.scripts.push(script)
      assertSafeScript(script)
      if (w.fail && w.fail.test(script)) return { code: 1, output: '3proxy did not start again.' }
      if (script === PROBE_SCRIPT) return { code: 0, output: 'kind=3proxy\nlisten=10.20.30.37\n' }
      if (/ stats /.test(script)) return { code: 0, output: STATS }
      if (/ selftest /.test(script)) return { code: 0, output: SELFTEST_OK }
      return { code: 0, output: 'ok\n' }
    },
    installs: async () => w.installs,
    vault: {
      read: async (c, p) => ({ ...(w.vault[`${c}/${p}`] ?? {}) }),
      set: async (c, p, k, v) => { (w.vault[`${c}/${p}`] ??= {})[k] = v },
      delete: async (c, p, k) => { delete w.vault[`${c}/${p}`]?.[k] },
    },
    audit: async (a, r, d) => { w.audits.push([a, r, d]) },
    dismissed: async key => { w.dismissed.push(key) },
    now: () => 1_000_000,
    password: () => `Pw_${String(++n).padStart(20, '0')}`,
  }
  return w
}

const ctx = (w: World, o: Partial<AdapterContext> = {}): AdapterContext => ({
  dismissed: () => false, autoConnectedBefore: () => false, excludedMachines: new Set(), excludedSubnets: [], vaultItems: () => [],
  audit: async (a, r, d) => { w.audits.push([a, r, { ...d, by: SYSTEM_ACTOR }]) }, now: () => 1_000_000, ...o,
})

const admin = { email: 'owner@example.com', role: 'admin' }

test('auto-connect: a finished Catalogue install is looked at read-only once, then connected and audited', async () => {
  const w = world()
  const svc = new FwdProxyService(w.deps)
  assert.deepEqual((await svc.autoConnect(ctx(w))).map(o => o.did), ['connected'])
  assert.deepEqual(w.scripts, [PROBE_SCRIPT], 'only the read-only probe ran')
  const i = (await svc.instances())[0]
  assert.equal(i.vmid, 210)
  assert.equal(i.listen, '10.20.30.37')
  assert.deepEqual(i.vault, { category: 'apps', provider: '3proxy-210' })
  assert.equal(w.audits[0][0], 'plugin.auto_connect')
  assert.equal(w.audits[0][2].by, SYSTEM_ACTOR)
  assert.deepEqual((await svc.autoConnect(ctx(w))).map(o => o.did), ['present'])
})

test('auto-connect: dismissed, tagged, excluded subnet, listed and a reused VMID are never connected', async () => {
  for (const [w, c, want] of [
    [world(), (w: World) => ctx(w, { dismissed: () => true }), 'dismissed'],
    [world({ tags: ['hyperprox-ignore'] }), (w: World) => ctx(w), 'excluded'],
    [world(), (w: World) => ctx(w, { excludedSubnets: ['10.20.30.0/24'] }), 'excluded'],
    [world(), (w: World) => ctx(w, { excludedMachines: new Set(['lxc-210']) }), 'excluded'],
  ] as Array<[World, (w: World) => AdapterContext, string]>) {
    assert.deepEqual((await new FwdProxyService(w.deps).autoConnect(c(w))).map(o => o.did), [want])
    assert.deepEqual(w.scripts, [], 'the guest is never entered')
  }
  const reused = world()
  reused.guests[0].name = 'someone-else'
  assert.deepEqual(await new FwdProxyService(reused.deps).autoConnect(ctx(reused)), [], 'a reused VMID is not this install')
  const other = world()
  other.installs[0].recipeId = 'nextcloud'
  assert.deepEqual(await new FwdProxyService(other.deps).autoConnect(ctx(other)), [], 'another app\'s install is not a proxy')
})

async function connected(o: Parameters<typeof world>[0] = {}) {
  const w = world(o)
  const svc = new FwdProxyService(w.deps)
  w.store.set('lxc-210', { id: 'lxc-210', vmid: 210, node: 'n1', name: 'proxy', listen: '10.20.30.37', vault: { category: 'apps', provider: '3proxy-210' }, addedAt: 1, addedBy: 'x' })
  return { w, svc }
}

test('a new user: password to the vault first, then the guest, audited; never in the answer', async () => {
  const { w, svc } = await connected()
  const r = await svc.setUser('lxc-210', 'laptop', admin)
  assert.equal(r.vaultItem, 'hyperprox:apps/3proxy-210')
  assert.equal(r.field, 'user_laptop')
  const pw = w.vault[V].user_laptop
  assert.match(pw, /^Pw_/)
  assert.ok(!JSON.stringify(r).includes(pw), 'the password is not in the answer')
  assert.match(w.scripts.find(s => /user-add/.test(s))!, /user-add 'laptop' <<'HPX_PW'/)
  assert.ok(w.audits.some(([a, , d]) => a === 'fwdproxy.user_add' && d.user === 'laptop' && !JSON.stringify(d).includes(pw)))
  await assert.rejects(svc.setUser('lxc-210', 'alice', admin), /already exists/)
  await assert.rejects(svc.setUser('lxc-210', 'root', admin), /reserved/)
  await assert.rejects(svc.setUser('lxc-210', "a'b", admin), /lowercase/)
})

test('a user the guest refused is taken back out of the vault; a reset keeps the old password on failure', async () => {
  const { w, svc } = await connected()
  w.fail = /user-add/
  await assert.rejects(svc.setUser('lxc-210', 'laptop', admin), /did not start/)
  assert.equal(w.vault[V].user_laptop, undefined)
  await assert.rejects(svc.setUser('lxc-210', 'alice', admin, { reset: true }))
  assert.equal(w.vault[V].admin_password, 'Abc_def-123456789012', 'the old password stands')
  w.fail = null
  await svc.setUser('lxc-210', 'alice', admin, { reset: true })
  assert.notEqual(w.vault[V].admin_password, 'Abc_def-123456789012', 'the first user keeps admin_password')
})

test('a password change that times out keeps the vault and offers a new password', async () => {
  const { w, svc } = await connected()
  const exec = w.deps.exec
  w.deps.exec = async (g, s, t) => (/user-add 'laptop'/.test(s) ? { code: -1, output: '', timedOut: true } : exec(g, s, t))
  await assert.rejects(svc.setUser('lxc-210', 'laptop', admin), /may or may not have changed/)
  assert.match(w.vault[V].user_laptop, /^Pw_/, 'not rolled back: the guest may have it')
  assert.deepEqual(w.store.get('lxc-210')!.uncertain, ['laptop'])
  w.deps.exec = async (g, s, t) => (/ stats /.test(s) ? { code: 0, output: STATS.replace('user\talice\n', 'user\talice\nuser\tlaptop\n') } : exec(g, s, t))
  assert.equal((await svc.problems('lxc-210')).find(x => x.id === 'uncertain_laptop')!.fix!.id, 'reset_user')
  await svc.setUser('lxc-210', 'laptop', admin, { reset: true })
  assert.deepEqual(w.store.get('lxc-210')!.uncertain, [], 'a new password settles it')
})

test('removing a user removes its vault entry; settings are checked before the guest is touched', async () => {
  const { w, svc } = await connected()
  w.vault[V].user_bob = 'x'
  await svc.removeUser('lxc-210', 'bob', admin)
  assert.match(w.scripts.at(-1)!, /user-del 'bob'$/)
  assert.equal(w.vault[V].user_bob, undefined)
  const before = w.scripts.length
  await assert.rejects(svc.saveSettings('lxc-210', { allow: '0.0.0.0/0' }, admin), /not a private network/)
  await assert.rejects(svc.saveSettings('lxc-210', { allow: '192.168.0.0/8' }, admin), /host bits/)
  await assert.rejects(svc.saveSettings('lxc-210', { lanTargets: 'yes' }, admin), FwdProxyRefusal)
  await assert.rejects(svc.saveSettings('lxc-210', {}, admin), /Nothing/)
  assert.equal(w.scripts.length, before, 'nothing ran')
  await svc.saveSettings('lxc-210', { allow: ['10.20.30.0/24', '10.40.0.0/16'], lanTargets: false, perClient: false }, admin)
  assert.ok(w.scripts.some(s => s === "/usr/local/sbin/hpx-fwdproxy set ALLOW '10.20.30.0/24 10.40.0.0/16'"))
  assert.ok(w.scripts.some(s => s === "/usr/local/sbin/hpx-fwdproxy set LAN_TARGETS '0'"))
  assert.ok(w.audits.some(([a]) => a === 'fwdproxy.settings'))
})

test('actions: reload and the self-check, audited; unknown refused; the leave-alone rule', async () => {
  const { w, svc } = await connected()
  assert.match((await svc.action('lxc-210', 'reload', admin)).message, /started again/)
  assert.equal((await svc.action('lxc-210', 'selftest', admin)).message, 'Every check passed.')
  assert.ok(w.scripts.some(s => /selftest 'alice'/.test(s)))
  await assert.rejects(svc.action('lxc-210', 'clear_cache', admin), /not something/)
  await assert.rejects(svc.action('lxc-999', 'reload', admin), /not connected/)
  for (const a of ['fwdproxy.reload', 'fwdproxy.selftest']) assert.ok(w.audits.some(([x]) => x === a), a)
  const tagged = await connected({ tags: ['hyperprox-ignore'] })
  await assert.rejects(tagged.svc.action('lxc-210', 'reload', admin), /left alone/)
  assert.deepEqual(tagged.w.scripts, [])
  const listed = await connected({ excluded: ['lxc-210'] })
  await assert.rejects(listed.svc.reading('lxc-210'), /left alone/)
})

test('the self-check signs in as another user once the first one is gone', async () => {
  const { w, svc } = await connected()
  delete w.vault[V].admin_password
  w.vault[V].user_laptop = 'Lap_top-123456789012'
  const exec = w.deps.exec
  w.deps.exec = async (g, s, t) => (/ stats /.test(s) ? { code: 0, output: STATS.replace('user\talice\n', 'user\tlaptop\n') } : exec(g, s, t))
  await svc.action('lxc-210', 'selftest', admin)
  assert.ok(w.scripts.some(s => /selftest 'laptop' <<'HPX_PW'\nLap_top-123456789012/.test(s)))
  delete w.vault[V].user_laptop
  await assert.rejects(svc.action('lxc-210', 'selftest', admin), /No proxy user has its password in the vault/)
})

test('problems: each has a fix', async () => {
  const { w, svc } = await connected()
  w.deps.exec = async (_g, s) => (/ stats /.test(s) ? { code: 0, output: STATS.replace('meta\tactive\tactive', 'meta\tactive\tinactive').replace('cfg\tlan\t0', 'cfg\tlan\t1') } : { code: 0, output: '' })
  const p = await svc.problems('lxc-210')
  assert.ok(p.length >= 2)
  assert.ok(p.every(x => x.fix), 'every problem has a fix button')
  assert.equal(p.find(x => x.id === 'stopped')!.fix!.id, 'reload')
  assert.equal(p.find(x => x.id === 'lan_open')!.fix!.id, 'block_lan')
  delete w.vault[V].admin_password
  assert.equal((await svc.problems('lxc-210')).find(x => x.id === 'no_vault_alice')!.fix!.id, 'reset_user')
})

test('disconnect remembers the dismissal and keeps the proxy running', async () => {
  const { w, svc } = await connected()
  await svc.disconnect('lxc-210', admin)
  assert.deepEqual(w.dismissed, ['lxc-210'])
  assert.equal(w.store.size, 0)
  assert.deepEqual(w.scripts, [], 'nothing changed on the guest')
})

// ── the install step ───────────────────────────────────────────────────────

test('install: the self-check must pass, then the plug-in connects', async () => {
  const steps: Record<string, any> = {}
  const step = (id: string) => (steps[id] ??= { status: 'pending' })
  const input = { vmid: 210, ip: '10.20.30.37', user: 'proxyuser', password: 'Abc_def-123456789012' }
  const out = await runFwdProxySetup(input, step, { sh: async () => ({ code: 0, output: SELFTEST_OK }), connect: async () => true })
  assert.equal(out.url, 'http://10.20.30.37:3128')
  assert.equal(steps.verify.status, 'done')
  assert.equal(steps.wire.status, 'done')
  await assert.rejects(runFwdProxySetup(input, step, { sh: async () => ({ code: 0, output: SELFTEST_STOPPED }), connect: async () => true }), /did not pass its safety check/)
  assert.equal(proxyUrl('10.0.0.5'), 'http://10.0.0.5:3128')
})

// ── card, detail, roles ────────────────────────────────────────────────────

test('the plug-in card and detail: totals and refusals, never users, client addresses or sites', () => {
  const r = parseStats(STATS)
  const row = { id: 'lxc-210', name: 'proxy', vmid: 210, listen: '10.20.30.37', ok: true, reading: r }
  const t = tileOf([row])
  assert.equal(t.tone, 'good')
  assert.match(t.headline, /connections? ·/)
  assert.equal(tileOf([{ id: 'x', name: 'proxy', vmid: 1, listen: null, ok: false, error: 'not reachable' }]).tone, 'bad')
  assert.throws(() => tileOf([]), /Catalogue/)
  const d = detailOf([row])
  assert.deepEqual(d.tables!.map(x => x.title), ['Proxies', 'Refused'])
  const all = JSON.stringify([t, d])
  assert.ok(!all.includes('alice') && !all.includes('10.20.30.55'), 'no user name or client address')
})

test('roles: admin for everything but the card; a viewer is refused the detail; credentials and settings re-confirmed', () => {
  const b = '/api/plugins/3proxy/proxies'
  assert.equal(requiredRole('GET', b), 'admin')
  assert.equal(requiredRole('GET', `${b}/lxc-210/reading`), 'admin')
  assert.equal(requiredRole('POST', `${b}/lxc-210/actions`), 'admin')
  assert.equal(requiredRole('GET', '/api/plugins/3proxy/data'), 'viewer', 'the gallery card: totals only')
  assert.equal(requiredRole('GET', '/api/plugins/3proxy/detail'), 'admin', 'a viewer is refused the detail')
  for (const [m, p] of [['POST', `${b}/lxc-210/users`], ['POST', `${b}/lxc-210/users/bob/reset`], ['DELETE', `${b}/lxc-210/users/bob`], ['PUT', `${b}/lxc-210/settings`]]) {
    assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
    assert.equal(needsReconfirm(m, p), true, `${m} ${p} re-confirmed`)
  }
  assert.equal(needsReconfirm('POST', `${b}/lxc-210/actions`), false)
  assert.equal(needsReconfirm('GET', `${b}/lxc-210/reading`), false)
})
