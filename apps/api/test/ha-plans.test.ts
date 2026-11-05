// The HA preview/apply contract against the fake PVE: words before writes, refusals before any call,
// concurrency, quorum, single use, outcome checked by re-read, and HA guests' power through HA state.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HaPlanner, type PlannerDeps } from '../src/lib/ha/plans'
import { haPowerHook } from '../src/lib/ha/power'
import { HaRefusal } from '../src/lib/ha/types'
import { threeNodes, FakeHaPve } from './ha-fake'

const ADMIN = { email: 'admin@example.com', role: 'admin' }
function planner(f: FakeHaPve, extra: Partial<PlannerDeps> = {}) {
  const audit: any[] = []
  const p = new HaPlanner({ pve: () => f, audit: async (action, resource, details) => { audit.push({ action, resource, details }) }, maintenanceWaitMs: 0, sleep: async () => {}, ...extra })
  return { p, audit }
}
const refuses = async (fn: () => Promise<unknown>, re: RegExp, status?: number) => {
  await assert.rejects(fn, (e: any) => { assert.ok(e instanceof HaRefusal, String(e)); assert.match(e.message, re); if (status) assert.equal(e.status, status); return true })
}

test('protect: defaults explained, nothing written by the preview, written and verified by the apply', async () => {
  const f = threeNodes()
  const { p, audit } = planner(f)
  const plan = await p.preview({ action: 'protect', sid: 'ct:901' }, ADMIN)
  assert.equal(f.writes.length, 0, 'a preview writes nothing')
  assert.match(plan.changes.join('\n'), /Restart tries on the same node before moving it: 1\./)
  assert.match(plan.changes.join('\n'), /Moves to another node if it still will not start: 1\./)
  assert.match(plan.effects.join('\n'), /Nothing moves now/)
  assert.match(plan.warnings.join('\n'), /no home yet/)
  assert.deepEqual(plan.calls, ['POST /cluster/ha/resources sid=ct%3A901&state=started&max_restart=1&max_relocate=1'])
  const r = await p.apply(plan.id, ADMIN)
  assert.equal(r.ok, true, r.message)
  assert.equal(f.resources[0].sid, 'ct:901')
  assert.equal(audit.at(-1).details.ok, true)
})

test('apply is single use, expires, and belongs to the person who previewed it', async () => {
  const f = threeNodes()
  let now = 1_000_000
  const { p } = planner(f, { now: () => now })
  const a = await p.preview({ action: 'protect', sid: 'ct:901' }, ADMIN)
  await refuses(() => p.apply(a.id, { email: 'other@example.com', role: 'admin' }), /someone else/, 403)
  const b = await p.preview({ action: 'protect', sid: 'ct:901' }, ADMIN)
  await p.apply(b.id, ADMIN)
  await refuses(() => p.apply(b.id, ADMIN), /expired or was already used/, 410)
  f.resources = []
  const c = await p.preview({ action: 'protect', sid: 'ct:901' }, ADMIN)
  now += 11 * 60_000
  await refuses(() => p.apply(c.id, ADMIN), /expired/, 410)
})

test('concurrent change: anything in HA changed since the preview refuses the apply, and sends nothing', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  const { p, audit } = planner(f)
  const plan = await p.preview({ action: 'set-home', sid: 'ct:901', home: { mode: 'prefer', tiers: [['node-a'], ['node-b']] } }, ADMIN)
  f.addResource('ct:902')   // someone else, in the Proxmox UI
  const before = f.writes.length
  await refuses(() => p.apply(plan.id, ADMIN), /changed after the preview/, 409)
  assert.equal(f.writes.length, before)
  assert.equal(audit.at(-1).details.refused, 'changed since preview')
})

test('not quorate: preview and apply both refuse', async () => {
  const f = threeNodes()
  const { p } = planner(f)
  const plan = await p.preview({ action: 'protect', sid: 'ct:901' }, ADMIN)
  f.quorate = false
  await refuses(() => p.apply(plan.id, ADMIN), /not quorate/, 409)
  await refuses(() => p.preview({ action: 'protect', sid: 'ct:902' }, ADMIN), /not quorate/, 409)
  assert.equal(f.writes.length, 0)
})

test('locked: every write says so and does nothing', async () => {
  const f = threeNodes()
  let locked = false
  const { p } = planner(f, { isLocked: () => locked })
  const plan = await p.preview({ action: 'protect', sid: 'ct:901' }, ADMIN)
  locked = true
  await refuses(() => p.apply(plan.id, ADMIN), /HyperProx is locked — sign in/, 423)
  await refuses(() => p.preview({ action: 'protect', sid: 'ct:901' }, ADMIN), /HyperProx is locked/, 423)
  assert.equal(f.writes.length, 0)
})

