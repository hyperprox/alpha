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
