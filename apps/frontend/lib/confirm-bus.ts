// =============================================================================
//  In-page confirmation — client side
//
//  Important actions are confirmed on the page, never with the master password (the API's lib/confirm.ts). The API
//  answers such a request, the first time, with
//    403 { code: 'confirm_required', error, confirm: { token, summary, expiresAt } }
//  and runs nothing. The fetch wrapper (lib/api.ts) catches that once for every page: it shows the summary in the
//  shared ConfirmDialog (components/vault/ConfirmHost.tsx) and, on Confirm, sends the identical request again with
//  the token. Pages see only the final answer; Cancel comes back as `confirm_cancelled`.
//
//  A page whose own dialog already said what will happen and was confirmed (a preview with an Apply button, a typed
//  name) marks the request with IN_PAGE: the token is then exchanged without a second dialog.
// =============================================================================

export const CONFIRM_HEADER = 'X-HyperProx-Confirm'
/** Client-only marker: this page already showed the confirmation for this request. Never sent to the API. */
export const IN_PAGE_HEADER = 'X-HyperProx-Confirmed-In-Page'
/** Headers for a request the page itself has just confirmed (see the note at the top). */
export const IN_PAGE: Record<string, string> = { [IN_PAGE_HEADER]: '1' }

export const CANCELLED_CODE = 'confirm_cancelled'
export const CANCELLED_TEXT = 'Cancelled. Nothing was done.'

export interface ConfirmRequest {
  /** What will happen, in a sentence, from the API. */
  summary: string
}

type Asker = (req: ConfirmRequest) => Promise<boolean>
let asker: Asker | null = null

/** ConfirmHost registers itself here while mounted. Returns the unregister function. */
export function setConfirmAsker(fn: Asker | null): () => void {
  asker = fn
  return () => { if (asker === fn) asker = null }
}

/** Ask the person. With no dialog mounted (nothing can be shown), the answer is no. */
export function askConfirm(req: ConfirmRequest): Promise<boolean> {
  return asker ? asker(req) : Promise.resolve(false)
}

/** The confirmation an API answer asks for, or null when it is anything else. */
export function confirmAsked(status: number, body: unknown): { token: string; summary: string } | null {
  if (status !== 403 || !body || typeof body !== 'object') return null
  const b = body as any
  if (b.code !== 'confirm_required' || !b.confirm || typeof b.confirm.token !== 'string' || !b.confirm.token) return null
  const summary = typeof b.confirm.summary === 'string' && b.confirm.summary.trim() ? b.confirm.summary.trim()
    : typeof b.error === 'string' ? b.error : 'Do this now?'
  return { token: b.confirm.token, summary: summary.slice(0, 400) }
}

/** The answer a page gets when the person pressed Cancel: nothing was sent, nothing was done. */
export function cancelledResponse(): Response {
  return new Response(JSON.stringify({ ok: false, success: false, code: CANCELLED_CODE, error: CANCELLED_TEXT }), {
    status: 499, headers: { 'Content-Type': 'application/json' },
  })
}
