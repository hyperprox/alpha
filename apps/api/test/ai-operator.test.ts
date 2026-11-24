// The AI operator's tier router (lib/ai/operator): classifier, forced tier, escalation, Opus approval, spend cap and
// month rollover, privacy (redaction, keep-it-local topics), and that no secret reaches an answer, a row or an audit.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {
  askOperator, classify, classifyByRules, parseForce, redactForCloud, unredact, MemoryOperatorStore, OperatorService,
  normalizeSettings, defaultSettings, fingerprintOf, setPlaybookMatcher, noPlaybooks, operatorSource,
  type OperatorDeps, type OperatorSettings, type Tier, type TierCall, type TierCallArgs, type AskInput,
} from '../src/lib/ai/operator'
import { estimateCostUsd, wouldExceedCap, monthStart } from '../src/lib/ai/operator/pricing'
import { makeOperatorRoutes, loosening } from '../src/routes/ai-operator'
import { requiredRole } from '../src/lib/roles'
import { tokenForbidden } from '../src/lib/api-tokens'
import { CREDENTIAL_DEFS } from '../src/lib/credentials'
import { callStructured } from '../src/lib/ai/providers'
import { setAuditSink } from '../src/lib/audit'
import { clearConfirms } from '../src/lib/confirm'
import { injectConfirmed } from './fakes/confirm'

const NOW = new Date('2026-11-24T12:00:00Z')

interface Rig {
  store: MemoryOperatorStore
  calls: TierCallArgs[]
  audits: Array<{ action: string; details: Record<string, unknown> }>
  deps: OperatorDeps
  /** What each tier answers next; the last entry repeats. */
  script: Partial<Record<Tier, Array<{ answer?: string; confidence?: 'low' | 'medium' | 'high' | number; fail?: boolean; classify?: string }>>>
  clock: { now: Date }
  ready: Partial<Record<Tier, boolean>>
}

function rig(settings: Partial<OperatorSettings> = {}): Rig {
  const store = new MemoryOperatorStore()
  store.settings = normalizeSettings({ ...defaultSettings(), localBaseUrl: 'http://10.0.0.5:8080/v1', ...settings })
  const r: Rig = { store, calls: [], audits: [], script: {}, clock: { now: NOW }, ready: {}, deps: null as any }
  const used: Record<string, number> = {}
  const call: TierCall = async a => {
    r.calls.push(a)
    const steps = r.script[a.tier] ?? [{ answer: `${a.tier} answer`, confidence: 'high' }]
    const idx = Math.min(used[a.tier] = (used[a.tier] ?? -1) + 1, steps.length - 1)
    const s = steps[idx]
    if (s.fail) throw new Error('model unreachable')
    if (a.name === 'operator_class') return { value: { class: s.classify ?? 'new_fault' }, usage: { inputTokens: 10, outputTokens: 2 } }
    return { value: { answer: s.answer ?? `${a.tier} answer`, confidence: s.confidence ?? 'high', verified: null }, usage: { inputTokens: 1000, outputTokens: 500 } }
  }
  r.deps = {
    store, call, vaultUnlocked: () => true, now: () => r.clock.now,
    tierReady: async t => ({ ready: r.ready[t] ?? true, missing: 'a key' }),
    audit: async (action, _res, details) => { r.audits.push({ action, details }) },
  }
  return r
}

const ask = (r: Rig, text: string, more: Partial<AskInput> = {}) =>
  askOperator({ text, source: 'test', userRef: 'u1', ...more }, r.deps)

beforeEach(() => { setPlaybookMatcher(null); clearConfirms() })

// ── Classifier ──────────────────────────────────────────────────────────────

test('classifier rules: build, fault, and unclear', () => {
  assert.equal(classifyByRules('Write a script that backs up node1'), 'build')
  assert.equal(classifyByRules('please create a new playbook for updates'), 'build')
  assert.equal(classifyByRules('Why is the backup job failing?'), 'new_fault')
  assert.equal(classifyByRules('the web proxy is down and returns errors'), 'new_fault')
  // A fault word does not beat a request that starts by asking for something to be made.
  assert.equal(classifyByRules('write a script to fix the failing backup'), 'build')
  assert.equal(classifyByRules('I need to build an exporter for ceph'), 'build')
  assert.equal(classifyByRules('tell me about ceph'), null)
})

test('classifier: a playbook match wins and is known; the no-op matcher never matches', async () => {
  const c = await classify('restart the proxy', 'test', { matcher: { match: () => ({ id: 'pb-1', title: 'Restart proxy' }) } })
  assert.deepEqual([c.problemClass, c.by, c.playbook?.id], ['known', 'playbook', 'pb-1'])
  assert.equal(await noPlaybooks.match('anything', { source: 'x' }), null)
  assert.equal((await classify('Why is it down', 'test')).by, 'rules')
})

