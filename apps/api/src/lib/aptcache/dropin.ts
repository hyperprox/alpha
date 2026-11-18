// =============================================================================
//  HyperProx — the package cache: pointing a guest's apt at it, safely
//
//  One apt config drop-in, /etc/apt/apt.conf.d/01hyperprox-cache, which names a
//  small detect script (Acquire::http::Proxy-Auto-Detect). apt runs that script
//  before it fetches from an http:// source; the script asks the cache for a
//  page with a three-second limit and prints the cache's address only when an
//  HTTP answer comes back. Anything else (the cache is off, stopped, full, or
//  refuses this guest) prints DIRECT, and apt goes straight to the internet as
//  if the drop-in were not there. Only the archives the cache serves go to it;
//  every other source goes direct. A dead cache never stops an update, and a
//  sick one (full, failing its check) is skipped once HyperProx notices.
//
//  HTTPS sources are left alone: apt fetches them directly (they cannot be
//  cached). A proxy someone set by hand in /etc/apt is never overridden: the
//  guest is reported as having its own and nothing is written.
//
//  Every script here runs through the Updates executor (lib/updates/executor.ts
//  guestExec), which refuses a guest HyperProx must leave alone.
// =============================================================================

import { DEBIAN_FULL_HOSTS, DEBIAN_HOSTS, UBUNTU_CODES } from './mirrors'

export const DROPIN = '/etc/apt/apt.conf.d/01hyperprox-cache'
export const DETECT = '/usr/local/lib/hyperprox/apt-cache-detect'

// The same strict rule as everywhere else: no leading zeros (an octet like 010 would be read as octal).
const IPV4 = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/

/** The cache's address, checked: an IPv4 address and a port. Anything else is refused before a script is built. */
export function checkCacheAddress(host: string, port: number): void {
  const m = IPV4.exec(String(host ?? ''))
  if (!m || m.slice(1).some(o => Number(o) > 255)) throw new Error('The package cache has no usable address.')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The package cache has no usable port.')
}

/**
 * The script's routing, as a bash case on "host/path": the cache only for a host and path it serves with ForceManaged
 * on (apt-cacher-ng's own mirror lists, lib/aptcache/mirrors.ts); everything else, debug and ports archives included,
 * DIRECT. apt asks once per host and keeps the answer for that run, so the cache also serves deb.debian.org's debug and
 * ports archives (HyperProx's own remaps): whichever answer apt kept for that host, those paths still work.
 */
