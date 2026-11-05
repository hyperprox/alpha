#!/usr/bin/env bash
#
# HyperProx — one-command install, run on a Proxmox host.
#
#   curl -fsSL https://raw.githubusercontent.com/hyperprox/alpha/main/bootstrap.sh | bash
#
# Everything the README used to ask you to do by hand, this does: picks a
# container ID and a storage, fetches the right template, creates the container
# with the features Docker needs, mints the API token, then installs HyperProx
# and hands you a URL.
#
# First it looks at every node (GPUs, power counters, what is already
# installed), says what it found in a line or two, and asks a few yes/no
# questions — only the ones that apply. Every answer is then carried out here,
# one node at a time, and checked afterwards. -y takes every default.
#
# The node scripts live in packages/hardware/node/ (the same ones the setup
# wizard and the API use). They only ever add packages, never upgrade or remove
# one, and never touch kernels, drivers or apt holds.
#
# It is safe to re-run: anything already correct is left alone.

set -euo pipefail

CTID=""            ; HOSTNAME="hyperprox"
CORES=4            ; MEMORY=8192        ; DISK=100
BRIDGE="vmbr0"     ; NET="dhcp"         ; GATEWAY=""
STORAGE=""         ; TEMPLATE_STORAGE=""
PASSWORD=""        ; ASSUME_YES=0       ; DRY_RUN=0
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

  --vmid N            Container ID           (default: next free)
  --hostname NAME     Container hostname     (default: hyperprox)
  --cores N           CPU cores              (default: 4)
  --memory MB         Memory in MB           (default: 8192)
  --disk GB           Disk in GB             (default: 100)
  --storage NAME      Storage for the rootfs (default: most free space)
  --bridge NAME       Network bridge         (default: vmbr0)
  --ip CIDR           Static address, e.g. 192.168.1.50/24 (default: dhcp)
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
  -y, --yes           Take every default and do not ask
USAGE
}

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
    -y|--yes) ASSUME_YES=1; shift;;
    -h|--help) usage; exit 0;;
    *) die "Unknown option: $1 (try --help)";;
  esac
done

# ---------------------------------------------------------------------------

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

# Where answers come from: the terminal, even under `curl | bash` (whose stdin is this script). Run from a
# file with answers piped in (`printf 'y\nn\n' | bash bootstrap.sh`), they come from stdin.
if [ -n "${HPX_TTY:-}" ]; then ASK_FROM="$HPX_TTY"
elif [ -f "${BASH_SOURCE[0]:-}" ] && [ ! -t 0 ]; then ASK_FROM=/dev/stdin
else ASK_FROM=/dev/tty; fi
# Opened once, as fd 3: stdin may be a socket, which cannot be opened again by name.
NO_TERMINAL=0
if [ "$ASK_FROM" = /dev/stdin ]; then exec 3<&0
elif ! exec 3< "$ASK_FROM"; then NO_TERMINAL=1; fi 2>/dev/null

# ask_yn VAR DEFAULT(yes|no) QUESTION WHAT: sets VAR to yes or no. A value given by a flag wins.
ask_yn() {
  local var="$1" def="$2" q="$3" what="$4" reply hint
  if [ -n "${!var}" ]; then printf '  %s %s\n' "$q" "${!var}"; return; fi
  if [ "$ASSUME_YES" -eq 1 ] || [ "$NO_TERMINAL" -eq 1 ]; then printf -v "$var" '%s' "$def"; printf '  %s %s\n' "$q" "$def"; return; fi
  [ "$def" = yes ] && hint='[Y/n]' || hint='[y/N]'
  printf '\n  %s%s%s\n    %s%s%s\n  %s ' "$C_ACC" "$q" "$C_OFF" "$C_DIM" "$what" "$C_OFF" "$hint"
  if ! IFS= read -r reply <&3; then reply=""; fi
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
#  Node scripts and running them
# ---------------------------------------------------------------------------
RAW_BASE="${HPX_RAW_BASE:-https://raw.githubusercontent.com/hyperprox/alpha/main}"
node_scripts_dir() {
  local here="" d f
  [ -f "${BASH_SOURCE[0]:-}" ] && here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -n "$here" ] && [ -f "$here/packages/hardware/node/probe.sh" ]; then echo "$here/packages/hardware/node"; return; fi
  d="$(mktemp -d)"
  for f in probe common node-exporter rapl intel-gpu-exporter nvidia-gpu-exporter amd-gpu-metrics amd-gpu-metrics-undo igpu-access igpu-access-undo; do
    curl -fsSL "$RAW_BASE/packages/hardware/node/$f.sh" -o "$d/$f.sh" || die "Could not download the node scripts from $RAW_BASE"
  done
  echo "$d"
}