test('classifier: a broken matcher is no match; the local model decides an unclear one; a slow or failing model falls back', async () => {
  const bad = { match: () => { throw new Error('boom') } }
  assert.equal((await classify('Why is it down', 'x', { matcher: bad })).problemClass, 'new_fault')
  assert.equal((await classify('tell me about ceph', 'x', { askModel: async () => 'build' })).problemClass, 'build')
  const slow = await classify('tell me about ceph', 'x', { askModel: () => new Promise(() => {}), timeoutMs: 20 })
  assert.deepEqual([slow.problemClass, slow.by], ['new_fault', 'default'])
  const thrown = await classify('tell me about ceph', 'x', { askModel: async () => { throw new Error('x') } })
  assert.equal(thrown.by, 'default')
})

test('a registered playbook matcher makes the router start at the known tier', async () => {
  setPlaybookMatcher({ match: t => (/restart/.test(t) ? { id: 'pb', title: 'Restart' } : null) })
  const r = rig()
  const out = await ask(r, 'restart the proxy')
  assert.equal(out.status, 'answered')
  if (out.status === 'answered') assert.deepEqual([out.problemClass, out.classifiedBy, out.tier], ['known', 'playbook', 'local'])
})

// ── Forced tier ─────────────────────────────────────────────────────────────

test('forced tier parsing: prefixes, case, separators, and only at the start', () => {
  assert.deepEqual(parseForce('ask Sonnet: why is ceph slow'), { tier: 'sonnet', text: 'why is ceph slow' })
  assert.deepEqual(parseForce('Ask OPUS - plan the migration'), { tier: 'opus', text: 'plan the migration' })
  assert.deepEqual(parseForce('please use haiku, list the nodes'), { tier: 'haiku', text: 'list the nodes' })
  assert.deepEqual(parseForce('send this to local what is up'), { tier: 'local', text: 'what is up' })
  assert.equal(parseForce('what would sonnet say about this').tier, null)
  assert.equal(parseForce('ask sonnet').tier, null)
  assert.equal(parseForce('ask the team').tier, null)
})

test('force: the asked tier answers, the prefix is stripped, and the answer is labelled with tier, model and chain', async () => {
  const r = rig()
  const out = await ask(r, 'ask Sonnet: why is ceph slow')
  assert.equal(out.status, 'answered')
  if (out.status !== 'answered') return
  assert.equal(out.tier, 'sonnet')
  assert.equal(out.model, 'claude-sonnet-5-5')
  assert.deepEqual(out.chain.map(c => c.tier), ['sonnet'])
  assert.equal(r.calls.at(-1)!.user, 'why is ceph slow')
  const param = await ask(r, 'anything', { force: 'haiku' })
  assert.equal(param.status === 'answered' && param.tier, 'haiku')
})

test('force: a disabled or unconfigured tier is refused, not skipped', async () => {
  const r = rig({ tiers: { haiku: { enabled: false, model: 'm' } } as any })
  const out = await ask(r, 'x', { force: 'haiku' })
  assert.equal(out.status, 'refused')
  assert.equal(r.calls.length, 0)
  const r2 = rig(); r2.ready.sonnet = false
  assert.equal((await ask(r2, 'x', { force: 'sonnet' })).status, 'refused')
})

// ── Starting tier by class ──────────────────────────────────────────────────

test('class mapping: faults start local, a build starts on Sonnet', async () => {
  const r = rig()
  const fault = await ask(r, 'Why is the backup failing')
  assert.equal(fault.status === 'answered' && fault.tier, 'local')
  const build = await ask(r, 'Write a script to rotate logs')
  assert.equal(build.status === 'answered' && build.tier, 'sonnet')
})

test('a class start that is turned off climbs to the next enabled tier, and says so', async () => {
  const r = rig({ tiers: { sonnet: { enabled: false, model: 'm' } } as any })
  const out = await ask(r, 'Write a script to rotate logs')
  // Sonnet is off: the next enabled tier above it is Opus, which asks first.
  assert.equal(out.status, 'needs_approval')
})

// ── Escalation ──────────────────────────────────────────────────────────────

test('low confidence escalates to the next enabled tier; the whole chain is recorded', async () => {
  const r = rig()
  r.script.local = [{ confidence: 'low', answer: 'maybe?' }]
  r.script.haiku = [{ confidence: 0.3 }]          // a number below 0.4 is low too
  r.script.sonnet = [{ confidence: 0.9, answer: 'it is the disk' }]
  const out = await ask(r, 'Why is the backup failing')
  assert.equal(out.status, 'answered')
  if (out.status !== 'answered') return
  assert.deepEqual(out.chain.map(c => `${c.tier}:${c.confidence}`), ['local:low', 'haiku:low', 'sonnet:high'])
  assert.equal(out.tier, 'sonnet')
  assert.equal(out.answer, 'it is the disk')
})

