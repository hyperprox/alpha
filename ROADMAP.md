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
- LXC container creation — template picker, node resource limits, dynamic storage with free space
- VM creation — ISO auto-detection across all nodes, network config, storage picker
- CT/VM deletion with confirmation guard
- CT template + ISO auto-detection across all nodes and storage pools

---

## v1.0 — Parity: Stop Going Back to the Proxmox UI

**The test for this section: an operator can run a normal week without opening the Proxmox web UI or an SSH session.** Today they cannot — editing a mount point, adding an HA rule, or answering "why is this OSD flagged" all require leaving HyperProx.

Parity is not the goal on its own. Every item below exists because the Proxmox UI either hides the thing that bites you, or shows it without the context that makes it actionable. Where HyperProx only matches the stock UI, it has added nothing.

### Guest Config Editing
Edit what today needs `pct set`, `qm set`, or a text editor on a corosync-backed filesystem. A guest's config is the single most dangerous file an operator touches: it is replicated cluster-wide on write, with no undo.

- Structured editor for cores, memory, swap, boot order, nameserver, onboot, description
- **Mount point editor** — add, remove, resize, and edit bind mounts and volume mounts
- **`shared=1` awareness, with verification.** Marking a bind mount shared is what allows a guest to migrate at all; without it the guest can fail *over* but can never come *home*, because recovery onto a surviving node needs no migration while the return trip does. HyperProx must offer the flag **and prove the claim** — check the path is really present on every node before writing it. A path that exists on one node and is marked shared will start the guest somewhere with an empty directory where its data should be.
- **Pending-change visibility.** Some edits land in a `[pve:pending]` block and do nothing until the guest restarts. The stock UI is quiet about this. HyperProx should show a clear "applies on next restart" state, list exactly which keys are pending, and offer the restart.
- **Raw `lxc.*` / `args:` protection.** Passthrough lines — GPU cgroups, device bind entries — are not represented in any form UI, and a careless rewrite silently drops them. The guest then starts fine and the hardware is simply gone. HyperProx must round-trip unknown keys untouched, show them read-only, count them before and after every write, and refuse a save that would lose one.
- Config diff before save, and a one-click revert to the previous version
- Per-guest config history, so "what changed and when" is answerable

### HA Management
The stock HA UI lets you write a rule and discover its consequences later. This should surface the consequence first.

- CRUD for HA resources: state, group, max_restart, max_relocate
- **Rule editor for both rule types** — node affinity (which nodes) and resource affinity (keep together / keep apart)
- **Explain the rule types' interaction, because Proxmox enforces it silently.** A resource that sits in a node-affinity rule with *weighted priorities* cannot join a resource-affinity rule at all; the API rejects it with a validation error most operators meet only after designing the rule. HyperProx should detect that up front and offer the fix (flatten the priorities) rather than surfacing a 400.
- **Strict vs non-strict, in words.** Strict means "nowhere else, ever" — including *not starting at all* when the preferred node is down. Non-strict means "prefer here, run anywhere". Picking wrong turns a preference into an outage. Label them by consequence, not by flag name.
- **Anti-affinity headroom warning.** N guests kept apart across N eligible nodes leaves zero slack: lose one node and one guest has nowhere legal to start. Compute eligible nodes per rule and warn before saving.
- **The "no rule at all" gap.** A guest with no node affinity that fails over never returns — it runs wherever it landed, indefinitely. This is invisible until it matters, and it is how a GPU workload ends up on a node with no GPU, reporting perfectly healthy. Flag HA guests with no home, and offer to give them one.
- **Migration preflight, per target node.** Proxmox already computes this (`/nodes/{node}/{type}/{id}/migrate` returns allowed and not-allowed nodes with causes). Show it as a grid: for each node, can this guest move there, and if not, exactly why — local bind mount, blocking HA rule, missing storage, insufficient memory.
- Guests that are HA-managed vs not, side by side. Anything not managed simply stays down after a node failure, and that set is worth seeing on one screen.

