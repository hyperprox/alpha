// Multi-cluster core: certificate pinning against a real TLS server on loopback, the registry and its vault
// items, the request context and its route allowlist, the role matrix, and the namespaced guest history.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock, signIn } from './fakes/app'
import { requestContext } from '../src/lib/auth'
import { cachedSecret } from '../src/lib/vault/state'
import { PinnedAgent, probeCertificate, normaliseFingerprint, CertificateChangedError, isServerAddress } from '../src/lib/clusters/tls-pin'
import { ProxmoxClient } from '../src/lib/proxmox-client'
import {
  setClusterStore, loadClusters, createRemote, listClusters, updateCluster, removeCluster, remoteToken, cleanRoot,
  HOME_ID, ClusterRefusal, saveRemoteNodeLogin,
} from '../src/lib/clusters/registry'
import { MemoryClusterStore } from '../src/lib/clusters/store'
import { installClusterContext, remoteRouteAllowed, runInCluster, currentClusterId } from '../src/lib/clusters/context'
import { pveFromEnv, CertificateNotConfirmedError } from '../src/lib/pve-env'
import { nodeCredential } from '../src/lib/node-exec'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { ClusterHistoryStore } from '../src/lib/clusters/history'
import { MemoryHistoryStore } from '../src/lib/guest-config/history/store'