test('escalation never calls a disabled tier', async () => {
  const r = rig({ tiers: { haiku: { enabled: false, model: 'm' } } as any })
  r.script.local = [{ confidence: 'low' }]
  const out = await ask(r, 'Why is the backup failing')
  assert.equal(out.status === 'answered' && out.tier, 'sonnet')
  assert.ok(!r.calls.some(c => c.tier === 'haiku'))
})

test('a tier that errors escalates; the error is in the chain in plain words', async () => {
  const r = rig()
  r.script.local = [{ fail: true }]
  const out = await ask(r, 'Why is the backup failing')
  assert.equal(out.status, 'answered')
  if (out.status === 'answered') {
    assert.deepEqual(out.chain.map(c => c.outcome), ['error', 'answered'])
    assert.equal(out.tier, 'haiku')
  }
})

test('escalation never runs Opus without approval; the lower answer comes with the request', async () => {
  const r = rig()
  for (const t of ['local', 'haiku', 'sonnet'] as Tier[]) r.script[t] = [{ confidence: 'low', answer: `${t} guess` }]
  const out = await ask(r, 'Why is the backup failing')
  assert.equal(out.status, 'needs_approval')
  if (out.status !== 'needs_approval') return
  assert.ok(!r.calls.some(c => c.tier === 'opus'))
  assert.equal(out.partial?.tier, 'sonnet')
  assert.match(out.reason, /most capable and most expensive/)
  assert.ok(out.approvalToken.length > 20)
})

test('with Opus approval switched off, escalation reaches Opus by itself', async () => {
  const r = rig({ opusNeedsApproval: false })
  for (const t of ['local', 'haiku', 'sonnet'] as Tier[]) r.script[t] = [{ confidence: 'low' }]
  const out = await ask(r, 'Why is the backup failing')
  assert.equal(out.status === 'answered' && out.tier, 'opus')
})

test('a fix attempt that did not verify starts one tier higher than the last tier', async () => {
  const r = rig()
  const out = await ask(r, 'The proxy is still down', { attempt: { verified: false, tier: 'local' } })
  assert.equal(out.status === 'answered' && out.tier, 'haiku')
  assert.match((out as any).notes.join(' '), /did not work/)
  const r2 = rig()
  const out2 = await ask(r2, 'The proxy is still down', { attempt: { verified: true } })
  assert.equal(out2.status === 'answered' && out2.tier, 'local')
})

test('the same problem again within the window starts one tier higher; outside the window it does not', async () => {
  const r = rig()
  const first = await ask(r, 'Why is node1 backup failing with 12 errors')
  assert.equal(first.status === 'answered' && first.tier, 'local')
  r.clock.now = new Date(NOW.getTime() + 10 * 60_000)
  const again = await ask(r, 'why is node2 backup failing with 9 errors')   // same words, other numbers: same problem
  assert.equal(again.status === 'answered' && again.tier, 'haiku')
  r.clock.now = new Date(NOW.getTime() + 24 * 3600_000)
  const later = await ask(r, 'Why is node1 backup failing with 12 errors')
  assert.equal(later.status === 'answered' && later.tier, 'local')
  assert.equal(fingerprintOf('Backup failed on 10.0.0.1'), fingerprintOf('backup FAILED on 10.0.0.9'))
  assert.equal(r.store.prints.every(p => /^[0-9a-f]{16}$/.test(p.fingerprint)), true)   // a hash, never the text
})

test('the chain is capped', async () => {
  const r = rig({ maxChain: 2, opusNeedsApproval: false })
  for (const t of ['local', 'haiku', 'sonnet', 'opus'] as Tier[]) r.script[t] = [{ confidence: 'low' }]
  const out = await ask(r, 'Why is the backup failing')
  assert.equal(out.status === 'answered' && out.chain.length, 2)
})

// ── Opus approval ───────────────────────────────────────────────────────────

