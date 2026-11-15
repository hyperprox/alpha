// Homepage plug-in, the generator: from a fixture inventory to services.yaml. Grouping, the link each entry gets
// (public when a proxy host serves it, else the LAN address), exclusion (tag, Remote access's list, subnets), the
// merge that keeps the person's groups and edits, the YAML read back, widgets.yaml, the .env and the diff.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEntries, mergeServices, mergeWidgets, mergeEnv, envNames, lineDiff, parseServices, isSampleConfig, valueHash, varName, hostPort, inSubnets,
  adoptFromHeader, yaml, YamlProblem, MANAGED_MARK, noBraces, safeSecret, pruneEnv,
} from '../src/lib/homepage/generate'
import { appFromName, knownApp } from '../src/lib/homepage/catalog'
import { buildInventory, inventoryFingerprint, type InventorySources } from '../src/lib/homepage/inventory'
import { DEFAULT_OPTIONS, EMPTY_STATE, type Inventory, type GenerateOptions } from '../src/lib/homepage/types'

const g = (vmid: number, name: string, addresses: string[], o: Partial<Inventory['guests'][number]> = {}) => ({
  vmid, name, node: 'node1', type: 'lxc' as const, status: 'running', tags: [], addresses, machineId: `lxc-${vmid}`, ...o,
})
const ref = (vmid: number, name: string) => ({ vmid, name, node: 'node1', type: 'lxc' as const })

function fixture(): Inventory {
  return {
    guests: [
      g(101, 'media', ['10.0.0.11']), g(102, 'arr', ['10.0.0.12']), g(103, 'cloud', ['10.0.0.13']), g(104, 'secret-box', ['10.0.0.14'], { tags: ['hyperprox-ignore'] }),
      g(105, 'listed', ['10.0.0.15']), g(106, 'iot-bridge', ['10.9.0.5']), g(107, 'idle', ['10.0.0.17']), g(108, 'stopped', [], { status: 'stopped' }),
      g(109, 'git', ['10.0.0.19']),
    ],
    services: [
      { key: 'plex', url: 'http://10.0.0.11:32400', guest: ref(101, 'media'), source: 'plugin' },
      { key: 'sonarr', url: 'http://10.0.0.12:8989', guest: ref(102, 'arr'), source: 'scan' },
      { key: 'radarr', url: 'http://10.0.0.12:7878', guest: ref(102, 'arr'), source: 'scan' },
      { key: 'sonarr', url: 'http://10.0.0.12:8989', guest: ref(102, 'arr'), source: 'plugin' }, // the same one, twice
      { key: 'nextcloud', url: 'http://10.0.0.13:80', publicUrl: 'https://cloud.example.org', guest: ref(103, 'cloud'), source: 'catalogue' },
      { key: 'vaultwarden', url: 'http://10.0.0.14:80', guest: ref(104, 'secret-box'), source: 'scan' },
      { key: 'unmanic', url: 'http://10.0.0.15:8888', guest: ref(105, 'listed'), source: 'plugin' },
      { key: 'home-assistant', url: 'http://10.9.0.5:8123', guest: ref(106, 'iot-bridge'), source: 'plugin' },
      { key: 'unmanic', url: 'http://10.0.0.11:8888', guest: ref(101, 'media'), source: 'plugin' },
      { key: 'proxmox', url: 'https://10.0.0.2:8006', guest: null, source: 'cluster' },
    ],
    proxyHosts: [
      { domains: ['plex.example.org'], url: 'https://plex.example.org', forward: { scheme: 'http', host: '10.0.0.11', port: 32400 }, guest: ref(101, 'media') },
      { domains: ['cloud.example.org'], url: 'https://cloud.example.org', forward: { scheme: 'http', host: '10.0.0.13', port: 80 }, guest: ref(103, 'cloud') },
      { domains: ['vault.example.org'], url: 'https://vault.example.org', forward: { scheme: 'http', host: '10.0.0.14', port: 80 }, guest: ref(104, 'secret-box') },
      { domains: ['gitlab.example.org'], url: 'https://gitlab.example.org', forward: { scheme: 'http', host: '10.0.0.19', port: 80 }, guest: ref(109, 'git') },
      { domains: ['shop.example.org'], url: 'https://shop.example.org', forward: { scheme: 'http', host: '10.0.0.19', port: 8081 }, guest: ref(109, 'git') },
    ],
    sites: [{ name: 'Blog', recipeId: 'wordpress', url: 'https://blog.example.org', localUrl: 'http://10.0.0.20', vmid: 120 }],
    excludedMachineIds: ['lxc-105'],
    builtAt: 0,
    errors: [],
    failed: [],
    pluginUrls: { 'arrstack:sonarr_url': 'http://10.0.0.12:8989', 'plex:plex_url': 'http://10.0.0.11:32400' },
  }
}

const opts = (o: Partial<GenerateOptions> = {}): GenerateOptions => ({ ...DEFAULT_OPTIONS, ...o })
const names = (es: ReturnType<typeof buildEntries>) => es.map(e => `${e.group}/${e.name}`)

