// A DNS blocker installed through the Catalogue wizard (previewInstall and applyPreview over a fake Proxmox and fake DNS
// and proxy), end to end: the plan, the vault item with the generated login, the script the container is given, the
// LAN-only and the published result, and what auto-connect then finds in the finished install and connects with. Nothing
// real is contacted.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { previewInstall, applyPreview } from '../src/lib/catalogue-installer'
import { MemoryWizardStore, setWizardStore } from '../src/lib/catalogue-store'
import { ServiceScanCache } from '../src/lib/service-scan'
import { sightingsOf } from '../src/lib/catalogue/sightings'
import { DnsBlockerService } from '../src/lib/dns-blocker/service'
import { DnsInstanceStore, type CredentialIO } from '../src/lib/dns-blocker/instances'
import type { PublishDeps, DnsLike } from '../src/lib/sites'
import type { AdapterContext } from '../src/lib/auto-connect/core'
import { FakePve, deps, INPUT, settled } from './fakes/catalogue-pve'
import { FakePihole, NOW } from './fakes/dns-blocker'

const INFO = '{"dns":true,"https_port":443,"took":1.8e-05}'

class FakeDns implements DnsLike {
  records: Record<string, Array<{ type: string; name: string; data: string; ttl?: number }>> = { 'example.com': [{ type: 'A', name: '@', data: '198.51.100.1' }] }
  created: any[] = []
  async getDomains() { return [{ domain: 'example.com', status: 'ACTIVE' }] }
  async getRecords(z: string) { return structuredClone(this.records[z] ?? []) }
  async createRecord(z: string, r: any) { this.created.push([z, r]); this.records[z].push({ ...r }) }
  async deleteRecord(z: string, type: string, name: string) { this.records[z] = this.records[z].filter(r => !(r.type === type && r.name === name)) }
}

function publishDeps(fetchPublic: PublishDeps['fetchPublic']) {
  const dns = new FakeDns()
  const calls: string[] = []
  const d: PublishDeps = {
    dns: async () => dns,
    proxy: {
      instances: async () => [{ id: 'npm-1', name: 'Edge NPM', kind: 'npm', status: 'ok', certificates: 'request' }],
      createHost: async (i, spec) => { calls.push(`host ${i} ${spec.domains.join()} -> ${spec.forwardHost}:${spec.forwardPort}`); return { hostId: '77' } },
      attachCertificate: async (i, h, c) => { calls.push(`attach ${i} ${h} ${c}`) },
      deleteHost: async () => {}, requestCertificate: async (i, names) => { calls.push(`cert ${i} ${names.join()}`); return { id: '9' } },
    },
    wanIp: async () => '203.0.113.7', resolve4: async () => ['203.0.113.7'], letsEncryptEmail: () => 'ops@example.com', fetchPublic, wait: async () => {},
  }
  return { d, dns, calls }
}

const saved = new Map<string, Record<string, string>>()
const scripts: string[] = []
let store = new MemoryWizardStore()
const savedScan = (ServiceScanCache.prototype as any).result
beforeEach(() => { store = new MemoryWizardStore(); saved.clear(); scripts.length = 0; setWizardStore(store); (ServiceScanCache.prototype as any).result = async () => ({ findings: [] }) })
afterEach(() => { (ServiceScanCache.prototype as any).result = savedScan })

const wizardDeps = (f: FakePve, over: Record<string, unknown> = {}) => deps(f, {
  saveSecrets: async (c: string, p: string, v: Record<string, string>) => { saved.set(`${c}/${p}`, v) },
  readSecrets: async () => ({}),
  exec: async (o: any) => { scripts.push(o.script); return { code: 0, output: '', timedOut: false } as any },
  probe: async () => ({ status: 200, body: INFO }),
  ...over,
})

const PIHOLE = (o: any = {}) => INPUT({ recipeId: 'pihole', hostname: 'pihole', memoryMb: 512, diskGb: 6, options: { DNS_UPSTREAMS: '9.9.9.9, 1.1.1.1' }, ...o })

