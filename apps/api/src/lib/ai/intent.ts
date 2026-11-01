// =============================================================================
//  HyperProx — intent match
//
//  Which template, if any, a request is for. One model call with every
//  template's summary, examples and near misses; a keyword fallback when no
//  provider can be reached. The model's answer is plain text to show, never
//  parsed for actions, and a removal or a question is never a deploy whatever
//  the model says.
// =============================================================================

import * as z from 'zod/v4'
import { StructuredOutputError, ModelCallError } from './providers'
import { TEMPLATES, getTemplate } from './templates'
import type { ModelCall } from './extract'
import { callStructured } from './providers'
import type { IntentFn, IntentResult } from './loop'

export type { IntentResult }

export const NO_TASK_ANSWER = 'I can deploy services on this cluster. Try: "Deploy Uptime Kuma at status.example.com".'
const NO_PROVIDER_QUESTION = 'I can answer questions only when an AI provider is reachable.'
const MAX_ANSWER = 2000

// ---------------------------------------------------------------------------
//  Keywords
// ---------------------------------------------------------------------------

type Kind = 'removal' | 'question' | 'task' | 'other'

// Each test reads the start of a sentence: "deploy gitea and disable signups" is a deploy, and the
// "?" in "Deploy Uptime Kuma, ok?" does not turn it into a question.
const FILLER = /^((hey|hi|hello|ok|okay|so|now|then|also|and|please|pls)\b[\s,]*)+/
const POLITE = /^(can|could|would|will)\s+you\b\s*(please\b\s*)?/
const WANT = /^(i\s+(want|need|would\s+like)|i'?d\s+like)\b\s*/
const TASK = /^(deploy|install|set\s*up|spin\s*up|stand\s*up|bring\s*up|create|launch|provision|host|add|run|make|build|give\s+me|get\s+me|let'?s)\b/
const REMOVAL = /^(remove|delete|destroy|uninstall|purge|wipe|stop|kill|disable|drop|shut\s*down|tear\s*down|get\s+rid\s+of)\b/
const QUESTION_START = /^(what|who|whom|whose|why|how|when|where|which|is|are|was|were|does|do|did|has|have|should|am|tell\s+me|explain|describe)\b/
const QUESTION_WORD = /\b(tell\s+me|explain|how|why|what)\b/

function sentenceKind(raw: string): Kind {
  const ended = /\?\s*$/.test(raw)
  let p = raw.toLowerCase().replace(/[.!?\s]+$/, '').replace(FILLER, '').trim()
  if (!p) return 'other'
  const polite = POLITE.exec(p)
  if (polite) {
    // "can you deploy …" is a request; "can you tell me how to install …" is a question.
    p = p.slice(polite[0].length)
    if (TASK.test(p)) return 'task'
    return REMOVAL.test(p) ? 'removal' : 'question'
  }
  const want = WANT.exec(p)
  if (want) {
    const rest = p.slice(want[0].length)
    if (!rest.startsWith('to ')) return 'task' // "I want a Grafana container"
    const verb = rest.slice(3)
    return TASK.test(verb) ? 'task' : REMOVAL.test(verb) ? 'removal' : QUESTION_WORD.test(verb) ? 'question' : 'other'
  }
  if (REMOVAL.test(p)) return 'removal'
  if (QUESTION_START.test(p)) return 'question'
  if (TASK.test(p)) return 'task'
  return ended || QUESTION_WORD.test(p) ? 'question' : 'other'
}

/** Per sentence: any imperative task request wins ("what is Gitea? deploy it"), then a removal, then a question. */
function classify(prompt: string): Kind {
  // A sentence ends at . ! ? ; followed by space, so "status.example.com" and "10.0.0.50" stay whole.
  const kinds = prompt.split(/(?<=[.!?;])\s+|;/).map(sentenceKind)
  for (const k of ['task', 'removal', 'question'] as const) if (kinds.includes(k)) return k
  return 'other'
}

/** Only one template today, so a task-shaped request is deploy-service. */
const KEYWORD_TEMPLATE = 'deploy-service'

/**
 * `cause`: why the model could not be asked, in words for the user. Without one the fallback is a
 * keyword match because no provider is configured at all.
 */
export function keywordIntent(prompt: string, cause?: string): IntentResult {
  const kind = classify(prompt)
  if (kind === 'task' && getTemplate(KEYWORD_TEMPLATE)) return { template: KEYWORD_TEMPLATE, question: false, answer: '' }
  if (kind === 'question') return { template: 'none', question: true, answer: `${cause ?? NO_PROVIDER_QUESTION} ${NO_TASK_ANSWER}` }
  return { template: 'none', question: false, answer: cause ? `${cause} ${NO_TASK_ANSWER}` : NO_TASK_ANSWER }
}

/** The real reason a model call failed, as a sentence to show. */
function causeOf(e: unknown): string {
  if (e instanceof ModelCallError || e instanceof StructuredOutputError) return e.message
  const msg = e instanceof Error ? e.message : String(e)
  return `The AI provider failed: ${msg.replace(/[.\s]+$/, '')}.`
}

// ---------------------------------------------------------------------------
//  Model
// ---------------------------------------------------------------------------

let systemPrompt: string | undefined
/** Built once from the registry: static, so it caches. */
function intentSystemPrompt(): string {
  if (systemPrompt) return systemPrompt
  const blocks = Object.values(TEMPLATES).map(t => [
    `Template ${t.id}: ${t.summary}`,
    'Requests for it:', ...t.intents.map(s => `- ${s}`),
    'Not requests for it:', ...t.nearMisses.map(s => `- ${s}`),
  ].join('\n'))
  systemPrompt = [
    'Decide which task template the user is asking for.',
    ...blocks,
    'template: the id when the user asks for that task to be done, otherwise none.',
    'question: true when the user is asking a question rather than asking for something to be done.',
    'answer: for none or a question, a short plain-text reply; otherwise an empty string.',
  ].join('\n\n')
  return systemPrompt
}

function intentRequest(prompt: string) {
  const ids = Object.keys(TEMPLATES)
  const shape = z.object({ template: z.enum(['none', ...ids] as [string, ...string[]]), question: z.boolean(), answer: z.string() })
  return {
    name: 'intent',
    system: intentSystemPrompt(),
    user: prompt,
    schema: {
      type: 'object',
      properties: {
        template: { enum: [...ids, 'none'] },
        question: { type: 'boolean' },
        answer: { type: 'string' },
      },
      required: ['template', 'question', 'answer'],
      additionalProperties: false,
    },
    parse: (raw: unknown) => shape.parse(raw),
  }
}

export async function matchIntent(prompt: string, opts: { call?: ModelCall } = {}): Promise<IntentResult> {
  const call: ModelCall = opts.call ?? (r => callStructured(r))
  let got: { template: string; question: boolean; answer: string }
  try {
    got = await call(intentRequest(prompt))
  } catch (e) {
    // A refusal is the model's answer, not an outage: keywords must not route around it.
    if (e instanceof StructuredOutputError && e.kind === 'refusal') return { template: 'none', question: false, answer: e.message }
    return keywordIntent(prompt, causeOf(e))
  }

  const prose = got.answer.trim().slice(0, MAX_ANSWER)
  const kind = classify(prompt)
  const known = got.template !== 'none' && !!getTemplate(got.template)
  if (!known || got.question || kind === 'removal' || kind === 'question') {
    const question = got.question || kind === 'question'
    // The model's prose is kept only where it was asked for: a reply to something that is not a task.
    return { template: 'none', question, answer: prose || NO_TASK_ANSWER }
  }
  return { template: got.template, question: false, answer: '' }
}

const _shape: IntentFn = matchIntent
void _shape
