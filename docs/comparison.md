# How HyperProx compares

Checked on **2026-11-11** against each project's own documentation, site, repository or changelog. Sources are
listed under every product. Tools change quickly: if a cell is out of date, open an issue with a link and it
will be corrected.

**Key:** ✅ yes · ◐ partly (the note says which part) · — no · ? not confirmed either way

## The short version

- **HyperProx** looks after the layer around your Proxmox clusters: apps, proxy, DNS, certificates, alerts,
  updates and the services you run. All of it sits behind a vault.
- **Proxmox Datacenter Manager** and **PegaProx** are cluster managers. They go deeper on the hypervisor
  (cross-cluster migration, load balancing, VMware import) and do not install or wire up apps.
- **Pulse** watches; **ProxMenux** and the **Helper-Scripts** set up one host; **Coolify**, **Dokploy** and
  **Runtipi** deploy Docker apps; **Homepage** and **Homarr** show dashboards; **Cockpit** administers one
  Linux machine.

Many people run HyperProx next to one of these, not instead of it.

## Feature table

| | HyperProx | PDM | PegaProx | ProxMenux | Pulse | Helper-Scripts | Coolify | Dokploy | Runtipi | Homepage | Homarr | Cockpit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Licence | AGPL-3.0 | AGPL-3.0 | AGPL-3.0 | GPL-3.0 | MIT (paid Pro tiers) | MIT | Apache-2.0 | Apache-2.0 + proprietary dir | GPL-3.0 | GPL-3.0 | Apache-2.0 | LGPL-2.1+ |
| Proxmox guests: create, power, migrate | ✅ create, power, migrate within a cluster | ◐ power, migrate; create planned | ✅ incl. cross-cluster | ◐ creates VMs | — read-only | ◐ creates guests | — | — | — | — | — | — |
| Several clusters in one place | ✅ view and control | ✅ | ✅ | — | ◐ view only | — | — | — | — | ◐ widgets | ? | — |
| Installs apps | ✅ catalogue + AI wizard | — | ◐ cloud-init templates | ✅ | — | ✅ 700+ scripts | ✅ 360+ | ✅ 600+ | ✅ 266 | — | — | — |
| Reverse proxy | ✅ Nginx Proxy Manager | — | — | — | — | — | ✅ | ✅ | ✅ | — | — | — |
| DNS records | ✅ GoDaddy | — | — | — | — | — | — | — | — | — | — | — |
| Certificates | ✅ issue, deploy, watch | ◐ own cert | ◐ own UI cert | — | ◐ expiry warnings | — | ✅ | ✅ | ✅ | — | — | — |
| Monitoring and alerts | ✅ Prometheus + Grafana, per-site traffic from access logs; Discord, Slack, Teams, ntfy, Gotify, Telegram, webhook | ◐ metrics; alerts planned | ✅ | ✅ | ✅ | — | ✅ | ✅ | ? | ◐ status only | ◐ status only | ◐ metrics only |
| Updates for hosts and guests | ✅ incl. pinned kernels | ✅ hosts | ◐ rolling host updates | ✅ | ◐ alerts | ◐ per script | ◐ OS checks | ? | ◐ per app | — | — | ◐ own host |
| Backups (PBS) | ◐ last backup per cluster | ✅ PBS remotes | ✅ | ◐ host config | ✅ visibility + alerts | — | ◐ to S3 | ◐ to S3 | ◐ per app | ◐ widget | ? | — |
| Secrets vault | ✅ zero-knowledge Vaultwarden | — | — | — | — | — | — | — | — | — | — | — |
| Roles | ✅ owner, admin, operator, viewer | ✅ + LDAP/AD/OIDC | ✅ + LDAP/OIDC, 2FA | ◐ one login + 2FA | ◐ Pro only | — | ✅ | ✅ | ? | — | ✅ + OIDC/LDAP | ◐ system accounts |
| Browser terminal | ✅ | ✅ | ◐ consoles | ✅ | — | — | ✅ | ✅ | ? | — | ? | ✅ |
| App control panels | ✅ Home Assistant, Plex, Arr, Unmanic, MikroTik, QNAP, MeshCentral | — | ◐ plug-in system | — | — | — | — | — | — | ✅ 100+ read-only widgets | ✅ 91+ integrations | ◐ add-on apps |
| NAS | ✅ QNAP plug-in, NAS on cluster cards | — | — | ✅ NAS VMs, shares | ◐ TrueNAS monitoring | — | — | — | — | ◐ widgets | ? | ◐ 45Drives add-on |
| VPN / remote access | ✅ WireGuard, Tailscale | — | — | ? | — | ◐ Tailscale add-on | — | — | ◐ Tailscale app | — | — | — |
| AI assistant | ✅ local (Ollama) | — | — | ◐ rewrites alerts | ✅ Patrol + MCP | — | ◐ MCP | ✅ | — | — | ? | — |
| Install | one-line script | ISO | script, APT, Docker | one-line script | Docker, script, Helm | one line per app | script | script | script | Docker | Docker | distro package |

