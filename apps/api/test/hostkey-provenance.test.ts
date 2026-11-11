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
import { execOnNode, probeHostKey, HostKeyNotConfirmedError, HostKeyNotPinnedError, pinHostKeyIfFree } from '../src/lib/node-exec'
import { listPins, pinSource, setPinSource, recordPin, pinId, recordVerified, pinEvidence, PinVerifyRefusal, pinnedKey, forgetPin } from '../src/lib/hostkey-pins'
import { setClusterStore, loadClusters, createRemote, updateCluster, resetClustersForTests } from '../src/lib/clusters/registry'
import { MemoryClusterStore } from '../src/lib/clusters/store'
import { runInCluster } from '../src/lib/clusters/context'
import { saveHostKeyAnchor } from '../src/lib/setup-checklist'
import { getAnchor } from '../src/lib/hostkey-pins'
import { saveAnchors, setHomeVerifier } from '../src/lib/hostkey-verify'
import { setAuditSink } from '../src/lib/audit'
import { addSession, markReconfirmed, reconfirmedWithin, dropReconfirm, isReconfirmed } from '../src/lib/auth'
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

test('no trust on first use: an unpinned home node is verified first, and refused before any login when it cannot be', async () => {
  let verifierRuns = 0
  setHomeVerifier(async () => { verifierRuns++; return [] })
  try {
    await asOwner(async () => {
      const tried = authTried
      await assert.rejects(execOnNode({ host: '127.0.0.1', port, cred, command: 'true' }), (e: any) => e instanceof HostKeyNotPinnedError)
      assert.equal(verifierRuns, 1, 'HyperProx tried the evidence-based check first')
      assert.equal(authTried, tried, 'no authentication was attempted')
      assert.equal(await pinnedKey('127.0.0.1', port), null, 'nothing was pinned on first use')
    })
  } finally { setHomeVerifier(null) }
})

test('a pin learned on first use (the wizard\'s, the API\'s) is refused before any login is sent', async () => {
  await asOwner(async () => {
    const fp = await probeHostKey('127.0.0.1', port)
    await recordPin('127.0.0.1', port, fp, 'wizard')
    const tried = authTried
    await assert.rejects(execOnNode({ host: '127.0.0.1', port, cred, command: 'true' }),
      (e: any) => e instanceof HostKeyNotConfirmedError && /Setup checklist/.test(e.message))
    await assert.rejects(execOnNode({ host: '127.0.0.1', port, cred, command: 'true', requirePin: true }), HostKeyNotConfirmedError)
    assert.equal(authTried, tried, 'no authentication was attempted')
    assert.equal(await confirmedFingerprint('127.0.0.1', port), false, 'HA maintenance mode does not accept it either')
  })
})

