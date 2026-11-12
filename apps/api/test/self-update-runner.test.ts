// The self-update step runner, against a pretend install (fakes/self-update.ts): the success path, a failure at
// every step (before the checkout: nothing changed, nothing rolled back; after it: rolled back), a migration
// failure restoring the database, the signed-tag requirement, commits that are not on the channel's branch, and
// no secret ever reaching the log. One test uses real git, to show a commit off the branch is refused for real.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runUpdate, deployPhase, pruneBackups, upstreamAllowed } from '../src/lib/self-update/runner'
import { MemoryStateSink, initialState, type UpdateState } from '../src/lib/self-update/state'
import { redactorForInstall, makeRedactor, envSecrets, MASK } from '../src/lib/self-update/redact'
import { RealShell } from '../src/lib/self-update/shell'
import { FakeInstall, FROM, TO, SECRET_PW, SECRET_TOKEN, type FakeOptions } from './fakes/self-update'

async function run(o: FakeOptions = {}, over = {}) {
  const f = new FakeInstall(o)
  const job = f.job(over)
  const sink = new MemoryStateSink(initialState(job))
  const end = await runUpdate(job, { sh: f, http: f.http, state: sink, redact: redactorForInstall(f.dir), sleep: async () => undefined })
  return { f, end, sink }
}
const step = (s: UpdateState, id: string) => s.steps.find(x => x.id === id)!.status

test('success: every step done, checked out and deployed the target, the backup is kept, rollback skipped', async () => {
  const { f, end } = await run({ migrationsAdded: 2 })
  try {
    assert.equal(end.status, 'succeeded', end.summary)
    for (const id of ['preflight', 'backup', 'fetch', 'build', 'migrate', 'restart', 'health']) assert.equal(step(end, id), 'done', id)
    assert.equal(step(end, 'rollback'), 'skipped')
    assert.equal(f.head, TO); assert.equal(f.deployed, TO)
    assert.ok(f.stagingSeen, 'looked over in a staging worktree before deploy.sh from it ran')
    const stage = f.calls.findIndex(c => c.startsWith('git worktree add'))
    const deploy = f.calls.findIndex(c => c.startsWith('bash '))
    const checkout = f.calls.findIndex(c => c.startsWith('git checkout'))
    assert.ok(stage < checkout && checkout < deploy, 'staged, then checked out, then run')
    assert.ok(end.backupFile && fs.existsSync(end.backupFile), 'the database backup exists')
    assert.match(path.basename(end.backupFile!), /^hyperprox-pre-update-0\.2\.0-alpha-aaaaaaa\.sql$/)
    assert.equal((fs.statSync(end.backupFile!).mode & 0o777), 0o600)
    assert.ok(f.calls.some(c => c === `git update-ref refs/hyperprox-update/previous ${FROM}`), 'the current commit is recorded')
    assert.equal(end.migrationsApplied, true); assert.equal(end.dbRestored, false)
    assert.equal(f.restored, false)
  } finally { f.cleanup() }
})

// Before the checkout nothing has changed: the run fails, nothing is rolled back, the install is where it was.
for (const failAt of ['df', 'dirty', 'pg_dump', 'fetch', 'tag-moved', 'staging'] as const) {
  test(`a failure before the checkout (${failAt}) changes nothing and rolls nothing back`, async () => {
    const { f, end } = await run({ failAt })
    try {
      assert.equal(end.status, 'failed')
      assert.equal(step(end, 'rollback'), 'skipped')
      assert.equal(f.head, FROM, 'still on the previous commit')
      assert.ok(!f.calls.some(c => c.startsWith('git checkout')), 'never checked out')
      assert.ok(!f.calls.some(c => c.startsWith('bash ')), 'deploy.sh never ran')
      assert.match(end.summary!, /before anything was changed/)
      if (failAt === 'dirty') assert.match(end.summary!, /local changes.*apps\/api\/src\/index\.ts/)
      if (failAt === 'df') assert.match(end.summary!, /MiB free/)
    } finally { f.cleanup() }
  })
}