test('grouping: each app in its group, groups in a fixed order, one entry per service however many sources saw it', () => {
  const es = buildEntries(fixture(), opts())
  assert.deepEqual(names(es), [
    'Media/Plex', 'Downloads/Radarr', 'Downloads/Sonarr', 'Downloads/Unmanic', 'Infrastructure/Proxmox VE',
    'Home/Home Assistant', 'Home/Nextcloud', 'Dev/GitLab', 'Websites/Blog', 'Websites/shop.example.org',
  ])
  const plex = es.find(e => e.name === 'Plex')!
  assert.equal(plex.icon, 'plex.png')
  assert.equal(plex.description, 'Films and TV')
  assert.equal(es.filter(e => e.name === 'Sonarr').length, 1)
})

test('href: the public proxy address when one serves the service, else the LAN address with its port and scheme', () => {
  const es = buildEntries(fixture(), opts())
  const by = (n: string) => es.find(e => e.name === n)!
  assert.equal(by('Plex').href, 'https://plex.example.org'); assert.equal(by('Plex').hrefKind, 'public')
  assert.equal(by('Nextcloud').href, 'https://cloud.example.org')
  assert.equal(by('Sonarr').href, 'http://10.0.0.12:8989'); assert.equal(by('Sonarr').hrefKind, 'lan')
  assert.equal(by('Proxmox VE').href, 'https://10.0.0.2:8006')
  // A proxy host that matches no service: an app its name suggests, else a website by its domain.
  assert.equal(by('GitLab').href, 'https://gitlab.example.org'); assert.equal(by('GitLab').icon, 'gitlab.png')
  assert.equal(by('shop.example.org').group, 'Websites')
  assert.equal(by('Blog').href, 'https://blog.example.org'); assert.equal(by('Blog').icon, 'wordpress.png')
})

test('status: siteMonitor on the LAN address (the no-login path where an app needs one), ping for bare guests', () => {
  const es = buildEntries(fixture(), opts({ includeBareGuests: true }))
  const by = (n: string) => es.find(e => e.name === n)!
  assert.equal(by('Plex').siteMonitor, 'http://10.0.0.11:32400/identity')
  assert.equal(by('Sonarr').siteMonitor, 'http://10.0.0.12:8989/ping')
  // A proxy host with no service behind it is checked at its public address (its target may serve by name only).
  assert.equal(by('shop.example.org').siteMonitor, 'https://shop.example.org')
  assert.equal(by('GitLab').siteMonitor, 'https://gitlab.example.org/users/sign_in')
  assert.equal(by('Nextcloud').siteMonitor, 'http://10.0.0.13/status.php')
  const idle = by('idle')
  assert.equal(idle.group, 'Guests'); assert.equal(idle.ping, '10.0.0.17'); assert.equal(idle.href, null); assert.equal(idle.siteMonitor, undefined)
  assert.ok(!es.some(e => e.name === 'stopped'), 'a stopped guest is not listed')
  assert.ok(!es.some(e => e.name === 'media' && e.group === 'Guests'), 'a guest with a service is not listed again')
})

test('exclusion: the hyperprox-ignore tag, Remote access\'s list and excluded subnets keep a guest and everything on it off', () => {
  const es = buildEntries(fixture(), opts())
  assert.ok(!es.some(e => e.name === 'Vaultwarden'), 'tagged guest: its service is left out')
  assert.ok(!es.some(e => e.href === 'https://vault.example.org'), 'tagged guest: its proxy host is left out too')
  assert.ok(!es.some(e => /10\.0\.0\.15/.test(e.href ?? '')), 'a guest on the exclusion list is left out')
  assert.equal(es.filter(e => e.name.startsWith('Unmanic')).length, 1, 'only the worker that is not excluded')
  const sub = buildEntries(fixture(), opts({ excludeSubnets: ['10.9.0.0/16'] }))
  assert.ok(!sub.some(e => e.name === 'Home Assistant'), 'an excluded subnet')
  assert.ok(sub.some(e => e.name === 'Plex'))
  const bare = buildEntries(fixture(), opts({ includeBareGuests: true }))
  assert.ok(!bare.some(e => e.name === 'secret-box' || e.name === 'listed'), 'excluded guests are not listed as bare guests either')
})

test('hidden entries and groups stay hidden; two of one app are told apart by guest', () => {
  const inv = fixture()
  inv.excludedMachineIds = []
  const es = buildEntries(inv, opts())
  assert.deepEqual(es.filter(e => e.name.startsWith('Unmanic')).map(e => e.name).sort(), ['Unmanic (listed)', 'Unmanic (media)'])
  const hid = buildEntries(inv, opts({ hiddenEntries: [es.find(e => e.name === 'Plex')!.id] }))
  assert.ok(!hid.some(e => e.name === 'Plex'))
  const merged = mergeServices('', es, EMPTY_STATE, { hiddenGroups: ['Downloads'] })
  assert.ok(!merged.state.managedGroups.includes('Downloads'))
})