test('Opus approval: first call asks, the token runs it once, and only for that user and that question', async () => {
  const r = rig()
  const first = await ask(r, 'ask opus: plan the failover', {})
  assert.equal(first.status, 'needs_approval')
  if (first.status !== 'needs_approval') return
  assert.equal(r.calls.length, 0)
  assert.match(first.promptPreview, /plan the failover/)

  const wrongUser = await ask(r, 'plan the failover', { approval: first.approvalToken, userRef: 'someone-else' })
  assert.equal(wrongUser.status === 'refused' && wrongUser.code, 'approval_invalid')
  // A wrong try uses the token up.
  assert.equal((await ask(r, 'plan the failover', { approval: first.approvalToken })).status, 'refused')

  const second = await ask(r, 'ask opus: plan the failover')
  assert.equal(second.status, 'needs_approval')
  if (second.status !== 'needs_approval') return
  const other = await ask(r, 'plan something else', { approval: second.approvalToken })
  assert.equal(other.status, 'refused')

  const third = await ask(r, 'plan the failover', { force: 'opus' })
  if (third.status !== 'needs_approval') throw new Error('expected approval')
  const done = await ask(r, 'plan the failover', { approval: third.approvalToken })
  assert.equal(done.status, 'answered')
  assert.equal(done.status === 'answered' && done.tier, 'opus')
  assert.equal((await ask(r, 'plan the failover', { approval: third.approvalToken })).status, 'refused')   // single use
})

test('Opus approval token expires after five minutes', async () => {
  const r = rig()
  const first = await ask(r, 'plan it', { force: 'opus' })
  if (first.status !== 'needs_approval') throw new Error('expected approval')
  r.clock.now = new Date(NOW.getTime() + 6 * 60_000)
  const late = await ask(r, 'plan it', { approval: first.approvalToken })
  assert.equal(late.status === 'refused' && late.code, 'approval_invalid')
})

// ── Spend ───────────────────────────────────────────────────────────────────

test('every call is recorded with tier, model, tokens and an estimated cost; local costs nothing', async () => {
  const r = rig()
  await ask(r, 'Why is the backup failing')                 // local
  await ask(r, 'x', { force: 'sonnet' })
  const rows = r.store.usage
  assert.equal(rows.find(x => x.tier === 'local')!.costUsd, 0)
  const s = rows.find(x => x.tier === 'sonnet')!
  assert.deepEqual([s.model, s.inputTokens, s.outputTokens], ['claude-sonnet-5-5', 1000, 500])
  assert.equal(s.costUsd, estimateCostUsd('sonnet', defaultSettings(), 1000, 500))
  assert.ok(Math.abs(s.costUsd - 0.0105) < 1e-9)
})

test('a price override replaces the built-in estimate, but local stays free', () => {
  const s = normalizeSettings({ priceOverrides: { sonnet: { inPerMTok: 10, outPerMTok: 20 }, local: { inPerMTok: 9, outPerMTok: 9 } } })
  assert.equal(estimateCostUsd('sonnet', s, 1_000_000, 1_000_000), 30)
  assert.equal(estimateCostUsd('local', s, 1_000_000, 1_000_000), 0)
})

test('monthly cap: once reached, cloud tiers refuse and the router falls back to local only', async () => {
  const r = rig({ monthlyCapUsd: 0.01 })
  r.store.usage.push({ tier: 'sonnet', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0.02, at: new Date('2026-11-02T00:00:00Z'), source: 't' })
  const out = await ask(r, 'Write a script to rotate logs')    // a build would start on Sonnet
  assert.equal(out.status, 'answered')
  if (out.status !== 'answered') return
  assert.equal(out.tier, 'local')
  assert.match(out.notes.join(' '), /monthly cap/)
  assert.ok(r.calls.every(c => c.tier === 'local'))
  const forced = await ask(r, 'x', { force: 'haiku' })
  assert.equal(forced.status === 'refused' && forced.code, 'cap')
})

test('monthly cap: a call that would go over is skipped before it is sent', async () => {
  const r = rig({ monthlyCapUsd: 0.001 })
  const out = await ask(r, 'Write a script to rotate logs')
  assert.equal(out.status, 'answered')
  if (out.status === 'answered') {
    assert.equal(out.tier, 'local')
    assert.equal(out.chain[0].outcome, 'skipped')
    assert.match(out.chain[0].note!, /cap/)
  }
  assert.ok(!r.calls.some(c => c.tier === 'sonnet'))
})

test('spend rolls over at the start of a month, and the running total is exposed', async () => {
  const r = rig({ monthlyCapUsd: 0.05 })
  r.store.usage.push({ tier: 'opus', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 4, at: new Date('2026-10-31T23:59:00Z'), source: 't' })
  const out = await ask(r, 'x', { force: 'haiku' })                 // October's spend does not count in November
  assert.equal(out.status, 'answered')
  if (out.status === 'answered') {
    assert.equal(out.spend.month, '2026-11')
    assert.ok(out.spend.monthUsd > 0 && out.spend.monthUsd < 0.05)
  }
  r.clock.now = new Date('2026-12-01T00:00:01Z')
  const svc = new OperatorService({ store: r.store, call: r.deps.call, vaultUnlocked: () => true, localKeyStored: async () => false, anthropicKeyStored: async () => true, saveLocalKey: async () => {}, clearLocalKey: async () => {}, now: () => r.clock.now })
  const sp = await svc.spend()
  assert.equal(sp.month, '2026-12')
  assert.equal(sp.monthUsd, 0)
  assert.equal(monthStart(new Date('2026-11-24T12:00:00Z')).toISOString(), '2026-11-01T00:00:00.000Z')
  assert.equal(wouldExceedCap(1, 0.5, 0), false)
  assert.equal(wouldExceedCap(1, 0.5, 1.2), true)
})

