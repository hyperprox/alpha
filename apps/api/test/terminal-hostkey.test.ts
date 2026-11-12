// A changed SSH host key in the Deck, checked with Proxmox (lib/terminal-hostkey.ts): the address is resolved to a
// cluster guest, that guest's own keys are read through its node (pct exec, or the VM's guest agent), and only a key
// that is one of them can be trusted with one tap. Fakes stand in for Proxmox, the nodes and the probe; the pins,
// the vault, the gate and the role matrix are the real ones.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { terminalRoutes } from '../src/routes/terminal'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable, getCredential, setCredential } from '../src/lib/credentials'
import { requestContext } from '../src/lib/auth'
import { setAuditSink } from '../src/lib/audit'
import { setTerminalTargetDeps, type TargetDeps } from '../src/lib/terminal-targets'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken } from '../src/lib/api-tokens'
import {
  checkHostKey, verifyForPane, trustVerdict, parseKeygenFingerprints, agentExecOutput, lxcConfigAddresses,
  setHostKeyCheckDeps, resetHostKeyChecks, HostKeyCheckRefusal, OVERRIDE_PHRASE, type HostKeyCheckDeps,
} from '../src/lib/terminal-hostkey'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'

const fp = (s: string) => 'SHA256:' + createHash('sha256').update(s).digest('base64').replace(/=+$/, '')
const OLD = fp('old ed25519'), NEW = fp('new ed25519'), RSA = fp('guest rsa'), OTHER = fp('someone else')
const ADDR = '192.0.2.101', VM_ADDR = '192.0.2.202'

const keygen = (lines: Array<[number, string, string]>) => lines.map(([bits, f, t]) => `${bits} ${f} root@guest (${t})`).join('\n') + '\n'

interface World {
  resources: any[]
  configs: Record<string, Record<string, unknown>>
  agentUp: Set<number>
  interfaces: Record<number, unknown>
  saved: Record<string, string>
  /** Output of the guest-keys command, per vmid. */
  keys: Record<number, string>
  offered: { fingerprint: string; type: string }
  pins: Map<string, { fingerprint: string | null; source: string | null; evidence: any }>
  ran: Array<{ node: string; command: string }>
  repinned: Array<{ host: string; port: number; fp: string; source: string; evidence: any }>
  audits: Array<{ action: string; resource: string; details: Record<string, unknown> }>
  auditFails?: boolean
}

function world(over: Partial<World> = {}): World {
  return {
    resources: [{ type: 'lxc', vmid: 101, node: 'node-a', status: 'running', name: 'web' }],
    configs: { 'lxc/101': { net0: `name=eth0,bridge=vmbr0,ip=${ADDR}/24` } },
    agentUp: new Set(), interfaces: {}, saved: {},
    keys: { 101: keygen([[256, NEW, 'ED25519'], [3072, RSA, 'RSA']]) },
    offered: { fingerprint: NEW, type: 'ssh-ed25519' },
    pins: new Map([[`${ADDR}:22`, { fingerprint: OLD, source: 'terminal-auto', evidence: null }], [`${VM_ADDR}:22`, { fingerprint: OLD, source: 'terminal-auto', evidence: null }]]),
    ran: [], repinned: [], audits: [],
    ...over,
  }
}

function depsFor(w: World): HostKeyCheckDeps {
  return {
    resources: async () => w.resources,
    guestConfig: async (_n, vmid, type) => w.configs[`${type}/${vmid}`] ?? {},
    agentPing: async (_n, vmid) => w.agentUp.has(vmid),
    agentInterfaces: async (_n, vmid) => { if (!w.agentUp.has(vmid)) throw new Error('agent not running'); return w.interfaces[vmid] ?? [] },
    hostAddresses: async () => w.saved,
    nodeRun: async (node, command) => {
      w.ran.push({ node, command })
      const m = /(?:pct exec|qm guest exec) (\d+)/.exec(command)
      const out = w.keys[Number(m?.[1])] ?? ''
      if (command.startsWith('qm guest exec')) return { code: 0, output: JSON.stringify({ exited: 1, exitcode: 0, 'out-data': out }) }
      return { code: 0, output: out }
    },
    probe: async () => w.offered,
    pin: async (h, p) => w.pins.get(`${h}:${p}`) ?? { fingerprint: null, source: null, evidence: null },
    repin: async (host, port, f, source, evidence) => { w.repinned.push({ host, port, fp: f, source, evidence }); w.pins.set(`${host}:${port}`, { fingerprint: f, source, evidence }) },
    audit: async (action, resource, details) => { if (w.auditFails) throw new Error('database is down'); w.audits.push({ action, resource, details }) },
  }
}

