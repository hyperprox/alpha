// Auto-connect: the shared pass (lib/auto-connect/core.ts), the vault matching (vault-match.ts) and the address-setting
// plug-ins (settings-adapter.ts). Homepage's and Nextcloud's own adapters are tested beside their services
// (homepage-service.test.ts, nextcloud.test.ts). Nothing real is contacted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Reconciler, MemoryStateStore, SYSTEM_ACTOR, inSubnets, envExcludedSubnets, exclusionOf, installStillOwns, type AdapterContext, type AutoConnectAdapter, type Outcome } from '../src/lib/auto-connect/core'
import { matchVault, pickVault, uriMatches, credentialOf } from '../src/lib/auto-connect/vault-match'
import { settingsAdapter, type SettingsAdapterDeps, type ScanSighting } from '../src/lib/auto-connect/settings-adapter'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { scrubDetails } from '../src/lib/audit'
import type { SecretItem } from '../src/lib/vault/broker'
import type { PluginManifest } from '../src/lib/plugin-host'

const SECRET = 'k3y-VALUE-never-logged-0123456789'

function reconciler(adapters: AutoConnectAdapter[], o: { unlocked?: () => boolean; excluded?: () => Promise<string[]>; items?: SecretItem[] } = {}) {
  const audits: Array<{ action: string; resource: string; details: Record<string, unknown> }> = []
  const logs: string[] = []
  const store = new MemoryStateStore()
  const r = new Reconciler({
    store, adapters,
    unlocked: o.unlocked ?? (() => true),
    excluded: o.excluded ?? (async () => []),
    excludedSubnets: () => ['192.0.2.0/24'],
    vaultItems: () => o.items ?? [],
    audit: async (action, resource, details) => { audits.push({ action, resource, details: scrubDetails(details) }) },
    log: m => logs.push(m),
  })
  return { r, store, audits, logs }
}

/** A plug-in whose finds are given: connects each one not dismissed or excluded. */
function fakeAdapter(finds: Array<{ key: string; machineId?: string; address?: string; candidates?: string[] }>): AutoConnectAdapter & { connected: string[] } {
  const connected: string[] = []
  return {
    plugin: 'fake', connected,
    async reconcile(ctx) {
      const out: Outcome[] = []
      for (const f of finds) {
        if (connected.includes(f.key)) { out.push({ key: f.key, label: f.key, did: 'present' }); continue }
        const why = exclusionOf(ctx, { machineId: f.machineId, addresses: [f.address] })
        if (why) { out.push({ key: f.key, label: f.key, did: 'excluded', message: why }); continue }
        if (ctx.dismissed(f.key)) { out.push({ key: f.key, label: f.key, did: 'dismissed' }); continue }
        if ((f.candidates ?? []).length > 1) { out.push({ key: f.key, label: f.key, did: 'ambiguous', choices: f.candidates!.map(c => ({ id: c, label: c })) }); continue }
        await ctx.audit('fake.auto_connect', f.key, { evidence: ['scan'], by: 'someone pretending' })
        connected.push(f.key)
        out.push({ key: f.key, label: f.key, did: 'connected', evidence: ['scan'] })
      }
      return out
    },
    async pick(key, choice, ctx) { await ctx.audit('fake.pick_connect', key, { choice }); connected.push(key); return { key, label: key, did: 'connected', evidence: [`picked ${choice}`] } },
  }
}

test('a single detection is connected, audited as the system with its evidence, and not again on the next pass', async () => {
  const a = fakeAdapter([{ key: 'lxc-101', machineId: 'lxc-101', address: 'http://10.0.0.5:3000' }])
  const { r, audits, store } = reconciler([a])
  const res = await r.run('timer')
  assert.equal(res.waited, null)
  assert.deepEqual(a.connected, ['lxc-101'])
  assert.equal(audits.length, 1)
  assert.equal(audits[0].details.by, SYSTEM_ACTOR, 'the adapter cannot audit as anyone else')
  assert.deepEqual(audits[0].details.evidence, ['scan'])
  assert.ok(store.s.connected['fake/lxc-101'])
  await r.run('timer')
  assert.equal(audits.length, 1)
})

