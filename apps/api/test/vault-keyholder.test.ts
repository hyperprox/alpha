// The keyholder process itself (bin/hyperprox-keyholder): what it holds, when it locks, who it talks to.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { KeyholderClient, KeyholderError } from '../src/lib/vault/keyholder'
import { keyholderDir, startKeyholder, waitFor, type RunningKeyholder } from './fakes/keyholder'

const running: RunningKeyholder[] = []
after(async () => { for (const k of running) await k.stop('SIGKILL') })

async function kh(args: string[] = []) {
  const k = await startKeyholder({ args })
  running.push(k)
  return k
}

function client(k: RunningKeyholder) {
  const events: string[] = []
  let gone = false
  const c = new KeyholderClient(k.socket, { locked: r => events.push(r), gone: () => { gone = true } })
  return { c, events, gone: () => gone }
}

const MARKER = 'kh-test-secret-7f3a9c'
const SNAP = Buffer.from(JSON.stringify({ secret: MARKER })).toString('base64')

test('refuses to start when its socket directory is not 0700', async () => {
  const dir = keyholderDir()
  fs.chmodSync(dir, 0o755)
  const k = await startKeyholder({ dir, expectFail: true })
  assert.notEqual(await k.exited, 0)
  assert.match(k.output(), /must be owned by uid \d+ with mode 0700/)
})

test('the socket is 0600; holds a snapshot only while unlocked; update needs the current epoch', async () => {
  const k = await kh()
  assert.equal(fs.statSync(k.socket).mode & 0o777, 0o600)
  const { c } = client(k)
  await c.connect()
  const h = await c.hello()
  assert.equal(h.v, 1)
  assert.equal(h.unlocked, false)
  assert.deepEqual(await c.get(), { id: 2, ok: true, unlocked: false, lastLock: null })

  const epoch = await c.unlock(SNAP, 60_000)
  await assert.rejects(c.unlock(SNAP, 60_000), (e: any) => e instanceof KeyholderError && e.code === 'already_unlocked')
  const got = await c.get()
  assert.equal(got.unlocked, true)
  assert.equal(got.snapshot, SNAP)
  assert.equal(got.epoch, epoch)

  await assert.rejects(c.update('not-the-epoch', SNAP), (e: any) => e.code === 'locked')
  const next = Buffer.from('{"secret":"v2"}').toString('base64')
  await c.update(epoch, next)
  assert.equal((await c.get()).snapshot, next)
  await assert.rejects(c.unlock('not base64!', 60_000), (e: any) => e.code === 'already_unlocked')
  c.close()
})

test('bad requests are refused without unlocking', async () => {
  const k = await kh()
  const { c } = client(k)
  await c.connect()
  await assert.rejects(c.unlock('not base64 "}', 60_000), (e: any) => e.code === 'bad_request')
  await assert.rejects(c.unlock(SNAP, 1), (e: any) => e.code === 'bad_request')            // idle below the minimum
  await assert.rejects(c.unlock(SNAP, 10 * 24 * 3600_000), (e: any) => e.code === 'bad_request')
  assert.equal((await c.hello()).unlocked, false)
  c.close()
})

test('the idle timeout locks, wipes, and tells every connection; touch keeps it unlocked', async () => {
  const k = await kh()
  const a = client(k), b = client(k)
  await a.c.connect(); await b.c.connect()
  await a.c.unlock(SNAP, 400)
  for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 200)); assert.equal(await a.c.touch(), true) }
  assert.equal((await b.c.get()).unlocked, true, 'touched for 800 ms against a 400 ms timeout: still unlocked')
  await waitFor(() => a.events.length > 0 && b.events.length > 0, 3000, 'locked events')
  assert.deepEqual(a.events, ['idle'])
  assert.deepEqual(b.events, ['idle'])
  const got = await b.c.get()
  assert.equal(got.unlocked, false)
  assert.equal(got.snapshot, undefined)
  assert.equal(got.lastLock?.reason, 'idle')
  a.c.close(); b.c.close()
})

test('lock wipes at once and reports whether it was unlocked', async () => {
  const k = await kh()
  const { c, events } = client(k)
  await c.connect()
  await c.unlock(SNAP, 60_000)
  assert.equal(await c.lock('manual'), true)
  assert.equal(await c.lock('manual'), false)
  assert.equal((await c.get()).unlocked, false)
  await waitFor(() => events.length === 1, 1000, 'event')
  assert.deepEqual(events, ['manual'])
  c.close()
})

test('a peer with another uid is refused (SO_PEERCRED)', async () => {
  const other = (process.getuid?.() ?? 0) + 4242
  const k = await kh(['--allow-uid', String(other)])
  const { c } = client(k)
  await c.connect()
  await assert.rejects(c.hello(), (e: any) => e instanceof KeyholderError && (e.code === 'peer_refused' || e.code === 'gone'))
  await waitFor(() => /refused a connection from pid \d+: uid \d+ not allowed/.test(k.output()), 2000, 'refusal in the log')
})

test('a peer outside the allowed systemd unit is refused', async () => {
  const k = await kh(['--allow-unit', 'hyperprox-api.service'])
  const { c } = client(k)
  await c.connect()
  await assert.rejects(c.hello(), (e: any) => e instanceof KeyholderError)
  await waitFor(() => /refused a connection .*: unit .* not allowed/.test(k.output()), 2000, 'refusal in the log')
})

test('a keyholder restart is a lock: the new process holds nothing, the old connection is gone', async () => {
  const k1 = await kh()
  const { c, gone } = client(k1)
  await c.connect()
  await c.unlock(SNAP, 60_000)
  await k1.stop('SIGKILL')            // a crash: no chance to say anything
  await waitFor(gone, 2000, 'gone')
  const k2 = await startKeyholder({ dir: k1.dir })
  running.push(k2)
  const n = client(k2)
  await n.c.connect()
  const h = await n.c.hello()
  assert.equal(h.unlocked, false)
  assert.equal(h.lastLock, null)
  n.c.close()
})

test('SIGTERM wipes, tells the API, and exits 0', async () => {
  const k = await startKeyholder()
  const { c, events, gone } = client(k)
  await c.connect()
  await c.unlock(SNAP, 60_000)
  assert.equal(await k.stop('SIGTERM'), 0)
  await waitFor(gone, 2000, 'gone')
  assert.deepEqual(events, ['stop'])
  assert.equal(fs.existsSync(k.socket), false)
})

test('nothing sensitive in its logs', async () => {
  const k = await kh()
  const { c } = client(k)
  await c.connect()
  const epoch = await c.unlock(SNAP, 300)
  await c.update(epoch, SNAP)
  await c.get()
  await waitFor(() => /locked \(idle\)/.test(k.output()), 3000, 'idle lock')
  await c.unlock(SNAP, 60_000)
  await c.lock('manual')
  c.close()
  await k.stop('SIGTERM')
  const out = k.output()
  assert.ok(out.length > 0)
  for (const needle of [MARKER, SNAP, SNAP.slice(0, 16), epoch]) assert.equal(out.includes(needle), false, `log contains ${needle}`)
  assert.match(out, /unlocked \(idle lock after/)
  assert.match(out, /locked \(manual\)/)
})
