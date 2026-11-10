// Send files, the simple way: discovery from fixtures (mount table, pct config, Plex's library XML, Proxmox
// storage), symlinked roots refused on both ends, first-time setup in one re-confirmed step bound to what the
// preview showed (and refused without the password, for an API token, on a changed plan, and before anything
// changes), the Plex token never leaving the node (the real bash run against a fake `pct`), the preview's maths,
// skip-existing, multi-select, partial starts, and what notifications may say.
// No real node is contacted: the runner is a fake that answers discovery from fixtures and runs the read-only
// checks with local bash on a temp folder.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
import { setClusterStore, loadClusters, clusterRow, updateCluster } from '../src/lib/clusters/registry'
import { MemoryClusterStore } from '../src/lib/clusters/store'
import { needsReconfirm, requiredRole } from '../src/lib/roles'
import { MemoryApiTokenStore, setApiTokenStore, createApiToken, tokenForbidden } from '../src/lib/api-tokens'
import { familyOf } from '../src/lib/notify/types'
import {
  pairProvider, pairField, sendKey, setJobStore, MemoryJobStore, jobStore, CopyRunner, plainJobError, copyEvent, noAddresses, containmentScript, parseContainment, runScript,
  type NodeRunner, type JobRow,
} from '../src/lib/clusters/files'
import {
  parseFacts, parsePlexSections, librariesOf, linkAddresses, friendlyName, factsScript, plexScanScript, scanLibraryAfterCopy, discoverSend, planReadiness,
  browseSend, searchSend, previewSend, sendNow, excludedContainers, previewWords, sizeWords, linkSpeed, DEFAULT_SPEED, setSendDeps, forgetSendPlans, storagePaths, type SendDeps,
} from '../src/lib/clusters/send-simple'

const FIX = join(__dirname, 'fixtures', 'send-simple')
const fx = (f: string) => readFileSync(join(FIX, f), 'utf8')
const TOKEN = 'FAKEplexTOKEN123abcXYZ'
const GB = 1024 ** 3, TB = 1024 ** 4
const RID = 'c0123456789'
const OWNER = 'owner@example.com'
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
  lines.push('LINK\tlo\t127.0.0.1', 'LINK\tvmbr0\t10.0.0.9', 'LINK\ttailscale0\t100.100.1.9', 'LINK\ttailscale0\tfe80::1')
  lines.push('STORAGES\t[{"storage":"local","type":"dir","path":"/var/lib/vz"},{"storage":"nas","type":"nfs"}]')
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
      'PLEXXML\t201\t<MediaContainer><Directory key="1" type="movie" title="Movies"><Location id="1" path="/media/Movies"/></Directory><Directory key="2" type="show" title="TV Shows"><Location id="2" path="/media/TV Shows"/></Directory><Directory key="3" type="movie" title="Evil"><Location id="3" path="/media/Evil"/></Directory></MediaContainer>')
  }
  return lines.join('\n')
}

