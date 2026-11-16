// Who made a request, as routes and audit rows record it (lib/http/request-actor.ts), and the one failure envelope
// every failure goes out in (lib/failure.ts failureEnvelope, sendRefusal; lib/http/answer.ts answerData).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { actorOf, actorWords, auditBy, contextActor, contextIsAdmin, isAdmin, tokenNameOf } from '../src/lib/http/request-actor'
import { requestContext } from '../src/lib/auth'
import { scrubDetails } from '../src/lib/audit'
import { codeForStatus, failureEnvelope, sendRefusal } from '../src/lib/failure'
import { installRequestIds } from '../src/lib/request-id'
import { answerData } from '../src/lib/http/answer'

test('auditBy: a person is `by` alone; a token adds its name, from the actor or from its "token:" session name', () => {
  assert.deepEqual(auditBy({ email: 'admin@example.com', token: null }), { by: 'admin@example.com' })
  assert.deepEqual(auditBy({ email: 'token:nightly', token: 'nightly' }), { by: 'token:nightly', tokenName: 'nightly' })
  assert.deepEqual(auditBy({ email: 'token:nightly' }), { by: 'token:nightly', tokenName: 'nightly' }, 'an actor type without the token field')
  assert.deepEqual(auditBy('token:nightly'), { by: 'token:nightly', tokenName: 'nightly' }, 'the `by` text handed down to a service')
  assert.deepEqual(auditBy('token:nightly (API token nightly)'), { by: 'token:nightly (API token nightly)', tokenName: 'nightly' }, 'actorWords\' form')
  assert.deepEqual(auditBy('admin@example.com'), { by: 'admin@example.com' })
  assert.deepEqual(auditBy(null), { by: null })
  assert.deepEqual(auditBy(undefined), { by: undefined })
})

test('tokenNameOf reads only a token session name: never part of an email or free text', () => {
  assert.equal(tokenNameOf('token:ci.deploy-2'), 'ci.deploy-2')
  assert.equal(tokenNameOf('someone@example.com'), null)
  assert.equal(tokenNameOf('token:'), null)
  assert.equal(tokenNameOf('token:a b'), null)
  assert.equal(tokenNameOf('xtoken:abc'), null)
  assert.equal(tokenNameOf('token:abc (API token other)'), null, 'the two names must agree')
  assert.equal(tokenNameOf(null), null)
})

test('scrubDetails keeps the token name auditBy records and still drops anything named like a secret', () => {
  const kept = scrubDetails({ ...auditBy('token:nightly'), token: 'hpx_secret_value', apiKey: 'k', password: 'p', node: 'pve1' })
  assert.deepEqual(kept, { by: 'token:nightly', tokenName: 'nightly', node: 'pve1' })
})

test('actorOf and contextActor: the same actor from the request and from the request context', async () => {
  const person: any = { session: { email: 'admin@example.com', role: 'admin', sid: 's1' } }
  assert.deepEqual(actorOf(person), { email: 'admin@example.com', role: 'admin', sid: 's1', token: null })
  assert.equal(isAdmin(person), true)
  const tok: any = { session: { email: 'token:nightly', role: 'operator', sid: 'token:t1' }, apiToken: { id: 't1', name: 'nightly' } }
  assert.deepEqual(actorOf(tok), { email: 'token:nightly', role: 'operator', sid: 'token:t1', token: 'nightly' })
  assert.equal(isAdmin(tok), false)
  assert.deepEqual(actorOf({} as any), { email: 'unknown', role: 'viewer', sid: '', token: null })

  assert.deepEqual(contextActor(), { email: 'unknown', role: 'viewer', sid: '', token: null }, 'outside any request')
  assert.equal(contextIsAdmin(), false)
  await requestContext.run({ sid: 'token:t1', email: 'token:nightly', role: 'admin' }, async () => {
    assert.deepEqual(contextActor(), { email: 'token:nightly', role: 'admin', sid: 'token:t1', token: 'nightly' })
    assert.equal(contextIsAdmin(), true)
  })
  await requestContext.run({ sid: 's1', email: 'op@example.com', role: 'operator' }, async () => {
    assert.deepEqual(contextActor(), { email: 'op@example.com', role: 'operator', sid: 's1', token: null })
    assert.equal(contextIsAdmin(), false)
  })
  assert.equal(actorWords({ email: 'a@example.com', token: 'n' }), 'a@example.com (API token n)')
})

