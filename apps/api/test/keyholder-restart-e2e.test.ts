// End to end, with real processes: the API is killed and started again (what deploy.sh does) and
// HyperProx is still unlocked; the keyholder is killed and HyperProx is locked.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startKeyholder, waitFor, type RunningKeyholder } from './fakes/keyholder'
import { GOOD_CODE } from './fakes/fake-broker'

const CHILD = path.join(__dirname, 'fakes', 'keyholder-api-child.ts')
const SECRET = 'e2e-secret-91c2d7'
const procs: ChildProcess[] = []
let k: RunningKeyholder | null = null
after(async () => { for (const p of procs) p.kill('SIGKILL'); await k?.stop('SIGKILL') })

async function startApi(socket: string): Promise<{ proc: ChildProcess; base: string; output(): string }> {
  const proc = spawn(process.execPath, ['--import', 'tsx', CHILD], {
    env: { ...process.env, VAULT_KEYHOLDER_SOCKET: socket, HYPERPROX_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'khtest-e2e-')), VAULT_IDLE_LOCK_MINUTES: '30' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  procs.push(proc)
  let out = '', err = ''
  proc.stdout!.on('data', d => { out += d })
  proc.stderr!.on('data', d => { err += d })
  await waitFor(() => /"port":\d+/.test(out) || proc.exitCode !== null, 30_000, 'API child to listen')
  if (proc.exitCode !== null) throw new Error(`API child exited: ${err}`)
  const port = JSON.parse(out.split('\n')[0]).port
  return { proc, base: `http://127.0.0.1:${port}`, output: () => out + err }
}

async function call(base: string, method: string, url: string, cookie?: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') ?? '' }
}

test('API process restart: still unlocked, same session, same secrets; keyholder restart: locked', async () => {
  k = await startKeyholder()
  const api1 = await startApi(k.socket)
  const signIn = await call(api1.base, 'POST', '/api/auth/sign-in', undefined, { email: 'owner@example.com', password: 'correct horse battery staple', code: GOOD_CODE })
  assert.equal(signIn.status, 200, JSON.stringify(signIn.json))
  const cookie = signIn.setCookie.split(';')[0]
  assert.equal((await call(api1.base, 'PUT', '/api/test/probe', cookie, { value: SECRET })).status, 200)
  await new Promise(r => setTimeout(r, 100))

  api1.proc.kill('SIGKILL')               // the API dies (or is restarted by a deploy)
  await new Promise(r => api1.proc.once('exit', r))

  const api2 = await startApi(k.socket)
  const st = await call(api2.base, 'GET', '/api/auth/status', cookie)
  assert.equal(st.json.locked, false)
  assert.deepEqual(st.json.user, { email: 'owner@example.com', role: 'owner' })
  const probe = await call(api2.base, 'GET', '/api/test/probe', cookie)
  assert.equal(probe.status, 200)
  assert.equal(probe.json.value, SECRET)
  assert.equal((await call(api2.base, 'POST', '/api/auth/reconfirm', cookie, { password: 'correct horse battery staple' })).status, 200)
  assert.match(api2.output(), /restored from the keyholder/)

  await k.stop('SIGKILL')                 // the keyholder dies: its memory, and the unlock, are gone
  await waitFor(() => /keyholder stopped or restarted/.test(api2.output()), 5000, 'API to notice')
  assert.equal((await call(api2.base, 'GET', '/api/auth/status', cookie)).json.locked, true)
  assert.equal((await call(api2.base, 'GET', '/api/test/probe', cookie)).status, 423)

  for (const out of [api2.output(), k.output()]) assert.equal(out.includes(SECRET), false)
})
