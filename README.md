<p align="center">
  <img alt="HyperProx" src="docs/hyperprox-banner-dark.svg" width="700" />
</p>

<div align="center">

```

**Your Proxmox infrastructure, hypercharged.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Docker](https://img.shields.io/badge/Docker-hyperprox%2Fhyperprox-2496ED?logo=docker)](https://hub.docker.com/r/hyperprox/hyperprox)
[![GitHub Stars](https://img.shields.io/github/stars/hyperprox/alpha?style=flat)](https://github.com/hyperprox/alpha/stargazers)

</div>

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

**Proxmox 8.x (recent versions):**
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

---

## Install

```bash
# Install curl if not already present
apt update && apt install -y curl

curl -fsSL https://raw.githubusercontent.com/hyperprox/alpha/main/install.sh | bash
```

The installer will:
- Detect your environment (LXC, VM, or bare metal)
- Fix DNS if Proxmox has injected internal resolvers
- Prompt to set a static IP if running DHCP
- Install Docker, Node.js, and all dependencies
- Build and start all services
- Open the setup wizard at `http://<your-ip>:3001`

Or with Docker Compose directly (after cloning the repo):

```bash
docker compose up -d
```

---

## Full functionality in the alpha

The setup wizard will offer to install the following as Docker containers. These are optional but required for the full alpha experience:

| Service | Why you need it |
|---|---|
| **Nginx Proxy Manager** | Required for proxy management — create hosts, SSL certs, and the full AI deployment wizard |
| **Prometheus** | Required for node metrics, alerts, and the monitoring page |
| **Grafana** | Required for dashboard graphs and the embedded monitoring view |

If you already have any of these running elsewhere on your cluster, skip the install and connect to your existing instances instead.

---

Running Proxmox in production means managing half a dozen separate tools that don't talk to each other:

- Nginx Proxy Manager for reverse proxying
- GoDaddy / Cloudflare for DNS
- Grafana + Prometheus for monitoring (manually configured)
- Separate SSH sessions to check node health, network mounts, storage status
- No visibility when a NAS goes offline and silently breaks monitoring

HyperProx replaces all of that with a single pane of glass — deployed in under five minutes.

---

## What's Built & Working

| Feature | Status |
|---|---|
| VM & LXC management — live metrics, power actions | ✅ Shipped |
| Nginx Proxy Manager full CRUD | ✅ Shipped |
| GoDaddy DNS — all record types, DDNS, stale IP detection, domain expiry | ✅ Shipped |
| Bundled Prometheus + Grafana — optional, installed via setup wizard | ✅ Shipped |
| Real-time WebSocket dashboard — nodes, GPU, CEPH, HA, network | ✅ Shipped |
| Storage page — CEPH health, OSD status, VM/CT disk breakdown | ✅ Shipped |
| Monitoring page — node health, active alerts, Grafana embed | ✅ Shipped |
| AES-256-GCM encrypted credential store | ✅ Shipped |
| One-shot installer + first-run setup wizard | ✅ Shipped |
| AI deployment wizard (Ollama-powered, plan + confirm) | ✅ Shipped |
| LXC creation — template picker, node resource limits, storage with free space | ✅ Shipped |
| VM creation — ISO auto-detection, network config, storage picker | ✅ Shipped |
| CT/VM deletion with confirmation guard | ✅ Shipped |
| CT template + ISO auto-detection across all nodes and storage pools | ✅ Shipped |

---

## Known Issues

| Issue | Status |
|---|---|
| **Ubuntu requires AppArmor disabled** — Docker inside a privileged LXC on Ubuntu fails due to AppArmor restrictions. AppArmor must be completely disabled before running the installer. Debian 12 is recommended and works out of the box. | 🔧 Fix in progress — installer will handle this automatically |
| **CEPH MON node not auto-detected** — the setup wizard should automatically detect which node runs the CEPH MON service and save it to `.env`. This detection is not working correctly, so CEPH status and storage overview will return errors on fresh installs. | 🔧 Fix in progress |

### Workarounds

**Ubuntu — disable AppArmor before installing** (or use Debian 12 to avoid this entirely):

```bash
# Disable AppArmor completely
systemctl stop apparmor
systemctl disable apparmor
apt-get remove -y apparmor
reboot
```

**CEPH MON node** — after completing the setup wizard, SSH into the HyperProx CT and set it manually:

```bash
# Find which node runs the CEPH MON service (run on any Proxmox node)
pvesh get /nodes/<node>/ceph/mon

# Set it in .env
echo "CEPH_MON_NODE=<nodename>" >> /opt/hyperprox/.env
docker compose -f /opt/hyperprox/docker-compose.yml restart hyperprox-api
```

---

## System Requirements

### Minimum (no local AI)
- 2 CPU cores · 4GB RAM · 40GB storage

### Recommended
- 4 CPU cores · 8GB RAM · 100GB SSD

### With Local AI (Ollama + GPU)
- 4 CPU cores · 16GB RAM · 16GB VRAM · 100GB storage

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
| ollama | Local AI *(optional)* | 11434 |
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
| AI | Ollama (optional local) |
| Containers | Docker · Compose |
| CI/CD | GitLab CI → Docker Hub |

---

## Roadmap

### v1.0 — The Glue Layer

- **Smart Suggestion Engine** — cross-system awareness: new proxy host → suggest DNS record, WAN IP change → flag stale A records, SSL expiring → suggest renewal. Nothing acts without user confirmation.
- **Network Storage Health** — monitor CIFS/NFS mounts across all nodes, surface offline mounts as named alerts, correlate mount failures with downstream monitoring issues. AI-assisted remediation suggestions.
- **AI deployment wizard** — the killer feature. Type `Deploy Nextcloud at cloud.mydomain.com` and HyperProx handles everything end-to-end: creates the LXC, configures the NPM proxy host, creates the DNS A record, polls for propagation, requests the SSL cert, and returns the live URL. No tab switching. No SSH. No manual anything. *(AI plan + confirm flow is live today — full autonomous execution coming in v1.0)*
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
- **CVE scanner** — detect known vulnerabilities across nodes and VMs
- **PVE hardening** — one-click security hardening for Proxmox hosts
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

Commercial licensing for MSPs and enterprise deployments — coming in v2.0.

---

<div align="center">
Built by <a href="https://griffinit.net">GriffinIT</a> — running on a real 5-node Proxmox cluster so every feature solves a real problem.
</div>