// After the checkout: back to the previous commit, deploy.sh again, the previous version healthy.
for (const [failAt, failed] of [['build', 'build'], ['restart', 'restart'], ['health', 'health']] as const) {
  test(`a failure at ${failAt} rolls back to the previous commit; no migration ran, so the database is not restored`, async () => {
    const { f, end } = await run({ failAt, migrationsAdded: failAt === 'build' ? 3 : 0 })
    try {
      assert.equal(end.status, 'rolled-back', end.summary)
      assert.equal(step(end, failed), 'failed')
      assert.equal(step(end, 'rollback'), 'done')
      assert.equal(f.head, FROM); assert.equal(f.deployed, FROM)
      assert.equal(f.restored, false, 'no restore')
      assert.equal(end.dbRestored, false)
      assert.match(end.summary!, /database was not restored/)
      assert.equal(f.calls.filter(c => c.startsWith('bash ')).length, 2, 'deploy.sh ran for the update and again for the rollback')
    } finally { f.cleanup() }
  })
}

test('a failing health check after migrations ran restores the database, and says so', async () => {
  const { f, end } = await run({ failAt: 'health', migrationsAdded: 1 })
  try {
    assert.equal(end.status, 'rolled-back')
    assert.equal(f.restored, true); assert.equal(end.dbRestored, true)
    assert.equal(f.apiStopped, true, 'the API is stopped while the database is restored')
    assert.match(end.summary!, /database was restored from the backup/)
    assert.ok(end.log.some(l => /Restoring it from/.test(l)))
  } finally { f.cleanup() }
})

test('a migration failure rolls back and restores the database from the backup', async () => {
  const { f, end } = await run({ failAt: 'migrate', migrationsAdded: 2 })
  try {
    assert.equal(end.status, 'rolled-back')
    assert.equal(step(end, 'migrate'), 'failed')
    assert.equal(step(end, 'build'), 'done')
    assert.equal(f.restored, true); assert.equal(end.dbRestored, true)
    const restore = f.calls.findIndex(c => c.includes('psql') && c.includes('--single-transaction'))
    const rollbackDeploy = f.calls.map((c, i) => [c, i] as const).filter(([c]) => c.startsWith('bash ')).pop()![1]
    assert.ok(restore < rollbackDeploy, 'the database is restored before the previous version starts')
    const psql = f.calls[restore]
    assert.match(psql, /--single-transaction/)
  } finally { f.cleanup() }
})

test('when the rollback fails too, the state says so and where the backup and previous commit are', async () => {
  // The update's own deploy.sh fails at the build, and the previous version's deploy.sh fails as well.
  const g = new FakeInstall({ failAt: 'build' })
  const orig = g.run.bind(g)
  g.run = async (cmd, args, opts) => (cmd === 'bash' && g.head === FROM ? { code: 1, stdout: '', stderr: '' } : orig(cmd, args, opts))
  const job = g.job()
  const out = await runUpdate(job, { sh: g, http: g.http, state: new MemoryStateSink(initialState(job)), redact: redactorForInstall(g.dir), sleep: async () => undefined })
  try {
    assert.equal(out.status, 'rollback-failed')
    assert.equal(step(out, 'build'), 'failed')
    assert.equal(step(out, 'rollback'), 'failed')
    assert.match(out.summary!, /refs\/hyperprox-update\/previous/)
    assert.match(out.summary!, /hyperprox-pre-update-/)
    assert.match(out.summary!, /deploy\.sh by hand/)
  } finally { g.cleanup() }
})

test('alpha: a commit that is not on main is refused before anything changes', async () => {
  const { f, end } = await run({ channel: 'alpha', failAt: 'not-on-branch' })
  try {
    assert.equal(end.status, 'failed')
    assert.match(end.summary!, /is not on main/)
    assert.equal(f.head, FROM)
  } finally { f.cleanup() }
})

