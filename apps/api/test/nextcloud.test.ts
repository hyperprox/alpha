// Nextcloud: the occ allow-list and its argument checks, detection of a Compose install, the setup checks (from a
// real `occ setupchecks --output=json`, scrubbed) and the action each one maps to, the suggestions (maintenance
// window, phone region), and the service with a fake guest: who may act, audit before acting, the tier of each action,
// the mail password never on a command line, and the update's preflight, order and refusals. Nothing real is contacted.
//
// Fixtures (test/fixtures/nextcloud): setupchecks-occ.json is a real answer with the instance's address replaced by
// cloud.example.com; detect-compose.txt is a real detection with the image renamed and the image ids replaced.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { occArgs, occLine, occScript, occBatchScript, parseBatch, OccRefusal, REGIONS, OCC } from '../src/lib/nextcloud/occ'
import { parseDetect, DETECT_SCRIPT } from '../src/lib/nextcloud/detect'
import { parseSetupChecks, parseUpdateCheck, parseStatus, parseActiveCalls, parseLog, parseExApps, parseUserReport, compareVersions, parseAuthTokens } from '../src/lib/nextcloud/parse'
import { remedyFor, suggestWindow, suggestRegion, ACTIONS, type RemedyContext } from '../src/lib/nextcloud/checks'
import { NcInstanceStore, type CredentialIO } from '../src/lib/nextcloud/instances'
import { NextcloudService, cleanSmtp, type ServiceDeps } from '../src/lib/nextcloud/service'
import { targetProblem, roomProblem, imageRepo, backupScript, composeCmd, type UpdatePlan } from '../src/lib/nextcloud/update'
import { NcRefusal, type Actor } from '../src/lib/nextcloud/types'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import { tokenForbidden } from '../src/lib/api-tokens'
import { tileOf } from '../src/plugins/nextcloud'

const FIX = path.join(__dirname, 'fixtures', 'nextcloud')
const CHECKS = fs.readFileSync(path.join(FIX, 'setupchecks-occ.json'), 'utf8')
const DETECT = fs.readFileSync(path.join(FIX, 'detect-compose.txt'), 'utf8')
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0)

// ── occ allow-list ───────────────────────────────────────────────────────────

test('occ: only allow-listed commands, every value checked, every token quoted', () => {
  assert.throws(() => occArgs('user:delete' as any), OccRefusal)
  assert.throws(() => occArgs('set-maintenance-window', { hour: 24 }), /0 to 23/)
  assert.throws(() => occArgs('set-maintenance-window', { hour: '1; rm -rf /' }), OccRefusal)
  assert.throws(() => occArgs('set-phone-region', { region: 'XX' }), /country/)
  assert.throws(() => occArgs('set-server-id', { id: 1024 }), /0 to 1023/)
  assert.throws(() => occArgs('twofactor-state', { uid: "a'b" }), OccRefusal)
  assert.throws(() => occArgs('twofactor-state', { uid: '$(id)' }), OccRefusal)
  assert.throws(() => occArgs('config-get', { key: 'dbpassword' }), /does not read/, 'never a secret setting')
  assert.throws(() => occArgs('notify-push-setup', { url: 'http://cloud.example.com/push' }), /https/)
  assert.throws(() => occArgs('notify-push-setup', { url: 'https://cloud.example.com/elsewhere' }), /push/)
  assert.throws(() => occArgs('enforce-2fa', { exclude: ['two words'] }), /spaces/)
  assert.deepEqual(occArgs('set-maintenance-window', { hour: 1 }), ['config:system:set', 'maintenance_window_start', '--type=integer', '--value=1'])
  assert.deepEqual(occArgs('notify-push-setup', { url: 'https://cloud.example.com/push/' }), ['notify_push:setup', 'https://cloud.example.com/push'])
  assert.equal(occLine({ mode: 'docker', container: 'nextcloud-app-1' }, ['status', '--output=json']),
    "docker exec -u www-data 'nextcloud-app-1' php occ 'status' '--output=json' '--no-interaction'")
  const bare = occLine({ mode: 'bare', occPath: '/var/www/nextcloud/occ', user: 'www-data' }, ['status'])
  assert.match(bare, /sudo -n -u 'www-data' php '\/var\/www\/nextcloud\/occ' 'status'/)
  assert.match(bare, /runuser -u 'www-data' -- php/)
  assert.throws(() => occLine({ mode: 'docker', container: 'a;b' }, ['status']), OccRefusal)
  assert.throws(() => occLine({ mode: 'bare', occPath: '/var/www/../etc/occ', user: 'www-data' }, ['status']), OccRefusal)
  // Every write is marked: the service audits those first.
  for (const id of ['set-maintenance-window', 'add-indices', 'upgrade', 'import-smtp', 'enforce-2fa', 'disable-app-api'] as const) assert.equal(OCC[id].writes, true, id)
  for (const id of ['status', 'setupchecks', 'config-get', 'auth-tokens'] as const) assert.equal(OCC[id].writes, false, id)
})

