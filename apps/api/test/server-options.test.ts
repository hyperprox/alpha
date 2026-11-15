// What the log may never carry: an error's attached bodies and headers, and credentials in logged objects.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { safeErr, safeLogger, serverOptions } from '../src/lib/server-options'

function capture(opts: any) {
  const out: any[] = []
  const log = pino(safeLogger(opts), { write: (s: string) => out.push(JSON.parse(s)) } as any)
  return { log, out }
}

test('an error is logged as type, message, stack, code and status only, with its cause the same', () => {
  class VaultHttpError extends Error { status = 401; body = 'SECRET-BODY'; config = { headers: { Authorization: 'Bearer SECRET-TOKEN' } } }
  const inner: any = new Error('inner'); inner.response = { data: 'SECRET-INNER' }; inner.code = 'ECONNRESET'
  const e: any = new VaultHttpError('refused'); e.cause = inner
  const { log, out } = capture({ level: 'info' })
  log.error({ err: e }, 'it failed')
  const line = JSON.stringify(out[0])
  assert.ok(!line.includes('SECRET'), line)
  assert.equal(out[0].err.type, 'VaultHttpError')
  assert.equal(out[0].err.message, 'refused')
  assert.equal(out[0].err.status, 401)
  assert.ok(out[0].err.stack)
  assert.equal(out[0].err.cause.code, 'ECONNRESET')
  assert.deepEqual(Object.keys(safeErr(e) as object).sort(), ['cause', 'message', 'stack', 'status', 'type'])
})

test('credentials in logged objects and request headers are redacted', () => {
  const { log, out } = capture({ level: 'info' })
  log.info({ req: { headers: { authorization: 'Bearer AAA', cookie: 'sid=BBB', accept: 'x' } }, job: { password: 'CCC', token: 'DDD', secret: 'EEE', name: 'ok' } }, 'hello')
  const line = JSON.stringify(out[0])
  for (const w of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']) assert.ok(!line.includes(w), `${w} leaked: ${line}`)
  assert.equal(out[0].job.name, 'ok')
  assert.equal(out[0].req.headers.accept, 'x')
})

test('serverOptions applies it to the logger options', () => {
  const o: any = serverOptions({ level: 'info' })
  assert.equal(typeof o.logger.serializers.err, 'function')
  assert.ok(o.logger.redact.paths.includes('req.headers.authorization'))
  assert.equal(serverOptions(false).logger, false)
})