test('failureEnvelope: fills ok, success, code and requestId; never changes a route\'s words or its other fields', () => {
  assert.deepEqual(failureEnvelope({ error: 'No job j1' }, 404, 'r1'), { ok: false, success: false, error: 'No job j1', code: 'not_found', requestId: 'r1' })
  assert.deepEqual(
    failureEnvelope({ error: 'A job is running', runningJobId: 'j2' }, 409, 'r1'),
    { ok: false, success: false, error: 'A job is running', runningJobId: 'j2', code: 'conflict', requestId: 'r1' })
  assert.deepEqual(
    failureEnvelope({ success: false, code: 'cert_changed', error: 'Changed', presented: 'AA', requestId: 'r0' }, 409, 'r1'),
    { ok: false, success: false, code: 'cert_changed', error: 'Changed', presented: 'AA', requestId: 'r0' }, 'its own code and reference are kept')
  assert.deepEqual(failureEnvelope({ message: 'Route GET:/x not found', statusCode: 404 }, 404, 'r1'),
    { ok: false, success: false, message: 'Route GET:/x not found', statusCode: 404, error: 'Route GET:/x not found', code: 'not_found', requestId: 'r1' })
  assert.deepEqual(failureEnvelope({ ok: false, locked: true }, 423, 'r1'), { ok: false, success: false, locked: true, code: 'locked', requestId: 'r1' }, 'no sentence is made up')
  assert.equal(failureEnvelope({ ok: true }, 409, 'r1'), null, 'a body that says it succeeded is left alone')
  assert.equal(failureEnvelope([1, 2], 400, 'r1'), null)
  assert.equal(failureEnvelope({ error: 'x' }, 200, 'r1'), null, 'success statuses are out of scope')
  assert.equal(codeForStatus(400), 'invalid_request'); assert.equal(codeForStatus(503), 'unavailable'); assert.equal(codeForStatus(418), 'refused')
})

test('through a server: every JSON failure is in the one envelope, whichever way the route answered it', async () => {
  const app = Fastify({ logger: false })
  installRequestIds(app)
  app.get('/old-updates', async (_q, r) => r.status(409).send({ error: 'A check is already running.', status: { running: true } }))
  app.get('/old-notify', async (_q, r) => r.status(404).send({ ok: false, error: 'No such channel.' }))
  app.get('/refusal', async (_q, r) => sendRefusal(r, 422, 'refused', 'That guest is left alone.', { problems: ['p1'] }))
  app.get('/answer', async (_q, r) => answerData(r, async () => { throw Object.assign(new Error('raw upstream text'), { code: 'ECONNREFUSED' }) }, { friendly: 'The NAS did not answer.' }))
  app.get('/answer-refusal', async (_q, r) => answerData(r, async () => { throw new Error('gone') }, { refusal: () => ({ status: 503, code: 'ceph_unavailable', error: 'No Ceph here.', extra: { cephAvailable: false } }) }))
  app.get('/ok', async () => ({ success: true, data: 1 }))
  app.get('/text', async (_q, r) => r.status(500).type('text/plain').send('plain'))
  await app.ready()
  try {
    const shape = (b: any) => { assert.equal(b.ok, false); assert.equal(b.success, false); assert.equal(typeof b.error, 'string'); assert.equal(typeof b.code, 'string'); assert.equal(typeof b.requestId, 'string') }
    const u = await app.inject('/old-updates')
    assert.equal(u.statusCode, 409); shape(u.json())
    assert.equal(u.json().error, 'A check is already running.'); assert.deepEqual(u.json().status, { running: true }); assert.equal(u.json().code, 'conflict')
    assert.equal(u.json().requestId, u.headers['x-request-id'])
    const n = await app.inject('/old-notify')
    assert.equal(n.statusCode, 404); shape(n.json()); assert.equal(n.json().error, 'No such channel.')
    const f = await app.inject('/refusal')
    assert.equal(f.statusCode, 422); shape(f.json()); assert.equal(f.json().code, 'refused'); assert.deepEqual(f.json().problems, ['p1'])
    const a = await app.inject('/answer')
    assert.equal(a.statusCode, 502); shape(a.json()); assert.equal(a.json().error, 'The NAS did not answer.'); assert.ok(!a.body.includes('raw upstream text'))
    const c = await app.inject('/answer-refusal')
    assert.equal(c.statusCode, 503); shape(c.json()); assert.equal(c.json().cephAvailable, false); assert.equal(c.json().code, 'ceph_unavailable')
    assert.deepEqual((await app.inject('/ok')).json(), { success: true, data: 1 }, 'success bodies are untouched')
    assert.equal((await app.inject('/text')).body, 'plain')
  } finally { await app.close() }
})