test('occ: a payload goes in a quoted heredoc on stdin, never on the command line; a batch takes reads only', () => {
  const s = occScript({ mode: 'docker', container: 'nextcloud-app-1' }, 'import-smtp', undefined, JSON.stringify({ system: { mail_smtppassword: 'p$ss `x` $(id)' } }))
  const lines = s.split('\n')
  const cmd = lines.find(l => l.startsWith('docker exec'))!
  assert.match(cmd, /^docker exec -i -u www-data 'nextcloud-app-1' php occ 'config:import' '--no-interaction' <<'HPX_EOF_[A-Z0-9]+'$/)
  assert.ok(!cmd.includes('p$ss'), 'the password is not on the command line')
  assert.ok(s.includes('p$ss `x` $(id)'), 'it is in the quoted heredoc, where the shell expands nothing')
  assert.throws(() => occScript({ mode: 'docker', container: 'c' }, 'import-smtp', undefined, 'a\nb'), /one line/)
  assert.throws(() => occBatchScript({ mode: 'docker', container: 'c' }, [{ key: 'x', id: 'upgrade' }]), /Only reads/)
  const b = occBatchScript({ mode: 'docker', container: 'c' }, [{ key: 'status', id: 'status' }, { key: 'u', id: 'update-check' }])
  assert.match(b, /@@HPX-BEGIN status@@/)
  const parsed = parseBatch("@@HPX-BEGIN status@@\n{\"a\":1}\n\n@@HPX-END status 0@@\n@@HPX-BEGIN u@@\nNextcloud 34.0.6 is available.\n\n@@HPX-END u 0@@\n@@HPX-BEGIN cut@@\nno end")
  assert.deepEqual(Object.keys(parsed), ['status', 'u'], 'a part without its end marker is left out')
  assert.equal(parsed.status.output, '{"a":1}')
})

// ── detection ────────────────────────────────────────────────────────────────

test('detection: a Compose install with a Dockerfile build, its database, Talk signalling and no Client Push', () => {
  const d = parseDetect(DETECT)!
  assert.equal(d.kind, 'compose')
  assert.deepEqual(d.occ, { mode: 'docker', container: 'nextcloud-app-1' })
  assert.equal(d.app!.project, 'nextcloud'); assert.equal(d.app!.service, 'app')
  assert.equal(d.app!.workdir, '/opt/nextcloud'); assert.equal(d.app!.configFile, '/opt/nextcloud/docker-compose.yml')
  assert.equal(d.app!.built, true, 'the Compose file gives the service a build: key, so an update rebuilds with --pull')
  assert.equal(d.app!.imageVersion, '34.0.3')
  assert.equal(d.db!.engine, 'postgres'); assert.equal(d.db!.container, 'nextcloud-db-1')
  assert.equal(d.signaling!.version, '2.1.1~docker'); assert.equal(d.signaling!.service, 'signaling')
  assert.equal(d.notifyPush, null)
  assert.ok(DETECT_SCRIPT.includes('never the file'), 'the Compose file itself is never printed')
  assert.ok(!/docker inspect[^\n]*\.Config\.Env/.test(DETECT_SCRIPT), 'no container environment (where passwords live) is read')
})

test('detection: a plain install, nothing at all, and a detection that did not finish', () => {
  const bare = parseDetect('BARE|/var/www/nextcloud/occ|www-data\nEND|ok\n')!
  assert.equal(bare.kind, 'bare')
  assert.deepEqual(bare.occ, { mode: 'bare', occPath: '/var/www/nextcloud/occ', user: 'www-data' })
  assert.equal(parseDetect('BARE|/var/www/nextcloud/occ|root\nEND|ok\n')!.occ.mode === 'bare' && (parseDetect('BARE|/var/www/nextcloud/occ|root\nEND|ok\n')!.occ as any).user, 'www-data', 'occ never runs as root')
  assert.equal(parseDetect('DOCKER|29\nEND|ok\n'), null)
  assert.throws(() => parseDetect('DOCKER|29\n'), /did not finish/)
  const odd = parseDetect(DETECT.replace('|/opt/nextcloud|/opt/nextcloud/docker-compose.yml|running|1', "|/opt/x'y|/opt/nextcloud/docker-compose.yml|running|1"))!
  assert.equal(odd.kind, 'docker', 'a working directory HyperProx will not quote is dropped, and without it the install is not updated')
})

// ── setup checks and their actions ───────────────────────────────────────────

const ctx = (o: Partial<RemedyContext> = {}): RemedyContext => ({
  deployment: parseDetect(DETECT), exApps: 0, fromCli: true,
  suggest: { windowHour: 1, windowWhy: 'default', region: 'CA', regionWhy: 'tz', serverId: 7 }, ...o,
})

