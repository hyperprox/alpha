# HyperProx — Roadmap

> *"Your Proxmox infrastructure, hypercharged."*
>
> Built by [HyperProx](https://example.net) — every feature comes from real operational pain running a real 5-node Proxmox homelab.

---

This file says what HyperProx does today, what is partly built, and what comes next. Everything under
**Where it is today** is in the code on `main`. The version in the repository is `0.2.0-alpha`, and there
are no published releases yet.

For how HyperProx compares with other tools, with a source for every cell, see
[docs/comparison.md](docs/comparison.md).

## Why it is built this way

Each part of HyperProx was written after hitting the problem on a live cluster, not from reading the
Proxmox feature list. The recurring shape: **the platform reports success while the thing it exists to do
is broken.** A guest runs without its GPU. An HA rule is satisfied by leaving a service on the wrong node. A
daemon is "outdated" with no sign that restarting it takes data offline.

HyperProx earns its place by showing the consequence before the action, and by checking the outcome rather
than the component's own status line. That is why almost every change in it is a preview first, is refused
if something changed since the preview, and is read back afterwards.

---

## Where it is today

### Clusters

- **Home cluster** through the Proxmox API. First-run setup signs in once, creates HyperProx's own API
  token and a read-only one for the metrics exporter, and never stores the password.
- **Command center**: any number of remote Proxmox servers or clusters beside the home one, reached over
  Tailscale, WireGuard or any routable address. A remote is never joined to your cluster.
- Each cluster is a panel: nodes, quorum, guests, CPU, memory, storage, a row for each NAS, a row for every
  GPU, the last backup, and one **Needs attention** list across all clusters.
- On a remote: start, stop, shut down, restart, snapshot, back up now, edit settings and delete guests,
  each read back from Proxmox.
- **Adding a server** checks its certificate and node host keys by itself over a private link (Tailscale
  or WireGuard), or asks you to compare a fingerprint once. Its token and logins live in the vault.
- **Hardware scan** per cluster, with `vainfo` where a node login allows it.
- **Monitoring on a remote**: node_exporter on the private link only, plus AMD and Intel GPU figures.
  Removal puts everything back.
- **Send files**: copy folders between or within clusters, node to node with rsync, add-only, every file
  checked by size and checksum. Plex on the other side is asked to rescan. This is a first version and has
  not yet been tried against real servers.

### Guests & HA

- Every VM and container in one list with power actions, snapshots and migration within a cluster.
- Create a container from any template or a VM from any ISO on any node. Delete asks for the master
  password.
- **Guest config editor** (`lib/guest-config`): cores, memory, swap, start-up order, tags, DNS, network
  cards, disks and mount points. Each change is previewed, refused if the guest changed meanwhile, and
  read back.
  - `shared=1` on a bind mount is offered only after HyperProx has checked the path exists on every node.
  - Changes that land in `[pve:pending]` say "applies on next restart", list the keys, and offer the
    restart.
  - Raw `lxc.*` device lines are written only with extra checks. Unknown and raw keys are counted before
    and after every write, so a save cannot silently drop one.
  - History of every change, one-click revert, and passwords and keys masked in the history.
- **GPUs and devices**: give a container a GPU, switch its GPU access off and on, and **Portable GPU** so a
  container picks up whichever node's GPU it lands on. Each node lists its GPUs, USB, serial and PCI devices
  and who uses them.
- **GPU watch**: after an HA move, HyperProx checks that a GPU container still has its GPU and says so
  through your notification channels.
- **High availability** (`lib/ha`), in plain words:
  - Protect a guest, give it a home ("prefer this node" or "only this node"; the strict choice is red and
    needs a second confirmation), and keep guests apart or together.
  - Proxmox's rule conflicts (a weighted node-affinity rule with a resource-affinity rule) are caught
    before Proxmox refuses them.
  - Keep-apart rules show their headroom: how many nodes are left once the guests are placed.
  - Guests with no home, guests not protected, and guests that need one node's hardware are listed.
  - Where each guest would go if its node failed, and a grid of which nodes it can migrate to and why not.
  - Maintenance mode for a node.
  - Every change is previewed, refused without quorum or if HA changed since the preview, and needs the
    master password.

### Storage & Ceph

- **Storage**: every storage on every node, including NFS and CIFS, Ceph health, OSDs with latency, pools,
  and each guest's disks.
- **NAS rows** on Command center panels: Proxmox NFS and CIFS storages, plus network mounts Proxmox does not
  list (read through node_exporter), grouped per NAS server with shared volumes counted once.
- **Ceph safety in Updates**: before restarting an OSD or rebooting a node, HyperProx asks Ceph whether it
  is safe to stop and checks every pool's copies. A step that would take data offline (for example a pool
  with one copy on that node) is skipped and says what would have gone offline. OSDs restart one at a time
  with `noout` set. Ceph packages are levelled to one version across nodes, and a node update never pulls
  Ceph forward by itself.

