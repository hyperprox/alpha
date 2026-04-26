#!/usr/bin/env bash
# =============================================================================
#  HyperProx — Directory Scaffold + Config Generator
#  Run inside CT 751: bash hyperprox-scaffold.sh
#  Creates the full /opt/hyperprox/ structure and all mounted config files
# =============================================================================

set -euo pipefail

BASE="/opt/hyperprox"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; RESET='\033[0m'
log()  { echo -e "${CYAN}[SCAFFOLD]${RESET} $*"; }
ok()   { echo -e "${GREEN}[  OK  ]${RESET} $*"; }
warn() { echo -e "${YELLOW}[ WARN ]${RESET} $*"; }

# =============================================================================
#  DIRECTORY TREE
# =============================================================================

log "Creating directory structure..."

mkdir -p \
  $BASE/config/nginx/conf.d \
  $BASE/config/postgres \
  $BASE/config/prometheus/rules \
  $BASE/config/grafana/provisioning/datasources \
  $BASE/config/grafana/provisioning/dashboards \
  $BASE/config/grafana/dashboards \
  $BASE/data/postgres \
  $BASE/data/redis \
  $BASE/data/prometheus \
  $BASE/data/grafana \
  $BASE/data/ollama \
  $BASE/certs \
  $BASE/logs \
  $BASE/backups

ok "Directory tree created."

# =============================================================================
#  NGINX — Main config
# =============================================================================

log "Writing Nginx config..."

cat > $BASE/config/nginx/nginx.conf << 'EOF'
user  nginx;
worker_processes  auto;
error_log  /var/log/nginx/error.log warn;
pid        /var/run/nginx.pid;