test('home: a weighted preference becomes one rule with generated weights, and says what moves', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  const { p } = planner(f)
  const plan = await p.preview({ action: 'set-home', sid: 'ct:901', home: { mode: 'prefer', tiers: [['node-b'], ['node-c']] } }, ADMIN)
  assert.match(plan.changes.join('\n'), /Add home rule "ha-home-901": Prefers node-b, then node-c, but runs anywhere if needed\./)
  assert.match(plan.effects.join('\n'), /will migrate to node-b now/)
  assert.match(plan.effects.join('\n'), /a container moves with a restart/)
  assert.match(plan.calls[0], /nodes=node-b%3A2%2Cnode-c%3A1/)
  const r = await p.apply(plan.id, ADMIN)
  assert.equal(r.ok, true, r.message)
  assert.equal(f.rules[0].nodes, 'node-b:2,node-c:1')
  assert.equal(f.rules[0].strict, '0')
})

test('strict home needs its own confirmation and carries a red warning', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  const { p } = planner(f)
  await refuses(() => p.preview({ action: 'set-home', sid: 'ct:901', home: { mode: 'only', tiers: [['node-a']] } }, ADMIN), /Confirm it/, 400)
  const plan = await p.preview({ action: 'set-home', sid: 'ct:901', home: { mode: 'only', tiers: [['node-a']] }, confirmStrict: true }, ADMIN)
  assert.equal(plan.strict, true)
  assert.match(plan.critical.join('\n'), /does not start anywhere/)
  assert.match(plan.effects.join('\n'), /Nothing moves now/)
})

test('weighted home + keep apart: refused before any PVE call, naming the flatten fix; the fix is its own preview', async () => {
  const f = threeNodes()
  f.addResource('ct:901'); f.addResource('ct:902')
  f.addRule({ rule: 'home-901', type: 'node-affinity', resources: 'ct:901', nodes: 'node-a:2,node-b:1' })
  const { p } = planner(f)
  const err: any = await p.preview({ action: 'create-rule', rule: { id: 'apart', type: 'resource-affinity', affinity: 'negative', resources: ['ct:901', 'ct:902'] } as any }, ADMIN).catch(e => e)
  assert.ok(err instanceof HaRefusal)
  assert.equal(err.problems[0].code, 'weighted-with-affinity')
  assert.deepEqual(err.problems[0].fix.kind, 'flatten')
  assert.equal(f.writes.length, 0, 'no 400 from PVE is ever the first explanation')
  const fix = await p.preview({ action: 'flatten', ruleId: 'home-901' }, ADMIN)
  assert.match(fix.changes.join('\n'), /equal choice: node-a and node-b/)
  assert.equal((await p.apply(fix.id, ADMIN)).ok, true)
  assert.equal(f.rules[0].nodes, 'node-a,node-b')
  const ok = await p.preview({ action: 'create-rule', rule: { id: 'apart', type: 'resource-affinity', affinity: 'negative', resources: ['ct:901', 'ct:902'] } as any }, ADMIN)
  assert.equal((await p.apply(ok.id, ADMIN)).ok, true)
})

test('a rule naming a guest that is not HA, or a node that does not exist, is never sent', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  const { p } = planner(f)
  await refuses(() => p.preview({ action: 'create-rule', rule: { id: 'r1', type: 'resource-affinity', affinity: 'positive', resources: ['ct:901', 'ct:902'] } as any }, ADMIN), /not protected by HA yet/)
  await refuses(() => p.preview({ action: 'create-rule', rule: { id: 'r2', type: 'node-affinity', nodes: [{ node: 'node-z' }], resources: ['ct:901'] } as any }, ADMIN), /node-z, which is not in this cluster/)
  assert.equal(f.writes.length, 0)
})

test('anti-affinity headroom warning on a keep-apart rule across every node', async () => {
  const f = threeNodes()
  for (const s of ['ct:901', 'ct:902', 'ct:903']) f.addResource(s)
  const { p } = planner(f)
  const plan = await p.preview({ action: 'create-rule', rule: { id: 'apart', type: 'resource-affinity', affinity: 'negative', resources: ['ct:901', 'ct:902', 'ct:903'] } as any }, ADMIN)
  assert.match(plan.warnings.join('\n'), /zero slack/)
  const check = await p.check({ id: 'apart', type: 'resource-affinity', affinity: 'negative', resources: ['ct:901', 'ct:902', 'ct:903'], disabled: false }, null)
  assert.equal(check.headroom[0].level, 'none')
})

