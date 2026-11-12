// Deleting a website (lib/site-delete.ts, routes/sites.ts): the preview per site kind, ownership defaults,
// orphans, the guards, read-back, a partial failure and its retry, the container identity check and the
// backup-job clean-up (lib/clusters/guest-actions.ts).

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { buildSiteRoutes } from '../src/routes/sites'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { setWizardStore, MemoryWizardStore } from '../src/lib/catalogue-store'
import { recordSite, getSite, forgetSite, type SiteRecord, type PublishLedger } from '../src/lib/sites'
import { MemoryMetricsStore } from '../src/lib/site-metrics/store'
import { defaultState } from '../src/lib/site-metrics/collector'
import {
  buildDeletePreview, checkChoice, runDelete, DeletePreviewStore, DELETE_PREVIEW_TTL_MS, SiteDeleteRefusal, type SiteDeleteDeps, type ProxyHostInfo,
} from '../src/lib/site-delete'
import { removeFromBackupJobs, destroyOwned } from '../src/lib/clusters/guest-actions'
import { homeNodeRunner, pbsMountCleanup } from '../src/lib/pbs/setup-deps'
import { clusterContext, isRemoteContext } from '../src/lib/clusters/context'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

const MARK = (j: string) => `hyperprox-install: ${j}`

// ── A small cluster, DNS provider and proxy ─────────────────────────────────

interface Guest { node: string; type: 'lxc' | 'qemu'; status: string; hostname: string; description: string }

function world() {
  const guests = new Map<number, Guest>()
  const ha = new Set<string>()
  let jobs: Array<{ id: string; vmid?: string; all?: number }> = []
  const calls: string[] = []
  const fail = { haRead: false, destroy: false }
  const pve = {
    async fetchStrict<T>(path: string, method = 'GET', body?: string): Promise<T> {
      calls.push(`${method} ${path}${body ? ' ' + body : ''}`)
      const p = path.split('?')[0]
      if (p === '/cluster/resources') return [...guests].map(([vmid, g]) => ({ vmid, node: g.node, type: g.type, status: g.status, name: g.hostname })) as T
      if (p === '/cluster/ha/resources' && method === 'GET') { if (fail.haRead) throw new Error('HTTP 500'); return [...ha].map(sid => ({ sid })) as T }
      let m = /^\/cluster\/ha\/resources\/(.+)$/.exec(p)
      if (m && method === 'DELETE') { ha.delete(decodeURIComponent(m[1])); return null as T }
      if (p === '/cluster/backup' && method === 'GET') return structuredClone(jobs) as T
      m = /^\/cluster\/backup\/(.+)$/.exec(p)
      if (m && method === 'DELETE') { jobs = jobs.filter(j => j.id !== decodeURIComponent(m![1])); return null as T }
      if (m && method === 'PUT') { const j = jobs.find(x => x.id === decodeURIComponent(m![1]))!; j.vmid = new URLSearchParams(body).get('vmid')!; return null as T }
      m = /^\/nodes\/([^/]+)\/(lxc|qemu)\/(\d+)(\/.*)?$/.exec(p)
      if (m) {
        const g = guests.get(Number(m[3]))
        if (!g || g.node !== m[1]) throw new Error(`Proxmox ${method} ${path}: HTTP 500 — does not exist`)
        const rest = m[4] ?? ''
        if (rest === '/config') return { hostname: g.hostname, description: g.description } as T
        if (rest === '/status/current') return { status: g.status, name: g.hostname, ha: { managed: ha.has(`ct:${m[3]}`) ? 1 : 0 } } as T
        if (rest === '/status/stop' && method === 'POST') { g.status = 'stopped'; return 'UPID:stop' as T }
        if (rest === '' && method === 'DELETE') {
          if (fail.destroy) throw new Error('Proxmox DELETE: HTTP 500 — storage busy')
          guests.delete(Number(m[3])); return 'UPID:destroy' as T
        }
      }
      throw new Error(`unexpected ${method} ${path}`)
    },
    async waitForTask() {},
  }
  const zone: Array<{ type: string; name: string; data: string }> = []
  const dnsCalls: string[] = []
  const dnsFail = { delete: false }
  const dns = {
    getDomains: async () => [{ domain: 'example.net', provider: 'cloudflare' }],
    getRecords: async (z: string) => (z === 'example.net' ? structuredClone(zone) : []),
    createRecord: async () => {},
    deleteRecord: async (z: string, type: 'A', name: string) => {
      dnsCalls.push(`delete ${type} ${name}.${z}`)
      if (dnsFail.delete) throw new Error('the DNS provider answered 503')
      for (let i = zone.length - 1; i >= 0; i--) if (zone[i].type === type && zone[i].name === name) zone.splice(i, 1)
    },
  }
  let hosts: ProxyHostInfo[] = []
  let certs: Array<{ id: string; names: string[] }> = []
  const others: Array<{ hostKind: string; id: string; certificateId: string | null }> = []
  const proxyCalls: string[] = []
  const metrics = new MemoryMetricsStore()
  const audits: Array<{ action: string; details?: any }> = []
  const auditFail = { start: false }
  const pbs: number[] = []
  const vault = new Map<string, Record<string, string>>()
  const vaultState = { made: true as boolean | null, locked: false }
  const deps: SiteDeleteDeps = {
    dns: async () => dns,
    proxy: {
      hosts: async () => ({ hosts: structuredClone(hosts), errors: [] }),
      instanceHosts: async id => structuredClone(hosts.filter(h => h.instanceId === id)),
      deleteHost: async (id, hostId) => { proxyCalls.push(`delete host ${id}/${hostId}`); hosts = hosts.filter(h => !(h.instanceId === id && h.id === hostId)) },
      certificateUsers: async id => [...hosts.filter(h => h.instanceId === id).map(h => ({ hostKind: 'proxy', id: h.id, certificateId: h.certificateId ?? null })), ...others],
      certificates: async () => structuredClone(certs),
      deleteCertificate: async (_id, c) => { proxyCalls.push(`delete cert ${c}`); certs = certs.filter(x => x.id !== c) },
    },
    guest: { pve: pve as any, sleep: async () => {}, afterDestroy: async g => { pbs.push(g.vmid); return '' } },
    ledger: async s => s.published ?? null,
    hostname: async s => s.hostname ?? null,
    installMark: MARK,
    vaultCreatedByInstall: async () => vaultState.made,
    vaultKeys: async (c, p) => { if (vaultState.locked) throw new Error('HyperProx is locked'); const f = vault.get(`${c}/${p}`) ?? {}; return Object.keys(f).filter(k => f[k]).sort() },
    deleteVault: async (c, p) => { vault.set(`${c}/${p}`, {}) },
    vaultName: (c, p) => `hyperprox/${c}/${p}`,
    site: getSite,
    forget: forgetSite,
    deleteMetrics: id => metrics.deleteSite(id),
    metricsLeft: async id => (await metrics.getState(id)) !== null,
    audit: async (action, _r, details) => {
      if (auditFail.start && action === 'site.delete.item.start') throw new Error('database unavailable')
      audits.push({ action, details })
    },
    now: () => Date.now(),
  }
  return {
    deps, guests, ha, calls, fail, zone, dnsCalls, dnsFail, metrics, audits, auditFail, pbs, proxyCalls, others, vault, vaultState,
    get jobs() { return jobs }, set jobs(v) { jobs = v },
    get hosts() { return hosts }, set hosts(v) { hosts = v },
    get certs() { return certs }, set certs(v) { certs = v },
  }
}

