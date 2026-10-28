// The npm-app helper: versions and names, finding installs in what a guest reports (including what a
// hostile process can put in its arguments), the registry and release-note reads against a mock, and
// the apply script — built from hostile input, and run for real under bash against stub binaries.
// Package names, paths and hosts are generic: this repo is public.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { AppContext } from '../src/lib/plugin-host'
import {
  compareVersions, inRange, isNpmName, isSafeAbsPath, isStableVersion, isUnitName, isUserName, isVersion,
} from '../src/lib/app-updates/versions'
import {
  type NpmInstall, detectNpmInstalls, dirFromArgs, npmApply, npmApplyScript, npmDiscoverScript, npmFactsScript, npmRelease,
  npmUpdateBlocker, parseNpmDiscover, parseServiceState, securityLine, waitForSteadyService,
} from '../src/lib/app-updates/npm-app'

const e = (s: string) => Buffer.from(s).toString('base64')

/** A context whose run() answers from a function; fetchJson from a map of URL → value or Error. */
function ctxWith(run: (script: string) => { code: number; output: string }, fetches: Record<string, unknown> = {}): AppContext & { scripts: string[]; t: number } {
  const c: any = {
    scripts: [] as string[], t: 0,
    guest: { vmid: 101, name: 'guest-101', node: 'node-a', type: 'lxc' },
    async run(script: string) { c.scripts.push(script); const r = run(script); return { timedOut: false, ...r } },
    option: () => undefined,
    async fetchJson(url: string, body?: unknown) {
      const key = body === undefined ? url : `POST ${url}`
      const v = fetches[key]
      if (v === undefined) throw new Error(`HTTP 404 for ${key}`)
      if (v instanceof Error) throw v
      return v
    },
    http: async () => { throw new Error('no http in this test') },
    wsProbe: async () => ({ upgraded: false, status: 0, firstMessage: null }),
    proxiedUrls: async () => [],
    log: () => {},
    now: () => c.t,
    sleep: async (ms: number) => { c.t += ms },
  }
  return c
}

// --- versions and names ------------------------------------------------------------------

test('versions: semver precedence, pre-releases below their release, garbage refused', () => {
  assert.ok(compareVersions('1.3.1', '1.1.53') > 0)
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0)
  assert.ok(compareVersions('2.0.0-rc.1', '2.0.0') < 0)
  assert.ok(compareVersions('2.0.0-rc.2', '2.0.0-rc.10') < 0)
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0)
  assert.throws(() => compareVersions('1.0', '1.0.0'))
  assert.equal(isStableVersion('1.2.3'), true)
  assert.equal(isStableVersion('1.2.3-beta.1'), false)
  for (const bad of ['1.2', '01.2.3', '1.2.3; rm -rf /', '1.2.3\n', "1.2.3'", '$(id)', 'latest', '']) assert.equal(isVersion(bad), false, bad)
})

test('names, users, units and paths: only shapes that are safe to quote into a root shell', () => {
  for (const ok of ['meshcentral', '@scope/pkg-name', 'a.b_c~d']) assert.equal(isNpmName(ok), true, ok)
  for (const bad of ['MeshCentral', 'pkg name', 'pkg;id', '../x', '@scope/../x', '-rf', "a'b"]) assert.equal(isNpmName(bad), false, bad)
  assert.equal(isUserName('appuser'), true)
  assert.equal(isUserName('app user'), false)
  assert.equal(isUnitName('app.service'), true)
  assert.equal(isUnitName('app.service;id'), false)
  assert.equal(isSafeAbsPath('/opt/app'), true)
  for (const bad of ['opt/app', '/opt/../etc', '/opt/./app', '/opt//app', '/opt/app\n/etc']) assert.equal(isSafeAbsPath(bad), false, JSON.stringify(bad))
})

test('advisory ranges: the forms GitHub and npm write, and null when unreadable', () => {
  assert.equal(inRange('1.1.53', '<1.1.60'), true)
  assert.equal(inRange('1.1.60', '< 1.1.60'), false)
  assert.equal(inRange('1.2.0', '>= 1.0.0, < 1.2.3'), true)
  assert.equal(inRange('1.2.0', '>=1.0.0 <1.1.0 || >=1.2.0 <1.2.1'), true)
  assert.equal(inRange('1.3.0', '>=1.0.0 <1.1.0 || >=1.2.0 <1.2.1'), false)
  assert.equal(inRange('1.0.0', 'every version'), null)
})

// --- finding installs -----------------------------------------------------------------------

