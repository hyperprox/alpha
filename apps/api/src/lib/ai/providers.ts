// =============================================================================
//  HyperProx — AI providers
//
//  Three ways to reach a model, one interface. Ollama stays the default because
//  it costs nothing and needs no account; the cloud providers exist so a new
//  install is useful on day one instead of after someone has downloaded eight
//  gigabytes of weights.
//
//  NOTE ON SDKs: the Anthropic path uses the official @anthropic-ai/sdk. The
//  OpenAI path is deliberately raw HTTP against the chat-completions shape,
//  which means the same code also reaches OpenRouter, Groq, Together and any
//  local OpenAI-compatible server — a second SDK would buy nothing and would
//  narrow it to one vendor.
// =============================================================================

import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { getCredential, setCredential } from '../credentials'
import { PlanSchema, planJsonSchema, type Plan } from './plan-schema'
import { SYSTEM_PROMPT } from './prompt'

export type ProviderId = 'ollama' | 'anthropic' | 'openai'

export interface ProviderInfo {
  id:        ProviderId
  name:      string
  kind:      'local' | 'cloud'
  configured: boolean
  model:     string
  /** What still has to be supplied before it can be used. */
  missing:   string[]
  note:      string
}

const CATEGORY = 'ai'

async function cred(provider: string, key: string): Promise<string> {
  return (await getCredential(CATEGORY, provider, key)) ?? ''
}

// ---------------------------------------------------------------------------
//  Anthropic
// ---------------------------------------------------------------------------

const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5'

async function anthropicPlan(userText: string): Promise<Plan> {
  const apiKey = await cred('anthropic', 'api_key')
  if (!apiKey) throw new Error('Anthropic is not configured — add an API key in Settings.')
  const model = (await cred('anthropic', 'model')) || ANTHROPIC_DEFAULT_MODEL

  const client = new Anthropic({ apiKey })

  // Structured output is native here: the schema constrains generation rather
  // than being described in prose and hoped for, which is what made the old
  // prompt's "respond ONLY with JSON" instruction necessary.
  const response = await client.messages.parse({
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userText }],
    output_config: { format: zodOutputFormat(PlanSchema) },
  })

  // A safety classifier can decline; that arrives as a 200 with stop_reason
  // "refusal", so content must never be read without checking.
  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined this request. Rephrase it, or use a different provider.')
  }
  if (!response.parsed_output) {
    throw new Error('The model returned a plan that did not match the schema.')
  }
  return response.parsed_output
}

// ---------------------------------------------------------------------------
//  OpenAI, and anything that speaks its chat-completions shape
// ---------------------------------------------------------------------------

const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1'

async function openaiPlan(userText: string): Promise<Plan> {
  const apiKey = await cred('openai', 'api_key')
  if (!apiKey) throw new Error('OpenAI is not configured — add an API key in Settings.')
  const base  = ((await cred('openai', 'base_url')) || OPENAI_DEFAULT_BASE).replace(/\/+$/, '')
  const model = (await cred('openai', 'model')) || 'gpt-4o'

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'deployment_plan', strict: true, schema: planJsonSchema() },
      },
    }),
    signal: AbortSignal.timeout(180_000),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${model} returned HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const data: any = await res.json()
  const text = data?.choices?.[0]?.message?.content
  if (!text) throw new Error('The provider returned no content.')
  return PlanSchema.parse(JSON.parse(text))
}

// ---------------------------------------------------------------------------
//  Ollama — unchanged in spirit, but now validated like the others
// ---------------------------------------------------------------------------

async function ollamaPlan(userText: string): Promise<Plan> {
  const url = (await cred('ollama', 'url')) || process.env.OLLAMA_URL || ''
  if (!url) throw new Error('Ollama is not configured — add its address in Settings.')
  const model = (await cred('ollama', 'model')) || process.env.OLLAMA_MODEL || 'llama3.2:3b'

  const res = await fetch(`${url.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, stream: false,
      // Ollama takes a JSON Schema in `format`, which is the closest it has to
      // constrained decoding. Smaller models still drift, so the result is
      // validated afterwards rather than trusted.
      format: planJsonSchema(),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText },
      ],
      options: { temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(180_000),
  })

  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`)
  const data: any = await res.json()
  const text = data?.message?.content
  if (!text) throw new Error(data?.error || 'Ollama returned no content.')

  // Small models wrap JSON in prose or fences no matter what they are told.
  const cleaned = String(text).replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  const json = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned
  return PlanSchema.parse(JSON.parse(json))
}

// ---------------------------------------------------------------------------

export async function activeProvider(): Promise<ProviderId> {
  const stored = await cred('system', 'provider')
  if (stored === 'anthropic' || stored === 'openai' || stored === 'ollama') return stored
  // Whatever is configured, preferring the local one — it costs nothing.
  if (await cred('ollama', 'url')) return 'ollama'
  if (await cred('anthropic', 'api_key')) return 'anthropic'
  if (await cred('openai', 'api_key')) return 'openai'
  return 'ollama'
}

export async function setActiveProvider(id: ProviderId): Promise<void> {
  await setCredential(CATEGORY, 'system', 'provider', id, false)
}

export async function generatePlan(userText: string, provider?: ProviderId): Promise<Plan> {
  const id = provider ?? (await activeProvider())
  if (id === 'anthropic') return anthropicPlan(userText)
  if (id === 'openai')    return openaiPlan(userText)
  return ollamaPlan(userText)
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const [ollamaUrl, ollamaModel, anthKey, anthModel, oaKey, oaModel, oaBase] = await Promise.all([
    cred('ollama', 'url'), cred('ollama', 'model'),
    cred('anthropic', 'api_key'), cred('anthropic', 'model'),
    cred('openai', 'api_key'), cred('openai', 'model'), cred('openai', 'base_url'),
  ])

  return [
    {
      id: 'anthropic', name: 'Anthropic', kind: 'cloud',
      configured: Boolean(anthKey), model: anthModel || ANTHROPIC_DEFAULT_MODEL,
      missing: anthKey ? [] : ['API key'],
      note: 'Constrains the plan against the schema natively, so malformed plans are not a failure mode.',
    },
    {
      id: 'openai', name: 'OpenAI', kind: 'cloud',
      configured: Boolean(oaKey), model: oaModel || 'gpt-4o',
      missing: oaKey ? [] : ['API key'],
      note: oaBase && oaBase !== OPENAI_DEFAULT_BASE
        ? `Pointed at ${oaBase}`
        : 'Also reaches any OpenAI-compatible endpoint — set a base URL for OpenRouter, Groq or a local server.',
    },
    {
      id: 'ollama', name: 'Ollama', kind: 'local',
      configured: Boolean(ollamaUrl || process.env.OLLAMA_URL),
      model: ollamaModel || process.env.OLLAMA_MODEL || 'llama3.2:3b',
      missing: (ollamaUrl || process.env.OLLAMA_URL) ? [] : ['server address'],
      note: 'Free and private. Small models produce weaker plans — the output is validated before you see it.',
    },
  ]
}
