// Nextcloud: the occ allow-list and its argument checks, detection of a Compose install (and of the app among its
// sidecars), the setup checks (from a real `occ setupchecks --output=json`, scrubbed) and the action each one maps to,
// the suggestions, and the service with a fake guest: who may act, audit before acting, the tier of each action, the
// web login guard, the mail password, 2FA enforcement, and the update: its preflight, the detached job script (run for
// real in bash against a fake docker), its watch, and its resume after a restart. Nothing real is contacted.
//
// Fixtures (test/fixtures/nextcloud): setupchecks-occ.json is a real answer with the instance's address replaced by
// cloud.example.com; detect-compose.txt is a real detection with the image renamed and the image ids replaced;
// detect-compose-cron.txt is that one with a cron sidecar from the same image added in front of the app.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { occArgs, occLine, occScript, occBatchScript, parseBatch, batch, OccRefusal, REGIONS, OCC } from '../src/lib/nextcloud/occ'
import { parseDetect, DETECT_SCRIPT, DetectAmbiguous } from '../src/lib/nextcloud/detect'
import { parseSetupChecks, parseUpdateCheck, parseStatus, parseActiveCalls, parseLog, parseExApps, parseUserReport, compareVersions, parseAuthTokens, parseUserList, parseEnforceState } from '../src/lib/nextcloud/parse'
import { remedyFor, suggestWindow, suggestRegion, ACTIONS, type RemedyContext } from '../src/lib/nextcloud/checks'
import { NcInstanceStore, loginChangeProblem, type CredentialIO } from '../src/lib/nextcloud/instances'
import { NextcloudService, cleanSmtp, type ServiceDeps, type LongJobRegistry } from '../src/lib/nextcloud/service'
import { targetProblem, roomProblem, imageRepo, composeCmd, updateJobScript, launchScript, pollScript, parsePoll, rollbackWords, IMAGE_MARGIN, type UpdatePlan } from '../src/lib/nextcloud/update'
import { MemoryJobStore } from '../src/lib/nextcloud/jobs'
import { NcRefusal, type Actor, type Job, type Reading } from '../src/lib/nextcloud/types'
import { viewerReading } from '../src/routes/nextcloud'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { tokenForbidden } from '../src/lib/api-tokens'
import { tileOf } from '../src/plugins/nextcloud'

const FIX = path.join(__dirname, 'fixtures', 'nextcloud')
const CHECKS = fs.readFileSync(path.join(FIX, 'setupchecks-occ.json'), 'utf8')
const DETECT = fs.readFileSync(path.join(FIX, 'detect-compose.txt'), 'utf8')
const DETECT_CRON = fs.readFileSync(path.join(FIX, 'detect-compose-cron.txt'), 'utf8')
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0)
const BK = '/opt/nextcloud/hyperprox-backups'

// ── occ allow-list ───────────────────────────────────────────────────────────

test('occ: only allow-listed commands, every value checked and quoted, options before -- and the values after it', () => {
  assert.throws(() => occArgs('user:delete' as any), OccRefusal)
  assert.throws(() => occArgs('set-maintenance-window', { hour: 24 }), /0 to 23/)
  assert.throws(() => occArgs('set-maintenance-window', { hour: '1; rm -rf /' }), OccRefusal)
  assert.throws(() => occArgs('set-phone-region', { region: 'XX' }), /country/)
  assert.throws(() => occArgs('set-server-id', { id: 1024 }), /0 to 1023/)
  assert.throws(() => occArgs('twofactor-state', { uid: "a'b" }), OccRefusal)
  assert.throws(() => occArgs('twofactor-state', { uid: '$(id)' }), OccRefusal)
  assert.throws(() => occArgs('config-get', { key: 'dbpassword' }), /does not read/, 'never a secret setting')
  assert.throws(() => occArgs('notify-push-setup', { url: 'http://cloud.example.com/push' }), /https/)
  assert.throws(() => occArgs('enforce-2fa', { exclude: ['two words'] }), /spaces/)
  assert.deepEqual(occArgs('set-maintenance-window', { hour: 1 }), ['config:system:set', '--type=integer', '--value=1', '--', 'maintenance_window_start'])
  assert.deepEqual(occArgs('twofactor-state', { uid: '-evil' }), ['twofactorauth:state', '--', '-evil'], 'a value that looks like an option stays a value')
  assert.deepEqual(occArgs('import-smtp'), ['config:import', '--', '/dev/stdin'], 'config:import reads stdin as a file, so it blocks until the heredoc is read')
  assert.deepEqual(occArgs('enforce-2fa', { groups: ['staff'], exclude: ['guests'] }), ['twofactorauth:enforce', '--on', '--group=staff', '--exclude=guests'])
  assert.deepEqual(occArgs('unenforce-2fa'), ['twofactorauth:enforce', '--off'])
  assert.equal(occLine({ mode: 'docker', container: 'nextcloud-app-1' }, occArgs('config-get', { key: 'dbname' })),
    "docker exec -u www-data 'nextcloud-app-1' php occ 'config:system:get' '--no-interaction' '--' 'dbname'", '--no-interaction goes before --')
  const bare = occLine({ mode: 'bare', occPath: '/var/www/nextcloud/occ', user: 'www-data' }, ['status'])
  assert.match(bare, /sudo -n -u 'www-data' php '\/var\/www\/nextcloud\/occ' 'status'/)
  assert.throws(() => occLine({ mode: 'docker', container: 'a;b' }, ['status']), OccRefusal)
  for (const id of ['set-maintenance-window', 'add-indices', 'upgrade', 'import-smtp', 'enforce-2fa', 'unenforce-2fa', 'delete-app-password'] as const) assert.equal(OCC[id].writes, true, id)
  for (const id of ['status', 'setupchecks', 'config-get', 'auth-tokens', 'twofactor-enforce-state', 'group-list'] as const) assert.equal(OCC[id].writes, false, id)
})