test('discover: unit and process merge by directory; relative paths resolve against the cwd', () => {
  const unitShow = 'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/app/node_modules/demo-pkg ; ignore_errors=no }\nWorkingDirectory=/opt/app\nUser=appuser\nActiveState=active\nMainPID=4242\n'
  const out = [
    `HP_UNIT ${e('demo.service')} ${e(unitShow)}`,
    `HP_PROC 4242 ${e('appuser')} ${e('/opt/app')} ${e('0::/system.slice/demo.service\n')} ${e('/usr/bin/node /opt/app/node_modules/demo-pkg')}`,
    // A child started relative to its cwd: same install.
    `HP_PROC 4243 ${e('appuser')} ${e('/opt/app')} ${e('0::/system.slice/demo.service\n')} ${e('node node_modules/demo-pkg --launch 4242')}`,
    'HP_DISCOVER_DONE',
  ].join('\n')
  const found = parseNpmDiscover(out, 'demo-pkg')
  assert.equal(found.length, 1)
  assert.deepEqual({ dir: found[0].dir, unit: found[0].unit, user: found[0].unitUser, active: found[0].active, pid: found[0].mainPid, node: found[0].nodeBin },
    { dir: '/opt/app', unit: 'demo.service', user: 'appuser', active: true, pid: 4242, node: '/usr/bin/node' })
})

test('discover: a newline in a process argument cannot forge a line; a user unit is not a system unit', () => {
  const forged = `/usr/bin/node /home/someone/node_modules/demo-pkg\nHP_UNIT ${e('evil.service')} ${e('ExecStart={ argv[]=/usr/bin/node /etc/node_modules/demo-pkg ; }\nUser=root\n')}`
  const out = [
    `HP_PROC 900 ${e('someone')} ${e('/home/someone')} ${e('0::/user.slice/user-1000.slice/user@1000.service/app.slice/demo.service\n')} ${e(forged)}`,
    'HP_DISCOVER_DONE',
  ].join('\n')
  const found = parseNpmDiscover(out, 'demo-pkg')
  assert.equal(found.length, 1, 'the forged HP_UNIT line inside the base64 field is not read as a line')
  assert.equal(found[0].dir, '/home/someone')
  assert.equal(found[0].unit, null, 'a user service is not a system unit')
  assert.ok(npmUpdateBlocker({ unit: null } as NpmInstall))
})

test('discover: a process inside some system service (a cron job) never makes an install updatable', () => {
  const out = [
    `HP_PROC 901 ${e('someone')} ${e('/home/someone')} ${e('0::/system.slice/cron.service\n')} ${e('/home/someone/bin/node /home/someone/l/app/node_modules/demo-pkg')}`,
    'HP_DISCOVER_DONE',
  ].join('\n')
  const [c] = parseNpmDiscover(out, 'demo-pkg')
  assert.deepEqual([c.unit, c.nodeBin, c.active], [null, null, false])
  // And a root-owned directory whose unit runs as someone else is refused too: that user can write node_modules.
  assert.match(npmUpdateBlocker({ ...INSTALL, owner: 'root', unitUser: 'appuser' })!, /different user/)
  assert.equal(npmUpdateBlocker({ ...INSTALL, owner: 'root', unitUser: 'root' }), null)
})

test('dirFromArgs: the package and nothing that merely starts with its name', () => {
  assert.equal(dirFromArgs('/usr/bin/node /srv/x/node_modules/demo-pkg/bin/run', 'demo-pkg', null), '/srv/x')
  assert.equal(dirFromArgs('/usr/bin/node /srv/x/node_modules/demo-pkg-extra', 'demo-pkg', null), null)
  assert.equal(dirFromArgs('node node_modules/demo-pkg', 'demo-pkg', '/srv/y'), '/srv/y')
  assert.equal(dirFromArgs('node ../../etc/node_modules/demo-pkg', 'demo-pkg', '/srv/y'), '/etc')
  assert.equal(dirFromArgs('node node_modules/demo-pkg', 'demo-pkg', null), null)
})