const LEDGER: PublishLedger = {
  proxyHost: { instanceId: 'npm', hostId: '41' },
  dnsRecord: { zone: 'example.net', type: 'A', name: 'tester', data: '203.0.113.9' },
  certificate: { instanceId: 'npm', id: '77' },
}
const recipeSite = (over: Partial<SiteRecord> = {}): SiteRecord => ({
  id: 'job-1', recipeId: 'static-site', name: 'tester.example.net', vmid: 4201, node: 'node-a', ip: '192.0.2.42',
  domain: 'tester.example.net', url: 'https://tester.example.net', jobId: 'job-1', owner: 'admin@example.com', createdAt: 1,
  hostname: 'tester', published: structuredClone(LEDGER), ...over,
})
const adoptedSite = (over: Partial<SiteRecord> = {}): SiteRecord => ({
  id: 'a1', recipeId: 'adopted-wordpress', name: 'shop.example.net', vmid: 4300, node: 'node-b', domain: 'shop.example.net',
  url: 'https://shop.example.net', jobId: 'adopted', owner: 'admin@example.com', createdAt: 1, ...over,
})

/** The usual published recipe site: container running under HA, its record, host and certificate all present. */
function published(w: ReturnType<typeof world>) {
  w.guests.set(4201, { node: 'node-a', type: 'lxc', status: 'running', hostname: 'tester', description: `Static site.\n${MARK('job-1')}` })
  w.ha.add('ct:4201')
  w.jobs = [{ id: 'backup-daily', vmid: '4100,4201,4400' }, { id: 'backup-tester', vmid: '4201' }, { id: 'backup-all', all: 1 }]
  w.zone.push({ type: 'A', name: 'tester', data: '203.0.113.9' }, { type: 'TXT', name: 'tester', data: 'v=spf1 -all' })
  w.hosts = [{ instanceId: 'npm', instanceName: 'Nginx Proxy Manager', kind: 'npm', id: '41', domains: ['tester.example.net'], certificateId: '77' }]
  w.certs = [{ id: '77', names: ['tester.example.net'] }]
}

let store: MemoryWizardStore
beforeEach(() => { store = new MemoryWizardStore(); setWizardStore(store) })

