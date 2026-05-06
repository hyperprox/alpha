<p align="center">
  <img alt="HyperProx" src="docs/hyperprox-banner.png" width="700" />
</p>

<p align="center">
  <strong>Your Proxmox infrastructure, hypercharged.</strong>
</p>

<p align="center">
  <a href="https://www.gnu.org/licenses/agpl-3.0"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3"></a>
  <a href="https://hub.docker.com/r/hyperprox/hyperprox"><img src="https://img.shields.io/badge/Docker-hyperprox%2Fhyperprox-2496ED?logo=docker" alt="Docker"></a>
  <a href="https://github.com/hyperprox/alpha/stargazers"><img src="https://img.shields.io/github/stars/hyperprox/alpha?style=flat" alt="GitHub Stars"></a>
</p>

---

HyperProx is an open-source infrastructure management platform built on top of Proxmox VE. It consolidates the tools that homelab operators and MSPs currently juggle — proxy management, DNS, SSL, monitoring, AI-driven deployments, and network storage health — into a single interface deployed with one command.

---

## Prerequisites

HyperProx runs inside a **dedicated LXC container** on your Proxmox node. Before running the installer, create and configure the container correctly.

### Create the LXC in Proxmox

**Recommended specs:**
- Debian 12 template
- 4 CPU cores · 8GB RAM · 100GB disk (SSD preferred)
- Network: bridge on your main LAN (e.g. `vmbr0`), static IP recommended

> **Minimum for testing (no Ollama):** 2 cores · 4GB RAM · 20GB disk

### Required LXC settings — critical

The container must be **privileged** with nesting and keyctl enabled. Without this, Docker will fail with an overlay filesystem error.

**Via Proxmox web UI:**
1. Create the LXC — check **Privileged container** during creation
2. After creation → **Options → Features** → enable **Nesting** and **keyctl**

**Via command line** — create the container with all required settings in one shot (run on your Proxmox node):

```bash
# 1. Download the Debian 12 template if not already available
pveam update
pveam download local debian-12-standard_12.12-1_amd64.tar.zst

# 2. Create the container (replace <CTID>, storage names, and IP as needed)
pct create <CTID> local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst \
  --hostname hyperprox \
  --cores 4 \
  --memory 8192 \
  --rootfs local-lvm:100 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged false \
  --features keyctl=1,nesting=1 \
  --password \
  --start 1
```

Or if the container already exists, enable the required features:

```bash
pct set <CTID> --features keyctl=1,nesting=1
pct reboot <CTID>
```

> The installer will detect missing nesting and warn you, but Docker will still fail. Always set these features before running the installer.

### Tailscale (optional)

If you want to access HyperProx remotely via Tailscale, the TUN device must be enabled on the LXC.

**Proxmox 8.x:**
```bash
pct set <CTID> --features keyctl=1,nesting=1,tun=1
pct reboot <CTID>
```

**Older Proxmox versions** (if the above returns a schema error):
```bash
echo "lxc.cgroup2.devices.allow: c 10:200 rwm" >> /etc/pve/lxc/<CTID>.conf
echo "lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file" >> /etc/pve/lxc/<CTID>.conf
pct reboot <CTID>
```

Then inside the CT:
```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
```

### Create the Proxmox API Token

Run on any Proxmox node:

```bash
pveum user token add root@pam hyperprox --privsep=0
pveum acl modify / --token 'root@pam!hyperprox' --role Administrator
```

Copy the token secret — it is only shown once.

### Get your GoDaddy API Key (DNS management)

GoDaddy DNS management requires a production API key. The OTE (test environment) keys will not work.

