// The whole-file writer for raw lxc lines: PVE-compatible parsing, an allowlist, exact rewrites, a locked
// compare-and-swap script that cleans up after itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitConf, rewriteRawLines, writeScript, readScript, parseRead, sha256, parseRawLine, rawLineAllowed, cleanupScript } from '../src/lib/guest-config/rawfile'
import { pveParseRaw } from './fakes/pve-conf'

const FILE = [
  'arch: amd64', 'cores: 2', 'hostname: web', 'memory: 512',
  'lxc.cgroup2.devices.allow: c 10:200 rwm', 'lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file',
  'net0: name=eth0,bridge=vmbr0,ip=dhcp,type=veth', 'parent: before-change', 'rootfs: fast-ssd:vm-901-disk-0,size=4G', 'unprivileged: 1',
  '', '[before-change]', 'arch: amd64', 'cores: 1', 'lxc.cgroup2.devices.allow: c 10:200 rwm', 'snaptime: 1700000000', '',
].join('\n')

const ODD = [
  'arch: amd64',
  'lxc.hook.pre-start: /var/lib/vz/snippets/hook.sh',
  'lxc.cgroup2.devices.allow = c 226:* rwm',
  'lxc.mount.entry:   /dev/dri/renderD128 dev/dri/renderD128 none bind,optional,create=file   ',
  '   lxc.environment: A=1',
  'memory: 512',
  '',
].join('\n')

test('raw lines parse the way Proxmox parses them: dashes in keys, "key = value", trimmed whitespace', () => {
  assert.deepEqual(parseRawLine('lxc.hook.pre-start: /x'), ['lxc.hook.pre-start', '/x'])
  assert.deepEqual(parseRawLine('lxc.cgroup2.devices.allow = c 226:* rwm'), ['lxc.cgroup2.devices.allow', 'c 226:* rwm'])
  assert.deepEqual(parseRawLine('lxc.mount.entry:   /a a none bind   '), ['lxc.mount.entry', '/a a none bind'])
  assert.deepEqual(parseRawLine('   lxc.environment: A=1'), ['lxc.environment', 'A=1'])
  assert.equal(parseRawLine('memory: 512'), null)
  // The writer's split agrees with an independent PVE-style parser on every fixture.
  for (const f of [FILE, ODD, FILE.replace(/\n/g, '\r\n')]) assert.deepEqual(splitConf(f).rawMain, pveParseRaw(f))
})

test('only device lines may be written: cgroup device allows and /dev bind mounts, in their exact form', () => {
  assert.equal(rawLineAllowed(['lxc.cgroup2.devices.allow', 'c 226:* rwm']), null)
  assert.equal(rawLineAllowed(['lxc.cgroup.devices.allow', 'c 195:0 rw']), null)
  assert.equal(rawLineAllowed(['lxc.mount.entry', '/dev/nvidia0 dev/nvidia0 none bind,optional,create=file']), null)
  assert.equal(rawLineAllowed(['lxc.mount.entry', '/dev/dri dev/dri none bind,optional,create=dir']), null)
  for (const bad of [
    ['lxc.hook.start-host', '/bin/sh -c id'], ['lxc.apparmor.profile', 'unconfined'], ['lxc.idmap', 'g 0 100000 65536'], ['lxc.cap.drop', ''],
    ['lxc.mount.entry', '/etc dev/x none bind'], ['lxc.mount.entry', '/dev/x etc/x none bind'], ['lxc.mount.entry', '/dev/x dev/y none bind'],
    ['lxc.mount.entry', '/dev/x dev/x none bind,optional,create=file,exec'], ['lxc.mount.entry', '/dev/../etc dev/../etc none bind'],
    ['lxc.cgroup2.devices.allow', 'a'], ['lxc.cgroup2.devices.allow', 'b 8:* rwm'],
  ] as Array<[string, string]>) assert.match(rawLineAllowed(bad) ?? '', /only edits device lines|device|form/, bad.join(': '))
  assert.match(rawLineAllowed(['lxc.hook.pre-start', '/x'])!, /hooks and other raw settings run as root on the node/)
})

test('a rewrite changes only the main section’s raw lines; every other byte stays, snapshots included', () => {
  const out = rewriteRawLines(FILE, { remove: [['lxc.cgroup2.devices.allow', 'c 10:200 rwm']], add: [['lxc.cgroup2.devices.allow', 'c 226:* rwm'], ['lxc.mount.entry', '/dev/dri/renderD128 dev/dri/renderD128 none bind,optional,create=file']] })
  const lines = out.split('\n')
  const snap = lines.indexOf('[before-change]')
  assert.ok(!lines.slice(0, snap).includes('lxc.cgroup2.devices.allow: c 10:200 rwm'))
  assert.ok(lines.slice(snap).includes('lxc.cgroup2.devices.allow: c 10:200 rwm'), 'the snapshot keeps its line')
  assert.equal(out.slice(out.indexOf('[before-change]')), FILE.slice(FILE.indexOf('[before-change]')), 'snapshot section byte for byte')
  assert.equal(rewriteRawLines(FILE, {}), FILE, 'no change is the same bytes')
  assert.deepEqual(pveParseRaw(out), splitConf(out).rawMain)
})

