// DNS provider routing and Cloudflare records over a pretend Cloudflare and a pretend GoDaddy: which provider
// serves a zone, record CRUD with the proxied defaults, value checks, and names, types and ids that try to
// walk out of their URL path segment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CloudflareClient } from '../src/lib/cloudflare-client'
import { DnsRouter, cloudflareBackend, godaddyBackend, checkedRecordName, pickRecord, type ZoneBackend } from '../src/lib/dns-providers'
import { FakeCloudflare } from './fakes/cloudflare'

/** A GoDaddy stand-in with the client's calls; it records what it was asked. */
function fakeGoDaddy(domains: string[], records: Record<string, any[]> = {}) {
  const calls: string[] = []
  const gd = {
    calls,
    getDomains: async () => domains.map(domain => ({ domain, status: 'ACTIVE', domainId: 1, renewAuto: true, locked: true, createdAt: '', nameServers: null })),
    getDomain: async (d: string) => ({ domain: d, status: 'ACTIVE' }) as any,
    getRecords: async (d: string) => { calls.push(`get ${d}`); return records[d] ?? [] },
    getRecordsByName: async (d: string, t: string, n: string) => (records[d] ?? []).filter(r => r.type === t && r.name === n),
    createRecord: async (d: string, r: any) => { calls.push(`create ${d} ${JSON.stringify(r)}`) },
    updateRecord: async (d: string, t: string, n: string, r: any) => { calls.push(`update ${d} ${t} ${n} ${JSON.stringify(r)}`) },
    replaceRecords: async () => { calls.push('replace') },
    deleteRecord: async (d: string, t: string, n: string) => { calls.push(`delete ${d} ${t} ${n}`) },
  }
  return gd
}

function cfWorld() {
  const cf = new FakeCloudflare()
  const client = new CloudflareClient({ token: cf.validToken }, { fetch: cf.fetch, sleep: async () => {} })
  return { cf, client, backend: cloudflareBackend(client) }
}

test('routing: each zone goes to the provider that holds it; both listed → the active Cloudflare zone wins', async () => {
  const { cf, backend } = cfWorld()
  cf.addZone('example.net')                      // only at Cloudflare
  cf.addZone('example.com')                      // registered at GoDaddy, DNS moved to Cloudflare
  cf.addZone('example.org', 'pending')           // Cloudflare pending: GoDaddy still serves it
  const gd = fakeGoDaddy(['example.com', 'example.org', 'example.test'])
  const r = new DnsRouter([godaddyBackend(gd as any), backend])
  const list = await r.getDomains()
  assert.deepEqual(list.map(z => [z.domain, z.provider]), [
    ['example.com', 'cloudflare'], ['example.net', 'cloudflare'], ['example.org', 'godaddy'], ['example.test', 'godaddy']])
  assert.equal(await r.providerOf('example.com'), 'cloudflare')
  assert.equal(await r.providerOf('EXAMPLE.org'), 'godaddy')
  // A write lands only at the chosen provider.
  await r.createRecord('example.test', { type: 'A', name: 'www', data: '192.0.2.1', ttl: 600 })
  assert.equal(gd.calls.filter(c => c.startsWith('create example.test')).length, 1)
  assert.ok(!cf.calls.some(c => c.method === 'POST'))
  await r.createRecord('example.com', { type: 'A', name: 'www', data: '192.0.2.1', ttl: 600 })
  assert.ok(!gd.calls.some(c => c.startsWith('create example.com')))
  assert.equal(cf.records.filter(x => x.name === 'www.example.com').length, 1)
})

test('routing: a domain no provider holds is refused, never guessed', async () => {
  const r = new DnsRouter([godaddyBackend(fakeGoDaddy(['example.com']) as any)])
  await assert.rejects(r.getRecords('example.net'), /not a domain any configured DNS provider holds/)
  await assert.rejects(r.createRecord('evil-example.test', { type: 'A', name: 'x', data: '192.0.2.1' }), /not a domain/)
})

