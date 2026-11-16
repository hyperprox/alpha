// =============================================================================
//  HyperProx — the HAProxy recipe: a load balancer HyperProx can drive
//
//  HAProxy from HAProxy's own Debian repository (haproxy.debian.net), one LTS
//  line, an exact version, the repository key checked against a pinned hash. Its
//  Data Plane API (HAProxy Technologies' own package, checked against the
//  release's published SHA-256) is what HyperProx writes configuration through:
//  every change is a transaction that haproxy -c validates before HAProxy
//  reloads (lib/proxy/providers/haproxy.ts).
//
//  What listens where:
//    :80               the public frontend "http"; no rule matched = 503
//    127.0.0.1:5555    the Data Plane API, hashed login, the vault keeps the password
//    127.0.0.1:8404    the stats page, this container's loopback only
//    :8405             /metrics only (the built-in Prometheus exporter), only to
//                      HyperProx's own addresses (hyperprox-scrapers.lst)
//    /run/haproxy/admin.sock   the Runtime API, a local socket only
//
//  Nothing the network can reach can change HAProxy: HyperProx reaches the API
//  and the socket through the container (pct exec on its node), like the
//  Managed proxies of lib/proxy/managed-recipes.ts.
//
//  The password reaches commands on standard input only (openssl passwd -stdin,
//  curl -K -); the Data Plane's file holds its SHA-512 crypt hash, mode 0600.
// =============================================================================

import os from 'node:os'

export const HAPROXY_RECIPE_ID = 'haproxy'
/** The LTS line, and the exact package from it (haproxy.debian.net trixie-backports-3.4). */
export const HAPROXY_LINE = '3.4'
export const HAPROXY_VERSION = '3.4.7'
export const HAPROXY_DEB = '3.4.7-1~bpo13+1'
/** SHA-256 of https://haproxy.debian.net/haproxy-archive-keyring.gpg (key AEF2 3487 66F3 71C6 89A7 3600 95A4 2FE8 3535 25F9). */
export const HAPROXY_KEY_SHA256 = 'bf5d90e2e278fca69901ade9e9c132b733df169eb88190704a26562b56b9b2e0'
/** HAProxy Technologies' Data Plane API, its 3.4 line; the hashes are the release's own checksums.txt. */
export const DATAPLANE_VERSION = '3.4.6'
export const DATAPLANE_SHA256 = {
  amd64: 'f4f3483ee26c9bc05b10928bfbc9e9e098be7dde5be9b8ad82b6a662e4a54206',
  arm64: 'a08a111f7e4d517475cadfea5f615f40738d4a0e7c6bd3a5738fe048d5a01ec2',
} as const

/** Where things are in the container, for the plug-in and the Proxy page. */
export const HAPROXY_SOCKET = '/run/haproxy/admin.sock'
export const HAPROXY_CONFIG = '/etc/haproxy/haproxy.cfg'
export const DATAPLANE_URL = 'http://127.0.0.1:5555'
export const DATAPLANE_USER = 'hyperprox'
export const METRICS_PORT = 8405
/** The frontend people's traffic arrives on; the Proxy page and "Load-balance this app" add their rules here. */
export const PUBLIC_FRONTEND = 'http'