test('signed tags: required and unsigned is refused; required and no trusted keys is refused; a bad signature is refused; a good one passes', async () => {
  const signed = 'object x\ntype commit\ntag v0.3.0\n\nRelease\n-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n'
  const a = await run({ tagText: 'object x\ntype commit\ntag v0.3.0\n\nRelease\n' }, { requireSigned: true, trustedKeys: '/keys' })
  const b = await run({ tagText: signed }, { requireSigned: true, trustedKeys: null })
  const c = await run({ tagText: signed, verifyTagCode: 1 }, { requireSigned: false, trustedKeys: '/keys' })
  const d = await run({ tagText: signed, verifyTagCode: 0 }, { requireSigned: true, trustedKeys: '/keys' })
  const e = await run({ tagText: '' }, { requireSigned: false })
  const alpha = await run({ channel: 'alpha' }, { requireSigned: true, trustedKeys: '/keys' })
  try {
    assert.equal(a.end.status, 'failed'); assert.match(a.end.summary!, /not signed/)
    assert.equal(b.end.status, 'failed'); assert.match(b.end.summary!, /no trusted keys/)
    assert.equal(c.end.status, 'failed'); assert.match(c.end.summary!, /does not verify/)
    assert.equal(d.end.status, 'succeeded', d.end.summary)
    assert.ok(d.f.calls.some(x => x.startsWith('git verify-tag refs/hyperprox-update/tags/v0.3.0')))
    assert.equal(e.end.status, 'succeeded', 'not required: an unsigned (lightweight) tag installs')
    assert.equal(alpha.end.status, 'failed'); assert.match(alpha.end.summary!, /alpha channel follows unsigned commits/)
    for (const r of [a, b, c, alpha]) assert.equal(r.f.head, FROM, 'nothing was checked out')
  } finally { for (const r of [a, b, c, d, e, alpha]) r.f.cleanup() }
})

test('a keyholder change (by content) is said in the log, so a lock after the restart is expected', async () => {
  const { f, end } = await run({ keyholderChanged: true })
  try {
    assert.equal(end.status, 'succeeded')
    assert.ok(end.log.some(l => /changes the keyholder/.test(l)))
  } finally { f.cleanup() }
  const quiet = await run({})
  try { assert.ok(!quiet.end.log.some(l => /changes the keyholder/.test(l))) } finally { quiet.f.cleanup() }
})

test('a renamed signed tag (an old release pushed under a newer name) is refused before anything changes', async () => {
  const oldSigned = 'object x\ntype commit\ntag v0.1.0\ntagger t <t@example.com> 1 +0000\n\nOld release\n-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n'
  const { f, end } = await run({ tagText: oldSigned, verifyTagCode: 0 }, { requireSigned: true, trustedKeys: '/keys' })
  try {
    assert.equal(end.status, 'failed')
    assert.match(end.summary!, /made as "v0\.1\.0", not v0\.3\.0/)
    assert.ok(!f.calls.some(c => c.startsWith('git verify-tag')), 'refused before the signature is even looked at')
    assert.equal(f.head, FROM)
  } finally { f.cleanup() }
})

test('a release whose package.json is not the offered version is refused', async () => {
  const { f, end } = await run({ stagedVersion: '0.1.0' })
  try {
    assert.equal(end.status, 'failed')
    assert.match(end.summary!, /contains version 0\.1\.0, not 0\.3\.0/)
    assert.equal(f.head, FROM)
  } finally { f.cleanup() }
})

test('a target that does not contain the installed commit is refused; a person can confirm it, an automatic install never', async () => {
  const plain = await run({ unrelated: true })
  const confirmed = await run({ unrelated: true }, { allowUnrelated: true })
  const auto = await run({ unrelated: true }, { allowUnrelated: true, how: 'auto' })
  try {
    assert.equal(plain.end.status, 'failed'); assert.match(plain.end.summary!, /does not contain the installed aaaaaaa/)
    assert.equal(plain.f.head, FROM)
    assert.equal(confirmed.end.status, 'succeeded', confirmed.end.summary)
    assert.ok(confirmed.end.log.some(l => /because admin@example\.com confirmed it/.test(l)))
    assert.equal(auto.end.status, 'failed', 'auto never moves to unrelated history'); assert.equal(auto.f.head, FROM)
  } finally { for (const r of [plain, confirmed, auto]) r.f.cleanup() }
})