test('a Pi-hole on the LAN only: the plan, the generated login in the vault, the script, and nothing published', async () => {
  const f = new FakePve()
  const d = wizardDeps(f)
  const r = await previewInstall(PIHOLE(), 'a@example.com', d)
  assert.deepEqual(r.errors, [])
  assert.equal(r.preview!.plan.publish, undefined)
  assert.deepEqual(r.preview!.plan.options, { DNS_UPSTREAMS: '9.9.9.9, 1.1.1.1' })
  const job = await settled((await applyPreview(r.preview!.id, 'a@example.com', d)).jobId)
  assert.equal(job.status, 'completed', job.error)
  assert.deepEqual(job.steps.map(s => s.id), ['container', 'network', 'install', 'verify', 'wire'])
  assert.equal(job.url, 'http://192.0.2.50:80')
  const item = saved.get('apps/pihole-102')!
  assert.deepEqual(Object.keys(item).sort(), ['admin_password', 'admin_user'])
  assert.equal(item.admin_user, 'admin')
  assert.ok(item.admin_password.length >= 20, 'a generated password, not a vendor default')
  assert.equal(job.adminCredential?.user, 'admin')
  assert.equal(job.adminCredential?.vault.provider, 'pihole-102')
  assert.match(scripts[0], new RegExp(`^export PIHOLE_PASSWORD='${item.admin_password}'$`, 'm'))
  assert.match(scripts[0], /^export DNS_UPSTREAMS='9\.9\.9\.9, 1\.1\.1\.1'$/m)
  assert.doesNotMatch(JSON.stringify(job).replace(item.admin_password, ''), /admin_password.*[A-Za-z0-9_-]{20,}/, 'the job result never carries the password into its log')
  assert.ok(!job.log.includes(item.admin_password), 'and the output log has none')
  const verify = job.steps.find(s => s.id === 'verify')!
  assert.match(verify.detail!, /http:\/\/192\.0\.2\.50:80\/api\/info\/login is answering/)
})

test('a wrong upstream list is refused in words before anything is created', async () => {
  const f = new FakePve()
  const r = await previewInstall(PIHOLE({ options: { DNS_UPSTREAMS: 'dns.example.com' } }), 'a@example.com', wizardDeps(f))
  assert.match(r.errors.join(' '), /Upstream DNS servers: "dns\.example\.com" is not an IP address/)
  assert.equal(f.creates.length, 0)
})

test('the web page can get a public name and a certificate; DNS itself is never proxied', async () => {
  const f = new FakePve()
  const p = publishDeps(async () => ({ status: 200, body: INFO }))
  const d = wizardDeps(f, { publish: p.d })
  const r = await previewInstall(PIHOLE({ recipeId: 'adguard-home', hostname: 'adguard', options: {}, publish: { zone: 'example.com', name: 'dns', instanceId: 'npm-1' } } as any), 'a@example.com', {
    ...d, probe: async () => ({ status: 200, body: '<link rel="mask-icon" href="assets/safari-pinned-tab.svg" color="#67B279"><script src="login.abc123.js"></script><div id="root"></div>' }),
  })
  assert.deepEqual(r.errors, [])
  assert.equal(r.preview!.plan.publish!.domain, 'dns.example.com')
  assert.equal(p.dns.created.length, 0, 'a preview writes nothing')
  const job = await settled((await applyPreview(r.preview!.id, 'a@example.com', { ...d, probe: async () => ({ status: 200, body: '<link rel="mask-icon" href="assets/safari-pinned-tab.svg" color="#67B279"><script src="login.abc123.js"></script><div id="root"></div>' }),
    publish: { ...p.d, fetchPublic: async () => ({ status: 200, body: '<link rel="mask-icon" href="assets/safari-pinned-tab.svg" color="#67B279"><script src="login.abc123.js"></script><div id="root"></div>' }) } })).jobId)
  assert.equal(job.status, 'completed', job.error)
  assert.deepEqual(job.steps.map(s => s.id), ['container', 'network', 'install', 'verify', 'wire', 'proxy', 'dns', 'propagate', 'cert', 'public'])
  assert.equal(job.url, 'https://dns.example.com')
  assert.ok(p.calls.includes('host npm-1 dns.example.com -> 192.0.2.50:80'), p.calls.join('; '))
  assert.deepEqual(p.dns.created.map(c => [c[0], c[1].name, c[1].data]), [['example.com', 'dns', '203.0.113.7']])
})

test('a recipe that is neither a website nor a DNS blocker still cannot be published', async () => {
  const f = new FakePve()
  const p = publishDeps(async () => ({ status: 200, body: '' }))
  const k = await previewInstall(INPUT({ publish: { zone: 'example.com', name: 'kuma', instanceId: 'npm-1' } } as any), 'a@example.com', wizardDeps(f, { publish: p.d }))
  assert.match(k.errors.join(), /only websites are/)
})

