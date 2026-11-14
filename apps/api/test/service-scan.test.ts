// The one service scan (lib/service-scan.ts over @hyperprox/hardware/service-probes): the Plug-ins page's Scan,
// the Catalogue's "already here" and the setup wizard's verdicts come from the same findings, so they agree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { PROBES, scanHosts, verdicts, type ProbeAnswer, type ProbeGetter } from '@hyperprox/hardware/service-probes'
import { ServiceScanCache, scanTargets, pluginFindings, catalogueRunning, mergeDetection, type ScanSource } from '../src/lib/service-scan'
import { buildCatalogueRoutes } from '../src/routes/catalogue'

const SOURCE: ScanSource = {
  guests: async () => [
    { vmid: 101, name: 'proxy', node: 'node-a', type: 'lxc', status: 'running' },
    { vmid: 102, name: 'backup', node: 'node-a', type: 'qemu', status: 'running' },
    { vmid: 103, name: 'media', node: 'node-b', type: 'lxc', status: 'running' },
    { vmid: 104, name: 'off', node: 'node-b', type: 'lxc', status: 'stopped' },
  ],
  config: async (_n, vmid) => ({
    101: { net0: 'name=eth0,bridge=vmbr0,ip=10.0.2.11/24,gw=10.0.2.1' },
    102: { net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0' },
    103: { net0: 'name=eth0,bridge=vmbr0,ip=dhcp' },
    104: { net0: 'name=eth0,bridge=vmbr0,ip=10.0.2.14/24' },
  } as Record<number, Record<string, unknown>>)[vmid] ?? null,
  live: async (_n, vmid) => ({
    102: { result: [{ name: 'lo', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '127.0.0.1' }] }, { name: 'eth0', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '10.0.2.12' }] }] },
    103: [{ name: 'eth0', inet: '10.0.2.13/24' }],
  } as Record<number, unknown>)[vmid] ?? null,
  nodes: async () => [{ name: 'node-a', ip: '10.0.2.2' }, { name: 'node-b', ip: '10.0.2.3' }],
}

const ok = (body: unknown, status = 200): ProbeAnswer => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body) })
/** What each address answers; anything else is no answer at all. */
const ANSWERS: Record<string, ProbeAnswer> = {
  'http://10.0.2.11:81/': ok('<html><head><title>Nginx Proxy Manager</title></head></html>'),
  'https://10.0.2.12:8007/': ok('<html><head><title>Proxmox Backup Server</title></head><script src="/js/proxmox-backup-gui.js"></script></html>'),
  'http://10.0.2.13:8989/ping': ok({ status: 'OK' }),
  'http://10.0.2.13:7878/ping': ok({ status: 'OK' }),
  'http://10.0.2.13:9696/api/v1/system/status': ok('Unauthorized', 401),
  'http://10.0.2.13:8888/unmanic/api/v2/workers/status': ok({ workers_status: [] }),
  'http://10.0.2.2:8888/unmanic/api/v2/workers/status': ok({ workers_status: [{ id: 'w0' }] }),
  // Tautulli's /status sends a browser to its sign-in page first: followed, because it stays on its own origin.
  'http://10.0.2.13:8181/status': { status: 302, body: '', location: '/auth/login' },
  'http://10.0.2.13:8181/auth/login': ok('<html><head><title>Tautulli - Login</title></head></html>'),
  // A redirect off its own origin is a miss, and the other address is never asked.
  'http://10.0.2.11:32400/identity': { status: 302, body: '', location: 'http://10.0.2.99:32400/identity' },
  'http://10.0.2.99:32400/identity': ok('<MediaContainer machineIdentifier="x"/>'),
  // Nextcloud and Vaultwarden, which the Catalogue missed while they ran: public status endpoints that name them.
  'https://10.0.2.13:443/status.php': ok({ installed: true, maintenance: false, version: '31.0.0.18', versionstring: '31.0.0', edition: '', productname: 'Nextcloud' }),
  'http://10.0.2.11:80/api/config': ok({ version: '2025.6.0', server: { name: 'Vaultwarden', url: 'https://github.com/dani-garcia/vaultwarden' } }),
}
function fakeGet(asked: string[] = []): ProbeGetter {
  return async url => { asked.push(url); return ANSWERS[url] ?? null }
}