## What others do better

Being fair matters more than winning a table.

- **PDM:** it is Proxmox's own product with enterprise support, and it does live migration between clusters.
  It also manages SDN/EVPN across clusters and sign-in through LDAP, AD and OIDC.
- **PegaProx:** load balancing and affinity rules across clusters, import from ESXi, vCenter and XCP-ng,
  rolling updates that move guests out of the way first, SIEM forwarding and multi-tenancy.
- **ProxMenux:** tuned for a single host: a GPU passthrough and NVIDIA installer, Log2RAM, NAS VMs, and six
  languages.
- **Pulse:** the widest monitoring coverage (Proxmox VE, PBS, PMG, Docker, Kubernetes, TrueNAS) and an AI
  patrol.
- **Helper-Scripts:** the largest catalogue of Proxmox installers, and the community standard.
- **Coolify / Dokploy:** deploys straight from a git push, PR preview environments, and hundreds of templates.
- **Runtipi:** the simplest single-host app store.
- **Homepage / Homarr:** lightweight dashboards with large widget libraries and SSO.
- **Cockpit:** ships with most Linux distributions and covers storage, network and packages on one host.

## Where HyperProx is still behind

- Sign-in through LDAP, AD or OIDC is not supported yet.
- Notifications cannot go out by email yet.
- DNS works with GoDaddy only.
- Guests can move between nodes of one cluster, but not to another cluster.
- Guest hardware is still edited in the Proxmox web interface.
- Backups show as the last result per cluster; PBS itself is not managed yet.

## Sources

**HyperProx:** this repository (`apps/api/src/lib/notify`, `lib/clusters/guest-actions.ts`,
`lib/catalogue.ts`, `lib/roles.ts`, `routes/vpn.ts`).

**Proxmox Datacenter Manager** (1.1, 2026-05-28):
- https://pdm.proxmox.com/docs/roadmap.html
- https://www.proxmox.com/en/products/proxmox-datacenter-manager/overview
- https://pdm.proxmox.com/docs/remotes.html

**PegaProx** (1.4.1, 2026-10-24):
- https://github.com/PegaProx/project-pegaprox
- https://pegaprox.com/
- https://github.com/PegaProx/project-pegaprox/releases/tag/v1.4.1

**ProxMenux** (1.2.8, 2026-11-02):
- https://github.com/MacRimi/ProxMenux
- https://raw.githubusercontent.com/MacRimi/ProxMenux/main/CHANGELOG.md

**Pulse** (6.7.0, 2026-11-02):
- https://github.com/rcourtman/Pulse

**Proxmox VE Helper-Scripts** (rolling):
- https://github.com/community-scripts/ProxmoxVE
- https://community-scripts.org/scripts?id=add-tailscale-lxc

**Coolify** (4.7.5, 2026-11-10):
- https://github.com/coollabsio/coolify
- https://coolify.io/docs/knowledge-base/notifications
- https://coolify.io/docs/core/team/roles-and-permissions
- https://coolify.io/docs/core/infrastructure/servers/web-terminal
- https://coolify.io/docs/mcp/clients/claude-code

**Dokploy** (0.31.0, 2026-11-05):
- https://github.com/Dokploy/dokploy
- https://docs.dokploy.com/docs/core/domains
- https://docs.dokploy.com/docs/core/ai
- https://raw.githubusercontent.com/Dokploy/dokploy/canary/LICENSE.MD

**Runtipi** (4.12.0, 2026-10-31):
- https://github.com/runtipi/runtipi
- https://runtipi.io/docs/learn/reverse-proxy
- https://runtipi.io/docs/apps-available

**Homepage** (2.7.0, 2026-10-23):
- https://gethomepage.dev/
- https://gethomepage.dev/widgets/services/proxmox/
- https://gethomepage.dev/widgets/services/proxmoxbackupserver/

**Homarr** (2.12.0, 2026-11-06):
- https://homarr.dev/
- https://homarr.dev/docs/integrations/proxmox

**Cockpit** (372, 2026-11-10):
- https://cockpit-project.org/
- https://github.com/cockpit-project/cockpit-machines
- https://github.com/45Drives/cockpit-file-sharing

Umbrel (PolyForm Noncommercial licence, a whole OS) and CasaOS (no release since 2024-12-19) are left out of
the table for those reasons.