test('ids are stable and HOMEPAGE_VAR names are safe', () => {
  const a = buildEntries(fixture(), opts()), b = buildEntries(fixture(), opts())
  assert.deepEqual(a.map(e => e.id), b.map(e => e.id))
  assert.equal(a.find(e => e.name === 'Sonarr')!.id, 'sonarr@10.0.0.12:8989')
  assert.equal(varName('sonarr@10.0.0.12:8989', 'key'), 'HOMEPAGE_VAR_SONARR_10_0_0_12_8989_KEY')
  assert.match(varName('x"; rm -rf /', 'key'), /^HOMEPAGE_VAR_[A-Z0-9_]+$/)
})

test('widgets: offered per service, never written unless turned on AND their keys are on the guest', () => {
  const sonarr = 'sonarr@10.0.0.12:8989'
  let s = buildEntries(fixture(), opts()).find(e => e.id === sonarr)!
  assert.deepEqual(s.offer, { type: 'sonarr', vars: { key: varName(sonarr, 'key') }, enabled: false, pending: false })
  assert.equal(s.widget, undefined, 'off by default')
  s = buildEntries(fixture(), opts({ widgets: [sonarr] })).find(e => e.id === sonarr)!
  assert.equal(s.offer!.pending, true); assert.equal(s.widget, undefined, 'turned on but no key on the guest yet')
  s = buildEntries(fixture(), opts({ widgets: [sonarr], exportedVars: [varName(sonarr, 'key')] })).find(e => e.id === sonarr)!
  assert.deepEqual(s.widget, { type: 'sonarr', url: 'http://10.0.0.12:8989', key: `{{${varName(sonarr, 'key')}}}` }, 'the widget gets the app, not the check path')
  const text = mergeServices('', [s], EMPTY_STATE).text
  assert.ok(text.includes('{{HOMEPAGE_VAR_'), 'a placeholder, never a value')
})

test('merge: a fresh install\'s example groups are replaced; the header names HyperProx\'s groups', () => {
  const sample = `---\n- My First Group:\n    - My First Service:\n        href: http://localhost/\n        description: Homepage is awesome\n\n- My Second Group:\n    - My Second Service:\n        href: http://localhost/\n        description: x\n\n- My Third Group:\n    - My Third Service:\n        href: http://localhost/\n        description: y\n`
  assert.equal(isSampleConfig(parseServices(sample)), true)
  const r = mergeServices(sample, buildEntries(fixture(), opts()), EMPTY_STATE)
  assert.equal(r.notes.droppedSamples, true)
  assert.ok(!r.text.includes('My First Group'))
  assert.ok(r.text.startsWith(MANAGED_MARK))
  assert.match(r.text, /keeps these groups up to date: Media, Downloads, Infrastructure, Home, Dev, Websites\./)
  assert.deepEqual(r.state.managedGroups, ['Media', 'Downloads', 'Infrastructure', 'Home', 'Dev', 'Websites'])
  // An edited sample is the person's: kept.
  const edited = sample.replace('Homepage is awesome', 'mine now').replace('http://localhost/', 'http://10.0.0.99/')
  assert.equal(isSampleConfig(parseServices(edited)), false)
  assert.ok(mergeServices(edited, [], EMPTY_STATE).text.includes('My First Group'))
})

test('merge: the person\'s groups and entries are kept, their edits to ours left alone, our stale entries removed', () => {
  const es = buildEntries(fixture(), opts())
  const first = mergeServices('', es, EMPTY_STATE)
  // The person adds a group of their own, an entry inside our Media group, and edits our Sonarr.
  const doc = parseServices(first.text) as any[]
  doc.unshift({ 'My Stuff': [{ Router: { href: 'http://10.0.0.1' } }] })
  doc.find(x => x.Media).Media.push({ 'Kids TV': { href: 'http://10.0.0.50' } })
  const dl = doc.find(x => x.Downloads).Downloads
  dl.find((x: any) => x.Sonarr).Sonarr.description = 'my shows'
  const text = yaml.dump(doc)
  // Next run: Radarr is gone, and Plex moved.
  const inv = fixture()
  inv.services = inv.services.filter(s => s.key !== 'radarr')
  const next = mergeServices(text, buildEntries(inv, opts()), first.state)
  const back = parseServices(next.text) as any[]
  assert.equal(Object.keys(back[0])[0], 'My Stuff', 'their group, where they put it')
  assert.deepEqual(back[0]['My Stuff'], [{ Router: { href: 'http://10.0.0.1' } }])
  const media = back.find(x => x.Media).Media.map((x: any) => Object.keys(x)[0])
  assert.deepEqual(media, ['Plex', 'Kids TV'], 'their entry inside our group is kept')
  const dl2 = back.find(x => x.Downloads).Downloads
  assert.equal(dl2.find((x: any) => x.Sonarr).Sonarr.description, 'my shows', 'their edit is left as it is')
  assert.ok(!dl2.some((x: any) => x.Radarr), 'our entry for a service that is gone is removed')
  assert.deepEqual(next.notes.keptUserGroups, ['My Stuff'])
  assert.deepEqual(next.notes.keptUserEntries, ['Media / Kids TV'])
  assert.deepEqual(next.notes.keptEdits, ['Downloads / Sonarr'])
  assert.equal(next.state.written.Downloads.Sonarr, first.state.written.Downloads.Sonarr, 'an edited entry is still HyperProx\'s, remembered by the hash of what HyperProx wrote')
})

