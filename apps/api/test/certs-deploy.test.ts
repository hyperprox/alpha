// Delivering a certificate: the guest file script (run for real with bash, in a temp dir), the deploy
// outcome rules (reload failure, probe mismatch, nothing to probe), and HyperProx's own nginx install
// with a fake docker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deployBundle, installHyperproxCert, pushScript, guestFiles, sameFingerprint, type DeployDeps } from '../src/lib/certs/deploy'
import type { IssuedBundle, ProbeResult, TargetSpec } from '../src/lib/certs/modules'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'certs-deploy-test-'))
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))
const me = `${os.userInfo().uid}:${os.userInfo().gid}`

const bundle = (fp = 'AA:BB:CC'): IssuedBundle => ({
  keyPem: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
  certPem: 'LEAF\n', chainPem: 'CHAIN\n', fullchainPem: 'LEAF\nCHAIN\n',
  notBefore: new Date(), notAfter: new Date(Date.now() + 90 * 86400_000), serial: '01', issuer: 'Test CA', fingerprint256: fp,
})

const guestTarget = (over: Partial<Extract<TargetSpec, { kind: 'guest-files' }>> = {}): TargetSpec => ({
  kind: 'guest-files', vmid: 101, files: { fullchain: '/etc/ssl/mail/fullchain.pem', key: '/etc/ssl/mail/privkey.pem' },
  owner: 'root:root', keyMode: '0600', reload: 'systemctl reload postfix', ...over,
})

const served = (fp: string | null): ProbeResult => fp
  ? { ok: true, trusted: true, namesMatch: true, leaf: { subject: 'x', issuer: 'Test CA', names: ['mail.example.com'], notBefore: new Date(), notAfter: new Date(), serial: '01', fingerprint256: fp, selfSigned: false } }
  : { ok: false, error: 'refused', trusted: null, namesMatch: null }

function deps(over: Partial<DeployDeps> = {}): DeployDeps & { log: string[] } {
  const log: string[] = []
  return {
    log,
    guestPush: async (vmid, files) => { log.push(`push ${vmid} ${files.map(f => `${f.path}:${f.mode}`).join(' ')}`); return { code: 0, output: '' } },
    guestExec: async (vmid, script) => { log.push(`exec ${vmid} ${script}`); return { code: 0, output: '' } },
    hyperproxInstall: async () => { log.push('install'); return { ok: true, detail: 'installed' } },
    probe: async () => served('AA:BB:CC'),
    endpoints: [{ host: 'mail.example.com', port: 993, starttls: 'none' }],
    probeAttempts: 3, sleep: async () => undefined,
    ...over,
  }
}

test('pushScript writes every file with its mode, keeps the old ones, and leaves nothing staged', () => {
  const dir = path.join(tmp, 'guest', 'etc', 'ssl')
  const files = [
    { path: path.join(dir, 'fullchain.pem'), content: 'NEW CHAIN\n', mode: '0644', owner: me },
    { path: path.join(dir, 'privkey.pem'), content: "NEW KEY with 'quotes' and $dollars\n", mode: '0600', owner: me },
  ]
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(files[0].path, 'OLD CHAIN\n')
  const out = execFileSync('bash', ['-c', pushScript(files)], { encoding: 'utf8' })
  assert.match(out, /wrote 2 file/)
  assert.equal(fs.readFileSync(files[0].path, 'utf8'), 'NEW CHAIN\n')
  assert.equal(fs.readFileSync(files[1].path, 'utf8'), files[1].content)
  assert.equal(fs.statSync(files[1].path).mode & 0o777, 0o600)
  assert.equal(fs.statSync(files[0].path).mode & 0o777, 0o644)
  assert.equal(fs.readFileSync(files[0].path + '.hyperprox-prev', 'utf8'), 'OLD CHAIN\n')
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith('.hyperprox-cert')), [])
})

