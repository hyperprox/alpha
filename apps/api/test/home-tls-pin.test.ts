// The home Proxmox API's certificate is pinned: the first one seen is pinned (so an install that predates this keeps
// working), a normally-verifying one is always accepted, and a different self-signed one is refused before the API
// token is sent. Against a real HTTPS server on loopback with throwaway certificates.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProxmoxClient } from '../src/lib/proxmox-client'
import { homeCertDecision, homeTlsPin, forgetHomeTlsPin, HomeCertificateChangedError } from '../src/lib/home-tls'

const dir = mkdtempSync(join(tmpdir(), 'hpx-home-tls-'))
process.env.HPX_HOME_TLS_PINS = join(dir, 'pins.json')
function cert(name: string) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', `/CN=${name}`,
    '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.pem`)], { stdio: 'ignore' })
  return { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.pem`)) }
}
let port = 0
let server: https.Server
const tokensSeen: string[] = []
function listen(c: { key: Buffer; cert: Buffer }) {
  server = https.createServer(c, (req, res) => { tokensSeen.push(String(req.headers.authorization ?? '')); res.end('{"data":{"version":"9.0"}}') })
  return new Promise<void>(r => server.listen(port, '127.0.0.1', () => { port = (server.address() as any).port; r() }))
}
const A = cert('pve-a'), B = cert('pve-b')
before(async () => { await listen(A) })
after(() => server?.close())

test('the rule', () => {
  const pin = { fingerprint: 'AA', source: 'first-use' as const, at: '' }
  assert.deepEqual(homeCertDecision(null, 'AA', false), { accept: true, record: 'first-use' })
  assert.deepEqual(homeCertDecision(pin, 'AA', false), { accept: true })
  assert.deepEqual(homeCertDecision(pin, 'BB', false), { accept: false })
  assert.deepEqual(homeCertDecision(pin, 'BB', true), { accept: true, record: 'ca-verified' })
})

test('first use pins the certificate; the same one keeps working', async () => {
  assert.equal(existsSync(process.env.HPX_HOME_TLS_PINS!), false)
  const c = new ProxmoxClient('127.0.0.1', port, 'root@pam!hpx', 'tok-secret')
  assert.equal((await c.fetchStrict<any>('/version')).version, '9.0')
  const pin = homeTlsPin('127.0.0.1', port)!
  assert.equal(pin.source, 'first-use')
  assert.match(pin.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  assert.equal((await c.fetchStrict<any>('/version')).version, '9.0')
  assert.equal(tokensSeen.length, 2)
})

test('a different certificate at the same address is refused before the token is sent; forgetting the pin re-pins', async () => {
  await new Promise<void>(r => server.close(() => r()))
  await listen(B)
  const before = tokensSeen.length
  const c = new ProxmoxClient('127.0.0.1', port, 'root@pam!hpx', 'tok-secret')
  await assert.rejects(c.fetchStrict('/version'), (e: any) => e instanceof HomeCertificateChangedError && /not the one HyperProx pinned/.test(e.message))
  assert.equal(tokensSeen.length, before, 'the server never received the token')
  forgetHomeTlsPin('127.0.0.1', port)
  assert.equal((await c.fetchStrict<any>('/version')).version, '9.0')
})
