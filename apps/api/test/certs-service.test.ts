// The Certificates service with everything outside it faked: CA, DNS, vault, guests, probes.
// Covers the rules the service exists for: one issuance per label, a failure keeps the certificate in
// place, a deploy is only good when the probe sees the new fingerprint, and nothing issues a
// certificate for the first time on its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CertsService, CertsInputError, CertsNotFoundError, CertsBusyError, RenewingError, bundleFromPems, covers,
  type CertsSecrets, type StoredBundle,
} from '../src/lib/certs/service'
import { MemoryCertsStore } from '../src/lib/certs/store'
import { defaultModules, type CertsModules, type CertsPolicy, type IssuedBundle, type ProbeTarget } from '../src/lib/certs/_stubs'

// --- fixtures ------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'certs-svc-test-'))
let serial = 0
function makeCert(cn: string, days = 90): StoredBundle {
  const k = path.join(tmp, `k${++serial}.pem`), c = path.join(tmp, `c${serial}.pem`)
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-days', String(days), '-subj', `/O=Test CA/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`, '-keyout', k, '-out', c], { stdio: 'ignore' })
  return { keyPem: fs.readFileSync(k, 'utf8'), fullchainPem: fs.readFileSync(c, 'utf8') }
}
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }))

const policy = (over: Partial<CertsPolicy> = {}): CertsPolicy => ({
  acme: { directoryUrl: 'https://acme.test/directory', staging: false, email: 'admin@example.com', keyType: 'ec256' },
  schedule: { check: '15 6 * * *' },
  alerts: { warnFraction: 0.33, criticalDays: 7, webhookUrl: 'https://hooks.example.com/x' },
  certificates: { mail: { names: ['mail.example.com'], deploy: [{ target: 'mail-guest' }, { target: 'self' }] } },
  probes: [
    { host: 'mail.example.com', port: 993, starttls: 'none', internal: false },
    { host: 'mail.example.com', port: 587, starttls: 'smtp', internal: false },
  ],
  targets: {
    'mail-guest': { kind: 'guest-files', vmid: 101, files: { fullchain: '/etc/ssl/mail/fullchain.pem', key: '/etc/ssl/mail/privkey.pem' },
      owner: 'root:root', keyMode: '0600', reload: 'systemctl reload postfix dovecot' },
    self: { kind: 'hyperprox' },
  },
  proxy: { guestVmid: null },
  ...over,
})

class FakeVault implements CertsSecrets {
  account: string | null = null
  bundles = new Map<string, StoredBundle>()
  async getAccountKey() { return this.account }
  async saveAccountKey(pem: string) { this.account = pem }
  async getBundle(label: string) { return this.bundles.get(label) ?? null }
  async saveBundle(label: string, b: StoredBundle) { this.bundles.set(label, { ...b }) }
}

interface World {
  svc: CertsService; store: MemoryCertsStore; vault: FakeVault
  served: Map<string, string>          // host:port -> fingerprint the fake endpoint serves
  issued: string[]                      // labels' names passed to the CA
  issue: (names: string[]) => Promise<IssuedBundle>
  pushes: Array<{ vmid: number; paths: string[] }>
  execs: Array<{ vmid: number; script: string }>
  installs: number
  webhooks: string[][]
  policy: { current: CertsPolicy; loaded: boolean }
  now: { t: Date }
}