THIS_NODE="$(hostname)"
# node_run NODE: run the script on stdin there. This node directly, the others over the cluster's SSH trust.
node_run() {
  if [ "$1" = "$THIS_NODE" ]; then bash -s
  else ssh -o BatchMode=yes -o ConnectTimeout=8 "$1" 'bash -s'; fi
}

cluster_nodes() {
  pvesh get /nodes --output-format json 2>/dev/null \
    | sed 's/},{/}\n{/g' | sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sort -u
}
# The address each node has in the cluster, for checking its exporters from here.
node_ip() {
  pvesh get /cluster/status --output-format json 2>/dev/null | sed 's/},{/}\n{/g' \
    | grep "\"name\"[[:space:]]*:[[:space:]]*\"$1\"" | sed -n 's/.*"ip"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

declare -A HW_GPUS HW_RAPL HW_NX HW_INTEL_X HW_NV_X HW_OK HW_IGPU HW_AMD_X
CHECKLIST=()
check() { CHECKLIST+=("$1"$'\t'"$2"$'\t'"$3"$'\t'"$4"); }   # status label node reason
# ---------------------------------------------------------------------------
#  1. Are we somewhere this can work?
# ---------------------------------------------------------------------------
say "Checking this host"
command -v pveversion >/dev/null 2>&1 || die "This must run on a Proxmox VE host — pveversion was not found."
[ "$(id -u)" -eq 0 ] || die "This must run as root."
ok "Proxmox $(pveversion | cut -d/ -f2)"

# ---------------------------------------------------------------------------
#  2. Where to put it
# ---------------------------------------------------------------------------
say "Choosing placement"
[ -n "$CTID" ] || CTID="$(pvesh get /cluster/nextid)"
if pct status "$CTID" >/dev/null 2>&1; then
  die "Container $CTID already exists. Pass --vmid to choose another."
fi
ok "Container ID $CTID"

# Rootfs storage: something that can hold a container, with the most space free.
if [ -z "$STORAGE" ]; then
  STORAGE="$(pvesm status -content rootdir 2>/dev/null \
    | awk 'NR>1 && $3=="active" {print $NF, $1}' | sort -rn | head -1 | awk '{print $2}')"
  [ -n "$STORAGE" ] || STORAGE="$(pvesm status -content rootdir 2>/dev/null | awk 'NR==2{print $1}')"
fi
[ -n "$STORAGE" ] || die "No storage on this node can hold a container."
ok "Rootfs storage: $STORAGE"

# Template storage: anything that accepts vztmpl.
TEMPLATE_STORAGE="$(pvesm status -content vztmpl 2>/dev/null | awk 'NR==2{print $1}')"
[ -n "$TEMPLATE_STORAGE" ] || die "No storage on this node accepts container templates."
ok "Template storage: $TEMPLATE_STORAGE"

# ---------------------------------------------------------------------------
#  3. Template — newest Debian, fetched only if absent
# ---------------------------------------------------------------------------
say "Preparing the container template"
[ "$DRY_RUN" -eq 1 ] || pveam update >/dev/null 2>&1 || warn "Could not refresh the template list; using what is cached."

TEMPLATE="$(pveam available --section system 2>/dev/null \
  | awk '/debian-1[0-9]-standard/ {print $2}' | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || die "No Debian container template is available from Proxmox."

if pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  ok "Template already downloaded: $TEMPLATE"
elif [ "$DRY_RUN" -eq 1 ]; then
  ok "Would download $TEMPLATE"
else
  note "Downloading $TEMPLATE — this is the slow part, usually a minute or two."
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null || die "Template download failed."
  ok "Downloaded $TEMPLATE"
fi

# ---------------------------------------------------------------------------
#  3b. What every node has
# ---------------------------------------------------------------------------
say "Looking at your nodes"
NODE_DIR="$(node_scripts_dir)"
NODES=($(cluster_nodes))
[ "${#NODES[@]}" -gt 0 ] || NODES=("$THIS_NODE")
ANY_RAPL=0; ANY_INTEL=0; ANY_NVIDIA=0; ANY_AMD=0; ANY_CEPH=0; IGPU_NODES=""
SUMMARY="Found ${#NODES[@]} node$([ "${#NODES[@]}" -eq 1 ] || echo s)."
for node in "${NODES[@]}"; do
  if ! out="$(node_run "$node" < "$NODE_DIR/probe.sh" 2>/dev/null)" || ! grep -q '^arch' <<< "$out"; then
    HW_OK[$node]=0
    SUMMARY="$SUMMARY $node: could not be reached, so it is left out."
    continue
  fi
  HW_OK[$node]=1
  gpus="$(awk -F'\t' '$1=="gpu"{print $2"\t"$3"\t"$5}' <<< "$out")"
  HW_GPUS[$node]="$gpus"
  HW_RAPL[$node]="$(awk -F'\t' '$1=="rapl"{print $2}' <<< "$out")"
  HW_NX[$node]="$(awk -F'\t' '$1=="node_exporter"{print $2}' <<< "$out")"
  HW_INTEL_X[$node]="$(awk -F'\t' '$1=="intel_exporter"{print $2}' <<< "$out")"
  HW_NV_X[$node]="$(awk -F'\t' '$1=="nvidia_exporter"{print $2}' <<< "$out")"
  HW_AMD_X[$node]="$(awk -F'\t' '$1=="amd_metrics"{print $2}' <<< "$out")"
  HW_IGPU[$node]="$(awk -F'\t' '$1=="igpu_access"{print $2}' <<< "$out")"
  case "${HW_IGPU[$node]}" in open|closed) IGPU_NODES="${IGPU_NODES:+$IGPU_NODES, }$node";; esac
  grep -q $'^ceph\tyes' <<< "$out" && ANY_CEPH=1
  [ "${HW_RAPL[$node]}" != none ] && ANY_RAPL=1
  grep -q $'^intel\t' <<< "$gpus" && ANY_INTEL=1
  grep -q $'^nvidia\t' <<< "$gpus" && ANY_NVIDIA=1
  grep -q $'^amd\t' <<< "$gpus" && ANY_AMD=1
  # The same words as the setup wizard: "node-a: NVIDIA GeForce GTX 1070 Ti (dedicated)."
  words="$(awk -F'\t' 'NF{printf "%s%s (%s)", (n++ ? ", " : ""), $3, ($2=="integrated" ? "built in" : "dedicated")}' <<< "$gpus")"
  [ -n "$words" ] || words="no GPU"
  extra=""
  [ "${HW_RAPL[$node]}" = none ] && extra="${extra}; no power counters"
  [ "${HW_NX[$node]}" = running ] && extra="${extra}; health monitoring already running"
  SUMMARY="$SUMMARY $node: ${words}${extra}."
done
[ "$ANY_CEPH" -eq 1 ] && SUMMARY="$SUMMARY Ceph storage found."
printf '%s\n' "$SUMMARY" | fold -s -w 96 | sed 's/^/    /'

# ---------------------------------------------------------------------------
#  3c. The questions — only those that apply
# ---------------------------------------------------------------------------
say "A few questions"
[ "$NO_TERMINAL" -eq 1 ] && note "No terminal to ask on, so the defaults are shown. Re-run with -y to go ahead with them."
ask_yn A_NODE_HEALTH yes "$Q_NODE_HEALTH" "$W_NODE_HEALTH"
if [ "$ANY_RAPL" -eq 1 ]; then ask_yn A_POWER yes "$Q_POWER" "$W_POWER"; else A_POWER=no; fi
if [ "$ANY_INTEL" -eq 1 ] || [ "$ANY_NVIDIA" -eq 1 ] || [ "$ANY_AMD" -eq 1 ]; then
  [ "$ANY_AMD" -eq 1 ] && note "AMD GPUs are read by node_exporter, so on those nodes this also needs node health monitoring."
  ask_yn A_GPU yes "$Q_GPU" "$W_GPU"
else
  A_GPU=no
fi
# Offered on nodes with built-in Intel or AMD graphics, but the default is no, even with -y.
if [ -n "$IGPU_NODES" ]; then
  note "Applies to ${IGPU_NODES}."
  ask_yn A_IGPU no "$Q_IGPU" "$W_IGPU"
else A_IGPU=no; fi
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
fi
ask_yn A_AI no "$Q_AI" "$W_AI"

# The node work these answers mean, one node at a time: "node<TAB>step".
PLAN=()
for node in "${NODES[@]}"; do
  [ "${HW_OK[$node]}" -eq 1 ] || continue
  [ "$A_NODE_HEALTH" = yes ] && [ "${HW_NX[$node]}" != running ] && PLAN+=("$node"$'\t'node-exporter)
  [ "$A_POWER" = yes ] && [ "${HW_RAPL[$node]}" = root-only ] && PLAN+=("$node"$'\t'rapl)
  if [ "$A_GPU" = yes ]; then
    grep -q $'^intel\t' <<< "${HW_GPUS[$node]}" && [ "${HW_INTEL_X[$node]}" != running ] && PLAN+=("$node"$'\t'intel-gpu-exporter)
    grep -q $'^nvidia\t' <<< "${HW_GPUS[$node]}" && [ "${HW_NV_X[$node]}" != running ] && PLAN+=("$node"$'\t'nvidia-gpu-exporter)
    grep -q $'^amd\t' <<< "${HW_GPUS[$node]}" && [ "${HW_AMD_X[$node]}" != on ] && PLAN+=("$node"$'\t'amd-gpu-metrics)
  fi
  [ "$A_IGPU" = yes ] && [ "${HW_IGPU[$node]}" = closed ] && PLAN+=("$node"$'\t'igpu-access)
done
step_label() {
  case "$1" in
    node-exporter) echo "Health monitoring";; rapl) echo "Power monitoring";;
    intel-gpu-exporter) echo "Intel GPU monitoring";; nvidia-gpu-exporter) echo "NVIDIA GPU monitoring";;
    amd-gpu-metrics) echo "AMD GPU monitoring";;
    igpu-access) echo "Built-in graphics for containers";;
  esac
}

