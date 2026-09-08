#!/usr/bin/env bash
#
# HyperProx — one-command install, run on a Proxmox host.
#
#   curl -fsSL https://raw.githubusercontent.com/hyperprox/alpha/main/bootstrap.sh | bash
#
# Everything the README used to ask you to do by hand, this does: picks a
# container ID and a storage, fetches the right template, creates the container
# with the features Docker needs, mints the API token, installs node_exporter on
# every node so monitoring works, then installs HyperProx and hands you a URL.
#
# It is safe to re-run: anything already correct is left alone.

set -euo pipefail

CTID=""            ; HOSTNAME="hyperprox"
CORES=4            ; MEMORY=8192        ; DISK=100
BRIDGE="vmbr0"     ; NET="dhcp"         ; GATEWAY=""
STORAGE=""         ; TEMPLATE_STORAGE=""
PASSWORD=""        ; ASSUME_YES=0       ; SKIP_EXPORTER=0
SKIP_RAPL=0        ; SKIP_GPU_EXPORTER=0

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
  --skip-exporter     Do not install node_exporter on the nodes
  --skip-rapl         Do not make CPU energy counters readable (see below)
  --skip-gpu-exporter Do not install the Intel GPU exporter on Intel nodes
  -y, --yes           Do not ask for confirmation
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
    --skip-exporter) SKIP_EXPORTER=1; shift;;
    --skip-rapl) SKIP_RAPL=1; shift;;
    --skip-gpu-exporter) SKIP_GPU_EXPORTER=1; shift;;
    -y|--yes) ASSUME_YES=1; shift;;
    -h|--help) usage; exit 0;;
    *) die "Unknown option: $1 (try --help)";;
  esac
done

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
pveam update >/dev/null 2>&1 || warn "Could not refresh the template list; using what is cached."

TEMPLATE="$(pveam available --section system 2>/dev/null \
  | awk '/debian-1[0-9]-standard/ {print $2}' | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || die "No Debian container template is available from Proxmox."

if pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  ok "Template already downloaded: $TEMPLATE"
else
  note "Downloading $TEMPLATE — this is the slow part, usually a minute or two."
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null || die "Template download failed."
  ok "Downloaded $TEMPLATE"
fi

# ---------------------------------------------------------------------------
#  4. Confirm
# ---------------------------------------------------------------------------
NETCONF="name=eth0,bridge=${BRIDGE},ip=${NET}"
[ -n "$GATEWAY" ] && NETCONF="${NETCONF},gw=${GATEWAY}"
[ -n "$PASSWORD" ] || PASSWORD="$(openssl rand -base64 18 2>/dev/null | tr -d '/+=' | head -c 20)"

if [ "$ASSUME_YES" -ne 1 ]; then
  echo
  echo "  About to create container $CTID:"
  echo "    ${CORES} cores · ${MEMORY} MB · ${DISK} GB on ${STORAGE}"
  echo "    network ${NETCONF}"
  echo "    privileged, with nesting, keyctl and tun"
  echo
  printf "  Continue? [y/N] "
  read -r reply < /dev/tty || reply=""
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
CONF="/etc/pve/lxc/${CTID}.conf"
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

# ---------------------------------------------------------------------------
#  7. node_exporter on every node, so Monitoring has data on day one
# ---------------------------------------------------------------------------
if [ "$SKIP_EXPORTER" -eq 0 ]; then
  say "Installing node_exporter across the cluster"
  for node in $(pvesh get /nodes --output-format json 2>/dev/null \
      | sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sort -u); do
    if [ "$node" = "$(hostname)" ]; then
      if systemctl is-active --quiet prometheus-node-exporter 2>/dev/null; then
        ok "$node — already running"
      else
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq prometheus-node-exporter >/dev/null 2>&1 \
          && ok "$node — installed" || warn "$node — install failed, do it by hand"
      fi
    else
      # Other nodes are reached over the cluster's own SSH trust.
      if ssh -o BatchMode=yes -o ConnectTimeout=8 "$node" \
          "systemctl is-active --quiet prometheus-node-exporter || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq prometheus-node-exporter" >/dev/null 2>&1; then
        ok "$node — ready"
      else
        warn "$node — could not reach it; install prometheus-node-exporter there yourself"
      fi
    fi
  done
fi

