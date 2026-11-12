// Proxmox Backup Server in the catalogue: the recipe and its option checks, the install script (key checked by
// checksum, test write before the datastore, never re-initialise one), the detect fingerprint, the NFS datastore
// (option builder, SMB refusal, existing-datastore detection with re-attach, the uid-mapping note, reversible
// mount), the create call, and the setup steps in order with mocks. Nothing real is contacted; names are made up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findRecipe, checkOptions } from '../src/lib/catalogue'
import { installScript } from '../src/lib/install-script'
import { DETECT } from '../src/lib/catalogue-detect'
import { createFromPlan, type InstallPlan } from '../src/lib/catalogue-installer'
import {
  PBS_SETUP_STEPS, PROXMOX_KEY_SHA256, RECIPE_ID, fingerprintFromLog, pbsPreviewChecks, runPbsSetup, scriptEnv,
  type SetupDeps, type SetupStep,
} from '../src/lib/pbs/catalogue'
import {
  NFS_OPTIONS, SMB_REFUSAL, UID_NOTE, bindMountpoint, cleanNfsSource, fstabLine, judgeProbe, looksLikeSmb, mountScript, parseProbe, probeScript, unmountScript,
} from '../src/lib/pbs/nfs'
import { knownNas, parseExports } from '../src/lib/pbs/nas-list'
import { normaliseFingerprint } from '../src/lib/clusters/tls-pin'

const recipe = findRecipe(RECIPE_ID)!
const nasOpts = { PBS_LOCATION: 'nas', PBS_NFS_HOST: '10.20.30.40', PBS_NFS_EXPORT: '/Backups', PBS_DATASTORE: 'store1', PBS_SIZE_GB: '500' }

// ── the recipe ───────────────────────────────────────────────────────────────

test('recipe: an unprivileged Debian script install, 2 cores / 2 GB, a generated root@pam password, its own setup', () => {
  assert.ok(recipe)
  assert.equal(recipe.name, 'Proxmox Backup Server')
  assert.equal(recipe.install.kind, 'script')
  assert.equal(recipe.needsDocker, false)
  assert.deepEqual(recipe.defaults, { cores: 2, memoryMb: 2048, diskGb: 10, swapMb: 512 })
  assert.deepEqual(recipe.firstRun, { kind: 'env-admin', user: 'root@pam', passwordEnv: 'PBS_ROOT_PASSWORD' })
  assert.equal(recipe.setup, 'pbs')
  assert.equal(recipe.port, 8007)
  assert.equal(recipe.wizard, false, 'not offered to the AI wizard')
  assert.ok(recipe.notes!.some(n => /not an off-site copy/.test(n)))
})

test('recipe options: NAS needs an address and export, SMB is refused, a new disk cannot be "re-attached"', () => {
  assert.deepEqual(checkOptions(recipe, nasOpts).errors, [])
  assert.equal(checkOptions(recipe, {}).values.PBS_LOCATION, 'nas', 'the NAS is the default choice')
  assert.match(checkOptions(recipe, { ...nasOpts, PBS_NFS_EXPORT: '' }).errors.join(' '), /export is the NFS path/)
  for (const [host, path] of [['smb://nas.example.lan', '/Backups'], ['\\\\nas\\Backups', ''], ['nas.example.lan', '//nas/Backups'], ['cifs:nas', '/x']]) {
    assert.deepEqual(checkOptions(recipe, { ...nasOpts, PBS_NFS_HOST: host, PBS_NFS_EXPORT: path }).errors, [SMB_REFUSAL], `${host} ${path}`)
  }
  assert.match(SMB_REFUSAL, /":"/)
  assert.deepEqual(checkOptions(recipe, { PBS_LOCATION: 'disk', PBS_DATASTORE: 'store1', PBS_SIZE_GB: '100' }).errors, [])
  assert.match(checkOptions(recipe, { PBS_LOCATION: 'disk', PBS_DATASTORE: 'store1', PBS_REATTACH: '1' }).errors.join(' '), /new disk is always empty/)
  assert.match(checkOptions(recipe, { ...nasOpts, PBS_DATASTORE: 'bad name!' }).errors.join(' '), /datastore name/)
  assert.match(checkOptions(recipe, { ...nasOpts, PBS_LOCATION: 'usb' }).errors.join(' '), /Choose where/)
  assert.match(checkOptions(recipe, { ...nasOpts, PBS_NFS_EXPORT: '/a/../b' }).errors.join(' '), /export/)
})

