// The Homepage plug-in page's pieces, rendered to HTML: the dashboard preview (groups, tiles, link kind and status
// in words), the diff with unchanged runs folded, problems with their fix buttons, the widget opt-in with its
// plaintext warning, and the pure logic behind them.
//   cd apps/frontend && node ../api/node_modules/tsx/dist/cli.mjs --tsconfig test/tsconfig.json --test test/*.test.tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import "./css-stub"
import { renderToStaticMarkup } from 'react-dom/server'
import { DashboardPreview, DiffView, ProblemList, WidgetList } from '../components/plugins/homepage/HomepagePage'
import { diffStats, foldDiff, grouped, keptWords, monogram, syncWords, validSubnets, KEYS_WARNING, type PreviewEntry } from '../components/plugins/homepage/logic'

const e = (o: Partial<PreviewEntry>): PreviewEntry => ({
  id: 'x', group: 'Media', name: 'Plex', href: 'https://plex.example.org', hrefKind: 'public', icon: 'plex.png', description: 'Films and TV',
  status: 'siteMonitor', widget: null, guest: null, source: 'plugin', ...o,
})

test('the preview draws groups in Homepage\'s order, each tile saying its link kind and status in words', () => {
  const html = renderToStaticMarkup(<DashboardPreview entries={[
    e({ id: 'a', group: 'Downloads', name: 'Sonarr', href: 'http://10.0.0.12:8989', hrefKind: 'lan' }),
    e({ id: 'b' }),
    e({ id: 'c', group: 'Guests', name: 'idle', href: null, hrefKind: 'none', status: 'ping' }),
  ]} hidden={['a']} onToggleHidden={() => {}} />)
  assert.ok(html.indexOf('Media') < html.indexOf('Downloads') && html.indexOf('Downloads') < html.indexOf('Guests'))
  assert.match(html, /aria-label="Media, 1 entry"/)
  assert.match(html, /public[\s\S]*up\/down check/)
  assert.match(html, />LAN</)
  assert.match(html, /no link[\s\S]*ping/)
  assert.match(html, /href="https:\/\/plex\.example\.org" target="_blank" rel="noreferrer noopener"/)
  assert.match(html, /Show on the dashboard/, 'a hidden entry offers to come back')
  assert.match(html, /Leave off the dashboard/)
  assert.ok(!/<img/.test(html), 'no icon is fetched from outside HyperProx')
  assert.match(renderToStaticMarkup(<DashboardPreview entries={[]} />), /Nothing on the cluster/)
})

test('the diff: added and removed lines marked in words too, long unchanged runs folded', () => {
  const diff = [...Array.from({ length: 10 }, (_, i) => ({ op: ' ' as const, text: `same ${i}` })), { op: '-' as const, text: '- My First Group:' }, { op: '+' as const, text: '- Media:' }]
  const html = renderToStaticMarkup(<DiffView name="services.yaml" diff={diff} />)
  assert.match(html, /\+1/); assert.match(html, /−1/)
  assert.match(html, /8 unchanged lines/)
  assert.match(html, /removed: <\/span>- My First Group:/)
  assert.match(html, /added: <\/span>- Media:/)
  assert.deepEqual(diffStats(diff), { added: 1, removed: 1 })
  assert.equal(foldDiff(diff).length, 5)
})

test('problems: worst first, each with its own fix button; none says so plainly', () => {
  const html = renderToStaticMarkup(<ProblemList busy={null} onFix={() => {}} problems={[
    { id: 'widget_pending', severity: 'warn', title: '1 widget waiting for keys', detail: 'x', fix: { id: 'export_keys', label: 'Write the keys to the guest', secure: true } },
    { id: 'yaml_invalid', severity: 'bad', title: 'services.yaml is not valid', detail: 'line 3', fix: { id: 'reset_services', label: 'Back it up and start it fresh', confirm: 'sure?' } },
  ]} />)
  assert.ok(html.indexOf('services.yaml is not valid') < html.indexOf('waiting for keys'))
  assert.match(html, /Back it up and start it fresh/)
  assert.match(html, /aria-label="Problem"/)
  assert.match(renderToStaticMarkup(<ProblemList problems={[]} busy={null} onFix={() => {}} />), /No problems/)
})

test('widgets: opt-in checkboxes, all off unless chosen, with the plaintext warning shown before any is turned on', () => {
  const html = renderToStaticMarkup(<WidgetList chosen={[]} onChange={() => {}} entries={[
    e({ id: 's', name: 'Sonarr', widget: { type: 'sonarr', enabled: false, pending: false, vars: ['HOMEPAGE_VAR_S_KEY'] } }),
    e({ id: 'u', name: 'Unmanic', widget: { type: 'unmanic', enabled: false, pending: false, vars: [] } }),
    e({ id: 'p', name: 'Plain' }),
  ]} />)
  assert.match(html, /Plaintext on the guest/)
  assert.ok(html.includes(KEYS_WARNING.slice(0, 60).replace(/'/g, '&#x27;')))
  assert.match(html, /Sonarr<\/b> · sonarr widget · needs 1 key/)
  assert.match(html, /no key needed/)
  assert.ok(!/checked=""/.test(html), 'nothing is on by default')
  assert.ok(!html.includes('<b>Plain</b>'), 'only services with a widget are offered')
})

test('logic: grouping, monograms, kept-words, sync words, subnets', () => {
  assert.deepEqual(grouped([e({ group: 'Dev', name: 'b' }), e({ group: 'Media', name: 'z' }), e({ group: 'Media', name: 'a' })]).map(g => [g.group, g.entries.map(x => x.name)]),
    [['Media', ['a', 'z']], ['Dev', ['b']]])
  assert.equal(monogram('Nginx Proxy Manager'), 'NP')
  assert.equal(monogram('Unmanic (worker-2)'), 'UN')
  assert.equal(monogram('plex'), 'PL')
  const words = keptWords({ keptUserGroups: ['Mine'], keptUserEntries: [], keptEdits: ['Media / Plex'], userRemovedGroups: ['Dev'], renamed: [{ from: 'Media', to: 'Media (HyperProx)' }], droppedSamples: true, adopted: [] })
  assert.equal(words.length, 5)
  assert.match(words.join(' '), /Your groups stay as they are: Mine/)
  const base = { id: 'i', machineId: 'lxc-1', kind: 'lxc' as const, vmid: 1, node: 'n', name: 'h', container: 'c', configDir: '/c', composeDir: null, url: null,
    options: { excludeSubnets: [], includeBareGuests: false, hiddenGroups: [], hiddenEntries: [], widgets: [] }, autoSync: false, managedGroups: [], exportedVars: [], proxmoxToken: null }
  assert.deepEqual(syncWords({ ...base, lastSync: null }), { text: 'Not filled yet', tone: 'warn' })
  assert.equal(syncWords({ ...base, lastSync: { at: 0, by: 'a@b', ok: true, message: '', wrote: [], counts: {}, backups: [] } }, 5 * 60_000).text, 'In sync · 5 min ago · a@b')
  assert.deepEqual(validSubnets('192.0.2.0/24, 198.51.100.0/24'), { ok: true, list: ['192.0.2.0/24', '198.51.100.0/24'] })
  assert.equal(validSubnets('192.0.2.0').ok, false)
  assert.equal(validSubnets('300.0.0.0/8').ok, false)
  assert.deepEqual(validSubnets(''), { ok: true, list: [] })
})