test('the database restore follows _prisma_migrations, not deploy.sh\'s words', async () => {
  // A failure after the migrate step but with no migration in it: the table is unchanged, so no restore.
  const { f, end } = await run({ failAt: 'restart', migrationsAdded: 0 })
  try { assert.equal(end.status, 'rolled-back'); assert.equal(f.restored, false) } finally { f.cleanup() }
  // A failure whose deploy.sh printed nothing about migrations, yet the table changed: restored.
  const g = new FakeInstall({ failAt: 'restart' })
  const orig = g.run.bind(g)
  g.run = async (cmd, args, opts) => {
    if (cmd === 'bash' && g.head === TO) { g.migrations += '\nsneaky|2026-11-12|-'; return { code: 1, stdout: '', stderr: '' } }
    return orig(cmd, args, opts)
  }
  const job = g.job()
  const out = await runUpdate(job, { sh: g, http: g.http, state: new MemoryStateSink(initialState(job)), redact: s => s, sleep: async () => undefined })
  try { assert.equal(out.status, 'rolled-back'); assert.equal(out.dbRestored, true); assert.equal(g.restored, true) } finally { g.cleanup() }
})

test('a failed database restore leaves the API stopped on purpose and gives the exact recovery commands', async () => {
  const { f, end } = await run({ failAt: 'migrate', migrationsAdded: 1, restoreFails: true })
  try {
    assert.equal(end.status, 'rollback-failed')
    assert.equal(f.apiStopped, true)
    assert.equal(f.calls.filter(c => c.startsWith('bash ')).length, 1, 'the previous version is not started over a half-restored database')
    assert.match(end.summary!, /left stopped on purpose/)
    assert.match(end.summary!, /DROP SCHEMA public CASCADE; CREATE SCHEMA public;.*hyperprox-pre-update-0\.2\.0-alpha-aaaaaaa\.sql.*docker exec -i hyperprox-postgres psql -v ON_ERROR_STOP=1 --single-transaction/)
    assert.match(end.summary!, new RegExp(`git checkout -B 'main' ${FROM} && bash deploy\\.sh`))
    assert.ok(!end.summary!.includes(SECRET_PW))
  } finally { f.cleanup() }
})

test('the backup directory is made 0700', async () => {
  const { f, end } = await run({})
  try {
    assert.equal(end.status, 'succeeded')
    assert.equal(fs.statSync(path.dirname(end.backupFile!)).mode & 0o777, 0o700)
  } finally { f.cleanup() }
})

test('an automatic install never falls back to the mirror', async () => {
  const { f, end } = await run({ failAt: 'fetch' }, { how: 'auto', mirrorUrl: 'https://mirror.example/hyperprox.git' })
  try {
    assert.equal(end.status, 'failed')
    assert.equal(f.calls.filter(c => c.startsWith('git fetch')).length, 1, 'one fetch, from the upstream')
  } finally { f.cleanup() }
})

test('a non-https upstream is refused before anything is fetched', async () => {
  const { f, end } = await run({}, { repoUrl: 'http://example.com/evil.git' })
  try {
    assert.equal(end.status, 'failed')
    assert.ok(!f.calls.some(c => c.startsWith('git fetch')))
    assert.equal(upstreamAllowed('https://github.com/hyperprox/alpha.git', false), true)
    assert.equal(upstreamAllowed('ext::sh -c touch% /tmp/x', true), false)
    assert.equal(upstreamAllowed('file:///srv/up.git', false), false)
    assert.equal(upstreamAllowed('file:///srv/up.git', true), true)
    assert.equal(upstreamAllowed('https://x.example/a.git --upload-pack=touch', false), false)
  } finally { f.cleanup() }
})

