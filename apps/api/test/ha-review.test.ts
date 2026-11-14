// The HA security review's findings, as tests (its harness cases included). Each one failed before its fix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HaPlanner, type PlannerDeps } from '../src/lib/ha/plans'
import { haPowerHook } from '../src/lib/ha/power'
import { readSnapshot } from '../src/lib/ha/read'
import { predictFailover } from '../src/lib/ha/predict'
import { overview, guestView, clusterWords } from '../src/lib/ha/insight'
import { preflightGrid } from '../src/lib/ha/preflight'
import { hardwareOf } from '../src/lib/ha/parse'
import { redactText } from '../src/lib/ha/redact'
import { pinFingerprint } from '../src/lib/ha/hostkey'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { HaRefusal } from '../src/lib/ha/types'
import { threeNodes, lxcGpuConfig, type FakeHaPve } from './ha-fake'

const ADMIN = { email: 'admin@example.com', role: 'admin' }
function planner(f: FakeHaPve, extra: Partial<PlannerDeps> = {}) {
  const audit: any[] = []
  const p = new HaPlanner({ pve: () => f, audit: async (a, r, d) => { audit.push({ a, r, d }) }, maintenanceWaitMs: 0, sleep: async () => {}, ...extra })
  return { p, audit }
}
const refusal = (fn: () => Promise<unknown>) => fn().then(() => { throw new Error('expected a refusal') }, (e: any) => { assert.ok(e instanceof HaRefusal, String(e)); return e as HaRefusal })
const RA = (id: string, resources: string[], affinity = 'negative') => ({ id, type: 'resource-affinity', affinity, resources })

// --- 1. update-rule merges into the stored rule -------------------------------------------------------

test('review 1 (harness case 1): removing a guest from a disabled, commented apart rule keeps it disabled and keeps the comment', async () => {
  const f = threeNodes()
  for (const s of ['ct:901', 'ct:902', 'ct:903']) f.addResource(s)
  f.addRule({ rule: 'apart', type: 'resource-affinity', affinity: 'negative', resources: 'ct:901,ct:902,ct:903', disable: '1', comment: 'dns pair' })
  const { p } = planner(f)
  const plan = await p.preview({ action: 'update-rule', rule: { id: 'apart', resources: ['ct:901', 'ct:902'] } as any }, ADMIN)
  assert.doesNotMatch(plan.calls[0], /delete=/, plan.calls[0])
  assert.match(plan.changes.join('\n'), /Guests: take g903 \(903\) out/)
  assert.equal(plan.changes.some(c => /^Turn the rule on|^Note:/.test(c)), false, plan.changes.join('\n'))
  assert.equal((await p.apply(plan.id, ADMIN)).ok, true)
  assert.equal(f.rules[0].disable, '1')
  assert.equal(f.rules[0].comment, 'dns pair')
})

test('review 1: clearing the comment or turning the rule on is a named field change', async () => {
  const f = threeNodes()
  f.addResource('ct:901'); f.addResource('ct:902')
  f.addRule({ rule: 'apart', type: 'resource-affinity', affinity: 'negative', resources: 'ct:901,ct:902', disable: '1', comment: 'note' })
  const { p } = planner(f)
  const plan = await p.preview({ action: 'update-rule', rule: { id: 'apart', comment: '', disabled: false } as any }, ADMIN)
  assert.match(plan.calls[0], /delete=disable%2Ccomment/)
  assert.match(plan.changes.join('\n'), /Turn the rule on/)
  assert.match(plan.changes.join('\n'), /Note: "note" → removed/)
})

// --- 2./3. strictness ---------------------------------------------------------------------------------

test('review 2 (harness case 2): editing a strict avoid rule keeps it strict; losing strictness needs a confirm and is named', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  f.addRule({ rule: 'avoid', type: 'node-affinity', affinity: 'negative', resources: 'ct:901', nodes: 'node-b', strict: '1' })
  const { p } = planner(f)
  const keep = await p.preview({ action: 'update-rule', rule: { id: 'avoid', nodes: [{ node: 'node-b' }, { node: 'node-c' }], confirmStrict: undefined } as any, confirmStrict: true }, ADMIN)
  assert.match(keep.calls[0], /strict=1/)
  const e = await refusal(() => p.preview({ action: 'update-rule', rule: { id: 'avoid', strict: false } as any }, ADMIN))
  assert.match(e.message, /no longer strict/i)
  const lose = await p.preview({ action: 'update-rule', rule: { id: 'avoid', strict: false } as any, confirmStrict: true }, ADMIN)
  assert.match(lose.changes.join('\n'), /Strict: yes → no/)
})

