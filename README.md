<p align="center">
  <img alt="HyperProx" src="docs/hyperprox-banner.png" width="700" />
</p>

<p align="center">
  <strong>Your Proxmox infrastructure, hypercharged.</strong>
</p>

<p align="center">
  <a href="https://www.gnu.org/licenses/agpl-3.0"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3"></a>
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

That is the whole thing, and the recommended way. It picks a free container ID and
the storage with the most room, fetches the current Debian template, creates the
container with the features Docker actually needs, mints the Proxmox API token,
installs `node_exporter` on every node so Monitoring has data immediately,
installs HyperProx, and prints you a URL: `https://<container-ip>/`.

It is safe to re-run — anything already correct is left alone.

Already have a container, a VM or a machine for it? Use
[install.sh from a clone](#alternative-installsh-from-a-clone) instead.

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
--skip-rapl         Do not install the power-metrics udev rule
--skip-gpu-exporter Do not install the Intel GPU exporter
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
| Discover that power metrics silently need a udev rule, on every node | The rule is written and applied (`--skip-rapl` to decline) |
| Work out which nodes have an Intel iGPU and hand-run a container on each | Detected by PCI vendor and installed only there (`--skip-gpu-exporter` to decline) |
| Find the CEPH monitor node and set `CEPH_MON_NODE` | Detected at runtime, and re-detected if that node goes away |
| Type the address of every service you want a plug-in for | **Scan for services** finds them |

### Finding your services

Open **Plug-ins** and press **Scan for services**. HyperProx already knows every
guest on the cluster and its address, so it probes them for services it has a
plug-in for and offers to configure what it finds:

```
qBittorrent  http://10.0.0.20:8080   on media-stack (201)
Sonarr       http://10.0.0.20:8989   on media-stack (201)   still needs an API key
Unmanic      http://10.0.0.21:8888   on transcoder (202)
```

Every probe is an unauthenticated GET against a port a known service answers on.
Nothing is written until you press **Use this**, and an API key is never guessed
— where one is needed it says so and opens the settings form.

Only running containers with an address Proxmox can read are scanned. A VM
without the guest agent has no address to probe, and nothing outside the cluster
is touched.

### Alternative: install.sh from a clone

`bootstrap.sh` runs this same installer inside the container it creates. Run it
yourself when the machine already exists — your own container, a VM, or bare
metal (Debian 12 or 13, or Ubuntu 22.04 / 24.04), as root:

```bash
apt update && apt install -y git curl
git clone https://github.com/hyperprox/alpha.git /opt/hyperprox
bash /opt/hyperprox/install.sh
```

The installer works from that clone: `/opt/hyperprox/docker-compose.yml` and
`config/` are used as they are, and everything specific to your install goes in
`/opt/hyperprox/.env`. Re-running it is safe and keeps your data and settings.

It does not create the container or the Proxmox token for you; the steps below
cover both.

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

You do not need to make an API token: the setup wizard signs in with your Proxmox
login and creates one for itself (see **First-run setup** below). If you would
rather hand it one, create it and paste it under **Advanced** on the wizard's
first step:

```bash
pveum user token add root@pam hyperprox --privsep=0
pveum acl modify / --token 'root@pam!hyperprox' --role Administrator
```

Then, inside the container, clone and run the installer as shown above.

</details>

### HTTPS

HyperProx is served by its bundled nginx on `https://<container-ip>/`; plain http
on port 80 redirects there. The app's own services listen on loopback only and
are reached through nginx, WebSockets (live updates, the terminal) included.
Grafana is served on the same origin at `/grafana/`, so the Monitoring page can
embed it.

The installer generates a self-signed certificate when you have not supplied one,
so the browser warns once. To use your own, put the full chain in
`/opt/hyperprox/certs/cert.pem` and the key in `/opt/hyperprox/certs/key.pem`
(before installing, or any time after), then `docker restart hyperprox-nginx`.

If another reverse proxy (Nginx Proxy Manager, say) terminates TLS in front of
HyperProx, point it at `http://<container-ip>:80` and tell nginx to trust it.
nginx believes a proxy's `X-Forwarded-Proto: https`, and serves its requests
instead of redirecting them, only from loopback and the addresses you list:

```bash
mkdir -p /opt/hyperprox/data/nginx/trusted-proxies
echo '10.0.0.7 1;' > /opt/hyperprox/data/nginx/trusted-proxies/proxies.conf   # your proxy's address or CIDR
docker restart hyperprox-nginx
```

From any other address the header is ignored, so nobody can use it to talk
plain http to port 80.

HSTS is not sent. With a self-signed certificate on a LAN address it would lock
browsers out the day the certificate changes. If you serve HyperProx under a
real domain with a real certificate, you can add
`add_header Strict-Transport-Security "max-age=31536000" always;` to the
:443 server in `config/nginx/conf.d/hyperprox.conf`.

### First-run setup

When the install finishes it prints the wizard link, `https://<container-ip>/setup?k=<setup key>`. The key is what lets the wizard accept requests, so keep the link private; if you lose it, `grep SETUP_SECRET /opt/hyperprox/.env` on the host gives it back.

The wizard keeps its progress on the server. Reload it, or open the link again
tomorrow, and it picks up at the step it had reached.

1. **Connect your Proxmox** — sign in with the same username and password you use
   for the Proxmox web interface (two-factor codes are supported). HyperProx uses
   that login once to create its own API token, named
   `hyperprox-<container-hostname>-<install id>`, and never stores your password.
   The install id is random, made once and kept in `.env` (`HYPERPROX_INSTALL_ID`),
   so two installs never share a token name, even when both containers are called
   `hyperprox`. Connecting again reuses the token while HyperProx still holds its
   secret. If the secret has been lost, it deletes and recreates that one token,
   but only when the token's comment carries this install's id. Any other token is
   never touched.
2. **Cluster detected** — nodes, storage and Ceph, read back through the new token.
3. **Existing services** — Nginx Proxy Manager and Proxmox Backup Server already on
   the cluster are found by their web interface, and HyperProx will not offer to
   install a second NPM over one it found.
4. **DNS provider**, then **Cluster connected**, which sends you to HyperProx's sign-in page.

The wizard no longer asks you to invent an admin password: **HyperProx has no password of its own.**
Open `https://<container-ip>/login` and **create the owner vault account**: an email, a master
password and a two-factor code (an authenticator app; 2FA is required for the owner). From then on you
sign in with those. See [Security](#security) for what that protects and what it does not.

Check on it from the machine with `hyperprox status`; `hyperprox lock` locks it at once.

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

### Power measurement

Power comes from your CPU's RAPL energy counters, read by node_exporter's
`rapl` collector, plus `nvidia-smi` for discrete GPUs. `bootstrap.sh` sets this
up on every node; the rest of this section is what it does and why, for anyone
installing by hand or wondering why a node reads nothing.

**The permission that decides whether any of this works.** Since kernel 5.10,
`/sys/class/powercap/*/energy_uj` is `0400` root-only — a PLATYPUS mitigation,
because energy readings are fine-grained enough to leak AES keys. node_exporter
runs unprivileged, so without a change it gets `EACCES` and the rapl collector
yields **nothing**: no error, no warning, just a metric that never appears. A
cluster total then silently covers only the nodes that happened to be readable,
and looks perfectly healthy while doing it.

`bootstrap.sh` installs this rule on each node, and `--skip-rapl` declines it:

```
SUBSYSTEM=="powercap", ACTION=="add|change", RUN+="/bin/chmod o+r /sys%p/energy_uj"
```

It chmods the device udev is reporting rather than walking the tree. A rule of
the form `find /sys/class/powercap -name energy_uj -exec chmod …` looks correct
and never fires: `RUN+=` runs once per domain *as each appears*, so the find
searches a directory that is not yet populated. Delete
`/etc/udev/rules.d/99-hyperprox-rapl.rules` to undo it.

**Which domains are added, and which are not.** RAPL exposes several and they
are not peers:

| Domain | Treatment | Why |
|---|---|---|
| `package-0` | base figure | the CPU package |
| `core`, `uncore` | **never read** | slices of `package` — adding them counts the same watts two or three times |
| `dram` | **added** | a genuinely separate rail |
| `psys` | **replaces** package + dram | the platform rail, including VRM and board losses the CPU domains cannot see. On a board that exposes it, psys typically reads two to three times package+dram |
| discrete GPU | **added** | on PCIe, outside every domain above, `psys` included |
| `igpu_power_package` | stand-in only | the same package domain read by `intel_gpu_top`; used only where RAPL cannot be read, never in addition |

**What it does not cover.** Drives, fans, memory outside the DRAM rail, and PSU
conversion losses are not instrumented by any of this. The figure is silicon
draw, not wall draw — a node with a stack of spinning disks can easily draw
another 40–60 W that nothing here sees. `psys` is the closest available proxy
for board power, and most boards do not expose it. For true wall power you need
a metered PDU or a UPS that reports load.

**Reading the display.** The dashboard tile shows `POWER 4/5` when a node
reports nothing, rather than quietly summing what it has. Each node card and
each Infrastructure chip shows its own figure, or `no meter` — those two states
are drawn differently on purpose, because a node measuring nothing and a node
drawing nothing are not the same fact.

If a node reads `no meter`, check in this order: node_exporter is installed;
`/etc/udev/rules.d/99-hyperprox-rapl.rules` exists; `stat -c %a
/sys/class/powercap/intel-rapl:0/energy_uj` returns `404` and not `400`; and the
CPU exposes RAPL at all (`ls /sys/class/powercap/`).

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

### Intel GPU metrics (optional — Intel iGPUs)

`bootstrap.sh` installs this automatically on nodes with an Intel GPU, and skips
AMD and NVIDIA nodes — `intel_gpu_top` has nothing to talk to there and the
container would crash-loop. `--skip-gpu-exporter` declines it. By hand:

```bash
docker run -d --name intel-gpu-exporter --restart unless-stopped \
  --privileged --pid host -v /dev/dri:/dev/dri -p 8081:8080 \
  ghcr.io/onedr0p/intel-gpu-exporter:rolling
```

It reports iGPU utilisation, and a package power figure that stands in where
RAPL cannot be read. Measured against RAPL on the same hosts, its
`igpu_power_package` tracks `node_rapl_package_joules_total` within 1%.

**You do not need to edit `prometheus.yml`.** HyperProx detects nodes and writes
the scrape target files itself — Settings → Targets, or `POST
/api/targets/sync`.

---

## AI Assistant — current state

The assistant turns a sentence into a deployment plan, then runs it. It is still
early, and the section below says exactly where the edges are.

**Three providers, one interface.** Pick one in Settings → AI:

| Provider | Needs | Notes |
|---|---|---|
| **Anthropic** | An API key | The plan schema constrains generation natively, so a malformed plan is not a failure mode. Defaults to `claude-opus-5-5` (Claude Opus 5.5); set a different model in Settings → AI. |
| **OpenAI** | An API key | Uses JSON-schema structured output. The base URL is settable, so the same path also reaches OpenRouter, Groq, Together or any OpenAI-compatible server. |
| **Ollama** | A reachable Ollama server | Free and private. HyperProx does not bundle or install Ollama — point it at one you already run. |

Cloud keys are kept in the vault like every other credential, and are never sent to the browser.

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
- Installing the service needs an SSH login for the node; without one the
  `install_service` step is skipped and shows you the commands to run instead.
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

## Security

HyperProx can change everything it manages, so it holds nothing of value outside a vault. Every install
runs its own stock, unmodified [Vaultwarden](https://github.com/dani-garcia/vaultwarden) (pinned by
digest, listening on the loopback interface only), and HyperProx will not start without it. You sign in
with your vault account (email, master password, two-factor code); roles come from the vault
organization; HyperProx starts **locked** and locks itself again when idle.

```bash
hyperprox status   # is the vault up, is HyperProx locked?
hyperprox lock     # lock it now: wipe secrets from memory, end every session
```

**Shipped (phase 1):** the built-in Vaultwarden, vault sign-in with 2FA required for the owner, secrets
held in memory only, auto-lock and `hyperprox lock`, four roles (Owner, Admin, Operator, Viewer),
re-confirmation for dangerous actions, and Bitwarden Sends for handing a secret to someone.

Read [docs/security.md](docs/security.md) for the model in plain language, what is protected now, what
is **not** yet, and the caveats that matter.

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
| **Vault gate — built-in Vaultwarden, vault sign-in with 2FA, secrets in memory only, auto-lock, four roles** | ✅ Shipped |
| One-shot installer + first-run setup wizard (Debian 12/13, Ubuntu 22.04/24.04) | ✅ Shipped |
| **Setup wizard signs in with your Proxmox login and creates its own uniquely named token** | ✅ Shipped |
| **Setup wizard locked to a per-install setup key, same-origin only** | ✅ Shipped |
| **Service scan finds the NPM, PBS, Grafana and Prometheus you already run** | ✅ Shipped |
| LXC creation — template picker, node resource limits, storage with free space | ✅ Shipped |
| VM creation — ISO auto-detection, network config, storage picker | ✅ Shipped |
| CT/VM deletion with confirmation guard | ✅ Shipped |
| CT template + ISO auto-detection across all nodes and storage pools | ✅ Shipped |
| **Terminal — SSH panes for every host, sessions that outlive the browser** | ✅ Shipped |
| **Terminal — split panes, tabs, and saved layouts** | ✅ Shipped |
| **Plug-ins — brokered plug-in system: Arr Stack, Unmanic, MikroTik, Plex/Tautulli and Home Assistant** | ✅ Shipped |
| **MikroTik plug-in — the whole router, per-device bandwidth and an SSH console** | ✅ Shipped |
| **Dashboard — speedometer dials, trend sparklines and live throughput charts** | ✅ Shipped |
| **WAN and LAN bandwidth meters, read from a plug-in** | ✅ Shipped |
| **Per-node and cluster power, from every RAPL domain the board exposes** | ✅ Shipped |
| **Terminal — host palette on Ctrl/⌘ K, no second sidebar** | ✅ Shipped |
| **Terminal — open a host's existing tmux sessions in their own panes, singly or all at once** | ✅ Shipped |
| **Service catalogue — install a reverse proxy, Ollama or Tautulli you do not have** | ✅ Shipped |
| **AI wizard installs the service itself, where a node login is stored** | ✅ Shipped |
| **Home Assistant plug-in — dead entities, flat batteries, pending updates** | ✅ Shipped |
| **Responsive down to a phone, with a navigation drawer** | ✅ Shipped |
| **Installable as a PWA — offline page, shortcuts, never caches live data** | ✅ Shipped |
| **Light and dark mode, one design language throughout** | ✅ Shipped |
| **90-day metrics history in the bundled Prometheus, sized by the wizard for your cluster** | ✅ Shipped |
| AI deployment — plan generation from natural language | ✅ Shipped |
| **AI providers — Anthropic, OpenAI or any OpenAI-compatible endpoint, alongside Ollama** | ✅ Shipped |
| **AI plans are grounded in live cluster facts and audited before they are shown** | ✅ Shipped |
| AI deployment — plan execution, end to end: container, service install, proxy host, DNS record, certificate | ✅ Shipped |
| Run commands inside any guest from the node, without a guest credential | ✅ Shipped |
| Connect to existing Grafana / Prometheus instance — works through `PROMETHEUS_URL` and `NEXT_PUBLIC_GRAFANA_URL` in `.env`; no settings UI yet | ⚠️ Partial |

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

A pane already lives inside tmux, so typing `tmux attach` in it would nest one tmux
in another, and tmux refuses. Instead, the pane header has a **Sessions** menu
listing what is already running on that host (its windows, attached clients and
last activity). Pick one to open it in a pane of its own, attached directly, beside
the pane you came from; **Open all** opens every session at once, side by side for
two and in a grid for more.

Hosts are opened from a palette rather than a permanent column: the **+** in the
tab bar, or **Ctrl/⌘ K** from anywhere on the page. Type to filter, arrows to
move, Enter to open, Escape to leave. A terminal wants width, and a list of
hosts is only needed at the moment you open one — a second menu stacked against
the app's own nav earned its place on neither count.

Panes can be tabbed, split side by side, stacked, or gridded, and an arrangement
can be saved by name and reopened later. Host keys are pinned on first connect
and a change is refused with both fingerprints shown.

---

## On a phone

The interface is responsive, and it installs. Open it on a phone and use the
browser's *Add to Home Screen* — it then runs full-screen with its own icon,
and the shortcuts drop you straight into the Terminal, Dashboard or Plug-ins.

Below the `md` breakpoint the navigation becomes a drawer, the dashboard's
columns stack, dial rows wrap, tables scroll inside their own container rather
than dragging the page sideways, and the Terminal shows one pane at a time
whatever the view mode says — two 80-column shells side by side on a phone is
two unreadable shells. Panes stay connected either way; the layout only decides
what is drawn.

**The service worker never caches an API response, by design.** This is a
console for live infrastructure: a stored `/api/proxmox/summary` replayed as
current shows a node up that went down an hour ago, and that is the reading
someone acts on. Hashed static assets are cached, because a filename containing
a content hash cannot go stale. When there is no network you get an offline page
that says plainly it is not showing your cluster, rather than a convincing
screenshot of the past.

`sw.js`, the manifest and the offline page are served without a session — a
browser fetches the manifest before anyone signs in, and shows the offline page
exactly when it cannot reach the server to authenticate. They contain the app's
name, colours and caching rules and nothing else; every API route and page stays
behind auth.

---

## Service catalogue

Everything else in HyperProx assumes you already run the thing it talks to. This
is the page for when you do not: a reverse proxy, Ollama, Tautulli. It creates a
container, installs the service, checks it answers, and writes the address into
the integration that was waiting for it — the last step being the point, since an
install that leaves you copying a URL into a settings form has done the easy half.

**It needs one SSH login per node, and that is a real decision.** Installs run
with `pct exec` from the node rather than by SSH into the container. The
alternative needs a credential for a guest that is a minute old, an sshd that may
not be installed, and a DHCP lease that may not have arrived — `pct exec` needs
none of those, because the node already owns the container.

The consequence is that HyperProx asks for a login on the hypervisor. It is
tested before it is stored, it is kept in the vault with everything
else, and it is deliberately **not** shared with the Terminal's guest login: that
password was given so one root account could cover a shelf of containers, and
borrowing it to reach the hosts would be both a guess and a quiet widening of
what you granted. A key is the better answer — it can be revoked on the node
without changing anything else.

Nothing is created before that check passes. An earlier build checked at the
install step, which is to say after building a container, and a missing login
then cost you a stray guest to clean up for a job that could never have finished.

| Recipe | Provides | Notes |
|---|---|---|
| **Nginx Proxy Manager** | the reverse proxy HyperProx drives for proxy hosts and certificates | takes 80 and 443 on its container |
| **Ollama** | a local provider for the deployment wizard | binds `0.0.0.0` on purpose — the default loopback bind is the usual reason a model server "cannot be reached". No model is pulled; do that from the AI page |
| **Tautulli** | Plex history for the Plex plug-in | history starts the day it is installed; it cannot backfill |

Installs are tracked in memory, so restarting the API loses the progress view of
one already running. The container and the service it installed are unaffected.

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

Bundled today — the live list is on the **Plug-ins** page, which is the one that
cannot go stale:

| Plug-in | What it shows |
|---|---|
| **Arr Stack** | Sonarr, Radarr, Prowlarr and qBittorrent as one thing, because they are one thing. What needs a person versus what automation will retry on its own, the queue with season packs marked as packs, active downloads, torrents by state, anything with no progress in over an hour, indexer health. |
| **Unmanic** | Transcode workers across every node: what each is working on, how far in, what is queued and what failed. |
| **MikroTik** | The whole router: identity, model, RouterOS and RouterBOARD firmware, CPU, memory, temperature and input voltage; per-device and per-interface throughput; port forwards, firewall counters, WireGuard peers, LLDP/CDP neighbours, listening services, accounts, DNS and the recent log. Feeds the dashboard's WAN and LAN meters, and offers an SSH console. Read-only by intent. |
| **Plex activity** | Who is watching, what they are watching, what is transcoding and what it costs in bandwidth — read through Tautulli, which also supplies the history: recent plays, top watchers, most-watched titles. |
| **Home Assistant** | What has quietly stopped working. Unavailable entities sorted longest-dead first, batteries under a level you set, updates waiting, automations and when each last ran, what is on right now, entities by domain, and the error lines from the log. **Read-only by intent** — every write against this API actuates something physical, so it never calls `/api/services`. |

Each plug-in's real output is shown on its gallery card, so you can see what it
renders before placing it anywhere, and a plug-in quietly returning nothing is
obvious rather than discovered later.

### Asking for one that does not exist

The Plug-ins page also lists what has **not** been built — Proxmox Backup Server,
Pi-hole, UniFi, TrueNAS, Frigate, a UPS, and others — each with a button that
opens a pre-filled issue on GitHub in your browser. Ideas, not promises: nothing
there is scheduled, and asking is what moves one up.

HyperProx holds no GitHub token and posts nothing on your behalf. The request
arrives under your own name, and no installation has to store a credential so a
button can work.

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
| `hyperprox_plugin_home_entities`, `..._entities_unavailable` | Home Assistant |
| `hyperprox_plugin_home_batteries_low`, `..._updates_pending` | Home Assistant |
| `hyperprox_plugin_home_automations` | Home Assistant, labelled `state` (on / off) |
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
| **The AI wizard needs one SSH login per node to install anything** — with one stored it creates the container and installs the service itself. Without one it still creates everything else and prints the commands, and says so rather than reporting success. | ℹ️ Add node logins on the Catalogue page |
| **A node shows `no meter` for power** — usually the udev rule rather than the hardware: `energy_uj` is root-only from kernel 5.10 and node_exporter runs unprivileged, so the rapl collector silently yields nothing. `bootstrap.sh` installs the rule; see [Power measurement](#power-measurement) for the order to check things in. Genuinely absent on some CPUs and inside VMs. | ℹ️ Usually fixable |
| **HA card can read 0** on a cluster that has HA resources — the count is being checked against token privileges | Investigating |
| **Storage gauge and the Ceph bar can disagree** (raw vs usable capacity) | Investigating |
| **NPM and Prometheus can stay on "checking…"** on a fresh install although both are running; Grafana shows no status pill | Investigating |
| **Power reads "–" with no reason** when no node exposes RAPL | Planned: say why, or hide the card |
| **Tokens from earlier wizard runs stay on the cluster** — before the wizard reused its token, each connect made a new `hyperprox-<host>-<random>` one. HyperProx never deletes tokens it does not own by its current name, so remove old ones under Datacenter → Permissions → API Tokens | ℹ️ One-time cleanup |

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

The HyperProx app (frontend, API, setup wizard) runs as systemd services; `docker compose` runs everything around it:

| Service | Purpose | Port |
|---|---|---|
| hyperprox-frontend | Next.js dashboard | 127.0.0.1:3000 |
| hyperprox-api | Fastify API + WebSockets | 3002 |
| hyperprox-setup | First-run setup wizard | 127.0.0.1:3001 |
| hyperprox-vault | Vaultwarden: the sign-in gate and secret store (loopback only) | 127.0.0.1:8222 |
| prometheus | Metrics collection | 9090 |
| grafana | Visualization | 3003 |
| pve-exporter | Proxmox metrics bridge | 9221 |
| postgres | Config + state storage | 5432 |
| redis | Queue + cache | 6379 |
| nginx | The front door: TLS, and the route to every service above | 443 (80 redirects) |
| nginx-proxy-manager | Optional bundled NPM (compose profile `npm`), when you do not already run one | 80/443/81 |

> Prometheus runs with `network_mode: host` so it can scrape node_exporter directly on the host network, and nginx does too so it reaches the app's loopback-only services. The other containers run on an internal bridge network.
>
> `docker-compose.yml` in the repo is the only compose file; the installer, `deploy.sh` and the setup wizard all use it as it is. Per-install settings live in `.env`, including `COMPOSE_PROFILES` (`monitoring`, `npm`), which compose reads itself.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 · Radix UI (shadcn/ui) |
| Backend | Node.js · Fastify |
| Real-time | WebSockets |
| Database | PostgreSQL · Prisma ORM |
| Queue | BullMQ · Redis |
| Monitoring | Prometheus · Grafana (bundled, auto-configured) |
| AI | Anthropic, any OpenAI-compatible endpoint, or Ollama (external, optional) |
| Containers | Docker · Compose |

---

## Roadmap

### Next — designed, not built yet

Each of these has a written design in [`docs/superpowers/specs/`](docs/superpowers/specs/). Comments
on them are welcome before the code exists.

- **Vault gate, phase 2** ([design](docs/superpowers/specs/2026-10-14-vault-gate-design.md)). Phase 1
  is built and shipping — see [Security](#security). Designed, not built yet:
  - **Temporary users:** access to named guests that expires on its own.
  - **Recovery:** `hyperprox --force-reset <email>` from a sealed Master Reset Password.
  - **Editions:** Homelab (everything) and Business (media plug-ins removed); a Homelab install can move
    to Business, not back.
  - **Access modes:** local network only is the default today; the built-in WireGuard VPN, hardened
    internet access and existing-tunnel modes are not built.
  - **Tamper check** of the installed files before every unlock, and an **audit timeline** joining the
    vault's events with HyperProx's own.
  - **Least-privilege tokens** per role, and credential rotation in the target system.
  - **AI:** the assistant never sees a secret (applies when the operator arrives).
- **Updates** ([design](docs/superpowers/specs/2026-10-06-updates-design.md)). One page shows what's
  pending on every node, container and VM, and runs the round on demand or on a schedule.
  - **One node at a time:** checks Ceph and quorum health before each node and stops at the first
    failure. Reboots use HA maintenance mode and Ceph `noout`.
  - **Your rules, in your config file:** for example "this node gets `apt upgrade` only, never
    `dist-upgrade`, and stop if its kernel pin is missing", or "don't reboot while a Plex stream is
    playing". The rules live in a local file, not in the code.
- **Releases, update and uninstall** ([design](docs/superpowers/specs/2026-10-06-installer-design.md),
  [plan](docs/superpowers/plans/2026-10-06-installer.md)).
  - **Releases:** versioned, prebuilt and checksum-verified, each one proven by an automated install
    on a clean Proxmox before it's published.
  - **Installer:** Default and Advanced menus.
  - **CLI:** `hyperprox update | rollback | uninstall`; a failed update puts the old version back.

### v1.0 — The Glue Layer

Struck items are done. Two things changed since this list was written: the
plug-in system arrived, which absorbs several of these more cheaply than a
bespoke feature would, and the wizard learned to run commands inside a guest,
which was the blocker under the autonomous-deployment item.

- ~~**AI deployment wizard — full autonomous execution**~~ — **done.** The
  wizard creates the container, installs the service with `pct exec` from the
  node, configures the proxy host, creates the DNS record, waits for
  propagation and requests the certificate. Needs one SSH login per node; with
  none stored it does everything except the install and says so.
- **Connect to existing Grafana / Prometheus** — *half done.* Both are already
  configurable in `.env`; what is missing is a settings surface and a
  credential-store entry so it is not a file edit.
- **Smart Suggestion Engine** — cross-system awareness: new proxy host → suggest DNS record, WAN IP change → flag stale A records, SSL expiring → suggest renewal. Nothing acts without user confirmation.
- **Network Storage Health** — monitor CIFS/NFS mounts across all nodes, surface offline mounts as named alerts, correlate mount failures with downstream monitoring issues.
- **Multi-provider DNS** — GoDaddy + Cloudflare + Namecheap simultaneously.
  GoDaddy is the only client written; the other two already have credential
  definitions, so this is a client each against an interface that exists.
- **Multi-instance proxy** — NPM + Traefik + Caddy + HAProxy + Pangolin
  simultaneously. Same shape as above: NPM is the only client so far.
- **Proxmox rolling updates** — CEPH-aware, per-node sequencing. *Designed:* see **Updates** above.
- **HyperProx self-update** — one-click from UI. *Designed:* see **Releases, update and uninstall** above.
- **PBS backup monitoring** — datastore usage, job history, retention policies.
  Better served as a plug-in now that plug-ins exist; it is already in the
  catalogue's "not built yet" list, where anyone can ask for it.
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
- **Role-based access control (RBAC)** — four roles shipped with the vault gate (Owner, Admin, Operator, Viewer); Temporary users are next
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
| Network storage health | 🔜 v1.0 | ❌ | ❌ | ❌ |
| Smart suggestion engine | 🔜 v1.0 | ❌ | ❌ | ❌ |
| AI deployment wizard | ✅ | ❌ | ❌ | ❌ |
| Bundled monitoring | ✅ | ❌ | ❌ | ❌ |
| Runs in Docker | ✅ | ❌ | ❌ | ✅ |
| curl \| bash install | ✅ | ✅ | ❌ | ✅ |
| Multi-cluster | 🔜 v2.0 | ✅ | ✅ | ❌ |
| Cross-cluster migration | 🔜 v2.0 | ✅ | ❌ | ❌ |
| ESXi migration | 🔜 v2.0 | ✅ | ❌ | ❌ |
| XCP-NG support | 🔜 v2.0 | ✅ | ❌ | ❌ |
| VPN management | 🔜 v2.0 | ❌ | ❌ | ❌ |
| RBAC | ✅ four roles | ✅ | ✅ | Partial |
| CVE scanner | 🔜 v2.0 | ✅ | ❌ | ❌ |
| PVE hardening | 🔜 v2.0 | ✅ | ❌ | ❌ |
| Bare metal installer | 🔜 v2.0 | ❌ | ✅ | ❌ |
| Load balancing (DRS) | ❌ | ✅ | ❌ | ❌ |
| Free & open source | ✅ AGPL v3 | ✅ AGPL v3 | ✅ AGPL v3 | ✅ |

✅ shipped · 🔜 planned for the version shown.

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
