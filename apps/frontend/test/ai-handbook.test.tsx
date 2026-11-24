// The Handbook page's pieces: filtering and wording, the playbook card, and the operator answer saying what it used.
// All names are made up.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import "./css-stub"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlaybookCard } from '../components/ai/handbook/HandbookView'
import { AnswerCard } from '../components/ai/operator/OperatorView'
import { bodyOf, countLine, draftOf, emptyDraft, filterPlaybooks, parseList, parseRules, rulesText, sourceWord, statusWord, type Playbook } from '../lib/handbook-view'
import { usedSentence } from '../lib/operator-view'

const pb = (o: Partial<Playbook>): Playbook => ({
  id: 'a', key: 'a', title: 'Queued downloads show zero seeds', tags: ['torrent', 'queue'], symptoms: ['a download is stuck at 0%'], severity: 'high', area: 'downloads',
  checks: 'Read the state.', cause: 'It is queued.', fix: 'Wait for a slot.', safety: 'Never purge it.', testScenario: 'Situation: queued.', source: 'seed', approved: true,
  createdAt: '2026-11-24T00:00:00Z', updatedAt: '2026-11-24T00:00:00Z', ...o,
})

test('filter: by words in title, tags, symptoms or area; waiting ones first', () => {
  const list = [pb({}), pb({ id: 'b', title: 'Printer offline', tags: ['printer'], symptoms: ['shows offline'], area: 'network', approved: false }), pb({ id: 'c', title: 'Backup full', tags: [], symptoms: [], area: 'storage' })]
  assert.deepEqual(filterPlaybooks(list, { q: '', status: 'all' }).map(p => p.id), ['b', 'a', 'c'])
  assert.deepEqual(filterPlaybooks(list, { q: 'torrent', status: 'all' }).map(p => p.id), ['a'])
  assert.deepEqual(filterPlaybooks(list, { q: 'offline printer', status: 'all' }).map(p => p.id), ['b'])
  assert.deepEqual(filterPlaybooks(list, { q: '', status: 'waiting' }).map(p => p.id), ['b'])
  assert.deepEqual(filterPlaybooks(list, { q: '', status: 'approved' }).map(p => p.id).sort(), ['a', 'c'])
  assert.equal(countLine(list), '3 playbooks, 1 waiting for approval.')
  assert.equal(countLine([pb({})]), '1 playbook.')
})

test('drafts: a playbook into the form and back into a request body', () => {
  const d = draftOf(pb({ tags: ['a', 'b'], symptoms: ['one', 'two three'] }))
  assert.equal(d.tags, 'a, b')
  assert.equal(d.symptoms, 'one\ntwo three')
  const body = bodyOf({ ...d, tags: 'x, y\nx', symptoms: 'first one\n\nsecond, with a comma' })
  assert.deepEqual(body.tags, ['x', 'y'])
  assert.deepEqual(body.symptoms, ['first one', 'second, with a comma'])
  assert.equal(emptyDraft().approved, false)
  assert.deepEqual(parseList(' a,, b ,a'), ['a', 'b'])
  assert.deepEqual(parseRules(rulesText(['one', 'two'])), ['one', 'two'])
  assert.deepEqual(parseRules('one\n\n  two  \n'), ['one', 'two'])
})

test('words: where a playbook came from and whether it is in use', () => {
  assert.equal(sourceWord('cloud-draft'), 'Drafted by a cloud model')
  assert.equal(sourceWord('seed'), 'Imported')
  assert.equal(statusWord(pb({ approved: false })), 'Waiting for approval')
})

test('card: closed it is a title and badges; open it shows every section and the actions given', () => {
  const closed = renderToStaticMarkup(<PlaybookCard p={pb({ approved: false })} open={false} />)
  assert.match(closed, /Queued downloads show zero seeds/)
  assert.match(closed, /Waiting for approval/)
  assert.match(closed, /aria-expanded="false"/)
  assert.doesNotMatch(closed, /Wait for a slot/)
  const open = renderToStaticMarkup(<PlaybookCard p={pb({})} open><button>Approve</button></PlaybookCard>)
  for (const t of ['Checks', 'Cause', 'Fix', 'Safety', 'Test scenario', 'a download is stuck at 0%', 'Wait for a slot.', 'Never purge it.', 'Approve']) assert.match(open, new RegExp(t.replace(/[.%]/g, '\\$&')))
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(open), 'no emoji')
})

test('an answer says which playbooks, readings and rules it was built from, and when it left a draft', () => {
  const base = { status: 'answered' as const, answer: 'It is only queued.', tier: 'local' as const, model: 'm', confidence: 'high', chain: [], notes: [], costUsd: 0, redacted: false, localOnly: false }
  const html = renderToStaticMarkup(<AnswerCard result={{ ...base, used: { playbooks: [{ id: 'a', title: 'Queued downloads show zero seeds' }], live: ['Arr Stack'], rules: 3 } }} />)
  assert.match(html, /Built from the playbook &quot;Queued downloads show zero seeds&quot;, live readings of Arr Stack, 3 house rules\./)
  const drafted = renderToStaticMarkup(<AnswerCard result={{ ...base, tier: 'sonnet', drafted: { id: 'd', title: 'Scheduler stops' } }} />)
  assert.match(drafted, /Scheduler stops/)
  assert.match(drafted, /waits for your approval/)
  assert.equal(usedSentence(undefined), '')
  assert.equal(usedSentence({ playbooks: [], live: [], rules: 0 }), '')
  assert.doesNotMatch(renderToStaticMarkup(<AnswerCard result={base} />), /Built from/)
})