test('review 3 (harness case 5): a strict avoid rule needs the strict confirm; avoiding all but one node is a strict single-node home in effect', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  const { p } = planner(f)
  const rule = { id: 'avoid', type: 'node-affinity', affinity: 'negative', strict: true, nodes: [{ node: 'node-b' }, { node: 'node-c' }], resources: ['ct:901'] }
  await refusal(() => p.preview({ action: 'create-rule', rule: rule as any }, ADMIN))
  const plan = await p.preview({ action: 'create-rule', rule: rule as any, confirmStrict: true }, ADMIN)
  assert.equal(plan.strict, true)
  assert.match(plan.warnings.join('\n'), /in effect a strict home on node-a only: if node-a is down, g901 \(901\) stays off/)
})

// --- 4. set-home over an existing rule ----------------------------------------------------------------

test('review 4: set-home names what it does to a disabled, avoid or weighted rule; keeps weights when the order is unchanged', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  f.addRule({ rule: 'hh', type: 'node-affinity', resources: 'ct:901', nodes: 'node-a:5,node-b:1', disable: '1' })
  const { p } = planner(f)
  let plan = await p.preview({ action: 'set-home', sid: 'ct:901', home: { mode: 'prefer', tiers: [['node-a'], ['node-b']] } }, ADMIN)
  assert.match(plan.changes.join('\n'), /Turn rule "hh" back on/)
  assert.match(plan.calls[0], /nodes=node-a%3A5%2Cnode-b%3A1/, 'same order: the hand-made weights stay')
  plan = await p.preview({ action: 'set-home', sid: 'ct:901', home: { mode: 'prefer', tiers: [['node-b'], ['node-a']] } }, ADMIN)
  assert.match(plan.changes.join('\n'), /Priorities: node-a:5, node-b:1 → node-b:2, node-a:1/)
  f.rules = []
  f.addRule({ rule: 'av', type: 'node-affinity', affinity: 'negative', resources: 'ct:901', nodes: 'node-c' })
  plan = await p.preview({ action: 'set-home', sid: 'ct:901', home: { mode: 'prefer', tiers: [['node-a']] } }, ADMIN)
  assert.match(plan.changes.join('\n'), /Replace the avoid rule "av" \(never on node-c\) with a home/)
})

test('review 2/4: moving a home from "only" to "prefer" is a loss of strictness and needs the confirm', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  f.addRule({ rule: 'hh', type: 'node-affinity', resources: 'ct:901', nodes: 'node-a', strict: '1' })
  const { p } = planner(f)
  await refusal(() => p.preview({ action: 'set-home', sid: 'ct:901', home: { mode: 'prefer', tiers: [['node-a']] } }, ADMIN))
  const plan = await p.preview({ action: 'set-home', sid: 'ct:901', home: { mode: 'prefer', tiers: [['node-a']] }, confirmStrict: true }, ADMIN)
  assert.match(plan.changes.join('\n'), /Strict: yes → no/)
})

// --- 5. vCPUs -----------------------------------------------------------------------------------------

test('review 5 (harness case 6): containers are never filtered by CPUs; they get a soft "limited to" note', async () => {
  const f = threeNodes()
  for (const n of f.nodes) n.maxcpu = 4
  const ct = f.guests.find(g => g.vmid === 901)!
  ct.maxcpu = 8; ct.config = { ...ct.config, cores: 8 }
  f.addResource('ct:901')
  const snap = await readSnapshot(f)
  const p = predictFailover(snap, 'ct:901')
  assert.equal(p.to, 'node-b')
  assert.match(p.words, /will be limited to 4 CPUs on node-b/)
  const grid = preflightGrid(snap, snap.guests.find(g => g.sid === 'ct:901')!, { 'allowed-nodes': ['node-b', 'node-c'], 'not-allowed-nodes': {}, running: 1 }, ct.config!)
  assert.equal(grid.rows.find(r => r.node === 'node-b')!.allowed, true)
  assert.doesNotMatch(JSON.stringify(grid), /Not enough CPUs/)
  assert.match(grid.rows.find(r => r.node === 'node-b')!.notes.join(' '), /limited to 4 CPUs on node-b/)
})