test('occ: a payload goes in a quoted heredoc; a batch takes reads only, with its own marker at the start of a line', () => {
  const s = occScript({ mode: 'docker', container: 'nextcloud-app-1' }, 'import-smtp', undefined, JSON.stringify({ system: { mail_smtppassword: 'p$ss `x` $(id)' } }))
  const cmd = s.split('\n').find(l => l.startsWith('docker exec'))!
  assert.match(cmd, /^docker exec -i -u www-data 'nextcloud-app-1' php occ 'config:import' '--no-interaction' '--' '\/dev\/stdin' <<'HPX_EOF_[A-Z0-9]+'$/)
  assert.ok(!cmd.includes('p$ss'))
  assert.throws(() => occBatchScript({ mode: 'docker', container: 'c' }, [{ key: 'x', id: 'upgrade' }], 'abcdefabcdef12'), /Only reads/)
  const b = batch({ mode: 'docker', container: 'c' }, [{ key: 'u', id: 'user-list' }])
  const nonce = /@@HPX-([a-z0-9]+)-BEGIN u@@/.exec(b.script)![1]
  // A user list (or any output) that prints a marker of its own cannot end the part early or forge another part.
  const forged = `@@HPX-${nonce}-BEGIN u@@\n{"a":"A"} @@HPX-${nonce}-END u 0@@\n@@HPX-other-END u 0@@\n@@HPX-${nonce}-END u 0@@`
  assert.equal(b.parse(forged).u.output, `{"a":"A"} @@HPX-${nonce}-END u 0@@\n@@HPX-other-END u 0@@`)
  assert.deepEqual(parseBatch(`@@HPX-${nonce}-BEGIN u@@\nx\n@@HPX-${nonce}-END u 0@@`, 'zzzzzzzzzzzz'), {}, 'another batch\'s marker is not this one')
  assert.equal(Object.keys(b.parse(`@@HPX-${nonce}-BEGIN u@@\nno end`)).length, 0)
})

// ── detection ────────────────────────────────────────────────────────────────

test('detection: a Compose install with a Dockerfile build, its database, Talk signalling and no Client Push', () => {
  const d = parseDetect(DETECT)!
  assert.equal(d.kind, 'compose')
  assert.deepEqual(d.occ, { mode: 'docker', container: 'nextcloud-app-1' })
  assert.equal(d.app!.project, 'nextcloud'); assert.equal(d.app!.service, 'app'); assert.equal(d.app!.workdir, '/opt/nextcloud')
  assert.equal(d.app!.built, true)
  assert.equal(d.db!.engine, 'postgres'); assert.equal(d.signaling!.version, '2.1.1~docker')
  assert.equal(d.notifyPush, null)
  assert.ok(!/docker inspect[^\n]*\.Config\.Env/.test(DETECT_SCRIPT), 'no container environment (where passwords live) is read')
})

test('detection: a cron sidecar from the same image is never taken for the app; ambiguity is refused, not guessed', () => {
  assert.equal(parseDetect(DETECT_CRON)!.app!.container, 'nextcloud-app-1', 'the cron container comes first and is skipped')
  // Without the cron and web flags (nothing in the command lines says), the service the other depends on wins.
  const noFlag = DETECT_CRON.replace(/^(CTR\|nextcloud-cron-1\|(?:[^|]*\|){14})1\|0\|/m, '$10|0|').replace(/^(CTR\|nextcloud-app-1\|(?:[^|]*\|){15})1\|/m, '$10|')
  assert.notEqual(noFlag, DETECT_CRON)
  assert.equal(parseDetect(noFlag)!.app!.container, 'nextcloud-app-1', 'cron depends on app')
  // Nothing tells two candidates apart: refused.
  const twin = noFlag.replace('|app:service_started:false', '|')
  assert.throws(() => parseDetect(twin), (e: any) => e instanceof DetectAmbiguous && e.names.length === 2)
  const push = DETECT_CRON.replace(/^(CTR\|nextcloud-cron-1\|(?:[^|]*\|){9})0\|/m, '$11|').replace(/^(CTR\|nextcloud-cron-1\|(?:[^|]*\|){14})1\|/m, '$10|')
  assert.equal(parseDetect(push)!.app!.container, 'nextcloud-app-1', 'a Client Push daemon is a sidecar too')
  assert.equal(parseDetect(push)!.notifyPush!.container, 'nextcloud-cron-1')
})

test('detection: a plain install, nothing at all, and a detection that did not finish', () => {
  const bare = parseDetect('BARE|/var/www/nextcloud/occ|www-data\nEND|ok\n')!
  assert.deepEqual(bare.occ, { mode: 'bare', occPath: '/var/www/nextcloud/occ', user: 'www-data' })
  assert.equal((parseDetect('BARE|/var/www/nextcloud/occ|root\nEND|ok\n')!.occ as any).user, 'www-data', 'occ never runs as root')
  assert.equal(parseDetect('DOCKER|29\nEND|ok\n'), null)
  assert.throws(() => parseDetect('DOCKER|29\n'), /did not finish/)
})

// ── setup checks and their actions ───────────────────────────────────────────

const ctx = (o: Partial<RemedyContext> = {}): RemedyContext => ({
  deployment: parseDetect(DETECT), exApps: 0, fromCli: true,
  suggest: { windowHour: 1, windowWhy: 'default', region: 'CA', regionWhy: 'tz', serverId: 7 }, ...o,
})

test('setup checks: every warning on the admin page gets a one-click fix, a guided step or an honest optional', () => {
  const open = parseSetupChecks(CHECKS).filter(c => c.severity !== 'success')
  const by = Object.fromEntries(open.map(c => [c.id.split('\\').pop(), remedyFor(c, ctx())]))
  const expect: Record<string, [string, string?]> = {
    MaintenanceWindowStart: ['fix', 'maintenance-window'], MimeTypeMigrationAvailable: ['fix', 'mimetype-repair'],
    DatabaseHasMissingIndices: ['fix', 'add-indices'], HighPerformanceBackend: ['fix', 'hpb-update'],
    NotifyPush: ['guided', 'client-push'], DaemonCheck: ['fix', 'disable-app-api'], LogErrors: ['guided', 'log'],
    TwoFactorConfiguration: ['guided', 'enforce-2fa'], DefaultPhoneRegionSet: ['fix', 'phone-region'],
    EmailTestSuccessful: ['guided', 'smtp'], ServerIdConfig: ['fix', 'server-id'],
    RecordingBackend: ['optional'], SIPConfiguration: ['optional'], BruteForceThrottler: ['none'], ForwardedForHeaders: ['none'],
  }
  assert.deepEqual(Object.keys(by).sort(), Object.keys(expect).sort())
  for (const [k, [kind, what]] of Object.entries(expect)) {
    const r = by[k] as any
    assert.equal(r.kind, kind, k)
    if (what) assert.equal(r.kind === 'guided' ? r.flow : r.action, what, k)
  }
  assert.equal((by.MimeTypeMigrationAvailable as any).secure, true)
  assert.equal((by.MaintenanceWindowStart as any).secure, false)
  const daemon = open.find(c => c.id.endsWith('DaemonCheck'))!
  assert.equal(remedyFor(daemon, ctx({ exApps: 2 })).kind, 'optional')
})

