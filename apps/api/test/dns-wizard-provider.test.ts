// The wizards create their records at the provider that holds the zone: the website/catalogue publish
// (also Arr, Seerr and PBS public names, which run through planPublish/runPublish) and the AI deploy wizard's
// create_dns step. Cloudflare records they make are DNS only, and a record someone set to proxied is named
// as the reason, rather than a vague propagation timeout or a failed Let's Encrypt request.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planPublish, runPublish, type PublishDeps, type PublishLedger } from '../src/lib/sites'
import { findRecipe } from '../src/lib/catalogue'
import { stepCreateDNS, type ExecDeps, type JobState } from '../src/lib/wizard-executor'
import { CloudflareClient } from '../src/lib/cloudflare-client'
import { DnsRouter, cloudflareBackend, godaddyBackend } from '../src/lib/dns-providers'
import { cloudflareProvider } from '../src/lib/certs/dns01'
import { FakeCloudflare } from './fakes/cloudflare'

function world() {
  const cf = new FakeCloudflare()
  cf.addZone('example.com')
  const gdCreated: any[] = []
  const gd = {
    getDomains: async () => [{ domain: 'example.org', status: 'ACTIVE' }],
    getDomain: async () => ({}), getRecordsByName: async () => [],
    getRecords: async () => [] as any[],
    createRecord: async (z: string, r: any) => { gdCreated.push([z, r]) },
    updateRecord: async () => {}, replaceRecords: async () => {}, deleteRecord: async () => {},
  }
  const client = new CloudflareClient({ token: cf.validToken }, { fetch: cf.fetch, sleep: async () => {} })
  // A fresh router per call, as production makes one per request.
  const router = () => new DnsRouter([godaddyBackend(gd as any), cloudflareBackend(client)])
  return { cf, gdCreated, router, client }
}

function publishDeps(router: () => DnsRouter, over: Partial<PublishDeps> = {}): { d: PublishDeps; calls: string[] } {
  const calls: string[] = []
  const d: PublishDeps = {
    dns: async () => { const r = router(); return { getDomains: async () => (await r.getDomains()).filter(z => z.active), getRecords: z => r.getRecords(z), createRecord: (z, rec) => r.createRecord(z, rec), deleteRecord: (z, t, n) => r.deleteRecord(z, t, n) } },
    proxy: {
      instances: async () => [{ id: 'npm-1', name: 'Edge NPM', kind: 'npm', status: 'ok', certificates: 'request' }],
      createHost: async () => { calls.push('host'); return { hostId: '77' } },
      attachCertificate: async () => { calls.push('attach') },
      deleteHost: async () => {},
      requestCertificate: async () => { calls.push('cert'); return { id: '9' } },
    },
    wanIp: async () => '203.0.113.7',
    resolve4: async () => ['203.0.113.7'],
    letsEncryptEmail: () => 'ops@example.com',
    fetchPublic: async () => ({ status: 200, body: '<form id="loginform">' }),
    wait: async () => {},
    ...over,
  }
  return { d, calls }
}

const hooks = (steps: Record<string, any>) => ({ step: (id: string) => (steps[id] = { status: 'running' }), save: () => {} })

test('publish: a Cloudflare zone gets its record at Cloudflare, DNS only, and the plan says so', async () => {
  const { cf, gdCreated, router } = world()
  const { d, calls } = publishDeps(router)
  const p = await planPublish({ zone: 'example.com', name: 'blog', instanceId: 'npm-1' }, d)
  assert.deepEqual(p.errors, [])
  assert.ok(p.checks.some(c => /on Cloudflare: the record is made DNS only \(grey cloud\)/.test(c)))
  const ledger: PublishLedger = {}
  const url = await runPublish(p.plan!, findRecipe('wordpress')!, '192.0.2.80', 'a@example.com', ledger, hooks({}), d)
  assert.equal(url, 'https://blog.example.com')
  const made = cf.records.find(r => r.name === 'blog.example.com')!
  assert.equal(made.type, 'A'); assert.equal(made.content, '203.0.113.7'); assert.equal(made.proxied, false)
  assert.equal(gdCreated.length, 0)
  assert.deepEqual(calls, ['host', 'cert', 'attach'])
})

