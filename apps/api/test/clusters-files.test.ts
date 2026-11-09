// File copies: path rules, the node-side checks (run for real with local bash on a temp folder, read-only),
// the sending key's restriction and host-key check, the preview, and the job runner's states. No rsync is run:
// the runner is a fake, and the transfer itself is not exercised here.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { utils } from 'ssh2'
import { setAuditSink } from '../src/lib/audit'
import { FakeBroker } from './fakes/fake-broker'
import { buildTestApp, resetLock, signIn } from './fakes/app'
import { requestContext } from '../src/lib/auth'
import { after } from 'node:test'
import { setClusterStore, loadClusters } from '../src/lib/clusters/registry'
import { MemoryClusterStore } from '../src/lib/clusters/store'
import { fingerprintOf } from '../src/lib/ssh-broker'
import { assertSafeScript } from '../src/lib/clusters/monitoring'
import {
  rootFor, containmentScript, parseContainment, authorizedLine, hostKeyLines, parseStats, parsePoll, launchScript, runScript,
  browse, previewCopy, startCopy, CopyRunner, setJobStore, MemoryJobStore, jobStore, POLL_SCRIPT, type NodeRunner, type JobRow,
} from '../src/lib/clusters/files'

setAuditSink({ write: async () => {} })
const bash = (script: string) => { try { return execFileSync('bash', ['-c', script], { encoding: 'utf8' }) } catch (e: any) { return String(e.stdout ?? '') } }

const broker = new FakeBroker()
broker.addUser('owner@example.com', 'owner master password', 'owner')
const appP = buildTestApp(broker)
let sid = ''
after(async () => { await resetLock(); await (await appP).close() })
const asOwner = <T>(fn: () => Promise<T>) => requestContext.run({ sid, email: 'owner@example.com', role: 'owner' }, fn)

const tmp = mkdtempSync(join(tmpdir(), 'hpx-files-'))
const ROOT = join(tmp, 'media')
before(async () => {
  const app = await appP
  await signIn(app, 'owner@example.com', 'owner master password')
  sid = [...broker.sessions.values()].at(-1)!.sid
  mkdirSync(join(ROOT, 'Movies', 'Film (2017)'), { recursive: true })
  writeFileSync(join(ROOT, 'Movies', 'Film (2017)', 'film.mkv'), 'x')
  mkdirSync(join(tmp, 'outside'))
  symlinkSync(join(tmp, 'outside'), join(ROOT, 'escape'))
  const store = new MemoryClusterStore()
  await store.upsert({ id: 'home', name: 'Home cluster', kind: 'home', address: '', port: 8006, note: '', certFingerprint: null, certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: { node1: '10.0.0.1' }, allowedRoots: [ROOT], monitoring: {}, plexUrl: null, createdBy: 'x' })
  await store.upsert({ id: 'c0123456789', name: 'Remote server', kind: 'remote', address: 'pve1.example', port: 8006, note: '', certFingerprint: 'AA', certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: { pve: '10.0.0.9' }, allowedRoots: ['/srv/media'], monitoring: {}, plexUrl: null, createdBy: 'x' })
  setClusterStore(store); await loadClusters()
})

test('paths: inside an allowed folder, the longest root wins, traversal is refused', () => {
  assert.equal(rootFor('/srv/media/Movies/x', ['/srv/media', '/srv/media/Movies']), '/srv/media/Movies')
  assert.equal(rootFor('/srv/mediax/a', ['/srv/media']), null)
  assert.equal(rootFor('/srv/media/../etc', ['/srv/media']), null)
  assert.equal(rootFor('/etc/passwd', ['/srv/media']), null)
})