const runLog: string[] = []
let failDryRunFor: string | null = null
const fakeRunner: NodeRunner = {
  async run(cluster, node, script) {
    runLog.push(`${cluster}/${node}${script.includes('HPX-FACTS') ? ' facts' : ''}`)
    if (cluster === 'home' && node === 'node3') throw new Error('No node login is saved for node3.')
    if (script.includes('HPX-FACTS')) return { code: 0, output: cluster === 'home' ? homeFacts(node, script) : remoteFacts() }
    if (script.includes('rsync -a --dry-run --stats')) {
      if (failDryRunFor && script.includes(failDryRunFor)) return { code: 0, output: 'rsync: connection refused\n' }
      return { code: 0, output: 'Number of files: 3 (reg: 2, dir: 1)\nNumber of regular files transferred: 1\nTotal transferred file size: 2,048 bytes\n' }
    }
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
  async excludedCts() { return [] },
}

const broker = new FakeBroker()
broker.addUser(OWNER, 'owner master password', 'owner')
let app: FastifyInstance
let cookie = '', sid = ''
const tokens = new MemoryApiTokenStore()
const asOwner = <T>(fn: () => Promise<T>) => requestContext.run({ sid, email: OWNER, role: 'owner' }, fn)

before(async () => {
  for (const d of ['Movies/Film A (2001)', 'Movies/Film B (2002)', 'Movies/Film C (2003)', 'Movies/Film D (2004)', 'TV Shows/Show']) mkdirSync(join(HOME_MEDIA, d), { recursive: true })
  writeFileSync(join(HOME_MEDIA, 'Movies/Film A (2001)/a.mkv'), 'a'.repeat(1000))
  writeFileSync(join(HOME_MEDIA, 'Movies/Film B (2002)/b.mkv'), 'b'.repeat(2000))
  writeFileSync(join(HOME_MEDIA, 'Movies/Film B (2002)/b.srt'), 'b'.repeat(30))
  writeFileSync(join(HOME_MEDIA, 'Movies/Film C (2003)/c.mkv'), 'c'.repeat(4000))
  writeFileSync(join(HOME_MEDIA, 'Movies/Film D (2004)/two\nlines.mkv'), 'd'.repeat(700))
  writeFileSync(join(HOME_MEDIA, 'Movies/single.mkv'), 's'.repeat(500))
  // Already on the other server: all of Film A, and Film B's subtitles.
  for (const d of ['movies/Film A (2001)', 'movies/Film B (2002)', 'tv', 'music']) mkdirSync(join(NAS, d), { recursive: true })
  writeFileSync(join(NAS, 'movies/Film A (2001)/a.mkv'), 'a'.repeat(1000))
  writeFileSync(join(NAS, 'movies/Film B (2002)/b.srt'), 'b'.repeat(30))
  // A library that is really a link into a system folder, on both ends.
  symlinkSync('/etc', join(HOME_MEDIA, 'Evil'))
  symlinkSync('/etc', join(NAS, 'evil'))

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
  cookie = (await signIn(app, OWNER, 'owner master password')).cookie
  sid = [...broker.sessions.values()].at(-1)!.sid
})
after(async () => { setSendDeps(null); setApiTokenStore(null); await resetLock(); await app?.close(); rmSync(tmp, { recursive: true, force: true }) })

const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = { cookie }) => app.inject({ method: method as any, url, headers, payload: payload as any })

// ---------------------------------------------------------------------------

test('Plex library XML: key, title (entities decoded), type and folders', () => {
  const s = parsePlexSections('101', fx('plex-sections.xml'))
  assert.deepEqual(s.map(x => [x.key, x.title, x.type, x.locations]), [
    ['1', 'Movies', 'movie', ['/media/movies']], ['2', 'TV Shows', 'show', ['/media/tv']], ['3', 'Music & Concerts', 'artist', ['/media/music']],
    ['4', 'Old Films', 'movie', ['/media/old']], ['5', 'Phone Photos', 'photo', ['/data/photos']], ['6', 'Evil Link', 'movie', ['/media/evil']],
  ])
})

test('destination candidates: writable NAS mounts used by Plex, by Plex name; read-only and system-disk folders left out', () => {
  const f = parseFacts('pve', remoteFacts())
  const libs = librariesOf(f, true)
  // As text the link looks fine; discovery checks it on the node (next tests).
  assert.deepEqual(libs.map(l => [l.name, l.path, l.sectionKey, l.containerPath]), [
    ['Movies', `${NAS}/movies`, '1', '/media/movies'], ['TV Shows', `${NAS}/tv`, '2', '/media/tv'], ['Music & Concerts', `${NAS}/music`, '3', '/media/music'], ['Evil Link', `${NAS}/evil`, '6', '/media/evil'],
  ])
  assert.equal(libs[0].free, 2 * TB)
  assert.deepEqual(linkAddresses(f), ['100.100.1.9'], 'the tailnet address; not the LAN, loopback or link-local one')
  // Plex there but not signed in: the same folders, named by their own names.
  const noPlex = parseFacts('pve', remoteFacts().split('\n').filter(l => !l.startsWith('PLEXXML')).join('\n') + '\nPLEXWHY\t101\tno-token')
  assert.deepEqual(librariesOf(noPlex, true).map(l => [l.name, l.from]), [['Movies', 'folder'], ['TV Shows', 'folder'], ['Music', 'folder'], ['Evil', 'folder']])
  assert.equal(friendlyName('/x/kids_films'), 'Kids Films')
})