test('no secret reaches the log, the step details or the summary', async () => {
  for (const failAt of [null, 'migrate', 'build'] as const) {
    const { f, end } = await run({ failAt, migrationsAdded: 1 })
    try {
      const all = JSON.stringify(end)
      assert.ok(!all.includes(SECRET_PW), 'the database password never appears')
      assert.ok(!all.includes(SECRET_TOKEN), 'the vault token never appears')
      assert.ok(end.log.some(l => l.includes(MASK)), 'the lines that carried them are masked, not dropped')
    } finally { f.cleanup() }
  }
  const r = makeRedactor(envSecrets('A_PASSWORD="hunter2hunter2"\nPLAIN_SETTING=plainvalue\nDATABASE_URL=postgres://u:pw1234@h/db\n'))
  assert.equal(r('x hunter2hunter2 y'), `x ${MASK} y`)
  assert.equal(r('plainvalue'), 'plainvalue')
  assert.equal(r('pw1234'), MASK)
  assert.equal(r('https://user:abc@host/x'), `https://user:${MASK}@host/x`)
  assert.equal(r('Authorization: Bearer abcdefghijklmnop'), `Authorization: ${MASK}`)
  assert.equal(r('password=s3cr3t!'), `password=${MASK}`)
})

test('deploy.sh step markers map to build, migrate and restart', () => {
  assert.equal(deployPhase('→ Installing dependencies...'), 'build')
  assert.equal(deployPhase('→ Building Frontend...'), 'build')
  assert.equal(deployPhase('→ Applying database migrations...'), 'migrate')
  assert.equal(deployPhase('→ Checking the keyholder...'), 'restart')
  assert.equal(deployPhase('→ Restarting services...'), 'restart')
  assert.equal(deployPhase('→ Checking that /grafana/ is gated...'), 'restart')
  assert.equal(deployPhase('  plain output'), null)
})