test('setup checks: every warning on the admin page gets a one-click fix, a guided step or an honest optional', () => {
  const checks = parseSetupChecks(CHECKS)
  const open = checks.filter(c => c.severity !== 'success')
  const by = Object.fromEntries(open.map(c => [c.id.split('\\').pop(), remedyFor(c, ctx())]))
  const expect: Record<string, [string, string?]> = {
    MaintenanceWindowStart: ['fix', 'maintenance-window'], MimeTypeMigrationAvailable: ['fix', 'mimetype-repair'],
    DatabaseHasMissingIndices: ['fix', 'add-indices'], HighPerformanceBackend: ['fix', 'hpb-update'],
    NotifyPush: ['guided', 'client-push'], DaemonCheck: ['fix', 'disable-app-api'], LogErrors: ['guided', 'log'],
    TwoFactorConfiguration: ['guided', 'enforce-2fa'], DefaultPhoneRegionSet: ['fix', 'phone-region'],
    EmailTestSuccessful: ['guided', 'smtp'], ServerIdConfig: ['fix', 'server-id'],
    RecordingBackend: ['optional'], SIPConfiguration: ['optional'],
    BruteForceThrottler: ['none'], ForwardedForHeaders: ['none'],
  }
  assert.deepEqual(Object.keys(by).sort(), Object.keys(expect).sort())
  for (const [k, [kind, what]] of Object.entries(expect)) {
    const r = by[k] as any
    assert.equal(r.kind, kind, k)
    if (what) assert.equal(r.kind === 'guided' ? r.flow : r.action, what, k)
  }
  // The long and the risky ones need the master password; the one-setting ones do not.
  assert.equal((by.MimeTypeMigrationAvailable as any).secure, true)
  assert.equal((by.MimeTypeMigrationAvailable as any).long, true)
  assert.equal((by.MaintenanceWindowStart as any).secure, false)
  assert.equal((by.MaintenanceWindowStart as any).params.hour, 1)
  const push = open.find(c => c.id.endsWith('NotifyPush'))!
  assert.equal(push.description, 'Client Push is not installed. This may lead to delayed Talk notifications.', 'placeholders filled in')
  // AppAPI: turned off only when nothing uses it.
  const daemon = open.find(c => c.id.endsWith('DaemonCheck'))!
  assert.equal(remedyFor(daemon, ctx({ exApps: 2 })).kind, 'optional')
  assert.equal(remedyFor(daemon, ctx({ exApps: null })).kind, 'optional')
  // From the admin page (not the command line) the remote-address checks are real problems again.
  const bf = open.find(c => c.id.endsWith('BruteForceThrottler'))!
  assert.equal(remedyFor(bf, ctx({ fromCli: false })).kind, 'guided')
  // No signalling server in the guest: a guided step instead of a button.
  const hpb = open.find(c => c.id.endsWith('HighPerformanceBackend'))!
  assert.equal(remedyFor(hpb, ctx({ deployment: null })).kind, 'guided')
})

test('parsers: status, update check, calls, log, ExApps, user report, tokens, versions', () => {
  assert.deepEqual(parseStatus('{"installed":true,"version":"34.0.3.2","versionstring":"34.0.3","edition":"","maintenance":false,"needsDbUpgrade":false,"productname":"Nextcloud","extendedSupport":false}'),
    { installed: true, version: '34.0.3.2', versionString: '34.0.3', maintenance: false, needsDbUpgrade: false, edition: '' })
  assert.equal(parseStatus('not json'), null)
  const up = parseUpdateCheck('Nextcloud 34.0.6 is available. Get more information on how to update at https://docs.example.\nUpdate for calendar to version 6.6.5 is available.\nUpdate for mail to version 5.13.2 is available.\n6 updates available')
  assert.equal(up.core, '34.0.6'); assert.deepEqual(up.apps, [{ app: 'calendar', version: '6.6.5' }, { app: 'mail', version: '5.13.2' }])
  assert.equal(parseActiveCalls('No calls in progress'), 0)
  assert.equal(parseActiveCalls('There are currently 2 calls in progress with 5 participants'), 2)
  assert.equal(parseActiveCalls('Call failed'), null)
  const log = parseLog('{"level":2,"time":"2026-10-02T06:26:30+00:00","app":"core","message":"Login failed: \'someone\' (Remote IP: \'203.0.113.9\')"}\nnoise\n{"level":9}')
  assert.equal(log.length, 1); assert.equal(log[0].app, 'core')
  assert.equal(parseExApps('ExApps:\n'), 0); assert.equal(parseExApps('ExApps:\nassistant (1.0)\n'), 1); assert.equal(parseExApps('error'), null)
  assert.deepEqual(parseUserReport('| total users      | 3 |\n| active users     | 2 |\n| disabled users   | 0 |'), { total: 3, active: 2, disabled: 0 })
  assert.deepEqual(parseAuthTokens('[{"id":1,"name":"HyperProx","lastActivity":5,"type":1}]'), [{ name: 'HyperProx', lastActivity: 5, type: 1 }])
  assert.equal(compareVersions('34.0.3', '34.0.6'), -1); assert.equal(compareVersions('35.0.0', '34.9.9'), 1)
})