test('review 5: a container with no cores set is not treated as needing its host\'s CPU count', async () => {
  const f = threeNodes()
  for (const n of f.nodes) n.maxcpu = 4
  f.guests.find(g => g.vmid === 901)!.maxcpu = 24   // PVE reports the host's threads when cores is unset
  f.addResource('ct:901')
  assert.doesNotMatch(predictFailover(await readSnapshot(f), 'ct:901').words, /limited/)
})

test('review 5: a VM is tried by score; too few CPUs means a failed start and the next node, or an error state', async () => {
  const f = threeNodes()
  f.nodes.find(n => n.node === 'node-b')!.maxcpu = 4
  f.nodes.find(n => n.node === 'node-c')!.maxcpu = 16
  f.guests.find(g => g.vmid === 904)!.maxcpu = 12
  f.addResource('vm:904'); f.addResource('ct:903')   // node-c busier, so HA scores node-b first
  let p = predictFailover(await readSnapshot(f), 'vm:904')
  assert.deepEqual(p.tries, ['node-b', 'node-c'])
  assert.equal(p.to, 'node-c')
  assert.match(p.words, /would try node-b first, which has too few CPUs \(12 vCPUs, node-b has 4\), then node-c/)
  f.nodes.find(n => n.node === 'node-c')!.maxcpu = 8
  p = predictFailover(await readSnapshot(f), 'vm:904')
  assert.equal(p.to, null)
  assert.match(p.words, /ends in an error state/)
})

// --- 6. hardware classes ------------------------------------------------------------------------------

test('review 6: hostpci devices are named by PCI class; a NIC is not a GPU', () => {
  const pci = { '0000:01:00.0': '0x030000', '0000:03:00.0': '0x020000', '0000:04:00.0': '0x010700' }
  const hw = hardwareOf('qemu', { hostpci0: '0000:01:00,pcie=1', hostpci1: '0000:03:00', hostpci2: '0000:04:00.0', scsi0: 'shared-rbd:x' }, ['shared-rbd'], pci)
  assert.deepEqual(hw.devices.map(d => [d.kind, d.required]), [['gpu', true], ['nic', true], ['hba', true]])
  assert.match(hw.devices[1].what, /network card/)
  assert.match(hw.devices[2].what, /storage controller/)
  assert.doesNotMatch(hw.devices[1].what, /GPU/)
  const lxc = hardwareOf('lxc', { dev0: '/dev/ttyUSB0', ...lxcGpuConfig }, ['shared-rbd'])
  assert.equal(lxc.devices.find(d => d.key === 'dev0')!.required, true)
  assert.equal(lxc.devices.find(d => d.kind === 'gpu')!.required, false, 'optional mount entries degrade gracefully')
})

test('review 6: a VM with a passed-through device "will not start" elsewhere, and such a node is not a target', async () => {
  const f = threeNodes()
  const vm = f.guests.find(g => g.vmid === 904)!
  vm.config = { hostpci0: '0000:03:00', scsi0: 'shared-rbd:vm-904-disk-0' }
  f.pci = { 'node-a': { '0000:03:00': '0x020000' } }
  f.addResource('vm:904')
  f.addRule({ rule: 'h', type: 'node-affinity', resources: 'vm:904', nodes: 'node-a' })
  const snap = await readSnapshot(f)
  const p = predictFailover(snap, 'vm:904')
  assert.equal(p.to, null)
  assert.match(p.words, /cannot start .* without its network card/)
  const v = guestView(snap, 'vm:904')!
  assert.doesNotMatch(v.notes.join(' '), /will run on/)
  assert.doesNotMatch(JSON.stringify(v), /without its GPU/)
})

// --- 7. keep-apart with no room right now -------------------------------------------------------------

test('review 7 (harness case 9): a keep-apart rule that strands a guest now is refused unless confirmed with its consequence', async () => {
  const f = threeNodes()
  f.nodes.find(n => n.node === 'node-c')!.status = 'offline'
  for (const s of ['ct:901', 'ct:902', 'ct:903']) f.addResource(s)
  const { p } = planner(f)
  const e = await refusal(() => p.preview({ action: 'create-rule', rule: RA('apart', ['ct:901', 'ct:902', 'ct:903']) as any }, ADMIN))
  assert.match(e.message, /nowhere to run right now/)
  assert.equal(f.writes.length, 0)
  const plan = await p.preview({ action: 'create-rule', rule: RA('apart', ['ct:901', 'ct:902', 'ct:903']) as any, confirmNoRoom: true }, ADMIN)
  assert.match(plan.warnings.join('\n'), /one of these guests stays off/)
})

