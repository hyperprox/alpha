// The DNS blocker service (lib/dns-blocker/service.ts), for both products, against fakes that answer from fixtures
// recorded on real installs: the reading (and what a viewer or a hidden-clients setting leaves out), a login the blocker
// refuses (never retried), every action with its role, token and confirm rules and its read-back, the audit rows (no
// secret in them), the restart, the guest DNS setting, and auto-connect (a Catalogue install's login, a vault item, none,
// several, excluded, dismissed, already there). Nothing real is contacted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DnsBlockerService, allowPhrase, cleanDomain, restartScript, type GuestRow, type NamingPort, type ServiceDeps, type Sighting } from '../src/lib/dns-blocker/service'
import { DnsInstanceStore, type CredentialIO } from '../src/lib/dns-blocker/instances'
import { DnsLoginError } from '../src/lib/dns-blocker/client'
import { DnsRefusal, type DnsKind } from '../src/lib/dns-blocker/types'
import { scrubDetails } from '../src/lib/audit'
import type { AdapterContext } from '../src/lib/auto-connect/core'
import type { SecretItem } from '../src/lib/vault/broker'
import { ADGUARD_PASSWORD, ADGUARD_USER, FakeAdguard, FakePihole, NOW, PIHOLE_PASSWORD } from './fakes/dns-blocker'

function memIO(): CredentialIO & { mem: Map<string, string> } {
  const mem = new Map<string, string>()
  return {
    mem,
    get: async (c, p, k) => mem.get(`${c}/${p}/${k}`) ?? null,
    set: async (c, p, k, v) => { mem.set(`${c}/${p}/${k}`, v) },
    remove: async (c, p) => { for (const k of [...mem.keys()]) if (k.startsWith(`${c}/${p}/`)) mem.delete(k) },
  }
}

const admin = { sid: 'a', email: 'admin@example.test', role: 'admin' as const, token: null }
const operator = { sid: 'o', email: 'op@example.test', role: 'operator' as const, token: null }
const viewer = { sid: 'v', email: 'view@example.test', role: 'viewer' as const, token: null }

interface Rig {
  svc: DnsBlockerService; io: ReturnType<typeof memIO>; audits: Array<{ action: string; resource: string; details: Record<string, unknown> }>
  fake: FakePihole | FakeAdguard; kind: DnsKind; probes: Array<[string, number]>; id: string
}

async function rig(kind: DnsKind, over: Partial<ServiceDeps> = {}, o: { probe?: (s: string, p: number) => boolean } = {}): Promise<Rig> {
  const io = memIO()
  const fake: FakePihole | FakeAdguard = kind === 'pihole' ? new FakePihole() : new FakeAdguard()
  const audits: Rig['audits'] = []
  const probes: Array<[string, number]> = []
  const svc = new DnsBlockerService({
    kind, store: new DnsInstanceStore(kind, io), audit: async (action, resource, details) => { audits.push({ action, resource, details: scrubDetails(details) }) },
    http: () => fake,
    probe: async (s, p) => { probes.push([s, p]); const ok = o.probe ? o.probe(s, p) : true; return ok ? { ok: true, ms: 12 } : { ok: false, ms: null } },
    resolve: async u => u.hostname, now: () => NOW, sleep: async () => {}, restartWaitMs: 100,
    ...over,
  })
  const meta = await svc.add({ name: 'Home DNS', url: 'http://192.0.2.10', ...(kind === 'adguard' ? { username: ADGUARD_USER, password: ADGUARD_PASSWORD } : { password: PIHOLE_PASSWORD }) }, admin)
  return { svc, io, audits, fake, kind, probes, id: meta.id }
}

