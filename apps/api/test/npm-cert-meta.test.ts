// NPM 2.13+ refuses the per-request Let's Encrypt fields; the client must fall back without creating twice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NPMClient } from '../src/lib/npm-client'

function client(refuse: (body: any) => string | null) {
  const c: any = Object.create(NPMClient.prototype)
  const sent: any[] = []
  c.req = async (_m: string, _p: string, body: any) => {
    sent.push(body)
    const why = refuse(body)
    if (why) throw new Error(`NPM POST /nginx/certificates failed 400: ${why}`)
    return { id: 7, nice_name: body.nice_name }
  }
  return { c: c as NPMClient, sent }
}

test('old NPM: the first request (with email and agreement) is used', async () => {
  const { c, sent } = client(() => null)
  const r = await c.requestCertificate({ domain_names: ['a.example.com'], provider: 'letsencrypt', nice_name: 'a', letsencrypt_email: 'x@example.com' })
  assert.equal(r.id, 7); assert.equal(sent.length, 1); assert.equal(sent[0].meta.letsencrypt_agree, true)
})

test('new NPM: refused extra meta fields fall back to dns_challenge only', async () => {
  const { c, sent } = client(b => b.meta?.letsencrypt_email ? 'data/meta must NOT have additional properties' : null)
  const r = await c.requestCertificate({ domain_names: ['a.example.com'], provider: 'letsencrypt', nice_name: 'a', letsencrypt_email: 'x@example.com' })
  assert.equal(r.id, 7); assert.equal(sent.length, 2); assert.deepEqual(sent[1].meta, { dns_challenge: false })
})

test('other errors are not retried', async () => {
  const { c, sent } = client(() => 'Some other problem')
  await assert.rejects(c.requestCertificate({ domain_names: ['a.example.com'], provider: 'letsencrypt', nice_name: 'a', letsencrypt_email: 'x@example.com' }), /Some other problem/)
  assert.equal(sent.length, 1)
})
