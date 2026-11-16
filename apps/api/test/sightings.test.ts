// Where an app was seen without looking inside a guest: the scan's probe and the Catalogue's finished installs.
// Nextcloud's list (lib/nextcloud/index.ts) was pinned before the shared reader replaced its copy; Homepage's
// policy (a failed scan sees nothing; any recorded install counts) is pinned through sightingsOf.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ProxmoxClient } from '../src/lib/proxmox-client'
import { ServiceScanCache } from '../src/lib/service-scan'
import { MemoryWizardStore, setWizardStore } from '../src/lib/catalogue-store'
import { sightings as nextcloudSightings } from '../src/lib/nextcloud'

const saved = { fetchStrict: (ProxmoxClient.prototype as any).fetchStrict, result: (ServiceScanCache.prototype as any).result, env: { ...process.env } }
let scan: any[] | Error = []
let rows: any[] = []
const store = new MemoryWizardStore()
beforeEach(() => {
  Object.assign(process.env, { PROXMOX_HOST: 'pve.invalid', PROXMOX_PORT: '8006', PROXMOX_USER: 'u@pve', PROXMOX_TOKEN_ID: 't', PROXMOX_TOKEN_SECRET: 's' })
  ;(ProxmoxClient.prototype as any).fetchStrict = async () => rows
  ;(ServiceScanCache.prototype as any).result = async () => { if (scan instanceof Error) throw scan; return { findings: scan } }
  setWizardStore(store)
})
afterEach(() => { Object.assign(ProxmoxClient.prototype, { fetchStrict: saved.fetchStrict }); (ServiceScanCache.prototype as any).result = saved.result; process.env = { ...saved.env } })

let n = 0
const job = async (data: any) => { await store.put({ id: `j${++n}`, kind: 'job', owner: 'a', data, expiresAt: null } as any) }
const lxc = (vmid: number, name: string, extra: any = {}) => ({ type: 'lxc', vmid, name, node: 'n1', status: 'running', ...extra })

test('Nextcloud: scan sightings first, then completed Catalogue installs of a guest that is still that install', async () => {
  rows = [lxc(150, 'cloud'), lxc(151, 'other'), lxc(50, 'low'), lxc(152, 'tmpl', { template: 1 }), { type: 'qemu', vmid: 160, name: 'vm', node: 'n1', status: 'running' }]
  scan = [
    { key: 'nextcloud', address: 'http://10.0.0.50:80', host: '10.0.0.50', guest: { type: 'lxc', vmid: 150 } },
    { key: 'homepage', address: 'http://10.0.0.51', host: '10.0.0.51', guest: { type: 'lxc', vmid: 151 } },
    { key: 'nextcloud', address: 'http://10.0.0.9', host: '10.0.0.9', guest: null },
  ]
  await job({ recipeId: 'nextcloud', status: 'completed', vmid: 150, hostname: 'cloud', url: 'https://cloud.example.test', ip: '10.0.0.50/24', adminCredential: { user: 'ncadmin' } })
  await job({ recipeId: 'nextcloud', status: 'completed', vmid: 151, hostname: 'cloud', url: 'x' })        // guest 151 is another guest now
  await job({ recipeId: 'nextcloud', status: 'running', vmid: 150, hostname: 'cloud' })                       // not finished
  await job({ recipeId: 'nextcloud', status: 'completed', vmid: 50, hostname: 'low' })                         // below 100
  await job({ recipeId: 'nextcloud', status: 'completed', vmid: 152, hostname: 'tmpl' })                       // a template is not listed
  await job({ recipeId: 'nextcloud', status: 'completed', vmid: 160, hostname: 'vm' })                         // a VM is not a container
  await job({ recipeId: 'homepage', status: 'completed', vmid: 150, hostname: 'cloud' })
  const out = await nextcloudSightings()
  assert.deepEqual(out.map(s => `${s.via}:${s.guest.kind}${s.guest.vmid}`), ['scan:lxc150', 'catalogue:lxc150'])
  assert.deepEqual(out[0], { guest: { kind: 'lxc', vmid: 150 }, url: 'http://10.0.0.50:80', via: 'scan', ip: '10.0.0.50' })
  assert.deepEqual(out[1], { guest: { kind: 'lxc', vmid: 150 }, url: 'https://cloud.example.test', via: 'catalogue', ip: '10.0.0.50', admin: 'ncadmin' })
})

test('Nextcloud: a scan that cannot be read throws; a guest list that cannot be read drops the Catalogue sightings only', async () => {
  scan = new Error('scan down'); rows = []
  await assert.rejects(nextcloudSightings(), /scan down/)
  scan = [{ key: 'nextcloud', address: 'http://10.0.0.50', host: '10.0.0.50', guest: { type: 'lxc', vmid: 150 } }]
  await job({ recipeId: 'nextcloud', status: 'completed', vmid: 150, hostname: 'cloud' })
  ;(ProxmoxClient.prototype as any).fetchStrict = async () => { throw new Error('pve down') }
  const out = await nextcloudSightings()
  assert.deepEqual(out.map(s => s.via), ['scan'])
})

test('a Catalogue record without a hostname counts for any guest with that id; a url that is not text is none', async () => {
  rows = [lxc(150, 'whatever')]; scan = []
  await job({ recipeId: 'nextcloud', status: 'completed', vmid: 150, url: 42 })
  const out = await nextcloudSightings()
  assert.equal(out.length, 1); assert.equal(out[0].url, null); assert.equal(out[0].ip, null); assert.equal(out[0].admin, null)
})

import { sightingsOf } from '../src/lib/catalogue/sightings'

test('Homepage policy: a failed scan sees nothing, the Catalogue still counts, any listed guest of that id with the same name', async () => {
  scan = new Error('scan down')
  await job({ recipeId: 'homepage', status: 'completed', vmid: 120, hostname: 'home', url: 'https://home.example.test' })
  await job({ recipeId: 'homepage', status: 'completed', vmid: 121, hostname: 'home' })           // reused by another guest
  await job({ recipeId: 'homepage', status: 'completed', vmid: 0, hostname: 'home' })              // no usable id
  const guests = async () => [{ vmid: 120, name: 'home' }, { vmid: 121, name: 'something-else' }]
  const out = await sightingsOf('homepage', 'homepage', { guests, minVmid: 1, ignoreScanFailure: true })
  assert.deepEqual(out.scan, [])
  assert.deepEqual(out.catalogue.map(s => [s.guest.vmid, s.url]), [[120, 'https://home.example.test']])
  await assert.rejects(sightingsOf('homepage', 'homepage', { guests, minVmid: 1 }), /scan down/)
  scan = [{ key: 'homepage', address: 'http://10.0.0.7:3000', host: '10.0.0.7', guest: { type: 'lxc', vmid: 120 } }, { key: 'nextcloud', address: 'x', guest: { type: 'lxc', vmid: 5 } }]
  const again = await sightingsOf('homepage', 'homepage', { guests, minVmid: 1 })
  assert.deepEqual(again.scan.map(s => [s.guest.vmid, s.url]), [[120, 'http://10.0.0.7:3000']])
})