test('merge: a group the person deleted is not put back; a name the person already uses is not taken', () => {
  const es = buildEntries(fixture(), opts())
  const first = mergeServices('', es, EMPTY_STATE)
  const doc = (parseServices(first.text) as any[]).filter(x => !x.Dev)
  const r = mergeServices(yaml.dump(doc), es, first.state)
  assert.deepEqual(r.notes.userRemovedGroups, ['Dev'])
  assert.ok(!(parseServices(r.text) as any[]).some(x => x.Dev))
  // Their own "Media" group before HyperProx ever wrote: HyperProx's goes in beside it, renamed.
  const own = yaml.dump([{ Media: [{ 'My Films': { href: 'http://10.0.0.60' } }] }])
  const r2 = mergeServices(own, es, EMPTY_STATE)
  const back = parseServices(r2.text) as any[]
  assert.deepEqual(back[0], { Media: [{ 'My Films': { href: 'http://10.0.0.60' } }] })
  assert.ok(back.some(x => x['Media (HyperProx)']))
  assert.deepEqual(r2.notes.renamed, [{ from: 'Media', to: 'Media (HyperProx)' }])
})

test('merge: run twice on the same inventory changes nothing; the hash tells our unchanged entry from an edit', () => {
  const es = buildEntries(fixture(), opts())
  const a = mergeServices('', es, EMPTY_STATE)
  const b = mergeServices(a.text, es, a.state)
  assert.equal(b.changed, false)
  assert.equal(b.text, a.text)
  assert.notEqual(valueHash({ a: 1, b: 2 }), valueHash({ a: 1, b: 3 }))
  assert.equal(valueHash({ a: 1, b: 2 }), valueHash({ b: 2, a: 1 }))
})

test('merge: with no record but HyperProx\'s header in the file, its groups are taken back, the person\'s entries kept', () => {
  const es = buildEntries(fixture(), opts())
  const a = mergeServices('', es, EMPTY_STATE)
  const doc = parseServices(a.text) as any[]
  doc.find(x => x.Media).Media.push({ Mine: { href: 'http://10.0.0.70' } })
  const withHeader = a.text.split('\n').slice(0, 5).join('\n') + '\n' + yaml.dump(doc)
  const st = adoptFromHeader(withHeader, parseServices(withHeader) as any, es)
  assert.deepEqual(st.managedGroups, a.state.managedGroups)
  assert.equal(st.written.Media.Mine, undefined)
  const r = mergeServices(withHeader, es, EMPTY_STATE)
  assert.deepEqual(r.notes.adopted, a.state.managedGroups)
  assert.ok(!(parseServices(r.text) as any[]).some(x => Object.keys(x)[0].endsWith('(HyperProx)')), 'no duplicate groups')
  assert.deepEqual((parseServices(r.text) as any[]).find(x => x.Media).Media.map((x: any) => Object.keys(x)[0]), ['Plex', 'Mine'])
})

test('YAML: generated with a library and read back; a broken or odd file is refused, never overwritten blind', () => {
  const es = buildEntries(fixture(), opts())
  // Names and values YAML would misread if written by hand.
  es[0].name = 'Plex: "the" #1 - yes'
  es[0].description = 'on: off\n- tricky'
  const r = mergeServices('', es, EMPTY_STATE)
  const back = parseServices(r.text) as any[]
  assert.equal(Object.keys(back.find(x => x.Media).Media[0])[0], 'Plex: "the" #1 - yes')
  assert.throws(() => mergeServices('- a: [unclosed', es, EMPTY_STATE), (e: any) => e instanceof YamlProblem && e.code === 'yaml_invalid')
  assert.throws(() => mergeServices('just: a map', es, EMPTY_STATE), (e: any) => e instanceof YamlProblem && e.code === 'not_a_list')
  assert.deepEqual(parseServices('# only a comment\n'), [])
})

test('widgets.yaml: resources and search added when missing, otherwise the same text (no write)', () => {
  const r = mergeWidgets('')
  assert.deepEqual(r.added, ['resources', 'search'])
  assert.deepEqual(yaml.load(r.text), [{ resources: { cpu: true, memory: true, disk: '/' } }, { search: { provider: 'duckduckgo', target: '_blank' } }])
  const have = '---\n- resources:\n    cpu: true\n- search:\n    provider: google\n'
  assert.deepEqual(mergeWidgets(have), { text: have, changed: false, added: [] })
  const some = mergeWidgets('- datetime:\n    format: {}\n')
  assert.deepEqual((yaml.load(some.text) as any[]).map(x => Object.keys(x)[0]), ['datetime', 'resources', 'search'])
})