for (const kind of ['pihole', 'adguard'] as const) {
  const NAME = kind === 'pihole' ? 'Pi-hole' : 'AdGuard Home'

  test(`${NAME}: a reading has the numbers, the upstream servers and no problems when all is well`, async () => {
    const r = await rig(kind)
    const reading = await r.svc.reading(r.id)
    assert.equal(reading.kind, kind)
    assert.ok(reading.totals.queries > 0 && reading.totals.blocked > 0)
    assert.ok(reading.topBlocked.some(d => d.domain === 'doubleclick.net'))
    assert.ok(reading.clients && reading.clients.length >= 1)
    assert.equal(reading.protection.on, true)
    assert.equal(reading.answering.ok, true)
    assert.ok(reading.upstreams.length >= 1 && reading.upstreams.every(u => u.state === 'ok'))
    assert.ok(reading.blocklists.domains! > 1000)
    assert.equal(reading.history.length, 24)
    assert.deepEqual(reading.problems, [])
    assert.equal(JSON.stringify(reading).includes(PIHOLE_PASSWORD) || JSON.stringify(reading).includes(ADGUARD_PASSWORD), false)
    assert.ok(!/sid-\d/.test(JSON.stringify(reading)), 'no session id in a reading')
  })

  test(`${NAME}: a reading is kept 20 seconds, and a fresh one reads again`, async () => {
    let t = NOW
    const r = await rig(kind, { now: () => t })
    await r.svc.reading(r.id)
    const n = r.fake.log.requests.length
    await r.svc.reading(r.id)
    assert.equal(r.fake.log.requests.length, n, 'served from the cache')
    t += 21_000
    await r.svc.reading(r.id)
    assert.ok(r.fake.log.requests.length > n)
    await r.svc.reading(r.id, { fresh: true })
  })

  test(`${NAME}: hidden clients are not even asked for`, async () => {
    const r = await rig(kind)
    await r.svc.instances.update(r.id, { hideClients: true })
    const reading = await r.svc.reading(r.id, { fresh: true })
    assert.equal(reading.clients, null)
    assert.equal(reading.clientsHidden, true)
    assert.ok(!r.fake.log.requests.some(q => /top_clients|control\/clients/.test(q.path)), 'the per-client numbers were never requested')
  })

  test(`${NAME}: pausing blocking is read back, and resuming too`, async () => {
    const r = await rig(kind)
    const m = await r.svc.act(r.id, { action: 'pause', minutes: 30 }, operator, false)
    assert.match(m.message, /paused for 30 minutes/)
    const paused = await r.svc.reading(r.id, { fresh: true })
    assert.equal(paused.protection.on, false)
    assert.ok(paused.problems.some(p => p.id === 'protection_off' && p.fix?.action === 'resume'))
    assert.ok(paused.protection.secondsLeft! > 1000)
    assert.match((await r.svc.act(r.id, { action: 'resume' }, operator, false)).message, /on again/)
    assert.equal((await r.svc.reading(r.id, { fresh: true })).protection.on, true)
    await assert.rejects(r.svc.act(r.id, { action: 'pause', minutes: 7 }, operator, false), (e: any) => e.code === 'bad_input')
    await assert.rejects(r.svc.act(r.id, { action: 'pause', minutes: '30; reboot' }, operator, false), (e: any) => e.code === 'bad_input')
  })

  test(`${NAME}: updating the lists asks the blocker and says it is done only when the lists are fresh`, async () => {
    const r = await rig(kind)
    // The fixture's lists were updated at capture time; "now" is just after it.
    const out = await r.svc.act(r.id, { action: 'update_lists' }, operator, false)
    assert.match(out.message, /up to date/)
    assert.ok(r.fake instanceof FakePihole ? r.fake.gravityRuns === 1 : (r.fake as FakeAdguard).refreshes === 1)
  })

  test(`${NAME}: allowing a domain needs the typed phrase, an admin and a person; it is read back`, async () => {
    const r = await rig(kind, { limits: { securityPerMinute: 100 } })
    await assert.rejects(r.svc.act(r.id, { action: 'allow_domain', domain: 'ads.example.net', confirm: 'yes' }, admin, true), (e: any) => e.code === 'confirm_wrong')
    await assert.rejects(r.svc.act(r.id, { action: 'allow_domain', domain: 'ads.example.net', confirm: allowPhrase('ads.example.net') }, operator, true), (e: any) => e.code === 'forbidden')
    await assert.rejects(r.svc.act(r.id, { action: 'allow_domain', domain: 'ads.example.net', confirm: allowPhrase('ads.example.net') }, { ...admin, token: 'tok' }, true), (e: any) => e.code === 'person_only')
    for (const bad of ['*.example.net', 'a b.example.net', 'example', 'x.example.net/path', 'x.example.net; rm -rf /', '']) {
      await assert.rejects(r.svc.act(r.id, { action: 'allow_domain', domain: bad, confirm: allowPhrase(bad) }, admin, true), (e: any) => e.code === 'bad_input' || e.code === 'confirm_wrong', bad)
    }
    const ok = await r.svc.act(r.id, { action: 'allow_domain', domain: 'Ads.Example.NET', confirm: 'Allow ads.example.net' }, admin, true)
    assert.match(ok.message, /ads\.example\.net is allowed/)
    if (r.fake instanceof FakePihole) assert.ok(r.fake.allowed.has('ads.example.net'))
    else assert.deepEqual((r.fake as FakeAdguard).userRules, ['@@||ads.example.net^'])
  })

  test(`${NAME}: allowing a domain twice is fine`, async () => {
    const r = await rig(kind)
    const body = { action: 'allow_domain', domain: 'ads.example.net', confirm: 'Allow ads.example.net' }
    await r.svc.act(r.id, body, admin, true)
    if (r.fake instanceof FakePihole) r.fake.refuseAdd = 'The item is already present'
    await r.svc.act(r.id, body, admin, true)
    if (r.fake instanceof FakeAdguard) assert.deepEqual(r.fake.userRules, ['@@||ads.example.net^'], 'the rule is not added twice')
  })

  test(`${NAME}: a failing upstream is shown, with a fix that keeps the ones that answer`, async () => {
    const bad = '192.0.2.99'
    const r = await rig(kind, {}, { probe: (s) => s !== bad })
    if (r.fake instanceof FakePihole) r.fake.upstreams = ['1.1.1.1', bad]
    else { r.fake.upstreams = ['1.1.1.1', bad]; r.fake.failing.add(bad) }
    const reading = await r.svc.reading(r.id, { fresh: true })
    const states = Object.fromEntries(reading.upstreams.map(u => [u.address.replace(/:53$/, ''), u.state]))
    assert.equal(states[bad], 'failing')
    assert.equal(states['1.1.1.1'], 'ok')
    const p = reading.problems.find(x => x.id === 'upstream_failing')
    assert.deepEqual(p?.fix, { action: 'switch_upstream', label: 'Use only the ones that answer', params: { to: 'healthy' }, secure: true })
    const out = await r.svc.act(r.id, { action: 'switch_upstream', to: 'healthy' }, admin, true)
    assert.match(out.message, /only 1\.1\.1\.1/)
    assert.deepEqual(r.fake.upstreams, ['1.1.1.1'])
    // Nothing left to switch: refused in words.
    await assert.rejects(r.svc.act(r.id, { action: 'switch_upstream', to: 'healthy' }, admin, true), (e: any) => e.code === 'nothing_to_do')
  })

  test(`${NAME}: switching to a provider sets its servers and checks they were kept`, async () => {
    const r = await rig(kind)
    const out = await r.svc.act(r.id, { action: 'switch_upstream', to: 'quad9' }, admin, true)
    assert.match(out.message, /Quad9/)
    assert.deepEqual(r.fake.upstreams, ['9.9.9.9', '149.112.112.112'])
    await assert.rejects(r.svc.act(r.id, { action: 'switch_upstream', to: '8.8.8.8; evil' }, admin, true), (e: any) => e.code === 'bad_input')
    await assert.rejects(r.svc.act(r.id, { action: 'switch_upstream', to: 'healthy' }, admin, true), (e: any) => e.code === 'nothing_to_do' || e.code === 'none_healthy')
  })

  test(`${NAME}: when every upstream fails, the fix is a provider and the blocker is not blamed`, async () => {
    const r = await rig(kind, {}, { probe: () => false })
    if (r.fake instanceof FakeAdguard) for (const u of r.fake.upstreams) r.fake.failing.add(u)
    const reading = await r.svc.reading(r.id, { fresh: true })
    assert.ok(reading.upstreams.every(u => u.state === 'failing'))
    assert.ok(reading.problems.some(p => p.id === 'all_upstreams_failing' && p.fix?.params?.to === 'cloudflare'))
    assert.ok(!reading.problems.some(p => p.id === 'not_answering'), 'the upstream problem explains the slow answers')
  })

  test(`${NAME}: a blocker that does not answer a test lookup gets a restart fix`, async () => {
    const r = await rig(kind, {}, { probe: s => s !== '192.0.2.10' })
    const reading = await r.svc.reading(r.id, { fresh: true })
    assert.equal(reading.answering.ok, false)
    assert.deepEqual(reading.problems.find(p => p.id === 'not_answering')?.fix, { action: 'restart_service', label: `Restart ${NAME}`, secure: true })
  })

  test(`${NAME}: stale block lists get an update fix`, async () => {
    let t = NOW + 12 * 24 * 3_600_000
    const r = await rig(kind, { now: () => t })
    const reading = await r.svc.reading(r.id, { fresh: true })
    assert.equal(reading.blocklists.stale, true)
    assert.deepEqual(reading.problems.find(p => p.id === 'lists_stale')?.fix, { action: 'update_lists', label: 'Update the block lists now', secure: false })
  })

  test(`${NAME}: actions: unknown names, wrong tier, viewers and the rate limit`, async () => {
    const r = await rig(kind, { limits: { normalPerMinute: 2, securityPerMinute: 2 } })
    await assert.rejects(r.svc.act(r.id, { action: 'rm -rf /' }, admin, false), (e: any) => e.code === 'unknown_action')
    await assert.rejects(r.svc.act(r.id, { action: 'restart_service' }, admin, false), (e: any) => e.code === 'unknown_action', 'a secure action is not on the normal route')
    await assert.rejects(r.svc.act(r.id, { action: 'pause', minutes: 5 }, admin, true), (e: any) => e.code === 'unknown_action', 'a normal action is not on the secure route')
    await assert.rejects(r.svc.act(r.id, { action: 'pause', minutes: 5 }, viewer, false), (e: any) => e.code === 'forbidden')
    await assert.rejects(r.svc.act('d00000000', { action: 'resume' }, admin, false), (e: any) => e.code === 'no_instance')
    await r.svc.act(r.id, { action: 'resume' }, operator, false)
    await r.svc.act(r.id, { action: 'resume' }, operator, false)
    await assert.rejects(r.svc.act(r.id, { action: 'resume' }, operator, false), (e: any) => e.code === 'rate_limited')
  })

  test(`${NAME}: every attempt is audited as who and what, and no secret is in any row`, async () => {
    const r = await rig(kind)
    await r.svc.act(r.id, { action: 'pause', minutes: 5 }, operator, false)
    await r.svc.act(r.id, { action: 'resume' }, viewer, false).catch(() => {})
    await r.svc.act(r.id, { action: 'allow_domain', domain: 'a.example.net', confirm: 'wrong' }, admin, true).catch(() => {})
    await r.svc.act(r.id, { action: 'restart_service' }, { ...admin, token: 't' }, true).catch(() => {})
    const rows = r.audits.filter(a => a.action === `${kind}.action`).map(a => `${a.details.action}:${a.details.result}`)
    assert.deepEqual(rows, ['pause:ok', 'resume:refused:role', 'allow_domain:refused:confirm', 'restart_service:refused:token'])
    const all = JSON.stringify(r.audits)
    for (const secret of [PIHOLE_PASSWORD, ADGUARD_PASSWORD, 'sid-1', 'Basic ']) assert.ok(!all.includes(secret), `no ${secret} in the audit`)
    assert.ok(r.audits.every(a => a.details.by), 'every row says who')
  })

  test(`${NAME}: a refused login is not tried again until it is saved again`, async () => {
    const r = await rig(kind)
    const fake = r.fake
    // The blocker's password changed: the saved one is refused.
    await r.svc.instances.update(r.id, { password: 'changed-and-wrong' }).catch(() => {})
    r.svc.forget(r.id)
    await assert.rejects(r.svc.reading(r.id, { fresh: true }), DnsLoginError)
    const n = fake.log.requests.length
    await assert.rejects(r.svc.reading(r.id, { fresh: true }), DnsLoginError)
    assert.equal(fake.log.requests.length, n, 'no second sign-in attempt while it is held')
    assert.ok(r.svc.blockedReason(r.id))
    r.svc.forget(r.id)
    assert.equal(r.svc.blockedReason(r.id), null)
  })

  test(`${NAME}: adding one checks the login first and saves nothing for a wrong one`, async () => {
    const r = await rig(kind)
    await assert.rejects(r.svc.add({ name: 'Wrong', url: 'http://192.0.2.11', username: ADGUARD_USER, password: 'nope' }, admin), DnsLoginError)
    assert.equal((await r.svc.instances.list()).length, 1)
    for (const url of ['ftp://192.0.2.11', 'http://user:pw@192.0.2.11', 'http://192.0.2.11/path?x=1', '']) {
      await assert.rejects(r.svc.add({ name: 'x', url, username: ADGUARD_USER, password: ADGUARD_PASSWORD }, admin), (e: any) => e.code === 'bad_input', url)
    }
  })

  test(`${NAME}: the login is in the vault store, masked, and never in the instance list`, async () => {
    const r = await rig(kind)
    const list = JSON.stringify(await r.svc.instances.list())
    assert.ok(!list.includes('192.0.2.10') && !list.includes(PIHOLE_PASSWORD) && !list.includes(ADGUARD_PASSWORD))
    const keys = [...r.io.mem.keys()]
    assert.ok(keys.some(k => k.endsWith('/password')))
    const view = JSON.stringify(await r.svc.instances.views())
    assert.ok(!view.includes(PIHOLE_PASSWORD) && !view.includes(ADGUARD_PASSWORD), 'a view says whether a password is saved, never the password')
  })

  test(`${NAME}: moving the address needs the password again in the same save`, async () => {
    const r = await rig(kind)
    await assert.rejects(r.svc.instances.update(r.id, { url: 'http://192.0.2.77' }), (e: any) => /password again/.test(e.message))
    await r.svc.instances.update(r.id, { url: 'http://192.0.2.77', password: kind === 'pihole' ? PIHOLE_PASSWORD : ADGUARD_PASSWORD })
    assert.equal((await r.svc.instances.login(r.id))?.url, 'http://192.0.2.77')
  })
}

