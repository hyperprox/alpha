#!/usr/bin/env bash
# =============================================================================
#  HyperProx — One-Shot Installer
#  Supports: Debian 12, Debian 13, Ubuntu 22.04, Ubuntu 24.04
#  Targets:  Proxmox LXC (privileged), bare metal, VM
#  Usage:    curl -fsSL https://raw.githubusercontent.com/hyperprox/alpha/main/install.sh | bash
#            — or —
#            bash install.sh [--no-build] [--dev]
# =============================================================================

set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# ── Flags ────────────────────────────────────────────────────────────────────
SKIP_BUILD=false
DEV_MODE=false
for arg in "$@"; do
  case $arg in
    --no-build) SKIP_BUILD=true ;;
    --dev)      DEV_MODE=true ;;
  esac
done

# ── Constants ─────────────────────────────────────────────────────────────────
HYPERPROX_DIR="/opt/hyperprox"
REPO_URL="https://github.com/hyperprox/alpha.git"
NODE_VERSION="20"
PNPM_VERSION="9"
SETUP_PORT="3001"
API_PORT="3002"
FRONTEND_PORT="3000"
LOG_FILE="/var/log/hyperprox-install.log"

# Initialise log file — try /var/log, fall back to home dir
mkdir -p /var/log 2>/dev/null || true
if ! touch "${LOG_FILE}" 2>/dev/null; then
  LOG_FILE="${HOME}/hyperprox-install.log"
  touch "${LOG_FILE}" 2>/dev/null || LOG_FILE="/dev/null"
fi
echo "HyperProx install log — $(date -u)" > "${LOG_FILE}"

# ── Colors ───────────────────────────────────────────────────────────────────
C_RESET="\033[0m"
C_BOLD="\033[1m"
C_DIM="\033[2m"
C_CYAN="\033[36m"
C_GREEN="\033[32m"
C_YELLOW="\033[33m"
C_RED="\033[31m"

# ── Helpers ───────────────────────────────────────────────────────────────────
banner() {
  echo ""
  echo -e "${C_CYAN}${C_BOLD}"
  echo "  ██╗  ██╗██╗   ██╗██████╗ ███████╗██████╗ ██████╗ ██████╗  ██████╗ ██╗  ██╗"
  echo "  ██║  ██║╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔══██╗██╔═══██╗╚██╗██╔╝"
  echo "  ███████║ ╚████╔╝ ██████╔╝█████╗  ██████╔╝██████╔╝██████╔╝██║   ██║ ╚███╔╝ "
  echo "  ██╔══██║  ╚██╔╝  ██╔═══╝ ██╔══╝  ██╔══██╗██╔═══╝ ██╔══██╗██║   ██║ ██╔██╗ "
  echo "  ██║  ██║   ██║   ██║     ███████╗██║  ██║██║     ██║  ██║╚██████╔╝██╔╝ ██╗"
  echo "  ╚═╝  ╚═╝   ╚═╝   ╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝"
  echo -e "${C_RESET}"
  echo -e "${C_DIM}  Your Proxmox infrastructure, hypercharged.${C_RESET}"
  echo ""
}

step()    { echo -e "\n${C_CYAN}${C_BOLD}▶  $1${C_RESET}"; }
ok()      { echo -e "   ${C_GREEN}✓${C_RESET}  $1"; }
warn()    { echo -e "   ${C_YELLOW}⚠${C_RESET}  $1"; }
info()    { echo -e "   ${C_DIM}→  $1${C_RESET}"; }
die()     { echo -e "\n   ${C_RED}✗  ERROR: $1${C_RESET}"; echo -e "   ${C_DIM}Full log: ${LOG_FILE}${C_RESET}\n"; exit 1; }

# ── Root check ────────────────────────────────────────────────────────────────
# After die() exists: before, a non-root run failed with "die: command not found" instead of the message.
[[ $EUID -ne 0 ]] && die "Run as root: sudo bash install.sh"

confirm() {
  # Default to yes when running non-interactively (curl | bash)
  if [[ ! -t 0 ]]; then return 0; fi
  echo -e "   ${C_YELLOW}?${C_RESET}  $1 [Y/n] "
  read -r reply
  [[ "${reply,,}" =~ ^(y|yes|)$ ]]
}

# ── Spinner ───────────────────────────────────────────────────────────────────
# Usage: run_with_spinner "Message" command [args...]
# Runs command in background, shows spinner until it completes.
# On failure, dumps the last 20 lines of LOG_FILE.
run_with_spinner() {
  local msg="$1"; shift
  # An array, not a string sliced by position: a fresh container has no UTF-8 locale, so bash slices
  # bytes and every frame came out as a broken fragment of a braille character - an invisible spinner.
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local i=0 start=${SECONDS}

  "$@" >> "${LOG_FILE}" 2>&1 &
  local pid=$!

  while kill -0 "${pid}" 2>/dev/null; do
    local t=$((SECONDS - start))
    printf "\r   ${C_CYAN}%s${C_RESET}  %s... ${C_DIM}%dm %02ds${C_RESET}   " \
      "${frames[$((i % ${#frames[@]}))]}" "${msg}" $((t / 60)) $((t % 60))
    i=$((i + 1))
    sleep 0.2
  done
  printf "\r\033[K"  # clear the whole spinner line

  if ! wait "${pid}"; then
    echo -e "   ${C_RED}✗${C_RESET}  ${msg} — FAILED"
    echo -e "   ${C_DIM}Last output:${C_RESET}"
    tail -20 "${LOG_FILE}" | sed 's/^/      /'
    die "${msg} failed. See ${LOG_FILE} for full output."
  fi
}