const as = <T>(role: 'operator' | 'admin' | 'owner', fn: () => Promise<T>, sid = `sid-${role}`) => requestContext.run({ sid, email: `${role}@example.com`, role }, fn)

beforeEach(() => resetHostKeyChecks())

// --- Parsing -------------------------------------------------------------------------------------------------

test('ssh-keygen lines become key types and fingerprints; anything else is ignored', () => {
  const ecdsa = fp('ecdsa')
  const keys = parseKeygenFingerprints(`256 ${NEW} root@web (ED25519)\r\n3072 ${RSA} root@web (RSA)\n384 ${ecdsa} no comment here (ECDSA)\nssh-keygen: /etc/ssh/x.pub is not a public key file.\n256 SHA256:short root@web (ED25519)\n`)
  assert.deepEqual(keys, [
    { type: 'ssh-ed25519', fingerprint: NEW }, { type: 'ssh-rsa', fingerprint: RSA }, { type: 'ecdsa-sha2-nistp384', fingerprint: ecdsa },
  ])
  assert.equal(agentExecOutput(JSON.stringify({ exited: 1, exitcode: 0, 'out-data': 'x' }))?.out, 'x')
  assert.equal(agentExecOutput(JSON.stringify({ exited: 0 })), null)
  assert.equal(agentExecOutput('not json'), null)
  assert.deepEqual(lxcConfigAddresses({ net0: 'name=eth0,ip=192.0.2.5/24,ip6=2001:db8::5/64', net1: 'name=eth1,ip=dhcp', hostname: 'ip=192.0.2.9' }), ['192.0.2.5', '2001:db8::5'])
})

// --- Verdicts -------------------------------------------------------------------------------------------------

test('LXC verified: the offered key is one of the container\'s own keys, read with pct exec on its node', async () => {
  const w = world()
  const v = await checkHostKey(ADDR, 22, depsFor(w), { type: 'lxc', vmid: 101 })
  assert.equal(v.state, 'verified', JSON.stringify(v))
  assert.equal(v.guest?.name, 'web')
  assert.equal(v.guest?.vmid, 101)
  assert.equal(v.via, 'pct')
  assert.equal(v.pinned, OLD)
  assert.equal(w.ran.length, 1)
  assert.equal(w.ran[0].node, 'node-a')
  assert.match(w.ran[0].command, /^pct exec 101 -- sh -c 'for f in \/etc\/ssh\/ssh_host_\*_key\.pub; do ssh-keygen -lf "\$f"; done'$/)
  assert.ok(v.context.some(c => /learned the first time/.test(c)), 'the old pin\'s source is told')
})

