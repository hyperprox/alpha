// No AI model connected: an open question says to connect one (not "The AI provider failed"), and asking never
// writes an empty-looking hyperprox:ai/ollama item into the vault.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerQuestion, type AskSource } from '../src/lib/ai/ask'
import { keywordIntent } from '../src/lib/ai/intent'
import { ModelCallError, NO_MODEL_MESSAGE } from '../src/lib/ai/providers'
import { saveOllamaModel } from '../src/routes/ai'

const SRC: AskSource = { id: 'x', title: 'X', blurb: 'x', aliases: /\bx\b/i, load: async () => ({ headline: 'x', lines: ['x'] }) } as any

test('an open question with no model connected says to connect one', async () => {
  const call = async () => { throw new ModelCallError(NO_MODEL_MESSAGE, 'not-configured') }
  const a = await answerQuestion('why is x slower than it was?', { sources: [SRC], call: call as any, fallback: 'CANNED' })
  assert.ok(a)
  assert.match(a!, /connect a model/i)
  assert.doesNotMatch(a!, /provider failed/i)
  assert.match(NO_MODEL_MESSAGE, /connect a model .* to answer open questions/)
})

test('a keyword fallback with that cause says the same', () => {
  const r = keywordIntent('how is everything?', NO_MODEL_MESSAGE)
  assert.match(r.answer, /connect a model/i)
  assert.doesNotMatch(r.answer, /provider failed/i)
})

test('the model a request picked is saved only when an Ollama is connected and it changed', async () => {
  const writes: string[] = []
  const set = async (_c: string, _p: string, k: string, v: string) => { writes.push(`${k}=${v}`) }
  const prevEnv = process.env.OLLAMA_URL
  delete process.env.OLLAMA_URL
  try {
    assert.equal(await saveOllamaModel('llama3.2:3b', async () => null, set), false)
    assert.deepEqual(writes, [], 'no Ollama: no vault item is made')
    const stored: Record<string, string> = { url: 'http://192.0.2.9:11434', model: 'llama3.2:3b' }
    const get = async (_c: string, _p: string, k: string) => stored[k] ?? null
    assert.equal(await saveOllamaModel('llama3.2:3b', get, set), false, 'unchanged: nothing written')
    assert.equal(await saveOllamaModel('qwen3.5:9b', get, set), true)
    assert.deepEqual(writes, ['model=qwen3.5:9b'])
  } finally { if (prevEnv !== undefined) process.env.OLLAMA_URL = prevEnv }
})
