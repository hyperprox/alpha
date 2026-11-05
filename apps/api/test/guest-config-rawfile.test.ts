// The whole-file writer for raw lxc lines: PVE-compatible parsing, a strict inventory-based allowlist, exact
// rewrites (mixed line endings included), and a locked compare-and-swap script that verifies devices itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  splitConf, rewriteRawLines, writeScript, readScript, parseRead, sha256, parseRawLine, rawLineAllowed, rawLineForm,
  cleanupScript, verifyScript, parseVerify, type RawAllow,
} from '../src/lib/guest-config/rawfile'
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
  'lxc.environment.runtime: B=2',
  'lxc.rootfs.options: ro',
  'memory: 512',
  '',
].join('\n')

const MIXED = 'arch: amd64\r\nlxc.cgroup2.devices.allow: c 226:* rwm\r\n\n[pve:pending]\ncores: 2\n'
const MIXED_SNAP = 'arch: amd64\r\nlxc.cgroup2.devices.allow: c 226:* rwm\r\n\n[snap1]\r\nlxc.cgroup2.devices.allow: c 226:* rwm\n'
const NV: RawAllow = {
  devices: new Set(['/dev/nvidia0', '/dev/nvidiactl', '/dev/nvidia-uvm', '/dev/dri/renderD128', '/dev/dri/card0', '/dev/nvidia-caps/nvidia-cap1', '/dev/net/tun']),
  majors: new Set([195, 226, 508, 511, 10]),
}

test('raw lines parse the way Proxmox parses them: dashes in keys, "key = value", trimmed values, no leading whitespace, PVE’s key filter', () => {
  assert.deepEqual(parseRawLine('lxc.hook.pre-start: /x'), ['lxc.hook.pre-start', '/x'])
  assert.deepEqual(parseRawLine('lxc.cgroup2.devices.allow = c 226:* rwm'), ['lxc.cgroup2.devices.allow', 'c 226:* rwm'])
  assert.deepEqual(parseRawLine('lxc.mount.entry:   /a a none bind   '), ['lxc.mount.entry', '/a a none bind'])
  assert.equal(parseRawLine('   lxc.environment: A=1'), null, 'PVE anchors the key at the start of the line')
  assert.equal(parseRawLine('memory: 512'), null)
  for (const f of [FILE, ODD, FILE.replace(/\n/g, '\r\n'), MIXED, MIXED_SNAP]) assert.deepEqual(splitConf(f).rawMain, pveParseRaw(f), JSON.stringify(f.slice(0, 50)))
  assert.ok(!splitConf(ODD).rawMain.some(([k]) => k === 'lxc.environment.runtime' || k === 'lxc.rootfs.options'), 'runtime env and invalid keys are not raw lines to PVE')
})

test('only device lines may be written: the key and the form', () => {
  assert.equal(rawLineForm(['lxc.cgroup2.devices.allow', 'c 226:* rwm']), null)
  assert.equal(rawLineForm(['lxc.mount.entry', '/dev/nvidia0 dev/nvidia0 none bind,optional,create=file']), null)
  assert.equal(rawLineForm(['lxc.mount.entry', '/dev/nvidia-modeset dev/nvidia-modeset none bind,optional,create=file,mode=0666']), null, 'removing a hand-written line needs only the form')
  assert.match(rawLineForm(['lxc.hook.pre-start', '/x'])!, /hooks and other raw settings run as root on the node/)
  for (const k of ['lxc.hook.start-host', 'lxc.apparmor.profile', 'lxc.idmap', 'lxc.cap.drop']) assert.match(rawLineForm([k, 'x'])!, /only edits device lines/)
})

