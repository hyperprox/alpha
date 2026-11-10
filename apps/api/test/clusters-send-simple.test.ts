// Send files, the simple way: discovery from fixtures (mount table, pct config, Plex's library XML), first-time
// setup in one re-confirmed step (and refused without it, and for an API token), the Plex token never leaving
// the node (the real bash run against a fake `pct`), the preview's maths, skip-existing and multi-select.
// No real node is contacted: the runner is a fake that answers discovery from fixtures and runs the read-only
// checks with local bash on a temp folder.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { utils } from 'ssh2'
import Fastify, { type FastifyInstance } from 'fastify'
import { setAuditSink } from '../src/lib/audit'
import { FakeBroker } from './fakes/fake-broker'
import { signIn, resetLock } from './fakes/app'
import { setBroker } from '../src/lib/vault/broker'
import { setCredentialTable, setCredential } from '../src/lib/credentials'
import { registerGate } from '../src/lib/gate'
import { authRoutes } from '../src/routes/auth'
import { clusterRoutes } from '../src/routes/clusters'
import { requestContext } from '../src/lib/auth'
import { setClusterStore, loadClusters, clusterRow } from '../src/lib/clusters/registry'
import { MemoryClusterStore } from '../src/lib/clusters/store'
import { needsReconfirm, requiredRole } from '../src/lib/roles'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken, tokenForbidden } from '../src/lib/api-tokens'
import { familyOf } from '../src/lib/notify/types'
import { pairProvider, pairField, sendKey, setJobStore, MemoryJobStore, jobStore, CopyRunner, plainJobError, type NodeRunner, type JobRow } from '../src/lib/clusters/files'
import {
  parseFacts, parsePlexSections, librariesOf, linkAddresses, friendlyName, factsScript, plexScanScript, scanLibraryAfterCopy, discoverSend, setupSend,
  browseSend, searchSend, previewSend, sendNow, previewWords, sizeWords, linkSpeed, DEFAULT_SPEED, setSendDeps, forgetSendPlans, type SendDeps,
} from '../src/lib/clusters/send-simple'

const FIX = join(__dirname, 'fixtures', 'send-simple')
const fx = (f: string) => readFileSync(join(FIX, f), 'utf8')
const TOKEN = 'FAKEplexTOKEN123abcXYZ'
const GB = 1024 ** 3, TB = 1024 ** 4
const RID = 'c0123456789'
const bash = (script: string, env: Record<string, string> = {}) => { try { return execFileSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } }) } catch (e: any) { return String(e.stdout ?? '') } }

const audits: any[] = []
setAuditSink({ write: async r => { audits.push(r) } })

// Not under /tmp: a system folder no copy root may be in. node_modules is ignored by git.
mkdirSync(join(process.cwd(), 'node_modules', '.cache'), { recursive: true })
const tmp = mkdtempSync(join(process.cwd(), 'node_modules', '.cache', 'hpx-send-'))
const HOME_MEDIA = join(tmp, 'media')          // the shared filesystem every home node mounts
const NAS = join(tmp, 'nas-rw')                 // the remote node's NAS mounts, one per library

function remoteFacts(): string {
  const lines = ['HPX-FACTS 1']
  for (const l of fx('remote-mounts.txt').replaceAll('@NAS@', NAS).trim().split('\n')) { const [s, t, f, o] = l.split(' '); lines.push(`MNT\t${s}\t${t}\t${f}\t${o.split(',')[0]}`) }
  lines.push(`DF\t/\t${10 * GB}\t${30 * GB}`, `DF\t${NAS}/movies\t${2 * TB}\t${4 * TB}`, `DF\t${NAS}/tv\t${50 * GB}\t${4 * TB}`, `DF\t${NAS}/music\t${1 * GB}\t${4 * TB}`)
  lines.push('LINK\tlo\t127.0.0.1', 'LINK\tvmbr0\t10.0.0.9', 'LINK\ttailscale0\t100.100.1.9')
  for (const l of fx('remote-pct-config.txt').replaceAll('@NAS@', NAS).split('\n').filter(l => /^mp\d+:/.test(l))) lines.push(`CTMP\t101\t${l}`)
  lines.push('PLEX\t101', `PLEXXML\t101\t${fx('plex-sections.xml').replace(/[\n\t]/g, ' ')}`)
  return lines.join('\n')
}
function homeFacts(node: string, script: string): string {
  const lines = ['HPX-FACTS 1', `MNT\t10.0.0.1:6789:/\t${HOME_MEDIA}\tceph\trw`, 'MNT\t/dev/sda1\t/\text4\trw']
  if (node === 'node1') {
    lines.push('LINK\ttailscale0\t100.100.1.1')
    if (script.includes("'100.100.1.9'")) lines.push('REACH\t100.100.1.9')   // only when asked to test that address
  }
  if (node === 'node2') {
    lines.push(`CTMP\t201\tmp0: ${HOME_MEDIA},mp=/media`, 'PLEX\t201',
      'PLEXXML\t201\t<MediaContainer><Directory key="1" type="movie" title="Movies"><Location id="1" path="/media/Movies"/></Directory><Directory key="2" type="show" title="TV Shows"><Location id="2" path="/media/TV Shows"/></Directory></MediaContainer>')
  }
  return lines.join('\n')
}

