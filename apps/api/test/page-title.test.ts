// The top bar's title on pages named at run time (apps/frontend/lib/page-title.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pluginIdOf, resolvePageMeta, PLUGIN_NAMES } from '../../frontend/lib/page-title'

const base = { crumb: 'Plug-ins', title: 'Plug-in' }

test('a plug-in page is titled with the plug-in, and its crumb links back to the list', () => {
  assert.deepEqual(resolvePageMeta(base, '/plugins/mikrotik', { mikrotik: 'Router' }), { crumb: 'Plug-ins', crumbHref: '/plugins', title: 'Router' })
  assert.equal(resolvePageMeta(base, '/plugins/home-assistant', null).title, 'Home Assistant')
  assert.equal(resolvePageMeta(base, '/plugins/qnap', {}).title, 'QNAP')
})

test('before the list loads the built-in name shows; an unknown id is made readable, never "Plug-in"', () => {
  for (const [id, name] of Object.entries(PLUGIN_NAMES)) assert.equal(resolvePageMeta(base, `/plugins/${id}`).title, name)
  assert.equal(resolvePageMeta(base, '/plugins/uptime-kuma').title, 'Uptime kuma')
})

test('only /plugins/<id> is a plug-in page', () => {
  assert.equal(pluginIdOf('/plugins'), null)
  assert.equal(pluginIdOf('/plugins/'), null)
  assert.equal(pluginIdOf('/plugins/plex'), 'plex')
  assert.equal(pluginIdOf('/plugins/plex/'), 'plex')
  assert.equal(pluginIdOf('/plugins/plex/extra'), null)
  const dash = { crumb: 'Overview', title: 'Dashboard' }
  assert.deepEqual(resolvePageMeta(dash, '/dashboard', { plex: 'Plex' }), dash)
})

test('a cluster page links its crumb back to the Command center; Add a server keeps its own', () => {
  assert.equal(resolvePageMeta({ crumb: 'Command center', title: 'Cluster' }, '/clusters/c3f1a2b4c5d').crumbHref, '/clusters')
  assert.equal(resolvePageMeta({ crumb: 'Command center', title: 'Updates' }, '/clusters/c3f1a2b4c5d/updates').crumbHref, '/clusters')
  assert.equal(resolvePageMeta({ crumb: 'Command center', title: 'Add a server' }, '/clusters/add').crumbHref, undefined)
})