test('detectNpmInstalls: version, pin, owner and extra files from the facts read', async () => {
  const unitShow = 'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/app/node_modules/demo-pkg ; }\nWorkingDirectory=/opt/app\nUser=appuser\nActiveState=active\nMainPID=10\n'
  const ctx = ctxWith(script => {
    if (script.includes('HP_DISCOVER_DONE')) return { code: 0, output: `HP_UNIT ${e('demo.service')} ${e(unitShow)}\nHP_DISCOVER_DONE\n` }
    return { code: 0, output: [
      `HP_REAL ${e('/opt/app')}`,
      `HP_OWNER ${e('appuser')}`,
      `HP_FILE package ${e(JSON.stringify({ dependencies: { 'demo-pkg': '1.1.53' } }))}`,
      `HP_FILE installed ${e(JSON.stringify({ name: 'demo-pkg', version: '1.1.53' }))}`,
      `HP_FILE config ${e('{"settings":{}}')}`,
    ].join('\n') }
  })
  const [i] = await detectNpmInstalls(ctx, 'demo-pkg', { config: 'data/config.json' })
  assert.equal(i.installed, '1.1.53')
  assert.equal(i.exact, true)
  assert.equal(i.owner, 'appuser')
  assert.equal(i.files.config, '{"settings":{}}')
  assert.match(ctx.scripts[1], /f config .*data\/config\.json/)
  assert.throws(() => npmFactsScript('/opt/app', 'demo-pkg', { config: '../../etc/shadow' }), /unsafe/)
  assert.match(npmDiscoverScript('demo-pkg'), /needle='node_modules\/demo-pkg'/)
  assert.throws(() => npmDiscoverScript("x'; id; '"), /not an npm package name/)
})

// --- the registry, notes, security ------------------------------------------------------------

const REGISTRY = 'https://registry.npmjs.org/demo-pkg'
const packument = { 'dist-tags': { latest: '1.3.1' }, versions: { '1.1.53': {}, '1.2.0': {}, '1.3.0': {}, '1.3.1': {}, '1.4.0-beta.1': {} } }

test('npmRelease: latest from the registry, notes newest first, security from the notes', async () => {
  const ctx = ctxWith(() => ({ code: 0, output: '' }), {
    [REGISTRY]: packument,
    'https://api.github.com/repos/example/demo/releases?per_page=100': [
      { tag_name: '1.3.1', body: '**PLEASE UPGRADE, THIS IS A SECURITY UPDATE**\n- fix', html_url: 'https://github.com/example/demo/releases/tag/1.3.1' },
      { tag_name: 'v1.3.0', body: '- features', html_url: 'https://evil.example/phish' },
      { tag_name: '1.1.53', body: 'old' },
    ],
    'POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk': {},
    'https://api.github.com/repos/example/demo/security-advisories?state=published&per_page=100': [],
  })
  const r = await npmRelease(ctx, 'demo-pkg', '1.1.53', { github: 'example/demo' })
  assert.equal(r.latest, '1.3.1')
  assert.deepEqual(r.notes.map(n => n.version), ['1.3.1', '1.3.0'])
  assert.equal(r.notes[1].url, undefined, 'only github.com release links are passed on')
  assert.equal(r.isSecurity, true)
  assert.match(r.securityNote!, /1\.3\.1 release notes: PLEASE UPGRADE, THIS IS A SECURITY UPDATE/)
})

test('npmRelease: an advisory affecting the installed version (and not the latest) wins; GitHub down is survivable', async () => {
  const ctx = ctxWith(() => ({ code: 0, output: '' }), {
    [REGISTRY]: packument,
    'https://api.github.com/repos/example/demo/releases?per_page=100': new Error('HTTP 403 rate limited'),
    'POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk': {
      'demo-pkg': [
        { id: 1, title: 'Fixed long ago', severity: 'low', vulnerable_versions: '<1.0.0' },
        { id: 2, title: 'Unsanitized fields', severity: 'high', vulnerable_versions: '<1.1.60' },
      ],
    },
  })
  const r = await npmRelease(ctx, 'demo-pkg', '1.1.53', { github: 'example/demo' })
  assert.equal(r.isSecurity, true)
  assert.match(r.securityNote!, /Unsanitized fields \(high, affects <1\.1\.60\)/)
  assert.deepEqual(r.notes, [])
})

test('npmRelease: current, unknown and malformed answers', async () => {
  const cur = await npmRelease(ctxWith(() => ({ code: 0, output: '' }), { [REGISTRY]: packument }), 'demo-pkg', '1.3.1')
  assert.deepEqual(cur, { latest: '1.3.1', notes: [], isSecurity: false })
  const bad = await npmRelease(ctxWith(() => ({ code: 0, output: '' }), { [REGISTRY]: { 'dist-tags': { latest: '1.0.0; id' }, versions: {} } }), 'demo-pkg', '1.0.0')
  assert.equal(bad.latest, null, 'a registry answer that is not a version is never used')
  assert.equal(securityLine('- 9864ae39 fix handle leak'), null)
  assert.match(securityLine('- fix: CVE-2026-12345 in the relay')!, /CVE-2026-12345/)
})

// --- applying ---------------------------------------------------------------------------------

