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
import { HomepageService, HomepageRefusal, composeReadsEnv, wireEnv, AUTO_MIN_GAP_MS, type HomepageDeps, type HomepageInstance, type RecordStore } from '../src/lib/homepage/service'
import {
  locateScript, readScript, writeScript, verifyScript, composeUpScript, parseLocate, safePath, safeContainer, sha256, UnsafeValueError,
} from '../src/lib/homepage/remote'
import { varName } from '../src/lib/homepage/generate'
import { tileOf } from '../src/plugins/homepage'
import { assertSafeScript } from '../src/lib/clusters/script-guard'
import { requiredRole, needsReconfirm } from '../src/lib/roles'
import type { Inventory } from '../src/lib/homepage/types'
import type { Machine } from '../src/lib/remote/types'

const SAMPLE = `---\n# For configuration options and examples, please see:\n# https://gethomepage.dev/configs/services/\n\n- My First Group:\n    - My First Service:\n        href: http://localhost/\n        description: Homepage is awesome\n\n- My Second Group:\n    - My Second Service:\n        href: http://localhost/\n        description: Homepage is the best\n\n- My Third Group:\n    - My Third Service:\n        href: http://localhost/\n        description: Homepage is cool\n`
const WIDGETS = `---\n- resources:\n    cpu: true\n- search:\n    provider: duckduckgo\n`
const COMPOSE = `services:\n  homepage:\n    image: ghcr.io/gethomepage/homepage:latest\n    volumes: ["./config:/app/config"]\n    env_file: [".env"]\n`

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
    sites: [], excludedMachineIds: [], builtAt: 0, errors: [], ...extra,
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