const item = (b: { items: any[] }, key: string) => b.items.find(i => i.key === key)

// ── Preview content per site kind ────────────────────────────────────────────

test('a recipe site: record, DNS, proxy host and certificate ticked (HyperProx made them), container offered but off', async () => {
  const w = world(); published(w)
  const s = recipeSite(); await recordSite(s)
  const b = await buildDeletePreview(s, w.deps)
  assert.deepEqual(b.items.map(i => [i.key, i.state, i.offered, i.defaultOn, i.owned]), [
    ['record', 'present', true, true, true],
    ['dns', 'present', true, true, true],
    ['proxy:npm:41', 'present', true, true, true],
    ['cert:npm:77', 'present', true, true, true],
    ['container', 'present', true, false, true],
  ])
  assert.equal(item(b, 'record').locked, true)
  assert.equal(item(b, 'container').danger, 'Deletes the container and its disk, permanently.')
  assert.match(item(b, 'container').notes.join(' '), /under HA.*taken out of HA first/)
  assert.match(item(b, 'container').notes.join(' '), /running: it is stopped first/)
  assert.match(item(b, 'container').notes.join(' '), /backup job\(s\) backup-daily, backup-tester/)
  assert.match(item(b, 'dns').notes.join(' '), /TXT v=spf1 -all, which HyperProx leaves alone/)
  assert.equal(item(b, 'cert:npm:77').requires, 'proxy:npm:41')
  assert.equal(w.calls.filter(c => !c.startsWith('GET')).length, 0, 'a preview writes nothing')
  assert.equal(w.dnsCalls.length + w.proxyCalls.length, 0)
})

test('an adopted site: only "stop tracking" is ticked; DNS and proxy need the name typed; the container is never offered', async () => {
  const w = world()
  w.guests.set(4300, { node: 'node-b', type: 'lxc', status: 'running', hostname: 'webhost', description: '' })
  w.zone.push({ type: 'A', name: 'shop', data: '203.0.113.9' })
  w.hosts = [{ instanceId: 'npm', instanceName: 'NPM', kind: 'npm', id: '5', domains: ['shop.example.net'], certificateId: '8' }]
  w.certs = [{ id: '8', names: ['shop.example.net'] }]
  const s = adoptedSite(); await recordSite(s)
  const b = await buildDeletePreview(s, w.deps)
  assert.equal(item(b, 'record').label, 'Stop tracking: the site record')
  assert.equal(item(b, 'container'), undefined, 'no container item at all')
  assert.match(b.notes.join(' '), /never offered for an adopted site/)
  for (const k of ['dns', 'proxy:npm:5', 'cert:npm:8']) {
    assert.equal(item(b, k).defaultOn, false, k)
    assert.equal(item(b, k).owned, false, k)
    assert.equal(item(b, k).typed, 'shop.example.net', k)
  }
  const p = new DeletePreviewStore(() => 0).put('sid', s, b)
  assert.throws(() => checkChoice(p, { items: ['dns'] }), (e: any) => e instanceof SiteDeleteRefusal && e.code === 'typed_confirm')
  assert.throws(() => checkChoice(p, { items: ['dns'], confirm: { dns: 'shop' } }), /Type shop.example.net/)
  assert.deepEqual([...checkChoice(p, { items: ['dns'], confirm: { dns: 'Shop.Example.net' } })].sort(), ['dns', 'record'])
  assert.throws(() => checkChoice(p, { items: ['container'] }), /not in the preview/)
})

// ── Ownership defaults ───────────────────────────────────────────────────────

test('ownership: no ledger means off with a note; a changed record or another host is off too', async () => {
  const w = world(); published(w)
  const noLedger = recipeSite({ published: undefined }); await recordSite(noLedger)
  let b = await buildDeletePreview(noLedger, w.deps)
  for (const k of ['dns', 'proxy:npm:41', 'cert:npm:77']) {
    assert.equal(item(b, k).owned, null, k); assert.equal(item(b, k).defaultOn, false, k); assert.equal(item(b, k).offered, true, k)
  }
  assert.match(item(b, 'dns').notes[0], /no record of making this/)
  for (const k of ['dns', 'proxy:npm:41', 'cert:npm:77']) assert.equal(item(b, k).typed, 'tester.example.net', `${k}: not known to be ours, so typed`)
  const pv = new DeletePreviewStore(() => 0).put('sid', noLedger, b)
  assert.throws(() => checkChoice(pv, { items: ['dns'] }), (e: any) => e.code === 'typed_confirm', 'a recipe site too')
  assert.ok(checkChoice(pv, { items: ['dns'], confirm: { dns: 'tester.example.net' } }).has('dns'))

  w.zone[0].data = '198.51.100.1'
  w.hosts[0].id = '99'
  b = await buildDeletePreview(recipeSite(), w.deps)
  assert.equal(item(b, 'dns').owned, false)
  assert.match(item(b, 'dns').notes[0], /made it pointing at 203.0.113.9; it now holds 198.51.100.1/)
  assert.equal(item(b, 'proxy:npm:99').owned, false)
  assert.equal(item(b, 'proxy:npm:99').defaultOn, false)
  assert.equal(item(b, 'dns').typed, 'tester.example.net', 'changed since HyperProx made it: typed')
  assert.equal(item(b, 'proxy:npm:99').typed, 'tester.example.net')
  const owned = await buildDeletePreview(recipeSite(), (() => { const x = world(); published(x); return x.deps })())
  for (const k of ['dns', 'proxy:npm:41', 'cert:npm:77']) assert.equal(item(owned, k).typed, undefined, `${k}: HyperProx made it, no typing`)
})