### Network

- **Reverse proxy** (`lib/proxy/providers`): Nginx Proxy Manager, Traefik, Caddy, HAProxy and Pangolin,
  several at once in one table. Each proxy is one you run or one HyperProx installed. Every change is
  previewed and read back; hosts other tools made are read-only.
- **DNS**: GoDaddy only. Records, guided creation, domain expiry, A records that differ from your WAN IP
  flagged, and DDNS.
- **Certificates** (`lib/certs`): probes every endpoint like a client, issues and renews over ACME DNS-01
  through GoDaddy, delivers into guests or HyperProx's own nginx, and checks each delivery by fingerprint.
- **VPN and remote access**: installs and manages Tailscale and NetBird on nodes, containers and VMs, and
  adopts clients it did not install. WireGuard servers in a container, phones and laptops by QR code, and
  WireGuard peers on a MikroTik router.
- **The Deck**: SSH in the browser to every guest and to hosts you add, with tmux sessions that survive
  closing the tab, tabs, splits, grids, saved layouts and pinned host keys.

### Apps & Plug-ins

- **Catalogue** (`lib/catalogue.ts`): twelve recipes (Nginx Proxy Manager, Ollama, Tautulli, Nextcloud,
  Jellyfin, Vaultwarden, Gitea, Uptime Kuma, Homepage, Grafana, Static site, WordPress). A wizard picks
  resources, recommends a node from live capacity, sets ID, hostname and address, and shows the exact
  plan. A failed install can remove only the container it made.
- **Sites** (`lib/sites.ts`): a New website wizard for a static site or WordPress that also makes the DNS
  record, proxy host and certificate and checks the public address, with a clean-up of only what a failed
  run made; then open, one-time WordPress admin sign-in, reveal password, pull now and health.
- **Site metrics** (`lib/site-metrics`): privacy-friendly analytics read from each site's own nginx access log
  every 5 minutes (no scripts, no cookies, addresses never stored; visitors counted with a salted hash whose
  key changes daily), the public check and certificate days, container gauges, a read-only WordPress check,
  alerts (down, server errors, certificate, traffic spike), a Websites panel on Monitoring, Prometheus gauges
  and a Grafana dashboard. **Add an existing site** adopts a hand-built container read-only, with an optional,
  previewed and re-confirmed change to its nginx log format for response times.
- **AI assistant** (`lib/ai`): answers questions about one cluster or all of them, with each fact labelled
  by cluster. Plain-language deploys of Nextcloud, Jellyfin, Gitea, Uptime Kuma and Homepage run end to
  end on the home cluster: container, service, proxy host, DNS record and certificate. A static site (its
  starter page) is offered to it too and goes through the same steps. On any cluster it can
  prepare guest power, snapshot, back up now, delete, monitoring and copies; nothing runs until you confirm,
  with the same role and password checks as by hand. It also reads every QNAP NAS, network storage, the
  alerts Prometheus has firing, notification channels, every Home Assistant house by room, the websites
  HyperProx made, and the plug-in pages' figures, and answers the common questions about them by code. It
  plans a new website through the New website wizard's own code (reviewed and installed in the wizard),
  and prepares a static site's pull now and a NAS disk's quick SMART test. Visitor figures wait for the
  site-metrics module: until it is added the assistant says they are not collected. Providers: Anthropic,
  OpenAI-compatible, Ollama.
- **Plug-ins** (`apps/api/src/plugins`): Arr Stack, Unmanic, MikroTik, Plex activity (through Tautulli),
  Home Assistant, QNAP and MeshCentral. Each has a visual page that follows the theme, with the old tables
  under **Details**. Plug-ins never read a credential: HyperProx makes their HTTP calls. **Scan for
  services** finds known apps on running guests.
