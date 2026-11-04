// Nginx Proxy Manager behaviour that only a real NPM shows (written against 2.16.0): updates merge into the
// host and never reset options the caller did not send, websockets keeps its value, a disabled host is created
// in one call, and a change made on NPM after the preview fails the apply. Opt-in, against a throwaway NPM:
//   HP_PROXY_NPM_LIVE=1 HP_NPM_URL=http://…:81 HP_NPM_EMAIL=… HP_NPM_PASSWORD=… HP_NPM_BACKEND=host:port
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NPMClient } from '../src/lib/npm-client'
import { ProxyService, LEGACY_NPM_ID } from '../src/lib/proxy/service'
import { MemoryInstanceSecrets, MemoryProxyStore } from '../src/lib/proxy/store'
import { ProxyPlanner } from '../src/lib/proxy/plans'

const LIVE = process.env.HP_PROXY_NPM_LIVE === '1'

if (!LIVE) {
  test('live NPM behaviour (set HP_PROXY_NPM_LIVE=1 and HP_NPM_* to run)', { skip: true }, () => {})
} else {
  const url = process.env.HP_NPM_URL!, email = process.env.HP_NPM_EMAIL!, password = process.env.HP_NPM_PASSWORD!
  const [bHost, bPort] = (process.env.HP_NPM_BACKEND ?? '127.0.0.1:9000').split(':')
  const run = Date.now().toString(36)
  const actor = { email: 'npm-live@example.invalid' }
  const npm = new NPMClient(url, email, password)
  const service = new ProxyService({ store: new MemoryProxyStore(), secrets: new MemoryInstanceSecrets(), legacyNpm: async () => ({ url, email, password }) })
  const planner = new ProxyPlanner(service)
  const made: number[] = []
  let certId = 0
  let hostId = 0
  const native = async () => npm.getProxyHost(hostId) as any
  const KEEP = ['certificate_id', 'ssl_forced', 'hsts_enabled', 'hsts_subdomains', 'http2_support', 'caching_enabled', 'block_exploits',
    'allow_websocket_upgrade', 'advanced_config', 'access_list_id', 'locations', 'trust_forwarded_proto', 'domain_names', 'forward_host', 'forward_scheme']
  const pick = (h: any) => Object.fromEntries(KEEP.map(k => [k, h[k]]))

  test('setup: a custom certificate and a host using every option', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-live-'))
    try {
      const name = `cert-${run}.hpx.invalid`
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '30',
        '-subj', `/CN=${name}`, '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' })
      const tok = (await (await fetch(`${url}/api/tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity: email, secret: password }) })).json()).token
      const c = await (await fetch(`${url}/api/nginx/certificates`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
        body: JSON.stringify({ provider: 'other', nice_name: `hpx-test-${run}` }) })).json()
      certId = c.id
      const form = new FormData()
      form.append('certificate', new Blob([fs.readFileSync(path.join(dir, 'c.pem'))]), 'c.pem')
      form.append('certificate_key', new Blob([fs.readFileSync(path.join(dir, 'k.pem'))]), 'k.pem')
      const up = await fetch(`${url}/api/nginx/certificates/${certId}/upload`, { method: 'POST', headers: { authorization: `Bearer ${tok}` }, body: form })
      assert.equal(up.ok, true, await up.text())
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    const h = await npm.createProxyHost({ domain_names: [`full-${run}.hpx.invalid`], forward_scheme: 'http', forward_host: bHost, forward_port: Number(bPort),
      certificate_id: certId, ssl_forced: true, hsts_enabled: true, hsts_subdomains: true, http2_support: true, caching_enabled: true,
      block_exploits: false, allow_websocket_upgrade: false, advanced_config: '# hpx test\nproxy_set_header X-Test 1;', meta: {} as any, locations: [] as any } as any)
    hostId = h.id
    made.push(h.id)
    assert.equal((await native()).certificate_id, certId)
  })

  test('finding 1: a partial NPM update merges; nothing it did not name changes, and the read-back checks every field', async () => {
    const before = pick(await native())
    const plan = await planner.preview(LEGACY_NPM_ID, { action: 'update', hostId: String(hostId), host: { npm: { block_exploits: true } } }, actor)
    assert.deepEqual(plan.changes.length, 1, plan.changes.join(' | '))
    assert.match(plan.changes[0], /block exploits: off → on/)
    const r = await planner.apply(plan.id, actor)
    assert.equal(r.ok, true, r.message)
    assert.deepEqual(pick(await native()), { ...before, block_exploits: true })
  })

  test('finding 1: removing the certificate and turning off HTTPS options is spelled out and warned', async () => {
    const plan = await planner.preview(LEGACY_NPM_ID, { action: 'update', hostId: String(hostId), host: { npm: { certificate_id: false, hsts_enabled: false } } }, actor)
    assert.ok(plan.changes.some(c => /certificate: #\d+ .*→ none/.test(c)), plan.changes.join(' | '))
    assert.ok(plan.changes.some(c => /HSTS: on → off/.test(c)))
    assert.ok(plan.warnings.some(w => /plain HTTP|certificate/i.test(w)), plan.warnings.join(' | '))
    // Not applied: the host keeps its certificate for the next tests.
  })

  test('finding 2: a port-only update keeps websockets off; a websockets-only update works', async () => {
    const r1 = await planner.apply((await planner.preview(LEGACY_NPM_ID, { action: 'update', hostId: String(hostId), host: { forwardPort: Number(bPort) + 1 } }, actor)).id, actor)
    assert.equal(r1.ok, true, r1.message)
    const n1 = await native()
    assert.equal(n1.forward_port, Number(bPort) + 1)
    assert.equal(n1.allow_websocket_upgrade, false)
    const plan = await planner.preview(LEGACY_NPM_ID, { action: 'update', hostId: String(hostId), host: { websockets: true } }, actor)
    assert.match(plan.changes.join(' '), /websockets: off → on/)
    const r2 = await planner.apply(plan.id, actor)
    assert.equal(r2.ok, true, r2.message)
    assert.equal((await native()).allow_websocket_upgrade, true)
    assert.equal((await native()).certificate_id, certId)
  })

  test('an unchanged edit is refused before anything is sent', async () => {
    const h = await native()
    await assert.rejects(planner.preview(LEGACY_NPM_ID, { action: 'update', hostId: String(hostId), host: { forwardPort: h.forward_port, npm: { ssl_forced: h.ssl_forced } } }, actor), /Nothing would change/)
  })

  test('finding 3: a host created disabled is created in one call and reads back disabled', async () => {
    const d = `off-${run}.hpx.invalid`
    const r = await planner.apply((await planner.preview(LEGACY_NPM_ID, { action: 'create', host: { domains: [d], forwardHost: bHost, forwardPort: Number(bPort), enabled: false } }, actor)).id, actor)
    if (r.hostId) made.push(Number(r.hostId))
    assert.equal(r.ok, true, r.message)
    assert.equal(r.after?.enabled, false)
    assert.equal((await npm.getProxyHosts()).filter(h => h.domain_names.includes(d)).length, 1)
  })

  test('finding 4: a change made on NPM after the preview (advanced config) fails the apply; nothing is overwritten', async () => {
    const plan = await planner.preview(LEGACY_NPM_ID, { action: 'update', hostId: String(hostId), host: { forwardPort: Number(bPort) } }, actor)
    await npm.updateProxyHost(hostId, { advanced_config: '# changed behind the preview' } as any)
    await assert.rejects(planner.apply(plan.id, actor), /changed .* after the preview/)
    assert.equal((await native()).advanced_config, '# changed behind the preview')
  })

  test('cleanup: remove what this run made (and anything an earlier failed run left under .hpx.invalid)', async () => {
    for (const h of await npm.getProxyHosts()) if (made.includes(h.id) || h.domain_names.some(d => d.endsWith('.hpx.invalid'))) await npm.deleteProxyHost(h.id)
    for (const c of await npm.getCertificates()) if (c.id === certId || /^hpx-test-/.test(c.nice_name)) await npm.deleteCertificate(c.id).catch(() => undefined)
    assert.deepEqual((await npm.getProxyHosts()).filter(h => h.domain_names.some(d => d.endsWith('.hpx.invalid'))), [])
  })
}