# ---------------------------------------------------------------------------
#  4. Confirm
# ---------------------------------------------------------------------------
NETCONF="name=eth0,bridge=${BRIDGE},ip=${NET}"
[ -n "$GATEWAY" ] && NETCONF="${NETCONF},gw=${GATEWAY}"
[ -n "$PASSWORD" ] || PASSWORD="$(openssl rand -base64 18 2>/dev/null | tr -d '/+=' | head -c 20)"

show_plan() {
  echo
  echo "  About to create container $CTID:"
  echo "    ${CORES} cores · ${MEMORY} MB · ${DISK} GB on ${STORAGE}"
  echo "    network ${NETCONF}"
  echo "    privileged, with nesting, keyctl and tun"
  if [ "${#PLAN[@]}" -gt 0 ]; then
    echo "  Then, on your nodes, one at a time:"
    local p
    for p in "${PLAN[@]}"; do printf '    %s: %s\n' "${p%%$'\t'*}" "$(step_label "${p#*$'\t'}")"; done
  else
    echo "  Nothing to change on your nodes."
  fi
  echo "  In HyperProx: charts ${A_CHARTS} · Proxmox metrics ${A_PVE_METRICS} · GoDaddy ${A_DNS} · local AI ${A_AI}"
  [ -n "$IGPU_NODES" ] && echo "  Built-in graphics for containers: ${A_IGPU}"
  echo
}
show_plan
if [ "$DRY_RUN" -eq 1 ]; then
  ok "Dry run: nothing was changed."
  exit 0
fi
if [ "$ASSUME_YES" -ne 1 ]; then
  [ "$NO_TERMINAL" -eq 1 ] && die "No terminal to confirm on. Re-run with -y to accept the plan above."
  printf "  Continue? [y/N] "
  read -r reply <&3 || reply=""
  case "$reply" in [yY]*) ;; *) die "Cancelled.";; esac
