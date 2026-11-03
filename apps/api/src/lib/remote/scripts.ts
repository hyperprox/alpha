// =============================================================================
//  HyperProx — Remote access: every shell line it sends, and how output is read
//
//  One file to read to know what this feature can do to a machine. Scripts are
//  delivered on stdin (see executor.ts), never on a command line. Only
//  upScript() ever holds a secret, and it hands it to the client on a pipe:
//  `tailscale up --auth-key=file:/dev/stdin`, `netbird up --setup-key-file
//  /dev/stdin`. printf is a shell builtin, so the key is in no process's argv.
// =============================================================================

import type { ProviderId } from './types'

const sq = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`

// ── Detection (read-only) ───────────────────────────────────────────────────

export const DETECT_SCRIPT = [
  '[ -r /etc/os-release ] && . /etc/os-release',
  'echo "HP_OS_ID=${ID:-}"',
  'echo "HP_OS_LIKE=${ID_LIKE:-}"',
  'echo "HP_OS_VERSION=${VERSION_ID:-}"',
  'echo "HP_OS_CODENAME=${VERSION_CODENAME:-}"',
  'echo "HP_OS_UBUNTU_CODENAME=${UBUNTU_CODENAME:-}"',
  'echo "HP_UNAME=$(uname -s 2>/dev/null)"',
  'echo "HP_ARCH=$(uname -m 2>/dev/null)"',
  'if command -v apt-get >/dev/null 2>&1; then echo HP_PM=apt; elif command -v dnf >/dev/null 2>&1; then echo HP_PM=dnf; else echo HP_PM=none; fi',
  '[ -d /run/systemd/system ] && echo HP_SYSTEMD=1 || echo HP_SYSTEMD=0',
  // Present is not enough: an unprivileged container can see the node and still be refused the open.
  'if [ -c /dev/net/tun ] && ( exec 3<>/dev/net/tun ) 2>/dev/null; then echo HP_TUN=1; else echo HP_TUN=0; fi',
  '[ "$(id -u)" = 0 ] && echo HP_ROOT=1 || echo HP_ROOT=0',
  'command -v curl >/dev/null 2>&1 && echo HP_CURL=1 || echo HP_CURL=0',
  'command -v tailscale >/dev/null 2>&1 && echo "HP_HAS_TAILSCALE=$(tailscale version 2>/dev/null | head -n1)"',
  'command -v netbird >/dev/null 2>&1 && echo "HP_HAS_NETBIRD=$(netbird version 2>/dev/null | head -n1)"',
  'true',
].join('\n')

export interface OsFacts {
  id: string; like: string[]; version: string; codename: string; ubuntuCodename: string
  uname: string; arch: string; pm: 'apt' | 'dnf' | 'none'; systemd: boolean; tun: boolean; root: boolean; curl: boolean
  installed: Partial<Record<ProviderId, string>>
}

function kv(output: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const line of output.split('\n')) {
    const x = /^(HP_[A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (x) m.set(x[1], x[2].trim())
  }
  return m
}

export function parseFacts(output: string): OsFacts {
  const m = kv(output)
  const g = (k: string) => m.get(k) ?? ''
  const pm = g('HP_PM')
  return {
    id: g('HP_OS_ID').toLowerCase(), like: g('HP_OS_LIKE').toLowerCase().split(/\s+/).filter(Boolean),
    version: g('HP_OS_VERSION'), codename: g('HP_OS_CODENAME').toLowerCase(), ubuntuCodename: g('HP_OS_UBUNTU_CODENAME').toLowerCase(),
    uname: g('HP_UNAME'), arch: g('HP_ARCH'),
    pm: pm === 'apt' || pm === 'dnf' ? pm : 'none',
    systemd: g('HP_SYSTEMD') === '1', tun: g('HP_TUN') === '1', root: g('HP_ROOT') === '1', curl: g('HP_CURL') === '1',
    installed: {
      ...(m.has('HP_HAS_TAILSCALE') ? { tailscale: g('HP_HAS_TAILSCALE') || 'unknown' } : {}),
      ...(m.has('HP_HAS_NETBIRD') ? { netbird: g('HP_HAS_NETBIRD') || 'unknown' } : {}),
    },
  }
}

// ── Which systems, and which repository ─────────────────────────────────────

export type Support =
  | { ok: true; pm: 'apt' | 'dnf'; label: string; tsRepo: string }
  | { ok: false; reason: string; manual?: 'windows' | 'macos' }

const EL_IDS = new Set(['rhel', 'centos', 'rocky', 'almalinux', 'ol', 'oracle'])

export function osSupport(f: OsFacts): Support {
  if (/darwin/i.test(f.uname)) return { ok: false, manual: 'macos', reason: 'macOS: install the app from the official download page' }
  if (/mingw|msys|cygwin|windows/i.test(f.uname)) return { ok: false, manual: 'windows', reason: 'Windows: install the app from the official download page' }
  const name = f.id || 'this system'
  if (!f.systemd) return { ok: false, reason: `${name} does not run systemd, which both clients need for their service` }

  if (f.pm === 'apt') {
    const ubuntuish = f.id === 'ubuntu' || f.like.includes('ubuntu')
    const debianish = ['debian', 'raspbian'].includes(f.id) || f.like.includes('debian')
    if (!ubuntuish && !debianish) return { ok: false, reason: `${name} has apt but is neither Debian- nor Ubuntu-based` }
    const dist = ubuntuish ? 'ubuntu' : f.id === 'raspbian' ? 'raspbian' : 'debian'
    const codename = ubuntuish && f.id !== 'ubuntu' ? f.ubuntuCodename : f.codename
    if (!/^[a-z]+$/.test(codename)) return { ok: false, reason: `${name} reports no release codename, so the right repository cannot be chosen` }
    return { ok: true, pm: 'apt', label: `${dist} ${codename}`, tsRepo: `https://pkgs.tailscale.com/stable/${dist}/${codename}` }
  }

  if (f.pm === 'dnf') {
    const major = f.version.split('.')[0]
    if (f.id === 'fedora') return { ok: true, pm: 'dnf', label: `fedora ${f.version}`, tsRepo: 'https://pkgs.tailscale.com/stable/fedora' }
    if (EL_IDS.has(f.id) || f.like.includes('rhel')) {
      if (!['8', '9', '10'].includes(major)) return { ok: false, reason: `${name} ${f.version || ''} is not a supported RHEL-family release (8, 9 or 10)`.replace('  ', ' ') }
      return { ok: true, pm: 'dnf', label: `${f.id} ${major}`, tsRepo: `https://pkgs.tailscale.com/stable/rhel/${major}` }
    }
    return { ok: false, reason: `${name} has dnf but is not RHEL-family or Fedora` }
  }
  return { ok: false, reason: `${name} has neither apt nor dnf; HyperProx installs only through the official apt and dnf repositories` }
}