test('routing: one provider failing leaves the other serving, and the failure is reported', async () => {
  const { cf, backend } = cfWorld()
  cf.addZone('example.net')
  const broken: ZoneBackend = { ...godaddyBackend(fakeGoDaddy([]) as any), zones: async () => { throw new Error('GoDaddy GET /domains failed 503') } }
  const r = new DnsRouter([broken, backend])
  assert.deepEqual((await r.getDomains()).map(z => z.domain), ['example.net'])
  const p = await r.providers()
  assert.deepEqual(p.map(x => [x.id, x.ok, x.zones]), [['godaddy', false, 0], ['cloudflare', true, 1]])
  assert.match(p[0].error!, /503/)
  // Every provider failing is an error, not an empty list.
  const all = new DnsRouter([broken])
  await assert.rejects(all.getDomains(), /GoDaddy: GoDaddy GET \/domains failed 503/)
})

test('zero zones: a working Cloudflare account with no domains is a provider with 0 zones', async () => {
  const { backend } = cfWorld()
  const r = new DnsRouter([backend])
  assert.deepEqual(await r.getDomains(), [])
  assert.deepEqual(await r.providers(), [{ id: 'cloudflare', label: 'Cloudflare', ok: true, zones: 0, active: 0 }])
})

test('Cloudflare records: names are zone-relative, and a new record is DNS only unless asked', async () => {
  const { cf, backend } = cfWorld()
  const z = cf.addZone('example.com')
  const r = new DnsRouter([backend])
  await r.createRecord('example.com', { type: 'A', name: 'app', data: '192.0.2.10', ttl: 600 })
  await r.createRecord('example.com', { type: 'CNAME', name: 'www', data: 'example.com.', proxied: true })
  await r.createRecord('example.com', { type: 'A', name: '@', data: '192.0.2.11' })
  const sent = cf.calls.filter(c => c.method === 'POST').map(c => c.body)
  assert.deepEqual(sent[0], { type: 'A', name: 'app.example.com', ttl: 600, proxied: false, content: '192.0.2.10' })
  assert.deepEqual(sent[1], { type: 'CNAME', name: 'www.example.com', ttl: 1, proxied: true, content: 'example.com' }, 'proxied → TTL Auto')
  assert.equal(sent[2].name, 'example.com')
  const recs = await r.getRecords('example.com')
  assert.deepEqual(recs.map(x => [x.type, x.name, x.data, x.proxied]).sort(), [
    ['A', '@', '192.0.2.11', false], ['A', 'app', '192.0.2.10', false], ['CNAME', 'www', 'example.com', true]])
  assert.ok(recs.every(x => /^[a-f0-9]{32}$/.test(x.id!)))
  assert.equal(cf.records.length, 3); void z
})

test('Cloudflare records: an edit keeps the record proxied unless it says otherwise', async () => {
  const { cf, backend } = cfWorld()
  const z = cf.addZone('example.com')
  const rec = cf.addRecord(z, { type: 'A', name: 'app.example.com', content: '192.0.2.10', ttl: 1, proxied: true })
  const r = new DnsRouter([backend])
  await r.updateRecord('example.com', 'A', 'app', { data: '192.0.2.20', ttl: 600 })
  assert.equal(rec.content, '192.0.2.20')
  assert.equal(rec.proxied, true, 'still proxied')
  assert.equal(rec.ttl, 1, 'a proxied record is TTL Auto')
  await r.updateRecord('example.com', 'A', 'app', { proxied: false, ttl: 600 })
  assert.equal(rec.proxied, false)
  assert.equal(rec.ttl, 600)
  assert.equal(rec.content, '192.0.2.20', 'the value is kept when only the proxy changes')
  assert.equal(cf.calls.filter(c => c.method === 'PATCH').length, 2)
})