test('.env: HOMEPAGE_VAR values set, every other line kept, quotes and line breaks refused, names read without values', () => {
  const cur = 'HOMEPAGE_ALLOWED_HOSTS=10.0.0.30:3000\n# note\nHOMEPAGE_VAR_A_KEY=\'old\'\n'
  const next = mergeEnv(cur, { HOMEPAGE_VAR_A_KEY: 'new1', HOMEPAGE_VAR_B_KEY: 'abc$def' })
  assert.equal(next, "HOMEPAGE_ALLOWED_HOSTS=10.0.0.30:3000\n# note\nHOMEPAGE_VAR_A_KEY='new1'\nHOMEPAGE_VAR_B_KEY='abc$def'\n")
  assert.throws(() => mergeEnv(cur, { HOMEPAGE_VAR_X: "it's" }), /quote/)
  assert.throws(() => mergeEnv(cur, { HOMEPAGE_VAR_X: 'a\nB=1' }), /line break/)
  assert.throws(() => mergeEnv(cur, { 'PATH': 'x' }), /Not a Homepage variable/)
  assert.deepEqual(envNames(next), ['HOMEPAGE_VAR_A_KEY', 'HOMEPAGE_VAR_B_KEY'])
})

test('diff: lines kept, removed and added', () => {
  const d = lineDiff('a\nb\nc', 'a\nc\nd')
  assert.deepEqual(d, [{ op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: ' ', text: 'c' }, { op: '+', text: 'd' }])
})

test('helpers: URLs, subnets, names', () => {
  assert.deepEqual(hostPort('https://x.example.org/'), { scheme: 'https', host: 'x.example.org', port: 443 })
  assert.equal(hostPort('ftp://x'), null)
  assert.equal(inSubnets('10.9.1.2', ['10.9.0.0/16']), true)
  assert.equal(inSubnets('10.10.1.2', ['10.9.0.0/16']), false)
  assert.equal(inSubnets('example.org', ['10.9.0.0/16']), false)
  assert.equal(appFromName('jellyseerr')?.key, 'seerr')
  assert.equal(appFromName('media-plex')?.key, 'plex')
  assert.equal(appFromName('shop'), null)
  assert.equal(appFromName('ha')?.key, 'home-assistant')
  assert.equal(appFromName('hash'), null, 'short aliases only match exactly')
  assert.equal(knownApp('nginx-proxy-manager')?.key, 'npm')
})

// ── the inventory, from its sources ──────────────────────────────────────────

function sources(o: Partial<InventorySources> = {}): InventorySources {
  return {
    guests: async () => [
      { vmid: 101, name: 'media', node: 'node1', type: 'lxc', status: 'running', tags: 'media;hyperprox-ignore' },
      { vmid: 102, name: 'arr', node: 'node1', type: 'lxc', status: 'running' },
      { vmid: 103, name: 'off', node: 'node1', type: 'qemu', status: 'stopped' },
      { vmid: 900, name: 'tmpl', node: 'node1', type: 'lxc', status: 'stopped', template: 1 },
    ],
    addresses: async gr => ({ 101: ['10.0.0.11'], 102: ['10.0.0.12'] } as Record<number, string[]>)[gr.vmid] ?? [],
    scan: async () => [{ key: 'sonarr', address: 'http://10.0.0.12:8989', guest: null }],
    detected: async () => ({ apps: { nextcloud: [{ guest: { vmid: 102, name: 'arr', node: 'node1', type: 'lxc', status: 'running' }, target: '10.0.0.12:80', publicUrl: 'https://c.example.org', domains: ['c.example.org'], version: null, via: 'probe' }] }, builtAt: 0, probed: 1, errors: [] }),
    candidates: async () => [],
    installs: async () => [
      { recipeId: 'jellyfin', status: 'completed', url: 'http://10.0.0.12:8096/', vmid: 102 },
      { recipeId: 'gitea', status: 'failed', url: 'http://10.0.0.12:3000', vmid: 102 },
      { recipeId: 'grafana', status: 'completed', url: 'http://10.0.0.13:3000', vmid: 103 },
    ],
    sites: async () => [],
    plugins: async () => [
      { id: 'arrstack', name: 'Arr Stack', configured: true, settings: { sonarr_url: 'http://10.0.0.12:8989', radarr_url: 'http://10.0.0.12:7878/' }, addressSettings: [{ key: 'sonarr_url', endpoint: null }, { key: 'radarr_url', endpoint: 'radarr' }] },
      { id: 'mikrotik', name: 'MikroTik', configured: false, settings: { url: 'https://10.0.0.1' }, addressSettings: [{ key: 'url', endpoint: null }] },
    ],
    instances: async () => [{ key: 'qnap', name: 'NAS', url: 'https://10.0.0.40:443' }, { key: 'qnap', name: 'Far', url: 'https://10.8.0.4', remote: true }],
    exclusions: async () => ['lxc-102'],
    self: async () => ({ hyperprox: 'https://10.0.0.50', proxmox: 'https://10.0.0.2:8006' }),
    now: () => 42,
    ...o,
  }
}