// ── Install (no secrets) ────────────────────────────────────────────────────

export type NetMode = 'kernel' | 'userspace'

const APT_ENV = 'export DEBIAN_FRONTEND=noninteractive LC_ALL=C'
/** Refresh only the repository just added: a node's own package sources are not re-read or changed. */
const aptRefreshOnly = (list: string) =>
  `apt-get update -qq -o Dir::Etc::sourcelist=sources.list.d/${list} -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0`

const NB_KEYRING = '/usr/share/keyrings/netbird-archive-keyring.gpg'

export function installScript(p: ProviderId, s: Extract<Support, { ok: true }>, mode: NetMode): string {
  const L: string[] = ['set -e']
  if (s.pm === 'apt') {
    L.push(APT_ENV)
    L.push('if ! command -v curl >/dev/null 2>&1; then apt-get update -qq; apt-get install -y -qq curl ca-certificates; fi')
    L.push('install -d -m 0755 /usr/share/keyrings')
    if (p === 'tailscale') {
      L.push(`curl -fsSL ${s.tsRepo}.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg`)
      L.push(`curl -fsSL ${s.tsRepo}.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list`)
      L.push(aptRefreshOnly('tailscale.list'))
      L.push('apt-get install -y -qq tailscale')
    } else {
      L.push('if ! command -v gpg >/dev/null 2>&1; then apt-get update -qq; apt-get install -y -qq gnupg; fi')
      L.push(`curl -fsSL https://pkgs.netbird.io/debian/public.key | gpg --dearmor --yes -o ${NB_KEYRING}`)
      L.push(`echo 'deb [signed-by=${NB_KEYRING}] https://pkgs.netbird.io/debian stable main' > /etc/apt/sources.list.d/netbird.list`)
      L.push(aptRefreshOnly('netbird.list'))
      L.push('apt-get install -y -qq netbird')
    }
  } else {
    if (p === 'tailscale') {
      L.push(`curl -fsSL ${s.tsRepo}/tailscale.repo -o /etc/yum.repos.d/tailscale.repo`)
      L.push('dnf install -y -q tailscale')
    } else {
      L.push([
        "cat > /etc/yum.repos.d/netbird.repo <<'HP_REPO'",
        '[netbird]', 'name=netbird', 'baseurl=https://pkgs.netbird.io/yum/', 'enabled=1', 'gpgcheck=0',
        'gpgkey=https://pkgs.netbird.io/yum/repodata/repomd.xml.key', 'repo_gpgcheck=1', 'HP_REPO',
      ].join('\n'))
      L.push('dnf install -y -q netbird')
    }
  }

  if (p === 'tailscale') {
    if (mode === 'userspace') {
      // The whole file, never an append: this is the package's own defaults file and holds only these two.
      L.push(`printf 'PORT="41641"\\nFLAGS="--tun=userspace-networking"\\n' > /etc/default/tailscaled`)
    }
    L.push('systemctl enable tailscaled >/dev/null 2>&1 || true')
    L.push('systemctl restart tailscaled')
  } else {
    const env = mode === 'userspace' ? ' --service-env NB_USE_NETSTACK_MODE=true' : ''
    L.push('netbird service stop >/dev/null 2>&1 || true')
    L.push('netbird service uninstall >/dev/null 2>&1 || true')
    L.push(`netbird service install${env}`)
    L.push('netbird service start')
  }
  L.push(p === 'tailscale' ? 'echo "HP_VERSION=$(tailscale version | head -n1)"' : 'echo "HP_VERSION=$(netbird version | head -n1)"')
  return L.join('\n')
}

