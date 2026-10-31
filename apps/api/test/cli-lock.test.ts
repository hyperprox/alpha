// `hyperprox lock` when the API cannot be reached restarts the keyholder, and leaves word that this was a
// manual lock, so the API does not later alert "the keyholder restarted" for it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(__dirname, '..', '..', '..')

test('API unreachable: restarts the keyholder and records the reason as manual', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khtest-cli-'))
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin)
  const calls = path.join(tmp, 'systemctl.log')
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(calls)}\nexit 0\n`, { mode: 0o755 })
  const data = path.join(tmp, 'data')
  const r = spawnSync('bash', [path.join(REPO, 'bin', 'hyperprox'), 'lock'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HYPERPROX_DIR: tmp, HYPERPROX_DATA_DIR: data, HYPERPROX_API_URL: 'http://127.0.0.1:1' },
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /keyholder was restarted/)
  assert.ok(fs.readFileSync(calls, 'utf8').includes('restart hyperprox-keyholder'))
  const reason = JSON.parse(fs.readFileSync(path.join(data, 'keyholder-restart-reason.json'), 'utf8'))
  assert.equal(reason.reason, 'manual')
})
