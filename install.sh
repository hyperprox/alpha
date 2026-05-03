#!/usr/bin/env bash
# =============================================================================
#  HyperProx — One-Shot Installer
#  Supports: Debian 12, Ubuntu 22.04, Ubuntu 24.04
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
LOG_FILE="/tmp/hyperprox-install.log"

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

confirm() {
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
  local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0

  "$@" >> "${LOG_FILE}" 2>&1 &
  local pid=$!

  while kill -0 "${pid}" 2>/dev/null; do
    printf "\r   ${C_CYAN}%s${C_RESET}  %s..." "${spin:$((i % ${#spin})):1}" "${msg}"
    i=$((i + 1))
    sleep 0.1
  done
  printf "\r   \r"  # clear the spinner line

  if ! wait "${pid}"; then
    echo -e "   ${C_RED}✗${C_RESET}  ${msg} — FAILED"
    echo -e "   ${C_DIM}Last output:${C_RESET}"
    tail -20 "${LOG_FILE}" | sed 's/^/      /'
    die "${msg} failed. See ${LOG_FILE} for full output."
  fi
}

# ── Root check ────────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && die "Run as root: sudo bash install.sh"

# Initialise log file
echo "HyperProx install log — $(date -u)" > "${LOG_FILE}"
info "Logging to ${LOG_FILE}"

# ── Environment Detection ─────────────────────────────────────────────────────
detect_environment() {
  step "Detecting environment"

  if [[ -f /etc/os-release ]]; then
    source /etc/os-release
    OS_ID="${ID}"
    OS_VERSION="${VERSION_ID}"
    OS_CODENAME="${VERSION_CODENAME:-}"
  else
    die "Cannot determine OS. Requires Debian 12 or Ubuntu 22.04/24.04."
  fi

  case "${OS_ID}" in
    debian)
      [[ "${OS_VERSION}" == "12" ]] || die "Debian 12 (Bookworm) required. Found: Debian ${OS_VERSION}"
      PKG_CODENAME="bookworm"
      ;;
    ubuntu)
      [[ "${OS_VERSION}" == "22.04" || "${OS_VERSION}" == "24.04" ]] || \
        die "Ubuntu 22.04 or 24.04 required. Found: Ubuntu ${OS_VERSION}"
      PKG_CODENAME="${OS_CODENAME}"
      ;;
    *)
      die "Unsupported OS: ${OS_ID}. Requires Debian 12 or Ubuntu 22.04/24.04."
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
configure_network() {
  # Fix broken DNS — PVE sometimes injects Tailscale DNS into LXC resolv.conf
  # which fails if Tailscale isn't running in the CT
  if grep -q "100\.100\.100\.100\|taila\|ts\.net" /etc/resolv.conf 2>/dev/null; then
    warn "Detected Proxmox-injected Tailscale DNS — replacing with public resolvers"
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
              apt-transport-https software-properties-common
              openssl jq unzip build-essential)

  info "Installing base packages..."
  run_with_spinner "Installing packages" \
    apt-get install -y -qq "${pkgs[@]}"

  ok "System packages installed"
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
  }
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

# ── Proxmox (filled in by setup wizard) ──────────────────────────────────────
PROXMOX_HOST=
PROXMOX_PORT=8006
PROXMOX_USER=
PROXMOX_TOKEN_ID=
PROXMOX_TOKEN_SECRET=
PROXMOX_PUBLIC_URL=

# ── Frontend public URLs ──────────────────────────────────────────────────────
NEXT_PUBLIC_API_URL=http://${HOST_IP}:${API_PORT}
NEXT_PUBLIC_WS_URL=ws://${HOST_IP}:${API_PORT}

# ── Cluster identity ──────────────────────────────────────────────────────────
# Display name shown in the sidebar
NEXT_PUBLIC_CLUSTER_NAME="My Cluster"

# Comma-separated list of node names that have a GPU (e.g. node1,node2)
# Used to show GPU badge and violet accent on those nodes in the dashboard
NEXT_PUBLIC_GPU_NODES=

# The Proxmox node name to use for CEPH status/OSD queries
# Set to any node that runs the CEPH MON service
CEPH_MON_NODE=