test('3: without Plex naming them, Proxmox storage folders are never offered', () => {
  assert.deepEqual(storagePaths('[{"storage":"local","path":"/var/lib/vz"},{"storage":"nas","type":"nfs"},{"storage":"bad/../x"}]'), ['/var/lib/vz', '/mnt/pve/local', '/mnt/pve/nas'])
  const out = ['MNT\tnas:/a\t/mnt/pve/nas\tnfs4\trw', 'MNT\tnas:/b\t/srv/backup\tnfs4\trw', 'MNT\tnas:/c\t/srv/backup/dump\tnfs4\trw', 'MNT\tnas:/d\t/srv\tnfs4\trw', 'MNT\tnas:/e\t/srv2/media\tnfs4\trw',
    'STORAGES\t[{"storage":"bk","type":"dir","path":"/srv/backup"}]'].join('\n')
  assert.deepEqual(librariesOf(parseFacts('pve', out), true).map(l => l.path), ['/srv2/media'], 'not /mnt/pve, not a storage folder, nor inside or holding one')
  // An unaskable Plex container whose bind source is a storage folder: also left out.
  const ct = ['MNT\tnas:/b\t/srv/backup\tnfs4\trw', 'MNT\tnas:/e\t/srv2/media\tnfs4\trw', 'STORAGES\t[{"storage":"bk","path":"/srv/backup"}]',
    'CTMP\t101\tmp0: /srv/backup,mp=/b', 'CTMP\t101\tmp1: /srv2/media,mp=/m', 'PLEX\t101', 'PLEXWHY\t101\tno-answer'].join('\n')
  assert.deepEqual(librariesOf(parseFacts('pve', ct), true).map(l => l.path), ['/srv2/media'])
  // Plex naming exactly a folder under /mnt/pve: offered.
  const plex = ['MNT\tnas:/a\t/mnt/pve/nas\tnfs4\trw', 'CTMP\t101\tmp0: /mnt/pve/nas/media,mp=/m', 'PLEX\t101', 'PLEXXML\t101\t<Directory key="1" title="Movies" type="movie"><Location path="/m"/></Directory>'].join('\n')
  assert.deepEqual(librariesOf(parseFacts('pve', plex), true).map(l => l.path), ['/mnt/pve/nas/media'])
})

test('5: link candidates are private only, never loopback or link-local, and at most 16', () => {
  const links = ['LINK\twg0\t203.0.113.5', 'LINK\twg0\t10.8.0.2', 'LINK\ttailscale0\t169.254.1.1', 'LINK\tnb-wt0\t100.70.0.2', ...Array.from({ length: 30 }, (_, i) => `LINK\twg${i + 1}\t10.9.0.${i + 1}`)]
  const a = linkAddresses(parseFacts('x', links.join('\n')))
  assert.ok(!a.includes('203.0.113.5') && !a.includes('169.254.1.1'))
  assert.ok(a.includes('10.8.0.2') && a.includes('100.70.0.2'))
  assert.equal(a.length, 16)
  assert.ok(factsScript(Array.from({ length: 40 }, (_, i) => `10.0.1.${i}`)).split('/dev/tcp').length - 1 <= 16)
})

