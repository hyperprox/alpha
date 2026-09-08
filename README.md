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

## Install

On any Proxmox node, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/hyperprox/alpha/main/bootstrap.sh | bash
```

That is the whole thing. It picks a free container ID and the storage with the
most room, fetches the current Debian template, creates the container with the
features Docker actually needs, mints the Proxmox API token, installs
`node_exporter` on every node so Monitoring has data immediately, installs
HyperProx, and prints you a URL.

It is safe to re-run — anything already correct is left alone.

<details>
<summary>Options, if the defaults do not suit you</summary>

```
--vmid N            Container ID           (default: next free)
--hostname NAME     Container hostname     (default: hyperprox)
--cores N           CPU cores              (default: 4)
--memory MB         Memory                 (default: 8192)
--disk GB           Disk                   (default: 100)
--storage NAME      Storage for the rootfs (default: most free space)
--bridge NAME       Network bridge         (default: vmbr0)
--ip CIDR           Static address, e.g. 192.168.1.50/24  (default: dhcp)
--gateway IP        Gateway, required with --ip
--skip-exporter     Do not install node_exporter on the nodes
-y, --yes           Do not ask for confirmation
```

</details>

### What it does for you, that you used to do by hand

| Was | Now |
|---|---|
| Download a template, then `pct create` with the right flags | Chosen and created for you |
| Remember that the container must be **privileged** with nesting and keyctl, or Docker fails with an overlay error | Set correctly, every time |
| Add the TUN device rules by hand for Tailscale | Included |
| `pveum user token add`, then `pveum acl modify`, then paste the secret into a wizard | Created, granted and written into the config |
| Install `node_exporter` on each node individually | Installed across the cluster |
| Find the CEPH monitor node and set `CEPH_MON_NODE` | Detected at runtime, and re-detected if that node goes away |
| Type the address of every service you want a plug-in for | **Scan for services** finds them |

### Finding your services

Open **Plug-ins** and press **Scan for services**. HyperProx already knows every
guest on the cluster and its address, so it probes them for services it has a
plug-in for and offers to configure what it finds:

```
qBittorrent  http://192.168.1.20:8080   on arrstack (700)
Sonarr       http://192.168.1.20:8989   on arrstack (700)   still needs sonarr_key
Unmanic      http://192.168.1.21:8888   on unmanic-titan2 (216)
```

Every probe is an unauthenticated GET against a port a known service answers on.
Nothing is written until you press **Use this**, and an API key is never guessed
— where one is needed it says so and opens the settings form.

Only running containers with an address Proxmox can read are scanned. A VM
without the guest agent has no address to probe, and nothing outside the cluster
is touched.

### If you would rather do it yourself

<details>
<summary>Manual container creation and token setup</summary>

The container must be **privileged**, with **nesting** and **keyctl**. Without
those, Docker fails with an overlay filesystem error.

```bash
pveam update
pveam download local debian-13-standard_13.1-2_amd64.tar.zst

pct create <CTID> local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst \
  --hostname hyperprox --cores 4 --memory 8192 \
  --rootfs local-lvm:100 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 0 --features keyctl=1,nesting=1 \
  --password --start 1