# ── Environment Detection ─────────────────────────────────────────────────────
detect_environment() {
  step "Detecting environment"

  if [[ -f /etc/os-release ]]; then
    source /etc/os-release
    OS_ID="${ID}"
    OS_VERSION="${VERSION_ID}"
    OS_CODENAME="${VERSION_CODENAME:-}"
  else
    die "Cannot determine OS. Requires Debian 12/13 or Ubuntu 22.04/24.04."
  fi

  case "${OS_ID}" in
    debian)
      [[ "${OS_VERSION}" == "13" || "${OS_VERSION}" == "12" || "${OS_VERSION}" == "11" ]] || die "Debian 11, 12 or 13 required. Found: Debian ${OS_VERSION}"
      PKG_CODENAME="${OS_CODENAME}"
      ;;
    ubuntu)
      [[ "${OS_VERSION}" == "22.04" || "${OS_VERSION}" == "24.04" ]] || \
        die "Ubuntu 22.04 or 24.04 required. Found: Ubuntu ${OS_VERSION}"
      PKG_CODENAME="${OS_CODENAME}"
      ;;
    *)
      die "Unsupported OS: ${OS_ID}. Requires Debian 12/13 or Ubuntu 22.04/24.04."
      ;;
  esac
  ok "OS: ${OS_ID^} ${OS_VERSION}"

  # Virtualisation / container type
  VIRT_TYPE="bare-metal"
  ENV_NOTE=""

  if command -v systemd-detect-virt &>/dev/null; then
    VIRT_RAW="$(systemd-detect-virt 2>/dev/null || true)"
    case "${VIRT_RAW}" in
      lxc)
        VIRT_TYPE="lxc"
        ENV_NOTE="Proxmox LXC — Docker requires privileged container + nesting enabled."
        ;;
      kvm|qemu)
        VIRT_TYPE="vm"
        ENV_NOTE="KVM/QEMU virtual machine"
        ;;
      none)
        VIRT_TYPE="bare-metal"
        ENV_NOTE="Bare metal"
        ;;
      *)
        VIRT_TYPE="${VIRT_RAW}"
        ENV_NOTE="Virtualisation: ${VIRT_RAW}"
        ;;
    esac
  fi

  # Is this machine a Proxmox node itself?
  IS_PROXMOX_NODE=false
  if command -v pveversion &>/dev/null 2>&1; then
    IS_PROXMOX_NODE=true
    PVE_VERSION="$(pveversion | grep -oP 'pve-manager/\K[^/]+')"
    warn "This machine IS a Proxmox node (PVE ${PVE_VERSION}). Installing HyperProx here is supported but unusual."
    warn "Recommended: install HyperProx in a dedicated LXC on this node instead."
    confirm "Continue installing on the Proxmox node itself?" || die "Aborted. Create a dedicated LXC and run the installer there."
  fi

  ok "Environment: ${ENV_NOTE}"

  # LXC-specific preflight
  if [[ "${VIRT_TYPE}" == "lxc" ]]; then
    # Check overlay filesystem — this is the definitive test for Docker compatibility.
    # Overlay requires both privileged container AND nesting=1 in Proxmox.
    if grep -q overlay /proc/filesystems 2>/dev/null; then
      ok "LXC container: privileged + nesting ✓"
    else
      warn "overlay filesystem not available — Docker will fail."
      warn "Fix in Proxmox (run on your Proxmox node):"
      warn "  pct set <CTID> --features keyctl=1,nesting=1 && pct reboot <CTID>"
      warn "Also ensure the container is set to Unprivileged: No in Options."
      confirm "Continue anyway?" || die "Aborted. Re-run after fixing LXC configuration."
    fi
  fi
}

# ── Network Configuration ─────────────────────────────────────────────────────
# True when $1 (a resolv.conf) sends lookups to Tailscale's MagicDNS resolver, 100.100.100.100 or its IPv6
# twin. Only nameserver lines count. The old test grepped the whole file for "ts.net", so a container
# resolving through 1.1.1.1 that merely inherited a tailnet search domain from its Proxmox host (or a
# comment naming Tailscale) was "fixed" too. A search domain on its own breaks nothing.
resolv_uses_magicdns() {
  grep -qE '^[[:space:]]*nameserver[[:space:]]+(100\.100\.100\.100|fd7a:115c:a1e0::53)([[:space:]]|$)' "$1" 2>/dev/null
}