test('inventory: every source counted once, stopped guests and their services left out, configured plug-ins only', async () => {
  const inv = await buildInventory(sources())
  assert.deepEqual(inv.guests.map(x => x.vmid), [101, 102, 103], 'templates are not guests')
  assert.deepEqual(inv.guests[0].tags, ['media', 'hyperprox-ignore'])
  assert.deepEqual(inv.guests[2].addresses, [], 'a stopped guest is not asked for addresses')
  const keys = inv.services.map(s => `${s.key}@${s.url}:${s.source}`)
  assert.ok(keys.includes('jellyfin@http://10.0.0.12:8096:install'))
  assert.ok(!keys.some(k => k.startsWith('gitea')), 'a failed install is not a service')
  assert.ok(!keys.some(k => k.startsWith('grafana')), 'an install on a stopped guest is left out')
  assert.ok(keys.includes('sonarr@http://10.0.0.12:8989:plugin') && keys.includes('radarr@http://10.0.0.12:7878:plugin'))
  assert.ok(!keys.some(k => k.startsWith('mikrotik')), 'a plug-in that is not set up is not used')
  assert.ok(keys.includes('qnap@https://10.0.0.40:443:plugin'))
  assert.ok(!keys.some(k => k.includes('10.8.0.4')), 'a device beside another cluster is not on this one')
  assert.ok(keys.includes('nextcloud@http://10.0.0.12:80:catalogue'))
  assert.equal(inv.services.find(s => s.key === 'sonarr' && s.source === 'scan')!.guest!.vmid, 102, 'a scan finding is matched to its guest by address')
  assert.deepEqual(inv.excludedMachineIds, ['lxc-102'])
  assert.equal(inv.builtAt, 42)
  // And the generator then leaves the excluded guest out entirely.
  const es = buildEntries(inv, DEFAULT_OPTIONS)
  assert.deepEqual(es.map(e => e.name).sort(), ['HyperProx', 'NAS', 'Proxmox VE'])
})

test('inventory: a source that fails is named, the rest still count; the fingerprint follows what matters', async () => {
  const inv = await buildInventory(sources({ scan: async () => { throw new Error('scan down') }, exclusions: async () => [] }))
  assert.deepEqual(inv.errors, ['Service scan: scan down'])
  assert.ok(inv.services.length > 0)
  const a = inventoryFingerprint(inv)
  assert.equal(a, inventoryFingerprint(await buildInventory(sources({ scan: async () => { throw new Error('scan down') }, exclusions: async () => [] }))))
  const b = inventoryFingerprint(await buildInventory(sources({ scan: async () => { throw new Error('scan down') }, exclusions: async () => ['lxc-101'] })))
  assert.notEqual(a, b)
})

// ── finding Homepage: the shared probe and the Catalogue's fingerprint ───────

test('the Homepage probe and fingerprint match current images (a <title> with attributes) and its host check', async () => {
  const { PROBES, probeHost } = require('@hyperprox/hardware/service-probes')
  const { DETECT } = await import('../src/lib/catalogue-detect')
  const page = '<!DOCTYPE html><html><head><title data-next-head="">Homepage</title><script src="/_next/static/chunks/main.js"></script></head></html>'
  const probe = PROBES.find((p: any) => p.key === 'homepage')
  assert.equal(probe.port, 3000)
  assert.equal(probe.pluginId, 'homepage'); assert.equal(probe.page, '/plugins/homepage')
  assert.equal(await probeHost(async () => ({ status: 200, body: page }), '10.0.0.30', probe), true)
  assert.equal(await probeHost(async () => ({ status: 400, body: '{"error":"Host validation failed. See logs for more details."}' }), '10.0.0.30', probe), true)
  assert.equal(await probeHost(async () => ({ status: 200, body: '<title>Grafana</title>/_next/' }), '10.0.0.30', probe), false)
  assert.ok(DETECT.homepage[0].match({ status: 200, headers: {}, body: page }))
})

// ── review fixes ─────────────────────────────────────────────────────────────

test('B3: a group left with only the person\'s edit stays HyperProx\'s; no "X (HyperProx)" twin and no second copy, ever', () => {
  const sonarrOnly = (): Inventory => ({ ...fixture(), services: fixture().services.filter(s => s.key === 'sonarr'), proxyHosts: [], sites: [] })
  const es = buildEntries(sonarrOnly(), opts())
  const a = mergeServices('', es, EMPTY_STATE)
  const doc = parseServices(a.text) as any[]
  doc.find(x => x.Downloads).Downloads[0].Sonarr.description = 'mine'
  let text = yaml.dump(doc), state = a.state
  for (let run = 0; run < 3; run++) {
    const r = mergeServices(text, es, state)
    assert.ok(r.state.managedGroups.includes('Downloads'), `run ${run}: still HyperProx's`)
    assert.deepEqual(r.notes.keptUserEntries, [], `run ${run}: an edit never counts as an entry the person added`)
    assert.deepEqual(r.notes.keptEdits, ['Downloads / Sonarr'])
    text = r.text; state = r.state
  }
  const back = parseServices(text) as any[]
  assert.ok(!back.some(x => x['Downloads (HyperProx)']), 'no twin group')
  const all = back.flatMap(x => (Object.values(x)[0] as any[]).map(e => Object.keys(e)[0]))
  assert.equal(all.filter(n => n === 'Sonarr').length, 1, 'never two copies of an entry')
  assert.equal(back.find(x => x.Downloads).Downloads[0].Sonarr.description, 'mine')
  assert.deepEqual(state.released, [], 'nothing is released by itself')
})