```

For Tailscale, add the TUN device:

```bash
echo "lxc.cgroup2.devices.allow: c 10:200 rwm" >> /etc/pve/lxc/<CTID>.conf
echo "lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file" >> /etc/pve/lxc/<CTID>.conf
pct reboot <CTID>
```

Then the API token:

```bash
pveum user token add root@pam hyperprox --privsep=0
pveum acl modify / --token 'root@pam!hyperprox' --role Administrator
```

And inside the container:

```bash
apt update && apt install -y curl
curl -fsSL https://raw.githubusercontent.com/hyperprox/alpha/main/install.sh | bash
```

</details>

### GoDaddy API key — only if you want DNS management

1. [developer.godaddy.com/keys](https://developer.godaddy.com/keys) → **Create New App**
2. Environment: **Production** — the OTE test keys will not work
3. Copy the key and secret into Settings → DNS

---

## Monitoring — additional setup required

The monitoring page, node metrics, and wattage display require `node_exporter` installed on each Proxmox **host** (not inside the HyperProx CT). Prometheus and Grafana are bundled and started automatically by the installer — no manual setup needed.

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

The assistant turns a sentence into a deployment plan, then runs it. It is still
early, and the section below says exactly where the edges are.

**Three providers, one interface.** Pick one in Settings → AI:

| Provider | Needs | Notes |
|---|---|---|
| **Anthropic** | An API key | The plan schema constrains generation natively, so a malformed plan is not a failure mode. Defaults to `claude-opus-5`. |
| **OpenAI** | An API key | Uses JSON-schema structured output. The base URL is settable, so the same path also reaches OpenRouter, Groq, Together or any OpenAI-compatible server. |
| **Ollama** | A reachable Ollama server | Free and private. HyperProx does not bundle or install Ollama — point it at one you already run. |

Cloud keys are stored in the same AES-256-GCM credential store as everything
else and are never sent to the browser.

**The model is given your actual cluster.** Before a plan is generated, HyperProx
gathers the live facts — every online node with its free memory, every storage
that can hold a container ranked best-first, the DNS zones you manage, the proxy
hosts already in use, and the next free VMID — and puts them in the prompt. It
plans against what is there rather than what it can imagine.

**Every plan is audited before you see it.** A schema-valid plan can still be
undeployable, so the plan is checked against the same facts: a node that does not
exist, a storage that was never configured, a domain outside your zones, a size
no node can fit, a missing DNS step. Anything it finds is shown as a warning
alongside the model's own.

**What still does not work:**
- The `install_service` step reports itself as skipped and shows you the commands
  to run — HyperProx does not yet execute inside a newly created container.
- Small local models still produce weaker plans. The output is validated either
  way, so a bad one is rejected rather than executed.

> **Local model recommendation:** `llama3.2:3b` works but is inconsistent.
> `qwen3:8b` or `deepseek-r1:8b` handle structured planning noticeably better.
> If you have no GPU to spare, a cloud provider costs a few cents per plan and
> works on day one.

---

### Plug-in consoles

A plug-in whose device also takes an interactive login declares
`consoleAccess` in its manifest, and the device then appears in the Terminal
host list under **From plug-ins** — no second address to type, and no way for
the two to drift apart, because the address comes from the plug-in's own base
URL.

Credentials are deliberately *not* shared with the plug-in. A plug-in is told a
read-only account is enough; reusing that for a shell would either fail or
quietly hand a browser more access than the plug-in was granted. The console
asks for its own login like any other host.

Appliances declare `tmux: false`, because RouterOS and its kind answer SSH with
their own CLI rather than a POSIX shell — there is nothing for tmux to run in,
and probing for it only wastes a round trip on every connect.

### Bandwidth meters

The dashboard's WAN and LAN dials come from whichever plug-in implements
`bandwidth()` — the MikroTik plug-in does. The cluster's own netin/netout cannot
answer this: that is only the traffic Proxmox itself moves, so a house
saturating the uplink is invisible to it.

Two optional settings turn the dials from a bare number into utilisation. In the
MikroTik plug-in's settings:

- **Plan download / upload (Mbps)** — what you pay for, not what the port
  negotiated. A gigabit port on a 500/50 plan is a 500/50 link, and only the
  person paying the bill knows that. Left blank, each dial scales to the largest
  rate it has seen and labels itself `auto`.
- **LAN interface** — blank prefers a bridge, which on a typical router is every
  LAN port at once. Set it to a trunk if your local traffic crosses one: a
  bridge counter does not see switch-to-switch traffic.

---

## What's Built & Working

| Feature | Status |
|---|---|
| VM & LXC management — live metrics, power actions | ✅ Shipped |
| Nginx Proxy Manager full CRUD | ✅ Shipped |
| GoDaddy DNS — all record types, DDNS, stale IP detection, domain expiry | ✅ Shipped |
| Bundled Prometheus + Grafana — auto-started by installer | ✅ Shipped |
| Real-time WebSocket dashboard — nodes, GPU, CEPH, HA, network | ✅ Shipped |
| Storage page — CEPH health, OSD status, VM/CT disk breakdown | ✅ Shipped |
| Monitoring page — node health, active alerts, Grafana embed | ✅ Shipped |
| AES-256-GCM encrypted credential store | ✅ Shipped |
| One-shot installer + first-run setup wizard | ✅ Shipped |
| LXC creation — template picker, node resource limits, storage with free space | ✅ Shipped |
| VM creation — ISO auto-detection, network config, storage picker | ✅ Shipped |
| CT/VM deletion with confirmation guard | ✅ Shipped |
| CT template + ISO auto-detection across all nodes and storage pools | ✅ Shipped |
| **Terminal — SSH panes for every host, sessions that outlive the browser** | ✅ Shipped |
| **Terminal — split panes, tabs, and saved layouts** | ✅ Shipped |
| **Plug-ins — brokered plug-in system with MikroTik and Plex/Tautulli** | ✅ Shipped |
| **Dashboard — speedometer dials, trend sparklines and live throughput charts** | ✅ Shipped |
| **WAN and LAN bandwidth meters, read from a plug-in** | ✅ Shipped |
| AI deployment — plan generation from natural language | ✅ Shipped |
| **AI providers — Anthropic, OpenAI or any OpenAI-compatible endpoint, alongside Ollama** | ✅ Shipped |
| **AI plans are grounded in live cluster facts and audited before they are shown** | ✅ Shipped |
| AI deployment — plan execution (creates the CT, proxy host, DNS record and certificate; the service install itself is still manual) | ⚠️ Partial |
| Connect to existing Grafana / Prometheus instance | 🚧 v1.0 |

---

## Terminal

An SSH terminal for every host on the cluster, in the browser.

The host list is not something you fill in: HyperProx already knows every VM and
container, so all of them are listed the first time you open it, with addresses
taken from the guest config. Hosts Proxmox has never heard of — a router, a NAS,
a VPS — can be added by hand and sit in the same list. One shared login covers
every host that has none of its own, because entering the same root password
twenty-seven times is how a tool gets abandoned in week one.

Sessions run in **tmux on the target**, so the browser is only a window onto
them: close the tab, come back tomorrow, and the session is still there with its
scrollback. Hosts without tmux get a plain shell and say so — and offer to
install it, over the credential the pane is already using.

Panes can be tabbed, split side by side, stacked, or gridded, and an arrangement
can be saved by name and reopened later. Host keys are pinned on first connect
and a change is refused with both fingerprints shown.

---

## Plug-ins

Plug-ins teach HyperProx about things that are not Proxmox — a router, a media
server — and render them as tiles.

**A plug-in never sees a credential.** It declares in its manifest which settings
it needs and how those settings authenticate an HTTP call; the host resolves
them, makes the request, and returns only the response. That boundary is
deliberate: this process holds your Proxmox token, your proxy and DNS logins and
your SSH keys, and a plug-in able to read the credential store would be a plug-in
able to read all of it. Non-secret settings are readable through `ctx.option()`,
because a plug-in legitimately needs its own configuration; values declared
`secret` never are.

Bundled today:

| Plug-in | What it shows |
|---|---|
| **MikroTik** | The whole router: identity, model, RouterOS and RouterBOARD firmware, CPU, memory, temperature and input voltage; per-device and per-interface throughput; port forwards, firewall counters, WireGuard peers, LLDP/CDP neighbours, listening services, accounts, DNS and the recent log. Feeds the dashboard's WAN and LAN meters, and offers an SSH console. Read-only by intent. |
| **Plex activity** | Who is watching, what they are watching, what is transcoding and what it costs in bandwidth — read through Tautulli, which also supplies the history: recent plays, top watchers, most-watched titles. |

Each plug-in's real output is shown on its gallery card, so you can see what it
renders before placing it anywhere, and a plug-in quietly returning nothing is
obvious rather than discovered later.

### Plug-ins in Prometheus and Grafana

A tile answers *what is happening now*. Prometheus answers *what has been
happening* — whether the link saturates at 3am, whether transcoding piles up on
Sundays, how device count moves across a week.

Plug-ins that publish metrics are scraped at `/api/plugins/metrics` and land in
the bundled Prometheus, ready to graph in the bundled Grafana:

| Metric | From |
|---|---|
| `hyperprox_plugin_up` | every plug-in — 1 when it answered its device on the last scrape |
| `hyperprox_plugin_network_bits_per_second` | MikroTik, labelled `direction` and `interface` |
| `hyperprox_plugin_network_devices` | MikroTik, labelled `state` (awake / leased) |
| `hyperprox_plugin_router_cpu_percent`, `..._memory_bytes` | MikroTik |
| `hyperprox_plugin_plex_streams` | Plex, labelled `decision` (all / transcode / direct_play) |
| `hyperprox_plugin_plex_bandwidth_kbps` | Plex, labelled `scope` (total / lan / wan) |

Metrics are declared separately from tile text on purpose: tile text is written
to be read, and parsing numbers back out of prose is how a metric quietly
becomes wrong.

A **HyperProx — Plug-ins** dashboard is provisioned into Grafana automatically,
so the data arrives on a panel rather than as a query you have to write: WAN
throughput with upload mirrored below the axis, devices awake against devices
leased, router load, Plex streams stacked by decision, and a plug-in health row
that tells you *why* the panels above went quiet.

The endpoint authenticates with `METRICS_TOKEN` from `.env` as a bearer token,
because a scraper has no session to present. **With no token set it refuses**
rather than exposing device names and viewing habits to anything that can reach
the port. The installer generates one; the bundled Prometheus job is configured
to match. A plug-in that fails to answer reports `hyperprox_plugin_up 0` and the
others still publish — one broken device does not blank the scrape.

---

## Known Issues

| Issue | Status |
|---|---|
| **AI deployment does not install the service** — the wizard creates the container, proxy host, DNS record and SSL certificate, but the install step only *generates* commands; run them in the container or the domain will return 502. The step reports itself as skipped. | ⚠️ By design, for now |
| **Wattage not displayed on all hardware** — power draw requires CPU power counter support. See [Monitoring](#monitoring--additional-setup-required) for details. | ℹ️ Hardware dependent |

### Workarounds

**CEPH MON node** — detected automatically at runtime and re-detected if that node
stops answering, so no configuration is needed. `CEPH_MON_NODE` in `.env` remains
supported as an explicit override; leave it empty unless you need to pin one.


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
| prometheus | Metrics collection | 9090 |
| grafana | Visualization | 3003 |
| pve-exporter | Proxmox metrics bridge | 9221 |
| postgres | Config + state storage | 5432 |
| redis | Queue + cache | 6379 |
| nginx | Internal reverse proxy | 80 |

> Prometheus runs with `network_mode: host` so it can scrape node_exporter directly on the host network. All other services run on an internal bridge network.

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
