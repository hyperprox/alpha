// Certificates policy loading. Unknown keys fail with their path, so a typo cannot change where a private key
// goes or who can read it; without a file nothing is issued, and the defaults are the contract's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseCertsPolicy, loadCertsPolicy, defaultCertsPolicy, LE_PRODUCTION, LE_STAGING } from '../src/lib/certs/policy'

const EXAMPLE = path.resolve(__dirname, '../../../config/certs.example.yaml')

test('no file: not loaded, contract defaults', () => {
  const l = loadCertsPolicy('/nonexistent/certs.yaml')
  assert.equal(l.loaded, false)
  assert.match(l.error!, /No certificates policy file/)
  assert.deepEqual(l.policy, {
    acme:     { directoryUrl: LE_PRODUCTION, staging: false, email: null, keyType: 'ec256' },
    schedule: { check: '15 6 * * *' },
    alerts:   { warnFraction: 0.33, criticalDays: 7, webhookUrl: null },
    certificates: {}, probes: [], targets: {}, proxy: { guestVmid: null },
  })
})

test('an empty file and comment-only sections load as the defaults', () => {
  assert.deepEqual(parseCertsPolicy(''), defaultCertsPolicy())
  assert.deepEqual(parseCertsPolicy('# nothing\nacme:\n  # directory: staging\nprobes:\n'), defaultCertsPolicy())
})

test('the shipped example loads and every section is read', () => {
  const p = parseCertsPolicy(fs.readFileSync(EXAMPLE, 'utf8'))
  assert.equal(p.acme.directoryUrl, LE_STAGING)
  assert.equal(p.acme.staging, true)
  assert.equal(p.acme.email, 'admin@example.com')
  assert.equal(p.acme.keyType, 'ec256')
  assert.equal(p.schedule.check, '15 6 * * *')
  assert.equal(p.alerts.webhookUrl, 'https://hooks.example.com/certificates')
  assert.deepEqual(p.certificates.mail, { names: ['mail.example.com'], deploy: [{ target: 'mail-guest' }] })
  assert.deepEqual(p.certificates.wildcard.names, ['example.com', '*.example.com'])
  assert.deepEqual(p.probes[1], { host: 'mail.example.com', port: 587, starttls: 'smtp', internal: false, connect: null })
  assert.deepEqual(p.probes[2], { host: '10.0.0.20', port: 8006, starttls: 'none', internal: true, connect: null })
  assert.deepEqual(p.targets['mail-guest'], {
    kind: 'guest-files', vmid: 101,
    files: { fullchain: '/etc/ssl/mail/fullchain.pem', key: '/etc/ssl/mail/privkey.pem' },
    owner: 'root:root', keyMode: '0600', reload: 'systemctl reload postfix dovecot',
  })
  assert.deepEqual(p.targets.self, { kind: 'hyperprox' })
  assert.equal(p.proxy.guestVmid, 102)
})

test('directory: production, staging or a URL; staging is flagged', () => {
  assert.equal(parseCertsPolicy('acme: { directory: production }').acme.directoryUrl, LE_PRODUCTION)
  const s = parseCertsPolicy('acme: { directory: staging }').acme
  assert.equal(s.directoryUrl, LE_STAGING); assert.equal(s.staging, true)
  const c = parseCertsPolicy('acme: { directory: "https://ca.example.com/dir" }').acme
  assert.equal(c.directoryUrl, 'https://ca.example.com/dir'); assert.equal(c.staging, false)
  assert.equal(parseCertsPolicy(`acme: { directory: "${LE_STAGING}" }`).acme.staging, true)
  assert.throws(() => parseCertsPolicy('acme: { directory: prod }'), /acme\.directory/)
  assert.throws(() => parseCertsPolicy('acme: { directory: "http://ca.example.com/dir" }'), /acme\.directory/)
})

