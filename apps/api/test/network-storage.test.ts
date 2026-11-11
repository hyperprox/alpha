import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupNetworkStorage, networkServer, readNetworkStorage, readPanel } from '../src/lib/clusters/overview'

const TB = 1e12
const row = (device: string, mountpoint: string, size: number, avail: number, node = 'n1') => ({
  size: { metric: { device, mountpoint, node, fstype: 'nfs4' }, value: size },
  avail: { metric: { device, mountpoint, node, fstype: 'nfs4' }, value: avail },
})
const group = (rows: ReturnType<typeof row>[]) => groupNetworkStorage(rows.map(r => r.size), rows.map(r => r.avail))

test('network storage: device parsing for NFS, CIFS, sshfs and IPv6', () => {
  assert.equal(networkServer('10.0.0.5:/Movies'), '10.0.0.5')
  assert.equal(networkServer('nas.example.lan:/export/tv'), 'nas.example.lan')
  assert.equal(networkServer('//10.0.0.6/media'), '10.0.0.6')
  assert.equal(networkServer('//user@Files.Example/share'), 'files.example')
  assert.equal(networkServer('user@10.0.0.7:/srv'), '10.0.0.7')
  assert.equal(networkServer('[fd00::5]:/export'), 'fd00::5')
  assert.equal(networkServer('/dev/sda1'), null)
  assert.equal(networkServer('tmpfs'), null)
})

test('network storage: several exports of one volume count once', () => {
  const out = group([
    row('10.0.0.5:/Movies', '/mnt/movies', 40 * TB, 10 * TB),
    row('10.0.0.5:/Shows', '/mnt/shows', 40 * TB, 10 * TB),
    row('10.0.0.5:/Music', '/mnt/music', 40 * TB, 10 * TB),
  ])
  assert.deepEqual(out, [{ server: '10.0.0.5', shares: 3, usedBytes: 30 * TB, totalBytes: 40 * TB, pct: 75 }])
})

test('network storage: two servers give two entries, and a server with two volumes adds them', () => {
  const out = group([
    row('10.0.0.5:/a', '/mnt/a', 10 * TB, 5 * TB),
    row('10.0.0.8:/b', '/mnt/b', 20 * TB, 2 * TB),
    row('10.0.0.8:/c', '/mnt/c', 4 * TB, 1 * TB),
  ])
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { server: '10.0.0.5', shares: 1, usedBytes: 5 * TB, totalBytes: 10 * TB, pct: 50 })
  assert.deepEqual(out[1], { server: '10.0.0.8', shares: 2, usedBytes: 21 * TB, totalBytes: 24 * TB, pct: 88 })
})

test('network storage: the same mount seen from two nodes counts once', () => {
  const out = group([row('10.0.0.5:/a', '/mnt/a', 10 * TB, 5 * TB, 'n1'), row('10.0.0.5:/a', '/mnt/a', 10 * TB, 5 * TB, 'n2')])
  assert.deepEqual(out, [{ server: '10.0.0.5', shares: 1, usedBytes: 5 * TB, totalBytes: 10 * TB, pct: 50 }])
})

test('network storage: Proxmox storages under /mnt/pve are left out, and so are rows with no size or no free figure', () => {
  const out = group([
    row('10.0.0.5:/pbs', '/mnt/pve/nas-backup', 10 * TB, 1 * TB),
    row('//10.0.0.6/iso', '/mnt/pve/iso', 10 * TB, 1 * TB),
    row('10.0.0.5:/zero', '/mnt/zero', 0, 0),
    row('10.0.0.9:/media', '/mnt/media', 8 * TB, 4 * TB),
  ])
  assert.deepEqual(out.map(o => o.server), ['10.0.0.9'])
  const lone = groupNetworkStorage([row('10.0.0.9:/x', '/mnt/x', 1, 1).size], [])
  assert.deepEqual(lone, [])
})

test('network storage: CIFS devices group by host', () => {
  const out = group([row('//10.0.0.6/films', '/mnt/films', 6 * TB, 3 * TB), row('//10.0.0.6/shows', '/mnt/shows', 6 * TB, 3 * TB)])
  assert.deepEqual(out, [{ server: '10.0.0.6', shares: 2, usedBytes: 3 * TB, totalBytes: 6 * TB, pct: 50 }])
})

test('network storage: the Prometheus query is scoped to the cluster and its own nodes', async () => {
  const seen: string[] = []
  const r = row('10.0.0.5:/a', '/mnt/a', 10 * TB, 5 * TB, 'pve@c1')
  const foreign = row('10.0.0.5:/a', '/mnt/a', 99 * TB, 1 * TB, 'other@c2')
  const prom = async (e: string) => { seen.push(e); return e.startsWith('node_filesystem_size') ? [r.size, foreign.size] : [r.avail, foreign.avail] }
  const out = await readNetworkStorage({ id: 'c1', kind: 'remote' }, ['pve@c1'], prom)
  assert.ok(seen.every(e => e.includes('hpx_cluster="c1"') && e.includes('fstype=~"nfs4?|cifs|smb3|fuse.sshfs"')))
  assert.deepEqual(out, [{ server: '10.0.0.5', shares: 1, usedBytes: 5 * TB, totalBytes: 10 * TB, pct: 50 }])
  assert.deepEqual(await readNetworkStorage({ id: 'c1', kind: 'remote' }, [], async () => { throw new Error('down') }), [])
})

test('network storage: the panel carries it and warns at 90% full', async () => {
  const pve: any = {
    async fetchStrict(path: string) {
      if (path === '/version') return { version: '9.1' }
      if (path === '/nodes') return [{ node: 'pve', status: 'online', cpu: 0.1, maxcpu: 8, mem: 4, maxmem: 32 }]
      return []
    },
    async fetchNode() { return [] },
  }
  const full = row('10.0.0.5:/a', '/mnt/a', 10 * TB, 0.5 * TB, 'pve@c1')
  const prom = async (e: string) => (e.startsWith('node_filesystem_size') ? [full.size] : e.startsWith('node_filesystem_avail') ? [full.avail] : [])
  const c: any = { id: 'c1', name: 'Far', kind: 'remote', monitoring: {} }
  const p = await readPanel(c, { pve: () => pve, prom, now: Date.now })
  assert.deepEqual(p.networkStorage, [{ server: '10.0.0.5', shares: 1, usedBytes: 9.5 * TB, totalBytes: 10 * TB, pct: 95 }])
  assert.ok(p.attention.some(a => a.title === 'Network storage 10.0.0.5 is 95% full'))
  const q = await readPanel(c, { pve: () => pve, prom: async () => [], now: Date.now })
  assert.deepEqual(q.networkStorage, [])
})
