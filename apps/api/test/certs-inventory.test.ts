// Inventory: discovery de-duplicates endpoints and keeps the most informative source; the merge gives every
// certificate one entry with how it renews and who uses it, judges it by what is actually served, and turns
// anything served that nothing explains into an entry of its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildInventory, discoverProbeTargets, type InventoryDeps, type InventoryPolicy } from '../src/lib/certs/inventory'
import type { NPMCertificate } from '../src/lib/npm-client'
import type { CertsManaged, CertsProbe } from '../src/lib/certs/types'

const NOW = new Date('2026-10-26T06:15:00Z')
const DAY = 86_400_000
const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString()

const policy: InventoryPolicy = {
  alerts: { warnFraction: 0.33, criticalDays: 7 },
  certificates: {
    mail: { names: ['mail.example.com'], deploy: [{ target: 'mail-guest' }] },
    self: { names: ['hp.example.com'], deploy: [{ target: 'self' }] },
  },
  probes: [
    { host: 'mail.example.com', port: 993, starttls: 'none', internal: false },
    { host: 'mail.example.com', port: 587, starttls: 'smtp', internal: false },
    { host: 'backup.example.com', port: 8007, starttls: 'none', internal: true },
    { host: 'WWW.example.com', port: 443, starttls: 'none', internal: false },
  ],
  targets: { 'mail-guest': { kind: 'guest-files' }, self: { kind: 'hyperprox' } },
}

const npmCert = (id: number, names: string[], expires: string, o: Partial<NPMCertificate> & { modified_on?: string } = {}): NPMCertificate =>
  ({ id, nice_name: names[0], domain_names: names, expires_on: expires, provider: 'letsencrypt', meta: {}, ...o })

const hosts = [
  { domain_names: ['www.example.com', 'example.com'], certificate_id: 1, enabled: true },
  { domain_names: ['dns.example.com'], certificate_id: 2, enabled: true },
  { domain_names: ['off.example.com'], certificate_id: 1, enabled: false },
  { domain_names: ['plain.example.com'], certificate_id: null, enabled: true },
  { domain_names: ['*.wild.example.com'], certificate_id: 2, enabled: true },
]

const nodes = [
  { node: 'node-a', host: '10.0.0.11', certs: [
    { filename: 'pve-root-ca.pem', issuer: 'CN=Proxmox Virtual Environment', notbefore: 0, notafter: 4_000_000_000, fingerprint: '00:00' },
    { filename: 'pve-ssl.pem', issuer: 'CN=Proxmox Virtual Environment, O=PVE Cluster Manager CA', notbefore: Date.parse(at(-300)) / 1000, notafter: Date.parse(at(430)) / 1000,
      san: ['IP Address:10.0.0.11', 'DNS:node-a'], fingerprint: 'AA:11' },
  ] },
  { node: 'node-b', host: '10.0.0.12', certs: [
    { filename: 'pve-ssl.pem', issuer: 'CN=Proxmox Virtual Environment', notbefore: 0, notafter: 4_000_000_000, fingerprint: 'BB:00' },
    { filename: 'pveproxy-ssl.pem', issuer: "C=US, O=Let's Encrypt, CN=E7", notbefore: Date.parse(at(-80)) / 1000, notafter: Date.parse(at(10)) / 1000,
      san: ['node-b.example.com'], fingerprint: 'BB:22' },
  ] },
]

const managed: CertsManaged[] = [{
  label: 'mail', names: ['mail.example.com'], status: 'valid', issuer: "C=US, O=Let's Encrypt, CN=E7",
  notBefore: at(-10), notAfter: at(80), renewAfter: at(50), ariStart: null, ariEnd: null, staging: false, lastError: null,
  dns: [{ name: 'mail.example.com', zone: 'example.com', provider: 'godaddy' }],
  targets: [{ name: 'mail-guest', kind: 'guest-files', lastDeployAt: at(-10), lastResult: 'ok', verdict: 'ok' }],
}]

function probe(host: string, port: number, o: Partial<CertsProbe> = {}): CertsProbe {
  return { host, port, starttls: 'none', source: 'policy', internal: false, checkedAt: NOW.toISOString(), verdict: 'ok',
           reason: null, fingerprint: 'FF:FF', issuer: "C=US, O=Let's Encrypt, CN=E7", notAfter: at(80), trusted: true, namesMatch: true, ...o }
}