test('excluded guests and subnets, and the hyperprox-ignore tag, are never connected', async () => {
  const a = fakeAdapter([
    { key: 'lxc-101', machineId: 'lxc-101', address: 'http://10.0.0.5:3000' },
    { key: 'lxc-102', machineId: 'lxc-102', address: 'http://192.0.2.7:3000' },
  ])
  const { r, audits } = reconciler([a], { excluded: async () => ['lxc-101'] })
  const res = await r.run('timer')
  assert.deepEqual(a.connected, [])
  assert.equal(audits.length, 0)
  assert.deepEqual(res.outcomes.fake.map(o => o.did), ['excluded', 'excluded'])
  assert.equal(exclusionOf({ excludedMachines: new Set(), excludedSubnets: [] }, { tags: ['hyperprox-ignore'] }), 'the hyperprox-ignore tag')
  assert.ok(inSubnets('https://192.0.2.200:8443/x', ['192.0.2.0/24']))
  assert.ok(!inSubnets('https://cloud.example.com', ['0.0.0.0/0']), 'a name is never taken as inside a subnet')
  assert.deepEqual(envExcludedSubnets({ HYPERPROX_AUTOCONNECT_EXCLUDE_SUBNETS: '192.0.2.0/24; 198.51.100.0/24,203.0.113.0/24' } as any), ['192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24'])
  // IPv4-mapped IPv6 is its IPv4.
  assert.ok(inSubnets('http://[::ffff:192.0.2.9]:3000', ['192.0.2.0/24']))
  assert.ok(inSubnets('::ffff:192.0.2.9', ['192.0.2.0/24']))
  assert.ok(inSubnets('[::ffff:c000:209]:80', ['192.0.2.0/24']))
})

test('the exclusion list unreadable: nothing is connected (fail closed)', async () => {
  const a = fakeAdapter([{ key: 'lxc-101', machineId: 'lxc-101' }])
  const { r } = reconciler([a], { excluded: async () => { throw new Error('db down') } })
  assert.equal((await r.run('timer')).waited, 'exclusions')
  assert.deepEqual(a.connected, [])
})

test('a dismissed instance is never added back, until "connect again"', async () => {
  const a = fakeAdapter([{ key: 'lxc-101', machineId: 'lxc-101' }])
  const { r, audits } = reconciler([a])
  await r.dismiss('fake', 'lxc-101', 'dash', 'admin@example.com')
  await r.run('timer')
  assert.deepEqual(a.connected, [])
  await assert.rejects(r.connectAgain('fake', 'lxc-999', 'admin@example.com'), /not disconnected/)
  await r.connectAgain('fake', 'lxc-101', 'admin@example.com')
  assert.deepEqual(a.connected, ['lxc-101'])
  assert.ok(audits.some(x => x.action === 'autoconnect.connect_again' && x.details.by === 'admin@example.com'))
})

test('ambiguous detection is not guessed: one pending choice, and only a listed option can be picked', async () => {
  const a = fakeAdapter([{ key: 'lxc-101', machineId: 'lxc-101', candidates: ['homepage-a', 'homepage-b'] }])
  const { r, store, audits } = reconciler([a])
  await r.run('timer')
  assert.deepEqual(a.connected, [])
  assert.deepEqual(store.s.pending['fake/lxc-101'].choices.map(c => c.id), ['homepage-a', 'homepage-b'])
  await assert.rejects(r.pick('fake', 'lxc-101', 'homepage-c', 'admin@example.com'), /listed options/)
  const o = await r.pick('fake', 'lxc-101', 'homepage-b', 'admin@example.com')
  assert.equal(o.did, 'connected')
  assert.equal(store.s.pending['fake/lxc-101'], undefined)
  assert.ok(audits.some(x => x.action === 'autoconnect.pick' && x.details.by === 'admin@example.com'))
  await assert.rejects(r.pick('fake', 'lxc-101', 'homepage-b', 'admin@example.com'), /nothing to pick/)
})

