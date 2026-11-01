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
import { getCredential, setCredential } from '../credentials'

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

// ---------------------------------------------------------------------------
//  OpenAI, and anything that speaks its chat-completions shape
// ---------------------------------------------------------------------------

const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1'

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
  return (await ollamaTags(url)).up
}

/** The models an Ollama server has installed; `up` is false when it does not answer. */
export async function ollamaTags(url: string, fetchFn: typeof fetch = fetch): Promise<{ up: boolean; models: string[] }> {
  try {
    const res = await fetchFn(`${url.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return { up: false, models: [] }
    const data = await res.json().catch(() => ({})) as { models?: Array<{ name?: unknown }> }
    return { up: true, models: (data.models ?? []).map(m => m.name).filter((n): n is string => typeof n === 'string') }
  } catch {
    return { up: false, models: [] }
  }
}

/** A name with no tag is its `latest` tag, as Ollama reads it. */
export function modelInstalled(model: string, installed: string[]): boolean {
  const want = model.includes(':') ? model : `${model}:latest`
  return installed.includes(want)
}

/** Reachable is not usable: the model stored for the wizard has to be one the server has. */
export function ollamaProviderState(addr: string, model: string, tags: { up: boolean; models: string[] }): { configured: boolean; missing: string[] } {
  if (!addr) return { configured: false, missing: ['server address'] }
  if (!tags.up) return { configured: false, missing: ['a reachable server — ' + addr + ' does not answer'] }
  if (!modelInstalled(model, tags.models)) {
    return { configured: false, missing: [`the model ${model} is not installed on the server — pick one under Models`] }
  }
  return { configured: true, missing: [] }
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const [ollamaUrl, ollamaModel, anthKey, anthModel, oaKey, oaModel, oaBase] = await Promise.all([
    cred('ollama', 'url'), cred('ollama', 'model'),
    cred('anthropic', 'api_key'), cred('anthropic', 'model'),
    cred('openai', 'api_key'), cred('openai', 'model'), cred('openai', 'base_url'),
  ])

  const ollamaAddr = ollamaUrl || process.env.OLLAMA_URL || ''
  const ollamaTagList = ollamaAddr ? await ollamaTags(ollamaAddr) : { up: false, models: [] }
  const ollamaStored = ollamaModel || process.env.OLLAMA_MODEL || OLLAMA_DEFAULT_MODEL
  const ollamaState = ollamaProviderState(ollamaAddr, ollamaStored, ollamaTagList)

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
      configured: ollamaState.configured,
      model: ollamaStored,
      missing: ollamaState.missing,
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

/**
 * `refusal`: the model declined. `truncated`: it ran out of tokens mid-reply. Neither is retried.
 * `parse`: two replies did not fit the schema.
 */
export class StructuredOutputError extends Error {
  constructor(message: string, readonly kind: 'refusal' | 'truncated' | 'parse' = 'parse') {
    super(message)
    this.name = 'StructuredOutputError'
  }
}

/**
 * A model call that failed for a reason a person can act on. The message is written to be shown as is:
 * it names the cause and never quotes the provider's body, which can echo the prompt.
 */
export class ModelCallError extends Error {
  constructor(message: string, readonly kind: 'unreachable' | 'model-missing' | 'timeout' | 'rejected') {
    super(message)
    this.name = 'ModelCallError'
  }
}

const REFUSED = 'The model declined this request. Rephrase it, or use a different provider.'
const TRUNCATED = 'The model ran out of room before finishing its reply. Shorten the request or use a different model.'

/** Status and the provider's error type or code; the body can echo the prompt, so none of it is quoted. */
export function providerError(model: string, status: number, body: string): Error {
  let tag = ''
  try {
    const e = JSON.parse(body)?.error
    const t = [e?.type, e?.code].filter((x: unknown) => typeof x === 'string' && /^[\w.-]{1,60}$/.test(x as string))
    if (t.length) tag = ` (${t.join(', ')})`
  } catch { /* not JSON: the status alone */ }
  return new Error(`${model} returned HTTP ${status}${tag}`)
}

export function openaiText(data: any): string {
  const choice = data?.choices?.[0]
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new StructuredOutputError(REFUSED, 'refusal')
  if (choice?.finish_reason === 'length') throw new StructuredOutputError(TRUNCATED, 'truncated')
  const text = choice?.message?.content
  if (!text) throw new Error('The provider returned no content.')
  return text
}

export function ollamaText(data: any): string {
  if (data?.done_reason === 'length') throw new StructuredOutputError(TRUNCATED, 'truncated')
  const text = data?.message?.content
  if (!text) throw new Error(data?.error ? 'Ollama reported an error.' : 'Ollama returned no content.')
  return text
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
      ...(typeof numThread === 'number' && Number.isInteger(numThread) && numThread >= 1 ? { num_thread: numThread } : {}),
    },
  }
}

/** Thread count and timeout for a local model on a CPU: slow, so patient, and told how many cores it really has. */
export async function ollamaSettings(): Promise<{ numThread?: number; timeoutMs: number; unreadable?: string }> {
  const pos = (v: string): number | undefined => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  let unreadable: string | undefined
  // A stored setting that cannot be read is not the same as one that was never set.
  const read = async (key: string): Promise<string> => {
    try { return await cred('ollama', key) } catch (e) { unreadable ??= e instanceof Error ? e.message : String(e); return '' }
  }
  const whole = (v: number | undefined) => (v !== undefined && Number.isInteger(v) ? v : undefined)
  const numThread = whole(pos(await read('num_thread'))) ?? whole(pos(process.env.OLLAMA_NUM_THREAD ?? ''))
  const seconds = pos(await read('timeout_s')) ?? pos(process.env.OLLAMA_TIMEOUT_S ?? '') ?? OLLAMA_DEFAULT_TIMEOUT_S
  return { numThread, timeoutMs: seconds * 1000, ...(unreadable ? { unreadable } : {}) }
}

/** The text of an Anthropic reply; a refusal is an error, never an empty result. */
export function anthropicText(response: { stop_reason?: string | null; content?: Array<{ type: string; text?: string }> }): string {
  if (response.stop_reason === 'refusal') throw new StructuredOutputError(REFUSED, 'refusal')
  if (response.stop_reason === 'max_tokens') throw new StructuredOutputError(TRUNCATED, 'truncated')
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
    if (!res.ok) throw providerError(String(body.model), res.status, await res.text())
    return openaiText(await res.json())
  }
  const url = (await cred('ollama', 'url')) || process.env.OLLAMA_URL || ''
  if (!url) throw new Error('Ollama is not configured — add its address in Settings.')
  const { timeoutMs, unreadable } = await ollamaSettings()
  if (unreadable) throw new Error(`Ollama's settings could not be read: ${unreadable}`)
  return ollamaSend(url, body, timeoutMs)
}

/** One Ollama chat call. Every failure is a ModelCallError that says which of four things went wrong. */
export async function ollamaSend(
  url: string, body: Record<string, unknown>, timeoutMs: number, fetchFn: typeof fetch = fetch,
): Promise<string> {
  const model = String(body.model ?? 'the model')
  try {
    const res = await fetchFn(`${url.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 404) {
      throw new ModelCallError(`The local model ${model} isn't installed. Pick one under Models.`, 'model-missing')
    }
    if (!res.ok) throw new ModelCallError(`Ollama refused the request (HTTP ${res.status}).`, 'rejected')
    return ollamaText(await res.json())
  } catch (e) {
    if (e instanceof ModelCallError || e instanceof StructuredOutputError) throw e
    const name = (e as { name?: string })?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ModelCallError(`The local model ${model} took too long (over ${Math.round(timeoutMs / 1000)} s).`, 'timeout')
    }
    if (e instanceof TypeError) {
      throw new ModelCallError(`The local model server can't be reached. Check that Ollama is running and its address under Settings.`, 'unreachable')
    }
    throw e
  }
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

  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await send(id, body) // transport errors and refusals are not parse failures: not retried
    try {
      return r.parse(JSON.parse(unwrapJson(String(text))))
    } catch { /* the error text can quote the reply; not kept */ }
  }
  throw new StructuredOutputError(`The model's reply did not match what was asked for, after two tries. Please rephrase your request.`, 'parse')
}
