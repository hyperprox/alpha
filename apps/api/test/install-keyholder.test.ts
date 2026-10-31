// bin/install-keyholder, the step deploy.sh and install.sh run: installs the unit and the API drop-in,
// starts the keyholder when it is not running, and restarts it ONLY when its program changed (saying
// that this locks HyperProx). Runs against a scratch directory with a stand-in `systemctl`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(__dirname, '..', '..', '..')
const SCRIPT = path.join(REPO, 'bin', 'install-keyholder')

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khtest-install-'))
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin)
  const hp = path.join(tmp, 'hp'); fs.mkdirSync(path.join(hp, 'bin'), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'bin', 'hyperprox-keyholder'), path.join(hp, 'bin', 'hyperprox-keyholder'))
  const calls = path.join(tmp, 'systemctl.log')
  const active = path.join(tmp, 'active')
  // A stand-in systemctl: records every call; "is-active" answers from a file; "start"/"restart" make it active.
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(calls)}
case "$1" in
  is-active) [ -f ${JSON.stringify(active)} ] ;;
  start|restart) [ -n "\${STUB_START_FAIL:-}" ] && exit 1; touch ${JSON.stringify(active)} ;;
  show) echo "" ;;
esac
`, { mode: 0o755 })
  const run = (extra: Record<string, string> = {}) => spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env, ...extra, PATH: `${bin}:${process.env.PATH}`, HYPERPROX_DIR: hp,
      SYSTEMD_DIR: path.join(tmp, 'systemd'), KEYHOLDER_LIB: path.join(tmp, 'lib'),
    },
  })
  const callsNow = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [])
  const reset = () => fs.rmSync(calls, { force: true })
  return { tmp, hp, run, callsNow, reset }
}

test('first run: installs the unit and the API drop-in, starts the keyholder, warns about the one last lock', () => {
  const t = setup()
  const r = t.run()
  assert.equal(r.status, 0, r.stderr)
  const unit = fs.readFileSync(path.join(t.tmp, 'systemd', 'hyperprox-keyholder.service'), 'utf8')
  assert.match(unit, /--socket \/run\/hyperprox-keyholder\/keyholder.sock --allow-uid 0 --allow-unit hyperprox-api.service/)
  for (const line of ['RuntimeDirectoryMode=0700', 'PrivateNetwork=yes', 'RestrictAddressFamilies=AF_UNIX', 'LimitCORE=0', 'MemorySwapMax=0', 'Type=notify',
    'CapabilityBoundingSet=\n', 'SystemCallFilter=@system-service', 'SystemCallArchitectures=native', 'PrivateDevices=yes', 'ProtectKernelLogs=yes',
    'ProtectClock=yes', 'ProtectHostname=yes', 'RestrictSUIDSGID=yes']) {
    assert.ok(unit.includes(line), line)
  }
  assert.doesNotMatch(unit, /ProtectProc=invisible/, 'the keyholder reads the peer\'s /proc/<pid>/cgroup')
  const dropin = fs.readFileSync(path.join(t.tmp, 'systemd', 'hyperprox-api.service.d', 'keyholder.conf'), 'utf8')
  assert.match(dropin, /^Wants=hyperprox-keyholder.service$/m)
  assert.doesNotMatch(dropin, /Requires=|BindsTo=|PartOf=/, 'a keyholder restart must not restart the API')
  assert.match(dropin, /^Environment=VAULT_KEYHOLDER_SOCKET=\/run\/hyperprox-keyholder\/keyholder.sock$/m)
  // The API holds the same state: no core dumps or swap for it either.
  assert.match(dropin, /^LimitCORE=0$/m)
  assert.match(dropin, /^MemorySwapMax=0$/m)
  assert.ok(t.callsNow().includes('daemon-reload'))
  assert.ok(t.callsNow().includes('start hyperprox-keyholder.service'))
  assert.match(r.stdout, /First install of the keyholder/)
  assert.equal(t.callsNow().some(c => /hyperprox-api/.test(c) && /restart|stop|start/.test(c.split(' ')[0])), false, 'never touches the API')
})

test('a deploy with the keyholder unchanged leaves it alone (HyperProx stays unlocked)', () => {
  const t = setup()
  assert.equal(t.run().status, 0)
  t.reset()
  const r = t.run()
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /left alone/)
  assert.equal(t.callsNow().some(c => /^(restart|stop|start|daemon-reload)/.test(c)), false, t.callsNow().join('; '))
})

test('a deploy that changes the keyholder program restarts it, and says it locks HyperProx', () => {
  const t = setup()
  assert.equal(t.run().status, 0)
  t.reset()
  fs.appendFileSync(path.join(t.hp, 'bin', 'hyperprox-keyholder'), '\n# a new version\n')
  const r = t.run()
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /program changed\. Restarting it now LOCKS HyperProx/)
  assert.ok(t.callsNow().includes('restart hyperprox-keyholder.service'))
  assert.equal(fs.readFileSync(path.join(t.tmp, 'lib', 'hyperprox-keyholder'), 'utf8').includes('# a new version'), true)
})

test('a stopped keyholder is started again, without a restart of anything else', () => {
  const t = setup()
  assert.equal(t.run().status, 0)
  fs.rmSync(path.join(t.tmp, 'active'))
  t.reset()
  const r = t.run()
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(t.callsNow().filter(c => /^(start|restart|stop)/.test(c)), ['start hyperprox-keyholder.service'])
  assert.doesNotMatch(r.stdout, /First install/)
})

test('the keyholder fails to start: the API drop-in is removed and reloaded before exiting, so the API stays in today\'s mode', () => {
  const t = setup()
  const r = t.run({ STUB_START_FAIL: '1' })
  assert.notEqual(r.status, 0)
  assert.equal(fs.existsSync(path.join(t.tmp, 'systemd', 'hyperprox-api.service.d', 'keyholder.conf')), false)
  const calls = t.callsNow()
  assert.ok(calls.lastIndexOf('daemon-reload') > calls.indexOf('start hyperprox-keyholder.service'), calls.join('; '))
  assert.match(r.stderr, /keyholder did not start/)
})

test('a changed program whose restart fails: the drop-in is removed too', () => {
  const t = setup()
  assert.equal(t.run().status, 0)
  fs.appendFileSync(path.join(t.hp, 'bin', 'hyperprox-keyholder'), '\n# broken\n')
  t.reset()
  const r = t.run({ STUB_START_FAIL: '1' })
  assert.notEqual(r.status, 0)
  assert.equal(fs.existsSync(path.join(t.tmp, 'systemd', 'hyperprox-api.service.d', 'keyholder.conf')), false)
  assert.ok(t.callsNow().includes('daemon-reload'))
})