const TEMPLATE = String.raw`# The installer runs scripts under umask 077; HAProxy's own user must be able to read its configuration.
umask 022
DP_PW="$HPX_DP_PASSWORD"
export -n HPX_DP_PASSWORD
if [ -z "$DP_PW" ]; then echo "The installer did not pass the Data Plane password." >&2; exit 1; fi
ARCH=$(dpkg --print-architecture)
case "$ARCH" in
  amd64) DP_SHA=__DP_SHA_AMD64__ ;;
  arm64) DP_SHA=__DP_SHA_ARM64__ ;;
  *) echo "HAProxy's package repository has no build for $ARCH." >&2; exit 1 ;;
esac
. /etc/os-release
if [ "$VERSION_CODENAME" != trixie ]; then echo "This recipe installs the Debian 13 (trixie) packages; this container is $PRETTY_NAME." >&2; exit 1; fi

apt-get update -qq
apt-get install -y -qq curl ca-certificates socat openssl

# HAProxy's own Debian repository (haproxy.debian.net), one LTS line only, its key checked against a pinned hash.
mkdir -p /etc/apt/keyrings
curl -fsSLo /etc/apt/keyrings/haproxy-archive-keyring.gpg https://haproxy.debian.net/haproxy-archive-keyring.gpg
echo "__KEY_SHA__  /etc/apt/keyrings/haproxy-archive-keyring.gpg" | sha256sum -c --quiet
echo "deb [signed-by=/etc/apt/keyrings/haproxy-archive-keyring.gpg] http://haproxy.debian.net trixie-backports-__LINE__ main" > /etc/apt/sources.list.d/haproxy.list
# Upgrades stay on the __LINE__ LTS line: never a jump to another branch by itself.
cat > /etc/apt/preferences.d/haproxy <<'PIN'
Package: haproxy
Pin: version __LINE__.*
Pin-Priority: 1001
PIN
apt-get update -qq
apt-get install -y -qq "haproxy=__HAPROXY_DEB__"

# The configuration: written once. A configuration someone (or the Data Plane API) has changed since is kept: the
# marker file says HyperProx wrote it (the Data Plane API rewrites the file's first lines), the comment is a second sign.
CFG=/etc/haproxy/haproxy.cfg
MARK=/etc/haproxy/.hyperprox-managed
if [ ! -e "$MARK" ] && ! grep -q '^# Managed with HyperProx' "$CFG" 2>/dev/null; then
  [ -f "$CFG" ] && cp -p "$CFG" "/etc/haproxy/haproxy.cfg.debian-default"
  cat > "$CFG" <<'HAPROXY'
# Managed with HyperProx. Changes made in HyperProx go through the Data Plane API and are checked with haproxy -c
# before HAProxy reloads. Hand edits are kept; run haproxy -c -f /etc/haproxy/haproxy.cfg before a reload.
global
  log /dev/log local0
  log /dev/log local1 notice
  chroot /var/lib/haproxy
  # The Runtime API: a local socket only, never a TCP port.
  stats socket /run/haproxy/admin.sock mode 660 level admin
  stats timeout 30s
  user haproxy
  group haproxy
  daemon
  ssl-default-bind-ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305
  ssl-default-bind-ciphersuites TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256
  ssl-default-bind-options ssl-min-ver TLSv1.2 no-tls-tickets
  ssl-default-server-options ssl-min-ver TLSv1.2

defaults
  log global
  mode http
  option httplog
  option dontlognull
  option http-server-close
  option forwardfor
  option redispatch
  retries 2
  timeout connect 5s
  timeout client 30s
  timeout server 30s
  timeout http-request 10s
  timeout http-keep-alive 5s
  timeout queue 30s
  timeout check 5s
  default-server inter 5s fall 3 rise 2
  errorfile 400 /etc/haproxy/errors/400.http
  errorfile 403 /etc/haproxy/errors/403.http
  errorfile 408 /etc/haproxy/errors/408.http
  errorfile 500 /etc/haproxy/errors/500.http
  errorfile 502 /etc/haproxy/errors/502.http
  errorfile 503 /etc/haproxy/errors/503.http
  errorfile 504 /etc/haproxy/errors/504.http

# The public side. Without a matching rule HAProxy answers 503 ("No server is available").
frontend http
  bind :80
  http-request set-header X-Forwarded-Proto http
  http-response del-header Server

# The stats page: this container's loopback only.
frontend hpx_stats
  bind 127.0.0.1:8404
  stats enable
  stats uri /stats
  stats refresh 10s
  stats show-legends
  no log

# Prometheus metrics for HyperProx: only /metrics, only to the addresses in hyperprox-scrapers.lst.
frontend hpx_metrics
  bind :8405
  acl hpx_scraper src -f /etc/haproxy/hyperprox-scrapers.lst
  http-request deny deny_status 403 unless hpx_scraper
  http-request use-service prometheus-exporter if { path /metrics }
  http-request deny deny_status 404
  no log
HAPROXY
fi
: > "$MARK"
# Who may read the metrics: rewritten on every run, so a new HyperProx address is picked up by installing again.
: > /etc/haproxy/hyperprox-scrapers.lst
for a in $(printf '%s' "$HPX_SCRAPERS" | tr ',' ' '); do
  case "$a" in *[!0-9./]*|'') echo "Skipping $a: not an IPv4 address." ;; *) echo "$a" >> /etc/haproxy/hyperprox-scrapers.lst ;; esac
done
[ -s /etc/haproxy/hyperprox-scrapers.lst ] || echo "127.0.0.1" > /etc/haproxy/hyperprox-scrapers.lst
haproxy -c -q -f "$CFG"
systemctl enable haproxy
systemctl reload-or-restart haproxy

# The Data Plane API: HAProxy's own, pinned and checked, on this container's loopback only, with a hashed login.
mkdir -p /etc/dataplaneapi /var/lib/dataplaneapi/transactions /var/lib/dataplaneapi/backups /etc/haproxy/maps /etc/haproxy/ssl /etc/haproxy/general /etc/haproxy/spoe
HASH=$(printf '%s' "$DP_PW" | openssl passwd -6 -stdin)
umask 077
cat > /etc/dataplaneapi/dataplaneapi.yml <<DPCFG
dataplaneapi:
  host: 127.0.0.1
  port: 5555
  user:
  - name: hyperprox
    password: "$HASH"
    insecure: false
  resources:
    maps_dir: /etc/haproxy/maps
    ssl_certs_dir: /etc/haproxy/ssl
    general_storage_dir: /etc/haproxy/general
    spoe_dir: /etc/haproxy/spoe
  transaction:
    transaction_dir: /var/lib/dataplaneapi/transactions
    backups_number: 10
    backups_dir: /var/lib/dataplaneapi/backups
haproxy:
  config_file: /etc/haproxy/haproxy.cfg
  haproxy_bin: /usr/sbin/haproxy
  # The custom strategy: the systemd one calls sudo, which a container does not have.
  reload:
    reload_delay: 2
    reload_strategy: custom
    reload_cmd: systemctl reload haproxy
    restart_cmd: systemctl restart haproxy
    status_cmd: systemctl is-active haproxy
log_targets:
- log_to: file
  log_file: /var/log/dataplaneapi.log
  log_level: warning
  log_types:
  - app
DPCFG
umask 022
if [ "$(dpkg-query -W -f='$''{Version}' dataplaneapi 2>/dev/null)" != "__DP_VERSION__" ]; then
  curl -fsSLo /tmp/dataplaneapi.deb "https://github.com/haproxytech/dataplaneapi/releases/download/v__DP_VERSION__/dataplaneapi___DP_VERSION___linux_$ARCH.deb"
  echo "$DP_SHA  /tmp/dataplaneapi.deb" | sha256sum -c --quiet
  # Our configuration file is already in place: keep it (--force-confold), never the package's 0.0.0.0 one.
  dpkg -i --force-confold /tmp/dataplaneapi.deb
  rm -f /tmp/dataplaneapi.deb
fi
systemctl daemon-reload
systemctl enable dataplaneapi
systemctl restart dataplaneapi
for i in $(seq 1 30); do
  printf 'user = "hyperprox:%s"\n' "$DP_PW" | curl -fsS -o /dev/null -K - http://127.0.0.1:5555/v3/info 2>/dev/null && break
  sleep 1
done
printf 'user = "hyperprox:%s"\n' "$DP_PW" | curl -fsS -o /dev/null -K - http://127.0.0.1:5555/v3/info
echo "show info" | socat - unix-connect:/run/haproxy/admin.sock | grep -E '^(Version|Uptime):'
echo "HAProxy $(haproxy -v | head -n1 | awk '{ print $3 }') is serving on port 80; the Data Plane API answers on 127.0.0.1:5555."
`

