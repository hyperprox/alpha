// The scripts the self-update leans on: deploy.sh's step lines (the updater reads them to show progress) and its
// one-at-a-time lock, scripts/release.sh in a scratch repository, and install.sh / bootstrap.sh --ref.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { deployPhase } from '../src/lib/self-update/runner'

const ROOT = path.resolve(__dirname, '..', '..', '..')
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')

test('deploy.sh: every "→" line maps to a step, migrations come after the build and before the restart', () => {
  const lines = read('deploy.sh').split('\n').map(l => /^\s*echo "(→ [^"]+)"/.exec(l)?.[1]).filter(Boolean) as string[]
  assert.ok(lines.length >= 10)
  const phases = lines.map(l => deployPhase(l))
  assert.ok(phases.every(Boolean))
  const firstMigrate = phases.indexOf('migrate'), firstRestart = phases.indexOf('restart')
  assert.ok(firstMigrate > 0 && firstRestart > firstMigrate)
  assert.ok(phases.slice(0, firstMigrate).every(p => p === 'build'))
  assert.ok(phases.slice(firstRestart).every(p => p === 'restart'))
})

test('deploy.sh: a second deploy (or one under a running update) stops at once; the updater, holding the lock, is let through', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-deploylock-'))
  const lock = path.join(dir, 'deploy.lock')
  try {
    // An empty install: past the lock, deploy.sh stops at its first check ("no vault yet") and changes nothing.
    const env = { ...process.env, HYPERPROX_DIR: dir, HYPERPROX_DEPLOY_LOCK: lock }
    const free = spawnSync('bash', [path.join(ROOT, 'deploy.sh')], { env, encoding: 'utf8' })
    assert.equal(free.status, 1)
    assert.match(free.stderr, /no vault yet/)
    const holder = spawn('flock', [lock, 'sleep', '5'], { stdio: 'ignore' })
    await new Promise(r => setTimeout(r, 300))
    try {
      const busy = spawnSync('bash', [path.join(ROOT, 'deploy.sh')], { env, encoding: 'utf8' })
      assert.equal(busy.status, 1)
      assert.match(busy.stderr, /Another deploy or a HyperProx update is running/)
      const held = spawnSync('bash', [path.join(ROOT, 'deploy.sh')], { env: { ...env, HYPERPROX_DEPLOY_LOCK_HELD: '1' }, encoding: 'utf8' })
      assert.match(held.stderr, /no vault yet/, 'the updater holds the lock itself, so deploy.sh does not wait for it')
    } finally { holder.kill() }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('release.sh: bumps the versions, commits, makes an annotated tag with notes; refuses a version that is not newer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-release-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim()
  const rel = (...a: string[]) => spawnSync('bash', [path.join(ROOT, 'scripts', 'release.sh'), ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } })
  try {
    git('init', '-q', '-b', 'main')
    git('config', 'tag.gpgSign', 'false')
    fs.mkdirSync(path.join(dir, 'apps/api/prisma/migrations/20261101_x'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'apps/frontend'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), '{\n  "name": "hyperprox",\n  "version": "0.1.0-alpha",\n  "private": true\n}\n')
    fs.writeFileSync(path.join(dir, 'apps/api/package.json'), '{ "name": "@hyperprox/api", "version": "0.1.0-alpha" }\n')
    fs.writeFileSync(path.join(dir, 'apps/frontend/package.json'), '{ "name": "@hyperprox/frontend", "version": "0.1.0-alpha" }\n')
    git('add', '-A'); git('commit', '-qm', 'base'); git('tag', '-a', 'v0.1.0-alpha', '-m', 'first')
    fs.writeFileSync(path.join(dir, 'apps/api/prisma/migrations/20261101_x/migration.sql'), 'select 1;')
    git('add', '-A'); git('commit', '-qm', 'feat: a migration')

    const dry = rel('0.2.0-alpha', '--dry-run')
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /previous: v0\.1\.0-alpha/)
    assert.match(dry.stdout, /- feat: a migration/)
    assert.match(dry.stdout, /MIGRATION:.*\n- 20261101_x/)
    assert.equal(git('tag', '--list', 'v0.2.0-alpha'), '', 'a dry run changes nothing')

    const old = rel('0.1.0-alpha')
    assert.notEqual(old.status, 0)
    const notNewer = rel('0.0.9')
    assert.notEqual(notNewer.status, 0); assert.match(notNewer.stderr, /not newer/)

    const ok = rel('0.2.0-alpha')
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '0.2.0-alpha')
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'apps/api/package.json'), 'utf8')).version, '0.2.0-alpha')
    assert.equal(git('cat-file', '-t', 'v0.2.0-alpha'), 'tag', 'annotated')
    assert.equal(git('rev-parse', 'v0.2.0-alpha^{commit}'), git('rev-parse', 'HEAD'))
    assert.equal(git('log', '-1', '--format=%s'), 'Release v0.2.0-alpha')
    assert.match(git('tag', '-l', '--format=%(contents)', 'v0.2.0-alpha'), /MIGRATION/)
    assert.match(ok.stdout, /git push origin main v0\.2\.0-alpha/)

    git('checkout', '-qb', 'side')
    const side = rel('0.3.0')
    assert.notEqual(side.status, 0); assert.match(side.stderr, /cut from main/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('install.sh --ref and bootstrap.sh --ref: pinned installs, validated refs, the mirror passed through', () => {
  const install = read('install.sh'), boot = read('bootstrap.sh')
  assert.match(install, /--ref=\*\)\s+HYPERPROX_REF=/)
  assert.match(install, /REPO_URL="\$\{HYPERPROX_REPO_URL:-https:\/\/github\.com\/hyperprox\/alpha\.git\}"/)
  assert.match(install, /checkout --quiet -B main "\$sha"/, 'pinned, but on the main branch')
  assert.match(boot, /--ref\) REF="\$\{2:-\}"; shift 2;;/)
  assert.match(boot, /HYPERPROX_REF='\$REF' HYPERPROX_REPO_URL='\$REPO_URL_ARG' bash \/tmp\/install\.sh/)
  assert.match(boot, /raw\.githubusercontent\.com\/hyperprox\/alpha\/\$REF/)
  // The same validation in both: what reaches a shell is a plain ref.
  const re = /\^\[A-Za-z0-9\._\/-\]\{1,100\}\$/
  assert.match(install, re); assert.match(boot, re)
  const check = (ref: string) => spawnSync('bash', ['-c', '[[ "$1" =~ ^[A-Za-z0-9._/-]{1,100}$ && "$1" != *..* && "$1" != -* ]]', '_', ref]).status === 0
  for (const good of ['v0.3.0', 'main', 'a'.repeat(40), 'feat/self-update']) assert.ok(check(good), good)
  for (const bad of ["v1'; rm -rf /", '--upload-pack=x', 'a..b', '$(id)', '']) assert.ok(!check(bad), bad)
})
