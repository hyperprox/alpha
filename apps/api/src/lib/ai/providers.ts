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

const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5'

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
//  Small models wrap JSON in prose or fences no matter what they are told.
// ---------------------------------------------------------------------------

export function unwrapJson(text: string): string {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned
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

  const json = unwrapJson(String(text))
  return PlanSchema.parse(JSON.parse(json))
}

// ---------------------------------------------------------------------------

export async function activeProvider(): Promise<ProviderId> {
  const stored = await cred('system', 'provider')
  if (stored === 'anthropic' || stored === 'openai' || stored === 'ollama') return stored
  // Whatever is configured, preferring the local one — it costs nothing. But an
  // address is only a preference if something answers at it.
  const ollamaAddr = (await cred('ollama', 'url')) || process.env.OLLAMA_URL || ''
  if (ollamaAddr && await ollamaReachable(ollamaAddr)) return 'ollama'
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

/**
 * A stored address is not a working one.
 *
 * For the cloud providers "configured" can only mean "a key is present" — the
 * alternative is spending money to render a dropdown. Ollama is different: it
 * is free to ask, and an address left behind by a server that no longer exists
 * would otherwise report itself as configured forever, disagreeing with the
 * connection status the rest of the app shows.
 */
async function ollamaReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const [ollamaUrl, ollamaModel, anthKey, anthModel, oaKey, oaModel, oaBase] = await Promise.all([
    cred('ollama', 'url'), cred('ollama', 'model'),
    cred('anthropic', 'api_key'), cred('anthropic', 'model'),
    cred('openai', 'api_key'), cred('openai', 'model'), cred('openai', 'base_url'),
  ])

  const ollamaAddr = ollamaUrl || process.env.OLLAMA_URL || ''
  const ollamaUp   = ollamaAddr ? await ollamaReachable(ollamaAddr) : false

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
      configured: ollamaUp,
      model: ollamaModel || process.env.OLLAMA_MODEL || 'llama3.2:3b',
      missing: ollamaAddr
        ? (ollamaUp ? [] : ['a reachable server — ' + ollamaAddr + ' does not answer'])
        : ['server address'],
      note: 'Free and private. Small models produce weaker plans — the output is validated before you see it.',
    },
  ]
}

// ===========================================================================
//  One structured-output call, for every provider
//
//  The caller supplies one JSON Schema and one parse function. Each provider
//  constrains generation its own way; the reply is then parsed identically, so
//  nothing downstream depends on which provider answered.
// ===========================================================================

export interface StructuredRequest<T> {
  name: string
  system: string
  user: string
  schema: Record<string, unknown>
  parse(raw: unknown): T
}

/** Returns the reply's text. */
export type RawSend = (provider: ProviderId, body: Record<string, unknown>) => Promise<string>

export interface StructuredOptions {
  /** Overrides the stored model (and skips the credential lookup). */
  model?: string
  /** Ollama only: threads per request. Overrides the setting and OLLAMA_NUM_THREAD. */
  numThread?: number
}

/** `refusal`: the model declined, retrying will not help. `parse`: two replies did not fit the schema. */
export class StructuredOutputError extends Error {
  constructor(message: string, readonly kind: 'refusal' | 'parse' = 'parse') {
    super(message)
    this.name = 'StructuredOutputError'
  }
}

const ANTHROPIC_STRUCTURED_MAX_TOKENS = 4096
const OLLAMA_DEFAULT_TIMEOUT_S = 300
const OPENAI_DEFAULT_MODEL = 'gpt-4o'
const OLLAMA_DEFAULT_MODEL = 'llama3.2:3b'

export function anthropicBody(r: StructuredRequest<unknown>, model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: ANTHROPIC_STRUCTURED_MAX_TOKENS,
    system: r.system,
    messages: [{ role: 'user', content: r.user }],
    output_config: { format: { type: 'json_schema', schema: r.schema } },
  }
}

export function openaiBody(r: StructuredRequest<unknown>, model: string): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: 'system', content: r.system },
      { role: 'user', content: r.user },
    ],
    response_format: { type: 'json_schema', json_schema: { name: r.name, strict: true, schema: r.schema } },
  }
}