test('a node the evidence-based check verifies is used without anyone confirming it by hand', async () => {
  const mod: any = await import('ssh2')
  const { Server, utils } = mod.default ?? mod
  const kp = utils.generateKeyPairSync('ed25519')
  const srv = new Server({ hostKeys: [kp.private] }, (client: any) => {
    client.on('authentication', (ctx: any) => ctx.method === 'password' && ctx.password === PW ? ctx.accept() : ctx.reject())
    client.on('ready', () => client.on('session', (accept: any) => accept().on('exec', (acc: any) => { const s = acc(); s.write('ran\n'); s.exit(0); s.end() })))
    client.on('error', () => undefined)
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const p2 = srv.address().port
  setHomeVerifier(async () => {
    const fp = await probeHostKey('127.0.0.1', p2)
    await recordVerified('127.0.0.1', p2, fp, { kind: 'trusted-session', via: 'test' })
    return []
  })
  try {
    await asOwner(async () => {
      const r = await execOnNode({ host: '127.0.0.1', port: p2, cred, command: 'true' })
      assert.equal(r.code, 0)
      assert.equal(await pinSource('127.0.0.1', p2), 'verified')
    })
  } finally { setHomeVerifier(null); srv.close() }
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
    assert.match(row(pinId('192.0.2.11', 22)).reason, /learned by the setup wizard, not verified yet/)
    assert.match(row(pinId('192.0.2.13', 22)).reason, /pinned before HyperProx kept track, not verified yet/)
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

test('a pin HyperProx verified (with its evidence) satisfies requirePin; a different pin is never replaced by it', async () => {
  const mod: any = await import('ssh2')
  const { Server, utils } = mod.default ?? mod
  const kp = utils.generateKeyPairSync('ed25519')
  const srv = new Server({ hostKeys: [kp.private] }, (client: any) => {
    client.on('authentication', (ctx: any) => { ctx.method === 'password' && ctx.password === PW ? ctx.accept() : ctx.reject() })
    client.on('ready', () => client.on('session', (accept: any) => accept().on('exec', (acc: any) => { const s = acc(); s.write('ran\n'); s.exit(0); s.end() })))
    client.on('error', () => undefined)
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const p2 = srv.address().port
  try {
    await asOwner(async () => {
      const fp = await probeHostKey('127.0.0.1', p2)
      await recordPin('127.0.0.1', p2, fp, 'api')
      await assert.rejects(execOnNode({ host: '127.0.0.1', port: p2, cred, command: 'true', requirePin: true }), HostKeyNotConfirmedError)
      const ev = { kind: 'tailnet', nodeId: 'nTEST', hostname: 'node1' } as const
      assert.equal(await recordVerified('127.0.0.1', p2, fp, ev), 'verified')
      assert.equal(await pinSource('127.0.0.1', p2), 'verified')
      assert.deepEqual(await pinEvidence('127.0.0.1', p2), ev)
      const row = (await listPins()).find(x => x.id === pinId('127.0.0.1', p2))!
      assert.equal(row.confirmed, true)
      assert.equal((await execOnNode({ host: '127.0.0.1', port: p2, cred, command: 'true', requirePin: true })).code, 0)
      await assert.rejects(recordVerified('127.0.0.1', p2, 'SHA256:' + 'Q'.repeat(43), ev), PinVerifyRefusal)
      assert.equal((await listPins()).find(x => x.id === pinId('127.0.0.1', p2))!.fingerprint, fp, 'the pin is unchanged')
    })
  } finally { srv.close() }
})

test('review 4: a remote server\'s pins are scoped to it; an old pin moves to it only when the address is unambiguous', async () => {
  const saved = process.env.PROXMOX_HOST
  process.env.PROXMOX_HOST = '10.0.0.51'
  try {
    await asOwner(async () => {
      setClusterStore(new MemoryClusterStore()); await loadClusters()
      const c = await createRemote({ name: 'Remote server', address: '10.0.0.50', port: 8006, fingerprint: 'AB'.repeat(32), tokenId: 'hyperprox@pve!main', tokenSecret: 'abcdef01-2345-6789-abcd-ef0123456789', by: 'owner@example.com' })
      await updateCluster(c.id, { nodeAddresses: { node1: '10.0.0.51', node2: '10.0.0.52' } })
      const homeFp = 'SHA256:' + 'H'.repeat(43), oldFp = 'SHA256:' + 'L'.repeat(43)
      await recordPin('10.0.0.51', 22, homeFp, 'confirmed')   // a home node on the same address as the remote's node1
      await recordPin('10.0.0.52', 22, oldFp, 'confirmed')    // a remote pin kept before pins were scoped
      await runInCluster(c.id, async () => {
        assert.equal(await pinnedKey('10.0.0.51', 22), null, 'the home pin is never inherited by the remote')
        assert.equal(await pinnedKey('10.0.0.52', 22), oldFp, 'the old remote pin was copied under the remote')
        assert.equal(await pinSource('10.0.0.52', 22), 'confirmed', 'with its source')
        assert.equal(pinId('10.0.0.52', 22), `${c.id}:10.0.0.52:22`)
      })
      assert.equal(await pinnedKey('10.0.0.51', 22), homeFp, 'home keeps its own pin')
      // review LOW: the home copy stays (a home guest may use the same address), and it is never copied again.
      assert.equal(await pinnedKey('10.0.0.52', 22), oldFp, 'the home copy is left in place')
      await runInCluster(c.id, async () => {
        await forgetPin('10.0.0.52', 22)
        assert.equal(await pinnedKey('10.0.0.52', 22), null, 'forgotten for the remote, and not copied back from home')
      })
      assert.equal(await pinnedKey('10.0.0.52', 22), oldFp, 'home still has its pin')
    })
  } finally { process.env.PROXMOX_HOST = saved; resetClustersForTests() }
})

test('review 1: proving a key needs the host to sign the handshake with it, and sends no login at all', async () => {
  const { proveKey, algorithmsFor } = await import('../src/lib/hostkey-verify')
  const fp = await probeHostKey('127.0.0.1', port)
  const tried = authTried
  const k = await proveKey('127.0.0.1', port, algorithmsFor(['ssh-ed25519']), x => x.fingerprint === fp)
  assert.equal(k.fingerprint, fp)
  await assert.rejects(proveKey('127.0.0.1', port, algorithmsFor(['ssh-ed25519']), () => false), (e: any) => e?.name === 'SessionKeyRefused')
  assert.equal(authTried, tried, 'no authentication was attempted')
})

test('review 1: the installer\'s host record rides the one-time hand-over and becomes the home anchor at the owner\'s sign-in', async () => {
  const { holdValidated, validateHandoff, flushHeldSecrets } = await import('../src/lib/setup-handoff')
  const { getAnchor } = await import('../src/lib/hostkey-pins')
  const mod: any = await import('ssh2')
  const { utils } = mod.default ?? mod
  const pub = String(utils.generateKeyPairSync('ed25519').public).trim().split(/\s+/).slice(0, 2).join(' ')
  const text = ['@@hpx local node-a', '@@hpx node node-a', `node-a ${pub}`, '@@hpx priv', '@@hpx own', `${pub} root@node-a`, '@@hpx end'].join('\n')
  const v = validateHandoff({ hostRecord: Buffer.from(text).toString('base64') })
  assert.ok(v?.hostRecord, 'accepted on its own')
  assert.equal(validateHandoff({ hostRecord: 'not the command output' }), null, 'anything else is dropped')
  holdValidated(v!)
  const r = await flushHeldSecrets({ sid, email: 'owner@example.com', role: 'owner' })
  assert.ok(r.stored.some(x => /host-key record/.test(x)))
  const a = await asOwner(() => getAnchor('home', 'node-a'))
  assert.equal(a?.source, 'installer')
  assert.equal(a?.keys.length, 1)
})

test('review N4: a pasted anchor never silently replaces the installer\'s; replacing needs a second, fresh re-confirmation, and is audited', async () => {
  const audits: any[] = []
  setAuditSink({ async write(r: any) { audits.push(r) } })
  const mod: any = await import('ssh2')
  const { utils } = mod.default ?? mod
  const pub = () => String(utils.generateKeyPairSync('ed25519').public).trim().split(/\s+/).slice(0, 2).join(' ')
  const out = (k: string) => Buffer.from(['@@hpx local node-a', '@@hpx node node-a', `node-a ${k}`, '@@hpx priv', '@@hpx own', `${k} root@node-a`, '@@hpx end'].join('\n')).toString('base64')
  try {
    await asOwner(async () => {
      await saveAnchors('home', out(pub()), 'installer')
      assert.equal((await getAnchor('home', 'node-a'))?.source, 'installer')
      await assert.rejects(saveHostKeyAnchor({ output: out(pub()) }, 'owner@example.com'), (e: any) => e?.code === 'anchor_installer')
      assert.equal((await getAnchor('home', 'node-a'))?.source, 'installer', 'unchanged')
      const r = await saveHostKeyAnchor({ output: out(pub()) }, 'owner@example.com', { replaceInstaller: true })
      assert.deepEqual(r.replaced, ['node-a'])
      assert.equal((await getAnchor('home', 'node-a'))?.source, 'pasted')
      assert.ok(audits.some(a => a.action === 'host_key.anchor.replace' && a.details.by === 'owner@example.com'))
    })
  } finally { setAuditSink(null) }
  // The second re-confirmation: only a password entered in the last minute counts, and it can be asked again.
  addSession({ sid: 'n4-sess', email: 'owner@example.com', role: 'owner', userId: 'u' })
  markReconfirmed('n4-sess', Date.now() - 120_000)
  assert.equal(isReconfirmed('n4-sess'), true)
  assert.equal(reconfirmedWithin('n4-sess', 60_000), false)
  markReconfirmed('n4-sess')
  assert.equal(reconfirmedWithin('n4-sess', 60_000), true)
  dropReconfirm('n4-sess')
  assert.equal(isReconfirmed('n4-sess'), false)
})