configure_network() {
  # Fix broken DNS: Proxmox can hand a container its host's Tailscale resolver, which answers nothing
  # unless Tailscale also runs in the container. Where it does run, MagicDNS works and is left alone.
  if resolv_uses_magicdns /etc/resolv.conf && ! systemctl is-active --quiet tailscaled 2>/dev/null; then
    warn "Detected the Tailscale DNS resolver without Tailscale running here — replacing with public resolvers"
    cat > /etc/resolv.conf <<'EOF'
nameserver 1.1.1.1
nameserver 8.8.8.8
EOF
    ok "DNS fixed"
  fi

  # Only relevant inside an LXC — bare metal / VM manage networking externally
  [[ "${VIRT_TYPE}" != "lxc" ]] && return

  step "Configuring network"

  # Detect current interface, IP, gateway
  local iface gateway current_ip
  iface="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'dev \K\S+' || echo 'eth0')"
  current_ip="$(ip -4 addr show "${iface}" 2>/dev/null | grep -oP '(?<=inet )\S+' | head -1)"
  gateway="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'via \K\S+' || echo '')"

  if [[ -z "${current_ip}" ]]; then
    warn "Could not detect current IP address — skipping network config"
    return
  fi

  ok "Current IP: ${current_ip} via ${gateway} on ${iface}"

  # Check if running DHCP
  local is_dhcp=false
  if grep -qE 'dhcp' /etc/network/interfaces 2>/dev/null; then
    is_dhcp=true
  fi

  if [[ "${is_dhcp}" == "false" ]]; then
    ok "Static IP already configured — skipping"
    return
  fi

  # Only prompt if running interactively — skip when piped (curl | bash)
  if [[ ! -t 0 ]]; then
    warn "Running non-interactively — skipping static IP prompt. Set a static IP manually after install."
    return
  fi

  warn "Interface ${iface} is using DHCP — IP may change on reboot."
  info "Recommended: set a static IP now so HyperProx is always reachable."
  echo ""

  # Prompt for static IP (default = current DHCP lease)
  local ip_cidr prefix
  prefix="$(echo "${current_ip}" | grep -oP '/\d+$' || echo '/24')"
  local ip_only="${current_ip%%/*}"

  echo -e "   ${C_YELLOW}?${C_RESET}  Static IP to assign (default: ${ip_only}/24): "
  read -r user_ip
  [[ -z "${user_ip}" ]] && user_ip="${ip_only}/24"
  # Strip trailing /prefix if user forgot to add one
  [[ "${user_ip}" != */* ]] && user_ip="${user_ip}/24"

  echo -e "   ${C_YELLOW}?${C_RESET}  Gateway (default: ${gateway}): "
  read -r user_gw
  [[ -z "${user_gw}" ]] && user_gw="${gateway}"

  # Write static config
  info "Writing /etc/network/interfaces..."
  cat > /etc/network/interfaces <<EOF
# Generated by HyperProx installer
auto lo
iface lo inet loopback

auto ${iface}
iface ${iface} inet static
    address ${user_ip}
    gateway ${user_gw}
EOF

  # Write resolv.conf if empty
  if [[ ! -s /etc/resolv.conf ]]; then
    echo "nameserver 1.1.1.1" > /etc/resolv.conf
    echo "nameserver 8.8.8.8" >> /etc/resolv.conf
  fi

  # Apply without full reboot
  info "Applying static IP (${user_ip})..."
  ifdown "${iface}" 2>>"${LOG_FILE}" || true
  ifup "${iface}" 2>>"${LOG_FILE}" || true

  ok "Static IP configured: ${user_ip} via ${user_gw}"
  warn "If you are connected via SSH, reconnect to: ${user_ip%%/*}"
}

# ── System Update + Prerequisites ─────────────────────────────────────────────
install_prerequisites() {
  step "Installing system prerequisites"

  info "Updating package lists..."
  run_with_spinner "Updating apt" apt-get update -qq

  local pkgs=(curl wget git gnupg lsb-release ca-certificates
              apt-transport-https openssl jq unzip build-essential)
  # Not packaged on Debian 13 (trixie) and nothing below needs it; install it only where it exists.
  if apt-cache show software-properties-common >/dev/null 2>&1; then
    pkgs+=(software-properties-common)
  fi

  info "Installing base packages..."
  run_with_spinner "Installing packages" \
    apt-get install -y -qq "${pkgs[@]}"

  ok "System packages installed"
}

# ── Disable AppArmor (LXC incompatible) ──────────────────────────────────────
disable_apparmor() {
  [[ "${VIRT_TYPE}" != "lxc" ]] && return

  if systemctl is-active --quiet apparmor 2>/dev/null || systemctl is-enabled --quiet apparmor 2>/dev/null; then
    step "Disabling AppArmor"
    info "AppArmor is not supported in LXC containers — disabling to allow Docker to run..."
    systemctl stop apparmor 2>/dev/null || true
    systemctl disable apparmor 2>/dev/null || true
    # Unload all AppArmor profiles
    if command -v aa-teardown &>/dev/null; then
      aa-teardown 2>/dev/null || true
    fi
    ok "AppArmor disabled"
  fi
}

# ── Docker CE ─────────────────────────────────────────────────────────────────
install_docker() {
  step "Installing Docker CE"

  if command -v docker &>/dev/null; then
    DOCKER_VERSION="$(docker --version | grep -oP '\d+\.\d+\.\d+')"
    ok "Docker already installed: ${DOCKER_VERSION} — skipping"
    return
  fi

  info "Adding Docker GPG key..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${OS_ID}/gpg" \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>>"${LOG_FILE}"
  chmod a+r /etc/apt/keyrings/docker.gpg

  info "Adding Docker apt repository..."
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${OS_ID} ${PKG_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

  run_with_spinner "Updating apt (Docker repo)" apt-get update -qq

  info "Downloading and installing Docker CE (this may take a few minutes)..."
  run_with_spinner "Installing Docker CE" \
    apt-get install -y -qq \
      docker-ce docker-ce-cli containerd.io \
      docker-buildx-plugin docker-compose-plugin

  if [[ "${VIRT_TYPE}" == "lxc" ]]; then
    info "Configuring Docker daemon for LXC environment..."
    mkdir -p /etc/docker
    cat > /etc/docker/daemon.json <<'EOF'
{
  "storage-driver": "overlay2",
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "no-new-privileges": false
}
EOF
  fi

  info "Starting Docker daemon..."
  systemctl enable docker --quiet
  systemctl start docker

  info "Running smoke test (hello-world)..."
  docker run --rm hello-world >>"${LOG_FILE}" 2>&1 \
    && ok "Docker CE installed and working" \
    || die "Docker installed but test container failed. Check LXC nesting settings."
}

# ── Node.js + pnpm ────────────────────────────────────────────────────────────
install_node() {
  step "Installing Node.js ${NODE_VERSION} LTS + pnpm"

  if command -v node &>/dev/null; then
    CURRENT_NODE="$(node --version | grep -oP '\d+' | head -1)"
    if [[ "${CURRENT_NODE}" -ge "${NODE_VERSION}" ]]; then
      ok "Node.js already installed: $(node --version) — skipping"
    else
      warn "Node.js $(node --version) found but ${NODE_VERSION}+ required — upgrading"
      _install_node_nodesource
    fi
  else
    _install_node_nodesource
  fi

  if command -v pnpm &>/dev/null; then
    ok "pnpm already installed: $(pnpm --version)"
  else
    info "Installing pnpm..."
    run_with_spinner "Installing pnpm" \
      npm install -g "pnpm@${PNPM_VERSION}"
    ok "pnpm $(pnpm --version) installed"
  fi
}

_install_node_nodesource() {
  info "Adding NodeSource repository for Node.js ${NODE_VERSION}..."
  run_with_spinner "Configuring NodeSource repo" \
    bash -c "curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -"

  info "Installing Node.js ${NODE_VERSION}..."
  run_with_spinner "Installing Node.js" \
    apt-get install -y -qq nodejs

  ok "Node.js $(node --version) installed"
}

# ── Clone Repo ────────────────────────────────────────────────────────────────
clone_repo() {
  step "Cloning HyperProx repository"

  if [[ -d "${HYPERPROX_DIR}/.git" ]]; then
    warn "Repository already exists at ${HYPERPROX_DIR}"
    confirm "Pull latest changes?" && git -C "${HYPERPROX_DIR}" pull --quiet && ok "Repository updated" || ok "Skipped"
    return
  fi

  if [[ -d "${HYPERPROX_DIR}" ]]; then
    warn "${HYPERPROX_DIR} exists but is not a git repo — removing"
    rm -rf "${HYPERPROX_DIR}"
  fi

  info "Cloning from ${REPO_URL}..."
  run_with_spinner "Cloning repository" \
    git clone --quiet "${REPO_URL}" "${HYPERPROX_DIR}"

  ok "Cloned to ${HYPERPROX_DIR}"
}

# ── Install Dependencies + Build ───────────────────────────────────────────────
build_app() {
  [[ "${SKIP_BUILD}" == "true" ]] && { warn "Skipping build (--no-build flag)"; return; }

  step "Installing dependencies"
  cd "${HYPERPROX_DIR}"
  info "Running pnpm install (first run downloads all packages — may take a few minutes)..."
  run_with_spinner "Installing npm packages" \
    pnpm install --frozen-lockfile
  ok "Dependencies installed"

  step "Building API"
  cd "${HYPERPROX_DIR}/apps/api"
  info "Compiling TypeScript..."
  run_with_spinner "Building API" pnpm build
  ok "API built"

  step "Building Frontend"
  cd "${HYPERPROX_DIR}/apps/frontend"

  # NEXT_PUBLIC_* vars are baked in at build time — validate they exist
  source "${HYPERPROX_DIR}/.env"
  [[ -z "${NEXT_PUBLIC_API_URL:-}" ]] && die "NEXT_PUBLIC_API_URL is not set in .env — cannot build frontend"
  [[ -z "${NEXT_PUBLIC_WS_URL:-}" ]]  && die "NEXT_PUBLIC_WS_URL is not set in .env — cannot build frontend"
  # FIX: Write .env.production so NEXT_PUBLIC_ vars are baked into the Next.js build
  grep '^NEXT_PUBLIC_' "${HYPERPROX_DIR}/.env" > .env.production

  info "Building Next.js app (this is the slow step — typically 3-5 minutes)..."
  run_with_spinner "Building Frontend" pnpm build

  info "Copying static assets to standalone output..."
  SRC="${HYPERPROX_DIR}/apps/frontend/.next/static"
  DEST="${HYPERPROX_DIR}/apps/frontend/.next/standalone/apps/frontend/.next/static"
  mkdir -p "$(dirname "${DEST}")"
  cp -r "${SRC}" "${DEST}"

  if [[ -d "${HYPERPROX_DIR}/apps/frontend/public" ]]; then
    cp -r "${HYPERPROX_DIR}/apps/frontend/public" \
      "${HYPERPROX_DIR}/apps/frontend/.next/standalone/apps/frontend/public" 2>/dev/null || true
  fi
  ok "Frontend built"
}

# ── Generate .env ─────────────────────────────────────────────────────────────
configure_env() {
  step "Generating environment configuration"

  ENV_FILE="${HYPERPROX_DIR}/.env"

  if [[ -f "${ENV_FILE}" ]]; then
    warn ".env already exists — preserving existing configuration"
    return
  fi

  HOST_IP="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I | awk '{print $1}')"

  AES_KEY="$(openssl rand -hex 32)"
  JWT_SECRET="$(openssl rand -hex 32)"
  SETUP_SECRET="$(openssl rand -hex 32)"
  DB_PASSWORD="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)"
  GRAFANA_ADMIN_PASSWORD="$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 16)"
  GRAFANA_SECRET_KEY="$(openssl rand -hex 32)"

  cat > "${ENV_FILE}" <<EOF
# =============================================================================
# HyperProx Environment Configuration
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Edit this file to configure HyperProx, then restart services.
# =============================================================================

# ── App ───────────────────────────────────────────────────────────────────────
NODE_ENV=production
HOST_IP=${HOST_IP}
API_HOST=localhost
SETUP_PORT=${SETUP_PORT}
API_PORT=${API_PORT}
FRONTEND_PORT=${FRONTEND_PORT}

# ── Database ──────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://hyperprox:${DB_PASSWORD}@localhost:5432/hyperprox
POSTGRES_USER=hyperprox
POSTGRES_PASSWORD=${DB_PASSWORD}
POSTGRES_DB=hyperprox

# ── Redis ─────────────────────────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=

# ── Security ──────────────────────────────────────────────────────────────────
# ENCRYPTION_KEY and JWT_SECRET are legacy. Credentials and sessions now live behind the vault gate; the
# first owner unlock migrates stored credentials into the vault and blanks these two lines (a copy is
# kept in .env.pre-vault, mode 0600 - delete it once you have checked your credentials).
# The vault settings (VAULT_*) are added further down by the installer.
ENCRYPTION_KEY=${AES_KEY}
JWT_SECRET=${JWT_SECRET}
SETUP_SECRET=${SETUP_SECRET}

# ── Grafana ───────────────────────────────────────────────────────────────────
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}
GRAFANA_SECRET_KEY=${GRAFANA_SECRET_KEY}

# ── Monitoring ────────────────────────────────────────────────────────────────
PROMETHEUS_RETENTION=90d
PROMETHEUS_RETENTION_SIZE=40GB

# ── Docker Compose ────────────────────────────────────────────────────────────
# Optional parts of docker-compose.yml to run: monitoring (Prometheus, Grafana, PVE exporter) and npm
# (Nginx Proxy Manager). docker compose reads this itself; the setup wizard rewrites it from your choices.
COMPOSE_PROFILES=monitoring

# ── Proxmox (filled in by setup wizard) ──────────────────────────────────────
PROXMOX_HOST=
PROXMOX_PORT=8006
PROXMOX_USER=
PROXMOX_TOKEN_ID=
PROXMOX_TOKEN_SECRET=
PROXMOX_PUBLIC_URL=

# ── Frontend public URLs ──────────────────────────────────────────────────────
# Everything is served through nginx on https://${HOST_IP}/ (see config/nginx).
NEXT_PUBLIC_API_URL=https://${HOST_IP}/api
NEXT_PUBLIC_WS_URL=wss://${HOST_IP}/ws

# ── Cluster identity ──────────────────────────────────────────────────────────
# Display name shown in the sidebar
NEXT_PUBLIC_CLUSTER_NAME="My Cluster"

# Grafana embed URL — must be reachable from the user's browser. The Monitoring page embeds it, and an
# http iframe on the https app is blocked, so it is served on the same origin at /grafana/.
NEXT_PUBLIC_GRAFANA_URL=/grafana
GRAFANA_ROOT_URL=https://${HOST_IP}/grafana/
GRAFANA_SERVE_FROM_SUB_PATH=true

# Comma-separated list of node names that have a GPU (e.g. node1,node2)
# Used to show GPU badge and violet accent on those nodes in the dashboard
NEXT_PUBLIC_GPU_NODES=

# The Proxmox node name to use for CEPH status/OSD queries
# Auto-detected during setup wizard — override here if needed
CEPH_MON_NODE=

# ── AI providers (all optional) ───────────────────────────────────────────────
# The deployment wizard can plan against Anthropic, OpenAI, or a local Ollama.
# These are seeded into the encrypted credential store on first run; after that
# the store is the source of truth and these lines are ignored. Setting any of
# them here is a convenience for unattended installs — the AI page is the
# ordinary way to enter them, and nothing here is required to start HyperProx.
#
# ANTHROPIC_API_KEY=
# ANTHROPIC_MODEL=claude-opus-5
#
# OPENAI_API_KEY=
# OPENAI_MODEL=gpt-4o
# OPENAI_BASE_URL=https://api.openai.com/v1   # or OpenRouter, Groq, a local server
#
# OLLAMA_URL=http://your-ollama-host:11434
# OLLAMA_MODEL=qwen3:8b

# ── Setup wizard state ────────────────────────────────────────────────────────
SETUP_COMPLETE=false
EOF

  chmod 600 "${ENV_FILE}"
  ok "Generated .env at ${ENV_FILE}"
  info "Grafana admin password: ${GRAFANA_ADMIN_PASSWORD} (also saved in .env)"
  info "Proxmox credentials will be configured through the setup wizard"
}

# ── Vault gate settings ───────────────────────────────────────────────────────
# Idempotent: runs for fresh installs and for existing .env files that predate the vault. Existing values
# are never overwritten, so re-running the installer keeps the admin token that is already in force.
VAULT_IMAGE="vaultwarden/server:1.37.4@sha256:efb3cde962015fcc036b2ea625242248611943b27212ebf4392841fb30fad055"

env_has() { grep -qE "^$1=" "${ENV_FILE}" 2>/dev/null; }

# Argon2id PHC hash of $1, produced by Vaultwarden's own `hash` tool from the pinned image. The tool
# insists on a terminal for its password prompt, so it runs under script(1) with the token piped in.
vault_token_hash() {
  local token="$1" out
  out="$(printf '%s\n%s\n' "${token}" "${token}" \
    | script -qec "docker run --rm -it ${VAULT_IMAGE} /vaultwarden hash --preset bitwarden" /dev/null 2>>"${LOG_FILE}" \
    | tr -d '\r')" || true
  printf '%s' "${out}" | grep -oP "ADMIN_TOKEN='\K[^']+" | head -1
}

configure_vault_env() {
  step "Configuring the vault gate"
  ENV_FILE="${HYPERPROX_DIR}/.env"
  [[ -f "${ENV_FILE}" ]] || die ".env not found at ${ENV_FILE}"

  # The vault is served over TLS on loopback (the Bitwarden CLI refuses plain http). Self-signed, made once,
  # never replaced. Cert is world-readable; the key is root-only (the container runs as root).
  local tls="${HYPERPROX_DIR}/config/vault-tls"
  mkdir -p "${tls}"; chmod 755 "${tls}"
  if [[ ! -s "${tls}/cert.pem" || ! -s "${tls}/key.pem" ]]; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
      -subj /CN=hyperprox-vault -addext subjectAltName=IP:127.0.0.1,DNS:localhost \
      -keyout "${tls}/key.pem" -out "${tls}/cert.pem" >>"${LOG_FILE}" 2>&1 \
      || die "Could not generate the vault TLS certificate (see ${LOG_FILE})"
    ok "Generated the vault's loopback TLS certificate"
  fi
  chmod 644 "${tls}/cert.pem"; chmod 600 "${tls}/key.pem"

  local added=false
  if ! env_has VAULT_ADMIN_TOKEN_HASH; then
    local token hash
    token="$(openssl rand -hex 24)"
    info "Pulling the pinned Vaultwarden image and hashing the admin token..."
    docker pull --quiet "${VAULT_IMAGE}" >>"${LOG_FILE}" 2>&1 || die "Could not pull ${VAULT_IMAGE}"
    hash="$(vault_token_hash "${token}")"
    [[ "${hash}" == \$argon2id\$* ]] || die "Could not generate the vault admin token hash (see ${LOG_FILE})"
    {
      echo ""
      echo "# ── Vault (Vaultwarden) ───────────────────────────────────────────────────────"
      echo "# VAULT_ADMIN_TOKEN opens the vault's /admin page on 127.0.0.1:8222. That page manages users and"
      echo "# settings, NOT vault contents (those are end-to-end encrypted). Keep it private."
      echo "VAULT_ADMIN_TOKEN=${token}"
      # Single quotes: the hash is full of '\$', which docker compose would otherwise try to expand.
      echo "VAULT_ADMIN_TOKEN_HASH='${hash}'"
    } >> "${ENV_FILE}"
    added=true
  fi
  # An earlier build of this installer wrote a plain-http URL; the vault now speaks only https.
  sed -i 's|^VAULT_URL=http://127.0.0.1:8222$|VAULT_URL=https://127.0.0.1:8222|' "${ENV_FILE}"
  env_has VAULT_URL || { echo "VAULT_URL=https://127.0.0.1:8222" >> "${ENV_FILE}"; added=true; }
  env_has VAULT_CA_CERT || { echo "VAULT_CA_CERT=${tls}/cert.pem" >> "${ENV_FILE}"; added=true; }
  # Empty = Send links and invitations use the loopback origin. Set to the https address people can reach.
  env_has VAULT_PUBLIC_URL || { echo "VAULT_PUBLIC_URL=" >> "${ENV_FILE}"; added=true; }
  env_has VAULT_IDLE_LOCK_MINUTES || { echo "VAULT_IDLE_LOCK_MINUTES=30" >> "${ENV_FILE}"; added=true; }
  chmod 600 "${ENV_FILE}"
  [[ "${added}" == "true" ]] && ok "Vault settings written to .env" || ok "Vault settings already present"
}

# ── Docker Compose Stack ───────────────────────────────────────────────────────
# The repo's docker-compose.yml is the only compose file. This installer used to carry its own copy in a
# heredoc, written only when the clone had none - which a clone always has - so the copy was never used and
# drifted unnoticed. Per-install choices live in .env; the profiles are the one this step makes sure of.
configure_compose() {
  step "Checking the Docker Compose stack"
  cd "${HYPERPROX_DIR}"
  [[ -f docker-compose.yml ]] || die "docker-compose.yml is missing from ${HYPERPROX_DIR} — is this a HyperProx clone?"

  # An .env from before COMPOSE_PROFILES: keep what the setup wizard was told, else monitoring as before.
  if ! env_has COMPOSE_PROFILES; then
    local profiles="monitoring"
    if env_has INSTALL_PROMETHEUS; then
      profiles=""
      grep -qE '^INSTALL_(PROMETHEUS|GRAFANA)=true' "${ENV_FILE}" && profiles="monitoring"
      grep -q '^INSTALL_NPM=true' "${ENV_FILE}" && profiles="${profiles:+${profiles},}npm"
    fi
    printf '\n# Optional compose profiles (monitoring, npm); docker compose reads this itself.\nCOMPOSE_PROFILES=%s\n' "${profiles}" >> "${ENV_FILE}"
    ok "Compose profiles: ${profiles:-none}"
  fi

  docker compose config -q >>"${LOG_FILE}" 2>&1 || die "docker-compose.yml does not validate with this .env (see ${LOG_FILE})"
  ok "docker-compose.yml validates"
}

# ── Prometheus + Grafana base config ──────────────────────────────────────────
write_monitoring_config() {
  step "Writing monitoring base configuration"

  # FIX: Preserve existing prometheus.yml on reinstall
  if [[ -f "${HYPERPROX_DIR}/config/prometheus/prometheus.yml" ]]; then
    warn "Prometheus config already exists — preserving existing configuration"
  else
    mkdir -p "${HYPERPROX_DIR}/config/prometheus/targets"
    mkdir -p "${HYPERPROX_DIR}/config/prometheus/rules"

    # FIX: job name 'node' (not 'node_exporter') — matches alert rules and
    # existing HyperProx API references
    cat > "${HYPERPROX_DIR}/config/prometheus/prometheus.yml" <<'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: hyperprox

rule_files:
  - /etc/prometheus/rules/*.yml

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ['localhost:9090']

  - job_name: node
    scrape_interval: 60s
    scrape_timeout: 30s
    file_sd_configs:
      - files:
          - /etc/prometheus/targets/nodes.json
        refresh_interval: 30s
    relabel_configs:
      - source_labels: [__address__]
        target_label: instance
      - source_labels: [node]
        target_label: node

  - job_name: pve
    metrics_path: /pve
    params:
      module: [default]
    file_sd_configs:
      - files:
          - /etc/prometheus/targets/pve.json
        refresh_interval: 30s
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: 127.0.0.1:9221

  - job_name: ceph
    file_sd_configs:
      - files:
          - /etc/prometheus/targets/ceph.json
        refresh_interval: 30s

  - job_name: nvidia
    file_sd_configs:
      - files:
          - /etc/prometheus/targets/nvidia.json
        refresh_interval: 30s
EOF

    ok "Prometheus config written"
  fi

  # Target files are DEPLOYMENT-SPECIFIC and must never be inherited from the
  # repo. This seeding used to live in the else-branch above, which is
  # unreachable on a fresh install: prometheus.yml is tracked, so a clone always
  # has it, the guard takes the "preserve" path, and the target files shipped in
  # git survived — every new install started with the dev cluster's node IPs as
  # scrape targets. The four files have since been untracked; this seeds any
  # that are missing and never overwrites one that is already populated.
  # intel-gpu.json was also absent from the original list.
  mkdir -p "${HYPERPROX_DIR}/config/prometheus/targets"
  for _t in nodes pve ceph nvidia intel-gpu; do
    if [[ ! -f "${HYPERPROX_DIR}/config/prometheus/targets/${_t}.json" ]]; then
      echo '[]' > "${HYPERPROX_DIR}/config/prometheus/targets/${_t}.json"
    fi
  done

  # Grafana's provisioning (datasource, dashboards) ships in the repo under config/grafana/provisioning,
  # which is what docker-compose.yml mounts. Nothing to write.

  # pve-exporter config — preserve on reinstall.
  #
  # If compose starts before this file exists, Docker creates a DIRECTORY at the
  # bind-mount path. `-f` is false for a directory, so the old guard fell through
  # to a `cat >` that cannot write onto a directory; the redirect failed, the
  # script reported success, and the exporter crash-looped on IsADirectoryError
  # forever. It could never self-heal, because every reinstall repeated it.
  # Observed on TitanCluster 2026-09-02: 3,572 restarts since 2026-05-05.
  mkdir -p "${HYPERPROX_DIR}/config/pve-exporter"
  if [[ -d "${HYPERPROX_DIR}/config/pve-exporter/pve.yml" ]]; then
    warn "pve.yml exists as a directory (Docker bind-mount artefact) — removing"
    rm -rf "${HYPERPROX_DIR}/config/pve-exporter/pve.yml"
  fi
  if [[ ! -f "${HYPERPROX_DIR}/config/pve-exporter/pve.yml" ]]; then
    cat > "${HYPERPROX_DIR}/config/pve-exporter/pve.yml" <<'EOF'
# PVE Exporter configuration
# Populated by setup wizard after Proxmox connection
default:
  user: hyperprox@pve
  token_name: hyperprox
  token_value: ""
  verify_ssl: false
EOF
    ok "PVE exporter config written"
  fi
  # The image runs as uid 101 (prometheus). Root-owned 0600 gives PermissionError
  # and the same crash loop with a different exception.
  chown 101:101 "${HYPERPROX_DIR}/config/pve-exporter/pve.yml"
  chmod 640 "${HYPERPROX_DIR}/config/pve-exporter/pve.yml"
}

# ── TLS for the front door ────────────────────────────────────────────────────
# nginx serves HyperProx on https://<host>/ with certs/cert.pem + certs/key.pem. Supply your own (full chain
# in cert.pem) and they are used as they are; otherwise a self-signed one is made here, once, and kept.
configure_tls() {
  step "Configuring HTTPS"
  local dir="${HYPERPROX_DIR}/certs" host_ip
  mkdir -p "${dir}"; chmod 755 "${dir}"
  # Reverse proxies whose X-Forwarded-Proto nginx believes; empty means loopback only (see README, HTTPS).
  mkdir -p "${HYPERPROX_DIR}/data/nginx/trusted-proxies"
  if [[ -s "${dir}/cert.pem" && -s "${dir}/key.pem" ]]; then
    ok "Using the certificate in ${dir}"
  else
    host_ip="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I | awk '{print $1}')"
    local san="DNS:$(hostname),DNS:localhost,IP:127.0.0.1"
    [[ -n "${host_ip}" ]] && san="IP:${host_ip},${san}"
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
      -subj "/CN=$(hostname)" -addext "subjectAltName=${san}" \
      -keyout "${dir}/key.pem" -out "${dir}/cert.pem" >>"${LOG_FILE}" 2>&1 \
      || die "Could not generate the HTTPS certificate (see ${LOG_FILE})"
    ok "Generated a self-signed certificate (${san})"
    info "Browsers will warn once. To use your own, replace ${dir}/cert.pem and key.pem, then: docker restart hyperprox-nginx"
  fi
  chmod 644 "${dir}/cert.pem"; chmod 600 "${dir}/key.pem"
}

# ── Systemd Services ──────────────────────────────────────────────────────────
write_systemd_services() {
  step "Creating systemd service units"

  cat > /etc/systemd/system/hyperprox-api.service <<EOF
[Unit]
Description=HyperProx API (Fastify)
# The vault is the sign-in gate: there is no HyperProx without it. ExecStartPre refuses to start the
# API (with a clear journal message) until the vault answers.
After=network.target docker.service
Wants=docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=${HYPERPROX_DIR}/apps/api
EnvironmentFile=${HYPERPROX_DIR}/.env
# Reached through nginx on loopback; takes effect once the API reads API_BIND (it binds every interface now).
Environment=API_BIND=127.0.0.1
TimeoutStartSec=120
ExecStartPre=${HYPERPROX_DIR}/bin/wait-for-vault
ExecStart=$(which node) dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hyperprox-api

[Install]
WantedBy=multi-user.target
EOF

  cat > /etc/systemd/system/hyperprox-frontend.service <<EOF
[Unit]
Description=HyperProx Frontend (Next.js)
After=network.target hyperprox-api.service

[Service]
Type=simple
User=root
WorkingDirectory=${HYPERPROX_DIR}/apps/frontend/.next/standalone/apps/frontend
EnvironmentFile=${HYPERPROX_DIR}/.env
Environment=PORT=${FRONTEND_PORT}
# Loopback only: browsers reach the frontend through nginx on https://<host>/.
Environment=HOSTNAME=127.0.0.1
ExecStart=$(which node) server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hyperprox-frontend

[Install]
WantedBy=multi-user.target
EOF

  # Setup wizard — Restart=on-failure is intentional: it stops once setup
  # is complete and SETUP_COMPLETE=true, and should not restart after that.
  cat > /etc/systemd/system/hyperprox-setup.service <<EOF
[Unit]
Description=HyperProx Setup Wizard
After=network.target hyperprox-api.service

[Service]
Type=simple
User=root
WorkingDirectory=${HYPERPROX_DIR}/apps/setup
EnvironmentFile=${HYPERPROX_DIR}/.env
Environment=PORT=${SETUP_PORT}
# Loopback only: the wizard is served through nginx at https://<host>/setup.
Environment=SETUP_BIND=127.0.0.1
ExecStart=$(which node) setup.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hyperprox-setup

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  ok "Systemd units created"
}

# ── CLI ───────────────────────────────────────────────────────────────────────
install_cli() {
  step "Installing the hyperprox command"
  chmod +x "${HYPERPROX_DIR}/bin/hyperprox" "${HYPERPROX_DIR}/bin/wait-for-vault"
  ln -sf "${HYPERPROX_DIR}/bin/hyperprox" /usr/local/bin/hyperprox
  ok "hyperprox status | hyperprox lock"
}

# ── Database Migration ────────────────────────────────────────────────────────
run_migrations() {
  step "Running database migrations"

  info "Waiting for PostgreSQL to be ready..."
  local retries=30
  while ! docker exec hyperprox-postgres pg_isready -U hyperprox >/dev/null 2>&1; do
    retries=$((retries - 1))
    [[ $retries -le 0 ]] && die "PostgreSQL did not become ready in time"
    printf "\r   ${C_DIM}→  Waiting for PostgreSQL... (%d retries left)${C_RESET}" "${retries}"
    sleep 2
  done
  printf "\r   \r"
  ok "PostgreSQL is ready"

  cd "${HYPERPROX_DIR}/apps/api"
  source "${HYPERPROX_DIR}/.env"
  export DATABASE_URL
  info "Generating Prisma client..."
  run_with_spinner "Generating Prisma client" \
    npx prisma generate --schema ./prisma/schema.prisma
  info "Applying migrations..."
  run_with_spinner "Running Prisma migrations" \
    npx prisma migrate deploy --schema ./prisma/schema.prisma
  ok "Database migrations applied"
}

# ── Start Everything ──────────────────────────────────────────────────────────
start_services() {
  step "Starting the vault"
  cd "${HYPERPROX_DIR}"
  run_with_spinner "Starting the vault" \
    docker compose up -d --quiet-pull vault
  info "Waiting for the vault to answer..."
  VAULT_URL=https://127.0.0.1:8222 VAULT_CA_CERT="${HYPERPROX_DIR}/config/vault-tls/cert.pem" VAULT_WAIT_SECONDS=90 "${HYPERPROX_DIR}/bin/wait-for-vault" \
    || die "The vault did not start. HyperProx cannot run without it. See: docker logs hyperprox-vault"
  ok "Vault is up on https://127.0.0.1:8222"

  step "Starting Docker stack"
  info "Pulling images and starting containers (postgres, redis, nginx, and the COMPOSE_PROFILES in .env)..."
  run_with_spinner "Starting Docker stack" \
    docker compose up -d --quiet-pull
  ok "Docker stack started"

  run_migrations

  step "Starting HyperProx services"
  systemctl enable hyperprox-api hyperprox-frontend hyperprox-setup --quiet

  info "Starting hyperprox-api..."
  systemctl restart hyperprox-api
  sleep 2

  info "Starting hyperprox-frontend..."
  systemctl restart hyperprox-frontend
  sleep 1

  info "Starting hyperprox-setup..."
  systemctl restart hyperprox-setup
  sleep 1

  local failed=()
  for svc in hyperprox-api hyperprox-frontend hyperprox-setup; do
    if ! systemctl is-active --quiet "${svc}"; then
      failed+=("${svc}")
    fi
  done

  if [[ ${#failed[@]} -gt 0 ]]; then
    warn "Some services failed to start: ${failed[*]}"
    warn "Check logs: journalctl -u ${failed[0]} -n 50"
  else
    ok "All services running"
  fi
}

# ── Summary ───────────────────────────────────────────────────────────────────
print_summary() {
  HOST_IP="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I | awk '{print $1}')"

  echo ""
  echo -e "${C_CYAN}${C_BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}"
  echo -e "${C_GREEN}${C_BOLD}  HyperProx installed successfully!${C_RESET}"
  echo -e "${C_CYAN}${C_BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}"
  echo ""
  echo -e "  ${C_BOLD}Open the setup wizard in your browser:${C_RESET}"
  echo ""
  # The wizard only answers requests carrying the setup key; the link carries it. Read from .env so a
  # re-run that kept an existing .env prints the key that is actually in force.
  SETUP_SECRET="$(grep -oP '^SETUP_SECRET=\K.*' "${ENV_FILE}" 2>/dev/null || true)"
  echo -e "  ${C_CYAN}${C_BOLD}  https://${HOST_IP}/setup?k=${SETUP_SECRET}${C_RESET}"
  echo -e "  ${C_DIM}Keep this link private - it is the key to the setup wizard.${C_RESET}"
  echo -e "  ${C_DIM}The certificate is self-signed unless you supplied one, so the browser warns once.${C_RESET}"
  echo ""
  echo -e "  ${C_DIM}The wizard will guide you through:${C_RESET}"
  echo -e "  ${C_DIM}  • Connecting your Proxmox cluster${C_RESET}"
  echo -e "  ${C_DIM}  • Detecting existing services (NPM, Grafana, Ollama)${C_RESET}"
  echo -e "  ${C_DIM}  • Configuring DNS and proxy providers${C_RESET}"
  echo ""
  echo -e "  ${C_BOLD}Then create the owner account${C_RESET}"
  echo -e "  ${C_DIM}  HyperProx has no password of its own. After setup, open https://${HOST_IP}/login to${C_RESET}"
  echo -e "  ${C_DIM}  create the owner vault account (email, master password, and a required 2FA code).${C_RESET}"
  echo -e "  ${C_DIM}  Check on it any time with: hyperprox status    Lock it now with: hyperprox lock${C_RESET}"
  echo -e "  ${C_DIM}  Details: docs/security.md. The vault admin token is VAULT_ADMIN_TOKEN in ${ENV_FILE}.${C_RESET}"
  echo ""
  echo -e "  ${C_DIM}Service logs:${C_RESET}"
  echo -e "  ${C_DIM}  journalctl -fu hyperprox-api${C_RESET}"
  echo -e "  ${C_DIM}  journalctl -fu hyperprox-frontend${C_RESET}"
  echo -e "  ${C_DIM}  journalctl -fu hyperprox-setup${C_RESET}"
  echo -e "  ${C_DIM}  docker compose -f ${HYPERPROX_DIR}/docker-compose.yml ps${C_RESET}"
  echo ""
  echo -e "  ${C_DIM}Install log: ${LOG_FILE}${C_RESET}"
  echo ""
  echo -e "${C_CYAN}${C_BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}"
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  banner
  detect_environment
  configure_network
  disable_apparmor
  install_prerequisites
  install_docker
  install_node
  clone_repo
  configure_env
  configure_vault_env
  build_app
  configure_compose
  write_monitoring_config
  configure_tls
  write_systemd_services
  install_cli
  start_services
  print_summary
}

main "$@"
