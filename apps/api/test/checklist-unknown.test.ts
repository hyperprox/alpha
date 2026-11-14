// A node whose state could not be read is unknown in the Setup checklist: not "not done", and not counted as such.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roll } from '../src/lib/setup-checklist'

const r = (state: any) => ({ node: 'n', state, reason: '' })

test('unknown rows count neither way', () => {
  assert.equal(roll([r('unknown'), r('unknown')]), 'unknown')
  assert.equal(roll([r('done'), r('unknown')]), 'partly', 'done where known, but not everywhere known to be')
  assert.equal(roll([r('not-done'), r('unknown')]), 'not-done')
  assert.equal(roll([r('done'), r('done')]), 'done')
  assert.equal(roll([r('not-applicable'), r('unknown')]), 'unknown')
})
