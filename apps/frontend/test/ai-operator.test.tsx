// The AI operator page's pieces rendered to HTML: the ladder in words, the spend meter, and the answer card with its
// tier badge, chain and the Opus approval step. All names and addresses are made up.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import "./css-stub"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnswerCard, Ladder, SpendMeter } from '../components/ai/operator/OperatorView'
import { chainText, ladderState, ladderWord, parseTopics, spendPercent, spendSentence, spendTone, usd, type TierStatus } from '../lib/operator-view'

const t = (o: Partial<TierStatus>): TierStatus => ({ tier: 'local', enabled: true, model: 'local-model', cloud: false, configured: true, missing: '', ready: true, ...o })

test('ladder: four tiers in order, each with its state said in words', () => {
  const html = renderToStaticMarkup(<Ladder tiers={[
    t({}),
    t({ tier: 'haiku', cloud: true, model: 'claude-haiku-4-5', configured: false, missing: 'an Anthropic key', ready: false }),
    t({ tier: 'sonnet', cloud: true, enabled: false, ready: false, model: 'claude-sonnet-5-5' }),
    t({ tier: 'opus', cloud: true, model: 'claude-opus-5-5' }),
  ]} />)
  assert.ok(html.indexOf('Local model') < html.indexOf('Haiku') && html.indexOf('Haiku') < html.indexOf('Sonnet') && html.indexOf('Sonnet') < html.indexOf('Opus'))
  assert.match(html, /Ready/)
  assert.match(html, /Needs an Anthropic key/)
  assert.match(html, /Turned off/)
  assert.match(html, /Asks you first/)
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(html), 'no emoji')
  assert.match(html, /<svg/)
})

test('ladder state and words', () => {
  assert.equal(ladderState(t({})), 'ready')
  assert.equal(ladderState(t({ enabled: false })), 'off')
  assert.equal(ladderWord(t({ configured: false, missing: 'a model name' })), 'Needs a model name')
})

test('spend: no cap shows no bar; a cap shows how much is used, in words and in a bar', () => {
  assert.equal(spendPercent({ monthUsd: 3, capUsd: 0 }), null)
  assert.equal(spendPercent({ monthUsd: 5, capUsd: 20 }), 25)
  assert.equal(spendPercent({ monthUsd: 50, capUsd: 20 }), 100)
  assert.deepEqual([spendTone(10), spendTone(85), spendTone(100), spendTone(null)], ['ok', 'warn', 'full', 'ok'])
  assert.match(spendSentence({ month: '2026-11', monthUsd: 5, capUsd: 20 }), /\$5\.00 of \$20\.00 used this month\. At the cap, only the local model is used\./)
  assert.match(spendSentence({ month: '2026-11', monthUsd: 0, capUsd: 0 }), /No cap is set/)
  assert.equal(usd(0.0021), '$0.0021')
  const none = renderToStaticMarkup(<SpendMeter spend={{ month: '2026-11', monthUsd: 1, capUsd: 0 }} />)
  assert.ok(!none.includes('role="progressbar"'))
  const capped = renderToStaticMarkup(<SpendMeter spend={{ month: '2026-11', monthUsd: 5, capUsd: 20 }} />)
  assert.match(capped, /role="progressbar"[^>]*aria-valuenow="25"/)
})

test('answer card: tier badge, model, the chain, cost and the privacy note', () => {
  const html = renderToStaticMarkup(<AnswerCard result={{
    status: 'answered', answer: 'Restart the proxy on node1.', tier: 'sonnet', model: 'claude-sonnet-5-5', confidence: 'high', costUsd: 0.0105,
    chain: [{ tier: 'local', model: 'local-model', outcome: 'answered', confidence: 'low' }, { tier: 'sonnet', model: 'claude-sonnet-5-5', outcome: 'answered', confidence: 'high' }],
    notes: ['A note.'], redacted: true, localOnly: false,
  }} />)
  assert.match(html, />Sonnet</)
  assert.match(html, /claude-sonnet-5-5/)
  assert.match(html, /Tried: Local model then Sonnet\./)
  assert.match(html, /Cost about \$0\.0105/)
  assert.match(html, /hidden before it was sent/)
})

test('answer card: Opus approval shows what would be sent and an approve button; a refusal is an alert', () => {
  const html = renderToStaticMarkup(<AnswerCard onApprove={() => {}} result={{
    status: 'needs_approval', tier: 'opus', model: 'claude-opus-5-5', reason: 'Opus is the most capable and most expensive model, so it asks first.',
    promptPreview: 'check host-1 at addr-1', approvalToken: 'tok', chain: [{ tier: 'local', model: 'local-model', outcome: 'answered', confidence: 'low' }], notes: [],
    partial: { answer: 'maybe the disk', tier: 'local', confidence: 'low' },
  }} />)
  assert.match(html, /Opus is waiting for your OK/)
  assert.match(html, /check host-1 at addr-1/)
  assert.match(html, /Approve and ask Opus/)
  assert.match(html, /maybe the disk/)
  assert.ok(!html.includes('tok"') && !html.includes('>tok<'), 'the token is not drawn')
  const refused = renderToStaticMarkup(<AnswerCard result={{ status: 'refused', code: 'vault_locked', message: 'HyperProx is locked.', chain: [], notes: [] }} />)
  assert.match(refused, /role="alert"/)
})

test('helpers: chain wording and the topic list', () => {
  assert.equal(chainText([{ tier: 'local', model: 'm', outcome: 'error' }, { tier: 'haiku', model: 'm', outcome: 'skipped' }]), 'Local model (failed) then Haiku (skipped)')
  assert.deepEqual(parseTopics('payroll\n customer data, payroll,'), ['payroll', 'customer data'])
})
