// The Proxmox read in network.ts runs every two seconds: a server that accepts the connection and never answers
// must be cut off with an error, not held open.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import https from 'node:https'
import { proxmoxFetch, PROXMOX_READ_TIMEOUT_MS } from '../src/lib/network'

test('the default limit is ten seconds', () => { assert.equal(PROXMOX_READ_TIMEOUT_MS, 10_000) })

test('a server that never answers is cut off and the read rejects', async () => {
  const sockets: net.Socket[] = []
  const server = net.createServer(s => { sockets.push(s) })   // accepts, then says nothing
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  const t0 = Date.now()
  try {
    await assert.rejects(() => proxmoxFetch('127.0.0.1', port, 'x=y', '/nodes', 300, new https.Agent()), /did not answer within/)
    assert.ok(Date.now() - t0 < 3000, 'gave up soon after the limit')
  } finally {
    sockets.forEach(s => s.destroy())
    await new Promise(r => server.close(r))
  }
})

test('a connection cut in the middle of the body rejects at once, long before the limit', async () => {
  const { generateKeyPairSync } = await import('node:crypto')
  void generateKeyPairSync
  const http2 = await import('node:tls')
  void http2
  // A plain TCP server speaking just enough HTTP over TLS is heavy; use an https server with a throwaway
  // certificate from openssl-free self-signed material instead.
  const { execFileSync } = await import('node:child_process')
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-net-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' })
  } catch { fs.rmSync(dir, { recursive: true, force: true }); return }   // no openssl here: nothing to serve with
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' })
    res.write('{"data":')
    setTimeout(() => res.socket?.destroy(), 20)   // headers and part of the body sent, then the socket is cut
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as net.AddressInfo).port
  const t0 = Date.now()
  try {
    await assert.rejects(() => proxmoxFetch('127.0.0.1', port, 'x=y', '/nodes', 5000, new https.Agent({ rejectUnauthorized: false })), /closed the connection|socket hang up|aborted/i)
    assert.ok(Date.now() - t0 < 2000, 'rejected promptly, not after the 5 s limit')
  } finally {
    await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true })
  }
})