// ── Privacy ─────────────────────────────────────────────────────────────────

test('redaction: addresses and host names get stable placeholders and come back', () => {
  const text = 'node1.example.org cannot reach 10.0.0.5 and 10.0.0.6; ssh to db-primary fails, retry 10.0.0.5 via https://proxy.example.net:8443/x. See config.yml and fd00::1.'
  const red = redactForCloud(text)
  assert.ok(!/10\.0\.0\./.test(red.text) && !/example\.(org|net)/.test(red.text) && !/db-primary/.test(red.text) && !/fd00/.test(red.text), red.text)
  assert.equal((red.text.match(/addr-1/g) ?? []).length, 2)        // 10.0.0.5 twice, one placeholder
  assert.match(red.text, /config\.yml/)                              // a file name is not a host
  assert.equal(unredact(red.text, red.map), text)
  assert.equal(unredact('ask host-99 about addr-1', red.map), 'ask host-99 about 10.0.0.5')
})

test('redaction: caller-supplied host names are hidden too, longest first', () => {
  const red = redactForCloud('node10 and node1 are up', ['node1', 'node10'])
  assert.ok(!/node1/.test(red.text))
  assert.equal(unredact(red.text, red.map), 'node10 and node1 are up')
})

test('redaction before cloud: the cloud send receives redacted text, the reply is un-redacted, local sees the original', async () => {
  const r = rig()
  r.script.sonnet = [{ answer: 'Check host-1 (addr-1) first.', confidence: 'high' }]
  const q = 'Write a script to check node7.example.org at 10.0.0.7'
  const out = await ask(r, q)
  const sent = r.calls.find(c => c.tier === 'sonnet')!
  assert.ok(!sent.user.includes('10.0.0.7') && !sent.user.includes('node7.example.org'), sent.user)
  assert.match(sent.user, /host-1/)
  assert.equal(out.status === 'answered' && out.answer, 'Check node7.example.org (10.0.0.7) first.')
  assert.equal(out.status === 'answered' && out.redacted, true)

  const local = rig()
  await ask(local, 'Why is 10.0.0.7 down')
  assert.ok(local.calls.find(c => c.tier === 'local' && c.name === 'operator_answer')!.user.includes('10.0.0.7'))   // nothing leaves, nothing hidden
})

test('redaction can be switched off, and then the cloud receives the text as typed', async () => {
  const r = rig({ redactBeforeCloud: false })
  await ask(r, 'x 10.0.0.7', { force: 'haiku' })
  assert.ok(r.calls.find(c => c.tier === 'haiku')!.user.includes('10.0.0.7'))
})

test('keep-it-local topics: cloud tiers are never used, a forced cloud tier is ignored, and it says so', async () => {
  const r = rig({ localOnlyTopics: ['payroll', 'Customer Data'] })
  const out = await ask(r, 'Write a script to export customer data nightly')   // a build: would start on Sonnet
  assert.equal(out.status, 'answered')
  if (out.status !== 'answered') return
  assert.equal(out.tier, 'local')
  assert.equal(out.localOnly, true)
  assert.match(out.notes.join(' '), /keep-it-local/)
  const forced = await ask(r, 'ask opus: payroll run failed')
  assert.equal(forced.status === 'answered' && forced.tier, 'local')
  assert.match((forced as any).notes.join(' '), /kept local/)
  assert.ok(r.calls.every(c => c.tier === 'local'))
  // Low confidence on a local-only topic does not leak upward either.
  r.script.local = [{ confidence: 'low' }]
  const low = await ask(r, 'payroll is failing')
  assert.equal(low.status === 'answered' && low.tier, 'local')
  assert.ok(r.calls.every(c => c.tier === 'local'))
})

test('keep-it-local with the local tier not set up: refused, nothing sent', async () => {
  const r = rig({ localOnlyTopics: ['payroll'] }); r.ready.local = false
  const out = await ask(r, 'payroll is failing')
  assert.equal(out.status, 'refused')
  assert.equal(r.calls.length, 0)
})