test('the facts script, run for real against a fake pct: libraries come back, the token never does, excluded containers are not entered', () => {
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
  writeFileSync(join(bin, 'pvesh'), '#!/bin/bash\nprintf \'[{"storage":"local","path":"/var/lib/vz"}]\'\n')
  chmodSync(join(bin, 'pct'), 0o755); chmodSync(join(bin, 'pvesh'), 0o755)
  const env = { PATH: `${bin}:${process.env.PATH}`, HPX_LOG: join(tmp, 'pct.log'), HPX_DIR: tmp }

  const out = bash(factsScript(), env)
  assert.ok(!out.includes(TOKEN), 'the token is cut out of everything printed')
  const f = parseFacts('pve', out)
  assert.deepEqual(f.plexCts, ['101'], 'only the container with Plex in it')
  assert.ok(f.plexSections.some(s => s.title === 'Movies'))
  assert.ok(f.storages.includes('/var/lib/vz'))
  assert.ok(f.ctMounts.some(c => c.ct === '101' && c.source === `${NAS}/movies` && c.target === '/media/movies'))
  const argv = readFileSync(join(tmp, 'pct.log'), 'utf8')
  assert.ok(!argv.includes(TOKEN), 'the token is never an argument of any command')
  assert.match(readFileSync(join(tmp, 'pct.log.stdin.101'), 'utf8'), new RegExp(`^X-Plex-Token: ${TOKEN}$`, 'm'), 'it reaches curl on stdin')
  assert.ok(!/\[exec\] \[103\]/.test(argv), 'stopped containers are not entered')
  assert.match(factsScript(), /timeout 15 pct exec "\$1" -- sh -c .* \| head -c 2000000/)
  assert.match(factsScript(), /timeout 15 pct exec "\$1" -- curl .* \| head -c 2000000/)

  // The scan after a copy: one library, one folder, only the HTTP code comes back.
  const scan = plexScanScript('101', '1', '/media/movies/Film C (2003)')
  assert.ok(!scan.includes(TOKEN))
  assert.match(scan, /-H @-/)
  assert.match(scan, /library\/sections\/1\/refresh\?path=%2Fmedia%2Fmovies%2FFilm%20C%20\(2003\)/)
  assert.equal(bash(scan, env).trim(), 'PLEX-HTTP 200')
  assert.ok(!readFileSync(join(tmp, 'pct.log'), 'utf8').includes(TOKEN))
  assert.throws(() => plexScanScript('101; rm', '1', null))

  // Never look inside: by the list, by the tag (also at scan time), and none at all when the list is unknown.
  const entered = (id = '\\d+') => (readFileSync(join(tmp, 'pct.log'), 'utf8').match(new RegExp(`\\[exec\\] \\[${id}\\]`, 'g')) ?? []).length
  writeFileSync(join(tmp, 'pct.log'), '')
  assert.deepEqual(parseFacts('pve', bash(factsScript([], ['101']), env)).plexCts, [])
  assert.equal(entered('101'), 0, 'not the listed one')
  writeFileSync(join(tmp, 'pct.log'), '')
  bash(factsScript([], null), env)
  assert.equal(entered(), 0)
  writeFileSync(join(tmp, 'pct-config.txt'), 'tags: media;hyperprox-ignore\n' + fx('remote-pct-config.txt').replaceAll('@NAS@', NAS))
  assert.deepEqual(parseFacts('pve', bash(factsScript(), env)).plexCts, [])
  assert.equal(bash(scan, env).trim(), 'PLEX-IGNORED')
  assert.equal(entered('101'), 0)
})

test('1: a root that is a link into a system folder is refused by the node check and by the run script', () => {
  const link = join(HOME_MEDIA, 'Evil')
  assert.throws(() => parseContainment(bash(containmentScript(`${link}/hostname`, link, false)), 'x', 'hostname'), /leads to a system folder/)
  assert.throws(() => parseContainment(bash(containmentScript(link, link, true)), 'x', 'Evil'), /leads to a system folder/)
  assert.match(bash(containmentScript(join(HOME_MEDIA, 'Movies'), HOME_MEDIA, true)), /^OK /m, 'an ordinary folder still passes')

  const D = mkdtempSync(join(tmpdir(), 'hpx-run-'))
  writeFileSync(join(D, 'run.sh'), runScript())
  for (const [k, root] of [['SRC_ROOT', link], ['DST_ROOT', join(NAS, 'evil')]] as const) {
    const other = k === 'SRC_ROOT' ? HOME_MEDIA : HOME_MEDIA
    writeFileSync(join(D, 'job.env'), `JOB_ID=t\nMODE=copy\nSRC='${k === 'SRC_ROOT' ? `${link}/hostname` : `${HOME_MEDIA}/Movies/single.mkv`}'\nSRC_ROOT='${k === 'SRC_ROOT' ? root : other}'\nDST_PATH='${k === 'DST_ROOT' ? root : HOME_MEDIA}'\nDST_ROOT='${k === 'DST_ROOT' ? root : HOME_MEDIA}'\nDST_REL=.\nDST_HOST=''\nDST_HOST_URI=''\nBWLIMIT=0\n`)
    writeFileSync(join(D, 'status'), '')
    execFileSync('bash', [join(D, 'run.sh')], { env: { ...process.env, PATH: '/usr/bin:/bin' } })
    const status = readFileSync(join(D, 'status'), 'utf8')
    assert.match(status, /error an allowed folder leads to a system folder/, k)
    assert.match(status, /end failed/)
    assert.ok(!status.includes('/etc') && !status.includes(HOME_MEDIA), 'the status line carries no path')
  }
  rmSync(D, { recursive: true, force: true })
})

