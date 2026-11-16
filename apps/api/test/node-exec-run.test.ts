// nodeExec(): the one way to run a command on a node over its own saved login (lib/node-exec.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeExec, type ExecOptions } from '../src/lib/node-exec'
import { productionRemoteExecutor } from '../src/lib/remote/executor'

const CRED: any = { kind: 'password', user: 'root', secret: 'x', port: 2222 }
const OK = { code: 0, output: 'fine', timedOut: false }
const calls: ExecOptions[] = []
const ssh = async (o: ExecOptions) => { calls.push(o); return OK }

test('a node with no login: null, unless the caller says what to throw; an unreadable login also gives null', async () => {
  const host = async (n: string) => `10.0.0.${n.length}`
  assert.equal(await nodeExec('a', 'true', { host, credential: async () => null, ssh }), null)
  assert.equal(await nodeExec('a', 'true', { host, credential: async () => { throw new Error('bad json') }, ssh }), null)
  await assert.rejects(nodeExec('a', 'true', { host, credential: async () => null, ssh, noLogin: n => new Error(`No login for ${n}`) }), /No login for a/)
  await assert.rejects(nodeExec('a', 'true', { host, credential: async () => { throw new Error('bad json') }, ssh, noLogin: () => new Error('x') }), /bad json/)
  assert.equal(calls.length, 0)
})

test('options pass through; the port may come from the login; host and login are looked up in the order asked', async () => {
  calls.length = 0
  const order: string[] = []
  const host = async (n: string) => { order.push('host'); return '10.0.0.5' }
  const credential = async () => { order.push('cred'); return CRED }
  const r = await nodeExec('a', 'uptime', { host, credential, ssh, timeoutMs: 5, maxOutputBytes: 9, input: 'in', requirePin: true, port: c => c.port })
  assert.equal(r, OK)
  assert.deepEqual(order, ['cred', 'host'])
  assert.deepEqual(calls[0], { host: '10.0.0.5', cred: CRED, command: 'uptime', timeoutMs: 5, maxOutputBytes: 9, input: 'in', requirePin: true, port: 2222 })
  order.length = 0
  await nodeExec('a', 'x', { host, credential, ssh, hostFirst: true })
  assert.deepEqual(order, ['host', 'cred'])
  assert.equal('port' in calls[1], false)
})

test('the remote-access executor still says what it said: no login, no address', async () => {
  const pve: any = { fetchStrict: async (p: string) => p === '/cluster/status' ? [{ type: 'node', name: 'n1', ip: '10.0.0.9' }] : [] }
  const t: any = { ssh, nodeCredential: async () => null, loadCredential: async () => null, listManualHosts: async () => [], listHostAddresses: async () => ({}), exclusions: async () => [], guestTags: async () => [] }
  const ex = productionRemoteExecutor(pve, t)
  const node = { id: 'node-n1', kind: 'node', name: 'n1', node: 'n1', running: true } as any
  await assert.rejects(ex.run(node, 'true'), /^No login saved for node n1\. Add one under Settings → Setup checklist \(Add node login\); node logins are never borrowed from guests\.$/)
  const lost = { ...node, id: 'node-zz', name: 'zz', node: 'zz' }
  await assert.rejects(ex.run(lost, 'true'), /Could not find an address for node zz/)
  calls.length = 0
  const t2 = { ...t, nodeCredential: async () => CRED }
  await productionRemoteExecutor(pve, t2).run(node, 'echo hi')
  assert.equal(calls[0].host, '10.0.0.9'); assert.equal(calls[0].command, 'bash -s'); assert.equal(calls[0].requirePin, true); assert.equal(calls[0].input, 'echo hi')
})
