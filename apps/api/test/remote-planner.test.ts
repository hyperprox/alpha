// Remote access: OS detection, the install planner, the exact client flags, and the node guard's rollback
// triggers. All pure: no machine, no provider.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseFacts, osSupport, installScript, upScript, statusScript, parseStatus, uninstallScript, updateScript,
  routingScript, DETECT_SCRIPT, SNAPSHOT_SCRIPT, type OsFacts,
} from '../src/lib/remote/scripts'
import { clientFlags, planInstall, tunFix, checkRouting, safeHostname } from '../src/lib/remote/planner'
import { parseSnapshot, compareSnapshots, snapshotReady } from '../src/lib/remote/guard'
import type { Machine } from '../src/lib/remote/types'

const facts = (over: Partial<Record<string, string>> = {}): OsFacts => parseFacts(Object.entries({
  HP_OS_ID: 'debian', HP_OS_LIKE: '', HP_OS_VERSION: '13', HP_OS_CODENAME: 'trixie', HP_OS_UBUNTU_CODENAME: '',
  HP_UNAME: 'Linux', HP_ARCH: 'x86_64', HP_PM: 'apt', HP_SYSTEMD: '1', HP_TUN: '1', HP_ROOT: '1', HP_CURL: '1', ...over,
}).map(([k, v]) => `${k}=${v}`).join('\n'))

const node: Machine  = { id: 'node-pve-a', kind: 'node', name: 'pve-a', node: 'pve-a', running: true, address: '192.0.2.11' }
const ct: Machine    = { id: 'lxc-101', kind: 'lxc', name: 'web', node: 'pve-a', vmid: 101, running: true, ostype: 'debian' }
const vm: Machine    = { id: 'qemu-102', kind: 'qemu', name: 'app', node: 'pve-a', vmid: 102, running: true, ostype: 'l26' }
const win: Machine   = { id: 'qemu-103', kind: 'qemu', name: 'desk', node: 'pve-a', vmid: 103, running: true, ostype: 'win11' }

// ── Detection ────────────────────────────────────────────────────────────────

test('detect script is read-only and reports what the planner needs', () => {
  for (const k of ['HP_OS_ID', 'HP_PM', 'HP_SYSTEMD', 'HP_TUN', 'HP_ROOT', 'HP_UNAME']) assert.match(DETECT_SCRIPT, new RegExp(k))
  assert.doesNotMatch(DETECT_SCRIPT, /apt-get (install|update)|dnf install|rm -|>\s*\/etc/)
  const f = parseFacts('noise\nHP_OS_ID=ubuntu\nHP_OS_LIKE=debian\nHP_PM=apt\nHP_TUN=0\nHP_HAS_TAILSCALE=1.90.1\n')
  assert.equal(f.id, 'ubuntu'); assert.deepEqual(f.like, ['debian']); assert.equal(f.tun, false)
  assert.equal(f.installed.tailscale, '1.90.1'); assert.equal(f.installed.netbird, undefined)
})

test('os support: apt and dnf families yes, the rest refused with a reason, Windows and macOS manual', () => {
  const deb = osSupport(facts())
  assert.ok(deb.ok); if (deb.ok) { assert.equal(deb.pm, 'apt'); assert.equal(deb.tsRepo, 'https://pkgs.tailscale.com/stable/debian/trixie') }
  const ubu = osSupport(facts({ HP_OS_ID: 'ubuntu', HP_OS_CODENAME: 'noble' }))
  assert.ok(ubu.ok); if (ubu.ok) assert.equal(ubu.tsRepo, 'https://pkgs.tailscale.com/stable/ubuntu/noble')
  // An Ubuntu derivative uses Ubuntu's codename, not its own.
  const mint = osSupport(facts({ HP_OS_ID: 'linuxmint', HP_OS_LIKE: 'ubuntu debian', HP_OS_CODENAME: 'wilma', HP_OS_UBUNTU_CODENAME: 'noble' }))
  assert.ok(mint.ok); if (mint.ok) assert.equal(mint.tsRepo, 'https://pkgs.tailscale.com/stable/ubuntu/noble')
  const rocky = osSupport(facts({ HP_OS_ID: 'rocky', HP_OS_LIKE: 'rhel centos fedora', HP_OS_VERSION: '9.4', HP_OS_CODENAME: '', HP_PM: 'dnf' }))
  assert.ok(rocky.ok); if (rocky.ok) { assert.equal(rocky.pm, 'dnf'); assert.equal(rocky.tsRepo, 'https://pkgs.tailscale.com/stable/rhel/9') }
  const fed = osSupport(facts({ HP_OS_ID: 'fedora', HP_OS_VERSION: '41', HP_OS_CODENAME: '', HP_PM: 'dnf' }))
  assert.ok(fed.ok); if (fed.ok) assert.equal(fed.tsRepo, 'https://pkgs.tailscale.com/stable/fedora')

  for (const [over, why] of [
    [{ HP_OS_ID: 'alpine', HP_PM: 'none' }, /alpine/i],
    [{ HP_OS_CODENAME: '' }, /codename/i],
    [{ HP_SYSTEMD: '0' }, /systemd/i],
    [{ HP_OS_ID: 'rhel', HP_OS_VERSION: '7.9', HP_PM: 'dnf', HP_OS_CODENAME: '' }, /7/],
  ] as const) {
    const s = osSupport(facts(over as any))
    assert.equal(s.ok, false, JSON.stringify(over))
    if (!s.ok) { assert.match(s.reason, why); assert.equal(s.manual, undefined) }
  }
  const mac = osSupport(facts({ HP_UNAME: 'Darwin', HP_PM: 'none' }))
  assert.ok(!mac.ok && mac.manual === 'macos')
})