test('discovery: links into system folders are dropped on both ends; the sender, the libraries and what setup would do', () => asOwner(async () => {
  forgetSendPlans()
  const plan = await discoverSend(RID, deps, { fresh: true })
  assert.deepEqual(plan.sources.map(s => [s.name, s.path]), [['Movies', `${HOME_MEDIA}/Movies`], ['TV Shows', `${HOME_MEDIA}/TV Shows`]], 'Evil (a link to /etc) is gone')
  assert.deepEqual(plan.libraries.map(l => l.name), ['Movies', 'TV Shows', 'Music & Concerts'], 'Evil Link (a link to /etc) is gone')
  assert.ok(plan.problems.some(p => /1 home folder was left out/.test(p)))
  assert.equal(plan.sourceNode, 'node1', 'the home node that reaches it over the tailnet')
  assert.deepEqual(plan.links, { pve: '100.100.1.9' })
  assert.deepEqual(plan.privateLink, { pve: true })
  const r = await planReadiness(plan, deps)
  assert.equal(r.ready, false)
  assert.deepEqual(r.hostKeys, [{ node: 'pve', fingerprint: PIN }])
  assert.ok(r.steps.some(s => s.includes(`Movies (${HOME_MEDIA}/Movies)`)), 'steps show the real paths')
  assert.ok(r.steps.some(s => /over the private link/.test(s)))
  assert.ok(runLog.includes('home/node3 facts'), 'a home node without a login is skipped, not fatal')

  // Browsing and searching only reach the folders that passed.
  await assert.rejects(browseSend(RID, `${HOME_MEDIA}/Evil`, deps), /not inside your home library/)
  assert.deepEqual((await searchSend(RID, 'hostname', deps)).length, 0)

  // Per session: another person's look does not reuse this one.
  const before = runLog.filter(l => l.endsWith('facts')).length
  await requestContext.run({ sid: 'someone-else', email: 'b@example.com', role: 'owner' }, () => discoverSend(RID, deps))
  assert.ok(runLog.filter(l => l.endsWith('facts')).length > before)
  await discoverSend(RID, deps)
  const again = runLog.filter(l => l.endsWith('facts')).length
  await discoverSend(RID, deps)
  assert.equal(runLog.filter(l => l.endsWith('facts')).length, again, 'the same session reuses its own look')
}))

test('setup is refused without the master password, and for an API token, and changes nothing', async () => {
  assert.equal(needsReconfirm('POST', `/api/clusters/${RID}/send/setup`), true)
  assert.equal(requiredRole('POST', `/api/clusters/${RID}/send/setup`), 'admin')
  assert.equal(needsReconfirm('POST', `/api/clusters/${RID}/send/preview`), false, 'looking is not re-confirmed')
  assert.equal(tokenForbidden('POST', '/api/auth/reconfirm'), true, 'a token can never re-confirm')

  const r = await call('POST', `/api/clusters/${RID}/send/setup`, { previewId: 'x', setupHash: 'y', confirmHostKeys: [PIN] })
  assert.equal(r.statusCode, 403)
  assert.equal(r.json().code, 'reconfirm_required')
  const { token } = await createApiToken({ name: 'auto', role: 'admin' }, 'test', tokens)
  const t = await call('POST', `/api/clusters/${RID}/send/setup`, { previewId: 'x', setupHash: 'y', confirmHostKeys: [PIN] }, { authorization: `Bearer ${token}` })
  assert.equal(t.statusCode, 403)
  assert.ok(['reconfirm_required', 'token_forbidden'].includes(t.json().code))
  assert.deepEqual(clusterRow('home')!.allowedRoots, [])
  assert.deepEqual(clusterRow(RID)!.allowedRoots, [])
})

let previewId = '', setupHash = '', moviesId = ''
const picks = ['Film A (2001)', 'Film B (2002)', 'Film C (2003)', 'single.mkv'].map(n => `${HOME_MEDIA}/Movies/${n}`)

