// =============================================================================
//  HyperProx — WireGuard: every shell line it sends
//
//  Private keys are made on the machine (`wg genkey`) and read only by
//  WireGuard itself. The one exception, a client keypair made on a server
//  container when the browser cannot make one, is printed once into output
//  that HyperProx never logs and sends straight to the vault.
// =============================================================================

import type { Support } from '../../remote/scripts'
import { renderInterface, type WgInterfaceSpec } from './config'
import { IFACE_RE } from './config'

const sq = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`

function iface(i: string): string {
  if (!IFACE_RE.test(i)) throw new Error(`not a HyperProx WireGuard interface: ${i}`)
  return i
}

/**
 * Install wireguard-tools and nothing else: no recommends, no other package named, never an upgrade. The
 * package lists are refreshed only when the package is not in them. The install is simulated first and
 * refused if it would upgrade or remove anything (a node's packages are not HyperProx's to move).
 */
export function wgInstallScript(s: Extract<Support, { ok: true }>): string {
  if (s.pm === 'apt') {
    return [
      'set -e',
      'export DEBIAN_FRONTEND=noninteractive',
      'if ! command -v wg >/dev/null 2>&1; then',
      '  if ! LC_ALL=C apt-cache policy wireguard-tools 2>/dev/null | grep -q "Candidate: [^(]"; then apt-get update -qq; fi',
      '  hp_sim=$(LC_ALL=C apt-get -s install -y --no-install-recommends wireguard-tools)',
      // `Inst pkg [old] (new …)` is an upgrade of something installed; `Remv` a removal.
      '  hp_bad=$(printf "%s\\n" "$hp_sim" | awk \'/^Remv / || /^Inst [^ ]+ \\[/ { printf "%s%s", sep, $2; sep=" " }\')',
      '  if [ -n "$hp_bad" ]; then echo "HP_WG_REFUSED=installing wireguard-tools would upgrade or remove: $hp_bad"; exit 3; fi',
      '  apt-get install -y -qq --no-install-recommends wireguard-tools',
      'fi',
      'wg --version | head -n1 | sed "s/^/HP_WG_VERSION=/"',
    ].join('\n')
  }
  return [
    'set -e',
    'if ! command -v wg >/dev/null 2>&1; then',
    '  hp_sim=$(LC_ALL=C dnf install --assumeno --setopt=install_weak_deps=False wireguard-tools 2>&1 || true)',
    '  if printf "%s\\n" "$hp_sim" | grep -qE "^(Upgrading|Removing|Downgrading|Removing dependent packages):"; then echo "HP_WG_REFUSED=installing wireguard-tools would upgrade or remove packages"; exit 3; fi',
    '  dnf install -y -q --setopt=install_weak_deps=False wireguard-tools',
    'fi',
    'wg --version | head -n1 | sed "s/^/HP_WG_VERSION=/"',
  ].join('\n')
}

/**
 * `wg syncconf` input for a live interface: the stripped file plus the private key, which awk reads from the
 * key file itself. A stripped file alone would make syncconf remove the key (it does), and putting the key on
 * a command line would show it in the process list.
 */
function syncconf(n: string): string {
  return `wg syncconf ${n} <(wg-quick strip ${n} | awk -v kf=/etc/wireguard/${n}.key 'BEGIN { getline k < kf } { print } /^\\[Interface\\]/ { print "PrivateKey = " k }')`
}

/** Make the machine's key if it has none (kept if it has), and print the public half. */
export function wgKeyScript(i: string): string {
  const k = `/etc/wireguard/${iface(i)}.key`
  return ['set -e', 'umask 077', 'mkdir -p /etc/wireguard', `[ -s ${k} ] || wg genkey > ${k}`, `echo "HP_WG_PUB=$(wg pubkey < ${k})"`].join('\n')
}

export const parsePublicKey = (out: string) => /^HP_WG_PUB=(\S+)$/m.exec(out)?.[1] ?? null

/**
 * Write the whole interface file (never appended to), keep the previous one for an undo, and bring the
 * interface up, or update it in place with `wg syncconf` when it is already up.
 */
export function wgApplyScript(spec: WgInterfaceSpec, o: { forwarding?: boolean } = {}): string {
  const i = iface(spec.iface)
  const conf = `/etc/wireguard/${i}.conf`
  return [
    'set -e', 'umask 077', 'mkdir -p /etc/wireguard',
    `[ -f ${conf} ] && cp -p ${conf} ${conf}.hp-prev || rm -f ${conf}.hp-prev`,
    `cat > ${conf}.new <<'HP_WG'`, renderInterface(spec).trimEnd(), 'HP_WG',
    `mv ${conf}.new ${conf}`,
    ...(o.forwarding ? ['mkdir -p /etc/sysctl.d', `printf 'net.ipv4.ip_forward = 1\\n' > /etc/sysctl.d/99-hyperprox-${i}.conf`, `sysctl -q -p /etc/sysctl.d/99-hyperprox-${i}.conf || true`] : []),
    `if ip link show ${i} >/dev/null 2>&1; then ${syncconf(i)}; else systemctl enable wg-quick@${i} >/dev/null 2>&1 || true; wg-quick up ${i}; fi`,
    wgStatusScript(i),
  ].join('\n')
}

/** Put the previous interface file back, or take the interface down and remove it when there was none. */
export function wgRestoreScript(i: string, previousConf: string | null): string {
  const n = iface(i)
  const conf = `/etc/wireguard/${n}.conf`
  if (previousConf === null) {
    return [`wg-quick down ${n} >/dev/null 2>&1 || ip link del ${n} >/dev/null 2>&1 || true`, `systemctl disable wg-quick@${n} >/dev/null 2>&1 || true`,
      `rm -f ${conf} ${conf}.hp-prev /etc/wireguard/${n}.key /etc/sysctl.d/99-hyperprox-${n}.conf`, 'echo HP_WG_GONE'].join('\n')
  }
  return ['set -e', 'umask 077', `cat > ${conf} <<'HP_WG'`, previousConf.trimEnd(), 'HP_WG',
    `if ip link show ${n} >/dev/null 2>&1; then ${syncconf(n)}; else wg-quick up ${n}; fi`, 'echo HP_WG_RESTORED'].join('\n')
}

/** The interface's public key, port and peers. `wg show dump`'s first line holds the private key: never read. */
export function wgStatusScript(i: string): string {
  const n = iface(i)
  return [
    `if ! ip link show ${n} >/dev/null 2>&1; then echo HP_WG_DOWN; else`,
    `  echo "HP_WG_PUB=$(wg show ${n} public-key)"`,
    `  echo "HP_WG_PORT=$(wg show ${n} listen-port)"`,
    '  echo HP_WG_DUMP_BEGIN',
    `  wg show ${n} dump | tail -n +2 | awk '{ print $1, $3, $4, $5, $6, $7, $8 }'`,
    '  echo HP_WG_DUMP_END',
    'fi',
  ].join('\n')
}

/** A client keypair made on the server container, for a browser that cannot make one. Output is never logged. */
export const SERVER_KEYGEN_SCRIPT = 'set -e\numask 077\nhp_k=$(wg genkey)\necho "HP_WG_PRIV=$hp_k"\necho "HP_WG_PUB=$(printf %s "$hp_k" | wg pubkey)"\nunset hp_k'

/** A server's own key, printed once for the opt-in vault backup. Output is never logged. */
export function wgKeyBackupScript(i: string): string {
  return `set -e\necho "HP_WG_PRIV=$(cat /etc/wireguard/${iface(i)}.key)"`
}

/** Put a backed-up server key back on a rebuilt server, from stdin (never on a command line). */
export function wgKeyRestoreScript(i: string, privateKey: string): string {
  const k = `/etc/wireguard/${iface(i)}.key`
  return ['set -e', 'set +x', 'umask 077', 'mkdir -p /etc/wireguard', `printf '%s\\n' ${sq(privateKey)} > ${k}`, `echo "HP_WG_PUB=$(wg pubkey < ${k})"`].join('\n')
}

export const parsePrivateKey = (out: string) => /^HP_WG_PRIV=(\S+)$/m.exec(out)?.[1] ?? null

/** Ping across the tunnel (the e2e and the "check" button). */
export function wgPingScript(addr: string): string {
  if (!/^[0-9a-fA-F.:]+$/.test(addr)) throw new Error('not an address')
  return `ping -c 3 -W 2 ${addr} >/dev/null 2>&1 && echo HP_WG_PING_OK || echo HP_WG_PING_FAIL`
}