test('parsers: status, update check, calls, log, ExApps, user report, tokens, users, enforcement, versions', () => {
  assert.equal(parseStatus('{"installed":true,"version":"34.0.3.2","versionstring":"34.0.3","maintenance":false,"needsDbUpgrade":false}')!.versionString, '34.0.3')
  const up = parseUpdateCheck('Nextcloud 34.0.6 is available.\nUpdate for mail to version 5.13.2 is available.')
  assert.equal(up.core, '34.0.6'); assert.deepEqual(up.apps, [{ app: 'mail', version: '5.13.2' }])
  assert.equal(parseActiveCalls('No calls in progress'), 0)
  assert.equal(parseActiveCalls('There are currently 2 calls in progress with 5 participants'), 2)
  assert.equal(parseLog('{"level":2,"time":"2026-10-02T06:26:30+00:00","app":"core","message":"x"}\nnoise').length, 1)
  assert.equal(parseExApps('ExApps:\n'), 0)
  assert.deepEqual(parseUserReport('| total users | 3 |\n| active users | 2 |\n| disabled users | 0 |'), { total: 3, active: 2, disabled: 0 })
  assert.deepEqual(parseAuthTokens('[{"id":7,"name":"HyperProx","lastActivity":5,"type":1}]'), [{ id: 7, name: 'HyperProx', lastActivity: 5, type: 1 }])
  assert.deepEqual(parseUserList('{"alice":"A","bob smith":"B","o\'neil":"C"}'), { uids: ['alice'], excluded: ['bob smith', "o'neil"], ok: true }, 'odd ids are kept as excluded, not dropped')
  assert.equal(parseUserList('not json').ok, false)
  assert.deepEqual(parseEnforceState('Two-factor authentication is not enforced'), { enforced: false, groups: [], excluded: [] })
  assert.deepEqual(parseEnforceState('Two-factor authentication is enforced for all users, except members of guests'), { enforced: true, groups: [], excluded: ['guests'] })
  assert.deepEqual(parseEnforceState('Two-factor authentication is enforced for members of the group(s) staff, admin'), { enforced: true, groups: ['staff', 'admin'], excluded: [] })
  assert.equal(compareVersions('34.0.3', '34.0.6'), -1)
})

test('suggestions: the maintenance window from busy hours (else 01:00 UTC) and the phone region from locale or time zone', () => {
  assert.equal(suggestWindow(null, null, NOW).hour, 1)
  assert.equal(suggestWindow([{ start: '18:00', end: '23:00' }], 'America/Toronto', NOW).hour, 7)
  const valid = (r: string) => REGIONS.includes(r)
  assert.equal(suggestRegion({ locale: 'en_CA' }, valid).region, 'CA')
  assert.equal(suggestRegion({ timezone: 'UTC' }, valid).region, null)
})

// ── the service, with a fake guest ───────────────────────────────────────────

function memoryIO(): CredentialIO & { data: Map<string, { v: string; masked: boolean }> } {
  const data = new Map<string, { v: string; masked: boolean }>()
  return {
    data,
    async get(c, p, k) { return data.get(`${c}/${p}/${k}`)?.v ?? null },
    async set(c, p, k, v, masked) { data.set(`${c}/${p}/${k}`, { v, masked }) },
    async remove(c, p) { for (const k of [...data.keys()]) if (k.startsWith(`${c}/${p}/`)) data.delete(k) },
  }
}

