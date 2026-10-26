// Housekeeping: expired-and-unused proxy certificates (deleted through the API on apply) and certbot files the
// proxy no longer knows (archived on apply, never removed). The proxy guest is a fake shell; the archive test
// runs the generated script for real against a temporary directory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { listHousekeeping, applyHousekeeping, shq, ARCHIVE_DIR, type HousekeepingDeps } from '../src/lib/certs/housekeeping'
import type { NPMCertificate } from '../src/lib/npm-client'

const NOW = new Date('2026-10-26T06:15:00Z')
const cert = (id: number, expires: string, names = [`h${id}.example.com`]): NPMCertificate =>
  ({ id, nice_name: names[0], domain_names: names, expires_on: expires, provider: 'letsencrypt', meta: {} })

function deps(o: Partial<HousekeepingDeps> & { certs?: NPMCertificate[]; hosts?: { certificate_id: number | null }[] } = {}) {
  const deleted: number[] = []
  const d: HousekeepingDeps = {
    npmCertificates: async () => o.certs ?? [cert(1, '2026-01-01T00:00:00Z'), cert(2, '2026-02-01T00:00:00Z'), cert(3, '2027-01-01T00:00:00Z'), cert(4, '2026-03-01T00:00:00Z')],
    npmCertificateUsers: o.npmCertificateUsers ?? (async () => o.hosts ?? [{ certificate_id: 2 }, { certificate_id: 3 }, { certificate_id: null }]),
    deleteNpmCertificate: async id => { deleted.push(id) },
    guestExec: o.guestExec ?? null,
    npmLoginIsAdmin: o.npmLoginIsAdmin ?? (async () => true),
    warn: o.warn,
  }
  return { d, deleted }
}

test('API only: expired and attached to nothing; expired but used, and valid but unused, are left alone', async () => {
  const { d } = deps()
  const items = await listHousekeeping(d, NOW)
  assert.deepEqual(items.map(i => [i.id, i.kind, i.expiredAt]), [
    ['npm-cert:1', 'proxy-expired-unused', '2026-01-01T00:00:00.000Z'],
    ['npm-cert:4', 'proxy-expired-unused', '2026-03-01T00:00:00.000Z'],
  ])
  assert.match(items[0].detail, /#1 \(h1\.example\.com\) has expired and no proxy host, redirection, 404 host or stream uses it/)
})

test('a certificate used only by a redirection, 404 host or stream is not unused', async () => {
  // The production source flattens proxy, redirection and 404 hosts and streams into this one list.
  const { d } = deps({ hosts: [{ certificate_id: 2 }, { certificate_id: 3 }, { certificate_id: 4 }] })
  assert.deepEqual((await listHousekeeping(d, NOW)).map(i => i.id), ['npm-cert:1'])
})

test('if any host list cannot be read, nothing is listed and nothing is deleted', async () => {
  const { d, deleted } = deps({ npmCertificateUsers: async () => { throw new Error('GET /nginx/streams failed 500') } })
  await assert.rejects(listHousekeeping(d, NOW), /streams failed/)
  const item = { id: 'npm-cert:1', kind: 'proxy-expired-unused' as const, names: [], expiredAt: null, detail: '' }
  await assert.rejects(applyHousekeeping(item, d), /streams failed/)
  assert.deepEqual(deleted, [])
})

test('apply deletes through the API, but re-checks first', async () => {
  const { d, deleted } = deps()
  const [item] = await listHousekeeping(d, NOW)
  assert.equal(await applyHousekeeping(item, d), 'Deleted proxy certificate #1 (h1.example.com).')
  assert.deepEqual(deleted, [1])

  // A host picked the certificate up after the list was made.
  const later = deps({ hosts: [{ certificate_id: 1 }] })
  await assert.rejects(applyHousekeeping(item, later.d), /no longer both expired and unused/)
  assert.deepEqual(later.deleted, [])

  const gone = deps({ certs: [] })
  assert.match(await applyHousekeeping(item, gone.d), /already gone/)
  await assert.rejects(applyHousekeeping({ ...item, id: 'npm-cert:abc' }, d), /not a proxy certificate item/)
  await assert.rejects(applyHousekeeping({ ...item, id: 'what:1' }, d), /unknown housekeeping item/)
})

// --- on disk -------------------------------------------------------------------

const LE = '/srv/proxy/letsencrypt'
const PEM_B64 = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'certs-hk-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'k', '-out', 'c',
    '-days', '1', '-subj', '/CN=old.example.com', '-addext', 'subjectAltName=DNS:old.example.com,DNS:www.old.example.com'], { cwd: dir, stdio: 'ignore' })
  const b = fs.readFileSync(path.join(dir, 'c')).toString('base64')
  fs.rmSync(dir, { recursive: true, force: true })
  return b
})()

