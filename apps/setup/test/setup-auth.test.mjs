// Security review 2026-10-18, findings 1 and 2: the setup API must refuse callers without the setup
// key, and must not answer cross-origin. Starts the real setup server against a throwaway .env.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'hpx-setup-'))
const envFile = join(dir, '.env')
const PORT = 39000 + Math.floor(Math.random() * 1000)
const KEY = 'a'.repeat(64)
let proc

before(async () => {
  writeFileSync(envFile, `SETUP_SECRET=${KEY}\nENCRYPTION_KEY=${'b'.repeat(64)}\n`)
  proc = spawn(process.execPath, [join(here, '..', 'setup.js')], {
    env: { ...process.env, SETUP_PORT: String(PORT), ENV_FILE_PATH: envFile, SETUP_COMPLETE: 'false' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('setup server did not start')
})
after(() => proc?.kill())

const call = (headers = {}) =>
  fetch(`http://127.0.0.1:${PORT}/api/setup/create-admin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }),
  })

test('create-admin without the setup key is refused and writes nothing', async () => {
  const r = await call()
  assert.equal(r.status, 401)
  assert.doesNotMatch(readFileSync(envFile, 'utf8'), /SETUP_ADMIN_HASH/)
})

test('a wrong setup key is refused', async () => {
  assert.equal((await call({ 'x-setup-key': 'nope' })).status, 401)
})

test('no wildcard CORS on any answer', async () => {
  const r = await call({ origin: 'https://evil.example' })
  assert.equal(r.headers.get('access-control-allow-origin'), null)
})

test('with the key, the admin is created (and a reloaded wizard may redo it)', async () => {
  const first = await call({ 'x-setup-key': KEY })
  assert.notEqual(first.status, 401)
  assert.match(readFileSync(envFile, 'utf8'), /SETUP_ADMIN_HASH=/)
  assert.notEqual((await call({ 'x-setup-key': KEY })).status, 401)
})

test('the wizard page itself still loads without the key', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/`)).status, 200)
})
