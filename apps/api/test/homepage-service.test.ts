// Homepage plug-in, the service and the scripts: run for real against a folder on this machine. The "guest" is a
// temporary directory; `bash -s` gets each script on stdin exactly as pct exec would, and a stand-in `docker` on
// PATH answers inspect, port, exec (Homepage's /api/services, built from the services.yaml on disk), restart and
// compose. Covered: finding the config folder from the mount, quoting, backup, refusing a file that changed since
// the preview, the diff, verifying on Homepage's own list, the audit-before-acting rule, one write at a time, keys
// into a 0600 .env, the Proxmox token, auto-sync's rate limit, fixes, and the role and re-confirm rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { firstFillReason, HomepageService, HomepageRefusal, composeReadsEnv, wireEnv, wireEnvText, WIRE_SNIPPET, AUTO_MIN_GAP_MS, type HomepageDeps, type HomepageInstance, type RecordStore } from '../src/lib/homepage/service'
import {
  locateScript, readScript, writeScript, verifyScript, composeUpScript, parseLocate, safePath, safeContainer, sha256, UnsafeValueError,
} from '../src/lib/homepage/remote'
import { varName, yaml, MANAGED_MARK } from '../src/lib/homepage/generate'
import { SYSTEM_ACTOR, type AdapterContext } from '../src/lib/auto-connect/core'
import { tileOf } from '../src/plugins/homepage'
import { assertSafeScript } from '../src/lib/clusters/script-guard'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import type { Inventory } from '../src/lib/homepage/types'
import type { Machine } from '../src/lib/remote/types'

const SAMPLE = `---\n# For configuration options and examples, please see:\n# https://gethomepage.dev/configs/services/\n\n- My First Group:\n    - My First Service:\n        href: http://localhost/\n        description: Homepage is awesome\n\n- My Second Group:\n    - My Second Service:\n        href: http://localhost/\n        description: Homepage is the best\n\n- My Third Group:\n    - My Third Service:\n        href: http://localhost/\n        description: Homepage is cool\n`
const WIDGETS = `---\n- resources:\n    cpu: true\n- search:\n    provider: duckduckgo\n`
const COMPOSE = `services:\n  homepage:\n    image: ghcr.io/gethomepage/homepage:latest\n    volumes: ["./config:/app/config"]\n    env_file:\n      - path: ./homepage.env\n        required: false\n`

interface Guest { root: string; config: string; compose: string; calls: string[]; scripts: string[] }

/** A pretend guest: a folder tree, and a docker that answers from it. */
function makeGuest(o: { compose?: string; withEnvFile?: boolean } = {}): Guest {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-homepage-'))
  const config = path.join(root, 'app', 'config'), compose = path.join(root, 'app')
  fs.mkdirSync(config, { recursive: true })
  fs.writeFileSync(path.join(config, 'services.yaml'), SAMPLE)
  fs.chmodSync(path.join(config, 'services.yaml'), 0o640)
  fs.writeFileSync(path.join(config, 'widgets.yaml'), WIDGETS)
  fs.writeFileSync(path.join(compose, 'docker-compose.yml'), o.compose ?? COMPOSE)
  fs.writeFileSync(path.join(compose, '.env'), 'HOMEPAGE_ALLOWED_HOSTS=10.0.0.30:3000\n', { mode: 0o600 })
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const yamlPath = require.resolve('js-yaml')
  fs.writeFileSync(path.join(root, 'api.js'), `const y=require(${JSON.stringify(yamlPath)});const fs=require('fs');
let d;try{d=y.load(fs.readFileSync(process.argv[2],'utf8'))||[]}catch(e){process.stdout.write(JSON.stringify({error:'bad yaml'}));process.exit(0)}
process.stdout.write(JSON.stringify(d.map(g=>{const n=Object.keys(g)[0];return{name:n,services:(g[n]||[]).map(s=>({name:Object.keys(s)[0]})),groups:[]}})))`)
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
echo "$*" >> ${JSON.stringify(path.join(root, 'calls'))}
case "$1" in
  ps) echo app-homepage-1; echo other-1 ;;
  inspect)
    fmt="$3"; c="$4"
    if [ "$c" = other-1 ]; then case "$fmt" in *Config.Image*) echo nginx:latest ;; esac; exit 0; fi
    case "$fmt" in
      *Config.Image*) echo ghcr.io/gethomepage/homepage:latest ;;
      *State.Status*) cat ${JSON.stringify(path.join(root, 'state'))} 2>/dev/null || echo running ;;
      *app/config*) echo ${JSON.stringify(config)} ;;
      *working_dir*) echo ${JSON.stringify(compose)} ;;
      *config_files*) echo ${JSON.stringify(path.join(compose, 'docker-compose.yml'))} ;;
    esac ;;
  port) echo 0.0.0.0:3000 ;;
  exec) node ${JSON.stringify(path.join(root, 'api.js'))} ${JSON.stringify(path.join(config, 'services.yaml'))} ;;
  restart) echo "$2" ;;
  compose) echo started ;;