const DATA = '/srv/proxy/data'

/** A proxy guest whose docker shows the proxy's container plus an unrelated one. `refs`: ids nginx still uses. */
function fakeGuest(listing: string, mounts = `jc21/nginx-proxy-manager:latest\t${LE}\t${DATA}\nredis:7\t\t\n`, refs: number[] = []) {
  const scripts: string[] = []
  const exec = async (script: string) => {
    scripts.push(script)
    if (script.includes('docker inspect')) return { code: 0, output: mounts }
    if (script.includes('grep -rqF')) return { code: 0, output: refs.map(i => `REF\t${i}\n`).join('') }
    if (script.includes('PATH')) return { code: 0, output: listing }
    return { code: 0, output: 'moved' }
  }
  return { exec, scripts }
}

const LISTING = [
  `PATH\t${LE}/live/npm-1`, `PATH\t${LE}/live/npm-7`, `PATH\t${LE}/archive/npm-7`, `PATH\t${LE}/renewal/npm-7.conf`,
  `PATH\t${LE}/renewal/npm-9.conf`, `CERT\tnpm-7\t${PEM_B64}`, `CERT\tnpm-1\t${PEM_B64}`, '',
].join('\n')

test('orphan files: certbot dirs for ids the proxy does not have, found under the mount docker reports', async () => {
  const g = fakeGuest(LISTING)
  const { d } = deps({ guestExec: g.exec })
  const items = (await listHousekeeping(d, NOW)).filter(i => i.kind === 'proxy-orphan-files')
  assert.deepEqual(items.map(i => i.id), ['npm-files:7', 'npm-files:9'])
  assert.deepEqual(items[0].names, ['old.example.com', 'www.old.example.com'])
  assert.match(items[0].detail, new RegExp(`${LE}/live/npm-7, ${LE}/archive/npm-7, ${LE}/renewal/npm-7.conf`))
  assert.match(items[0].detail, /nothing is deleted/)
  assert.deepEqual(items[1].names, [])
  // The directories came from docker, quoted, never typed in.
  assert.ok(g.scripts.some(s => s.includes(`d='${LE}'`)))
  const refs = g.scripts.find(s => s.includes('grep -rqF'))!
  assert.ok(refs.includes(`d='${DATA}'/nginx`))
  assert.match(refs, /for id in 7 9; do/)
  // Listing is read-only.
  assert.ok(g.scripts.every(s => !/\bmv\b|\brm\b|mkdir/.test(s)))
})

test('orphan files the proxy\'s nginx config still references are not listed', async () => {
  const g = fakeGuest(LISTING, undefined, [7])
  const warnings: string[] = []
  const items = (await listHousekeeping(deps({ guestExec: g.exec, warn: m => warnings.push(m) }).d, NOW)).filter(i => i.kind === 'proxy-orphan-files')
  assert.deepEqual(items.map(i => i.id), ['npm-files:9'])
  assert.match(warnings.join('\n'), /npm-7 .*still uses it; left alone/)
})

