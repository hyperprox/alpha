<div align="center">

```
 ██╗  ██╗██╗   ██╗██████╗ ███████╗██████╗ ██████╗ ██████╗  ██████╗ ██╗  ██╗
 ██║  ██║╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔══██╗██╔═══██╗╚██╗██╔╝
 ███████║ ╚████╔╝ ██████╔╝█████╗  ██████╔╝██████╔╝██████╔╝██║   ██║ ╚███╔╝
 ██╔══██║  ╚██╔╝  ██╔═══╝ ██╔══╝  ██╔══██╗██╔═══╝ ██╔══██╗██║   ██║ ██╔██╗
 ██║  ██║   ██║   ██║     ███████╗██║  ██║██║     ██║  ██║╚██████╔╝██╔╝ ██╗
 ╚═╝  ╚═╝   ╚═╝   ╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝
```

**Your Proxmox infrastructure, hypercharged.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Docker](https://img.shields.io/badge/Docker-hyperprox%2Fhyperprox-2496ED?logo=docker)](https://hub.docker.com/r/hyperprox/hyperprox)
[![GitHub Stars](https://img.shields.io/github/stars/hyperprox/hyperprox?style=flat)](https://github.com/hyperprox/hyperprox/stargazers)

</div>

---

HyperProx is an open-source infrastructure management platform built on top of Proxmox VE. It consolidates the tools that homelab operators and MSPs currently juggle — proxy management, DNS, SSL, monitoring, and AI-driven deployments — into a single interface deployed with one command.

## Features

### Infrastructure Management
- Real-time dashboard for all nodes, VMs, and LXCs
- GPU monitoring with per-consumer VRAM breakdown
- Network utilization per node with CEPH I/O
- CEPH pool health, OSD status, rebalance tracking
- HA cluster status and state management
- Full VM/CT lifecycle — start, stop, reboot, migrate, snapshot
- Browser-based noVNC console

### Proxy Management
- **Nginx Proxy Manager** — full host CRUD, SSL cert lifecycle
- Enable/disable hosts, dead link detection, cert expiry alerts
- Let's Encrypt automation
- *(Traefik, Caddy, HAProxy, Pangolin — coming in v1.x)*

### DNS Management
- **GoDaddy** — full record CRUD (A, AAAA, CNAME, TXT, MX, SRV, NS)
- WAN IP auto-detection, DDNS per interface
- Propagation polling, stale IP flagging
- Domain expiry monitoring
- *(Cloudflare, Namecheap — coming in v1.x)*

### Monitoring
- Prometheus + Grafana bundled and auto-configured
- Zero manual setup — metrics server enabled via Proxmox API automatically
- `node_exporter` deployed to all nodes automatically
- Pre-built dashboards provisioned on first run

### Settings
- AES-256-GCM encrypted credential store
- Test connection buttons for all providers
- Multi-provider architecture — connect multiple DNS/proxy instances

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/hyperprox/alpha.git
cd alpha

# 2. Configure your environment
cp .env.example .env
nano .env

# 3. Start HyperProx
docker compose up -d

# 4. Open the dashboard
# http://your-server-ip
```

---

## System Requirements

| | Minimum | Recommended |
|---|---|---|
| CPU | 2 cores | 4 cores |
| RAM | 4 GB | 8 GB |
| Storage | 40 GB | 100 GB SSD |
| OS | Any Docker host | Debian 12 / Ubuntu 22.04 |

> **Running Ollama for local AI?** Add 16 GB RAM and a GPU with 8 GB+ VRAM.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     HyperProx Stack                     │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ Frontend │  │   API    │  │  Setup   │             │
│  │ Next.js  │  │ Fastify  │  │ Wizard   │             │
│  │  :3000   │  │  :3002   │  │  :3001   │             │
│  └──────────┘  └──────────┘  └──────────┘             │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ Postgres │  │  Redis   │  │  Nginx   │             │
│  │  :5432   │  │  :6379   │  │  80/443  │             │
│  └──────────┘  └──────────┘  └──────────┘             │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │Prometheus│  │ Grafana  │  │  Ollama  │             │
│  │  :9090   │  │  :3003   │  │ optional │             │
│  └──────────┘  └──────────┘  └──────────┘             │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   Proxmox Cluster                       │
│   titan1  │  titan2  │  titan3  │  titan4  │  titan7   │
└─────────────────────────────────────────────────────────┘
```

---

## Roadmap

### v0.1 — Alpha (current)
- [x] Dashboard — nodes, GPU, network, CEPH, HA
- [x] Infrastructure — VM/CT management, console, snapshots, migrate
- [x] Proxy — NPM integration, SSL lifecycle
- [x] DNS — GoDaddy integration, DDNS, propagation
- [x] Storage — volumes, CEPH pools, OSDs
- [x] Settings — encrypted credential store

### v1.0
- [ ] Setup wizard — guided first-run with auto-detection
- [ ] AI deployment wizard — "Deploy Nextcloud at cloud.mydomain.com"
- [ ] Traefik + Caddy proxy support
- [ ] Cloudflare + Namecheap DNS support
- [ ] Multi-instance proxy management
- [ ] Multi-provider DNS management
- [ ] PBS backup monitoring
- [ ] Proxmox rolling updates

### v2.0
- [ ] Proxmox bare metal installer (ISO/PXE)
- [ ] Node expansion wizard
- [ ] VPN management (WireGuard, Tailscale)
- [ ] HAProxy + Pangolin support
- [ ] MSP multi-cluster management

---

## vs. The Alternatives

| Feature | HyperProx | Proxmox PDM | PegaProx |
|---|---|---|---|
| Proxy management | ✅ | ❌ | ❌ |
| DNS management | ✅ | ❌ | ❌ |
| SSL lifecycle | ✅ | ❌ | ❌ |
| AI deployment | ✅ roadmap | ❌ | ❌ |
| Bundled monitoring | ✅ | ❌ | ❌ |
| Docker install | ✅ | ❌ | ❌ |
| Free & open source | ✅ | ❌ | ✅ |
| Multi-cluster | Soon | ✅ | ✅ |

---

## Contributing

HyperProx is built in public and contributions are welcome.

Bug reports, feature requests, and pull requests all welcome via GitHub Issues.

---

## License

[AGPL v3](LICENSE) — free for personal and open-source use.

Commercial licensing for MSPs and enterprise deployments — coming soon.

---

<div align="center">
Built by <a href="https://griffinit.net">GriffinIT</a> — running on a real 5-node Proxmox cluster so every feature solves a real problem.
</div>