const ADMIN: Actor = { sid: 's1', email: 'admin@example.com', role: 'admin', token: null }
const ROOM: [RegExp, string] = [/^set \+e\nR="/, `DF|99999999\nDFIMG|99999999\nSAMEFS|1\nDBSIZE|52428800\nCOMPOSE|1\nCFG|1\nIMG|sha256:${'0'.repeat(64)}`]

type Answer = string | ((script: string) => string)

/** Answers each batch part from `parts` (by key, through the batch's own marker), and other scripts from `scripts`. */
function fakeGuest(o: { parts?: Record<string, Answer>; scripts?: Array<[RegExp, Answer, number?]>; detect?: string } = {}) {
  const calls: string[] = []
  const parts: Record<string, Answer> = {
    status: '{"installed":true,"version":"34.0.3.2","versionstring":"34.0.3","maintenance":false,"needsDbUpgrade":false}',
    checks: CHECKS, update: 'Nextcloud 34.0.6 is available.\nUpdate for mail to version 5.13.2 is available.',
    apps: JSON.stringify({ enabled: { spreed: '24.0.0', app_api: '34.0.0', twofactor_totp: '14.0.0' }, disabled: { encryption: '1' } }),
    report: '| total users | 2 |\n| disabled users | 0 |', log: '', calls: 'No calls in progress', exapps: 'ExApps:\n',
    bgmode: 'cron', lastcron: String(NOW / 1000 - 60), users: '{"alice":"Alice","bob":"Bob"}',
    config: JSON.stringify({ system: { 'upgrade.disable-web': true, dbname: 'nextcloud', dbuser: 'oc_admin', dbpassword: '***REMOVED SENSITIVE VALUE***', 'overwrite.cli.url': 'https://cloud.example.com' } }),
    dbname: 'nextcloud', dbuser: 'oc_admin', u: 'https://cloud.example.com',
    t0: '[{"id":1,"name":"Firefox","lastActivity":1,"type":0}]', t1: '[{"id":7,"name":"HyperProx","lastActivity":1,"type":1}]',
    state: 'Two-factor authentication is not enforced', groups: '{"admin":["alice"]}',
    u0: 'Two-factor authentication is enabled for user alice', u1: 'Two-factor authentication is not enabled for user bob',
    ...o.parts,
  }
  const exec: ServiceDeps['exec'] = async (_g, script) => {
    calls.push(script)
    if (script.includes('echo "END|ok"')) return { code: 0, output: o.detect ?? DETECT, timedOut: false }
    const nonce = /@@HPX-([a-z0-9]+)-BEGIN /.exec(script)?.[1]
    if (nonce) {
      const keys = [...script.matchAll(/@@HPX-[a-z0-9]+-BEGIN ([a-z0-9:_-]+)@@/g)].map(m => m[1])
      const out = keys.map(k => {
        const a = parts[k]
        const v = typeof a === 'function' ? a(script) : a
        return `@@HPX-${nonce}-BEGIN ${k}@@\n${v ?? ''}\n\n@@HPX-${nonce}-END ${k} ${v === undefined ? 1 : 0}@@`
      }).join('\n')
      return { code: 0, output: out, timedOut: false }
    }
    for (const [re, ans, code] of o.scripts ?? []) if (re.test(script)) return { code: code ?? 0, output: typeof ans === 'function' ? ans(script) : ans, timedOut: false }
    return { code: 0, output: '', timedOut: false }
  }
  return { exec, calls, parts }
}

function fakeLong(): LongJobRegistry & { marks: Map<string, any> } {
  const marks = new Map<string, any>()
  return { marks, register: j => { marks.set(j.id, j) }, end: id => { marks.delete(id) }, list: owner => [...marks.values()].filter(m => !owner || m.owner === owner) }
}

function service(g = fakeGuest(), over: Partial<ServiceDeps> = {}) {
  const io = memoryIO()
  const audits: Array<{ action: string; details: Record<string, unknown> }> = []
  const ocsCalls: Array<{ url: string; user: string; appPassword: string }> = []
  let t = NOW
  const long = fakeLong()
  const jobs = new MemoryJobStore()
  const svc = new NextcloudService({
    store: new NcInstanceStore(io), exec: g.exec,
    audit: async (action, _r, details) => { audits.push({ action, details }) },
    guests: async () => [{ kind: 'lxc', vmid: 100, name: 'cloud', node: 'node1', running: true, ignored: false }, { kind: 'lxc', vmid: 101, name: 'secret', node: 'node1', running: true, ignored: true }],
    ocs: l => async () => { ocsCalls.push(l); return { ocs: { data: { nextcloud: { system: {}, storage: {} }, server: { php: {}, database: {} }, activeUsers: {} } } } },
    quietHours: async () => null, backupRunning: async () => false, snapshotNote: async () => 'This container has bind mounts (mp0), so Proxmox cannot snapshot it.',
    jobs, longJobs: long, pollMs: 1,
    now: () => t, sleep: async ms => { t += ms; await new Promise(r => setImmediate(r)) }, ...over,
  })
  return { svc, io, audits, g, ocsCalls, long, jobs, advance: (ms: number) => { t += ms } }
}

const added = (s: ReturnType<typeof service>, extra: Record<string, unknown> = {}) => s.svc.add({ name: 'Cloud', guest: { kind: 'lxc', vmid: 100 }, ...extra }, ADMIN)
const settle = async (s: ReturnType<typeof service>, iid: string, jobId: string) => {
  for (let i = 0; i < 400 && (await s.svc.job(iid, jobId)).state === 'running'; i++) await new Promise(r => setImmediate(r))
  return s.svc.job(iid, jobId)
}

test('adding: detected first, refused for an ignored guest, a token, a viewer or a half login; audited before it is saved', async () => {
  const s = service()
  await assert.rejects(s.svc.add({ name: 'x', guest: { kind: 'lxc', vmid: 101 } }, ADMIN), /hyperprox-ignore/)
  await assert.rejects(s.svc.add({ name: 'x', guest: { kind: 'lxc', vmid: 100 } }, { ...ADMIN, token: 'ci' }), /API tokens/)
  await assert.rejects(s.svc.add({ name: 'x', guest: { kind: 'lxc', vmid: 100 } }, { ...ADMIN, role: 'operator' }), /admin role/)
  await assert.rejects(added(s, { url: 'https://cloud.example.com' }), /all three/)
  const m = await added(s)
  assert.equal(m.deployment!.kind, 'compose')
  await assert.rejects(added(s), /already added/)
  // Audit first: when the row cannot be written, nothing is saved.
  const s2 = service(fakeGuest(), { audit: async a => { if (a === 'nextcloud.instance.create') throw new Error('audit log down') } })
  await assert.rejects(added(s2), /audit log down/)
  assert.equal((await s2.svc.instances.list()).length, 0)
})

test('adding with "make the app password for me": every check runs first, and the password is revoked when the add fails after it', async () => {
  // Already added: refused before any app password is made.
  const s = service()
  await added(s)
  const n = s.g.calls.length
  await assert.rejects(added(s, { user: 'alice', createAppPassword: true }), /already added/)
  assert.ok(!s.g.calls.slice(n).some(c => c.includes('user:auth-tokens:add')))
  // Made, then the web test fails: revoked by its token id.
  let made = false
  const g = fakeGuest({
    parts: { t: () => (made ? `[{"id":3,"name":"Firefox","lastActivity":1,"type":0},{"id":42,"name":"HyperProx","lastActivity":${NOW / 1000},"type":1}]` : '[{"id":3,"name":"Firefox","lastActivity":1,"type":0}]') },
    scripts: [[/user:auth-tokens:add/, () => { made = true; return `app password:\n${'A'.repeat(72)}\n` }]],
  })
  const s2 = service(g, { ocs: () => async () => { throw new Error('HTTP 401') } })
  await assert.rejects(added(s2, { user: 'alice', createAppPassword: true }), /web login did not work/)
  const del = g.calls.find(c => c.includes('user:auth-tokens:delete'))!
  assert.match(del, /'user:auth-tokens:delete' '--no-interaction' '--' 'alice' '42'/)
  assert.ok(s2.audits.some(a => a.action === 'nextcloud.app_password.revoke' && a.details.token === 42))
  assert.equal((await s2.svc.instances.list()).length, 0)
  // Made and tested: saved with its token id, so its own activity is never counted as a person's.
  made = false
  const s3 = service(g)
  const m3 = await added(s3, { user: 'alice', createAppPassword: true })
  assert.equal((await s3.svc.instances.login(m3.id)).tokenId, 42)
})

test('B1: a stored app password is never sent to a new address or for a new user; only a password from the same request is tested', async () => {
  const s = service()
  const m = await added(s, { url: 'https://cloud.example.com', user: 'alice', appPassword: 'abcde-fghij-klmno-pqrst-uvwxy' })
  s.ocsCalls.length = 0
  await assert.rejects(s.svc.update(m.id, { url: 'https://attacker.example.net' }, ADMIN), /enter the app password again/)
  await assert.rejects(s.svc.update(m.id, { user: 'bob' }, ADMIN), /different user/)
  assert.deepEqual(s.ocsCalls, [], 'no call reached the new origin (or anywhere) before the guard')
  await s.svc.update(m.id, { name: 'Renamed' }, ADMIN)
  assert.deepEqual(s.ocsCalls, [], 'nothing about the login changed: nothing is tested')
  await s.svc.update(m.id, { url: 'https://files.example.com', appPassword: 'zyxwv-utsrq-ponml-kjihg-fedcb' }, ADMIN)
  assert.deepEqual(s.ocsCalls.map(c => [c.url, c.appPassword]), [['https://files.example.com', 'zyxwv-utsrq-ponml-kjihg-fedcb']], 'tested with the new password only')
  assert.equal(loginChangeProblem({ url: 'https://a.example.com', user: 'u', appPassword: 'p' }, { url: 'https://a.example.com/sub', user: 'u', appPassword: null }), null, 'same origin, another path: fine')
  // Update and remove are audited before they act.
  const s2 = service(fakeGuest(), { audit: async a => { if (a !== 'nextcloud.instance.create') throw new Error('audit down') } })
  const m2 = await added(s2)
  await assert.rejects(s2.svc.update(m2.id, { name: 'New' }, ADMIN), /audit down/)
  assert.equal((await s2.svc.instances.get(m2.id))!.name, 'Cloud')
  await assert.rejects(s2.svc.remove(m2.id, ADMIN), /audit down/)
  assert.ok(await s2.svc.instances.get(m2.id), 'not removed')
})

test('the reading: counts by severity, fresh reads throttled, and the viewer version without confirm texts, paths or names', async () => {
  const s = service()
  const m = await added(s)
  const r = await s.svc.reading(m.id)
  assert.deepEqual(r.counts, { error: 0, warning: 6, info: 9 })
  const n = s.g.calls.length
  await s.svc.reading(m.id, { fresh: true })
  assert.equal(s.g.calls.length, n, 'a fresh read within 10 s is served from the reading just made')
  s.advance(11_000)
  await s.svc.reading(m.id, { fresh: true })
  assert.ok(s.g.calls.length > n)
  const withPath = { ...r, checks: [...r.checks, { ...r.checks[0], id: 'x', description: 'Data directory /srv/nc/data is readable; container nextcloud-app-1 runs custom-nextcloud:apache-ffmpeg' }] } as Reading
  const v = viewerReading(withPath)
  const text = JSON.stringify(v)
  for (const leak of ['/srv/nc/data', 'nextcloud-app-1', 'custom-nextcloud', '/opt/nextcloud', 'Pulls the newest']) assert.ok(!text.includes(leak), leak)
  assert.ok(v.checks!.every(c => c.remedy.kind !== 'fix' || c.remedy.confirm === ''))
})

test('actions: admin and a person only, the tier is HyperProx\'s, values checked before the audit, audited before running', async () => {
  const s = service()
  const m = await added(s)
  await assert.rejects(s.svc.act(m.id, 'maintenance-window', { hour: 1 }, { ...ADMIN, token: 'ci' }, false), /API tokens/)
  await assert.rejects(s.svc.act(m.id, 'user:delete', {}, ADMIN, false), (e: any) => e instanceof NcRefusal && e.status === 404)
  await assert.rejects(s.svc.act(m.id, 'mimetype-repair', {}, ADMIN, false), /master password/)
  const before = s.audits.length
  await assert.rejects(s.svc.act(m.id, 'maintenance-window', { hour: 30 }, ADMIN, false), /0 to 23/)
  assert.equal(s.audits.length, before)
  await s.svc.act(m.id, 'maintenance-window', { hour: 1 }, ADMIN, false)
  assert.equal(s.audits.at(-1)!.action, 'nextcloud.action.maintenance-window')
  assert.match(s.g.calls.at(-1)!, /'config:system:set' '--no-interaction' '--type=integer' '--value=1' '--' 'maintenance_window_start'/)
  for (const a of ['update', 'hpb-update', 'mimetype-repair', 'add-indices', 'smtp', 'enforce-2fa', 'unenforce-2fa', 'update-apps'] as const) assert.equal(ACTIONS[a].secure, true, a)
})

test('notify-push-setup: a malformed stored address is a 400, not a crash', async () => {
  const s = service(fakeGuest({ parts: { u: 'not a url' } }))
  const m = await added(s)
  await assert.rejects(s.svc.act(m.id, 'notify-push-setup', {}, ADMIN, false), (e: any) => e instanceof NcRefusal && e.status === 400)
})

test('mail: the password goes to the vault and to occ on stdin, and is never reused for another server, port or login', async () => {
  const s = service()
  const m = await added(s)
  const pw = 's3cret pass$word'
  const base = { mode: 'smtp', host: 'smtp.example.com', port: 587, secure: 'starttls', auth: true, user: 'cloud@example.com', fromUser: 'cloud', domain: 'example.com' }
  await s.svc.act(m.id, 'smtp', { ...base, password: pw }, ADMIN, true)
  assert.ok(!JSON.stringify(s.audits).includes(pw))
  const script = s.g.calls.find(c => c.includes('config:import'))!
  assert.ok(!script.split('\n').find(l => l.startsWith('docker exec'))!.includes(pw))
  assert.match(script, /'config:import' '--no-interaction' '--' '\/dev\/stdin'/)
  // Same server, no password: the saved one is reused.
  await s.svc.act(m.id, 'smtp', base, ADMIN, true)
  // Another host, port or login without the password: refused, and nothing is sent to Nextcloud.
  const n = s.g.calls.filter(c => c.includes('config:import')).length
  for (const change of [{ host: 'mail.attacker.example' }, { port: 465 }, { user: 'other@example.com' }]) {
    await assert.rejects(s.svc.act(m.id, 'smtp', { ...base, ...change }, ADMIN, true), /enter the password again/)
  }
  assert.equal(s.g.calls.filter(c => c.includes('config:import')).length, n)
  assert.throws(() => cleanSmtp({ host: 'bad host', port: 587, fromUser: 'a', domain: 'example.com' }), /host name/)
})

test('2FA: the current enforcement is kept, only TOTP/WebAuthn count, unknown users and admins without 2FA stop it, and it can be undone', async () => {
  // Only backup codes enabled: no factor a user could set up at sign-in.
  const s0 = service(fakeGuest({ parts: { apps: JSON.stringify({ enabled: { twofactor_backupcodes: '1' }, disabled: {} }) } }))
  const m0 = await added(s0)
  await assert.rejects(s0.svc.act(m0.id, 'enforce-2fa', { acknowledged: true }, ADMIN, true), /TOTP or WebAuthn/)
  // A user id HyperProx cannot pass on: unknown, so refused.
  const s1 = service(fakeGuest({ parts: { users: '{"alice":"A","bob smith":"B"}' } }))
  const m1 = await added(s1)
  await assert.rejects(s1.svc.act(m1.id, 'enforce-2fa', { acknowledged: true }, ADMIN, true), /could not check 1 user \(bob smith\)/)
  // An admin without a second factor: refused unless acknowledged on its own.
  const s2 = service(fakeGuest({ parts: { groups: '{"admin":["bob"]}', state: 'Two-factor authentication is enforced for members of the group(s) staff, except members of guests' } }))
  const m2 = await added(s2)
  await assert.rejects(s2.svc.act(m2.id, 'enforce-2fa', { acknowledged: true }, ADMIN, true), (e: any) => e.code === 'admin_without_2fa' && /bob/.test(e.message))
  assert.ok(!s2.audits.some(a => a.action === 'nextcloud.action.enforce-2fa'), 'refused before the audit and before occ')
  await s2.svc.act(m2.id, 'enforce-2fa', { acknowledged: true, adminWithout2fa: true, exclude: ['contractors'] }, ADMIN, true)
  assert.match(s2.g.calls.at(-1)!, /'twofactorauth:enforce' '--no-interaction' '--on' '--group=staff' '--exclude=guests' '--exclude=contractors'/, 'the groups already set are kept')
  await s2.svc.act(m2.id, 'unenforce-2fa', {}, ADMIN, true)
  assert.match(s2.g.calls.at(-1)!, /'twofactorauth:enforce' '--no-interaction' '--off'/)
  await assert.rejects(s2.svc.act(m2.id, 'unenforce-2fa', {}, ADMIN, false), /master password/)
})

// ── the update ───────────────────────────────────────────────────────────────

test('update preview: refused while anyone is active (HyperProx\'s own token known by its id, not its name), a call runs, a backup runs', async () => {
  const recent = `[{"id":7,"name":"HyperProx","lastActivity":${NOW / 1000},"type":1}]`
  const s = service(fakeGuest({ scripts: [ROOM], parts: { t1: recent } }))
  const m = await added(s)
  await s.io.set('plugin', `nextcloud.${m.id}`, 'user', 'bob', false)
  await s.io.set('plugin', `nextcloud.${m.id}`, 'token_id', '7', false)
  const p = await s.svc.updatePreview(m.id, ADMIN)
  assert.deepEqual(p.problems, [])
  assert.equal(p.backupDir, BK)
  assert.equal(p.activeUsers, 0, 'token 7 is HyperProx\'s own')
  // Another token that only calls itself HyperProx counts as a person.
  const s2 = service(fakeGuest({ scripts: [ROOM], parts: { t1: `[{"id":9,"name":"HyperProx","lastActivity":${NOW / 1000},"type":1}]` } }))
  const m2 = await added(s2)
  await s2.io.set('plugin', `nextcloud.${m2.id}`, 'user', 'bob', false)
  await s2.io.set('plugin', `nextcloud.${m2.id}`, 'token_id', '7', false)
  assert.equal((await s2.svc.updatePreview(m2.id, ADMIN)).activeUsers, 1)
  // A user id HyperProx cannot check makes "who is online" unknown, which blocks the update.
  const s3 = service(fakeGuest({ scripts: [ROOM], parts: { users: '{"alice":"A","x y":"B"}' } }))
  const m3 = await added(s3)
  const p3 = await s3.svc.updatePreview(m3.id, ADMIN)
  assert.equal(p3.activeUsers, null); assert.ok(!p3.ok)
  const busy = service(fakeGuest({ scripts: [ROOM], parts: { calls: 'There are currently 1 calls in progress with 2 participants' } }), { backupRunning: async () => true })
  const mb = await added(busy)
  const pb = await busy.svc.updatePreview(mb.id, ADMIN)
  assert.ok(pb.problems.some(x => /1 Talk call is running/.test(x)))
  assert.ok(pb.problems.some(x => /backup of this guest is running/.test(x)))
})

test('room: the dump and a 3 GiB margin for the new image, on one filesystem or each on its own', () => {
  const r = { freeBytes: 2 * 1024 ** 3, imageFreeBytes: 2 * 1024 ** 3, sameFs: true, dbBytes: 50 * 1048576, compose: true, configFile: true, imageId: null }
  assert.match(roomProblem(r)!, /dump and the new image need about/)
  assert.equal(roomProblem({ ...r, freeBytes: 10 * 1024 ** 3 }), null)
  assert.match(roomProblem({ ...r, sameFs: false, freeBytes: 10 * 1024 ** 3, imageFreeBytes: 1024 ** 3 })!, /Docker's storage/)
  assert.equal(IMAGE_MARGIN, 3 * 1024 ** 3)
})

const PLAN = (o: Partial<UpdatePlan> = {}): UpdatePlan => ({
  from: '34.0.3', offered: '34.0.6', source: 'build', backupDir: BK, stamp: '20261115T120000Z',
  db: { engine: 'postgres', container: 'nextcloud-db-1', name: 'nextcloud', user: 'oc_admin' },
  app: { container: 'nextcloud-app-1', service: 'app', image: 'custom-nextcloud:apache-ffmpeg', imageId: `sha256:${'1'.repeat(64)}`, workdir: '/opt/nextcloud', configFile: '/opt/nextcloud/docker-compose.yml', project: 'nextcloud' },
  ...o,
})

test('rollback words: turn maintenance mode off, restore the config copied before it, and MariaDB images too', () => {
  const pg = rollbackWords(PLAN(), null)
  assert.match(pg, /maintenance:mode --off/)
  assert.match(pg, /copied before maintenance mode was turned on/)
  const my = rollbackWords(PLAN({ db: { engine: 'mysql', container: 'db', name: null, user: null } }), null)
  assert.match(my, /MYSQL_USER:-\$MARIADB_USER/); assert.match(my, /MYSQL_PASSWORD:-\$MARIADB_PASSWORD/)
})

// The job script, run for real: bash with a fake docker, sleep and date in front of PATH.
function runJob(o: { status?: string[]; next?: string; failBuild?: boolean; upgrading?: boolean; lock?: boolean; failUp?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-nc-job-'))
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin)
  const work = path.join(dir, 'opt')
  fs.mkdirSync(work)
  const plan = PLAN({ backupDir: `${work}/hyperprox-backups`, app: { ...PLAN().app, workdir: work, configFile: `${work}/docker-compose.yml` } })
  const jobId = 'j0123456789ab'
  fs.writeFileSync(path.join(dir, 'status'), (o.status ?? ['{"installed":true,"versionstring":"34.0.6","maintenance":false,"needsDbUpgrade":false}']).join('\n') + '\n')
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
D=${JSON.stringify(dir)}
echo "$*" >> "$D/calls"
case "$*" in
  "exec nextcloud-app-1 cat /var/www/html/config/config.php") echo "<?php \\$CONFIG = array ('maintenance' => $(cat "$D/maint" 2>/dev/null || echo false));";;
  *"php occ maintenance:mode --no-interaction --on"*) echo true > "$D/maint";;
  *"php occ maintenance:mode --no-interaction --off"*) echo false > "$D/maint";;
  *"pg_dump"*) echo DUMPDATA;;
  *"pg_restore --list"*) cat > /dev/null;;
  "image tag "*) ;;
  "compose "*"build --pull"*) ${o.failBuild ? 'exit 1' : 'true'};;
  "image inspect --format"*) echo "NEXTCLOUD_VERSION=${o.next ?? '34.0.6'}";;
  "compose "*"up -d"*) ${o.failUp ? 'exit 1' : 'true'};;
  *"php occ status"*) l=$(head -1 "$D/status"); [ "$(wc -l < "$D/status")" -gt 1 ] && sed -i 1d "$D/status"; echo "$l";;
  "top "*) ${o.upgrading ? 'echo "PID COMMAND"; echo "4242 php occ upgrade"' : 'echo "PID COMMAND"; echo "1 apache2 -DFOREGROUND"'};;
  *"flock -n"*) ${o.lock ? 'exit 1' : 'exit 0'};;
  *"php occ upgrade"*) echo upgraded;;
