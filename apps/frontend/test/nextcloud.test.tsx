// The Nextcloud page's pieces, rendered to HTML: setup warnings grouped by severity with their action in words (a
// one-click fix, a guided step, an optional with what it gives and what it needs), snoozed and command-line-only checks
// folded away, the version track and its update button, the update check with its refusals and the backup location,
// a background job's steps, Talk and Client Push, and the pure logic behind them.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import "./css-stub"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { CheckCard, CheckGroups, JobView, TalkView, UpdateCheckView, VersionTrack } from '../components/plugins/nextcloud/parts'
import { groupChecks, healthScore, hourWords, manualUpdateSteps, pushComposeSnippet, pushNginxSnippet, regionOptions, stopWatchingWords, twoFactorWords, verdictOf, type Check, type Reading } from '../components/plugins/nextcloud/logic'

const noop = () => {}
const check = (o: Partial<Check> & Pick<Check, 'id' | 'severity' | 'remedy'>): Check => ({ category: 'system', name: o.id, description: 'words', doc: null, snoozed: null, ...o })

const fixMW = check({ id: 'MaintenanceWindowStart', name: 'Maintenance window start', severity: 'warning',
  remedy: { kind: 'fix', action: 'maintenance-window', label: 'Set it to 01:00 UTC', confirm: 'c', secure: false, long: false, params: { hour: 1 }, note: 'No busy hours are set' } })
const mime = check({ id: 'Mime', name: 'Mimetype migrations available', severity: 'warning', remedy: { kind: 'fix', action: 'mimetype-repair', label: 'Run the migrations', confirm: 'c', secure: true, long: true } })
const smtp = check({ id: 'Email', name: 'Email test', severity: 'info', remedy: { kind: 'guided', flow: 'smtp', label: 'Set up mail', why: 'needs your mail server', action: 'smtp' } })
const rec = check({ id: 'Rec', name: 'Recording backend', severity: 'info', remedy: { kind: 'optional', gives: 'Talk can record calls', needs: 'A recording server' } })
const cli = check({ id: 'Brute', name: 'Brute-force Throttle', severity: 'info', remedy: { kind: 'none', why: 'Only shown from the command line' } })
const snoozed = check({ id: 'SIP', name: 'SIP configuration', severity: 'info', snoozed: 'forever', remedy: { kind: 'optional', gives: 'dial in', needs: 'a SIP bridge' } })
const err = check({ id: 'Err', name: 'Broken thing', severity: 'error', remedy: { kind: 'guided', flow: 'update-manual', label: 'Read how to fix it', why: 'docs' }, doc: 'https://docs.example.com/x' })

function reading(o: Partial<Reading> = {}): Reading {
  return {
    fetchedAt: new Date().toISOString(), status: { versionString: '34.0.3', maintenance: false, needsDbUpgrade: false },
    update: { core: '34.0.6', apps: [], webUpdaterDisabled: true }, checksFrom: 'occ', checks: [fixMW, mime, smtp, rec, cli],
    counts: { error: 0, warning: 2, info: 2 }, background: { mode: 'ajax', lastRun: Math.floor(Date.now() / 1000) - 300 },
    config: { maintenanceWindowStart: null, phoneRegion: null, serverId: null, timezone: null, mail: { mode: null, host: null, port: null, secure: null, from: null, domain: null } },
    users: { total: 1, disabled: 0 }, twoFactor: { enforced: false, providers: ['twofactor_totp'] }, log: [], server: null,
    talk: { installed: true, hpb: { version: '2.1.1~docker', image: 'strukturag/nextcloud-spreed-signaling:latest', container: 'nextcloud-signaling-1', missing: ['changed-users'] }, activeCalls: 0,
      push: { app: 'missing', daemon: 'missing', endpoint: null } },
    apps: { enabled: 50, exApps: 0 },
    deployment: { kind: 'compose', app: { container: 'nextcloud-app-1', image: 'custom-nextcloud:apache', project: 'nextcloud', service: 'app', workdir: '/opt/nextcloud', configFile: '/opt/nextcloud/docker-compose.yml', built: true, dockerfile: true, imageVersion: '34.0.3' } },
    suggest: { windowHour: 1, windowWhy: 'default', region: 'CA', regionWhy: 'tz', serverId: 7 }, php: '8.5.10', dbVersion: '16.15', missing: [], ...o,
  }
}