function ctxOf(): AdapterContext {
  return {
    dismissed: () => false, autoConnectedBefore: () => false, excludedMachines: new Set(), excludedSubnets: [], vaultItems: () => [],
    audit: async () => {}, now: () => NOW,
  }
}

test('what the install left is what auto-connect needs: the finished install is found, and the vault login connects it', async () => {
  const f = new FakePve()
  const d = wizardDeps(f)
  const r = await previewInstall(PIHOLE(), 'a@example.com', d)
  const job = await settled((await applyPreview(r.preview!.id, 'a@example.com', d)).jobId)
  assert.equal(job.status, 'completed', job.error)
  const password = saved.get('apps/pihole-102')!.admin_password

  // The sighting the Catalogue's finished install gives.
  const guests = [{ vmid: 102, name: 'pihole' }]
  const seen = await sightingsOf('pihole', 'pihole', { guests: async () => guests, minVmid: 100, ignoreScanFailure: true })
  assert.equal(seen.catalogue.length, 1)
  assert.deepEqual([seen.catalogue[0].guest, seen.catalogue[0].ip, seen.catalogue[0].admin], [{ type: 'lxc', vmid: 102 }, '192.0.2.50', 'admin'])

  // Auto-connect with the generated login from the vault; the blocker accepts only that password.
  const fake = new FakePihole(password)
  const mem = new Map<string, string>()
  const io: CredentialIO = { get: async (c, p, k) => mem.get(`${c}/${p}/${k}`) ?? null, set: async (c, p, k, v) => { mem.set(`${c}/${p}/${k}`, v) }, remove: async () => {} }
  const svc = new DnsBlockerService({
    kind: 'pihole', store: new DnsInstanceStore('pihole', io), audit: async () => {}, http: () => fake, probe: async () => ({ ok: true, ms: 3 }), resolve: async u => u.hostname, now: () => NOW,
    guests: async () => [{ kind: 'lxc', vmid: 102, name: 'pihole', node: 'node-a', running: true, ignored: false }], tags: async () => new Map(),
    sightings: async () => seen.catalogue.map(s => ({ guest: { kind: 'lxc' as const, vmid: s.guest.vmid }, url: s.url, via: 'catalogue', ip: s.ip, admin: s.admin })),
    catalogueLogin: async vmid => { const v = saved.get(`apps/pihole-${vmid}`); return v ? { username: v.admin_user, password: v.admin_password } : null },
  })
  const out = await svc.autoConnect(ctxOf())
  assert.deepEqual(out.map(o => o.did), ['connected'])
  const [meta] = await svc.instances.list()
  assert.equal((await svc.instances.login(meta.id))?.url, 'http://192.0.2.50')
  assert.equal((await svc.reading(meta.id)).totals.queries > 0, true, 'and its numbers can be read')
})

test('a published install is still connected by its own address, not through the public name', async () => {
  const sighting = { guest: { kind: 'lxc' as const, vmid: 102 }, url: 'https://dns.example.com', via: 'catalogue', ip: '192.0.2.50' }
  const fake = new FakePihole()
  const mem = new Map<string, string>()
  const io: CredentialIO = { get: async (c, p, k) => mem.get(`${c}/${p}/${k}`) ?? null, set: async (c, p, k, v) => { mem.set(`${c}/${p}/${k}`, v) }, remove: async () => {} }
  const svc = new DnsBlockerService({
    kind: 'pihole', store: new DnsInstanceStore('pihole', io), audit: async () => {}, http: () => fake, probe: async () => ({ ok: true, ms: 3 }), resolve: async u => u.hostname, now: () => NOW,
    guests: async () => [{ kind: 'lxc', vmid: 102, name: 'pihole', node: 'node-a', running: true, ignored: false }], tags: async () => new Map(), sightings: async () => [sighting],
    catalogueLogin: async () => ({ username: 'admin', password: 'pihole-test-password' }),
  })
  assert.deepEqual((await svc.autoConnect(ctxOf())).map(o => o.did), ['connected'])
  assert.equal((await svc.instances.login((await svc.instances.list())[0].id))?.url, 'http://192.0.2.50')
})