// ── Up (the only script with a secret) ──────────────────────────────────────

export function upScript(p: ProviderId, o: { secret: string; flags: string[] }): string {
  const flags = o.flags.map(f => sq(f)).join(' ')
  const up = p === 'tailscale'
    ? `printf '%s' "$HP_KEY" | tailscale up --auth-key=file:/dev/stdin --reset --timeout=120s ${flags}`
    : `printf '%s' "$HP_KEY" | netbird up --setup-key-file /dev/stdin ${flags}`
  return [
    'set -e',
    // Off: a traced line would print the key.
    'set +x',
    `HP_KEY=${sq(o.secret)}`,
    up,
    'unset HP_KEY',
    statusScript(p),
  ].join('\n')
}

// ── Status (read-only) ──────────────────────────────────────────────────────

export function statusScript(p: ProviderId): string {
  const cmd = p === 'tailscale' ? 'tailscale status --json --peers=false' : 'netbird status --json'
  return [
    `if ! command -v ${p} >/dev/null 2>&1; then echo HP_NOT_INSTALLED; exit 0; fi`,
    'echo HP_STATUS_BEGIN',
    `${cmd} 2>/dev/null || echo '{}'`,
    'echo',
    'echo HP_STATUS_END',
  ].join('\n')
}

export interface ClientStatus {
  installed: boolean; connected: boolean; ip: string | null; version: string | null; nodeKey?: string; hostname?: string
}

export function parseStatus(p: ProviderId, output: string): ClientStatus {
  if (/^HP_NOT_INSTALLED$/m.test(output)) return { installed: false, connected: false, ip: null, version: null }
  const m = /HP_STATUS_BEGIN\n([\s\S]*?)\nHP_STATUS_END/.exec(output)
  let j: any = {}
  try { j = m ? JSON.parse(m[1].trim() || '{}') : {} } catch { j = {} }
  if (p === 'tailscale') {
    return {
      installed: true,
      connected: j.BackendState === 'Running',
      ip:        Array.isArray(j.Self?.TailscaleIPs) && j.Self.TailscaleIPs.length ? String(j.Self.TailscaleIPs[0]) : null,
      version:   j.Version ? String(j.Version).split('-')[0] : null,
      nodeKey:   j.Self?.ID ? String(j.Self.ID) : undefined,
      hostname:  j.Self?.HostName ? String(j.Self.HostName) : undefined,
    }
  }
  return {
    installed: true,
    connected: j.management?.connected === true,
    ip:        j.netbirdIp ? String(j.netbirdIp).split('/')[0] : null,
    version:   j.daemonVersion ? String(j.daemonVersion) : null,
    nodeKey:   undefined,
    hostname:  j.fqdn ? String(j.fqdn) : undefined,
  }
}

