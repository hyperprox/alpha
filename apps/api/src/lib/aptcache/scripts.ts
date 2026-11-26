// =============================================================================
//  HyperProx — the package cache: the scripts that run in its container
//
//  The install script puts apt-cacher-ng in from Debian 13's own archive at a
//  pinned version, gives it the cache disk the installer made, and leaves the
//  helper hpx-aptcache behind. The helper is all the plug-in ever runs (through
//  the remote executor): figures, the expiry run, restart, the allowed networks,
//  the self-check. Every value arrives as an environment variable the installer
//  exported, already checked; the admin password reaches the config only from
//  the script's own shell, never a command line.
//
//  Written with the sh tag below, which keeps the text raw (a backslash is a
//  backslash): \${ in this file is a literal ${ in the script, and ${x} with no
//  backslash is a value from this file.
// =============================================================================

import { ACNG_VERSION, HELPER, PORT } from './types'

/** Raw template text, with \${ standing for a literal ${ (shell parameter expansion). */
const sh = (s: TemplateStringsArray, ...v: Array<string | number>): string =>
  s.raw.map((part, i) => part.replace(/\\\$\{/g, '${') + (i < v.length ? String(v[i]) : '')).join('')

/**
 * The helper. Its verbs are fixed; the plug-in passes only a verb, a number of hours, or a setting name and a value
 * the helper checks again itself.
 */
export const HELPER_SCRIPT = sh`#!/bin/bash
# hpx-aptcache: HyperProx's helper for apt-cacher-ng.
# Verbs: probe | stats HOURS | selftest | maint | restart | apply | set ALLOW|REPORT VALUE
# Settings live in /etc/hyperprox/aptcache.env. The config it writes is /etc/apt-cacher-ng/zzz_hyperprox.conf (read
# last, so it wins) and the apt-cacher-ng lines of /etc/hosts.allow and /etc/hosts.deny.
set -euo pipefail
export LC_ALL=C.UTF-8
ENV=/etc/hyperprox/aptcache.env
CONF=/etc/apt-cacher-ng/zzz_hyperprox.conf
LOGDIR=/var/log/apt-cacher-ng
CACHE=/var/cache/apt-cacher-ng
PORT=${PORT}
[ -r "$ENV" ] || { echo "HyperProx's settings for the cache are missing ($ENV)." >&2; exit 3; }
. "$ENV"

# A network the cache may serve: private, written as its network address, never wider than its private block.
private_net() {
  local c=$1 a b cc d p n m x
  # No leading zeros: tcp wrappers (and bash arithmetic) read 010 as octal.
  [[ "$c" =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})/(0|[1-9][0-9]?)$ ]] || return 1
  a=\${BASH_REMATCH[1]}; b=\${BASH_REMATCH[2]}; cc=\${BASH_REMATCH[3]}; d=\${BASH_REMATCH[4]}; p=\${BASH_REMATCH[5]}
  for x in "$a" "$b" "$cc" "$d"; do [ "$x" -le 255 ] || return 1; done
  [ "$p" -le 32 ] || return 1
  if [ "$a" -eq 10 ]; then [ "$p" -ge 8 ] || return 1
  elif [ "$a" -eq 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ]; then [ "$p" -ge 12 ] || return 1
  elif [ "$a" -eq 192 ] && [ "$b" -eq 168 ]; then [ "$p" -ge 16 ] || return 1
  else return 1; fi
  n=$(( (a << 24) | (b << 16) | (cc << 8) | d ))
  m=$(( p == 0 ? 0 : (0xFFFFFFFF << (32 - p)) & 0xFFFFFFFF ))
  [ $(( n & m )) -eq "$n" ]
}
dotted_mask() {
  local m
  m=$(( $1 == 0 ? 0 : (0xFFFFFFFF << (32 - $1)) & 0xFFFFFFFF ))
  echo "$(( m >> 24 & 255 )).$(( m >> 16 & 255 )).$(( m >> 8 & 255 )).$(( m & 255 ))"
}
check_allow() {
  local c
  [ -n "$1" ] || { echo "Give at least one network." >&2; return 1; }
  for c in $1; do
    private_net "$c" || { echo "$c is not a private network written as its network address (inside 10/8, 172.16/12 or 192.168/16, no wider than its block)." >&2; return 1; }
  done
}
save_env() {
  local tmp
  tmp=$(mktemp "$ENV.XXXXXX")
  printf 'KIND=apt-cacher-ng\nLISTEN_IP=%s\nALLOW="%s"\nREPORT=%s\nREPORT_PAGE=%s\nCACHE_GB=%s\n' \
    "$LISTEN_IP" "$ALLOW" "$REPORT" "$REPORT_PAGE" "\${CACHE_GB:-}" > "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$ENV"
}
# 1 when apt-cacher-ng's socket is really listening on the LAN address, else 0.
listening() {
  ss -ltnH "sport = :$PORT" 2>/dev/null | awk '{print $4}' | grep -qxF "$LISTEN_IP:$PORT" && echo 1 || echo 0
}
wait_port() {
  local i
  for i in $(seq 1 30); do
    ss -ltnH "sport = :$PORT" | grep -q . && return 0
    sleep 1
  done
  echo "apt-cacher-ng did not start listening on port $PORT." >&2
  return 1
}
apply() {
  check_allow "$ALLOW"
  local tmp c hosts=""
  tmp=$(mktemp "$CONF.XXXXXX")
  cat > "$tmp" <<CONF
# Written by HyperProx (hpx-aptcache apply). Change it with the helper, not by hand.
Port: $PORT
# Only this container's LAN address, and loopback for the helper and the daily expiry.
BindAddress: $LISTEN_IP 127.0.0.1
# Who may use it: the apt-cacher-ng lines of /etc/hosts.allow and /etc/hosts.deny.
UseWrap: 1
# HTTPS repositories cannot be cached. A client that sends one through the cache gets a tunnel, to port 443 only, and
# only to a host name (at least one dot, last label starting with a letter): never to an address written as numbers,
# so no tunnel to 10.x, 127.x, 169.254.x, 100.64.x or any other address literal. A name that resolves to a private
# address is not refused by apt-cacher-ng; only the allowed networks can ask at all.
PassThroughPattern: ^([A-Za-z0-9-]+\.)+[A-Za-z][A-Za-z0-9-]*:443$
# Only the package archives apt-cacher-ng knows (Debian, Debian security, Ubuntu and their mirrors) are fetched;
# any other address is refused, so the cache is not a general web proxy. Ubuntu's security archive is added to the ones
# apt-cacher-ng knows by itself.
ForceManaged: 1
Remap-ubusec: security.ubuntu.com/ubuntu ; security.ubuntu.com/ubuntu # Ubuntu security
# apt keeps one answer per host for a run, so deb.debian.org's debug and ports archives must work through the cache too.
Remap-debdbg: deb.debian.org/debian-debug cdn-fastly.deb.debian.org/debian-debug ; deb.debian.org/debian-debug # Debian debug symbols
Remap-debports: deb.debian.org/debian-ports cdn-fastly.deb.debian.org/debian-ports ; deb.debian.org/debian-ports # Debian ports
ReportPage: $REPORT_PAGE
ExThreshold: 4
CONF
  chmod 644 "$tmp"; mv "$tmp" "$CONF"
  # tcp wrappers read a network as address/mask; a single address (/32) is written bare, as libwrap takes the mask
  # 255.255.255.255 for an invalid one and would match nothing.
  for c in $ALLOW; do
    if [ "\${c#*/}" = 32 ]; then hosts="$hosts \${c%/*}"; else hosts="$hosts \${c%/*}/$(dotted_mask "\${c#*/}")"; fi
  done
  # Only the apt-cacher-ng lines are HyperProx's; anything else in these files stays as it was.
  touch /etc/hosts.allow /etc/hosts.deny
  tmp=$(mktemp); grep -v '^apt-cacher-ng:' /etc/hosts.allow > "$tmp" || true
  echo "apt-cacher-ng: 127.0.0.1$hosts" >> "$tmp"; cat "$tmp" > /etc/hosts.allow; rm -f "$tmp"
  tmp=$(mktemp); grep -v '^apt-cacher-ng:' /etc/hosts.deny > "$tmp" || true
  echo "apt-cacher-ng: ALL" >> "$tmp"; cat "$tmp" > /etc/hosts.deny; rm -f "$tmp"
  # At boot the service can start before eth0 has its address: apt-cacher-ng then fails to bind it, says so in one
  # log line and carries on listening on loopback only, so guests can never reach it. This drop-in makes the unit wait
  # for the address first and fail (and so be restarted) if the address is still not bound once it is up.
  local ud=/etc/systemd/system/apt-cacher-ng.service.d
  mkdir -p "$ud"
  cat > "$ud/hyperprox-wait.conf" <<UNIT
# Written by HyperProx (hpx-aptcache apply). Change it with the helper, not by hand.
[Unit]
After=network-online.target
Wants=network-online.target
[Service]
ExecStartPre=/bin/sh -c 'timeout 60 sh -c "until ip -4 -o addr show | grep -q inet.$LISTEN_IP/; do sleep 1; done" || true'
ExecStartPost=/bin/sh -c 'ss -ltnH | grep -q $LISTEN_IP:$PORT'
Restart=on-failure
RestartSec=5
UNIT
  chmod 644 "$ud/hyperprox-wait.conf"
  systemctl daemon-reload
  systemctl restart apt-cacher-ng
  wait_port
}

# Figures only. No path and no request leaves the container: packages by name, repositories by apt-cacher-ng's
# short name, client addresses only as totals (the API turns them into guest names and drops the addresses).
stats() {
  local hours=$1 now since m f body o tmp
  [[ "$hours" =~ ^[1-9][0-9]{0,2}$ ]] && [ "$hours" -ge 1 ] && [ "$hours" -le 720 ] || { echo "Hours: 1 to 720." >&2; exit 2; }
  now=$(date +%s); since=$(( now - hours * 3600 ))
  echo "kind=apt-cacher-ng"
  echo "now=$now"
  echo "hours=$hours"
  echo "version=$(dpkg-query -W -f '\${Version}' apt-cacher-ng 2>/dev/null || true)"
  echo "active=$(systemctl is-active --quiet apt-cacher-ng && echo 1 || echo 0)"
  echo "listen=$LISTEN_IP"
  echo "listening=$(listening)"
  echo "allow=$ALLOW"
  echo "report=$REPORT"
  echo "cache_gb=\${CACHE_GB:-}"
  df -kP "$CACHE" 2>/dev/null | awk 'NR==2 {print "disk=" $2 " " $3 " " $4}'
  m=$(ls -1 "$LOGDIR"/ 2>/dev/null | sed -n 's/^maint_\([0-9]*\)\.log\.html\(\.xz\)\{0,1\}$/\1 &/p' | sort -n | tail -n1 || true)
  if [ -n "$m" ]; then
    f="$LOGDIR/\${m#* }"
    case "$f" in *.xz) body=$(xzcat "$f" 2>/dev/null || true) ;; *) body=$(cat "$f") ;; esac
    if grep -q 'class="ERROR"' <<<"$body"; then o=errors; elif grep -q 'suppressed' <<<"$body"; then o=skipped; else o=done; fi
    echo "expiry=\${m%% *} $o"
  fi
  # The error log (rotated daily): requests refused because the client is not on an allowed network, and the rest.
  echo "refused=$(grep -c 'access not permitted' "$LOGDIR/apt-cacher.err" 2>/dev/null || true)"
  echo "errors=$(grep -vc 'access not permitted' "$LOGDIR/apt-cacher.err" 2>/dev/null || true)"
  # The transfer log: epoch|I|bytes|client|path (I: fetched from the internet) and epoch|O|bytes|client|path (sent to
  # a client). An O with no I before it for the same client and path was answered from the cache.
  tmp=$(mktemp)
  { for f in $(ls -1tr "$LOGDIR"/apt-cacher.log* 2>/dev/null); do
      case "$f" in *.gz) zcat "$f" 2>/dev/null || true ;; *) cat "$f" ;; esac
    done; } | awk -F'|' -v since="$since" '
    # With ForceManaged on, only the archives apt-cacher-ng knows are served, under their short names (debrep, secdeb,
    # uburep...). A path starting with a host name is a refused request (its small error page), not traffic.
    $1 >= since && NF >= 5 && $5 !~ /^[^\/]*\./ {
      key = $4 "|" $5; hr = int($1 / 3600) * 3600
      if ($2 == "I") { pend[key] = 1; fetched[hr] += $3; tf += $3; next }
      if ($2 != "O") next
      hit = (key in pend) ? 0 : 1; delete pend[key]
      req[hr]++; by[hr] += $3; tr++; tb += $3
      if (hit) { hits[hr]++; hb[hr] += $3; th++; thb += $3 }
      n = split($5, seg, "/"); repo = seg[1]; file = seg[n]
      gsub(/[^A-Za-z0-9._+-]/, "", repo)
      if (repo != "") { rr[repo]++; rb[repo] += $3; if (hit) rh[repo]++ }
      if (file ~ /\.u?deb$/) {
        split(file, parts, "_"); p = parts[1]; gsub(/[^a-z0-9.+-]/, "", p)
        if (p != "") { pr[p]++; pb[p] += $3; if (hit) ph[p]++ }
      }
      c = $4; gsub(/[^0-9a-fA-F.:]/, "", c)
      if (c != "") { cr[c]++; cb[c] += $3 }
    }
    END {
      printf "totals=%d %d %d %d %d\n", tr, th, tb, thb, tf
      for (h in req) printf "H|%d|%d|%d|%d|%d|%d\n", h, req[h], hits[h], by[h], hb[h], fetched[h]
      for (h in fetched) if (!(h in req)) printf "H|%d|0|0|0|0|%d\n", h, fetched[h]
      for (p in pr) printf "P|%s|%d|%d|%d\n", p, pr[p], ph[p], pb[p]
      for (r in rr) printf "R|%s|%d|%d|%d\n", r, rr[r], rh[r], rb[r]
      for (c in cr) printf "C|%s|%d|%d\n", c, cr[c], cb[c]
    }' > "$tmp"
  grep '^totals=' "$tmp" || true
  grep '^H|' "$tmp" | sort -t'|' -k2,2n || true
  grep '^P|' "$tmp" | sort -t'|' -k3,3nr | head -n 15 || true
  grep '^R|' "$tmp" | sort -t'|' -k3,3nr | head -n 15 || true
  grep '^C|' "$tmp" | sort -t'|' -k3,3nr | head -n 50 || true
  rm -f "$tmp"
}

# Each check prints: check=<id> <ok|fail|info> <detail>
selftest() {
  local listening bad code
  if systemctl is-active --quiet apt-cacher-ng; then echo "check=running ok apt-cacher-ng is running"; else echo "check=running fail apt-cacher-ng is not running"; fi
  listening=$(ss -ltnH "sport = :$PORT" | awk '{print $4}' | sort -u | xargs)
  bad=$(for a in $listening; do case "$a" in "$LISTEN_IP:$PORT"|"127.0.0.1:$PORT") ;; *) echo "$a" ;; esac; done | xargs)
  if [ -z "$listening" ]; then echo "check=listen fail nothing listens on port $PORT"
  elif [ -n "$bad" ]; then echo "check=listen fail it also listens on $bad"
  else echo "check=listen ok only on $LISTEN_IP:$PORT (and loopback)"; fi
  if /usr/lib/apt-cacher-ng/acngtool -c /etc/apt-cacher-ng printvar UseWrap 2>/dev/null | grep -qx 1 \
     && grep -q "^apt-cacher-ng: ALL$" /etc/hosts.deny && grep -q '^apt-cacher-ng: 127.0.0.1' /etc/hosts.allow; then
    echo "check=clients ok only $ALLOW may use it"
  else echo "check=clients fail the allowed-networks rule is not in force"; fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 -x "http://127.0.0.1:$PORT" http://deb.debian.org/debian/dists/trixie/Release || true)
  if [ "$code" = 200 ]; then echo "check=fetch ok a Debian index came through the cache"; else echo "check=fetch fail fetching through the cache answered $code"; fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 -x "http://127.0.0.1:$PORT" https://deb.debian.org/debian/dists/trixie/Release || true)
  if [ "$code" = 200 ]; then echo "check=https ok an HTTPS repository goes through (tunnelled, not cached)"; else echo "check=https fail an HTTPS repository through the cache answered $code"; fi
  code=$(curl -s -o /dev/null -w '%{http_connect}' --max-time 20 -x "http://127.0.0.1:$PORT" https://127.0.0.1:443/ || true)
  if [ "$code" != 200 ]; then echo "check=no_private_tunnel ok a tunnel to an address on a private or loopback network is refused"; else echo "check=no_private_tunnel fail a tunnel to 127.0.0.1 was opened"; fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -x "http://127.0.0.1:$PORT" http://www.example.com/ || true)
  if [ "$code" != 200 ]; then echo "check=managed_only ok anything but a package archive is refused ($code)"; else echo "check=managed_only fail an ordinary web page came through"; fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://127.0.0.1:$PORT/$REPORT_PAGE?doExpire=Start+Expiration" || true)
  if [ "$code" = 401 ]; then echo "check=admin ok the admin actions need the password from the vault"; else echo "check=admin fail an admin action without the password answered $code"; fi
}

case "\${1:-}" in
  probe)
    echo "kind=apt-cacher-ng"; echo "listen=$LISTEN_IP"; echo "listening=$(listening)" ;;
  stats)
    stats "\${2:-24}" ;;
  maint)
    rc=0; out=$(/usr/lib/apt-cacher-ng/acngtool maint -c /etc/apt-cacher-ng SocketPath=/run/apt-cacher-ng/socket 2>&1) || rc=$?
    [ -z "$out" ] || echo "$out" | tail -n 5
    m=$(ls -1 "$LOGDIR"/maint_*.log.html 2>/dev/null | sort | tail -n1 || true)
    if [ "$rc" != 0 ]; then echo "result=failed"; exit 1
    elif [ -n "$m" ] && grep -q 'suppressed' "$m"; then echo "result=skipped"
    else echo "result=done"; fi ;;
  restart)
    systemctl restart apt-cacher-ng; wait_port; echo "result=restarted" ;;
  apply)
    apply; echo "result=applied" ;;
  set)
    k=\${2:-}; v=\${3:-}
    case "$k" in
      ALLOW) v=$(echo "$v" | tr ',;' '  ' | xargs -n1 | sort -u | xargs); check_allow "$v"; ALLOW=$v ;;
      REPORT)
        case "$v" in
          1) REPORT=1; REPORT_PAGE=acng-report.html ;;
          0) REPORT=0; REPORT_PAGE="hpx-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n').html" ;;
          *) echo "REPORT is 1 or 0." >&2; exit 2 ;;
        esac ;;
      *) echo "Only ALLOW and REPORT can be set." >&2; exit 2 ;;
    esac
    save_env; apply; echo "result=saved" ;;
  selftest)
    selftest ;;
  *)
    echo "usage: hpx-aptcache probe | stats HOURS | selftest | maint | restart | apply | set ALLOW|REPORT VALUE" >&2; exit 2 ;;
esac
`

/** The script the installer runs in the new container (after its exports of every option). */
export const INSTALL_SCRIPT = sh`# ── apt-cacher-ng from Debian 13's archive (lib/aptcache/scripts.ts) ─────────
umask 022
# The template has no locale generated; C.UTF-8 always exists and keeps apt and perl quiet.
export LC_ALL=C.UTF-8 LANG=C.UTF-8
PW="$ACNG_ADMIN_PASSWORD"; export -n ACNG_ADMIN_PASSWORD
if [ -z "$PW" ]; then echo "The installer did not pass the admin page's generated password." >&2; exit 1; fi
case "$PW" in *[!A-Za-z0-9_-]*) echo "The admin page's password is not one HyperProx made." >&2; exit 1 ;; esac
[ -n "$ACNG_REPORT" ] || ACNG_REPORT=1
ACNG_VERSION=${ACNG_VERSION}
CACHE=/var/cache/apt-cacher-ng

# Listen only on this container's LAN address, and only when it is a private one.
ADDR=$(ip -4 -o addr show dev eth0 scope global | awk '{print $4}' | head -n1)
if [ -z "$ADDR" ]; then echo "This container has no IPv4 address on eth0, so there is nothing safe to listen on." >&2; exit 1; fi
LISTEN_IP=\${ADDR%/*}; PREFIX=\${ADDR#*/}
IFS=. read -r O1 O2 _ _ <<<"$LISTEN_IP"
if ! { [ "$O1" -eq 10 ] || { [ "$O1" -eq 172 ] && [ "$O2" -ge 16 ] && [ "$O2" -le 31 ]; } || { [ "$O1" -eq 192 ] && [ "$O2" -eq 168 ]; }; }; then
  echo "This container's address ($LISTEN_IP) is not a private network address. The package cache is installed only on a LAN address." >&2; exit 1
fi
net_of() {
  local a b c d n m p=$2
  IFS=. read -r a b c d <<<"$1"
  n=$(( (a << 24) | (b << 16) | (c << 8) | d ))
  m=$(( p == 0 ? 0 : (0xFFFFFFFF << (32 - p)) & 0xFFFFFFFF ))
  n=$(( n & m ))
  echo "$(( n >> 24 & 255 )).$(( n >> 16 & 255 )).$(( n >> 8 & 255 )).$(( n & 255 ))/$p"
}
# Default: only the network this container is on.
[ -n "$ACNG_ALLOW" ] || ACNG_ALLOW=$(net_of "$LISTEN_IP" "$PREFIX")

# The package's own start would fail on the cache disk it does not own yet: nothing starts until it is configured.
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d; chmod 755 /usr/sbin/policy-rc.d
trap 'rm -f /usr/sbin/policy-rc.d' EXIT
echo "apt-cacher-ng apt-cacher-ng/tunnelenable boolean false" | debconf-set-selections
echo "apt-cacher-ng apt-cacher-ng/gentargetmode select No automated setup" | debconf-set-selections
apt-get update -qq
apt-get install -y -qq --no-install-recommends "apt-cacher-ng=$ACNG_VERSION" curl ca-certificates iproute2 cron logrotate xz-utils >/dev/null
INSTALLED=$(dpkg-query -W -f '\${Version}' apt-cacher-ng)
if [ "$INSTALLED" != "$ACNG_VERSION" ]; then echo "apt-cacher-ng $INSTALLED was installed, not $ACNG_VERSION." >&2; exit 1; fi
rm -f /usr/sbin/policy-rc.d; trap - EXIT

# The cache disk the installer gave the container (its own volume, left out of backups).
mkdir -p "$CACHE"
if [ -n "$ACNG_CACHE_GB" ] && ! mountpoint -q "$CACHE"; then echo "The cache disk is not mounted at $CACHE." >&2; exit 1; fi
chown apt-cacher-ng:apt-cacher-ng "$CACHE"; chmod 755 "$CACHE"

# The admin page's actions (expiry and the like) need this password; it is in the vault. Only apt-cacher-ng reads it.
SEC=/etc/apt-cacher-ng/security.conf
TMP=$(mktemp)
grep -v '^AdminAuth:' "$SEC" > "$TMP" 2>/dev/null || true
echo "AdminAuth: admin:$PW" >> "$TMP"
install -m 640 -o root -g apt-cacher-ng "$TMP" "$SEC"; rm -f "$TMP"
unset PW

mkdir -p /etc/hyperprox
if [ "$ACNG_REPORT" = 1 ]; then RP=acng-report.html; else RP="hpx-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n').html"; fi
printf 'KIND=apt-cacher-ng\nLISTEN_IP=%s\nALLOW="%s"\nREPORT=%s\nREPORT_PAGE=%s\nCACHE_GB=%s\n' \
  "$LISTEN_IP" "$ACNG_ALLOW" "$ACNG_REPORT" "$RP" "$ACNG_CACHE_GB" > /etc/hyperprox/aptcache.env
chmod 600 /etc/hyperprox/aptcache.env
cat > ${HELPER} <<'HPX_HELPER'
${HELPER_SCRIPT}HPX_HELPER
chmod 755 ${HELPER}

${HELPER} apply
systemctl enable apt-cacher-ng >/dev/null 2>&1
echo "apt-cacher-ng $INSTALLED is listening on $LISTEN_IP:${PORT} for $ACNG_ALLOW."`