test('a host that also serves other names is not ticked; a certificate another host uses is kept', async () => {
  const w = world(); published(w)
  w.hosts[0].domains = ['tester.example.net', 'www.tester.example.net']
  w.others.push({ hostKind: 'redirection', id: '3', certificateId: '77' })
  const b = await buildDeletePreview(recipeSite(), w.deps)
  assert.equal(item(b, 'proxy:npm:41').defaultOn, false)
  assert.match(item(b, 'proxy:npm:41').notes.join(' '), /also serves www.tester.example.net/)
  assert.equal(item(b, 'cert:npm:77').offered, false)
  assert.match(item(b, 'cert:npm:77').notes[0], /1 other host\(s\) use it/)
})

// ── Orphans ──────────────────────────────────────────────────────────────────

test('container gone (the tester case): the container is skipped, missing DNS and proxy are "already gone", nothing errors', async () => {
  const w = world()
  const s = recipeSite(); await recordSite(s)
  const b = await buildDeletePreview(s, w.deps)
  assert.deepEqual(b.items.map(i => [i.key, i.state, i.offered]), [
    ['record', 'present', true], ['dns', 'gone', false], ['proxy', 'gone', false], ['container', 'gone', false],
  ])
  assert.match(item(b, 'container').notes[0], /Container gone/)
  assert.match(item(b, 'dns').notes[0], /Already gone/)
  const p = new DeletePreviewStore(() => 0)
  const held = p.take(p.put('sid', s, b).id, 'sid', s.id)
  const out = await runDelete(s, held, checkChoice(held.preview, {}), 'admin@example.com', w.deps)
  assert.deepEqual(out.results.map(r => [r.key, r.outcome]), [['record', 'removed']])
  assert.equal(await getSite(s.id), undefined)
  assert.equal(w.calls.filter(c => !c.startsWith('GET')).length, 0, 'nothing on the cluster was touched')
})

test('container gone but its ID is still in a backup job: offered on its own, ticked, and the dead ID is removed', async () => {
  const w = world()
  w.jobs = [{ id: 'backup-daily', vmid: '4100,4201' }]
  const s = recipeSite(); await recordSite(s)
  const b = await buildDeletePreview(s, w.deps)
  assert.equal(item(b, 'backups').offered, true)
  assert.equal(item(b, 'backups').defaultOn, true)
  const p = new DeletePreviewStore(() => 0)
  const held = p.take(p.put('sid', s, b).id, 'sid', s.id)
  const out = await runDelete(s, held, checkChoice(held.preview, { items: ['backups'] }), 'admin@example.com', w.deps)
  assert.deepEqual(out.results.map(r => [r.key, r.outcome]), [['backups', 'removed'], ['record', 'removed']])
  assert.deepEqual(w.jobs, [{ id: 'backup-daily', vmid: '4100' }])
})

// ── The run: read-back, partial failure and retry ────────────────────────────

