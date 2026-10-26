// Probe: real handshakes against TLS servers started here, with certificates generated for the run (a private
// CA, a wildcard leaf, a self-signed one, an expired one), plus SMTP/IMAP/POP3 STARTTLS fakes. Then the verdict
// table, which is pure.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import { execFileSync } from 'node:child_process'
import { probeEndpoint, verdictFor, type ProbeResult } from '../src/lib/certs/probe'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'certs-probe-'))
const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8')
const EC = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes']

let ca = ''
const pems: Record<string, { key: string; cert: string }> = {}
const servers: net.Server[] = []

function makeCerts() {
  ssl('req', '-x509', ...EC, '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '30', '-subj', '/CN=Probe Test CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
  ca = read('ca.pem')

  fs.writeFileSync(path.join(dir, 'leaf.ext'), 'subjectAltName=DNS:localhost,DNS:*.wild.test,IP:127.0.0.1\n')
  ssl('req', '-new', ...EC, '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=localhost')
  ssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '20',
      '-extfile', 'leaf.ext', '-out', 'leaf.pem')
  pems.leaf = { key: read('leaf.key'), cert: read('leaf.pem') }

  ssl('req', '-x509', ...EC, '-keyout', 'self.key', '-out', 'self.pem', '-days', '90', '-subj', '/CN=self.test',
      '-addext', 'subjectAltName=DNS:self.test')
  pems.self = { key: read('self.key'), cert: read('self.pem') }

  // A certificate that ended in 2020: `openssl ca` is the 3.0 way to choose both dates.
  fs.writeFileSync(path.join(dir, 'index.txt'), '')
  fs.writeFileSync(path.join(dir, 'serial'), '1000\n')
  fs.writeFileSync(path.join(dir, 'ca.cnf'), [
    '[ca]', 'default_ca = d', '[d]', `dir = ${dir}`, 'database = $dir/index.txt', 'new_certs_dir = $dir',
    'serial = $dir/serial', 'default_md = sha256', 'policy = p', 'copy_extensions = copy', 'unique_subject = no',
    '[p]', 'commonName = supplied', '',
  ].join('\n'))
  ssl('req', '-new', ...EC, '-keyout', 'old.key', '-out', 'old.csr', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost')
  ssl('ca', '-batch', '-config', 'ca.cnf', '-cert', 'ca.pem', '-keyfile', 'ca.key', '-in', 'old.csr', '-out', 'old.pem',
      '-startdate', '20200101000000Z', '-enddate', '20200201000000Z', '-notext')
  pems.old = { key: read('old.key'), cert: read('old.pem') }
}

function listen(server: net.Server): Promise<number> {
  servers.push(server)
  return new Promise(res => server.listen(0, '127.0.0.1', () => res((server.address() as net.AddressInfo).port)))
}

const tlsServer = (which: string) => listen(tls.createServer({ ...pems[which] }, s => { s.on('error', () => {}); s.end() }))

/** A plain-text server that speaks `script` (pairs of expected-line prefix → reply) and then upgrades to TLS. */
function starttlsServer(greeting: string, script: Array<[string, string, boolean?]>, which = 'leaf'): Promise<number> {
  return listen(net.createServer(sock => {
    sock.on('error', () => {})
    sock.write(greeting)
    let buf = ''
    const onData = (c: Buffer) => {
      buf += c.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        const step = script.find(([prefix]) => l.toUpperCase().startsWith(prefix))
        if (!step) { sock.write('500 what\r\n'); continue }
        sock.write(step[1])
        if (step[2]) {
          sock.removeListener('data', onData)
          const t = new tls.TLSSocket(sock, { isServer: true, secureContext: tls.createSecureContext(pems[which]) })
          t.on('error', () => {})
          return
        }
      }
    }
    sock.on('data', onData)
  }))
}

const NOW = new Date()
const ctx = { now: NOW, warnFraction: 0.33, criticalDays: 7 }