- **Home Assistant control** (`lib/ha-control`): more than one house, devices as tiles by room, read-back
  after every action, and an audit entry for each. Locks, alarm panels, sirens and other security devices
  need the admin role, the master password and a confirm step where you type the device name.
- **QNAP** (`lib/qnap`): each NAS's bays with SMART, volumes, shares, temperatures, fans and firmware; quick
  SMART test; restart and shut down behind the confirm step; alerts; and a NAS on a remote cluster's LAN read
  through one of that cluster's nodes.

### Monitoring & Alerts

- Bundled Prometheus and Grafana with HyperProx dashboards, a plug-ins dashboard, and the node list kept up
  to date by itself.
- The installer and **Settings → Setup checklist** ask plain questions and do the node work: node_exporter,
  CPU power counters, GPU exporters, and built-in graphics for containers. They only add packages.
- Alert rules for nodes, CPU, memory, disk, Ceph, GPUs and hardware (`config/prometheus/rules/cluster.yml`):
  GPUNotResponding, GPUHot, CPUHot, FanStuckAtMax, MonitoringTargetDown.
- **Alerts are forwarded** (`lib/alerts/forwarder.ts`): one message when an alert starts, one when it clears,
  and one warning if Prometheus stops answering.
- **Websites** (`lib/site-metrics`): every site on the Sites page is checked every 5 minutes, with its traffic,
  errors, p95 and certificate on the Monitoring page and in Grafana, and its alerts in the same feed.
- **Notifications** (`lib/notify`): Discord, Slack, Teams, ntfy, Gotify, Telegram and generic webhooks, with
  severity filters, quiet hours and a test button.

### Updates

- Pending packages and kernel pins on every node and guest, on every cluster (`lib/updates`).
- A full update round: preflight checks, guests in batches with a snapshot first, Ceph levelled, then nodes
  one at a time with HA maintenance mode and `noout` around a reboot. It stops at the first failure.
- A policy file (`config/updates.yaml`) with per-cluster sections. Without it you get dry runs only. A node
  with held packages or a pinned kernel gets `apt-get upgrade`, never `dist-upgrade`, unless the policy
  names it.
- On a remote: apt's own simulation as the preview, the master password to apply, every package read back,
  and no automatic reboot.
- A daily read-only check of every cluster, with one notification when something new needs updating.
- **App updates** for software outside apt and Docker, contributed by plug-ins. MeshCentral (npm installs)
  is bundled.

### Security & Vault

- A built-in Vaultwarden is the only sign-in: email, master password and two-factor code. The API does not
  start without it.
- Locked after a reboot, auto-lock after idle time, secrets in memory only, and a small keyholder so a
  deploy does not lock you out.
- Four roles from the vault's organization: owner, admin, operator, viewer.
- The master password is asked again for dangerous actions (destroying a guest, revealing a secret,
  catalogue installs, remote cluster changes, and more).
- API tokens with a role, stored as a hash, that stop working while locked and can never read secrets.
- Secrets page: reveal, send as a one-view link, or generate and store a password.
- Node host keys and remote certificates are verified automatically where HyperProx has evidence, and
  compared by hand only where it has none.
- Actions are written to an audit log.
- Only nginx listens on the network; everything else is bound to loopback.

### Interface

- A redesigned interface with a grouped side rail, a **Find anything** box, and Auto, Light and Dark themes.
- A real-time dashboard: nodes, storage, Ceph, HA and quorum, GPUs, network, bandwidth and power.
- Works on a phone and installs as an app.

---

## In progress / partly built

### Network storage health

Born from an offline CIFS/NFS mount that silently caused 10-second node_exporter scrape timeouts and false
NodeDown alerts with no obvious cause.

**Built:** the Storage page lists NFS and CIFS storages on every node, and the Command center shows each NAS
with how full it is, including mounts Proxmox does not list.

**Not built:**
- A per-node mount status (online, unreachable, degraded) with a "last seen online" time.
- Named alerts ("NAS-Storage (CIFS) unreachable on node1"), not just NodeDown, cleared when the mount
  returns.
- Root-cause correlation: when a node's scrape is slow or failing, check that node for offline mounts and
  show it as the likely cause.
- AI assistant awareness of the same (today it reads the usage the Command center shows, not mount status).