test('everything ticked: removed in order, each audited before and after and read back; the record goes last', async () => {
  const w = world(); published(w)
  const s = recipeSite(); await recordSite(s); await w.metrics.putState(defaultState(s))
  const b = await buildDeletePreview(s, w.deps)
  const p = new DeletePreviewStore(() => 0)
  const held = p.take(p.put('sid', s, b).id, 'sid', s.id)
  assert.throws(() => checkChoice(held.preview, { items: ['container'] }), /Type the container's hostname \(tester\)/)
  const keys = checkChoice(held.preview, { items: ['dns', 'proxy:npm:41', 'cert:npm:77', 'container'], confirm: { container: 'tester' } })
  const out = await runDelete(s, held, keys, 'admin@example.com', w.deps)
  assert.deepEqual(out.results.map(r => [r.key, r.outcome]), [
    ['proxy:npm:41', 'removed'], ['cert:npm:77', 'removed'], ['dns', 'removed'], ['container', 'removed'], ['record', 'removed'],
  ])
  assert.equal(out.recordRemoved, true)
  assert.deepEqual(w.zone.map(z => z.type), ['TXT'], 'only the A record went')
  assert.deepEqual(w.hosts, []); assert.deepEqual(w.certs, [])
  assert.equal(w.guests.has(4201), false)
  assert.equal(w.ha.has('ct:4201'), false)
  assert.deepEqual(w.jobs, [{ id: 'backup-daily', vmid: '4100,4400' }, { id: 'backup-all', all: 1 }], 'out of every job; the job that listed only it is deleted')
  assert.deepEqual(w.pbs, [4201], 'the PBS mount hook ran')
  const destroyCall = w.calls.find(c => c.startsWith('DELETE /nodes/node-a/lxc/4201'))!
  assert.match(destroyCall, /purge=1/)
  assert.doesNotMatch(destroyCall, /destroy-unreferenced-disks/, 'never deletes older volumes named for the ID')
  const order = w.calls.filter(c => !c.startsWith('GET'))
  const haAt = order.indexOf('DELETE /cluster/ha/resources/ct%3A4201?purge=1'), stopAt = order.findIndex(c => c.includes('/status/stop'))
  assert.ok(haAt >= 0 && stopAt > haAt, `out of HA before the stop: ${order.join(' | ')}`)
  assert.equal(await getSite(s.id), undefined)
  assert.equal(await w.metrics.getState(s.id), null, 'metrics and collector state are gone')
  assert.deepEqual(w.audits.map(a => a.action), Array(5).fill(['site.delete.item.start', 'site.delete.item.result']).flat())
  assert.match(out.results.find(r => r.key === 'dns')!.words, /read back/)
})

test('a failure half-way: the rest still runs, the record is kept, and a fresh preview retries only what is left', async () => {
  const w = world(); published(w)
  w.dnsFail.delete = true
  const s = recipeSite(); await recordSite(s)
  const p = new DeletePreviewStore(() => 0)
  let held = p.take(p.put('sid', s, await buildDeletePreview(s, w.deps)).id, 'sid', s.id)
  let out = await runDelete(s, held, checkChoice(held.preview, { items: ['dns', 'proxy:npm:41', 'cert:npm:77'] }), 'admin@example.com', w.deps)
  assert.deepEqual(out.results.map(r => [r.key, r.outcome]), [['proxy:npm:41', 'removed'], ['cert:npm:77', 'removed'], ['dns', 'failed'], ['record', 'kept']])
  assert.match(out.results.find(r => r.key === 'dns')!.words, /503/)
  assert.ok(await getSite(s.id), 'the record stays so the delete can be retried')

  // Retry: the host and certificate show as gone; only DNS is left, still ticked.
  w.dnsFail.delete = false
  const b = await buildDeletePreview(s, w.deps)
  assert.deepEqual(b.items.filter(i => i.offered && i.defaultOn).map(i => i.key), ['record', 'dns'])
  assert.equal(item(b, 'proxy').state, 'gone')
  held = p.take(p.put('sid', s, b).id, 'sid', s.id)
  out = await runDelete(s, held, checkChoice(held.preview, { items: ['dns'] }), 'admin@example.com', w.deps)
  assert.deepEqual(out.results.map(r => [r.key, r.outcome]), [['dns', 'removed'], ['record', 'removed']])
})

test('a host deleted but its certificate not: the retry offers the certificate on its own', async () => {
  const w = world(); published(w)
  w.hosts = []
  const b = await buildDeletePreview(recipeSite(), w.deps)
  assert.equal(item(b, 'cert:npm:77').offered, true)
  assert.equal(item(b, 'cert:npm:77').requires, undefined)
  assert.match(item(b, 'cert:npm:77').detail, /its host is gone/)
})

test('something changed since the preview is left alone; something gone since is "already gone"', async () => {
  const w = world(); published(w)
  const s = recipeSite(); await recordSite(s)
  const p = new DeletePreviewStore(() => 0)
  const held = p.take(p.put('sid', s, await buildDeletePreview(s, w.deps)).id, 'sid', s.id)
  w.zone[0].data = '198.51.100.7'
  w.hosts = []
  const out = await runDelete(s, held, checkChoice(held.preview, { items: ['dns', 'proxy:npm:41'] }), 'admin@example.com', w.deps)
  assert.deepEqual(out.results.map(r => [r.key, r.outcome]), [['proxy:npm:41', 'already-gone'], ['dns', 'failed'], ['record', 'kept']])
  assert.match(out.results[1].words, /now holds 198.51.100.7.*left alone/)
  assert.deepEqual(w.dnsCalls, [])
})

test('an audit that cannot be written stops that item before it changes anything', async () => {
  const w = world(); published(w)
  const s = recipeSite(); await recordSite(s)
  const p = new DeletePreviewStore(() => 0)
  const held = p.take(p.put('sid', s, await buildDeletePreview(s, w.deps)).id, 'sid', s.id)
  w.auditFail.start = true
  const out = await runDelete(s, held, checkChoice(held.preview, { items: ['dns'] }), 'admin@example.com', w.deps)
  assert.equal(out.results[0].outcome, 'failed')
  assert.match(out.results[0].words, /audit log could not be written/)
  assert.deepEqual(w.dnsCalls, [])
  assert.ok(await getSite(s.id))
})

// ── The container's identity ─────────────────────────────────────────────────

test('container destroy is refused on a hostname mismatch, a missing install mark or a VM in its place', async () => {
  const w = world(); published(w)
  const s = recipeSite()
  w.guests.get(4201)!.hostname = 'someone-else'
  let b = await buildDeletePreview(s, w.deps)
  assert.equal(item(b, 'container').state, 'mismatch')
  assert.equal(item(b, 'container').offered, false)
  assert.match(item(b, 'container').notes[0], /called "someone-else", but this site was installed as "tester"/)
  const p = new DeletePreviewStore(() => 0).put('sid', s, b)
  assert.throws(() => checkChoice(p, { items: ['container'] }), /cannot be removed/)

  w.guests.get(4201)!.hostname = 'tester'
  w.guests.get(4201)!.description = 'made by hand'
  b = await buildDeletePreview(s, w.deps)
  assert.match(item(b, 'container').notes[0], /does not carry this site's install mark/)

  w.guests.set(4201, { node: 'node-a', type: 'qemu', status: 'running', hostname: 'tester', description: MARK('job-1') })
  b = await buildDeletePreview(s, w.deps)
  assert.match(item(b, 'container').notes[0], /now a VM/)
  assert.equal(w.calls.filter(c => !c.startsWith('GET')).length, 0)
})

test('a container renamed between preview and delete is left alone', async () => {
  const w = world(); published(w)
  const s = recipeSite(); await recordSite(s)
  const p = new DeletePreviewStore(() => 0)
  const held = p.take(p.put('sid', s, await buildDeletePreview(s, w.deps)).id, 'sid', s.id)
  w.guests.get(4201)!.hostname = 'renamed'
  const out = await runDelete(s, held, checkChoice(held.preview, { items: ['container'], confirm: { container: 'tester' } }), 'admin@example.com', w.deps)
  assert.equal(out.results[0].outcome, 'failed')
  assert.match(out.results[0].words, /called "renamed"/)
  assert.ok(w.guests.has(4201))
  assert.ok(w.ha.has('ct:4201'), 'not even taken out of HA')
})

test('a destroy that fails is reported with where it stopped, and the retry finishes it', async () => {
  const w = world(); published(w)
  w.fail.destroy = true
  const g = { node: 'node-a', type: 'lxc' as const, vmid: 4201 }
  await assert.rejects(destroyOwned(w.deps.guest, g, 'tester'), /storage busy/)
  assert.ok(w.guests.has(4201))
  assert.equal(w.ha.has('ct:4201'), false, 'it had been taken out of HA')
  w.fail.destroy = false
  const again = await destroyOwned(w.deps.guest, g, 'tester')
  assert.equal(again.ok, true, again.words)
  assert.match(again.words, /was not under HA/)
})

// ── Backup-job clean-up ──────────────────────────────────────────────────────

test('removeFromBackupJobs: out of lists, a job of only this ID deleted, all-guests jobs untouched, read back, safe twice', async () => {
  const w = world()
  w.jobs = [{ id: 'a', vmid: '4201' }, { id: 'b', vmid: '100, 4201 ,42010' }, { id: 'c', all: 1 }, { id: 'd', vmid: '42010' }]
  const r = await removeFromBackupJobs(w.deps.guest.pve, 4201)
  assert.equal(r.ok, true)
  assert.deepEqual(r.jobs, ['a', 'b'])
  assert.deepEqual(w.jobs, [{ id: 'b', vmid: '100,42010' }, { id: 'c', all: 1 }, { id: 'd', vmid: '42010' }], '42010 is not 4201')
  const again = await removeFromBackupJobs(w.deps.guest.pve, 4201)
  assert.deepEqual([again.ok, again.jobs], [true, []])
})

// ── The guards, through the real gate ────────────────────────────────────────

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('admin2@example.com', 'admin2 master password', 'admin')
broker.addUser('op@example.com', 'operator master password', 'operator')
const tokens = new MemoryApiTokenStore()
let app: FastifyInstance
let W = world()
let clock = Date.now()

before(async () => {
  setBroker(broker)
  setApiTokenStore(tokens)
  setAuditSink({ async write() {} })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildSiteRoutes({
    deletion: () => W.deps, whoami: () => '', audit: async () => {}, now: () => clock,
    guestIds: async () => new Set(W.guests.keys()),
  }), { prefix: '/api/sites' })
  await app.ready()
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual'); await app.close() })

const URL_ = (id: string) => `/api/sites/${id}/delete`

test('the role matrix: both admin; the delete re-confirmed, its preview not', () => {
  assert.equal(requiredRole('POST', `${URL_('x')}/preview`), 'admin')
  assert.equal(requiredRole('POST', URL_('x')), 'admin')
  assert.equal(needsReconfirm('POST', URL_('x')), true)
  assert.equal(needsReconfirm('POST', `${URL_('x')}/preview`), false)
})

test('the list marks a site whose container is gone', async () => {
  W = world(); published(W)
  await recordSite(recipeSite()); await recordSite(recipeSite({ id: 'job-2', jobId: 'job-2', vmid: 4202, name: 'gone' }))
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const r = await app.inject({ method: 'GET', url: '/api/sites', headers: { cookie } })
  assert.deepEqual(r.json().data.sites.map((x: any) => [x.vmid, x.container, x.adopted]).sort(), [[4201, 'present', false], [4202, 'gone', false]])
})

test('guards: an operator and an API token are refused; an admin must re-confirm; the preview is single use, theirs, for this site', async () => {
  W = world(); published(W)
  await recordSite(recipeSite()); await recordSite(adoptedSite())
  const op = (await signIn(app, 'op@example.com', 'operator master password')).cookie
  assert.equal((await app.inject({ method: 'POST', url: `${URL_('job-1')}/preview`, headers: { cookie: op } })).statusCode, 403)

  const t = (await createApiToken({ name: 'auto', role: 'admin' }, 'test', tokens)).token
  const tp = await app.inject({ method: 'POST', url: `${URL_('job-1')}/preview`, headers: { authorization: `Bearer ${t}` } })
  assert.equal(tp.statusCode, 403)
  assert.equal(tp.json().code, 'token_forbidden')

  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const pv = await app.inject({ method: 'POST', url: `${URL_('job-1')}/preview`, headers: { cookie } })
  assert.equal(pv.statusCode, 200, pv.body)
  const id = pv.json().data.id
  const body = { previewId: id, items: ['dns', 'proxy:npm:41', 'cert:npm:77'] }

  const noConfirm = await app.inject({ method: 'POST', url: URL_('job-1'), headers: { cookie }, payload: body })
  assert.equal(noConfirm.json().code, 'reconfirm_required')
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })).statusCode, 200)

  const other = await app.inject({ method: 'POST', url: URL_('a1'), headers: { cookie }, payload: body })
  assert.equal(other.statusCode, 409, 'scoped to the site it was made for')

  const admin2 = (await signIn(app, 'admin2@example.com', 'admin2 master password')).cookie
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie: admin2 }, payload: { password: 'admin2 master password' } })
  const pv2 = await app.inject({ method: 'POST', url: `${URL_('job-1')}/preview`, headers: { cookie } })
  const theirs = await app.inject({ method: 'POST', url: URL_('job-1'), headers: { cookie: admin2 }, payload: { ...body, previewId: pv2.json().data.id } })
  assert.equal(theirs.statusCode, 403)
  assert.equal(theirs.json().code, 'not_yours')

  const pv3 = await app.inject({ method: 'POST', url: `${URL_('job-1')}/preview`, headers: { cookie } })
  const done = await app.inject({ method: 'POST', url: URL_('job-1'), headers: { cookie }, payload: { ...body, previewId: pv3.json().data.id } })
  assert.equal(done.statusCode, 200, done.body)
  assert.equal(done.json().data.recordRemoved, true)
  assert.ok(W.guests.has(4201), 'the container was not ticked, so it is still there')
  const again = await app.inject({ method: 'POST', url: URL_('job-1'), headers: { cookie }, payload: { ...body, previewId: pv3.json().data.id } })
  assert.equal(again.statusCode, 404, 'the site is gone; the preview was single use anyway')
})

