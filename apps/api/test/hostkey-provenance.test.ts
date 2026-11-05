// Where each host-key pin came from, and what requirePin accepts: only a pin an admin confirmed (in the
// Terminal, or the Setup checklist's confirm step), never one HyperProx or the setup wizard learned on
// first use. Against a real SSH server on loopback.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock, signIn } from './fakes/app'
import { requestContext } from '../src/lib/auth'
import { execOnNode, probeHostKey, HostKeyNotConfirmedError, pinHostKeyIfFree } from '../src/lib/node-exec'
import { listPins, pinSource, setPinSource, recordPin, pinId } from '../src/lib/hostkey-pins'
import { confirmHostKey, checklistState } from '../src/lib/setup-checklist'
import { confirmedFingerprint } from '../src/lib/ha/hostkey'
import { needsReconfirm } from '../src/lib/roles'
import { acceptHandoff, handoffFlagPath } from '../src/lib/setup-handoff'

const broker = new FakeBroker()
broker.addUser('owner@example.com', 'owner master password', 'owner')
const appP = buildTestApp(broker)
let sid = ''
let port = 0
let authTried = 0
let server: any
const PW = 'node-password'

before(async () => {
  const app = await appP
  await signIn(app, 'owner@example.com', 'owner master password')
  sid = [...broker.sessions.values()].at(-1)!.sid
  const mod: any = await import('ssh2')
  const { Server, utils } = mod.default ?? mod
  const kp = utils.generateKeyPairSync('ed25519')
  server = new Server({ hostKeys: [kp.private] }, (client: any) => {
    client.on('authentication', (ctx: any) => { authTried++; ctx.method === 'password' && ctx.password === PW ? ctx.accept() : ctx.reject() })
    client.on('ready', () => client.on('session', (accept: any) => accept().on('exec', (acc: any) => { const s = acc(); s.write('ran\n'); s.exit(0); s.end() })))
    client.on('error', () => undefined)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  port = server.address().port
})
after(async () => { server?.close(); await resetLock(); await (await appP).close() })

const asOwner = <T>(fn: () => Promise<T>) => requestContext.run({ sid, email: 'owner@example.com', role: 'owner' }, fn)
const cred = { username: 'root', password: PW } as any

test('the node runner pins on first use and records it as learned by the API, not confirmed', async () => {
  await asOwner(async () => {
    const r = await execOnNode({ host: '127.0.0.1', port, cred, command: 'true' })
    assert.equal(r.code, 0)
    assert.equal(await pinSource('127.0.0.1', port), 'api')
    const p = (await listPins()).find(x => x.id === pinId('127.0.0.1', port))!
    assert.equal(p.confirmed, false)
  })
})

test('requirePin refuses a pin learned on first use, before any login is sent', async () => {
  await asOwner(async () => {
    const tried = authTried
    await assert.rejects(execOnNode({ host: '127.0.0.1', port, cred, command: 'true', requirePin: true }),
      (e: any) => e instanceof HostKeyNotConfirmedError && /Setup checklist/.test(e.message))
    assert.equal(authTried, tried, 'no authentication was attempted')
    assert.equal(await confirmedFingerprint('127.0.0.1', port), false, 'HA maintenance mode does not accept it either')
  })
})

test('confirming the fingerprint (it must be the key shown now) makes requirePin accept it', async () => {
  await asOwner(async () => {
    const fp = await probeHostKey('127.0.0.1', port)
    await assert.rejects(confirmHostKey({ host: '127.0.0.1', port, fingerprint: 'SHA256:' + 'x'.repeat(43) }, 'owner@example.com', { presentedKey: probeHostKey } as any), /presents .* now, not the key you confirmed/)
    const r = await confirmHostKey({ host: '127.0.0.1', port, fingerprint: fp }, 'owner@example.com', { presentedKey: probeHostKey } as any)
    assert.equal(r.result, 'confirmed')
    assert.equal(await pinSource('127.0.0.1', port), 'confirmed')
    const ok = await execOnNode({ host: '127.0.0.1', port, cred, command: 'true', requirePin: true })
    assert.equal(ok.code, 0)
    assert.equal(await confirmedFingerprint('127.0.0.1', port), true)
  })
})

test('a confirmed pin counts; the wizard\'s and a pin from before sources were kept do not', async () => {
  await asOwner(async () => {
    await recordPin('192.0.2.10', 22, 'SHA256:' + 'T'.repeat(43), 'confirmed')
    assert.equal(await pinHostKeyIfFree('192.0.2.11', 'SHA256:' + 'W'.repeat(43)), 'pinned')
    assert.equal(await pinSource('192.0.2.11', 22), 'wizard')
    await recordPin('192.0.2.12', 22, 'SHA256:' + 'L'.repeat(43), 'api')
    await setPinSource('192.0.2.12', 22, undefined as any).catch(() => undefined)
    const legacy = 'SHA256:' + 'Q'.repeat(43)
    const { setCredential } = await import('../src/lib/credentials')
    await setCredential('deck', 'hostkey', pinId('192.0.2.13', 22), legacy, false)
    const pins = new Map((await listPins()).map(p => [p.id, p]))
    assert.equal(pins.get(pinId('192.0.2.10', 22))!.confirmed, true)
    assert.equal(pins.get(pinId('192.0.2.11', 22))!.confirmed, false)
    assert.equal(pins.get(pinId('192.0.2.13', 22))!.source, null, 'an existing pin is left as it is')
    assert.equal(pins.get(pinId('192.0.2.13', 22))!.fingerprint, legacy)
  })
})

test('the Setup checklist shows each node\'s fingerprint and every unconfirmed pin, with where it came from', async () => {
  await asOwner(async () => {
    const deps: any = {
      hardware: { nodes: async () => ['node-a', 'node-b'], addresses: async () => ({ 'node-a': '192.0.2.10', 'node-b': '192.0.2.20' }), pci: async () => [],
        login: async () => null, exec: async () => ({ code: 1, output: '' }), metrics: async () => null },
      envFile: join(mkdtempSync(join(tmpdir(), 'hpx-hk-')), '.env'), hyperproxDir: '/nonexistent',
      pveExporter: async () => ({ configured: false, readOnly: null }), dnsKey: async () => ({}), ollamaModels: async () => null,
      pins: () => listPins(), presentedKey: async (h: string) => h === '192.0.2.20' ? 'SHA256:' + 'N'.repeat(43) : Promise.reject(new Error('no')),
    }
    const item = (await checklistState(deps)).items.find((i: any) => i.id === 'host-keys')!
    const row = (n: string) => item.rows.find((r: any) => r.node === n)!
    assert.equal(row('node-a').state, 'done'); assert.match(row('node-a').reason, /confirmed by an admin/)
    assert.equal(row('node-b').state, 'not-done'); assert.match(row('node-b').reason, /SHA256:N+: not pinned yet/)
    assert.equal(row('node-b').fingerprint, 'SHA256:' + 'N'.repeat(43))
    assert.match(row(pinId('192.0.2.11', 22)).reason, /learned by the setup wizard, not confirmed/)
    assert.match(row(pinId('192.0.2.13', 22)).reason, /pinned before HyperProx kept track, not confirmed/)
    assert.ok(!item.rows.some((r: any) => r.node === pinId('192.0.2.10', 22)), 'a confirmed non-node pin is not listed twice')
  })
  assert.equal(needsReconfirm('POST', '/api/setup-checklist/host-keys/confirm'), true, 'confirming needs the master password')
})

test('the hand-over flag is created exclusively: one written by someone else is never overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hpx-flag-'))
  const prev = process.env.HPX_HANDOFF_FLAG
  process.env.HPX_HANDOFF_FLAG = join(dir, 'handed-over')
  try {
    acceptHandoff({ reachable: true, bootstrapped: false })
    const first = readFileSync(handoffFlagPath(), 'utf8')
    writeFileSync(handoffFlagPath(), 'another process\n')
    assert.throws(() => acceptHandoff({ reachable: true, bootstrapped: false }), /already handed over/)
    assert.equal(readFileSync(handoffFlagPath(), 'utf8'), 'another process\n')
    void first
  } finally { if (prev === undefined) delete process.env.HPX_HANDOFF_FLAG; else process.env.HPX_HANDOFF_FLAG = prev }
})

