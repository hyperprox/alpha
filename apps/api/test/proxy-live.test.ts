// The ProxyProvider contract against real servers. Opt-in: HP_PROXY_LIVE=1, with HP_PROXY_LIVE_CONFIG
// pointing at a JSON file outside the repository (addresses and test credentials of throwaway servers).
// Each run uses fresh names under .hpx.invalid and removes what it creates. Every write goes through the
// same preview → apply → re-read path as the Proxy page, and traffic is checked through the proxy itself.
//
//   HP_PROXY_LIVE=1 HP_PROXY_LIVE_CONFIG=/path/config.json node --import tsx --test test/proxy-live.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { ProxyService, LEGACY_NPM_ID } from '../src/lib/proxy/service'
import { MemoryInstanceSecrets, MemoryProxyStore } from '../src/lib/proxy/store'
import { ProxyPlanner } from '../src/lib/proxy/plans'
import { runContract, type ContractCase } from './proxy-contract'

const LIVE = process.env.HP_PROXY_LIVE === '1'
const CFG_PATH = process.env.HP_PROXY_LIVE_CONFIG ?? ''

if (!LIVE) {
  test('live proxy tests (set HP_PROXY_LIVE=1 and HP_PROXY_LIVE_CONFIG to run)', { skip: true }, () => {})
} else if (process.env.HP_PROXY_LIVE_PHASE === 'after-caddy-restart') {
  // Second phase, after the harness restarted the Caddy container: the host made in phase one is still there.
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
  test('live Caddy: the host HyperProx added survived a Caddy restart', async () => {
    const saved = JSON.parse(fs.readFileSync(`${CFG_PATH}.caddy-persist`, 'utf8'))
    const service = new ProxyService({ store: new MemoryProxyStore(), secrets: new MemoryInstanceSecrets(), legacyNpm: async () => null })
    const actor = { email: 'live-test@example.invalid' }
    const { instance } = await service.createInstance({ kind: 'caddy', name: 'live caddy', url: cfg.caddy.url }, actor)
    const h = (await service.hosts(instance.id)).find(x => x.id === saved.id)
    assert.ok(h, 'the route is back after the restart')
    assert.deepEqual(h.domains, [saved.name])
    const planner = new ProxyPlanner(service)
    const r = await planner.apply((await planner.preview(instance.id, { action: 'delete', hostId: saved.id }, actor)).id, actor)
    assert.equal(r.ok, true, r.message)
    fs.rmSync(`${CFG_PATH}.caddy-persist`)
  })
} else {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
  const run = Date.now().toString(36)
  const actor = { email: 'live-test@example.invalid' }
  const service = new ProxyService({
    store: new MemoryProxyStore(), secrets: new MemoryInstanceSecrets(),
    legacyNpm: async () => ({ url: cfg.npm[0].url, email: cfg.npm[0].email, password: cfg.npm[0].password }),
  })
  const ids: Record<string, string> = { npm1: LEGACY_NPM_ID }

  /**
   * GET / on the proxy with a Host header. 200 only when the test backend (whoami, which echoes the
   * request) answered; a 200 from the proxy itself (a default site) is reported as 299.
   */
  const prober = (base: string) => (domain: string) => new Promise<number | null>(resolve => {
    const u = new URL(base)
    const req = http.request({ host: u.hostname, port: u.port, path: '/', headers: { Host: domain }, timeout: 5000 }, res => {
      let body = ''
      res.on('data', d => { body += d })
      res.on('end', () => resolve(res.statusCode === 200 && !/^Hostname: /m.test(body) ? 299 : res.statusCode ?? null))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.end()
  })
  const settled = (base: string) => async (domain: string, want: (s: number | null) => boolean) => {
    const p = prober(base)
    let last: number | null = null
    for (let i = 0; i < 20; i++) { last = await p(domain); if (want(last)) return last; await new Promise(r => setTimeout(r, 500)) }
    return last
  }

  test('live setup: every instance added through the service and healthy', async () => {
    const add = async (key: string, input: any) => {
      const r = await service.createInstance(input, actor)
      assert.equal(r.health.ok, true, `${input.name}: ${JSON.stringify(r.health.checks)}`)
      ids[key] = r.instance.id
      return r
    }
    await add('npm2', { kind: 'npm', name: 'live npm 2', url: cfg.npm[1].url, settings: { email: cfg.npm[1].email }, secrets: { password: cfg.npm[1].password } })
    const t = await add('traefik', { kind: 'traefik', name: 'live traefik', url: cfg.traefik.url,
      settings: { api_user: cfg.traefik.user, file: cfg.traefik.file, entrypoints: 'web', transport: 'ssh', ssh_host: cfg.traefik.sshHost, ssh_user: cfg.traefik.sshUser },
      secrets: { api_password: cfg.traefik.password, ssh_private_key: fs.readFileSync(cfg.traefik.sshKeyFile, 'utf8') } })
    assert.match(t.instance.settings.ssh_host_key, /^SHA256:/, 'the SSH host key was learned and pinned')
    await add('caddy', { kind: 'caddy', name: 'live caddy', url: cfg.caddy.url })
    await add('haproxy', { kind: 'haproxy', name: 'live haproxy', url: cfg.haproxy.url, settings: { user: cfg.haproxy.user }, secrets: { password: cfg.haproxy.password } })
    const token = fs.readFileSync(cfg.pangolin.tokenFile, 'utf8').split('=', 2)[1].trim()
    await add('pangolin', { kind: 'pangolin', name: 'live pangolin', url: cfg.pangolin.url, settings: { org_id: cfg.pangolin.org }, secrets: { api_key: token } })
    const { errors } = await service.allHosts()
    assert.deepEqual(errors, [])
  })

  test('live: a pinned SSH host key that no longer matches stops every Traefik read and write', async () => {
    const inst = await service.getInstance(ids.traefik)
    const good = inst.settings.ssh_host_key
    await service.updateInstance(ids.traefik, { settings: { ssh_host_key: 'SHA256:not-the-key' } }, actor)
    try {
      const h = await service.health(ids.traefik)
      assert.equal(h.ok, false)
      assert.match(h.checks.find(c => c.name === 'file')!.detail, /host key changed/)
    } finally { await service.updateInstance(ids.traefik, { settings: { ssh_host_key: good } }, actor) }
  })

  const be = cfg.backend, edge = cfg.edgeBackend
  const cases: ContractCase[] = [
    { label: 'live NPM 1 (legacy login)', instanceId: LEGACY_NPM_ID, externalDomain: cfg.npm[0].external, externalReadOnly: false,
      probe: settled(cfg.npm[0].probe) },
    { label: 'live NPM 2', get instanceId() { return ids.npm2 }, externalDomain: cfg.npm[1].external, externalReadOnly: false,
      probe: settled(cfg.npm[1].probe) },
    { label: 'live Traefik', get instanceId() { return ids.traefik }, externalDomain: cfg.traefik.external, forwardHost: edge.host, forwardPort: edge.port,
      probe: settled(cfg.traefik.probe), disabledStatus: 403 },
    { label: 'live Caddy', get instanceId() { return ids.caddy }, externalDomain: cfg.caddy.external, forwardHost: edge.host, forwardPort: edge.port,
      probe: settled(cfg.caddy.probe), disabledStatus: 503 },
    { label: 'live HAProxy', get instanceId() { return ids.haproxy }, externalDomain: cfg.haproxy.external, forwardHost: edge.host, forwardPort: edge.port,
      probe: settled(cfg.haproxy.probe), disabledStatus: 503 },
    { label: 'live Pangolin', get instanceId() { return ids.pangolin }, externalDomain: cfg.pangolin.external, forwardHost: edge.host, forwardPort: edge.port,
      multiDomain: false },
  ].map((c: any, i) => Object.assign(c, {
    service: () => service, multiDomain: c.multiDomain ?? true,
    forwardHost: c.forwardHost ?? be.host, forwardPort: c.forwardPort ?? be.port,
    domain: `test-${i}-${run}.hpx.invalid`, secondDomain: `test-${i}b-${run}.hpx.invalid`,
  }))
  for (const c of cases) runContract(c)

  test('live HAProxy: a configuration haproxy -c rejects is not applied, and HAProxy keeps serving', async () => {
    const planner = new ProxyPlanner(service)
    const before = (await service.hosts(ids.haproxy)).map(h => h.id).sort()
    // A server address haproxy cannot resolve fails validation (resolution happens at parse time).
    const plan = await planner.preview(ids.haproxy, { action: 'create', host: { domains: [`bad-${run}.hpx.invalid`], forwardHost: 'no-such-host.hpx.invalid', forwardPort: 80 } }, actor)
    await assert.rejects(planner.apply(plan.id, actor), /HAProxy rejected the new configuration .*nothing was applied/)
    assert.deepEqual((await service.hosts(ids.haproxy)).map(h => h.id).sort(), before)
    assert.equal(await prober(cfg.haproxy.probe)(cfg.haproxy.external), 200, 'the outside host still answers')
  })

  test('live: a Caddy host survives a restart only through autosave + --resume (checked by the harness)', async () => {
    const planner = new ProxyPlanner(service)
    const name = `persist-${run}.hpx.invalid`
    const r = await planner.apply((await planner.preview(ids.caddy, { action: 'create', host: { domains: [name], forwardHost: edge.host, forwardPort: edge.port } }, actor)).id, actor)
    assert.equal(r.ok, true, r.message)
    fs.writeFileSync(`${CFG_PATH}.caddy-persist`, JSON.stringify({ name, id: r.hostId }))
  })
}
