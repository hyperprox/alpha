// MikroTik router manager: the change engine (plan, backup, dead-man undo on the router, lockout guard, verify,
// rollback, history, undo), the plans for fixed addresses, port forwards and device blocks, and the routes behind the
// real gate (admin only, confirmed in the page, bound to the plan, audited first, API tokens refused).
// Every router here is made up; nothing reaches a real device.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { buildMikrotikRoutes } from '../src/routes/mikrotik'
import { setBroker } from '../src/lib/vault/broker'
import { lock, isUnlocked } from '../src/lib/vault/state'
import { setCredentialTable } from '../src/lib/credentials'
import { setAuditSink } from '../src/lib/audit'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken, tokenForbidden } from '../src/lib/api-tokens'
import { requiredRole } from '../src/lib/roles'
import {
  ChangeRefusal, KEEP_BACKUPS, MemoryChangeStore, applyPlan, checkLockout, deadManScheduler, deadManScript, historyView, opCommand, planBlock, planForward,
  planHash, planLease, planSummary, quote, readInputs, readSnapshot, undoChange, type ChangePlan, type EngineDeps, type Management, type Op,
} from '../src/lib/mikrotik-change'
import { FakeBroker } from './fakes/fake-broker'
import { signIn } from './fakes/app'
import { injectConfirmed } from './fakes/confirm'
import { makeRouter, type FakeOpts } from './fakes/fake-mikrotik'

const MGMT: Management = { host: '10.0.0.1', service: 'www', port: null, username: 'hp', wan: ['ether1'] }
const inputsOf = (r = makeRouter()) => readInputs(r, ['ether1'])

function engine(r = makeRouter(), over: Partial<EngineDeps> = {}) {
  const audit: string[] = []
  let k = 0
  const d: EngineDeps = {
    router: r, management: MGMT, store: new MemoryChangeStore(), routerKey: 'r-test', by: 'admin@example.com',
    audit: async a => { audit.push(a) }, newId: () => `a1b2c3d${k++}`, ...over,
  }
  return { d, audit }
}
const refusal = async (fn: () => unknown, code: string) => {
  try { await fn() } catch (e: any) { assert.ok(e instanceof ChangeRefusal, String(e?.stack)); assert.equal(e.code, code, e.message); return e as ChangeRefusal }
  assert.fail(`expected refusal ${code}`)
}

// ── the router's own undo: script text ───────────────────────────────────────

test('quote: the characters RouterOS would act on, and anything not plain ASCII, become hex escapes', () => {
  assert.equal(quote('plain text-1'), '"plain text-1"')
  assert.equal(quote('a "b" $c [d] ?e \\f'), '"a \\22b\\22 \\24c \\5Bd\\5D \\3Fe \\5Cf"')
  assert.equal(quote('café'), '"caf\\C3\\A9"')
  assert.equal(quote('a\nb'), '"a\\0Ab"')
})

test('opCommand: add, set, remove and command, with booleans in RouterOS words and a bad property name refused', () => {
  assert.equal(opCommand({ kind: 'remove', path: '/ip/firewall/nat', where: { chain: 'dstnat', comment: 'x $y' } }), '/ip/firewall/nat/remove [find where chain="dstnat" comment="x \\24y"]')
  assert.equal(opCommand({ kind: 'add', path: '/ip/dhcp-server/lease', props: { address: '10.0.0.5', 'mac-address': 'AA:BB:CC:00:11:22' } }), '/ip/dhcp-server/lease/add address="10.0.0.5" mac-address="AA:BB:CC:00:11:22"')
  assert.equal(opCommand({ kind: 'set', path: '/ip/firewall/nat', where: { comment: 'c' }, props: { disabled: 'true' } }), '/ip/firewall/nat/set [find where comment="c"] disabled="yes"')
  assert.equal(opCommand({ kind: 'command', path: '/ip/dhcp-server/lease/make-static', where: { address: '10.0.0.5' } }), '/ip/dhcp-server/lease/make-static [find where address="10.0.0.5"]')
  assert.throws(() => opCommand({ kind: 'remove', path: '/ip/firewall/nat', where: { 'x"; /system reset-configuration; "': '1' } }), /property name/)
  assert.throws(() => opCommand({ kind: 'remove', path: '/ip/firewall/nat; /system/reset-configuration', where: {} }), /menu path/)
})

test('the dead-man script: a log line, every inverse wrapped so one failure stops nothing, then it removes its scheduler and itself', () => {
  const inv: Op[] = [
    { kind: 'remove', path: '/ip/firewall/filter', where: { chain: 'forward', comment: 'HyperProx block: "x" [hpx-abc123]' } },
    { kind: 'add', path: '/ip/firewall/nat', props: { chain: 'dstnat', comment: 'back $1' } },
  ]
  const s = deadManScript('a1b2c3d4', inv)
  assert.equal(s, [
    '# HyperProx auto-undo a1b2c3d4',
    ':log warning "HyperProx: change a1b2c3d4 was not confirmed in time, putting it back"',
    ':do { /ip/firewall/filter/remove [find where chain="forward" comment="HyperProx block: \\22x\\22 \\5Bhpx-abc123\\5D"] } on-error={ :log error "HyperProx: one undo command for change a1b2c3d4 failed" }',
    ':do { /ip/firewall/nat/add chain="dstnat" comment="back \\241" } on-error={ :log error "HyperProx: one undo command for change a1b2c3d4 failed" }',
    ':do { /system/scheduler/remove [find where name="hyperprox-undo-a1b2c3d4"] } on-error={}',
    ':do { /system/script/remove [find where name="hyperprox-undo-a1b2c3d4"] } on-error={}',
    '',
  ].join('\n'))
  assert.throws(() => deadManScript('not hex!', inv), /change id/)
  const sch = deadManScheduler('a1b2c3d4', { date: '2026-11-21', time: '12:00:00' })
  assert.deepEqual(sch, { name: 'hyperprox-undo-a1b2c3d4', comment: 'HyperProx auto-undo a1b2c3d4', 'on-event': '/system/script/run hyperprox-undo-a1b2c3d4', interval: '00:01:30', policy: 'read,write,test', 'start-date': '2026-11-21', 'start-time': '12:00:00' })
  assert.throws(() => deadManScheduler('a1b2c3d4', {}), /time/)
})