1. Go to [https://developer.godaddy.com/keys](https://developer.godaddy.com/keys) and sign in with your GoDaddy account
2. Click **Create New App**
3. Give it a name (e.g. `HyperProx`) and click **Next**
4. Under **Environment**, select **Production** — do not use OTE
5. Copy both the **API Key** and **API Secret** — the secret is only shown once

> Your GoDaddy account must have purchased domains associated with it. Reseller or sub-accounts may require additional permissions.

Enter both values in the HyperProx setup wizard when prompted for DNS credentials.

---

## Install

```bash
apt update && apt install -y curl
curl -fsSL https://raw.githubusercontent.com/hyperprox/alpha/main/install.sh | bash
```

The installer will:
- Detect your environment (LXC, VM, or bare metal)
- Fix DNS if Proxmox has injected internal resolvers
- Prompt to set a static IP if running DHCP
- Install Docker, Node.js, and all dependencies with live progress output
- Build and start all services
- Open the setup wizard at `http://<your-ip>:3001`

Or with Docker Compose directly (after cloning the repo):

```bash
docker compose up -d
```

---

## Monitoring — additional setup required

The monitoring page, node metrics, and wattage display require additional components installed on each Proxmox **host** (not inside the HyperProx CT). These are not installed automatically.

### node_exporter (required for all node metrics)

Install on every Proxmox node you want to monitor:

```bash
apt update && apt install -y prometheus-node-exporter
systemctl enable --now prometheus-node-exporter
```

Verify it's working:
```bash
curl -s http://localhost:9100/metrics | head -5
```

### Wattage display

Wattage is read from your CPU's built-in power counters (Intel RAPL / AMD energy) via node_exporter's `hwmon` collector, which is enabled by default. No additional configuration is required — if node_exporter is installed and your hardware exposes power data, wattage will appear automatically.

If wattage is missing on a specific node, the most likely causes are:
- node_exporter is not installed on that node
- The hardware or hypervisor doesn't expose CPU power counters (common in VMs and some older or embedded hardware)

### GPU metrics (optional — NVIDIA only)

If you have NVIDIA GPUs on any Proxmox node, install `nvidia_gpu_exporter`:

```bash
wget https://github.com/utkuozdemir/nvidia_gpu_exporter/releases/download/v1.1.0/nvidia_gpu_exporter_1.1.0_linux_amd64.tar.gz
tar -xzf nvidia_gpu_exporter_1.1.0_linux_amd64.tar.gz
mv nvidia_gpu_exporter /usr/local/bin/
chmod +x /usr/local/bin/nvidia_gpu_exporter

cat > /etc/systemd/system/nvidia_gpu_exporter.service << 'EOF'
[Unit]
Description=NVIDIA GPU Exporter
After=network.target

[Service]
ExecStart=/usr/local/bin/nvidia_gpu_exporter
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now nvidia_gpu_exporter
```

---

## AI Assistant — current state

The AI assistant is in early alpha. Here is exactly what works today and what doesn't.

**What works:**
- Connect to an **existing Ollama instance** running on your network — HyperProx does not bundle or install Ollama
- Enter a deployment request in natural language (e.g. `Deploy Nextcloud at cloud.mydomain.com`)
- HyperProx will generate a **step-by-step deployment plan** showing what it would do

**What does not work yet:**
- Plan execution — the Confirm button does not execute anything. The plan is display-only.
- Autonomous end-to-end deployment (CT creation → proxy → DNS → SSL) — this is the v1.0 target
- Any action beyond plan generation

**Connecting to Ollama:**

Enter your Ollama URL in Settings → AI. This must be an existing Ollama instance you are already running — for example `http://192.168.2.208:11434` if Ollama is running on another node or machine on your network.

> **Model recommendation:** `llama3.2:3b` works but produces inconsistent deployment plans. `qwen3:8b` or `deepseek-r1:8b` handle structured planning significantly better and are recommended if your hardware supports them.

---

## Full functionality in the alpha

> ⚠️ **The setup wizard monitoring install toggles are not yet functional.** Prometheus and Grafana containers must be started manually — see the workaround in [Known Issues](#known-issues).

The setup wizard will offer to install the following as Docker containers. These are optional but required for the full alpha experience:

| Service | Why you need it |
|---|---|
| **Nginx Proxy Manager** | Required for proxy management — create hosts, SSL certs, and the AI deployment wizard |
| **Prometheus** | Required for node metrics, alerts, and the monitoring page |
| **Grafana** | Required for dashboard graphs and the embedded monitoring view |

If you already have any of these running elsewhere on your cluster, skip the install and connect to your existing instances instead.

> ⚠️ **Connecting to an existing Grafana or Prometheus instance is not yet supported.** HyperProx currently only supports the bundled instances started via Docker Compose. Custom Grafana/Prometheus URLs are a v1.0 feature.

---

Running Proxmox in production means managing half a dozen separate tools that don't talk to each other: Nginx Proxy Manager for reverse proxying, GoDaddy or Cloudflare for DNS, Grafana and Prometheus for monitoring (manually configured), separate SSH sessions to check node health, and no visibility when a NAS goes offline and silently breaks monitoring.

HyperProx replaces all of that with a single pane of glass — deployed in under five minutes.

---

## What's Built & Working

| Feature | Status |
|---|---|
| VM & LXC management — live metrics, power actions | ✅ Shipped |
| Nginx Proxy Manager full CRUD | ✅ Shipped |
| GoDaddy DNS — all record types, DDNS, stale IP detection, domain expiry | ✅ Shipped |
| Bundled Prometheus + Grafana — manual start via Docker Compose | ✅ Shipped |
| Real-time WebSocket dashboard — nodes, GPU, CEPH, HA, network | ✅ Shipped |
| Storage page — CEPH health, OSD status, VM/CT disk breakdown | ✅ Shipped |
| Monitoring page — node health, active alerts, Grafana embed | ✅ Shipped |
| AES-256-GCM encrypted credential store | ✅ Shipped |
| One-shot installer + first-run setup wizard | ✅ Shipped |
| LXC creation — template picker, node resource limits, storage with free space | ✅ Shipped |
| VM creation — ISO auto-detection, network config, storage picker | ✅ Shipped |
| CT/VM deletion with confirmation guard | ✅ Shipped |
| CT template + ISO auto-detection across all nodes and storage pools | ✅ Shipped |
| AI deployment — plan generation from natural language (read-only) | ✅ Shipped |
| Setup wizard — one-click Prometheus + Grafana install | 🚧 v1.0 |
| AI deployment — plan execution and autonomous end-to-end workflow | 🚧 v1.0 |
| Connect to existing Grafana / Prometheus instance | 🚧 v1.0 |

---

## Known Issues

| Issue | Status |
|---|---|
| **Setup wizard monitoring install toggles do nothing** — the Prometheus and Grafana install toggles in the setup wizard are UI-only and do not start the containers. They must be started manually. | 🔧 Fix in progress |
| **Grafana not connecting to Prometheus** — on some Docker setups `host.docker.internal` doesn't resolve inside the Grafana container, causing the Prometheus datasource to show as disconnected and all graphs to be blank. | 🔧 Fix in progress |
| **Ubuntu requires AppArmor disabled** — Docker inside a privileged LXC on Ubuntu fails due to AppArmor restrictions. Debian 12 is recommended and works out of the box. | 🔧 Fix in progress |
| **CEPH MON node not auto-detected** — the setup wizard attempts to detect which node runs the CEPH MON service, but detection is unreliable on fresh installs. CEPH status and storage overview will return errors until set manually. | 🔧 Fix in progress |

### Workarounds

**Start Prometheus and Grafana manually** (until setup wizard install is fixed):
```bash
cd /opt/hyperprox
docker compose --profile monitoring up -d
```

**Grafana not connecting to Prometheus:**
```bash
sed -i '/container_name: hyperprox-grafana/{n;s/restart: unless-stopped/extra_hosts:\n      - "host.docker.internal:host-gateway"\n    restart: unless-stopped/}' /opt/hyperprox/docker-compose.yml
docker rm -f hyperprox-grafana
docker compose --profile monitoring up -d grafana
```

**Ubuntu — disable AppArmor before installing:**
```bash
systemctl stop apparmor
systemctl disable apparmor
apt-get remove -y apparmor
reboot
```

**CEPH MON node** — after the setup wizard completes, set it manually:
```bash
# Find which node runs CEPH MON (run on any Proxmox node)
pvesh get /nodes/<node>/ceph/mon

# Set it in .env
echo "CEPH_MON_NODE=<nodename>" >> /opt/hyperprox/.env
docker compose -f /opt/hyperprox/docker-compose.yml restart hyperprox-api
```

---

## System Requirements

### Minimum (testing, no local AI)
- 2 CPU cores · 4GB RAM · 20GB storage

### Recommended
- 4 CPU cores · 8GB RAM · 100GB SSD

### With Local AI (Ollama + GPU)
- Ollama runs on a **separate machine or node** — not inside the HyperProx CT
- 16GB RAM · 16GB VRAM recommended for the Ollama host

### Prometheus Storage Planning

| Cluster Size | 90-day Retention |
|---|---|
| 5 nodes, 50 CTs | ~45GB |
| 10 nodes, 100 CTs | ~90GB |

The setup wizard calculates recommended storage automatically based on your cluster size.

---

## Architecture

Single `docker compose up` deploys the full stack:

| Service | Purpose | Port |
|---|---|---|
| hyperprox-frontend | Next.js dashboard | 3000 |
| hyperprox-api | Fastify API + WebSockets | 3002 |
| hyperprox-setup | First-run setup wizard | 3001 |
| prometheus | Metrics collection *(optional)* | 9090 |
| grafana | Visualization *(optional)* | 3003 |
| nginx-proxy-manager | Reverse proxy + SSL *(optional)* | 80, 81, 443 |
| postgres | Config + state storage | 5432 |
| redis | Queue + cache | 6379 |
| nginx | Internal reverse proxy | 80/443 |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14+ · shadcn/ui |
| Backend | Node.js · Fastify |
| Real-time | WebSockets |
| Database | PostgreSQL · Prisma ORM |
| Queue | BullMQ · Redis |
| Monitoring | Prometheus · Grafana (bundled, auto-configured) |
| AI | Ollama (external, optional) |
| Containers | Docker · Compose |
| CI/CD | GitLab CI → Docker Hub |

---

## Roadmap

### v1.0 — The Glue Layer

- **Setup wizard — working install toggles** for Prometheus, Grafana, and NPM
- **Connect to existing Grafana / Prometheus** — use your own monitoring stack instead of the bundled containers
- **Smart Suggestion Engine** — cross-system awareness: new proxy host → suggest DNS record, WAN IP change → flag stale A records, SSL expiring → suggest renewal. Nothing acts without user confirmation.
- **Network Storage Health** — monitor CIFS/NFS mounts across all nodes, surface offline mounts as named alerts, correlate mount failures with downstream monitoring issues.
- **AI deployment wizard — full autonomous execution** — type `Deploy Nextcloud at cloud.mydomain.com` and HyperProx handles everything end-to-end: creates the LXC, configures the NPM proxy host, creates the DNS A record, polls for propagation, requests the SSL cert, and returns the live URL. No tab switching. No SSH. No manual anything.
- **Multi-provider DNS** — GoDaddy + Cloudflare + Namecheap simultaneously
- **Multi-instance proxy** — NPM + Traefik + Caddy + HAProxy + Pangolin simultaneously
- **Proxmox rolling updates** — CEPH-aware, per-node sequencing
- **HyperProx self-update** — one-click from UI
- **PBS backup monitoring** — datastore usage, job history, retention policies
- **GitOps export** — encrypted YAML backup/restore of entire HyperProx configuration

### v2.0 — The Platform

- **Bare metal Proxmox installer** — custom ISO/PXE with HyperProx baked in
- **Post-install bootstrap wizard** — networking, storage, cluster formation
- **Node expansion** — add new nodes to existing clusters from the dashboard
- **Multi-cluster management** — unlimited clusters from one UI
- **Cross-cluster live migration** — move VMs between clusters with zero downtime
- **ESXi live migration** — import VMware workloads directly into Proxmox
- **XCP-NG support** — manage Xen alongside Proxmox
- **VPN management** — WireGuard + Tailscale + Pangolin
- **CVE scanner + PVE hardening**
- **Role-based access control (RBAC)**
- **LDAP / OIDC / SSO support**
- **Commercial licensing tier** — MSPs and enterprise deployments

See [ROADMAP.md](ROADMAP.md) for full details.

---

## vs. The Alternatives

| Feature | HyperProx | PegaProx | PDM | Coolify/Dokploy |
|---|---|---|---|---|
| Proxy management | ✅ | ❌ | ❌ | Partial |
| DNS management | ✅ | ❌ | ❌ | ❌ |
| SSL lifecycle | ✅ | ❌ | ❌ | Partial |
| Network storage health | ✅ v1.0 | ❌ | ❌ | ❌ |
| Smart suggestion engine | ✅ v1.0 | ❌ | ❌ | ❌ |
| AI deployment wizard | ✅ v1.0 | ❌ | ❌ | ❌ |
| Bundled monitoring | ✅ | ❌ | ❌ | ❌ |
| Docker install | ✅ | ❌ | ❌ | ✅ |
| curl \| bash install | ✅ | ✅ | ❌ | ✅ |
| Multi-cluster | ✅ v2.0 | ✅ | ✅ | ❌ |
| Cross-cluster migration | ✅ v2.0 | ✅ | ❌ | ❌ |
| ESXi migration | ✅ v2.0 | ✅ | ❌ | ❌ |
| XCP-NG support | ✅ v2.0 | ✅ | ❌ | ❌ |
| VPN management | ✅ v2.0 | ❌ | ❌ | ❌ |
| RBAC | ✅ v2.0 | ✅ | ✅ | Partial |
| CVE scanner | ✅ v2.0 | ✅ | ❌ | ❌ |
| PVE hardening | ✅ v2.0 | ✅ | ❌ | ❌ |
| Bare metal installer | ✅ v2.0 | ❌ | ✅ | ❌ |
| Load balancing (DRS) | ❌ | ✅ | ❌ | ❌ |
| Free & open source | ✅ AGPL v3 | ✅ AGPL v3 | ✅ AGPL v3 | ✅ |

**HyperProx owns the application delivery layer. No competitor connects proxy + DNS + SSL + AI + network storage health in a single platform.**

---

## Contributing

Bug reports, feature requests, and pull requests welcome via [GitHub Issues](https://github.com/hyperprox/alpha/issues).

---

## License

[AGPL v3](LICENSE) — free for personal and open-source use.

Commercial licensing for MSPs and enterprise deployments coming in v2.0.

---

<p align="center">
  Built by <a href="https://griffinit.net">GriffinIT</a> — running on a real 5-node Proxmox cluster so every feature solves a real problem.
</p>