const runLog: string[] = []
const fakeRunner: NodeRunner = {
  async run(cluster, node, script) {
    runLog.push(`${cluster}/${node}`)
    if (cluster === 'home' && node === 'node3') throw new Error('No node login is saved for node3.')
    if (script.includes('HPX-FACTS')) return { code: 0, output: cluster === 'home' ? homeFacts(node, script) : remoteFacts() }
    if (script.includes('rsync -a --dry-run --stats')) return { code: 0, output: 'Number of files: 3 (reg: 2, dir: 1)\nNumber of regular files transferred: 1\nTotal transferred file size: 2,048 bytes\n' }
    if (script.includes('PLEX-HTTP')) return { code: 0, output: `noise ${TOKEN}\nPLEX-HTTP 200\n` }
    return { code: 0, output: bash(script) }
  },
  async sshAddress(_c, n) { return n === 'pve' ? '10.0.0.9' : '10.0.0.1' },
  linkAddress() { return null },
}

const PIN = 'SHA256:' + 'A'.repeat(43)
let pinConfirmed = false
const confirmed: string[] = []
const deps: SendDeps = {
  runner: fakeRunner,
  async nodes(c) { return c === 'home' ? ['node1', 'node2', 'node3'] : ['pve'] },
  async hostKey() { return { address: '10.0.0.9', pinned: PIN, confirmed: pinConfirmed } },
  async confirmHostKey(_c, node, fp) { if (fp !== PIN) throw new Error('not presented'); confirmed.push(node); pinConfirmed = true },
  // As files.ts setupSending ends: a key in the vault for that one folder, with the address it was given.
  async setupKey(o) {
    const kp = utils.generateKeyPairSync('ed25519', { comment: 'k' })
    await setCredential('xfer-key', pairProvider(o.src, o.dst), pairField(o.dstNode, o.root), JSON.stringify({ private: kp.private, public: kp.public, knownHosts: `${o.dstAddress} ssh-ed25519 AAAA`, dstAddress: o.dstAddress }), true)
  },
  keyFor: sendKey,
}

const broker = new FakeBroker()
broker.addUser('owner@example.com', 'owner master password', 'owner')
let app: FastifyInstance
let cookie = '', sid = ''
const tokens = new MemoryApiTokenStore()
const asOwner = <T>(fn: () => Promise<T>) => requestContext.run({ sid, email: 'owner@example.com', role: 'owner' }, fn)