test('a preview expires after ten minutes', async () => {
  W = world(); published(W)
  await recordSite(recipeSite())
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  const pv = await app.inject({ method: 'POST', url: `${URL_('job-1')}/preview`, headers: { cookie } })
  assert.equal(pv.json().data.expiresAt - pv.json().data.createdAt, DELETE_PREVIEW_TTL_MS)
  clock += DELETE_PREVIEW_TTL_MS + 1
  const r = await app.inject({ method: 'POST', url: URL_('job-1'), headers: { cookie }, payload: { previewId: pv.json().data.id } })
  assert.equal(r.statusCode, 409)
  assert.equal(r.json().code, 'preview_expired')
  assert.ok(await getSite('job-1'))
})

test('a partial failure answers 207 with each item, and keeps the record', async () => {
  W = world(); published(W); W.dnsFail.delete = true
  await recordSite(recipeSite())
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  await app.inject({ method: 'POST', url: '/api/auth/reconfirm', headers: { cookie }, payload: { password: 'admin master password' } })
  const pv = await app.inject({ method: 'POST', url: `${URL_('job-1')}/preview`, headers: { cookie } })
  const r = await app.inject({ method: 'POST', url: URL_('job-1'), headers: { cookie }, payload: { previewId: pv.json().data.id, items: ['dns'] } })
  assert.equal(r.statusCode, 207)
  assert.deepEqual(r.json().data.results.map((x: any) => [x.key, x.outcome]), [['dns', 'failed'], ['record', 'kept']])
  assert.ok(await getSite('job-1'))
})