const INSTALL: NpmInstall = {
  dir: '/opt/app', pkg: 'demo-pkg', installed: '1.1.53', spec: '1.1.53', exact: true, section: 'dependencies', owner: 'appuser',
  unit: 'demo.service', unitUser: 'appuser', active: true, mainPid: 10, nodeBin: '/usr/bin/node', command: '', files: {},
}

test('apply script: refuses hostile values outright, quotes the rest, stops before it installs', () => {
  assert.throws(() => npmApplyScript(INSTALL, '1.3.1; reboot'), /not a version/)
  assert.throws(() => npmApplyScript({ ...INSTALL, pkg: 'demo-pkg; reboot' }, '1.3.1'), /package name/)
  assert.throws(() => npmApplyScript({ ...INSTALL, dir: '/opt/../etc' }, '1.3.1'), /unsafe directory/)
  // A quote in a path is legal on disk; it is quoted, never interpreted.
  assert.match(npmApplyScript({ ...INSTALL, dir: "/opt/app'; reboot; '" }, '1.3.1'), /dir='\/opt\/app'\\''; reboot; '\\'''; pkg=/)
  assert.throws(() => npmApplyScript({ ...INSTALL, unit: null }, '1.3.1'), /no system unit/)
  assert.throws(() => npmApplyScript({ ...INSTALL, owner: 'a b' }, '1.3.1'), /user name/)
  assert.throws(() => npmApplyScript({ ...INSTALL, nodeBin: '/tmp/x/../node' }, '1.3.1'), /node path/)
  const s = npmApplyScript(INSTALL, '1.3.1')
  assert.ok(s.indexOf('systemctl stop') < s.indexOf('install --no-audit'))
  assert.ok(s.indexOf('install --no-audit') < s.indexOf(' ls --all'))
  assert.ok(s.indexOf(' ls --all') < s.indexOf('systemctl start'))
  assert.match(s, /runuser -u "\$owner" --/)
  assert.match(s, /--save --save-exact "\$pkg@\$ver"/)
  assert.match(s, / ls --all --omit=dev --json/)
  assert.match(npmApplyScript({ ...INSTALL, exact: false, spec: '^1.1.0' }, '1.3.1'), /--save "\$pkg@\$ver"/)
  assert.match(npmApplyScript({ ...INSTALL, section: null, spec: null }, '1.3.1'), /--no-save "\$pkg@\$ver"/)
  const dev = npmApplyScript({ ...INSTALL, section: 'devDependencies' }, '1.3.1')
  assert.match(dev, /--save-dev --save-exact/)
  assert.match(dev, / ls --all --json/)
  assert.match(s, /as_owner "\$nodebin" "\$npmcli" install/, 'npm runs through the resolved node, never through PATH')
})

test('npmApply: success only on the HP_APPLIED marker; the failure line is the reason', async () => {
  const good = await npmApply(ctxWith(() => ({ code: 0, output: 'HP_STEP npm\nHP_APPLIED 1.3.1\n' })), INSTALL, '1.3.1')
  assert.equal(good.ok, true)
  const bad = await npmApply(ctxWith(() => ({ code: 1, output: 'HP_FAIL npm install exited 1; demo.service is left STOPPED\n' })), INSTALL, '1.3.1')
  assert.deepEqual([bad.ok, bad.message], [false, 'npm install exited 1; demo.service is left STOPPED'])
  const blocked = await npmApply(ctxWith(() => { throw new Error('must not run') }), { ...INSTALL, unit: null }, '1.3.1')
  assert.match(blocked.message, /not run by a system service/)
  const mismatched = await npmApply(ctxWith(() => { throw new Error('must not run') }), { ...INSTALL, unitUser: 'other' }, '1.3.1')
  assert.match(mismatched.message, /different user/)
})

