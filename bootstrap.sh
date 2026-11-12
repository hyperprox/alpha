#!/usr/bin/env bash
#
# HyperProx — one-command install, run on a Proxmox host.
#
#   curl -fsSL https://raw.githubusercontent.com/hyperprox/alpha/main/bootstrap.sh | bash
#
# Everything the README used to ask you to do by hand, this does: picks a
# container ID and a storage, fetches the right template for this host's CPU,
# creates the container with the features Docker needs, mints the API token,
# then installs HyperProx and hands you a URL.
#
# First it looks at every node (GPUs, power counters, what is already
# installed), lists what it found, and asks a few yes/no questions — only the
# ones that apply, and never about something that is already there. Then it
# shows one summary of everything it will create and asks once more. Nothing is
# created before that last answer. -y takes every default.
#
# If the install stops part-way (Ctrl+C, a failure), what this run created is
# removed again; anything that was there before is never touched.
#
# The node scripts live in packages/hardware/node/ (the same ones the setup
# wizard and the API use). They only ever add packages, never upgrade or remove
# one, and never touch kernels, drivers or apt holds.
#
# It is safe to re-run: anything already correct is left alone.
#
# The whole script is one function, called on the very last line. Under
# `curl | bash`, bash reads the script from the pipe as it runs; wrapped like
# this, nothing runs until the last line has arrived (a cut-off download runs
# nothing), and no command started later can read the rest of the script as
# its input.

set -euo pipefail

CTID=""            ; HOSTNAME="hyperprox"
CORES=4            ; MEMORY=8192        ; DISK=100
BRIDGE="vmbr0"     ; NET="dhcp"         ; GATEWAY=""
STORAGE=""         ; TEMPLATE_STORAGE=""
PASSWORD=""        ; ASSUME_YES=0       ; DRY_RUN=0       ; KEEP_ON_FAILURE=0
REF=""             # a tag, branch or commit to install instead of main (--ref)
[ "${HYPERPROX_YES:-}" = 1 ] && ASSUME_YES=1
# Answers: "" means ask (or take the default with -y); a flag below answers in advance.
A_NODE_HEALTH=""   ; A_POWER=""         ; A_GPU=""
A_CHARTS=""        ; A_PVE_METRICS=""   ; A_DNS=""          ; A_AI=""          ; A_IGPU=""

C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_DIM=$'\e[90m'; C_ACC=$'\e[36m'; C_OFF=$'\e[0m'
say()  { printf '%s→%s %s\n' "$C_ACC" "$C_OFF" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_OFF" "$*"; }
die()  { printf '  %s✗%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }
note() { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }

usage() {
  cat <<'USAGE'
Usage: bootstrap.sh [options]

  --vmid N            Container ID           (default: one that fits your numbering, or next free)
  --hostname NAME     Container hostname     (default: hyperprox)
  --cores N           CPU cores              (default: 4)
  --memory MB         Memory in MB           (default: 8192)
  --disk GB           Disk in GB             (default: 100)
  --storage NAME      Storage for the rootfs (default: block storage with room, most free first)
  --bridge NAME       Network bridge         (default: vmbr0)
  --ip CIDR           Static address, e.g. 10.0.0.50/24 (default: one that fits your numbering, or dhcp)
  --gateway IP        Gateway, required with --ip
  --password PASS     Container root password (default: generated)
  --skip-exporter     Answer no: do not watch node health (node_exporter)
  --skip-rapl         Answer no: do not monitor power (CPU energy counters)
  --skip-gpu-exporter Answer no: do not monitor GPUs
  --no-charts         Answer no: no Prometheus and Grafana
  --no-pve-metrics    Answer no: do not read Proxmox's own metrics
  --ai | --no-ai      Answer yes or no: a local AI assistant (Ollama)
  --igpu | --no-igpu  Answer yes or no: let containers use the nodes' built-in graphics
  --dry-run           Look and ask, then show what would be done; change nothing
  --keep-on-failure   If the install fails, keep what was created so you can look inside
  --ref REF           Install this release tag, branch or commit instead of main (e.g. v0.3.0);
                      HyperProx can update itself from there (Updates page)
  -y, --yes           Take every default and do not ask (or set HYPERPROX_YES=1)
USAGE
}

# ---------------------------------------------------------------------------
#  Questions. The words are the setup wizard's too (packages/hardware/index.js,
#  QUESTIONS); a test keeps the two the same.
# ---------------------------------------------------------------------------
Q_NODE_HEALTH='Do you want HyperProx to watch the health of each of your nodes (CPU, memory, disks)?'
W_NODE_HEALTH='Installs node_exporter on every node. It answers on port 9100.'
Q_POWER='Do you want HyperProx to monitor the power on each of your nodes?'
W_POWER='Lets HyperProx read the CPU energy counters. The trade-off: any local user on that node can then read energy use.'
Q_GPU='Do you want HyperProx to monitor your GPUs?'
W_GPU='Intel and NVIDIA GPUs get a small exporter (ports 8081, 9835); AMD GPUs are read by node_exporter. Drivers are never touched.'
Q_IGPU='Do you want containers on these nodes to be able to use their built-in graphics (for video transcoding)?'
W_IGPU='Opens the built-in Intel or AMD graphics to containers. The trade-off: any container on that node can then use its built-in graphics.'
Q_CHARTS='Do you want charts and dashboards (Prometheus and Grafana)?'
W_CHARTS='Runs Prometheus and Grafana on this machine. You reach them only through HyperProx.'
Q_PVE_METRICS="Do you want HyperProx to read Proxmox's own metrics?"
W_PVE_METRICS='Makes a read-only Proxmox token (PVEAuditor) for the metrics exporter.'
Q_DNS='Do you manage your domains at GoDaddy? Paste a key to let HyperProx manage DNS.'
W_DNS='The key is kept in the vault. You can skip this and add it later.'
Q_AI='Do you want a local AI assistant? HyperProx can run a small one on this machine, or you can connect one later.'
W_AI='Runs Ollama here (3 CPUs, 4 GB) and downloads a small model (about 2 GB).'

# Where answers come from, set up by open_answers: fd 3. INTERACTIVE=1 when a person is there to ask
# (a terminal, or HPX_TTY); NO_TERMINAL=1 when there is nothing to read answers from at all.
INTERACTIVE=0; NO_TERMINAL=0
open_answers() {
  if [ -n "${HPX_TTY:-}" ]; then
    # Tests point this at a file of answers: it stands in for the keyboard.
    if exec 3< "$HPX_TTY"; then INTERACTIVE=1; else NO_TERMINAL=1; fi 2>/dev/null
  elif [ -f "${BASH_SOURCE[0]:-}" ] && [ ! -t 0 ]; then
    # Run from a file with answers piped in (`printf 'y\nn\n' | bash bootstrap.sh`): they come from stdin.
    # Opened once, as fd 3: stdin may be a socket, which cannot be opened again by name.
    exec 3<&0
  elif [ -t 0 ]; then
    exec 3<&0; INTERACTIVE=1
  elif { exec 3</dev/tty; } 2>/dev/null; then
    # Under `curl | bash` stdin is this script, so the keyboard is reached through /dev/tty.
    INTERACTIVE=1
  else
    NO_TERMINAL=1
  fi
  # No command after this reads stdin by accident: not the rest of a piped script, and not a keypress.
  exec 0</dev/null
}

# ask_yn VAR DEFAULT(yes|no) QUESTION WHAT: sets VAR to yes or no. A value given by a flag wins.
ask_yn() {
  local var="$1" def="$2" q="$3" what="$4" reply hint
  if [ -n "${!var}" ]; then printf '  %s %s\n' "$q" "${!var}"; return; fi
  if [ "$ASSUME_YES" -eq 1 ] || [ "$NO_TERMINAL" -eq 1 ]; then printf -v "$var" '%s' "$def"; printf '  %s %s\n' "$q" "$def"; return; fi
  [ "$def" = yes ] && hint='[Y/n]' || hint='[y/N]'
  printf '\n  %s%s%s\n    %s%s%s\n  %s ' "$C_ACC" "$q" "$C_OFF" "$C_DIM" "$what" "$C_OFF" "$hint"
  # Nothing more to read (EOF) is not consent: every question here asks to add something, so it means no.
  if ! IFS= read -r reply <&3 && [ -z "$reply" ]; then printf -v "$var" no; printf '(no answer: no)'; [ -t 1 ] || echo; return; fi
  case "$reply" in [yY]*) printf -v "$var" yes;; [nN]*) printf -v "$var" no;; *) printf -v "$var" '%s' "$def";; esac
  [ -t 1 ] || echo
}
# ask_secret VAR PROMPT: read without echo. Held in this shell's memory only.
ask_secret() {
  local var="$1" reply=""
  printf '    %s: ' "$2"
  IFS= read -rs reply <&3 || reply=""
  echo
  printf -v "$var" '%s' "$reply"
}