test('pushScript moves nothing when one file cannot be staged', () => {
  const dir = path.join(tmp, 'guest2')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'a.pem'), 'OLD A\n')
  const files = [
    { path: path.join(dir, 'a.pem'), content: 'NEW A\n', mode: '0644', owner: me },
    { path: path.join(dir, 'b.pem'), content: 'NEW B\n', mode: '0600', owner: 'no-such-user-hp' },
  ]
  assert.throws(() => execFileSync('bash', ['-c', pushScript(files)], { stdio: 'pipe' }))
  assert.equal(fs.readFileSync(path.join(dir, 'a.pem'), 'utf8'), 'OLD A\n')
  assert.ok(!fs.existsSync(path.join(dir, 'b.pem')))
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith('.hyperprox-cert')), [])
})

test('pushScript refuses relative paths, odd owners and modes before anything runs', () => {
  const ok = { path: '/etc/ssl/a.pem', content: 'x', mode: '0644', owner: 'root:root' }
  assert.throws(() => pushScript([{ ...ok, path: 'etc/ssl/a.pem' }]), /absolute/)
  assert.throws(() => pushScript([{ ...ok, path: '/etc/ssl/../shadow' }]), /absolute/)
  assert.throws(() => pushScript([{ ...ok, path: '/etc/ssl/a.pem; rm -rf /' }]), /absolute/)
  assert.throws(() => pushScript([{ ...ok, owner: 'root;id' }]), /owner/)
  assert.throws(() => pushScript([{ ...ok, mode: '777; id' }]), /mode/)
  assert.throws(() => pushScript([ok, { ...ok, mode: '0600' }]), /twice in one delivery/)
})

test('guestFiles: the key gets keyMode, everything else 0644; optional cert and chain', () => {
  const t = guestTarget({ files: { fullchain: '/a/full.pem', key: '/a/key.pem', cert: '/a/cert.pem', chain: '/a/chain.pem' }, keyMode: '0640' }) as any
  const files = guestFiles(t, bundle())
  assert.deepEqual(files.map(f => [f.path, f.mode, f.content]), [
    ['/a/full.pem', '0644', 'LEAF\nCHAIN\n'], ['/a/key.pem', '0640', bundle().keyPem], ['/a/cert.pem', '0644', 'LEAF\n'], ['/a/chain.pem', '0644', 'CHAIN\n'],
  ])
})

test('guestFiles and deploy refuse a key mode that lets other users read the key', async () => {
  for (const keyMode of ['0644', '0604', '0601', '644']) {
    assert.throws(() => guestFiles(guestTarget({ keyMode }) as any, bundle()), /other users no access/, keyMode)
  }
  assert.equal(guestFiles(guestTarget({ keyMode: '0640' }) as any, bundle())[1].mode, '0640')
  const d = deps()
  const r = await deployBundle(guestTarget({ keyMode: '0644' }), bundle(), d)
  assert.equal(r.ok, false)
  assert.match(r.detail, /refusing key mode "0644"/)
  assert.deepEqual(d.log, [], 'nothing was pushed')
})

test('guest-files: push, reload, then the probe must see the new fingerprint', async () => {
  const d = deps()
  const r = await deployBundle(guestTarget(), bundle(), d)
  assert.equal(r.ok, true, r.detail)
  assert.equal(r.fingerprint, 'AA:BB:CC')
  assert.deepEqual(d.log, ['push 101 /etc/ssl/mail/fullchain.pem:0644 /etc/ssl/mail/privkey.pem:0600', 'exec 101 systemctl reload postfix'])
})

test('guest-files: a failed reload fails the deploy and is not probed', async () => {
  let probed = 0
  const d = deps({ guestExec: async () => ({ code: 1, output: 'Job for postfix.service failed' }), probe: async () => { probed++; return served('AA:BB:CC') } })
  const r = await deployBundle(guestTarget(), bundle(), d)
  assert.equal(r.ok, false)
  assert.match(r.detail, /reload failed \(exit 1\): Job for postfix/)
  assert.equal(probed, 0)
})