test('locked: nothing runs and nothing is read; the pass after the unlock connects', async () => {
  let unlocked = false
  let read = 0
  const a = fakeAdapter([{ key: 'lxc-101', machineId: 'lxc-101' }])
  const { r } = reconciler([a], { unlocked: () => unlocked, excluded: async () => { read++; return [] } })
  assert.equal((await r.run('timer')).waited, 'locked')
  assert.equal(read, 0)
  assert.equal(r.waitingForUnlock, true)
  assert.deepEqual(a.connected, [])
  await assert.rejects(r.pick('fake', 'lxc-101', 'x', 'a'), /locked/)
  // The unlock hook start() registers runs a pass.
  let unlockCb: (() => void) | null = null
  const stop = r.start(cb => { unlockCb = cb })
  unlocked = true
  unlockCb!()
  for (let i = 0; i < 20 && !a.connected.length; i++) await new Promise(res => setImmediate(res))
  stop()
  assert.deepEqual(a.connected, ['lxc-101'])
  assert.equal(r.waitingForUnlock, false)
})

test('a vault that locks during the pass leaves it waiting for the unlock', async () => {
  const a: AutoConnectAdapter = { plugin: 'x', reconcile: async () => { const e = new Error('locked'); e.name = 'VaultLockedError'; throw e } }
  const { r } = reconciler([a])
  assert.equal((await r.run('timer')).waited, 'locked')
  assert.equal(r.waitingForUnlock, true)
})

// ── the vault ──────────────────────────────────────────────────────────────

const item = (id: string, name: string, uris: string[], fields: Record<string, string>): SecretItem => ({ id, name, uris, fields })

test('vault: exactly one item for the host is used; two are a pick; another host or HyperProx\'s own items never match', () => {
  const items = [
    item('i1', 'Sonarr', ['http://10.0.0.12:8989'], { username: 'admin', password: 'pw', api_key: SECRET }),
    item('i2', 'Router', ['https://10.0.0.1'], { username: 'admin', password: 'pw2' }),
    item('i3', 'hyperprox:plugin/arrstack', ['http://10.0.0.12:8989'], { sonarr_key: 'x' }),
  ]
  const one = matchVault(items, 'http://10.0.0.12:8989', 'api_key')
  assert.equal(one.kind, 'one')
  assert.equal(one.kind === 'one' && one.value.secret, SECRET, 'the field named like an API key is taken before the password')
  assert.deepEqual(one.kind === 'one' && one.item, { id: 'i1', name: 'Sonarr' })
  // Wrong host: refused, whatever else matches.
  assert.equal(matchVault(items, 'http://10.0.0.13:8989', 'api_key').kind, 'none')
  // A URI with a port: another port is another service.
  assert.equal(matchVault(items, 'http://10.0.0.12:7878', 'api_key').kind, 'none')
  // A URI with a scheme: http and https are different origins.
  assert.equal(matchVault(items, 'https://10.0.0.12:8989', 'api_key').kind, 'none')
  // Two items for the same address: never guessed.
  const two = matchVault([...items, item('i4', 'Sonarr (old)', ['10.0.0.12:8989'], { api_key: 'old' })], 'http://10.0.0.12:8989', 'api_key')
  assert.equal(two.kind, 'several')
  assert.deepEqual(two.kind === 'several' && two.items, [{ id: 'i1', name: 'Sonarr' }, { id: 'i4', name: 'Sonarr (old)' }])
  assert.ok(!JSON.stringify(two).includes(SECRET), 'a pick carries ids and names, never a value')
  // A pick is honoured only for an item that still matches the address.
  assert.equal(pickVault(items, 'i2', 'http://10.0.0.12:8989', 'api_key'), null)
  assert.equal(pickVault(items, 'i1', 'http://10.0.0.12:8989', 'api_key')?.value.secret, SECRET)
  assert.ok(uriMatches('cloud.example.com', 'https://cloud.example.com'))
  assert.ok(!uriMatches('https://cloud.example.com.evil.test', 'https://cloud.example.com'))
  assert.equal(credentialOf(item('x', 'x', [], { password: 'p' }), 'login'), null, 'a login needs a user name too')
  // A person's web password is never taken for an API key or a token; a password shaped like the key is.
  assert.equal(credentialOf(item('x', 'x', [], { username: 'me', password: 'correct horse battery' }), 'api_key'), null)
  assert.equal(credentialOf(item('x', 'x', [], { username: 'me', password: 'correct horse battery' }), 'token'), null)
  assert.equal(credentialOf(item('x', 'Sonarr', [], { password: '0123456789abcdef0123456789abcdef' }), 'api_key'), null, 'a key-shaped password alone is not enough')
  assert.equal(credentialOf(item('x', 'Sonarr API key', [], { password: '0123456789abcdef0123456789abcdef' }), 'api_key')?.secret, '0123456789abcdef0123456789abcdef', 'an item that says it is a key')
  assert.equal(credentialOf(item('x', 'Plex token', [], { password: 'tok' }), 'token')?.secret, 'tok')
})