# ---------------------------------------------------------------------------
#  Undo: what this run created is removed again if it does not finish.
#  Every *_TRY flag is set just before the command that creates the thing, and
#  each was checked to be absent first, so nothing that was already there is
#  ever removed.
# ---------------------------------------------------------------------------
FINISHED=0; INTERRUPTED=0
TMP_PATHS=()
CT_TRY=0
# This run's mark, put in the container's description: the rollback removes a container only if it carries it.
RUN_MARK="hyperprox-install-$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
TPL_TRY=0
TOKEN_TRY=0; TOKEN_EXISTED=0; XTOKEN_TRY=0; XTOKEN_EXISTED=0
NODE_UNDO=(); NODE_LEFT=()

guest_conf() {   # the config file of guest ID anywhere in the cluster, if there is one
  local f
  for f in "$PVE_ETC"/nodes/*/lxc/"$1".conf "$PVE_ETC"/nodes/*/qemu-server/"$1".conf "$PVE_ETC"/lxc/"$1".conf; do
    [ -e "$f" ] && { echo "$f"; return 0; }
  done
  return 1
}
# Read whole before searching: with pipefail, `cmd | grep -q` fails when grep stops reading early.
token_exists() { grep -q "\"$1\"" <<< "$(pveum user token list root@pam --output-format json 2>/dev/null)"; }
# The path of a template on its storage, or nothing if the storage cannot say.
template_path() { pvesm path "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" 2>/dev/null || true; }

rollback() {
  local p node step f out tp
  # Node steps first, newest first; then the container, tokens and template.
  for (( i=${#NODE_UNDO[@]}-1; i>=0; i-- )); do
    p="${NODE_UNDO[$i]}"; node="${p%%$'\t'*}"; step="${p#*$'\t'}"
    out="$(step_text "$step" | node_run "$node" 2>/dev/null || true)"
    if grep -q $'^HPX-RESULT\t\(done\|already\)' <<< "$out"; then
      ok "$node: undid $(step_label "${step%-undo}")"
    else warn "$node: could not undo $(step_label "${step%-undo}"); see Settings → Setup checklist"; fi
  done
  if [ "$CT_TRY" -eq 1 ]; then
    # Only a container that carries this run's mark is ours. pct create removes its own volumes when it fails.
    if f="$(guest_conf "$CTID")"; then
      if grep -qF "$RUN_MARK" "$f" && grep -qxF "hostname: ${HOSTNAME}" "$f"; then
        pct stop "$CTID" >/dev/null 2>&1 || true
        if pct destroy "$CTID" --purge >/dev/null 2>&1; then ok "Removed container $CTID"
        else warn "Could not remove container $CTID; remove it with: pct destroy $CTID --purge"; fi
      elif grep -qxF "lock: create" "$f"; then
        # A create cut off before it wrote anything but its lock: not provably ours, so it is not removed here.
        warn "Container $CTID was left half-made (locked while being created). If nobody else is creating it, remove it with:"
        note "pct unlock $CTID && pct destroy $CTID --purge"
      fi
    fi
  fi
  if [ "$XTOKEN_TRY" -eq 1 ] && [ "$XTOKEN_EXISTED" -eq 0 ] && token_exists "$EXPORTER_TOKEN"; then
    pveum user token remove root@pam "$EXPORTER_TOKEN" >/dev/null 2>&1 \
      && ok "Removed token root@pam!$EXPORTER_TOKEN" || warn "Could not remove token root@pam!$EXPORTER_TOKEN"
  fi
  if [ "$TOKEN_TRY" -eq 1 ] && [ "$TOKEN_EXISTED" -eq 0 ] && token_exists hyperprox; then
    pveum user token remove root@pam hyperprox >/dev/null 2>&1 \
      && ok "Removed token root@pam!hyperprox" || warn "Could not remove token root@pam!hyperprox"
  fi
  tp=""; [ "$TPL_TRY" -eq 1 ] && tp="$(template_path)"
  if [ -n "$tp" ] && [ -e "$tp" ]; then
    pveam remove "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" >/dev/null 2>&1 \
      && ok "Removed the template this run downloaded" || warn "Could not remove ${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"
  fi
  for p in "${NODE_LEFT[@]}"; do
    node="${p%%$'\t'*}"; step="${p#*$'\t'}"
    if [ "$step" = rapl ]; then
      note "Left in place on $node: $(step_label "$step") (a rule that lets local users read energy use; to undo it, delete /etc/udev/rules.d/99-hyperprox-rapl.rules there)"
    else
      note "Left in place on $node: $(step_label "$step") (monitoring software; it does no harm, and a re-run uses it)"
    fi
  done
}
made_anything() {
  [ "$CT_TRY" -eq 1 ] || [ "$TPL_TRY" -eq 1 ] || [ "$TOKEN_TRY" -eq 1 ] || [ "$XTOKEN_TRY" -eq 1 ] \
    || [ "${#NODE_UNDO[@]}" -gt 0 ] || [ "${#NODE_LEFT[@]}" -gt 0 ]
}
on_exit() {
  local rc=$? p
  trap '' INT TERM HUP     # a second Ctrl+C must not stop the clean-up half-way
  set +eu
  if [ "$FINISHED" -ne 1 ]; then
    echo
    if ! made_anything; then
      [ "$INTERRUPTED" -eq 1 ] && note "Stopped. Nothing was created."
    elif [ "$KEEP_ON_FAILURE" -eq 1 ] && [ "$INTERRUPTED" -ne 1 ]; then
      warn "Stopped part-way. Kept what was made, as asked (--keep-on-failure): container ${CTID}."
    else
      say "$([ "$INTERRUPTED" -eq 1 ] && echo Interrupted || echo Stopped) — undoing what this run created"
      rollback
    fi
  fi
  for p in "${TMP_PATHS[@]}"; do [ -n "$p" ] && rm -rf -- "$p"; done
  exit "$rc"
}

# ---------------------------------------------------------------------------
#  Node scripts and running them
# ---------------------------------------------------------------------------
RAW_BASE="${HPX_RAW_BASE:-https://raw.githubusercontent.com/hyperprox/alpha/main}"
NODE_DIR=""
node_scripts_dir() {   # sets NODE_DIR
  local here="" f
  [ -f "${BASH_SOURCE[0]:-}" ] && here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -n "$here" ] && [ -f "$here/packages/hardware/node/probe.sh" ]; then NODE_DIR="$here/packages/hardware/node"; return; fi
  NODE_DIR="$(mktemp -d)"; TMP_PATHS+=("$NODE_DIR")
  for f in probe common node-exporter rapl intel-gpu-exporter nvidia-gpu-exporter amd-gpu-metrics amd-gpu-metrics-undo igpu-access igpu-access-undo; do
    curl -fsSL "$RAW_BASE/packages/hardware/node/$f.sh" -o "$NODE_DIR/$f.sh" || die "Could not download the node scripts from $RAW_BASE"
  done
}

# node_run NODE: run the script on stdin there. This node directly, the others over the cluster's SSH trust,
# by the address the cluster has for them (node names do not always resolve) and checked against the key
# the cluster recorded for that node name.
node_run() {
  if [ "$1" = "$THIS_NODE" ]; then bash -s; return; fi
  local ip f kh="" opts=(-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes -o "HostKeyAlias=$1")
  ip="$(node_ip "$1")"; [ -n "$ip" ] && opts+=(-o "HostName=$ip")
  # The keys the cluster itself recorded: the node's own file (PVE 8.1+) and the cluster-wide one.
  for f in "$PVE_ETC/nodes/$1/ssh_known_hosts" "$PVE_ETC/priv/known_hosts"; do [ -f "$f" ] && kh="${kh:+$kh }$f"; done
  [ -n "$kh" ] && opts+=(-o "GlobalKnownHostsFile=$kh")
  ssh "${opts[@]}" "$1" 'bash -s'
}

cluster_nodes() {
  pvesh get /nodes --output-format json 2>/dev/null \
    | sed 's/},{/}\n{/g' | sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sort -u
}
# The address each node has in the cluster.
CLUSTER_STATUS=""
node_ip() {
  [ -n "$CLUSTER_STATUS" ] || CLUSTER_STATUS="$(pvesh get /cluster/status --output-format json 2>/dev/null | sed 's/},{/}\n{/g')"
  grep "\"name\"[[:space:]]*:[[:space:]]*\"$1\"" <<< "$CLUSTER_STATUS" | sed -n 's/.*"ip"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true
}

declare -gA HW_GPUS HW_RAPL HW_NX HW_INTEL_X HW_NV_X HW_OK HW_IGPU HW_AMD_X
CHECKLIST=()
check() { CHECKLIST+=("$1"$'\t'"$2"$'\t'"$3"$'\t'"$4"); }   # status label node reason

step_label() {
  case "$1" in
    node-exporter) echo "Health monitoring";; rapl) echo "Power monitoring";;
    intel-gpu-exporter) echo "Intel GPU monitoring";; nvidia-gpu-exporter) echo "NVIDIA GPU monitoring";;
    amd-gpu-metrics) echo "AMD GPU monitoring";;
    igpu-access) echo "Built-in graphics for containers";;
  esac
}
# A step as one script: the helpers, then (for the built-in graphics steps) the probe's own functions.
step_text() {
  cat "$NODE_DIR/common.sh"
  case "$1" in igpu-access*) echo 'HPX_PROBE_LIB=1'; cat "$NODE_DIR/probe.sh";; esac
  cat "$NODE_DIR/$1.sh"
}
metrics_from() { curl -fsS --max-time 5 "http://$1:$2/metrics" 2>/dev/null; }
# metrics_has HOST PORT PATTERN. node_exporter's page is large: piped into grep -q, curl is cut off when grep
# stops early, and with pipefail that reads as "does not answer".
metrics_has() { local m; m="$(metrics_from "$1" "$2" || true)"; grep -q "$3" <<< "$m"; }
rapl_joules() { { metrics_from "$1" 9100 || true; } | awk '/^node_rapl_package_joules_total/ {s += $2} END {printf "%.3f", s + 0}'; }
join_list() { local IFS=,; local s="$*"; echo "${s//,/, }"; }