# ── Setup wizard state ────────────────────────────────────────────────────────
SETUP_COMPLETE=false
EOF

  chmod 600 "${ENV_FILE}"
  ok "Generated .env at ${ENV_FILE}"
  info "Grafana admin password: ${GRAFANA_ADMIN_PASSWORD} (also saved in .env)"
  info "Proxmox credentials will be configured through the setup wizard"
}

# ── Docker Compose Stack ───────────────────────────────────────────────────────
write_docker_compose() {
  step "Writing Docker Compose stack"

  # FIX: Preserve existing docker-compose.yml on reinstall
  if [[ -f "${HYPERPROX_DIR}/docker-compose.yml" ]]; then
    warn "docker-compose.yml already exists — preserving existing configuration"
    return
  fi

  cat > "${HYPERPROX_DIR}/docker-compose.yml" <<'EOF'
# HyperProx Docker Compose Stack
# Do not add 'version:' — deprecated in Compose v2

services:
  postgres:
    image: postgres:16-alpine
    container_name: hyperprox-postgres
    restart: unless-stopped
    env_file: .env
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    container_name: hyperprox-redis
    restart: unless-stopped
    command: redis-server --save 60 1 --loglevel warning
    volumes:
      - redis_data:/data
    ports:
      - "127.0.0.1:6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  # FIX: network_mode: host — Prometheus must scrape node_exporter on the host
  # network directly. Bridge networking causes NAT through 172.x.x.x which
  # results in 'context deadline exceeded' on scrape targets.
  prometheus:
    image: prom/prometheus:latest
    container_name: hyperprox-prometheus
    restart: unless-stopped
    network_mode: host
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
      - "--storage.tsdb.path=/prometheus"
      - "--storage.tsdb.retention.time=${PROMETHEUS_RETENTION:-90d}"
      - "--storage.tsdb.retention.size=${PROMETHEUS_RETENTION_SIZE:-40GB}"
      - "--web.console.libraries=/usr/share/prometheus/console_libraries"
      - "--web.console.templates=/usr/share/prometheus/consoles"
      - "--web.enable-lifecycle"
      - "--web.enable-admin-api"
    volumes:
      - ./config/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./config/prometheus/rules:/etc/prometheus/rules:ro
      - ./config/prometheus/targets:/etc/prometheus/targets:ro
      - ./data/prometheus:/prometheus
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:9090/-/healthy"]
      interval: 30s
      timeout: 5s
      retries: 3

  grafana:
    image: grafana/grafana:latest
    container_name: hyperprox-grafana
    restart: unless-stopped
    environment:
      # FIX: Explicitly set HTTP port — Grafana defaults to 3000 internally
      - GF_SERVER_HTTP_PORT=3003
      - GF_SECURITY_ADMIN_USER=${GRAFANA_ADMIN_USER:-admin}
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}
      - GF_SECURITY_SECRET_KEY=${GRAFANA_SECRET_KEY}
      - GF_USERS_ALLOW_SIGN_UP=false
      - GF_USERS_ALLOW_ORG_CREATE=false
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_NAME=Main Org.
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer
      - GF_SECURITY_ALLOW_EMBEDDING=true
      - GF_SECURITY_COOKIE_SAMESITE=disabled
    volumes:
      - ./config/grafana:/etc/grafana/provisioning:ro
      - grafana_data:/var/lib/grafana
    ports:
      - "3003:3003"
    networks:
      - hyperprox-net
    depends_on:
      - prometheus

  pve-exporter:
    image: prompve/prometheus-pve-exporter:latest
    container_name: hyperprox-pve-exporter
    restart: unless-stopped
    volumes:
      - ./config/pve-exporter/pve.yml:/etc/prometheus/pve.yml:ro
    ports:
      - "127.0.0.1:9221:9221"
    networks:
      - hyperprox-net

  # FIX: extra_hosts required for host.docker.internal to resolve on Linux
  nginx:
    image: nginx:alpine
    container_name: hyperprox-nginx
    restart: unless-stopped
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./config/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    ports:
      - "80:80"
      - "443:443"
    networks:
      - hyperprox-net
    depends_on:
      - postgres
      - redis

networks:
  hyperprox-net:
    driver: bridge