### Ceph: measurement, not just status

The stock Ceph panel answers "is it green". The questions that cost time are "what changed", "what is slow",
and "what is unsafe to touch".

**Built:** restart and reboot safety inside Updates (see above), Ceph packages levelled across nodes in an
update round, and OSD latency on the Storage page.

**Not built:**
- **Outdated daemon detection, done properly.** A daemon is outdated when the installed package on its node
  is newer than the running daemon. Show it per daemon, grouped by node, with both versions side by side.
- **A version-skew view**, called out loudly. A split-version cluster reports healthy and is not a state to
  sit in.
- **"Upgrade Ceph" as its own cluster-level action**, outside a full update round: installed, available and
  running versions per node first; `--only-upgrade` on the Ceph packages; packages first and restarts
  second as separate gated steps; and the package cache cleaned so a small root filesystem does not push a
  monitor under its free-space threshold mid-upgrade.
- **A guided rolling restart on its own**: mon, mgr, osd, mds in order, one daemon at a time, `noout` set
  and cleared, a health gate between steps. Where a pool has no replicas, smallest OSD first, and each step
  says what goes offline in gigabytes and percent of the pool.
- **Slow-op history**: which OSDs, since when, on which device, and whether it is getting worse.
- **Per-OSD benchmarks** stored over time, so a slow OSD shows as a trend against its peers.
- **Pool detail**: PG count and whether autoscale agrees, per-pool IOPS and throughput, and a projected full
  date.
- **Device health** (SMART, power-on hours, unsafe shutdowns, reallocated sectors) next to the OSD it
  backs.
- **Single-failure-domain statements**: all of a pool's OSDs on one node, or a `size=1` pool, shown once as
  an accepted risk with its blast radius instead of a health warning people learn to ignore.

### More on remote clusters

**Built:** see Clusters above. **Not built:** high availability and GPU sharing on a remote (labelled "home
cluster only" in the interface), Proxmox figures in Grafana for a remote (its own PVE exporter), Sync and
Move in Send files, and editing guest settings or deploying a service from the AI assistant.

### Home Assistant

**Built:** see Apps & Plug-ins above. **Not built:** locks and alarm panels that need a code, live state over
Home Assistant's WebSocket instead of refreshing every few seconds, and control from the AI assistant (it reads
every house, room by room, and on purpose switches nothing).

### MeshCentral

**Built:** the plug-in finds MeshCentral npm installs in guests and updates them through Updates.
**Not built:** it holds no MeshCentral login, so it shows no devices and offers no remote desktop.

### Backups

**Built:** the last backup per cluster on the Command center, back up now on any cluster, and the assistant
answers questions about backup runs. **Not built:** anything that reads Proxmox Backup Server itself.

### Audit and access control

**Built:** actions are written to an audit log, and four roles apply to everything. **Not built:** a page to
read the audit log, a timeline that joins it with the vault's event log, roles scoped to a cluster, node or
guest, and temporary users.

### Smart suggestions

**Built, as separate pieces:** A records that differ from the WAN IP are flagged with a one-click DDNS
update, a certificate whose check turns bad (or good again) is notified, Prometheus's node list follows nodes joining, and the
Needs attention list collects problems. **Not built:** one engine that connects these, such as "a new proxy
host has no DNS record, create one?". Every suggestion would still need you to confirm it.

### Console

**Built:** a guest's **Console** tab opens an SSH pane in the Deck. **Not built:** a real console for guests
SSH cannot reach (see Next).

---

## Next

The test for this list: **an operator can run a normal week without opening the Proxmox web UI or an SSH
session.** Today consoles, templates, Ceph maintenance and backups still send you there. In rough order:

1. **The six-point standard for every catalogue install.** An app is not installed until it has:
   an address, a proxy host and a certificate; its login in the vault; a backup; monitoring with alerts; a
   place under the update policy; and a plug-in panel. The catalogue checks each point and says which are
   missing. Today the catalogue makes the container, installs the app, checks that it answers, and fills in
   the HyperProx setting that was waiting for it; for websites (New website) it also makes the address,
   proxy host and certificate, keeps generated logins in the vault, and gives the site monitoring with alerts
   (its Metrics tab). Backups, the update policy and a plug-in panel are not automatic for any recipe yet, and
   monitoring with alerts is not automatic for the other recipes. Ghost as a website kind waits on a supported
   database for Debian 13.