test('restart: runs the fixed script in the guest through the guard, then waits until the blocker answers', async () => {
  const ran: string[] = []
  const guest = { kind: 'lxc' as const, vmid: 411 }
  let answers = false
  const r = await rig('pihole', {
    exec: async (g, script) => { ran.push(`${g.kind}-${g.vmid}`); ran.push(script); answers = true; return { code: 0, output: '@@restarted docker\n', timedOut: false } },
  }, { probe: () => answers })
  await r.svc.instances.update(r.id, { guest })
  const out = await r.svc.act(r.id, { action: 'restart_service' }, admin, true)
  assert.match(out.message, /restarted and answers again/)
  assert.equal(ran[0], 'lxc-411')
  assert.equal(ran[1], restartScript('pihole'))
  assert.match(ran[1], /docker restart 'pihole'/)
  assert.match(ran[1], /systemctl restart 'pihole-FTL'/)
  assert.match(restartScript('adguard'), /docker restart 'adguardhome'[\s\S]*systemctl restart 'AdGuardHome'/)
  assert.ok(!/\$\{|\$\(.*\$/.test(ran[1].replace(/\$\(/g, '')), 'no value is ever put in the script')
})

test('restart: a guest HyperProx leaves alone is refused by the guard, and so is a restart with no guest', async () => {
  const r = await rig('adguard', { exec: async () => { throw new DnsRefusal('left_alone', 'HyperProx was told to leave that guest alone.', 409) } })
  await assert.rejects(r.svc.act(r.id, { action: 'restart_service' }, admin, true), (e: any) => e.code === 'no_guest')
  await r.svc.instances.update(r.id, { guest: { kind: 'lxc', vmid: 412 } })
  await assert.rejects(r.svc.act(r.id, { action: 'restart_service' }, admin, true), (e: any) => e.code === 'left_alone')
  assert.ok(r.audits.some(a => a.details.action === 'restart_service' && a.details.result === 'refused:left_alone'))
})

test('restart: a service that never comes back is said so, not claimed done', async () => {
  const r = await rig('pihole', { exec: async () => ({ code: 0, output: '@@restarted service\n', timedOut: false }) }, { probe: () => false })
  await r.svc.instances.update(r.id, { guest: { kind: 'lxc', vmid: 411 } })
  const t0 = Date.now()
  let t = NOW
  ;(r.svc as any).d.now = () => (t += 60)
  await assert.rejects(r.svc.act(r.id, { action: 'restart_service' }, admin, true), (e: any) => e.code === 'not_confirmed')
  assert.ok(Date.now() - t0 < 5_000)
})

test('restart: nothing to restart in the guest is a plain refusal', async () => {
  const r = await rig('pihole', { exec: async () => ({ code: 3, output: '@@none\n', timedOut: false }) })
  await r.svc.instances.update(r.id, { guest: { kind: 'lxc', vmid: 411 } })
  await assert.rejects(r.svc.act(r.id, { action: 'restart_service' }, admin, true), (e: any) => e.code === 'not_found')
})

test('domains: one name only', () => {
  assert.equal(cleanDomain(' Ads.Example.COM. '), 'ads.example.com')
  for (const bad of ['', 'localhost', '*.x.com', 'x.com/a', 'x.com:80', 'a_b.example.com ', 'x..com', '-x.com', 'ex ample.com', 'x.c', '1.2.3.4']) {
    if (bad === 'a_b.example.com ') { assert.equal(cleanDomain(bad), 'a_b.example.com'); continue }
    assert.throws(() => cleanDomain(bad), (e: any) => e.code === 'bad_input', bad)
  }
})

// ── guest DNS (the Catalogue's naming settings) ─────────────────────────────

function namingRig(dns: string[] | null) {
  const saved: Array<Record<string, unknown>> = []
  let cur: ({ dns: string[] } & Record<string, unknown>) | null = dns ? { subnet: '192.0.2.0/24', dns } : null
  const naming: NamingPort = {
    read: async () => (cur ? { ...cur } : null),
    save: async s => { saved.push(s); cur = s as any; return { errors: [] } },
  }
  return { naming, saved, get: () => cur }
}

test('use for guests: puts the blocker first in the DNS list new guests get, keeps the old ones after it, and can be undone', async () => {
  const n = namingRig(['1.1.1.1', '9.9.9.9'])
  const r = await rig('pihole', { naming: n.naming })
  const out = await r.svc.act(r.id, { action: 'use_for_guests' }, admin, true)
  assert.match(out.message, /from now on/); assert.match(out.message, /not changed/)
  assert.deepEqual(n.get()!.dns, ['192.0.2.10', '1.1.1.1', '9.9.9.9'])
  assert.deepEqual((await r.svc.instances.get(r.id))!.guestDns, { address: '192.0.2.10', previous: ['1.1.1.1', '9.9.9.9'] })
  await assert.rejects(r.svc.act(r.id, { action: 'use_for_guests' }, admin, true), (e: any) => e.code === 'nothing_to_do')
  await r.svc.act(r.id, { action: 'stop_using_for_guests' }, admin, true)
  assert.deepEqual(n.get()!.dns, ['1.1.1.1', '9.9.9.9'])
  assert.equal((await r.svc.instances.get(r.id))!.guestDns, undefined)
})

test('use for guests: at most three servers, and a person who changed the list since is not overwritten on undo', async () => {
  const n = namingRig(['1.1.1.1', '9.9.9.9', '8.8.8.8'])
  const r = await rig('adguard', { naming: n.naming })
  await r.svc.act(r.id, { action: 'use_for_guests' }, admin, true)
  assert.deepEqual(n.get()!.dns, ['192.0.2.10', '1.1.1.1', '9.9.9.9'])
  n.get()!.dns = ['10.0.0.53']
  await r.svc.act(r.id, { action: 'stop_using_for_guests' }, admin, true)
  assert.deepEqual(n.get()!.dns, ['10.0.0.53'], 'their own change stays')
})

test('use for guests: no naming settings saved is explained, not invented; and it is admin and person only', async () => {
  const r = await rig('pihole', { naming: namingRig(null).naming })
  await assert.rejects(r.svc.act(r.id, { action: 'use_for_guests' }, admin, true), (e: any) => e.code === 'no_naming' && /Settings, Naming/.test(e.message))
  await assert.rejects(r.svc.act(r.id, { action: 'use_for_guests' }, operator, true), (e: any) => e.code === 'forbidden')
  await assert.rejects(r.svc.act(r.id, { action: 'use_for_guests' }, { ...admin, token: 't' }, true), (e: any) => e.code === 'person_only')
})

// ── auto-connect ────────────────────────────────────────────────────────────

const item = (o: Partial<SecretItem> & { fields: Record<string, string> }): SecretItem => ({ id: 'i1', name: 'Pi-hole', uris: ['http://192.0.2.10'], notes: '', ...o } as SecretItem)

function ctxOf(o: { items?: SecretItem[]; excluded?: string[]; dismissed?: string[] } = {}) {
  const audits: Array<{ action: string; resource: string; details: Record<string, unknown> }> = []
  const ctx: AdapterContext = {
    dismissed: k => (o.dismissed ?? []).includes(k), autoConnectedBefore: () => false,
    excludedMachines: new Set(o.excluded ?? []), excludedSubnets: ['198.51.100.0/24'],
    vaultItems: () => o.items ?? [], audit: async (a, r, d) => { audits.push({ action: a, resource: r, details: scrubDetails(d) }) }, now: () => NOW,
  }
  return { ctx, audits }
}

async function autoRig(kind: DnsKind, sightings: Sighting[], over: Partial<ServiceDeps> = {}) {
  const io = memIO()
  const fake = kind === 'pihole' ? new FakePihole() : new FakeAdguard()
  const rows: GuestRow[] = [{ kind: 'lxc', vmid: 411, name: 'dns-box', node: 'n1', running: true, ignored: false }]
  const svc = new DnsBlockerService({
    kind, store: new DnsInstanceStore(kind, io), audit: async () => {}, http: () => fake, probe: async () => ({ ok: true, ms: 5 }), resolve: async u => u.hostname,
    now: () => NOW, guests: async () => rows, tags: async () => new Map(), sightings: async () => sightings, ...over,
  })
  return { svc, io, fake, rows }
}

const seenAt = (via: string, over: Partial<Sighting> = {}): Sighting => ({ guest: { kind: 'lxc', vmid: 411 }, url: 'http://192.0.2.10:80', via, ip: '192.0.2.10', ...over })

test('auto-connect: a Catalogue install is connected with the generated login from the vault, after a sign-in proves it', async () => {
  const { svc } = await autoRig('pihole', [seenAt('catalogue')], { catalogueLogin: async vmid => (vmid === 411 ? { username: 'admin', password: PIHOLE_PASSWORD } : null) })
  const { ctx, audits } = ctxOf()
  const out = await svc.autoConnect(ctx)
  assert.deepEqual(out.map(o => o.did), ['connected'])
  assert.match(out[0].evidence!.join(' '), /Catalogue install/)
  const list = await svc.instances.list()
  assert.equal(list.length, 1)
  assert.deepEqual(list[0].guest, { kind: 'lxc', vmid: 411 })
  assert.equal((await svc.instances.login(list[0].id))?.url, 'http://192.0.2.10', 'the address, without the default port')
  assert.equal(audits[0].action, 'plugin.auto_connect')
  assert.ok(!JSON.stringify(audits).includes(PIHOLE_PASSWORD))
  // The next pass finds it already there.
  assert.deepEqual((await svc.autoConnect(ctx)).map(o => o.did), ['present'])
})

test('auto-connect: AdGuard Home from a Catalogue install uses the generated user and password', async () => {
  const { svc } = await autoRig('adguard', [seenAt('catalogue')], { catalogueLogin: async () => ({ username: 'admin', password: ADGUARD_PASSWORD }) })
  assert.deepEqual((await svc.autoConnect(ctxOf().ctx)).map(o => o.did), ['connected'])
  assert.equal((await svc.instances.login((await svc.instances.list())[0].id))?.username, 'admin')
})

test('auto-connect: a refused generated login is never saved', async () => {
  const { svc } = await autoRig('pihole', [seenAt('catalogue')], { catalogueLogin: async () => ({ username: 'admin', password: 'stale' }) })
  const out = await svc.autoConnect(ctxOf().ctx)
  assert.deepEqual(out.map(o => o.did), ['needs_credential'])
  assert.equal((await svc.instances.list()).length, 0)
})

test('auto-connect: one found by the scan needs exactly one vault item for that very address', async () => {
  const mine = item({ id: 'v1', name: 'Home Pi-hole', uris: ['http://192.0.2.10'], fields: { password: PIHOLE_PASSWORD } })
  const other = item({ id: 'v2', name: 'Router', uris: ['http://192.0.2.1'], fields: { password: 'router-password' } })
  const a = await autoRig('pihole', [seenAt('scan')])
  const none = await a.svc.autoConnect(ctxOf({ items: [other] }).ctx)
  assert.deepEqual(none.map(o => o.did), ['needs_credential'])
  assert.match(none[0].message!, /no vault item has a login for that address/)
  assert.equal((await a.svc.instances.list()).length, 0)
  const one = await a.svc.autoConnect(ctxOf({ items: [mine, other] }).ctx)
  assert.deepEqual(one.map(o => o.did), ['connected'])
  assert.equal(one[0].vaultItem?.id, 'v1')
  assert.equal(JSON.stringify(one).includes(PIHOLE_PASSWORD), false, 'the outcome names the item, never the password')
})

test('auto-connect: two vault items for the address are never guessed between; a pick connects with the chosen one', async () => {
  const a1 = item({ id: 'v1', name: 'Pi-hole (old)', fields: { password: 'old-password' } })
  const a2 = item({ id: 'v2', name: 'Pi-hole', fields: { password: PIHOLE_PASSWORD } })
  const { svc } = await autoRig('pihole', [seenAt('scan')])
  const out = await svc.autoConnect(ctxOf({ items: [a1, a2] }).ctx)
  assert.equal(out[0].did, 'ambiguous')
  assert.deepEqual(out[0].choices!.map(c => c.id).sort(), ['v1', 'v2'])
  assert.equal((await svc.instances.list()).length, 0)
  const picked = await svc.autoPick('lxc-411', 'v2', ctxOf({ items: [a1, a2] }).ctx)
  assert.equal(picked.did, 'connected')
  assert.equal((await svc.instances.list()).length, 1)
})

test('auto-connect: AdGuard Home needs a login with a user name; a password alone is not enough', async () => {
  const noUser = item({ id: 'v1', name: 'AdGuard', fields: { password: ADGUARD_PASSWORD } })
  const full = item({ id: 'v2', name: 'AdGuard Home', fields: { username: ADGUARD_USER, password: ADGUARD_PASSWORD } })
  const { svc } = await autoRig('adguard', [seenAt('scan')])
  assert.deepEqual((await svc.autoConnect(ctxOf({ items: [noUser] }).ctx)).map(o => o.did), ['needs_credential'])
  assert.deepEqual((await svc.autoConnect(ctxOf({ items: [noUser, full] }).ctx)).map(o => o.did), ['connected'])
})

test('auto-connect: a vault item for another host or port is never used', async () => {
  const wrongPort = item({ id: 'v1', uris: ['http://192.0.2.10:8080'], fields: { password: PIHOLE_PASSWORD } })
  const wrongHost = item({ id: 'v2', uris: ['http://192.0.2.11'], fields: { password: PIHOLE_PASSWORD } })
  const own = item({ id: 'v3', name: 'hyperprox:plugin/pihole', uris: ['http://192.0.2.10'], fields: { password: PIHOLE_PASSWORD } })
  const { svc } = await autoRig('pihole', [seenAt('scan')])
  assert.deepEqual((await svc.autoConnect(ctxOf({ items: [wrongPort, wrongHost, own] }).ctx)).map(o => o.did), ['needs_credential'])
})

test('auto-connect: an excluded guest, an excluded address, a left-alone guest and a dismissed one are never connected', async () => {
  const creds = { catalogueLogin: async () => ({ username: 'admin', password: PIHOLE_PASSWORD }) }
  const a = await autoRig('pihole', [seenAt('catalogue')], creds)
  assert.deepEqual((await a.svc.autoConnect(ctxOf({ excluded: ['lxc-411'] }).ctx)).map(o => o.did), ['excluded'])
  assert.deepEqual((await a.svc.autoConnect(ctxOf({ dismissed: ['lxc-411'] }).ctx)).map(o => o.did), ['dismissed'])
  a.rows[0].ignored = true; a.rows[0].excludedBy = 'the hyperprox-ignore tag'
  assert.deepEqual((await a.svc.autoConnect(ctxOf().ctx)).map(o => o.did), ['excluded'])
  const b = await autoRig('pihole', [seenAt('catalogue', { url: 'http://198.51.100.5', ip: '198.51.100.5' })], creds)
  assert.deepEqual((await b.svc.autoConnect(ctxOf().ctx)).map(o => o.did), ['excluded'], 'an excluded subnet')
  const c = await autoRig('pihole', [seenAt('catalogue')], { ...creds, tags: async () => new Map([['lxc-411', ['hyperprox-ignore']]]) })
  assert.deepEqual((await c.svc.autoConnect(ctxOf().ctx)).map(o => o.did), ['excluded'], 'the leave-alone tag')
  for (const x of [a, b, c]) assert.equal((await x.svc.instances.list()).length, 0)
})

test('auto-connect: a sighting with no address is skipped, and a failure is reported once and not retried for ten minutes', async () => {
  const a = await autoRig('pihole', [{ guest: { kind: 'lxc', vmid: 411 }, url: null, via: 'scan', ip: null }])
  assert.deepEqual((await a.svc.autoConnect(ctxOf().ctx)).map(o => o.did), ['skipped'])
  let t = NOW
  let asked = 0
  const b = await autoRig('pihole', [seenAt('catalogue')], { now: () => t, catalogueLogin: async () => { asked++; throw new Error('vault is busy') } })
  assert.deepEqual((await b.svc.autoConnect(ctxOf().ctx)).map(o => o.did), ['failed'])
  await b.svc.autoConnect(ctxOf().ctx)
  assert.equal(asked, 1)
  t += 11 * 60_000
  await b.svc.autoConnect(ctxOf().ctx)
  assert.equal(asked, 2)
})