function setup(o: { inv?: () => Inventory; audit?: HomepageDeps['audit']; compose?: string; secrets?: Record<string, string> } = {}) {
  const guest = makeGuest({ compose: o.compose })
  const audits: Array<{ action: string; details: Record<string, unknown> }> = []
  let now = 1_700_000_000_000
  let inv = o.inv ?? (() => inventory())
  const tokens: string[] = []
  const vault = new Map<string, string>()
  const store = memStore()
  const deps: HomepageDeps = {
    store,
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
    secret: async (src, iid) => src.kind === 'plugin' ? (o.secrets ?? {})[`${src.plugin}:${src.setting}`] ?? null
      : src.part === 'id' ? (await store.get(iid))?.proxmoxToken?.tokenId ?? null : vault.get(iid) ?? null,
    proxmox: {
      createAuditorToken: async (name) => { tokens.push(name); return { tokenId: `hyperprox@pve!${name}`, secret: 'tok-secret-1' } },
      revokeToken: async (id) => { tokens.splice(tokens.indexOf(id.split('!')[1]), 1) },
      saveSecret: async (iid, s) => { if (s === null) vault.delete(iid); else vault.set(iid, s) },
    },
    audit: o.audit ?? (async (action, _r, details) => { audits.push({ action, details }) }),
    now: () => now,
  }
  const svc = new HomepageService(deps)
  return {
    svc, guest, audits, store, tokens, vault,
    advance: (ms: number) => { now += ms },
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
  assert.throws(() => writeScript({ dir: '/opt/app/config', file: 'services.yaml', content: '', expectSha: '$(id)', mode: '0644', stamp: '20260101-000000' }), UnsafeValueError)
  assert.throws(() => readScript('/opt/app', ['a b']), UnsafeValueError)
  // A config path or container name with shell characters in docker's answer is dropped, not used.
  const r = parseLocate("HPX_CONTAINER good-1\nHPX_CONFIG good-1 /opt/x'y\nHPX_CONTAINER bad;name\nHPX_DONE\n")
  assert.deepEqual(r.found.map(f => [f.container, f.configDir]), [['good-1', null]])
  for (const sc of [locateScript(), readScript('/opt/app', ['.env']), verifyScript('c1', 3000), composeUpScript('/opt/app', '/opt/app/docker-compose.yml'), s]) {
    assertSafeScript(sc)
    assert.ok(!/umask 077/.test(sc))
    assert.equal(spawnSync('bash', ['-n'], { input: sc }).status, 0, 'valid bash')
  }
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

test('widget keys: opt-in, never for an API token, into a 0600 .env as HOMEPAGE_VAR values, then the container is recreated', async () => {
  const sonarr = 'sonarr@10.0.0.12:8989'
  const t = setup({ secrets: { 'arrstack:sonarr_key': 'abc123secret' } })
  const i = await t.svc.connect('lxc-130', me)
  await assert.rejects(() => t.svc.setWidgets(i.id, [sonarr], { email: 'bot', token: 'ci' }), (e: any) => e.code === 'token_forbidden')
  await t.svc.setWidgets(i.id, [sonarr], me)
  // Turned on but no key on the guest yet: services.yaml gets no widget.
  let p = await t.svc.preview(i.id, me)
  assert.equal(p.entries.find(e => e.id === sonarr)!.offer!.pending, true)
  assert.ok(!p.files[0].after.includes('widget'))
  const keys = await t.svc.widgetKeys(i.id)
  assert.deepEqual(keys[0].vars, [{ field: 'key', name: varName(sonarr, 'key'), held: true, exported: false }])
  await assert.rejects(() => t.svc.exportKeys(i.id, { email: 'bot', token: 'ci' }), (e: any) => e.code === 'token_forbidden')
  const r = await t.svc.exportKeys(i.id, me)
  assert.deepEqual(r.written, [varName(sonarr, 'key')])
  assert.equal(r.restarted, true)
  const env = fs.readFileSync(path.join(t.guest.compose, '.env'), 'utf8')
  assert.match(env, /^HOMEPAGE_ALLOWED_HOSTS=10\.0\.0\.30:3000$/m, 'other lines kept')
  assert.match(env, new RegExp(`^${varName(sonarr, 'key')}='abc123secret'$`, 'm'))
  assert.equal(fs.statSync(path.join(t.guest.compose, '.env')).mode & 0o777, 0o600)
  assert.match(t.calls(), /compose .*up -d/)
  const audit = t.audits.find(a => a.action === 'homepage.export_keys')!
  assert.ok(!JSON.stringify(audit).includes('abc123secret'), 'the audit names variables, never values')
  // Now the widget is written, with a placeholder.
  p = await t.svc.preview(i.id, me)
  const text = p.files[0].after
  assert.match(text, /widget:\n\s+type: sonarr\n\s+url: http:\/\/10\.0\.0\.12:8989\n\s+key: "?\{\{HOMEPAGE_VAR_SONARR_10_0_0_12_8989_KEY\}\}"?/)
  assert.ok(!text.includes('abc123secret'), 'services.yaml never holds a key')
})

test('keys are not written when compose does not hand the .env to the container; the fix adds env_file and recreates', async () => {
  const bare = 'services:\n  homepage:\n    image: ghcr.io/gethomepage/homepage:latest\n    environment:\n      - HOMEPAGE_ALLOWED_HOSTS=${HOMEPAGE_ALLOWED_HOSTS}\n'
  assert.equal(composeReadsEnv(bare, 'app-homepage-1'), false)
  assert.equal(composeReadsEnv(COMPOSE, 'app-homepage-1'), true)
  const wired = wireEnv(bare, 'app-homepage-1')!
  assert.equal(composeReadsEnv(wired, 'app-homepage-1'), true)
  assert.match(wired, /HOMEPAGE_ALLOWED_HOSTS=\$\{HOMEPAGE_ALLOWED_HOSTS\}/, 'the rest of the file is kept')
  assert.equal(wireEnv(COMPOSE, 'app-homepage-1'), null)

  const t = setup({ compose: bare, secrets: { 'arrstack:sonarr_key': 'k' } })
  const i = await t.svc.connect('lxc-130', me)
  await t.svc.setWidgets(i.id, ['sonarr@10.0.0.12:8989'], me)
  await assert.rejects(() => t.svc.exportKeys(i.id, me), (e: any) => e.code === 'env_not_wired')
  const probs = await t.svc.problems(i.id)
  assert.ok(probs.some(p => p.id === 'env_not_wired' && p.fix?.id === 'wire_env'))
  const r = await t.svc.fix(i.id, 'wire_env', me)
  assert.match(r.message, /reads its \.env/)
  assert.equal(composeReadsEnv(fs.readFileSync(path.join(t.guest.compose, 'docker-compose.yml'), 'utf8'), 'app-homepage-1'), true)
  assert.ok(fs.readdirSync(t.guest.compose).some(n => n.startsWith('docker-compose.yml.bak-hyperprox-')), 'backed up first')
  await t.svc.exportKeys(i.id, me)
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
  const keys = await t.svc.widgetKeys(i.id)
  assert.deepEqual(keys[0].vars.map(v => [v.field, v.held]), [['username', true], ['password', true]])
  await t.svc.revokeProxmoxToken(i.id, me)
  assert.deepEqual(t.tokens, [])
  assert.equal(t.vault.has(i.id), false)
  assert.equal((await t.store.get(i.id))!.proxmoxToken, null)
  await t.svc.disconnect(i.id, me)
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
  // A new service appears: too soon after the last write.
  t.setInv(() => inventory({ services: [...inventory().services, { key: 'radarr', url: 'http://10.0.0.12:7878', guest: null, source: 'scan' }] }))
  assert.equal((await t.svc.tick())[0].did, 'soon')
  t.advance(AUTO_MIN_GAP_MS + 1)
  assert.equal((await t.svc.tick())[0].did, 'wrote')
  assert.match(t.read('services.yaml'), /Radarr/)
  // A changed inventory that changes nothing on the dashboard (a new guest with no service) writes nothing.
  t.advance(AUTO_MIN_GAP_MS + 1)
  const inv2 = inventory({ services: [...inventory().services, { key: 'radarr', url: 'http://10.0.0.12:7878', guest: null, source: 'scan' }] })
  inv2.guests.push({ vmid: 150, name: 'quiet', node: 'node1', type: 'lxc', status: 'running', tags: [], addresses: ['10.0.0.50'], machineId: 'lxc-150' })
  t.setInv(() => inv2)
  const backups = fs.readdirSync(t.guest.config).filter(n => n.includes('.bak-hyperprox-')).length
  assert.equal((await t.svc.tick())[0].did, 'unchanged')
  assert.equal(fs.readdirSync(t.guest.config).filter(n => n.includes('.bak-hyperprox-')).length, backups)
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
  await assert.rejects(() => t.svc.fix(i.id, 'export_keys', me), /master password/)
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

test('roles: every Homepage route is admin; widgets, keys and the token also need the master password', () => {
  const B = '/api/plugins/homepage'
  for (const [m, p] of [['GET', `${B}/installs`], ['GET', `${B}/instances/x/preview`], ['POST', `${B}/instances/x/apply`], ['GET', `${B}/instances/x/problems`], ['PUT', `${B}/instances/x/settings`], ['POST', `${B}/instances`]]) {
    assert.equal(requiredRole(m, p), 'admin', `${m} ${p}`)
  }
  assert.equal(requiredRole('GET', '/api/plugins/homepage/data'), 'viewer', 'the gallery card stays a viewer read')
  for (const [m, p] of [['PUT', `${B}/instances/x/widgets`], ['POST', `${B}/instances/x/secrets`], ['POST', `${B}/instances/x/proxmox-token`], ['DELETE', `${B}/instances/x/proxmox-token`]]) {
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