test('unprotect: says the guest stays off after a node failure, and the purged rules go with it', async () => {
  const f = threeNodes()
  f.addResource('ct:901'); f.addResource('ct:902')
  f.addRule({ rule: 'h', type: 'node-affinity', resources: 'ct:901', nodes: 'node-a' })
  f.addRule({ rule: 'tog', type: 'resource-affinity', affinity: 'positive', resources: 'ct:901,ct:902' })
  const { p } = planner(f)
  const plan = await p.preview({ action: 'unprotect', sid: 'ct:901' }, ADMIN)
  assert.match(plan.effects.join('\n'), /if node-a dies, this stays off until you start it/)
  assert.match(plan.changes.join('\n'), /Remove rule "h"/)
  assert.match(plan.changes.join('\n'), /Remove rule "tog" .*with only one guest left it would do nothing/)
  const r = await p.apply(plan.id, ADMIN)
  assert.equal(r.ok, true, r.message)
  assert.equal(f.rules.find(x => x.rule === 'h'), undefined)
  assert.equal(f.rules.length, 0)
})

test('outcome, not self-report: a PVE that answers OK and changes nothing is a failure', async () => {
  const f = threeNodes()
  const { p } = planner(f)
  const plan = await p.preview({ action: 'protect', sid: 'ct:901' }, ADMIN)
  f.ignoreWrites = true
  const r = await p.apply(plan.id, ADMIN)
  assert.equal(r.ok, false)
  assert.match(r.message, /ct:901 is not an HA resource/)
})

test('a home change for a guest in a shared rule splits it out, leaving the others their home', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  f.addRule({ rule: 'shared', type: 'node-affinity', resources: 'ct:901,ct:902', nodes: 'node-a' })
  f.addResource('ct:902')
  const { p } = planner(f)
  const plan = await p.preview({ action: 'set-home', sid: 'ct:901', home: { mode: 'prefer', tiers: [['node-b']] } }, ADMIN)
  assert.equal(plan.calls.length, 2, 'split out of the shared rule, then its own rule')
  const r = await p.apply(plan.id, ADMIN)
  assert.equal(r.ok, true, r.message)
  assert.equal(f.rules.find(x => x.rule === 'shared').resources, 'ct:902')
})

test('maintenance mode: runs the documented command over the node login, previews who moves where', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  const cmds: string[] = []
  const { p } = planner(f, {
    hasNodeLogin: async () => true, hostKeyPinned: async () => true,
    nodeExec: async (node, command) => { cmds.push(`${node}: ${command}`); f.nodes.find(n => n.node === 'node-a')!.maintenance = true; return { code: 0, output: '' } },
  })
  const plan = await p.preview({ action: 'maintenance', node: 'node-a', enable: true }, ADMIN)
  assert.match(plan.changes[0], /HA moves its guests away first/)
  assert.match(plan.effects.join('\n'), /g901 \(901\) will migrate to node-b now/)
  assert.match(plan.warnings.join('\n'), /not HA-managed and stay/)
  const r = await p.apply(plan.id, ADMIN)
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(cmds, ['node-a: ha-manager crm-command node-maintenance enable node-a'])
  const { p: p2 } = planner(f)
  await refuses(() => p2.preview({ action: 'maintenance', node: 'node-b', enable: true }, ADMIN), /no API for maintenance mode/)
})

test('HA guest start/stop goes through HA state; non-HA guests and reboots are left to the direct call', async () => {
  const f = threeNodes()
  f.addResource('ct:901')
  const audit: any[] = []
  const deps = { pve: () => f, audit: async (a: string, r: string, d: any) => { audit.push({ a, r, d }) } }
  const stop = await haPowerHook({ node: 'node-a', vmid: 901, type: 'lxc', action: 'shutdown' }, ADMIN, deps)
  assert.equal(stop.handled, true)
  assert.equal(f.resources[0].state, 'stopped')
  assert.ok(f.writes.every(w => w.path.startsWith('/cluster/ha/resources/')), 'no direct pct/qm call')
  assert.match((stop as any).message, /went through HA/)
  const start = await haPowerHook({ node: 'node-a', vmid: 901, type: 'lxc', action: 'start' }, ADMIN, deps)
  assert.equal(start.handled && start.ok, true)
  assert.equal(f.resources[0].state, 'started')
  assert.equal((await haPowerHook({ node: 'node-a', vmid: 901, type: 'lxc', action: 'reboot' }, ADMIN, deps)).handled, false)
  assert.equal((await haPowerHook({ node: 'node-b', vmid: 902, type: 'lxc', action: 'stop' }, ADMIN, deps)).handled, false)
  f.quorate = false
  const nq = await haPowerHook({ node: 'node-a', vmid: 901, type: 'lxc', action: 'stop' }, ADMIN, deps)
  assert.equal(nq.handled && nq.status, 409)
  assert.equal(f.resources[0].state, 'started')
  const locked = await haPowerHook({ node: 'node-a', vmid: 901, type: 'lxc', action: 'stop' }, ADMIN, { ...deps, isLocked: () => true })
  assert.equal(locked.handled && locked.status, 423)
})