before(async () => {
  for (const d of ['Movies/Film A (2001)', 'Movies/Film B (2002)', 'Movies/Film C (2003)', 'TV Shows/Show']) mkdirSync(join(HOME_MEDIA, d), { recursive: true })
  writeFileSync(join(HOME_MEDIA, 'Movies/Film A (2001)/a.mkv'), 'a'.repeat(1000))
  writeFileSync(join(HOME_MEDIA, 'Movies/Film B (2002)/b.mkv'), 'b'.repeat(2000))
  writeFileSync(join(HOME_MEDIA, 'Movies/Film B (2002)/b.srt'), 'b'.repeat(30))
  writeFileSync(join(HOME_MEDIA, 'Movies/Film C (2003)/c.mkv'), 'c'.repeat(4000))
  writeFileSync(join(HOME_MEDIA, 'Movies/single.mkv'), 's'.repeat(500))
  // Already on the other server: all of Film A, and Film B's subtitles.
  for (const d of ['movies/Film A (2001)', 'movies/Film B (2002)', 'tv', 'music']) mkdirSync(join(NAS, d), { recursive: true })
  writeFileSync(join(NAS, 'movies/Film A (2001)/a.mkv'), 'a'.repeat(1000))
  writeFileSync(join(NAS, 'movies/Film B (2002)/b.srt'), 'b'.repeat(30))

  setBroker(broker)
  setCredentialTable({ credential: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) } })
  process.env.ENV_FILE_PATH = '/nonexistent/hyperprox-test.env'
  const store = new MemoryClusterStore()
  await store.upsert({ id: 'home', name: 'Home cluster', kind: 'home', address: '', port: 8006, note: '', certFingerprint: null, certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: {}, allowedRoots: [], monitoring: {}, plexUrl: null, createdBy: 'x' })
  await store.upsert({ id: RID, name: 'Remote server', kind: 'remote', address: 'pve1.example', port: 8006, note: '', certFingerprint: 'AA', certConfirmedAt: null, certConfirmedBy: null, nodeAddresses: { pve: '10.0.0.9' }, allowedRoots: [], monitoring: {}, plexUrl: null, createdBy: 'x' })
  setClusterStore(store); await loadClusters()
  setSendDeps(deps)
  setJobStore(new MemoryJobStore())
  setApiTokenStore(tokens)

  app = Fastify({ logger: false })
  await registerGate(app)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(clusterRoutes, { prefix: '/api/clusters' })
  await app.ready()
  cookie = (await signIn(app, 'owner@example.com', 'owner master password')).cookie
  sid = [...broker.sessions.values()].at(-1)!.sid
})
after(async () => { setSendDeps(null); setApiTokenStore(null); await resetLock(); await app?.close(); rmSync(tmp, { recursive: true, force: true }) })

const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = { cookie }) => app.inject({ method: method as any, url, headers, payload: payload as any })

// ---------------------------------------------------------------------------

test('Plex library XML: key, title (entities decoded), type and folders', () => {
  const s = parsePlexSections('101', fx('plex-sections.xml'))
  assert.deepEqual(s.map(x => [x.key, x.title, x.type, x.locations]), [
    ['1', 'Movies', 'movie', ['/media/movies']], ['2', 'TV Shows', 'show', ['/media/tv']], ['3', 'Music & Concerts', 'artist', ['/media/music']],
    ['4', 'Old Films', 'movie', ['/media/old']], ['5', 'Phone Photos', 'photo', ['/data/photos']],
  ])
})

test('destination discovery: writable NAS mounts used by Plex, named by their Plex library; read-only and system-disk folders left out', () => {
  const f = parseFacts('pve', remoteFacts())
  const libs = librariesOf(f, true)
  assert.deepEqual(libs.map(l => [l.name, l.path, l.sectionKey, l.containerPath]), [
    ['Movies', `${NAS}/movies`, '1', '/media/movies'], ['TV Shows', `${NAS}/tv`, '2', '/media/tv'], ['Music & Concerts', `${NAS}/music`, '3', '/media/music'],
  ])
  assert.equal(libs[0].free, 2 * TB)
  assert.deepEqual(linkAddresses(f), ['100.100.1.9'], 'the tailnet address, not the LAN or loopback one')

  // Plex there but not signed in: the same folders, named by their own names.
  const noPlex = parseFacts('pve', remoteFacts().split('\n').filter(l => !l.startsWith('PLEXXML')).join('\n') + '\nPLEXWHY\t101\tno-token')
  assert.deepEqual(librariesOf(noPlex, true).map(l => [l.name, l.from]), [['Movies', 'folder'], ['TV Shows', 'folder'], ['Music', 'folder']])
  assert.equal(friendlyName('/x/kids_films'), 'Kids Films')
})