// ── fixed addresses ──────────────────────────────────────────────────────────

test('make permanent: a dynamic lease becomes static through the router command, and the inverse removes only the static row', async () => {
  const p = planLease(await inputsOf(), { action: 'make-static', mac: '00:00:5e:00:53:31' })
  assert.equal(p.title, 'Make 10.0.0.31 permanent for laptop')
  assert.deepEqual(p.steps[0].forward, { kind: 'command', path: '/ip/dhcp-server/lease/make-static', where: { address: '10.0.0.31', 'mac-address': '00:00:5E:00:53:31', dynamic: 'true' } })
  assert.deepEqual(p.steps[0].inverse, [{ kind: 'remove', path: '/ip/dhcp-server/lease', where: { address: '10.0.0.31', 'mac-address': '00:00:5E:00:53:31', dynamic: 'false' } }])
  assert.match(p.steps[0].words, /always give this device that address/)
  assert.equal(p.checkWan, false)
})

test('make permanent: a device with no lease (only seen by ARP) gets a new static lease on the right server', async () => {
  const p = planLease(await inputsOf(), { action: 'make-static', mac: '00:00:5E:00:53:50', comment: 'printer' })
  assert.deepEqual(p.steps[0].forward, { kind: 'add', path: '/ip/dhcp-server/lease', props: { address: '10.0.0.50', 'mac-address': '00:00:5E:00:53:50', server: 'dhcp1', comment: 'printer' } })
})

test('fixed addresses: duplicates, other networks, the router itself, a second fixed address for one device are refused', async () => {
  const i = await inputsOf()
  await refusal(() => planLease(i, { action: 'add', mac: '00:00:5E:00:53:50', address: '10.0.0.20' }), 'duplicate_address')
  await refusal(() => planLease(i, { action: 'add', mac: '00:00:5E:00:53:50', address: '10.0.0.40' }), 'duplicate_address') // in use by the TV
  await refusal(() => planLease(i, { action: 'add', mac: '00:00:5E:00:53:50', address: '192.0.2.9' }), 'outside_network')
  await refusal(() => planLease(i, { action: 'add', mac: '00:00:5E:00:53:50', address: '10.0.0.1' }), 'duplicate_address')
  await refusal(() => planLease(i, { action: 'add', mac: '00:00:5E:00:53:50', address: '10.0.0.255' }), 'outside_network')
  await refusal(() => planLease(i, { action: 'make-static', mac: '00:00:5E:00:53:20' }), 'already_fixed')
  await refusal(() => planLease(i, { action: 'add', mac: 'nonsense', address: '10.0.0.9' }), 'bad_request')
  await refusal(() => planLease(i, { action: 'add', mac: '00:00:5E:00:53:50', address: '10.0.0.999' }), 'bad_request')
})

test('fixed addresses: edit moves the address and the note with an exact inverse; remove keeps the row for its inverse; only static rows', async () => {
  const i = await inputsOf()
  const e = planLease(i, { action: 'edit', id: '*l2', address: '10.0.0.21', comment: 'storage' })
  assert.deepEqual(e.steps[0].forward, { kind: 'set', path: '/ip/dhcp-server/lease', where: { address: '10.0.0.20', 'mac-address': '00:00:5E:00:53:20', dynamic: 'false' }, props: { address: '10.0.0.21', comment: 'storage' } })
  assert.deepEqual(e.steps[0].inverse, [{ kind: 'set', path: '/ip/dhcp-server/lease', where: { address: '10.0.0.21', 'mac-address': '00:00:5E:00:53:20', dynamic: 'false' }, props: { address: '10.0.0.20', comment: 'nas' } }])
  const rm = planLease(i, { action: 'remove', id: '*l2' })
  assert.equal(rm.steps[0].inverse[0].kind, 'add')
  assert.deepEqual((rm.steps[0].inverse[0] as any).props, { address: '10.0.0.20', 'mac-address': '00:00:5E:00:53:20', server: 'dhcp1', comment: 'nas' })
  await refusal(() => planLease(i, { action: 'remove', id: '*l1' }), 'not_fixed')
  await refusal(() => planLease(i, { action: 'edit', id: '*l2', address: '10.0.0.40' }), 'duplicate_address')
  await refusal(() => planLease(i, { action: 'edit', id: '*nope' }), 'not_found')
})

// ── port forwards ────────────────────────────────────────────────────────────

test('port forwards: add reads in plain English, uses the WAN interface list, and its inverse is exact', async () => {
  const p = planForward(await inputsOf(), { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: '8123', name: 'cam' })
  const op = p.steps[0].forward as Extract<Op, { kind: 'add' }>
  assert.match(op.props.comment, /^HyperProx forward: cam \[hpx-[0-9a-f]{6}\]$/)
  assert.deepEqual({ ...op.props, comment: undefined }, { chain: 'dstnat', action: 'dst-nat', protocol: 'tcp', 'dst-port': '8123', 'to-addresses': '10.0.0.50', 'to-ports': '8123', 'in-interface-list': 'WAN', comment: undefined })
  assert.deepEqual(p.steps[0].inverse, [{ kind: 'remove', path: '/ip/firewall/nat', where: { chain: 'dstnat', comment: op.props.comment } }])
  assert.match(p.steps[0].words, /^Add the forward: Outside port 8123 → 10\.0\.0\.50 port 8123, TCP\.$/)
  assert.equal(p.needsTick, null)
  assert.ok(p.warnings.some(w => /hairpin/.test(w)), 'no hairpin rule: said, not added')
  assert.equal(planHash(p), planHash(planForward(await inputsOf(), { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: '8123', name: 'cam' })), 'the same request is the same plan')
})

test('port forwards: a device by name shows as "name (address)"; no WAN list and one link uses that link; several links must be chosen', async () => {
  const i = await inputsOf()
  assert.match(planForward(i, { action: 'add', address: '10.0.0.20', proto: 'udp', extPort: '51820', toPort: '51821' }).steps[0].words, /Outside port 51820 → nas \(10\.0\.0\.20\) port 51821, UDP/)
  const noList = { ...i, listMembers: [] }
  assert.equal((planForward(noList, { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: '81' }).steps[0].forward as any).props['in-interface'], 'ether1')
  await refusal(() => planForward({ ...noList, wan: ['ether1', 'ether2'] }, { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: '81' }), 'wan_needed')
  assert.equal((planForward({ ...noList, wan: ['ether1', 'ether2'] }, { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: '81', wan: 'ether2' }).steps[0].forward as any).props['in-interface'], 'ether2')
})

