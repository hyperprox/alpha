// The Sites health probe never follows a redirect: it reports the redirect, and the target is never asked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { siteProbe } from '../src/routes/sites'

test('a redirecting site is reported, not followed', async () => {
  let targetHit = 0
  const target = http.createServer((_q, r) => { targetHit++; r.end('ok') })
  await new Promise<void>(r => target.listen(0, '127.0.0.1', r))
  const site = http.createServer((_q, r) => { r.writeHead(302, { location: `http://127.0.0.1:${(target.address() as any).port}/` }); r.end() })
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r))
  try {
    const res = await siteProbe(`http://127.0.0.1:${(site.address() as any).port}/wp-login.php`)
    assert.equal(res?.status, 302)
    assert.equal(targetHit, 0)
  } finally { site.close(); target.close() }
})
