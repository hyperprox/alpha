// Disconnecting a plug-in: every setting and its vault item go, each address it was set up for is remembered as
// dismissed first (so auto-connect does not add it straight back), the audit names settings but never a value, and a
// plug-in with its own device list is sent to its page instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { disconnectPlugin, dismissKey, OWN_PAGE_PLUGINS } from '../src/lib/plugin-disconnect'
import { addressSettings, type PluginManifest } from '../src/lib/plugin-host'

const ARR: PluginManifest = {
  id: 'arrstack', name: 'Arr Stack', description: 'x', kind: 'device', icon: 'x',
  settings: [
    { key: 'sonarr_url', label: 'Sonarr address', type: 'url', required: false },
    { key: 'sonarr_key', label: 'Sonarr API key', type: 'secret', required: false },
    { key: 'radarr_url', label: 'Radarr address', type: 'url', required: false },
    { key: 'radarr_key', label: 'Radarr API key', type: 'secret', required: false },
    { key: 'qbit_url', label: 'qBittorrent', type: 'url', required: false },
  ],
  baseUrlSetting: 'sonarr_url', auth: { kind: 'header', header: 'X-Api-Key', fromSetting: 'sonarr_key' },
  endpoints: [{ key: 'radarr', label: 'Radarr', baseUrlSetting: 'radarr_url', auth: { kind: 'header', header: 'X-Api-Key', fromSetting: 'radarr_key' } }],
} as PluginManifest

function rig(stored: Record<string, string>) {
  const events: string[] = []
  const audits: any[] = []
  let settings = { ...stored }
  return {
    events, audits, get: () => settings,
    deps: {
      settings: async () => ({ ...settings }),
      forgetAll: async () => { events.push('forget'); settings = {} },
      dismiss: async (plugin: string, key: string) => { events.push(`dismiss ${plugin}/${key}`) },
      audit: async (action: string, _r: string, details: any) => { events.push('audit'); audits.push({ action, details }) },
    },
  }
}

test('address settings carry the credential sent to them', () => {
  assert.deepEqual(addressSettings(ARR), [
    { key: 'sonarr_url', secrets: ['sonarr_key'] }, { key: 'radarr_url', secrets: ['radarr_key'] }, { key: 'qbit_url', secrets: [] },
  ])
})

test('disconnect: audit, then the dismissals, then the vault item; no value in the audit', async () => {
  const r = rig({ sonarr_url: 'http://10.0.0.5:8989/', sonarr_key: 'SECRETKEY', qbit_url: 'http://10.0.0.7:8080' })
  const out = await disconnectPlugin(ARR, 'admin@example.com', r.deps)
  assert.deepEqual(r.events, ['audit', 'dismiss arrstack/sonarr_url@http://10.0.0.5:8989', 'dismiss arrstack/qbit_url@http://10.0.0.7:8080', 'forget'])
  assert.deepEqual(r.get(), {})
  assert.deepEqual(out.forgot, ['qbit_url', 'sonarr_key', 'sonarr_url'])
  assert.equal(r.audits[0].action, 'plugin.disconnect')
  assert.ok(!JSON.stringify(r.audits).includes('SECRETKEY'))
  // The same key auto-connect's settings adapter checks (setting@origin).
  assert.equal(dismissKey('sonarr_url', 'http://10.0.0.5:8989/x'), 'sonarr_url@http://10.0.0.5:8989')
})

test('disconnect: nothing saved is refused; a plug-in with its own device list is sent to its page; an audit that fails changes nothing', async () => {
  await assert.rejects(disconnectPlugin(ARR, 'a', rig({}).deps), /nothing saved/)
  for (const id of Object.keys(OWN_PAGE_PLUGINS)) {
    await assert.rejects(disconnectPlugin({ ...ARR, id }, 'a', rig({ x: 'y' }).deps), (e: any) => e.code === 'use_page')
  }
  const r = rig({ sonarr_url: 'http://10.0.0.5:8989' })
  r.deps.audit = async () => { throw new Error('audit down') }
  await assert.rejects(disconnectPlugin(ARR, 'a', r.deps), /audit down/)
  assert.deepEqual(r.events, [])
  assert.equal(r.get().sonarr_url, 'http://10.0.0.5:8989')
})
