// The node-side commands that run a script in a guest: the script arrives on stdin, never on a command line, and
// is staged only in files that root alone can read. Run for real under bash with pretend `pct` and `qm`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { containerScriptCommand, vmScriptCommand } from '../src/lib/node-exec'

const SECRET = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----'
const SCRIPT = `printf '%s\\n' 'hello from the guest'\ncat > /dev/null <<'EOF'\n${SECRET}\nEOF\nexit 3\n`

function fakes() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-node-exec-'))
  const log = path.join(dir, 'log')
  // pct push records the mode of the node-side file it was given, then copies it with the requested perms.
  fs.writeFileSync(path.join(dir, 'pct'), `#!/bin/bash
case "$1" in
  push) echo "push-src-mode $(stat -c %a "$3")" >> ${log}; cp "$3" "$4"; chmod "$6" "$4"; echo "push-dst-mode $(stat -c %a "$4")" >> ${log} ;;
  exec) shift 3; "$@" ;;
esac
`, { mode: 0o755 })
  // qm guest exec records the mode of the file on its stdin, then runs it, and answers like the agent does.
  fs.writeFileSync(path.join(dir, 'qm'), `#!/bin/bash
echo "qm-args $*" >> ${log}
echo "stdin-mode $(stat -L -c %a /dev/stdin)" >> ${log}
out=$(bash); rc=$?
printf '{"exited":1,"exitcode":%d,"out-data":"%s"}' "$rc" "$out"
`, { mode: 0o755 })
  return { dir, log }
}

function run(command: string, dir: string) {
  return spawnSync('bash', ['-c', command], { input: SCRIPT, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } })
}

test('container: private from the first byte, script on stdin, every staged copy removed', () => {
  const { dir, log } = fakes()
  const id = `101-test-${process.pid}`
  const cmd = containerScriptCommand(101, id)
  assert.match(cmd, /^umask 077\n/)
  assert.ok(!cmd.includes('PRIVATE KEY'))
  const r = run(cmd, dir)
  assert.equal(r.status, 3, r.stderr)
  assert.match(r.stdout, /hello from the guest/)
  const seen = fs.readFileSync(log, 'utf8')
  assert.match(seen, /push-src-mode 600/)
  assert.match(seen, /push-dst-mode 700/)
  assert.ok(!fs.existsSync(`/tmp/hyperprox-${id}.sh`), 'node copy removed')
  assert.ok(!fs.existsSync(`/tmp/hyperprox-run-${id}.sh`), 'guest copy removed')
  fs.rmSync(dir, { recursive: true })
})

test('container: the node copy is removed even when the push fails', () => {
  const { dir } = fakes()
  fs.writeFileSync(path.join(dir, 'pct'), '#!/bin/bash\nexit 9\n', { mode: 0o755 })
  const id = `101-fail-${process.pid}`
  const r = run(containerScriptCommand(101, id), dir)
  assert.equal(r.status, 9)
  assert.ok(!fs.existsSync(`/tmp/hyperprox-${id}.sh`))
  fs.rmSync(dir, { recursive: true })
})

test('VM: the agent gets the script on stdin from a 0600 file, not on its command line', () => {
  const { dir, log } = fakes()
  const id = `102-test-${process.pid}`
  const cmd = vmScriptCommand(102, 120, id)
  assert.match(cmd, /^umask 077\n/)
  const r = run(cmd, dir)
  assert.equal(r.status, 0, r.stderr)
  const j = JSON.parse(r.stdout)
  assert.equal(j.exitcode, 3)
  assert.match(j['out-data'], /hello from the guest/)
  const seen = fs.readFileSync(log, 'utf8')
  assert.match(seen, /qm-args guest exec 102 --timeout 120 --pass-stdin 1 -- bash\n/)
  assert.ok(!seen.includes('PRIVATE KEY'), 'nothing of the script on the agent command line')
  assert.match(seen, /stdin-mode 600/)
  assert.ok(!fs.existsSync(`/tmp/hyperprox-${id}.sh`))
  fs.rmSync(dir, { recursive: true })
})