esac
exit 0
`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  // Each call moves the clock a minute: the 10-minute and 40-minute rules are reached in a few loops.
  fs.writeFileSync(path.join(bin, 'date'), `#!/bin/bash\nf=${JSON.stringify(dir)}/clock; n=$(cat "$f" 2>/dev/null || echo 1800000000); echo $((n + 60)) > "$f"; echo $n\n`, { mode: 0o755 })
  const launch = launchScript(plan, jobId).replace(/if \[ -d \/run\/systemd\/system \][\s\S]*?fi\n/, '').replace(/nohup setsid \/bin\/bash (\S+) .*\n/, 'bash $1\n')
  const r = spawnSync('bash', ['-c', launch], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 60_000 })
  const J = `${plan.backupDir}/jobs/${jobId}`
  const state = fs.readFileSync(`${J}/state`, 'utf8')
  const calls = fs.readFileSync(path.join(dir, 'calls'), 'utf8')
  const config = fs.existsSync(`${plan.backupDir}/config-${plan.stamp}.php`) ? fs.readFileSync(`${plan.backupDir}/config-${plan.stamp}.php`, 'utf8') : ''
  fs.rmSync(dir, { recursive: true, force: true })
  return { r, state, calls, config, polled: parsePoll(`${state}@@HPX-LOG@@\n@@HPX-LOG-END@@\nALIVE|0\nEXISTS|1\n`) }
}