test('unknown keys are rejected with their path, at every level', () => {
  const cases: Array<[string, RegExp]> = [
    ['acmee: {}', /acmee: unknown key/],
    ['acme: { key_typ: ec256 }', /acme\.key_typ: unknown key/],
    ['schedule: { cron: "0 6 * * *" }', /schedule\.cron: unknown key/],
    ['alerts: { notify_webhook: true }', /alerts\.notify_webhook: unknown key/],
    ['certificates:\n  mail: { names: [mail.example.com], deploi: [] }', /certificates\.mail\.deploi: unknown key/],
    ['certificates:\n  mail: { names: [mail.example.com], deploy: [{ target: t, when: now }] }', /certificates\.mail\.deploy\.0\.when: unknown key/],
    ['probes: [{ host: mail.example.com, port: 993, sni: x }]', /probes\.0\.sni: unknown key/],
    ['targets:\n  t: { kind: hyperprox, vmid: 1 }', /targets\.t\.vmid: unknown key/],
    ['targets:\n  t: { kind: guest-files, vmid: 101, files: { fullchain: /a, key: /b, pem: /c } }', /targets\.t\.files\.pem: unknown key/],
    ['targets:\n  t: { kind: guest-files, vmid: 101, files: { fullchain: /a, key: /b }, keymode: "0600" }', /targets\.t\.keymode: unknown key/],
    ['proxy: { vmid: 102 }', /proxy\.vmid: unknown key/],
  ]
  for (const [yaml, re] of cases) assert.throws(() => parseCertsPolicy(yaml), re, yaml)
})

test('bad values are rejected with their path', () => {
  const cases: Array<[string, RegExp]> = [
    ['acme: { key_type: ec521 }', /acme\.key_type/],
    ['acme: { email: not-an-address }', /acme\.email/],
    ['schedule: { check: "15 6 * * MON" }', /schedule\.check/],
    ['alerts: { warn_fraction: 1.5 }', /alerts\.warn_fraction/],
    ['alerts: { critical_days: -1 }', /alerts\.critical_days/],
    ['alerts: { webhook_url: discord }', /alerts\.webhook_url/],
    ['certificates:\n  mail: { names: [] }', /certificates\.mail\.names/],
    ['certificates:\n  mail: { names: ["mail example com"] }', /certificates\.mail\.names\.0/],
    ['certificates:\n  mail: { names: ["mail.*.example.com"] }', /certificates\.mail\.names\.0/],
    ['certificates:\n  mail: { names: ["*.com"] }', /certificates\.mail\.names\.0/],
    ['certificates:\n  "bad label": { names: [mail.example.com] }', /certificates\.bad label: a label/],
    ['certificates:\n  mail: { names: [mail.example.com, MAIL.example.com] }', /certificates\.mail\.names: a name is listed twice/],
    ['certificates:\n  mail: { names: [mail.example.com], deploy: [{ target: nowhere }] }', /certificates\.mail\.deploy\.0\.target: no target named "nowhere"/],
    ['probes: [{ host: mail.example.com, port: 70000 }]', /probes\.0\.port/],
    ['probes: [{ host: mail.example.com, port: 993, starttls: ldap }]', /probes\.0\.starttls/],
    ['probes: [{ host: a.example.com, port: 993 }, { host: A.example.com, port: 993 }]', /probes\.1: a\.example\.com:993 is listed twice/],
    ['targets:\n  t: { kind: ftp }', /targets\.t\.kind/],
    ['targets:\n  t: { kind: guest-files, vmid: 101, files: { fullchain: relative.pem, key: /b } }', /targets\.t\.files\.fullchain/],
    ['targets:\n  t: { kind: guest-files, files: { fullchain: /a, key: /b } }', /targets\.t\.vmid/],
    ['targets:\n  t: { kind: guest-files, vmid: 101, files: { fullchain: /a, key: /b }, key_mode: "0999" }', /targets\.t\.key_mode/],
    ['targets:\n  t: { kind: guest-files, vmid: 101, files: { fullchain: /a, key: /b }, owner: "root;rm" }', /targets\.t\.owner/],
    ['targets:\n  t: { kind: guest-files, vmid: 101, files: { fullchain: /a, key: /b }, key_mode: "0644" }', /targets\.t\.key_mode: a mode that gives other users no access/],
    ['targets:\n  t: { kind: guest-files, vmid: 101, files: { fullchain: /a, key: /b }, key_mode: 604 }', /targets\.t\.key_mode: a mode that gives other users no access/],
    ['targets:\n  t: { kind: guest-files, vmid: 101, files: { fullchain: /a, key: /b }, key_mode: "0601" }', /targets\.t\.key_mode/],
    ['targets:\n  t: { kind: guest-files, vmid: 101, files: { fullchain: /a, key: /a } }', /targets\.t\.files\.key: the same path as fullchain/],
    ['targets:\n  t: { kind: guest-files, vmid: 101, files: { fullchain: /a, key: /b, cert: /c, chain: /c } }', /targets\.t\.files\.chain: the same path as cert/],
    ['targets:\n  t: { kind: guest-files, vmid: 101, files: { fullchain: /etc/ssl/a.pem, key: /etc/ssl//./a.pem } }', /targets\.t\.files\.key: the same path as fullchain/],
    ['proxy: { guest_vmid: 0 }', /proxy\.guest_vmid/],
    ['- a\n- list', /mapping/],
    ['acme: [unclosed', /YAML/],
  ]
  for (const [yaml, re] of cases) assert.throws(() => parseCertsPolicy(yaml), re, yaml)
})