// ── the address-setting plug-ins ─────────────────────────────────────────────

const ARR: PluginManifest = {
  id: 'arrstack', name: 'Arr Stack', description: '', kind: 'service', icon: '', baseUrlSetting: 'sonarr_url', auth: { kind: 'header', header: 'X-Api-Key', fromSetting: 'sonarr_key' },
  endpoints: [{ key: 'qbit', label: 'qBittorrent', baseUrlSetting: 'qbit_url', auth: { kind: 'none' } }],
  settings: [{ key: 'sonarr_url', label: 'Sonarr address', type: 'url', required: true }, { key: 'sonarr_key', label: 'Sonarr API key', type: 'secret', required: true },
    { key: 'qbit_url', label: 'qBittorrent', type: 'url', required: false }],
} as any
const UNMANIC: PluginManifest = {
  id: 'unmanic', name: 'Unmanic', description: '', kind: 'device', icon: '', baseUrlSetting: 'url', auth: { kind: 'none' },
  settings: ['url', 'label', 'url2', 'label2', 'url3', 'label3'].map(k => ({ key: k, label: k, type: k.startsWith('url') ? 'url' : 'text', required: k === 'url' })),
} as any

function settingsDeps(finds: ScanSighting[], stored: Record<string, Record<string, string>> = {}, tags = new Map<string, string[]>()) {
  const saves: Array<{ plugin: string; values: Record<string, string> }> = []
  const d: SettingsAdapterDeps = {
    findings: async () => finds,
    tags: async () => tags,
    manifest: id => ({ arrstack: ARR, unmanic: UNMANIC } as any)[id],
    settings: async id => ({ ...(stored[id] ?? {}) }),
    save: async (m, values) => { saves.push({ plugin: m.id, values }); stored[m.id] = { ...(stored[m.id] ?? {}), ...values } },
  }
  return { d, saves, stored }
}

const g = (vmid: number, name: string) => ({ vmid, type: 'lxc' as const, name })