test('the job script: config.php before maintenance mode, then dump, keep, build --pull, recreate, upgrade wait and post steps', () => {
  const { r, polled, calls, config } = runJob()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(polled.result?.state, 'done', JSON.stringify(polled))
  assert.match(polled.result!.message, /34\.0\.6/)
  assert.match(config, /'maintenance' => false/, 'the copy does not carry maintenance mode back')
  const order = ['cat /var/www/html/config/config.php', 'maintenance:mode --no-interaction --on', 'pg_dump', 'pg_restore --list', 'image tag', 'build --pull', 'image inspect', 'up -d --no-deps app', 'occ status', 'db:add-missing-indices', 'db:add-missing-primary-keys']
  let at = -1
  for (const o of order) { const i = calls.indexOf(o, at + 1); assert.ok(i > at, `${o} after the step before it`); at = i }
  assert.ok(!calls.includes('php occ upgrade'), 'the image upgraded itself; HyperProx did not run occ upgrade')
  assert.equal(polled.maint, 'off')
})

test('the job script: a failure before the recreate turns maintenance mode off again and says so; after it, says it is still on', () => {
  const a = runJob({ failBuild: true })
  assert.equal(a.polled.result?.state, 'failed')
  assert.match(a.polled.result!.message, /could not be built.*Maintenance mode is off\./)
  assert.ok(a.calls.includes('maintenance:mode --no-interaction --off'))
  assert.ok(!a.calls.includes('up -d'))
  const b = runJob({ next: '34.0.3' })
  assert.match(b.polled.result!.message, /still Nextcloud 34\.0\.3.*Maintenance mode is off\./)
  const c = runJob({ failUp: true, status: ['{"installed":true,"versionstring":"34.0.3","maintenance":true,"needsDbUpgrade":true}'] })
  assert.match(c.polled.result!.message, /could not be recreated.*Maintenance mode is still ON/)
  assert.equal(c.polled.maint, 'on')
})

