// The ProxyProvider contract on recorded fixtures: NPM (two instances), Traefik, Caddy, HAProxy, Pangolin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LEGACY_NPM_ID } from '../src/lib/proxy/service'
import { runContract } from './proxy-contract'
import { fixtureWorld } from './fakes/proxy-world'

const w = fixtureWorld()
const actor = { email: 'admin@example.invalid' }
const ids: Record<string, string> = {}

test('setup: one instance per provider, a second NPM beside the legacy one', async () => {
  const add = async (kind: string, name: string, url: string, settings: Record<string, string>, secrets: Record<string, string>) => {
    const r = await w.service.createInstance({ kind, name, url, settings, secrets }, actor)
    assert.equal(r.health.ok, true, `${name}: ${JSON.stringify(r.health.checks)}`)
    return r.instance.id
  }
  ids.npm2 = await add('npm', 'npm two', 'http://192.0.2.37:181', { email: 'admin@example.invalid' }, { password: 'npm2-password' })
  ids.traefik = await add('traefik', 'edge traefik', 'http://192.0.2.38:8282',
    { api_user: 'hpx', file: '/etc/traefik/dynamic/hyperprox.yml', ssh_host: '192.0.2.38', ssh_user: 'hpx' },
    { api_password: 'traefik-test-password', ssh_password: 'x' })
  ids.caddy = await add('caddy', 'edge caddy', 'http://192.0.2.38:2019', {}, {})
  ids.haproxy = await add('haproxy', 'edge haproxy', 'http://192.0.2.38:5555', { user: 'hpx' }, { password: 'haproxy-test-password' })
  ids.pangolin = await add('pangolin', 'pangolin', 'http://192.0.2.39:3003/v1', { org_id: 'hpx-test' }, { api_key: 'pangolin-test-key' })
  const list = await w.service.viewInstances()
  assert.deepEqual(list.map(i => i.kind), ['npm', 'npm', 'traefik', 'caddy', 'haproxy', 'pangolin'])
  assert.equal(list[0].id, LEGACY_NPM_ID)
  assert.equal(list[0].legacy, true)
  // Secrets are in the vault item, never in the stored row or the view.
  const row = (await w.store.get(ids.haproxy))!
  assert.equal(JSON.stringify(row).includes('haproxy-test-password'), false)
  assert.deepEqual(list.find(i => i.id === ids.haproxy)!.secretsSet, ['password'])
  assert.equal(JSON.stringify(list).includes('haproxy-test-password'), false)
  // The Traefik SSH host key was pinned when it was added.
  assert.equal(list.find(i => i.id === ids.traefik)!.settings.ssh_host_key, 'SHA256:fixture-host-key')
})

const base = { service: () => w.service, forwardHost: '192.0.2.50', forwardPort: 9000 }
runContract({ ...base, label: 'NPM (legacy instance)', instanceId: LEGACY_NPM_ID, externalDomain: 'legacy-npm1.hpx.invalid',
  domain: 'test-a.hpx.invalid', secondDomain: 'test-a2.hpx.invalid', multiDomain: true, externalReadOnly: false })
runContract({ ...base, label: 'NPM (second instance)', get instanceId() { return ids.npm2 }, externalDomain: 'legacy-npm2.hpx.invalid',
  domain: 'test-a.hpx.invalid', secondDomain: 'test-a2.hpx.invalid', multiDomain: true, externalReadOnly: false })
runContract({ ...base, label: 'Traefik', get instanceId() { return ids.traefik }, externalDomain: 'legacy-traefik.hpx.invalid',
  domain: 'test-t.hpx.invalid', secondDomain: 'test-t2.hpx.invalid', multiDomain: true })
runContract({ ...base, label: 'Caddy', get instanceId() { return ids.caddy }, externalDomain: 'legacy-caddy.hpx.invalid',
  domain: 'test-c.hpx.invalid', secondDomain: 'test-c2.hpx.invalid', multiDomain: true })
runContract({ ...base, label: 'HAProxy', get instanceId() { return ids.haproxy }, externalDomain: 'legacy-haproxy.hpx.invalid',
  domain: 'test-h.hpx.invalid', secondDomain: 'test-h2.hpx.invalid', multiDomain: true })
runContract({ ...base, label: 'Pangolin', get instanceId() { return ids.pangolin }, externalDomain: 'legacy-pangolin.hpx.invalid',
  domain: 'test-p.hpx.invalid', secondDomain: 'test-p2.hpx.invalid', multiDomain: false })

test('every host across instances names its instance; two NPMs side by side', async () => {
  const { hosts, errors } = await w.service.allHosts()
  assert.deepEqual(errors, [])
  const npm = hosts.filter(h => h.kind === 'npm')
  assert.deepEqual([...new Set(npm.map(h => h.instanceId))].sort(), [LEGACY_NPM_ID, ids.npm2].sort())
  for (const h of hosts) assert.ok(h.instanceId && h.instanceName)
})

test('one instance down does not hide the others; it is named', async () => {
  await w.service.updateInstance(ids.caddy, { url: 'http://192.0.2.99:2019' }, actor)
  const r = await w.service.allHosts()
  assert.ok(r.hosts.length > 0)
  assert.deepEqual(r.errors.map(e => e.instanceName), ['edge caddy'])
  assert.match(r.errors[0].error, /could not be sent \(ECONNREFUSED\)/)
  await w.service.updateInstance(ids.caddy, { url: 'http://192.0.2.38:2019' }, actor)
})