test('an added mount source must be an exact character device from the node inventory, never a symlink, a directory outside the two GPU ones, or host memory', () => {
  assert.equal(rawLineAllowed(['lxc.mount.entry', '/dev/nvidia0 dev/nvidia0 none bind,optional,create=file'], NV), null)
  assert.equal(rawLineAllowed(['lxc.mount.entry', '/dev/dri dev/dri none bind,optional,create=dir'], NV), null)
  assert.equal(rawLineAllowed(['lxc.mount.entry', '/dev/nvidia-caps dev/nvidia-caps none bind,optional,create=dir'], NV), null)
  const refused: Array<[string, RegExp]> = [
    ['/dev/. dev/. none bind,create=dir', /“\.” or “\.\.”/],
    ['/dev/shm dev/shm none bind,create=dir', /not a device/],
    ['/dev/pts dev/pts none bind,create=dir', /not a device/],
    ['/dev/fd dev/fd none bind,create=dir', /not a device/],
    ['/dev/disk/by-id dev/disk/by-id none bind,create=dir', /disk/],
    ['/dev/disk/by-id/nvme-x dev/disk/by-id/nvme-x none bind,create=file', /disk/],
    ['/dev/mem dev/mem none bind,create=file', /host memory/],
    ['/dev/kmem dev/kmem none bind,create=file', /host memory/],
    ['/dev/port dev/port none bind,create=file', /host memory/],
    ['/dev/sda dev/sda none bind,create=file', /disks are out of scope/],
    ['/dev/ttyS9 dev/ttyS9 none bind,create=file', /not in .*inventory/],
    ['/dev/dri/../mem dev/dri/../mem none bind,create=file', /“\.” or “\.\.”/],
    ['/etc dev/x none bind', /only \/dev device nodes/],
  ]
  for (const [v, re] of refused) {
    const why = rawLineAllowed(['lxc.mount.entry', v], NV)
    assert.ok(why && re.test(why), `${v} → ${why}`)
  }
  assert.match(rawLineAllowed(['lxc.mount.entry', '/dev/nvidia0 dev/nvidia0 none bind,optional,create=file'], null)!, /inventory/)
})

test('an added cgroup line names one inventory major, character devices only, rwm', () => {
  assert.equal(rawLineAllowed(['lxc.cgroup2.devices.allow', 'c 226:* rwm'], NV), null)
  assert.equal(rawLineAllowed(['lxc.cgroup2.devices.allow', 'c 195:0 rwm'], NV), null)
  for (const [v, re] of [['c *:* rwm', /every device/], ['a', /every device/], ['b 8:* rwm', /block/], ['c 1:1 rwm', /not a GPU or inventory device/], ['c 226:* r', /rwm/]] as Array<[string, RegExp]>) {
    const why = rawLineAllowed(['lxc.cgroup2.devices.allow', v], NV)
    assert.ok(why && re.test(why), `${v} → ${why}`)
  }
})