test('the job script: occ upgrade runs once, only when the image is not already upgrading', () => {
  const pending = '{"installed":true,"versionstring":"34.0.3","maintenance":true,"needsDbUpgrade":true}'
  const done = '{"installed":true,"versionstring":"34.0.6","maintenance":false,"needsDbUpgrade":false}'
  // The entrypoint is still at it (it holds its flock): HyperProx keeps waiting, then times out without a second upgrade.
  const locked = runJob({ status: Array(60).fill(pending), lock: true })
  assert.ok(!locked.calls.includes('php occ upgrade'))
  assert.match(locked.polled.result!.message, /within 40 minutes.*Maintenance mode is still ON/)
  const proc = runJob({ status: Array(60).fill(pending), upgrading: true })
  assert.ok(!proc.calls.includes('php occ upgrade'), 'an occ upgrade process is running: not a second one')
  // Nothing is upgrading after 10 minutes: one occ upgrade, then it reports the new version.
  const idle = runJob({ status: [...Array(12).fill(pending), done] })
  assert.equal(idle.calls.split('\n').filter(l => /php occ upgrade/.test(l)).length, 1)
  assert.equal(idle.polled.result?.state, 'done')
})

test('the update: audited, started detached in the guest, watched to its end; the backup location must be confirmed', async () => {
  let polls = 0
  const g = fakeGuest({ scripts: [ROOM, [/LAUNCHED/, 'LAUNCHED|systemd'], [/@@HPX-LOG@@/, () => {
    polls++
    return polls < 3
      ? 'PID|123\nSTEP|config|done|x\nMAINT|on\nSTEP|maintenance|done|\n@@HPX-LOG@@\nworking\n@@HPX-LOG-END@@\nALIVE|1\nEXISTS|1'
      : `PID|123\nSTEP|config|done|x\nMAINT|on\nSTEP|maintenance|done|\nDUMP|${BK}/nextcloud-db-20261115T120000Z.dump\nSTEP|post|done|\nMAINT|off\nRESULT|done|Nextcloud is on 34.0.6.\n@@HPX-LOG@@\ndone\n@@HPX-LOG-END@@\nALIVE|0\nEXISTS|1`
  }]] })
  const s = service(g)
  const m = await added(s)
  await assert.rejects(s.svc.act(m.id, 'update', { confirmBackupDir: '/elsewhere' }, ADMIN, true), /check screen/)
  const r = await s.svc.act(m.id, 'update', { confirmBackupDir: BK }, ADMIN, true)
  assert.ok(s.audits.some(a => a.action === 'nextcloud.action.update'))
  const launch = g.calls.find(c => c.includes('run.sh'))!
  assert.match(launch, /systemd-run --quiet --collect --unit='hyperprox-nc-j[0-9a-f]{12}'/)
  assert.match(launch, /nohup setsid \/bin\/bash/)
  assert.ok(s.long.marks.get(r.jobId!)?.detached, 'registered as detached work while it runs')
  await assert.rejects(s.svc.act(m.id, 'maintenance-window', { hour: 1 }, ADMIN, false), /still running/)
  const job = await settle(s, m.id, r.jobId!)
  assert.equal(job.state, 'done')
  assert.equal(job.maintenance, 'off')
  assert.ok(!s.long.marks.has(r.jobId!), 'its marker is gone once it finished')
  assert.equal((await s.jobs.get(r.jobId!))!.state, 'done', 'kept in the job store')
})

test('the update: a job script that died without a result is failed with the maintenance mode it left', async () => {
  const g = fakeGuest({ scripts: [ROOM, [/LAUNCHED/, 'LAUNCHED|setsid'], [/@@HPX-LOG@@/, 'PID|123\nSTEP|config|done|\nMAINT|on\n@@HPX-LOG@@\n@@HPX-LOG-END@@\nALIVE|0\nEXISTS|1']] })
  const s = service(g)
  const m = await added(s)
  const r = await s.svc.act(m.id, 'update', { confirmBackupDir: BK }, ADMIN, true)
  const job = await settle(s, m.id, r.jobId!)
  assert.equal(job.state, 'failed')
  assert.match(job.result!, /stopped without finishing.*still ON/)
})

