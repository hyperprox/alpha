#!/usr/bin/env bash
# =============================================================================
#  HyperProx — One-Shot Installer
#  Supports: Debian 12, Ubuntu 22.04, Ubuntu 24.04
#  Targets:  Proxmox LXC (privileged), bare metal, VM
#  Usage:    curl -fsSL https://get.hyperprox.io | bash
#            — or —
#            bash install.sh [--no-build] [--dev]
# =============================================================================

set -euo pipefail

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

# ── Colors ───────────────────────────────────────────────────────────────────
C_RESET="\033[0m"
C_BOLD="\033[1m"
C_DIM="\033[2m"
C_CYAN="\033[36m"
C_GREEN="\033[32m"
C_YELLOW="\033[33m"
C_RED="\033[31m"
C_MAGENTA="\033[35m"

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
die()     { echo -e "\n   ${C_RED}✗  ERROR: $1${C_RESET}\n"; exit 1; }

confirm() {
  echo -e "   ${C_YELLOW}?${C_RESET}  $1 [Y/n] "
  read -r reply
  [[ "${reply,,}" =~ ^(y|yes|)$ ]]
}

# ── Root check ────────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && die "Run as root: sudo bash install.sh"

# ── Environment Detection ─────────────────────────────────────────────────────
detect_environment() {
  step "Detecting environment"

  # OS
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
    # Check if privileged — unprivileged LXC can't run Docker without extra config
    if [[ -f /proc/1/status ]]; then
      CAP_BND="$(grep CapBnd /proc/1/status | awk '{print $2}')"
      if [[ "${CAP_BND}" == "0000003fffffffff" ]] || [[ "${CAP_BND}" == "000001ffffffffff" ]]; then
        ok "LXC container: privileged ✓"
      else
        warn "LXC container appears to be unprivileged (limited capabilities)."
        warn "Docker may not work without additional Proxmox LXC config."
        warn "In Proxmox: set 'features: nesting=1' and ensure container is privileged."
        confirm "Continue anyway?" || die "Aborted. Re-run after fixing LXC configuration."
      fi
    fi
  fi
}

