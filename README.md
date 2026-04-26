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
[![GitHub Stars](https://img.shields.io/github/stars/hyperprox/alpha?style=flat)](https://github.com/hyperprox/alpha/stargazers)

</div>

---

HyperProx is an open-source infrastructure management platform built on top of Proxmox VE. It consolidates the tools that homelab operators and MSPs currently juggle — proxy management, DNS, SSL, monitoring, VPN, and AI-driven deployments — into a single interface deployed with one command.

The vision is simple: **HyperProx is the Proxmox experience, from first boot to running production services.**

---

## Current Features (v0.1 Alpha)

### Infrastructure Management
- Real-time dashboard for all nodes, VMs, and LXCs
- GPU monitoring with per-consumer VRAM breakdown (Plex, Ollama, etc.)
- Network utilization per node with CEPH I/O
- CEPH pool health, OSD status, rebalance tracking
- HA cluster status and state management
- Full VM/CT lifecycle — start, stop, reboot, migrate, snapshot
- Browser-based noVNC console

### Proxy Management
- **Nginx Proxy Manager** — bring your own or HyperProx installs it
- Full host CRUD, SSL cert lifecycle, Let's Encrypt automation
- Enable/disable hosts, cert expiry alerts

### DNS Management
- **GoDaddy** — bring your own credentials, manage multiple domains
- Full record CRUD (A, AAAA, CNAME, TXT, MX, SRV, NS)
- WAN IP auto-detection, DDNS per interface
- Propagation polling, stale IP flagging, domain expiry monitoring

### Monitoring
- Prometheus + Grafana bundled and auto-configured — zero manual setup
- Proxmox metrics server enabled via API automatically
- `node_exporter` deployed to all nodes automatically
- Pre-built dashboards provisioned on first run

### Settings
- AES-256-GCM encrypted credential store
- Test connection buttons for all providers
- Feature enablement model — connect providers progressively

---

## Quick Start

```bash
git clone https://github.com/hyperprox/alpha.git
cd alpha
cp .env.example .env
nano .env
docker compose up -d
```

Open `http://your-server-ip` — dashboard is live.

---

## System Requirements

| | Minimum | Recommended |
|---|---|---|
| CPU | 2 cores | 4 cores |
| RAM | 4 GB | 8 GB |
| Storage | 40 GB | 100 GB SSD |
| OS | Any Docker host | Debian 12 / Ubuntu 22.04 |

> **With local AI (Ollama):** 16 GB RAM + GPU with 8 GB+ VRAM recommended.

> **Prometheus storage:** 5 nodes, 50 containers, 90-day retention ≈ 45 GB.

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
- [ ] **Smart Suggestion Engine** — HyperProx watches both proxy and DNS simultaneously and suggests cross-system actions without acting automatically:
  - New NPM proxy host detected → suggest creating matching DNS record
  - New GoDaddy DNS record detected → suggest creating matching proxy host
  - WAN IP change detected → suggest updating all stale A records
  - SSL cert expiring → suggest renewal before it lapses
  - Suggestions surface as a persistent panel on the dashboard with one-click approve or dismiss — nothing happens until the user confirms
- [ ] Setup wizard — guided first-run with auto-detection of existing services
- [ ] Bring Your Own vs HyperProx Managed — install NPM, Grafana, Ollama from UI
- [ ] AI deployment wizard — type "Deploy Nextcloud at cloud.mydomain.com", HyperProx handles container, proxy, DNS, SSL end to end
- [ ] Multi-instance proxy — manage NPM, Traefik, and Caddy simultaneously
- [ ] Multi-provider DNS — manage domains across GoDaddy, Cloudflare, Namecheap from one interface
- [ ] Traefik + Caddy proxy support
- [ ] Cloudflare + Namecheap DNS support
- [ ] Proxmox rolling updates — CEPH-aware, per-node sequencing, reboot detection
- [ ] HyperProx self-update — one-click updates from GitHub releases
- [ ] PBS backup monitoring
- [ ] Unified SSL cert expiry view across all proxy instances
- [ ] Domain expiry alerts

### v2.0
- [ ] Proxmox bare metal installer — custom ISO/PXE with HyperProx baked in
- [ ] Post-install bootstrap wizard — networking, storage, cluster formation
- [ ] Node expansion — add new nodes to existing cluster from the dashboard
- [ ] Proxmox major version upgrade wizard
- [ ] VPN management — WireGuard peer CRUD, config generation, key rotation
- [ ] Tailscale integration — node mesh visibility, ACL management
- [ ] Pangolin native integration — zero-port-forward tunnel + proxy + DNS
- [ ] HAProxy support
- [ ] MSP multi-cluster management
- [ ] Role-based access control
- [ ] Commercial licensing tier

---

## vs. The Alternatives

| Feature | HyperProx | Proxmox PDM | PegaProx |
|---|---|---|---|
| Proxy management | ✅ | ❌ | ❌ |
| DNS management | ✅ | ❌ | ❌ |
| SSL lifecycle | ✅ | ❌ | ❌ |
| Smart suggestion engine | ✅ v1.0 | ❌ | ❌ |
| AI deployment wizard | ✅ v1.0 | ❌ | ❌ |
| VPN management | ✅ v2.0 | ❌ | ❌ |
| Bare metal installer | ✅ v2.0 | ❌ | ❌ |
| Bundled monitoring | ✅ | ❌ | ❌ |
| Docker install | ✅ | ❌ | ❌ |
| Free & open source | ✅ | ❌ | ✅ |
| Multi-cluster | v2.0 | ✅ | ✅ |
| Load balancing / DRS | v2.0 | ✅ | ✅ |

---

## Contributing

HyperProx is built in public. Bug reports, feature requests, and pull requests welcome via GitHub Issues.

---

## License

[AGPL v3](LICENSE) — free for personal and open-source use.

Commercial licensing for MSPs and enterprise deployments — coming in v2.0.

---

<div align="center">
Built by <a href="https://griffinit.net">GriffinIT</a> — running on a real 5-node Proxmox cluster so every feature solves a real problem.
</div>