# ---------------------------------------------------------------------------
#  This host's CPU architecture, as Debian and Proxmox's templates name it
# ---------------------------------------------------------------------------
host_arch() {
  local a
  a="$(dpkg --print-architecture 2>/dev/null || true)"
  if [ -z "$a" ]; then
    case "$(uname -m)" in x86_64|amd64) a=amd64;; aarch64|arm64) a=arm64;; *) a="";; esac
  fi
  case "$a" in amd64|arm64) echo "$a";; *) return 1;; esac
}

# Standard Debian template names in some pveam output, one per line (pveam list: "store:vztmpl/NAME";
# pveam available: "system  NAME  [arch]").
debian_templates() { grep -oE 'debian-[0-9]+-standard_[^[:space:]/:]+\.tar\.zst' | sort -u || true; }
# Only those built for ARCH: the name ends in exactly _ARCH.tar.zst.
for_arch() { grep -E "_${1}\.tar\.zst\$" || true; }
newest() { sort -V | tail -1; }

# ---------------------------------------------------------------------------
#  Storage for the container's disk: one that is active, can hold DISK GB, and
#  is block storage if there is any (a container's root on a network file share
#  is slow and fragile). Among equals, the most space free.
# ---------------------------------------------------------------------------
pick_rootfs_storage() {
  pvesm status -content rootdir 2>/dev/null | awk -v need="$(( DISK * 1024 * 1024 ))" '
    NR > 1 && $3 == "active" && $6 + 0 >= need {
      tier = 3
      if ($2 ~ /^(rbd|zfspool|lvmthin|lvm|iscsidirect)$/) tier = 1
      else if ($2 ~ /^(dir|btrfs|zfs)$/) tier = 2
      printf "%d %.0f %s\n", tier, $6, $1
    }' | sort -k1,1n -k2,2nr | head -1 | awk '{print $3}'
}

# ---------------------------------------------------------------------------
#  Numbering. Many clusters number guests <node#><two digits> and give each the
#  address .2<the same two digits> (guest 342 on node 3 at x.y.z.242). When most
#  guests do, the new container is offered an ID and an address that fit.
# ---------------------------------------------------------------------------
# A guest's first static IPv4 address, from the current config only (not snapshots): "a.b.c.d/nn gw".
conf_ip() {
  awk '/^\[/ { exit }
       /^(net|ipconfig)[0-9]+:/ && match($0, /ip=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\/[0-9]+/) {
         ip = substr($0, RSTART + 3, RLENGTH - 3); gw = ""
         if (match($0, /gw=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/)) gw = substr($0, RSTART + 3, RLENGTH - 3)
         print ip, gw; exit }' "$1"
}
node_digit_from_name() { [[ "$1" =~ [^0-9]([1-9])$ ]] && echo "${BASH_REMATCH[1]}"; return 0; }
majority() { sort | uniq -c | sort -k1,1nr | awk 'NR==1 {print $2}'; }

