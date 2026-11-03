// Remote access: OS detection, the install planner, the exact client flags, and the node guard's rollback
// triggers. All pure: no machine, no provider.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseFacts, osSupport, installScript, upScript, statusScript, parseStatus, uninstallScript, updateScript,
  routingScript, parseNetbirdFlags, parseForwardingBefore, backupStateScript, restoreStateScript,
  DETECT_SCRIPT, SNAPSHOT_SCRIPT, type OsFacts,
} from '../src/lib/remote/scripts'
import { clientFlags, planInstall, tunFix, checkRouting, safeHostname, cidrOverlaps } from '../src/lib/remote/planner'
import { parseSnapshot, compareSnapshots, snapshotReady, normaliseRoute, clusterNetworks } from '../src/lib/remote/guard'
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


// ── Safe defaults ────────────────────────────────────────────────────────────

test('flags: Tailscale never accepts DNS or routes, advertises nothing, and on a node adds no netfilter rules', () => {
  const f = clientFlags('tailscale', { hostname: 'pve-a', kind: 'node' })
  for (const x of ['--accept-dns=false', '--accept-routes=false', '--netfilter-mode=off', '--hostname=pve-a']) assert.ok(f.includes(x), x)
  assert.ok(!f.some(x => x.startsWith('--advertise')), 'nothing advertised')
  assert.ok(!f.some(x => /auth-key/.test(x)), 'the key is never a flag value')
  // A guest keeps Tailscale's own firewall handling.
  assert.ok(!clientFlags('tailscale', { hostname: 'web', kind: 'lxc' }).some(x => x.startsWith('--netfilter-mode')))
})

test('flags: every NetBird boolean is explicit; a node gets no NetBird firewall; never --allow-server-ssh', () => {
  const f = clientFlags('netbird', { hostname: 'pve-a', kind: 'node', managementUrl: 'https://nb.example.com' })
  assert.deepEqual(f, ['--management-url=https://nb.example.com', '--hostname=pve-a', '--disable-dns=true',
    '--disable-client-routes=true', '--disable-server-routes=true', '--disable-firewall=true'])
  const g = clientFlags('netbird', { hostname: 'web', kind: 'lxc' })
  assert.ok(g.includes('--disable-firewall=false'))
  const r = clientFlags('netbird', { hostname: 'web', kind: 'lxc', routing: { subnets: ['198.51.100.0/24'], exitNode: false } })
  assert.ok(r.includes('--disable-server-routes=false'), 'routing on is said, not implied by a missing flag')
  for (const set of [f, g, r]) {
    assert.ok(!set.some(x => /allow-server-ssh/.test(x)))
    for (const x of set.filter(x => /^--disable-/.test(x))) assert.match(x, /=(true|false)$/, x)
  }
})

test('hostnames are made safe for both clients', () => {
  assert.equal(safeHostname('My Web_Server.local'), 'my-web-server-local')
  assert.equal(safeHostname('---'), 'hyperprox-host')
  assert.equal(safeHostname('a'.repeat(80)).length, 63)
})

// ── Scripts ──────────────────────────────────────────────────────────────────