test('Cloudflare records: proxy only where Cloudflare allows it, and values checked per type', async () => {
  const { cf, backend } = cfWorld()
  cf.addZone('example.com')
  const r = new DnsRouter([backend])
  await assert.rejects(r.createRecord('example.com', { type: 'TXT', name: '@', data: 'v=spf1 -all', proxied: true }), /cannot be proxied/)
  await assert.rejects(r.createRecord('example.com', { type: 'A', name: 'x', data: 'not-an-ip' }), /IPv4/)
  await assert.rejects(r.createRecord('example.com', { type: 'AAAA', name: 'x', data: '192.0.2.1' }), /IPv6/)
  await assert.rejects(r.createRecord('example.com', { type: 'CNAME', name: 'x', data: 'https://example.net/' }), /hostname/)
  await assert.rejects(r.createRecord('example.com', { type: 'A', name: 'x', data: '192.0.2.1', ttl: 30 }), /TTL/)
  await assert.rejects(r.createRecord('example.com', { type: 'NS', name: 'x', data: 'ns.example.net' }), /not NS/)
  assert.ok(!cf.calls.some(c => c.method === 'POST'), 'nothing invalid was sent')
})

test('Cloudflare records: MX, TXT, SRV and CAA map both ways', async () => {
  const { cf, backend } = cfWorld()
  cf.addZone('example.com')
  const r = new DnsRouter([backend])
  await r.createRecord('example.com', { type: 'MX', name: '@', data: 'mail.example.net.', priority: 5, ttl: 3600 })
  await r.createRecord('example.com', { type: 'TXT', name: '@', data: 'v=spf1 include:example.net -all', ttl: 600 })
  await r.createRecord('example.com', { type: 'SRV', name: '@', service: '_sip', protocol: '_tcp', data: 'sip.example.net', priority: 10, weight: 5, port: 5060 })
  await r.createRecord('example.com', { type: 'CAA', name: '@', data: '0 issue "letsencrypt.org"' })
  const sent = cf.calls.filter(c => c.method === 'POST').map(c => c.body)
  assert.equal(sent[0].priority, 5); assert.equal(sent[0].content, 'mail.example.net'); assert.equal(sent[0].proxied, undefined)
  assert.deepEqual(sent[2], { type: 'SRV', name: '_sip._tcp.example.com', ttl: 1, data: { priority: 10, weight: 5, port: 5060, target: 'sip.example.net' } }, 'no proxied flag on a type that cannot be proxied')
  assert.deepEqual(sent[3].data, { flags: 0, tag: 'issue', value: 'letsencrypt.org' })
  // Cloudflare hands TXT back quoted and SRV/CAA as structured data.
  cf.records.find(x => x.type === 'TXT')!.content = '"v=spf1 include:example.net -all"'
  cf.records.find(x => x.type === 'CAA')!.content = undefined
  const back = await r.getRecords('example.com')
  const by = (t: string) => back.find(x => x.type === t)!
  assert.equal(by('TXT').data, 'v=spf1 include:example.net -all')
  assert.deepEqual([by('SRV').name, by('SRV').data, by('SRV').port, by('SRV').service, by('SRV').protocol], ['_sip._tcp', 'sip.example.net', 5060, '_sip', '_tcp'])
  assert.equal(by('CAA').data, '0 issue "letsencrypt.org"')
  assert.equal(by('MX').priority, 5)
})

test('Cloudflare records: a name with several values is edited or deleted one at a time, by id', async () => {
  const { cf, backend } = cfWorld()
  const z = cf.addZone('example.com')
  const a = cf.addRecord(z, { type: 'TXT', name: 'example.com', content: 'one', ttl: 1 })
  const b = cf.addRecord(z, { type: 'TXT', name: 'example.com', content: 'two', ttl: 1 })
  const r = new DnsRouter([backend])
  await assert.rejects(r.updateRecord('example.com', 'TXT', '@', { data: 'x' }), /has 2 TXT records/)
  await r.updateRecord('example.com', 'TXT', '@', { data: 'two-b' }, { id: b.id })
  assert.equal(b.content, 'two-b'); assert.equal(a.content, 'one')
  await r.deleteRecord('example.com', 'TXT', '@', { id: a.id })
  assert.deepEqual(cf.records.map(x => x.content), ['two-b'])
  await assert.rejects(r.deleteRecord('example.com', 'TXT', '@', { id: a.id }), /with that id/)
  await r.deleteRecord('example.com', 'TXT', '@')
  assert.equal(cf.records.length, 0)
})

