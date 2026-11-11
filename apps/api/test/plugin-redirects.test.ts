// The plug-in broker sends a device's credential with every request, so it never follows a redirect: a device (or
// anything answering in its place) pointing elsewhere would otherwise receive the login. Discovery's probes do not
// follow redirects either, so a scan cannot be steered to another address.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fetchWithTimeout, PluginRedirectError } from '../src/lib/plugin-host'
import { probeOne } from '../src/lib/discovery'

let a: http.Server, b: http.Server
let aPort = 0, bPort = 0
const seenByB: http.IncomingHttpHeaders[] = []

before(async () => {
  b = http.createServer((req, res) => { seenByB.push(req.headers); res.end('{"status":"ok"}') })
  await new Promise<void>(r => b.listen(0, '127.0.0.1', r)); bPort = (b.address() as any).port
  a = http.createServer((req, res) => {
    if (req.url === '/plain') { res.setHeader('content-type', 'application/json'); return res.end('{"ok":true}') }
    res.writeHead(302, { location: `http://127.0.0.1:${bPort}/ping` }); res.end()
  })
  await new Promise<void>(r => a.listen(0, '127.0.0.1', r)); aPort = (a.address() as any).port
})
after(() => { a.close(); b.close() })

test('the broker refuses a redirect and the credential never reaches the redirect target', async () => {
  await assert.rejects(fetchWithTimeout(`http://127.0.0.1:${aPort}/api`, { Authorization: 'Bearer device-secret' }), PluginRedirectError)
  await assert.rejects(fetchWithTimeout(`http://127.0.0.1:${aPort}/api`, { 'X-Api-Key': 'device-secret' }, false, 'POST', { x: 1 }), /redirect/)
  assert.equal(seenByB.length, 0)
  const ok = await fetchWithTimeout(`http://127.0.0.1:${aPort}/plain`, {})
  assert.equal(ok.status, 200)
})

test('a discovery probe that is redirected is a miss, and the target is never asked', async () => {
  const hit = await probeOne('127.0.0.1', { port: aPort, path: '/ping', match: (s: number, body: string) => s === 200 && body.includes('status') } as any)
  assert.equal(hit, false)
  assert.equal(seenByB.length, 0)
})
