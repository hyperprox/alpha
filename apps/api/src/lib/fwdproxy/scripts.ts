// =============================================================================
//  HyperProx — 3proxy: the scripts that run in the container
//
//  The install script: a private LAN address and the allowed networks, then
//  3proxy from the project's own Debian package (pinned, checked by SHA-256),
//  then the helper, the first user and the config. The helper, hpx-fwdproxy,
//  is what the plug-in runs later through the remote executor: figures,
//  users, allowed networks, reload and the self-check.
//
//  Every value a script reads arrives as an environment variable the installer
//  exported, already checked against its option; the generated password reaches
//  the helper only on standard input. Written with the sh tag below: \${ in
//  this file is a literal ${ in the script.
// =============================================================================

/** Template text as written, with \${ standing for a literal ${ (shell parameter expansion). */
const sh = (s: TemplateStringsArray): string => s.raw.join('').replace(/\\\$\{/g, '${')

export const START_SCRIPT = sh`# ── 3proxy install: the address and the networks (lib/fwdproxy/scripts.ts) ──
# The generated password stays in this shell: export -n keeps it out of every child's environment, and it reaches
# the helper only on standard input.
umask 022
# The template has no locale generated; C.UTF-8 always exists and keeps apt and perl quiet.
export LC_ALL=C.UTF-8 LANG=C.UTF-8
PW="$FP_PASSWORD"; export -n FP_PASSWORD
if [ -z "$PW" ]; then echo "The installer did not pass the generated password." >&2; exit 1; fi
[ -n "$FP_USER" ] || FP_USER=proxyuser
[ -n "$FP_LAN_TARGETS" ] || FP_LAN_TARGETS=0
[ -n "$FP_PER_CLIENT" ] || FP_PER_CLIENT=1

# Listen only on this container's LAN address, and only when it is a private one.
ADDR=$(ip -4 -o addr show dev eth0 scope global | awk '{print $4}' | head -n1)
if [ -z "$ADDR" ]; then echo "This container has no IPv4 address on eth0, so there is nothing safe to listen on." >&2; exit 1; fi
LISTEN_IP=\${ADDR%/*}; PREFIX=\${ADDR#*/}
is_private() {
  case "$1" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
  esac
  return 1
}
if ! is_private "$LISTEN_IP"; then
  echo "This container's address ($LISTEN_IP) is not a private network address. A forward proxy is installed only on a LAN address, so it can never become an open proxy on the internet." >&2
  exit 1
fi
# The network this container is on: the default for who may use the proxy.
net_of() {
  local a b c d n m p=$2
  IFS=. read -r a b c d <<<"$1"
  n=$(( (a << 24) | (b << 16) | (c << 8) | d ))
  m=$(( p == 0 ? 0 : (0xFFFFFFFF << (32 - p)) & 0xFFFFFFFF ))
  n=$(( n & m ))
  echo "$(( n >> 24 & 255 )).$(( n >> 16 & 255 )).$(( n >> 8 & 255 )).$(( n & 255 ))/$p"
}
[ -n "$FP_ALLOW" ] || FP_ALLOW=$(net_of "$LISTEN_IP" "$PREFIX")

apt-get update -qq
apt-get install -y -qq curl ca-certificates openssl cron logrotate iproute2 >/dev/null
mkdir -p /etc/hyperprox`

export const THREEPROXY_SCRIPT = sh`# ── 3proxy, from the project's own Debian package ──────────────────────────
# Not packaged by Debian. The release's .deb is checked against the SHA-256 in the release's own SHA256SUMS. The
# config is written before the package is unpacked (--force-confold keeps it), so 3proxy never starts on its
# sample config; the unit then runs it as the proxy user, never as root.
[ -n "$FP_HTTP" ] || FP_HTTP=1
[ -n "$FP_SOCKS" ] || FP_SOCKS=1
if [ "$FP_HTTP" != 1 ] && [ "$FP_SOCKS" != 1 ]; then echo "Turn on at least one of the HTTP proxy and the SOCKS proxy." >&2; exit 1; fi
TP_VERSION=0.9.9.2
case "$(dpkg --print-architecture)" in
  amd64) TP_ARCH=x86_64; TP_SHA256=4f6d516884f13cd5d2e8ebd4f5177cc5508f7b442bebeada8c4f34a9ed0ab5d0 ;;
  *) echo "3proxy is installed here only on amd64." >&2; exit 1 ;;
esac
apt-get install -y -qq libpcre2-8-0 libssl3t64 >/dev/null
mkdir -p /etc/3proxy /var/log/3proxy
getent group proxy >/dev/null || groupadd -r proxy
# Nothing is allowed until the helper writes the real config below.
printf '# Written by HyperProx; replaced by hpx-fwdproxy.\nauth strong\ndeny *\n' > /etc/3proxy/3proxy.cfg
if [ "$(dpkg-query -W -f '\${Version}' 3proxy 2>/dev/null | cut -d- -f1)" != "$TP_VERSION" ]; then
  TMPD=$(mktemp -d)
  curl -fsSL --retry 3 -o "$TMPD/3proxy.deb" "https://github.com/3proxy/3proxy/releases/download/$TP_VERSION/3proxy-$TP_VERSION.$TP_ARCH.deb"
  echo "$TP_SHA256  $TMPD/3proxy.deb" | sha256sum -c --quiet
  dpkg --force-confold -i "$TMPD/3proxy.deb" >/dev/null
  rm -rf "$TMPD"
fi
systemctl stop 3proxy 2>/dev/null || true
# The package's script switches the unit to root; this keeps it as the proxy user, with only what it needs.
mkdir -p /etc/systemd/system/3proxy.service.d
cat > /etc/systemd/system/3proxy.service.d/hyperprox.conf <<'UNIT'
[Service]
User=proxy
Group=proxy
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/log/3proxy
ProtectHome=yes
PrivateTmp=yes
UNIT
chown -R proxy:proxy /var/log/3proxy
chmod 750 /var/log/3proxy
[ -f /etc/3proxy/hpx-users ] || install -m 640 -o root -g proxy /dev/null /etc/3proxy/hpx-users
chown root:proxy /etc/3proxy /etc/3proxy/3proxy.cfg
chmod 750 /etc/3proxy
KIND=3proxy; SOCKS="$FP_SOCKS"; HTTP="$FP_HTTP"; SERVICE=3proxy; NAME=3proxy`

export const FINISH_SCRIPT = sh`# ── 3proxy install: the helper, the first user, the config ──────────────────
# The settings the helper generates the config from, quoted by printf so sourcing them runs nothing.
printf 'KIND=%q\nLISTEN_IP=%q\nALLOW=%q\nLAN_TARGETS=%q\nPER_CLIENT=%q\nSOCKS=%q\nHTTP=%q\n' \
  "$KIND" "$LISTEN_IP" "$FP_ALLOW" "$FP_LAN_TARGETS" "$FP_PER_CLIENT" "$SOCKS" "$HTTP" > /etc/hyperprox/fwdproxy.env
chmod 600 /etc/hyperprox/fwdproxy.env
cat > /usr/local/sbin/hpx-fwdproxy <<'HPX_HELPER'
@@HELPER@@
HPX_HELPER
chmod 750 /usr/local/sbin/hpx-fwdproxy
systemctl daemon-reload
/usr/local/sbin/hpx-fwdproxy user-add "$FP_USER" <<<"$PW" >/dev/null
/usr/local/sbin/hpx-fwdproxy apply >/dev/null
systemctl enable --quiet "$SERVICE"
systemctl is-active --quiet "$SERVICE" || { journalctl -u "$SERVICE" -n 30 --no-pager >&2; echo "The proxy did not start." >&2; exit 1; }
echo "$NAME is running on $LISTEN_IP for $FP_ALLOW. Sign-in is required; the first user is $FP_USER (its password is in the vault)."`

export const HELPER_SCRIPT = sh`#!/bin/bash
# HyperProx 3proxy helper. The HyperProx installer wrote it; HyperProx runs it (through its remote executor) to read
# the proxy's figures and to make the changes its plug-in offers. 3proxy's config is generated from
# /etc/hyperprox/fwdproxy.env and the user list each time: change those through HyperProx, not the config itself.
#
#   hpx-fwdproxy stats [minutes]       figures for the last N minutes (default 60), one fact per line
#   hpx-fwdproxy apply                 regenerate the config and restart 3proxy
#   hpx-fwdproxy reload                restart 3proxy on its current config
#   hpx-fwdproxy users                 the proxy users
#   hpx-fwdproxy user-add NAME         add or reset a user; the password is read from standard input
#   hpx-fwdproxy user-del NAME         remove a user (the last one cannot be removed)
#   hpx-fwdproxy set KEY VALUE         ALLOW (networks), LAN_TARGETS (0/1), PER_CLIENT (0/1), then apply
#   hpx-fwdproxy selftest NAME         prove the rules (NAME's password on standard input)
set -euo pipefail
umask 077
CONF=/etc/hyperprox/fwdproxy.env
USERS=/etc/3proxy/hpx-users
[ -r "$CONF" ] || { echo "Not a HyperProx proxy: $CONF is missing." >&2; exit 2; }
# shellcheck disable=SC1090
. "$CONF"
: "\${KIND:?}" "\${LISTEN_IP:?}" "\${ALLOW:?}"
[ "$KIND" = 3proxy ] || { echo "This helper serves 3proxy only." >&2; exit 2; }
LAN_TARGETS=\${LAN_TARGETS:-0}; PER_CLIENT=\${PER_CLIENT:-1}; SOCKS=\${SOCKS:-1}; HTTP=\${HTTP:-1}

die() { echo "$*" >&2; exit 1; }
valid_name() { [[ "$1" =~ ^[a-z0-9][a-z0-9._-]{0,31}$ ]]; }
is_private() {
  case "$1" in 10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;; esac
  return 1
}
# ALLOW: private IPv4 networks only (a public one would open the proxy to the internet), at most 32. Each is a
# network address (no host bits) inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16, no wider than that block.
check_allow() {
  local n=0 c a b o3 o4 p num mask
  for c in $1; do
    n=$((n + 1))
    [[ "$c" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})/([0-9]{1,2})$ ]] || die "Not a network like 10.0.5.0/24: $c"
    a=\${BASH_REMATCH[1]}; b=\${BASH_REMATCH[2]}; o3=\${BASH_REMATCH[3]}; o4=\${BASH_REMATCH[4]}; p=\${BASH_REMATCH[5]}
    for o in "$a" "$b" "$o3" "$o4" "$p"; do [[ "$o" =~ ^(0|[1-9][0-9]*)$ ]] || die "Not a network address (no leading zeros): $c"; done
    for o in "$a" "$b" "$o3" "$o4"; do [ "$o" -le 255 ] || die "Not a network address: $c"; done
    [ "$((10#$p))" -le 32 ] || die "Not a network: $c"
    p=$((10#$p)); num=$(( (10#$a << 24) | (10#$b << 16) | (10#$o3 << 8) | 10#$o4 ))
    mask=$(( p == 0 ? 0 : (0xFFFFFFFF << (32 - p)) & 0xFFFFFFFF ))
    [ $(( num & mask )) -eq "$num" ] || die "$c has host bits set: write the network address, $(( (num & mask) >> 24 & 255 )).$(( (num & mask) >> 16 & 255 )).$(( (num & mask) >> 8 & 255 )).$(( num & mask & 255 ))/$p."
    if   [ $(( num >> 24 )) -eq 10 ]; then [ "$p" -ge 8 ] || die "Too wide: $c reaches outside 10.0.0.0/8."
    elif [ $(( num >> 20 )) -eq $(( (172 << 4) | 1 )) ]; then [ "$p" -ge 12 ] || die "Too wide: $c reaches outside 172.16.0.0/12."
    elif [ $(( num >> 16 )) -eq $(( (192 << 8) | 168 )) ]; then [ "$p" -ge 16 ] || die "Too wide: $c reaches outside 192.168.0.0/16."
    else die "Not a private network, so the proxy would be open to the internet: $c"; fi
  done
  [ "$n" -ge 1 ] && [ "$n" -le 32 ] || die "Give between 1 and 32 networks."
}

save_conf() {
  local tmp; tmp=$(mktemp /etc/hyperprox/.fwdproxy.env.XXXXXX)
  printf 'KIND=%q\nLISTEN_IP=%q\nALLOW=%q\nLAN_TARGETS=%q\nPER_CLIENT=%q\nSOCKS=%q\nHTTP=%q\n' \
    "$KIND" "$LISTEN_IP" "$ALLOW" "$LAN_TARGETS" "$PER_CLIENT" "$SOCKS" "$HTTP" > "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$CONF"
}

# Destinations no proxy user may reach: the proxy itself, loopback, link-local (cloud metadata), "this network",
# multicast; and, unless LAN targets are allowed, the private ranges (so the proxy is not a door into your network).
# (The proxy's own address is private, so the LAN ranges cover it when they are blocked.)
ALWAYS_BLOCKED="127.0.0.0/8 169.254.0.0/16 0.0.0.0/8 224.0.0.0/4 240.0.0.0/4"
LAN_RANGES="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10"
blocked() { if [ "$LAN_TARGETS" = 1 ]; then echo "$LISTEN_IP/32 $ALWAYS_BLOCKED"; else echo "$ALWAYS_BLOCKED $LAN_RANGES"; fi; }
# Accounts every Debian container has: never a proxy user, so nobody mistakes one for the other.
RESERVED=" root daemon bin sys sync games man lp mail news uucp proxy www-data backup list irc gnats nobody systemd-network systemd-resolve systemd-timesync messagebus sshd _apt postfix admin administrator "

# ── users ────────────────────────────────────────────────────────────────────
list_users() { [ -f "$USERS" ] && cut -d: -f1 "$USERS" || true; }
# 3proxy reads its user list only when it starts, so every change restarts it: a removed user or an old password
# stops working at once.
restart() {
  systemctl restart 3proxy; sleep 1
  systemctl is-active --quiet 3proxy || { journalctl -u 3proxy -n 20 --no-pager >&2 || true; die "3proxy did not start again."; }
}
# Names are matched exactly (awk on the first field), never as a pattern: a dot in a name is only a dot.
without_user() { [ -f "$USERS" ] && awk -F: -v n="$1" '$1 != n' "$USERS" || true; }
write_users() { local tmp; tmp=$(mktemp "$USERS.XXXXXX"); cat > "$tmp"; chmod 640 "$tmp"; chown root:proxy "$tmp"; mv "$tmp" "$USERS"; }
user_add() {
  local name=$1 pw hash
  valid_name "$name" || die "A user name is lowercase letters, digits, dots, dashes and underscores (up to 32)."
  [[ "$RESERVED" != *" $name "* ]] || die "\"$name\" is reserved on the container; pick another name."
  IFS= read -r pw || true
  [ "\${#pw}" -ge 12 ] || die "The password must be at least 12 characters."
  [[ "$pw" != *:* && "$pw" != *$'\n'* ]] || die "The password cannot contain a colon."
  hash=$(printf '%s' "$pw" | openssl passwd -1 -stdin)
  { without_user "$name"; echo "$name:CR:$hash"; } | write_users
  restart
}
user_del() {
  local name=$1
  valid_name "$name" || die "Not a user name."
  list_users | grep -Fx -- "$name" >/dev/null || die "There is no proxy user called $name."
  [ "$(list_users | wc -l)" -gt 1 ] || die "That is the last user. Add another first: a proxy with no users cannot be used, and one without a password is never made."
  without_user "$name" | write_users
  restart
}
# Per-user figures turned off: the logs written so far (which name users and client addresses) are emptied too.
forget_clients() { find /var/log/3proxy -type f -exec truncate -s 0 {} +; }

# ── config ───────────────────────────────────────────────────────────────────
gen_3proxy() {
  local b
  b=$(blocked | tr ' ' ',')
  echo "# Written by hpx-fwdproxy (HyperProx). Change it in HyperProx: this file is regenerated."
  echo "log /var/log/3proxy/3proxy.log D"
  echo "rotate 7"
  if [ "$PER_CLIENT" = 1 ]; then echo 'logformat "L%t %N %E %U %C %n %r %I %O"'
  else echo 'logformat "L%t %N %E - - %n %r %I %O"'; fi
  echo 'users $/etc/3proxy/hpx-users'
  echo "maxconn 256"
  if [ "$HTTP" = 1 ]; then
    echo "auth strong"
    echo "deny * * $b"
    echo "allow * $(echo "$ALLOW" | tr ' ' ',') * 443 HTTPS"
    echo "deny * * * * HTTPS"
    echo "allow * $(echo "$ALLOW" | tr ' ' ',') * 80,21,1025-65535 HTTP,FTP"
    echo "deny *"
    echo "proxy -n -p3128 -i$LISTEN_IP -e$LISTEN_IP"
    echo "flush"
  fi
  if [ "$SOCKS" = 1 ]; then
    echo "auth strong"
    echo "deny * * $b"
    echo "deny * * * 25"
    echo "allow * $(echo "$ALLOW" | tr ' ' ',') * * CONNECT,BIND,UDPASSOC"
    echo "deny *"
    echo "socks -n -p1080 -i$LISTEN_IP -e$LISTEN_IP"
    echo "flush"
  fi
}

# Write the new config beside the live one, then swap it in and restart (3proxy has no config check of its own; a
# config it cannot run shows as a failed restart, which this reports).
apply() {
  local tmp
  check_allow "$ALLOW"
  tmp=$(mktemp /etc/3proxy/.3proxy.cfg.XXXXXX); gen_3proxy > "$tmp"; chmod 640 "$tmp"; chown root:proxy "$tmp"
  mv "$tmp" /etc/3proxy/3proxy.cfg
  restart
  echo "Reloaded."
}
reload() { restart; echo "Reloaded."; }

# ── figures ──────────────────────────────────────────────────────────────────
conns_on() { ss -Htn state established "( sport = :$1 )" 2>/dev/null | wc -l; }

stats() {
  local mins=\${1:-60} since now
  [[ "$mins" =~ ^[0-9]{1,4}$ ]] && [ "$mins" -ge 1 ] && [ "$mins" -le 1440 ] || die "Minutes: 1 to 1440."
  now=$(date +%s); since=$(( now - mins * 60 ))
  echo "meta	kind	3proxy"
  echo "meta	now	$now"
  echo "meta	active	$(systemctl is-active 3proxy 2>/dev/null || true)"
  echo "meta	listen	$LISTEN_IP"
  echo "meta	minutes	$mins"
  echo "cfg	allow	$ALLOW"
  echo "cfg	lan	$LAN_TARGETS"
  echo "cfg	perclient	$PER_CLIENT"
  list_users | sed 's/^/user	/'
  echo "meta	version	$(dpkg-query -W -f '\${Version}' 3proxy 2>/dev/null | cut -d- -f1)"
  echo "cfg	http	$HTTP"
  echo "cfg	socks	$SOCKS"
  echo "now	conns_http	$(conns_on 3128)"
  echo "now	conns_socks	$(conns_on 1080)"
  cat /var/log/3proxy/3proxy.log.* /var/log/3proxy/3proxy.log 2>/dev/null | tail -n 200000 | awk -v since="$since" -v pc="$PER_CLIENT" '
    # timestamp service error user client host port bytes-in bytes-out; [0.0.0.0] lines are 3proxy starting a service.
    /^[0-9]/ && $6 != "[0.0.0.0]" { t = $1 + 0; if (t < since) next
      svc = ($2 == "PROXY") ? "PROXY" : "SOCKS"; e = $3 + 0; b = $8 + $9; m = int(t / 60); mr[m]++; mb[m] += b; n++; by += b; sr[svc]++; sb[svc] += b
      if (e >= 1 && e <= 9) { dn++; den[e]++; next }
      if (e != 0) { er++ }
      if (pc == 1) { if ($4 != "-" && $4 != "") { ur[$4]++; ub[$4] += b } if ($5 != "-") { cr[$5]++; cb[$5] += b } } }
    END {
      for (k in mr) printf "min\t%d\t%d\t%d\n", k, mr[k], mb[k]
      printf "tot\trequests\t%d\ntot\tbytes\t%d\ntot\tdenied\t%d\ntot\terrors\t%d\n", n, by, dn, er
      for (k in den) printf "deny\t%s\t%d\n", k, den[k]
      for (k in sr) printf "svc\t%s\t%d\t%d\n", k, sr[k], sb[k]
      for (k in ur) printf "who\tuser\t%s\t%d\t%d\n", k, ur[k], ub[k]
      for (k in cr) printf "who\tclient\t%s\t%d\t%d\n", k, cr[k], cb[k] }'
}

# ── self-check ───────────────────────────────────────────────────────────────
ip_num() { local a b c d; IFS=. read -r a b c d <<<"$1"; echo $(( (a << 24) | (b << 16) | (c << 8) | d )); }
in_allow() {
  local c ip p m; ip=$(ip_num "$1")
  for c in $ALLOW; do
    p=\${c#*/}; m=$(( p == 0 ? 0 : (0xFFFFFFFF << (32 - p)) & 0xFFFFFFFF ))
    [ $(( ip & m )) -eq $(( $(ip_num "\${c%/*}") & m )) ] && return 0
  done
  return 1
}
# Proves the rules from the proxy's own address: strangers are refused, a user is served, and (unless allowed) the
# proxy will not reach your own network or itself. The user's password is read from standard input and passed to
# curl in a config file only root can read, never on a command line.
service() { echo 3proxy; }
selftest() {
  local user=$1 pw cfg code rc t probe=https://deb.debian.org/ lan=10.255.255.1
  valid_name "$user" || die "Not a user name."
  IFS= read -r pw || true
  [ -n "$pw" ] || die "No password was given."
  cfg=$(mktemp); trap 'rm -f "$cfg"' RETURN
  local q=\${pw//\\/\\\\}; q=\${q//\"/\\\"}
  printf 'proxy-user = "%s:%s"\n' "$user" "$q" > "$cfg"
  report() { printf 'check\t%s\t%s\t%s\n' "$1" "$2" "$3"; }
  if systemctl is-active --quiet "$(service)"; then report running ok "$(service) is running on $LISTEN_IP."
  else report running fail "$(service) is not running, so nothing else could be checked."; return 0; fi
  local own=1; in_allow "$LISTEN_IP" || own=0
  [ "$own" = 1 ] || report source info "The proxy's own address is not in the allowed networks, so only the refusal could be checked from here."
  if [ "$HTTP" = 1 ]; then
    t="http://$LISTEN_IP:3128"
    code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -x "$t" http://deb.debian.org/ || true)
    case "$code" in 407|403) report http_auth ok "Without a password: refused ($code)." ;; *) report http_auth fail "Without a password the HTTP proxy answered $code." ;; esac
    if [ "$own" = 1 ]; then
      code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' -K "$cfg" -x "$t" "$probe" || true)
      [ "$code" = 200 ] && report http_ok ok "With a password: $probe answered 200 through the proxy." || report http_ok fail "With a password, $probe answered \${code:-nothing} through the proxy."
      code=$(curl -s -o /dev/null -m 10 -w '%{http_connect}' -K "$cfg" -x "$t" https://deb.debian.org:22/ || true)
      case "$code" in 403|405|400) report connect_443 ok "A tunnel to port 22 was refused ($code); only 443 is allowed." ;; *) report connect_443 fail "A tunnel to port 22 answered \${code:-nothing}." ;; esac
      code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -K "$cfg" -x "$t" "http://$LISTEN_IP:3128/" || true)
      case "$code" in 403|400) report self ok "The proxy refused to reach itself ($code)." ;; *) report self fail "Asked to reach itself, the proxy answered \${code:-nothing}." ;; esac
      code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -K "$cfg" -x "$t" "http://localhost/" || true)
      case "$code" in 403) report localhost ok "A name for this machine (localhost) was refused (403)." ;; *) report localhost fail "Asked for localhost, the proxy answered \${code:-nothing}." ;; esac
      if [ "$LAN_TARGETS" = 1 ]; then report lan info "Your own network is reachable through the proxy: you allowed it."
      else
        code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -K "$cfg" -x "$t" "http://$lan/" || true)
        case "$code" in 403) report lan ok "A private address ($lan) was refused (403)." ;; *) report lan fail "A private address ($lan) answered \${code:-nothing}." ;; esac
      fi
    fi
  fi
  if [ "$SOCKS" = 1 ]; then
    t="socks5h://$LISTEN_IP:1080"
    rc=0; curl -s -o /dev/null -m 10 -x "$t" "$probe" || rc=$?
    # 97: the proxy itself refused the handshake (no acceptable sign-in method), not merely "nothing answered".
    [ "$rc" = 97 ] && report socks_auth ok "Without a password: refused by the proxy." || report socks_auth fail "Without a password the SOCKS proxy gave curl $rc (97 is a refusal)."
    if [ "$own" = 1 ]; then
      code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' -K "$cfg" -x "$t" "$probe" || true)
      [ "$code" = 200 ] && report socks_ok ok "With a password: $probe answered 200 through SOCKS." || report socks_ok fail "With a password, $probe answered \${code:-nothing} through SOCKS."
      rc=0; curl -s -o /dev/null -m 10 -K "$cfg" -x "$t" "http://$LISTEN_IP:22/" || rc=$?
      [ "$rc" = 97 ] && report socks_self ok "The proxy refused to reach itself." || report socks_self fail "Asked to reach itself, SOCKS gave curl $rc (97 is a refusal)."
      rc=0; curl -s -o /dev/null -m 10 -K "$cfg" -x "$t" "http://localhost/" || rc=$?
      [ "$rc" = 97 ] && report socks_localhost ok "A name for this machine (localhost) was refused." || report socks_localhost fail "Asked for localhost, SOCKS gave curl $rc (97 is a refusal)."
      if [ "$LAN_TARGETS" = 1 ]; then report socks_lan info "Your own network is reachable through the proxy: you allowed it."
      else
        rc=0; curl -s -o /dev/null -m 10 -K "$cfg" -x "$t" "http://$lan/" || rc=$?
        [ "$rc" = 97 ] && report socks_lan ok "A private address ($lan) was refused." || report socks_lan fail "A private address ($lan) gave curl $rc (97 is a refusal)."
      fi
    fi
  fi
}

case "\${1:-}" in
  selftest)    [ -n "\${2:-}" ] || die "Name the user."; selftest "$2" ;;
  stats)       stats "\${2:-60}" ;;
  apply)       apply ;;
  reload)      reload ;;
  users)       list_users ;;
  user-add)    [ -n "\${2:-}" ] || die "Name the user."; user_add "$2"; echo "User $2 saved." ;;
  user-del)    [ -n "\${2:-}" ] || die "Name the user."; user_del "$2"; echo "User $2 removed." ;;
  set)
    case "\${2:-}" in
      ALLOW)       v=$(echo "\${3:-}" | tr ',' ' ' | xargs); check_allow "$v"; ALLOW=$v ;;
      LAN_TARGETS) [[ "\${3:-}" =~ ^[01]$ ]] || die "0 or 1."; LAN_TARGETS=$3 ;;
      PER_CLIENT)  [[ "\${3:-}" =~ ^[01]$ ]] || die "0 or 1."; PER_CLIENT=$3; [ "$3" = 0 ] && forget_clients ;;
      *) die "Not a setting HyperProx changes." ;;
    esac
    save_conf; apply ;;
  *) die "Usage: hpx-fwdproxy stats|apply|reload|users|user-add|user-del|set|selftest" ;;
esac`

/** The pinned release, checked by SHA-256 in the script. */
export const THREEPROXY_VERSION = '0.9.9.2'
export const THREEPROXY_SHA256 = '4f6d516884f13cd5d2e8ebd4f5177cc5508f7b442bebeada8c4f34a9ed0ab5d0'

/** The whole install script. A function replacement: a string one would read $' and $& in the helper as patterns. */
export function proxyScript(): string {
  return [START_SCRIPT, THREEPROXY_SCRIPT, FINISH_SCRIPT.replace('@@HELPER@@', () => HELPER_SCRIPT)].join('\n')
}