test('Cloudflare DDNS: A records move to the WAN address by id; proxied stays as it was', async () => {
  const { cf, backend } = cfWorld()
  const z = cf.addZone('example.com')
  const p = cf.addRecord(z, { type: 'A', name: 'example.com', content: '192.0.2.1', ttl: 1, proxied: true })
  const d = cf.addRecord(z, { type: 'A', name: 'home.example.com', content: '192.0.2.1', ttl: 600, proxied: false })
  cf.addRecord(z, { type: 'A', name: 'same.example.com', content: '198.51.100.7', ttl: 600, proxied: false })
  const out = await new DnsRouter([backend]).updateDDNS('example.com', '198.51.100.7', ['home'])
  assert.deepEqual(out, { updated: ['@'], skipped: ['home', 'same'], wanIP: '198.51.100.7' })
  assert.equal(p.content, '198.51.100.7'); assert.equal(p.proxied, true)
  assert.equal(d.content, '192.0.2.1')
})

test('injection: domains, names, types and ids that try to leave their path segment are refused before any request', async () => {
  const { cf, backend } = cfWorld()
  cf.addZone('example.com')
  const gd = fakeGoDaddy(['example.com'])
  for (const be of [backend, godaddyBackend(gd as any)]) {
    const r = new DnsRouter([be])
    for (const dom of ['../../user/tokens', 'example.com/../..', 'example.com?x=1', 'example.com%2f..', 'example.com#x'])
      await assert.rejects(r.getRecords(dom), /not a domain/, dom)
    for (const name of ['../../zones', 'a/b', 'a?b', 'a b', '%2e%2e', 'a..b', 'x.*', '-bad'])
      await assert.rejects(r.deleteRecord('example.com', 'A', name), /not a record name/, name)
    for (const type of ['A/../..', '../zones', 'ANY', '%41'])
      await assert.rejects(r.deleteRecord('example.com', type, 'www'), /Unknown DNS record type/, type)
    for (const id of ['../../zones', 'abc', '0123456789abcdef0123456789abcdef/x'])
      await assert.rejects(r.deleteRecord('example.com', 'A', 'www', { id }), /not a record id/, id)
  }
  assert.ok(!cf.calls.some(c => c.method !== 'GET' || /dns_records/.test(c.url)), 'only the zone list was ever read')
  assert.ok(!gd.calls.some(c => c.startsWith('delete')))
})

test('a record body is copied field by field; anything else the browser sends is dropped', () => {
  const r = pickRecord({ type: 'a', name: 'WWW', data: '192.0.2.1', ttl: 600, proxied: 'yes', zone_id: 'x', id: 'y', __proto__: { admin: true }, comment: 'c' })
  assert.deepEqual(r, { type: 'A', name: 'www', data: '192.0.2.1', ttl: 600, proxied: false })
  assert.equal(checkedRecordName('*.app'), '*.app')
  assert.equal(checkedRecordName('_acme-challenge.mail'), '_acme-challenge.mail')
  assert.throws(() => pickRecord({ type: 'A', name: 'x', data: '1', ttl: 'NaN' }), /TTL/)
})

test('GoDaddy through the router behaves as before, and refuses a proxy flag it does not have', async () => {
  const gd = fakeGoDaddy(['example.com'])
  const r = new DnsRouter([godaddyBackend(gd as any)])
  await r.createRecord('example.com', { type: 'A', name: 'app', data: '192.0.2.10', ttl: 600, extra: 'dropped' })
  assert.deepEqual(gd.calls.at(-1), 'create example.com {"type":"A","name":"app","data":"192.0.2.10","ttl":600}')
  await assert.rejects(r.createRecord('example.com', { type: 'A', name: 'app', data: '192.0.2.10', proxied: true }), /only Cloudflare/)
})