// ── Update, routing, uninstall ──────────────────────────────────────────────

export function updateScript(p: ProviderId, s: Extract<Support, { ok: true }>): string {
  const L = ['set -e']
  if (s.pm === 'apt') {
    L.push(APT_ENV, aptRefreshOnly(`${p}.list`), `apt-get install --only-upgrade -y -qq ${p}`)
  } else {
    L.push(`dnf upgrade -y -q ${p}`)
  }
  if (p === 'netbird') L.push('netbird service restart >/dev/null 2>&1 || true')
  L.push(statusScript(p))
  return L.join('\n')
}

const SYSCTL_FILE = '/etc/sysctl.d/99-hyperprox-remote-access.conf'

/**
 * NetBird keeps its settings in its own config file. Only these four booleans are read from it (the file also
 * holds the peer's private key, which never leaves the machine).
 */
const NB_FLAGS_READBACK =
  `grep -hoE '"(DisableServerRoutes|DisableClientRoutes|DisableDNS|DisableFirewall)": *(true|false)' ` +
  `/var/lib/netbird/*.json /etc/netbird/config.json 2>/dev/null | tr -d ' "' | sed 's/^/HP_NB_FLAG /' || true`

/**
 * Turn routing on or off.
 *  - Tailscale: `tailscale set` with exactly the routes asked for. The routes are then approved in the API.
 *  - NetBird: reconnect with every flag explicit (`--disable-server-routes=false` to serve routes: an omitted
 *    flag keeps the stored value), then read the client's own config back so the result is checked, not assumed.
 *  - Forwarding, guests only (`forwarding: 'guest'`): the values before are printed (HP_FWD_BEFORE) so they can be
 *    restored exactly when routing goes off. A node's forwarding is never touched (`forwarding: 'leave'`).
 */
export function routingScript(p: ProviderId, o: {
  subnets: string[]; exitNode: boolean; flags: string[]
  forwarding: 'leave' | 'guest'
  /** Guests, turning off: the values recorded when routing went on, as "v4:v6". */
  restoreForwarding?: string | null
}): string {
  const on = o.subnets.length > 0 || o.exitNode
  const L = ['set -e']
  if (o.forwarding === 'guest') {
    L.push('echo "HP_FWD_BEFORE=$(cat /proc/sys/net/ipv4/ip_forward):$(cat /proc/sys/net/ipv6/conf/all/forwarding)"')
    if (on) {
      L.push(`printf 'net.ipv4.ip_forward = 1\\nnet.ipv6.conf.all.forwarding = 1\\n' > ${SYSCTL_FILE}`, `sysctl -q -p ${SYSCTL_FILE}`)
    } else {
      L.push(`rm -f ${SYSCTL_FILE}`)
      const m = /^([01]):([01])$/.exec(o.restoreForwarding ?? '')
      if (m) L.push(`sysctl -q -w net.ipv4.ip_forward=${m[1]} net.ipv6.conf.all.forwarding=${m[2]}`)
    }
  }
  if (p === 'tailscale') {
    L.push(`tailscale set ${sq(`--advertise-routes=${o.subnets.join(',')}`)} --advertise-exit-node=${o.exitNode ? 'true' : 'false'}`)
  } else {
    L.push('netbird down >/dev/null 2>&1 || true', `netbird up ${o.flags.map(sq).join(' ')}`, NB_FLAGS_READBACK)
  }
  L.push(statusScript(p))
  return L.join('\n')
}

/** NetBird's stored flags, as the client itself has them. */
export function parseNetbirdFlags(output: string): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const m of output.matchAll(/^HP_NB_FLAG (\w+):(true|false)$/gm)) out[m[1]] = m[2] === 'true'
  return out
}

export function parseForwardingBefore(output: string): string | null {
  return /^HP_FWD_BEFORE=([01]:[01])$/m.exec(output)?.[1] ?? null
}

