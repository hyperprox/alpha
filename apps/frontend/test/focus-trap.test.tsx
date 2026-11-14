// Modal dialogs keep Tab inside them (lib/focus-trap.ts): it cycles, and never leaves the dialog.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { nextFocusIndex } from '../lib/focus-trap'

test('Tab and Shift+Tab cycle inside the dialog', () => {
  assert.equal(nextFocusIndex(3, 0, false), 1)
  assert.equal(nextFocusIndex(3, 2, false), 0, 'past the last: back to the first')
  assert.equal(nextFocusIndex(3, 0, true), 2, 'before the first: the last')
  assert.equal(nextFocusIndex(3, -1, false), 0, 'focus outside: the first')
  assert.equal(nextFocusIndex(3, -1, true), 2)
  assert.equal(nextFocusIndex(0, 0, false), -1)
})
void renderToStaticMarkup