test('port forwards: a risky port needs the extra tick, in the plan and in its hash; a range that contains one counts', async () => {
  const i = await inputsOf()
  for (const port of ['3389', '22', '23', '445', '139', '5900', '3306', '5432', '8006', '8007', '2375', '2376']) {
    const p = planForward(i, { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: port })
    assert.ok(p.needsTick, port); assert.match(p.needsTick!, new RegExp(`Port ${port} `))
  }
  const range = planForward(i, { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: '3380-3390' })
  assert.match(range.needsTick!, /3389 \(Remote Desktop\)/)
  const toRisky = planForward(i, { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: '2222', toPort: '22' })
  assert.match(toRisky.needsTick!, /22 \(SSH/)
  assert.notEqual(planHash(range), planHash(planForward(i, { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: '3390-3400' })))
  assert.equal(planForward(i, { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: '8080' }).needsTick, null)
})

test('port forwards: conflicts with an existing forward are refused; edit ignores itself; bad ports, the router and other networks are refused', async () => {
  const i = await inputsOf()
  const c = await refusal(() => planForward(i, { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: '443' }), 'port_conflict')
  assert.match(c.message, /Outside port 443 \(TCP\) already goes to nas \(10\.0\.0\.20\)/)
  await refusal(() => planForward(i, { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: '440-450' }), 'port_conflict')
  assert.doesNotThrow(() => planForward(i, { action: 'add', address: '10.0.0.50', proto: 'udp', extPort: '443' }), 'another protocol is fine')
  assert.doesNotThrow(() => planForward(i, { action: 'edit', id: '*f1', address: '10.0.0.50' }))
  await refusal(() => planForward(i, { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: '70000' }), 'bad_request')
  await refusal(() => planForward(i, { action: 'add', address: '10.0.0.50', proto: 'icmp', extPort: '80' }), 'bad_request')
  await refusal(() => planForward(i, { action: 'add', address: '10.0.0.1', proto: 'tcp', extPort: '80' }), 'is_router')
  await refusal(() => planForward(i, { action: 'add', address: '192.0.2.50', proto: 'tcp', extPort: '80' }), 'not_on_lan')
})

test('port forwards: toggle and remove have exact inverses; enabling a risky one needs the tick; the hairpin note goes away with a hairpin rule', async () => {
  const i = await inputsOf()
  const off = planForward(i, { action: 'toggle', id: '*f1', disabled: true })
  const key = { chain: 'dstnat', action: 'dst-nat', protocol: 'tcp', 'dst-port': '443', 'to-addresses': '10.0.0.20', 'to-ports': '443', 'in-interface-list': 'WAN', comment: 'existing web' }
  assert.deepEqual(off.steps[0].forward, { kind: 'set', path: '/ip/firewall/nat', where: key, props: { disabled: 'true' } })
  assert.deepEqual(off.steps[0].inverse, [{ kind: 'set', path: '/ip/firewall/nat', where: key, props: { disabled: 'false' } }])
  await refusal(() => planForward(i, { action: 'toggle', id: '*f1', disabled: false }), 'nothing_to_do')
  const rm = planForward(i, { action: 'remove', id: '*f1' })
  assert.deepEqual((rm.steps[0].inverse[0] as any).props, { ...key, disabled: 'false' })
  const risky = { ...i, nat: [{ ...i.nat[0], 'dst-port': '3389', 'to-ports': '3389', disabled: 'true' }, i.nat[1]] }
  assert.ok(planForward(risky, { action: 'toggle', id: '*f1', disabled: false }).needsTick)
  const hairpin = { ...i, nat: [...i.nat, { '.id': '*h', chain: 'srcnat', action: 'masquerade', 'src-address': '10.0.0.0/24', 'dst-address': '10.0.0.0/24' }] }
  assert.ok(!planForward(hairpin, { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: '8123' }).warnings.some(w => /hairpin/.test(w)))
})

// ── device blocks ────────────────────────────────────────────────────────────

test('block: a forward drop by MAC to the internet only, at the top, with the schedule in the rule\'s time field', async () => {
  const i = await inputsOf()
  const p = planBlock(i, { action: 'block', address: '10.0.0.31', schedule: { from: '22:00', to: '06:00', days: ['mon', 'tue', 'sat'] } })
  const op = p.steps[0].forward as Extract<Op, { kind: 'add' }>
  assert.equal(op.top, true)
  assert.deepEqual({ ...op.props, comment: undefined }, { chain: 'forward', action: 'drop', 'src-mac-address': '00:00:5E:00:53:31', 'out-interface-list': 'WAN', time: '22:00:00-06:00:00,mon,tue,sat', comment: undefined })
  assert.match(op.props.comment, /^HyperProx block: laptop \[hpx-[0-9a-f]{6}\]$/)
  assert.deepEqual(p.steps[0].inverse, [{ kind: 'remove', path: '/ip/firewall/filter', where: { chain: 'forward', comment: op.props.comment } }])
  assert.match(p.steps[0].words, /from 22:00 to 06:00 on mon,tue,sat/)
  assert.equal(p.checkWan, true)
  const open = planBlock(i, { action: 'block', mac: '00:00:5E:00:53:40' })
  assert.equal((open.steps[0].forward as any).props.time, undefined)
  await refusal(() => planBlock(i, { action: 'block', mac: '00:00:5E:00:53:40', schedule: { from: '25:00', to: '06:00' } }), 'bad_request')
  await refusal(() => planBlock(i, { action: 'block', mac: '00:00:5E:00:53:40', schedule: { from: '22:00', to: '22:00' } }), 'bad_request')
})

test('block: unblock and schedule edit use the rule by its comment; a second block, the router itself and a stranger are refused', async () => {
  const r = makeRouter()
  const i0 = await inputsOf(r)
  const first = planBlock(i0, { action: 'block', mac: '00:00:5E:00:53:31' })
  const row = { '.id': '*b1', ...(first.steps[0].forward as any).props }
  r.tables['/ip/firewall/filter'].unshift(row)
  const i = await inputsOf(r)
  const un = planBlock(i, { action: 'unblock', id: '*b1' })
  assert.deepEqual(un.steps[0].forward, { kind: 'remove', path: '/ip/firewall/filter', where: { chain: 'forward', comment: row.comment } })
  assert.equal((un.steps[0].inverse[0] as any).top, true)
  const sch = planBlock(i, { action: 'schedule', id: '*b1', schedule: { from: '08:00', to: '17:00' } })
  assert.equal((sch.steps[0].forward as any).props.time, '08:00:00-17:00:00,mon,tue,wed,thu,fri,sat,sun')
  assert.deepEqual((sch.steps[0].inverse[0] as any).props, { time: '' })
  await refusal(() => planBlock(i, { action: 'block', mac: '00:00:5E:00:53:31' }), 'already_blocked')
  await refusal(() => planBlock(i, { action: 'block', address: '10.0.0.1' }), 'is_router')
  await refusal(() => planBlock(i, { action: 'block', address: '192.0.2.4' }), 'not_on_lan')
  await refusal(() => planBlock(i, { action: 'unblock', id: '*i1' }), 'not_found') // somebody else's rule is not ours to remove
})

// ── the lockout guard ────────────────────────────────────────────────────────

const stepOf = (forward: Op): { steps: [{ words: string; forward: Op; inverse: Op[] }] } => ({ steps: [{ words: 'x', forward, inverse: [] }] })
const lock409 = async (forward: Op, m: Management = MGMT) => {
  const snap = await readSnapshot(makeRouter())
  try { checkLockout(stepOf(forward), m, snap) } catch (e: any) { assert.ok(e instanceof ChangeRefusal); assert.equal(e.code, 'lockout_guard'); return e.message as string }
  assert.fail('expected a lockout refusal')
}
const lockOk = async (forward: Op, m: Management = MGMT) => checkLockout(stepOf(forward), m, await readSnapshot(makeRouter()))

test('lockout: the management services, the address, the link, the route, the user HyperProx uses cannot be removed or disabled', async () => {
  for (const name of ['www', 'ssh', 'api', 'winbox']) {
    assert.match(await lock409({ kind: 'set', path: '/ip/service', where: { name }, props: { disabled: 'true' } }), new RegExp(`"${name}" service`))
  }
  assert.match(await lock409({ kind: 'set', path: '/ip/service', where: { name: 'www' }, props: { port: '8080' } }), /service/)
  assert.match(await lock409({ kind: 'remove', path: '/ip/address', where: { address: '10.0.0.1/24' } }), /10\.0\.0\.1\/24/)
  assert.match(await lock409({ kind: 'set', path: '/ip/address', where: { address: '10.0.0.1/24' }, props: { disabled: 'true' } }), /reaches the router/)
  assert.match(await lock409({ kind: 'set', path: '/interface', where: { name: 'bridge-lan' }, props: { disabled: 'true' } }), /bridge-lan/)
  assert.match(await lock409({ kind: 'set', path: '/user', where: { name: 'hp' }, props: { disabled: 'true' } }), /login HyperProx uses/)
  assert.match(await lock409({ kind: 'remove', path: '/user', where: { name: 'hp' } }), /login HyperProx uses/)
  // reached over the internet link: its address, its link and the default route are off limits too
  const viaWan: Management = { ...MGMT, host: '203.0.113.5' }
  assert.match(await lock409({ kind: 'set', path: '/interface', where: { name: 'ether1' }, props: { disabled: 'true' } }, viaWan), /ether1/)
  assert.match(await lock409({ kind: 'remove', path: '/ip/route', where: { 'dst-address': '0.0.0.0/0' } }, viaWan), /default route/)
  await lockOk({ kind: 'set', path: '/interface', where: { name: 'ether1' }, props: { disabled: 'true' } }) // not the way in
  await lockOk({ kind: 'set', path: '/user', where: { name: 'someone-else' }, props: { disabled: 'true' } })
})

test('lockout: a firewall rule that drops the LAN\'s input to the management services is refused; WAN-only drops and other ports are not', async () => {
  const add = (props: Record<string, string>): Op => ({ kind: 'add', path: '/ip/firewall/filter', props })
  assert.match(await lock409(add({ chain: 'input', action: 'drop' })), /management services/)
  assert.match(await lock409(add({ chain: 'input', action: 'drop', protocol: 'tcp', 'dst-port': '80,443' })), /management services/)
  assert.match(await lock409(add({ chain: 'input', action: 'reject', 'in-interface': 'bridge-lan', 'dst-port': '8291' })), /management services/)
  assert.match(await lock409(add({ chain: 'input', action: 'drop', 'src-address': '10.0.0.0/24', 'dst-port': '22' })), /management services/)
  await lockOk(add({ chain: 'input', action: 'drop', 'in-interface': 'ether1' }))
  await lockOk(add({ chain: 'input', action: 'drop', 'in-interface-list': 'WAN', 'dst-port': '80' }))
  await lockOk(add({ chain: 'input', action: 'drop', protocol: 'udp', 'dst-port': '80' }))
  await lockOk(add({ chain: 'input', action: 'drop', 'dst-port': '9999' }))
  assert.match(await lock409({ kind: 'set', path: '/ip/firewall/filter', where: { chain: 'input', action: 'accept' }, props: { disabled: 'true' } }), /management services/)
  await lockOk({ kind: 'remove', path: '/ip/firewall/filter', where: { chain: 'forward', action: 'accept' } })
})

test('lockout: a block never names the router or HyperProx; a forward never takes the port HyperProx reaches the router on over the internet', async () => {
  assert.match(await lock409({ kind: 'add', path: '/ip/firewall/filter', props: { chain: 'forward', action: 'drop', 'src-address': '10.0.0.1' } }), /router itself/)
  assert.match(await lock409({ kind: 'add', path: '/ip/firewall/filter', props: { chain: 'forward', action: 'drop', 'src-address': '10.0.0.9' } }, { ...MGMT, selfAddress: '10.0.0.9' }), /HyperProx/)
  const viaWan: Management = { ...MGMT, host: '203.0.113.5' }
  assert.match(await lock409({ kind: 'add', path: '/ip/firewall/nat', props: { chain: 'dstnat', action: 'dst-nat', 'dst-port': '80', 'in-interface-list': 'WAN' } }, viaWan), /Port 80/)
  await lockOk({ kind: 'add', path: '/ip/firewall/nat', props: { chain: 'dstnat', action: 'dst-nat', 'dst-port': '80', 'in-interface-list': 'WAN' } }) // reached over the LAN: fine
})

// ── the engine ───────────────────────────────────────────────────────────────

const blockPlan = async (r = makeRouter()) => planBlock(await inputsOf(r), { action: 'block', mac: '00:00:5E:00:53:31' })

test('apply: audit, backup, then the safety switch is on the router BEFORE the first change, and it is gone after; history records the exact inverse', async () => {
  const r = makeRouter(); const { d, audit } = engine(r)
  const plan = await blockPlan(r)
  const out = await applyPlan(d, plan)
  assert.equal(out.id, 'a1b2c3d0')
  assert.deepEqual(audit, ['mikrotik.change.start', 'mikrotik.change.done'])
  const order = r.writes.map(w => w.split(' ')[1])
  assert.deepEqual(order.slice(0, 5), ['/export', '/file', '/system/script', '/system/scheduler', '/ip/firewall/filter'], 'export, then the switch, then the change')
  const change = r.log.find(l => l.w === 'PUT /ip/firewall/filter')!
  assert.equal(change.scheduler, true, 'the scheduler entry already existed when the rule was added')
  assert.equal(r.tables['/system/scheduler'].length, 0); assert.equal(r.tables['/system/script'].length, 0)
  assert.equal(r.tables['/file'].length, 0, 'a complete copy is kept in HyperProx; the router\'s own file is removed')
  assert.equal(r.tables['/ip/firewall/filter'][0].chain, 'forward', 'the block is first')
  assert.match(r.tables['/ip/firewall/filter'][0].comment, /^HyperProx block: laptop/)
  const [h] = await d.store.list('r-test')
  assert.equal(h.status, 'applied'); assert.equal(h.by, 'admin@example.com'); assert.deepEqual(h.ops[0].inverse, plan.steps[0].inverse)
  assert.equal((await d.store.readBackup('r-test', out.id))!.startsWith('# export hyperprox-a1b2c3d0'), true)
})

test('the router script the switch carries is the inverse, run on the router: put in place by the engine, text checked', async () => {
  const r = makeRouter(); const { d } = engine(r)
  const plan = await blockPlan(r)
  let seen = ''
  const put = r.put
  r.put = async (p, body: any) => { if (p === '/rest/system/script') seen = body.source; return put(p, body) }
  await applyPlan(d, plan)
  assert.equal(seen, deadManScript('a1b2c3d0', plan.steps.slice().reverse().flatMap(s => s.inverse)))
  assert.match(seen, /\/ip\/firewall\/filter\/remove \[find where chain="forward" comment="HyperProx block: laptop \\5Bhpx-[0-9a-f]{6}\\5D"\]/)
})

test('the history never carries the export text or the operations; the page sees words, status and whether it can be undone', async () => {
  const r = makeRouter(); const { d } = engine(r)
  await applyPlan(d, await blockPlan(r))
  const view = historyView(await d.store.list('r-test'))
  assert.equal(view.length, 1); assert.equal(view[0].canUndo, true)
  const text = JSON.stringify(view)
  assert.ok(!text.includes('/ip address'), 'no export text'); assert.ok(!('ops' in view[0]))
  assert.deepEqual(Object.keys(view[0].backup!).sort(), ['bytes', 'id', 'truncated'])
})

test('verify failure (the router stops answering after the change): everything is put back and the switch is removed', async () => {
  const r = makeRouter({}, { dropAfterWrites: 6 }); const { d, audit } = engine(r)
  // writes: export, script, scheduler, rule add, (move). The router "goes away" once the rule exists.
  const e = await applyPlan(d, await blockPlan(r)).catch(x => x)
  assert.ok(e instanceof Error); assert.match(e.message, /stopped answering/)
  assert.ok(!r.tables['/ip/firewall/filter'].some(x => String(x.comment).startsWith('HyperProx block')), 'the rule is gone again')
  assert.equal(r.tables['/system/scheduler'].length, 0)
  assert.ok(audit.includes('mikrotik.change.failed'))
  assert.equal((await d.store.list('r-test'))[0].status, 'rolled-back')
})

test('the router cannot be reached to put it back: the safety switch is LEFT on the router so it undoes the change itself', async () => {
  const r = makeRouter({}, { dropAfterWrites: 5, failRollback: true }); const { d } = engine(r)
  const e = await applyPlan(d, await blockPlan(r)).catch(x => x)
  assert.match(e.message, /router will undo it by itself/)
  assert.equal(r.tables['/system/scheduler'].length, 1, 'scheduler still there')
  assert.equal(r.tables['/system/scheduler'][0].comment, 'HyperProx auto-undo a1b2c3d0')
  assert.equal(r.tables['/system/script'].length, 1)
  assert.equal((await d.store.list('r-test'))[0].status, 'failed')
})

test('a step that fails part-way puts back the steps already done', async () => {
  const r = makeRouter(); const { d } = engine(r)
  const i = await inputsOf(r)
  const two: ChangePlan = { ...planBlock(i, { action: 'block', mac: '00:00:5E:00:53:31' }), steps: [] }
  const a = planBlock(i, { action: 'block', mac: '00:00:5E:00:53:31' }).steps[0]
  const b = planLease(i, { action: 'edit', id: '*l2', comment: 'x' }).steps[0]
  b.forward = { ...(b.forward as any), where: { address: '10.9.9.9' } } // matches nothing: the step fails
  two.steps = [a, b]
  const e = await applyPlan(d, two).catch(x => x)
  assert.match(e.message, /no longer has the entry/)
  assert.ok(!r.tables['/ip/firewall/filter'].some(x => String(x.comment).startsWith('HyperProx block')))
  assert.equal(r.tables['/system/scheduler'].length, 0)
})

test('the internet path is tested before and after: when it worked before and not after, the change is put back; when it never worked, it is not blamed', async () => {
  const r = makeRouter(); const { d } = engine(r)
  let calls = 0
  const post = r.post!
  r.post = async (p, b) => { if (p === '/rest/tool/ping') { calls++; return calls === 1 ? [{ received: '3', 'packet-loss': '0' }] : [{ received: '0', 'packet-loss': '100' }] } return post(p, b) }
  const e = await applyPlan(d, await blockPlan(r)).catch(x => x)
  assert.match(e.message, /reach the internet before the change and cannot now/)
  assert.ok(!r.tables['/ip/firewall/filter'].some(x => String(x.comment).startsWith('HyperProx block')))
  const r2 = makeRouter({}, { pingFails: true })
  await applyPlan(engine(r2).d, await blockPlan(r2))
  assert.ok(r2.tables['/ip/firewall/filter'].some(x => String(x.comment).startsWith('HyperProx block')))
})

test('no backup or no safety switch means nothing is changed', async () => {
  const r = makeRouter({}, { noExport: true }); const { d, audit } = engine(r)
  await refusal(async () => applyPlan(d, await blockPlan(r)), 'backup_failed')
  assert.deepEqual(r.writes.filter(w => !w.includes('/export')), [])
  assert.ok(audit.includes('mikrotik.change.refused'))
  const r2 = makeRouter({}, { noScheduler: true })
  await refusal(async () => applyPlan(engine(r2).d, await blockPlan(r2)), 'no_safety_switch')
  assert.ok(!r2.tables['/ip/firewall/filter'].some(x => String(x.comment).startsWith('HyperProx block')))
  assert.equal(r2.tables['/system/script'].length, 0, 'the half-made switch is cleaned up')
})

test('a lockout is refused before anything is written, audit included', async () => {
  const r = makeRouter(); const { d, audit } = engine(r)
  const plan: ChangePlan = { kind: 'x', title: 'x', warnings: [], needsTick: null, checkWan: false, steps: [{ words: 'turn off www', forward: { kind: 'set', path: '/ip/service', where: { name: 'www' }, props: { disabled: 'true' } }, inverse: [] }] }
  await refusal(() => applyPlan(d, plan), 'lockout_guard')
  assert.deepEqual(r.writes, []); assert.deepEqual(audit, [])
})

test('an audit log that cannot be written stops the change before any write', async () => {
  const r = makeRouter(); const { d } = engine(r, { audit: async () => { throw new Error('disk full') } })
  await assert.rejects(async () => applyPlan(d, await blockPlan(r)), /disk full/)
  assert.deepEqual(r.writes, [])
})

test('undo: the recorded inverse runs through the same engine (backup, switch, verify), the original is marked undone, and it cannot be undone twice', async () => {
  const r = makeRouter(); const { d } = engine(r)
  const before = JSON.stringify(r.tables['/ip/firewall/filter'])
  const done = await applyPlan(d, await blockPlan(r))
  const out = await undoChange(d, done.id)
  assert.equal(out.id, 'a1b2c3d1')
  assert.equal(JSON.stringify(r.tables['/ip/firewall/filter']), before)
  const list = await d.store.list('r-test')
  assert.equal(list.find(e => e.id === done.id)!.status, 'undone')
  assert.equal(list.find(e => e.id === out.id)!.undoOf, done.id)
  assert.ok(r.writes.filter(w => w === 'POST /export').length === 2, 'the undo took its own backup')
  const view = historyView(list)
  assert.equal(view[0].canUndo, false); assert.equal(view.find(v => v.id === done.id)!.canUndo, false)
  await refusal(() => undoChange(d, done.id), 'not_undoable')
  await refusal(() => undoChange(d, 'nope'), 'not_found')
})

test('undo of a removal puts the row back as it was; undo of a lease edit puts the old address back', async () => {
  const r = makeRouter(); const { d } = engine(r)
  const i = await inputsOf(r)
  const rm = await applyPlan(d, planForward(i, { action: 'remove', id: '*f1' }))
  assert.ok(!r.tables['/ip/firewall/nat'].some(x => x.comment === 'existing web'))
  await undoChange(d, rm.id)
  const back = r.tables['/ip/firewall/nat'].find(x => x.comment === 'existing web')!
  assert.deepEqual([back['dst-port'], back['to-addresses'], back['in-interface-list']], ['443', '10.0.0.20', 'WAN'])
  const edit = await applyPlan(d, planLease(await inputsOf(r), { action: 'edit', id: '*l2', address: '10.0.0.21', comment: 'storage' }))
  assert.equal(r.tables['/ip/dhcp-server/lease'].find(x => x['.id'] === '*l2')!.address, '10.0.0.21')
  await undoChange(d, edit.id)
  const l2 = r.tables['/ip/dhcp-server/lease'].find(x => x['.id'] === '*l2')!
  assert.deepEqual([l2.address, l2.comment], ['10.0.0.20', 'nas'])
})

test('make permanent through the engine: the lease turns static, and undo removes only that static row', async () => {
  const r = makeRouter(); const { d } = engine(r)
  const done = await applyPlan(d, planLease(await inputsOf(r), { action: 'make-static', mac: '00:00:5E:00:53:31' }))
  assert.equal(r.tables['/ip/dhcp-server/lease'].find(x => x['.id'] === '*l1')!.dynamic, 'false')
  await undoChange(d, done.id)
  assert.ok(!r.tables['/ip/dhcp-server/lease'].some(x => x['.id'] === '*l1' && x.dynamic === 'false'), 'no static row for it any more')
  assert.ok(r.tables['/ip/dhcp-server/lease'].some(x => x['.id'] === '*l2'), 'the other fixed address is untouched')
})

test('only the last 20 router backups are kept per router, and an entry whose backup went says so', async () => {
  const s = new MemoryChangeStore()
  for (let i = 0; i < KEEP_BACKUPS + 3; i++) {
    const id = `b${String(i).padStart(7, '0')}`
    await s.save('r', { id, at: 'x', by: 'a', kind: 'k', title: 't', steps: [], status: 'applied', ops: [], backup: { id, bytes: 1, truncated: false } })
    await s.saveBackup('r', id, `text ${i}`)
  }
  assert.equal(s.backups.get('r')!.size, KEEP_BACKUPS)
  assert.equal(await s.readBackup('r', 'b0000000'), null); assert.equal(await s.readBackup('r', 'b0000022'), 'text 22')
  assert.equal((await s.list('r')).find(e => e.id === 'b0000000')!.backup, undefined)
})

test('planSummary says every step, the warnings, and what the safety switch does', async () => {
  const p = planForward(await inputsOf(), { action: 'add', address: '10.0.0.50', proto: 'tcp', extPort: '3389' })
  const s = planSummary(p)
  assert.match(s, /Forward outside port 3389 to 10\.0\.0\.50\. 1\. Add the forward: Outside port 3389 → 10\.0\.0\.50 port 3389, TCP\./)
  assert.match(s, /Remote Desktop/); assert.match(s, /safety switch/); assert.match(s, /within 90 seconds/)
})

// ── the routes, behind the real gate ─────────────────────────────────────────

const broker = new FakeBroker()
broker.addUser('admin@example.com', 'admin master password', 'admin')
broker.addUser('op@example.com', 'operator master password', 'operator')
broker.addUser('view@example.com', 'viewer master password', 'viewer')
const tokens = new MemoryApiTokenStore()
const audits: Array<{ action: string; details?: Record<string, unknown> }> = []
let app: FastifyInstance
let router = makeRouter()
let store = new MemoryChangeStore()
const BASE = '/api/plugins/mikrotik'
let ids = 0

before(async () => {
  setBroker(broker); setApiTokenStore(tokens)
  setAuditSink({ async write(r) { audits.push(r) } })
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(buildMikrotikRoutes({
    router: async () => router,
    options: async () => ({ username: 'hp', wan: 'ether1', lan: 'bridge-lan' }),
    management: async () => ({ host: '10.0.0.1', service: 'www', port: null }),
    store: { list: k => store.list(k), save: (k, e) => store.save(k, e), saveBackup: (k, i, t) => store.saveBackup(k, i, t), readBackup: (k, i) => store.readBackup(k, i) },
    engine: { newId: () => `c0ffee${String(ids++).padStart(2, '0')}` },
    audit: async (action, details) => { audits.push({ action, details }) },
  }), { prefix: BASE })
  await app.ready()
})
after(async () => { setApiTokenStore(null); setAuditSink(null); if (isUnlocked()) await lock('manual'); await app.close() })

const BLOCK = { action: 'block.block', params: { mac: '00:00:5E:00:53:31' } }
const fresh = (opts?: FakeOpts) => { router = makeRouter({}, opts); store = new MemoryChangeStore(); audits.length = 0 }
async function previewHash(cookie: string, body: any = BLOCK) {
  const r = await app.inject({ method: 'POST', url: `${BASE}/change/plan`, headers: { cookie }, payload: body })
  assert.equal(r.statusCode, 200, r.body)
  return r.json().data
}

test('role matrix: admin for every method, never a token\'s', () => {
  for (const [m, p] of [['GET', `${BASE}/control`], ['POST', `${BASE}/change/plan`], ['POST', `${BASE}/change/apply`], ['POST', `${BASE}/changes/abc123/undo`]] as const) {
    assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
    assert.equal(tokenForbidden(m, p), true, `${m} ${p}`)
  }
})

test('an operator and a viewer cannot read or change the router through the manager', async () => {
  fresh()
  for (const [who, pw] of [['op@example.com', 'operator master password'], ['view@example.com', 'viewer master password']]) {
    const { cookie } = await signIn(app, who, pw)
    for (const [method, url, payload] of [['GET', `${BASE}/control`, undefined], ['POST', `${BASE}/change/plan`, BLOCK], ['POST', `${BASE}/change/apply`, BLOCK], ['POST', `${BASE}/changes/x/undo`, {}]] as const) {
      const r = await app.inject({ method, url, headers: { cookie }, payload } as any)
      assert.equal(r.statusCode, 403, `${who} ${method} ${url}`)
    }
  }
  assert.deepEqual(router.writes, [])
})

test('an API token, even an admin one, is refused by name on every route and nothing is written', async () => {
  fresh()
  const t = (await createApiToken({ name: 'auto', role: 'admin' }, 'test', tokens)).token
  for (const [method, url] of [['GET', `${BASE}/control`], ['POST', `${BASE}/change/plan`], ['POST', `${BASE}/change/apply`], ['POST', `${BASE}/changes/x/undo`]] as const) {
    const r = await app.inject({ method, url, headers: { authorization: `Bearer ${t}` }, payload: method === 'POST' ? BLOCK : undefined } as any)
    assert.equal(r.statusCode, 403, url); assert.equal(r.json().code, 'token_forbidden', url)
  }
  assert.deepEqual(router.writes, [])
})

test('control: devices, fixed addresses, forwards in words, blocks, hairpin note and history; no operations or export text', async () => {
  fresh()
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const r = await app.inject({ method: 'GET', url: `${BASE}/control`, headers: { cookie } })
  assert.equal(r.statusCode, 200, r.body)
  const d = r.json().data
  assert.equal(d.canWrite, true)
  assert.deepEqual(d.leases.map((l: any) => l.address), ['10.0.0.20'])
  assert.equal(d.forwards[0].words, 'Outside port 443 → nas (10.0.0.20) port 443, TCP')
  assert.equal(d.devices.find((x: any) => x.mac === '00:00:5E:00:53:31').fixed, false)
  assert.equal(d.devices.find((x: any) => x.mac === '00:00:5E:00:53:20').fixed, true)
  assert.match(d.hairpin.note, /hairpin/)
  assert.ok(d.risky.some((x: any) => x.port === 3389))
})

test('admin: plan is read-only; apply asks for a confirmation that names the plan, then audits first, applies, and the history can undo it', async () => {
  fresh()
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const plan = await previewHash(cookie)
  assert.match(plan.steps[0], /drops internet traffic from laptop/)
  assert.deepEqual(router.writes, [], 'planning wrote nothing')
  const body = { ...BLOCK, planHash: plan.hash }
  const ask = await app.inject({ method: 'POST', url: `${BASE}/change/apply`, headers: { cookie }, payload: body })
  assert.equal(ask.statusCode, 403); assert.equal(ask.json().code, 'confirm_required')
  assert.match(ask.json().confirm.summary, /Block internet for laptop\. 1\. Add a firewall rule that drops internet traffic from laptop/)
  assert.match(ask.json().confirm.summary, /safety switch/)
  assert.deepEqual(router.writes, [])

  const done = await injectConfirmed(app, { method: 'POST', url: `${BASE}/change/apply`, headers: { cookie }, payload: body })
  assert.equal(done.statusCode, 200, done.body)
  const names = audits.map(a => a.action)
  assert.ok(names.indexOf('action.confirmed') < names.indexOf('mikrotik.change.start'))
  assert.ok(names.indexOf('mikrotik.change.start') < names.indexOf('mikrotik.change.done'))
  assert.equal(audits.find(a => a.action === 'mikrotik.change.start')!.details?.by, 'admin@example.com')
  assert.ok(router.tables['/ip/firewall/filter'].some(x => String(x.comment).startsWith('HyperProx block')))

  const ctl = (await app.inject({ method: 'GET', url: `${BASE}/control`, headers: { cookie } })).json().data
  assert.equal(ctl.blocks.length, 1); assert.equal(ctl.history[0].canUndo, true); assert.ok(!JSON.stringify(ctl).includes('/ip address'))
  const undoAsk = await app.inject({ method: 'POST', url: `${BASE}/changes/${ctl.history[0].id}/undo`, headers: { cookie }, payload: {} })
  assert.equal(undoAsk.json().code, 'confirm_required'); assert.match(undoAsk.json().confirm.summary, /Put back what "Block internet for laptop" changed/)
  const undone = await injectConfirmed(app, { method: 'POST', url: `${BASE}/changes/${ctl.history[0].id}/undo`, headers: { cookie }, payload: {} })
  assert.equal(undone.statusCode, 200, undone.body)
  assert.ok(!router.tables['/ip/firewall/filter'].some(x => String(x.comment).startsWith('HyperProx block')))
})

test('a plan that changed since the page loaded is refused (409 plan_changed) before any confirmation or write', async () => {
  fresh()
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const plan = await previewHash(cookie)
  router.tables['/ip/firewall/filter'].unshift({ '.id': '*x9', chain: 'forward', action: 'drop', 'src-mac-address': '00:00:5E:00:53:31', comment: 'HyperProx block: laptop [hpx-111111]' })
  const r = await injectConfirmed(app, { method: 'POST', url: `${BASE}/change/apply`, headers: { cookie }, payload: { ...BLOCK, planHash: plan.hash } })
  assert.equal(r.statusCode, 409); assert.equal(r.json().code, 'already_blocked')
  fresh()
  const p2 = await previewHash(cookie)
  router.tables['/ip/dhcp-server/lease'].push({ '.id': '*l9', address: '10.0.0.99', 'mac-address': '00:00:5E:00:53:99', dynamic: 'true' })
  router.tables['/ip/arp'].push({ address: '10.0.0.99', 'mac-address': '00:00:5E:00:53:99', interface: 'bridge-lan' })
  // a different device list does not change this plan; a stale hash does
  const stale = await app.inject({ method: 'POST', url: `${BASE}/change/apply`, headers: { cookie }, payload: { ...BLOCK, planHash: 'deadbeef' } })
  assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'plan_changed')
  assert.ok(p2.hash.length > 10); assert.deepEqual(router.writes, [])
})