events {
    worker_connections  1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent"';

    access_log  /var/log/nginx/access.log  main;

    sendfile        on;
    keepalive_timeout  65;
    client_max_body_size 50M;

    # Gzip
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    include /etc/nginx/conf.d/*.conf;
}
EOF

# ---------------------------------------------------------------------------
#  NGINX — Proxy routing
# ---------------------------------------------------------------------------

cat > $BASE/config/nginx/conf.d/hyperprox.conf << 'EOF'
upstream frontend  { server frontend:3000; keepalive 32; }
upstream api       { server api:3002;      keepalive 32; }
upstream setup     { server setup:3001;    keepalive 16; }
upstream grafana   { server grafana:3003;  keepalive 16; }
upstream prometheus { server prometheus:9090; keepalive 8; }

server {
    listen 80;
    server_name _;

    location /nginx-health {
        access_log off;
        return 200 "ok\n";
        add_header Content-Type text/plain;
    }

    location /setup {
        proxy_pass         http://setup;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    location /api {
        proxy_pass         http://api;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    location /ws {
        proxy_pass          http://api;
        proxy_http_version  1.1;
        proxy_set_header    Upgrade    $http_upgrade;
        proxy_set_header    Connection "upgrade";
        proxy_set_header    Host       $host;
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
    }

    location /grafana/ {
        proxy_pass         http://grafana/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    location /prometheus/ {
        proxy_pass         http://prometheus/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        allow              192.168.0.0/16;
        deny               all;
    }

    location / {
        proxy_pass         http://frontend;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
EOF

ok "Nginx config written."

# =============================================================================
#  POSTGRES — Init SQL
# =============================================================================

log "Writing Postgres init script..."

cat > $BASE/config/postgres/init.sql << 'EOF'
-- HyperProx — Postgres initialisation
-- Prisma migrations handle schema — this just sets up extensions and tuning

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- fuzzy search on names
CREATE EXTENSION IF NOT EXISTS "btree_gin"; -- composite index support

-- Tune for container workload
ALTER SYSTEM SET shared_buffers = '256MB';
ALTER SYSTEM SET effective_cache_size = '512MB';
ALTER SYSTEM SET work_mem = '16MB';
ALTER SYSTEM SET maintenance_work_mem = '64MB';
ALTER SYSTEM SET checkpoint_completion_target = '0.9';
ALTER SYSTEM SET wal_buffers = '16MB';
ALTER SYSTEM SET log_min_duration_statement = '1000'; -- log slow queries >1s
EOF

ok "Postgres init script written."

# =============================================================================
#  PROMETHEUS — Scrape config
# =============================================================================

log "Writing Prometheus config..."

cat > $BASE/config/prometheus/prometheus.yml << 'EOF'
global:
  scrape_interval:     15s
  evaluation_interval: 15s
  external_labels:
    cluster: 'titancluster'
    environment: 'homelab'

rule_files:
  - /etc/prometheus/rules/*.yml

alerting:
  alertmanagers: []   # wire up Alertmanager in v1

scrape_configs:

  # Prometheus self-monitoring
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  # HyperProx API metrics
  - job_name: 'hyperprox-api'
    static_configs:
      - targets: ['api:3002']
    metrics_path: /metrics

  # Proxmox nodes — populated dynamically by HyperProx API
  # These are placeholders; the API will reload prometheus config via /-/reload
  - job_name: 'proxmox-nodes'
    file_sd_configs:
      - files:
          - /etc/prometheus/targets/nodes.json
        refresh_interval: 30s

  # Proxmox VE exporter (pve-exporter)
  - job_name: 'pve'
    file_sd_configs:
      - files:
          - /etc/prometheus/targets/pve.json
        refresh_interval: 30s
    metrics_path: /pve
    params:
      module: [default]
EOF

# Placeholder target files (API will overwrite these)
mkdir -p $BASE/config/prometheus/targets

cat > $BASE/config/prometheus/targets/nodes.json << 'EOF'
[
  {
    "targets": ["192.168.2.208:9100"],
    "labels": { "node": "titan7", "role": "gpu" }
  }
]
EOF

cat > $BASE/config/prometheus/targets/pve.json << 'EOF'
[
  {
    "targets": ["192.168.2.208:9221"],
    "labels": { "node": "titan7" }
  }
]
EOF

# Alert rules — basic cluster health
cat > $BASE/config/prometheus/rules/cluster.yml << 'EOF'
groups:
  - name: cluster_health
    rules:
      - alert: NodeDown
        expr: up{job="proxmox-nodes"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Node {{ $labels.node }} is down"

      - alert: HighCPU
        expr: 100 - (avg by(node) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 90
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High CPU on {{ $labels.node }}: {{ $value }}%"

      - alert: HighMemory
        expr: (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100 > 90
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High memory on {{ $labels.node }}: {{ $value }}%"

      - alert: DiskSpaceLow
        expr: (1 - (node_filesystem_avail_bytes / node_filesystem_size_bytes)) * 100 > 85
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Disk {{ $labels.mountpoint }} on {{ $labels.node }} at {{ $value }}%"
EOF

ok "Prometheus config written."

# =============================================================================
#  GRAFANA — Provisioning
# =============================================================================

log "Writing Grafana provisioning..."

# Datasource — Prometheus
cat > $BASE/config/grafana/provisioning/datasources/prometheus.yml << 'EOF'
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
    jsonData:
      timeInterval: "15s"
      httpMethod: POST
EOF

# Dashboard provider
cat > $BASE/config/grafana/provisioning/dashboards/provider.yml << 'EOF'
apiVersion: 1

providers:
  - name: HyperProx
    orgId: 1
    folder: HyperProx
    folderUid: hyperprox
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: true
    options:
      path: /etc/grafana/dashboards
EOF

# Placeholder dashboard (real ones generated by API on first run)
cat > $BASE/config/grafana/dashboards/hyperprox-overview.json << 'EOF'
{
  "title": "HyperProx — Cluster Overview",
  "uid": "hyperprox-overview",
  "tags": ["hyperprox"],
  "timezone": "browser",
  "schemaVersion": 38,
  "version": 1,
  "panels": [
    {
      "id": 1,
      "type": "text",
      "title": "HyperProx",
      "gridPos": { "h": 4, "w": 24, "x": 0, "y": 0 },
      "options": {
        "mode": "markdown",
        "content": "# HyperProx — TitanCluster\nDashboards are provisioned automatically on first run. Connect your Proxmox cluster in the setup wizard to populate metrics."
      }
    }
  ]
}
EOF

ok "Grafana provisioning written."

# =============================================================================
#  PERMISSIONS
# =============================================================================

log "Setting permissions..."

# Grafana runs as UID 472
chown -R 472:472 $BASE/data/grafana $BASE/config/grafana

# Prometheus runs as UID 65534 (nobody)
chown -R 65534:65534 $BASE/data/prometheus $BASE/config/prometheus

# Everything else — root (running as root in CT)
chmod -R 755 $BASE/config
chmod -R 755 $BASE/data

ok "Permissions set."

# =============================================================================
#  SUMMARY
# =============================================================================

echo ""
echo -e "${BOLD}${CYAN}============================================${RESET}"
echo -e "${BOLD}${CYAN}  HyperProx Scaffold Complete${RESET}"
echo -e "${BOLD}${CYAN}============================================${RESET}"
echo ""

tree $BASE -L 3 --dirsfirst 2>/dev/null || find $BASE -maxdepth 3 -print | sort

echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo -e "  1. Copy ${CYAN}docker-compose.yml${RESET} and ${CYAN}.env${RESET} to ${CYAN}$BASE/${RESET}"
echo -e "  2. ${CYAN}cd $BASE && docker compose up -d${RESET}"
echo -e "  3. Open ${CYAN}http://192.168.2.251/setup${RESET} to run the setup wizard"
echo ""