function world(): World {
  const store = new MemoryCertsStore()
  const vault = new FakeVault()
  const w: World = {
    store, vault, served: new Map(), issued: [], pushes: [], execs: [], installs: 0, webhooks: [],
    policy: { current: policy(), loaded: true }, now: { t: new Date() },
    issue: async names => { const c = makeCert(names[0]); return bundleFromPems(c.keyPem, c.fullchainPem) },
    svc: null as any,
  }
  const modules: CertsModules = {
    ...defaultModules,
    loadCertsPolicy: () => ({ loaded: w.policy.loaded, path: '/test/certs.yaml', policy: w.policy.current }),
    issueCertificate: async (_deps, names) => { w.issued.push(names.join(',')); return w.issue(names) },
    fetchAri: async () => null,
    probeEndpoint: async (t: ProbeTarget) => {
      const fp = w.served.get(`${t.host}:${t.port}`)
      if (!fp) return { ok: false, error: 'connection refused', trusted: null, namesMatch: null }
      return { ok: true, trusted: true, namesMatch: true, leaf: { subject: t.host, issuer: 'Test CA', names: [t.host],
        notBefore: new Date(), notAfter: new Date(Date.now() + 80 * 86400_000), serial: '01', fingerprint256: fp, selfSigned: false } }
    },
    verdictFor: (r, ctx) => {
      if (!r.ok || !r.leaf) return { verdict: 'error', reason: r.error ?? 'no answer' }
      if (ctx.expectFingerprint && ctx.expectFingerprint !== r.leaf.fingerprint256) return { verdict: 'critical', reason: 'serves another certificate' }
      return { verdict: 'ok', reason: null }
    },
    alertChanges: (prev, next) => {
      const messages = next.filter(s => prev.get(s.key)?.verdict !== s.verdict && s.verdict !== 'ok').map(s => `${s.key}: ${s.verdict}`)
      return { messages, state: new Map(next.map(s => [s.key, s])), reminderSent: false }
    },
    sendWebhook: async (_url, m) => { w.webhooks.push(m) },
  }
  w.svc = new CertsService({
    store, secrets: vault, modules,
    dnsProviders: async () => [],
    deploy: {
      guestPush: async (vmid, files) => { w.pushes.push({ vmid, paths: files.map(f => f.path) }); return { code: 0, output: 'wrote' } },
      guestExec: async (vmid, script) => { w.execs.push({ vmid, script }); return { code: 0, output: '' } },
      hyperproxInstall: async () => { w.installs++; return { ok: true, detail: 'installed' } },
      probeAttempts: 2, sleep: async () => undefined,
    },
    sources: {
      npmCertificates: async () => [], npmHosts: async () => [], nodeCertificates: async () => [],
      deleteNpmCertificate: async () => undefined,
    },
    log: () => undefined,
    now: () => w.now.t,
  })
  return w
}

/** Make every endpoint of `mail` serve `fp` (what a successful reload would do). */
function serveEverywhere(w: World, fp: string) {
  for (const k of ['mail.example.com:993', 'mail.example.com:587', '127.0.0.1:443']) w.served.set(k, fp)
}

async function issueOk(w: World): Promise<IssuedBundle> {
  let bundle!: IssuedBundle
  const orig = w.issue
  w.issue = async names => { bundle = await orig(names); serveEverywhere(w, bundle.fingerprint256); return bundle }
  await w.svc.issue('mail', 'admin@example.com')
  await w.svc.idle()
  w.issue = orig
  return bundle
}

// --- tests --------------------------------------------------------------------------------------

test('covers: exact names and one-level wildcards only', () => {
  assert.ok(covers('mail.example.com', 'MAIL.example.com'))
  assert.ok(covers('*.example.com', 'mail.example.com'))
  assert.ok(!covers('*.example.com', 'example.com'))
  assert.ok(!covers('*.example.com', 'a.b.example.com'))
})