# addr_answers ADDR: something on the network answers on ADDR (a ping, or an ARP reply where iputils arping is
# installed: hosts that drop pings still answer ARP).
addr_answers() {
  ping -c 1 -W 1 "$1" >/dev/null 2>&1 && return 0
  if command -v arping >/dev/null 2>&1 && arping -V 2>&1 | grep -q iputils; then
    # -D: duplicate address detection, which exits non-zero when anything replies.
    arping -q -D -c 2 -w 3 -I "$BRIDGE" "$1" >/dev/null 2>&1 || return 0
  fi
  return 1
}
# addr_in_configs ADDR: some guest config (snapshots and pending changes too) names ADDR.
addr_in_configs() { grep -qsE "ip=${1//./\\.}/" "$PVE_ETC"/nodes/*/lxc/*.conf "$PVE_ETC"/nodes/*/qemu-server/*.conf; }

CONV_ID=""; CONV_IP=""; CONV_GW=""; CONV_MATCH=0; CONV_TOTAL=0
detect_numbering() {
  local f node id ipc ip gw o lead d subnet cidr x cand_id cand_ip pings=0 used_ips
  local -A digit votes
  local rows=()
  for f in "$PVE_ETC"/nodes/*/lxc/*.conf "$PVE_ETC"/nodes/*/qemu-server/*.conf; do
    [ -e "$f" ] || continue
    ipc="$(conf_ip "$f")"; [ -n "$ipc" ] || continue
    node="$(basename "$(dirname "$(dirname "$f")")")"; id="$(basename "$f" .conf)"
    rows+=("$node $id $ipc")
    ip="${ipc%%/*}"; o="${ip##*.}"
    if [[ "$id" =~ ^[1-9][0-9][0-9]$ ]] && [ "$o" -ge 200 ] && [ "$o" -le 299 ] && [ $((10#${id:1})) -eq $((o - 200)) ]; then
      votes[$node]+="${id:0:1}"$'\n'
    fi
  done
  CONV_TOTAL=${#rows[@]}
  [ "$CONV_TOTAL" -ge 3 ] || return 0
  # Each node's digit: the one its name ends in, else the one most of its guests start with.
  for node in "${!votes[@]}" "$THIS_NODE"; do
    d="$(node_digit_from_name "$node")"
    [ -n "$d" ] || d="$(printf '%s' "${votes[$node]:-}" | grep . | majority || true)"
    digit[$node]="$d"
  done
  local matched=()
  for f in "${rows[@]}"; do
    read -r node id ipc gw <<< "$f"
    ip="${ipc%%/*}"; o="${ip##*.}"
    [[ "$id" =~ ^[1-9][0-9][0-9]$ ]] && [ "$o" -ge 200 ] && [ "$o" -le 299 ] || continue
    [ "${id:0:1}" = "${digit[$node]:-x}" ] && [ $((10#${id:1})) -eq $((o - 200)) ] || continue
    matched+=("$ipc ${gw:-}")
  done
  CONV_MATCH=${#matched[@]}
  [ "$CONV_MATCH" -ge 3 ] && [ $((CONV_MATCH * 2)) -gt "$CONV_TOTAL" ] || return 0
  d="${digit[$THIS_NODE]:-}"; [ -n "$d" ] || return 0
  command -v ping >/dev/null 2>&1 || return 0      # an address that cannot be checked is not offered
  subnet="$(printf '%s\n' "${matched[@]}" | awk '{split($1, a, "/"); sub(/\.[0-9]+$/, "", a[1]); print a[1]}' | majority)"
  cidr="$(printf '%s\n' "${matched[@]}" | awk '{split($1, a, "/"); print a[2]}' | majority)"
  gw="$(printf '%s\n' "${matched[@]}" | awk 'NF > 1 {print $2}' | majority)"
  [ -n "$gw" ] || gw="$(ip route show default 2>/dev/null | awk '/via/ {for (i = 1; i < NF; i++) if ($i == "via") {print $(i+1); exit}}')"
  [ -n "$subnet" ] && [ -n "$cidr" ] && [ -n "$gw" ] || return 0
  # Every address any guest config names (snapshots and pending changes too), and every node's.
  used_ips="$( { cat "$PVE_ETC"/nodes/*/lxc/*.conf "$PVE_ETC"/nodes/*/qemu-server/*.conf 2>/dev/null \
                  | grep -oE 'ip=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | cut -d= -f2
                for node in "${NODES[@]}"; do node_ip "$node"; done; } | sort -u)"
  for x in $(seq 0 54); do
    cand_id="$d$(printf '%02d' "$x")"; cand_ip="$subnet.$((200 + x))"
    guest_conf "$cand_id" >/dev/null && continue
    [ "$(pvesh get /cluster/nextid --vmid "$cand_id" 2>/dev/null)" = "$cand_id" ] || continue
    [ "$cand_ip" = "$gw" ] && continue
    grep -qxF "$cand_ip" <<< "$used_ips" && continue
    pings=$((pings + 1)); [ "$pings" -le 12 ] || return 0
    addr_answers "$cand_ip" && continue
    CONV_ID="$cand_id"; CONV_IP="$cand_ip/$cidr"; CONV_GW="$gw"
    return 0
  done
}

# ===========================================================================
main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --vmid) CTID="$2"; shift 2;;
      --hostname) HOSTNAME="$2"; shift 2;;
      --cores) CORES="$2"; shift 2;;
      --memory) MEMORY="$2"; shift 2;;
      --disk) DISK="$2"; shift 2;;
      --storage) STORAGE="$2"; shift 2;;
      --bridge) BRIDGE="$2"; shift 2;;
      --ip) NET="$2"; shift 2;;
      --gateway) GATEWAY="$2"; shift 2;;
      --password) PASSWORD="$2"; shift 2;;
      --skip-exporter) A_NODE_HEALTH=no; shift;;
      --skip-rapl) A_POWER=no; shift;;
      --skip-gpu-exporter) A_GPU=no; shift;;
      --no-charts) A_CHARTS=no; shift;;
      --no-pve-metrics) A_PVE_METRICS=no; shift;;
      --ai) A_AI=yes; shift;;
      --no-ai) A_AI=no; shift;;
      --igpu) A_IGPU=yes; shift;;
      --no-igpu) A_IGPU=no; shift;;
      --dry-run) DRY_RUN=1; shift;;
      --keep-on-failure) KEEP_ON_FAILURE=1; shift;;
      --ref) REF="${2:-}"; shift 2;;
      -y|--yes) ASSUME_YES=1; shift;;
      -h|--help) usage; exit 0;;
      *) die "Unknown option: $1 (try --help)";;
    esac
  done
  ipv4='^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$'
  [[ "$HOSTNAME" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$ ]] && [ "${#HOSTNAME}" -le 253 ] \
    || die "--hostname must be a host name: letters, digits and hyphens, optionally dotted."
  [[ "$BRIDGE" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || die "--bridge must be a network interface name, e.g. vmbr0."
  [ -z "$GATEWAY" ] || [[ "$GATEWAY" =~ $ipv4 ]] || die "--gateway must be an IPv4 address."
  for v in CORES MEMORY DISK; do [[ "${!v}" =~ ^[1-9][0-9]*$ ]] || die "--${v,,} must be a whole number."; done
  [ -z "$CTID" ] || [[ "$CTID" =~ ^[1-9][0-9]{2,8}$ ]] || die "--vmid must be a number of 100 or more."
  if [ -n "$REF" ]; then
    [[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ && "$REF" != *..* && "$REF" != -* ]] || die "--ref must be a tag, branch or commit id."
    # The installer and the node scripts come from that same version (HPX_RAW_BASE, when set, is used as given).
    [ -n "${HPX_RAW_BASE:-}" ] || RAW_BASE="https://raw.githubusercontent.com/hyperprox/alpha/$REF"
  fi
  # A mirror or fork to clone instead of GitHub (HPX_REPO_URL), as install.sh's HYPERPROX_REPO_URL.
  REPO_URL_ARG="${HPX_REPO_URL:-}"
  [ -z "$REPO_URL_ARG" ] || [[ "$REPO_URL_ARG" =~ ^https?://[A-Za-z0-9.:-]+/[A-Za-z0-9._~/-]+$ ]] || die "HPX_REPO_URL must be an http(s) git URL."
  if [ "$NET" != dhcp ]; then
    [[ "${NET%%/*}" =~ $ipv4 ]] && [[ "$NET" =~ /([1-9]|[12][0-9]|3[0-2])$ ]] || die "--ip must be an address with its prefix, e.g. 10.0.0.50/24."
    [ -n "$GATEWAY" ] || die "--ip needs --gateway too."
  fi

  open_answers
  trap on_exit EXIT
  trap 'INTERRUPTED=1; exit 130' INT TERM HUP
  PVE_ETC="${HPX_PVE_ETC:-/etc/pve}"

  # -------------------------------------------------------------------------
  #  1. Are we somewhere this can work?
  # -------------------------------------------------------------------------
  say "Checking this host"
  command -v pveversion >/dev/null 2>&1 || die "This must run on a Proxmox VE host — pveversion was not found."
  [ "$(id -u)" -eq 0 ] || die "This must run as root."
  ok "Proxmox $(pveversion | cut -d/ -f2)"
  ip link show "$BRIDGE" >/dev/null 2>&1 || die "There is no network bridge '$BRIDGE' on this node. Pass --bridge."
  ARCH="$(host_arch)" || die "This host's CPU ($(uname -m)) has no Proxmox container template; HyperProx needs amd64 or arm64."
  ok "CPU architecture: $ARCH"
  # This node's name in the cluster (which is not always what `hostname` says).
  THIS_NODE=""
  [ -L "$PVE_ETC/local" ] && THIS_NODE="$(basename "$(readlink -f "$PVE_ETC/local")")"
  [ -n "$THIS_NODE" ] || THIS_NODE="$(hostname -s 2>/dev/null || hostname)"
  NODES=($(cluster_nodes))
  [ "${#NODES[@]}" -gt 0 ] || NODES=("$THIS_NODE")

  # -------------------------------------------------------------------------
  #  2. Where to put it
  # -------------------------------------------------------------------------
  say "Choosing placement"
  if [ -z "$CTID" ] && [ "$NET" = dhcp ]; then
    detect_numbering
    if [ -n "$CONV_ID" ]; then
      use=""
      if [ "$NO_TERMINAL" -eq 1 ] && [ "$ASSUME_YES" -ne 1 ]; then
        note "Your guests follow <node#><IP> numbering; with no terminal to ask on, a static address is not chosen for you."
        use=no
      else
        ask_yn use yes "Your guests follow <node#><IP> numbering ($CONV_MATCH of $CONV_TOTAL do); use CT $CONV_ID with IP $CONV_IP (gateway $CONV_GW)?" \
          "The ID is free, no guest config uses the address, and nothing answers a ping on it."
      fi
      if [ "$use" = yes ]; then CTID="$CONV_ID"; NET="$CONV_IP"; GATEWAY="$CONV_GW"; fi
    fi
  fi
  [ -n "$CTID" ] || CTID="$(pvesh get /cluster/nextid)"
  [[ "$CTID" =~ ^[0-9]+$ ]] || die "Could not get a free container ID from Proxmox."
  if f="$(guest_conf "$CTID")"; then die "ID $CTID is already used ($f). Pass --vmid to choose another."; fi
  ok "Container ID $CTID"
  if [ "$NET" = dhcp ]; then ok "Network: DHCP on $BRIDGE"
  else
    if [ "$NET" != "${CONV_IP:-}" ]; then
      addr_in_configs "${NET%%/*}" && die "Another guest's config already uses ${NET%%/*}. Choose another --ip."
      addr_answers "${NET%%/*}" && die "Something already answers on ${NET%%/*}. Choose another --ip."
    fi
    ok "Network: $NET, gateway $GATEWAY, on $BRIDGE"
  fi

  if [ -z "$STORAGE" ]; then
    STORAGE="$(pick_rootfs_storage)"
    [ -n "$STORAGE" ] || die "No active storage on this node can hold a ${DISK} GB container disk. Pass --storage, or a smaller --disk."
  else
    pvesm status -content rootdir 2>/dev/null | awk -v s="$STORAGE" 'NR>1 && $1==s && $3=="active" {f=1} END {exit !f}' \
      || die "Storage '$STORAGE' is not active on this node, or cannot hold containers."
  fi
  ok "Rootfs storage: $STORAGE"

  # -------------------------------------------------------------------------
  #  3. Template — the newest Debian 13 built for this CPU. A template for
  #     another CPU is never used, even when it is the only one downloaded.
  # -------------------------------------------------------------------------
  say "Choosing the container template"
  [ "$DRY_RUN" -eq 1 ] || pveam update >/dev/null 2>&1 || warn "Could not refresh the template list; using what is cached."
  TPL_STORES=($(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 && $3=="active" {print $6, $1}' | sort -k1,1nr | awk '{print $2}'))
  [ "${#TPL_STORES[@]}" -gt 0 ] || die "No active storage on this node accepts container templates."
  AVAIL="$(pveam available --section system 2>/dev/null | debian_templates | for_arch "$ARCH")"
  declare -gA HAVE
  ALL_HAVE=""; OTHER_ARCH=""
  for s in "${TPL_STORES[@]}"; do
    if ! l="$(pveam list "$s" 2>/dev/null)"; then warn "Could not list the templates on $s; any there are checked again before downloading."; fi
    l="$(debian_templates <<< "$l")"
    HAVE[$s]="$(for_arch "$ARCH" <<< "$l")"
    ALL_HAVE="$ALL_HAVE${HAVE[$s]:+${HAVE[$s]}$'\n'}"
    OTHER_ARCH="$OTHER_ARCH$(grep -vE "_${ARCH}\.tar\.zst\$" <<< "$l" | grep . | sed "s|^|$s:|" || true)"$'\n'
  done
  CANDIDATES="$(printf '%s\n%s\n' "$AVAIL" "$ALL_HAVE" | grep . | sort -u || true)"
  TEMPLATE="$(grep '^debian-13-standard_' <<< "$CANDIDATES" | newest || true)"
  if [ -z "$TEMPLATE" ]; then
    TEMPLATE="$(grep -E '^debian-(1[2-9]|[2-9][0-9])-standard_' <<< "$CANDIDATES" | newest || true)"
    [ -n "$TEMPLATE" ] || die "No Debian container template for $ARCH is available from Proxmox or on this node's storage."
    warn "No Debian 13 template for $ARCH; using $TEMPLATE"
  fi
  while IFS= read -r o; do
    [ -n "$o" ] && note "Ignoring ${o#*:} on ${o%%:*}: it is not built for $ARCH."
  done <<< "$OTHER_ARCH"
  NEED_DOWNLOAD=1
  for s in "${TPL_STORES[@]}"; do
    if grep -qxF "$TEMPLATE" <<< "${HAVE[$s]}"; then TEMPLATE_STORAGE="$s"; NEED_DOWNLOAD=0; break; fi
  done
  if [ "$NEED_DOWNLOAD" -eq 1 ]; then
    grep -qxF "$TEMPLATE" <<< "$AVAIL" || die "$TEMPLATE is not offered for download."
    TEMPLATE_STORAGE="${TPL_STORES[0]}"
    ok "Template: $TEMPLATE ($ARCH), to be downloaded to $TEMPLATE_STORAGE"
  else
    TEMPLATE_PATH="$(template_path)"
    [ -n "$TEMPLATE_PATH" ] && [ -r "$TEMPLATE_PATH" ] && [ -s "$TEMPLATE_PATH" ] \
      || die "The template ${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE} is listed but cannot be read (${TEMPLATE_PATH:-no path}). Is the storage mounted?"
    ok "Template: $TEMPLATE ($ARCH), already on $TEMPLATE_STORAGE"
  fi

  # -------------------------------------------------------------------------
  #  3b. What every node has
  # -------------------------------------------------------------------------
  say "Looking at your nodes"
  node_scripts_dir
  ANY_CEPH=0; REACHED=()
  echo "    Found ${#NODES[@]} node$([ "${#NODES[@]}" -eq 1 ] || echo s):"
  for node in "${NODES[@]}"; do
    if ! out="$(node_run "$node" < "$NODE_DIR/probe.sh" 2>/dev/null)" || ! grep -q '^arch' <<< "$out"; then
      HW_OK[$node]=0
      echo "      • $node: could not be reached, so it is left out"
      continue
    fi
    HW_OK[$node]=1; REACHED+=("$node")
    gpus="$(awk -F'\t' '$1=="gpu"{print $2"\t"$3"\t"$5}' <<< "$out")"
    HW_GPUS[$node]="$gpus"
    HW_RAPL[$node]="$(awk -F'\t' '$1=="rapl"{print $2}' <<< "$out")"
    HW_NX[$node]="$(awk -F'\t' '$1=="node_exporter"{print $2}' <<< "$out")"
    HW_INTEL_X[$node]="$(awk -F'\t' '$1=="intel_exporter"{print $2}' <<< "$out")"
    HW_NV_X[$node]="$(awk -F'\t' '$1=="nvidia_exporter"{print $2}' <<< "$out")"
    HW_AMD_X[$node]="$(awk -F'\t' '$1=="amd_metrics"{print $2}' <<< "$out")"
    HW_IGPU[$node]="$(awk -F'\t' '$1=="igpu_access"{print $2}' <<< "$out")"
    grep -q $'^ceph\tyes' <<< "$out" && ANY_CEPH=1
    # "AMD Radeon Vega Series / Radeon Vega Mobile Series" is shown as "AMD Radeon Vega".
    words="$(awk -F'\t' 'NF { n = $3; sub(/ \/ .*/, "", n); sub(/ Series$/, "", n)
                         printf "%s%s (%s)", (k++ ? ", " : ""), n, ($2 == "integrated" ? "built in" : "dedicated") }' <<< "$gpus")"
    [ -n "$words" ] || words="no GPU"
    [ "${HW_RAPL[$node]}" = none ] && words="$words · no power counters"
    [ "${HW_NX[$node]}" = running ] && words="$words · health monitoring ✓"
    grep -qE $'^(intel|nvidia|amd)\t' <<< "$gpus" && gpu_covered "$node" && words="$words · GPU monitoring ✓"
    echo "      • $node: $words"
  done
  [ "$ANY_CEPH" -eq 1 ] && echo "    Ceph storage found."
  [ "${#REACHED[@]}" -gt 0 ] || die "No node could be reached, not even this one."

  # -------------------------------------------------------------------------
  #  3c. The questions — only those that apply, and never about what is there
  # -------------------------------------------------------------------------
  say "A few questions"
  [ "$NO_TERMINAL" -eq 1 ] && note "No terminal to ask on, so the defaults are shown. Re-run with -y to go ahead with them."
  N=${#REACHED[@]}; NS="$N node$([ "$N" -eq 1 ] || echo s)"
  NX_NEED=(); RAPL_ANY=(); RAPL_NEED=(); GPU_ANY=(); GPU_NEED=(); IGPU_ANY=(); IGPU_NEED=(); AMD_ANY=0
  for node in "${REACHED[@]}"; do
    [ "${HW_NX[$node]}" = running ] || NX_NEED+=("$node")
    [ "${HW_RAPL[$node]}" != none ] && RAPL_ANY+=("$node")
    [ "${HW_RAPL[$node]}" = root-only ] && RAPL_NEED+=("$node")
    if grep -qE $'^(intel|nvidia|amd)\t' <<< "${HW_GPUS[$node]}"; then
      GPU_ANY+=("$node"); gpu_covered "$node" || GPU_NEED+=("$node")
      grep -q $'^amd\t' <<< "${HW_GPUS[$node]}" && AMD_ANY=1
    fi
    case "${HW_IGPU[$node]}" in open) IGPU_ANY+=("$node");; closed) IGPU_ANY+=("$node"); IGPU_NEED+=("$node");; esac
  done

  # partial NEED_ARRAY_NAME ANY_ARRAY_NAME: names the nodes left to do when only some need it.
  partial() {
    local -n need="$1" any="$2"; local done_=() n
    [ "${#need[@]}" -lt "${#any[@]}" ] || return 0
    for n in "${any[@]}"; do [[ " ${need[*]} " == *" $n "* ]] || done_+=("$n"); done
    note "Already on $(join_list "${done_[@]}"); this is about $(join_list "${need[@]}")."
  }

  if [ -z "$A_NODE_HEALTH" ] && [ "${#NX_NEED[@]}" -eq 0 ]; then
    ok "Health monitoring already running on all $NS"; A_NODE_HEALTH=yes
  else
    partial NX_NEED REACHED
    ask_yn A_NODE_HEALTH yes "$Q_NODE_HEALTH" "$W_NODE_HEALTH"
  fi
  if [ "${#RAPL_ANY[@]}" -eq 0 ]; then A_POWER=no
  elif [ -z "$A_POWER" ] && [ "${#RAPL_NEED[@]}" -eq 0 ]; then
    ok "Power counters already readable on $([ "${#RAPL_ANY[@]}" -eq "$N" ] && echo "all $NS" || join_list "${RAPL_ANY[@]}")"; A_POWER=yes
  else
    partial RAPL_NEED RAPL_ANY
    ask_yn A_POWER yes "$Q_POWER" "$W_POWER"
  fi
  if [ "${#GPU_ANY[@]}" -eq 0 ]; then A_GPU=no
  elif [ -z "$A_GPU" ] && [ "${#GPU_NEED[@]}" -eq 0 ]; then
    ok "GPU monitoring already running on $([ "${#GPU_ANY[@]}" -eq "$N" ] && echo "all $NS" || join_list "${GPU_ANY[@]}")"; A_GPU=yes
  else
    [ "$AMD_ANY" -eq 1 ] && note "AMD GPUs are read by node_exporter, so on those nodes this also needs node health monitoring."
    partial GPU_NEED GPU_ANY
    ask_yn A_GPU yes "$Q_GPU" "$W_GPU"
  fi
  # Offered on nodes with built-in Intel or AMD graphics, but the default is no, even with -y.
  if [ "${#IGPU_ANY[@]}" -eq 0 ]; then A_IGPU=no
  elif [ -z "$A_IGPU" ] && [ "${#IGPU_NEED[@]}" -eq 0 ]; then
    ok "Built-in graphics already open to containers on $(join_list "${IGPU_ANY[@]}")"; A_IGPU=yes
  else
    [ "${#IGPU_NEED[@]}" -gt 0 ] && note "Applies to $(join_list "${IGPU_NEED[@]}")."
    ask_yn A_IGPU no "$Q_IGPU" "$W_IGPU"
  fi
  ask_yn A_CHARTS yes "$Q_CHARTS" "$W_CHARTS"
  if [ "$A_CHARTS" = yes ]; then ask_yn A_PVE_METRICS yes "$Q_PVE_METRICS" "$W_PVE_METRICS"; else A_PVE_METRICS=no; fi
  GD_KEY=""; GD_SECRET=""
  ask_yn A_DNS no "$Q_DNS" "$W_DNS"
  if [ "$A_DNS" = yes ] && [ "$ASSUME_YES" -ne 1 ] && [ "$NO_TERMINAL" -ne 1 ]; then
    note "Production key from developer.godaddy.com/keys (test keys do not work). Typing is hidden."
    ask_secret GD_KEY "API key"
    ask_secret GD_SECRET "API secret"
    if [ -z "$GD_KEY" ] || [ -z "$GD_SECRET" ]; then A_DNS=no; note "No key given; add one later under Settings → Setup checklist."; fi
    # Checked before it is held, as the setup wizard does. The key goes to curl on stdin, never on a command line.
    if [ "$A_DNS" = yes ]; then
      if printf 'Authorization: sso-key %s:%s\n' "$GD_KEY" "$GD_SECRET" \
          | curl -fsS -o /dev/null --max-time 15 -H @- 'https://api.godaddy.com/v1/domains?limit=1' 2>/dev/null; then
        ok "GoDaddy accepted the key"
      else
        A_DNS=no; GD_KEY=""; GD_SECRET=""
        warn "GoDaddy did not accept that key (it must be a Production key). Add one later under Settings → Setup checklist."
      fi
    fi
  elif [ "$A_DNS" = yes ]; then
    A_DNS=no; note "A GoDaddy key cannot be typed without a terminal; add one later under Settings → Setup checklist."
  fi
  ask_yn A_AI no "$Q_AI" "$W_AI"

  # The node work these answers mean, one node at a time: "node<TAB>step".
  PLAN=()
  for node in "${REACHED[@]}"; do
    [ "$A_NODE_HEALTH" = yes ] && [ "${HW_NX[$node]}" != running ] && PLAN+=("$node"$'\t'node-exporter)
    [ "$A_POWER" = yes ] && [ "${HW_RAPL[$node]}" = root-only ] && PLAN+=("$node"$'\t'rapl)
    if [ "$A_GPU" = yes ]; then
      grep -q $'^intel\t' <<< "${HW_GPUS[$node]}" && [ "${HW_INTEL_X[$node]}" != running ] && PLAN+=("$node"$'\t'intel-gpu-exporter)
      grep -q $'^nvidia\t' <<< "${HW_GPUS[$node]}" && [ "${HW_NV_X[$node]}" != running ] && PLAN+=("$node"$'\t'nvidia-gpu-exporter)
      grep -q $'^amd\t' <<< "${HW_GPUS[$node]}" && [ "${HW_AMD_X[$node]}" != on ] && PLAN+=("$node"$'\t'amd-gpu-metrics)
    fi
    [ "$A_IGPU" = yes ] && [ "${HW_IGPU[$node]}" = closed ] && PLAN+=("$node"$'\t'igpu-access)
  done

  # -------------------------------------------------------------------------
  #  4. One summary of everything, then one question. Nothing exists yet.
  # -------------------------------------------------------------------------
  NETCONF="name=eth0,bridge=${BRIDGE},ip=${NET}"
  [ -n "$GATEWAY" ] && NETCONF="${NETCONF},gw=${GATEWAY}"
  [ -n "$PASSWORD" ] || PASSWORD="$(openssl rand -base64 18 2>/dev/null | tr -d '/+=' | head -c 20 || true)"
  [ -n "$PASSWORD" ] || die "Could not generate a root password; pass --password."
  EXPORTER_TOKEN="hyperprox-exporter"
  token_exists hyperprox && TOKEN_EXISTED=1
  token_exists "$EXPORTER_TOKEN" && XTOKEN_EXISTED=1

  echo
  echo "  Ready to create:"
  echo "    Container  $CTID ($HOSTNAME): privileged, with nesting, keyctl and tun; starts on boot"
  echo "    Resources  ${CORES} cores · ${MEMORY} MB · ${DISK} GB on ${STORAGE}"
  if [ "$NET" = dhcp ]; then echo "    Network    DHCP on ${BRIDGE}"
  else echo "    Network    ${NET}, gateway ${GATEWAY}, on ${BRIDGE}"; fi
  echo "    Template   ${TEMPLATE} (${ARCH}) on ${TEMPLATE_STORAGE}$([ "$NEED_DOWNLOAD" -eq 1 ] && echo ', downloaded first' || echo ', already there')"
  if [ "$TOKEN_EXISTED" -eq 1 ]; then echo "    Token      root@pam!hyperprox exists already and is left alone; the setup page will ask for one"
  else echo "    Token      root@pam!hyperprox (Administrator on /)"; fi
  if [ "$A_PVE_METRICS" = yes ]; then
    if [ "$XTOKEN_EXISTED" -eq 1 ]; then echo "               root@pam!${EXPORTER_TOKEN} exists already and is left alone"
    else echo "               root@pam!${EXPORTER_TOKEN} (read-only: PVEAuditor on /)"; fi
  fi
  if [ "${#PLAN[@]}" -gt 0 ]; then
    echo "  Then, on your nodes, one at a time:"
    for p in "${PLAN[@]}"; do printf '    • %s: %s\n' "${p%%$'\t'*}" "$(step_label "${p#*$'\t'}")"; done
  else
    echo "  Nothing to change on your nodes."
  fi
  echo "  In HyperProx: charts ${A_CHARTS} · Proxmox metrics ${A_PVE_METRICS} · GoDaddy ${A_DNS} · local AI ${A_AI}"
  [ "${#IGPU_ANY[@]}" -gt 0 ] && echo "  Built-in graphics for containers: ${A_IGPU}"
  echo
  if [ "$DRY_RUN" -eq 1 ]; then
    FINISHED=1
    ok "Dry run: nothing was changed."
    exit 0
  fi
  if [ "$ASSUME_YES" -ne 1 ]; then
    [ "$INTERACTIVE" -eq 1 ] || die "No terminal to confirm on. Re-run with -y (or HYPERPROX_YES=1) to accept the plan above."
    printf "  Create it? [Y/n] "
    if ! IFS= read -r reply <&3 && [ -z "$reply" ]; then echo; die "No answer. Cancelled. Nothing was created."; fi
    [ -t 1 ] || echo
    case "$reply" in [nN]*) die "Cancelled. Nothing was created.";; esac
  fi

  # -------------------------------------------------------------------------
  #  5. The template, then the container
  #
  #  Privileged with nesting and keyctl is not a preference — Docker's overlay
  #  driver fails without it, which is the first wall people hit. tun is included
  #  so Tailscale works later without a second reboot.
  # -------------------------------------------------------------------------
  if [ "$NEED_DOWNLOAD" -eq 1 ]; then
    # The listing can fail quietly; the storage's own path is the last word on whether the file is there.
    TEMPLATE_PATH="$(template_path)"
    [ -n "$TEMPLATE_PATH" ] || die "Cannot find where ${TEMPLATE_STORAGE} keeps templates (pvesm path failed)."
    [ -e "$TEMPLATE_PATH" ] && NEED_DOWNLOAD=0 && ok "Template $TEMPLATE is on $TEMPLATE_STORAGE already"
  fi
  if [ "$NEED_DOWNLOAD" -eq 1 ]; then
    note "Downloading $TEMPLATE — this is the slow part, usually a minute or two."
    TPL_TRY=1
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null || die "Template download failed."
    ok "Downloaded $TEMPLATE"
  fi
  TEMPLATE_PATH="$(template_path)"
  [ -n "$TEMPLATE_PATH" ] && [ -r "$TEMPLATE_PATH" ] && [ -s "$TEMPLATE_PATH" ] \
    || die "The template ${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE} cannot be read (${TEMPLATE_PATH:-no path})."

  say "Creating the container"
  # Checked again at the last moment: the ID may have been taken while the questions were open.
  if f="$(guest_conf "$CTID")"; then die "ID $CTID was taken meanwhile ($f). Re-run to pick another."; fi
  if [ "$NET" != dhcp ]; then
    addr_in_configs "${NET%%/*}" && die "${NET%%/*} was taken meanwhile by another guest's config. Re-run to pick another."
    addr_answers "${NET%%/*}" && die "Something answers on ${NET%%/*} now. Re-run to pick another address."
  fi
  CT_TRY=1
  if ! create_out="$(pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
    --arch "$ARCH" --ostype debian \
    --description "$RUN_MARK" \
    --hostname "$HOSTNAME" \
    --cores "$CORES" --memory "$MEMORY" --swap 512 \
    --rootfs "${STORAGE}:${DISK}" \
    --net0 "$NETCONF" \
    --unprivileged 0 \
    --features "keyctl=1,nesting=1" \
    --onboot 1 --start 0 2>&1)"; then
    # Someone else's container with this ID: not ours to remove.
    grep -q 'already exists' <<< "$create_out" && CT_TRY=0
    printf '%s\n' "$create_out" | sed 's/^/    /' >&2
    die "Container creation failed."
  fi

  # tun needs a device rule; --features tun=1 is not accepted on every PVE version, so set it the way
  # that works everywhere. The container was made a moment ago and has no pending changes to append into.
  CONF="$PVE_ETC/lxc/${CTID}.conf"
  grep -q 'c 10:200 rwm' "$CONF" 2>/dev/null || {
    printf 'lxc.cgroup2.devices.allow: c 10:200 rwm\nlxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file\n' >> "$CONF"
  }
  ok "Container $CTID created"

  pct start "$CTID" >/dev/null || die "Container failed to start."
  # The root password goes in on stdin, so it is on no command line (and in no process list).
  printf 'root:%s\n' "$PASSWORD" | pct exec "$CTID" -- chpasswd \
    || warn "Could not set the root password; set it with: pct exec $CTID -- passwd"
  say "Waiting for the container's network"
  for _ in $(seq 1 60); do
    if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
    sleep 2
  done
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 \
    || die "The container has no working DNS. Check the bridge and gateway, then re-run."
  CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
  ok "Container is up at ${CT_IP:-unknown}"

  # -------------------------------------------------------------------------
  #  6. Proxmox API token
  # -------------------------------------------------------------------------
  say "Creating the Proxmox API token"
  TOKEN_SECRET=""
  if [ "$TOKEN_EXISTED" -eq 1 ] || token_exists hyperprox; then
    # Someone else's token: neither its secret nor its permissions are ours to change.
    warn "A token named 'hyperprox' already exists; its secret is only shown once, so it is left alone."
    note "The setup page will ask for a token. Or delete it (pveum user token remove root@pam hyperprox) and re-run."
  else
    TOKEN_SECRET="$(pveum user token add root@pam hyperprox --privsep=0 --output-format json 2>/dev/null \
      | sed -n 's/.*"value"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')" || TOKEN_SECRET=""
    # Ours only once it has handed back its secret: a token that failed to be made, or was made by someone
    # else meanwhile ("already exists"), is never removed by the undo.
    [ -n "$TOKEN_SECRET" ] || die "Could not create the token root@pam!hyperprox (check: pveum user token list root@pam)."
    TOKEN_TRY=1
    ok "Token root@pam!hyperprox created"
    pveum acl modify / --token 'root@pam!hyperprox' --role Administrator >/dev/null 2>&1 \
      && ok "Granted Administrator on /" || warn "Could not set the ACL; grant it by hand."
  fi

  # The PVE exporter (Grafana's Proxmox panels) gets a token of its own that can only read: privilege
  # separation on, PVEAuditor on / and nothing else. Named and marked the way HyperProx's own provisioning
  # does it (apps/setup/pve-exporter.js), so `hyperprox pve-exporter` can later repair it.
  EXPORTER_SECRET=""
  if [ "$A_PVE_METRICS" != yes ]; then
    ok "Proxmox metrics: skipped (you said no)"
  elif [ "$XTOKEN_EXISTED" -eq 1 ] || token_exists "$EXPORTER_TOKEN"; then
    warn "A token named '${EXPORTER_TOKEN}' already exists; its secret is only shown once."
    note "After signing in to HyperProx, run in the container: hyperprox pve-exporter"
  else
    EXPORTER_SECRET="$(pveum user token add root@pam "${EXPORTER_TOKEN}" --privsep 1 \
      --comment 'HyperProx metrics exporter, read-only (PVEAuditor) [exporter for root@pam!hyperprox]' --output-format json 2>/dev/null \
      | sed -n 's/.*"value"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true)"
    [ -n "$EXPORTER_SECRET" ] && XTOKEN_TRY=1
    if [ -n "$EXPORTER_SECRET" ] && pveum acl modify / --token "root@pam!${EXPORTER_TOKEN}" --role PVEAuditor >/dev/null 2>&1; then
      ok "Token root@pam!${EXPORTER_TOKEN} created (read-only: PVEAuditor on /)"
    else
      warn "Could not make the exporter's read-only token; after setup, run in the container: hyperprox pve-exporter"
      EXPORTER_SECRET=""
    fi
  fi

  # -------------------------------------------------------------------------
  #  7. Your answers, carried out on the nodes — one node at a time
  #
  #  Each step reports done, already, skipped or failed with a plain reason, and
  #  is then checked from here: the exporter answers over the network (which is
  #  what Prometheus needs), and power reads more than zero.
  # -------------------------------------------------------------------------
  if [ "${#PLAN[@]}" -gt 0 ]; then say "Setting up your nodes"; fi
  for p in "${PLAN[@]}"; do
    node="${p%%$'\t'*}"; step="${p#*$'\t'}"; label="$(step_label "$step")"
    out="$(step_text "$step" | node_run "$node" 2>&1)" || true
    res="$(grep '^HPX-RESULT' <<< "$out" | tail -1)"
    if [ -z "$res" ]; then check failed "$label" "$node" "could not run the step there"; warn "$node — $label: could not run the step there"; continue; fi
    st="$(cut -f2 <<< "$res")"; why="$(cut -f3- <<< "$res")"
    if [ "$st" = done ]; then
      if [ -f "$NODE_DIR/$step-undo.sh" ]; then NODE_UNDO+=("$node"$'\t'"$step-undo"); else NODE_LEFT+=("$node"$'\t'"$step"); fi
    fi
    check "$st" "$label" "$node" "$why"
    case "$st" in done|already) ok "$node — $label: $why";; skipped) note "$node — $label: $why";; *) warn "$node — $label: $why";; esac
  done

  # Check the outcome, not the scripts' word.
  if [ "$A_NODE_HEALTH" = yes ] || [ "$A_POWER" = yes ] || [ "$A_GPU" = yes ]; then
    say "Checking from here"
    for node in "${NODES[@]}"; do
      [ "${HW_OK[$node]}" -eq 1 ] || { check failed "Node checks" "$node" "could not be reached"; continue; }
      ip="$(node_ip "$node")"; ip="${ip:-$node}"
      if [ "$A_NODE_HEALTH" = yes ]; then
        if metrics_has "$ip" 9100 '^node_exporter_build_info'; then check ok "Health answers" "$node" "port 9100 answers from here"
        else check failed "Health answers" "$node" "port 9100 does not answer from here (a firewall?)"; fi
      fi
      if [ "$A_POWER" = yes ] && [ "${HW_RAPL[$node]}" != none ]; then
        j1="$(rapl_joules "$ip")"; sleep 2; j2="$(rapl_joules "$ip")"
        if awk -v a="$j1" -v b="$j2" 'BEGIN{exit !(b > a)}'; then
          check ok "Power reading" "$node" "$(awk -v a="$j1" -v b="$j2" 'BEGIN{printf "%.1f W", (b-a)/2}')"
        else check failed "Power reading" "$node" "node_exporter shows no energy use (is health monitoring on?)"; fi
      fi
      if [ "$A_GPU" = yes ]; then
        if grep -q $'^intel\t' <<< "${HW_GPUS[$node]}"; then
          metrics_has "$ip" 8081 '^igpu_' && check ok "Intel GPU answers" "$node" "port 8081 answers from here" \
            || check failed "Intel GPU answers" "$node" "port 8081 does not answer from here"
        fi
        if grep -q $'^amd\t' <<< "${HW_GPUS[$node]}"; then
          metrics_has "$ip" 9100 '^node_drm_gpu_busy_percent' && check ok "AMD GPU answers" "$node" "node_exporter reports it from here" \
            || check failed "AMD GPU answers" "$node" "node_exporter reports no AMD GPU figures"
        fi
        if grep -q $'^nvidia\t' <<< "${HW_GPUS[$node]}"; then
          metrics_has "$ip" 9835 '^nvidia_smi_memory_total_bytes' && check ok "NVIDIA GPU answers" "$node" "port 9835 answers from here" \
            || check failed "NVIDIA GPU answers" "$node" "port 9835 does not answer from here"
        fi
      fi
    done
  fi

  # -------------------------------------------------------------------------
  #  8. Install HyperProx inside the container
  # -------------------------------------------------------------------------
  say "Installing HyperProx (this takes a few minutes)"
  pct exec "$CTID" -- bash -c "DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null 2>&1" \
    || die "Could not install curl inside the container."
  pct exec "$CTID" -- bash -c "curl -fsSL '$RAW_BASE/install.sh' -o /tmp/install.sh && yes | HYPERPROX_REF='$REF' HYPERPROX_REPO_URL='$REPO_URL_ARG' bash /tmp/install.sh" \
    || die "The HyperProx installer failed inside the container. To keep the container and look inside, re-run with --keep-on-failure."

  # -------------------------------------------------------------------------
  #  9. Hand the container everything it would otherwise ask you for
  # -------------------------------------------------------------------------
  if [ -n "$TOKEN_SECRET" ]; then
    say "Configuring the Proxmox connection"
    # This node's address in the cluster: `hostname -I` lists every address, and the first is not always it.
    HOST_IP="$(node_ip "$THIS_NODE")"
    [ -n "$HOST_IP" ] || HOST_IP="$(hostname -I | awk '{print $1}')"
    pct exec "$CTID" -- bash -c "
      f=/opt/hyperprox/.env
      set_kv() { grep -q \"^\$1=\" \"\$f\" 2>/dev/null && sed -i \"s|^\$1=.*|\$1=\$2|\" \"\$f\" || echo \"\$1=\$2\" >> \"\$f\"; }
      set_kv PROXMOX_HOST '$HOST_IP'
      set_kv PROXMOX_PORT '8006'
      set_kv PROXMOX_USER 'root@pam'
      set_kv PROXMOX_TOKEN_ID 'hyperprox'
      set_kv PROXMOX_TOKEN_SECRET '$TOKEN_SECRET'
      systemctl restart hyperprox-api 2>/dev/null || true
    " && ok "Proxmox connection configured — the setup wizard will not ask again"
  fi

  if [ -n "$EXPORTER_SECRET" ]; then
    # pve.yml as apps/setup/pve-exporter.js writes it: 0600 and owned by the exporter's user (uid 101).
    _pveyml="$(mktemp)"; TMP_PATHS+=("$_pveyml"); chmod 600 "$_pveyml"
    cat > "$_pveyml" <<PVEYML
# prometheus-pve-exporter: the read-only Proxmox API token it signs in with (PVEAuditor on /).
# Written by bootstrap.sh. To make a new one: hyperprox pve-exporter.
default:
  user: "root@pam"
  token_name: "${EXPORTER_TOKEN}"
  token_value: "${EXPORTER_SECRET}"
  verify_ssl: false
PVEYML
    if pct push "$CTID" "$_pveyml" /opt/hyperprox/config/pve-exporter/pve.yml --perms 0600 --user 101 --group 101; then
      pct exec "$CTID" -- docker restart hyperprox-pve-exporter >/dev/null 2>&1 || true
      ok "PVE exporter configured with its read-only token"
    else
      warn "Could not write the exporter's pve.yml; after setup, run in the container: hyperprox pve-exporter"
    fi
    rm -f "$_pveyml"
  fi

  # -------------------------------------------------------------------------
  #  9b. Your other answers, handed to HyperProx
  #
  #  The choices go into the container as plain settings, plus what was found and
  #  done (no secrets) so the setup page can show it. A GoDaddy key is a secret:
  #  it is never written to a file. It goes to the setup wizard's memory over
  #  stdin, and from there into the vault once you create the owner account.
  # -------------------------------------------------------------------------
  say "Handing your answers to HyperProx"
  _inst_prom=false; [ "$A_CHARTS" = yes ] && _inst_prom=true
  pct exec "$CTID" -- bash -c "
    f=/opt/hyperprox/.env
    set_kv() { grep -q \"^\$1=\" \"\$f\" 2>/dev/null && sed -i \"s|^\$1=.*|\$1=\$2|\" \"\$f\" || echo \"\$1=\$2\" >> \"\$f\"; }
    set_kv INSTALL_PROMETHEUS '$_inst_prom'
    set_kv INSTALL_GRAFANA '$_inst_prom'
    set_kv INSTALL_OLLAMA '$([ "$A_AI" = yes ] && echo true || echo false)'
  " && ok "Charts: ${A_CHARTS} · local AI: ${A_AI}"

  # The cluster's own record of every node's SSH host key, and this node's own key files, read HERE, as root on a
  # node: public keys only. HyperProx takes it as the anchor for verifying its nodes' keys by itself, so nobody has to
  # compare fingerprints (lib/hostkey-verify.ts; the same output as the command it shows for installs made elsewhere).
  _hostrec="$( { echo "@@hpx local $(basename "$(readlink -f /etc/pve/local)")"; for f in /etc/pve/nodes/*/ssh_known_hosts; do [ -f "$f" ] && echo "@@hpx node $(basename "$(dirname "$f")")" && cat -- "$f"; done; echo "@@hpx priv"; cat /etc/pve/priv/known_hosts 2>/dev/null; echo "@@hpx own"; cat /etc/ssh/ssh_host_*_key.pub; echo "@@hpx end"; } 2>/dev/null | base64 -w0 || true)"

  _answers="$(mktemp)"; TMP_PATHS+=("$_answers"); chmod 600 "$_answers"
  {
    printf '{"source":"bootstrap","hostRecord":"%s","answers":{' "$_hostrec"
    printf '"node-health":%s,"power":%s,"gpu":%s,"charts":%s,"proxmox-metrics":%s,"dns":%s,"ai":%s,"igpu-access":%s},"results":[' \
      "$([ "$A_NODE_HEALTH" = yes ] && echo true || echo false)" "$([ "$A_POWER" = yes ] && echo true || echo false)" \
      "$([ "$A_GPU" = yes ] && echo true || echo false)" "$([ "$A_CHARTS" = yes ] && echo true || echo false)" \
      "$([ "$A_PVE_METRICS" = yes ] && echo true || echo false)" "$([ "$A_DNS" = yes ] && echo true || echo false)" \
      "$([ "$A_AI" = yes ] && echo true || echo false)" "$([ "$A_IGPU" = yes ] && echo true || echo false)"
    _first=1
    for row in "${CHECKLIST[@]}"; do
      IFS=$'\t' read -r _s _l _n _w <<< "$row"
      [ "$_first" -eq 1 ] || printf ','; _first=0
      printf '{"status":"%s","label":"%s","node":"%s","reason":"%s"}' "$_s" "$_l" "$_n" "$(printf '%s' "$_w" | sed 's/\\/\\\\/g; s/"/\\"/g')"
    done
    printf ']}\n'
  } > "$_answers"
  pct exec "$CTID" -- mkdir -p /opt/hyperprox/data/setup
  pct push "$CTID" "$_answers" /opt/hyperprox/data/setup/bootstrap.json --perms 0600 >/dev/null 2>&1 \
    && ok "What was found and done is on the setup page too" || warn "Could not hand the results to the setup page"
  rm -f "$_answers"

  if [ "$A_DNS" = yes ] && [ -n "$GD_KEY" ]; then
    # Sent on stdin, so it is on no command line; the wizard holds it in memory only.
    if printf '{"godaddy":{"key":"%s","secret":"%s"}}' "$GD_KEY" "$GD_SECRET" | pct exec "$CTID" -- bash -c '
        k="$(grep -oP "^SETUP_SECRET=\K.*" /opt/hyperprox/.env)"
        for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3001/health && break; sleep 2; done
        curl -fsS -o /dev/null -X POST -H "Content-Type: application/json" -H "X-Setup-Key: $k" --data-binary @- http://127.0.0.1:3001/api/setup/hold-secrets'; then
      ok "GoDaddy key held in memory until you create the owner account, then kept in the vault"
    else
      warn "Could not hand over the GoDaddy key; add it on the setup page or under Settings → Setup checklist"
    fi
  fi
  GD_KEY=""; GD_SECRET=""
  FINISHED=1

  # -------------------------------------------------------------------------
  #  Done
  # -------------------------------------------------------------------------
  CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
  echo
  printf '%s  HyperProx is ready%s\n' "$C_OK" "$C_OFF"
  echo
  echo "    Open       https://${CT_IP}/   (self-signed certificate: the browser warns once)"
  echo "    Container  $CTID  (pct enter $CTID)"
  [ -n "$PASSWORD" ] && echo "    Root pw    $PASSWORD"
  if [ "${#CHECKLIST[@]}" -gt 0 ]; then
    echo
    echo "    What was done on your nodes:"
    for row in "${CHECKLIST[@]}"; do
      IFS=$'\t' read -r _s _l _n _w <<< "$row"
      case "$_s" in done|already|ok) _m="${C_OK}✓${C_OFF}";; skipped) _m="${C_DIM}–${C_OFF}";; *) _m="${C_ERR}✗${C_OFF}";; esac
      printf '      %s %-22s %-12s %s\n' "$_m" "$_l" "$_n" "$_w"
    done
    note "Anything skipped or failed can be done later: Settings → Setup checklist."
  fi
  echo
  note "First: open the address above and create the owner account. HyperProx has no password of its own;"
  note "it signs in with its built-in vault (email, master password, required 2FA). See docs/security.md."
  note "Then: open Plug-ins and press Scan, and HyperProx will find the services"
  note "already running on your network and offer to configure them."
  echo
}

# GPU monitoring already covers every Intel, NVIDIA and AMD GPU on NODE.
gpu_covered() {
  local g="${HW_GPUS[$1]}"
  ! grep -q $'^intel\t' <<< "$g" || [ "${HW_INTEL_X[$1]}" = running ] || return 1
  ! grep -q $'^nvidia\t' <<< "$g" || [ "${HW_NV_X[$1]}" = running ] || return 1
  ! grep -q $'^amd\t' <<< "$g" || [ "${HW_AMD_X[$1]}" = on ] || return 1
  return 0
}

main "$@"; exit $?