test('address settings: Unmanic workers and qBittorrent need no secret and are filled; a filled setting is never changed', async () => {
  const { d, saves, stored } = settingsDeps([
    { key: 'unmanic', address: 'http://10.0.0.21:8888', guest: g(121, 'worker-a') },
    { key: 'unmanic', address: 'http://10.0.0.22:8888', guest: g(122, 'worker-b') },
    { key: 'qbittorrent', address: 'http://10.0.0.12:8080', guest: g(102, 'arr') },
  ], { arrstack: { qbit_url: 'http://10.0.0.99:8080' } })
  const { r, audits } = reconciler([settingsAdapter('unmanic', d), settingsAdapter('arrstack', d)])
  await r.run('timer')
  assert.equal(stored.unmanic.url, 'http://10.0.0.21:8888')
  assert.equal(stored.unmanic.label, 'worker-a')
  assert.equal(stored.unmanic.url2, 'http://10.0.0.22:8888')
  assert.equal(stored.arrstack.qbit_url, 'http://10.0.0.99:8080', 'a person\'s setting is kept')
  assert.equal(saves.filter(s => s.plugin === 'arrstack').length, 0)
  assert.ok(audits.every(a => a.details.by === SYSTEM_ACTOR))
  // Cleared by a person afterwards: remembered, never filled again until "connect again".
  delete stored.unmanic.url2
  await r.run('timer')
  assert.equal(stored.unmanic.url2, undefined)
  const st = await r.state()
  assert.ok(Object.keys(st.dismissed).some(k => k.startsWith('unmanic/url2@')))
})

test('address settings: an Arr key comes only from one vault item for that same host; none waits, two are a pick, wrong host refused', async () => {
  const finds = [{ key: 'sonarr', address: 'http://10.0.0.12:8989', guest: g(102, 'arr') }]
  // None.
  let s = settingsDeps(finds)
  let rc = reconciler([settingsAdapter('arrstack', s.d)], { items: [item('i2', 'Sonarr elsewhere', ['http://10.0.0.50:8989'], { api_key: SECRET })] })
  let res = await rc.r.run('timer')
  assert.equal(res.outcomes.arrstack[0].did, 'needs_credential')
  assert.equal(s.saves.length, 0, 'the key for another host is never used')
  // One.
  s = settingsDeps(finds)
  rc = reconciler([settingsAdapter('arrstack', s.d)], { items: [item('i1', 'Sonarr', ['http://10.0.0.12:8989'], { api_key: SECRET })] })
  res = await rc.r.run('timer')
  assert.equal(res.outcomes.arrstack[0].did, 'connected')
  assert.deepEqual(s.saves[0].values, { sonarr_url: 'http://10.0.0.12:8989', sonarr_key: SECRET })
  const row = rc.audits.find(a => a.action === 'plugin.auto_connect')!
  assert.equal(row.details.vaultItemId, 'i1')
  assert.equal(row.details.vaultItemName, 'Sonarr')
  assert.ok(!JSON.stringify(rc.audits).includes(SECRET) && !JSON.stringify(await rc.r.state()).includes(SECRET) && !rc.logs.join('\n').includes(SECRET), 'no value in the audit, the state or the log')
  // Two: a pick by item, and the picked item is used for that host only.
  s = settingsDeps(finds)
  rc = reconciler([settingsAdapter('arrstack', s.d)], { items: [item('i1', 'Sonarr', ['http://10.0.0.12:8989'], { api_key: SECRET }), item('i3', 'Sonarr 2', ['10.0.0.12:8989'], { api_key: 'other' })] })
  res = await rc.r.run('timer')
  assert.equal(res.outcomes.arrstack[0].did, 'ambiguous')
  assert.equal(s.saves.length, 0)
  const key = res.outcomes.arrstack[0].key
  assert.equal((await rc.r.pick('arrstack', key, 'i3', 'admin@example.com')).did, 'connected')
  assert.equal(s.saves[0].values.sonarr_key, 'other')
})

