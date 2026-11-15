// Long plug-in jobs: the registry deploy.sh and the in-app updater read before restarting the API. Markers of work in
// a process that is gone are dropped; detached work stays until its owner ends it; deploy.sh refuses while any is live.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { busyJobs, endLongJob, registerLongJob } from '../src/lib/long-jobs'

function withDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-busy-'))
  const prev = process.env.HYPERPROX_BUSY_DIR
  process.env.HYPERPROX_BUSY_DIR = dir
  try { return fn(dir) } finally {
    if (prev === undefined) delete process.env.HYPERPROX_BUSY_DIR; else process.env.HYPERPROX_BUSY_DIR = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('register, list and end; a marker from a process that is gone is dropped, a detached one is kept', () => withDir(dir => {
  registerLongJob({ id: 'j1', owner: 'nextcloud', label: 'Nextcloud Cloud: update', detached: true })
  registerLongJob({ id: 'j2', owner: 'nextcloud', label: 'Nextcloud Cloud: repair', detached: false })
  fs.writeFileSync(path.join(dir, 'j3.json'), JSON.stringify({ id: 'j3', owner: 'other', label: 'dead', pid: 999_999_999, detached: false, at: '' }))
  assert.deepEqual(busyJobs().map(j => j.id).sort(), ['j1', 'j2'])
  assert.ok(!fs.existsSync(path.join(dir, 'j3.json')), 'the dead marker was removed')
  assert.deepEqual(busyJobs('other'), [])
  endLongJob('j2')
  assert.deepEqual(busyJobs().map(j => j.id), ['j1'])
  assert.throws(() => registerLongJob({ id: '../x', owner: 'nextcloud', label: 'x', detached: false }), /Bad/)
}))

test('deploy.sh refuses to restart anything while a long job runs, names it, and says how to override', () => withDir(dir => {
  const root = path.join(__dirname, '..', '..', '..')
  registerLongJob({ id: 'j1', owner: 'nextcloud', label: 'Nextcloud Cloud: update 34.0.3 to 34.0.6', detached: true })
  fs.writeFileSync(path.join(dir, 'j2.json'), JSON.stringify({ id: 'j2', owner: 'x', label: 'long gone', pid: 999_999_999, detached: false, at: '' }))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-deploy-'))
  const r = spawnSync('bash', [path.join(root, 'deploy.sh')], {
    env: { ...process.env, HYPERPROX_DIR: tmp, HYPERPROX_DEPLOY_LOCK: path.join(tmp, 'lock'), HYPERPROX_BUSY_DIR: dir }, encoding: 'utf8', timeout: 30_000,
  })
  fs.rmSync(tmp, { recursive: true, force: true })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /long plug-in job is running/)
  assert.match(r.stderr, /Nextcloud Cloud: update 34\.0\.3 to 34\.0\.6/)
  assert.ok(!r.stderr.includes('long gone'), 'a marker from a process that is gone does not block')
  assert.match(r.stderr, /HYPERPROX_IGNORE_BUSY=1/)
  // The guard comes before anything that changes the install (the vault check, builds, migrations, restarts).
  const src = fs.readFileSync(path.join(root, 'deploy.sh'), 'utf8')
  assert.ok(src.indexOf('BUSY_DIR=') < src.indexOf('VAULT_ADMIN_TOKEN_HASH'))
  assert.ok(src.indexOf('BUSY_DIR=') < src.indexOf('systemctl restart hyperprox-api'))
}))