test('multi-select preview: whole items already there are skipped, files already there are skipped, room is checked', async () => {
  moviesId = (await asOwner(() => discoverSend(RID, deps))).libraries.find(l => l.name === 'Movies')!.id
  const res = await call('POST', `/api/clusters/${RID}/send/preview`, { items: picks, library: moviesId })
  assert.equal(res.statusCode, 200, res.body)
  const p = res.json().data
  assert.deepEqual(p.items.map((i: any) => [i.name, i.files, i.bytes, i.skippedFiles, i.already]), [
    ['Film A (2001)', 0, 0, 1, true], ['Film B (2002)', 1, 2000, 1, false], ['Film C (2003)', 1, 4000, 0, false], ['single.mkv', 1, 500, 0, false],
  ])
  assert.equal(p.words, '3 items, 6.3 KB, under a minute; 1 already there and will be skipped')
  assert.equal(p.ready, false)
  // 2: only what was picked is to be set up: the Movies library on both ends, with real paths.
  assert.ok(p.steps.some((s: string) => s.includes(`Movies (${HOME_MEDIA}/Movies)`)) && !p.steps.some((s: string) => s.includes('TV Shows')))
  assert.ok(p.steps.some((s: string) => s.includes(`${NAS}/movies`)) && !p.steps.some((s: string) => s.includes(`${NAS}/tv`)))
  previewId = p.previewId; setupHash = p.setupHash

  await asOwner(async () => {
    const plan = await discoverSend(RID, deps)
    const music = plan.libraries.find(l => l.name === 'Music & Concerts')!
    await assert.rejects(previewSend(OWNER, RID, [`${HOME_MEDIA}/Movies`], moviesId, deps), /not the whole library/)
    await assert.rejects(previewSend(OWNER, RID, [`${HOME_MEDIA}/Movies/Film B (2002)`, `${HOME_MEDIA}/Movies/Film B (2002)/b.mkv`], moviesId, deps), /already picked/)
    await assert.rejects(previewSend(OWNER, RID, Array.from({ length: 21 }, (_, i) => `${HOME_MEDIA}/Movies/x${i}`), moviesId, deps), /at most 20/)
    await assert.rejects(previewSend(OWNER, RID, ['/etc/passwd'], moviesId, deps), /system folder/)
    await assert.rejects(previewSend(OWNER, RID, [`${HOME_MEDIA}/Movies/nope`], music.id, deps), /does not exist/)
    await assert.rejects(previewSend(OWNER, RID, picks, 'nope', deps), /no longer there/)
    // A file name with a line break in it is one file, not two broken lines.
    const d = await previewSend(OWNER, RID, [`${HOME_MEDIA}/Movies/Film D (2004)`], moviesId, deps)
    assert.deepEqual([d.files, d.bytes], [1, 700])
  })
})

test('2 and 8: setup is bound to the preview, checks everything before changing anything, and asks for a needed host key in the same step', async () => {
  await call('POST', '/api/auth/reconfirm', { password: 'owner master password' })
  const changed = await call('POST', `/api/clusters/${RID}/send/setup`, { previewId, setupHash: 'f'.repeat(64), confirmHostKeys: [PIN] })
  assert.equal(changed.statusCode, 409)
  assert.match(changed.json().error, /What will be set up changed; look again\. Nothing was changed\./)

  const noKey = await call('POST', `/api/clusters/${RID}/send/setup`, { previewId, setupHash, confirmHostKeys: [] })
  assert.equal(noKey.statusCode, 409, noKey.body)
  assert.match(noKey.json().error, /identity key .*Nothing was changed/)

  // More than 20 folders: refused before the host key is confirmed or any folder is allowed.
  await updateCluster(RID, { allowedRoots: Array.from({ length: 20 }, (_, i) => `/srv/x${i}`) })
  const many = await call('POST', `/api/clusters/${RID}/send/setup`, { previewId, setupHash, confirmHostKeys: [PIN] })
  assert.equal(many.statusCode, 422, many.body)
  assert.match(many.json().error, /more than 20 folders.*Nothing was changed/)
  assert.deepEqual(confirmed, [], 'the host key was not confirmed')
  assert.deepEqual(clusterRow('home')!.allowedRoots, [])
  await updateCluster(RID, { allowedRoots: [] })

  // 7: a preview is only good for the server it was made for.
  assert.equal((await call('POST', `/api/clusters/c9999999999/send`, { previewId })).statusCode, 404)

  audits.length = 0
  const ok = await call('POST', `/api/clusters/${RID}/send/setup`, { previewId, setupHash, confirmHostKeys: [PIN] })
  assert.equal(ok.statusCode, 200, ok.body)
  assert.equal(ok.json().data.words, "Ready. Your home library can now be sent to Remote server's Movies.")
  assert.equal(ok.json().data.ready, true)
  assert.deepEqual(confirmed, ['pve'])
  assert.deepEqual(clusterRow('home')!.allowedRoots, [`${HOME_MEDIA}/Movies`], 'only the home library holding the picks')
  assert.deepEqual(clusterRow(RID)!.allowedRoots, [`${NAS}/movies`], 'only the picked library')
  assert.equal((await asOwner(() => sendKey('home', RID, 'pve', `${NAS}/movies`)))?.dstAddress, '100.100.1.9')
  assert.equal(await asOwner(() => sendKey('home', RID, 'pve', `${NAS}/tv`)), null, 'no key for a library that was not picked')
  const a = audits.find(x => x.action === 'cluster.files.setup')
  assert.ok(a && a.details.by === OWNER && a.details.keysMade === 1 && a.details.ok === true)
  assert.ok(!JSON.stringify(audits).includes('PRIVATE KEY') && !JSON.stringify(audits).includes(NAS), 'no key or path in the audit log')
  assert.ok(!ok.body.includes('PRIVATE KEY') && !ok.body.includes(TOKEN), 'nor in the answer')
})