// --- 8./9. input parsing ------------------------------------------------------------------------------

test('review 8 (harness case 7): booleans are parsed strictly; anything else is refused', async () => {
  const f = threeNodes()
  f.addResource('ct:901'); f.addResource('ct:902')
  const { p } = planner(f)
  const off = await p.preview({ action: 'create-rule', rule: { ...RA('ra', ['ct:901', 'ct:902']), disabled: 'false' } as any }, ADMIN)
  assert.doesNotMatch(off.calls[0], /disable=1/)
  const zero = await p.preview({ action: 'create-rule', rule: { id: 'rb', type: 'node-affinity', strict: '0', nodes: ['node-a'], resources: ['ct:901'] } as any }, ADMIN)
  assert.match(zero.calls[0], /strict=0/)
  await refusal(() => p.preview({ action: 'create-rule', rule: { ...RA('rc', ['ct:901', 'ct:902']), disabled: 'yes' } as any }, ADMIN))
})

test('review 9 (harness case 8): a node named twice with different weights is refused; the same weight is folded', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  const { p } = planner(f)
  const e = await refusal(() => p.preview({ action: 'create-rule', rule: { id: 'rd', type: 'node-affinity', nodes: [{ node: 'node-a', priority: 1 }, { node: 'node-a', priority: 2 }], resources: ['ct:901'] } as any }, ADMIN))
  assert.match(e.message, /node-a is listed twice/)
  const ok = await p.preview({ action: 'create-rule', rule: { id: 'rd', type: 'node-affinity', nodes: ['node-a', 'node-a', 'node-b'], resources: ['ct:901'] } as any }, ADMIN)
  assert.match(ok.calls[0], /nodes=node-a%2Cnode-b&/)
})

// --- 10./16. maintenance ------------------------------------------------------------------------------

test('review 10: maintenance mode on the node that runs HyperProx says so in red', async () => {
  const f = threeNodes()
  f.addResource('ct:902')
  const { p } = planner(f, { hasNodeLogin: async () => true, nodeExec: async () => ({ code: 0, output: '' }), hostKeyPinned: async () => true, selfSid: () => 'ct:902' })
  const plan = await p.preview({ action: 'maintenance', node: 'node-b', enable: true }, ADMIN)
  assert.match(plan.critical.join('\n'), /HyperProx will restart on another node and lock; sign in again afterwards/)
})

test('review 16: maintenance mode refuses a node whose SSH host key is not pinned, and says how to pin it', async () => {
  const f = threeNodes()
  const ran: string[] = []
  let pinned = false
  const { p } = planner(f, { hasNodeLogin: async () => true, nodeExec: async (_n, c) => { ran.push(c); return { code: 0, output: '' } }, hostKeyPinned: async () => pinned })
  const e = await refusal(() => p.preview({ action: 'maintenance', node: 'node-a', enable: true }, ADMIN))
  assert.equal(e.status, 409)
  assert.match(e.message, /host key .* not pinned/i)
  assert.equal((e.problems[0] as any).code, 'hostkey-unpinned')
  pinned = true
  const ok = await p.preview({ action: 'maintenance', node: 'node-a', enable: true }, ADMIN)
  // Pinned at preview, then cleared before apply: refused at apply too.
  pinned = false
  const r = await refusal(() => p.apply(ok.id, ADMIN))
  assert.match(r.message, /not pinned/)
  assert.equal(ran.length, 0)
})

// --- 11. apply lock -----------------------------------------------------------------------------------

test('review 11: two applies are serialised', async () => {
  const f = threeNodes()
  let active = 0, peak = 0
  const slow = { fetchStrict: async (path: string, method?: string, body?: string) => {
    if (method && method !== 'GET') { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 20)); active-- }
    return f.fetchStrict(path, method, body)
  } }
  const { p } = planner(f, { pve: () => slow as any })
  const a = await p.preview({ action: 'protect', sid: 'ct:901' }, ADMIN)
  const b = await p.preview({ action: 'protect', sid: 'ct:902' }, ADMIN)
  const [ra, rb] = await Promise.all([p.apply(a.id, ADMIN), p.apply(b.id, ADMIN).catch((e: any) => ({ ok: false, message: e.message }))])
  assert.equal(peak, 1, 'never two writes at once')
  assert.equal(ra.ok, true)
  assert.match(String((rb as any).message), /changed after the preview/, 'the second sees the first one\'s change')
})