test('names are normalised; key modes are four octal digits whether quoted or not', () => {
  const p = parseCertsPolicy(`
certificates:
  web: { names: [WWW.Example.com, "*.Example.com"] }
targets:
  a: { kind: guest-files, vmid: 101, files: { fullchain: /a, key: /b }, key_mode: "640" }
  b: { kind: guest-files, vmid: 101, files: { fullchain: /a, key: /b }, key_mode: 0600, owner: "mail:ssl-cert", reload: null }
  c: { kind: guest-files, vmid: 101, files: { fullchain: /a, key: /b, cert: /c, chain: /d } }
`)
  assert.deepEqual(p.certificates.web, { names: ['www.example.com', '*.example.com'], deploy: [] })
  const a = p.targets.a, b = p.targets.b, c = p.targets.c
  assert.ok(a.kind === 'guest-files' && b.kind === 'guest-files' && c.kind === 'guest-files')
  assert.equal(a.keyMode, '0640')
  assert.equal(b.keyMode, '0600')
  assert.equal(b.owner, 'mail:ssl-cert')
  assert.equal(b.reload, null)
  assert.deepEqual(c.files, { fullchain: '/a', key: '/b', cert: '/c', chain: '/d' })
  assert.equal(c.owner, 'root:root'); assert.equal(c.keyMode, '0600'); assert.equal(c.reload, null)
})

test('a broken file loads as not-loaded with the reason, never half-applied', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-certs-'))
  const f = path.join(dir, 'certs.yaml')
  fs.writeFileSync(f, 'acme: { directory: staging }\ncertificates:\n  mail: { names: [mail.example.com], deploy: [{ target: missing }] }\n')
  const l = loadCertsPolicy(f)
  assert.equal(l.loaded, false)
  assert.match(l.error!, /Policy file rejected: .*deploy\.0\.target/)
  assert.deepEqual(l.policy, defaultCertsPolicy(), 'the defaults, not the half-read file')
  fs.writeFileSync(f, 'acme: { directory: staging }\n')
  const ok = loadCertsPolicy(f)
  assert.equal(ok.loaded, true); assert.equal(ok.error, undefined); assert.equal(ok.policy.acme.staging, true)
  fs.rmSync(dir, { recursive: true })
})

test('CERTS_POLICY_PATH picks the file', () => {
  const before = process.env.CERTS_POLICY_PATH
  process.env.CERTS_POLICY_PATH = '/nonexistent/elsewhere.yaml'
  try { assert.equal(loadCertsPolicy().path, '/nonexistent/elsewhere.yaml') }
  finally { if (before === undefined) delete process.env.CERTS_POLICY_PATH; else process.env.CERTS_POLICY_PATH = before }
})

test("a probe may connect to another address than the name it verifies", () => {
  const p = parseCertsPolicy("probes:\n  - { host: Mail.Example.com, port: 993, connect: 10.0.0.20 }\n")
  assert.deepEqual(p.probes[0], { host: "mail.example.com", port: 993, starttls: "none", internal: false, connect: "10.0.0.20" })
  assert.equal(parseCertsPolicy("probes:\n  - { host: a.example.com, port: 443 }\n").probes[0].connect, null)
})
