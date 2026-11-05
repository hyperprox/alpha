// HA rules: simple home choices ↔ PVE node-affinity rules, PVE's feasibility checks mirrored locally,
// and "what does this change break" (problemsOfChange).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flatten, homeOf, homeRule, homeWords, prioritiesOf, problemsOfChange, tiersOf, validateRules, freeRuleId } from '../src/lib/ha/rules'
import { formatNodes, parseNodes, parseRule, ruleParams } from '../src/lib/ha/parse'
import type { HaRule } from '../src/lib/ha/types'

const NODES = ['node-a', 'node-b', 'node-c']
const ctx = (ha: string[]) => ({ haSids: new Set(ha), guests: new Set(['ct:901', 'ct:902', 'ct:903', 'vm:904', 'ct:905', 'ct:906']), nodes: NODES })
const na = (id: string, resources: string[], nodes: string, extra: Partial<HaRule> = {}): HaRule =>
  parseRule({ rule: id, type: 'node-affinity', resources: resources.join(','), nodes, ...extra })!
const raRule = (id: string, resources: string[], affinity: 'positive' | 'negative'): HaRule =>
  parseRule({ rule: id, type: 'resource-affinity', resources: resources.join(','), affinity })!

test('choices → weights: one node is bare, ordered choices get descending priorities, one tier is flat', () => {
  assert.equal(formatNodes(prioritiesOf([['node-a']])), 'node-a')
  assert.equal(formatNodes(prioritiesOf([['node-a'], ['node-b']])), 'node-a:2,node-b:1')
  assert.equal(formatNodes(prioritiesOf([['node-a'], ['node-b', 'node-c']])), 'node-a:2,node-b:1,node-c:1')
  assert.equal(formatNodes(prioritiesOf([['node-a', 'node-b']])), 'node-a,node-b')
})

test('weights → choices: PVE rules read back as tiers, highest first', () => {
  assert.deepEqual(tiersOf(parseNodes('node-a:5,node-b:1,node-c:1')), [['node-a'], ['node-b', 'node-c']])
  assert.deepEqual(tiersOf(parseNodes('node-c')), [['node-c']])
  assert.deepEqual(tiersOf(parseNodes('node-b:1,node-a:1')), [['node-a', 'node-b']])
})

test('round trip: a home choice → rule → form params → parsed rule → the same choice', () => {
  for (const choice of [
    { mode: 'prefer' as const, tiers: [['node-b'], ['node-a']] },
    { mode: 'only' as const, tiers: [['node-c']] },
    { mode: 'prefer' as const, tiers: [['node-a', 'node-c']] },
  ]) {
    const rule = homeRule('ct:901', 'ha-home-901', choice)
    const p = ruleParams(rule)
    const back = parseRule({ ...p, rule: rule.id })!
    const view = homeOf([back], 'ct:901')
    assert.deepEqual(view.choice, choice)
    assert.equal(p.strict, choice.mode === 'only' ? '1' : '0')
  }
})

test('home words lead with the consequence', () => {
  assert.equal(homeWords({ mode: 'prefer', tiers: [['node-a'], ['node-b']] }), 'Prefers node-a, then node-b, but runs anywhere if needed.')
  assert.match(homeWords({ mode: 'only', tiers: [['node-c']] }), /Only ever runs on node-c\. If it is down, it stays off\./)
  assert.match(homeWords({ mode: 'none', tiers: [] }), /No home: after a failover it stays wherever it lands/)
})

test('homeOf: a negative rule is "avoid", a disabled rule is reported as such, a shared rule names its partners', () => {
  assert.deepEqual(homeOf([na('x', ['ct:901'], 'node-a', { affinity: 'negative' } as any)], 'ct:901').avoid, ['node-a'])
  assert.equal(homeOf([na('x', ['ct:901'], 'node-a', { disable: 1 } as any)], 'ct:901').disabled, true)
  assert.deepEqual(homeOf([na('x', ['ct:901', 'ct:902'], 'node-a')], 'ct:901').sharedWith, ['ct:902'])
})