test('address settings: two servers for one setting are a pick; an excluded guest is left alone', async () => {
  const s = settingsDeps([
    { key: 'qbittorrent', address: 'http://10.0.0.12:8080', guest: g(102, 'arr') },
    { key: 'qbittorrent', address: 'http://10.0.0.13:8080', guest: g(103, 'arr2') },
    { key: 'unmanic', address: 'http://10.0.0.21:8888', guest: g(121, 'w') },
  ], {}, new Map([['lxc-121', ['hyperprox-ignore']]]))
  const { r, store } = reconciler([settingsAdapter('arrstack', s.d), settingsAdapter('unmanic', s.d)])
  const res = await r.run('timer')
  assert.equal(s.saves.length, 0)
  assert.equal(res.outcomes.unmanic[0].did, 'excluded')
  assert.deepEqual(store.s.pending['arrstack/qbit_url@*'].choices.map(c => c.id), ['http://10.0.0.12:8080', 'http://10.0.0.13:8080'])
  await r.pick('arrstack', 'qbit_url@*', 'http://10.0.0.13:8080', 'admin@example.com')
  assert.deepEqual(s.saves[0].values, { qbit_url: 'http://10.0.0.13:8080' })
})

test('roles: auto-connect is admin for every method; the plug-ins\' writes keep their re-confirmation', () => {
  for (const [m, p] of [['GET', '/api/auto-connect'], ['POST', '/api/auto-connect/pick'], ['POST', '/api/auto-connect/connect-again'], ['POST', '/api/auto-connect/run']]) assert.equal(requiredRole(m, p), 'admin', p)
  // Writes and fixes are unchanged: the key file, the token, the compose edit, Nextcloud's secure actions and instance changes.
  for (const p of ['/api/plugins/homepage/instances/x/widgets', '/api/plugins/homepage/instances/x/secrets', '/api/plugins/homepage/instances/x/wire-env', '/api/plugins/homepage/instances/x/proxmox-token',
    '/api/plugins/nextcloud/instances/n1234abcd/secure-actions/update', '/api/plugins/nextcloud/instances']) assert.ok(needsReconfirm(p.endsWith('widgets') ? 'PUT' : 'POST', p), p)
  assert.ok(needsReconfirm('PUT', '/api/plugins/arrstack/settings'))
  assert.ok(needsReconfirm('DELETE', '/api/plugins/nextcloud/instances/n1234abcd'))
})

test('subnet list fails closed: one unreadable entry stops every pass and every pick, loudly', async () => {
  assert.throws(() => envExcludedSubnets({ HYPERPROX_AUTOCONNECT_EXCLUDE_SUBNETS: '192.0.2.0/24, junk' } as any), /not IPv4 CIDRs \(junk\)/)
  assert.throws(() => envExcludedSubnets({ HYPERPROX_AUTOCONNECT_EXCLUDE_SUBNETS: '192.0.2.0/33' } as any))
  assert.throws(() => envExcludedSubnets({ HYPERPROX_AUTOCONNECT_EXCLUDE_SUBNETS: '300.0.2.0/24' } as any))
  assert.deepEqual(envExcludedSubnets({} as any), [])
  const a = fakeAdapter([{ key: 'lxc-101', machineId: 'lxc-101', candidates: ['x', 'y'] }])
  const store = new MemoryStateStore()
  store.s.pending['fake/lxc-101'] = { at: 1, label: 'x', message: 'm', choiceKind: 'container', choices: [{ id: 'x', label: 'x' }] }
  const errors: string[] = []
  const orig = console.error
  console.error = (m: string) => { errors.push(m) }
  try {
    const r = new Reconciler({ store, adapters: [a], unlocked: () => true, excluded: async () => [], excludedSubnets: () => envExcludedSubnets({ HYPERPROX_AUTOCONNECT_EXCLUDE_SUBNETS: 'nope' } as any), vaultItems: () => [], audit: async () => {} })
    assert.equal((await r.run('timer')).waited, 'subnets')
    await assert.rejects(r.pick('fake', 'lxc-101', 'x', 'admin@example.com'), (e: any) => e.code === 'subnets_unknown')
  } finally { console.error = orig }
  assert.deepEqual(a.connected, [])
  assert.ok(errors.some(e => /REFUSING TO RUN/.test(e)))
})