test('the facts script, run for real against a fake pct: libraries come back, the Plex token never does', () => {
  const bin = join(tmp, 'bin'); mkdirSync(bin, { recursive: true })
  writeFileSync(join(tmp, 'prefs.xml'), fx('Preferences.xml'))
  writeFileSync(join(tmp, 'sections.xml'), fx('plex-sections.xml'))
  writeFileSync(join(tmp, 'pct-config.txt'), fx('remote-pct-config.txt').replaceAll('@NAS@', NAS))
  writeFileSync(join(bin, 'pct'), [
    '#!/bin/bash',
    'printf "ARGV:" >> "$HPX_LOG"; printf " [%s]" "$@" >> "$HPX_LOG"; echo >> "$HPX_LOG"',
    'case "$1" in',
    '  list) printf "VMID       Status     Lock         Name\\n101        running                 plex\\n102        running                 web\\n103        stopped                 old\\n" ;;',
    '  config) [ "$2" = 101 ] && cat "$HPX_DIR/pct-config.txt"; [ "$2" = 102 ] && printf "mp0: /srv/www,mp=/var/www\\n"; exit 0 ;;',
    '  exec) id="$2"; shift 3',
    '    if [ "$1" = sh ]; then [ "$id" = 101 ] && { cat "$HPX_DIR/prefs.xml"; exit 0; }; exit 1; fi',
    '    if [ "$1" = curl ]; then cat > "$HPX_LOG.stdin.$id"; for a in "$@"; do last="$a"; done',
    '      case "$last" in *refresh*) printf 200 ;; *) cat "$HPX_DIR/sections.xml"; printf "<!-- %s -->" "$(sed -n "s/^X-Plex-Token: //p" "$HPX_LOG.stdin.$id")" ;; esac; exit 0; fi ;;',
    'esac',
  ].join('\n'))
  chmodSync(join(bin, 'pct'), 0o755)
  const env = { PATH: `${bin}:${process.env.PATH}`, HPX_LOG: join(tmp, 'pct.log'), HPX_DIR: tmp }

  const out = bash(factsScript(), env)
  assert.ok(!out.includes(TOKEN), 'the token is cut out of everything printed')
  const f = parseFacts('pve', out)
  assert.deepEqual(f.plexCts, ['101'], 'only the container with Plex in it')
  assert.deepEqual(f.plexSections.map(s => s.title), ['Movies', 'TV Shows', 'Music & Concerts', 'Old Films', 'Phone Photos'])
  assert.ok(f.ctMounts.some(c => c.ct === '101' && c.source === `${NAS}/movies` && c.target === '/media/movies'))
  const argv = readFileSync(join(tmp, 'pct.log'), 'utf8')
  assert.ok(!argv.includes(TOKEN), 'the token is never an argument of any command')
  assert.match(readFileSync(join(tmp, 'pct.log.stdin.101'), 'utf8'), new RegExp(`^X-Plex-Token: ${TOKEN}$`, 'm'), 'it reaches curl on stdin')
  assert.ok(!/\[exec\] \[103\]/.test(argv), 'stopped containers are not entered')

  // The scan after a copy: one library, one folder, only the HTTP code comes back.
  const scan = plexScanScript('101', '1', '/media/movies/Film C (2003)')
  assert.ok(!scan.includes(TOKEN))
  assert.match(scan, /-H @-/)
  assert.match(scan, /library\/sections\/1\/refresh\?path=%2Fmedia%2Fmovies%2FFilm%20C%20\(2003\)/)
  const r = bash(scan, env)
  assert.equal(r.trim(), 'PLEX-HTTP 200')
  assert.ok(!readFileSync(join(tmp, 'pct.log'), 'utf8').includes(TOKEN))
  assert.throws(() => plexScanScript('101; rm', '1', null))
})

test('discovery of both ends: the home library, the sender that reaches the other node, and what setup would do', () => asOwner(async () => {
  forgetSendPlans()
  const plan = await discoverSend(RID, deps, { fresh: true })
  assert.deepEqual(plan.sources.map(s => [s.name, s.path]), [['Movies', `${HOME_MEDIA}/Movies`], ['TV Shows', `${HOME_MEDIA}/TV Shows`]])
  assert.equal(plan.sourceNode, 'node1', 'the home node that reaches it over the tailnet')
  assert.deepEqual(plan.links, { pve: '100.100.1.9' })
  assert.deepEqual(plan.libraries.map(l => l.name), ['Movies', 'TV Shows', 'Music & Concerts'])
  assert.equal(plan.ready, false)
  assert.deepEqual(plan.hostKeys, [{ node: 'pve', fingerprint: PIN }])
  assert.equal(plan.steps.length, 5)
  assert.ok(runLog.includes('home/node3'), 'a home node without a login is skipped, not fatal')
}))

