// The AI assistant page without a model: the input and the example chips stay usable (questions are answered by
// code), and the page says what connecting a model adds instead of "Not ready".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { assistantMode, exampleChips, CONNECT_MODEL_WORDS } from '../lib/ai-assistant-mode'

test('no model: input usable, a "Connect a model for more" panel, no red NOT READY', () => {
  const m = assistantMode({ providerReady: false, planning: false, providerName: 'Ollama', model: 'llama3.2:3b' })
  assert.equal(m.inputEnabled, true)
  assert.equal(m.showConnectModel, true)
  assert.equal(m.status.tone, 'warn')
  assert.doesNotMatch(m.title, /not ready/i)
  assert.match(CONNECT_MODEL_WORDS.title, /Connect a model for more/)
})

test('the input is held only while a request is in flight, model or not', () => {
  for (const providerReady of [true, false]) {
    assert.equal(assistantMode({ providerReady, planning: true }).inputEnabled, false)
    assert.equal(assistantMode({ providerReady, planning: false }).inputEnabled, true)
  }
  assert.equal(assistantMode({ providerReady: true, planning: false }).showConnectModel, false)
})

test('example chips are whole questions, asked as they are', () => {
  const chips = exampleChips(false)
  assert.ok(chips.includes('Is my NAS healthy?'))
  assert.ok(chips.every(c => !c.includes('"')))
  assert.equal(exampleChips(true)[0], 'How is each cluster doing?')
  const html = renderToStaticMarkup(<ul>{chips.map(c => <li key={c}>{c}</li>)}</ul>)
  assert.match(html, /What alerts are firing\?/)
})