test('resume after a restart: a detached update is watched again and stays registered; in-process work is marked failed', async () => {
  const g = fakeGuest({ scripts: [[/@@HPX-LOG@@/, 'PID|1\nRESULT|failed|occ upgrade failed. Maintenance mode is still ON.\nMAINT|on\n@@HPX-LOG@@\n@@HPX-LOG-END@@\nALIVE|0\nEXISTS|1']] })
  const s = service(g)
  const m = await added(s)
  const base: Job = { id: 'jaaaaaaaaaaaa', instanceId: m.id, action: 'update', by: 'admin@example.com', state: 'running', steps: [{ key: 'recreate', label: 'Recreate', state: 'done' }],
    lines: [], startedAt: new Date(NOW).toISOString(), endedAt: null, result: null, rollback: 'To go back', detached: { guest: m.guest, backupDir: BK }, maintenance: null }
  await s.jobs.save(base)
  await s.jobs.save({ ...base, id: 'jbbbbbbbbbbbb', action: 'mimetype-repair', detached: null, startedAt: new Date(NOW - 1000).toISOString() })
  s.long.register({ id: 'jcccccccccccc', owner: 'nextcloud', label: 'stale', detached: false })
  await s.svc.resume()
  assert.ok(s.long.marks.has('jaaaaaaaaaaaa'), 'the detached update keeps deploys away again')
  assert.ok(!s.long.marks.has('jcccccccccccc'), 'a stale marker is cleared')
  assert.equal((await s.jobs.get('jbbbbbbbbbbbb'))!.state, 'failed')
  const j = await settle(s, m.id, 'jaaaaaaaaaaaa')
  assert.equal(j.state, 'failed'); assert.equal(j.maintenance, 'on'); assert.match(j.rollback!, /To go back/, 'it failed after the recreate: the rollback stays')
  assert.equal((await s.svc.latestJob(m.id))!.id, 'jaaaaaaaaaaaa')
})

test('one action at a time: a second request while an update is checking, or during a preview, is refused', async () => {
  const s = service(fakeGuest({ scripts: [ROOM] }))
  const m = await added(s)
  const first = s.svc.act(m.id, 'update', { confirmBackupDir: '/x' }, ADMIN, true)
  await assert.rejects(s.svc.act(m.id, 'maintenance-window', { hour: 1 }, ADMIN, false), /still running/)
  await assert.rejects(s.svc.updatePreview(m.id, ADMIN), /still running/)
  await first.catch(() => {})
  const preview = s.svc.updatePreview(m.id, ADMIN)
  await assert.rejects(s.svc.act(m.id, 'maintenance-window', { hour: 1 }, ADMIN, false), /still running/)
  await preview
})

test('the job scripts parse in bash, quote every name, and refuse a bad one', () => {
  for (const engine of ['postgres', 'mysql'] as const) {
    const p = PLAN({ db: { engine, container: 'nextcloud-db-1', name: engine === 'postgres' ? 'nextcloud' : null, user: engine === 'postgres' ? 'oc_admin' : null } })
    for (const sc of [updateJobScript(p, 'j0123456789ab'), launchScript(p, 'j0123456789ab'), pollScript(BK, 'j0123456789ab')]) {
      const r = spawnSync('bash', ['-n'], { input: sc, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
    }
  }
  assert.ok(!/-p"\$/.test(updateJobScript(PLAN({ db: { engine: 'mysql', container: 'db', name: null, user: null } }), 'j0123456789ab')), 'the MySQL password is never an argument')
  assert.throws(() => updateJobScript(PLAN(), 'bad'), /job id/)
  assert.throws(() => composeCmd({ workdir: "/opt/x'y", configFile: '/opt/x/c.yml', project: 'p' }), /directory/)
  assert.equal(targetProblem('34.0.3', '35.0.0'), null)
  assert.match(targetProblem('34.0.3', '36.0.0')!, /one major/)
  assert.equal(imageRepo('custom-nextcloud:apache-ffmpeg'), 'custom-nextcloud')
})

test('Talk signalling update: refused during a call; nothing recreated when the image did not change', async () => {
  const s = service(fakeGuest({ parts: { calls: 'There are currently 2 calls in progress with 4 participants' } }))
  const m = await added(s)
  await assert.rejects(s.svc.act(m.id, 'hpb-update', {}, ADMIN, true), /2 Talk calls are running/)
  const sigId = /CTR\|nextcloud-signaling-1\|[^|]+\|(sha256:[0-9a-f]{64})/.exec(DETECT)![1]
  const g = fakeGuest({ scripts: [[/'\{\{\.Id\}\}'/, `${sigId}\n`]] })
  const s2 = service(g)
  const m2 = await added(s2)
  const r = await s2.svc.act(m2.id, 'hpb-update', {}, ADMIN, true)
  assert.ok(s2.long.marks.has(r.jobId!), 'registered while it runs (in this process)')
  const job = await settle(s2, m2.id, r.jobId!)
  assert.equal(job.state, 'done', job.result ?? '')
  assert.ok(!g.calls.join('\n').includes('up -d'))
  assert.ok(!s2.long.marks.has(r.jobId!))
})

// ── routes, roles, the card ──────────────────────────────────────────────────

test('roles: reads viewer (trimmed), admin reads, plain actions admin, secure actions and instance changes re-confirmed, tokens refused', () => {
  const base = '/api/plugins/nextcloud'
  assert.equal(requiredRole('GET', `${base}/instances/n0a1b2c3d/reading`), 'viewer')
  assert.equal(requiredRole('GET', `${base}/candidates`), 'admin')
  assert.equal(requiredRole('GET', `${base}/instances/n0a1b2c3d/jobs/j1`), 'admin')
  assert.equal(needsReconfirm('POST', `${base}/instances/n0a1b2c3d/actions/maintenance-window`), false)
  assert.equal(needsReconfirm('POST', `${base}/instances/n0a1b2c3d/secure-actions/update`), true)
  assert.equal(needsReconfirm('POST', `${base}/instances`), true)
  assert.equal(needsReconfirm('DELETE', `${base}/instances/n0a1b2c3d`), true)
  assert.equal(tokenForbidden('POST', `${base}/instances/n0a1b2c3d/actions/phone-region`), true)
  assert.equal(tokenForbidden('POST', `${base}/instances/n0a1b2c3d/secure-actions/update`), true)
})

test('the card: an update or a warning is "needs attention", an unreachable one is bad', () => {
  assert.throws(() => tileOf([]), /Not configured/)
  assert.equal(tileOf([{ id: 'n1', name: 'Cloud', version: '34.0.3', update: '34.0.6', counts: { error: 0, warning: 6, info: 9 }, error: null }]).tone, 'warn')
  assert.equal(tileOf([{ id: 'n1', name: 'Cloud', version: null, update: null, counts: null, error: 'down' }]).tone, 'bad')
})