// ── The vault item ───────────────────────────────────────────────────────────

const withVault = (over: Partial<SiteRecord> = {}) => recipeSite({ vault: { category: 'apps', provider: 'ghost-4201' }, ...over })

test('vault item: offered, follows the container (unticked while it stays), ticked when the container is gone', async () => {
  const w = world(); published(w)
  w.vault.set('apps/ghost-4201', { admin_password: 'x', db_password: 'y', admin_api_key: 'z' })
  let b = await buildDeletePreview(withVault(), w.deps)
  const v = item(b, 'vault')
  assert.deepEqual([v.offered, v.defaultOn, v.tickWith, v.owned], [true, false, 'container', true])
  assert.equal(v.detail, 'hyperprox/apps/ghost-4201: admin_api_key, admin_password, db_password', 'key names only')
  assert.doesNotMatch(JSON.stringify(b.items), /"x"|"y"|"z"/, 'never a value')

  w.guests.clear()
  b = await buildDeletePreview(withVault(), w.deps)
  assert.deepEqual([item(b, 'vault').offered, item(b, 'vault').defaultOn, item(b, 'vault').tickWith], [true, true, undefined])

  w.vaultState.made = false
  b = await buildDeletePreview(withVault(), w.deps)
  assert.equal(item(b, 'vault').offered, false)
  assert.match(item(b, 'vault').notes[0], /existed before/)

  w.vaultState.made = true; w.vaultState.locked = true
  b = await buildDeletePreview(withVault(), w.deps)
  assert.equal(item(b, 'vault').state, 'unknown')
  assert.equal(item(await buildDeletePreview(recipeSite(), w.deps), 'vault'), undefined, 'no vault on record: no item')
})