test('scan targets: running guests by config and live address, and the nodes; stopped guests and loopback are not asked', async () => {
  const t = await scanTargets(SOURCE)
  assert.deepEqual(t.map(x => x.address), ['10.0.2.11', '10.0.2.12', '10.0.2.13', '10.0.2.2', '10.0.2.3'].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })))
  assert.equal(t.find(x => x.address === '10.0.2.12')?.guest?.vmid, 102)
  assert.equal(t.find(x => x.address === '10.0.2.2')?.guest, null)
})

test('one scan, three consumers: Plug-ins Scan, Catalogue and the wizard verdicts agree on every service', async () => {
  const asked: string[] = []
  const cache = new ServiceScanCache(() => SOURCE, fakeGet(asked))
  const r = await cache.result()
  const v = verdicts(r.findings)
  const plugins = pluginFindings(r.findings)
  const catalogue = catalogueRunning(r.findings)

  // The wizard's three, and what the install test saw the Catalogue miss.
  for (const key of ['npm', 'pbs', 'sonarr', 'radarr', 'prowlarr', 'unmanic', 'tautulli']) assert.equal(v[key].found, true, key)
  for (const key of ['ollama', 'plex', 'lidarr', 'qbittorrent']) assert.equal(v[key].found, false, key)
  assert.equal(asked.includes('http://10.0.2.99:32400/identity'), false, 'an off-origin redirect is not followed')

  for (const p of PROBES) {
    const found = v[p.key].found
    if (p.pluginId) assert.equal(plugins.some(f => f.key === p.key), found, `Scan agrees on ${p.key}`)
    if (p.recipeId) assert.equal((catalogue[p.recipeId] ?? []).some(x => x.service === p.label), found, `Catalogue agrees on ${p.key}`)
  }
  // The Catalogue's verdicts the install test got wrong.
  for (const id of ['nginx-proxy-manager', 'proxmox-backup-server', 'arr-stack', 'unmanic', 'tautulli']) assert.ok(catalogue[id]?.length, id)
  assert.equal(catalogue['proxmox-backup-server'][0].url, 'https://10.0.2.12:8007')
  assert.equal(catalogue['proxmox-backup-server'][0].guest?.vmid, 102)
  // Unmanic may run on several hosts; Scan lists each.
  assert.equal(plugins.filter(f => f.key === 'unmanic').length, 2)
  // Nextcloud and Vaultwarden are found, for the Catalogue; PBS is a Scan finding too, added on its own page.
  assert.equal(catalogue['nextcloud']?.[0]?.url, 'https://10.0.2.13:443')
  assert.equal(catalogue['vaultwarden']?.[0]?.url, 'http://10.0.2.11:80')
  const pbs = plugins.find(f => f.key === 'pbs')
  assert.equal(pbs?.pluginId, 'pbs'); assert.equal(pbs?.setting, null); assert.equal(pbs?.page, '/plugins/pbs')
})

test('the cache: a second ask within five minutes is the same answer; refresh asks again', async () => {
  let t = 1_000
  const asked: string[] = []
  const cache = new ServiceScanCache(() => SOURCE, fakeGet(asked), () => t)
  const a = await cache.result()
  const n = asked.length
  t += 60_000
  assert.equal(await cache.result(), a)
  assert.equal(asked.length, n)
  await cache.result(true)
  assert.ok(asked.length > n)
})

test('scanHosts: the same inputs give the same findings in the same order', async () => {
  const hosts = await scanTargets(SOURCE)
  const a = await scanHosts(hosts, fakeGet())
  const b = await scanHosts([...hosts].reverse(), fakeGet())
  assert.deepEqual(a.map(f => f.address), b.map(f => f.address))
})