test('a check card says its severity, its kind of action and the action itself, in words', () => {
  const html = renderToStaticMarkup(<CheckCard c={fixMW} admin busy={false} onAct={noop} onSnooze={noop} />)
  assert.match(html, /aria-label="Warning: Maintenance window start"/)
  assert.match(html, /one-click fix/)
  assert.match(html, /Set it to 01:00 UTC/)
  assert.match(html, /No busy hours are set/)
  assert.match(html, /Snooze 7 d/)
  assert.ok(!/Dismiss/.test(html), 'only an optional item can be dismissed outright')
  const secure = renderToStaticMarkup(<CheckCard c={mime} admin busy={false} onAct={noop} onSnooze={noop} />)
  assert.match(secure, /master password/)
  const opt = renderToStaticMarkup(<CheckCard c={rec} admin busy={false} onAct={noop} onSnooze={noop} />)
  assert.match(opt, /What it gives you[\s\S]*Talk can record calls[\s\S]*What it needs[\s\S]*A recording server/)
  assert.match(opt, /Dismiss/)
  const viewer = renderToStaticMarkup(<CheckCard c={fixMW} admin={false} busy={false} onAct={noop} onSnooze={noop} />)
  assert.ok(!/<button/.test(viewer), 'a viewer sees the problem and its remedy, with no buttons')
  const guided = renderToStaticMarkup(<CheckCard c={err} admin busy={false} onAct={noop} onSnooze={noop} />)
  assert.match(guided, /Nextcloud&#x27;s docs/); assert.match(guided, /guided/)
})

test('checks are grouped errors, warnings, notes; snoozed and command-line-only ones are folded away', () => {
  const g = groupChecks([fixMW, mime, smtp, rec, cli, snoozed, err])
  assert.deepEqual(g.groups.map(x => x.severity), ['error', 'warning', 'info'])
  assert.deepEqual(g.groups[2].checks.map(c => c.id), ['Email', 'Rec'])
  assert.deepEqual(g.snoozed.map(c => c.id), ['SIP']); assert.deepEqual(g.quiet.map(c => c.id), ['Brute'])
  const html = renderToStaticMarkup(<CheckGroups checks={[fixMW, cli, snoozed]} admin busy={false} onAct={noop} onSnooze={noop} />)
  assert.match(html, /Warnings <small>1/)
  assert.match(html, /Snoozed or dismissed · 1[\s\S]*SIP configuration[\s\S]*dismissed[\s\S]*Bring back/)
  assert.match(html, /Not problems here · 1[\s\S]*Only shown from the command line/)
  assert.match(renderToStaticMarkup(<CheckGroups checks={[]} admin busy={false} onAct={noop} onSnooze={noop} />), /Every setup check passes/)
})

test('the version track: running and available, the deployment in words, and the update button for Compose only', () => {
  const html = renderToStaticMarkup(<VersionTrack r={reading()} admin busy={false} onUpdate={noop} />)
  assert.match(html, /running[\s\S]*34\.0\.3[\s\S]*available[\s\S]*34\.0\.6/)
  assert.match(html, /Docker Compose, built from a Dockerfile/)
  assert.match(html, /web updater is off/)
  assert.match(html, /Check and update to 34\.0\.6/)
  const bare = renderToStaticMarkup(<VersionTrack r={reading({ deployment: { kind: 'bare', bareDir: '/var/www/nextcloud' } })} admin busy={false} onUpdate={noop} />)
  assert.match(bare, /How to update it/)
  assert.match(renderToStaticMarkup(<VersionTrack r={reading({ update: { core: null, apps: [], webUpdaterDisabled: false } })} admin busy={false} onUpdate={noop} />), /Up to date/)
})

test('the update check: every refusal, the backup location, the snapshot note and the rollback', () => {
  const html = renderToStaticMarkup(<UpdateCheckView p={{ ok: false, problems: ['1 user was active in the last 10 minutes.'], warnings: ['The image is built from a Dockerfile here, so HyperProx rebuilds it with --pull.'],
    from: '34.0.3', to: '34.0.6', source: 'build', backupDir: '/opt/nextcloud/hyperprox-backups', steps: ['Check nobody is using it', 'Dump the database'],
    snapshotNote: 'This container has bind mounts (mp0), so Proxmox cannot snapshot it.', rollback: 'To go back to Nextcloud 34.0.3:', activeUsers: 1, activeCalls: 0 }} />)
  assert.match(html, /Not now:[\s\S]*1 user was active/)
  assert.match(html, /rebuilt from your Dockerfile with --pull/)
  assert.match(html, /\/opt\/nextcloud\/hyperprox-backups/)
  assert.match(html, /cannot snapshot it/)
  assert.match(html, /How to roll back/)
  const ok = renderToStaticMarkup(<UpdateCheckView p={{ ok: true, problems: [], warnings: [], from: '34.0.3', to: '34.0.6', source: 'pull', backupDir: '/x', steps: [], snapshotNote: null, rollback: null, activeUsers: 0, activeCalls: null }} />)
  assert.match(ok, /nobody \(HyperProx&#x27;s own login is not counted\)/)
  assert.match(ok, /Take a Proxmox snapshot of the guest first if you can/)
})

test('a job shows each step in words, the newest output, the result, and the rollback when it failed', () => {
  const job = { id: 'j1', action: 'update' as const, by: 'admin@example.com', state: 'failed' as const, startedAt: '', endedAt: '', result: 'occ upgrade failed.', rollback: '1. docker tag ...',
    lines: ['line one', 'line two'], steps: [{ key: 'a', label: 'Maintenance mode on', state: 'done' as const }, { key: 'b', label: 'Dump the database', state: 'failed' as const, detail: 'no space' }, { key: 'c', label: 'Recreate', state: 'pending' as const }] }
  const html = renderToStaticMarkup(<JobView job={job} />)
  assert.match(html, /Maintenance mode on[\s\S]*done/)
  assert.match(html, /Dump the database[\s\S]*failed · no space/)
  assert.match(html, /Recreate[\s\S]*waiting/)
  assert.match(html, /line two/); assert.match(html, /occ upgrade failed/); assert.match(html, /How to roll back[\s\S]*docker tag/)
  const on = renderToStaticMarkup(<JobView job={{ ...job, maintenance: 'on' }} />)
  assert.match(on, /Maintenance mode: ON/)
  const running = renderToStaticMarkup(<JobView job={{ ...job, state: 'running', result: null, detached: { backupDir: '/opt/nc/hyperprox-backups' } }} />)
  assert.match(running, /keeps going if this page closes or HyperProx restarts[\s\S]*\/opt\/nc\/hyperprox-backups\/jobs\/j1\/log/)
})

test('a job that finished with problems says so and keeps its rollback; stop watching says the update may still run', () => {
  const job = { id: 'j1', action: 'update' as const, by: 'a@example.com', state: 'problems' as const, startedAt: '', endedAt: '', result: 'Finished with problems. HyperProx then read occ status: maintenance mode ON.',
    rollback: '6. Turn maintenance mode off', lines: [], steps: [], detached: { backupDir: '/opt/nc/hyperprox-backups' } }
  const html = renderToStaticMarkup(<JobView job={job} />)
  assert.match(html, /Finished with problems: check Nextcloud/)
  assert.match(html, /How to roll back[\s\S]*Turn maintenance mode off/)
  const running = renderToStaticMarkup(<JobView job={{ ...job, state: 'running', result: null }} onStopWatching={() => {}} />)
  assert.match(running, /Stop watching this job \(it may still be running in the guest\)/)
  assert.ok(!/Stop watching/.test(renderToStaticMarkup(<JobView job={{ ...job, state: 'running', result: null }} />)), 'only for admins (a handler given)')
  assert.match(stopWatchingWords({ ...job, state: 'running' }), /does NOT stop anything in the guest[\s\S]*\/opt\/nc\/hyperprox-backups\/jobs\/j1\/state/)
})

test('2FA review: the enforcement as it stands, who lacks one, admins without one, and when enforcing is not offered', () => {
  const base = { users: [{ uid: 'alice', state: 'on' as const }, { uid: 'bob', state: 'off' as const }], excluded: [], truncated: false, providers: ['twofactor_totp'],
    enforcement: { enforced: true, groups: ['staff'], excluded: ['guests'] }, admins: [{ uid: 'bob', state: 'off' as const }] }
  const w = twoFactorWords(base)
  assert.match(w.state, /enforced now for the group staff, except guests\. Enforcing again keeps that/)
  assert.deepEqual(w.lacking, ['bob']); assert.deepEqual(w.adminsLacking, ['bob']); assert.equal(w.canEnforce, true)
  assert.equal(twoFactorWords({ ...base, excluded: ['x y'] }).canEnforce, false, 'a user that cannot be checked')
  assert.equal(twoFactorWords({ ...base, providers: [] }).canEnforce, false)
  assert.equal(twoFactorWords({ ...base, enforcement: null }).canEnforce, false)
})

test('Talk: the signalling version and what it lacks, and Client Push as three parts', () => {
  const html = renderToStaticMarkup(<TalkView r={reading()} admin busy={false} onHpb={noop} onPush={noop} />)
  assert.match(html, /2\.1\.1~docker/)
  assert.match(html, /lacks: changed-users/)
  assert.match(html, /Pull the newest and recreate/)
  assert.match(html, /App[\s\S]*not installed[\s\S]*Daemon[\s\S]*not found[\s\S]*Address[\s\S]*not set/)
  assert.match(html, /Set up Client Push/)
  assert.match(html, /No call running/)
})

test('logic: health ring, verdict, hours in UTC and local, regions, snippets and manual steps', () => {
  assert.ok(healthScore({ error: 0, warning: 0, info: 0 }) === 1)
  assert.ok(healthScore({ error: 1, warning: 0, info: 0 }) < healthScore({ error: 0, warning: 1, info: 0 }))
  assert.deepEqual(verdictOf(reading()), { text: '2 warnings', tone: 'warn' })
  assert.deepEqual(verdictOf(reading({ status: null })), { text: 'not answering', tone: 'bad' })
  assert.match(hourWords(1, 'America/Toronto'), /^01:00 UTC \(20:00 Toronto\)$/)
  assert.equal(hourWords(1, 'UTC'), '01:00 UTC')
  const r = regionOptions('CA')
  assert.equal(r[0].code, 'CA'); assert.ok(r.length > 240)
  assert.match(pushComposeSnippet(reading().deployment), /image: custom-nextcloud:apache[\s\S]*notify_push[\s\S]*NEXTCLOUD_URL: http:\/\/app/)
  assert.match(pushComposeSnippet(reading().deployment), /ports: \["127\.0\.0\.1:7867:7867"\]/, 'never all interfaces')
  assert.match(pushNginxSnippet('nc.lan'), /location \^~ \/push\/[\s\S]*proxy_pass http:\/\/nc\.lan:7867\/;[\s\S]*Upgrade/)
  assert.match(manualUpdateSteps({ kind: 'bare', bareDir: '/srv/nc' }, '34.0.6').join('\n'), /php \/srv\/nc\/updater\/updater\.phar/)
})