test('discovery: one target per host:port, policy first (managed when it serves a managed name), then managed, proxy, nodes', async () => {
  const targets = await discoverProbeTargets({ npmHosts: async () => hosts, nodeCertificates: async () => nodes, policy, managed })
  const view = targets.map(t => `${t.source} ${t.host}:${t.port} ${t.starttls}${t.internal ? ' internal' : ''}`)
  assert.deepEqual(view, [
    'managed mail.example.com:993 none',
    'managed mail.example.com:587 smtp',
    'policy backup.example.com:8007 none internal',
    'policy WWW.example.com:443 none',            // the proxy's www.example.com:443 is the same endpoint
    'managed hp.example.com:443 none',            // the hyperprox target serves its names on 443
    'proxy example.com:443 none',
    'proxy dns.example.com:443 none',
    'node 10.0.0.11:8006 none internal',
    'node 10.0.0.12:8006 none internal',
  ])
  // Disabled hosts, hosts without a certificate and wildcard names are not probed.
  assert.ok(!view.some(v => /off\.|plain\.|\*/.test(v)))
})

async function inventory(probes: CertsProbe[], over: Partial<InventoryDeps> = {}) {
  return buildInventory({
    npmCertificates: async () => [
      npmCert(1, ['www.example.com', 'example.com'], at(60), { modified_on: at(-30) }),
      npmCert(2, ['dns.example.com', '*.wild.example.com'], at(70), { meta: { dns_challenge: true } }),
      npmCert(3, ['gone.example.com'], at(-40)),
      npmCert(4, ['custom.example.com'], at(200), { provider: 'other' }),
    ],
    npmHosts: async () => hosts,
    nodeCertificates: async () => nodes,
    managed, probes, policy, now: NOW, ...over,
  })
}

test('merge: sources, renewal wording, usedBy, days and lifetime', async () => {
  const inv = await inventory([])
  const byId = new Map(inv.map(e => [e.id, e]))
  assert.deepEqual([...byId.keys()].sort(), ['managed:mail', 'npm:1', 'npm:2', 'npm:3', 'npm:4', 'pve:node-a:pve-ssl.pem', 'pve:node-b:pveproxy-ssl.pem'])

  const www = byId.get('npm:1')!
  assert.equal(www.renewal, 'Proxy (HTTP-01)')
  assert.deepEqual(www.usedBy, ['www.example.com', 'example.com', 'off.example.com'])
  assert.equal(www.daysLeft, 60)
  assert.equal(www.lifetimeDays, 90)      // from modified_on, the proxy's last renewal
  assert.equal(www.verdict, 'ok')

  assert.equal(byId.get('npm:2')!.renewal, 'Proxy (DNS-01)')
  assert.equal(byId.get('npm:2')!.lifetimeDays, null)
  assert.equal(byId.get('npm:4')!.renewal, 'Uploaded to the proxy (no renewal)')

  // Expired and unused is housekeeping, not an outage.
  const gone = byId.get('npm:3')!
  assert.equal(gone.verdict, 'warn')
  assert.match(gone.reason!, /expired 40 days ago and no proxy host uses it/)

  const mail = byId.get('managed:mail')!
  assert.equal(mail.renewal, 'HyperProx (DNS-01)')
  assert.deepEqual(mail.usedBy, ['mail-guest'])
  assert.equal(mail.lifetimeDays, 90)

  const a = byId.get('pve:node-a:pve-ssl.pem')!
  assert.equal(a.renewal, 'Proxmox internal CA')
  assert.deepEqual(a.names, ['10.0.0.11', 'node-a'])
  assert.deepEqual(a.usedBy, ['node-a console (10.0.0.11:8006)'])
  // pveproxy-ssl.pem is what node-b serves; its unused pve-ssl.pem and every root CA are left out.
  const b = byId.get('pve:node-b:pveproxy-ssl.pem')!
  assert.equal(b.renewal, 'Proxmox ACME')
  assert.equal(b.verdict, 'warn')                // 10 of 90 days left
  assert.match(b.reason!, /expires in 10 days, with less than a third of its 90-day lifetime left/)

  // Worst first.
  assert.equal(inv[0].verdict, 'warn')
  assert.equal(inv[inv.length - 1].verdict, 'ok')
})