esac
`, { mode: 0o755 })
  return { root, config, compose, calls: [], scripts: [] }
}

const machine: Machine = { id: 'lxc-130', kind: 'lxc', name: 'homepage', node: 'node1', vmid: 130, running: true, tags: [] }

function inventory(extra: Partial<Inventory> = {}): Inventory {
  return {
    guests: [{ vmid: 101, name: 'media', node: 'node1', type: 'lxc', status: 'running', tags: [], addresses: ['10.0.0.11'], machineId: 'lxc-101' },
      { vmid: 102, name: 'arr', node: 'node1', type: 'lxc', status: 'running', tags: [], addresses: ['10.0.0.12'], machineId: 'lxc-102' }],
    services: [
      { key: 'plex', url: 'http://10.0.0.11:32400', guest: { vmid: 101, name: 'media', node: 'node1', type: 'lxc' }, source: 'plugin' },
      { key: 'sonarr', url: 'http://10.0.0.12:8989', guest: { vmid: 102, name: 'arr', node: 'node1', type: 'lxc' }, source: 'scan' },
    ],
    proxyHosts: [{ domains: ['plex.example.org'], url: 'https://plex.example.org', forward: { scheme: 'http', host: '10.0.0.11', port: 32400 }, guest: null }],
    sites: [], excludedMachineIds: [], builtAt: 0, errors: [], failed: [], pluginUrls: { 'arrstack:sonarr_url': 'http://10.0.0.12:8989' }, ...extra,
  }
}

function memStore(): RecordStore & { rows: Map<string, HomepageInstance> } {
  const rows = new Map<string, HomepageInstance>()
  return {
    rows,
    async get(id) { const r = rows.get(id); return r ? structuredClone(r) : null },
    async put(i) { rows.set(i.id, structuredClone(i)) },
    async list() { return [...rows.values()].map(r => structuredClone(r)) },
    async delete(id) { rows.delete(id) },
  }
}

function setup(o: { inv?: () => Inventory; audit?: HomepageDeps['audit']; compose?: string; secrets?: Record<string, string>; revoke?: (id: string) => Promise<void>; put?: (i: HomepageInstance) => Promise<void> } = {}) {
  const guest = makeGuest({ compose: o.compose })
  const audits: Array<{ action: string; details: Record<string, unknown> }> = []
  let now = 1_700_000_000_000
  let inv = o.inv ?? (() => inventory())
  const tokens: string[] = []
  const vault = new Map<string, string>()
  const store = memStore()
  let excludedList: string[] | null = []
  const secrets = { ...(o.secrets ?? {}) }
  const realPut = store.put
  if (o.put) store.put = async (i) => { await o.put!(i); await realPut(i) }
  const deps: HomepageDeps = {
    store,
    excluded: async () => { if (!excludedList) throw new Error('db down'); return excludedList },
    exec: {
      listMachines: async () => [machine],
      run: async (_m, script) => {
        assertSafeScript(script)
        guest.scripts.push(script)
        const r = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8', env: { ...process.env, PATH: `${path.join(guest.root, 'bin')}:${process.env.PATH}` }, timeout: 30_000 })
        return { code: r.status ?? -1, output: (r.stdout ?? '') + (r.stderr ?? ''), timedOut: false }
      },
    },
    inventory: async () => inv(),
    sightings: async () => [{ vmid: 130, url: 'http://10.0.0.30:3000', via: 'catalogue' }, { vmid: 130, url: 'https://home.example.org', via: 'proxy' }],
    secret: async (src, iid) => src.kind === 'plugin' ? secrets[`${src.plugin}:${src.setting}`] ?? null
      : src.part === 'id' ? (await store.get(iid))?.proxmoxToken?.tokenId ?? null : vault.get(iid) ?? null,
    proxmox: {
      createAuditorToken: async (name) => { tokens.push(name); return { tokenId: `hyperprox@pve!${name}`, secret: 'tok-secret-1' } },
      revokeToken: o.revoke ?? (async (id) => { tokens.splice(tokens.indexOf(id.split('!')[1]), 1) }),
      saveSecret: async (iid, s) => { if (s === null) vault.delete(iid); else vault.set(iid, s) },
    },
    audit: o.audit ?? (async (action, _r, details) => { audits.push({ action, details }) }),
    now: () => now,
  }
  const svc = new HomepageService(deps)
  return {
    svc, guest, audits, store, tokens, vault, secrets,
    advance: (ms: number) => { now += ms },
    setExcluded: (l: string[] | null) => { excludedList = l },
    keyFile: () => { const f = path.join(guest.compose, 'homepage.env'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null },
    setInv: (f: () => Inventory) => { inv = f },
    calls: () => (fs.existsSync(path.join(guest.root, 'calls')) ? fs.readFileSync(path.join(guest.root, 'calls'), 'utf8') : ''),
    read: (f: string) => fs.readFileSync(path.join(guest.config, f), 'utf8'),
  }
}

const me = { email: 'admin@example.org', token: null }

test('connect: the Homepage container and its config folder come from docker inspect, not a guess', async () => {
  const t = setup()
  const det = await t.svc.detected()
  assert.equal(det.length, 1)
  assert.deepEqual(det[0].via, ['catalogue', 'proxy'])
  assert.equal(det[0].url, 'https://home.example.org', 'the public address wins')
  const i = await t.svc.connect('lxc-130', me)
  assert.equal(i.container, 'app-homepage-1')
  assert.equal(i.configDir, t.guest.config)
  assert.equal(i.composeDir, t.guest.compose)
  assert.equal(i.port, 3000)
  assert.equal(i.autoSync, false, 'auto-sync is off until someone turns it on')
  assert.equal(t.audits[0].action, 'homepage.connect')
  assert.equal((await t.svc.connect('lxc-130', me)).id, i.id, 'connecting again returns the same dashboard')
  await assert.rejects(() => t.svc.connect('lxc-130; rm -rf /', me), (e: any) => e.code === 'bad_input')
})

test('preview, then apply: a diff first; then a dated backup, the new file with the old owner and mode, and Homepage shows every entry', async () => {
  const t = setup()
  const i = await t.svc.connect('lxc-130', me)
  const before = t.read('services.yaml')
  const p = await t.svc.preview(i.id, me)
  assert.equal(t.read('services.yaml'), before, 'a preview changes nothing')
  const f = p.files.find(x => x.name === 'services.yaml')!
  assert.equal(f.changed, true)
  assert.ok(f.diff.some(l => l.op === '-' && /My First Group/.test(l.text)))
  assert.ok(f.diff.some(l => l.op === '+' && /Plex/.test(l.text)))
  assert.equal(p.files.find(x => x.name === 'widgets.yaml')!.changed, false, 'widgets.yaml already has resources and search')
  assert.deepEqual(p.counts, { Media: 1, Downloads: 1 })

  const r = await t.svc.apply(i.id, p.id, me)
  assert.deepEqual(r.wrote, ['services.yaml'])
  assert.equal(r.verify.ok, true, JSON.stringify(r.verify))
  assert.equal(t.read('services.yaml'), f.after)
  const backups = fs.readdirSync(t.guest.config).filter(n => n.startsWith('services.yaml.bak-hyperprox-'))
  assert.equal(backups.length, 1)
  assert.equal(fs.readFileSync(path.join(t.guest.config, backups[0]), 'utf8'), before, 'the backup is the old file')
  assert.equal(fs.statSync(path.join(t.guest.config, 'services.yaml')).mode & 0o777, 0o640, 'the old mode is kept')
  assert.ok(!fs.readdirSync(t.guest.config).some(n => n.includes('.hyperprox.') || n.includes('write-test')), 'no temporary file is left')
  const audit = t.audits.find(a => a.action === 'homepage.write')!
  assert.deepEqual(audit.details.files, ['services.yaml'])
  const saved = (await t.store.get(i.id))!
  assert.deepEqual(saved.state.managedGroups, ['Media', 'Downloads'])
  assert.equal(saved.lastSync!.ok, true)
  assert.match(saved.lastSync!.message, /Homepage shows all 2 entries/)
  assert.ok(!/^(restart|compose|stop|start)\b/m.test(t.calls()), 'Homepage reloads by itself: nothing is restarted')
  // The plan was used: it cannot be applied twice.
  await assert.rejects(() => t.svc.apply(i.id, p.id, me), (e: any) => e.code === 'no_plan')
})

test('apply refuses a file someone changed after the preview, and leaves it alone', async () => {
  const t = setup()
  const i = await t.svc.connect('lxc-130', me)
  const p = await t.svc.preview(i.id, me)
  fs.appendFileSync(path.join(t.guest.config, 'services.yaml'), '\n- Mine:\n    - Thing:\n        href: http://10.0.0.9\n')
  const edited = t.read('services.yaml')
  await assert.rejects(() => t.svc.apply(i.id, p.id, me), (e: any) => e instanceof HomepageRefusal && e.code === 'changed')
  assert.equal(t.read('services.yaml'), edited)
  assert.equal(fs.readdirSync(t.guest.config).filter(n => n.includes('.bak-hyperprox-')).length, 0)
  // Preview again, and the person's new group survives the write.
  const p2 = await t.svc.preview(i.id, me)
  await t.svc.apply(i.id, p2.id, me)
  assert.match(t.read('services.yaml'), /- Mine:/)
})

test('audit before acting: when the audit row cannot be written, nothing is written to the guest', async () => {
  const t = setup({ audit: async (action) => { if (action === 'homepage.write') throw new Error('audit down') } })
  const i = await t.svc.connect('lxc-130', me)
  const p = await t.svc.preview(i.id, me)
  const before = t.read('services.yaml')
  const scripts = t.guest.scripts.length
  await assert.rejects(() => t.svc.apply(i.id, p.id, me), /audit down/)
  assert.equal(t.read('services.yaml'), before)
  assert.equal(t.guest.scripts.length, scripts, 'no script was even sent')
})

test('a preview is the person\'s own, for ten minutes; one write at a time per dashboard', async () => {
  const t = setup()
  const i = await t.svc.connect('lxc-130', me)
  const p = await t.svc.preview(i.id, me)
  await assert.rejects(() => t.svc.apply(i.id, p.id, { email: 'other@example.org', token: null }), (e: any) => e.code === 'not_yours')
  await assert.rejects(() => t.svc.apply(i.id, 'nope', me), (e: any) => e.code === 'no_plan')
  t.advance(11 * 60_000)
  await assert.rejects(() => t.svc.apply(i.id, p.id, me), (e: any) => e.code === 'plan_expired')
  const a = await t.svc.preview(i.id, me), b = await t.svc.preview(i.id, me)
  const [ra, rb] = await Promise.allSettled([t.svc.apply(i.id, a.id, me), t.svc.apply(i.id, b.id, me)])
  assert.equal(ra.status, 'fulfilled')
  assert.equal(rb.status, 'rejected')
  assert.equal((rb as PromiseRejectedResult).reason.code, 'busy')
})

test('quoting: values are checked and single-quoted, file contents travel as base64, guest output is parsed strictly', () => {
  assert.throws(() => safePath("/opt/app/con'fig"), UnsafeValueError)
  assert.throws(() => safePath('/opt/../etc'), UnsafeValueError)
  assert.throws(() => safePath('relative/path'), UnsafeValueError)
  assert.throws(() => safePath('/opt/$(id)'), UnsafeValueError)
  assert.throws(() => safeContainer('a;b'), UnsafeValueError)
  assert.equal(safePath('/opt/app/config/'), '/opt/app/config')
  const evil = 'x: $(touch /tmp/pwned) `id` \'; rm -rf / #'
  const s = writeScript({ dir: '/opt/app/config', file: 'services.yaml', content: evil, expectSha: null, mode: '0644', stamp: '20260101-000000' })
  assert.ok(!s.includes('touch /tmp/pwned') && !s.includes('rm -rf /'), 'the content never appears as shell text')
  assert.ok(s.includes(Buffer.from(evil).toString('base64').slice(0, 40)))
  assert.throws(() => writeScript({ dir: '/opt/app/config', file: 'passwd' as any, content: '', expectSha: null, mode: '0644', stamp: '20260101-000000' }), UnsafeValueError)
  assert.throws(() => writeScript({ dir: '/opt/app/config', file: '.env' as any, content: '', expectSha: null, mode: '0600', stamp: '20260101-000000' }), UnsafeValueError, 'the shared .env is never written')
  assert.throws(() => writeScript({ dir: '/opt/app/config', file: 'services.yaml', content: '', expectSha: '$(id)', mode: '0644', stamp: '20260101-000000' }), UnsafeValueError)
  assert.throws(() => readScript('/opt/app', ['a b']), UnsafeValueError)
  assert.throws(() => composeUpScript('/opt/app', [], 'a;b'), UnsafeValueError)
  assert.throws(() => composeUpScript('/opt/app', ["/opt/x'y.yml"], 'homepage'), UnsafeValueError)
  // A config path or container name with shell characters in docker's answer is dropped, not used.
  const r = parseLocate("HPX_CONTAINER good-1\nHPX_CONFIG good-1 /opt/x'y\nHPX_CONTAINER bad;name\nHPX_DONE\n")
  assert.deepEqual(r.found.map(f => [f.container, f.configDir]), [['good-1', null]])
  for (const sc of [locateScript(), readScript('/opt/app', ['homepage.env']), verifyScript('c1', 3000), composeUpScript('/opt/app', ['/opt/app/docker-compose.yml'], 'homepage'), s]) {
    assertSafeScript(sc)
    assert.equal(spawnSync('bash', ['-n'], { input: sc }).status, 0, 'valid bash')
    assert.ok(!/\/tmp\/\.hyperprox|\$\$/.test(sc), 'no predictable temporary name')
  }
  assert.match(composeUpScript('/opt/app', [], 'homepage'), /up -d 'homepage'/, 'only the Homepage service is recreated')
  assert.match(composeUpScript('/opt/app', ['/opt/app/docker-compose.yml', '/opt/app/override.yml'], 'homepage'),
    /compose -f '\/opt\/app\/docker-compose\.yml' -f '\/opt\/app\/override\.yml' up -d 'homepage'/, 'every file the project was started with, in order')
  const loc = parseLocate('HPX_CONTAINER c1\nHPX_COMPOSE_FILES c1 /opt/app/a.yml,/opt/app/b.yml\nHPX_DONE\n').found[0]
  assert.deepEqual(loc.composeFiles, ['/opt/app/a.yml', '/opt/app/b.yml'])
  assert.deepEqual(parseLocate("HPX_CONTAINER c1\nHPX_COMPOSE_FILES c1 /opt/app/a.yml,/opt/x'y.yml\nHPX_DONE\n").found[0].composeFiles, [], 'one unsafe path: none used')
})

test('B9: writes never follow a symbolic link: not the file, not its backup, not the folder; temporary files come from mktemp', async () => {
  const t = setup()
  const victim = path.join(t.guest.root, 'victim')
  fs.writeFileSync(victim, 'untouched\n')
  // The file itself a link.
  fs.rmSync(path.join(t.guest.config, 'widgets.yaml'))
  fs.symlinkSync(victim, path.join(t.guest.config, 'widgets.yaml'))
  let out = spawnSync('bash', ['-s'], { input: writeScript({ dir: t.guest.config, file: 'widgets.yaml', content: 'x\n', expectSha: null, mode: '0644', stamp: '20260101-000000' }), encoding: 'utf8' }).stdout
  assert.match(out, /HPX_ERR is_link/)
  // The backup name planted as a link.
  fs.symlinkSync(victim, path.join(t.guest.config, 'services.yaml.bak-hyperprox-20260101-000001'))
  out = spawnSync('bash', ['-s'], { input: writeScript({ dir: t.guest.config, file: 'services.yaml', content: 'y\n', expectSha: sha256(SAMPLE), mode: '0644', stamp: '20260101-000001' }), encoding: 'utf8' }).stdout
  assert.match(out, /^HPX_BACKUP .*services\.yaml\.bak-hyperprox-20260101-000001-1$/m, 'the planted name is stepped round, never written through')
  assert.equal(fs.readFileSync(path.join(t.guest.config, 'services.yaml.bak-hyperprox-20260101-000001-1'), 'utf8'), SAMPLE)
  assert.equal(t.read('services.yaml'), 'y\n')
  // The folder a link.
  const linkDir = path.join(t.guest.root, 'linked')
  fs.symlinkSync(t.guest.config, linkDir)
  out = spawnSync('bash', ['-s'], { input: writeScript({ dir: linkDir, file: 'services.yaml', content: 'z\n', expectSha: sha256('y\n'), mode: '0644', stamp: '20260101-000002' }), encoding: 'utf8' }).stdout
  assert.match(out, /HPX_ERR is_link/)
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched\n')
  const ws = writeScript({ dir: '/opt/app', file: 'homepage.env', content: 'A=1\n', expectSha: null, mode: '0600', stamp: '20260101-000000' })
  assert.match(ws, /^umask 077$/m, 'a key file is written under umask 077')
  assert.match(ws, /mktemp "\$d\/\.\$f\.hyperprox\.XXXXXX"/)
  assert.match(ws, /cp -P -p -n --/)
  assert.ok(!/chmod 0644/.test(ws), 'never 0644, even briefly')
})

test('the written file round-trips byte for byte, unicode and odd characters included', async () => {
  const t = setup()
  const content = '- Gröup "x" :\n    - Ünïcode 😎 $HOME `x`:\n        href: http://10.0.0.1/?a=1&b=2\n'
  const s = writeScript({ dir: t.guest.config, file: 'services.yaml', content, expectSha: sha256(SAMPLE), mode: '0644', stamp: '20260102-030405' })
  const r = spawnSync('bash', ['-s'], { input: s, encoding: 'utf8' })
  assert.match(r.stdout, /^HPX_WROTE [0-9a-f]{64}$/m)
  assert.equal(t.read('services.yaml'), content)
  assert.ok(fs.existsSync(path.join(t.guest.config, 'services.yaml.bak-hyperprox-20260102-030405')))
})

const SONARR = 'sonarr@10.0.0.12:8989'

test('widget keys: opt-in, never for an API token, into homepage.env (0600) as HOMEPAGE_VAR values, then only Homepage is recreated', async () => {
  const t = setup({ secrets: { 'arrstack:sonarr_key': 'abc123secret' } })
  const i = await t.svc.connect('lxc-130', me)
  await assert.rejects(() => t.svc.setWidgets(i.id, [SONARR], { email: 'bot', token: 'ci' }), (e: any) => e.code === 'token_forbidden')
  await t.svc.setWidgets(i.id, [SONARR], me)
  let p = await t.svc.preview(i.id, me)
  assert.equal(p.entries.find(e => e.id === SONARR)!.offer!.pending, true)
  assert.ok(!p.files[0].after.includes('widget'))
  const keys = await t.svc.widgetKeys(i.id)
  assert.deepEqual(keys[0].vars, [{ field: 'key', name: varName(SONARR, 'key'), held: true, unknown: false, exported: false, stale: false }])
  assert.ok(!JSON.stringify(keys).includes('abc123secret'), 'the key list never carries a value')
  await assert.rejects(() => t.svc.exportKeys(i.id, { email: 'bot', token: 'ci' }), (e: any) => e.code === 'token_forbidden')
  const r = await t.svc.exportKeys(i.id, me)
  assert.deepEqual(r.written, [varName(SONARR, 'key')])
  assert.equal(r.restarted, true)
  const env = t.keyFile()!
  assert.equal(env, `${varName(SONARR, 'key')}='abc123secret'\n`, 'its own file, only HOMEPAGE_VAR values')
  assert.equal(fs.statSync(path.join(t.guest.compose, 'homepage.env')).mode & 0o777, 0o600)
  assert.equal(fs.readFileSync(path.join(t.guest.compose, '.env'), 'utf8'), 'HOMEPAGE_ALLOWED_HOSTS=10.0.0.30:3000\n', 'the shared .env is untouched')
  assert.match(t.calls(), /^compose .*up -d homepage$/m, 'only the Homepage service')
  const audit = t.audits.find(a => a.action === 'homepage.export_keys')!
  assert.ok(!JSON.stringify(audit).includes('abc123secret'), 'the audit names variables, never values')
  assert.ok(!JSON.stringify(await t.store.get(i.id)).includes('abc123secret'), 'the record keeps a hash, never the value')
  p = await t.svc.preview(i.id, me)
  const text = p.files[0].after
  assert.match(text, /widget:\n\s+type: sonarr\n\s+url: http:\/\/10\.0\.0\.12:8989\n\s+key: "?\{\{HOMEPAGE_VAR_SONARR_10_0_0_12_8989_KEY\}\}"?/)
  assert.ok(!text.includes('abc123secret'), 'services.yaml never holds a key')
})

test('B7: a rotated or removed key is noticed by its hash: the widget goes back to waiting and the problem says so', async () => {
  const t = setup({ secrets: { 'arrstack:sonarr_key': 'first-key' } })
  const i = await t.svc.connect('lxc-130', me)
  await t.svc.setWidgets(i.id, [SONARR], me)
  await t.svc.exportKeys(i.id, me)
  assert.ok((await t.svc.preview(i.id, me)).entries.find(e => e.id === SONARR)!.widget)
  t.secrets['arrstack:sonarr_key'] = 'rotated-key'
  const p = await t.svc.preview(i.id, me)
  assert.equal(p.entries.find(e => e.id === SONARR)!.widget, undefined, 'not written with a key that is no longer the vault\'s')
  assert.equal(p.entries.find(e => e.id === SONARR)!.offer!.pending, true)
  assert.ok((await t.svc.problems(i.id)).some(x => x.id === 'key_mismatch' && x.fix?.id === 'export_keys'))
  await t.svc.exportKeys(i.id, me)
  assert.match(t.keyFile()!, /'rotated-key'/)
  assert.ok(!(await t.svc.problems(i.id)).some(x => x.id === 'key_mismatch'))
  delete t.secrets['arrstack:sonarr_key']
  assert.equal((await t.svc.preview(i.id, me)).entries.find(e => e.id === SONARR)!.widget, undefined, 'a removed key: waiting again')
})

test('secrets that cannot be carried safely are refused, never written', async () => {
  const t = setup({ secrets: { 'arrstack:sonarr_key': 'abc"} evil {{HOMEPAGE_VAR_X}}' } })
  const i = await t.svc.connect('lxc-130', me)
  await t.svc.setWidgets(i.id, [SONARR], me)
  await assert.rejects(() => t.svc.exportKeys(i.id, me), (e: any) => e.code === 'unsafe_secret')
  assert.equal(t.keyFile(), null)
})

test('turning a widget off, and disconnecting, take its key off the guest; old key backups can be purged', async () => {
  const t = setup({ secrets: { 'arrstack:sonarr_key': 'k1' } })
  const i = await t.svc.connect('lxc-130', me)
  await t.svc.setWidgets(i.id, [SONARR], me)
  await t.svc.exportKeys(i.id, me)
  t.secrets['arrstack:sonarr_key'] = 'k2'
  await t.svc.exportKeys(i.id, me)
  const probs = await t.svc.problems(i.id)
  const bak = probs.find(x => x.id === 'key_backups')!
  assert.ok(bak && bak.fix!.id === 'purge_key_backups' && bak.fix!.confirm, 'old copies with keys are pointed out, with a confirm')
  assert.equal(bak.fix!.secure, true)
  await assert.rejects(() => t.svc.fix(i.id, 'purge_key_backups', me), /its own button/, 'not through the plain fix route')
  await assert.rejects(() => t.svc.purgeKeyBackups(i.id, { email: 'bot', token: 'ci' }), (e: any) => e.code === 'token_forbidden')
  assert.match((await t.svc.purgeKeyBackups(i.id, me)).message, /Deleted 1 old copy/)
  assert.equal(needsReconfirm('POST', '/api/plugins/homepage/instances/x/purge-key-backups'), true)
  assert.ok(!fs.readdirSync(t.guest.compose).some(n => n.startsWith('homepage.env.bak-hyperprox-')))
  await t.svc.setWidgets(i.id, [], me)
  assert.equal(t.keyFile(), '', 'the key is gone from the key file')
  assert.deepEqual((await t.store.get(i.id))!.exported, {})
  // Disconnect with keys on the guest: they are taken off first.
  await t.svc.setWidgets(i.id, [SONARR], me)
  await t.svc.exportKeys(i.id, me)
  const r = await t.svc.disconnect(i.id, me)
  assert.deepEqual(r.keysRemoved, [varName(SONARR, 'key')])
  assert.equal(t.keyFile(), '')
})

test('disconnect refuses to leave keys behind on a guest it cannot reach, unless forced, and then says what is left', async () => {
  const t = setup({ secrets: { 'arrstack:sonarr_key': 'k1' } })
  const i = await t.svc.connect('lxc-130', me)
  await t.svc.setWidgets(i.id, [SONARR], me)
  await t.svc.exportKeys(i.id, me)
  machine.running = false
  try {
    await assert.rejects(() => t.svc.disconnect(i.id, me), (e: any) => e.code === 'keys_remain')
    assert.ok(await t.store.get(i.id))
    const r = await t.svc.disconnect(i.id, me, true)
    assert.deepEqual(r.keysLeft, [varName(SONARR, 'key')])
    assert.equal(await t.store.get(i.id), null)
  } finally { machine.running = true }
})

test('wiring the key file: re-confirmed (its own route), homepage.env only, never the shared .env; backed up; keys then go', async () => {
  const bare = 'services:\n  homepage:\n    image: ghcr.io/gethomepage/homepage:latest\n    environment:\n      - HOMEPAGE_ALLOWED_HOSTS=${HOMEPAGE_ALLOWED_HOSTS}\n'
  assert.equal(composeReadsEnv(bare, 'app-homepage-1'), false)
  assert.equal(composeReadsEnv(COMPOSE, 'app-homepage-1'), true)
  assert.equal(composeReadsEnv(bare.replace('environment:', 'env_file: [".env"]\n    environment:'), 'app-homepage-1'), false, 'the shared .env does not count')
  const wired = wireEnv(bare, 'app-homepage-1')!
  assert.equal(composeReadsEnv(wired, 'app-homepage-1'), true)
  assert.ok(!/\.env['"]?\s*$/m.test(wired.replace(/homepage\.env/g, '')), 'no .env added')
  assert.match(wired, /HOMEPAGE_ALLOWED_HOSTS=\$\{HOMEPAGE_ALLOWED_HOSTS\}/, 'the rest of the file is kept')
  assert.equal(wireEnv(COMPOSE, 'app-homepage-1'), null)

  const t = setup({ compose: bare, secrets: { 'arrstack:sonarr_key': 'k' } })
  const i = await t.svc.connect('lxc-130', me)
  await t.svc.setWidgets(i.id, [SONARR], me)
  await assert.rejects(() => t.svc.exportKeys(i.id, me), (e: any) => e.code === 'env_not_wired')
  const probs = await t.svc.problems(i.id)
  assert.ok(probs.some(p => p.id === 'env_not_wired' && p.fix?.id === 'wire_env' && p.fix.secure))
  await assert.rejects(() => t.svc.fix(i.id, 'wire_env', me), /its own button/, 'not through the plain fix route')
  await assert.rejects(() => t.svc.wireEnv(i.id, { email: 'bot', token: 'ci' }), (e: any) => e.code === 'token_forbidden')
  const r = await t.svc.wireEnv(i.id, me)
  assert.match(r.message, /reads homepage\.env/)
  assert.equal(composeReadsEnv(fs.readFileSync(path.join(t.guest.compose, 'docker-compose.yml'), 'utf8'), 'app-homepage-1'), true)
  assert.equal(fs.statSync(path.join(t.guest.compose, 'homepage.env')).mode & 0o777, 0o600, 'the key file exists, 0600')
  assert.ok(fs.readdirSync(t.guest.compose).some(n => n.startsWith('docker-compose.yml.bak-hyperprox-')), 'backed up first')
  await t.svc.exportKeys(i.id, me)
  assert.equal(needsReconfirm('POST', '/api/plugins/homepage/instances/x/wire-env'), true)
})

test('the Proxmox widget token: read-only, recorded so it can be revoked, its secret only in the vault', async () => {
  const t = setup({ inv: () => inventory({ services: [{ key: 'proxmox', url: 'https://10.0.0.2:8006', guest: null, source: 'cluster' }] }) })
  const i = await t.svc.connect('lxc-130', me)
  await assert.rejects(() => t.svc.createProxmoxToken(i.id, { email: 'bot', token: 'ci' }), (e: any) => e.code === 'token_forbidden')
  const { tokenId } = await t.svc.createProxmoxToken(i.id, me)
  assert.match(tokenId, /^hyperprox@pve!homepage-130-/)
  const saved = (await t.store.get(i.id))!
  assert.equal(saved.proxmoxToken!.tokenId, tokenId)
  assert.ok(saved.options.widgets.includes('proxmox@10.0.0.2:8006'), 'the Proxmox widget is turned on with it')
  assert.ok(!JSON.stringify(saved).includes('tok-secret-1'), 'the record holds the id, never the secret')
  assert.equal(t.vault.get(i.id), 'tok-secret-1')
  assert.deepEqual(t.audits.find(a => a.action === 'homepage.proxmox_token.create')!.details.role, 'PVEAuditor')
  await assert.rejects(() => t.svc.createProxmoxToken(i.id, me), (e: any) => e.code === 'exists')
  await assert.rejects(() => t.svc.disconnect(i.id, me), (e: any) => e.code === 'token_live', 'not left behind on disconnect')
  await t.svc.exportKeys(i.id, me)
  assert.match(t.keyFile()!, /HOMEPAGE_VAR_PROXMOX_10_0_0_2_8006_PASSWORD='tok-secret-1'/)
  await t.svc.revokeProxmoxToken(i.id, me)
  assert.deepEqual(t.tokens, [])
  assert.equal(t.vault.has(i.id), false)
  assert.equal((await t.store.get(i.id))!.proxmoxToken, null)
  assert.ok(!t.keyFile()!.includes('tok-secret-1'), 'the revoked token\'s values are taken off the guest')
  assert.deepEqual((await t.store.get(i.id))!.exported, {})
  await t.svc.disconnect(i.id, me)
})

test('B6: a token that is already gone counts as revoked, so the dashboard can still be disconnected', async () => {
  const t = setup({ inv: () => inventory({ services: [{ key: 'proxmox', url: 'https://10.0.0.2:8006', guest: null, source: 'cluster' }] }),
    revoke: async (id) => { throw new Error(`Proxmox DELETE /access/users/x/token/y: HTTP 500 — no such token '${id.split('!')[1]}' for user 'hyperprox@pve'`) } })
  const i = await t.svc.connect('lxc-130', me)
  await t.svc.createProxmoxToken(i.id, me)
  await t.svc.revokeProxmoxToken(i.id, me)
  assert.equal((await t.store.get(i.id))!.proxmoxToken, null)
  await t.svc.disconnect(i.id, me)
  // Any other failure is not swallowed.
  const t2 = setup({ inv: () => inventory({ services: [{ key: 'proxmox', url: 'https://10.0.0.2:8006', guest: null, source: 'cluster' }] }), revoke: async () => { throw new Error('HTTP 403 permission check failed') } })
  const j = await t2.svc.connect('lxc-130', me)
  await t2.svc.createProxmoxToken(j.id, me)
  await assert.rejects(() => t2.svc.revokeProxmoxToken(j.id, me), /403/)
  assert.ok((await t2.store.get(j.id))!.proxmoxToken)
})

test('createProxmoxToken: when the record cannot be saved, the new token is revoked again and its secret dropped', async () => {
  let fail = false
  const t = setup({ inv: () => inventory({ services: [{ key: 'proxmox', url: 'https://10.0.0.2:8006', guest: null, source: 'cluster' }] }),
    put: async (i) => { if (fail && i.proxmoxToken) throw new Error('store down') } })
  const i = await t.svc.connect('lxc-130', me)
  fail = true
  await assert.rejects(() => t.svc.createProxmoxToken(i.id, me), /store down/)
  assert.deepEqual(t.tokens, [], 'no token left behind')
  assert.equal(t.vault.has(i.id), false)
})

test('B1: auto-sync never writes from a partial inventory; a manual apply asks for "apply anyway", never without exclusions', async () => {
  const t = setup()
  const i = await t.svc.connect('lxc-130', me)
  await t.svc.saveSettings(i.id, { autoSync: true }, me)
  for (const src of ['guests', 'exclusions', 'scan', 'proxies', 'plugins'] as const) {
    t.setInv(() => inventory({ services: [], failed: [src], errors: [`${src}: down`] }))
    assert.equal((await t.svc.tick())[0].did, 'partial', src)
    assert.equal(t.read('services.yaml'), SAMPLE, `${src}: nothing written`)
  }
  await t.svc.saveSettings(i.id, { autoSync: false }, me)
  t.setInv(() => inventory({ failed: ['scan'], errors: ['Service scan: down'] }))
  let p = await t.svc.preview(i.id, me)
  assert.deepEqual(p.failed, ['scan'])
  await assert.rejects(() => t.svc.apply(i.id, p.id, me), (e: any) => e.code === 'partial_inventory')
  p = await t.svc.preview(i.id, me)
  await t.svc.apply(i.id, p.id, me, { applyAnyway: true })
  assert.match(t.read('services.yaml'), /Plex/)
  assert.equal(t.audits.filter(a => a.action === 'homepage.write').at(-1)!.details.applyAnyway, true)
  t.setInv(() => inventory({ failed: ['exclusions'], errors: ['exclusions: down'] }))
  p = await t.svc.preview(i.id, me)
  await assert.rejects(() => t.svc.apply(i.id, p.id, me, { applyAnyway: true }), (e: any) => e.code === 'exclusions_unknown', 'never without exclusions')
})

test('B2: a guest on Remote access\'s exclusion list is never contacted, and an unreadable list contacts nothing', async () => {
  const t = setup()
  const i = await t.svc.connect('lxc-130', me)
  const sent = t.guest.scripts.length
  t.setExcluded(['lxc-130'])
  assert.deepEqual(await t.svc.detected(), [], 'not offered')
  await assert.rejects(() => t.svc.preview(i.id, me), (e: any) => e.code === 'excluded')
  await assert.rejects(() => t.svc.connect('lxc-130', me, 'other'), (e: any) => e.code === 'excluded')
  assert.equal((await t.svc.problems(i.id))[0].id, 'excluded')
  await t.svc.saveSettings(i.id, { autoSync: true }, me)
  assert.equal((await t.svc.tick())[0].did, 'failed')
  t.setExcluded(null)
  await assert.rejects(() => t.svc.preview(i.id, me), (e: any) => e.code === 'exclusions_unknown')
  await assert.rejects(() => t.svc.detected(), (e: any) => e.code === 'exclusions_unknown')
  assert.equal(t.guest.scripts.length, sent, 'not one script was sent to the excluded guest')
})

test('auto-sync: off by default; on, it writes when the inventory changes, at most every ten minutes, and only real changes', async () => {
  const t = setup()
  const i = await t.svc.connect('lxc-130', me)
  assert.deepEqual(await t.svc.tick(), [{ id: i.id, did: 'off' }])
  assert.equal(t.read('services.yaml'), SAMPLE)
  await t.svc.saveSettings(i.id, { autoSync: true }, me)
  assert.equal((await t.svc.tick())[0].did, 'wrote')
  assert.match(t.read('services.yaml'), /Plex/)
  assert.equal((await t.svc.tick())[0].did, 'same', 'nothing changed in the inventory')
  t.setInv(() => inventory({ services: [...inventory().services, { key: 'radarr', url: 'http://10.0.0.12:7878', guest: null, source: 'scan' }] }))
  assert.equal((await t.svc.tick())[0].did, 'soon')
  t.advance(AUTO_MIN_GAP_MS + 1)
  assert.equal((await t.svc.tick())[0].did, 'wrote')
  assert.match(t.read('services.yaml'), /Radarr/)
  t.advance(AUTO_MIN_GAP_MS + 1)
  const inv2 = inventory({ services: [...inventory().services, { key: 'radarr', url: 'http://10.0.0.12:7878', guest: null, source: 'scan' }] })
  inv2.guests.push({ vmid: 150, name: 'quiet', node: 'node1', type: 'lxc', status: 'running', tags: [], addresses: ['10.0.0.50'], machineId: 'lxc-150' })
  t.setInv(() => inv2)
  const backups = fs.readdirSync(t.guest.config).filter(n => n.includes('.bak-hyperprox-')).length
  assert.equal((await t.svc.tick())[0].did, 'unchanged')
  assert.equal(fs.readdirSync(t.guest.config).filter(n => n.includes('.bak-hyperprox-')).length, backups)
  // Settings clear the fingerprint, so a changed setting is written on the next pass.
  await t.svc.saveSettings(i.id, { hiddenEntries: ['plex@10.0.0.11:32400'] }, me)
  assert.equal((await t.store.get(i.id))!.lastFingerprint, null)
  t.advance(AUTO_MIN_GAP_MS + 1)
  assert.equal((await t.svc.tick())[0].did, 'wrote')
  assert.ok(!/Plex/.test(t.read('services.yaml')))
})

test('tick reads the record again once it holds the lock: turned off in between, it does not write', async () => {
  const t = setup()
  const i = await t.svc.connect('lxc-130', me)
  await t.svc.saveSettings(i.id, { autoSync: true }, me)
  // The list read at the start of the pass says on; the record says off by the time the lock is held.
  const list = t.store.list
  t.store.list = async () => { const l = await list(); const r = t.store.rows.get(i.id)!; t.store.rows.set(i.id, { ...r, autoSync: false }); return l }
  assert.equal((await t.svc.tick())[0].did, 'off')
  assert.equal(t.read('services.yaml'), SAMPLE)
})

test('B5: a deleted twin group is remembered by its base name', async () => {
  const own = yaml.dump([{ Media: [{ 'My Films': { href: 'http://10.0.0.60' } }] }])
  const t = setup()
  fs.writeFileSync(path.join(t.guest.config, 'services.yaml'), own)
  const i = await t.svc.connect('lxc-130', me)
  await t.svc.apply(i.id, (await t.svc.preview(i.id, me)).id, me)
  assert.match(t.read('services.yaml'), /Media \(HyperProx\)/)
  const doc = (yaml.load(t.read('services.yaml')) as any[]).filter(x => !x['Media (HyperProx)'])
  fs.writeFileSync(path.join(t.guest.config, 'services.yaml'), yaml.dump(doc))
  await t.svc.apply(i.id, (await t.svc.preview(i.id, me)).id, me)
  assert.deepEqual((await t.store.get(i.id))!.options.hiddenGroups, ['Media'])
  assert.ok(!/Media \(HyperProx\)/.test(t.read('services.yaml')))
})

test('taking a group over: it becomes the person\'s and is never written again', async () => {
  const t = setup()
  const i = await t.svc.connect('lxc-130', me)
  await t.svc.apply(i.id, (await t.svc.preview(i.id, me)).id, me)
  await assert.rejects(() => t.svc.saveSettings(i.id, { takeOver: 'Nope' }, me), (e: any) => e.code === 'bad_input')
  await t.svc.saveSettings(i.id, { takeOver: 'Media' }, me)
  const doc = yaml.load(t.read('services.yaml')) as any[]
  doc.find(x => x.Media).Media[0].Plex.href = 'http://mine'
  fs.writeFileSync(path.join(t.guest.config, 'services.yaml'), yaml.dump(doc))
  await t.svc.apply(i.id, (await t.svc.preview(i.id, me)).id, me)
  const back = yaml.load(t.read('services.yaml')) as any[]
  assert.equal(back.find(x => x.Media).Media[0].Plex.href, 'http://mine')
  assert.ok(!back.some(x => x['Media (HyperProx)']))
})

test('an API token\'s preview is owned by, and audited as, the token: a person cannot apply it, nor the token a person\'s', async () => {
  const t = setup()
  const i = await t.svc.connect('lxc-130', me)
  const bot = { email: 'admin@example.org', token: 'ci' }
  const p = await t.svc.preview(i.id, bot)
  assert.equal(p.owner, 'admin@example.org (API token ci)')
  await assert.rejects(() => t.svc.apply(i.id, p.id, me), (e: any) => e.code === 'not_yours')
  const q = await t.svc.preview(i.id, me)
  await assert.rejects(() => t.svc.apply(i.id, q.id, bot), (e: any) => e.code === 'not_yours')
  await t.svc.apply(i.id, (await t.svc.preview(i.id, bot)).id, bot)
  assert.equal(t.audits.find(a => a.action === 'homepage.write')!.details.by, 'admin@example.org (API token ci)')
})

test('connect is one at a time per guest', async () => {
  const t = setup()
  const [a, b] = await Promise.allSettled([t.svc.connect('lxc-130', me), t.svc.connect('lxc-130', me)])
  assert.equal(a.status, 'fulfilled')
  assert.ok(b.status === 'rejected' && (b as PromiseRejectedResult).reason.code === 'busy')
  assert.equal((await t.store.list()).length, 1)
})

test('problems and fixes: invalid YAML is found and can be started fresh with a backup; a stopped Homepage can be started', async () => {
  const t = setup()
  const i = await t.svc.connect('lxc-130', me)
  assert.deepEqual((await t.svc.problems(i.id)).map(p => p.id), [])
  fs.writeFileSync(path.join(t.guest.config, 'services.yaml'), '- a: [unclosed\n')
  fs.writeFileSync(path.join(t.guest.root, 'state'), 'exited\n')
  const probs = await t.svc.problems(i.id)
  assert.deepEqual(probs.map(p => p.id).sort(), ['stopped', 'yaml_invalid'])
  assert.equal(probs.find(p => p.id === 'yaml_invalid')!.fix!.id, 'reset_services')
  await assert.rejects(() => t.svc.preview(i.id, me), (e: any) => e.code === 'yaml_invalid', 'no preview over a broken file')
  const r = await t.svc.fix(i.id, 'reset_services', me)
  assert.match(r.message, /old one is at .*services\.yaml\.bak-hyperprox-/)
  assert.match(t.read('services.yaml'), /Plex/)
  assert.match((await t.svc.fix(i.id, 'start', me)).message, /starting/)
  assert.match(t.calls(), /^restart app-homepage-1$/m)
  await assert.rejects(() => t.svc.fix(i.id, 'rm -rf', me), (e: any) => e.code === 'bad_input')
  await assert.rejects(() => t.svc.fix(i.id, 'export_keys', me), /its own button/)
  assert.deepEqual(t.audits.filter(a => a.action === 'homepage.fix').map(a => a.details.fix), ['reset_services', 'start'])
})

test('settings: subnets checked, lists bounded, the tagged guest refused', async () => {
  const t = setup()
  const i = await t.svc.connect('lxc-130', me)
  await assert.rejects(() => t.svc.saveSettings(i.id, { excludeSubnets: ['10.0.0.0/33'] }, me), (e: any) => e.code === 'bad_input')
  await assert.rejects(() => t.svc.saveSettings(i.id, { excludeSubnets: ['not a cidr'] }, me), (e: any) => e.code === 'bad_input')
  const s = await t.svc.saveSettings(i.id, { excludeSubnets: ['10.0.0.0/24', '10.0.0.0/24'], includeBareGuests: true }, me)
  assert.deepEqual(s.options.excludeSubnets, ['10.0.0.0/24'])
  const p = await t.svc.preview(i.id, me)
  assert.ok(!p.entries.some(e => /10\.0\.0\./.test(e.href ?? '')), 'the excluded subnet is left out')
  machine.tags = ['hyperprox-ignore']
  try { await assert.rejects(() => t.svc.preview(i.id, me), (e: any) => e.code === 'excluded') } finally { machine.tags = [] }
})

test('roles: every Homepage route is admin; widgets, keys, key-file wiring and the token are also confirmed on the page', () => {
  const B = '/api/plugins/homepage'
  for (const [m, p] of [['GET', `${B}/installs`], ['GET', `${B}/instances/x/preview`], ['POST', `${B}/instances/x/apply`], ['GET', `${B}/instances/x/problems`], ['PUT', `${B}/instances/x/settings`], ['POST', `${B}/instances`], ['POST', `${B}/instances/x/wire-env`]]) {
    assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
  }
  assert.equal(requiredRole('GET', '/api/plugins/homepage/data'), 'viewer', 'the gallery card stays a viewer read')
  for (const [m, p] of [['PUT', `${B}/instances/x/widgets`], ['POST', `${B}/instances/x/secrets`], ['POST', `${B}/instances/x/proxmox-token`], ['DELETE', `${B}/instances/x/proxmox-token`], ['POST', `${B}/instances/x/wire-env`]]) {
    assert.equal(needsReconfirm(m, p), true, `${m} ${p}`)
  }
  for (const [m, p] of [['POST', `${B}/instances/x/apply`], ['GET', `${B}/instances/x/preview`], ['PUT', `${B}/instances/x/settings`]]) {
    assert.equal(needsReconfirm(m, p), false, `${m} ${p}: links and status only, no secret leaves`)
  }
})

test('the gallery card: not configured, in sync, needs a look', () => {
  assert.throws(() => tileOf([]), /Not configured yet/)
  const ok = tileOf([{ id: 'a', name: 'homepage', url: null, autoSync: true, entries: 12, lastSync: { at: 1, ok: true, message: 'x' } }])
  assert.equal(ok.tone, 'good'); assert.equal(ok.headline, '12 entries, auto-sync on')
  const bad = tileOf([{ id: 'a', name: 'homepage', url: null, autoSync: false, entries: 0, lastSync: { at: 1, ok: false, message: 'services.yaml: changed' } }])
  assert.equal(bad.tone, 'bad')
})

test('B1: neither apply nor "start it fresh" writes without the guest list, "apply anyway" or not; the rest needs "apply anyway"', async () => {
  const t = setup()
  const i = await t.svc.connect('lxc-130', me)
  t.setInv(() => inventory({ failed: ['guests'], errors: ['Proxmox guests: down'] }))
  const p = await t.svc.preview(i.id, me)
  assert.ok(!p.entries.some(e => e.guest), 'without the guest list nothing tied to a guest is shown')
  await assert.rejects(() => t.svc.apply(i.id, p.id, me, { applyAnyway: true }), (e: any) => e.code === 'exclusions_unknown')
  fs.writeFileSync(path.join(t.guest.config, 'services.yaml'), '- a: [unclosed\n')
  for (const failed of [['guests'], ['exclusions']] as const) {
    t.setInv(() => inventory({ failed: [...failed], errors: ['down'] }))
    await assert.rejects(() => t.svc.fix(i.id, 'reset_services', me, { applyAnyway: true }), (e: any) => e.code === 'exclusions_unknown', failed[0])
  }
  t.setInv(() => inventory({ failed: ['plugins'], errors: ['Plug-ins: vault locked'] }))
  await assert.rejects(() => t.svc.fix(i.id, 'reset_services', me), (e: any) => e.code === 'partial_inventory')
  assert.equal(t.read('services.yaml'), '- a: [unclosed\n', 'nothing written')
  assert.match((await t.svc.fix(i.id, 'reset_services', me, { applyAnyway: true })).message, /started fresh/)
})

test('an unreadable vault is "unknown", not a rotated key: the widget stays, and no key is written from it', async () => {
  const t = setup({ secrets: { 'arrstack:sonarr_key': 'k1' } })
  const i = await t.svc.connect('lxc-130', me)
  await t.svc.setWidgets(i.id, [SONARR], me)
  await t.svc.exportKeys(i.id, me)
  const realSecret = (t.svc as any).d.secret
  ;(t.svc as any).d.secret = async () => { throw new Error('VaultLockedError') }
  try {
    const p = await t.svc.preview(i.id, me)
    assert.ok(p.entries.find(e => e.id === SONARR)!.widget, 'still written: the key on the guest is taken as it was')
    assert.ok(!(await t.svc.problems(i.id)).some(x => x.id === 'key_mismatch'))
    await assert.rejects(() => t.svc.exportKeys(i.id, me), (e: any) => e.code === 'vault_unreadable')
    assert.match(t.keyFile()!, /'k1'/)
  } finally { (t.svc as any).d.secret = realSecret }
})

test('turning a widget off: its key comes off first; a guest that cannot be reached keeps the old choice unless forced', async () => {
  const t = setup({ secrets: { 'arrstack:sonarr_key': 'k1' } })
  const i = await t.svc.connect('lxc-130', me)
  await t.svc.setWidgets(i.id, [SONARR], me)
  await t.svc.exportKeys(i.id, me)
  machine.running = false
  try {
    await assert.rejects(() => t.svc.setWidgets(i.id, [], me), (e: any) => e.code === 'keys_remain')
    assert.deepEqual((await t.store.get(i.id))!.options.widgets, [SONARR], 'nothing was changed')
    const r = await t.svc.setWidgets(i.id, [], me, true)
    assert.deepEqual(r.options.widgets, [])
    assert.deepEqual(r.exported, {})
  } finally { machine.running = true }
  assert.match(t.keyFile()!, /'k1'/, 'forced: the key was left there, as the answer said')
})

test('wiring: a one-line text edit that keeps every other byte; anything not simple is refused with the line to add', () => {
  const cmt = '# my stack\nservices:\n  # the dashboard\n  homepage:\n    image: "ghcr.io/gethomepage/homepage:latest"   # pinned later\n    ports: ["3000:3000"]\n  other:\n    image: nginx\n'
  const out = wireEnvText(cmt, 'homepage')!
  assert.equal(out, cmt.replace('  homepage:\n', '  homepage:\n    env_file: [homepage.env]\n'), 'exactly one line added')
  assert.equal(composeReadsEnv(out, 'app-homepage-1'), true)
  assert.equal(wireEnvText(out, 'homepage'), null)
  for (const odd of [
    'services: { homepage: { image: ghcr.io/gethomepage/homepage } }\n',
    'services:\n  homepage:\n    image: x\n    env_file: [.env]\n',
    'x: &a\n  image: ghcr.io/gethomepage/homepage\nservices:\n  homepage: *a\n',
  ]) assert.throws(() => wireEnvText(odd, 'homepage'), (e: any) => e.code === 'manual_edit' && e.message.includes(WIRE_SNIPPET), odd)
})

test('the Catalogue recipe: plain env_file (any Compose version), the key file created empty at 0600 before start', async () => {
  const { findRecipe } = await import('../src/lib/catalogue')
  const { installScript } = await import('../src/lib/install-script')
  const r = findRecipe('homepage')!
  assert.match((r.install as any).compose, /env_file: \[homepage\.env\]/)
  assert.ok(!/required:/.test((r.install as any).compose))
  const sc = installScript(r, 'debian', { HOMEPAGE_ALLOWED_HOSTS: '10.0.0.30:3000' } as any)
  assert.ok(sc.indexOf('[ -e homepage.env ] || ( umask 077 && : > homepage.env )') < sc.indexOf('docker compose up -d'))
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hpx-pf-'))
  spawnSync('bash', ['-c', '[ -e homepage.env ] || ( umask 077 && : > homepage.env )'], { cwd: d })
  assert.equal(fs.statSync(path.join(d, 'homepage.env')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(d, 'homepage.env')).size, 0)
})

test('R2: take the twin over, disconnect, reconnect: HyperProx never writes a second group of the same name', async () => {
  const own = yaml.dump([{ Media: [{ 'My Films': { href: 'http://10.0.0.60' } }] }])
  const t = setup({ inv: () => inventory({ services: [...inventory().services, { key: 'jellyfin', url: 'http://10.0.0.21:8096', guest: null, source: 'scan' }] }) })
  fs.writeFileSync(path.join(t.guest.config, 'services.yaml'), own)
  let i = await t.svc.connect('lxc-130', me)
  await t.svc.apply(i.id, (await t.svc.preview(i.id, me)).id, me)
  await t.svc.saveSettings(i.id, { takeOver: 'Media (HyperProx)' }, me)
  assert.deepEqual((await t.store.get(i.id))!.state.released, ['Media (HyperProx)'], 'released by its exact name')
  await t.svc.apply(i.id, (await t.svc.preview(i.id, me)).id, me)
  await t.svc.disconnect(i.id, me)
  i = await t.svc.connect('lxc-130', me)
  await t.svc.apply(i.id, (await t.svc.preview(i.id, me)).id, me)
  const names = (yaml.load(t.read('services.yaml')) as any[]).map(x => Object.keys(x)[0])
  assert.equal(new Set(names).size, names.length, names.join(', '))
  assert.deepEqual((yaml.load(t.read('services.yaml')) as any[]).find(x => x.Media).Media, [{ 'My Films': { href: 'http://10.0.0.60' } }])
  // And handing back the released twin of a connected dashboard takes back exactly that group.
  await t.svc.saveSettings(i.id, { takeOver: (await t.store.get(i.id))!.state.managedGroups.find(g => g.startsWith('Media'))! }, me)
  const rel = (await t.store.get(i.id))!.state.released![0]
  await assert.rejects(() => t.svc.saveSettings(i.id, { manageAgain: 'Media' }, me), (e: any) => e.code === 'bad_input', 'the person\'s own group cannot be "handed back"')
  await t.svc.saveSettings(i.id, { manageAgain: rel }, me)
  await t.svc.apply(i.id, (await t.svc.preview(i.id, me)).id, me)
  assert.deepEqual((yaml.load(t.read('services.yaml')) as any[]).find(x => x.Media).Media, [{ 'My Films': { href: 'http://10.0.0.60' } }], 'still untouched')
  assert.ok(!(await t.store.get(i.id))!.state.managedGroups.includes('Media'))
})

test('compose files: an unsafe path in Docker\'s record is refused, never replaced by a guessed docker-compose.yml', async () => {
  const t = setup({ secrets: { 'arrstack:sonarr_key': 'k1' } })
  const i = await t.svc.connect('lxc-130', me)
  await t.svc.setWidgets(i.id, [SONARR], me)
  const rec = (await t.store.get(i.id))!
  await t.store.put({ ...rec, composeFiles: [], composeFile: null })
  await assert.rejects(() => t.svc.exportKeys(i.id, me), (e: any) => e.code === 'compose_unknown')
  await assert.rejects(() => t.svc.wireEnv(i.id, me), (e: any) => e.code === 'compose_unknown')
  assert.equal(t.keyFile(), null, 'nothing written')
  assert.ok(!/^compose /m.test(t.calls()), 'compose never run')
})

// ── auto-connect (lib/auto-connect) ──────────────────────────────────────────

const acx = (o: Partial<AdapterContext> = {}): AdapterContext => ({
  dismissed: () => false, autoConnectedBefore: () => false, excludedMachines: new Set(), excludedSubnets: [], vaultItems: () => [], audit: async () => {}, now: () => 0, ...o,
})

test('auto-connect: a found Homepage is connected by itself, audited as the system, and a sample config gets its first fill with a backup', async () => {
  const t = setup()
  const out = await t.svc.autoConnect(acx())
  assert.equal(out.length, 1)
  assert.equal(out[0].did, 'connected')
  const [i] = await t.svc.instances()
  assert.equal(i.addedBy, SYSTEM_ACTOR)
  assert.equal(i.autoSync, false, 'auto-sync stays off')
  assert.deepEqual(i.autoConnected?.evidence, ['found by catalogue', 'found by proxy'])
  const row = t.audits.find(a => a.action === 'homepage.auto_connect')!
  assert.equal(row.details.by, SYSTEM_ACTOR)
  assert.equal(i.autoConnected?.firstFill?.reason, 'sample')
  assert.ok(t.read('services.yaml').startsWith(MANAGED_MARK))
  assert.equal(fs.readdirSync(t.guest.config).filter(n => n.startsWith('services.yaml.bak-hyperprox-')).length, 1, 'the sample is backed up')
  // Already connected: the next pass changes nothing.
  const n = t.audits.length
  assert.equal((await t.svc.autoConnect(acx()))[0].did, 'present')
  assert.equal(t.audits.length, n)
})

test('auto-connect: a services.yaml with the person\'s own groups is connected but never written; the page shows the diff and Apply', async () => {
  const t = setup()
  const mine = '---\n- Mine:\n    - Router:\n        href: http://10.0.0.1/\n'
  fs.writeFileSync(path.join(t.guest.config, 'services.yaml'), mine)
  assert.equal((await t.svc.autoConnect(acx()))[0].did, 'connected')
  assert.equal(t.read('services.yaml'), mine)
  assert.ok(!t.audits.some(a => a.action === 'homepage.write'))
  const [i] = await t.svc.instances()
  assert.equal(i.autoConnected?.firstFill?.reason, 'person')
  // The manual path is unchanged: a preview, then Apply.
  const p = await t.svc.preview(i.id, me)
  assert.ok(p.files.find(f => f.name === 'services.yaml')!.changed)
})

test('auto-connect: a file that is exactly HyperProx\'s own earlier write gets the first fill too; one with a person\'s edit does not', async () => {
  const t = setup()
  await t.svc.autoConnect(acx())
  const own = t.read('services.yaml')
  // The record goes (a reinstall of HyperProx, say), the file stays as HyperProx wrote it.
  for (const i of await t.svc.instances()) await t.store.delete(i.id)
  await t.svc.autoConnect(acx())
  assert.equal((await t.svc.instances())[0].autoConnected?.firstFill?.reason, 'own')
  assert.equal(t.read('services.yaml'), own)
  // Edited by a person (an entry added to a HyperProx group): left for them.
  for (const i of await t.svc.instances()) await t.store.delete(i.id)
  fs.writeFileSync(path.join(t.guest.config, 'services.yaml'), own.replace(/^(- [^\n]+:\n)/m, '$1    - Added by me:\n        href: http://10.0.0.9/\n'))
  await t.svc.autoConnect(acx())
  assert.equal((await t.svc.instances())[0].autoConnected?.firstFill?.reason, 'person')
})

test('auto-connect: never an excluded guest, a guest on an excluded subnet, a dismissed one, or while the exclusion list is unknown', async () => {
  const t = setup()
  t.setExcluded(['lxc-130'])
  assert.deepEqual(await t.svc.autoConnect(acx()), [], 'the exclusion list hides it from detection altogether')
  t.setExcluded([])
  ;(machine as any).address = '10.0.0.30'
  try { assert.equal((await t.svc.autoConnect(acx({ excludedSubnets: ['10.0.0.0/24'] })))[0].did, 'excluded') } finally { delete (machine as any).address }
  assert.equal((await t.svc.autoConnect(acx({ dismissed: k => k === 'lxc-130' })))[0].did, 'dismissed')
  t.setExcluded(null)
  await assert.rejects(t.svc.autoConnect(acx()), (e: any) => e.code === 'exclusions_unknown')
  assert.equal((await t.svc.instances()).length, 0)
  assert.ok(!t.audits.some(a => a.action === 'homepage.auto_connect'))
})

test('auto-connect: a person\'s disconnect is remembered (before the record goes) so the dashboard is not added back', async () => {
  const t = setup()
  const remembered: string[] = []
  ;(t.svc as any).d.dismissed = async (id: string) => { remembered.push(id) }
  const [o] = await t.svc.autoConnect(acx())
  assert.equal(o.did, 'connected')
  const [i] = await t.svc.instances()
  await t.svc.disconnect(i.id, me)
  assert.deepEqual(remembered, ['lxc-130'])
  // Not remembered (the store is down): not disconnected either.
  const t2 = setup()
  ;(t2.svc as any).d.dismissed = async () => { throw new Error('store down') }
  await t2.svc.autoConnect(acx())
  const [i2] = await t2.svc.instances()
  await assert.rejects(t2.svc.disconnect(i2.id, me), /store down/)
  assert.equal((await t2.svc.instances()).length, 1)
})

test('first fill rule: only missing, empty, the sample, or HyperProx\'s own file; never with a source missing', () => {
  const notes = { keptUserGroups: [], keptUserEntries: [], keptEdits: [], userRemovedGroups: [], renamed: [], droppedSamples: false, adopted: [] }
  const f = (text: string, exists = true) => ({ name: 'services.yaml', exists, text, sha: null, owner: null, mode: null })
  assert.equal(firstFillReason(undefined, { notes, failed: [] }), 'missing')
  assert.equal(firstFillReason(f('  \n'), { notes, failed: [] }), 'missing')
  assert.equal(firstFillReason(f(SAMPLE), { notes: { ...notes, droppedSamples: true }, failed: [] }), 'sample')
  assert.equal(firstFillReason(f(`${MANAGED_MARK}\n- A:\n`), { notes, failed: [] }), 'own')
  assert.equal(firstFillReason(f(`${MANAGED_MARK}\n- A:\n`), { notes: { ...notes, keptUserGroups: ['Mine'] }, failed: [] }), null)
  assert.equal(firstFillReason(f('- Mine:\n'), { notes, failed: [] }), null)
  assert.equal(firstFillReason(undefined, { notes, failed: ['scan'] }), null)
})

test('G3: a pick is refused for a guest that is excluded (list, tag or subnet) or dismissed by the time it is made', async () => {
  const t = setup()
  await assert.rejects(t.svc.autoPick('lxc-130', 'app-homepage-1', acx({ excludedMachines: new Set(['lxc-130']) })), (e: any) => e.code === 'excluded')
  await assert.rejects(t.svc.autoPick('lxc-130', 'app-homepage-1', acx({ dismissed: k => k === 'lxc-130' })), (e: any) => e.code === 'excluded')
  ;(machine as any).address = '10.0.0.30'
  try { await assert.rejects(t.svc.autoPick('lxc-130', 'app-homepage-1', acx({ excludedSubnets: ['10.0.0.0/24'] })), (e: any) => e.code === 'excluded') }
  finally { delete (machine as any).address }
  assert.equal((await t.svc.instances()).length, 0)
  assert.equal((await t.svc.autoPick('lxc-130', 'app-homepage-1', acx())).did, 'connected')
})

test('removed guest: forgetting a dashboard revokes its Proxmox token, empties its vault item, keeps no dismissal and runs nothing in the guest', async () => {
  const t = setup({ inv: () => inventory({ services: [{ key: 'proxmox', url: 'https://10.0.0.2:8006', guest: null, source: 'cluster' }] }) })
  const remembered: string[] = []
  ;(t.svc as any).d.dismissed = async (id: string) => { remembered.push(id) }
  // An invented guest for this test (the shared fixture's machine, under another ID).
  ;(t.svc as any).d.exec.listMachines = async () => [{ ...machine, id: 'lxc-9105', vmid: 9105 }]
  const i = await t.svc.connect('lxc-9105', me)
  assert.equal(i.vmid, 9105)
  await t.svc.createProxmoxToken(i.id, me)
  const scripts = t.guest.scripts.length
  const words = await t.svc.forgetRemoved(i.id, 'admin@example.org')
  assert.match(words, /Homepage forgot homepage, and its Proxmox token was revoked/)
  assert.deepEqual(t.tokens, [])
  assert.equal(t.vault.has(i.id), false)
  assert.equal(await t.store.get(i.id), null)
  assert.deepEqual(remembered, [], 'a new Homepage on that ID connects by itself')
  assert.equal(t.guest.scripts.length, scripts, 'the guest is gone: nothing is run in it')
  assert.ok(t.audits.some(a => a.action === 'homepage.forget_removed'))
})