/** Removes the client, its state, and the repository HyperProx added. Nothing else (no autoremove). */
export function uninstallScript(p: ProviderId, s: Extract<Support, { ok: true }> | null): string {
  const L = ['export DEBIAN_FRONTEND=noninteractive LC_ALL=C']
  if (p === 'tailscale') {
    L.push('tailscale down >/dev/null 2>&1 || true', 'tailscale logout >/dev/null 2>&1 || true',
      'systemctl disable --now tailscaled >/dev/null 2>&1 || true')
  } else {
    L.push('netbird down >/dev/null 2>&1 || true', 'netbird service stop >/dev/null 2>&1 || true',
      'netbird service uninstall >/dev/null 2>&1 || true')
  }
  const pm = s?.pm ?? 'apt'
  if (pm === 'apt') {
    L.push(`if command -v apt-get >/dev/null 2>&1; then apt-get purge -y -qq ${p} || true; fi`)
  } else {
    L.push(`dnf remove -y -q ${p} || true`)
  }
  if (p === 'tailscale') {
    L.push('rm -f /etc/apt/sources.list.d/tailscale.list /usr/share/keyrings/tailscale-archive-keyring.gpg /etc/yum.repos.d/tailscale.repo')
    L.push('rm -rf /var/lib/tailscale')
  } else {
    L.push(`rm -f /etc/apt/sources.list.d/netbird.list ${NB_KEYRING} /etc/yum.repos.d/netbird.repo`)
    L.push('rm -rf /etc/netbird /var/lib/netbird')
  }
  // Only a guest ever has this file (nodes' forwarding is never changed); restoring the values is the routing
  // action's job, so the file is simply removed and the running values are left as they are.
  L.push(`rm -f ${SYSCTL_FILE}`)
  // `hash -r`: bash remembers where it last ran `${p}` from, and `command -v` would report the deleted path.
  L.push('hash -r')
  L.push(`command -v ${p} >/dev/null 2>&1 && echo HP_STILL_INSTALLED || echo HP_REMOVED`)
  return L.join('\n')
}

// ── Keeping an existing client's state ───────────────────────────────────────
//  Before replacing a client that was already there, or uninstalling one, its own state (and the repository
//  file) is copied aside, root-only, so a rollback can put the machine back exactly as it was.

const BACKUP_DIR = '/var/lib/hyperprox-remote-access'
const STATE: Record<ProviderId, string[]> = {
  tailscale: ['/var/lib/tailscale', '/etc/default/tailscaled', '/etc/apt/sources.list.d/tailscale.list', '/usr/share/keyrings/tailscale-archive-keyring.gpg', '/etc/yum.repos.d/tailscale.repo'],
  netbird:   ['/etc/netbird', '/var/lib/netbird', '/etc/apt/sources.list.d/netbird.list', NB_KEYRING, '/etc/yum.repos.d/netbird.repo'],
}

export function backupStateScript(p: ProviderId): string {
  const dir = `${BACKUP_DIR}/${p}`
  return [
    'set -e', 'umask 077',
    `rm -rf ${dir} && mkdir -p ${dir}`,
    `${p === 'tailscale' ? 'tailscale version' : 'netbird version'} 2>/dev/null | head -n1 > ${dir}/.version || true`,
    ...STATE[p].map(f => `if [ -e ${f} ]; then mkdir -p ${dir}$(dirname ${f}) && cp -a ${f} ${dir}${f}; fi`),
    'echo HP_BACKUP_OK',
  ].join('\n')
}

/** Put the client back as it was: the package (from the repository saved with it) and its state, then start it. */
export function restoreStateScript(p: ProviderId, s: Extract<Support, { ok: true }>): string {
  const dir = `${BACKUP_DIR}/${p}`
  const svc = p === 'tailscale' ? 'systemctl stop tailscaled >/dev/null 2>&1 || true' : 'netbird service stop >/dev/null 2>&1 || true'
  const start = p === 'tailscale' ? 'systemctl enable tailscaled >/dev/null 2>&1 || true; systemctl restart tailscaled' : 'netbird service install >/dev/null 2>&1 || true; netbird service start'
  const L = [
    'set -e', 'export DEBIAN_FRONTEND=noninteractive LC_ALL=C',
    `[ -d ${dir} ] || { echo HP_NO_BACKUP; exit 3; }`,
    svc,
    ...STATE[p].map(f => `rm -rf ${f}; if [ -e ${dir}${f} ]; then mkdir -p $(dirname ${f}) && cp -a ${dir}${f} ${f}; fi`),
  ]
  if (s.pm === 'apt') L.push(`if ! command -v ${p} >/dev/null 2>&1; then ${aptRefreshOnly(`${p}.list`)}; apt-get install -y -qq ${p}; fi`)
  else L.push(`command -v ${p} >/dev/null 2>&1 || dnf install -y -q ${p}`)
  L.push(start, `rm -rf ${dir}`, 'echo HP_RESTORED', statusScript(p))
  return L.join('\n')
}