test('conflict: a weighted home and a keep-apart rule on the same guest, with the flatten fix', () => {
  const rules = [na('home-901', ['ct:901'], 'node-a:2,node-b:1'), raRule('apart', ['ct:901', 'ct:902'], 'negative')]
  const p = validateRules(rules, ctx(['ct:901', 'ct:902']))
  const w = p.find(x => x.code === 'weighted-with-affinity')!
  assert.ok(w, 'weighted-with-affinity found')
  assert.deepEqual(w.fix, { kind: 'flatten', rule: 'home-901', words: w.fix!.words })
  // After the fix, PVE would accept it.
  const fixed = [flatten(rules[0] as any), rules[1]]
  assert.equal(validateRules(fixed, ctx(['ct:901', 'ct:902'])).length, 0)
})

test('a disabled rule takes no part in the checks, as in PVE', () => {
  const rules = [na('home-901', ['ct:901'], 'node-a:2,node-b:1'), { ...raRule('apart', ['ct:901', 'ct:902'], 'negative'), disabled: true }]
  assert.equal(validateRules(rules, ctx(['ct:901', 'ct:902'])).length, 0)
})

test('the other PVE checks, each in words', () => {
  const ha = ctx(['ct:901', 'ct:902', 'ct:903', 'vm:904'])
  const codes = (rules: HaRule[], c = ha) => validateRules(rules, c).map(p => p.code)
  assert.ok(codes([na('a', ['ct:901'], 'node-a'), na('b', ['ct:901'], 'node-b')]).includes('two-homes'))
  assert.ok(codes([raRule('t', ['ct:901'], 'positive')]).includes('too-few-guests'))
  assert.ok(codes([raRule('n', ['ct:901', 'ct:902', 'ct:903', 'vm:904'], 'negative')]).includes('more-than-nodes'))
  assert.ok(codes([raRule('t1', ['ct:901', 'ct:902'], 'positive'), raRule('t2', ['ct:902', 'ct:903'], 'positive'), raRule('n', ['ct:901', 'ct:903'], 'negative')]).includes('together-and-apart'),
    'merged positive groups (901-902-903) conflict with keeping 901 and 903 apart')
  assert.ok(codes([raRule('t', ['ct:901', 'ct:902'], 'positive'), na('a', ['ct:901'], 'node-a'), na('b', ['ct:902'], 'node-b')]).includes('together-split-homes'))
  assert.ok(codes([raRule('n', ['ct:901', 'ct:902'], 'negative'), na('a', ['ct:901', 'ct:902'], 'node-a', { strict: 1 } as any)]).includes('apart-too-few-nodes'))
  assert.ok(codes([na('x', ['ct:901'], 'node-a,node-b,node-c', { affinity: 'negative' } as any)]).includes('negative-all-nodes'))
  assert.ok(codes([na('x', ['ct:901'], 'node-a:2', { affinity: 'negative' } as any)]).includes('negative-priorities'))
  assert.ok(codes([na('x', ['ct:906'], 'node-a')]).includes('not-ha'), 'PVE takes only HA guests in rules')
  assert.ok(codes([na('x', ['ct:999'], 'node-a')]).includes('unknown-guest'))
  assert.ok(codes([na('x', ['ct:901'], 'node-z')]).includes('unknown-node'))
  assert.ok(codes([na('9x', ['ct:901'], 'node-a')]).includes('bad-id'))
})

test('problemsOfChange: the change\'s own problems block; a problem it creates on another rule blocks; old ones are only "existing"', () => {
  const c = ctx(['ct:901', 'ct:902', 'ct:903'])
  const before = [na('home-901', ['ct:901'], 'node-a:2,node-b:1'), na('old-a', ['ct:903'], 'node-a'), na('old-b', ['ct:903'], 'node-b')]
  const after = [...before, raRule('apart', ['ct:901', 'ct:902'], 'negative')]
  const r = problemsOfChange(before, after, ['apart'], c)
  assert.ok(r.blocking.some(p => p.code === 'weighted-with-affinity'))
  assert.ok(r.existing.some(p => p.code === 'two-homes'), 'the pre-existing two-homes problem is reported, not blocking')
  assert.ok(!r.blocking.some(p => p.code === 'two-homes'))
})

test('freeRuleId never reuses a name', () => {
  assert.equal(freeRuleId([], 'home-901'), 'ha-home-901')
  assert.equal(freeRuleId([na('ha-home-901', ['ct:901'], 'node-a')], 'home-901'), 'ha-home-901-2')
})