export const HAPROXY_SCRIPT = TEMPLATE
  .split('__DP_SHA_AMD64__').join(DATAPLANE_SHA256.amd64)
  .split('__DP_SHA_ARM64__').join(DATAPLANE_SHA256.arm64)
  .split('__KEY_SHA__').join(HAPROXY_KEY_SHA256)
  .split('__LINE__').join(HAPROXY_LINE)
  .split('__HAPROXY_DEB__').join(HAPROXY_DEB)
  .split('__DP_VERSION__').join(DATAPLANE_VERSION)

/** IPv4 addresses Prometheus may scrape /metrics from: HyperProx's own, private and not loopback. */
export function scraperList(addresses: Iterable<string>): string[] {
  const out = new Set<string>()
  for (const a of addresses) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
    if (!m || m.slice(1).some(x => Number(x) > 255)) continue
    if (a.startsWith('127.') || a.startsWith('169.254.') || a === '0.0.0.0') continue
    out.add(a)
  }
  return [...out].sort()
}

/** HyperProx's own IPv4 addresses on the network (not loopback, not Docker's bridges): who may scrape /metrics. */
export function ownScrapers(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const addrs: string[] = []
  for (const [name, list] of Object.entries(ifaces)) {
    if (/^(lo|docker\d*|br-[0-9a-f]+|veth.*|cni\d*|podman\d*|virbr\d*)$/.test(name)) continue
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) addrs.push(a.address)
  }
  return scraperList(addrs)
}