test('the node verifies every added source itself: a character device (or one of the two directories), not a symlink, realpath equal', () => {
  const v = verifyScript(['/dev/nvidia0', '/dev/dri'])
  assert.ok(v.includes('realpath -e') && v.includes('[ -L "$p" ]') && v.includes('[ -c "$p" ]'))
  assert.deepEqual(parseVerify('C /dev/nvidia0 c3 /dev/nvidia0\nD /dev/dri /dev/dri\nL /dev/fd\nM /dev/nvidia1\nO /dev/sda\n'), {
    '/dev/nvidia0': { kind: 'char', major: 0xc3, real: '/dev/nvidia0' }, '/dev/dri': { kind: 'dir', real: '/dev/dri' },
    '/dev/fd': { kind: 'symlink' }, '/dev/nvidia1': { kind: 'missing' }, '/dev/sda': { kind: 'other' },
  })
  assert.throws(() => verifyScript(["/dev/x'; rm -rf /"]))
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

test('removing an oddly written line removes exactly that line, and everything around it is untouched', () => {
  const out = rewriteRawLines(ODD, { remove: [['lxc.cgroup2.devices.allow', 'c 226:* rwm'], ['lxc.mount.entry', '/dev/dri/renderD128 dev/dri/renderD128 none bind,optional,create=file']] })
  assert.equal(out, ['arch: amd64', 'lxc.hook.pre-start: /var/lib/vz/snippets/hook.sh', '   lxc.environment: A=1', 'lxc.environment.runtime: B=2', 'lxc.rootfs.options: ro', 'memory: 512', ''].join('\n'))
})

test('CRLF files keep CRLF on the lines HyperProx adds', () => {
  const crlf = FILE.replace(/\n/g, '\r\n')
  const out = rewriteRawLines(crlf, { add: [['lxc.mount.entry', '/dev/nvidia0 dev/nvidia0 none bind,optional,create=file']], remove: [['lxc.cgroup2.devices.allow', 'c 10:200 rwm']] })
  assert.ok(out.includes('lxc.mount.entry: /dev/nvidia0 dev/nvidia0 none bind,optional,create=file\r\n'))
  assert.ok(!/[^\r]\n/.test(out), 'no bare LF anywhere')
})

test('mixed line endings: sections are found, pending is refused (any case), and an added line takes its neighbour’s ending', () => {
  assert.equal(splitConf(MIXED).hasPending, true)
  assert.throws(() => rewriteRawLines(MIXED, { add: [['lxc.mount.entry', '/dev/nvidia0 dev/nvidia0 none bind,optional,create=file']] }), /pending/)
  assert.equal(splitConf('arch: amd64\n[PVE:Pending]\ncores: 1\n').hasPending, true)
  const out = rewriteRawLines(MIXED_SNAP, { add: [['lxc.mount.entry', '/dev/nvidia0 dev/nvidia0 none bind,optional,create=file']] })
  assert.equal(out, 'arch: amd64\r\nlxc.cgroup2.devices.allow: c 226:* rwm\r\nlxc.mount.entry: /dev/nvidia0 dev/nvidia0 none bind,optional,create=file\r\n\n[snap1]\r\nlxc.cgroup2.devices.allow: c 226:* rwm\n')
  assert.deepEqual(pveParseRaw(out), splitConf(out).rawMain)
})

test('a rewrite refuses a line that is not there, a pending section, a disallowed key and a line with a newline in it', () => {
  assert.throws(() => rewriteRawLines(FILE, { remove: [['lxc.mount.entry', '/dev/nope dev/nope none bind']] }), /not in the main section/)
  assert.throws(() => rewriteRawLines(FILE + '[pve:pending]\ncores: 4\n', { add: [['lxc.mount.entry', '/dev/x dev/x none bind,optional']] }), /pending/)
  assert.throws(() => rewriteRawLines('arch: amd64\n[pve:PENDING]\ncores: 1\n', { add: [['lxc.mount.entry', '/dev/x dev/x none bind,optional']] }), /pending/)
  assert.throws(() => rewriteRawLines(FILE, { add: [['lxc.mount.entry', 'a\nmemory: 99999']] }), /one line/)
  assert.throws(() => rewriteRawLines(FILE, { add: [['lxc.hook.pre-start', '/x']] }), /run as root/)
  assert.throws(() => rewriteRawLines(FILE, { add: [['memory', '1']] }), /lxc\./)
})

test('the node script: config lock across check and rename, refuses lock: and pending, re-checks added devices, cleans up on every path', () => {
  const s = writeScript('node-a', 901, sha256(FILE), FILE, ['/dev/nvidia0'])
  assert.match(s, /^set -eu/)
  assert.ok(s.includes('flock -w') && s.includes('/run/lock/lxc/pve-config-901.lock'))
  assert.ok(s.indexOf('flock -w') < s.indexOf('sha256sum'), 'the lock is taken before the hash check')
  assert.ok(s.includes("trap 'rm -f \"$t\"' EXIT"), 'the temp file goes on every exit')
  assert.ok(s.includes('HPX-GUEST-LOCKED'))
  assert.ok(s.includes("grep -qi '^\\[pve:pending\\]'"), 'pending is refused in the script too, case-insensitively')
  assert.ok(s.includes('HPX-BAD-DEVICE') && s.indexOf('HPX-BAD-DEVICE') < s.indexOf('mv -f'), 'added sources are re-checked before the rename')
  assert.match(s, /mv -f "\$t" "\$f"/)
  assert.ok(!/>>/.test(s) && !/sed -i/.test(s), 'never appends, never edits in place')
  assert.ok(!s.includes('memory: 512'), 'content travels base64-encoded')
  assert.throws(() => writeScript('node a;rm', 901, sha256(FILE), FILE))
  assert.throws(() => writeScript('node-a', 901, sha256(FILE), FILE, ['/dev/x y']))
  const r = readScript('node-a', 901)
  assert.ok(r.includes('base64 -w0') && r.includes('.tmp.hpx.'), 'the read lists leftover temp files')
  assert.ok(!r.includes('flock'), 'a plain read takes no lock')
  assert.ok(readScript('node-a', 901, { locked: true }).includes('flock -w'), 'the re-read after a dropped session waits for the config lock')
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