test('publish: a GoDaddy zone still goes to GoDaddy', async () => {
  const { cf, gdCreated, router } = world()
  const { d } = publishDeps(router)
  const p = await planPublish({ zone: 'example.org', name: 'blog', instanceId: 'npm-1' }, d)
  assert.ok(!p.checks.some(c => /Cloudflare/.test(c)))
  await runPublish(p.plan!, findRecipe('wordpress')!, '192.0.2.80', 'a@example.com', {}, hooks({}), d)
  assert.deepEqual(gdCreated, [['example.org', { type: 'A', name: 'blog', data: '203.0.113.7', ttl: 600 }]])
  assert.ok(!cf.calls.some(c => c.method === 'POST'))
})

test('publish: a record proxied after it was made is named as the reason, and no certificate is requested', async () => {
  const { cf, router } = world()
  // The name resolves to Cloudflare, never to the WAN address.
  const { d, calls } = publishDeps(router, { resolve4: async () => ['104.16.0.1'] })
  const p = await planPublish({ zone: 'example.com', name: 'blog', instanceId: 'npm-1' }, d)
  const real = d.dns
  d.dns = async () => { const x = (await real())!; return { ...x, createRecord: async (z, rec) => { await x.createRecord(z, rec); cf.records.at(-1)!.proxied = true } } }
  await assert.rejects(runPublish(p.plan!, findRecipe('wordpress')!, '192.0.2.80', 'a@example.com', {}, hooks({}), d),
    /proxied through Cloudflare \(orange cloud\).*Set the record to DNS only/)
  assert.ok(!calls.includes('cert'))
})

test('publish: proxied between propagation and the certificate is refused before Let\'s Encrypt is asked', async () => {
  const { cf, router } = world()
  const { d, calls } = publishDeps(router, { resolve4: async () => { const r = cf.records.find(x => x.name === 'blog.example.com'); if (r) r.proxied = true; return ['203.0.113.7'] } })
  const p = await planPublish({ zone: 'example.com', name: 'blog', instanceId: 'npm-1' }, d)
  await assert.rejects(runPublish(p.plan!, findRecipe('wordpress')!, '192.0.2.80', 'a@example.com', {}, hooks({}), d), /orange cloud/)
  assert.deepEqual(calls, ['host'])
})

test('a pending Cloudflare zone is not offered to the wizards', async () => {
  const { cf, router } = world()
  cf.addZone('example.net', 'pending')
  const { d } = publishDeps(router)
  const p = await planPublish({ zone: 'example.net', name: 'blog', instanceId: 'npm-1' }, d)
  assert.match(p.errors.join(), /not one of the domains/)
})

test('deploy wizard create_dns: written at the provider holding the zone, DNS only', async () => {
  const { cf, gdCreated, router } = world()
  const job = (domain: string) => ({ jobId: 'j', status: 'running', steps: [], currentStep: 0, startedAt: 0, run: { fields: { domain }, owner: 'a@example.com' } }) as unknown as JobState
  const deps = { dns: async () => router(), wanIp: async () => '203.0.113.5' } as unknown as ExecDeps
  assert.match(await stepCreateDNS(job('home.example.com'), deps), /home\.example\.com → 203\.0\.113\.5/)
  const r = cf.records.find(x => x.name === 'home.example.com')!
  assert.equal(r.proxied, false); assert.equal(r.ttl, 600)
  await stepCreateDNS(job('home.example.org'), deps)
  assert.deepEqual(gdCreated, [['example.org', { type: 'A', name: 'home', data: '203.0.113.5', ttl: 600 }]])
})

test('certificates: DNS-01 at Cloudflare adds one TXT record and removes only its own value', async () => {
  const { cf, client } = world()
  cf.addZone('example.net', 'pending')
  const z = cf.zones[0]
  cf.addRecord(z, { type: 'TXT', name: '_acme-challenge.mail.example.com', content: '"other-order"', ttl: 600 })
  const p = cloudflareProvider(client)
  assert.equal(p.name, 'cloudflare')
  assert.deepEqual(await p.zones(), ['example.com'], 'only active zones are managed')
  await p.present('example.com', '_acme-challenge.mail.example.com', 'tok-1')
  await p.present('example.com', '_acme-challenge.mail.example.com', 'tok-1')
  assert.deepEqual(cf.records.map(r => r.content), ['"other-order"', 'tok-1'], 'idempotent')
  assert.equal(cf.records[1].ttl, 600)
  await p.cleanup('example.com', '_acme-challenge.mail.example.com', 'tok-1')
  assert.deepEqual(cf.records.map(r => r.content), ['"other-order"'])
  await assert.rejects(p.present('example.com', '_acme-challenge.mail.example.org', 'x'), /not inside zone/)
  await assert.rejects(p.present('example.net', '_acme-challenge.example.net', 'x'), /not an active zone/)
})