test('B3 case T: Gitea\'s guest stopped for one sync, then back: Dev stays HyperProx\'s and Gitea returns', () => {
  const withGitea = (): Inventory => ({ ...fixture(), proxyHosts: [], sites: [], services: [{ key: 'gitea', url: 'http://10.0.0.19:3000', guest: { vmid: 109, name: 'git', node: 'node1', type: 'lxc' }, source: 'install' }] })
  const a = mergeServices('', buildEntries(withGitea(), opts()), EMPTY_STATE)
  assert.deepEqual(a.state.managedGroups, ['Dev'])
  // One sync with the guest stopped: Gitea is not in the inventory.
  const b = mergeServices(a.text, buildEntries({ ...withGitea(), services: [] }, opts()), a.state)
  assert.ok(b.state.managedGroups.includes('Dev'), 'still HyperProx\'s')
  assert.deepEqual(b.state.parked, ['Dev'])
  assert.deepEqual(b.notes.userRemovedGroups, [])
  // Back.
  const c = mergeServices(b.text, buildEntries(withGitea(), opts()), b.state)
  assert.deepEqual(c.notes.userRemovedGroups, [], 'a parked group is not "deleted by the person"')
  assert.ok(c.state.managedGroups.includes('Dev'))
  assert.deepEqual((parseServices(c.text) as any[]).find(x => x.Dev).Dev.map((x: any) => Object.keys(x)[0]), ['Gitea'])
  // And with an entry of the person's beside it: the group stays, Gitea comes back into it.
  const doc = parseServices(a.text) as any[]
  doc.find(x => x.Dev).Dev.push({ 'My Repo': { href: 'http://10.0.0.80' } })
  const d = mergeServices(yaml.dump(doc), buildEntries({ ...withGitea(), services: [] }, opts()), a.state)
  assert.ok(d.state.managedGroups.includes('Dev'), 'not handed over')
  const e = mergeServices(d.text, buildEntries(withGitea(), opts()), d.state)
  assert.deepEqual((parseServices(e.text) as any[]).find(x => x.Dev).Dev.map((x: any) => Object.keys(x)[0]), ['Gitea', 'My Repo'])
  assert.ok(!(parseServices(e.text) as any[]).some(x => x['Dev (HyperProx)']))
})

test('B3 case S: the person edits the only Media entry; a new Jellyfin still appears in Media', () => {
  const inv = fixture()
  const a = mergeServices('', buildEntries(inv, opts()), EMPTY_STATE)
  const doc = parseServices(a.text) as any[]
  assert.deepEqual(doc.find(x => x.Media).Media.map((x: any) => Object.keys(x)[0]), ['Plex'])
  doc.find(x => x.Media).Media[0].Plex.description = 'our films'
  const b = mergeServices(yaml.dump(doc), buildEntries(inv, opts()), a.state)
  inv.services.push({ key: 'jellyfin', url: 'http://10.0.0.21:8096', guest: null, source: 'scan' })
  const c = mergeServices(b.text, buildEntries(inv, opts()), b.state)
  const media = (parseServices(c.text) as any[]).find(x => x.Media).Media
  assert.deepEqual(media.map((x: any) => Object.keys(x)[0]).sort(), ['Jellyfin', 'Plex'])
  assert.equal(media.find((x: any) => x.Plex).Plex.description, 'our films')
  assert.ok(!(parseServices(c.text) as any[]).some(x => x['Media (HyperProx)']))
})

test('B3: only "Make a group yours" releases a group; "manage it again" takes back exactly HyperProx\'s entries', () => {
  const es = buildEntries(fixture(), opts())
  const a = mergeServices('', es, EMPTY_STATE)
  const st = { ...a.state, managedGroups: a.state.managedGroups.filter(g => g !== 'Media'), released: ['Media'] }
  const doc = parseServices(a.text) as any[]
  doc.find(x => x.Media).Media.push({ Mine: { href: 'http://10.0.0.70' } })
  const b = mergeServices(yaml.dump(doc), es, st)
  assert.ok(!b.state.managedGroups.includes('Media'))
  assert.ok(!(parseServices(b.text) as any[]).some(x => x['Media (HyperProx)']), 'released: no twin')
  // Handed back: Plex (exactly HyperProx's) is claimed again, Mine stays the person's.
  const c = mergeServices(b.text, es, { ...b.state, released: [], reclaim: ['Media'] })
  assert.ok(c.state.managedGroups.includes('Media'))
  assert.ok(c.state.written.Media.Plex && c.state.written.Media.Mine === undefined)
  assert.deepEqual(c.notes.keptUserEntries, ['Media / Mine'])
  assert.deepEqual(c.state.reclaim, [])
})

test('B3: a twin beside the person\'s own group never repeats an entry they already have there', () => {
  const es = buildEntries(fixture(), opts())
  const own = yaml.dump([{ Media: [{ Plex: { href: 'http://my-plex' } }] }])
  const r = mergeServices(own, es, EMPTY_STATE)
  const back = parseServices(r.text) as any[]
  assert.deepEqual(back[0], { Media: [{ Plex: { href: 'http://my-plex' } }] })
  assert.ok(!back.some(x => x['Media (HyperProx)']), 'the twin would only repeat Plex, so there is none')
})

