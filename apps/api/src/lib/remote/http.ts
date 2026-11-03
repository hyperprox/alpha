// =============================================================================
//  HyperProx — Remote access: one small HTTP helper for both provider APIs
//
//  Errors carry the status and the provider's message, and nothing that was
//  sent: no header, no body. A message that echoes something key-shaped back
//  is redacted before it leaves here, because it ends up in a job log.
// =============================================================================

import { ProviderError } from './types'
import { redactKnownKeyShapes } from './redact'

export type FetchFn = typeof fetch

export interface JsonRequest {
  method?:  string
  headers?: Record<string, string>
  json?:    unknown
  form?:    Record<string, string>
  /** Statuses that are not an error for this call (a DELETE of something already gone: 404). */
  okStatus?: number[]
  timeoutMs?: number
}

export async function requestJson<T = any>(fetchFn: FetchFn, url: string, what: string, r: JsonRequest = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...(r.headers ?? {}) }
  let body: string | undefined
  if (r.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(r.json) }
  else if (r.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(r.form).toString() }

  let res: Response
  try {
    res = await fetchFn(url, { method: r.method ?? 'GET', headers, body, signal: AbortSignal.timeout(r.timeoutMs ?? 15_000) })
  } catch (e: any) {
    throw new ProviderError(`${what}: could not reach ${new URL(url).host} (${e?.name === 'TimeoutError' ? 'timed out' : e?.cause?.code ?? e?.message ?? 'network error'})`)
  }
  const text = await res.text().catch(() => '')
  let parsed: any = null
  if (text) { try { parsed = JSON.parse(text) } catch { parsed = null } }

  if (!res.ok && !(r.okStatus ?? []).includes(res.status)) {
    const raw = parsed && typeof parsed === 'object' ? (parsed.message ?? parsed.error ?? '') : ''
    const msg = redactKnownKeyShapes(String(typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 200))
    throw new ProviderError(`${what}: HTTP ${res.status}${msg ? ` — ${msg}` : ''}`, res.status)
  }
  return parsed as T
}