# ---------------------------------------------------------------------------
#  7b. Power metrics
#
#  node_exporter's rapl collector reads /sys/class/powercap/*/energy_uj. Since
#  kernel 5.10 those files are 0400 root-only — a PLATYPUS mitigation, because
#  energy readings are fine-grained enough to leak AES keys. node_exporter runs
#  unprivileged, so without this it gets EACCES and the collector yields
#  *nothing*: no error, no warning, just a metric that never appears. A cluster
#  power figure then silently covers only the nodes that happened to be readable.
#
#  Relaxing it to 0404 is a deliberate trade: an unprivileged local reader on
#  your own hypervisor can observe energy draw. Pass --skip-rapl to decline, and
#  accept that Monitoring will have no wattage.
# ---------------------------------------------------------------------------
if [ "$SKIP_RAPL" -eq 0 ]; then
  say "Making CPU energy counters readable (pass --skip-rapl to decline)"
  _rapl_rule='# Installed by HyperProx. Lets the unprivileged node_exporter read RAPL.
# Kernel 5.10+ keeps energy_uj at 0400 as a PLATYPUS mitigation; this reverses
# that on this host so power metrics exist. Delete this file to undo it.
#
# The chmod targets the device udev is reporting rather than walking the tree:
# RUN+= fires once per domain as each appears, so a find over /sys/class/powercap
# runs against a directory that is not yet populated and silently does nothing.
SUBSYSTEM=="powercap", ACTION=="add|change", RUN+="/bin/chmod o+r /sys%p/energy_uj"'

  _rapl_cmd='mkdir -p /etc/udev/rules.d && cat > /etc/udev/rules.d/99-hyperprox-rapl.rules <<"RULE"
'"$_rapl_rule"'
RULE
udevadm control --reload-rules 2>/dev/null
udevadm trigger --action=add --subsystem-match=powercap 2>/dev/null
sleep 1
ls /sys/class/powercap/*/energy_uj >/dev/null 2>&1 || exit 3
systemctl restart prometheus-node-exporter 2>/dev/null || systemctl restart node_exporter 2>/dev/null || true'

  for node in $(pvesh get /nodes --output-format json 2>/dev/null \
      | sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sort -u); do
    if [ "$node" = "$(hostname)" ]; then
      if bash -c "$_rapl_cmd" >/dev/null 2>&1; then ok "$node — energy counters readable"
      else warn "$node — no RAPL on this CPU, or the rule did not apply"; fi
    else
      if ssh -o BatchMode=yes -o ConnectTimeout=8 "$node" "$_rapl_cmd" >/dev/null 2>&1; then
        ok "$node — energy counters readable"
      else
        warn "$node — could not apply the RAPL rule; power will be missing for it"
      fi
    fi
  done
fi

# ---------------------------------------------------------------------------
#  7c. Intel GPU exporter
#
#  On Intel nodes this reports iGPU utilisation, and a package power figure that
#  stands in where RAPL cannot be read at all. Skipped on AMD and NVIDIA nodes:
#  intel_gpu_top has nothing to talk to there and the container would crash-loop.
#  HyperProx adds the scrape target itself — Settings → Targets, or
#  POST /api/targets/sync — so nothing needs editing in prometheus.yml.
# ---------------------------------------------------------------------------
if [ "$SKIP_GPU_EXPORTER" -eq 0 ]; then
  say "Installing the Intel GPU exporter where there is an Intel GPU"
  _igpu_cmd='grep -qi 0x8086 /sys/class/drm/card*/device/vendor 2>/dev/null || exit 4
command -v docker >/dev/null 2>&1 || exit 5
docker ps -a --format "{{.Names}}" | grep -qx intel-gpu-exporter && exit 0
docker run -d --name intel-gpu-exporter --restart unless-stopped \
  --privileged --pid host -v /dev/dri:/dev/dri -p 8081:8080 \
  ghcr.io/onedr0p/intel-gpu-exporter:rolling >/dev/null'

  for node in $(pvesh get /nodes --output-format json 2>/dev/null \
      | sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sort -u); do
    if [ "$node" = "$(hostname)" ]; then bash -c "$_igpu_cmd" >/dev/null 2>&1; _rc=$?
    else ssh -o BatchMode=yes -o ConnectTimeout=8 "$node" "$_igpu_cmd" >/dev/null 2>&1; _rc=$?; fi
    case "$_rc" in
      0) ok   "$node — Intel GPU exporter running";;
      4) ok   "$node — no Intel GPU, skipped";;
      5) warn "$node — has an Intel GPU but no Docker; install the exporter yourself";;
      *) warn "$node — could not start the Intel GPU exporter";;
    esac
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

# ---------------------------------------------------------------------------
#  Done
# ---------------------------------------------------------------------------
CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
echo
printf '%s  HyperProx is ready%s\n' "$C_OK" "$C_OFF"
echo
echo "    Open       http://${CT_IP}"
echo "    Container  $CTID  (pct enter $CTID)"
[ -n "$PASSWORD" ] && echo "    Root pw    $PASSWORD"
echo
note "Next: open Plug-ins and press Scan, and HyperProx will find the services"
note "already running on your network and offer to configure them."
echo
