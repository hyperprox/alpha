// Which channel an install follows and what it calls itself: an untagged install from main follows main (alpha)
// unless someone chose a channel; a release follows stable; versions compare by semver precedence, and neither
// channel ever offers an older version.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isTaggedDescribe, installedLabel, effectiveChannel, releaseVsInstalled } from '../src/lib/self-update/channel'
import { findUpdate, type Installed } from '../src/lib/self-update/check'
import { SelfUpdateService } from '../src/lib/self-update/service'
import type { Shell } from '../src/lib/self-update/shell'
import type { Upstream } from '../src/lib/self-update/upstream'

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40)
const untagged: Installed = { version: '0.2.0-alpha', sha: A, describe: 'v0.1.0-alpha-40-gaaaaaaa', branch: 'main', git: true }
const release: Installed = { version: '0.2.0-alpha', sha: A, describe: 'v0.2.0-alpha', branch: null, git: true }

test('tagged or not: only an exact release tag is a release', () => {
  assert.equal(isTaggedDescribe('v0.2.0-alpha'), true)
  assert.equal(isTaggedDescribe('v1.4.2'), true)
  assert.equal(isTaggedDescribe('v0.1.0-alpha-40-gaaaaaaa'), false)
  assert.equal(isTaggedDescribe('v1.4.2-3-g1234567'), false)
  assert.equal(isTaggedDescribe('aaaaaaa'), false)
  assert.equal(isTaggedDescribe(''), false)
})

test('what an install calls itself: the tag, or the package version with where it came from', () => {
  assert.deepEqual(installedLabel(release), { tagged: true, label: 'v0.2.0-alpha', display: 'v0.2.0-alpha' })
  assert.deepEqual(installedLabel(untagged), { tagged: false, label: '0.2.0-alpha+main.aaaaaaa', display: '0.2.0-alpha (main @ aaaaaaa, untagged)' })
})

test('the channel: chosen wins; otherwise untagged follows main and a release follows stable', () => {
  assert.equal(effectiveChannel({ chosen: null, installed: untagged, autoInstall: false }).channel, 'alpha')
  assert.equal(effectiveChannel({ chosen: null, installed: untagged, autoInstall: false }).source, 'default')
  assert.equal(effectiveChannel({ chosen: null, installed: release, autoInstall: false }).channel, 'stable')
  assert.deepEqual(effectiveChannel({ chosen: 'stable', installed: untagged, autoInstall: false }).channel, 'stable')
  assert.equal(effectiveChannel({ chosen: 'stable', installed: untagged, autoInstall: false }).source, 'chosen')
  // Automatic install only installs releases, so it keeps stable.
  assert.equal(effectiveChannel({ chosen: null, installed: untagged, autoInstall: true }).channel, 'stable')
  // Not known yet (before the first look): stable, the conservative answer.
  assert.equal(effectiveChannel({ chosen: null, installed: null, autoInstall: false }).channel, 'stable')
})

test('semver precedence: newer, same, older; a release outranks its pre-release', () => {
  assert.equal(releaseVsInstalled('0.1.0-alpha', '0.2.0-alpha'), 'older')
  assert.equal(releaseVsInstalled('0.2.0', '0.2.0-alpha'), 'newer')
  assert.equal(releaseVsInstalled('0.2.0-alpha', '0.2.0-alpha'), 'same')
  assert.equal(releaseVsInstalled('0.2.0-beta', '0.2.0-alpha'), 'newer')
  assert.equal(releaseVsInstalled('0.10.0-alpha', '0.9.0'), 'newer')
  assert.equal(releaseVsInstalled('not', '0.2.0'), 'unknown')
})

/** An upstream where main is ahead of the install and the newest release is older than it. */
function upstream(releases: Array<{ tag: string; sha: string; prerelease?: boolean }>, mainHead = B): Upstream & { compared: string[] } {
  const compared: string[] = []
  return {
    compared, source: 'github', where: 'github.com/example/hyperprox',
    async releases() { return releases.map(r => ({ tag: r.tag, name: r.tag, notes: '', date: null, prerelease: !!r.prerelease, url: null })) },
    async tags() { return releases.map(r => r.tag) },
    async tag(t) { return { tag: t, commit: releases.find(r => r.tag === t)!.sha, annotated: false, signed: false, verified: null } },
    async head() { return { sha: mainHead, subject: 'feat: something new', body: '', date: null } },
    async compare(base, head) {
      compared.push(`${base.slice(0, 1)}..${head.slice(0, 1)}`)
      // The old release (C) is behind the install; main (B) is ahead of it.
      if (head === C) return { status: 'behind' as const, commits: [], files: [], total: 0 }
      return { status: 'ahead' as const, commits: [{ sha: head, subject: 'feat: something new', body: '', date: null }], files: [], total: 1 }
    },
  }
}