volumes:
  postgres_data:
  redis_data:
  grafana_data:
EOF
  ok "docker-compose.yml written"
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
        replacement: localhost:9221

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

    # Empty target files — populated by setup wizard after Proxmox connection
    echo '[]' > "${HYPERPROX_DIR}/config/prometheus/targets/nodes.json"
    echo '[]' > "${HYPERPROX_DIR}/config/prometheus/targets/ceph.json"
    echo '[]' > "${HYPERPROX_DIR}/config/prometheus/targets/nvidia.json"
    echo '[]' > "${HYPERPROX_DIR}/config/prometheus/targets/pve.json"

    ok "Prometheus config written"
  fi

  # Grafana config — preserve on reinstall
  if [[ -f "${HYPERPROX_DIR}/config/grafana/datasources/prometheus.yml" ]]; then
    warn "Grafana config already exists — preserving existing configuration"
  else
    mkdir -p "${HYPERPROX_DIR}/config/grafana/dashboards"
    mkdir -p "${HYPERPROX_DIR}/config/grafana/datasources"

    cat > "${HYPERPROX_DIR}/config/grafana/datasources/prometheus.yml" <<'EOF'
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://localhost:9090
    isDefault: true
    editable: false
EOF

    cat > "${HYPERPROX_DIR}/config/grafana/dashboards/dashboards.yml" <<'EOF'
apiVersion: 1
providers:
  - name: HyperProx
    folder: HyperProx
    type: file
    options:
      path: /etc/grafana/provisioning/dashboards
EOF

    ok "Grafana config written"
  fi

  # pve-exporter config — preserve on reinstall
  if [[ ! -f "${HYPERPROX_DIR}/config/pve-exporter/pve.yml" ]]; then
    mkdir -p "${HYPERPROX_DIR}/config/pve-exporter"
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

  # Nginx config — preserve on reinstall
  if [[ ! -f "${HYPERPROX_DIR}/config/nginx/nginx.conf" ]]; then
    mkdir -p "${HYPERPROX_DIR}/config/nginx"
    cat > "${HYPERPROX_DIR}/config/nginx/nginx.conf" <<'EOF'
events { worker_connections 1024; }

http {
  server {
    listen 80;
    server_name _;

    location / {
      proxy_pass http://host.docker.internal:3000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection 'upgrade';
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_cache_bypass $http_upgrade;
    }

    location /api/ {
      proxy_pass http://host.docker.internal:3002;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection 'upgrade';
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
    }

    location /setup/ {
      proxy_pass http://host.docker.internal:3001;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
    }
  }
}
EOF
    ok "Nginx config written"
  fi
}

# ── Systemd Services ──────────────────────────────────────────────────────────
write_systemd_services() {
  step "Creating systemd service units"

  cat > /etc/systemd/system/hyperprox-api.service <<EOF
[Unit]
Description=HyperProx API (Fastify)
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=${HYPERPROX_DIR}/apps/api
EnvironmentFile=${HYPERPROX_DIR}/.env
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
Environment=HOSTNAME=0.0.0.0
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
Environment=HOSTNAME=0.0.0.0
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
  step "Starting Docker stack"
  cd "${HYPERPROX_DIR}"
  info "Pulling images and starting containers (postgres, redis, prometheus, grafana, pve-exporter, nginx)..."
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
  echo -e "  ${C_CYAN}${C_BOLD}  http://${HOST_IP}:${SETUP_PORT}${C_RESET}"
  echo ""
  echo -e "  ${C_DIM}The wizard will guide you through:${C_RESET}"
  echo -e "  ${C_DIM}  • Connecting your Proxmox cluster${C_RESET}"
  echo -e "  ${C_DIM}  • Creating your admin account${C_RESET}"
  echo -e "  ${C_DIM}  • Detecting existing services (NPM, Grafana, Ollama)${C_RESET}"
  echo -e "  ${C_DIM}  • Configuring DNS and proxy providers${C_RESET}"
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
  install_prerequisites
  install_docker
  install_node
  clone_repo
  configure_env
  build_app
  write_docker_compose
  write_monitoring_config
  write_systemd_services
  start_services
  print_summary
}

main "$@"
