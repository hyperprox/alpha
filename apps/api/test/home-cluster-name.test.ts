// Updates and the AI page said "Home cluster" while the header showed the cluster's own name.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homeDisplayName, noteHomeClusterName, listClusters, HOME_DEFAULT_NAME } from '../src/lib/clusters/registry'

test('the home cluster is listed under Proxmox\'s name while it has the default one; a name someone gave it stays', () => {
  assert.equal(homeDisplayName(HOME_DEFAULT_NAME, 'lab'), 'lab')
  assert.equal(homeDisplayName('Basement', 'lab'), 'Basement')
  assert.equal(homeDisplayName(HOME_DEFAULT_NAME, null), HOME_DEFAULT_NAME)
  noteHomeClusterName('lab')
  assert.equal(listClusters().find(c => c.kind === 'home')!.name, 'lab')
  noteHomeClusterName(null)
  assert.equal(listClusters().find(c => c.kind === 'home')!.name, HOME_DEFAULT_NAME)
})
