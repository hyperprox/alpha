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
import { StructuredOutputError } from './providers'
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

const REMOVAL = /\b(remove|delete|destroy|uninstall|purge|wipe|stop|kill|disable|shut\s*down|tear\s*down|get\s+rid\s+of)\b/
const POLITE = /^(please\s+)?(can|could|would|will)\s+you\b|^please\b/
const QUESTION = /^(what|who|whom|whose|why|how|when|where|which|is|are|was|were|does|do|did|has|have|should|am)\b/
const TASK = /\b(deploy|install|set\s*up|spin\s*up|stand\s*up|bring\s*up|create|launch|provision|host|add|run|i\s+(want|need)|i'?d\s+like|give\s+me)\b/

function classify(prompt: string): Kind {
  const p = prompt.toLowerCase().replace(/\s+/g, ' ').trim()
  if (REMOVAL.test(p)) return 'removal'
  if (POLITE.test(p)) return TASK.test(p) ? 'task' : 'question'
  if (QUESTION.test(p) || p.endsWith('?')) return 'question'
  return TASK.test(p) ? 'task' : 'other'
}

/** Only one template today, so a task-shaped request is deploy-service. */
const KEYWORD_TEMPLATE = 'deploy-service'

export function keywordIntent(prompt: string): IntentResult {
  const kind = classify(prompt)
  if (kind === 'task' && getTemplate(KEYWORD_TEMPLATE)) return { template: KEYWORD_TEMPLATE, question: false, answer: '' }
  if (kind === 'question') return { template: 'none', question: true, answer: `${NO_PROVIDER_QUESTION} ${NO_TASK_ANSWER}` }
  return { template: 'none', question: false, answer: NO_TASK_ANSWER }
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
    return keywordIntent(prompt)
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
