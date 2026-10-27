// `hyperprox token ...`: the TypeScript side against an in-memory store, and the
// bash dispatch in bin/hyperprox against a stub of the built CLI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runTokenCli, CLI_ACTOR } from '../src/cli/api-token'
import { MemoryApiTokenStore, hashToken, setApiTokenStore, verifyApiToken } from '../src/lib/api-tokens'

function io() {
  const out: string[] = [], err: string[] = []
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
}

test('create prints the token once, alone on stdout; stores only its hash', async () => {
  const store = new MemoryApiTokenStore()
  const c = io()
  assert.equal(await runTokenCli(['create', 'claude-code', '--role', 'admin', '--expires-days', '90'], store, c.io), 0)
  assert.equal(c.out.length, 1)
  const token = c.out[0]
  assert.match(token, /^hpx_[A-Za-z0-9_-]{43}$/)
  assert.equal(c.err.join('\n').includes(token), false)
  assert.equal(store.rows.length, 1)
  const row = store.rows[0]
  assert.equal(row.name, 'claude-code')
  assert.equal(row.role, 'admin')
  assert.equal(row.createdBy, CLI_ACTOR)
  assert.equal(row.tokenHash, hashToken(token))
  const days = (row.expiresAt!.getTime() - row.createdAt.getTime()) / 86_400_000
  assert.ok(Math.abs(days - 90) < 0.01)
  assert.deepEqual(store.audits.map(a => [a.action, a.resource, a.details!.by]), [['api_token.create', 'claude-code', CLI_ACTOR]])
  assert.equal(JSON.stringify(store.audits).includes(token), false)
})

test('create: defaults to admin and no expiry; --flag=value form; bad input exits non-zero', async () => {
  const store = new MemoryApiTokenStore()
  assert.equal(await runTokenCli(['create', 'a'], store, io().io), 0)
  assert.equal(store.rows[0].role, 'admin')
  assert.equal(store.rows[0].expiresAt, null)
  assert.equal(await runTokenCli(['create', 'b', '--role=viewer'], store, io().io), 0)
  assert.equal(store.rows[1].role, 'viewer')

  for (const args of [
    ['create', 'a'],                              // name taken
    ['create', 'c', '--role', 'owner'],           // owner is for people
    ['create', 'c', '--role', 'root'],
    ['create', 'bad name'],
    ['create', 'c', '--expires-days', '0'],
    ['create', 'c', '--expires-days', 'soon'],
    ['create', 'c', '--role'],
  ]) {
    const c = io()
    assert.equal(await runTokenCli(args, store, c.io), 1, args.join(' '))
    assert.equal(c.out.length, 0, args.join(' '))
  }
  for (const args of [['create'], ['create', 'x', 'y'], ['create', 'x', '--colour', 'red'], ['list', 'x'], ['revoke'], ['frobnicate'], []]) {
    assert.equal(await runTokenCli(args, store, io().io), 2, args.join(' '))
  }
  assert.equal(store.rows.length, 2)
})

test('list shows name, role, state and id; never a hash', async () => {
  const store = new MemoryApiTokenStore()
  await runTokenCli(['create', 'one'], store, io().io)
  await runTokenCli(['create', 'two', '--role', 'operator'], store, io().io)
  await runTokenCli(['revoke', 'one'], store, io().io)
  const c = io()
  assert.equal(await runTokenCli(['list'], store, c.io), 0)
  const text = c.out.join('\n')
  assert.match(c.out[0], /^NAME\s+ROLE\s+STATE/)
  assert.match(text, /one\s+admin\s+revoked/)
  assert.match(text, /two\s+operator\s+active/)
  for (const r of store.rows) {
    assert.ok(text.includes(r.id))
    assert.equal(text.includes(r.tokenHash), false)
  }
  const empty = io()
  assert.equal(await runTokenCli(['list'], new MemoryApiTokenStore(), empty.io), 0)
  assert.deepEqual(empty.out, [])
})

test('revoke by name or id; the token stops verifying; unknown is an error; twice is fine', async () => {
  const store = new MemoryApiTokenStore()
  setApiTokenStore(store)
  const a = io(); await runTokenCli(['create', 'by-name'], store, a.io)
  const b = io(); await runTokenCli(['create', 'by-id'], store, b.io)
  assert.ok(await verifyApiToken(a.out[0]))
  assert.equal(await runTokenCli(['revoke', 'by-name'], store, io().io), 0)
  assert.equal(await runTokenCli(['revoke', store.rows[1].id], store, io().io), 0)
  assert.ok(store.rows.every(r => r.revokedAt))
  assert.equal(await verifyApiToken(a.out[0]), null)
  assert.equal(await verifyApiToken(b.out[0]), null)
  const again = io()
  assert.equal(await runTokenCli(['revoke', 'by-name'], store, again.io), 0)
  assert.match(again.out[0], /already revoked/)
  assert.equal(await runTokenCli(['revoke', 'nobody'], store, io().io), 1)
  assert.equal(store.audits.filter(x => x.action === 'api_token.revoke').length, 2)
  setApiTokenStore(null)
})

test('bin/hyperprox token: passes arguments and DATABASE_URL from .env to the built CLI', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apitok-cli-'))
  try {
    fs.mkdirSync(path.join(dir, 'apps/api/dist/cli'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'apps/api/dist/cli/api-token.js'),
      'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), db: process.env.DATABASE_URL }))\n')
    fs.writeFileSync(path.join(dir, '.env'), "API_PORT=3002\nDATABASE_URL='postgresql://u:p@localhost:5432/db'\n", { mode: 0o600 })
    const bin = path.resolve(__dirname, '../../../bin/hyperprox')
    const env = { ...process.env, HYPERPROX_DIR: dir }
    delete (env as any).DATABASE_URL
    const out = execFileSync('bash', [bin, 'token', 'create', 'ci', '--role', 'viewer'], { env, encoding: 'utf8' })
    assert.deepEqual(JSON.parse(out), { args: ['create', 'ci', '--role', 'viewer'], db: 'postgresql://u:p@localhost:5432/db' })

    fs.rmSync(path.join(dir, 'apps/api/dist/cli/api-token.js'))
    const missing = spawnSync('bash', [bin, 'token', 'list'], { env, encoding: 'utf8' })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /predates API tokens/)

    const usage = spawnSync('bash', [bin, 'nope'], { env, encoding: 'utf8' })
    assert.equal(usage.status, 2)
    assert.match(usage.stderr, /token/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