test('bundleFromPems derives the fields and refuses a key from another certificate', () => {
  const a = makeCert('a.example.com'), b = makeCert('b.example.com')
  const bundle = bundleFromPems(a.keyPem, a.fullchainPem)
  assert.match(bundle.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  assert.equal(bundle.issuer, 'Test CA a.example.com')
  assert.ok(bundle.notAfter.getTime() > bundle.notBefore.getTime())
  assert.throws(() => bundleFromPems(b.keyPem, a.fullchainPem), /does not belong/)
})

test('issue: renewing at once, then valid, stored in the vault, deployed and verified on every target', async () => {
  const w = world()
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const orig = w.issue
  w.issue = async names => { await gate; const b = await orig(names); serveEverywhere(w, b.fingerprint256); return b }

  const started = await w.svc.issue('mail', 'admin@example.com')
  assert.equal(started.status, 'renewing')
  release()
  await w.svc.idle()

  const row = (await w.store.getManaged('mail'))!
  assert.equal(row.status, 'valid')
  assert.equal(row.lastError, null)
  assert.ok(row.renewAfter && row.notAfter && row.renewAfter < row.notAfter)
  const stored = w.vault.bundles.get('mail')!
  assert.equal(bundleFromPems(stored.keyPem, stored.fullchainPem).fingerprint256, row.fingerprint)
  assert.deepEqual(w.pushes, [{ vmid: 101, paths: ['/etc/ssl/mail/fullchain.pem', '/etc/ssl/mail/privkey.pem'] }])
  assert.deepEqual(w.execs.map(e => e.script), ['systemctl reload postfix dovecot'])
  assert.equal(w.installs, 1)

  const view = (await w.svc.managed()).find(m => m.label === 'mail')!
  assert.deepEqual(view.targets.map(t => [t.name, t.verdict]), [['mail-guest', 'ok'], ['self', 'ok']])
  const events = await w.svc.events('mail', 10)
  assert.ok(events.some(e => e.kind === 'issue' && e.ok))
  assert.equal(events.filter(e => e.kind === 'deploy' && e.ok).length, 2)
  assert.ok(w.store.audits.some(a => a.action === 'certs.issue' && a.details?.by === 'admin@example.com'))
  // The endpoints were re-probed after the deploy, against the new fingerprint.
  const probes = await w.store.listProbes()
  assert.ok(probes.length >= 2 && probes.every(p => p.verdict === 'ok' && p.fingerprint === row.fingerprint))
})

test('a second issue for the same label while one runs is refused (409)', async () => {
  const w = world()
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const orig = w.issue
  w.issue = async names => { await gate; return orig(names) }
  await w.svc.issue('mail')
  await assert.rejects(w.svc.issue('mail'), RenewingError)
  await assert.rejects(w.svc.deploy('mail'), CertsInputError, 'never issued yet')
  release()
  await w.svc.idle()
  assert.equal(w.issued.length, 1)
})

test('a failed renewal keeps the certificate, its vault entry and its deployment; lastError says why', async () => {
  const w = world()
  const first = await issueOk(w)
  const pushesBefore = w.pushes.length
  w.issue = async () => { throw new Error('DNS provider refused the TXT record') }
  await w.svc.issue('mail')
  await w.svc.idle()
  const row = (await w.store.getManaged('mail'))!
  assert.equal(row.status, 'failed')
  assert.match(row.lastError!, /refused the TXT record/)
  assert.equal(row.fingerprint, first.fingerprint256)
  assert.equal(row.notAfter!.getTime(), first.notAfter.getTime())
  assert.equal(bundleFromPems(w.vault.bundles.get('mail')!.keyPem, w.vault.bundles.get('mail')!.fullchainPem).fingerprint256, first.fingerprint256)
  assert.equal(w.pushes.length, pushesBefore, 'nothing deployed')
  const ev = (await w.svc.events('mail', 5))[0]
  assert.equal(ev.kind, 'renew')
  assert.equal(ev.ok, false)
  assert.match(ev.detail, /current certificate stays in place/)
})

test('a deploy whose probe sees another certificate fails that target; the other targets continue', async () => {
  const w = world()
  const orig = w.issue
  w.issue = async names => {
    const b = await orig(names)
    serveEverywhere(w, b.fingerprint256)
    w.served.set('mail.example.com:587', 'AA:BB:CC')   // the submission port still serves an old certificate
    return b
  }
  await w.svc.issue('mail')
  await w.svc.idle()
  const recs = await w.store.listTargets('mail')
  const guest = recs.find(r => r.name === 'mail-guest')!
  assert.equal(guest.ok, false)
  assert.match(guest.detail!, /587 still serves another certificate/)
  assert.equal(recs.find(r => r.name === 'self')!.ok, true)
  assert.equal(w.installs, 1, 'the hyperprox target ran after the failed one')
  assert.equal((await w.store.getManaged('mail'))!.status, 'valid', 'the new certificate is kept for the next attempt')
  const view = (await w.svc.managed()).find(m => m.label === 'mail')!
  assert.equal(view.targets.find(t => t.name === 'mail-guest')!.verdict, 'critical')
})

test('redeploy uses the certificate in the vault; refuses while issuing or for an unknown label', async () => {
  const w = world()
  const b = await issueOk(w)
  const before = w.pushes.length
  const r = await w.svc.deploy('mail', 'admin@example.com')
  assert.equal(r.label, 'mail')
  await w.svc.idle()
  assert.equal(w.pushes.length, before + 1)
  assert.ok(w.store.audits.some(a => a.action === 'certs.deploy' && a.details?.fingerprint === b.fingerprint256))
  await assert.rejects(w.svc.deploy('nope'), CertsNotFoundError)
})

test('no policy file: issue is a 400 with the reason; unknown label is a 404', async () => {
  const w = world()
  await assert.rejects(w.svc.issue('nope'), CertsNotFoundError)
  w.policy.loaded = false
  await assert.rejects(w.svc.issue('mail'), (e: any) => e instanceof CertsInputError && /no certificate policy/.test(e.message))
})

test('the daily check never issues a certificate that has never been issued', async () => {
  const w = world()
  // A label in the policy, and even a failed first attempt in the database: still nothing automatic.
  await w.store.beginIssue('mail', ['mail.example.com'])
  await w.store.updateManaged('mail', { status: 'failed', lastError: 'CA said no' })
  await w.svc.dailyCheck()
  assert.deepEqual(w.issued, [])
})

test('the daily check renews what is due, and only that', async () => {
  const w = world()
  await issueOk(w)
  w.issued.length = 0
  await w.svc.dailyCheck()
  assert.deepEqual(w.issued, [], 'not due yet')

  // Past renewAfter: renewed by the schedule, deployed, audited as the schedule.
  w.now.t = new Date(Date.now() + 70 * 86400_000)
  const orig = w.issue
  w.issue = async names => { const b = await orig(names); serveEverywhere(w, b.fingerprint256); return b }
  await w.svc.dailyCheck()
  assert.deepEqual(w.issued, ['mail.example.com'])
  assert.equal((await w.store.getManaged('mail'))!.status, 'valid')
  assert.ok(w.store.audits.some(a => a.action === 'certs.renew' && a.details?.by === 'schedule'))
  assert.ok((await w.svc.events('mail', 20)).some(e => e.kind === 'renew' && e.ok && /schedule/.test(e.detail)))
})

test('the daily check retries a failed delivery with the certificate already issued', async () => {
  const w = world()
  const orig = w.issue
  let fp = ''
  w.issue = async names => { const b = await orig(names); fp = b.fingerprint256; return b }  // nothing serves it yet
  await w.svc.issue('mail')
  await w.svc.idle()
  assert.equal((await w.store.listTargets('mail')).every(t => t.ok === false), true)
  serveEverywhere(w, fp)
  w.issued.length = 0
  await w.svc.dailyCheck()
  assert.deepEqual(w.issued, [], 'no new issuance for a delivery problem')
  assert.equal((await w.store.listTargets('mail')).every(t => t.ok === true), true)
})

test('the daily check probes, alerts on a change of verdict, and sends the webhook once', async () => {
  const w = world()
  await issueOk(w)
  w.served.set('mail.example.com:993', 'DE:AD')   // another tool overwrote the certificate
  await w.svc.dailyCheck()
  assert.equal(w.webhooks.length, 1)
  assert.match(w.webhooks[0].join('\n'), /mail\.example\.com:993: critical/)
  await w.svc.dailyCheck()
  assert.equal(w.webhooks.length, 1, 'no repeat while nothing changed')
  const alert = (await w.svc.events(undefined, 50)).find(e => e.kind === 'alert')!
  assert.match(alert.detail, /sent to the webhook/)
})

test('restart recovery releases an issuance cut off mid-way', async () => {
  const w = world()
  await w.store.beginIssue('mail', ['mail.example.com'])
  assert.deepEqual(await w.svc.recover(), ['mail'])
  const row = (await w.store.getManaged('mail'))!
  assert.equal(row.status, 'failed')
  assert.match(row.lastError!, /restart/)
})

test('probe: one known endpoint, or 404 for one HyperProx does not know; all, with a summary event', async () => {
  const w = world()
  w.served.set('mail.example.com:993', 'AB:CD')
  const one = await w.svc.probe({ host: 'mail.example.com', port: 993 }, 'admin@example.com')
  assert.equal(one.length, 1)
  assert.equal(one[0].fingerprint, 'AB:CD')
  await assert.rejects(w.svc.probe({ host: 'elsewhere.example.com', port: 443 }), CertsNotFoundError)
  const all = await w.svc.probe(undefined, 'admin@example.com')
  assert.equal(all.length, 2)
  assert.ok((await w.svc.events(undefined, 5)).some(e => e.kind === 'probe' && /Probed 2 endpoint/.test(e.detail)))
  assert.equal(w.store.audits.filter(a => a.action === 'certs.probe').length, 3)
})

test('overview: policy status with the next run, every policy label listed, staging flag', async () => {
  const w = world()
  w.policy.current = policy({ acme: { ...policy().acme, staging: true } })
  const o = await w.svc.overview(false)
  assert.equal(o.policy.loaded, true)
  assert.ok(o.policy.schedule.nextRun)
  assert.deepEqual(o.managed.map(m => [m.label, m.status]), [['mail', 'pending']])
  await issueOk(w)
  assert.equal((await w.svc.overview(true)).managed[0].staging, true)
})

test('housekeeping apply re-lists first: an item that is gone is a 404', async () => {
  const w = world()
  const items = [{ id: 'npm:7', kind: 'proxy-expired-unused' as const, names: ['old.example.com'], expiredAt: null, detail: '' }]
  const applied: string[] = []
  ;(w.svc as any).deps.modules = { ...(w.svc as any).deps.modules,
    listHousekeeping: async () => items, applyHousekeeping: async (i: any) => { applied.push(i.id); return 'deleted from the proxy' } }
  assert.equal(await w.svc.applyHousekeeping('npm:7', 'admin@example.com'), 'deleted from the proxy')
  await assert.rejects(w.svc.applyHousekeeping('npm:8'), CertsNotFoundError)
  assert.deepEqual(applied, ['npm:7'])
  assert.ok(w.store.audits.some(a => a.action === 'certs.housekeeping.apply' && a.resource === 'npm:7'))
})

test('issue is refused while the same label is being deployed', async () => {
  const w = world()
  await issueOk(w)
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  ;(w.svc as any).deps.deploy.hyperproxInstall = async () => { await gate; return { ok: true, detail: 'installed' } }
  await w.svc.deploy('mail')
  await new Promise(r => setTimeout(r, 10))
  await assert.rejects(w.svc.issue('mail'), CertsBusyError)
  await assert.rejects(w.svc.deploy('mail'), CertsBusyError)
  release()
  await w.svc.idle()
})

test('alerts: with no saved state, the verdicts already on the page are the baseline (a restart or first check re-announces nothing)', async () => {
  const w = world()
  await issueOk(w)
  w.served.set('mail.example.com:993', 'DE:AD')
  await w.svc.probe()                        // the page already shows 993 as critical
  assert.equal(await w.store.getState('alerts'), null)
  await w.svc.dailyCheck()
  assert.equal(w.webhooks.length, 0, 'a known problem is not announced again')
  w.served.delete('mail.example.com:587')     // a new problem is
  await w.svc.dailyCheck()
  assert.equal(w.webhooks.length, 1)
  assert.match(w.webhooks[0].join('\n'), /587/)
  assert.doesNotMatch(w.webhooks[0].join('\n'), /993/)
})

test('probes carry the expected fingerprint, internal flag and probe options; housekeeping gets its own runner and a warn sink', async () => {
  const w = world()
  const seen: any[] = []
  const logs: string[] = []
  const deps = (w.svc as any).deps
  const base = deps.modules
  deps.probeOptions = { ca: 'TEST CA PEM' }
  deps.log = (m: string) => logs.push(m)
  deps.modules = { ...base,
    probeEndpoint: async (t: any, _ms: any, opts: any) => { seen.push({ t, opts }); return base.probeEndpoint(t) },
    verdictFor: (r: any, ctx: any) => { seen.push({ ctx }); return base.verdictFor(r, ctx) },
  }
  const b = await issueOk(w)
  assert.ok(seen.some(s => s.opts?.ca === 'TEST CA PEM'))
  assert.ok(seen.some(s => s.ctx?.expectFingerprint === b.fingerprint256), 'the deployed fingerprint, in X509 form')
  assert.ok(seen.every(s => !s.ctx || s.ctx.internal === false || s.ctx.internal === undefined))

  const ran: number[] = []
  deps.housekeepingExec = async (vmid: number) => { ran.push(vmid); return { code: 0, output: '' } }
  w.policy.current = policy({ proxy: { guestVmid: 105 } })
  deps.modules = { ...base, listHousekeeping: async (d: any) => { await d.guestExec('ls'); d.warn('scan failed'); return [] } }
  await w.svc.housekeeping()
  assert.deepEqual(ran, [105])
  assert.ok(logs.some(l => /housekeeping: scan failed/.test(l)))
})