test('the node-side check resolves links: a link out of the root is refused', () => {
  assert.match(parseContainment(bash(containmentScript(join(ROOT, 'Movies'), ROOT, true)), 'x', 'Movies'), /Movies$/)
  assert.throws(() => parseContainment(bash(containmentScript(join(ROOT, 'escape'), ROOT, true)), 'x', 'escape'), /outside the allowed folder/)
  assert.throws(() => parseContainment(bash(containmentScript(join(ROOT, 'nope'), ROOT, true)), 'x', 'nope'), /does not exist/)
  assert.throws(() => parseContainment(bash(containmentScript(join(ROOT, "it's"), ROOT, true)), 'x', 'q'), /does not exist/, 'quotes in a path stay quoted')
})

test('the destination key can only run rsync, write-only, without deletes, in one folder', () => {
  const kp = utils.generateKeyPairSync('ed25519', { comment: 'x' })
  const line = authorizedLine('/usr/bin/rrsync', '/srv/media', kp.public, 'home:abc')
  assert.match(line, /^restrict,command="\/usr\/bin\/rrsync -wo -no-del \/srv\/media" ssh-ed25519 \S+ hyperprox-xfer:home:abc$/)
  assert.throws(() => authorizedLine('/usr/bin/rrsync', '/srv/a"b', kp.public, 't'))
})

test('host keys read from the node are matched against the confirmed pin by fingerprint', () => {
  const kp = utils.generateKeyPairSync('ed25519', { comment: 'host' })
  const blob = kp.public.split(' ')[1]
  const lines = hostKeyLines(`${kp.public}\ngarbage line\n`)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].fingerprint, fingerprintOf(Buffer.from(blob, 'base64')))
})

test('rsync stats and progress are read', () => {
  const s = parseStats('Number of files: 1,234 (reg: 1,200, dir: 34)\nNumber of regular files transferred: 1,197\nTotal transferred file size: 53,000,000,000 bytes\n')
  assert.deepEqual(s, { totalFiles: 1234, regular: 1200, transferred: 1197, bytes: 53_000_000_000 })
  const p = parsePoll('HPX-STATUS-BEGIN\nphase copy\nHPX-STATUS-END\nHPX-PROGRESS       1,234,567  45%   10.00MB/s    0:01:23 (xfr#3, to-chk=10/20)\nALIVE\n')
  assert.equal(p.percent, 45); assert.equal(p.rate, '10.00MB/s'); assert.equal(p.alive, true)
  assert.equal(parsePoll('GONE\n').gone, true)
})

test('the run script is valid bash, offers copy only, and never names the cluster files', () => {
  execFileSync('bash', ['-n', '-c', runScript()])
  assert.doesNotThrow(() => assertSafeScript(runScript()))
  assert.match(runScript(), /--ignore-existing/)
  assert.match(runScript(), /--safe-links/)
  assert.doesNotMatch(runScript(), /--delete|--remove-source-files/)
})

test('launch: the key travels on stdin inside the script, never as an argument', async () => {
  const kp = utils.generateKeyPairSync('ed25519', { comment: 'k' })
  const job = { id: '00000000-0000-0000-0000-000000000001', mode: 'copy', srcPath: '/srv/a/b', dstPath: '/srv/media/Movies', speedKBps: 20480 } as JobRow
  const s = await launchScript(job, { private: kp.private, public: kp.public, knownHosts: '10.0.0.9 ssh-ed25519 AAAA', dstAddress: '10.0.0.9' }, 'Movies')
  assert.match(s, /cat > "\$D\/key" <<'HPXKEY'\n-----BEGIN OPENSSH PRIVATE KEY-----/)
  assert.match(s, /umask 077/)
  assert.match(s, /BWLIMIT=20480/)
  assert.match(s, /setsid bash "\$D\/run.sh"/)
  assert.doesNotThrow(() => assertSafeScript(s))
})

