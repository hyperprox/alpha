// =============================================================================
//  HyperProx — field extraction
//
//  The boundary where model output enters. The model is offered the template's
//  extractable fields and nothing else; whatever it sends back is read key by
//  key. A key that is not an extractable field is dropped and logged by name,
//  a null is "not stated", and a value is coerced or reported invalid — never
//  repaired into something the person did not say.
// =============================================================================

import { callStructured, type StructuredRequest } from './providers'
import { coerce, extractJsonSchema } from './templates/fields'
import type { FieldSpec, TaskTemplate, TemplateFacts } from './templates/types'
import type { ExtractFn, Extraction } from './loop'

export type { Extraction }

/** One structured model call. Tests pass callStructured with a faked send layer. */
export type ModelCall = <T>(r: StructuredRequest<T>) => Promise<T>
const defaultCall: ModelCall = r => callStructured(r)

export type ExtractLog = (msg: string, data: object) => void
const defaultLog: ExtractLog = (msg, data) => console.warn(msg, JSON.stringify(data))

export const EXTRACT_RULE = "Fill fields only from the user's words. Use null when a field is not stated. Never guess."

/** Offered to the model: exactly the properties extractJsonSchema emits. */
function offered(t: TaskTemplate): FieldSpec[] {
  const props = Object.keys((extractJsonSchema(t, {}) as { properties: Record<string, unknown> }).properties)
  return t.fields.filter(s => s.extract && props.includes(s.name))
}

const prompts = new Map<string, string>()

/**
 * The template's field descriptions and the never-guess rule. Static per template version, so a
 * provider can cache it and a slow local model reads the same short prefix every time; the values a
 * field may take (services, nodes) travel in the schema's enums, not here.
 */
export function extractSystemPrompt(t: TaskTemplate): string {
  const key = `${t.id}@${t.version}`
  const cached = prompts.get(key)
  if (cached) return cached
  const p = [
    `Read the user's request for this task: ${t.summary}`,
    'Return one JSON object with exactly these fields:',
    ...offered(t).map(s => `- ${s.name}: ${s.describe}`),
    EXTRACT_RULE,
  ].join('\n')
  prompts.set(key, p)
  return p
}

function userMessage(text: string, asking?: { field: string; question: string }): string {
  if (!asking) return text
  return `The user was asked about the field ${asking.field}: "${asking.question}"\nTheir answer: ${text}`
}

/** A reply must be a plain JSON object; anything else is a parse failure, so callStructured retries once. */
function asObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the reply is not an object')
  return raw as Record<string, unknown>
}

const EXPECTED: Record<FieldSpec['type'], string> = {
  string: 'text', int: 'a whole number', bool: 'true or false', enum: 'one of the choices',
  ipv4cidr: 'an IPv4 address or dhcp', hostname: 'a valid hostname',
}

// A key echoed into a log line is still model output: bound and flatten it.
const keyName = (k: string): string => k.replace(/[^\w.-]/g, '?').slice(0, 64)

export async function extractFields(
  t: TaskTemplate,
  text: string,
  facts: TemplateFacts,
  opts: { asking?: { field: string; question: string }; call?: ModelCall; log?: ExtractLog } = {},
): Promise<Extraction> {
  const call = opts.call ?? defaultCall
  const log = opts.log ?? defaultLog
  const enums = t.enums(facts)
  const specs = new Map(offered(t).map(s => [s.name, s]))

  // parse keeps the raw object: unknown keys must be seen, and named, before anything strips them.
  const raw = await call({
    name: `extract_${t.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    system: extractSystemPrompt(t),
    user: userMessage(text, opts.asking),
    schema: extractJsonSchema(t, enums),
    parse: asObject,
  })

  const out: Extraction = { values: {}, dropped: [], invalid: [] }
  for (const k of Object.keys(raw)) {
    const spec = specs.get(k) // a Map, so "__proto__" or "toString" is never a field
    if (!spec) { out.dropped.push(keyName(k)); continue }
    const v = raw[k]
    if (v === null || v === undefined) continue
    const c = coerce(spec, v, enums[k])
    if (c.ok) out.values[k] = c.value
    // The raw value is held for the loop to ask about; the message never repeats it.
    else out.invalid.push({ field: k, raw: v, message: `${k} is not ${EXPECTED[spec.type]}` })
  }
  if (out.dropped.length) log('ai.extract.dropped', { template: t.id, keys: out.dropped })
  return out
}

// Held to the loop's declared shape, so the loop can be driven by this or a fake interchangeably.
const _shape: ExtractFn = extractFields
void _shape