test('vault item: removed after the container, audited and read back; kept when the container did not go', async () => {
  const w = world(); published(w)
  w.vault.set('apps/ghost-4201', { admin_password: 'x' })
  const s = withVault(); await recordSite(s)
  const p = new DeletePreviewStore(() => 0)
  let held = p.take(p.put('sid', s, await buildDeletePreview(s, w.deps)).id, 'sid', s.id)
  w.fail.destroy = true
  let out = await runDelete(s, held, checkChoice(held.preview, { items: ['container', 'vault'], confirm: { container: 'tester' } }), 'admin@example.com', w.deps)
  assert.deepEqual(out.results.map(r => [r.key, r.outcome]), [['container', 'failed'], ['vault', 'kept'], ['record', 'kept']])
  assert.deepEqual(w.vault.get('apps/ghost-4201'), { admin_password: 'x' }, 'the logins stay with a container that stayed')

  w.fail.destroy = false
  held = p.take(p.put('sid', s, await buildDeletePreview(s, w.deps)).id, 'sid', s.id)
  out = await runDelete(s, held, checkChoice(held.preview, { items: ['container', 'vault'], confirm: { container: 'tester' } }), 'admin@example.com', w.deps)
  assert.deepEqual(out.results.map(r => [r.key, r.outcome]), [['container', 'removed'], ['vault', 'removed'], ['record', 'removed']])
  assert.match(out.results[1].words, /admin_password; read back/)
  assert.deepEqual(w.vault.get('apps/ghost-4201'), {})
  assert.ok(w.audits.some(a => a.action === 'site.delete.item.result' && a.details.item === 'vault' && a.details.outcome === 'removed'))
  assert.doesNotMatch(JSON.stringify(w.audits), /"x"/, 'no secret in the audit')
})

// ── The PBS mount hook: home cluster only ────────────────────────────────────

test('the PBS mount hook with a remote cluster selected: the home node, the home login, a pinned key only', async () => {
  const sent: Array<{ host: string; requirePin?: boolean; remote: boolean }> = []
  const credAsked: boolean[] = []
  const home = { fetchStrict: async (p: string) => { assert.equal(p, '/cluster/status'); return [{ type: 'node', name: 'node-a', ip: '192.0.2.10' }] } }
  const run = homeNodeRunner({
    pve: home as any,
    cred: async () => { credAsked.push(isRemoteContext()); return { username: 'root', password: 'home-secret' } as any },
    exec: async (o: any) => { sent.push({ host: o.host, requirePin: o.requirePin, remote: isRemoteContext() }); return { code: 0, output: '@@pbs nomount', timedOut: false } as any },
  })
  // A remote cluster is selected; it is not in the registry, so anything that asked pveFromEnv() would throw.
  const words = await clusterContext.run({ id: 'remote-x', kind: 'remote' }, () => pbsMountCleanup({ node: 'node-a', vmid: 4201 }, run))
  assert.equal(words, '')
  assert.deepEqual(credAsked, [false], 'the login is read as the home cluster')
  assert.deepEqual(sent, [{ host: '192.0.2.10', requirePin: true, remote: false }], 'sent to the home node only, pinned')
})
