# HyperProx — Roadmap

> *"Your Proxmox infrastructure, hypercharged."*
>
> Built by [GriffinIT](https://griffinit.net) — every feature comes from real operational pain running TitanCluster, a 5-node Proxmox homelab with 26+ containers.

---

## Current State (v0.1.0-alpha)

### Shipped & Working
- Full VM/CT management with live metrics and power actions
- Nginx Proxy Manager full CRUD (27 real hosts running in production)
- GoDaddy DNS full CRUD — all record types, DDNS, stale IP detection, domain expiry tracking
- Bundled Prometheus + Grafana — zero manual setup, auto-configured on install
- Real-time WebSocket dashboard — 5 nodes, GPU panel, CEPH, HA, network activity
- Monitoring page — node health cards, active alerts, Grafana embed
- Storage page — CEPH pool health, OSD status, VM/CT disk breakdown
- AES-256-GCM encrypted credential store
- One-shot installer + first-run setup wizard
- Intent-driven DNS record creation wizard
- AI deployment wizard (basic — Ollama-powered, plan + confirm flow)

---

## v1.0 — The Glue Layer

The complete single-cluster operational platform. Everything a homelab or small business operator needs to run Proxmox in production without SSH spelunking.

### Smart Suggestion Engine
Cross-system awareness that surfaces actionable recommendations without acting automatically. User confirms every action.
- New NPM proxy host detected → suggest creating matching DNS record
- WAN IP change detected → flag all stale A records, offer one-click bulk update
- SSL cert expiring within 30 days → suggest renewal
- New node joined cluster → suggest deploying node_exporter
- Container stopped unexpectedly → surface in dashboard with last-known state

### AI Deployment Wizard
Type a natural language command, HyperProx plans and executes the full deployment flow.
1. Creates LXC in Proxmox with appropriate resources
2. Configures NPM proxy host
3. Creates DNS A record
4. Polls for propagation
5. Requests Let's Encrypt SSL cert
6. Returns live URL

Preview & Diff stage shows the full action plan before anything executes. User confirms or aborts.

### Network Storage Health ⭐ NEW
Born from real operational experience: an offline CIFS/NFS mount silently caused 10-second node_exporter scrape timeouts, triggering false NodeDown alerts with no obvious cause. HyperProx should surface this immediately.

- Poll CIFS/NFS/NFS4 mount status across all nodes via Proxmox API
- Storage page — dedicated **Network Mounts** section alongside CEPH and local disks
  - Mount point, remote host, protocol, node, status (Online / Unreachable / Degraded)
  - Last seen online timestamp for unreachable mounts
- Active alerts — named alerts: *"NAS-Storage (CIFS) unreachable on node1"* not just *"NodeDown"*
- Root cause correlation — when a node's Prometheus scrape is slow or failing, check for offline mounts on that node and surface as the likely cause
- AI assistant awareness — *"node1's node_exporter is slow because a network mount is unreachable. Would you like me to unmount it temporarily to restore monitoring?"*
- Alert auto-resolution when mount comes back online

### Multi-Provider DNS
- GoDaddy — full support (shipped)
- Cloudflare — v1.0
- Namecheap — v1.0
- Route 53, Porkbun — v1.0
- Domain-centric model — per-domain provider assignment, not per-account

### Multi-Instance Proxy
- NPM — full support (shipped)
- Traefik — v1.0
- Caddy — v1.0
- HAProxy — v1.0
- Pangolin — v1.0
- Bring Your Own vs HyperProx Managed model
- Multiple providers simultaneously from one interface

### Infrastructure
- Proxmox rolling updates — CEPH-aware, per-node sequencing, reboot detection
- HyperProx self-update — GitHub releases API, one-click update from UI
- PBS backup monitoring — datastore usage, job history, retention policies
- Unified SSL cert expiry view across all proxy instances

### Setup & Onboarding
- Setup wizard — first-run auto-detection of existing services (shipped)
- Bring Your Own vs HyperProx Managed — install NPM, Grafana, Ollama from UI

### GitOps Export
- Point-in-time YAML export of entire HyperProx configuration
- Passphrase-encrypted credentials (PBKDF2 + AES-256-GCM)
- Restore via setup wizard on fresh instance — full recovery in under a minute
- Schema versioned for forward compatibility

---

## v2.0 — The Platform

Expanding from single-cluster homelab to multi-cluster, multi-hypervisor infrastructure management.

### Multi-Cluster Management
- Unlimited clusters from one UI
- Unified dashboard across all clusters
- Cross-cluster resource visibility
- Per-cluster credential management

### Cross-Cluster Live Migration
- Move VMs between different Proxmox VE clusters with zero downtime
- Automatic resource verification before migration
- Migration progress tracking and rollback support

### ESXi Live Migration
- Import VMware ESXi workloads directly into Proxmox VE
- Live migration support — no downtime
- Automatic disk format conversion, network mapping wizard
- **Strategic note:** Broadcom's VMware acquisition has driven mass exodus from VMware. This targets organizations actively migrating off VMware right now.

### XCP-NG Support
- Manage Xen/XCP-NG infrastructure alongside Proxmox VE from the same UI
- Full pool and VM lifecycle management for Xen workloads

### Bare Metal Lifecycle
- Proxmox bare metal installer — custom ISO/PXE with HyperProx baked in
- Post-install bootstrap wizard — networking, storage, cluster formation
- Node expansion — add new nodes to existing cluster from the dashboard
- Proxmox major version upgrade wizard

### VPN Management
- WireGuard — peer CRUD, config generation, key rotation, QR code export
- Tailscale — node mesh visibility, ACL management (API-driven)
- Pangolin — zero-port-forward tunnel + proxy + DNS native integration
- Bring Your Own vs HyperProx Managed model (consistent with proxy/DNS)

### Security
- CVE Scanner — detect known vulnerabilities across nodes and VMs
- PVE Hardening — automated one-click security hardening for Proxmox hosts
- Audit trails — full log of all actions taken through HyperProx

### Access Control
- Role-based access control (RBAC) — granular permissions at cluster, node, and VM level
- LDAP / Active Directory integration
- OIDC / SSO support (Microsoft Entra ID, Google, etc.)

### Commercial Licensing Tier
- Community tier remains AGPL v3 — free forever
- Commercial tier for MSPs and enterprise deployments
- Multi-cluster management, RBAC, SSO, white-labeling, priority support

---

## Competitive Position

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