### Templates & Cloning
- Convert a guest to a template; clone full or linked
- Template catalogue with description, source guest, and creation date
- **Provisioning profiles** — a named bundle of cores/memory/storage/network/features applied at create time, so "a standard Docker LXC here" stops being a checklist someone remembers
- Cloud-init editor for VMs: user, SSH keys, IP config
- Bulk clone with a naming pattern and sequential addressing

### Ceph: Measurement, Not Just Status
The stock Ceph panel answers "is it green". The questions that actually cost time are "what changed", "what is slow", and "what is unsafe to touch".

- **Outdated daemon detection, done properly.** A daemon is outdated when the *installed package version on its node* is newer than the *running daemon version* — the gap a package upgrade opens and a restart closes. Show it per daemon (mon / mgr / osd / mds), grouped by node, with the two versions side by side.
- **Version skew across nodes**, called out loudly. Upgrading one node's packages and not the others leaves a split-version cluster that reports healthy and is not a state to sit in. This is easy to reach by accident with a routine `apt upgrade` on a single node.
- **Restart-safety gating — the one that matters most.** Restarting an OSD in a pool with `size=1` makes that OSD's data *unavailable*, with no replica to serve it. The UI must know a pool's replica count and refuse to present a casual "restart" button for OSDs backing it, or at minimum state plainly what goes offline and for how long. Same for any OSD whose loss would drop a PG below `min_size`.
- **Cluster-wide package upgrade, as one operation.** Upgrading Ceph on a single node is the easiest way to split a healthy cluster's versions, and it happens by accident: a routine `apt upgrade` on one host pulls its Ceph packages forward while the others stay put. Nothing breaks, health stays green, and the cluster is now running one version with another installed underneath it. HyperProx should treat "upgrade Ceph" as a cluster-level action that levels every node in one pass, never a per-node one.
  - Show installed vs available vs running, per node, before anything is touched
  - `--only-upgrade` against the Ceph package set explicitly; never a blanket dist-upgrade, which drags unrelated packages into a storage maintenance window
  - **Packages first, restarts second, as separate gated steps.** Installing binaries restarts nothing and is safe at any hour; it also makes an unplanned daemon restart land on a consistent version instead of a split one. Only the rolling restart needs a window.
  - Watch node root filesystems during the install. On a small root, the downloaded archives alone can push a monitor under its free-space threshold and raise a fresh health warning mid-upgrade — clean the package cache as part of the flow.
- Guided rolling restart: correct order (mon → mgr → osd → mds), one daemon at a time, `noout` set and cleared automatically, health gate between each step, abort on degradation
  - Ordered by blast radius where a pool has no replicas: smallest OSD first, so the first restart is the cheapest lesson, and never two large ones in a row
  - State what goes offline before each step, in gigabytes and percent of the pool, not just "restarting osd.N"
- **Slow-op surfacing with history.** "2 OSDs experiencing slow operations" is where the stock UI stops. Which OSDs, since when, on which device, and is it getting worse — that is what identifies a dying disk.
- **Per-OSD benchmarking** — `ceph tell osd.N bench`, stored over time, so a slow OSD is visible as a trend against its peers rather than a number with nothing to compare to
- Pool-level detail: replica count, PG count and whether autoscale agrees, per-pool IOPS and throughput, capacity trend with a projected full date
- Device health: SMART, power-on hours, unsafe shutdown count, reallocated sectors — surfaced next to the OSD it backs, because "which physical disk is osd.N" is a question the stock UI makes you answer yourself
- Single-failure-domain warnings: all OSDs of a pool on one node, or a `size=1` pool at all, stated as an accepted risk with its blast radius rather than a recurring health warning to be ignored

### Why This Matters
Each of the above was written after hitting it on a live cluster, not from reading the Proxmox feature list. The recurring shape: **the platform reports success while the thing it exists to do is broken.** A guest runs without its GPU. An HA rule is satisfied by leaving a service on the wrong node. A pipeline is red for a reason unrelated to the code. A daemon is "outdated" with no indication that restarting it takes data offline.

HyperProx earns its place by showing the consequence before the action, and by checking the outcome rather than the component's own status line.

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