test('7 and 8: send only for its own server, keeps going when one item fails, and says so plainly', () => asOwner(async () => {
  await assert.rejects(sendNow('someone-else@example.com', previewId, RID, deps), /No such preview/)
  await assert.rejects(sendNow(OWNER, previewId, 'c9999999999', deps), /No such preview/)
  failDryRunFor = 'single.mkv'
  const r = await sendNow(OWNER, previewId, RID, deps)
  failDryRunFor = null
  assert.deepEqual(r.jobs.map(j => j.srcPath.split('/').pop()), ['Film B (2002)', 'Film C (2003)'])
  assert.deepEqual(r.notStarted.map(n => n.name), ['single.mkv'])
  assert.match(r.words, /^Started 2 of 3\. Not started: single\.mkv/)
  assert.ok(r.jobs.every(j => j.dstPath === `${NAS}/movies` && j.srcNode === 'node1' && j.plexScan && j.mode === 'copy'))
  assert.equal(r.jobs[0].preview.library.name, 'Movies')
  await assert.rejects(sendNow(OWNER, previewId, RID, deps), /No such preview/, 'a preview is used once')
}))

test('browse and search the home library: inside it only, folder sizes shown, odd names kept on one line', async () => {
  const b = await call('GET', `/api/clusters/${RID}/send/browse?path=${encodeURIComponent(`${HOME_MEDIA}/Movies`)}`)
  assert.equal(b.statusCode, 200, b.body)
  const e = b.json().data.entries
  assert.deepEqual(e.map((x: any) => [x.name, x.dir]), [['Film A (2001)', true], ['Film B (2002)', true], ['Film C (2003)', true], ['Film D (2004)', true], ['single.mkv', false]])
  assert.equal(e[4].size, 500)
  assert.ok(e[1].size >= 2030, 'a folder shows its size')
  assert.equal(b.json().data.up, null, 'the library itself is the top')
  assert.equal((await call('GET', `/api/clusters/${RID}/send/browse?path=${encodeURIComponent('/srv/elsewhere')}`)).statusCode, 422)
  const d = await call('GET', `/api/clusters/${RID}/send/browse?path=${encodeURIComponent(`${HOME_MEDIA}/Movies/Film D (2004)`)}`)
  assert.deepEqual(d.json().data.entries.map((x: any) => x.name), ['two lines.mkv'])

  const s = await asOwner(() => searchSend(RID, 'film b', deps))
  assert.deepEqual(s.map(x => x.name), ['Film B (2002)'])
  await assert.rejects(searchSend(RID, 'a*', deps), /plain words/)
  await assert.rejects(searchSend(RID, 'x', deps), /2 to 60/)
})

