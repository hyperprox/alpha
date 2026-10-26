// End to end against Pebble, the ACME test CA, and its challenge DNS, in containers on loopback. Issues a
// certificate for an apex, its wildcard and one more name (two challenge values on one record name), checks
// the chain, dates and fingerprint, that every challenge value is gone afterwards, and the failure paths:
// the CA rejecting a challenge and the propagation wait timing out both still clean up.
// Skipped when docker is not usable. Nothing here contacts a real CA or DNS provider.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { issueCertificate, fetchAri, ariCertId, type IssueDeps } from '../src/lib/certs/acme'
import { renewAfter } from '../src/lib/certs/timing'
import { dockerAvailable, startPebble, stopPebble, challtestProvider, pebbleRoots, DIRECTORY_URL, DNS_SERVER } from './fakes/pebble'
import { startTxtServer, type TxtServer } from './fakes/pebble-dns'

const docker = dockerAvailable()
const skip = docker ? false : 'docker not available'
let tlsBefore: string | undefined

before(async () => {
  if (!docker) return
  // Pebble serves its API with a throwaway test CA, deliberately untrusted; this file only ever talks to loopback.
  tlsBefore = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  await startPebble()
})

after(() => {
  if (!docker) return
  stopPebble()
  if (tlsBefore === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsBefore
})

async function txtAt(fqdn: string): Promise<string[]> {
  const r = new Resolver({ timeout: 2000, tries: 1 })
  r.setServers([DNS_SERVER])
  try { return (await r.resolveTxt(fqdn)).map(c => c.join('')) } catch { return [] }
}

function vault() {
  let key: string | null = null
  let saves = 0
  return {
    get saves() { return saves },
    get key() { return key },
    getAccountKey: async () => key,
    saveAccountKey: async (pem: string) => { key = pem; saves++ },
  }
}

const FAST = { intervalMs: 200, timeoutMs: 15_000, authoritative: async () => [DNS_SERVER] }

let issued: Awaited<ReturnType<typeof issueCertificate>> | null = null

test('issues apex + wildcard + one more name over DNS-01 and removes every challenge value', { skip, timeout: 180_000 }, async () => {
  const calls: string[] = [], log: string[] = []
  const v = vault()
  const dns = challtestProvider(['example.com'], { calls })
  const deps: IssueDeps = { directoryUrl: DIRECTORY_URL, email: 'admin@example.com', ...v, dns: [dns], log: l => log.push(l), propagation: FAST }

  const names = ['example.com', '*.example.com', 'mail.example.com']
  const b = await issueCertificate(deps, names, 'ec256')
  issued = b

  // Challenges: the apex and the wildcard share _acme-challenge.example.com with two values at once.
  const presents = calls.filter(c => c.startsWith('present'))
  assert.deepEqual(presents.sort(), [
    'present example.com _acme-challenge.example.com',
    'present example.com _acme-challenge.example.com',
    'present example.com _acme-challenge.mail.example.com',
  ])
  assert.equal(calls.filter(c => c.startsWith('cleanup')).length, 3, 'every value written is removed')
  assert.equal(dns.values.size, 0)
  assert.deepEqual(await txtAt('_acme-challenge.example.com'), [])
  assert.deepEqual(await txtAt('_acme-challenge.mail.example.com'), [])

  // The certificate.
  const leaf = new X509Certificate(b.certPem)
  const sans = leaf.subjectAltName!.split(', ').map(s => s.replace(/^DNS:/, '')).sort()
  assert.deepEqual(sans, [...names].sort())
  assert.ok(leaf.checkPrivateKey(createPrivateKey(b.keyPem)))
  assert.equal(createPrivateKey(b.keyPem).asymmetricKeyDetails?.namedCurve, 'prime256v1')
  assert.equal(b.fingerprint256, leaf.fingerprint256)
  assert.match(b.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  assert.equal(b.serial, leaf.serialNumber.toUpperCase())
  assert.equal(b.notBefore.getTime(), new Date(leaf.validFrom).getTime())
  assert.equal(b.notAfter.getTime(), new Date(leaf.validTo).getTime())
  assert.ok(b.notBefore.getTime() <= Date.now() + 60_000 && b.notAfter.getTime() > Date.now())
  assert.match(b.issuer, /Pebble Intermediate/)

  // The chain: fullchain = leaf + chain, the leaf is signed by the first chain certificate, which is
  // Pebble's intermediate, which Pebble's root signed.
  assert.equal(b.fullchainPem, b.certPem + b.chainPem)
  const chain = b.chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)!.map(p => new X509Certificate(p))
  assert.ok(chain.length >= 1)
  assert.ok(leaf.checkIssued(chain[0]) && leaf.verify(chain[0].publicKey))
  const { root, intermediate } = await pebbleRoots()
  assert.equal(chain[0].fingerprint256, new X509Certificate(intermediate).fingerprint256)
  assert.ok(chain[chain.length - 1].verify(new X509Certificate(root).publicKey))

  // The account key went to the vault once.
  assert.equal(v.saves, 1)
  assert.match(v.key!, /BEGIN (EC )?PRIVATE KEY/)
  assert.ok(log.some(l => /Issued: serial/.test(l)))
  assert.ok(!log.some(l => l.includes(b.keyPem.split('\n')[1])), 'no key material in the log')
})

test('a second order reuses the account key from the vault and can issue RSA', { skip, timeout: 180_000 }, async () => {
  const v = vault()
  const first: IssueDeps = { directoryUrl: DIRECTORY_URL, email: null, ...v, dns: [challtestProvider(['example.com'])], log: () => {}, propagation: FAST }
  await issueCertificate(first, ['a.example.com'], 'ec384')
  const accountKey = v.key
  const b = await issueCertificate({ ...first, dns: [challtestProvider(['example.com'])] }, ['b.example.com'], 'rsa2048')
  assert.equal(v.saves, 1, 'not saved again')
  assert.equal(v.key, accountKey)
  assert.equal(createPrivateKey(b.keyPem).asymmetricKeyType, 'rsa')
  assert.equal(createPrivateKey(b.keyPem).asymmetricKeyDetails?.modulusLength, 2048)

  // The same account, now with a contact address in the policy: updated, not re-registered.
  const log: string[] = []
  await issueCertificate({ ...first, email: 'admin@example.com', dns: [challtestProvider(['example.com'])], log: l => log.push(l) }, ['c.example.com'], 'ec256')
  assert.ok(log.includes('ACME account contact updated'))
  assert.equal(v.saves, 1)
})

test('a vault key the CA has never seen is registered rather than failing', { skip, timeout: 180_000 }, async () => {
  const { crypto } = await import('acme-client')
  const v = vault()
  await v.saveAccountKey((await crypto.createPrivateEcdsaKey('P-256')).toString())
  const log: string[] = []
  await issueCertificate({ directoryUrl: DIRECTORY_URL, email: null, ...v, dns: [challtestProvider(['example.com'])], log: l => log.push(l), propagation: FAST }, ['d.example.com'], 'ec256')
  assert.ok(log.some(l => /has no account at this CA; registering/.test(l)), log.join('\n'))
  assert.equal(v.saves, 1, 'the existing key is kept, not replaced')
})

test('the CA rejecting a challenge fails the order with its reason and still removes every value', { skip, timeout: 180_000 }, async t => {
  // HyperProx's propagation check reads a server that has the right values; Pebble's resolver sees wrong ones.
  const mirror: TxtServer = await startTxtServer()
  try {
    const calls: string[] = []
    const dns = challtestProvider(['example.com'], { calls, corrupt: true, mirror: mirror.txt })
    const deps: IssueDeps = {
      directoryUrl: DIRECTORY_URL, email: null, ...vault(), dns: [dns], log: () => {},
      propagation: { ...FAST, authoritative: async () => [mirror.address] },
    }
    await assert.rejects(issueCertificate(deps, ['example.com', '*.example.com'], 'ec256'),
      (e: Error) => { t.diagnostic(e.message); return /rejected the challenge/.test(e.message) && /incorrect TXT record|Correct value not found|not-/i.test(e.message) })
    assert.equal(calls.filter(c => c.startsWith('present')).length, 2)
    assert.equal(calls.filter(c => c.startsWith('cleanup')).length, 2)
    assert.equal(dns.values.size, 0)
    assert.equal(mirror.txt.size, 0)
    assert.deepEqual(await txtAt('_acme-challenge.example.com'), [])
  } finally { await mirror.close() }
})

test('a propagation timeout abandons the order and still removes every value', { skip, timeout: 180_000 }, async () => {
  const empty = await startTxtServer()
  try {
    const calls: string[] = []
    const dns = challtestProvider(['example.com'], { calls })
    const deps: IssueDeps = {
      directoryUrl: DIRECTORY_URL, email: null, ...vault(), dns: [dns], log: () => {},
      propagation: { intervalMs: 100, timeoutMs: 400, authoritative: async () => [empty.address] },
    }
    await assert.rejects(issueCertificate(deps, ['mail.example.com', 'www.example.com'], 'ec256'), /not visible on/)
    assert.equal(calls.filter(c => c.startsWith('present')).length, 2, 'all values are written before the wait')
    assert.equal(calls.filter(c => c.startsWith('cleanup')).length, 2)
    assert.deepEqual(await txtAt('_acme-challenge.mail.example.com'), [])
    assert.deepEqual(await txtAt('_acme-challenge.www.example.com'), [])
  } finally { await empty.close() }
})

test('ARI: Pebble\'s renewal window for the issued certificate, and renewAfter lands inside it', { skip, timeout: 60_000 }, async t => {
  assert.ok(issued, 'needs the first test\'s certificate')
  const dir = await (await fetch(DIRECTORY_URL)).json() as { renewalInfo?: string }
  const ari = await fetchAri(DIRECTORY_URL, issued.certPem)
  if (!dir.renewalInfo) { t.diagnostic('this Pebble offers no ARI'); assert.equal(ari, null); return }
  t.diagnostic(`ARI window ${ari?.start.toISOString()} .. ${ari?.end.toISOString()}`)
  assert.ok(ari, `no window for ${ariCertId(issued.certPem)}`)
  assert.ok(ari.start < ari.end)
  assert.ok(ari.start >= issued.notBefore && ari.end <= issued.notAfter, 'window inside the validity')
  const at = renewAfter(issued, ari)
  assert.ok(at >= ari.start && at <= ari.end)
})

test('ARI: a certificate the CA never issued is unknown (null), and a directory without ARI gives null', { skip, timeout: 60_000 }, async () => {
  assert.ok(issued)
  // Pebble's own intermediate has an AKI and a serial but is not an end-entity certificate Pebble issued.
  const { intermediate } = await pebbleRoots()
  const dir = await (await fetch(DIRECTORY_URL)).json() as { renewalInfo?: string }
  if (dir.renewalInfo) {
    try { assert.equal(await fetchAri(DIRECTORY_URL, intermediate), null) }
    catch (e: any) { assert.match(e.message, /ARI \d{3}/) }   // some CAs answer 400 rather than 404; it must still be a clear error
  }
  // A directory with no renewalInfo: Pebble's management "directory" is not one, so serve a tiny one inline.
  const http = await import('node:http')
  const srv = http.createServer((_q, s) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ newNonce: 'x' })) })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  try {
    const port = (srv.address() as { port: number }).port
    assert.equal(await fetchAri(`http://127.0.0.1:${port}/dir`, issued.certPem), null)
  } finally { srv.close() }
})