// ── Vault ───────────────────────────────────────────────────────────────────

test('locked vault: nothing is called, the reason is plain', async () => {
  const r = rig()
  r.deps.vaultUnlocked = () => false
  const out = await ask(r, 'Why is it down')
  assert.equal(out.status === 'refused' && out.code, 'vault_locked')
  assert.match((out as any).message, /locked/)
  assert.equal(r.calls.length, 0)
})

// ── Transport: the endpoint override ────────────────────────────────────────

test('callStructured with an endpoint override: OpenAI shape, the given address, key and model, no stored provider', async () => {
  const seen: any[] = []
  const send = async (provider: string, body: any, ctx: any) => {
    seen.push({ provider, model: body.model, ctx })
    ctx.onUsage?.({ inputTokens: 7, outputTokens: 3 })
    return '{"answer":"ok","confidence":"high","verified":null}'
  }
  let usage: any = null
  const v: any = await callStructured({ name: 'n', system: 's', user: 'u', schema: {}, parse: x => x }, undefined, send as any, {
    endpoint: { baseUrl: 'http://10.0.0.5:8080/v1', apiKey: 'k', model: 'local-model' }, onUsage: u => { usage = u },
  })
  assert.equal(v.answer, 'ok')
  assert.deepEqual(seen[0].provider, 'openai')
  assert.equal(seen[0].model, 'local-model')
  assert.equal(seen[0].ctx.endpoint.baseUrl, 'http://10.0.0.5:8080/v1')
  assert.deepEqual(usage, { inputTokens: 7, outputTokens: 3 })
})

test('callStructured without the new options sends exactly two arguments, as before', async () => {
  let n = -1
  await callStructured({ name: 'n', system: 's', user: 'u', schema: {}, parse: x => x }, 'ollama', (async (...a: any[]) => { n = a.length; return '{}' }) as any, { model: 'm', numThread: 1 })
  assert.equal(n, 2)
})

// ── Settings ────────────────────────────────────────────────────────────────

test('settings: defaults are safe, junk is repaired, and only what loosens a limit is called out', () => {
  const d = defaultSettings()
  assert.deepEqual([d.opusNeedsApproval, d.redactBeforeCloud, d.monthlyCapUsd], [true, true, 0])
  assert.deepEqual(d.classStart, { known: 'local', new_fault: 'local', build: 'sonnet' })
  const n = normalizeSettings({ monthlyCapUsd: -5, maxChain: 99, classStart: { build: 'gpt' }, localOnlyTopics: ['a', 'a', '', 7], tiers: { haiku: { model: '' } }, evil: 1 })
  assert.deepEqual([n.monthlyCapUsd, n.maxChain, n.classStart.build, n.localOnlyTopics, n.tiers.haiku.model], [0, 4, 'sonnet', ['a'], 'claude-haiku-4-5'])
  assert.ok(!('evil' in n))
  assert.deepEqual(loosening(d, { ...d, redactBeforeCloud: false, opusNeedsApproval: false }).length, 2)
  assert.deepEqual(loosening({ ...d, monthlyCapUsd: 10 }, { ...d, monthlyCapUsd: 5 }), [])
  assert.equal(loosening({ ...d, monthlyCapUsd: 10 }, { ...d, monthlyCapUsd: 0 }).length, 1)
  assert.equal(loosening({ ...d, localOnlyTopics: ['a'] }, { ...d, localOnlyTopics: [] }).length, 1)
})

test('the local-tier key is a masked vault credential with no .env mapping', () => {
  const def = CREDENTIAL_DEFS.find(c => c.category === 'ai' && c.provider === 'operator-local' && c.key === 'api_key')
  assert.ok(def)
  assert.equal(def!.masked, true)
  assert.equal(def!.envKey, undefined)
})

// ── Routes ──────────────────────────────────────────────────────────────────

const MARKER = 'PLANTED-KEY-d41d8cd98f00b204e9800998ecf8427e'

function routeWorld(role = 'admin') {
  const r = rig()
  const vault = { key: '' }
  const audits: any[] = []
  const svc = new OperatorService({
    store: r.store, call: r.deps.call, vaultUnlocked: () => true, now: () => r.clock.now,
    localKeyStored: async () => vault.key !== '', anthropicKeyStored: async () => true,
    saveLocalKey: async v => { vault.key = v }, clearLocalKey: async () => { vault.key = '' },
  })
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async (req: any) => { req.session = { sid: 'sess-1', email: 'admin@example.org', role } })
  app.register(makeOperatorRoutes({ service: () => svc, audit: async (a, res, d) => { audits.push({ action: a, resource: res, details: d }) } }), { prefix: '/api/ai/operator' })
  const sinkRows: any[] = []
  setAuditSink({ async write(row) { sinkRows.push(row) } })
  return { app, r, vault, audits, sinkRows }
}