// --- 13. HA mode --------------------------------------------------------------------------------------

test('review 13: a disarmed cluster in ignore mode is detected; power then goes straight to Proxmox', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  f.fencing = 'disarmed'; f.resourceMode = 'ignore'
  const snap = await readSnapshot(f)
  assert.match(clusterWords(snap).headline, /disarmed.*ignore/i)
  assert.match(guestView(snap, 'ct:901')!.statusLine, /HA is disarmed/)
  const hook = await haPowerHook({ node: 'node-a', vmid: 901, type: 'lxc', action: 'stop' }, ADMIN, { pve: () => f, audit: async () => {} })
  assert.equal(hook.handled, false)
})

// --- 14. redaction ------------------------------------------------------------------------------------

test('review 14: redaction covers the token id and node login secrets', () => {
  process.env.PROXMOX_TOKEN_ID = 'tokenid-abc123'
  process.env.PROXMOX_USER = 'hyperprox@pve'
  try {
    const out = redactText('auth PVEAPIToken=hyperprox@pve!tokenid-abc123 with pass hunter22secret', undefined, ['hunter22secret'])
    assert.doesNotMatch(out, /tokenid-abc123|hunter22secret/)
  } finally { delete process.env.PROXMOX_TOKEN_ID; delete process.env.PROXMOX_USER }
})

test('review 14: a node login\'s password echoed by the node never reaches the plan result or the audit log', async () => {
  const f = threeNodes()
  const SECRET = 'node-login-pw-9f8e7d'
  const { p, audit } = planner(f, {
    hasNodeLogin: async () => true, hostKeyPinned: async () => true,
    nodeExec: async () => ({ code: 1, output: `sshpass ${SECRET} failed` }), nodeSecrets: async () => [SECRET],
  })
  const plan = await p.preview({ action: 'maintenance', node: 'node-a', enable: true }, ADMIN)
  const r = await p.apply(plan.id, ADMIN)
  assert.equal(r.ok, false)
  assert.doesNotMatch(JSON.stringify(r) + JSON.stringify(audit), new RegExp(SECRET))
})

// --- 15. wording --------------------------------------------------------------------------------------

test('review 15: homeless wording with auto-rebalance, and the headroom count', async () => {
  const f = threeNodes()
  f.crs = 'ha=dynamic,ha-auto-rebalance=1'
  for (const s of ['ct:901', 'ct:902']) f.addResource(s)
  f.addRule({ rule: 'apart', type: 'resource-affinity', affinity: 'negative', resources: 'ct:901,ct:902' })
  const ov = overview(await readSnapshot(f))
  assert.match(ov.homeless[0].words, /may be moved back by auto-rebalance, or stay where it landed/)
  assert.equal(ov.headroom[0].level, 'tight')
  assert.equal(ov.counts.tightHeadroom, 1)
})

test('review 16: pinning stores only the key the node presents now, never over a different pin, and is re-confirmed', async () => {
  const FP = 'SHA256:' + 'A'.repeat(43), OTHER = 'SHA256:' + 'B'.repeat(43)
  const saved: string[] = []
  const deps = { probe: async () => FP, pinned: async () => null, save: async (_h: string, fp: string) => { saved.push(fp) } }
  assert.deepEqual(await pinFingerprint('10.0.0.1', FP, deps), { pinned: FP, already: false })
  await assert.rejects(pinFingerprint('10.0.0.1', OTHER, deps), /not the key you checked/)
  await assert.rejects(pinFingerprint('10.0.0.1', FP, { ...deps, pinned: async () => OTHER }), /already pinned to a different key/)
  await assert.rejects(pinFingerprint('10.0.0.1', 'nonsense', deps), /not an SSH SHA256 fingerprint/)
  assert.deepEqual(saved, [FP])
  assert.equal(requiredRole('POST', '/api/ha/nodes/node-a/hostkey/check'), 'admin')
  assert.equal(needsReconfirm('POST', '/api/ha/nodes/node-a/hostkey/pin'), true)
})

// --- re-check round ---------------------------------------------------------------------------------