test('VM verified through a mocked guest agent: address from the agent, keys from qm guest exec', async () => {
  const w = world({
    resources: [{ type: 'qemu', vmid: 202, node: 'node-b', status: 'running', name: 'db' }],
    configs: { 'qemu/202': { agent: 'enabled=1' } },
    agentUp: new Set([202]),
    interfaces: { 202: { result: [{ name: 'lo', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '127.0.0.1' }] }, { name: 'eth0', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': VM_ADDR, prefix: 24 }] }] } },
    keys: { 202: keygen([[256, NEW, 'ED25519']]) },
  })
  const v = await checkHostKey(VM_ADDR, 22, depsFor(w), { type: 'qemu', vmid: 202 })
  assert.equal(v.state, 'verified', JSON.stringify(v))
  assert.equal(v.guest?.type, 'qemu')
  assert.equal(v.via, 'guest-agent')
  assert.equal(w.ran[0].node, 'node-b')
  assert.match(w.ran[0].command, /^qm guest exec 202 --timeout 20 -- sh -c 'for f in/)
})

test('mismatch: the guest\'s own keys do not include the offered one (something else answers at its address)', async () => {
  const w = world({ offered: { fingerprint: OTHER, type: 'ssh-ed25519' } })
  const v = await checkHostKey(ADDR, 22, depsFor(w))
  assert.equal(v.state, 'mismatch')
  assert.equal(v.guest?.name, 'web')
  assert.deepEqual(v.guestKeys?.map(k => k.fingerprint), [NEW, RSA])
  // Same fingerprint, different key type: not the guest's key either.
  const t = await checkHostKey(ADDR, 22, depsFor(world({ offered: { fingerprint: RSA, type: 'ssh-ed25519' } })))
  assert.equal(t.state, 'mismatch')
})

test('unknown: no running guest has the address', async () => {
  const v = await checkHostKey('192.0.2.77', 22, depsFor(world({ pins: new Map([['192.0.2.77:22', { fingerprint: OLD, source: null, evidence: null }]]) })))
  assert.equal(v.state, 'unknown')
  assert.equal(v.reason, 'no-guest')
  assert.match(v.why!, /No running guest/)
})

test('unknown: the VM at that address has no running guest agent', async () => {
  // Known to use the address from its login's saved address, but the agent cannot say or read anything.
  const w = world({
    resources: [{ type: 'qemu', vmid: 202, node: 'node-b', status: 'running', name: 'db' }],
    configs: { 'qemu/202': { agent: '1' } }, saved: { 'qemu-202': VM_ADDR },
  })
  const v = await checkHostKey(VM_ADDR, 22, depsFor(w))
  assert.equal(v.state, 'unknown')
  assert.equal(v.reason, 'agent-down')
  assert.equal(v.guest?.vmid, 202)
  assert.match(v.why!, /guest agent is not running/)
  assert.equal(w.ran.length, 0, 'nothing ran on the node')
})

test('unknown: the read through the node failed (no node login)', async () => {
  const w = world()
  const d = { ...depsFor(w), nodeRun: async () => null }
  const v = await checkHostKey(ADDR, 22, d)
  assert.equal(v.state, 'unknown')
  assert.equal(v.reason, 'read-failed')
  assert.match(v.why!, /no login for node node-a/)
})

// --- A guest agent is the guest's own word: it never vouches for an address on its own -------------------------

const spoofVm = (vmid: number, addr: string, fpOut: string) => ({
  resource: { type: 'qemu', vmid, node: 'node-b', status: 'running', name: 'evil' },
  config: { agent: '1' },
  interfaces: { result: [{ name: 'eth0', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': addr }] }] },
  keys: keygen([[256, fpOut, 'ED25519']]),
})

test('spoof: a compromised VM whose agent claims a container\'s address cannot get its own key verified', async () => {
  const evil = spoofVm(202, ADDR, OTHER)
  const w = world({
    resources: [{ type: 'lxc', vmid: 101, node: 'node-a', status: 'running', name: 'web' }, evil.resource],
    configs: { 'lxc/101': { net0: `ip=${ADDR}/24` }, 'qemu/202': evil.config },
    agentUp: new Set([202]), interfaces: { 202: evil.interfaces }, keys: { 101: keygen([[256, NEW, 'ED25519']]), 202: evil.keys },
    offered: { fingerprint: OTHER, type: 'ssh-ed25519' },
  })
  const v = await checkHostKey(ADDR, 22, depsFor(w), { type: 'lxc', vmid: 101 })
  assert.equal(v.state, 'unknown', JSON.stringify(v))
  assert.equal(v.reason, 'several-guests')
  assert.equal(w.ran.length, 0, 'neither guest was read: there is nothing to decide between them')
})

test('pane-guest mismatch: a key verified as another guest\'s is never verified for this pane', async () => {
  // The pane's container is stopped; a running VM claims its address and really holds the offered key.
  const evil = spoofVm(202, ADDR, NEW)
  const w = world({
    resources: [{ type: 'lxc', vmid: 101, node: 'node-a', status: 'stopped', name: 'web' }, evil.resource],
    configs: { 'lxc/101': { net0: `ip=${ADDR}/24` }, 'qemu/202': evil.config },
    agentUp: new Set([202]), interfaces: { 202: evil.interfaces }, keys: { 202: evil.keys },
  })
  const v = await checkHostKey(ADDR, 22, depsFor(w), { type: 'lxc', vmid: 101 })
  assert.equal(v.state, 'unknown', JSON.stringify(v))
  assert.equal(v.reason, 'other-guest')
  assert.equal(v.guest?.vmid, 202)
  // And a trust of that verdict needs an admin and the typed phrase, never one tap.
  const d = depsFor(w)
  const held = await as('operator', () => verifyForPane('lxc-101', ADDR, 22, d))
  await assert.rejects(as('operator', () => trustVerdict('lxc-101', { host: ADDR, port: 22 }, { verdictId: held.verdictId! }, d)), (e: any) => e.status === 403)
})

test('a hand-added host whose address only a VM agent claims is not verified; the VM\'s saved login or cloud-init makes it so', async () => {
  const vm = spoofVm(202, VM_ADDR, NEW)
  const mk = (over: Partial<World> = {}) => world({
    resources: [vm.resource], configs: { 'qemu/202': vm.config }, agentUp: new Set([202]), interfaces: { 202: vm.interfaces }, keys: { 202: vm.keys }, ...over,
  })
  const agentOnly = await checkHostKey(VM_ADDR, 22, depsFor(mk()), null)
  assert.equal(agentOnly.state, 'unknown')
  assert.equal(agentOnly.reason, 'agent-only')
  assert.equal((await checkHostKey(VM_ADDR, 22, depsFor(mk({ saved: { 'qemu-202': VM_ADDR } })), null)).state, 'verified')
  assert.equal((await checkHostKey(VM_ADDR, 22, depsFor(mk({ configs: { 'qemu/202': { agent: '1', ipconfig0: `ip=${VM_ADDR}/24` } } })), null)).state, 'verified')
  // Another VM's saved address does not back this one.
  assert.equal((await checkHostKey(VM_ADDR, 22, depsFor(mk({ saved: { 'qemu-999': VM_ADDR } })), null)).reason, 'agent-only')
})

test('a running VM that may have the address (cloud-init) but whose agent cannot say blocks a verdict', async () => {
  const w = world({
    resources: [{ type: 'lxc', vmid: 101, node: 'node-a', status: 'running', name: 'web' }, { type: 'qemu', vmid: 203, node: 'node-b', status: 'running', name: 'quiet' }],
    configs: { 'lxc/101': { net0: `ip=${ADDR}/24` }, 'qemu/203': { ipconfig0: `ip=${ADDR}/24` } },
  })
  const v = await checkHostKey(ADDR, 22, depsFor(w), { type: 'lxc', vmid: 101 })
  assert.equal(v.state, 'unknown')
  assert.equal(v.reason, 'several-guests')
})

test('a failed read through the node is reported without its raw error text', async () => {
  const w = world()
  const d = { ...depsFor(w), nodeRun: async () => { throw new Error('ssh: secret node detail /root/x') } }
  const v = await checkHostKey(ADDR, 22, d, { type: 'lxc', vmid: 101 })
  assert.equal(v.state, 'unknown')
  assert.equal(v.reason, 'read-failed')
  assert.doesNotMatch(v.why!, /secret node detail/)
  assert.match(v.why!, /API log/)
})

test('context: a stopped guest configured with the same address is named', async () => {
  const w = world({
    resources: [
      { type: 'lxc', vmid: 101, node: 'node-a', status: 'running', name: 'web' },
      { type: 'qemu', vmid: 150, node: 'node-c', status: 'stopped', name: 'old-web' },
      { type: 'lxc', vmid: 105, node: 'node-a', status: 'stopped', name: 'web-before' },
    ],
    configs: {
      'lxc/101': { net0: `name=eth0,ip=${ADDR}/24` },
      'qemu/150': { ipconfig0: `ip=${ADDR}/24,gw=192.0.2.1` },
      'lxc/105': { net0: `name=eth0,ip=${ADDR}/24` },
    },
  })
  const v = await checkHostKey(ADDR, 22, depsFor(w))
  assert.equal(v.state, 'verified')
  assert.equal(v.guest?.vmid, 101)
  assert.ok(v.context.includes('VM 150 (old-web, stopped) is also configured with this address.'), JSON.stringify(v.context))
  assert.ok(v.context.includes('Container 105 (web-before, stopped) is also configured with this address.'), JSON.stringify(v.context))
})

test('two running guests on one address: unknown, never a guess', async () => {
  const w = world({
    resources: [{ type: 'lxc', vmid: 101, node: 'node-a', status: 'running', name: 'web' }, { type: 'lxc', vmid: 102, node: 'node-a', status: 'running', name: 'web2' }],
    configs: { 'lxc/101': { net0: `ip=${ADDR}/24` }, 'lxc/102': { net0: `ip=${ADDR}/24` } },
  })
  const v = await checkHostKey(ADDR, 22, depsFor(w))
  assert.equal(v.state, 'unknown')
  assert.equal(v.reason, 'several-guests')
})

test('an unchanged key needs nothing, and holds no verdict', async () => {
  const w = world({ offered: { fingerprint: OLD, type: 'ssh-ed25519' } })
  const v = await as('operator', () => verifyForPane('lxc-101', ADDR, 22, depsFor(w)))
  assert.equal(v.state, 'unchanged')
  assert.equal(v.verdictId, null)
})

// --- Trust ----------------------------------------------------------------------------------------------------

test('trusting a verified key re-pins exactly that fingerprint for that host:port, and audits it', async () => {
  const w = world()
  const d = depsFor(w)
  const v = await as('operator', () => verifyForPane('lxc-101', ADDR, 22, d))
  assert.equal(v.state, 'verified')
  const r = await as('operator', () => trustVerdict('lxc-101', { host: ADDR, port: 22 }, { verdictId: v.verdictId! }, d))
  assert.equal(r.fingerprint, NEW)
  assert.deepEqual(w.repinned, [{ host: ADDR, port: 22, fp: NEW, source: 'verified', evidence: { kind: 'guest-keys', guest: 'web (LXC 101)', node: 'node-a', via: 'pct' } }])
  assert.equal(w.audits.length, 1)
  assert.equal(w.audits[0].action, 'host_key.repin')
  assert.equal(w.audits[0].resource, `host:${ADDR}:22`)
  assert.equal(w.audits[0].details.verdict, 'verified')
  assert.equal(w.audits[0].details.fingerprint, NEW)
  assert.equal(w.audits[0].details.previous, OLD)
  assert.equal(w.audits[0].details.override, false)
  // Single use.
  await assert.rejects(as('operator', () => trustVerdict('lxc-101', { host: ADDR, port: 22 }, { verdictId: v.verdictId! }, d)), (e: any) => e instanceof HostKeyCheckRefusal && e.status === 409)
})

test('a verdict is bound to its session, its pane and its host:port; a key that changed again is refused', async () => {
  const w = world()
  const d = depsFor(w)
  const v = await as('operator', () => verifyForPane('lxc-101', ADDR, 22, d))
  const refused = (e: any) => e instanceof HostKeyCheckRefusal && e.status === 409
  await assert.rejects(as('operator', () => trustVerdict('lxc-101', { host: ADDR, port: 22 }, { verdictId: v.verdictId! }, d), 'sid-someone-else'), refused)
  await assert.rejects(as('operator', () => trustVerdict('lxc-102', { host: ADDR, port: 22 }, { verdictId: v.verdictId! }, d)), refused)
  await assert.rejects(as('operator', () => trustVerdict('lxc-101', { host: ADDR, port: 2222 }, { verdictId: v.verdictId! }, d)), refused)
  w.offered = { fingerprint: OTHER, type: 'ssh-ed25519' }
  await assert.rejects(as('operator', () => trustVerdict('lxc-101', { host: ADDR, port: 22 }, { verdictId: v.verdictId! }, d)), refused)
  assert.equal(w.repinned.length, 0)
  assert.equal(w.audits.length, 0)
})

test('mismatch: no one-tap trust; an admin can trust it only by typing the phrase, and it is audited as an override', async () => {
  const w = world({ offered: { fingerprint: OTHER, type: 'ssh-ed25519' } })
  const d = depsFor(w)
  const op = await as('operator', () => verifyForPane('lxc-101', ADDR, 22, d))
  assert.equal(op.state, 'mismatch')
  await assert.rejects(as('operator', () => trustVerdict('lxc-101', { host: ADDR, port: 22 }, { verdictId: op.verdictId!, phrase: OVERRIDE_PHRASE }, d)), (e: any) => e.status === 403)
  const v = await as('admin', () => verifyForPane('lxc-101', ADDR, 22, d))
  await assert.rejects(as('admin', () => trustVerdict('lxc-101', { host: ADDR, port: 22 }, { verdictId: v.verdictId!, confirmed: true }, d)), (e: any) => e.status === 400)
  assert.equal(w.repinned.length, 0)
  await as('admin', () => trustVerdict('lxc-101', { host: ADDR, port: 22 }, { verdictId: v.verdictId!, phrase: 'Trust Anyway' }, d))
  assert.deepEqual(w.repinned.map(r => [r.fp, r.source, r.evidence]), [[OTHER, 'terminal', null]])
  assert.equal(w.audits[0].details.verdict, 'mismatch')
  assert.equal(w.audits[0].details.override, true)
})

test('unknown: admin only, behind a typed phrase, audited', async () => {
  const w = world({ resources: [] })
  const d = depsFor(w)
  const v = await as('admin', () => verifyForPane('lxc-101', ADDR, 22, d))
  assert.equal(v.state, 'unknown')
  const o = await as('operator', () => verifyForPane('lxc-101', ADDR, 22, d))
  await assert.rejects(as('operator', () => trustVerdict('lxc-101', { host: ADDR, port: 22 }, { verdictId: o.verdictId!, confirmed: true }, d)), (e: any) => e.status === 403)
  await assert.rejects(as('admin', () => trustVerdict('lxc-101', { host: ADDR, port: 22 }, { verdictId: v.verdictId! }, d)), (e: any) => e.status === 400)
  // A confirm alone is not enough: the phrase is typed, as for a mismatch.
  await assert.rejects(as('admin', () => trustVerdict('lxc-101', { host: ADDR, port: 22 }, { verdictId: v.verdictId!, confirmed: true }, d)), (e: any) => e.status === 400)
  await as('admin', () => trustVerdict('lxc-101', { host: ADDR, port: 22 }, { verdictId: v.verdictId!, phrase: OVERRIDE_PHRASE }, d))
  assert.equal(w.repinned[0].fp, NEW)
  assert.equal(w.audits[0].details.verdict, 'unknown')
  assert.equal(w.audits[0].details.reason, 'no-guest')
})

test('a re-pin that cannot be audited does not happen', async () => {
  const w = world()
  const d = depsFor(w)
  const v = await as('operator', () => verifyForPane('lxc-101', ADDR, 22, d))
  w.auditFails = true
  await assert.rejects(as('operator', () => trustVerdict('lxc-101', { host: ADDR, port: 22 }, { verdictId: v.verdictId! }, d)), /database is down/)
  assert.equal(w.repinned.length, 0)
})

test('API token contexts are refused, and the check is rate-limited per session', async () => {
  const d = depsFor(world())
  await assert.rejects(requestContext.run({ sid: 'token:abc', email: 'tok', role: 'admin' }, () => verifyForPane('lxc-101', ADDR, 22, d)), (e: any) => e instanceof HostKeyCheckRefusal && e.status === 403)
  for (let i = 0; i < 10; i++) await as('operator', () => verifyForPane('lxc-101', ADDR, 22, d), 'sid-busy')
  await assert.rejects(as('operator', () => verifyForPane('lxc-101', ADDR, 22, d), 'sid-busy'), (e: any) => e.status === 429 && e.retryAfter > 0)
  // Another session is not held up.
  assert.equal((await as('operator', () => verifyForPane('lxc-101', ADDR, 22, d), 'sid-calm')).state, 'verified')
})

// --- Through the gate and the real pin store --------------------------------------------------------------------

const broker = new FakeBroker()
broker.addUser('owner@example.com', 'owner master password', 'owner')
broker.addUser('op@example.com', 'operator master password', 'operator')
let app: FastifyInstance
const auditRows: Array<{ action: string; resource: string; details?: Record<string, unknown> }> = []
const routeWorld = world()
const targets: TargetDeps = {
  clusterResources: async () => routeWorld.resources,
  guestConfig: async (_n, vmid, type) => routeWorld.configs[`${type}/${vmid}`] ?? {},
  manualHosts: async () => [], hostAddresses: async () => ({}), pluginConsole: async () => null,
}

before(async () => {
  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  setTerminalTargetDeps(targets)
  setAuditSink({ async write(r) { auditRows.push(r) } })
  // Proxmox, the nodes and the probe are fakes; the pin store and the audit are the real ones.
  const { pin: _p, repin: _r, audit: _a, ...fakes } = depsFor(routeWorld)
  setHostKeyCheckDeps(fakes)
  setApiTokenStore(new MemoryApiTokenStore())
  app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(terminalRoutes, { prefix: '/api/terminal' })
  await app.ready()
})
after(async () => { setTerminalTargetDeps(null); setHostKeyCheckDeps(null); setAuditSink(null); setApiTokenStore(null); if (isUnlocked()) await lock('manual'); await app.close() })

test('routes: an operator checks and trusts a verified key; the vault then holds only that fingerprint', async () => {
  const owner = await signIn(app, 'owner@example.com', 'owner master password')
  const ownerSid = [...broker.sessions.values()].find(s => s.email === 'owner@example.com')!.sid
  await requestContext.run({ sid: ownerSid, email: 'owner@example.com', role: 'owner' }, async () => {
    await setCredential('deck', 'hostkey', `${ADDR}:22`, OLD, false)
    await setCredential('deck', 'hostkey-source', `${ADDR}:22`, 'terminal-auto', false)
  })
  assert.ok(owner.cookie)
  const op = await signIn(app, 'op@example.com', 'operator master password')
  const v = await app.inject({ method: 'POST', url: '/api/terminal/hosts/lxc-101/hostkey/verify', headers: { cookie: op.cookie } })
  assert.equal(v.statusCode, 200, v.body)
  const verdict = v.json().data
  assert.equal(verdict.state, 'verified')
  assert.equal(verdict.offered.fingerprint, NEW)
  assert.equal(verdict.guest.name, 'web')

  // Whatever the browser sends besides the verdict id is ignored: the fingerprint is the verdict's.
  const t = await app.inject({ method: 'POST', url: '/api/terminal/hosts/lxc-101/hostkey/trust', headers: { cookie: op.cookie },
    payload: { verdictId: verdict.verdictId, fingerprint: OTHER, host: '192.0.2.66' } })
  assert.equal(t.statusCode, 200, t.body)
  await requestContext.run({ sid: ownerSid, email: 'owner@example.com', role: 'owner' }, async () => {
    assert.equal(await getCredential('deck', 'hostkey', `${ADDR}:22`), NEW)
    assert.equal(await getCredential('deck', 'hostkey-source', `${ADDR}:22`), 'verified')
    assert.deepEqual(JSON.parse((await getCredential('deck', 'hostkey-evidence', `${ADDR}:22`))!), { kind: 'guest-keys', guest: 'web (LXC 101)', node: 'node-a', via: 'pct' })
    assert.equal(await getCredential('deck', 'hostkey', '192.0.2.66:22'), null)
  })
  const row = auditRows.find(r => r.action === 'host_key.repin')
  assert.ok(row, 'an audit row was written')
  assert.equal(row!.resource, `host:${ADDR}:22`)
  assert.equal(row!.details?.verdict, 'verified')
  assert.equal(row!.details?.by, 'op@example.com')
  assert.equal(row!.details?.fingerprint, NEW)
})

test('routes: API tokens are refused on the check and the trust', async () => {
  const { token } = await createApiToken({ name: 'admin-token', role: 'admin' }, 'test')
  for (const url of ['/api/terminal/hosts/lxc-101/hostkey/verify', '/api/terminal/hosts/lxc-101/hostkey/trust']) {
    const r = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: { verdictId: 'x' } })
    assert.equal(r.statusCode, 403, `${url}: ${r.body}`)
    assert.equal(r.json().code, 'token_forbidden')
  }
})

test('routes: a node login id is refused', async () => {
  const op = await signIn(app, 'op@example.com', 'operator master password')
  const r = await app.inject({ method: 'POST', url: '/api/terminal/hosts/node-a/hostkey/verify', headers: { cookie: op.cookie } })
  assert.equal(r.statusCode, 403, r.body)
})