test('stable never offers a downgrade: v0.1.0-alpha is not offered to a 0.2.0-alpha install', async () => {
  const up = upstream([{ tag: 'v0.1.0-alpha', sha: C, prerelease: true }])
  const r = await findUpdate(untagged, 'stable', up)
  assert.equal(r.available, null)
  assert.match(r.note, /newer than the newest release, v0\.1\.0-alpha/)
  assert.match(r.note, /alpha channel follows main/)
  assert.deepEqual(up.compared, [], 'no commit comparison is needed to refuse an older version')
})

test('the alpha channel offers main to the untagged install; a newer release is offered on stable', async () => {
  const a = await findUpdate(untagged, 'alpha', upstream([{ tag: 'v0.1.0-alpha', sha: C, prerelease: true }]))
  assert.equal(a.available?.sha, B)
  assert.equal(a.available?.channel, 'alpha')
  const s = await findUpdate(release, 'stable', upstream([{ tag: 'v0.1.0-alpha', sha: C }, { tag: 'v0.3.0-alpha', sha: B }]))
  assert.equal(s.available?.label, 'v0.3.0-alpha')
})

// --- the service: the default follows the install, a saved window does not freeze it, a choice is kept ---

const dirs: string[] = []
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }) })

function service(describe: string, ups: Upstream[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-su-chan-'))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"0.2.0-alpha"}')
  const sh: Shell = {
    async run(cmd, args) {
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
      if (cmd === 'git' && args[0] === 'rev-parse') return ok(A + '\n')
      if (cmd === 'git' && args[0] === 'symbolic-ref') return ok('main\n')
      if (cmd === 'git' && args[0] === 'describe') return ok(describe + '\n')
      return { code: 1, stdout: '', stderr: 'unexpected' }
    },
  }
  const audits: any[] = []
  const svc = new SelfUpdateService({
    dir, dataDir: path.join(dir, 'data', 'self-update'), sh,
    config: { repoUrl: 'https://github.com/example/hyperprox.git', mirrorUrl: null, trustedKeys: null, allowInsecure: false },
    upstreams: () => ups, isUnlocked: () => true, publish: async () => {}, audit: async (a, d) => { audits.push([a, d]) },
    launch: async () => {}, lockFile: path.join(dir, 'lock'), backupDir: path.join(dir, 'backups'), runningSha: A,
  })
  return { svc, dir, audits }
}

test('service: an untagged main install checks main by default, and is offered its newer commits', async () => {
  const { svc } = service('v0.1.0-alpha-40-gaaaaaaa', [upstream([{ tag: 'v0.1.0-alpha', sha: C, prerelease: true }])])
  const inst = await svc.installed()
  assert.equal(inst.tagged, false)
  assert.equal(inst.label, '0.2.0-alpha+main.aaaaaaa')
  assert.equal(svc.settings().channel, 'alpha')
  assert.equal(svc.channelInfo().source, 'default')
  const c = await svc.check()
  assert.equal(c.available?.sha, B)
})

test('service: saving other settings keeps the channel a default; choosing one keeps the choice', async () => {
  const { svc, dir } = service('v0.1.0-alpha-40-gaaaaaaa', [upstream([])])
  await svc.installed()
  await svc.saveSettings({ checkEveryHours: 12 }, 'admin@example.com')
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'self-update', 'settings.json'), 'utf8'))
  assert.equal('channel' in file, false, 'a defaulted channel is not written down')
  assert.equal(svc.settings().channel, 'alpha')
  await svc.saveSettings({ channel: 'stable' }, 'admin@example.com')
  assert.equal(svc.settings().channel, 'stable')
  assert.equal(svc.channelInfo().source, 'chosen')
})

test('service: a release follows stable by default', async () => {
  const { svc } = service('v0.2.0-alpha', [upstream([{ tag: 'v0.1.0-alpha', sha: C }])])
  await svc.installed()
  assert.equal(svc.settings().channel, 'stable')
  const c = await svc.check()
  assert.equal(c.available, null, 'and is never offered the older release')
})