test('up script: the key reaches the client on stdin, never as an argument or a file', () => {
  const ts = upScript('tailscale', { secret: 'tskey-auth-SECRET', flags: clientFlags('tailscale', { hostname: 'x', kind: 'lxc' }) })
  assert.match(ts, /\| tailscale up --auth-key=file:\/dev\/stdin/)
  assert.doesNotMatch(ts, /--auth-key=tskey/)
  assert.equal(ts.split('tskey-auth-SECRET').length - 1, 1, 'the key appears once, in a shell variable')
  assert.match(ts, /^HP_KEY='tskey-auth-SECRET'$/m)
  assert.match(ts, /unset HP_KEY/)
  assert.doesNotMatch(ts, />\s*\/(tmp|var|etc|root)\//, 'nothing written to disk')

  const nb = upScript('netbird', { secret: "AB'CD", flags: clientFlags('netbird', { hostname: 'x', kind: 'lxc' }) })
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


test('routing script: a node\'s forwarding is never touched; a guest\'s is recorded and restored exactly', () => {
  const nodeOn = routingScript('tailscale', { subnets: ['198.51.100.0/24'], exitNode: false, flags: [], forwarding: 'leave' })
  assert.match(nodeOn, /tailscale set '--advertise-routes=198\.51\.100\.0\/24' --advertise-exit-node=false/)
  assert.doesNotMatch(nodeOn, /sysctl|ip_forward|forwarding/)
  const guestOn = routingScript('tailscale', { subnets: [], exitNode: true, flags: [], forwarding: 'guest' })
  assert.match(guestOn, /HP_FWD_BEFORE=/)
  assert.match(guestOn, /net\.ipv4\.ip_forward = 1/)
  const guestOff = routingScript('tailscale', { subnets: [], exitNode: false, flags: [], forwarding: 'guest', restoreForwarding: '0:0' })
  assert.match(guestOff, /sysctl -q -w net\.ipv4\.ip_forward=0 net\.ipv6\.conf\.all\.forwarding=0/)
  assert.doesNotMatch(guestOff, /sysctl -q --system/, 'reloading sysctl.d does not put the old values back')
  assert.equal(parseForwardingBefore('x\nHP_FWD_BEFORE=1:0\n'), '1:0')
})

test('routing script: NetBird reconnects with explicit flags and reads its own config back, booleans only', () => {
  const flags = clientFlags('netbird', { hostname: 'web', kind: 'lxc', routing: { subnets: ['198.51.100.0/24'], exitNode: false } })
  const s = routingScript('netbird', { subnets: ['198.51.100.0/24'], exitNode: false, flags, forwarding: 'guest' })
  assert.match(s, /netbird up .*'--disable-server-routes=false'/)
  assert.match(s, /grep -hoE '"\(DisableServerRoutes\|DisableClientRoutes\|DisableDNS\|DisableFirewall\)"/)
  assert.doesNotMatch(s, /cat [^|\n]*netbird/, 'the config file (with the private key) is never printed')
  assert.deepEqual(parseNetbirdFlags('HP_NB_FLAG DisableServerRoutes:false\nHP_NB_FLAG DisableDNS:true\n'), { DisableServerRoutes: false, DisableDNS: true })
})

test('backup and restore keep an existing client\'s own state, root-only, and put it back', () => {
  const s = osSupport(facts()); assert.ok(s.ok); if (!s.ok) return
  const b = backupStateScript('tailscale')
  assert.match(b, /umask 077/)
  assert.match(b, /cp -a \/var\/lib\/tailscale /)
  const r = restoreStateScript('tailscale', s)
  assert.match(r, /cp -a \/var\/lib\/hyperprox-remote-access\/tailscale\/var\/lib\/tailscale \/var\/lib\/tailscale/)
  assert.match(r, /HP_RESTORED/)
  assert.match(backupStateScript('netbird'), /\/etc\/netbird/)
})

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


test('planner: an existing client HyperProx did not install is refused unless the admin chose adopt or replace', () => {
  const f = facts({ HP_HAS_TAILSCALE: '1.90.1' })
  const p = planInstall({ machine: vm, provider: 'tailscale', facts: f })
  assert.equal(p.kind, 'refuse'); assert.match((p as any).reason, /adopt.*replace/s)
  assert.deepEqual(planInstall({ machine: vm, provider: 'tailscale', facts: f, existing: 'adopt' }), { kind: 'adopt' })
  const r = planInstall({ machine: vm, provider: 'tailscale', facts: f, existing: 'replace' })
  assert.equal(r.kind, 'install'); if (r.kind === 'install') assert.equal(r.existing, true)
  // HyperProx's own earlier install is not "someone else's".
  const own = planInstall({ machine: vm, provider: 'tailscale', facts: f, managed: true })
  assert.equal(own.kind, 'install')
  // A NetBird client does not count as a Tailscale one.
  assert.equal(planInstall({ machine: vm, provider: 'netbird', facts: f }).kind, 'install')
})

test('tunFix: the first free dev index, with the equivalent command; already configured is spotted, raw lxc entries included', () => {
  const fix = tunFix({ dev0: '/dev/dri/renderD128,gid=44', dev2: '/dev/ttyUSB0' }, 101)
  assert.deepEqual(fix, { configured: false, param: 'dev1', value: '/dev/net/tun', command: 'pct set 101 --dev1 /dev/net/tun' })
  assert.equal(tunFix({ dev3: '/dev/net/tun' }, 101).configured, true)
  assert.equal(tunFix({ lxc: [['lxc.cgroup2.devices.allow', 'c 10:200 rwm'], ['lxc.mount.entry', '/dev/net/tun dev/net/tun none bind,create=file']] }, 101).configured, true)
  assert.equal(tunFix({ lxc: [['lxc.mount.entry', '/dev/dri dev/dri none bind']] }, 101).configured, false)
})

test('overlap arithmetic works for IPv4 and IPv6', () => {
  assert.ok(cidrOverlaps('192.0.2.0/24', '192.0.2.128/25'))
  assert.ok(cidrOverlaps('192.0.2.0/23', '192.0.3.5/32'))
  assert.ok(!cidrOverlaps('198.51.100.0/24', '192.0.2.0/24'))
  assert.ok(cidrOverlaps('2001:db8::/32', '2001:db8:1::5/128'))
  assert.ok(!cidrOverlaps('2001:db8::/32', '2001:db9::/32'))
  assert.ok(!cidrOverlaps('192.0.2.0/24', '2001:db8::/32'))
})

test('routing: acknowledged, valid, never an exit node on a node, never overlapping any cluster network', () => {
  const nets = ['192.0.2.12/32', '198.51.100.0/24', '2001:db8:5::11/64', '203.0.113.7/32']
  assert.match(checkRouting(node, { subnets: [], exitNode: true }, true) ?? '', /never made an exit node/)
  assert.match(checkRouting(ct, { subnets: ['203.0.113.128/25'], exitNode: false }, false) ?? '', /acknowledge/i)
  assert.match(checkRouting(ct, { subnets: ['203.0.113.0/33'], exitNode: false }, true) ?? '', /not a subnet/i)
  // Own address, another corosync link, a Ceph network, IPv6, a Ceph monitor.
  assert.match(checkRouting(node, { subnets: ['192.0.2.0/24'], exitNode: false }, true, nets) ?? '', /overlaps the cluster network/)
  assert.match(checkRouting(ct, { subnets: ['198.51.100.128/25'], exitNode: false }, true, nets) ?? '', /198\.51\.100\.0\/24/)
  assert.match(checkRouting(ct, { subnets: ['2001:db8:5::/48'], exitNode: false }, true, nets) ?? '', /2001:db8:5::11\/64/)
  assert.match(checkRouting(ct, { subnets: ['203.0.113.0/24'], exitNode: false }, true, nets) ?? '', /203\.0\.113\.7/)
  assert.equal(checkRouting(ct, { subnets: ['192.0.2.128/25'], exitNode: false }, true, nets), null)
  assert.equal(checkRouting(ct, { subnets: [], exitNode: true }, true, nets), null)
})

// ── Guard ────────────────────────────────────────────────────────────────────

const BASE = {
  route: [
    '4 default via 192.0.2.1 dev vmbr0 proto kernel onlink',
    '4 192.0.2.0/24 dev vmbr0 proto kernel scope link src 192.0.2.11',
    '4 local 192.0.2.11 dev vmbr0 table local proto kernel scope host src 192.0.2.11',
    '6 default via fe80::1 dev vmbr0 proto ra metric 1024 expires 1795sec hoplimit 64 pref medium',
  ],
  rule: ['4 0: from all lookup local', '4 32766: from all lookup main', '4 32767: from all lookup default'],
  extra: [] as string[],
}
function snapText(o: { route?: string[]; rule?: string[]; extra?: string[]; fw?: string; q?: string; links?: string[]; paths?: string[]; fwd?: string } = {}) {
  return [
    ...(o.route ?? BASE.route).map(r => `HP_ROUTE${r[0]} ${r.slice(2)}`),
    ...(o.rule ?? BASE.rule).map(r => `HP_RULE${r[0]} ${r.slice(2)}`),
    'HP_RESOLV_LINK=/etc/resolv.conf', 'HP_RESOLV=search example.lan;nameserver 192.0.2.1;', 'HP_RESOLVED=inactive',
    `HP_FW_NFT=${o.fw ?? 'aaa'}`, 'HP_FW_IPT4=bbb', 'HP_FW_IPT6=ccc',
    `HP_FWD4=${o.fwd ?? '0'}`, 'HP_FWD6=0',
    'HP_NET corosync 192.0.2.12', 'HP_NET ceph 198.51.100.0/24', 'HP_NET own 192.0.2.11/24', 'HP_NET own 2001:db8::11/64',
    ...(o.paths ?? ['HP_PATH 192.0.2.12 192.0.2.12 dev vmbr0 src 192.0.2.11 uid 0 cache']),
    ...(o.links ?? ['HP_COROSYNC link0 node1 localhost', 'HP_COROSYNC link0 node2 connected']),
    `HP_QUORATE=${o.q ?? 'Yes'}`,
    ...(o.extra ?? []),
    'HP_SNAPSHOT_END',
  ].join('\n')
}
const snap = (o: Parameters<typeof snapText>[0] = {}) => parseSnapshot(snapText(o))

test('guard: the snapshot script only reads, and covers every rollback input', () => {
  for (const k of ['ip -$f route show table all', 'ip -$f rule show', 'resolvectl dns', 'nft list ruleset', 'iptables-save',
    'ip6tables-save', 'corosync-cfgtool -s', 'ip -o route get', 'pvecm status', 'ip_forward', 'ring[0-9]+_addr', 'public|cluster']) {
    assert.ok(SNAPSHOT_SCRIPT.includes(k), k)
  }
  assert.doesNotMatch(SNAPSHOT_SCRIPT, /systemctl (start|stop|restart)|apt-get|rm |sysctl -w|>\s*\/(?!dev\/null)/)
  const s = snap()
  assert.equal(snapshotReady(s), null)
  assert.deepEqual(clusterNetworks(s), ['192.0.2.12/32', '198.51.100.0/24', '192.0.2.11/24', '2001:db8::11/64'])
  assert.equal(snapshotReady(snap({ q: 'standalone', links: [] })), null)
  assert.match(snapshotReady(snap({ q: 'No' })) ?? '', /quorate/)
  assert.match(snapshotReady(snap({ q: 'unknown' })) ?? '', /quorum/)
  assert.match(snapshotReady(snap({ links: ['HP_COROSYNC link1 node2 disconnected'] })) ?? '', /corosync/)
  assert.match(snapshotReady(parseSnapshot('garbage')) ?? '', /read/)
})

test('guard: RA lifetimes, cache ages and counters are not changes', () => {
  assert.equal(normaliseRoute('default via fe80::1 dev vmbr0 proto ra metric 1024 expires 1795sec hoplimit 64 pref medium'),
    'default via fe80::1 dev vmbr0 proto ra metric 1024 hoplimit 64 pref medium')
  const later = snap({ route: BASE.route.map(r => r.replace('1795sec', '1713sec')), paths: ['HP_PATH 192.0.2.12 192.0.2.12 dev vmbr0 src 192.0.2.11 uid 1000 cache expires 300sec'] })
  assert.deepEqual(compareSnapshots(snap(), later, 'tailscale'), [])
})

test('guard: the client may add routes on its own interface and table, and its own rules; nothing else', () => {
  const ts = snap({
    route: [...BASE.route, '4 100.64.0.0/10 dev tailscale0 table 52', '4 throw 127.0.0.0/8 table 52', '4 local 100.64.0.5 dev tailscale0 table local proto kernel scope host src 100.64.0.5', '6 fe80::/64 dev tailscale0 proto kernel metric 256 pref medium'],
    rule: [...BASE.rule, '4 5210: from all fwmark 0x80000/0xff0000 lookup main', '4 5230: from all fwmark 0x80000/0xff0000 lookup default', '4 5250: from all fwmark 0x80000/0xff0000 unreachable', '4 5270: from all lookup 52'],
  })
  assert.deepEqual(compareSnapshots(snap(), ts, 'tailscale'), [])
  // The same change judged as NetBird's is not allowed.
  assert.ok(compareSnapshots(snap(), ts, 'netbird').length > 0)
  const nb = snap({ route: [...BASE.route, '4 100.92.0.0/16 dev wt0 proto kernel scope link src 100.92.0.4'], rule: [...BASE.rule, '4 105: from all lookup main suppress_prefixlength 0', '4 110: not from all fwmark 0x1bd00 lookup 7120'] })
  assert.deepEqual(compareSnapshots(snap(), nb, 'netbird'), [])
  // And taking them away again (uninstall) is fine too.
  assert.deepEqual(compareSnapshots(ts, snap(), 'tailscale'), [])
})

test('guard: every rollback trigger fires', () => {
  const b = snap()
  const t = (after: ReturnType<typeof snap>, re: RegExp) => assert.match(compareSnapshots(b, after, 'tailscale').join(' | '), re)
  t(snap({ route: [...BASE.route, '4 default dev tailscale0 table 52'] }), /default route/)
  t(snap({ route: BASE.route.filter(r => !r.startsWith('4 default')) }), /routing tables changed/)
  t(snap({ route: [...BASE.route, '4 198.51.100.0/24 via 192.0.2.254 dev vmbr0'] }), /routing tables changed/)
  t(snap({ rule: [...BASE.rule, '4 100: from all lookup 200'] }), /policy routing rules/)
  t(snap({ paths: ['HP_PATH 192.0.2.12 192.0.2.12 dev tailscale0 table 52 src 100.64.0.5'] }), /route to cluster peer 192\.0\.2\.12/)
  t(snap({ fw: 'zzz' }), /nftables ruleset changed/)
  t(snap({ links: ['HP_COROSYNC link0 node1 localhost', 'HP_COROSYNC link0 node2 disconnected'] }), /corosync link state/)
  t(snap({ fwd: '1' }), /forwarding changed/)
  t(snap({ q: 'No' }), /quorum/)
  t(parseSnapshot(''), /could not read/)
  const rs = parseSnapshot(snapText().replace('HP_RESOLVED=inactive', 'HP_RESOLVED=active\nHP_LINKDNS Link 2 (vmbr0): 100.100.100.100'))
  t(rs, /per-link DNS/)
  t(parseSnapshot(snapText().replace('nameserver 192.0.2.1;', 'nameserver 100.100.100.100;')), /resolver/)
})
