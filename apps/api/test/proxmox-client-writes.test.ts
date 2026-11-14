import { test, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import https from 'https'
import { EventEmitter } from 'events'
import { ProxmoxClient } from '../src/lib/proxmox-client'

type Seen = { method: string; path: string; headers: Record<string, any>; body: string }
let seen: Seen[] = []

/** Stand in for https.request: records the request, answers with `status` and a PVE-shaped JSON body. */
function stub(status: number, json: unknown) {
  seen = []
  mock.method(https, 'request', ((opts: any, cb: (res: any) => void) => {
    const req: any = new EventEmitter()
    const rec: Seen = { method: opts.method, path: opts.path, headers: opts.headers, body: '' }
    seen.push(rec)
    req.setTimeout = () => req
    req.destroy = () => {}
    req.write = (b: string) => { rec.body += b }
    req.end = () => {
      const res: any = new EventEmitter()
      res.statusCode = status; res.statusMessage = 'X'
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(json)); res.emit('end') })
    }
    return req
  }) as any)
}
afterEach(() => mock.restoreAll())

const client = () => new ProxmoxClient('192.0.2.10', 8006, 'root@pam!t', 'secret', { agent: new https.Agent() })
const FORM = 'application/x-www-form-urlencoded'

const writes: Array<[string, (c: ProxmoxClient) => Promise<unknown>, string, string, string | null]> = [
  ['createSnapshot', c => c.createSnapshot('node-a', 100, 'lxc', 'pre change', 'a note'), 'POST', '/api2/json/nodes/node-a/lxc/100/snapshot', 'snapname=pre+change&description=a+note'],
  ['createSnapshot without description', c => c.createSnapshot('node-a', 100, 'qemu', 'snap1'), 'POST', '/api2/json/nodes/node-a/qemu/100/snapshot', 'snapname=snap1'],
  ['migrateVM', c => c.migrateVM('node-a', 100, 'lxc', 'node-b', true), 'POST', '/api2/json/nodes/node-a/lxc/100/migrate', 'target=node-b&online=1'],
  ['migrateVM offline', c => c.migrateVM('node-a', 100, 'qemu', 'node-b', false), 'POST', '/api2/json/nodes/node-a/qemu/100/migrate', 'target=node-b&online=0'],
  ['setHAState', c => c.setHAState('ct:100', 'stopped'), 'PUT', '/api2/json/cluster/ha/resources/ct%3A100', 'state=stopped'],
  ['vmAction', c => c.vmAction('node-a', 100, 'lxc', 'start'), 'POST', '/api2/json/nodes/node-a/lxc/100/status/start', null],
  ['deleteSnapshot', c => c.deleteSnapshot('node-a', 100, 'lxc', 'snap1'), 'DELETE', '/api2/json/nodes/node-a/lxc/100/snapshot/snap1', null],
  ['rollbackSnapshot', c => c.rollbackSnapshot('node-a', 100, 'lxc', 'snap1'), 'POST', '/api2/json/nodes/node-a/lxc/100/snapshot/snap1/rollback', null],
  ['deleteLXC', c => c.deleteLXC('node-a', 100), 'DELETE', '/api2/json/nodes/node-a/lxc/100', null],
  ['deleteVM', c => c.deleteVM('node-a', 100), 'DELETE', '/api2/json/nodes/node-a/qemu/100', null],
]

for (const [name, call, method, path, body] of writes) {
  test(`${name}: exact method, path, encoding`, async () => {
    stub(200, { data: 'UPID:node-a:1' })
    await call(client())
    const r = seen[0]
    assert.equal(r.method, method)
    assert.equal(r.path, path)
    assert.equal(r.body, body ?? '')
    if (body !== null) assert.equal(r.headers['Content-Type'], FORM)
    assert.ok(!r.body.startsWith('{'), 'never a JSON body')
  })
  test(`${name}: a 400 from Proxmox is thrown with its reason`, async () => {
    stub(400, { data: null, message: 'Parameter verification failed.' })
    await assert.rejects(() => call(client()), /HTTP 400.*Parameter verification failed/)
  })
}

// ── GET /api/proxmox/cluster-name ────────────────────────────────────────────
import Fastify from 'fastify'
import { proxmoxRoutes } from '../src/routes/proxmox'

async function nameApp(rows: unknown | Error) {
  process.env.PROXMOX_HOST = '192.0.2.10'; process.env.PROXMOX_USER = 'root@pam'
  process.env.PROXMOX_TOKEN_ID = 't'; process.env.PROXMOX_TOKEN_SECRET = 'secret'
  mock.method(ProxmoxClient.prototype, 'fetchStrict', (async () => { if (rows instanceof Error) throw rows; return rows }) as any)
  const a = Fastify({ logger: false })
  await a.register(proxmoxRoutes, { prefix: '/api/proxmox' })
  await a.ready()
  return a
}

test('cluster-name: the cluster row\'s name', async () => {
  const a = await nameApp([{ type: 'node', name: 'node-a' }, { type: 'cluster', name: 'lab-cluster' }])
  const r = await a.inject({ method: 'GET', url: '/api/proxmox/cluster-name' })
  assert.deepEqual(r.json(), { name: 'lab-cluster' })
  await a.close()
})

test('cluster-name: standalone node or unreachable gives null', async () => {
  let a = await nameApp([{ type: 'node', name: 'node-a' }])
  assert.deepEqual((await a.inject({ method: 'GET', url: '/api/proxmox/cluster-name' })).json(), { name: null })
  await a.close(); mock.restoreAll()
  a = await nameApp(new Error('down'))
  assert.deepEqual((await a.inject({ method: 'GET', url: '/api/proxmox/cluster-name' })).json(), { name: null })
  await a.close()
})