test('a probe judges the certificate it serves; the managed entry takes the worst of its endpoints', async () => {
  const inv = await inventory([
    probe('www.example.com', 443, { notAfter: at(60), source: 'proxy' }),
    probe('mail.example.com', 993, { notAfter: at(80) }),
    probe('mail.example.com', 587, { starttls: 'smtp', verdict: 'critical', reason: 'serves a different certificate from the one HyperProx deployed',
                                     fingerprint: 'EE:EE', notAfter: at(300), issuer: 'CN=mail.example.com' }),
  ])
  const mail = inv.find(e => e.id === 'managed:mail')!
  assert.equal(mail.verdict, 'critical')
  assert.equal(mail.reason, 'mail.example.com:587 serves a different certificate from the one HyperProx deployed')
  assert.deepEqual(mail.usedBy, ['mail-guest', 'mail.example.com:993', 'mail.example.com:587'])
  // Attributed to the managed certificate, so not also listed as a stranger.
  assert.ok(!inv.some(e => e.source === 'probe'))
  assert.equal(inv[0].id, 'managed:mail')
})

test('a node certificate is matched by fingerprint, and the console probe sets its verdict', async () => {
  const inv = await inventory([probe('10.0.0.11', 8006, { source: 'node', internal: true, fingerprint: 'aa11', verdict: 'warn',
    reason: 'serves a certificate from a private CA', issuer: 'CN=Proxmox Virtual Environment', notAfter: at(430) })])
  const a = inv.find(e => e.id === 'pve:node-a:pve-ssl.pem')!
  assert.equal(a.verdict, 'warn')
  assert.equal(a.reason, '10.0.0.11:8006 serves a certificate from a private CA')
  assert.ok(!inv.some(e => e.source === 'probe'))
})

test('what is served and explained by nothing becomes its own entry; a failed probe at a known endpoint counts against it', async () => {
  const inv = await inventory([
    probe('backup.example.com', 8007, { internal: true, verdict: 'warn', reason: 'serves a self-signed certificate', fingerprint: 'CC:CC',
                                        issuer: 'CN=backup', notAfter: at(700), trusted: false }),
    probe('dns.example.com', 443, { verdict: 'error', reason: 'the probe failed: connection refused', fingerprint: null, notAfter: null, issuer: null }),
    probe('www.example.com', 443, { verdict: 'warn', reason: 'serves a staging certificate, which clients do not trust', fingerprint: 'DD:DD',
                                    issuer: 'CN=(STAGING) Ersatz', notAfter: at(5) }),
  ])
  const stranger = inv.filter(e => e.source === 'probe')
  assert.deepEqual(stranger.map(e => e.id), ['probe:www.example.com:443', 'probe:backup.example.com:8007'])
  const backup = stranger.find(e => e.id === 'probe:backup.example.com:8007')!
  assert.equal(backup.selfSigned, true)
  assert.equal(backup.daysLeft, 700)
  assert.equal(backup.renewal, 'Not managed by HyperProx or the proxy')
  assert.deepEqual(backup.usedBy, ['backup.example.com:8007'])
  assert.equal(stranger.find(e => e.id === 'probe:www.example.com:443')!.staging, true)

  const dns = inv.find(e => e.id === 'npm:2')!
  assert.equal(dns.verdict, 'error')
  assert.equal(dns.reason, 'dns.example.com:443 the probe failed: connection refused')
  // www serves a certificate the proxy does not hold: npm:1 is not blamed for it.
  assert.equal(inv.find(e => e.id === 'npm:1')!.verdict, 'ok')
})

test('managed certificates: not issued, failed, failed renewal, staging', async () => {
  const base = managed[0]
  const inv = await inventory([], { managed: [
    { ...base, label: 'new', names: ['new.example.com'], status: 'pending', notBefore: null, notAfter: null, issuer: null },
    { ...base, label: 'bad', names: ['bad.example.com'], status: 'failed', notBefore: null, notAfter: null, lastError: 'DNS provider not managed' },
    { ...base, label: 'old', names: ['old.example.com'], status: 'failed', notBefore: at(-85), notAfter: at(5), lastError: 'CA rejected validation' },
    { ...base, label: 'mid', names: ['mid.example.com'], status: 'failed', notBefore: at(-10), notAfter: at(80), lastError: 'timeout' },
    { ...base, label: 'stg', names: ['stg.example.com'], staging: true },
  ] })
  const v = (l: string) => { const e = inv.find(x => x.id === `managed:${l}`)!; return [e.verdict, e.reason] }
  assert.deepEqual(v('new'), ['unknown', 'not issued yet'])
  assert.deepEqual(v('bad'), ['error', 'issuance failed: DNS provider not managed'])
  assert.deepEqual(v('old'), ['critical', 'expires in 5 days and its last renewal failed: CA rejected validation'])
  assert.deepEqual(v('mid'), ['warn', 'its last renewal failed: timeout'])
  assert.deepEqual(v('stg'), ['warn', 'is a staging certificate, which clients do not trust'])
  assert.equal(inv.find(e => e.id === 'managed:stg')!.staging, true)
})