// ── Safe defaults ────────────────────────────────────────────────────────────

test('flags: Tailscale never accepts DNS or routes and advertises nothing by default', () => {
  const f = clientFlags('tailscale', { hostname: 'pve-a' })
  assert.ok(f.includes('--accept-dns=false'))
  assert.ok(f.includes('--accept-routes=false'))
  assert.ok(f.includes('--hostname=pve-a'))
  assert.ok(!f.some(x => x.startsWith('--advertise')), 'nothing advertised')
  assert.ok(!f.some(x => /auth-key/.test(x)), 'the key is never a flag value')
})

test('flags: NetBird keeps DNS and routes and serves no routes by default; routing on drops only the server-routes block', () => {
  const f = clientFlags('netbird', { hostname: 'pve-a', managementUrl: 'https://nb.example.com' })
  for (const x of ['--disable-dns', '--disable-client-routes', '--disable-server-routes']) assert.ok(f.includes(x), x)
  assert.ok(f.includes('--management-url=https://nb.example.com'))
  const r = clientFlags('netbird', { hostname: 'pve-a', managementUrl: 'https://nb.example.com', routing: { subnets: ['192.0.2.0/24'], exitNode: false } })
  assert.ok(r.includes('--disable-dns') && r.includes('--disable-client-routes'))
  assert.ok(!r.includes('--disable-server-routes'))
})

test('hostnames are made safe for both clients', () => {
  assert.equal(safeHostname('My Web_Server.local'), 'my-web-server-local')
  assert.equal(safeHostname('---'), 'hyperprox-host')
  assert.equal(safeHostname('a'.repeat(80)).length, 63)
})

// ── Scripts ──────────────────────────────────────────────────────────────────

