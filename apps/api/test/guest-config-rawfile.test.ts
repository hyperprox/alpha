// The whole-file writer for raw lxc lines: the rewrite is exact, the guard refuses what it cannot do safely.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitConf, rewriteRawLines, writeScript, readScript, sha256 } from '../src/lib/guest-config/rawfile'

const FILE = [
  'arch: amd64', 'cores: 2', 'hostname: web', 'memory: 512',
  'lxc.cgroup2.devices.allow: c 10:200 rwm', 'lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file',
  'net0: name=eth0,bridge=vmbr0,ip=dhcp,type=veth', 'parent: before-change', 'rootfs: fast-ssd:vm-901-disk-0,size=4G', 'unprivileged: 1',
  '', '[before-change]', 'arch: amd64', 'cores: 1', 'lxc.cgroup2.devices.allow: c 10:200 rwm', 'snaptime: 1700000000', '',
].join('\n')

test('splitting keeps the main section, snapshot sections and the pending flag apart', () => {
  const s = splitConf(FILE)
  assert.equal(s.hasPending, false)
  assert.deepEqual(s.sections, ['before-change'])
  assert.deepEqual(s.rawMain, [['lxc.cgroup2.devices.allow', 'c 10:200 rwm'], ['lxc.mount.entry', '/dev/net/tun dev/net/tun none bind,create=file']])
  assert.equal(splitConf(FILE + '[pve:pending]\nmemory: 1024\n').hasPending, true)
})

test('a rewrite changes only the main section’s raw lines; every other byte stays, snapshots included', () => {
  const out = rewriteRawLines(FILE, { remove: [['lxc.cgroup2.devices.allow', 'c 10:200 rwm']], add: [['lxc.cgroup2.devices.allow', 'c 226:* rwm'], ['lxc.mount.entry', '/dev/dri/renderD128 dev/dri/renderD128 none bind,optional,create=file']] })
  const lines = out.split('\n')
  const snap = lines.indexOf('[before-change]')
  assert.ok(!lines.slice(0, snap).includes('lxc.cgroup2.devices.allow: c 10:200 rwm'))
  assert.ok(lines.slice(snap).includes('lxc.cgroup2.devices.allow: c 10:200 rwm'), 'the snapshot keeps its line')
  assert.ok(lines.slice(0, snap).includes('lxc.mount.entry: /dev/dri/renderD128 dev/dri/renderD128 none bind,optional,create=file'))
  const strip = (t: string) => t.split('\n').filter(l => !l.startsWith('lxc.')).join('\n')
  assert.equal(strip(out.slice(0, out.indexOf('[before-change]'))), strip(FILE.slice(0, FILE.indexOf('[before-change]'))))
  assert.equal(out.slice(out.indexOf('[before-change]')), FILE.slice(FILE.indexOf('[before-change]')), 'snapshot section byte for byte')
  assert.equal(rewriteRawLines(FILE, {}), FILE, 'no change is the same bytes')
})

test('a rewrite refuses a line that is not there, a pending section, and a line with a newline in it', () => {
  assert.throws(() => rewriteRawLines(FILE, { remove: [['lxc.mount.entry', '/nope']] }), /not in the main section/)
  assert.throws(() => rewriteRawLines(FILE + '[pve:pending]\ncores: 4\n', { add: [['lxc.mount.entry', '/dev/x dev/x none bind,optional']] }), /pending/)
  assert.throws(() => rewriteRawLines(FILE, { add: [['lxc.mount.entry', 'a\nmemory: 99999']] }), /one line/)
  assert.throws(() => rewriteRawLines(FILE, { add: [['memory', '1']] }), /lxc\./)
})

test('the node script compares and swaps: hash check, temp file in the same directory, rename, read back', () => {
  const s = writeScript('node-a', 901, sha256(FILE), FILE)
  assert.match(s, /^set -eu/)
  assert.ok(s.includes(`/etc/pve/nodes/node-a/lxc/901.conf`))
  assert.ok(s.includes(sha256(FILE)))
  assert.match(s, /mv -f "\$t" "\$f"/)
  assert.ok(!/>>/.test(s) && !/sed -i/.test(s), 'never appends, never edits in place')
  assert.ok(!s.includes('memory: 512'), 'content travels base64-encoded')
  assert.throws(() => writeScript('node a;rm', 901, sha256(FILE), FILE))
  assert.ok(readScript('node-a', 901).includes('base64 -w0'))
})