export function routeCases(): string[] {
  const debianOnly = DEBIAN_HOSTS.filter(h => !DEBIAN_FULL_HOSTS.includes(h))
  return [
    'case "$h/$p" in',
    `  ${DEBIAN_FULL_HOSTS.map(h => `${h}/debian/*|${h}/debian-security/*`).join('|')}) ;;`,
    `  ${debianOnly.map(h => `${h}/debian/*`).join('|')}) ;;`,
    '  security.debian.org/*) ;;',
    `  archive.ubuntu.com/ubuntu/*|security.ubuntu.com/ubuntu/*|${UBUNTU_CODES.map(c => `${c}.archive.ubuntu.com/ubuntu/*`).join('|')}) ;;`,
    '  *) echo DIRECT; exit 0 ;;',
    'esac',
  ]
}

/**
 * The detect script apt runs before fetching from an http:// source: the cache's address only for an archive host and
 * path the cache serves, and only when the cache itself answers its own usage page (status 200, 401 or 406) within
 * three seconds. Anything else, a 5xx from a sick cache included, prints DIRECT.
 */
export function detectScript(host: string, port: number): string {
  checkCacheAddress(host, port)
  return [
    '#!/bin/bash',
    '# Written by HyperProx (Updates: "Use the package cache"). apt runs this before fetching from an http:// source.',
    '# It prints the package cache\'s address only for an archive the cache serves, and only when the cache answers',
    '# within three seconds; otherwise DIRECT, and apt fetches straight from the internet. Removed when the setting is',
    '# turned off.',
    'u=${1:-}',
    'case "$u" in http://*) ;; *) echo DIRECT; exit 0 ;; esac',
    'r=${u#http://}; h=${r%%/*}; p=${r#"$h"}; p=${p#/}; h=${h%%:*}; h=${h,,}; [ "$p" != "$r" ] || p=',
    ...routeCases(),
    `CACHE_HOST=${host}`,
    `CACHE_PORT=${port}`,
    'line=$(timeout 3 bash -c \'exec 3<>"/dev/tcp/$0/$1" && printf "GET / HTTP/1.0\\r\\nHost: %s\\r\\n\\r\\n" "$0" >&3 && head -c 12 <&3\' "$CACHE_HOST" "$CACHE_PORT" 2>/dev/null) || line=',
    'case "$line" in "HTTP/1."[01]" 200"|"HTTP/1."[01]" 401"|"HTTP/1."[01]" 406") echo "http://$CACHE_HOST:$CACHE_PORT" ;; *) echo DIRECT ;; esac',
    '',
  ].join('\n')
}

export function dropInText(): string {
  return [
    '// Written by HyperProx (Updates: "Use the package cache"). Removed when that setting is turned off.',
    '// The script prints the cache\'s address only for the archives it serves and only when it answers, else DIRECT.',
    `Acquire::http::Proxy-Auto-Detect "${DETECT}";`,
    '',
  ].join('\n')
}

/** Single-quoted for the shell. */
const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`

/**
 * Reads one apt config file (comments left out) and exits 0 when it sets a key under Acquire::http whose name starts
 * with "proxy" (Proxy, Proxy::<host>, Proxy-Auto-Detect), in any case and any nesting of blocks.
 */
export const OWN_PROXY_AWK = String.raw`
{ sub(/(^|[[:space:]])\/\/.*$/, ""); if ($0 ~ /^[[:space:]]*#/) next; buf = buf " " $0 }
END {
  while (match(buf, /\/\*/)) { rest = substr(buf, RSTART + 2); e = index(rest, "*/"); buf = substr(buf, 1, RSTART - 1) (e ? substr(rest, e + 2) : "") }
  n = 0; tok = ""; L = length(buf)
  for (i = 1; i <= L; i++) {
    c = substr(buf, i, 1)
    if (c == "\"") { j = index(substr(buf, i + 1), "\""); if (j == 0) j = L; tok = tok substr(buf, i, j + 1); i += j; continue }
    if (c == "{") { nm = tok; gsub(/^[[:space:]]+|[[:space:]]+$/, "", nm); st[++n] = tolower(nm); tok = ""; continue }
    if (c == "}") { if (n > 0) n--; tok = ""; continue }
    if (c == ";") {
      s = tok; gsub(/^[[:space:]]+/, "", s); split(s, w, /[[:space:]]+/); key = tolower(w[1]); pre = ""
      for (k = 1; k <= n; k++) pre = pre st[k] "::"
      if ((pre key) ~ /^acquire::http::proxy/) found = 1
      tok = ""; continue
    }
    tok = tok c
  }
  exit !found
}`

/**
 * Point this guest (or node) at the cache. Prints result=set|unchanged|own-proxy|no-apt, the address this machine
 * reaches the cache from (src=, so the plug-in can name clients without keeping their addresses), and whether the
 * cache answered from here (reachable=1|0). Exit 0 in every one of those cases: none of them may stop an update.
 */
export function ensureScript(host: string, port: number): string {
  checkCacheAddress(host, port)
  const detect = detectScript(host, port)
  const dropin = dropInText()
  return `set -e
D=${DROPIN}
S=${DETECT}
OWN_AWK=${shq(OWN_PROXY_AWK)}
if ! command -v apt-get >/dev/null 2>&1; then echo "result=no-apt"; exit 0; fi
# A proxy set by hand anywhere else wins: HyperProx takes its own setting out and leaves the guest alone. Looked for in
# the files apt reads (apt.conf, and in apt.conf.d names apt accepts: no extension or .conf, not .bak/.dpkg-*/.ucf-*
# and the like), comments left out, as a key under Acquire::http whichever way it is written (Acquire::http::Proxy,
# Acquire { http { Proxy ... } }, Acquire::http { Proxy-Auto-Detect ... }), in apt's merged view, and in /etc/environment.
own=
for f in /etc/apt/apt.conf /etc/apt/apt.conf.d/*; do
  [ -f "$f" ] && [ "$f" != "$D" ] || continue
  b=\${f##*/}
  case "$f" in /etc/apt/apt.conf.d/*)
    [[ "$b" =~ ^[A-Za-z0-9_.-]+$ ]] || continue
    case "$b" in *.conf|*.*) case "$b" in *.conf) ;; *) continue ;; esac ;; esac ;;
  esac
  if awk "$OWN_AWK" "$f"; then own=$f; break; fi
done
if [ -z "$own" ] && command -v apt-config >/dev/null 2>&1; then
  apt-config dump 2>/dev/null | grep -iE '^acquire::http::proxy' | grep -vF "$S" | grep -q . && own="apt's own settings"
fi
if [ -z "$own" ] && grep -qsiE '^[[:space:]]*(export[[:space:]]+)?http_proxy=' /etc/environment; then own=/etc/environment; fi
if [ -n "$own" ]; then
  rm -f "$D" "$S"
  echo "result=own-proxy"; echo "own=$(echo "$own" | head -n1 | tr ' ' '_')"; exit 0
fi
# apt runs the detect script as its unprivileged _apt user: the folder must be readable and searchable by everyone,
# whatever umask this shell inherited (a 0700 folder made apt fail every fetch with "ProxyAutoDetect returned 100").
install -d -m 755 "$(dirname "$S")"
chmod 755 "$(dirname "$S")"
T=$(mktemp)
cat > "$T" <<'HPX_DETECT'
${detect}HPX_DETECT
U=$(mktemp)
cat > "$U" <<'HPX_DROPIN'
${dropin}HPX_DROPIN
changed=0
if ! cmp -s "$T" "$S"; then install -m 755 "$T" "$S"; changed=1; fi
if ! cmp -s "$U" "$D"; then install -m 644 "$U" "$D"; changed=1; fi
rm -f "$T" "$U"
[ "$changed" = 1 ] && echo "result=set" || echo "result=unchanged"
src=$(ip -4 route get ${host} 2>/dev/null | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p' | head -n1 || true)
[ -z "$src" ] || echo "src=$src"
# Check as apt will run it: as _apt when that user exists, so a permission problem shows up here, not in apt.
if id _apt >/dev/null 2>&1 && command -v runuser >/dev/null 2>&1; then got=$(runuser -u _apt -- "$S" http://deb.debian.org/debian/ 2>/dev/null) || got=FAILED; else got=$("$S" http://deb.debian.org/debian/ 2>/dev/null) || got=FAILED; fi
if [ "$got" = FAILED ]; then
  # apt could not run the detect script: take the setting back out so apt goes direct, never fails.
  rm -f "$D" "$S"
  echo "result=unusable"; exit 0
fi
[ "$got" = "http://${host}:${port}" ] && echo "reachable=1" || echo "reachable=0"
exit 0`
}

/** Take HyperProx's drop-in and detect script out again. Prints result=removed|absent. Never touches anything else. */
export const REMOVE_SCRIPT = `D=${DROPIN}
S=${DETECT}
if [ -e "$D" ] || [ -e "$S" ]; then
  rm -f "$D" "$S"
  rmdir --ignore-fail-on-non-empty "$(dirname "$S")" 2>/dev/null || true
  echo "result=removed"
else
  echo "result=absent"
fi
exit 0`

export type EnsureResult =
  | { result: 'set' | 'unchanged'; src: string | null; reachable: boolean }
  | { result: 'own-proxy'; own: string | null }
  | { result: 'no-apt' }
  | { result: 'unusable' }

/** What ensureScript printed; null when it printed nothing it would. */
export function parseEnsure(output: string): EnsureResult | null {
  const r = /^result=(set|unchanged|own-proxy|no-apt|unusable)$/m.exec(output)?.[1]
  if (!r) return null
  if (r === 'no-apt') return { result: 'no-apt' }
  if (r === 'unusable') return { result: 'unusable' }
  if (r === 'own-proxy') return { result: 'own-proxy', own: /^own=(\S{1,200})$/m.exec(output)?.[1] ?? null }
  const src = /^src=(\d{1,3}(?:\.\d{1,3}){3})$/m.exec(output)?.[1] ?? null
  return { result: r as 'set' | 'unchanged', src, reachable: /^reachable=1$/m.test(output) }
}

export function parseRemove(output: string): 'removed' | 'absent' | null {
  return (/^result=(removed|absent)$/m.exec(output)?.[1] as 'removed' | 'absent' | undefined) ?? null
}