before(() => makeCerts())
after(() => {
  for (const s of servers) s.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a CA-signed certificate: trusted, names match, dates and fingerprint read from the leaf', async () => {
  const port = await tlsServer('leaf')
  const r = await probeEndpoint({ host: '127.0.0.1', port, starttls: 'none', servername: 'localhost' }, 5000, { ca })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.trusted, true)
  assert.equal(r.namesMatch, true)
  assert.deepEqual(r.leaf!.names, ['localhost', '*.wild.test', '127.0.0.1'])
  assert.equal(r.leaf!.selfSigned, false)
  assert.match(r.leaf!.issuer, /CN=Probe Test CA/)
  assert.match(r.leaf!.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  const days = (r.leaf!.notAfter.getTime() - r.leaf!.notBefore.getTime()) / 86_400_000
  assert.ok(days > 19 && days < 21)
  assert.deepEqual(verdictFor(r, ctx), { verdict: 'ok', reason: null })
  // The fingerprint HyperProx expects decides; its formatting does not.
  assert.equal(verdictFor(r, { ...ctx, expectFingerprint: r.leaf!.fingerprint256.replace(/:/g, '').toLowerCase() }).verdict, 'ok')
  assert.equal(verdictFor(r, { ...ctx, expectFingerprint: 'AA'.repeat(32) }).verdict, 'critical')
})

test('without the CA, the same certificate is untrusted: critical on a public endpoint', async () => {
  const port = await tlsServer('leaf')
  const r = await probeEndpoint({ host: '127.0.0.1', port, starttls: 'none', servername: 'localhost' }, 5000)
  assert.equal(r.ok, true)
  assert.equal(r.trusted, false)
  assert.ok(r.authorizationError)
  const v = verdictFor(r, ctx)
  assert.equal(v.verdict, 'critical')
  assert.match(v.reason!, /untrusted/)
  assert.deepEqual(verdictFor(r, { ...ctx, internal: true }), { verdict: 'ok', reason: 'private certificate, expected here' })
})

test('wildcards cover one label, not two; a wrong name is critical', async () => {
  const port = await tlsServer('leaf')
  const one = await probeEndpoint({ host: '127.0.0.1', port, starttls: 'none', servername: 'a.wild.test' }, 5000, { ca })
  assert.equal(one.namesMatch, true)
  const two = await probeEndpoint({ host: '127.0.0.1', port, starttls: 'none', servername: 'a.b.wild.test' }, 5000, { ca })
  assert.equal(two.namesMatch, false)
  const other = await probeEndpoint({ host: '127.0.0.1', port, starttls: 'none', servername: 'other.test' }, 5000, { ca })
  assert.equal(other.namesMatch, false)
  const v = verdictFor(other, ctx)
  assert.equal(v.verdict, 'critical')
  assert.match(v.reason!, /does not cover/)
})

test('an IP address is checked against IP SANs and sends no SNI', async () => {
  const port = await tlsServer('leaf')
  const r = await probeEndpoint({ host: '127.0.0.1', port, starttls: 'none' }, 5000, { ca })
  assert.equal(r.namesMatch, true)
})

test('self-signed: critical where public is expected, ok on an internal endpoint', async () => {
  const port = await tlsServer('self')
  const r = await probeEndpoint({ host: '127.0.0.1', port, starttls: 'none', servername: 'self.test' }, 5000)
  assert.equal(r.leaf!.selfSigned, true)
  assert.equal(r.trusted, false)
  assert.deepEqual(verdictFor(r, ctx), { verdict: 'critical', reason: 'serves a self-signed certificate where a public one is expected' })
  assert.deepEqual(verdictFor(r, { ...ctx, internal: true }), { verdict: 'ok', reason: 'private certificate, expected here' })
})

test('an expired certificate is critical whatever else is true', async () => {
  const port = await tlsServer('old')
  const r = await probeEndpoint({ host: '127.0.0.1', port, starttls: 'none', servername: 'localhost' }, 5000, { ca })
  assert.equal(r.ok, true)
  assert.equal(r.trusted, false)
  assert.equal(r.leaf!.notAfter.toISOString(), '2020-02-01T00:00:00.000Z')
  const v = verdictFor(r, { ...ctx, internal: true })
  assert.equal(v.verdict, 'critical')
  assert.match(v.reason!, /^serves a certificate that expired \d+ days ago$/)
})