test('roles: viewers read, admins change; API tokens cannot change anything', () => {
  for (const p of ['/api/ai/operator/settings', '/api/ai/operator/tiers', '/api/ai/operator/spend']) assert.equal(requiredRole('GET', p), 'viewer', p)
  for (const [m, p] of [['PUT', '/api/ai/operator/settings'], ['PUT', '/api/ai/operator/key'], ['POST', '/api/ai/operator/ask'], ['POST', '/api/ai/operator/ask/approve']]) {
    assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
    assert.equal(tokenForbidden(m, p), true, `${m} ${p}`)
  }
  assert.equal(tokenForbidden('GET', '/api/ai/operator/settings'), false)
})

test('routes: ask answers with tier, model and chain; Opus asks first and the approval route runs it', async () => {
  const { app } = routeWorld()
  const a = await app.inject({ method: 'POST', url: '/api/ai/operator/ask', payload: { text: 'Why is the backup failing' } })
  assert.equal(a.statusCode, 200)
  assert.deepEqual([a.json().result.status, a.json().result.tier, a.json().result.chain.length], ['answered', 'local', 1])

  const q = await app.inject({ method: 'POST', url: '/api/ai/operator/ask', payload: { text: 'plan the failover', force: 'opus' } })
  const need = q.json().result
  assert.equal(need.status, 'needs_approval')
  const noTok = await app.inject({ method: 'POST', url: '/api/ai/operator/ask/approve', payload: { text: 'plan the failover' } })
  assert.equal(noTok.statusCode, 400)
  const ok = await app.inject({ method: 'POST', url: '/api/ai/operator/ask/approve', payload: { text: 'plan the failover', approval: need.approvalToken } })
  assert.equal(ok.json().result.tier, 'opus')
  const bad = await app.inject({ method: 'POST', url: '/api/ai/operator/ask', payload: { text: 'x', force: 'gpt' } })
  assert.equal(bad.statusCode, 400)
  const empty = await app.inject({ method: 'POST', url: '/api/ai/operator/ask', payload: { text: '  ' } })
  assert.equal(empty.statusCode, 400)
})

test('routes: settings read and save; loosening a limit needs the in-page confirmation, tightening does not', async () => {
  const { app, audits } = routeWorld()
  const g = await app.inject({ method: 'GET', url: '/api/ai/operator/settings' })
  assert.equal(g.json().settings.redactBeforeCloud, true)

  const tighten = await app.inject({ method: 'PUT', url: '/api/ai/operator/settings', payload: { monthlyCapUsd: 20, localOnlyTopics: ['payroll'] } })
  assert.equal(tighten.statusCode, 200)
  assert.equal(tighten.json().settings.monthlyCapUsd, 20)

  const loose = await app.inject({ method: 'PUT', url: '/api/ai/operator/settings', payload: { redactBeforeCloud: false } })
  assert.equal(loose.statusCode, 403)
  assert.equal(loose.json().code, 'confirm_required')
  assert.match(loose.json().error, /stop hiding addresses/)
  assert.equal((await app.inject({ method: 'GET', url: '/api/ai/operator/settings' })).json().settings.redactBeforeCloud, true)

  const done = await injectConfirmed(app, { method: 'PUT', url: '/api/ai/operator/settings', payload: { redactBeforeCloud: false } })
  assert.equal(done.statusCode, 200)
  assert.equal(done.json().settings.redactBeforeCloud, false)
  assert.ok(audits.some(a => a.action === 'ai.operator.settings' && a.details.changed.includes('redactBeforeCloud')))
  // The audit row names fields, never values: the topic keyword is not in it.
  assert.ok(!JSON.stringify(audits).includes('payroll'))
})

test('settings read: a viewer gets the switches but not the local address or the keep-it-local words', async () => {
  const { app, r } = routeWorld('viewer')
  r.store.settings = normalizeSettings({ ...r.store.settings, localBaseUrl: 'http://10.0.0.5:8080/v1', localOnlyTopics: ['payroll'] })
  const v = await app.inject({ method: 'GET', url: '/api/ai/operator/settings' })
  assert.ok(!v.body.includes('10.0.0.5') && !v.body.includes('payroll'))
  assert.equal(v.json().settings.localBaseUrl, 'set')
  const adm = routeWorld('admin'); adm.r.store.settings = r.store.settings
  const a = await adm.app.inject({ method: 'GET', url: '/api/ai/operator/settings' })
  assert.ok(a.body.includes('10.0.0.5') && a.body.includes('payroll'))
})