test('the probe still seeing the old certificate fails the deploy after retrying', async () => {
  let probed = 0
  const r = await deployBundle(guestTarget(), bundle(), deps({ probe: async () => { probed++; return served('11:22:33') } }))
  assert.equal(r.ok, false)
  assert.equal(r.fingerprint, '11:22:33')
  assert.match(r.detail, /993 still serves another certificate/)
  assert.equal(probed, 3)
})

test('a daemon that picks the certificate up a moment late passes on a retry', async () => {
  const seq = [served('11:22:33'), served('aa:bb:cc')]
  const r = await deployBundle(guestTarget(), bundle(), deps({ probe: async () => seq.shift() ?? served('AA:BB:CC') }))
  assert.equal(r.ok, true, r.detail)
})

test('no endpoint to probe is reported as unverified, not as success', async () => {
  const r = await deployBundle(guestTarget(), bundle(), deps({ endpoints: [] }))
  assert.equal(r.ok, false)
  assert.match(r.detail, /unverified/)
})

test('hyperprox: install then probe; an install failure is returned as it is', async () => {
  const d = deps({ endpoints: [{ host: '127.0.0.1', port: 443, starttls: 'none', servername: 'hp.example.com' }] })
  assert.equal((await deployBundle({ kind: 'hyperprox' }, bundle(), d)).ok, true)
  const bad = await deployBundle({ kind: 'hyperprox' }, bundle(), deps({ hyperproxInstall: async () => ({ ok: false, detail: 'nginx refused it' }) }))
  assert.deepEqual([bad.ok, bad.detail], [false, 'nginx refused it'])
})

test('sameFingerprint ignores case and separators', () => {
  assert.ok(sameFingerprint('AA:BB:CC', 'aabbcc'))
  assert.ok(!sameFingerprint('', ''))
  assert.ok(!sameFingerprint('AA:BB', 'AA:BC'))
})

test('installHyperproxCert: replaces cert.pem/key.pem, keeps the previous pair, reloads nginx', async () => {
  const dir = path.join(tmp, 'hp1')
  fs.mkdirSync(path.join(dir, 'certs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'certs', 'cert.pem'), 'OLD CERT\n')
  fs.writeFileSync(path.join(dir, 'certs', 'key.pem'), 'OLD KEY\n')
  const calls: string[] = []
  const r = await installHyperproxCert(bundle(), { dir, run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, output: '' } } })
  assert.equal(r.ok, true)
  assert.deepEqual(calls, ['docker exec hyperprox-nginx nginx -t', 'docker exec hyperprox-nginx nginx -s reload'])
  const c = (f: string) => fs.readFileSync(path.join(dir, 'certs', f), 'utf8')
  assert.equal(c('cert.pem'), 'LEAF\nCHAIN\n')
  assert.equal(c('key.pem'), bundle().keyPem)
  assert.equal(c('cert.prev.pem'), 'OLD CERT\n')
  assert.equal(fs.statSync(path.join(dir, 'certs', 'key.pem')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(dir, 'certs', 'key.prev.pem')).mode & 0o777, 0o600)
})

test('installHyperproxCert: nginx refusing the new pair puts the old one back and does not reload', async () => {
  const dir = path.join(tmp, 'hp2')
  fs.mkdirSync(path.join(dir, 'certs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'certs', 'cert.pem'), 'OLD CERT\n')
  fs.writeFileSync(path.join(dir, 'certs', 'key.pem'), 'OLD KEY\n')
  const calls: string[] = []
  const r = await installHyperproxCert(bundle(), { dir, run: async (cmd, args) => {
    calls.push(args.join(' '))
    return args.includes('-t') ? { code: 1, output: 'SSL_CTX_use_PrivateKey failed' } : { code: 0, output: '' }
  } })
  assert.equal(r.ok, false)
  assert.match(r.detail, /previous one was put back.*SSL_CTX_use_PrivateKey/)
  assert.equal(calls.length, 1)
  assert.equal(fs.readFileSync(path.join(dir, 'certs', 'cert.pem'), 'utf8'), 'OLD CERT\n')
  assert.equal(fs.readFileSync(path.join(dir, 'certs', 'key.pem'), 'utf8'), 'OLD KEY\n')
})