test('vault: a URI with no port means its scheme\'s default port, never every app on that host', () => {
  const items = [item('w', 'NAS web page', ['https://10.0.0.12'], { username: 'u', password: 'p', api_key: SECRET }), item('b', 'Bare host', ['10.0.0.13'], { api_key: SECRET })]
  assert.equal(matchVault(items, 'http://10.0.0.12:8989', 'api_key').kind, 'none', 'https://host is port 443 only')
  assert.equal(matchVault(items, 'https://10.0.0.12', 'api_key').kind, 'one')
  assert.equal(matchVault(items, 'https://10.0.0.12:443', 'api_key').kind, 'one')
  assert.equal(matchVault(items, 'http://10.0.0.13:8080', 'api_key').kind, 'none', 'a bare host is only the address\'s default port')
  assert.equal(matchVault(items, 'http://10.0.0.13', 'api_key').kind, 'one')
  assert.ok(uriMatches('http://10.0.0.13:80', 'http://10.0.0.13'), 'a default port written out is the same port')
})

// ── B1: a person's change during a slow pass is never lost ───────────────────

/** An adapter whose pass waits until released, so a person's action can land in the middle of it. */
function slowAdapter(keys: string[]) {
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  let started!: () => void
  const running = new Promise<void>(r => { started = r })
  const connected: string[] = []
  const seen: Array<{ key: string; dismissed: boolean }> = []
  const a: AutoConnectAdapter = {
    plugin: 'slow',
    async reconcile(ctx) {
      started()
      await gate
      const out: Outcome[] = []
      for (const k of keys) {
        seen.push({ key: k, dismissed: ctx.dismissed(k) })
        if (ctx.dismissed(k)) { out.push({ key: k, label: k, did: 'dismissed' }); continue }
        if (k.startsWith('amb')) { out.push({ key: k, label: k, did: 'ambiguous', choices: [{ id: 'c1', label: 'c1' }, { id: 'c2', label: 'c2' }] }); continue }
        connected.push(k)
        out.push({ key: k, label: k, did: 'connected' })
      }
      return out
    },
    async pick(key, choice) { return { key, label: key, did: 'connected', evidence: [choice] } },
  }
  return { a, release, running, connected, seen }
}

test('B1: a dismiss that lands during a slow pass is kept, and the pass does not connect it', async () => {
  const s = slowAdapter(['lxc-101'])
  const { r, store } = reconciler([s.a])
  const pass = r.run('timer')
  await s.running
  await r.dismiss('slow', 'lxc-101', 'dash', 'admin@example.com')
  s.release()
  await pass
  assert.ok(store.s.dismissed['slow/lxc-101'], 'the dismissal survives the pass\'s write')
  assert.equal(store.s.connected['slow/lxc-101'], undefined)
  assert.deepEqual(s.connected, [], 'the adapter read the dismissal live')
})

test('B1: a dismiss after the adapter already connected still wins in the remembered state', async () => {
  let release!: () => void
  const gate = new Promise<void>(res => { release = res })
  let reached!: () => void
  const at = new Promise<void>(res => { reached = res })
  const a: AutoConnectAdapter = { plugin: 'slow', async reconcile() { reached(); await gate; return [{ key: 'lxc-101', label: 'x', did: 'connected' }] } }
  const { r, store } = reconciler([a])
  const pass = r.run('timer')
  await at
  await r.dismiss('slow', 'lxc-101', 'dash', 'admin@example.com')
  release()
  await pass
  assert.ok(store.s.dismissed['slow/lxc-101'])
  assert.equal(store.s.connected['slow/lxc-101'], undefined)
})