test('SMTP STARTTLS: multi-line greeting and EHLO, then TLS', async () => {
  const port = await starttlsServer('220-mail.example.com ESMTP\r\n220 ready\r\n', [
    ['EHLO', '250-mail.example.com\r\n250-PIPELINING\r\n250 STARTTLS\r\n'],
    ['STARTTLS', '220 go ahead\r\n', true],
  ])
  const r = await probeEndpoint({ host: '127.0.0.1', port, starttls: 'smtp', servername: 'localhost' }, 5000, { ca })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.trusted, true)
  assert.equal(r.namesMatch, true)
})

test('SMTP that refuses STARTTLS fails with the server\'s words', async () => {
  const port = await starttlsServer('220 ready\r\n', [['EHLO', '250 ok\r\n'], ['STARTTLS', '454 TLS not available\r\n']])
  const r = await probeEndpoint({ host: '127.0.0.1', port, starttls: 'smtp' }, 5000)
  assert.equal(r.ok, false)
  assert.match(r.error!, /STARTTLS with "454 TLS not available"/)
  assert.equal(verdictFor(r, ctx).verdict, 'error')
})

test('IMAP STARTTLS, with untagged lines before the tagged answer', async () => {
  const port = await starttlsServer('* OK IMAP ready\r\n', [['A1 STARTTLS', '* CAPABILITY IMAP4rev1\r\na1 OK Begin TLS\r\n', true]])
  const r = await probeEndpoint({ host: '127.0.0.1', port, starttls: 'imap', servername: 'localhost' }, 5000, { ca })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.trusted, true)
})

test('POP3 STLS', async () => {
  const port = await starttlsServer('+OK POP3 ready\r\n', [['STLS', '+OK begin\r\n', true]], 'self')
  const r = await probeEndpoint({ host: '127.0.0.1', port, starttls: 'pop3', servername: 'self.test' }, 5000)
  assert.equal(r.ok, true, r.error)
  assert.equal(r.leaf!.selfSigned, true)
})

test('a silent server times out within the deadline, and the probe never throws', async () => {
  const port = await listen(net.createServer(s => { s.on('error', () => {}) }))
  const t0 = Date.now()
  const r = await probeEndpoint({ host: '127.0.0.1', port, starttls: 'smtp' }, 300)
  assert.equal(r.ok, false)
  assert.match(r.error!, /no answer within 0.3s/)
  assert.ok(Date.now() - t0 < 2000)
  const r2 = await probeEndpoint({ host: '127.0.0.1', port, starttls: 'none' }, 300)
  assert.match(r2.error!, /no answer/)
})

test('connection refused and an unknown host come back as errors', async () => {
  const port = await listen(net.createServer())
  servers.pop()!.close()
  await new Promise(r => setTimeout(r, 50))
  const r = await probeEndpoint({ host: '127.0.0.1', port, starttls: 'none' }, 2000)
  assert.deepEqual([r.ok, r.error], [false, 'connection refused'])
  const r2 = await probeEndpoint({ host: 'no-such-host.invalid', port: 443, starttls: 'none' }, 5000)
  assert.equal(r2.ok, false)
  assert.ok(r2.error)
})

// --- verdict table ----------------------------------------------------------------