test('install script: key fetched over https and checked by SHA-256, no pipe to a shell, write test before the datastore', () => {
  const env = { ...checkOptions(recipe, nasOpts).values, ...scriptEnv(), PBS_ROOT_PASSWORD: 'generated-secret' }
  const s = installScript(recipe, 'debian', env)
  assert.match(s, /^set -e/)
  assert.ok(s.includes(`export PBS_KEY_SHA256='${PROXMOX_KEY_SHA256}'`))
  assert.match(s, /sha256sum -c --quiet -/)
  assert.ok(!/curl[^\n]*\|\s*(sh|bash)/.test(s), 'nothing downloaded is piped into a shell')
  assert.match(s, /Suites: trixie\nComponents: pbs-no-subscription/)
  // The enterprise repository the package adds is switched off after the install (it answers 401 without a subscription).
  const inst = s.indexOf('apt-get install -y -qq proxmox-backup-server')
  assert.ok(s.indexOf('pbs_no_enterprise', inst) > inst, 'switched off after the install')
  assert.ok(s.indexOf('pbs_no_enterprise\n') < s.indexOf('apt-get update -qq'), 'and before the first update, so a re-run works')
  assert.match(s, /printf 'Enabled: no\\n' >> "\$F"/)
  const own = s.indexOf('chown backup:backup "$DS"'), write = s.indexOf("su -s /bin/sh backup -c"), create = s.indexOf('proxmox-backup-manager datastore create')
  assert.ok(own > 0 && write > own, 'the folder is handed to backup before the write test (a new disk belongs to root)')
  assert.ok(write > 0 && create > write, 'the backup user is tested before any datastore is made')
  assert.ok(!/chown -R|chmod -R/.test(s), 'only the folder itself, never what is in it')
  assert.match(s, /--reuse-datastore true/)
  assert.match(s, /\[ "\$PBS_REATTACH" = 1 \] \|\| \{ echo .*nothing was changed/)
  assert.match(s, /--keep-last 3 --keep-daily 7 --keep-weekly 4 --keep-monthly 6/)
  assert.match(s, /--gc-schedule 'sat 06:00'/)
  assert.match(s, /verify-job create hyperprox-verify --store "\$PBS_DATASTORE" --schedule 'sun 08:00'/)
  assert.ok(!s.includes('rm -rf'), 'nothing in the datastore is ever removed')
  // The password is in the private script (stdin), set with chpasswd from the environment, never echoed.
  assert.match(s, /printf 'root:%s\\n' "\$PBS_ROOT_PASSWORD" \| chpasswd/)
  assert.ok(!/echo[^\n]*PBS_ROOT_PASSWORD/.test(s))
  assert.throws(() => installScript(recipe, 'debian', { ...env, PBS_ROOT_PASSWORD: '' }), /PBS_ROOT_PASSWORD/)
  const fp = 'AB:'.repeat(31) + 'AB'
  assert.equal(fingerprintFromLog(`...\n@@pbs fingerprint ${fp.toLowerCase()}\nProxmox Backup Server is installed`), fp)
  assert.equal(fingerprintFromLog('no marker'), null)
})

test('detect: a PBS web interface behind a proxy shows as installed; other pages do not', () => {
  const [fpr] = DETECT[RECIPE_ID]
  assert.equal(fpr.path, '/')
  const page = '<html><head><title>backup-01 - Proxmox Backup Server</title><script src="/js/proxmox-backup-gui.js"></script>'
  assert.deepEqual(fpr.match({ status: 200, headers: {}, body: page }), { version: null })
  assert.equal(fpr.match({ status: 200, headers: {}, body: '<title>Proxmox Backup Server docs</title>' }), null)
  assert.equal(fpr.match({ status: 200, headers: {}, body: '<title>Homepage</title><script src="/_next/x.js">' }), null)
  assert.equal(fpr.match({ status: 401, headers: {}, body: page }), null)
})

// ── the NFS datastore ────────────────────────────────────────────────────────

test('NFS: the source, the fstab line with nofail, the bind mountpoint, and the uid note', () => {
  const src = cleanNfsSource(' 10.20.30.40 ', '/Backups/')
  assert.deepEqual(src, { host: '10.20.30.40', path: '/Backups', source: '10.20.30.40:/Backups' })
  assert.equal(NFS_OPTIONS, 'rw,vers=3,hard,timeo=600,retrans=2,_netdev,nofail')
  assert.equal(fstabLine(src, 905), '10.20.30.40:/Backups /mnt/hyperprox-pbs/905 nfs rw,vers=3,hard,timeo=600,retrans=2,_netdev,nofail 0 0 # hyperprox-pbs 905')
  assert.equal(bindMountpoint(905, 'store1'), '/mnt/hyperprox-pbs/905,mp=/mnt/datastore/store1,backup=0')
  assert.match(UID_NOTE, /uid 34/)
  assert.match(UID_NOTE, /100034/)
  assert.ok(looksLikeSmb('\\\\nas\\share', ''))
  assert.ok(!looksLikeSmb('nas.example.lan', '/share'))
  assert.throws(() => cleanNfsSource('nas;reboot', '/x'), /IP address or name/)
  assert.throws(() => cleanNfsSource('fd00::1', '/x'), /IPv4/)
})

test('NFS: the mount is on the one node, marked, idempotent and reversible', () => {
  const src = cleanNfsSource('nas.example.lan', '/Backups')
  const m = mountScript(src, 905, 'store1')
  assert.match(m, /grep -vF "\$K" \/etc\/fstab/, 'an older line for this container is replaced, not doubled')
  assert.match(m, /pct set 905 -mp0 '\/mnt\/hyperprox-pbs\/905,mp=\/mnt\/datastore\/store1,backup=0'/)
  assert.ok(!/for node|pvesh|\/etc\/pve\/storage/.test(m), 'nothing cluster-wide')
  const u = unmountScript(905)
  assert.match(u, /pct set 905 -delete mp0/)
  assert.match(u, /umount "\$M"/)
  assert.match(u, /grep -vF "\$K" \/etc\/fstab/)
  assert.ok(!/rm -rf|rm -r /.test(u), 'the NAS\'s files are never removed')
  const p = probeScript(src)
  assert.match(p, /mount -t nfs -o ro,/, 'the preview\'s look is read-only')
  assert.match(p, /umount "\$T"/)
})

test('NFS: an existing datastore is found and only re-attached when asked; a full or busy export is refused', () => {
  const src = { source: '10.20.30.40:/Backups' }
  const out = (extra: string) => `@@pbs export /Backups\n@@pbs mounted\n@@pbs space ${600 * 1024 ** 3} ${2000 * 1024 ** 3}\n${extra}`
  const existing = parseProbe(out('@@pbs existing root\n@@pbs notempty'))
  assert.deepEqual([existing.reachable, existing.existing, existing.exports], [true, true, ['/Backups']])
  const no = judgeProbe(existing, src, { minFreeGb: 500, reattach: false })
  assert.equal(no.errors.length, 1)
  assert.match(no.errors[0], /already holds a PBS datastore.*never wipes/)
  const yes = judgeProbe(existing, src, { minFreeGb: 500, reattach: true })
  assert.deepEqual(yes.errors, [])
  assert.match(yes.warnings[0], /re-attached as it is/)
  assert.match(judgeProbe(parseProbe(out('@@pbs notempty')), src, { minFreeGb: 500, reattach: false }).errors[0], /other files/)
  assert.match(judgeProbe(parseProbe(out('')), src, { minFreeGb: 900, reattach: false }).errors[0], /600 GB free, less than the 900/)
  assert.deepEqual(judgeProbe(parseProbe(out('')), src, { minFreeGb: 500, reattach: false }).errors, [])
  const down = parseProbe('@@pbs mountfail mount.nfs: access denied by server\n')
  assert.match(judgeProbe(down, src, { minFreeGb: 1, reattach: false }).errors[0], /could not be mounted.*access denied/)
  assert.match(judgeProbe(parseProbe('@@pbs nonfs\n'), src, { minFreeGb: 1, reattach: false }).errors[0], /no NFS client/)
})

test('preview: a disk keeps the off-site warning; a NAS is probed from the chosen node and explains the mount', async () => {
  const disk = await pbsPreviewChecks('node-a', { PBS_LOCATION: 'disk', PBS_SIZE_GB: '100', PBS_DATASTORE: 'store1' }, { runOnNode: async () => { throw new Error('not asked') } })
  assert.match(disk.warnings[0], /not an off-site copy/)
  const seen: string[] = []
  const nas = await pbsPreviewChecks('node-a', { ...nasOpts, PBS_REATTACH: '0' }, {
    runOnNode: async (node, script) => { seen.push(node); assert.match(script, /10\.20\.30\.40:\/Backups/); return { code: 0, output: `@@pbs mounted\n@@pbs space ${900 * 1024 ** 3} ${1000 * 1024 ** 3}\n` } },
  })
  assert.deepEqual(seen, ['node-a'])
  assert.deepEqual(nas.errors, [])
  assert.ok(nas.checks.some(c => /node-a only.*nofail/.test(c)))
  assert.ok(nas.checks.includes(UID_NOTE))
})

test('NAS list: QNAP plug-in NAS and the cluster\'s NFS storage, with their exports', async () => {
  const list = await knownNas({
    qnap: async () => [{ name: 'Office NAS', url: 'http://10.20.30.40:8080' }],
    storages: async () => [{ storage: 'nfs-iso', type: 'nfs', server: '10.20.30.40', export: '/ISO' }, { storage: 'smb1', type: 'cifs', server: '10.20.30.41' }],
  })
  assert.deepEqual(list, [{ host: '10.20.30.40', label: 'Office NAS (QNAP)', source: 'qnap', exports: ['/ISO'] }])
  assert.deepEqual(parseExports('@@pbs export /Backups\n@@pbs export /Media\njunk\n'), { exports: ['/Backups', '/Media'], noShowmount: false })
})

// ── the container create ─────────────────────────────────────────────────────

function fakeCreate() {
  const bodies: URLSearchParams[] = []
  return {
    bodies,
    client: {
      fetchStrict: async (_p: string, method?: string, body?: string) => { if (method === 'POST') bodies.push(new URLSearchParams(body)); return 'UPID:n:1:2:3:4:vzcreate:905:x:' },
      waitForTask: async () => {}, downloadTemplate: async () => '', fetchNode: async () => null, getNodes: async () => [], createLXC: async () => '',
    } as any,
  }
}
const plan = (options: Record<string, string>): InstallPlan => ({
  recipeId: RECIPE_ID, node: 'node-a', vmid: 905, hostname: 'pbs', cores: 2, memoryMb: 2048, swapMb: 512, diskGb: 10, storage: 'fast-pool',
  bridge: 'vmbr0', ip: 'dhcp', template: 'store:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst', unprivileged: true, options: checkOptions(recipe, options).values,
})

test('create: a disk datastore is its own mountpoint on the chosen storage; a NAS container waits for its mount', async () => {
  const a = fakeCreate()
  await createFromPlan(plan({ PBS_LOCATION: 'disk', PBS_DATASTORE: 'store1', PBS_SIZE_GB: '250' }), recipe, 'job-1', a.client)
  assert.equal(a.bodies[0].get('mp0'), 'fast-pool:250,mp=/mnt/datastore/store1,backup=0')
  assert.equal(a.bodies[0].get('unprivileged'), '1')
  assert.equal(a.bodies[0].get('start'), '1')
  const b = fakeCreate()
  await createFromPlan(plan(nasOpts), recipe, 'job-2', b.client)
  assert.equal(b.bodies[0].get('mp0'), null, 'a bind mount is set by the node after the create, not through the API')
  assert.equal(b.bodies[0].get('start'), '0', 'it starts only once the NAS is mounted')
  assert.equal(b.bodies[0].get('unprivileged'), '1')
})

// ── the setup steps ──────────────────────────────────────────────────────────

const FP = normaliseFingerprint('12'.repeat(32))!

function setupWorld(o: { presented?: string; addStorage?: boolean } = {}) {
  const order: string[] = []
  const vault: Record<string, string> = {}
  const acl: any[] = []
  const users: any[] = [{ userid: 'root@pam' }]
  const storages: any[] = [{ storage: 'local', type: 'dir' }]
  const api = (who: string) => ({
    async call(method: string, path: string, params?: any) {
      order.push(`${who} ${method} ${path}`)
      if (path === '/admin/datastore/store1/status') return { total: 1000 * 1024 ** 3, used: 0, avail: 1000 * 1024 ** 3 }
      if (path === '/access/users' && method === 'GET') return users
      if (path === '/access/users' && method === 'POST') { users.push({ userid: params.userid }); return null }
      const t = /^\/access\/users\/([^/]+)\/token\/([^/]+)$/.exec(path)
      if (t && method === 'POST') return { tokenid: `${decodeURIComponent(t[1])}!${t[2]}`, value: `secret-of-${t[2]}` }
      if (path === '/access/acl' && method === 'PUT') { acl.push({ path: params.path, roleid: params.role, ugid: params['auth-id'] }); return null }
      if (path === '/access/acl') return acl
      throw new Error(`unexpected ${method} ${path}`)
    },
  })
  const deps: SetupDeps = {
    probe: async () => { order.push('probe'); return { fingerprint: o.presented ?? FP, caVerified: false } },
    login: async (_u, pin, user) => { order.push(`login ${user}`); assert.equal(pin.fingerprint, FP); return api('root') },
    tokenApi: (_u, _p, tokenId) => api(tokenId),
    saveSecrets: async (c, p, v) => { order.push(`vault ${Object.keys(v).join(',')}`); for (const [k, x] of Object.entries(v)) vault[`${c}/${p}/${k}`] = x },
    connect: async v => { order.push(`connect ${v.tokenId}`); assert.equal(v.pin.fingerprint, FP); return 'p0000beef' },
    reading: async () => ({ datastores: [{ store: 'store1' }] } as any),
    pveStorage: { list: async () => storages, add: async b => { order.push(`storage ${b.storage}`); storages.push({ ...b }) } },
    now: () => new Date('2026-01-01T00:00:00Z'),
  }
  const steps = new Map<string, SetupStep>()
  const step = (id: string) => { const s: SetupStep = { id, status: 'running' }; steps.set(id, s); order.push(`step ${id}`); return s }
  const ctx = { ip: '10.20.30.50', vmid: 905, hostname: 'PBS 905', datastore: 'store1', rootPassword: 'root-secret', installLog: `x\n@@pbs fingerprint ${FP}\n`,
    addStorage: !!o.addStorage, vault: { category: 'apps', provider: `${RECIPE_ID}-905` } }
  return { order, vault, acl, steps, step, deps, ctx, storages }
}

test('setup: the steps run in order, each read back, tokens into the vault only', async () => {
  const w = setupWorld()
  const out = await runPbsSetup(w.ctx, w.step, w.deps)
  assert.deepEqual(out, { url: 'https://10.20.30.50:8007', instanceId: 'p0000beef', fingerprint: FP })
  assert.deepEqual(w.order.filter(x => x.startsWith('step ')).map(x => x.slice(5)), PBS_SETUP_STEPS.map(s => s.id))
  const idx = (s: string) => w.order.indexOf(s)
  assert.ok(idx('probe') < idx('login root@pam'), 'the pin is checked before the password is sent')
  assert.ok(idx('vault pve_token_id,pve_token_secret') < idx('step pbs-readonly-token'))
  assert.ok(idx('connect hyperprox@pbs!readonly') > idx('vault readonly_token_id,readonly_token_secret'))
  assert.deepEqual(w.acl, [
    { path: '/datastore/store1', roleid: 'DatastoreBackup', ugid: 'pve-backup@pbs' },
    { path: '/datastore/store1', roleid: 'DatastoreBackup', ugid: 'pve-backup@pbs!pve' },
    { path: '/', roleid: 'Audit', ugid: 'hyperprox@pbs' },
    { path: '/', roleid: 'Audit', ugid: 'hyperprox@pbs!readonly' },
  ])
  assert.equal(w.vault[`apps/${RECIPE_ID}-905/pve_token_secret`], 'secret-of-pve')
  assert.equal(w.vault[`apps/${RECIPE_ID}-905/readonly_token_secret`], 'secret-of-readonly')
  for (const s of w.steps.values()) assert.ok(!/secret-of|root-secret/.test(s.detail ?? ''), `${s.id} shows no secret`)
  assert.equal(w.steps.get('pbs-storage')!.status, 'skipped', 'PVE storage is off unless ticked')
  assert.ok(!w.order.some(x => x.startsWith('storage ')))
})

test('setup: PVE storage only when ticked, with the backup token and the same fingerprint, read back', async () => {
  const w = setupWorld({ addStorage: true })
  await runPbsSetup(w.ctx, w.step, w.deps)
  const added = w.storages.find(s => s.storage === 'pbs-store1')
  assert.deepEqual({ type: added.type, server: added.server, datastore: added.datastore, username: added.username, fingerprint: added.fingerprint, content: added.content },
    { type: 'pbs', server: '10.20.30.50', datastore: 'store1', username: 'pve-backup@pbs!pve', fingerprint: FP, content: 'backup' })
  assert.equal(w.steps.get('pbs-storage')!.status, 'done')
})

test('setup: a certificate on :8007 that is not the one the server reported stops it before anything is sent', async () => {
  const w = setupWorld({ presented: normaliseFingerprint('34'.repeat(32))! })
  await assert.rejects(runPbsSetup(w.ctx, w.step, w.deps), /presented .* not the/)
  assert.ok(!w.order.some(x => x.startsWith('login')), 'the root password was never sent')
  assert.deepEqual(Object.keys(w.vault), [])
})