fi

# ---------------------------------------------------------------------------
#  5. Create the container
#
#  Privileged with nesting and keyctl is not a preference — Docker's overlay
#  driver fails without it, which is the first wall people hit. tun is included
#  so Tailscale works later without a second reboot.
# ---------------------------------------------------------------------------
say "Creating the container"
pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname "$HOSTNAME" \
  --cores "$CORES" --memory "$MEMORY" --swap 512 \
  --rootfs "${STORAGE}:${DISK}" \
  --net0 "$NETCONF" \
  --unprivileged 0 \
  --features "keyctl=1,nesting=1" \
  --password "$PASSWORD" \
  --onboot 1 --start 0 >/dev/null || die "Container creation failed."

# tun needs a device rule; --features tun=1 is not accepted on every PVE version,
# so set it the way that works everywhere.
CONF="${HPX_PVE_ETC:-/etc/pve}/lxc/${CTID}.conf"
grep -q 'c 10:200 rwm' "$CONF" 2>/dev/null || {
  printf 'lxc.cgroup2.devices.allow: c 10:200 rwm\nlxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file\n' >> "$CONF"
}
ok "Container $CTID created"

pct start "$CTID" >/dev/null || die "Container failed to start."
say "Waiting for the container's network"
for _ in $(seq 1 60); do
  if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
  sleep 2
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 \
  || die "The container has no working DNS. Check the bridge and gateway, then re-run."
CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
ok "Container is up at ${CT_IP:-unknown}"

# ---------------------------------------------------------------------------
#  6. Proxmox API token
# ---------------------------------------------------------------------------
say "Creating the Proxmox API token"
TOKEN_SECRET=""
if pveum user token list root@pam --output-format json 2>/dev/null | grep -q '"hyperprox"'; then
  warn "A token named 'hyperprox' already exists; its secret is only shown once."
  note "Delete it with: pveum user token remove root@pam hyperprox — then re-run."
else
  TOKEN_SECRET="$(pveum user token add root@pam hyperprox --privsep=0 --output-format json \
    | sed -n 's/.*"value"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  [ -n "$TOKEN_SECRET" ] || die "Token creation returned no secret."
  ok "Token root@pam!hyperprox created"
fi
pveum acl modify / --token 'root@pam!hyperprox' --role Administrator >/dev/null 2>&1 \
  && ok "Granted Administrator on /" || warn "Could not set the ACL; grant it by hand."

# The PVE exporter (Grafana's Proxmox panels) gets a token of its own that can only read: privilege
# separation on, PVEAuditor on / and nothing else. Named and marked the way HyperProx's own provisioning
# does it (apps/setup/pve-exporter.js), so `hyperprox pve-exporter` can later repair it.
EXPORTER_SECRET=""
EXPORTER_TOKEN="hyperprox-exporter"
if [ "$A_PVE_METRICS" != yes ]; then
  ok "Proxmox metrics: skipped (you said no)"
elif pveum user token list root@pam --output-format json 2>/dev/null | grep -q "\"${EXPORTER_TOKEN}\""; then
  warn "A token named '${EXPORTER_TOKEN}' already exists; its secret is only shown once."
  note "After signing in to HyperProx, run in the container: hyperprox pve-exporter"
else
  EXPORTER_SECRET="$(pveum user token add root@pam "${EXPORTER_TOKEN}" --privsep 1 \
    --comment 'HyperProx metrics exporter, read-only (PVEAuditor) [exporter for root@pam!hyperprox]' --output-format json \
    | sed -n 's/.*"value"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true)"
  if [ -n "$EXPORTER_SECRET" ] && pveum acl modify / --token "root@pam!${EXPORTER_TOKEN}" --role PVEAuditor >/dev/null 2>&1; then
    ok "Token root@pam!${EXPORTER_TOKEN} created (read-only: PVEAuditor on /)"
  else
    warn "Could not make the exporter's read-only token; after setup, run in the container: hyperprox pve-exporter"
    EXPORTER_SECRET=""
  fi
fi

# ---------------------------------------------------------------------------
#  7. Your answers, carried out on the nodes — one node at a time
#
#  Each step reports done, already, skipped or failed with a plain reason, and
#  is then checked from here: the exporter answers over the network (which is
#  what Prometheus needs), and power reads more than zero.
# ---------------------------------------------------------------------------
metrics_from() { curl -fsS --max-time 5 "http://$1:$2/metrics" 2>/dev/null; }
rapl_joules() { metrics_from "$1" 9100 | awk '/^node_rapl_package_joules_total/ {s += $2} END {printf "%.3f", s + 0}'; }