test('suggestions: the maintenance window from busy hours (else 01:00 UTC) and the phone region from locale or time zone', () => {
  assert.deepEqual(suggestWindow(null, null, NOW).hour, 1)
  assert.match(suggestWindow([], 'UTC', NOW).why, /01:00 UTC/)
  // Busy 17:00-24:00 and 00:00-02:00 local, UTC: 02:00 local overlaps nothing for four hours.
  assert.equal(suggestWindow([{ start: '17:00', end: '24:00' }, { start: '00:00', end: '02:00' }], 'UTC', NOW).hour, 2)
  // Toronto is UTC-5 in November: 02:00 local is 07:00 UTC.
  assert.equal(suggestWindow([{ start: '18:00', end: '23:00' }], 'America/Toronto', NOW).hour, 7)
  const valid = (r: string) => REGIONS.includes(r)
  assert.equal(suggestRegion({ locale: 'en_CA' }, valid).region, 'CA')
  assert.equal(suggestRegion({ adminLocale: 'de_DE' }, valid).region, 'DE')
  assert.equal(suggestRegion({ timezone: 'Europe/London' }, valid).region, 'GB')
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

/** Answers an occ batch from `parts` (by batch key), and everything else from `scripts` (first regex that matches). */
function fakeGuest(o: { parts?: Record<string, string>; scripts?: Array<[RegExp, string | ((s: string) => string), number?]> } = {}) {
  const calls: string[] = []
  const parts: Record<string, string> = {
    status: '{"installed":true,"version":"34.0.3.2","versionstring":"34.0.3","maintenance":false,"needsDbUpgrade":false}',
    checks: CHECKS, update: 'Nextcloud 34.0.6 is available.\nUpdate for mail to version 5.13.2 is available.',
    apps: JSON.stringify({ enabled: { spreed: '24.0.0', app_api: '34.0.0', twofactor_totp: '14.0.0' }, disabled: { encryption: '1' } }),
    report: '| total users | 2 |\n| disabled users | 0 |', log: '', calls: 'No calls in progress', exapps: 'ExApps:\n',
    bgmode: 'cron', lastcron: String(NOW / 1000 - 60), users: '{"alice":"Alice","bob":"Bob"}',
    config: JSON.stringify({ system: { 'upgrade.disable-web': true, dbname: 'nextcloud', dbuser: 'oc_admin', dbpassword: '***REMOVED SENSITIVE VALUE***', 'overwrite.cli.url': 'https://cloud.example.com' } }),
    dbname: 'nextcloud', dbuser: 'oc_admin', t0: '[{"name":"Firefox","lastActivity":1,"type":0}]', t1: '[{"name":"HyperProx","lastActivity":' + (NOW / 1000) + ',"type":1}]',
    ...o.parts,
  }
  const exec: ServiceDeps['exec'] = async (_g, script) => {
    calls.push(script)
    if (script.includes('echo "END|ok"')) return { code: 0, output: DETECT, timedOut: false }
    if (script.includes('@@HPX-BEGIN')) {
      const keys = [...script.matchAll(/@@HPX-BEGIN ([a-z0-9:_-]+)@@/g)].map(m => m[1])
      const out = keys.map(k => `@@HPX-BEGIN ${k}@@\n${parts[k] ?? ''}\n\n@@HPX-END ${k} ${parts[k] === undefined ? 1 : 0}@@`).join('\n')
      return { code: 0, output: out, timedOut: false }
    }
    for (const [re, ans, code] of o.scripts ?? []) if (re.test(script)) return { code: code ?? 0, output: typeof ans === 'function' ? ans(script) : ans, timedOut: false }
    return { code: 0, output: '', timedOut: false }
  }
  return { exec, calls, parts }
}

function service(g = fakeGuest(), over: Partial<ServiceDeps> = {}) {
  const io = memoryIO()
  const audits: Array<{ action: string; details: Record<string, unknown> }> = []
  let t = NOW
  const svc = new NextcloudService({
    store: new NcInstanceStore(io), exec: g.exec,
    audit: async (action, _r, details) => { audits.push({ action, details }) },
    guests: async () => [{ kind: 'lxc', vmid: 100, name: 'cloud', node: 'node1', running: true, ignored: false }, { kind: 'lxc', vmid: 101, name: 'secret', node: 'node1', running: true, ignored: true }],
    ocs: () => async () => { throw new Error('no ocs here') },
    quietHours: async () => null, backupRunning: async () => false, snapshotNote: async () => 'This container has bind mounts (mp0), so Proxmox cannot snapshot it.',
    now: () => t, sleep: async ms => { t += ms }, ...over,
  })
  return { svc, io, audits, g }
}

async function added(s: ReturnType<typeof service>) {
  return s.svc.add({ name: 'Cloud', guest: { kind: 'lxc', vmid: 100 } }, ADMIN)
}

test('adding: Nextcloud is detected first; an ignored guest, a token and a viewer are refused', async () => {
  const s = service()
  await assert.rejects(s.svc.add({ name: 'x', guest: { kind: 'lxc', vmid: 101 } }, ADMIN), /hyperprox-ignore/)
  await assert.rejects(s.svc.add({ name: 'x', guest: { kind: 'lxc', vmid: 100 } }, { ...ADMIN, token: 'ci' }), /API tokens/)
  await assert.rejects(s.svc.add({ name: 'x', guest: { kind: 'lxc', vmid: 100 } }, { ...ADMIN, role: 'operator' }), /admin role/)
  await assert.rejects(s.svc.add({ name: 'x', guest: { kind: 'lxc', vmid: 100 }, url: 'https://cloud.example.com' }, ADMIN), /all three/)
  const m = await added(s)
  assert.equal(m.deployment!.kind, 'compose')
  assert.ok(s.audits.some(a => a.action === 'nextcloud.instance.create'))
  await assert.rejects(added(s), /already added/)
})

test('the reading: counts by severity (command-line artefacts and snoozed checks left out), the update and app updates as problems too', async () => {
  const s = service()
  const m = await added(s)
  const r = await s.svc.reading(m.id)
  assert.equal(r.status!.versionString, '34.0.3')
  assert.equal(r.update.core, '34.0.6'); assert.equal(r.update.webUpdaterDisabled, true)
  assert.equal(r.checksFrom, 'occ')
  const upd = r.checks.find(c => c.id === 'hyperprox:update')!
  assert.equal(upd.remedy.kind, 'fix'); assert.equal((upd.remedy as any).action, 'update')
  assert.ok(r.checks.some(c => c.id === 'hyperprox:app-updates'))
  // 5 warnings from Nextcloud + the update; 8 notes + app updates (2 remote-address artefacts are not counted).
  assert.deepEqual(r.counts, { error: 0, warning: 6, info: 9 }, JSON.stringify(r.checks.map(c => [c.id, c.severity, c.remedy.kind])))
  assert.equal(r.talk.hpb!.version, '2.1.1~docker'); assert.deepEqual(r.talk.hpb!.missing, ['changed-users'])
  assert.equal(r.talk.push.app, 'missing'); assert.equal(r.talk.activeCalls, 0)
  await s.svc.snooze(m.id, 'OCA\\Talk\\SetupCheck\\RecordingBackend', 30, ADMIN)
  const r2 = await s.svc.reading(m.id)
  assert.equal(r2.counts.info, 8)
  assert.ok(r2.checks.find(c => c.id.endsWith('RecordingBackend'))!.snoozed)
})

test('actions: admin and a person only, the tier is HyperProx\'s, values checked before the audit, audited before running', async () => {
  const s = service()
  const m = await added(s)
  await assert.rejects(s.svc.act(m.id, 'maintenance-window', { hour: 1 }, { ...ADMIN, token: 'ci' }, false), /API tokens/)
  await assert.rejects(s.svc.act(m.id, 'maintenance-window', { hour: 1 }, { ...ADMIN, role: 'operator' }, false), /admin role/)
  await assert.rejects(s.svc.act(m.id, 'user:delete', {}, ADMIN, false), (e: any) => e instanceof NcRefusal && e.status === 404)
  await assert.rejects(s.svc.act(m.id, 'mimetype-repair', {}, ADMIN, false), /master password/, 'a secure action on the plain route')
  const before = s.audits.length
  await assert.rejects(s.svc.act(m.id, 'maintenance-window', { hour: 30 }, ADMIN, false), /0 to 23/)
  assert.equal(s.audits.length, before, 'refused before anything was audited or run')
  const n = s.g.calls.length
  const r = await s.svc.act(m.id, 'maintenance-window', { hour: 1 }, ADMIN, false)
  assert.match(r.message, /01:00 UTC/)
  assert.equal(s.audits.at(-1)!.action, 'nextcloud.action.maintenance-window')
  assert.match(s.g.calls.at(-1)!, /'config:system:set' 'maintenance_window_start' '--type=integer' '--value=1'/)
  assert.equal(s.g.calls.length, n + 1)
  for (const [a, secure] of Object.entries(ACTIONS)) if (['update', 'hpb-update', 'mimetype-repair', 'add-indices', 'smtp', 'enforce-2fa', 'update-apps'].includes(a)) assert.equal(secure.secure, true, a)
})

test('actions: no audit row, no action', async () => {
  const s = service(fakeGuest(), { audit: async (a) => { if (a.startsWith('nextcloud.action.')) throw new Error('audit log down') } })
  const m = await added(s)
  const n = s.g.calls.length
  await assert.rejects(s.svc.act(m.id, 'phone-region', { region: 'CA' }, ADMIN, false), /audit log down/)
  assert.ok(!s.g.calls.slice(n).some(c => c.includes('config:system:set')), 'the setting was never written')
})

test('mail: the password goes to the vault and to occ on stdin, never into the audit or a command line', async () => {
  const s = service()
  const m = await added(s)
  const pw = 's3cret pass$word'
  await s.svc.act(m.id, 'smtp', { mode: 'smtp', host: 'smtp.example.com', port: 587, secure: 'starttls', auth: true, user: 'cloud@example.com', password: pw, fromUser: 'cloud', domain: 'example.com' }, ADMIN, true)
  const a = s.audits.find(x => x.action === 'nextcloud.action.smtp')!
  assert.ok(!JSON.stringify(a).includes(pw)); assert.equal(a.details.params && (a.details.params as any).password, 'new')
  const script = s.g.calls.find(c => c.includes('config:import'))!
  assert.ok(!script.split('\n').find(l => l.startsWith('docker exec'))!.includes(pw))
  assert.ok(script.includes(JSON.stringify(pw).slice(1, -1)))
  assert.deepEqual([...s.io.data.entries()].filter(([k]) => k.endsWith('.smtp/password')).map(([, v]) => v), [{ v: pw, masked: true }])
  assert.throws(() => cleanSmtp({ host: 'bad host', port: 587, fromUser: 'a', domain: 'example.com' }), /host name/)
  assert.throws(() => cleanSmtp({ host: 'smtp.example.com', port: 587, fromUser: 'a b', domain: 'example.com' }), /before the @/)
})

test('guards: AppAPI stays on while an External App uses it; 2FA needs the acknowledgement and a provider', async () => {
  const s = service(fakeGuest({ scripts: [[/'app_api:app:list'/, 'ExApps:\nassistant (2.0)\n']] }))
  const m = await added(s)
  await assert.rejects(s.svc.act(m.id, 'disable-app-api', {}, ADMIN, false), /External App is installed/)
  await assert.rejects(s.svc.act(m.id, 'enforce-2fa', {}, ADMIN, true), /who has no second factor/)
  const s2 = service(fakeGuest({ scripts: [[/'app:list'/, JSON.stringify({ enabled: { spreed: '1' }, disabled: {} })]] }))
  const m2 = await added(s2)
  await assert.rejects(s2.svc.act(m2.id, 'enforce-2fa', { acknowledged: true }, ADMIN, true), /No second-factor app/)
})

// ── the update ───────────────────────────────────────────────────────────────

test('update preview: nobody active, no call, no backup; the backup location and the snapshot note are shown', async () => {
  const room = [/^set \+e\necho "DF/, 'DF|99999999\nDBSIZE|52428800\nCOMPOSE|1\nCFG|1\nIMG|sha256:' + '0'.repeat(64)] as [RegExp, string]
  const s2 = service(fakeGuest({ scripts: [room] }))
  const m2 = await added(s2)
  const p = await s2.svc.updatePreview(m2.id, ADMIN)
  assert.deepEqual(p.problems, [])
  assert.equal(p.from, '34.0.3'); assert.equal(p.to, '34.0.6'); assert.equal(p.source, 'build')
  assert.equal(p.backupDir, '/opt/nextcloud/hyperprox-backups')
  assert.match(p.snapshotNote!, /cannot snapshot/)
  assert.ok(p.warnings.some(w => /--pull/.test(w)))
  assert.equal(p.activeUsers, 0, "HyperProx's own app password does not count")
  // Someone active, a call running, a backup running: each refuses.
  const busy = service(fakeGuest({ scripts: [room], parts: { t0: `[{"name":"Firefox","lastActivity":${NOW / 1000 - 30},"type":0}]`, calls: 'There are currently 1 calls in progress with 2 participants' } }), { backupRunning: async () => true })
  const mb = await added(busy)
  const pb = await busy.svc.updatePreview(mb.id, ADMIN)
  assert.equal(pb.ok, false)
  assert.ok(pb.problems.some(x => /1 user was active/.test(x)))
  assert.ok(pb.problems.some(x => /1 Talk call is running/.test(x)))
  assert.ok(pb.problems.some(x => /backup of this guest is running/.test(x)))
  await assert.rejects(busy.svc.act(mb.id, 'update', { confirmBackupDir: '/opt/nextcloud/hyperprox-backups' }, ADMIN, true), /active|call|backup/)
})

test('update: maintenance on, dump read back, old image kept, rebuilt with --pull, recreated, upgraded, post steps; in that order', async () => {
  let statusCalls = 0
  const g = fakeGuest({
    scripts: [
      [/^set \+e\necho "DF/, 'DF|99999999\nDBSIZE|52428800\nCOMPOSE|1\nCFG|1\nIMG|sha256:' + '0'.repeat(64)],
      [/pg_dump/, 'DUMP|/opt/nextcloud/hyperprox-backups/nextcloud-db-20261115T120000Z.dump|1048576\nCONFIG|/opt/nextcloud/hyperprox-backups/config-20261115T120000Z.php'],
      [/NEXTCLOUD_VERSION/, '34.0.6\n'],
      [/'status' '--output=json'/, () => (++statusCalls < 2 ? '{"installed":true,"versionstring":"34.0.3","maintenance":true,"needsDbUpgrade":true}' : '{"installed":true,"versionstring":"34.0.6","maintenance":false,"needsDbUpgrade":false}')],
    ],
  })
  const s = service(g)
  const m = await added(s)
  await assert.rejects(s.svc.act(m.id, 'update', { confirmBackupDir: '/elsewhere' }, ADMIN, true), /check screen/)
  await assert.rejects(s.svc.act(m.id, 'update', { confirmBackupDir: '/opt/nextcloud/hyperprox-backups' }, ADMIN, false), /master password/)
  const n = g.calls.length
  const r = await s.svc.act(m.id, 'update', { confirmBackupDir: '/opt/nextcloud/hyperprox-backups' }, ADMIN, true)
  assert.ok(r.jobId)
  assert.ok(s.audits.some(a => a.action === 'nextcloud.action.update' && a.details.backupDir === '/opt/nextcloud/hyperprox-backups'), 'audited before the job started')
  for (let i = 0; i < 50 && s.svc.job(m.id, r.jobId!).state === 'running'; i++) await new Promise(res => setImmediate(res))
  const job = s.svc.job(m.id, r.jobId!)
  assert.equal(job.state, 'done', `${job.result} ${JSON.stringify(job.steps)}`)
  assert.match(job.result!, /34\.0\.6/)
  assert.match(job.rollback!, /pg_restore --clean/)
  const run = g.calls.slice(n).join('\n----\n')
  const order = ["'maintenance:mode' '--on'", 'pg_dump', 'pg_restore --list', "docker image tag 'sha256:", 'build --pull', 'NEXTCLOUD_VERSION', "up -d --no-deps 'app'", "'status' '--output=json'", "'db:add-missing-indices'", "'db:add-missing-columns'", "'db:add-missing-primary-keys'"]
  let at = -1
  for (const o of order) { const i = run.indexOf(o, at + 1); assert.ok(i > at, `${o} after the step before it`); at = i }
  assert.ok(!/ pull 'app'/.test(run), 'a Dockerfile build is rebuilt, not pulled')
  assert.ok(job.steps.every(st => st.state === 'done' || st.state === 'skipped'), JSON.stringify(job.steps))
  // The job is over, so other actions run again.
  assert.match((await s.svc.act(m.id, 'maintenance-window', { hour: 1 }, ADMIN, false)).message, /01:00/)
})

test('update: an image that is not newer stops before the container is touched, and maintenance mode goes off again', async () => {
  const g = fakeGuest({
    scripts: [
      [/^set \+e\necho "DF/, 'DF|99999999\nDBSIZE|52428800\nCOMPOSE|1\nCFG|1\nIMG|'],
      [/pg_dump/, 'DUMP|/opt/nextcloud/hyperprox-backups/nextcloud-db-x.dump|1048576'],
      [/NEXTCLOUD_VERSION/, '34.0.3\n'],
    ],
  })
  const s = service(g)
  const m = await added(s)
  const r = await s.svc.act(m.id, 'update', { confirmBackupDir: '/opt/nextcloud/hyperprox-backups' }, ADMIN, true)
  for (let i = 0; i < 50 && s.svc.job(m.id, r.jobId!).state === 'running'; i++) await new Promise(res => setImmediate(res))
  const job = s.svc.job(m.id, r.jobId!)
  assert.equal(job.state, 'failed')
  assert.match(job.result!, /still Nextcloud 34\.0\.3/)
  const run = g.calls.join('\n')
  assert.ok(!run.includes('up -d'), 'never recreated')
  assert.ok(run.includes("'maintenance:mode' '--off'"))
})

test('one action at a time: a second request while an update is checking or running is refused', async () => {
  const g = fakeGuest({ scripts: [[/^set \+e\necho "DF/, 'DF|99999999\nDBSIZE|52428800\nCOMPOSE|1\nCFG|1\nIMG|']] })
  const s = service(g)
  const m = await added(s)
  const first = s.svc.act(m.id, 'update', { confirmBackupDir: '/opt/nextcloud/hyperprox-backups' }, ADMIN, true)
  await assert.rejects(s.svc.act(m.id, 'maintenance-window', { hour: 1 }, ADMIN, false), /still running/)
  await first.catch(() => {})
})

test('update helpers: target versions, room for the dump, image tags, quoting', () => {
  assert.equal(targetProblem('34.0.3', '34.0.6'), null)
  assert.equal(targetProblem('34.0.3', '35.0.0'), null, 'one major ahead is how Nextcloud upgrades')
  assert.match(targetProblem('34.0.3', '36.0.0')!, /one major/)
  assert.match(targetProblem('34.0.3', '33.0.9')!, /downgraded/)
  assert.match(targetProblem('34.0.3', null)!, /NEXTCLOUD_VERSION/)
  assert.match(roomProblem({ freeBytes: 100 * 1048576, dbBytes: 50 * 1048576, compose: true, configFile: true, imageId: null })!, /needs about 250 MiB/)
  assert.equal(imageRepo('custom-nextcloud:apache-ffmpeg'), 'custom-nextcloud')
  assert.equal(imageRepo('registry.example.com:5000/nc'), 'registry.example.com:5000/nc')
  assert.equal(imageRepo('nextcloud@sha256:abc'), null)
  assert.throws(() => composeCmd({ workdir: "/opt/x'y", configFile: '/opt/x/c.yml', project: 'p' }), /directory/)
  const plan: UpdatePlan = { from: '34.0.3', offered: '34.0.6', source: 'pull', backupDir: '/opt/nc/hyperprox-backups', stamp: '20261115T120000Z',
    db: { engine: 'mysql', container: 'nc-db-1', name: null, user: null },
    app: { container: 'nc-app-1', service: 'app', image: 'nextcloud:apache', imageId: 'sha256:' + '1'.repeat(64), workdir: '/opt/nc', configFile: '/opt/nc/compose.yml', project: 'nc' } }
  const b = backupScript(plan)
  assert.match(b, /MYSQL_PWD=/); assert.ok(!/-p"\$/.test(b), 'the MySQL password is never an argument')
  assert.match(b, /gzip -t/)
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
  for (let i = 0; i < 50 && s2.svc.job(m2.id, r.jobId!).state === 'running'; i++) await new Promise(res => setImmediate(res))
  const job = s2.svc.job(m2.id, r.jobId!)
  assert.equal(job.state, 'done', job.result ?? '')
  assert.match(job.result!, /already running/)
  assert.ok(!g.calls.join('\n').includes('up -d'))
  assert.ok(g.calls.join('\n').includes("pull 'signaling'"))
})

// ── routes, roles, the card ──────────────────────────────────────────────────

test('roles: reads viewer (trimmed), admin reads, plain actions admin, secure actions and instance changes re-confirmed, tokens refused', () => {
  const base = '/api/plugins/nextcloud'
  assert.equal(requiredRole('GET', `${base}/instances`), 'viewer')
  assert.equal(requiredRole('GET', `${base}/instances/n0a1b2c3d/reading`), 'viewer')
  assert.equal(requiredRole('GET', `${base}/candidates`), 'admin')
  assert.equal(requiredRole('GET', `${base}/instances/n0a1b2c3d/two-factor`), 'admin')
  assert.equal(requiredRole('GET', `${base}/instances/n0a1b2c3d/jobs/j1`), 'admin')
  assert.equal(requiredRole('POST', `${base}/instances/n0a1b2c3d/actions/maintenance-window`), 'admin')
  assert.equal(needsReconfirm('POST', `${base}/instances/n0a1b2c3d/actions/maintenance-window`), false)
  assert.equal(needsReconfirm('POST', `${base}/instances/n0a1b2c3d/secure-actions/update`), true)
  assert.equal(needsReconfirm('POST', `${base}/instances`), true, 'adding stores a login')
  assert.equal(needsReconfirm('PUT', `${base}/instances/n0a1b2c3d`), true)
  assert.equal(needsReconfirm('DELETE', `${base}/instances/n0a1b2c3d`), true)
  assert.equal(needsReconfirm('POST', `${base}/instances/n0a1b2c3d/update/preview`), false, 'the check only reads')
  assert.equal(needsReconfirm('POST', `${base}/detect`), false)
  assert.equal(tokenForbidden('POST', `${base}/instances/n0a1b2c3d/actions/phone-region`), true)
  assert.equal(tokenForbidden('POST', `${base}/instances/n0a1b2c3d/secure-actions/update`), true)
  assert.equal(tokenForbidden('GET', `${base}/instances/n0a1b2c3d/reading`), false)
})

test('the card: an update or a warning is "needs attention", an unreachable one is bad', () => {
  assert.throws(() => tileOf([]), /Not configured/)
  const t = tileOf([{ id: 'n1', name: 'Cloud', version: '34.0.3', update: '34.0.6', counts: { error: 0, warning: 6, info: 9 }, error: null }])
  assert.equal(t.tone, 'warn'); assert.match(t.headline, /update to 34\.0\.6, 6 warnings/)
  assert.equal(tileOf([{ id: 'n1', name: 'Cloud', version: '34.0.6', update: null, counts: { error: 0, warning: 0, info: 3 }, error: null }]).tone, 'good')
  assert.equal(tileOf([{ id: 'n1', name: 'Cloud', version: null, update: null, counts: null, error: 'down' }]).tone, 'bad')
})
