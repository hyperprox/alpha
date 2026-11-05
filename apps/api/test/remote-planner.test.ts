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
import { parseSnapshot, compareSnapshots, snapshotReady, normaliseRoute, clusterNetworks, normaliseFirewall, firewallChanges, ownRouteProblem } from '../src/lib/remote/guard'
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

test('flags: every NetBird boolean is explicit; a node gets no NetBird firewall and no SSH', () => {
  const f = clientFlags('netbird', { hostname: 'pve-a', kind: 'node', managementUrl: 'https://nb.example.com' })
  assert.deepEqual(f, ['--management-url=https://nb.example.com', '--hostname=pve-a', '--disable-dns=true',
    '--disable-client-routes=true', '--disable-server-routes=true', '--disable-firewall=true', '--allow-server-ssh=false'])
  const g = clientFlags('netbird', { hostname: 'web', kind: 'lxc' })
  assert.ok(g.includes('--disable-firewall=false'))
  const r = clientFlags('netbird', { hostname: 'web', kind: 'lxc', routing: { subnets: ['198.51.100.0/24'], exitNode: false } })
  assert.ok(r.includes('--disable-server-routes=false'), 'routing on is said, not implied by a missing flag')
  for (const set of [f, g, r]) {
    assert.ok(!set.includes('--allow-server-ssh=true'), 'SSH only when asked for, and never on a node')
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
  assert.deepEqual(ts, { installed: true, connected: true, ip: '100.64.0.7', version: '1.90.1', nodeKey: 'nABC', hostname: 'pve-a', needsLogin: false })
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
  assert.match(s, /grep -oE '"\(DisableServerRoutes\|DisableClientRoutes\|DisableDNS\|DisableFirewall\|ServerSSHAllowed\)": \*\(true\|false\)' "\$hp_cfg"/)
  assert.doesNotMatch(s, /cat [^|\n]*netbird/, 'the config file (with the private key) is never printed')
  assert.deepEqual(parseNetbirdFlags('HP_NB_CONFIG=/etc/netbird/config.json\nHP_NB_FLAG DisableServerRoutes:false\nHP_NB_FLAG DisableDNS:true\n'), { config: '/etc/netbird/config.json', DisableServerRoutes: false, DisableDNS: true })
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
function snapText(o: { route?: string[]; rule?: string[]; extra?: string[]; fw?: string; fwLines?: string[]; q?: string; links?: string[]; paths?: string[]; fwd?: string } = {}) {
  return [
    ...(o.route ?? BASE.route).map(r => `HP_ROUTE${r[0]} ${r.slice(2)}`),
    ...(o.rule ?? BASE.rule).map(r => `HP_RULE${r[0]} ${r.slice(2)}`),
    'HP_RESOLV_LINK=/etc/resolv.conf', 'HP_RESOLV=search example.lan;nameserver 192.0.2.1;', 'HP_RESOLVED=inactive',
    ...(o.fwLines ?? fwText(o.fw)),
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

/** A small but realistic firewall: pve-firewall's iptables, an nftables table, an ipset, ebtables. */
function fwText(extraNft?: string, more: Partial<Record<string, string[]>> = {}): string[] {
  const nft = [
    'table inet filter {', 'chain input {', 'type filter hook input priority filter; policy accept;',
    'iif "lo" accept', 'tcp dport 22 counter packets 120 bytes 9000 accept', ...(extraNft ? [extraNft] : []), '}', '}',
    ...(more.nft ?? []),
  ]
  const ipt4 = ['# Generated by iptables-save v1.8.9 on Tue Nov  3 10:00:00 2026', '*filter', ':INPUT ACCEPT [1000:2000]', ':PVEFW-INPUT - [0:0]',
    '-A INPUT -j PVEFW-INPUT', '-A PVEFW-INPUT -p tcp -m tcp --dport 8006 -j ACCEPT', '-A PVEFW-INPUT -m comment --comment "PVESIG:abc"', 'COMMIT', ...(more.ipt4 ?? [])]
  const ipset = ['create PVEFW-0-management-v4 hash:net family inet hashsize 64 maxelem 64', 'add PVEFW-0-management-v4 192.0.2.0/24', ...(more.ipset ?? [])]
  const ebt = ['*filter', ':INPUT ACCEPT', ':FORWARD ACCEPT', '-A FORWARD -j PVEFW-FORWARD', ...(more.ebt ?? [])]
  return [
    'HP_FWSRC nft present', ...nft.map(l => `HP_FWL nft ${l}`),
    'HP_FWSRC ipt4 present', ...ipt4.map(l => `HP_FWL ipt4 ${l}`),
    'HP_FWSRC ipt6 absent', 'HP_FWSRC iptl4 absent', 'HP_FWSRC iptl6 absent',
    'HP_FWSRC ipset present', ...ipset.map(l => `HP_FWL ipset ${l}`),
    'HP_FWSRC ebt present', ...ebt.map(l => `HP_FWL ebt ${l}`),
  ]
}

test('guard: the snapshot script only reads, and covers every rollback input', () => {
  for (const k of ['ip -$f route show table all', 'ip -$f rule show', 'resolvectl dns', 'nft list ruleset', 'iptables-save',
    'ip6tables-save', 'iptables-legacy-save', 'ip6tables-legacy-save', 'ipset save', 'ebtables-save', 'corosync-cfgtool -s',
    'ip -o route get', 'pvecm status', 'ip_forward', 'ring[0-9]+_addr', 'public|cluster', 'nameserver', '"via"']) {
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
  t(snap({ paths: ['HP_PATH 192.0.2.12 192.0.2.12 dev tailscale0 table 52 src 100.64.0.5'] }), /route to 192\.0\.2\.12 changed/)
  t(snap({ fw: 'udp dport 5405 drop' }), /nftables ruleset changed.*added udp dport 5405 drop/)
  t(snap({ links: ['HP_COROSYNC link0 node1 localhost', 'HP_COROSYNC link0 node2 disconnected'] }), /corosync link state/)
  t(snap({ fwd: '1' }), /forwarding changed/)
  t(snap({ q: 'No' }), /quorum/)
  t(parseSnapshot(''), /could not read/)
  const rs = parseSnapshot(snapText().replace('HP_RESOLVED=inactive', 'HP_RESOLVED=active\nHP_LINKDNS Link 2 (vmbr0): 100.100.100.100'))
  t(rs, /per-link DNS/)
  t(parseSnapshot(snapText().replace('nameserver 192.0.2.1;', 'nameserver 100.100.100.100;')), /resolver/)
})

// ── Round 2: crafted snapshots that must not pass ───────────────────────────

const withRoutes = (...extra: string[]) => snap({ route: [...BASE.route, ...extra] })
const withRules = (...extra: string[]) => snap({ rule: [...BASE.rule, ...extra] })

test('guard A: a client\'s own routes must stay inside its overlay prefixes', () => {
  const t = (after: ReturnType<typeof snap>, p: 'tailscale' | 'netbird', re: RegExp) => assert.match(compareSnapshots(snap(), after, p).join(' | '), re)
  // /1 splits of the default route, in the client's table or on its interface, IPv4 and IPv6.
  t(withRoutes('4 0.0.0.0/1 dev tailscale0 table 52', '4 128.0.0.0/1 dev tailscale0 table 52'), 'tailscale', /\/1 split/)
  t(withRoutes('6 ::/1 dev tailscale0 table 52'), 'tailscale', /\/1 split/)
  t(withRoutes('4 0.0.0.0/1 dev wt0'), 'netbird', /\/1 split/)
  // Anything in its table, or on its interface, that is not the overlay.
  t(withRoutes('4 198.51.100.0/24 dev tailscale0 table 52'), 'tailscale', /outside the overlay/)
  t(withRoutes('4 192.0.2.0/25 dev tailscale0'), 'tailscale', /outside the overlay/)
  t(withRoutes('4 203.0.113.0/24 via 100.64.0.1 dev wt0 table 7120'), 'netbird', /outside the overlay/)
  t(withRoutes('4 default dev wt0 table 7120'), 'netbird', /default route/)
  t(withRoutes('6 2001:db8::/32 dev tailscale0 table 52'), 'tailscale', /outside the overlay/)
  // A prefix bigger than the overlay, even one containing it.
  t(withRoutes('4 100.0.0.0/8 dev tailscale0 table 52'), 'tailscale', /outside the overlay/)
  // NetBird may not use Tailscale's IPv6 range.
  t(withRoutes('6 fd7a:115c:a1e0::/48 dev wt0'), 'netbird', /outside the overlay/)
})

test('guard A: what the clients really add is allowed', () => {
  const ts = withRoutes(
    '4 100.64.0.0/10 dev tailscale0 table 52', '4 100.100.100.100 dev tailscale0 table 52', '4 throw 127.0.0.0/8 table 52',
    '4 local 100.64.0.5 dev tailscale0 table local proto kernel scope host src 100.64.0.5',
    '6 fd7a:115c:a1e0::/48 dev tailscale0 table 52', '6 fd7a:115c:a1e0:ab12:4843:cd96:6258:b240 dev tailscale0 table 52',
    '6 fe80::/64 dev tailscale0 proto kernel metric 256 pref medium', '6 multicast ff00::/8 dev tailscale0 table local proto kernel metric 256 pref medium',
  )
  assert.deepEqual(compareSnapshots(snap(), ts, 'tailscale'), [])
  const nb = withRoutes('4 100.92.0.0/16 dev wt0 proto kernel scope link src 100.92.0.4', '4 broadcast 100.92.255.255 dev wt0 table local proto kernel scope link src 100.92.0.4')
  assert.deepEqual(compareSnapshots(snap(), nb, 'netbird'), [])
  assert.equal(ownRouteProblem('4 throw 198.51.100.0/24 table 52', 'tailscale'), null)
})

test('guard A: each allowed policy rule is pinned to its exact priority and shape', () => {
  const ok = withRules('4 5210: from all fwmark 0x80000/0xff0000 lookup main', '4 5230: from all fwmark 0x80000/0xff0000 lookup default',
    '4 5250: from all fwmark 0x80000/0xff0000 unreachable', '4 5270: from all lookup 52', '6 5270: from all lookup 52')
  assert.deepEqual(compareSnapshots(snap(), ok, 'tailscale'), [])
  assert.deepEqual(compareSnapshots(snap(), withRules('4 105: from all lookup main suppress_prefixlength 0', '4 110: not from all fwmark 0x1bd00 lookup 7120'), 'netbird'), [])
  for (const bad of [
    '4 100: from all lookup 52',                       // the right table at a priority ahead of local/main
    '4 5260: from all lookup 52',                      // a priority Tailscale does not use
    '4 5270: from all lookup main',                    // the right priority, another shape
    '4 5270: from 192.0.2.0/24 lookup 52',             // narrower selector
    '4 5210: from all fwmark 0x80000/0xff0000 lookup 52',
  ]) assert.match(compareSnapshots(snap(), withRules(bad), 'tailscale').join(), /policy routing rules/, bad)
  assert.match(compareSnapshots(snap(), withRules('4 110: not from all fwmark 0x1bd00 lookup main'), 'netbird').join(), /policy routing rules/)
  assert.match(compareSnapshots(snap(), withRules('4 105: from all lookup main suppress_prefixlength 0'), 'tailscale').join(), /policy routing rules/, 'never the other client\'s rules')
})

test('guard A: the paths to the gateways and resolvers count like the paths to cluster peers', () => {
  const p = (gw: string) => snap({ paths: ['HP_PATH 192.0.2.12 192.0.2.12 dev vmbr0 src 192.0.2.11', `HP_PATH 192.0.2.1 ${gw}`, 'HP_PATH 192.0.2.53 192.0.2.53 dev vmbr0 src 192.0.2.11'] })
  const before = p('192.0.2.1 dev vmbr0 src 192.0.2.11')
  assert.deepEqual(compareSnapshots(before, p('192.0.2.1 dev vmbr0 src 192.0.2.11'), 'tailscale'), [])
  assert.match(compareSnapshots(before, p('192.0.2.1 dev tailscale0 table 52 src 100.64.0.5'), 'tailscale').join(), /route to 192\.0\.2\.1 changed/)
})

// ── Round 2: firewall text, not a hash ──────────────────────────────────────

test('guard B: counters, PVESIG signatures, fail2ban and per-guest chains, timed sets and named counters are not changes', () => {
  const nftAfter = [
    'table inet f2b-table {', 'set addr-set-sshd {', 'type ipv4_addr', 'elements = { 198.51.100.66 }', '}',
    'chain f2b-chain {', 'tcp dport 22 ip saddr @addr-set-sshd reject', '}', '}',
    'table inet proxmox-firewall-guests {', 'chain guest-105-in {', 'ct state established accept', '}', '}',
    'table inet hp {', 'set seen {', 'type ipv4_addr', 'flags dynamic,timeout', 'timeout 1h', 'elements = { 192.0.2.77 timeout 1h expires 59m58s,', '192.0.2.78 timeout 1h expires 12m1s }', '}',
    'counter hits {', 'packets 99 bytes 12345', '}', 'quota q {', 'over 10 mbytes used 1234 bytes', '}', '}',
  ]
  const nftBefore = [
    'table inet proxmox-firewall-guests {', '}',
    'table inet hp {', 'set seen {', 'type ipv4_addr', 'flags dynamic,timeout', 'timeout 1h', 'elements = { 192.0.2.70 timeout 1h expires 1m }', '}',
    'counter hits {', 'packets 3 bytes 120', '}', 'quota q {', 'over 10 mbytes used 9 bytes', '}', '}',
  ]
  const before = snap({ fwLines: fwText(undefined, { nft: nftBefore, ipset: ['create hp-seen hash:ip family inet timeout 300', 'add hp-seen 192.0.2.3 timeout 10'] }) })
  // A fail2ban ban and a guest starting, both during the settle: new f2b chain and set, per-guest chains, the
  // jumps pve-firewall adds to them, a new PVESIG, an ipset with timeouts, ebtables per-guest chains.
  const after = snap({ fwLines: fwText(undefined, {
    nft: nftAfter,
    ipt4: [':f2b-sshd - [0:0]', '-A INPUT -p tcp -m multiport --dports 22 -j f2b-sshd', '-A f2b-sshd -s 198.51.100.66/32 -j REJECT',
      ':tap105i0-IN - [0:0]', '-A PVEFW-FWBR-IN -m physdev --physdev-out tap105i0 --physdev-is-bridged -j tap105i0-IN', '-A PVEFW-FWBR-IN -m comment --comment "PVESIG:def"'],
    ipset: ['create f2b-sshd hash:ip family inet hashsize 1024 maxelem 65536 timeout 600', 'add f2b-sshd 198.51.100.66 timeout 599',
      'create hp-seen hash:ip family inet timeout 300', 'add hp-seen 192.0.2.9 timeout 120', 'create PVEFW-105-ipfilter-net0 hash:net family inet'],
    ebt: [':veth105i0-OUT ACCEPT', '-A FORWARD -i veth105i0 -j veth105i0-OUT'],
  }) })
  // The timed set's structure stays; only its elements (and counters) are discounted.
  assert.ok(after.firewall.nft.includes('set seen {'))
  assert.ok(!after.firewall.nft.some(l => /192\.0\.2\.7[78]|packets|used \d/.test(l)))
  assert.ok(!after.firewall.ipt4.some(l => /f2b|tap105|PVESIG/.test(l)))
  assert.deepEqual(after.firewall.ipset, ['add PVEFW-0-management-v4 192.0.2.0/24', 'create PVEFW-0-management-v4 hash:net family inet hashsize 64 maxelem 64', 'create hp-seen hash:ip family inet timeout 300'].sort())
  assert.deepEqual(firewallChanges(before, after), [])
})

test('guard B: a real firewall change is caught, in each backend, and named', () => {
  const plus = (more: Partial<Record<string, string[]>>) => snap({ fwLines: fwText(undefined, more) })
  const b = plus({})
  assert.match(firewallChanges(b, plus({ ipt4: ['-I INPUT 1 -i tailscale0 -j ACCEPT'] })).join(), /iptables ruleset changed.*tailscale0 -j ACCEPT/)
  assert.match(firewallChanges(b, plus({ nft: ['table ip ts-filter {', 'chain ts-input {', 'iifname "tailscale0" accept', '}', '}'] })).join(), /nftables ruleset changed/)
  assert.match(firewallChanges(b, plus({ ipset: ['add PVEFW-0-management-v4 100.64.0.0/10'] })).join(), /ipset ruleset changed/)
  assert.match(firewallChanges(b, plus({ ebt: ['-A INPUT -i wt0 -j ACCEPT'] })).join(), /ebtables ruleset changed/)
  const legacy = snap({ fwLines: fwText().map(l => l === 'HP_FWSRC iptl4 absent' ? 'HP_FWSRC iptl4 present\nHP_FWL iptl4 -A INPUT -j ts-input' : l).join('\n').split('\n') })
  assert.match(firewallChanges(snap(), legacy).join(), /iptables \(legacy\) ruleset appeared/)
})

test('guard B: the second sample discounts exactly the lines that moved between the two after-samples', () => {
  const plus = (extra: string[]) => snap({ fwLines: fwText(undefined, { ipt4: extra }) })
  const before = plus([])
  // A rule that rotates on its own appears in "after" and has moved again by the second sample.
  const after = plus(['-A PVEFW-INPUT -m set --match-set seen-1745 src -j ACCEPT', '-A INPUT -i wt0 -j ACCEPT'])
  const again = plus(['-A PVEFW-INPUT -m set --match-set seen-1760 src -j ACCEPT', '-A INPUT -i wt0 -j ACCEPT'])
  const d = firewallChanges(before, after, again)
  assert.equal(d.length, 1)
  assert.match(d[0], /wt0 -j ACCEPT/)
  assert.doesNotMatch(d[0], /seen-/)
  // Shape is not enough: a line that only looks like a moving one is still a change.
  const lookalike = plus(['-A PVEFW-INPUT -m set --match-set seen-9999 src -j ACCEPT'])
  assert.match(firewallChanges(before, lookalike, plus(['-A PVEFW-INPUT -m set --match-set seen-9999 src -j ACCEPT'])).join(), /seen-9999/)
})

test('normaliseFirewall keeps rule order out of it and drops comments', () => {
  assert.deepEqual(normaliseFirewall('ipt4', ['# x', '-A B', '-A A']), ['-A A', '-A B'])
})

// ── Round 2: IPv6 Ceph monitors, gateways and resolvers, read by the real script ──

test('guard G: the snapshot script finds IPv6 Ceph monitors and checks the path to each, and to the gateways and resolvers', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'hp-snap-'))
  try {
    writeFileSync(join(dir, 'ceph.conf'), [
      '[global]', 'public_network = 2001:db8:c::/64', 'cluster_network = 198.51.100.0/24',
      'mon_host = [v2:[2001:db8:c::11]:3300/0,v1:[2001:db8:c::11]:6789/0] [v2:192.0.2.21:3300/0,v1:192.0.2.21:6789/0]',
      '[mon.b]', 'public_addr = 2001:db8:c::12',
    ].join('\n'))
    writeFileSync(join(dir, 'corosync.conf'), 'nodelist {\n  node {\n    ring0_addr: 192.0.2.12\n    ring1_addr: 2001:db8:a::12\n  }\n}\n')
    const out = execFileSync('bash', ['-s'], { input: SNAPSHOT_SCRIPT, env: { ...process.env, HP_CEPH_CONF: join(dir, 'ceph.conf'), HP_COROSYNC_CONF: join(dir, 'corosync.conf') } }).toString()
    const s = parseSnapshot(out)
    for (const n of ['ceph 2001:db8:c::11', 'ceph 2001:db8:c::12', 'ceph 192.0.2.21', 'ceph 2001:db8:c::/64', 'ceph 198.51.100.0/24', 'corosync 192.0.2.12', 'corosync 2001:db8:a::12']) {
      assert.ok(s.nets.includes(n), `${n} in ${JSON.stringify(s.nets)}`)
    }
    for (const a of ['2001:db8:c::11', '2001:db8:c::12', '192.0.2.21', '192.0.2.12', '2001:db8:a::12']) assert.ok(a in s.paths, `path to ${a}`)
    // Every resolver in resolv.conf has a path line too.
    const ns = execFileSync('bash', ['-c', "grep -E '^[[:space:]]*nameserver' /etc/resolv.conf | awk '{print $2}' || true"]).toString().split('\n').filter(Boolean)
    for (const a of ns) assert.ok(a in s.paths, `path to resolver ${a}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── Round 2: NetBird's flags come from the config the running daemon uses ────

test('NetBird readback (F): the running daemon\'s --config wins over any other file', async () => {
  const { NB_FLAGS_READBACK } = await import('../src/lib/remote/scripts')
  const { execFileSync, spawn } = await import('node:child_process')
  const { mkdtempSync, writeFileSync, rmSync, chmodSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'hp-nb-'))
  const cfg = join(dir, 'daemon.json')
  writeFileSync(cfg, JSON.stringify({ PrivateKey: 'NEVER-PRINTED', DisableServerRoutes: false, DisableDNS: true, DisableFirewall: true }, null, 2))
  // A process named netbird whose arguments carry --config <file>, and a pgrep that finds it.
  writeFileSync(join(dir, 'daemon.sh'), 'sleep 30\n')
  const daemon = spawn('bash', ['-c', `exec -a netbird /bin/sh ${join(dir, 'daemon.sh')} --config ${cfg}`], { stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 200))
  writeFileSync(join(dir, 'pgrep'), `#!/bin/sh\necho ${daemon.pid}\n`); chmodSync(join(dir, 'pgrep'), 0o755)
  try {
    const out = execFileSync('bash', ['-c', NB_FLAGS_READBACK], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }).toString()
    const f = parseNetbirdFlags(out)
    assert.equal(f.config, cfg)
    assert.equal(f.DisableServerRoutes, false); assert.equal(f.DisableDNS, true)
    assert.doesNotMatch(out, /NEVER-PRINTED/)
  } finally { daemon.kill(); rmSync(dir, { recursive: true, force: true }) }
})

test('NetBird readback (F): without a known config there are no flags, so nothing can be confirmed', () => {
  assert.deepEqual(parseNetbirdFlags('HP_NB_CONFIG=unknown\nHP_NB_FLAG DisableServerRoutes:false\n'), {})
  assert.deepEqual(parseNetbirdFlags('HP_NB_FLAG DisableServerRoutes:false\n'), {})
})

// ── Round 2: a rolled-back replace restores everything ──────────────────────

test('restore (D): the exact package version, the unit and its environment, enabled and running state; a wiped copy', () => {
  const s = osSupport(facts()); assert.ok(s.ok); if (!s.ok) return
  const b = backupStateScript('netbird')
  assert.match(b, /dpkg-query -W -f='\$\{Version\}' netbird/)
  assert.match(b, /systemctl is-enabled netbird > \/var\/lib\/hyperprox-remote-access\/netbird\/\.enabled/)
  assert.match(b, /systemctl is-active netbird/)
  assert.match(b, /\/etc\/systemd\/system\/netbird\.service/)
  assert.match(b, /chmod 700/)
  const r = restoreStateScript('netbird', s)
  assert.match(r, /apt-get install -y -qq --allow-downgrades "netbird=\$hp_ver"/)
  assert.match(r, /case "\$hp_ver" in \*\[!A-Za-z0-9\.\+~:-\]\*\) hp_ver="" ;; esac/)
  assert.match(r, /systemctl daemon-reload/)
  assert.match(r, /= enabled \]; then systemctl enable netbird/)
  assert.match(r, /= active \]; then systemctl restart netbird; else systemctl stop netbird/)
  assert.match(r, /shred -u/)
  assert.match(r, /trap '.*chmod 700 \/var\/lib\/hyperprox-remote-access\/netbird.*HP_RESTORE_FAILED/)
  assert.doesNotMatch(r, /netbird service install/, 'the unit is restored as it was, not regenerated')
  const rpm = restoreStateScript('tailscale', { ok: true, pm: 'dnf', label: 'rocky 9', tsRepo: 'x' })
  assert.match(rpm, /dnf install -y -q "tailscale-\$hp_ver" \|\| dnf downgrade -y -q "tailscale-\$hp_ver"/)
})

// ── Round 2 re-check: six LOW findings ──────────────────────────────────────

test('LOW 1: a local route in the client\'s table is allowed only for the overlay', () => {
  assert.equal(ownRouteProblem('4 local 100.64.0.5 dev tailscale0 table local proto kernel scope host src 100.64.0.5', 'tailscale'), null)
  assert.match(ownRouteProblem('4 local 192.0.2.11 dev tailscale0 table local proto kernel scope host', 'tailscale') ?? '', /outside the overlay/)
  assert.match(ownRouteProblem('4 local 0.0.0.0/0 dev lo table 52', 'tailscale') ?? '', /default/)
  assert.equal(ownRouteProblem('6 local fe80::1:2 dev tailscale0 table local proto kernel metric 0 pref medium', 'tailscale'), null)
  assert.equal(ownRouteProblem('4 broadcast 100.92.255.255 dev wt0 table local', 'netbird'), null)
})

test('LOW 2: only rules jumping into, or belonging to, a dynamic chain are left out; a mention is not enough', () => {
  const lines = [
    ':f2b-sshd - [0:0]', '-A INPUT -p tcp -m multiport --dports 22 -j f2b-sshd', '-A f2b-sshd -s 198.51.100.66/32 -j REJECT',
    ':tap105i0-IN - [0:0]', '-A PVEFW-FWBR-IN -m physdev --physdev-out tap105i0 --physdev-is-bridged -j tap105i0-IN',
    '-A INPUT -i tap105i0 -j ACCEPT', '-A INPUT -m comment --comment "f2b-sshd exception" -j ACCEPT',
  ]
  assert.deepEqual(normaliseFirewall('ipt4', lines), ['-A INPUT -i tap105i0 -j ACCEPT', '-A INPUT -m comment --comment "f2b-sshd exception" -j ACCEPT'].sort())
  const nft = ['table inet filter {', 'chain input {', 'jump f2b-chain', 'iifname "tap105i0" accept', '}', 'chain f2b-chain {', 'ip saddr 198.51.100.66 drop', '}', '}']
  assert.deepEqual(normaliseFirewall('nft', nft), ['table inet filter {', 'chain input {', 'iifname "tap105i0" accept', '}', '}'].sort())
})

test('LOW 5: optional fields in ip rule output do not make a rule look new', () => {
  const a = snap({ rule: [...BASE.rule, '4 5270: from all lookup 52'] })
  const b = parseSnapshot(snapText({ rule: [...BASE.rule, '4 5270: from all lookup 52 proto kernel'] }).replace('HP_RULE4 32766: from all lookup main', 'HP_RULE4 32766:\tfrom all lookup main proto boot'))
  assert.deepEqual(compareSnapshots(a, b, 'tailscale'), [])
})

test('LOW 4: a link-local gateway is looked up on its own uplink', () => {
  assert.match(SNAPSHOT_SCRIPT, /ip -o route get "\$hp_a" oif "\$hp_d"/)
})

test('LOW 6: the busy check ignores zombies and removes a stale pid file', async () => {
  const { busyScript, parseBusy } = await import('../src/lib/remote/scripts')
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const s = busyScript('job-1')
  assert.match(s, /pgrep -x -r R,S,D/)
  const dir = mkdtempSync(join(tmpdir(), 'hp-run-'))
  try {
    const f = join(dir, 'hyperprox-remote-access-job-1.pid')
    writeFileSync(f, '999999\n')   // no such process
    const out = execFileSync('bash', ['-s'], { input: s, env: { ...process.env, HP_RUN_DIR: dir } }).toString()
    assert.ok(!(parseBusy(out) ?? ['x']).includes('hyperprox-job'))
    assert.equal(existsSync(f), false, 'the stale pid file is gone')
    writeFileSync(f, `${process.pid}\n`)   // a live process
    const live = execFileSync('bash', ['-s'], { input: s, env: { ...process.env, HP_RUN_DIR: dir } }).toString()
    assert.ok((parseBusy(live) ?? []).includes('hyperprox-job'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