test('B4: the header alone claims only entries exactly as HyperProx would write them; an edited one stays the person\'s', () => {
  const es = buildEntries(fixture(), opts())
  const a = mergeServices('', es, EMPTY_STATE)
  const doc = parseServices(a.text) as any[]
  doc.find(x => x.Media).Media[0].Plex.href = 'http://my-own-plex'
  const text = a.text.split('\n').slice(0, 5).join('\n') + '\n' + yaml.dump(doc)
  const st = adoptFromHeader(text, parseServices(text) as any, es)
  assert.equal(st.written.Media?.Plex, undefined, 'the edited entry is not claimed')
  const r = mergeServices(text, es, EMPTY_STATE)
  assert.equal((parseServices(r.text) as any[]).find(x => x.Media).Media[0].Plex.href, 'http://my-own-plex', 'and not overwritten')
  // A header that names a group of the person's (nothing in it is HyperProx's) does not take it.
  const theirs = '# HyperProx keeps these groups up to date: Mine.\n' + yaml.dump([{ Mine: [{ Router: { href: 'http://10.0.0.1' } }] }])
  assert.deepEqual(adoptFromHeader(theirs, parseServices(theirs) as any, es).managedGroups, [])
  const r2 = mergeServices(theirs, es, EMPTY_STATE)
  assert.deepEqual((parseServices(r2.text) as any[])[0], { Mine: [{ Router: { href: 'http://10.0.0.1' } }] })
})

test('B8: a plug-in key\'s widget is offered only on the entry at that plug-in\'s address, the token only on the cluster', () => {
  const inv = fixture()
  inv.services.push({ key: 'sonarr', url: 'http://10.0.0.99:8989', guest: null, source: 'scan' })
  const es = buildEntries(inv, opts())
  assert.ok(es.find(e => e.id === 'sonarr@10.0.0.12:8989')!.offer, 'the configured Sonarr')
  assert.equal(es.find(e => e.id === 'sonarr@10.0.0.99:8989')!.offer, undefined, 'a second Sonarr never gets the first one\'s key')
  assert.equal(buildEntries({ ...inv, pluginUrls: {} }, opts()).find(e => e.id === 'sonarr@10.0.0.12:8989')!.offer, undefined, 'no configured address, no offer')
  assert.ok(es.find(e => e.id === 'proxmox@10.0.0.2:8006')!.offer)
  inv.services.push({ key: 'proxmox', url: 'https://10.0.0.98:8006', guest: null, source: 'scan' })
  assert.equal(buildEntries(inv, opts()).find(e => e.id === 'proxmox@10.0.0.98:8006')!.offer, undefined, 'a scanned Proxmox is not the cluster')
})

test('no {{ or }} in any generated value outside a widget block', () => {
  const inv = fixture()
  inv.services.push({ key: 'grafana', label: 'G {{HOMEPAGE_VAR_SONARR_10_0_0_12_8989_KEY}} x', url: 'http://10.0.0.30:3000', guest: null, source: 'plugin' })
  inv.sites.push({ name: 'Site {{{HOMEPAGE_VAR_A}}}', recipeId: 'static-site', url: 'https://s.example.org/{{x}}', vmid: 130 })
  const text = mergeServices('', buildEntries(inv, opts()), EMPTY_STATE).text
  assert.ok(!/\{\{|\}\}/.test(text), text)
  assert.equal(noBraces('a{{{b}}}c'), 'a{b}c'); assert.equal(noBraces('{{{{x}}}}'), 'x')
})

test('keys: refused when they hold quotes, a backslash, {{ or a line break; pruning keeps every other line', () => {
  for (const bad of ['a"b', "a'b", 'a\\b', 'a{{b', 'a}}b', 'a\nb', '']) assert.equal(safeSecret(bad), false, JSON.stringify(bad))
  assert.equal(safeSecret('abcDEF123-_.:$%'), true)
  assert.throws(() => mergeEnv('', { HOMEPAGE_VAR_X: 'a"b' }), /quote/)
  assert.deepEqual(pruneEnv("A=1\nHOMEPAGE_VAR_X='1'\nHOMEPAGE_VAR_Y='2'\n", ['HOMEPAGE_VAR_Y']), { text: "A=1\nHOMEPAGE_VAR_Y='2'\n", removed: ['HOMEPAGE_VAR_X'] })
})

test('B1: the inventory says which sources failed, a guest whose addresses cannot be read counts as guests failing', async () => {
  const inv = await buildInventory(sources({ exclusions: async () => { throw new Error('db down') }, addresses: async gr => { if (gr.vmid === 102) throw new Error('nope'); return ['10.0.0.11'] } }))
  assert.deepEqual([...inv.failed].sort(), ['exclusions', 'guests'])
  assert.deepEqual(inv.pluginUrls, { 'arrstack:sonarr_url': 'http://10.0.0.12:8989', 'arrstack:radarr_url': 'http://10.0.0.12:7878' })
})