test('B1: connect-again during a slow pass starts a fresh pass after it, never hands back the old one', async () => {
  const s = slowAdapter(['lxc-101'])
  const { r, store } = reconciler([s.a])
  await r.dismiss('slow', 'lxc-101', 'dash', 'admin@example.com')
  const pass = r.run('timer')
  await s.running
  const again = r.connectAgain('slow', 'lxc-101', 'admin@example.com')
  const old = await Promise.race([again.then(() => 'again'), new Promise(res => setTimeout(() => res('waiting'), 20))])
  assert.equal(old, 'waiting', 'connect-again does not resolve with the pass that started before it')
  s.release()
  await pass
  await again
  assert.equal(s.seen.length, 2, 'a second, fresh pass ran')
  assert.deepEqual(s.connected.filter(k => k === 'lxc-101').length >= 1, true)
  assert.equal(store.s.dismissed['slow/lxc-101'], undefined)
  assert.ok(store.s.connected['slow/lxc-101'])
})

test('B1: a pick during a slow pass is kept, and only its own choice is resolved', async () => {
  const s = slowAdapter(['amb-1', 'amb-2'])
  const { r, store } = reconciler([s.a])
  // The first pass leaves two choices.
  s.release()
  await r.run('timer')
  assert.ok(store.s.pending['slow/amb-1'] && store.s.pending['slow/amb-2'])
  // A second, slow pass; the pick lands in the middle of it.
  const s2 = slowAdapter(['amb-1', 'amb-2'])
  ;(r as any).d.adapters = [s2.a]
  const pass = r.run('timer')
  await s2.running
  const o = await r.pick('slow', 'amb-1', 'c2', 'admin@example.com')
  assert.equal(o.did, 'connected')
  assert.equal(store.s.pending['slow/amb-1'], undefined)
  assert.ok(store.s.pending['slow/amb-2'], 'the other choice is left alone')
  assert.ok(store.s.connected['slow/amb-1'])
  s2.release()
  await pass
  assert.ok(store.s.connected['slow/amb-1'], 'the pass\'s write does not undo the pick')
  assert.equal(store.s.pending['slow/amb-1'], undefined, 'a stale "ambiguous" from the pass does not re-open a picked choice')
  assert.ok(store.s.pending['slow/amb-2'])
})

test('minor 6: a key saved without its address is never overwritten or paired by itself', async () => {
  const s = settingsDeps([{ key: 'sonarr', address: 'http://10.0.0.12:8989', guest: g(102, 'arr') }], { arrstack: { sonarr_key: 'mine' } })
  const rc = reconciler([settingsAdapter('arrstack', s.d)], { items: [item('i1', 'Sonarr', ['http://10.0.0.12:8989'], { api_key: SECRET })] })
  const res = await rc.r.run('timer')
  assert.equal(res.outcomes.arrstack[0].did, 'skipped')
  assert.equal(s.saves.length, 0)
  assert.equal(s.stored.arrstack.sonarr_key, 'mine')
})

test('minor 7 and 10: one Unmanic worker written by name and by IP counts once; a finding with no guest is never connected', async () => {
  const s = settingsDeps([
    { key: 'unmanic', address: 'http://10.0.0.21:8888', guest: g(121, 'w1') },
    { key: 'unmanic', address: 'http://10.0.0.22:8888', guest: null },
  ], { unmanic: { url: 'http://worker-one.lan:8888' } })
  s.d.resolve = async h => (h === 'worker-one.lan' ? '10.0.0.21' : null)
  const { r } = reconciler([settingsAdapter('unmanic', s.d)])
  const res = await r.run('timer')
  assert.equal(res.outcomes.unmanic[0].did, 'present', 'the stored name resolves to the found IP')
  assert.equal(s.saves.length, 0, 'not added again, and the node-only finding is ignored')
  assert.equal(res.outcomes.unmanic.length, 1)
})

test('minor 9: a finished install counts only while its VMID still holds the guest it made', () => {
  assert.ok(installStillOwns({ hostname: 'cloud' }, { name: 'Cloud' }))
  assert.ok(!installStillOwns({ hostname: 'cloud' }, { name: 'gameserver' }), 'the VMID was reused')
  assert.ok(!installStillOwns({ hostname: 'cloud' }, undefined), 'the guest is gone')
  assert.ok(installStillOwns({}, { name: 'anything' }), 'no recorded hostname: the VMID alone')
})
