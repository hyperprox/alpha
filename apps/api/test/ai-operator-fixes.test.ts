// The fixes the operator may propose for the one download a person pointed at (lib/ai/operator/fixes.ts): only the known
// safe actions, only for that download, and the route reads the item strictly. Names and ids are made up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseItem, proposalsFor, FIX_ACTIONS } from '../src/lib/ai/operator/fixes'
import { answerSchema, normalizeAnswer } from '../src/lib/ai/operator/router'

const item = { kind: 'arr-queue', instance: 'sonarr', downloadId: 'ABC123', title: 'Some Show' }

test('parseItem accepts one queue download and refuses anything else', () => {
  assert.deepEqual(parseItem(item), item)
  assert.equal(parseItem({ ...item, kind: 'node' }), null)
  assert.equal(parseItem({ ...item, instance: 'plex' }), null)
  assert.equal(parseItem({ ...item, downloadId: '' }), null)
  assert.equal(parseItem({ ...item, downloadId: 'x'.repeat(221) }), null)
  assert.equal(parseItem('sonarr'), null)
  assert.equal(parseItem(null), null)
  assert.equal(parseItem({ ...item, title: 'y'.repeat(500) })!.title.length, 160)
})

test('proposals are the model\'s picks, kept to known actions, for that download only', () => {
  const p = proposalsFor(parseItem(item), ['find-another', 'remove', 'prioritise', 'find-another', 42, 'rm -rf /'])
  assert.deepEqual(p.map(x => x.action), ['find-another', 'prioritise'])
  assert.ok(p.every(x => x.downloadId === 'ABC123' && x.instance === 'sonarr'))
  assert.ok(!p.some(x => (x.action as string) === 'remove'), 'remove is never proposed')
  assert.deepEqual(proposalsFor(null, ['find-another']), [])
  assert.deepEqual(proposalsFor(parseItem(item), 'find-another'), [])
  assert.deepEqual(proposalsFor(parseItem(item), undefined), [])
})

test('the fixes field is asked for only when an item is given, and kept by normalizeAnswer', () => {
  assert.ok(!('fixes' in (answerSchema(false) as any).properties))
  const s: any = answerSchema(false, true)
  assert.deepEqual(s.properties.fixes.items.enum, [...FIX_ACTIONS])
  assert.ok(!s.required.includes('fixes'))
  assert.deepEqual(normalizeAnswer({ answer: 'ok', confidence: 'high', verified: null, fixes: ['prioritise'] }).fixes, ['prioritise'])
  assert.equal(normalizeAnswer({ answer: 'ok', confidence: 'high', verified: null }).fixes, undefined)
})