if [ "${#PLAN[@]}" -gt 0 ]; then say "Setting up your nodes"; fi
for p in "${PLAN[@]}"; do
  node="${p%%$'\t'*}"; step="${p#*$'\t'}"; label="$(step_label "$step")"
  out="$(cat "$NODE_DIR/common.sh" "$NODE_DIR/$step.sh" | node_run "$node" 2>&1)" || true
  res="$(grep '^HPX-RESULT' <<< "$out" | tail -1)"
  if [ -z "$res" ]; then check failed "$label" "$node" "could not run the step there"; warn "$node — $label: could not run the step there"; continue; fi
  st="$(cut -f2 <<< "$res")"; why="$(cut -f3- <<< "$res")"
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
      if metrics_from "$ip" 9100 | grep -q '^node_exporter_build_info'; then check ok "Health answers" "$node" "port 9100 answers from here"
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
        metrics_from "$ip" 8081 | grep -q '^igpu_' && check ok "Intel GPU answers" "$node" "port 8081 answers from here" \
          || check failed "Intel GPU answers" "$node" "port 8081 does not answer from here"
      fi
      if grep -q $'^amd\t' <<< "${HW_GPUS[$node]}"; then
        metrics_from "$ip" 9100 | grep -q '^node_drm_gpu_busy_percent' && check ok "AMD GPU answers" "$node" "node_exporter reports it from here" \
          || check failed "AMD GPU answers" "$node" "node_exporter reports no AMD GPU figures"
      fi
      if grep -q $'^nvidia\t' <<< "${HW_GPUS[$node]}"; then
        metrics_from "$ip" 9835 | grep -q '^nvidia_smi_memory_total_bytes' && check ok "NVIDIA GPU answers" "$node" "port 9835 answers from here" \
          || check failed "NVIDIA GPU answers" "$node" "port 9835 does not answer from here"
      fi
    fi
  done
fi

# ---------------------------------------------------------------------------
#  8. Install HyperProx inside the container
# ---------------------------------------------------------------------------
say "Installing HyperProx (this takes a few minutes)"
pct exec "$CTID" -- bash -c "DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null 2>&1"
pct exec "$CTID" -- bash -c "curl -fsSL https://raw.githubusercontent.com/hyperprox/alpha/main/install.sh -o /tmp/install.sh && yes | bash /tmp/install.sh" \
  || die "The HyperProx installer failed inside the container. Enter it with: pct enter $CTID"

# ---------------------------------------------------------------------------
#  9. Hand the container everything it would otherwise ask you for
# ---------------------------------------------------------------------------
if [ -n "$TOKEN_SECRET" ]; then
  say "Configuring the Proxmox connection"
  HOST_IP="$(hostname -I | awk '{print $1}')"
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
  _pveyml="$(mktemp)"; chmod 600 "$_pveyml"
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


# ---------------------------------------------------------------------------
#  9b. Your other answers, handed to HyperProx
#
#  The choices go into the container as plain settings, plus what was found and
#  done (no secrets) so the setup page can show it. A GoDaddy key is a secret:
#  it is never written to a file. It goes to the setup wizard's memory over
#  stdin, and from there into the vault once you create the owner account.
# ---------------------------------------------------------------------------
say "Handing your answers to HyperProx"
_inst_prom=false; [ "$A_CHARTS" = yes ] && _inst_prom=true
pct exec "$CTID" -- bash -c "
  f=/opt/hyperprox/.env
  set_kv() { grep -q \"^\$1=\" \"\$f\" 2>/dev/null && sed -i \"s|^\$1=.*|\$1=\$2|\" \"\$f\" || echo \"\$1=\$2\" >> \"\$f\"; }
  set_kv INSTALL_PROMETHEUS '$_inst_prom'
  set_kv INSTALL_GRAFANA '$_inst_prom'
  set_kv INSTALL_OLLAMA '$([ "$A_AI" = yes ] && echo true || echo false)'
" && ok "Charts: ${A_CHARTS} · local AI: ${A_AI}"

_answers="$(mktemp)"; chmod 600 "$_answers"
{
  printf '{"source":"bootstrap","answers":{"node-health":%s,"power":%s,"gpu":%s,"charts":%s,"proxmox-metrics":%s,"dns":%s,"ai":%s,"igpu-access":%s},"results":[' \
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

# ---------------------------------------------------------------------------
#  Done
# ---------------------------------------------------------------------------
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
