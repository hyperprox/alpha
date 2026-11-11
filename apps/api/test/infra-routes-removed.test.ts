// Two guest routes were removed: one handed Proxmox's raw console ticket (vncproxy) to the browser, the other
// forwarded an unvalidated body to the guest's config. Nothing in the frontend called either. They must stay gone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { infrastructureRoutes } from '../src/routes/infrastructure'
import { ProxmoxClient } from '../src/lib/proxmox-client'
import { requiredRole } from '../src/lib/roles'

test('the console-ticket and raw config-write routes are not registered', async () => {
  const app = Fastify()
  await app.register(infrastructureRoutes, { prefix: '/api/infra' })
  await app.ready()
  assert.equal(app.hasRoute({ method: 'PUT', url: '/api/infra/vms/:node/:vmid/:type/config' }), false)
  // Reading a config (the Config tab) stays.
  assert.equal(app.hasRoute({ method: 'GET', url: '/api/infra/vms/:node/:vmid/:type/config' }), true)
  const vnc = await app.inject({ method: 'POST', url: '/api/infra/vms/n1/100/qemu/vnc' })
  assert.equal(vnc.statusCode, 404)
  const put = await app.inject({ method: 'PUT', url: '/api/infra/vms/n1/100/lxc/config', payload: { delete: 'mp0' } })
  assert.equal(put.statusCode, 404)
  await app.close()
})

test('the Proxmox client no longer offers a console ticket or a raw config write', () => {
  const proto = ProxmoxClient.prototype as any
  assert.equal(proto.getVNCTicket, undefined)
  assert.equal(proto.updateVMConfig, undefined)
})

test('no operator grant is left for a console-ticket path', () => {
  assert.equal(requiredRole('POST', '/api/infra/vms/n1/100/qemu/vnc'), 'admin')
})

test('a guest\'s raw config is admin-only, masked, and empty for a guest tagged hyperprox-ignore', async () => {
  assert.equal(requiredRole('GET', '/api/infra/vms/n1/100/lxc/config'), 'admin')
  process.env.PROXMOX_HOST = '192.0.2.1'; process.env.PROXMOX_TOKEN_SECRET = 'x'
  const proto = ProxmoxClient.prototype as any
  const orig = proto.getVMConfig
  const configs: Record<string, any> = {
    '100': { hostname: 'web', password: 'root-pw', cipassword: 'ci-pw', net0: 'name=eth0,ip=192.0.2.5/24', description: 'token=abc123' },
    '101': { hostname: 'private', tags: 'prod;hyperprox-ignore', description: 'secret stuff', mp0: '/srv/private,mp=/x' },
  }
  proto.getVMConfig = async (_n: string, vmid: number) => configs[String(vmid)]
  try {
    const app = Fastify()
    await app.register(infrastructureRoutes, { prefix: '/api/infra' })
    const a = await app.inject({ method: 'GET', url: '/api/infra/vms/n1/100/lxc/config' })
    assert.equal(a.statusCode, 200, a.body)
    assert.equal(a.body.includes('root-pw'), false)
    assert.equal(a.body.includes('ci-pw'), false)
    assert.equal(a.json().data.hostname, 'web')
    const b = await app.inject({ method: 'GET', url: '/api/infra/vms/n1/101/lxc/config' })
    assert.deepEqual(b.json().data, { tags: 'prod;hyperprox-ignore', ignored: true })
    await app.close()
  } finally { proto.getVMConfig = orig; delete process.env.PROXMOX_HOST; delete process.env.PROXMOX_TOKEN_SECRET }
})