const DAY = 86_400_000
function result(o: { days?: number; lifetime?: number; trusted?: boolean; namesMatch?: boolean; selfSigned?: boolean; issuer?: string; fp?: string } = {}): ProbeResult {
  const lifetime = o.lifetime ?? 90
  const days = o.days ?? 60
  return {
    ok: true,
    leaf: {
      subject: 'CN=mail.example.com', issuer: o.issuer ?? "C=US, O=Let's Encrypt, CN=E7", names: ['mail.example.com'],
      notBefore: new Date(NOW.getTime() - (lifetime - days) * DAY), notAfter: new Date(NOW.getTime() + days * DAY),
      serial: '01', fingerprint256: o.fp ?? 'AB:CD', selfSigned: o.selfSigned ?? false,
    },
    trusted: o.trusted ?? true, namesMatch: o.namesMatch ?? true,
    ...(o.trusted === false ? { authorizationError: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' } : {}),
  }
}

test('verdict table', () => {
  const cases: Array<[string, ProbeResult, Partial<typeof ctx> & { internal?: boolean; expectFingerprint?: string }, string, RegExp | null]> = [
    ['healthy',                    result(),                                         {}, 'ok', null],
    ['probe failed',               { ok: false, error: 'connection refused', trusted: null, namesMatch: null }, {}, 'error', /^the probe failed: connection refused$/],
    ['expired',                    result({ days: -3 }),                             {}, 'critical', /expired 3 days ago/],
    ['under critical days',        result({ days: 5 }),                              {}, 'critical', /expires in 5 days/],
    ['name mismatch',              result({ namesMatch: false }),                    {}, 'critical', /does not cover/],
    ['other fingerprint',          result({ fp: '11:22' }),                          { expectFingerprint: 'ab:cd:ef' }, 'critical', /different certificate/],
    ['same fingerprint',           result({ fp: 'AB:CD:EF' }),                       { expectFingerprint: 'abcdef' }, 'ok', null],
    ['untrusted public',           result({ trusted: false }),                       {}, 'critical', /untrusted certificate \(UNABLE_TO_GET/],
    ['a third of 90 days left',    result({ days: 29 }),                             {}, 'warn', /in 29 days, with less than a third of its 90-day lifetime/],
    ['45-day cert, 14 days left',  result({ lifetime: 45, days: 14 }),               {}, 'warn', /45-day lifetime/],
    ['45-day cert, 16 days left',  result({ lifetime: 45, days: 16 }),               {}, 'ok', null],
    ['LE staging',                 result({ trusted: false, issuer: 'C=US, O=(STAGING) Let\'s Encrypt, CN=(STAGING) Ersatz Edamame E1' }), {}, 'warn', /staging/],
    ['Pebble',                     result({ trusted: false, issuer: 'CN=Pebble Intermediate CA 1a2b3c' }), {}, 'warn', /staging/],
    ['self-signed internal',       result({ trusted: false, selfSigned: true, lifetime: 3650, days: 3000 }), { internal: true }, 'ok', /^private certificate, expected here$/],
    ['private CA internal',        result({ trusted: false, lifetime: 398, days: 300 }), { internal: true }, 'ok', /^private certificate, expected here$/],
    ['internal, under a third',    result({ trusted: false, selfSigned: true, days: 20 }), { internal: true }, 'warn', /less than a third/],
    ['internal, name mismatch',    result({ trusted: false, selfSigned: true, namesMatch: false }), { internal: true }, 'critical', /does not cover/],
    ['internal, wrong fingerprint', result({ trusted: false, fp: '11:22' }), { internal: true, expectFingerprint: 'ab:cd' }, 'critical', /different certificate/],
    ['expiry beats internal',      result({ trusted: false, selfSigned: true, days: 2 }), { internal: true }, 'critical', /expires in 2 days/],
    ['not valid yet',              result({ days: 91 }),                             {}, 'critical', /not valid yet/],
    ['issued a minute ahead',      result({ days: 90.001 }),                         {}, 'ok', null],
    ['within a day',               result({ days: 0.5 }),                            {}, 'critical', /expires within a day/],
  ]
  for (const [name, r, extra, verdict, reason] of cases) {
    const v = verdictFor(r, { ...ctx, ...extra })
    assert.equal(v.verdict, verdict, `${name}: ${v.reason}`)
    if (reason) assert.match(v.reason!, reason, name)
    else assert.equal(v.reason, null, name)
  }
})

test("connect: reaches the given address but sends and verifies the name in host", async () => {
  const port = await tlsServer("leaf")
  // a.wild.test does not resolve; without connect this could not be reached at all.
  const r = await probeEndpoint({ host: "a.wild.test", connect: "127.0.0.1", port, starttls: "none" }, 5000, { ca })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.namesMatch, true)
  const wrong = await probeEndpoint({ host: "other.test", connect: "127.0.0.1", port, starttls: "none" }, 5000, { ca })
  assert.equal(wrong.namesMatch, false)
})