test('setup is refused without the master password, and for an API token, and changes nothing', async () => {
  assert.equal(needsReconfirm('POST', `/api/clusters/${RID}/send/setup`), true)
  assert.equal(requiredRole('POST', `/api/clusters/${RID}/send/setup`), 'admin')
  assert.equal(needsReconfirm('POST', `/api/clusters/${RID}/send/preview`), false, 'looking is not re-confirmed')
  assert.equal(tokenForbidden('POST', '/api/auth/reconfirm'), true, 'a token can never re-confirm')

  const r = await call('POST', `/api/clusters/${RID}/send/setup`, { confirmHostKeys: [PIN] })
  assert.equal(r.statusCode, 403)
  assert.equal(r.json().code, 'reconfirm_required')

  const { token } = await createApiToken({ name: 'auto', role: 'admin' }, 'test', tokens)
  const t = await call('POST', `/api/clusters/${RID}/send/setup`, { confirmHostKeys: [PIN] }, { authorization: `Bearer ${token}` })
  assert.equal(t.statusCode, 403)
  assert.ok(['reconfirm_required', 'token_forbidden'].includes(t.json().code))
  assert.deepEqual(clusterRow('home')!.allowedRoots, [])
  assert.deepEqual(clusterRow(RID)!.allowedRoots, [])
})