test('a risky port needs the tick: 409 without it, and the tick is part of what the confirmation is bound to', async () => {
  fresh()
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const req = { action: 'forward.add', params: { address: '10.0.0.50', proto: 'tcp', extPort: '3389' } }
  const plan = await previewHash(cookie, req)
  assert.match(plan.needsTick, /Remote Desktop/)
  const noTick = await injectConfirmed(app, { method: 'POST', url: `${BASE}/change/apply`, headers: { cookie }, payload: { ...req, planHash: plan.hash } })
  assert.equal(noTick.statusCode, 409); assert.equal(noTick.json().code, 'risk_tick_required'); assert.deepEqual(router.writes, [])
  const body = { ...req, planHash: plan.hash, riskTick: true }
  const ask = await app.inject({ method: 'POST', url: `${BASE}/change/apply`, headers: { cookie }, payload: body })
  assert.equal(ask.statusCode, 403)
  // the confirmation token only works for the exact body it was given for
  const swapped = await app.inject({ method: 'POST', url: `${BASE}/change/apply`, headers: { cookie, 'x-hyperprox-confirm': ask.json().confirm.token }, payload: { ...body, riskTick: 'yes' } })
  assert.notEqual(swapped.statusCode, 200); assert.deepEqual(router.writes, [])
  const ok = await injectConfirmed(app, { method: 'POST', url: `${BASE}/change/apply`, headers: { cookie }, payload: body })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.ok(router.tables['/ip/firewall/nat'].some(x => x['dst-port'] === '3389'))
})