test('the Catalogue route merges proxy fingerprints and the scan, without counting one guest twice', async () => {
  const scan = await new ServiceScanCache(() => SOURCE, fakeGet()).result()
  const fingerprints = {
    apps: { 'nginx-proxy-manager': [{ guest: { vmid: 101, name: 'proxy', node: 'node-a', type: 'lxc' as const, status: 'running' }, target: '10.0.2.11:81', publicUrl: 'https://npm.example.com', domains: ['npm.example.com'], version: '2.12.1', via: 'probe' as const }] },
    builtAt: 5, probed: 1, errors: [],
  }
  const merged = mergeDetection(fingerprints, scan)
  assert.equal(merged.apps['nginx-proxy-manager'].length, 1)
  assert.equal(merged.apps['nginx-proxy-manager'][0].via, 'probe')
  assert.equal(merged.apps['arr-stack'].length, 3)

  const app = Fastify()
  app.addHook('onRequest', async req => { (req as any).session = { role: 'admin' } })
  await app.register(buildCatalogueRoutes({ detected: async () => merged }), { prefix: '/api/catalogue' })
  const res = await app.inject({ method: 'GET', url: '/api/catalogue/detected' })
  assert.equal(res.statusCode, 200)
  const apps = res.json().data.apps
  for (const id of ['nginx-proxy-manager', 'proxmox-backup-server', 'arr-stack', 'unmanic', 'tautulli']) assert.ok(apps[id]?.length, id)
  await app.close()
})

test('the setup wizard\'s three services are in the one list, on the ports the wizard asks', () => {
  const by = Object.fromEntries(PROBES.map(p => [p.key, p]))
  assert.deepEqual([by.npm.port, by.npm.scheme, by.npm.recipeId], [81, 'http', 'nginx-proxy-manager'])
  assert.deepEqual([by.pbs.port, by.pbs.scheme, by.pbs.recipeId], [8007, 'https', 'proxmox-backup-server'])
  assert.deepEqual([by.ollama.port, by.ollama.recipeId], [11434, 'ollama'])
  // One answer, the same verdict whichever consumer reads it.
  assert.equal(by.npm.match(200, '<title>Nginx Proxy Manager</title>'), true)
  assert.equal(by.pbs.match(200, '<title>Proxmox Backup Server</title>'), true)
  assert.equal(by.npm.match(404, 'Nginx Proxy Manager'), false)
})

test('scan targets: only private unicast addresses; config beats the agent; one entry per address', async () => {
  const src: ScanSource = {
    guests: async () => [
      { vmid: 201, name: 'a', node: 'node-a', type: 'lxc', status: 'running' },
      { vmid: 202, name: 'b', node: 'node-a', type: 'qemu', status: 'running' },
      { vmid: 203, name: 'c', node: 'node-a', type: 'qemu', status: 'running' },
    ],
    config: async (_n, vmid) => ({
      201: { net0: 'name=eth0,ip=10.0.2.21/24' },
      202: { net0: 'virtio=BC,bridge=vmbr0' },
      203: { net0: 'virtio=BC,bridge=vmbr0' },
    } as Record<number, Record<string, unknown>>)[vmid] ?? null,
    live: async (_n, vmid) => ({
      201: [{ name: 'eth0', inet: '10.0.2.21/24' }, { name: 'docker0', inet: '172.17.0.1/16' }],
      202: { result: [{ name: 'eth0', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '169.254.9.9' }, { 'ip-address-type': 'ipv4', 'ip-address': '0.0.0.0' }, { 'ip-address-type': 'ipv4', 'ip-address': '224.0.0.1' }, { 'ip-address-type': 'ipv4', 'ip-address': '255.255.255.255' }, { 'ip-address-type': 'ipv4', 'ip-address': '8.8.8.8' }, { 'ip-address-type': 'ipv4', 'ip-address': '10.0.2.22' }] }] },
      203: { result: [{ name: 'eth0', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '10.0.2.22' }] }] },
    } as Record<number, unknown>)[vmid] ?? null,
    nodes: async () => [{ name: 'node-a', ip: '10.0.2.21' }, { name: 'node-b', ip: '203.0.113.9' }],
  }
  const t = await scanTargets(src)
  assert.deepEqual(t.map(x => x.address), ['10.0.2.21', '10.0.2.22'])
  assert.equal(t[0].guest?.vmid, 201, 'the guest, not the node, owns the shared address')
  assert.equal(t[1].guest?.vmid, 202)
})