test('first-time setup in one re-confirmed step: a needed host key must be confirmed in that same step', async () => {
  await call('POST', '/api/auth/reconfirm', { password: 'owner master password' })
  // The identity key is not confirmed yet and was not included: refused before anything changes.
  const no = await call('POST', `/api/clusters/${RID}/send/setup`, { confirmHostKeys: [] })
  assert.equal(no.statusCode, 409, no.body)
  assert.match(no.json().error, new RegExp(`pve's identity key \\(${PIN.replace(/[+/]/g, '\\$&')}\\).*Nothing was changed`))
  assert.deepEqual(clusterRow(RID)!.allowedRoots, [])

  audits.length = 0
  const ok = await call('POST', `/api/clusters/${RID}/send/setup`, { confirmHostKeys: [PIN] })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.match(ok.json().data.words, /^Ready\. Your home library can now be sent to Remote server's Movies, TV Shows, Music & Concerts\.$/)
  assert.equal(ok.json().data.plan.ready, true)
  assert.deepEqual(confirmed, ['pve'])
  assert.deepEqual(clusterRow('home')!.allowedRoots, [`${HOME_MEDIA}/Movies`, `${HOME_MEDIA}/TV Shows`])
  assert.deepEqual(clusterRow(RID)!.allowedRoots, [`${NAS}/movies`, `${NAS}/tv`, `${NAS}/music`])
  const key = await asOwner(() => sendKey('home', RID, 'pve', `${NAS}/movies`))
  assert.equal(key?.dstAddress, '100.100.1.9', 'the key goes to the private-link address the sender reaches')
  const a = audits.find(x => x.action === 'cluster.files.setup')
  assert.ok(a && a.details.by === 'owner@example.com' && a.details.keysMade === 3)
  assert.ok(!JSON.stringify(audits).includes('PRIVATE KEY'), 'no key in the audit log')
  assert.ok(!ok.body.includes('PRIVATE KEY') && !ok.body.includes(TOKEN), 'nor in the answer')

  // Run again: nothing left to do, no new keys.
  const again = await call('POST', `/api/clusters/${RID}/send/setup`, { confirmHostKeys: [] })
  assert.equal(again.statusCode, 200, again.body)
  assert.equal(audits.filter(x => x.action === 'cluster.files.setup').at(-1).details.keysMade, 0)
})

test('browse and search the home library: inside it only, folder sizes shown', async () => {
  const b = await call('GET', `/api/clusters/${RID}/send/browse?path=${encodeURIComponent(`${HOME_MEDIA}/Movies`)}`)
  assert.equal(b.statusCode, 200, b.body)
  const e = b.json().data.entries
  assert.deepEqual(e.map((x: any) => [x.name, x.dir]), [['Film A (2001)', true], ['Film B (2002)', true], ['Film C (2003)', true], ['single.mkv', false]])
  assert.equal(e[3].size, 500)
  assert.ok(e[1].size >= 2030, 'a folder shows its size')
  assert.equal(b.json().data.up, null, 'the library itself is the top')
  assert.equal((await call('GET', `/api/clusters/${RID}/send/browse?path=${encodeURIComponent('/srv/elsewhere')}`)).statusCode, 422)

  const s = await asOwner(() => searchSend(RID, 'film b', deps))
  assert.deepEqual(s.map(x => x.name), ['Film B (2002)'])
  await assert.rejects(searchSend(RID, 'a*', deps), /plain words/)
  await assert.rejects(searchSend(RID, 'x', deps), /2 to 60/)
})

test('preview maths: sizes, time at the link speed, and the words', () => {
  assert.equal(sizeWords(14.2 * GB), '14.2 GB')
  assert.equal(sizeWords(950 * 1024 * 1024), '950 MB')
  const bytes = Math.round(14.2 * GB), seconds = Math.round(bytes / (7.7 * 1024 * 1024))
  assert.equal(previewWords({ items: 4, bytes, seconds, already: 1, skippedFiles: 0 }), '3 items, 14.2 GB, about 31 min; 1 already there and will be skipped')
  assert.equal(previewWords({ items: 1, bytes: 10, seconds: 0, already: 0, skippedFiles: 0 }), '1 item, 10 B, under a minute')
  assert.equal(previewWords({ items: 2, bytes: 0, seconds: 0, already: 2, skippedFiles: 0 }), 'All 2 are already there. Nothing to send.')
  assert.equal(previewWords({ items: 1, bytes: 5 * GB, seconds: 5400, already: 0, skippedFiles: 2 }), '1 item, 5 GB, about 1 h 30 min; 2 files are already there and will be skipped')

  assert.deepEqual(linkSpeed(RID, []), { speed: DEFAULT_SPEED, measured: false })
  const job = (mb: number, secs: number, i: number) => ({ dstCluster: RID, state: 'done', preview: { bytes: mb * 1024 * 1024 }, startedAt: new Date(i * 1e6), finishedAt: new Date(i * 1e6 + secs * 1000) }) as unknown as JobRow
  assert.equal(Math.round(linkSpeed(RID, [job(800, 100, 1), job(700, 100, 2), job(900, 100, 3)]).speed / 1024 / 1024), 8, 'the median of the recent copies')
  assert.equal(linkSpeed(RID, [job(10, 1, 1)]).measured, false, 'a tiny copy says nothing about the link')
})

test('multi-select preview: whole items already there are skipped, files already there are skipped, room is checked', () => asOwner(async () => {
  const plan = await discoverSend(RID, deps)
  const movies = plan.libraries.find(l => l.name === 'Movies')!
  const picks = ['Film A (2001)', 'Film B (2002)', 'Film C (2003)', 'single.mkv'].map(n => `${HOME_MEDIA}/Movies/${n}`)
  const p = await previewSend('owner@example.com', RID, picks, movies.id, deps)
  assert.deepEqual(p.items.map(i => [i.name, i.files, i.bytes, i.skippedFiles, i.already]), [
    ['Film A (2001)', 0, 0, 1, true], ['Film B (2002)', 1, 2000, 1, false], ['Film C (2003)', 1, 4000, 0, false], ['single.mkv', 1, 500, 0, false],
  ])
  assert.equal(p.bytes, 6500)
  assert.equal(p.words, '3 items, 6.3 KB, under a minute; 1 already there and will be skipped')
  assert.equal(p.ready, true)

  const music = plan.libraries.find(l => l.name === 'Music & Concerts')!
  await assert.rejects(previewSend('o', RID, [`${HOME_MEDIA}/Movies`], movies.id, deps), /not the whole library/)
  await assert.rejects(previewSend('o', RID, [`${HOME_MEDIA}/Movies/Film B (2002)`, `${HOME_MEDIA}/Movies/Film B (2002)/b.mkv`], movies.id, deps), /already picked/)
  await assert.rejects(previewSend('o', RID, Array.from({ length: 21 }, (_, i) => `${HOME_MEDIA}/Movies/x${i}`), movies.id, deps), /at most 20/)
  await assert.rejects(previewSend('o', RID, ['/etc/passwd'], movies.id, deps), /system folder/)
  await assert.rejects(previewSend('o', RID, [`${HOME_MEDIA}/Movies/nope`], music.id, deps), /does not exist/)
  await assert.rejects(previewSend('o', RID, picks, 'nope', deps), /no longer there/)

  // Send: one job per item that has something to copy, through the reviewed engine; only the owner's preview.
  await assert.rejects(sendNow('someone-else@example.com', p.previewId, deps), /No such preview/)
  const jobs = await sendNow('owner@example.com', p.previewId, deps)
  assert.deepEqual(jobs.map(j => j.srcPath.split('/').pop()), ['Film B (2002)', 'Film C (2003)', 'single.mkv'])
  assert.ok(jobs.every(j => j.dstPath === `${NAS}/movies` && j.srcNode === 'node1' && j.plexScan && j.mode === 'copy'))
  assert.equal(jobs[0].preview.library.name, 'Movies')
  assert.ok(!JSON.stringify(jobs).includes('PRIVATE KEY'))
  await assert.rejects(sendNow('owner@example.com', p.previewId, deps), /No such preview/, 'a preview is used once')
}))

test('after a verified copy: that library is scanned, "Added to Movies" is shown, and the right notification goes out', () => asOwner(async () => {
  setJobStore(new MemoryJobStore())
  const sent: any[] = []
  const library = { id: 'x', name: 'Movies', node: 'pve', ct: '101', sectionKey: '1', containerPath: '/media/movies' }
  const base = { mode: 'copy', srcCluster: 'home', srcNode: 'node1', srcPath: `${HOME_MEDIA}/Movies/Film C (2003)`, dstCluster: RID, dstNode: 'pve', dstPath: `${NAS}/movies`, speedKBps: 0, plexScan: true, progress: {}, error: null, attempts: 1, createdBy: 'owner@example.com', startedAt: new Date(), finishedAt: null }
  const ok = await jobStore().create({ ...base, id: '00000000-0000-0000-0000-0000000000a1', state: 'running', preview: { files: 1, bytes: 4000, simple: true, item: 'Film C (2003)', library } } as any)

  const poll = (end: string) => ({ ...fakeRunner, async run(c: string, n: string, s: string) { if (s.includes('HPX-STATUS-BEGIN')) return { code: 0, output: `HPX-STATUS-BEGIN\nphase verify\ncopied 1\n${end}\nHPX-STATUS-END\nHPX-PROGRESS \nDEAD\n` }; return fakeRunner.run(c, n, s) } }) as NodeRunner
  const scanned: string[] = []
  const runner = new CopyRunner(poll('verified 1\nend done'), async (_c, j) => { const r = await scanLibraryAfterCopy(j, fakeRunner); scanned.push(r); return r }, () => {}, async e => { sent.push(e) })
  await runner.follow(ok)
  const done = (await jobStore().get(ok.id))!
  assert.equal(done.state, 'done')
  assert.equal(done.progress.plex, 'Added to Movies.')
  assert.ok(!JSON.stringify(done).includes(TOKEN), 'the scan answer never carries the token')
  assert.equal(sent[0].type, 'files.copy.finished')
  assert.match(sent[0].title, /Film C \(2003\) to Remote server/)
  assert.ok(!JSON.stringify(sent).includes(NAS), 'no paths in a notification')
  assert.equal(familyOf('files.copy.finished'), 'jobs', 'channels that take job events get it')

  const bad = await jobStore().create({ ...base, id: '00000000-0000-0000-0000-0000000000a2', state: 'running', preview: { files: 1, bytes: 4000, library } } as any)
  await new CopyRunner(poll('error copying stopped with rsync code 12\nend failed'), async () => null, () => {}, async e => { sent.push(e) }).follow(bad)
  const failed = (await jobStore().get(bad.id))!
  assert.equal(failed.state, 'failed')
  assert.match(failed.error ?? '', /connection to the other server dropped.*Resume/)
  assert.equal(sent.at(-1).type, 'files.copy.failed')
  assert.equal(plainJobError('something odd'), 'something odd', 'unknown words are kept')
}))
