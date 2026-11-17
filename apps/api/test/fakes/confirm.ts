// For tests written when important actions asked for the master password again: a session that "re-confirmed"
// (POST /api/auth/reconfirm, answered 200) now stands for a person who presses Confirm on every confirmation the API
// asks for (lib/confirm.ts). Any other request sees the API's answer unchanged, 403 confirm_required included.
// The confirmation itself is real: the request is sent a second time with the token the API handed out.
import type { FastifyInstance } from 'fastify'
import { hasAuditSink, setAuditSink } from '../../src/lib/audit'

type Inject = FastifyInstance['inject']

/** Patch app.inject (the promise form) as above. Returns the app. */
export function confirmAfterReconfirm<T extends FastifyInstance>(app: T): T {
  const original = app.inject.bind(app) as (o: any) => Promise<any>
  const confirmed = new Set<string>()
  const cookieOf = (o: any): string => String(o?.headers?.cookie ?? o?.cookies?.hyperprox_token ?? '')
  ;(app as any).inject = (async (o: any) => {
    const res = await original(o)
    const url = typeof o === 'string' ? o : o?.url
    const cookie = cookieOf(o)
    if (typeof url === 'string' && url.split('?')[0] === '/api/auth/reconfirm' && res.statusCode === 200 && cookie) confirmed.add(cookie)
    if (res.statusCode !== 403 || !cookie || !confirmed.has(cookie)) return res
    let body: any = null
    try { body = res.json() } catch { return res }
    if (body?.code !== 'confirm_required' || typeof body?.confirm?.token !== 'string') return res
    // The confirmation is audited before the action runs; a test with no audit sink of its own gets a quiet one.
    if (!hasAuditSink()) setAuditSink({ async write() {} })
    return original({ ...o, headers: { ...(o.headers ?? {}), 'x-hyperprox-confirm': body.confirm.token } })
  }) as Inject
  return app
}

/** One request as a person who presses Confirm: sent, and if the API asks for a confirmation, sent again with it. */
export async function injectConfirmed(app: FastifyInstance, o: any): Promise<any> {
  const res = await (app.inject as any)(o)
  if (res.statusCode !== 403) return res
  let body: any = null
  try { body = res.json() } catch { return res }
  if (body?.code !== 'confirm_required' || typeof body?.confirm?.token !== 'string') return res
  if (!hasAuditSink()) setAuditSink({ async write() {} })
  return (app.inject as any)({ ...o, headers: { ...(o.headers ?? {}), 'x-hyperprox-confirm': body.confirm.token } })
}