export function ollamaBody(r: StructuredRequest<unknown>, model: string, numThread?: number): Record<string, unknown> {
  return {
    model, stream: false,
    format: r.schema,
    messages: [
      { role: 'system', content: r.system },
      { role: 'user', content: r.user },
    ],
    options: {
      temperature: 0.1,
      // Ollama sizes its thread count from the host's cores, not the container's CPU quota.
      ...(numThread && numThread > 0 ? { num_thread: Math.floor(numThread) } : {}),
    },
  }
}

/** Thread count and timeout for a local model on a CPU: slow, so patient, and told how many cores it really has. */
export async function ollamaSettings(): Promise<{ numThread?: number; timeoutMs: number }> {
  const pos = (v: string): number | undefined => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const numThread = pos(await cred('ollama', 'num_thread').catch(() => '')) ?? pos(process.env.OLLAMA_NUM_THREAD ?? '')
  const seconds = pos(await cred('ollama', 'timeout_s').catch(() => '')) ?? pos(process.env.OLLAMA_TIMEOUT_S ?? '') ?? OLLAMA_DEFAULT_TIMEOUT_S
  return { numThread, timeoutMs: seconds * 1000 }
}

/** The text of an Anthropic reply; a refusal is an error, never an empty result. */
export function anthropicText(response: { stop_reason?: string | null; content?: Array<{ type: string; text?: string }> }): string {
  if (response.stop_reason === 'refusal') {
    throw new StructuredOutputError('The model declined this request. Rephrase it, or use a different provider.', 'refusal')
  }
  const block = response.content?.find(b => b.type === 'text')
  if (!block?.text) throw new Error('The provider returned no content.')
  return block.text
}

async function httpSend(provider: ProviderId, body: Record<string, unknown>): Promise<string> {
  if (provider === 'anthropic') {
    const apiKey = await cred('anthropic', 'api_key')
    if (!apiKey) throw new Error('Anthropic is not configured — add an API key in Settings.')
    const client = new Anthropic({ apiKey })
    const response = await client.messages.create(body as any, { timeout: 180_000 })
    return anthropicText(response as any)
  }
  if (provider === 'openai') {
    const apiKey = await cred('openai', 'api_key')
    if (!apiKey) throw new Error('OpenAI is not configured — add an API key in Settings.')
    const base = ((await cred('openai', 'base_url')) || OPENAI_DEFAULT_BASE).replace(/\/+$/, '')
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    })
    if (!res.ok) throw new Error(`${body.model} returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data: any = await res.json()
    const choice = data?.choices?.[0]
    if (choice?.message?.refusal) {
      throw new StructuredOutputError('The model declined this request. Rephrase it, or use a different provider.', 'refusal')
    }
    const text = choice?.message?.content
    if (!text) throw new Error('The provider returned no content.')
    return text
  }
  const url = (await cred('ollama', 'url')) || process.env.OLLAMA_URL || ''
  if (!url) throw new Error('Ollama is not configured — add its address in Settings.')
  const { timeoutMs } = await ollamaSettings()
  const res = await fetch(`${url.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`)
  const data: any = await res.json()
  const text = data?.message?.content
  if (!text) throw new Error(data?.error || 'Ollama returned no content.')
  return text
}

async function modelFor(provider: ProviderId): Promise<string> {
  if (provider === 'anthropic') return (await cred('anthropic', 'model')) || ANTHROPIC_DEFAULT_MODEL
  if (provider === 'openai') return (await cred('openai', 'model')) || OPENAI_DEFAULT_MODEL
  return (await cred('ollama', 'model')) || process.env.OLLAMA_MODEL || OLLAMA_DEFAULT_MODEL
}

export async function callStructured<T>(
  r: StructuredRequest<T>,
  provider?: ProviderId,
  send: RawSend = httpSend,
  opts: StructuredOptions = {},
): Promise<T> {
  const id = provider ?? (await activeProvider())
  const model = opts.model ?? (await modelFor(id))
  const numThread = id === 'ollama' ? (opts.numThread ?? (await ollamaSettings()).numThread) : undefined
  const body = id === 'anthropic' ? anthropicBody(r, model)
    : id === 'openai' ? openaiBody(r, model)
    : ollamaBody(r, model, numThread)

  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await send(id, body) // transport errors and refusals are not parse failures: not retried
    try {
      return r.parse(JSON.parse(unwrapJson(String(text))))
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  throw new StructuredOutputError(`The model's reply did not match what was asked for (${lastError.slice(0, 200)}). Please rephrase your request.`, 'parse')
}