// The script itself, run by bash against stub systemctl and npm. Needs root (the install is root-owned
// here, which is also the path that checks binaries before running them as root).
const canRun = process.getuid?.() === 0 && spawnSync('bash', ['-c', 'command -v base64 && command -v getent']).status === 0
test('apply script, executed: stop → install as owner → npm ls → start; a failed install leaves it stopped', { skip: !canRun && 'needs root and bash' }, () => {
  // Under root's home: /tmp is world-writable, and the trust check rightly refuses anything below it.
  const root = fs.mkdtempSync(path.join(os.homedir(), '.hp-npm-test-'))
  try {
    const app = path.join(root, 'app'), bin = path.join(root, 'bin'), sys = path.join(root, 'sys'), log = path.join(root, 'log')
    for (const d of [app, bin, sys]) fs.mkdirSync(d)
    fs.writeFileSync(path.join(app, 'package.json'), '{"dependencies":{"demo-pkg":"1.1.53"}}')
    // A wrapper, not a link: the script resolves links, and npm is looked for next to the resolved node.
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`, { mode: 0o755 })
    const lsJson = JSON.stringify({ dependencies: { 'demo-pkg': { version: '1.3.1' } }, problems: ['extraneous: optional-mod@1.0.0 /x'] })
    // npm-cli.js stand-in: run by the resolved node, as npm itself would be.
    fs.writeFileSync(path.join(bin, 'npm'), `const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},'npm '+a.join(' ')+'\\n');if(a[0]==='ls')console.log(${JSON.stringify(lsJson)});if(a[0]==='install'&&fs.existsSync(${JSON.stringify(root + '/fail')}))process.exit(3)\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(sys, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> ${log}\n[ "$1" = is-active ] && echo inactive\nexit 0\n`, { mode: 0o755 })
    const install: NpmInstall = { ...INSTALL, dir: app, owner: 'root', unitUser: 'root', nodeBin: path.join(bin, 'node') }
    const run = () => spawnSync('bash', ['-s'], { input: npmApplyScript(install, '1.3.1'), env: { PATH: `${sys}:/usr/local/bin:/usr/bin:/bin` }, encoding: 'utf8' })

    const ok = run()
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    assert.match(ok.stdout, /^HP_APPLIED 1\.3\.1$/m)
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(l => !/is-active/.test(l))
    assert.deepEqual(calls.map(l => l.split(' ').slice(0, 2).join(' ')), ['systemctl stop', 'npm install', 'npm ls', 'systemctl start'])
    assert.match(calls[1], /install --no-audit --no-fund --no-update-notifier --save --save-exact demo-pkg@1\.3\.1/)

    fs.writeFileSync(log, '')
    fs.writeFileSync(path.join(root, 'fail'), '')
    const bad = run()
    assert.notEqual(bad.status, 0)
    assert.match(bad.stdout, /HP_FAIL npm install exited 3; demo\.service is left STOPPED/)
    assert.equal(/systemctl start/.test(fs.readFileSync(log, 'utf8')), false, 'never started after a failed install')

    // A binary root would run, but that someone else could have written: refused before anything stops.
    fs.rmSync(path.join(root, 'fail'))
    fs.chmodSync(path.join(bin, 'npm'), 0o777)
    fs.writeFileSync(log, '')
    const unsafe = run()
    assert.match(unsafe.stdout, /not root-owned and protected/)
    assert.equal(fs.readFileSync(log, 'utf8'), '', 'nothing was stopped')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// --- settling ---------------------------------------------------------------------------------

test('waitForSteadyService: waits out npm and a pid change; gives up on failed', async () => {
  const states = ['activating 0 0', 'active 50 1', 'active 50 0', 'active 51 0', 'active 51 0', 'active 51 0', 'active 51 0', 'active 51 0', 'active 51 0']
  const ctx = ctxWith(() => ({ code: 0, output: `HP_STATE ${states.length > 1 ? states.shift() : states[0]}\n` }))
  const r = await waitForSteadyService(ctx, 'demo.service', 'appuser', { steadyMs: 20_000, pollMs: 5_000 })
  assert.deepEqual([r.ok, r.pid], [true, 51])
  const failed = await waitForSteadyService(ctxWith(() => ({ code: 0, output: 'HP_STATE failed 0 0' })), 'demo.service', 'appuser')
  assert.equal(failed.ok, false)
  assert.deepEqual(parseServiceState('HP_STATE active 7 0'), { state: 'active', pid: 7, npm: 0 })
})

test('facts script, executed: real path, owner and files; links are not followed', { skip: !canRun && 'needs root and bash' }, () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.hp-facts-test-'))
  try {
    fs.mkdirSync(path.join(root, 'node_modules/demo-pkg'), { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"demo-pkg":"1.0.0"}}')
    fs.writeFileSync(path.join(root, 'node_modules/demo-pkg/package.json'), '{"version":"1.0.0"}')
    fs.symlinkSync('/etc/hostname', path.join(root, 'secret.json'))
    const r = spawnSync('bash', ['-s'], { input: npmFactsScript(root, 'demo-pkg', { secret: 'secret.json' }), encoding: 'utf8' })
    const lines = r.stdout.split('\n')
    const field = (k: string) => lines.find(l => l.startsWith(k))!.split(' ')
    assert.equal(Buffer.from(field('HP_REAL')[1], 'base64').toString().trim(), root)
    assert.equal(Buffer.from(field('HP_OWNER')[1], 'base64').toString(), 'root')
    assert.equal(Buffer.from(field('HP_FILE installed')[2], 'base64').toString(), '{"version":"1.0.0"}')
    assert.equal(field('HP_FILE secret')[2], '-')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