2. **MeshCentral remote desktop**: a catalogue recipe that installs MeshCentral, an adopt flow for an
   existing install, and its devices and remote desktop on the plug-in page.
3. **A Proxmox Backup Server plug-in** with datastore use, job history and retention, and **automatic
   restore tests**: restore a recent backup to a throwaway guest on a schedule, check it starts and holds
   data, then remove it. A backup nobody has restored is not known to work.
4. **Catalogue packs**: one install for a set of apps that belong together, each meeting the six-point
   standard. Planned packs: family server, network, media automation, and home security with Frigate.
5. **Consoles: when SSH cannot reach.** The Deck reaches every guest over SSH, which is the path that is
   missing when you need a console most: a Windows VM, an appliance with no shell, a guest whose network is
   broken, a VM stuck at boot.
   - noVNC as a Deck pane type, beside SSH panes, with the same tabs, splits and layouts. Proxmox provides
     the console (`vncproxy` and `vncwebsocket`).
   - The stream relayed through the HyperProx API, never browser to Proxmox, so the browser never sees a
     Proxmox ticket and the console works wherever HyperProx is reachable.
   - termproxy for containers, through the same xterm.js terminal, so a container with no SSH or no network
     still gets a shell.
   - Offered automatically when an SSH pane cannot connect.
   - Send Ctrl-Alt-Del, paste as typed keystrokes, scale to pane, fullscreen.
6. **Ceph operations**: the unbuilt part of "Ceph: measurement, not just status" above.
7. **Releases and self-update**: versioned, checksum-verified builds instead of installing whatever `main`
   is, and `hyperprox update`, `rollback` and `uninstall`. Today you update with `git pull` and `deploy.sh`.
   The design is in [docs/superpowers/specs/2026-10-06-installer-design.md](docs/superpowers/specs/2026-10-06-installer-design.md).
8. **Demo mode and screenshots**: run HyperProx against made-up data so people can try it without a
   cluster, and real screenshots in the README.
9. **The hyperprox.dev website.**
10. **More integrations**:
    - DNS providers beyond GoDaddy: Cloudflare, Namecheap, Route 53, Porkbun, with a provider chosen per
      domain. (The credential form already has Cloudflare fields; there is no Cloudflare client.)
    - Email notifications.
    - LDAP / Active Directory and OIDC / SSO sign-in.

Also not built, and wanted:

- **Templates and cloning**: convert a guest to a template, full or linked clones, bulk clones with a
  naming pattern and sequential addresses, a cloud-init editor for VMs, and provisioning profiles (a named
  bundle of cores, memory, storage, network and features) so "a standard Docker container here" stops being
  a checklist someone remembers.
- **Configuration export**: a point-in-time export of HyperProx's configuration, with secrets encrypted by a
  passphrase, that a fresh install can restore.
- **The rest of the vault design**: temporary users, owner recovery, and the audit timeline
  ([docs/superpowers/specs/2026-10-14-vault-gate-design.md](docs/superpowers/specs/2026-10-14-vault-gate-design.md)).
- The remote-cluster, Home Assistant and network-storage remainders listed under In progress.

---

## Later

Ideas, not plans. None of these has code today.

- **Cross-cluster live migration**: move guests between Proxmox clusters, with resource checks first,
  progress, and rollback.
- **ESXi import**: bring VMware workloads into Proxmox, with disk conversion and network mapping, for people
  leaving VMware.
- **XCP-ng**: manage Xen pools and VMs beside Proxmox.
- **Bare metal**: a Proxmox installer with HyperProx included, post-install bootstrap, adding nodes from the
  dashboard, and a major-version upgrade wizard.
- **Security scanning**: known CVEs across nodes and guests, and guided Proxmox host hardening.
- **A commercial tier** for MSPs and larger deployments. The community edition stays AGPL v3.

---

## Contributing

Bug reports, feature requests, and pull requests welcome via [GitHub Issues](https://github.com/hyperprox/alpha/issues).

---

## License

[AGPL v3](LICENSE) — free for personal and open-source use.  
Commercial licensing for MSPs and enterprise deployments is an idea for later (see above).

---

<div align="center">
Built by <a href="https://example.net">HyperProx</a> — running on a real 5-node Proxmox cluster so every feature solves a real problem.
</div>
