// =============================================================================
//  HyperProx — the answer a route gives for a piece of work
//
//  `{ success: true, data }` when the work finished; otherwise one of HyperProx's own refusals (in the words and
//  with the status the route has always used for it) or, for anything else, sendFailure's plain sentence. Both
//  failures go out in the one failure envelope (lib/failure.ts).
// =============================================================================

import type { FastifyReply } from 'fastify'
import { sendFailure, sendRefusal, type FailureOptions } from '../failure'

/** A refusal as a route answers it: status, code, the sentence, and any fields a page reads beside them. */
export interface RefusalAnswer {
  status: number
  code: string
  error: string
  extra?: Record<string, unknown>
}

export interface AnswerOptions extends FailureOptions {
  /** What to say for a failure HyperProx has no words of its own for (sendFailure's `friendly`). */
  friendly?: string
  /** The route's refusals: how each error class it knows is answered. Null for anything else. */
  refusal?: (e: unknown) => RefusalAnswer | null | undefined
}

/** Answer a refusal the route recognised (see AnswerOptions.refusal). */
export function sendRefusalAnswer(reply: FastifyReply, r: RefusalAnswer) {
  return sendRefusal(reply, r.status, r.code, r.error, r.extra)
}

/** Run the work and answer with its data, a refusal, or a plain failure. */
export async function answerData(reply: FastifyReply, fn: () => Promise<unknown> | unknown, opts: AnswerOptions = {}) {
  try {
    return { success: true, data: await fn() }
  } catch (e) {
    const r = opts.refusal?.(e)
    if (r) return sendRefusalAnswer(reply, r)
    return sendFailure(reply.request, reply, e, opts.friendly, opts)
  }
}