test('a lockout plan is refused through the route; an unknown action and a read-only router login are plain answers', async () => {
  fresh()
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const bad = await app.inject({ method: 'POST', url: `${BASE}/change/plan`, headers: { cookie }, payload: { action: 'constructor', params: {} } })
  assert.equal(bad.statusCode, 400)
  const conflict = await app.inject({ method: 'POST', url: `${BASE}/change/plan`, headers: { cookie }, payload: { action: 'forward.add', params: { address: '10.0.0.50', proto: 'tcp', extPort: '443' } } })
  assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().code, 'port_conflict')
  fresh(); router.tables['/user/group'][0].policy = 'read,api'
  const ro = await app.inject({ method: 'POST', url: `${BASE}/change/plan`, headers: { cookie }, payload: BLOCK })
  assert.equal(ro.statusCode, 409); assert.equal(ro.json().code, 'read_only_login'); assert.match(ro.json().error, /can only read/)
})

test('an audit log that cannot be written stops the change at the confirmation: nothing is written', async () => {
  fresh()
  const { cookie } = await signIn(app, 'admin@example.com', 'admin master password')
  const plan = await previewHash(cookie)
  const body = { ...BLOCK, planHash: plan.hash }
  const ask = await app.inject({ method: 'POST', url: `${BASE}/change/apply`, headers: { cookie }, payload: body })
  setAuditSink({ async write() { throw new Error('disk full') } })
  const res = await app.inject({ method: 'POST', url: `${BASE}/change/apply`, headers: { cookie, 'x-hyperprox-confirm': ask.json().confirm.token }, payload: body })
  assert.equal(res.statusCode, 503); assert.deepEqual(router.writes, [])
  setAuditSink({ async write(r) { audits.push(r) } })
})