test('a first Terminal connection to an unknown host pins its key, but that does not satisfy requirePin', async () => {
  const { connect } = await import('../src/lib/ssh-broker')
  const mod: any = await import('ssh2')
  const { Server, utils } = mod.default ?? mod
  const kp = utils.generateKeyPairSync('ed25519')
  const srv = new Server({ hostKeys: [kp.private] }, (client: any) => {
    client.on('authentication', (ctx: any) => ctx.method === 'password' && ctx.password === PW ? ctx.accept() : ctx.reject())
    client.on('ready', () => client.on('session', (accept: any) => {
      const s = accept()
      s.on('pty', (a: any) => a && a()); s.on('exec', (a: any) => { const c = a(); c.exit(1); c.end() })
      s.on('shell', (a: any) => { const c = a(); c.write('$ '); setTimeout(() => { c.exit(0); c.end() }, 50) })
    }))
    client.on('error', () => undefined)
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const p = srv.address().port
  try {
    await asOwner(async () => {
      const r: any = await connect({ host: '127.0.0.1', port: p, cred, cols: 80, rows: 24, useTmux: false })
      try { r.channel?.end?.(); r.client?.end?.() } catch { /* closed */ }
      assert.equal(await pinSource('127.0.0.1', p), 'terminal-auto', 'learned, shown, not accepted')
      assert.equal((await listPins()).find(x => x.id === pinId('127.0.0.1', p))!.confirmed, false)
      await assert.rejects(execOnNode({ host: '127.0.0.1', port: p, cred, command: 'true', requirePin: true }),
        (e: any) => e instanceof HostKeyNotConfirmedError)
      assert.equal(await confirmedFingerprint('127.0.0.1', p), false)
    })
  } finally { srv.close() }
})

test('pinHostKey has no default source: the type requires one', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'node-exec.ts'), 'utf8')
  assert.match(src, /export async function pinHostKey\(host: string, port: number, fingerprint: string, source: PinSource\)/)
})