export function dropBackupScript(p: ProviderId): string {
  return `rm -rf ${BACKUP_DIR}/${p}`
}

// ── Node guard snapshot (read-only) ─────────────────────────────────────────
//  Everything that decides whether a node is still part of its cluster: every routing table and policy rule,
//  the path to every corosync and Ceph peer, the resolver (file and per-link), the firewall ruleset (hashed),
//  corosync's own link state, forwarding, and quorum. Also lists the cluster's networks, for the routing check.

export const SNAPSHOT_SCRIPT = String.raw`
for f in 4 6; do
  ip -$f route show table all 2>/dev/null | sed "s/^/HP_ROUTE$f /"
  ip -$f rule show 2>/dev/null | sed "s/^/HP_RULE$f /"
done
echo "HP_RESOLV_LINK=$(readlink -f /etc/resolv.conf 2>/dev/null)"
echo "HP_RESOLV=$(grep -E '^[[:space:]]*(nameserver|search|domain|options)' /etc/resolv.conf 2>/dev/null | tr -s ' \t' ' ' | tr '\n' ';')"
if command -v resolvectl >/dev/null 2>&1 && systemctl is-active --quiet systemd-resolved 2>/dev/null; then
  echo HP_RESOLVED=active
  resolvectl dns 2>/dev/null | sed 's/^/HP_LINKDNS /'
  resolvectl domain 2>/dev/null | sed 's/^/HP_LINKDOMAIN /'
else
  echo HP_RESOLVED=inactive
fi
if command -v nft >/dev/null 2>&1; then echo "HP_FW_NFT=$(nft list ruleset 2>/dev/null | sed -E 's/counter packets [0-9]+ bytes [0-9]+/counter/g' | sha256sum | cut -c1-64)"; else echo HP_FW_NFT=none; fi
hp_fw() { if command -v "$1" >/dev/null 2>&1; then "$1" 2>/dev/null | grep -v '^#' | sed -E 's/\[[0-9]+:[0-9]+\]//g' | sha256sum | cut -c1-64; else echo none; fi; }
echo "HP_FW_IPT4=$(hp_fw iptables-save)"
echo "HP_FW_IPT6=$(hp_fw ip6tables-save)"
echo "HP_FWD4=$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)"
echo "HP_FWD6=$(cat /proc/sys/net/ipv6/conf/all/forwarding 2>/dev/null)"
hp_peers=""
if [ -r /etc/pve/corosync.conf ]; then
  for h in $(awk '/ring[0-9]+_addr/ {print $2}' /etc/pve/corosync.conf); do
    a=$(getent ahosts "$h" 2>/dev/null | awk 'NR==1 {print $1}'); [ -n "$a" ] || a="$h"
    hp_peers="$hp_peers $a"; echo "HP_NET corosync $a"
  done
fi
if [ -r /etc/pve/ceph.conf ]; then
  awk -F= 'tolower($1) ~ /^[ \t]*(public|cluster)[_ ]network[ \t]*$/ {gsub(/[ \t]/, "", $2); n = split($2, a, ","); for (i = 1; i <= n; i++) print "HP_NET ceph " a[i]}' /etc/pve/ceph.conf
  for a in $(grep -iE '^[[:space:]]*(mon[_ ]host|public[_ ]addr|mon[_ ]addr)' /etc/pve/ceph.conf | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | sort -u); do
    hp_peers="$hp_peers $a"; echo "HP_NET ceph $a"
  done
fi
ip -o addr show scope global 2>/dev/null | awk '{print "HP_NET own " $4}'
for a in $(printf '%s\n' $hp_peers | sort -u); do echo "HP_PATH $a $(ip -o route get "$a" 2>/dev/null | head -n1)"; done
if command -v corosync-cfgtool >/dev/null 2>&1 && [ -e /etc/pve/corosync.conf ]; then
  corosync-cfgtool -s 2>/dev/null | awk '/^LINK ID/ {l = $3} /nodeid/ {gsub(/:/, " "); print "HP_COROSYNC link" l " node" $2 " " $NF}'
fi
if [ ! -e /etc/pve/corosync.conf ]; then echo HP_QUORATE=standalone
else q=$(pvecm status 2>/dev/null | awk -F: '/^Quorate/ {gsub(/[[:space:]]/, "", $2); print $2}'); echo "HP_QUORATE=${'$'}{q:-unknown}"; fi
echo HP_SNAPSHOT_END
`.trim()