test('removing an oddly written line removes exactly that line, and the hook line next to it is untouched', () => {
  const out = rewriteRawLines(ODD, { remove: [['lxc.cgroup2.devices.allow', 'c 226:* rwm'], ['lxc.mount.entry', '/dev/dri/renderD128 dev/dri/renderD128 none bind,optional,create=file']] })
  assert.equal(out, ['arch: amd64', 'lxc.hook.pre-start: /var/lib/vz/snippets/hook.sh', '   lxc.environment: A=1', 'memory: 512', ''].join('\n'))
})

test('CRLF files keep CRLF on the lines HyperProx adds', () => {
  const crlf = FILE.replace(/\n/g, '\r\n')
  const out = rewriteRawLines(crlf, { add: [['lxc.mount.entry', '/dev/nvidia0 dev/nvidia0 none bind,optional,create=file']], remove: [['lxc.cgroup2.devices.allow', 'c 10:200 rwm']] })
  assert.ok(out.includes('lxc.mount.entry: /dev/nvidia0 dev/nvidia0 none bind,optional,create=file\r\n'))
  assert.ok(!/[^\r]\n/.test(out), 'no bare LF anywhere')
})

test('a rewrite refuses a line that is not there, a pending section, a disallowed key and a line with a newline in it', () => {
  assert.throws(() => rewriteRawLines(FILE, { remove: [['lxc.mount.entry', '/dev/nope dev/nope none bind']] }), /not in the main section/)
  assert.throws(() => rewriteRawLines(FILE + '[pve:pending]\ncores: 4\n', { add: [['lxc.mount.entry', '/dev/x dev/x none bind,optional']] }), /pending/)
  assert.throws(() => rewriteRawLines(FILE, { add: [['lxc.mount.entry', 'a\nmemory: 99999']] }), /one line/)
  assert.throws(() => rewriteRawLines(FILE, { add: [['lxc.hook.pre-start', '/x']] }), /run as root/)
  assert.throws(() => rewriteRawLines(FILE, { add: [['memory', '1']] }), /lxc\./)
})

test('the node script: config lock held across check and rename, refuses a locked guest, cleans up its temp file on every path', () => {
  const s = writeScript('node-a', 901, sha256(FILE), FILE)
  assert.match(s, /^set -eu/)
  assert.ok(s.includes('flock -w') && s.includes('/run/lock/lxc/pve-config-901.lock'))
  assert.ok(s.indexOf('flock -w') < s.indexOf('sha256sum'), 'the lock is taken before the hash check')
  assert.ok(s.includes("trap 'rm -f \"$t\"' EXIT"), 'the temp file goes on every exit')
  assert.ok(s.includes('HPX-GUEST-LOCKED'))
  assert.match(s, /mv -f "\$t" "\$f"/)
  assert.ok(!/>>/.test(s) && !/sed -i/.test(s), 'never appends, never edits in place')
  assert.ok(!s.includes('memory: 512'), 'content travels base64-encoded')
  assert.throws(() => writeScript('node a;rm', 901, sha256(FILE), FILE))
  const r = readScript('node-a', 901)
  assert.ok(r.includes('base64 -w0') && r.includes('.tmp.hpx.'), 'the read lists leftover temp files')
  const c = cleanupScript('node-a', 901, ['/etc/pve/nodes/node-a/lxc/901.conf.tmp.hpx.1234'])
  assert.ok(c.includes('flock -w') && c.includes("rm -f '/etc/pve/nodes/node-a/lxc/901.conf.tmp.hpx.1234'"))
  assert.throws(() => cleanupScript('node-a', 901, ['/etc/pve/nodes/node-a/lxc/901.conf']), /temp/)
})

test('the read output carries the file, its hash and any leftover temp files', () => {
  const out = `${Buffer.from(FILE).toString('base64')}\n${sha256(FILE)}\nHPX-LEFTOVER /etc/pve/nodes/node-a/lxc/901.conf.tmp.hpx.77\n`
  const r = parseRead(out)
  assert.equal(r.text, FILE)
  assert.deepEqual(r.leftovers, ['/etc/pve/nodes/node-a/lxc/901.conf.tmp.hpx.77'])
})