# ── System Update + Prerequisites ─────────────────────────────────────────────
install_prerequisites() {
  step "Installing system prerequisites"
  apt-get update -qq
  apt-get install -y -qq \
    curl wget git gnupg lsb-release ca-certificates \
    apt-transport-https software-properties-common \
    openssl jq unzip build-essential \
    >/dev/null 2>&1
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

  # Add Docker's official GPG key
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${OS_ID}/gpg" \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  # Add Docker apt repo
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/${OS_ID} ${PKG_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    >/dev/null 2>&1

  # LXC-specific Docker daemon config
  if [[ "${VIRT_TYPE}" == "lxc" ]]; then
    info "Configuring Docker daemon for LXC environment"
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

  systemctl enable docker --quiet
  systemctl start docker

  # Verify
  docker run --rm hello-world >/dev/null 2>&1 \
    && ok "Docker CE installed and working" \
    || die "Docker installation succeeded but test container failed. Check LXC nesting settings."
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

  # pnpm
  if command -v pnpm &>/dev/null; then
    ok "pnpm already installed: $(pnpm --version)"
  else
    npm install -g "pnpm@${PNPM_VERSION}" --quiet
    ok "pnpm $(pnpm --version) installed"
  fi
}

_install_node_nodesource() {
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null 2>&1
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

  git clone --quiet "${REPO_URL}" "${HYPERPROX_DIR}"
  ok "Cloned to ${HYPERPROX_DIR}"
}

# ── Install Dependencies + Build ───────────────────────────────────────────────
build_app() {
  [[ "${SKIP_BUILD}" == "true" ]] && { warn "Skipping build (--no-build flag)"; return; }

  step "Installing dependencies"
  cd "${HYPERPROX_DIR}"
  pnpm install --frozen-lockfile
  ok "Dependencies installed"

  step "Building API"
  cd "${HYPERPROX_DIR}/apps/api"
  pnpm build
  ok "API built"

  step "Building Frontend"
  cd "${HYPERPROX_DIR}/apps/frontend"
  pnpm build
  # Copy static assets to standalone output (Next.js standalone quirk)
  SRC="${HYPERPROX_DIR}/apps/frontend/.next/static"
  DEST="${HYPERPROX_DIR}/apps/frontend/.next/standalone/apps/frontend/.next/static"
  mkdir -p "$(dirname "${DEST}")"
  cp -r "${SRC}" "${DEST}"

  # Copy public folder if it exists
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

  # Detect host IP (prefer non-loopback, non-docker)
  HOST_IP="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I | awk '{print $1}')"

  # Generate secrets
  AES_KEY="$(openssl rand -hex 32)"
  JWT_SECRET="$(openssl rand -hex 32)"
  DB_PASSWORD="$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)"

  cat > "${ENV_FILE}" <<EOF
# =============================================================================
# HyperProx Environment Configuration
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Edit this file to configure HyperProx, then restart services.
# =============================================================================

# ── App ───────────────────────────────────────────────────────────────────────
NODE_ENV=production
HOST_IP=${HOST_IP}
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

# ── Security ──────────────────────────────────────────────────────────────────
ENCRYPTION_KEY=${AES_KEY}
JWT_SECRET=${JWT_SECRET}

# ── Proxmox (filled in by setup wizard) ──────────────────────────────────────
PROXMOX_HOST=
PROXMOX_PORT=8006
PROXMOX_TOKEN_ID=
PROXMOX_TOKEN_SECRET=
PROXMOX_PUBLIC_URL=

# ── Setup wizard state ────────────────────────────────────────────────────────
# Set to "complete" after first-run wizard is finished
SETUP_COMPLETE=false
EOF

  chmod 600 "${ENV_FILE}"
  ok "Generated .env at ${ENV_FILE}"
  info "Proxmox credentials will be configured through the setup wizard"
}

# ── Docker Compose Stack ───────────────────────────────────────────────────────
write_docker_compose() {
  step "Writing Docker Compose stack"
  cat > "${HYPERPROX_DIR}/docker-compose.yml" <<'EOF'
version: "3.9"

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

  prometheus:
    image: prom/prometheus:latest
    container_name: hyperprox-prometheus
    restart: unless-stopped
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=90d'
      - '--web.enable-lifecycle'
    volumes:
      - ./config/prometheus:/etc/prometheus:ro
      - prometheus_data:/prometheus
    ports:
      - "127.0.0.1:9090:9090"

  grafana:
    image: grafana/grafana:latest
    container_name: hyperprox-grafana
    restart: unless-stopped
    environment:
      GF_AUTH_ANONYMOUS_ENABLED: "true"
      GF_AUTH_ANONYMOUS_ORG_NAME: "Main Org."
      GF_AUTH_ANONYMOUS_ORG_ROLE: "Viewer"
      GF_SECURITY_ALLOW_EMBEDDING: "true"
      GF_SECURITY_COOKIE_SAMESITE: "disabled"
      GF_SERVER_ROOT_URL: "%(protocol)s://%(domain)s:3003"
    volumes:
      - ./config/grafana:/etc/grafana/provisioning:ro
      - grafana_data:/var/lib/grafana
    ports:
      - "3003:3003"
    depends_on:
      - prometheus

  nginx:
    image: nginx:alpine
    container_name: hyperprox-nginx
    restart: unless-stopped
    volumes:
      - ./config/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    ports:
      - "80:80"
      - "443:443"
    depends_on:
      - postgres
      - redis

volumes:
  postgres_data:
  redis_data:
  prometheus_data:
  grafana_data:
EOF
  ok "docker-compose.yml written"
}

# ── Prometheus + Grafana base config ──────────────────────────────────────────
write_monitoring_config() {
  step "Writing monitoring base configuration"

  mkdir -p "${HYPERPROX_DIR}/config/prometheus/targets"
  mkdir -p "${HYPERPROX_DIR}/config/grafana/dashboards"
  mkdir -p "${HYPERPROX_DIR}/config/grafana/datasources"
  mkdir -p "${HYPERPROX_DIR}/config/nginx"

  # Prometheus base config
  cat > "${HYPERPROX_DIR}/config/prometheus/prometheus.yml" <<'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - "alerts.yml"

scrape_configs:
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'node_exporter'
    file_sd_configs:
      - files:
          - '/etc/prometheus/targets/nodes.json'
        refresh_interval: 30s

  - job_name: 'ceph'
    file_sd_configs:
      - files:
          - '/etc/prometheus/targets/ceph.json'
        refresh_interval: 30s

  - job_name: 'nvidia'
    file_sd_configs:
      - files:
          - '/etc/prometheus/targets/nvidia.json'
        refresh_interval: 30s
EOF

  # Empty target files — populated by setup wizard after Proxmox connection
  echo '[]' > "${HYPERPROX_DIR}/config/prometheus/targets/nodes.json"
  echo '[]' > "${HYPERPROX_DIR}/config/prometheus/targets/ceph.json"
  echo '[]' > "${HYPERPROX_DIR}/config/prometheus/targets/nvidia.json"

  # Grafana datasource
  cat > "${HYPERPROX_DIR}/config/grafana/datasources/prometheus.yml" <<'EOF'
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
EOF

  # Grafana dashboard provisioning
  cat > "${HYPERPROX_DIR}/config/grafana/dashboards/dashboards.yml" <<'EOF'
apiVersion: 1
providers:
  - name: HyperProx
    folder: HyperProx
    type: file
    options:
      path: /etc/grafana/provisioning/dashboards
EOF

  # Nginx reverse proxy config
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

  ok "Monitoring and proxy configs written"
}

# ── Systemd Services ──────────────────────────────────────────────────────────
write_systemd_services() {
  step "Creating systemd service units"

  # hyperprox-api
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

  # hyperprox-frontend
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

  # hyperprox-setup (wizard — runs until setup is complete)
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

  # Wait for postgres to be healthy
  info "Waiting for PostgreSQL..."
  local retries=30
  while ! docker exec hyperprox-postgres pg_isready -U hyperprox >/dev/null 2>&1; do
    retries=$((retries - 1))
    [[ $retries -le 0 ]] && die "PostgreSQL did not become ready in time"
    sleep 2
  done
  ok "PostgreSQL is ready"

  cd "${HYPERPROX_DIR}/apps/api"
  source "${HYPERPROX_DIR}/.env"
  export DATABASE_URL
  npx prisma migrate deploy --schema ./prisma/schema.prisma >/dev/null 2>&1
  ok "Database migrations applied"
}

# ── Start Everything ──────────────────────────────────────────────────────────
start_services() {
  step "Starting Docker stack"
  cd "${HYPERPROX_DIR}"
  docker compose up -d --quiet-pull 2>/dev/null
  ok "Docker stack started (postgres, redis, prometheus, grafana, nginx)"

  run_migrations

  step "Starting HyperProx services"
  systemctl enable hyperprox-api hyperprox-frontend hyperprox-setup --quiet
  systemctl restart hyperprox-api
  sleep 2
  systemctl restart hyperprox-frontend
  sleep 1
  systemctl restart hyperprox-setup
  sleep 1

  # Verify services came up
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
  echo -e "${C_CYAN}${C_BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}"
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  banner
  detect_environment
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
