# HyperProx node-side helpers. Sent ahead of every node-side script (bootstrap.sh, the setup wizard and the
# API all prepend this file), so each script arrives whole on stdin and nothing is left on the node.
#
# The rules every script follows:
#   - One node at a time, and idempotent: what is already there is left alone and reported as such.
#   - Packages are only ever *added*. Before installing, apt is asked what it would do; if that would
#     upgrade or remove anything, nothing is installed. Kernels, drivers and apt holds are never touched,
#     and there is no `apt upgrade` of any kind.
#   - The last line is the result:  HPX-RESULT<TAB>done|already|skipped|failed<TAB><plain reason>
set -u
export DEBIAN_FRONTEND=noninteractive
R="${HPX_SYSROOT:-}"

hp_result() { printf 'HPX-RESULT\t%s\t%s\n' "$1" "$2"; exit 0; }
hp_has() { command -v "$1" >/dev/null 2>&1; }
hp_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }

# hp_safe_apt_install PKG...: install packages that are not installed yet, only if that changes nothing
# else. Returns 0 when they are installed afterwards; prints why not otherwise.
hp_safe_apt_install() {
  local want=() p sim
  for p in "$@"; do hp_installed "$p" || want+=("$p"); done
  [ "${#want[@]}" -eq 0 ] && return 0
  hp_has apt-get || { echo "this node has no apt-get"; return 1; }
  sim="$(apt-get -s -q install --no-install-recommends "${want[@]}" 2>&1)" || {
    # The package lists may never have been fetched on this node. Refreshing them changes no package.
    apt-get -q update >/dev/null 2>&1 || true
    sim="$(apt-get -s -q install --no-install-recommends "${want[@]}" 2>&1)" || { echo "apt cannot install ${want[*]} here"; return 1; }
  }
  # "Inst pkg [old-version] (new ...)" is an upgrade of something already installed; "Remv" a removal.
  if printf '%s\n' "$sim" | grep -qE '^(Inst [^ ]+ \[|Remv |Purg )'; then
    echo "installing ${want[*]} would upgrade or remove other packages, so HyperProx left it alone:"
    printf '%s\n' "$sim" | grep -E '^(Inst [^ ]+ \[|Remv |Purg )' | head -5 | sed 's/^/  /'
    return 1
  fi
  apt-get -q -y install --no-install-recommends -o Dpkg::Options::=--force-confold "${want[@]}" >/dev/null 2>&1 \
    || { echo "apt-get install ${want[*]} failed"; return 1; }
}

# hp_write_file PATH MODE CONTENT: write only when the content differs. Prints "same" or "written".
hp_write_file() {
  local path="$1" mode="$2" content="$3"
  if [ -f "$path" ] && [ "$(cat "$path")" = "$content" ]; then echo same; return 0; fi
  mkdir -p "$(dirname "$path")"
  ( umask 022; printf '%s\n' "$content" > "$path.hpx-tmp" ) && chmod "$mode" "$path.hpx-tmp" && mv -f "$path.hpx-tmp" "$path"
  echo written
}

# hp_answers PORT PATTERN: the exporter on PORT serves metrics matching PATTERN, now (waits up to ~10 s).
hp_answers() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -fsS --max-time 3 "http://127.0.0.1:$1/metrics" 2>/dev/null | grep -q "$2" && return 0
    sleep 1
  done
  return 1
}
