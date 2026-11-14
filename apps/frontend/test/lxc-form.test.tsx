// The +LXC form's use of the server's numbering proposal (lib/lxc-form.ts): what lands in the form, and what does not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyProposal, proposedNet0, defaultNode } from '../lib/lxc-form'

// What POST /api/catalogue/wizard/propose answers on a cluster numbered <node#><two digits> <-> .2<digits>.
const convention = { vmid: 701, ip: '192.0.2.201/24', gateway: '192.0.2.1', bridge: 'vmbr0' }
const blank = { vmid: '100', net0: 'name=eth0,bridge=vmbr0,ip=dhcp', hostname: 'x' }

test('a proposal fills the ID and the network, and nothing else', () => {
  const f = applyProposal(blank, convention, { id: false, net: false })
  assert.equal(f.vmid, '701')
  assert.equal(f.net0, 'name=eth0,bridge=vmbr0,ip=192.0.2.201/24,gw=192.0.2.1')
  assert.equal(f.hostname, 'x')
})

test('a field the person typed is kept; the other still takes the proposal', () => {
  assert.deepEqual(applyProposal({ ...blank, vmid: '555' }, convention, { id: true, net: false }).vmid, '555')
  assert.match(applyProposal({ ...blank, vmid: '555' }, convention, { id: true, net: false }).net0, /ip=192\.0\.2\.201\/24/)
  const n = applyProposal({ ...blank, net0: 'custom' }, convention, { id: false, net: true })
  assert.deepEqual([n.vmid, n.net0], ['701', 'custom'])
})

test('net0 carries VLAN and DHCP as the server said', () => {
  assert.equal(proposedNet0({ vmid: 1, ip: '192.0.2.5/24', gateway: '192.0.2.1', vlan: 30 }), 'name=eth0,bridge=vmbr0,ip=192.0.2.5/24,gw=192.0.2.1,tag=30')
  assert.equal(proposedNet0({ vmid: 1, ip: 'dhcp', gateway: '192.0.2.1', bridge: 'br1' }), 'name=eth0,bridge=br1,ip=dhcp')
})

test('the form starts on a node without waiting on anything, so the proposal can start at once', () => {
  assert.equal(defaultNode([{ node: 'pve3', status: 'online' }, { node: 'pve1', status: 'online' }], 'pve3'), 'pve3')
})

const load = (q: string): Promise<{ versionLabel(): string }> => import(('../components/layout/version' + q) as string)

test('versionLabel (the About Build row, the sidebar and Updates): "v0.2.0-alpha (1a2b3c4)", just the version without a commit', async () => {
  process.env.NEXT_PUBLIC_APP_VERSION = '0.2.0-alpha'; process.env.NEXT_PUBLIC_GIT_SHA = '1a2b3c4'
  const withSha = await load('?with-sha')
  assert.equal(withSha.versionLabel(), 'v0.2.0-alpha (1a2b3c4)')
  process.env.NEXT_PUBLIC_GIT_SHA = ''
  const without = await load('?no-sha')
  assert.equal(without.versionLabel(), 'v0.2.0-alpha')
})