const haveOpenssl = spawnSync('openssl', ['version']).status === 0
const dir = mkdtempSync(join(tmpdir(), 'hpx-mc-'))
function makeCert(name: string) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '30',
    '-subj', '/CN=pve-test', '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.crt`)], { stdio: 'ignore' })
  return { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.crt`)) }
}

// A pretend Proxmox API: records what it was sent, answers a few paths.
const seen: Array<{ path: string; auth: string | undefined }> = []
let server: https.Server
let port = 0
let goodFp = ''
let otherFp = ''

const broker = new FakeBroker()
broker.addUser('owner@example.com', 'owner master password', 'owner')
const appP = buildTestApp(broker)
let sid = ''
const asOwner = <T>(fn: () => Promise<T>) => requestContext.run({ sid, email: 'owner@example.com', role: 'owner' }, fn)

before(async () => {
  if (!haveOpenssl) return
  const a = makeCert('a'), b = makeCert('b')
  server = https.createServer(a, (req, res) => {
    seen.push({ path: req.url ?? '', auth: req.headers.authorization })
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/version')) return res.end(JSON.stringify({ data: { version: '9.1.0' } }))
    if (req.url?.endsWith('/nodes')) return res.end(JSON.stringify({ data: [{ node: 'pve', status: 'online' }] }))
    res.statusCode = 404; res.end(JSON.stringify({ data: null }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  port = (server.address() as any).port
  goodFp = (await probeCertificate('127.0.0.1', port)).fingerprint
  const x509 = (c: Buffer) => new (require('node:crypto').X509Certificate)(c).fingerprint256
  otherFp = normaliseFingerprint(x509(b.cert))!
  assert.equal(goodFp, normaliseFingerprint(x509(a.cert)))
  const app = await appP
  await signIn(app, 'owner@example.com', 'owner master password')
  sid = [...broker.sessions.values()].at(-1)!.sid
})
after(async () => { server?.close(); await resetLock(); await (await appP).close() })

test('fingerprints normalise to upper-case colon pairs, and only SHA-256 lengths pass', () => {
  assert.equal(normaliseFingerprint('ab'.repeat(32)), Array(32).fill('AB').join(':'))
  assert.equal(normaliseFingerprint('AB:CD'), null)
  assert.ok(isServerAddress('pve1.example'))
  assert.ok(isServerAddress('10.0.0.5'))
  assert.ok(!isServerAddress('https://pve1.example'))
  assert.ok(!isServerAddress('pve1.example:8006'))
})

test('a pinned connection sends the token only to the confirmed certificate', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  seen.length = 0
  const good = new ProxmoxClient('127.0.0.1', port, 'u@pve!t', 'secret-good', { agent: new PinnedAgent(goodFp) })
  const v = await good.fetchStrict<any>('/version')
  assert.equal(v.version, '9.1.0')
  assert.equal(seen.length, 1)
  assert.match(seen[0].auth ?? '', /secret-good/)

  seen.length = 0
  const bad = new ProxmoxClient('127.0.0.1', port, 'u@pve!t', 'secret-bad', { agent: new PinnedAgent(otherFp) })
  await assert.rejects(bad.fetchStrict('/version'), (e: any) => e instanceof CertificateChangedError && e.presented === goodFp)
  assert.equal(seen.length, 0, 'the server never received the request, so never saw the token')
})

test('the registry keeps secrets in the vault only, and remote context builds the pinned client', { skip: !haveOpenssl && 'openssl not installed' }, async () => {
  const store = new MemoryClusterStore()
  setClusterStore(store)
  await loadClusters()
  assert.deepEqual(listClusters().map(c => c.id), [HOME_ID], 'a fresh install has only the home cluster')
  await asOwner(async () => {
    const c = await createRemote({ name: 'Remote server', address: '127.0.0.1', port, fingerprint: goodFp, tokenId: 'hyperprox@pve!main', tokenSecret: '12345678-aaaa-bbbb-cccc-1234567890ab', by: 'owner@example.com' })
    assert.match(c.id, /^c[0-9a-f]{10}$/)
    const row = JSON.stringify([...store.rows.values()])
    assert.ok(!row.includes('12345678-aaaa'), 'the row holds no secret')
    assert.equal(cachedSecret(`hyperprox:proxmox/${c.id}`)?.fields.token_secret, '12345678-aaaa-bbbb-cccc-1234567890ab')
    assert.equal(remoteToken(c.id).tokenId, 'hyperprox@pve!main')

    seen.length = 0
    const v = await runInCluster(c.id, () => pveFromEnv().fetchStrict<any>('/version'))
    assert.equal(v.version, '9.1.0')
    assert.match(seen[0].auth ?? '', /hyperprox@pve!main=12345678/)
    assert.equal(runInCluster(c.id, () => currentClusterId()), c.id)

    // Node logins are per cluster: a remote "pve" never sees a home login of the same name.
    await saveRemoteNodeLogin(c.id, 'pve', JSON.stringify({ username: 'root', port: 22, password: 'remote-pw' }))
    assert.equal((await runInCluster(c.id, () => nodeCredential('pve')))?.password, 'remote-pw')
    assert.equal(await nodeCredential('pve'), null, 'home has no login for pve')

    // A new address clears the confirmation: nothing is sent until it is confirmed again.
    await updateCluster(c.id, { address: 'localhost' })
    assert.throws(() => runInCluster(c.id, () => pveFromEnv()), CertificateNotConfirmedError)
    await assert.rejects(updateCluster(c.id, { allowedRoots: ['/etc'] }), ClusterRefusal)
    const r = await updateCluster(c.id, { allowedRoots: ['/mnt/media/', '/mnt/media'] })
    assert.deepEqual(r.allowedRoots, ['/mnt/media'])

    await removeCluster(c.id)
    assert.equal(cachedSecret(`hyperprox:proxmox/${c.id}`), undefined, 'the token item is gone from the vault')
    assert.equal(cachedSecret(`hyperprox:cluster-ssh/${c.id}`), undefined, 'and so are its node logins')
    assert.deepEqual(listClusters().map(x => x.id), [HOME_ID])
  })
})

test('file roots: absolute, no traversal, never a system folder', () => {
  assert.equal(cleanRoot('/srv/media/Movies/'), '/srv/media/Movies')
  for (const bad of ['relative', '/', '/srv/../etc', '/etc/pve', '/proc/1', '/srv/./x']) assert.throws(() => cleanRoot(bad), ClusterRefusal, bad)
})

test('the context hook: no header is home; a remote reaches only allowlisted routes; unknown ids are refused', async () => {
  const store = new MemoryClusterStore()
  await store.upsert({ id: 'c0123456789', name: 'Remote server', kind: 'remote', address: '10.0.0.9', port: 8006, note: '', certFingerprint: null, certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: {}, allowedRoots: [], monitoring: {}, plexUrl: null, createdBy: 'x' })
  setClusterStore(store)
  await loadClusters()
  const app = Fastify({ logger: false })
  installClusterContext(app)
  app.get('/api/proxmox/nodes', async () => ({ cluster: currentClusterId() }))
  app.get('/api/updates/overview', async () => ({ cluster: currentClusterId() }))
  app.post('/api/infra/guest-config/preview', async () => ({ cluster: currentClusterId() }))
  await app.ready()
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers })
  assert.equal((await get('/api/proxmox/nodes')).json().cluster, 'home')
  assert.equal((await get('/api/proxmox/nodes', { 'x-hyperprox-cluster': 'home' })).json().cluster, 'home')
  assert.equal((await get('/api/proxmox/nodes', { 'x-hyperprox-cluster': 'c0123456789' })).json().cluster, 'c0123456789')
  assert.equal((await get('/api/proxmox/nodes?cluster=c0123456789')).json().cluster, 'c0123456789')
  const post = await app.inject({ method: 'POST', url: '/api/infra/guest-config/preview', headers: { 'x-hyperprox-cluster': 'c0123456789' }, payload: {} })
  assert.equal(post.json().cluster, 'c0123456789', 'the context survives body parsing')
  const homeOnly = await get('/api/updates/overview', { 'x-hyperprox-cluster': 'c0123456789' })
  assert.equal(homeOnly.statusCode, 409)
  assert.match(homeOnly.json().error, /home cluster only for now, so nothing was done on Remote server/)
  assert.equal((await get('/api/proxmox/nodes', { 'x-hyperprox-cluster': 'c9999999999' })).statusCode, 404)
  assert.equal((await get('/api/proxmox/nodes', { 'x-hyperprox-cluster': '../x' })).statusCode, 400)
  await app.close()
  setClusterStore(new MemoryClusterStore())
})

test('the allowlist: reads and guest actions yes; the old delete route, the GPU reader and other pages no', () => {
  assert.ok(remoteRouteAllowed('GET', '/api/proxmox/summary'))
  assert.ok(remoteRouteAllowed('POST', '/api/infra/vms/pve/100/lxc/start'))
  assert.ok(remoteRouteAllowed('POST', '/api/infra/guest-config/apply'))
  assert.ok(!remoteRouteAllowed('DELETE', '/api/proxmox/nodes/pve/lxc/100'), 'deleting goes through the typed-name route')
  assert.ok(!remoteRouteAllowed('GET', '/api/proxmox/gpu'))
  assert.ok(!remoteRouteAllowed('POST', '/api/proxmox/lxc'))
  assert.ok(!remoteRouteAllowed('GET', '/api/ha/overview'))
  assert.ok(!remoteRouteAllowed('POST', '/api/catalogue/wizard/apply'))
})

test('roles: viewing is viewer, power is operator, credentials and deletes are re-confirmed', () => {
  assert.equal(requiredRole('GET', '/api/clusters'), 'viewer')
  assert.equal(requiredRole('GET', '/api/clusters/overview'), 'viewer')
  assert.equal(requiredRole('GET', '/api/clusters/c0123456789/hardware'), 'admin')
  assert.equal(requiredRole('POST', '/api/clusters/c0123456789/guests/pve/lxc/100/power'), 'operator')
  assert.equal(requiredRole('POST', '/api/clusters/c0123456789/guests/pve/lxc/100/delete'), 'admin')
  assert.equal(requiredRole('POST', '/api/clusters/probe-certificate'), 'admin')
  for (const [m, p] of [['POST', '/api/clusters'], ['DELETE', '/api/clusters/c0123456789'], ['POST', '/api/clusters/c0123456789/token'],
    ['POST', '/api/clusters/c0123456789/certificate'], ['POST', '/api/clusters/c0123456789/nodes/pve/login'],
    ['POST', '/api/clusters/c0123456789/guests/pve/qemu/101/delete'], ['POST', '/api/clusters/c0123456789/monitoring/apply']] as const)
    assert.ok(needsReconfirm(m, p), `${m} ${p}`)
  assert.ok(!needsReconfirm('POST', '/api/clusters/c0123456789/guests/pve/lxc/100/power'))
  assert.ok(!needsReconfirm('POST', '/api/clusters/probe-certificate'))
})

test('a remote cluster\'s guest history is kept apart from the home cluster\'s', async () => {
  const inner = new MemoryHistoryStore()
  const remote = new ClusterHistoryStore(inner, 'c0123456789')
  const row = { guest: 'lxc/100', node: 'pve', kind: 'edit', tag: null, actor: 'a', previewId: 'p', before: {}, after: {}, changes: [], outcome: 'ok' as const, problems: [], meta: null }
  const home = await inner.add({ ...row })
  const mine = await remote.add({ ...row })
  assert.equal(mine.guest, 'lxc/100')
  assert.equal((await inner.list('lxc/100')).length, 1, 'home sees only its own row')
  assert.equal((await remote.list('lxc/100')).length, 1)
  assert.equal(await remote.get(home.id), null, 'a home row cannot be reverted to from the remote')
  assert.equal((await inner.get(mine.id))?.guest, '@c0123456789/lxc/100', 'and the home service never matches a remote row')
  assert.equal(await remote.adoptLegacyGpu(), false)
})