test('local-tier key: stored only after confirmation, reads say stored or not and never the value; no marker anywhere', async () => {
  const { app, vault, audits, sinkRows, r } = routeWorld()
  const first = await app.inject({ method: 'PUT', url: '/api/ai/operator/key', payload: { key: MARKER } })
  assert.equal(first.statusCode, 403)
  assert.equal(first.json().code, 'confirm_required')
  assert.equal(vault.key, '')

  const saved = await injectConfirmed(app, { method: 'PUT', url: '/api/ai/operator/key', payload: { key: MARKER } })
  assert.equal(saved.statusCode, 200)
  assert.deepEqual(saved.json(), { ok: true, stored: true })
  assert.equal(vault.key, MARKER)

  const bodies = [
    first.body, saved.body,
    (await app.inject({ method: 'GET', url: '/api/ai/operator/settings' })).body,
    (await app.inject({ method: 'GET', url: '/api/ai/operator/tiers' })).body,
    (await app.inject({ method: 'GET', url: '/api/ai/operator/spend' })).body,
    (await app.inject({ method: 'POST', url: '/api/ai/operator/ask', payload: { text: 'Why is it down' } })).body,
  ]
  assert.equal((await app.inject({ method: 'GET', url: '/api/ai/operator/settings' })).json().keys.localKeyStored, true)
  for (const b of bodies) assert.ok(!b.includes(MARKER), 'a response carries the key')
  assert.ok(!JSON.stringify(audits).includes(MARKER))
  assert.ok(!JSON.stringify(sinkRows).includes(MARKER))
  assert.ok(!JSON.stringify(r.store).includes(MARKER))
  assert.ok(audits.some(a => a.action === 'ai.operator.key' && a.details.action === 'stored'))

  const cleared = await injectConfirmed(app, { method: 'PUT', url: '/api/ai/operator/key', payload: { key: '' } })
  assert.equal(cleared.json().stored, false)
  assert.equal(vault.key, '')
  assert.equal((await app.inject({ method: 'PUT', url: '/api/ai/operator/key', payload: { key: 'a\nb' } })).statusCode, 400)
})

test('an API token session cannot confirm, so it cannot store the key', async () => {
  const r = rig()
  const svc = new OperatorService({ store: r.store, call: r.deps.call, vaultUnlocked: () => true, localKeyStored: async () => false, anthropicKeyStored: async () => true, saveLocalKey: async () => { throw new Error('must not be called') }, clearLocalKey: async () => {} })
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async (req: any) => { req.session = { sid: 'token:7', email: 'token:ci', role: 'admin' }; req.apiToken = { id: '7', name: 'ci' } })
  app.register(makeOperatorRoutes({ service: () => svc, audit: async () => {} }), { prefix: '/api/ai/operator' })
  const res = await app.inject({ method: 'PUT', url: '/api/ai/operator/key', payload: { key: MARKER } })
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().code, 'token_forbidden')
  assert.ok(!res.body.includes(MARKER))
})

test('no secret in the audit or the usage rows when a key is in play: the router never sees one', async () => {
  const r = rig()
  r.script.local = [{ answer: 'fine' }]
  await ask(r, `Why is it down? ${'x'.repeat(10)}`)
  const all = JSON.stringify([r.audits, r.store.usage, r.store.prints, r.calls.map(c => ({ ...c, user: undefined }))])
  assert.ok(!all.includes('Why is it down'), 'the question text is in a row')
  assert.ok(!all.includes('fine'), 'the answer text is in a row')
  assert.ok(r.audits.every(a => a.action === 'ai.operator.ask' && !('text' in a.details)))
})

// ── Knowledge source ────────────────────────────────────────────────────────

test('the AI knowledge source summarises tiers, spend and privacy; locked it says so; no secret', async () => {
  const r = rig({ monthlyCapUsd: 10, localOnlyTopics: ['payroll'] })
  const svc = new OperatorService({ store: r.store, call: r.deps.call, vaultUnlocked: () => true, localKeyStored: async () => true, anthropicKeyStored: async () => true, saveLocalKey: async () => {}, clearLocalKey: async () => {}, now: () => r.clock.now })
  const src = operatorSource({ unlocked: () => true, service: () => svc })
  const sum = await src.load()
  const text = [sum.headline, ...sum.lines].join('\n')
  assert.match(text, /4 of 4 tiers ready/)
  assert.match(text, /asks for approval/)
  assert.match(text, /cap/)
  assert.ok(!/10\.0\.0\.5|payroll/.test(text))
  assert.ok(src.aliases.test('how much have we spent on opus this month'))
  const locked = await operatorSource({ unlocked: () => false, service: () => svc }).load()
  assert.equal(locked.locked, true)
})