/** Runs the read-only checks for real with local bash; answers the rsync dry run with canned stats. */
function fakeRunner(log: string[]): NodeRunner {
  return {
    async run(cluster, node, script) {
      log.push(`${cluster}/${node}: ${script.split('\n').find(l => /rsync|realpath|find|POLL|setsid|kill/.test(l)) ?? script.slice(0, 40)}`)
      if (script.includes('rsync -a --dry-run --stats')) return { code: 0, output: 'Number of files: 3 (reg: 2, dir: 1)\nNumber of regular files transferred: 1\nTotal transferred file size: 2,048 bytes\n' }
      if (script.includes('setsid bash')) return { code: 0, output: 'STARTED\n' }
      if (script.includes('HPX-STATUS-BEGIN')) return { code: 0, output: 'HPX-STATUS-BEGIN\nphase verify\ncopied 1\nverified 1\nend done\nHPX-STATUS-END\nHPX-PROGRESS \nDEAD\n' }
      if (script.includes('CLEANED')) return { code: 0, output: 'CLEANED\n' }
      // Containment checks: remote paths do not exist here, so answer as the node would for a good path.
      if (cluster !== 'home') return { code: 0, output: 'OK /srv/media/Movies\n' }
      return { code: 0, output: bash(script) }
    },
    async sshAddress(_c, n) { return n === 'pve' ? '10.0.0.9' : '10.0.0.1' },
    linkAddress(c, n) { return c === 'home' ? (n === 'node1' ? '10.0.0.1' : null) : '10.0.0.9' },
  }
}

test('browse lists a folder inside the root, and refuses a link out of it', async () => {
  const r = await browse('home', 'node1', join(ROOT, 'Movies'), fakeRunner([]))
  assert.deepEqual(r.entries.map(e => e.name), ['Film (2017)'])
  await assert.rejects(browse('home', 'node1', join(ROOT, 'escape'), fakeRunner([])), /outside/)
  await assert.rejects(browse('home', 'node1', '/etc', fakeRunner([])), /system folder|not inside an allowed folder/)
  await assert.rejects(browse('home', 'node1', '/srv/media', fakeRunner([])), /not inside an allowed folder/)
})

test('a copy needs sending set up first, then previews in words and runs to a verified end', () => asOwner(async () => {
  setJobStore(new MemoryJobStore())
  const log: string[] = []
  const input = { src: { cluster: 'home', node: 'node1', path: join(ROOT, 'Movies', 'Film (2017)') }, dst: { cluster: 'c0123456789', node: 'pve', path: '/srv/media/Movies' }, speedKBps: 1024, plexScan: false }
  await assert.rejects(previewCopy('owner@example.com', input, fakeRunner(log)), /not set up to send/)

  // Same node, same cluster: no key needed. Destination inside the source is refused.
  const local = { ...input, dst: { cluster: 'home', node: 'node1', path: join(ROOT, 'Movies', 'Film (2017)', 'x') } }
  await assert.rejects(previewCopy('owner@example.com', local, fakeRunner(log)), /inside what is being copied/)
  const ok = { ...input, dst: { cluster: 'home', node: 'node1', path: ROOT } }
  const prev = await previewCopy('owner@example.com', ok, fakeRunner(log))
  assert.equal(prev.files, 1); assert.equal(prev.skipped, 1)
  assert.match(prev.words, /1 file\(s\), 2.0 KB, from Home cluster to Home cluster, under a minute at the speed limit\. 1 file\(s\) already exist there and will be skipped; nothing there is replaced or deleted\./)

  await assert.rejects(startCopy(prev.previewId, 'someone-else@example.com'), /No such preview/)
  const job = await startCopy(prev.previewId, 'owner@example.com')
  assert.equal(job.state, 'queued')
  const runner = new CopyRunner(fakeRunner(log), async () => null)
  await runner.launch((await jobStore().get(job.id))!)
  assert.equal((await jobStore().get(job.id))!.state, 'running')
  await runner.follow((await jobStore().get(job.id))!)
  const done = (await jobStore().get(job.id))!
  assert.equal(done.state, 'done')
  assert.equal(done.progress.verified, 1)
  assert.ok(log.some(l => l.includes('CLEANED') || l.includes('kill')), 'the working folder is cleaned up')
  void POLL_SCRIPT
}))
