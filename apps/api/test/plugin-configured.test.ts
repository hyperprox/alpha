// "Is this plug-in set up" has one answer (lib/plugin-host.ts pluginConfigured), which the gallery count, the
// pills, the dashboard and the detail page all read. A plug-in with no required settings used to count as set up
// on a fresh install: ASUS, QNAP and PBS (their devices live in their own list) and MeshCentral.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pluginConfigured, instanceCount, pluginNeeds } from '../src/lib/plugin-host'
import { findPlugin } from '../src/plugins'

const one = JSON.stringify([{ id: 'a1', name: 'Router' }])

test('ASUS, QNAP and PBS are set up only once a device is saved in their list', async () => {
  for (const id of ['asus', 'qnap', 'pbs']) {
    const p = findPlugin(id)!
    assert.ok(p, id)
    assert.equal(await pluginConfigured(p, {}), false, `${id}: fresh install`)
    assert.equal(await pluginConfigured(p, { instances: '[]' }), false, `${id}: an empty list`)
    assert.equal(await pluginConfigured(p, { instances: 'not json' }), false, `${id}: unreadable`)
    assert.equal(await pluginConfigured(p, { instances: one }), true, `${id}: one device`)
  }
  assert.equal(instanceCount({ instances: one }), 1)
})

test('MeshCentral is not set up (nor "Active") until it knows where MeshCentral is', async () => {
  const p = findPlugin('meshcentral')!
  assert.equal(await pluginConfigured(p, {}), false)
  assert.equal(await pluginConfigured(p, { public_url: '  ' }), false)
  assert.equal(await pluginConfigured(p, { public_url: 'https://mesh.example.com' }), true)
})

test('a plug-in with required settings: set up when they are stored, as before', async () => {
  const p = findPlugin('arrstack')!
  assert.equal(await pluginConfigured(p, {}), false)
  assert.equal(await pluginConfigured(p, { sonarr_url: 'http://192.0.2.30:8989', sonarr_key: 'k' }), true)
  const ha = findPlugin('home-assistant')!
  assert.equal(await pluginConfigured(ha, { url: 'http://192.0.2.40:8123', token: 't' }), true, 'a core transport with settings is judged by them')
})

test('a plug-in that is not set up always says what it needs', () => {
  assert.equal(pluginNeeds(findPlugin('asus')!, []), 'a device added on its page')
  assert.equal(pluginNeeds(findPlugin('meshcentral')!, []), 'a public URL')
  assert.equal(pluginNeeds(findPlugin('arrstack')!, ['Sonarr address', 'Sonarr API key']), 'Sonarr address and Sonarr API key')
})