test('only the newest 3 pre-update backups are kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-bk-'))
  try {
    for (let i = 0; i < 5; i++) {
      const p = path.join(dir, `hyperprox-pre-update-0.${i}.0-aaaaaaa.sql`)
      fs.writeFileSync(p, 'x'); fs.utimesSync(p, 1000 + i, 1000 + i)
    }
    fs.writeFileSync(path.join(dir, 'unrelated.sql'), 'x')
    const removed = pruneBackups(dir, 3)
    assert.equal(removed.length, 2)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['hyperprox-pre-update-0.2.0-aaaaaaa.sql', 'hyperprox-pre-update-0.3.0-aaaaaaa.sql', 'hyperprox-pre-update-0.4.0-aaaaaaa.sql', 'unrelated.sql'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// Real git: an upstream with main and a side branch. The updater fetches main and must refuse the side commit.
test('real git: a commit that is not reachable from main upstream is refused, one that is passes the fetch step', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-git-'))
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...a], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  try {
    const up = path.join(root, 'up'); fs.mkdirSync(up)
    g(up, 'init', '-q')
    for (const f of ['deploy.sh', 'package.json', 'pnpm-lock.yaml', 'apps/api/package.json', 'apps/api/prisma/schema.prisma', 'apps/frontend/package.json']) {
      fs.mkdirSync(path.dirname(path.join(up, f)), { recursive: true })
      fs.writeFileSync(path.join(up, f), f === 'deploy.sh' ? 'prisma migrate deploy\nsystemctl restart hyperprox-api\n' : f.endsWith('.json') ? '{"version":"0.2.0"}' : '')
    }
    g(up, 'add', '-A'); g(up, 'commit', '-qm', 'base')
    const base = g(up, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(up, 'README'), 'main'); g(up, 'add', '-A'); g(up, 'commit', '-qm', 'on main')
    const onMain = g(up, 'rev-parse', 'HEAD')
    g(up, 'checkout', '-qb', 'side', base)
    fs.writeFileSync(path.join(up, 'EVIL'), 'x'); g(up, 'add', '-A'); g(up, 'commit', '-qm', 'side')
    const side = g(up, 'rev-parse', 'HEAD')
    g(up, 'checkout', '-q', 'main')
    const inst = path.join(root, 'inst')
    g(root, 'clone', '-q', up, inst); g(inst, 'checkout', '-q', '-B', 'main', base)
    fs.mkdirSync(path.join(inst, 'data', 'self-update'), { recursive: true })
    fs.writeFileSync(path.join(inst, '.git', 'info', 'exclude'), 'data/\n.env\nbackups/\n')
    fs.writeFileSync(path.join(inst, '.env'), 'POSTGRES_USER=u\nPOSTGRES_DB=d\n')

    // Real git; pretend df, docker, deploy.sh and HTTP.
    const real = new RealShell()
    let deployedHead = ''
    const sh = {
      async run(cmd: string, args: string[], opts: any = {}) {
        if (cmd === 'git') return real.run(cmd, args, opts)
        if (cmd === 'df') return { code: 0, stdout: 'h\n/dev/x 1 1 99999999 1% /\n', stderr: '' }
        if (cmd === 'docker') { if (opts.stdoutFile) fs.writeFileSync(opts.stdoutFile, '-- PostgreSQL database dump complete\n'); return { code: 0, stdout: '', stderr: '' } }
        if (cmd === 'bash') { deployedHead = g(inst, 'rev-parse', 'HEAD'); return { code: 0, stdout: '', stderr: '' } }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const http = async (url: string) => ({ status: 200, body: url.endsWith('/health') ? JSON.stringify({ commit: deployedHead.slice(0, 7) }) : 'ok' })
    const mk = (sha: string) => {
      const f = new FakeInstall({ channel: 'alpha' })
      f.cleanup()
      return { ...f.job(), dir: inst, from: { sha: base, version: '0.2.0', branch: 'main' }, target: { sha, channel: 'alpha' as const, ref: 'main', label: `main @ ${sha.slice(0, 7)}`, version: null },
               repoUrl: up, stateFile: path.join(inst, 'data', 'self-update', 'state.json'), logFile: path.join(inst, 'data', 'self-update', 'log'), backupDir: path.join(root, 'bk') }
    }
    process.env.HYPERPROX_UPDATE_INSECURE_UPSTREAM = '1'   // a local path upstream, for this test only
    // The installer marks scripts executable: a mode-only difference is not a local change.
    fs.chmodSync(path.join(inst, 'deploy.sh'), 0o755)
    const bad = mk(side)
    const r1 = await runUpdate(bad, { sh, http, state: new MemoryStateSink(initialState(bad)), redact: s => s, sleep: async () => undefined })
    assert.equal(r1.status, 'failed')
    assert.match(r1.summary!, /is not on main/)
    assert.equal(g(inst, 'rev-parse', 'HEAD'), base, 'still on the base commit')
    assert.ok(!fs.existsSync(path.join(inst, 'EVIL')))

    const good = mk(onMain)
    const r2 = await runUpdate(good, { sh, http, state: new MemoryStateSink(initialState(good)), redact: s => s, sleep: async () => undefined })
    assert.equal(r2.status, 'succeeded', r2.summary)
    assert.equal(g(inst, 'rev-parse', 'HEAD'), onMain)
    assert.equal(g(inst, 'symbolic-ref', '--short', 'HEAD'), 'main', 'still on the main branch')
    assert.equal(g(inst, 'rev-parse', 'refs/hyperprox-update/previous'), base)
    assert.equal(g(inst, 'worktree', 'list').split('\n').length, 1, 'the staging worktree is gone')
  } finally {
    delete process.env.HYPERPROX_UPDATE_INSECURE_UPSTREAM
    fs.rmSync(root, { recursive: true, force: true })
  }
})