test('re-check 1: turning on a strict single-node avoid rule gets the confirm and the red note', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  f.addRule({ rule: 'avoid', type: 'node-affinity', affinity: 'negative', resources: 'ct:901', nodes: 'node-b,node-c', strict: '1', disable: '1' })
  const { p } = planner(f)
  const e = await refusal(() => p.preview({ action: 'enable-rule', ruleId: 'avoid' }, ADMIN))
  assert.equal(e.problems[0]?.code, 'confirm-strict')
  const plan = await p.preview({ action: 'enable-rule', ruleId: 'avoid', confirmStrict: true } as any, ADMIN)
  assert.equal(plan.strict, true)
  assert.match(plan.critical.join('\n'), /in effect a strict home on node-a only/)
})

test('re-check 1: turning on a keep-apart rule with no room is refused unless confirmed', async () => {
  const f = threeNodes()
  f.nodes.find(n => n.node === 'node-c')!.status = 'offline'
  for (const s of ['ct:901', 'ct:902', 'ct:903']) f.addResource(s)
  f.addRule({ rule: 'apart', type: 'resource-affinity', affinity: 'negative', resources: 'ct:901,ct:902,ct:903', disable: '1' })
  const { p } = planner(f)
  const e = await refusal(() => p.preview({ action: 'enable-rule', ruleId: 'apart' }, ADMIN))
  assert.equal(e.problems[0]?.code, 'no-room')
  const plan = await p.preview({ action: 'enable-rule', ruleId: 'apart', confirmNoRoom: true } as any, ADMIN)
  assert.match(plan.warnings.join('\n'), /one of these guests stays off/)
})

test('re-check 1: turning off or deleting a strict rule is "no longer strict" and needs the confirm', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  f.addRule({ rule: 'lock', type: 'node-affinity', resources: 'ct:901', nodes: 'node-a', strict: '1' })
  const { p } = planner(f)
  for (const action of ['disable-rule', 'delete-rule'] as const) {
    const e = await refusal(() => p.preview({ action, ruleId: 'lock' } as any, ADMIN))
    assert.equal(e.problems[0]?.code, 'confirm-strict', action)
    const plan = await p.preview({ action, ruleId: 'lock', confirmStrict: true } as any, ADMIN)
    assert.match(plan.critical.join('\n'), /No longer strict/, action)
    assert.equal(plan.strict, true)
  }
  // A non-strict rule turns off without any confirm.
  f.rules[0].strict = '0'
  await p.preview({ action: 'disable-rule', ruleId: 'lock' }, ADMIN)
})

test('re-check 2: a plain bind mount means "may not start where the path is missing", not a certain failure', async () => {
  const f = threeNodes()
  f.addResource('ct:905')
  const p = predictFailover(await readSnapshot(f), 'ct:905')
  assert.equal(p.to, 'node-a')
  assert.match(p.words, /it may not start on node-a if \/mnt\/media is missing there/)
  assert.doesNotMatch(p.words, /cannot start|error state/)
})

test('re-check 3: PCI classes are keyed by full address; a whole device is classed by function .0', () => {
  const pci = { '0000:01:00.0': '0x030000', '0000:01:00.1': '0x040300', '0000:03:00.0': '0x020000' }
  const hw = hardwareOf('qemu', { hostpci0: '01:00', hostpci1: '0000:01:00.1', hostpci2: '0000:03:00.0' }, [], pci)
  assert.deepEqual(hw.devices.map(d => d.kind), ['gpu', 'pci', 'nic'])
  assert.match(hw.devices[1].what, /0000:01:00\.1/)
})

test('a standard char device (/dev/net/tun, /dev/fuse, /dev/kvm) is on every node: no "cannot start" warning', () => {
  const hw = hardwareOf('lxc', {
    dev0: '/dev/net/tun', dev1: '/dev/fuse,mode=0666', dev2: '/dev/kvm', rootfs: 'shared-rbd:subvol-1',
    'lxc.mount.entry': '/dev/net/tun dev/net/tun none bind,create=file',
    'lxc.cgroup2.devices.allow': 'c 10:200 rwm',
  }, ['shared-rbd'])
  assert.deepEqual(hw.devices, [], JSON.stringify(hw.devices))
  // A real device beside them still counts.
  const real = hardwareOf('lxc', { dev0: '/dev/net/tun', dev1: '/dev/ttyUSB0' }, [])
  assert.deepEqual(real.devices.map(d => d.key), ['dev1'])
})