test('up script: the key reaches the client on stdin, never as an argument or a file', () => {
  const ts = upScript('tailscale', { secret: 'tskey-auth-SECRET', flags: clientFlags('tailscale', { hostname: 'x' }) })
  assert.match(ts, /\| tailscale up --auth-key=file:\/dev\/stdin/)
  assert.doesNotMatch(ts, /--auth-key=tskey/)
  assert.equal(ts.split('tskey-auth-SECRET').length - 1, 1, 'the key appears once, in a shell variable')
  assert.match(ts, /^HP_KEY='tskey-auth-SECRET'$/m)
  assert.match(ts, /unset HP_KEY/)
  assert.doesNotMatch(ts, />\s*\/(tmp|var|etc|root)\//, 'nothing written to disk')

  const nb = upScript('netbird', { secret: "AB'CD", flags: clientFlags('netbird', { hostname: 'x' }) })
  assert.match(nb, /\| netbird up --setup-key-file \/dev\/stdin/)
  assert.match(nb, /HP_KEY='AB'\\''CD'/, 'quoted for the shell')
})

test('install scripts use the official repositories and contain no secret', () => {
  const s = osSupport(facts()); assert.ok(s.ok); if (!s.ok) return
  const ts = installScript('tailscale', s, 'kernel')
  assert.match(ts, /https:\/\/pkgs\.tailscale\.com\/stable\/debian\/trixie\.noarmor\.gpg/)
  assert.match(ts, /apt-get install -y -qq tailscale/)
  // Only the new repository is refreshed: a node's own sources are not re-read or changed.
  assert.match(ts, /sourcelist=sources\.list\.d\/tailscale\.list/)
  assert.doesNotMatch(ts, /dist-upgrade|full-upgrade|apt-get upgrade/)
  assert.doesNotMatch(ts, /HP_KEY|tskey/)
  const tsu = installScript('tailscale', s, 'userspace')
  assert.match(tsu, /--tun=userspace-networking/)

  const nb = installScript('netbird', s, 'kernel')
  assert.match(nb, /https:\/\/pkgs\.netbird\.io\/debian/)
  assert.match(nb, /apt-get install -y -qq netbird/)
  assert.match(installScript('netbird', s, 'userspace'), /NB_USE_NETSTACK_MODE=true/)

  const r = osSupport(facts({ HP_OS_ID: 'rocky', HP_OS_LIKE: 'rhel', HP_OS_VERSION: '9.4', HP_OS_CODENAME: '', HP_PM: 'dnf' }))
  assert.ok(r.ok); if (!r.ok) return
  assert.match(installScript('tailscale', r, 'kernel'), /pkgs\.tailscale\.com\/stable\/rhel\/9\/tailscale\.repo/)
  assert.match(installScript('netbird', r, 'kernel'), /pkgs\.netbird\.io\/yum/)
})

test('status parsing for both clients', () => {
  const ts = parseStatus('tailscale', `x\nHP_STATUS_BEGIN\n${JSON.stringify({ BackendState: 'Running', Version: '1.90.1-tabc', Self: { ID: 'nABC', HostName: 'pve-a', TailscaleIPs: ['100.64.0.7', 'fd7a::7'], Online: true } })}\nHP_STATUS_END\n`)
  assert.deepEqual(ts, { installed: true, connected: true, ip: '100.64.0.7', version: '1.90.1', nodeKey: 'nABC', hostname: 'pve-a' })
  const nb = parseStatus('netbird', `HP_STATUS_BEGIN\n${JSON.stringify({ management: { connected: true }, netbirdIp: '100.92.0.4/16', daemonVersion: '0.59.1', fqdn: 'pve-a.netbird.cloud' })}\nHP_STATUS_END`)
  assert.deepEqual(nb, { installed: true, connected: true, ip: '100.92.0.4', version: '0.59.1', nodeKey: undefined, hostname: 'pve-a.netbird.cloud' })
  assert.deepEqual(parseStatus('tailscale', 'HP_NOT_INSTALLED\n'), { installed: false, connected: false, ip: null, version: null })
  assert.match(statusScript('netbird'), /netbird status --json/)
})

test('update and uninstall touch only the client package', () => {
  const s = osSupport(facts()); assert.ok(s.ok); if (!s.ok) return
  const u = updateScript('tailscale', s)
  assert.match(u, /--only-upgrade -y -qq tailscale/)
  assert.doesNotMatch(u, /dist-upgrade|full-upgrade|apt-get -y -qq upgrade/)
  const x = uninstallScript('netbird', s)
  assert.match(x, /netbird service uninstall/)
  assert.match(x, /apt-get purge -y -qq netbird/)
  assert.match(x, /rm -f \/etc\/apt\/sources\.list\.d\/netbird\.list/)
  assert.doesNotMatch(x, /autoremove/, 'never removes anything it did not install')
})

test('routing script: Tailscale sets exactly the routes asked for; forwarding is switched with it', () => {
  const on = routingScript('tailscale', { subnets: ['192.0.2.0/24'], exitNode: true, flags: [] })
  assert.match(on, /tailscale set --advertise-routes=192\.0\.2\.0\/24 --advertise-exit-node=true/)
  assert.match(on, /net\.ipv4\.ip_forward = 1/)
  const off = routingScript('tailscale', { subnets: [], exitNode: false, flags: [] })
  assert.match(off, /--advertise-routes= --advertise-exit-node=false/)
  assert.match(off, /rm -f \/etc\/sysctl\.d\/99-hyperprox-remote-access\.conf/)
})

// ── Planner ──────────────────────────────────────────────────────────────────

test('planner: Windows and macOS get the manual flow; unsupported systems are refused before anything changes', () => {
  assert.deepEqual(planInstall({ machine: win, provider: 'tailscale', facts: null }), { kind: 'manual', os: 'windows' })
  const mac = planInstall({ machine: vm, provider: 'tailscale', facts: facts({ HP_UNAME: 'Darwin', HP_PM: 'none' }) })
  assert.deepEqual(mac, { kind: 'manual', os: 'macos' })
  const alp = planInstall({ machine: vm, provider: 'netbird', facts: facts({ HP_OS_ID: 'alpine', HP_PM: 'none' }) })
  assert.equal(alp.kind, 'refuse')
  const nonroot = planInstall({ machine: vm, provider: 'netbird', facts: facts({ HP_ROOT: '0' }) })
  assert.equal(nonroot.kind, 'refuse')
  assert.match((nonroot as any).reason, /root/)
})

test('planner: a container without /dev/net/tun needs the device or userspace mode, never a guess', () => {
  const p = planInstall({ machine: ct, provider: 'tailscale', facts: facts({ HP_TUN: '0' }) })
  assert.equal(p.kind, 'needs-tun')
  const u = planInstall({ machine: ct, provider: 'tailscale', facts: facts({ HP_TUN: '0' }), mode: 'userspace' })
  assert.equal(u.kind, 'install'); if (u.kind === 'install') assert.equal(u.mode, 'userspace')
  const k = planInstall({ machine: ct, provider: 'tailscale', facts: facts() })
  assert.equal(k.kind, 'install'); if (k.kind === 'install') assert.equal(k.mode, 'kernel')
  // A node never runs in userspace mode: it always has the device, and the guard checks the real thing.
  assert.equal(planInstall({ machine: node, provider: 'tailscale', facts: facts(), mode: 'userspace' }).kind, 'refuse')
})

test('tunFix: the first free dev index, through the API, with the equivalent command; already-configured is spotted', () => {
  const fix = tunFix({ dev0: '/dev/dri/renderD128,gid=44', dev2: '/dev/ttyUSB0' }, 101)
  assert.deepEqual(fix, { configured: false, param: 'dev1', value: '/dev/net/tun', command: 'pct set 101 --dev1 /dev/net/tun' })
  assert.equal(tunFix({ dev3: '/dev/net/tun' }, 101).configured, true)
  assert.equal(tunFix({ 'lxc.mount.entry': '/dev/net/tun dev/net/tun none bind,create=file' }, 101).configured, true)
})

test('routing: needs an acknowledgement, valid CIDRs, and never a subnet holding the node\'s cluster address', () => {
  assert.match(checkRouting(node, { subnets: ['192.0.2.0/24'], exitNode: false }, false) ?? '', /acknowledge/i)
  assert.match(checkRouting(node, { subnets: ['192.0.2.0/24'], exitNode: false }, true) ?? '', /cluster/i)
  assert.match(checkRouting(node, { subnets: ['198.51.100.0/33'], exitNode: false }, true) ?? '', /not a subnet/i)
  assert.equal(checkRouting(node, { subnets: ['198.51.100.0/24'], exitNode: false }, true), null)
  assert.equal(checkRouting(node, { subnets: [], exitNode: true }, true), null)
  assert.match(checkRouting(ct, { subnets: [], exitNode: true }, false) ?? '', /acknowledge/i)
})

// ── Guard ────────────────────────────────────────────────────────────────────

const snap = (o: Partial<Record<string, string>> = {}) => parseSnapshot(Object.entries({
  HP_DEF4: 'default via 192.0.2.1 dev vmbr0 proto kernel onlink ;', HP_DEF6: '', HP_RESOLV_LINK: '/etc/resolv.conf',
  HP_RESOLV: 'search example.lan;nameserver 192.0.2.1;', HP_QUORATE: 'Yes', ...o,
}).map(([k, v]) => `${k}=${v}`).join('\n'))

test('guard: the snapshot script reads only, and a quorate or standalone node is ready', () => {
  assert.match(SNAPSHOT_SCRIPT, /ip -4 route show default/)
  assert.match(SNAPSHOT_SCRIPT, /pvecm status/)
  assert.doesNotMatch(SNAPSHOT_SCRIPT, /systemctl|apt-get|rm |[^0-9&]>\s*\//)
  assert.equal(snapshotReady(snap()), null)
  assert.equal(snapshotReady(snap({ HP_QUORATE: 'standalone' })), null)
  assert.match(snapshotReady(snap({ HP_QUORATE: 'No' })) ?? '', /quorate/)
  assert.match(snapshotReady(snap({ HP_QUORATE: 'unknown' })) ?? '', /quorum/)
  assert.match(snapshotReady(parseSnapshot('garbage')) ?? '', /read/)
})

test('guard: every rollback trigger fires, and an unchanged node passes', () => {
  const before = snap()
  assert.deepEqual(compareSnapshots(before, snap()), [])
  assert.match(compareSnapshots(before, snap({ HP_DEF4: 'default dev tailscale0 ;' })).join(), /default route/)
  assert.match(compareSnapshots(before, snap({ HP_DEF6: 'default dev wt0 ;' })).join(), /IPv6 default route/)
  assert.match(compareSnapshots(before, snap({ HP_RESOLV: 'nameserver 100.100.100.100;' })).join(), /resolver/)
  assert.match(compareSnapshots(before, snap({ HP_RESOLV_LINK: '/run/systemd/resolve/stub-resolv.conf' })).join(), /resolver/)
  assert.match(compareSnapshots(before, snap({ HP_QUORATE: 'No' })).join(), /quorum/)
  assert.match(compareSnapshots(before, snap({ HP_QUORATE: 'unknown' })).join(), /quorum/)
  assert.match(compareSnapshots(before, parseSnapshot('')).join(), /could not read/)
})