test('rate limits: looking at both servers at most 3 times a minute', async () => {
  let last = 0
  for (let i = 0; i < 4; i++) last = (await call('POST', `/api/clusters/${RID}/send/discover`, {})).statusCode
  assert.equal(last, 429)
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

test('after a verified copy: that library is scanned, "Added to Movies" is shown, and notifications carry no paths or addresses', () => asOwner(async () => {
  setJobStore(new MemoryJobStore())
  const sent: any[] = []
  const library = { id: 'x', name: 'Movies', node: 'pve', ct: '101', sectionKey: '1', containerPath: '/media/movies' }
  const base = { mode: 'copy', srcCluster: 'home', srcNode: 'node1', srcPath: `${HOME_MEDIA}/Movies/Film C (2003)`, dstCluster: RID, dstNode: 'pve', dstPath: `${NAS}/movies`, speedKBps: 0, plexScan: true, progress: {}, error: null, attempts: 1, createdBy: OWNER, startedAt: new Date(), finishedAt: null }
  const ok = await jobStore().create({ ...base, id: '00000000-0000-0000-0000-0000000000a1', state: 'running', preview: { files: 1, bytes: 4000, simple: true, item: 'Film C (2003)', library } } as any)

  const poll = (end: string) => ({ ...fakeRunner, async run(c: string, n: string, s: string) { if (s.includes('HPX-STATUS-BEGIN')) return { code: 0, output: `HPX-STATUS-BEGIN\nphase verify\ncopied 1\n${end}\nHPX-STATUS-END\nHPX-PROGRESS \nDEAD\n` }; return fakeRunner.run(c, n, s) } }) as NodeRunner
  const runner = new CopyRunner(poll('verified 1\nend done'), async (_c, j) => scanLibraryAfterCopy(j, fakeRunner, deps), () => {}, async e => { sent.push(e) })
  await runner.follow(ok)
  const done = (await jobStore().get(ok.id))!
  assert.equal(done.state, 'done')
  assert.equal(done.progress.plex, 'Added to Movies.')
  assert.ok(!JSON.stringify(done).includes(TOKEN), 'the scan answer never carries the token')
  assert.equal(sent[0].type, 'files.copy.finished')
  assert.match(sent[0].title, /Film C \(2003\) to Remote server/)
  assert.ok(!JSON.stringify(sent).includes(NAS), 'no paths in a notification')
  assert.equal(familyOf('files.copy.finished'), 'jobs', 'channels that take job events get it')

  // 8: Plex's container put on the never-look-inside list since: not asked.
  assert.match(await scanLibraryAfterCopy(done, fakeRunner, { ...deps, excludedCts: async () => ['101'] }), /not to be looked inside/)
  assert.match(await scanLibraryAfterCopy(done, fakeRunner, { ...deps, excludedCts: async () => null }), /not to be looked inside/)

  const bad = await jobStore().create({ ...base, id: '00000000-0000-0000-0000-0000000000a2', state: 'running', preview: { files: 1, bytes: 4000, library } } as any)
  await new CopyRunner(poll('error copying stopped with rsync code 12\nend failed'), async () => null, () => {}, async e => { sent.push(e) }).follow(bad)
  const failed = (await jobStore().get(bad.id))!
  assert.equal(failed.state, 'failed')
  assert.match(failed.error ?? '', /connection to the other server dropped.*Resume/)
  assert.equal(sent.at(-1).type, 'files.copy.failed')
  assert.equal(plainJobError('something odd'), 'something odd', 'unknown words are kept in the job list')

  // 6: an unknown failure (a pin mismatch naming host:port) never reaches a notification; neither do Plex addresses.
  const odd = copyEvent(failed, 'failed', 'Host key for 10.0.0.9:22 changed (SHA256:abc)', null)
  assert.deepEqual(odd.lines, ['The copy stopped. Open the Command center in HyperProx to see why and to resume it.'])
  const plexy = copyEvent(done, 'done', null, 'Plex was not asked to scan: connect ECONNREFUSED 10.0.0.5:32400 (http://plex.example:32400/x) fd7a:115c:a1e0::1')
  assert.ok(!/10\.0\.0\.5|plex\.example|fd7a/.test(JSON.stringify(plexy)), JSON.stringify(plexy))
  assert.equal(noAddresses('Episode 01:02 at 12:30'), 'Episode 01:02 at 12:30', 'ordinary times are left alone')
}))

test('a remote cluster\'s own "never look inside" list: numbers only, saved through the re-confirmed connection route, used by discovery', async () => {
  await assert.rejects(updateCluster(RID, { ignoredGuests: ['101; rm'] }), /container numbers only/)
  assert.equal(needsReconfirm('POST', `/api/clusters/${RID}/connection`), true)
  const r = await call('POST', `/api/clusters/${RID}/connection`, { ignoredGuests: ['105', '101', '101'] })
  assert.equal(r.statusCode, 200, r.body)
  assert.deepEqual(clusterRow(RID)!.ignoredGuests, ['101', '105'])
  assert.deepEqual(await excludedContainers(RID), ['101', '105'])
  assert.equal(await excludedContainers('home'), null, 'home without the Remote access list: unknown, so nothing is entered')
  await updateCluster(RID, { ignoredGuests: [] })
})