test('orphan files are refused when hosts use certificates the list does not show, or /data cannot be found', async () => {
  // Host uses #5, which the certificate list lacks: the API login cannot see everything.
  const hidden = fakeGuest(LISTING)
  await assert.rejects(listHousekeeping(deps({ guestExec: hidden.exec, hosts: [{ certificate_id: 5 }] }).d, NOW), /#5, which the certificate list does not show/)
  assert.ok(!hidden.scripts.some(s => s.includes('PATH')), 'the disk is not even scanned')
  const warnings: string[] = []
  const items = await listHousekeeping(deps({ guestExec: hidden.exec, hosts: [{ certificate_id: 5 }], warn: m => warnings.push(m) }).d, NOW)
  assert.ok(!items.some(i => i.kind === 'proxy-orphan-files'))
  assert.match(warnings[0], /cannot see every certificate/)

  const noData = fakeGuest(LISTING, `jc21/nginx-proxy-manager:latest\t${LE}\t\n`)
  await assert.rejects(listHousekeeping(deps({ guestExec: noData.exec }).d, NOW), /mounts \/data/)
})

test('the letsencrypt dir is not guessed: none, or several unrelated, is an error', async () => {
  const none = fakeGuest(LISTING, 'redis:7\t\t\n')
  await assert.rejects(listHousekeeping(deps({ guestExec: none.exec }).d, NOW), /no running container in the proxy guest mounts \/etc\/letsencrypt/)
  const two = fakeGuest(LISTING, 'a:1\t/x\t/dx\nb:1\t/y\t/dy\n')
  await assert.rejects(listHousekeeping(deps({ guestExec: two.exec }).d, NOW), /not guessing/)
  // With a warn hook the API items still come back, and the failure is said out loud.
  const warnings: string[] = []
  const items = await listHousekeeping(deps({ guestExec: two.exec, warn: m => warnings.push(m) }).d, NOW)
  assert.equal(items.length, 2)
  assert.match(warnings[0], /could not check the proxy's certificate files/)
})

test('apply on orphan files moves them, keeping certbot\'s layout, and refuses if the proxy now knows the id', async () => {
  // Run the generated scripts for real against a temporary tree standing in for the guest's disk.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "certs-hk le'dir "))
  for (const p of ['live/npm-7', 'archive/npm-7', 'renewal', 'live/npm-1', 'live/npm-8']) fs.mkdirSync(path.join(root, p), { recursive: true })
  // The proxy's /data: its nginx config still points at npm-8 although the API no longer lists it.
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "certs-hk data'dir "))
  fs.mkdirSync(path.join(data, 'nginx/proxy_host'), { recursive: true })
  fs.writeFileSync(path.join(data, 'nginx/proxy_host/3.conf'), 'ssl_certificate /etc/letsencrypt/live/npm-8/fullchain.pem;\n')
  fs.writeFileSync(path.join(root, 'archive/npm-7/cert1.pem'), 'x')
  fs.symlinkSync('../../archive/npm-7/cert1.pem', path.join(root, 'live/npm-7/cert.pem'))
  fs.writeFileSync(path.join(root, 'renewal/npm-7.conf'), 'x')
  const exec = async (script: string) => {
    if (script.includes('docker inspect')) return { code: 0, output: `jc21/nginx-proxy-manager:2\t${root}\t${data}\n` }
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    return { code: r.status ?? 1, output: r.stdout + r.stderr }
  }
  try {
    const { d } = deps({ guestExec: exec })
    const listed = await listHousekeeping(d, NOW)
    assert.ok(!listed.some(i => i.id === 'npm-files:8'), 'still referenced by nginx')
    const item = listed.find(i => i.id === 'npm-files:7')!
    assert.ok(item)
    await assert.rejects(applyHousekeeping({ ...item, id: 'npm-files:8' }, d), /nginx configuration uses npm-8/)
    assert.ok(fs.existsSync(path.join(root, 'live/npm-8')))
    const detail = await applyHousekeeping(item, d)
    assert.match(detail, /^Archived 3 path\(s\) for npm-7 into /)
    assert.ok(!fs.existsSync(path.join(root, 'live/npm-7')))
    assert.ok(!fs.existsSync(path.join(root, 'renewal/npm-7.conf')))
    assert.ok(fs.existsSync(path.join(root, 'live/npm-1')))          // the proxy's own: untouched
    const [stamp] = fs.readdirSync(path.join(root, ARCHIVE_DIR))
    const kept = path.join(root, ARCHIVE_DIR, stamp)
    assert.equal(fs.readFileSync(path.join(kept, 'live/npm-7/cert.pem'), 'utf8'), 'x')   // the relative link still resolves
    assert.ok(fs.existsSync(path.join(kept, 'renewal/npm-7.conf')))
    assert.match(await applyHousekeeping(item, d), /Nothing left for npm-7/)

    const known = deps({ guestExec: exec, certs: [cert(7, '2027-01-01T00:00:00Z')] })
    await assert.rejects(applyHousekeeping(item, known.d), /now has a certificate #7/)
    await assert.rejects(applyHousekeeping(item, deps().d), /no proxy guest is configured/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(data, { recursive: true, force: true })
  }
})

test('shell quoting survives quotes and spaces', () => {
  const out = execFileSync('bash', ['-c', `printf %s ${shq("a b'c$d")}`], { encoding: 'utf8' })
  assert.equal(out, "a b'c$d")
})

test('orphan files are refused unless the proxy login is an administrator', async () => {
  const g = fakeGuest(LISTING).exec
  await assert.rejects(listHousekeeping(deps({ guestExec: g, npmLoginIsAdmin: async () => false }).d, NOW), /not an administrator/)
  await assert.rejects(listHousekeeping(deps({ guestExec: g, npmLoginIsAdmin: async () => { throw new Error('403') } }).d, NOW), /not an administrator/)
})
