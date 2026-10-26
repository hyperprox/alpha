// ACME without a CA: zone selection across providers, the "nothing written when a name is unmanaged" rule,
// and the ARI certificate identifier against the worked example in RFC 9773.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zonesFor, issueCertificate, ariCertId, describeLeaf, type IssueDeps } from '../src/lib/certs/acme'
import type { DnsProvider } from '../src/lib/certs/dns01'

function provider(name: string, zones: string[], calls: string[] = []): DnsProvider {
  return {
    name,
    async zones() { calls.push(`${name} zones`); return zones },
    async present(z, f) { calls.push(`${name} present ${z} ${f}`) },
    async cleanup(z, f) { calls.push(`${name} cleanup ${z} ${f}`) },
  }
}

test('zonesFor: the longest managed zone wins across providers; unmanaged names get nulls', async () => {
  const r = await zonesFor(
    ['mail.example.com', '*.lab.example.com', 'example.org', 'www.example.net'],
    [provider('godaddy', ['example.com', 'example.org']), provider('other', ['lab.example.com'])],
  )
  assert.deepEqual(r, [
    { name: 'mail.example.com', zone: 'example.com', provider: 'godaddy' },
    { name: '*.lab.example.com', zone: 'lab.example.com', provider: 'other' },
    { name: 'example.org', zone: 'example.org', provider: 'godaddy' },
    { name: 'www.example.net', zone: null, provider: null },
  ])
  assert.deepEqual(await zonesFor(['mail.example.com'], []), [{ name: 'mail.example.com', zone: null, provider: null }])
})

test('zonesFor: a provider that cannot list its zones is an error, not "unmanaged"', async () => {
  const broken: DnsProvider = { ...provider('godaddy', []), zones: async () => { throw new Error('GoDaddy GET /domains failed 503') } }
  await assert.rejects(zonesFor(['mail.example.com'], [broken]), /503/)
})

function deps(dns: DnsProvider[], log: string[] = []): IssueDeps {
  return {
    // Unreachable: the order must fail before any network or vault access.
    directoryUrl: 'https://127.0.0.1:1/dir',
    email: null,
    getAccountKey: async () => { throw new Error('vault touched') },
    saveAccountKey: async () => { throw new Error('vault touched') },
    dns, log: l => log.push(l),
  }
}

test('issueCertificate: a name in no managed zone fails the order before anything is written', async () => {
  const calls: string[] = []
  await assert.rejects(
    issueCertificate(deps([provider('godaddy', ['example.com'], calls)]), ['mail.example.com', 'www.example.net', '*.example.org'], 'ec256'),
    (e: Error) => /No managed DNS zone for www\.example\.net, \*\.example\.org/.test(e.message) && /nothing was written/.test(e.message),
  )
  assert.deepEqual(calls, ['godaddy zones'])
})

test('issueCertificate: no names is refused', async () => {
  await assert.rejects(issueCertificate(deps([]), [], 'ec256'), /no names/)
})

// --- ARI certID -----------------------------------------------------------------------

const openssl = spawnSync('openssl', ['version']).status === 0

test('ariCertId matches the RFC 9773 example (AKI 69:88:5B…, serial 0x87654321 with its DER sign byte)',
  { skip: openssl ? false : 'openssl not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-ari-'))
  const run = (...args: string[]) => {
    const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  try {
    fs.writeFileSync(path.join(dir, 'leaf.ext'), 'subjectAltName=DNS:mail.example.com\nauthorityKeyIdentifier=keyid:always\n')
    run('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt',
      '-subj', '/CN=Test CA', '-days', '30', '-addext', 'subjectKeyIdentifier=69:88:5B:6B:87:46:40:41:E1:B3:7B:84:7B:A0:AE:2C:DE:01:C8:D4',
      '-addext', 'basicConstraints=critical,CA:TRUE')
    run('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=mail.example.com')
    run('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', '0x87654321', '-days', '10', '-extfile', 'leaf.ext', '-out', 'leaf.crt')
    const pem = fs.readFileSync(path.join(dir, 'leaf.crt'), 'utf8')
    assert.equal(ariCertId(pem), 'aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE')

    const d = describeLeaf(pem)
    assert.equal(d.serial, '87654321')
    assert.equal(d.issuer, 'CN=Test CA')
    assert.match(d.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    assert.equal(Math.round((d.notAfter.getTime() - d.notBefore.getTime()) / 86_400_000), 10)

    // A certificate without an AKI (self-signed, no extension) cannot have an ARI identifier.
    run('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ss.key', '-out', 'ss.crt',
      '-subj', '/CN=self', '-days', '1', '-addext', 'authorityKeyIdentifier=none', '-addext', 'subjectKeyIdentifier=none')
    assert.throws(() => ariCertId(fs.readFileSync(path.join(dir, 'ss.crt'), 'utf8')), /authority key identifier|no extensions/)
  } finally { fs.rmSync(dir, { recursive: true }) }
})
