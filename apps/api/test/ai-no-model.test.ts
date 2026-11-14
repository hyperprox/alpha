// The assistant with no AI model connected: questions HyperProx can answer by code are answered, and a request
// that needs a model gets a plain "connect a model for more" answer, never a 502.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { buildAiRoutes, NEEDS_MODEL } from '../src/routes/ai'
import { PreparedStore } from '../src/lib/ai/prepared'
import { keywordIntent } from '../src/lib/ai/intent'
import { ModelCallError } from '../src/lib/ai/providers'
import { HOME_ID } from '../src/lib/clusters/registry'
import { WebsiteDrafts } from '../src/lib/ai/templates/website'
import type { AskSource } from '../src/lib/ai/ask'
import type { ModelCall } from '../src/lib/ai/extract'

const HOME = { id: HOME_ID, name: 'Home cluster', kind: 'home' as const }
const unreachable = () => new ModelCallError("The local model server can't be reached. Check that Ollama is running and its address under Settings.", 'unreachable')
let modelCalls = 0
const noModel: ModelCall = async () => { modelCalls++; throw unreachable() }

const NAS: AskSource = {
  id: 'nas', title: 'NAS', blurb: 'the NAS', aliases: /\bnas\b/i,
  load: async () => ({ headline: 'nas1: healthy', lines: ['nas1: healthy, 4 disks, 41% used'] }),
  answer: () => 'nas1 is healthy: 4 disks, 41% used.',
}

function app(configured: boolean) {
  const f = Fastify()
  f.register(buildAiRoutes({
    whoami: () => 'admin@example.com',
    session: () => ({ sid: 's1', role: 'admin', email: 'admin@example.com' }),
    activeProvider: async () => 'ollama',
    listProviders: async () => [{ id: 'ollama', name: 'Ollama', kind: 'local', configured, model: 'llama3.2:3b', missing: configured ? [] : ['server address'], note: '' }],
    saveModel: async () => {},
    facts: async () => ({}) as any,
    settings: async () => ({}) as any,
    sources: () => [NAS],
    clusterSources: () => [NAS],
    askCall: () => noModel,
    // The real no-provider path: keywords decide what the request is.
    intent: async p => keywordIntent(p),
    extract: async () => { modelCalls++; throw unreachable() },
    clusters: () => [HOME], currentCluster: () => HOME_ID, inCluster: (_id, fn) => fn(),
    actionPlans: new PreparedStore(), homePlans: new PreparedStore(),
    homeNames: async () => ({ nas: [], sites: [] }),
    websiteDrafts: new WebsiteDrafts(),
  }), { prefix: '/api/ai' })
  return f
}

const ask = async (prompt: string, configured = false) => {
  const f = app(configured)
  const r = await f.inject({ method: 'POST', url: '/api/ai/wizard/plan', payload: { prompt, provider: 'ollama' } })
  await f.close()
  return r
}

test('no model: a question HyperProx can answer by code is answered, and the model is never asked', async () => {
  modelCalls = 0
  const r = await ask('Is my NAS healthy?')
  assert.equal(r.statusCode, 200, r.body)
  const b = r.json()
  assert.equal(b.ok, true)
  assert.equal(b.conversational, true)
  assert.match(b.message, /nas1 is healthy/)
  assert.equal(b.needsModel, undefined)
  assert.equal(modelCalls, 0)
})

test('no model: a deploy request says a model is needed, as an answer, not a 502', async () => {
  for (const configured of [false, true]) {
    const r = await ask('Deploy Uptime Kuma at status.example.com', configured)
    assert.equal(r.statusCode, 200, r.body)
    const b = r.json()
    assert.equal(b.ok, true)
    assert.equal(b.needsModel, true)
    assert.ok(b.message.includes(NEEDS_MODEL))
    assert.equal(b.plan, undefined)
  }
})

test('no model: an open question gets a plain answer saying what works without one', async () => {
  const r = await ask('Why is the sky blue?')
  assert.equal(r.statusCode, 200, r.body)
  const b = r.json()
  assert.equal(b.ok, true)
  assert.equal(b.conversational, true)
  assert.match(b.message, /reachable|model/i)
})
