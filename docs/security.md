# Security: the vault gate

HyperProx can start, stop and destroy guests, change storage and network, and hold the keys to your DNS,
proxy and hypervisor. Before the vault gate, all of that sat behind one password, and the keys that
protected its stored credentials lived in a file on the same machine. Whoever read that file, or a copy
of the disk or a backup, got everything.

The fix is to put HyperProx behind something people already trust: **Vaultwarden**, an open-source,
Bitwarden-compatible, zero-knowledge vault. Every install runs its own, stock and unmodified.

## How it works

- **A built-in vault.** The `hyperprox-vault` container is Vaultwarden, pinned by digest, listening on
  `127.0.0.1:8222` only, over TLS with a self-signed certificate the installer makes in
  `config/vault-tls` (the Bitwarden command-line client refuses plain http; HyperProx trusts that
  certificate through `VAULT_CA_CERT`). Send links use the loopback origin unless you set `VAULT_PUBLIC_URL` in
  `.env` to an https address people can reach. Public signups are off; accounts exist only by invitation. The vault starts first,
  and the HyperProx API refuses to start until it answers. There is no "HyperProx without the gate".
- **One login.** You sign in to HyperProx with your vault account: email, master password, and a
  two-factor code. HyperProx has no password of its own. The very first visit to `/login` offers to create
  the **owner** account, and two-factor is mandatory for it.
- **Starts locked.** After a reboot HyperProx is locked: nothing is decrypted, and every route except
  health and sign-in answers "locked" (HTTP 423). Your first successful sign-in unlocks it.
- **Deploys do not lock it.** The unlocked state is held by a small separate service, the **keyholder**
  (`hyperprox-keyholder`), as well as by the API. Restarting the API (every `deploy.sh` does) re-attaches
  to it and carries on unlocked, with everyone still signed in. The keyholder holds it in memory only;
  both it and the API run with swap and core dumps turned off for their service (`MemorySwapMax=0`,
  `LimitCORE=0`), so neither writes it to a swap device or a crash file. The keyholder answers only on a
  root-only unix socket, and only to a process running as the API's user whose cgroup is exactly
  `/system.slice/hyperprox-api.service` (checked with `SO_PEERCRED` and, where the kernel has it,
  `SO_PEERPIDFD`); it has no network access, no capabilities and a system-call filter. Stopping,
  restarting or crashing the keyholder, or rebooting, **locks**. `deploy.sh` restarts the keyholder only
  when its own program changed, and says so. If the keyholder will not start, `deploy.sh` removes the
  API's keyholder setting first, so the API keeps today's behaviour (a restart locks) instead of being
  unable to unlock. Lock now is reported only once the keyholder confirmed it wiped its copy (or was
  restarted, which wipes it); otherwise it answers an error, never "locked".
- **Secrets live in memory only.** On unlock, the credentials HyperProx needs (hypervisor token, DNS and
  proxy logins, and so on) are read from the vault into process memory, and a fresh random session-signing
  key is generated. Neither is ever written to disk. Nothing in the database, `.env` or a backup can mint a
  session or be decrypted into a credential.
- **Auto-lock.** After `VAULT_IDLE_LOCK_MINUTES` (default 30) with no request from any signed-in session,
  HyperProx wipes the cache and the key and voids every session. The keyholder keeps this timer, so it
  holds even if the API is down. `hyperprox lock` and **Lock now** do the same on demand.
- **Lock alert.** When HyperProx locks by itself (idle, keyholder stopped, reboot while unlocked) it posts
  one message with a link to the sign-in page: open it and sign in to unlock. It goes to the notification
  channels marked **Works while locked** (Settings → Notifications, see `docs/notifications.md`), with
  `HYPERPROX_PUBLIC_URL` (the address you open HyperProx at) for the link. Those channels' addresses and
  tokens cannot be in the vault, which is what is locked, so they are kept in
  `data/notify-locked-channels.json` (mode 0600, git-ignored): anyone who can read that file (root on the
  host, a copy of its disk or backups) can post to those channels. Only an owner can mark a channel that
  way, per channel; every other channel's secret is a vault item. An existing `LOCK_ALERT_URL` /
  `LOCK_ALERT_KIND` / `LOCK_ALERT_TOKEN` in `.env` (or, without one, the Updates or Certificates webhook
  it used to fall back to) is moved onto such a channel once, at the first start of this version, and is
  not read after that. The message never carries a secret, token or session; signing in is the unlock. A
  manual lock sends nothing.
- **Notification channels.** Only admins add or edit them, and every send passes an SSRF guard: https
  only (http only with the per-channel "Self-hosted on my network" switch), Discord, Slack, Teams and
  Telegram pinned to their public hosts, the address resolved and checked at send time, link-local and
  metadata addresses always refused, private and loopback addresses only with the switch and never on
  HyperProx's own service ports, and no redirects followed. Logs, the delivery history and the audit log
  record a channel's id, kind, HTTP status and an error code, never its address, token or a response body.
- **Monitoring is behind the sign-in too.** Prometheus and Grafana listen on loopback only. nginx serves
  Grafana at `/grafana/`, and before each request (pages, queries, the live WebSocket) it asks the API
  (`GET /api/auth/check`) whether the browser holds a valid HyperProx session while HyperProx is
  unlocked. No session, or locked, is a redirect to sign in; an API token is refused; the API not
  answering (within 2 s to connect, 5 s to reply) is an error, never a pass. Grafana's own anonymous
  viewer is therefore reached only by signed-in people. nginx sends Grafana no Cookie and no
  Authorization header, so HyperProx's session never reaches it, and Grafana's login form, basic auth
  and plugin admin are switched off: from behind nginx nobody can become more than that anonymous
  viewer (admin work is `docker exec hyperprox-grafana grafana cli admin ...` on the host). These checks
  do not reset the auto-lock timer or mark the session as recently active, so a dashboard refreshing
  itself does not keep HyperProx unlocked.
- **Every signed-in person can read every metric.** The anonymous viewer behind `/grafana/` is the same
  for everyone, whatever their HyperProx role, so any signed-in viewer can run any PromQL query
  through Grafana and see every series Prometheus holds, along with what Grafana shows of Prometheus's
  read API (targets, scrape configuration with credentials redacted, flags). Prometheus refuses writes
  through Grafana. nginx refuses Grafana's raw datasource proxy (`/grafana/api/datasources/proxy/`) and
  its datasource list to everyone; dashboards do not use either. If some people must not see all
  metrics, do not give them a HyperProx account: per-role Grafana access is not built.
- **A Grafana WebSocket outlives a sign-out.** The session check runs once per request, and for Grafana
  Live's WebSocket that is once, when it opens. A socket opened before a sign-out or a lock keeps
  streaming metrics until the page closes it, or until it carries nothing for 300 seconds (nginx's idle
  timeout on `/grafana/`). Every new page, query or socket is checked again.
- **Roles.** They come from the person's membership in the vault's "HyperProx" organization:

  | Vault role | HyperProx role | Can |
  |---|---|---|
  | Owner | owner | Everything, including role management |
  | Admin | admin | Everything except role management |
  | Manager | operator | View, start/stop/restart guests, open consoles |
  | User (or Custom) | viewer | View only |

  Removing someone from the vault removes their access. Their personal vault is theirs alone and is not
  readable by HyperProx or any admin.
- **Adding people.** Invite them to the "HyperProx" organization in the vault. Invite as **Manager** to make
  them an operator (put them in the group "HyperProx operators"), or as **User** for a viewer (group
  "HyperProx viewers"). Owner and Admin memberships are full. The owner's two-factor code is enforced at
  every sign-in.
- **Re-confirmation.** Revealing a secret, destroying a guest, changing roles, resetting Grafana's admin
  password, and every change on the Setup checklist (saving a node login, running an item on your nodes,
  shredding old backups, opening or closing built-in graphics) ask for the master password again (valid
  for five minutes).
- **Secrets page** (Settings, Secrets): names only. Owners and admins can reveal a value (with
  re-confirmation), **Send** it to a person as an expiring, view-limited, encrypted link (a Bitwarden Send,
  24 hours and one view by default), or **generate** a strong password that is saved straight to the vault.
- **Existing installs migrate.** On the first owner unlock, credentials from the old encrypted table and
  `.env` are written to the vault and read back; only then are the old rows deleted and the keys blanked
  in `.env` (`ENCRYPTION_KEY` and `JWT_SECRET` too). No plaintext copy of the old file is kept. Earlier
  versions kept one as `.env.pre-vault`: if any is left, Settings → Setup checklist lists it and offers to
  shred it (overwritten and deleted; copies may remain in snapshots or backups; asks for the master
  password). A symlink with such a name is never followed or touched.

Deleting a secret from the Secrets page moves it to the vault's trash, so it can be recovered from the vault
until the trash is emptied. Signing in takes about a second: HyperProx talks to Vaultwarden's API directly. An account set to Argon2id
in the vault signs in through the Bitwarden CLI instead, which takes 15 to 20 seconds. Setting
`VAULT_FAST_SIGNIN=0` in `.env` sends every sign-in through the CLI.

## What is on disk, and why

`/opt/hyperprox/.env` (mode 0600) keeps only what HyperProx's own services need before anyone has signed
in. Nothing in it is one of your credentials once the owner account exists.

| Key | Why it cannot be in the vault |
|---|---|
| `POSTGRES_PASSWORD`, `DATABASE_URL` | Postgres starts with the machine, and the API connects to it before anyone signs in (API tokens and the audit log live there, and are checked while locked). |
| `REDIS_PASSWORD`, `REDIS_URL` | The same for Redis, which the API connects to at start. |
| `GRAFANA_SECRET_KEY` | Grafana reads it on every start to decrypt what it stores in its own database. It starts with the machine, while HyperProx is locked. |
| `METRICS_TOKEN` | Prometheus scrapes plug-in metrics around the clock, locked or not. See the caveat below. |
| `VAULT_ADMIN_TOKEN`, `VAULT_ADMIN_TOKEN_HASH` | The API needs the plain token before anyone is unlocked: to create the owner account, and to check at every sign-in that the owner still has two-factor on. Vaultwarden's admin sign-in takes the plain token; the Argon2 hash is only what Vaultwarden checks it against, so the hash alone is not enough. See the caveat below. |

Three more keys are there only for a while, and then removed:

| Key | How long |
|---|---|
| `SETUP_SECRET` | Until setup finishes. The wizard removes it as it finishes, and so does the owner's first sign-in. Setup counts as finished when `.env` says so or when the vault already has an owner, so `bin/hyperprox-config` (on the next `deploy.sh`) also removes it from an older install that never recorded `SETUP_COMPLETE`, and never adds it back. Re-running `install.sh` makes a new one only if setup has not finished. |
| `GRAFANA_ADMIN_PASSWORD` | Grafana reads it only when it first sets up its database. The first owner sign-in moves it to the vault item `hyperprox:system/grafana` and blanks it; `bin/hyperprox-config` then removes the empty line. Grafana recreated without it keeps its admin password (`scripts/test-grafana-admin-absent.sh` proves it against the pinned image). A Grafana that starts on a new database without it would otherwise keep its default admin/admin, so on every owner or admin sign-in, and after the charts are started, HyperProx sets Grafana's admin password to the vault's (making and storing one first if the vault has none). Its login form and basic auth are off, so the password is only for `grafana cli` work: reveal it on the Secrets page, or press reset (`POST /api/monitoring/grafana-admin/reset`), which writes a new one to the vault, reads it back, then sets it in Grafana over stdin; if Grafana refuses it, the vault is put back. |
| `PROXMOX_TOKEN_SECRET` (and the rest of the Proxmox connection) | Until the first owner sign-in. Setup runs before the vault exists, so the access key HyperProx makes for itself waits here; the first sign-in writes it to the vault, reads it back, and only then blanks it. No copy is kept. |

## The node login

Setting things up on your nodes (Settings → Setup checklist, the setup wizard, Catalogue installs, the
assistant) needs a login to each node. It is asked for once, in plain words, and tested on every node
with `pveversion` (read-only, and proof the host is a Proxmox node) before it is kept. It is kept only
where the test passed.

- **Where it lives.** In the vault, in the `hyperprox:deck/ssh` item, one hidden field per node. Never in
  `.env`, a file, Postgres, a log or the browser: the page sends it once and gets back only which nodes
  accepted it.
- **Before the vault exists.** The setup wizard runs before anyone has created the owner account. A node
  login (or a GoDaddy key) given to it is held in the wizard's memory only. When setup finishes, the wizard
  hands it to the API over loopback (`POST /api/auth/setup-handoff`), which answers only to a request
  from the same machine that did not come through nginx, carrying the setup key, checks the body first,
  accepts it exactly once (recorded in `data/setup/handed-over`, created exclusively, so a restart does not
  reopen it; `install.sh` clears it only when it starts setup again and no owner exists yet), refuses
  it when the vault does not answer, and refuses it once the vault has an owner (from then on, logins go in through the Setup checklist). The API holds it in
  memory until the owner's first sign-in, stores it in the vault, then drops it. If HyperProx restarts in
  between, it is gone and the Setup checklist asks again; that is the price of never writing it down.
  `bootstrap.sh` hands over a GoDaddy key the same way, on stdin, so it is on no command line.
- **While locked** the login cannot be read, so node work, the checklist and Catalogue installs answer
  "locked" and do nothing.
- **Revealing it** is the Secrets page's reveal, which asks for the master password again.
- **Every use is audited** in the database's audit log: which node, what for, and who; never the value.
  `test/setup-onboarding.test.ts` plants marker values in a node login and a GoDaddy key and proves none
  reaches Postgres, a file, a log, an audit row or an API answer.
- **Where a pin came from.** Each pin records its source: `confirmed` (an admin compared the fingerprint
  and pressed confirm: Setup checklist, Remote access, HA), or one of the first-use sources nobody
  confirmed: `terminal-auto` (learned when the host was first opened in the Terminal; the key is shown,
  but nobody accepted it), `wizard` or `api`. Calls that require a pin (Remote access scripts, HA
  maintenance mode) accept only confirmed pins (`terminal`, a person accepting the fingerprint in the
  Terminal, is reserved for when the Terminal asks). Settings → Setup
  checklist shows every node's fingerprint, and every pin that is not confirmed (including pins from before
  sources were kept, which are left as they are), with a confirm button that needs the master password and
  only accepts the key the host presents at that moment.
- **Host keys.** Pinned on first use, then required. The setup wizard pins each node's key the first
  time it connects, refuses any other key for the rest of its run (before it sends a password), shows the
  fingerprints so you can compare them on each node's console, and hands them to the API with the login,
  which pins them in the vault. After that, and for any node first reached later, the API does the same as
  the Deck terminal: the first key is pinned, a key that changes is always refused.
- **What it can do.** It is a root login to your hypervisors. The installer's node scripts only add
  packages (apt is asked first and an install that would upgrade or remove anything is refused), never
  touch kernels, drivers or apt holds, and run one node at a time.

## What the installer adds to your nodes

Each of these is a yes/no question; nothing is added if you say no. All of them serve read-only metrics
with no password, so anyone who can reach the port on your network can read them. Keep your nodes on a
network you trust, or firewall these ports to the HyperProx machine.

| Answer | What is added | Listens on | Exposure |
|---|---|---|---|
| Node health | `prometheus-node-exporter` from your distribution | `:9100`, every interface | CPU, memory, disk, network and (with power) energy figures. |
| Power | `/etc/udev/rules.d/99-hyperprox-rapl.rules` | nothing | Makes `energy_uj` readable by every local user on that node (kernels since 5.10 keep it root-only as a mitigation for energy side channels such as PLATYPUS). Delete the file to undo it. |
| Intel GPU, Docker present | The `intel-gpu-exporter` container, pinned by digest (privileged, host PID namespace, `/dev/dri`) | `:8081`, every interface | GPU busy, frequency and power. The container is privileged because `intel_gpu_top` needs the kernel's perf counters. |
| Intel GPU, no Docker | `intel-gpu-tools` from apt, and the `hyperprox-intel-gpu-exporter` service (a small Python script, run as root for the same reason) | `:8081`, every interface | The same metrics. HyperProx never installs Docker on a node. |
| Built-in graphics for containers | `/etc/udev/rules.d/99-hyperprox-igpu.rules`, one line per built-in GPU, matched by its PCI address (`SUBSYSTEM=="drm", KERNEL=="renderD*", KERNELS=="0000:00:02.0", MODE="0666"`), and `/var/lib/hyperprox/igpu-access.modes` with each render node's mode before the change | nothing | Any container on that node can then use its built-in graphics, not only those whose user maps onto the host's render group. Only built-in Intel or AMD graphics are opened: an NVIDIA card, a dedicated AMD or Arc card, or a render node whose GPU cannot be identified never is. Offered only on nodes with built-in graphics, and the answer defaults to no. Undo (the Setup checklist) removes the rule, re-triggers udev and puts every render node it touched back to its recorded mode, checking each one. |
| AMD GPU | A systemd drop-in for node_exporter, `/etc/systemd/system/<unit>.service.d/hyperprox-amd-gpu.conf`, that repeats the unit's own command with `--collector.drm` added (every existing flag kept) | `:9100` (node_exporter's own port) | GPU busy percentage and VRAM size and use, alongside node_exporter's other figures. Nothing is installed. If node_exporter then reports no AMD figures, the drop-in is removed again and node_exporter restarted as it was. Undo: delete the drop-in, then `systemctl daemon-reload` and restart node_exporter. |
| Intel GPU on a remote server (Edit server, step 5) | `intel-gpu-tools` from apt (only if apt would add new packages and nothing else, and never a kernel, header, firmware, NVIDIA or Proxmox package), and the `hyperprox-intel-gpu-textfile` service (a small Python script, `/usr/local/lib/hyperprox/intel-gpu-textfile.py`, run as root for the perf counters; `kernel.perf_event_paranoid` is not changed) | nothing: it writes `/var/lib/prometheus/node-exporter/hyperprox_intel_gpu.prom`, which node_exporter serves on its private-link address | GPU busy per engine, clock and power, per Intel GPU. Remove monitoring stops and deletes the service, script and file, and removes the packages HyperProx added only if apt would remove nothing else with them. |
| NVIDIA GPU | `nvidia_gpu_exporter` 1.15.1, checksum-checked, as the `hyperprox-nvidia-gpu-exporter` service (systemd `DynamicUser`) | `:9835`, every interface | GPU use, memory, temperature and power, read with `nvidia-smi`. It never installs or changes a driver. |

The Prometheus and Grafana that the charts question starts listen on loopback on the HyperProx machine,
as described above.

**Built-in graphics, for other pages.** `igpuAccess(node)` in `apps/api/src/lib/igpu-access.ts` returns
`{ node, state, ruleInstalled, apply(), undo() }`: `state` is `open` (render nodes 0666), `closed` (built-in
Intel or AMD graphics only the render group can use) or `none` (no built-in graphics, or NVIDIA only).
`apply()` and `undo()` resolve to `{ status: done|already|skipped|failed, reason, state }`. Over HTTP, admin
only: `GET /api/setup-checklist/igpu-access/:node`, and `POST .../:node/apply` and `POST .../:node/undo`
(both ask for the master password again). It uses the node login from the vault, so while HyperProx is
locked it answers locked, and a node with no saved login answers 409.

## From the command line

```bash
hyperprox status         # is the vault up? the keyholder? is HyperProx locked or unlocked?
hyperprox lock           # lock now: wipe memory, end all sessions
hyperprox pve-exporter   # give the PVE exporter its own read-only Proxmox token (needs HyperProx unlocked)
```

They talk to localhost only and are meant to run as root on the HyperProx machine. `hyperprox
pve-exporter` asks the API to make the token (only the API holds HyperProx's admin token, in memory),
using a one-off API token it creates in the database: valid for ten minutes, revoked straight
afterwards (also on Ctrl-C or SIGTERM), and any left behind by an earlier run killed outright are
revoked at the start of the next.

## API tokens

For scripts and coding agents that drive HyperProx without a browser (issuing certificates, DNS records,
proxy hosts). Make one in **Settings, API tokens** (owner or admin; asks for your master password), or as root
on the HyperProx machine:

```bash
hyperprox token create ci-deploy --role admin --expires-days 90   # prints the token once, on stdout
hyperprox token list
hyperprox token revoke ci-deploy                                  # by name or id
```

Send it as `Authorization: Bearer hpx_...`. It is shown once; HyperProx stores only its SHA-256.

- **It stops working while HyperProx is locked** (HTTP 423, like everything else), and its requests do not
  reset the auto-lock timer: only people keep HyperProx unlocked. Someone has to sign in first.
- **It has a role** (viewer, operator or admin; never owner) and the role table above applies to it unchanged.
- **It can never** read or send secrets (`/api/secrets`), use the Deck terminal or its saved logins
  (`/api/terminal`), open a WebSocket (`/ws`, including terminals and live status) or a guest console, sign
  in, out or lock, or make, list or revoke tokens (HTTP 403 `token_forbidden`). Anything that asks for the
  master password again (destroying a guest, revealing a secret, changing roles) answers 403
  `reconfirm_required`: a token has no master password.
- **Saving to the vault** (for example, changing a provider credential in Settings) is done through the most
  recently active signed-in session. With nobody signed in, such a write fails as locked.
- **Audit.** Creating and revoking a token, and every request with a token that changes something, are
  written to the audit log with the token's name. The token itself is never logged.
- **Revoking** takes effect at once from Settings; from `hyperprox token revoke`, within 10 seconds. A revoked
  token keeps its name, so pick a new name for its replacement. A bad, revoked or expired token gets 401.

## Remote access

Installing a VPN client opens a way into the machine from outside your network, so this feature is held to
the rules below ([docs/remote-access.md](remote-access.md)).

- **Provider credentials are vault items** (`hyperprox:remote/tailscale`, `hyperprox:remote/netbird`),
  masked when read back, like every other integration. Use a NetBird service user or a narrowly scoped
  Tailscale OAuth client rather than a personal admin token where you can. The NetBird URL must be
  `https://`, and no provider request follows a redirect.
- **Keys are minted per install**: single use, not ephemeral, 10 minutes (Tailscale) or one day (NetBird's
  minimum). Before a key leaves HyperProx its id (never the key) is written to the database as pending
  revocation. HyperProx revokes it as soon as the install ends, asks the provider to confirm, and only
  then deletes the row. A sweep at start-up, after every unlock and every minute revokes whatever is left,
  so a crash or a restart cannot leave a key alive. Shutdown waits a few seconds for revokes in flight.
- **A key exists only in the API's memory and on the target's stdin.** It travels inside the script on the
  SSH channel's stdin and reaches the client on a pipe (`--auth-key=file:/dev/stdin`,
  `--setup-key-file /dev/stdin`), so it is on no command line and in no file HyperProx writes, on the node
  or in the guest. Job output passes through a stream redactor that holds back enough of each chunk to
  catch a key split across two, and removes the key, Tailscale and NetBird token shapes and, while a
  NetBird key is live, NetBird setup-key shapes. Provider errors carry a status and message, never a request.
- **The one exception is the manual flow** for Windows and macOS: an admin who has just re-entered the
  master password can be shown a single-use key once. It is recorded for revocation first, audited, sent
  with `Cache-Control: no-store`, not stored, and revoked after 30 minutes even across a restart.
- **Re-confirmation** is required to install, change routing, uninstall, add `/dev/net/tun`, add the
  firewall rule, make a manual key, and to check or update a client on a Proxmox node. API tokens cannot
  re-confirm, so **no API token can open a tunnel into the cluster or run anything on a node**, at any role.
- **Status for roles below admin** is overlay state only: connected, overlay IP, client version, last seen.
  No LAN or cluster addresses, no routes. Job logs are admin-only.
- **Proxmox nodes keep their DNS, routes and firewall.** No DNS, no accepted routes, no client firewall
  rules (`--netfilter-mode=off`, `--disable-firewall=true`), never an exit node, never a forwarding change.
  Every change on a node is guarded by a before/after comparison of routing tables and rules (the client's
  own only inside its overlay prefixes, its rules only at their exact priorities), paths to cluster peers,
  Ceph monitors (IPv4 and IPv6), gateways and resolvers, resolver and per-link DNS, the firewall rules as
  text on every backend, corosync links, forwarding and quorum, 15 seconds apart, with automatic rollback.
  An in-flight record makes a restart wait for any running script or apt, re-run the check, and always
  undo an interrupted install. The only
  firewall change HyperProx offers is one rule for TCP 22 and 8006 from the overlay on its interface,
  previewed and confirmed.
- **Existing clients are not touched** without an explicit Adopt or Replace, and a Replace keeps the old
  state (files, unit and environment, package version, service state) root-only to put back, then
  overwrites and removes the copy. Provider devices are deleted only by the id recorded when the client reported itself,
  never by name.
- **Every SSH path fails closed** when the host key has never been pinned: nodes, `pct exec`, the guest
  agent, VMs and hand-added hosts. The refusal shows the fingerprint; an admin who has re-confirmed can pin
  exactly the key presented (it is read again and must match), in the store the Terminal uses. An existing
  different pin is never replaced from here.
- **Guest config is changed only through the Proxmox API** (`devN: /dev/net/tun`, with the config digest),
  never by editing or appending to a config file. HyperProx does not restart the container for you.
- **Sign-in links** (when an owner signs a machine in with their own account, or a key expired) are
  sensitive: whoever opens one adds a machine to the network. HyperProx captures them from output it does
  not log, keeps them in memory only for about ten minutes, shows them only to admins after
  re-confirmation (`Cache-Control: no-store`, audited without the link), and sends them only to
  notification channels marked **private**, as a sensitive link that is never written to the outbox. After
  it expires, or after a restart, the notification says the link has expired instead.
- **Every read of a provider credential is audited** without its value (`remote.credential.read`, at most
  once a minute per provider). While HyperProx is locked, every VPN action says "HyperProx is locked — sign in
  to …" and does nothing; the revoke sweep and the new-device poller pause and resume on unlock.
- **WireGuard keys.** A server's or machine's private key is made on that machine and never leaves it
  (wg-quick loads it from its own file; no interface file HyperProx writes has a `PrivateKey` line). A
  phone or laptop client's keypair is made in the browser (or, as a fallback, on the server container, in
  output HyperProx never logs) and kept with its config as one vault item per peer, revealed again only
  after re-confirmation, audited. A rotated key is kept seven days, marked rotated, then deleted. A server
  key goes to the vault only if the owner opts in. Postgres holds public keys only.
- **The MikroTik router** is written to only with a separate RouterOS login in the vault (group policies
  read, write, api, rest-api), never the admin login; without it the view is read-only. RouterOS cannot
  limit a login to WireGuard peers (`write` allows other changes), so that limit is enforced by HyperProx:
  its REST writer refuses every path but `/interface/wireguard/peers`. Only peers marked
  `comment=hyperprox:<id>` are ever changed or removed. Firewall, addresses and routes are never written; a
  missing input rule for a listen port is shown as a command for the owner to run.
- **Locked means nothing**: while HyperProx is locked no credential is in memory; every VPN and WireGuard
  action says "HyperProx is locked — sign in to …" and does nothing, and the background work (revoke sweep,
  new-device poller, rotation sweep) waits for the next unlock.
- **Audit**: `remote.install`, `remote.update`, `remote.routing`, `remote.uninstall`, `remote.check`,
  `remote.rollback`, `remote.cleanup`, `remote.recovered`, `remote.tun`, `remote.firewall` and
  `remote.manual-key` are written with the user, the machines and the provider.

## Not built yet

These are designed ([design](superpowers/specs/2026-10-14-vault-gate-design.md)) but are **not** in this
release. Do not assume them.

- **Temporary users**: access to named guests until an expiry date.
- **Master Reset Password recovery** (`hyperprox --force-reset`). Until it exists, **if you lose the owner's
  master password or two-factor device, there is no recovery**: the vault is zero-knowledge by design.
  Keep the master password in a safe place and keep your authenticator's backup or recovery codes.
- **Editions** (Homelab and Business) and the plug-in filtering that goes with them.
- **Access modes**: the built-in WireGuard VPN, hardened internet exposure and existing-tunnel support.
  Today HyperProx is served on your local network over plain HTTP; put your own TLS and network controls
  in front of it before exposing it anywhere else.
- **Tamper check**: verifying the installed files against signed checksums before each unlock.
- **Audit timeline**: the vault's event log joined with HyperProx's own action log.
- Least-privilege hypervisor tokens per role, and rotating a credential in the system it belongs to.

## Raw device lines in guest configs

Proxmox's API refuses every `lxc.*` line, so the GPU and device editor writes the few it needs by rewriting the
guest's config file over the node login. Only device lines are written: `lxc.cgroup2.devices.allow` /
`lxc.cgroup.devices.allow` for one character device (`MAJOR:*` only for a GPU major, otherwise the exact
`MAJOR:MINOR` from the node's inventory) and `lxc.mount.entry` binds of an inventory device node onto the same path,
without `mode=`, `uid=` or `gid=`. Hooks, AppArmor, idmaps, capabilities and everything else are refused. Each
write is a compare-and-swap under Proxmox's own config lock, re-checks every added device's major:minor on the node
at that moment, and is read back byte for byte.

**The limit of that check.** It proves what the node had when the file was written. LXC resolves a mount source
again every time the container starts. If a device node is later replaced (a different device at the same path, or
a symlink in its place), the container binds whatever is there at start; an `optional` entry whose device has gone
is skipped silently. Re-open the guest's GPU section after hardware or driver changes on its nodes: the drill-down
shows which device it actually sees.

**The hidden GPU marker.** A guest's GPU state (what HyperProx added, and an open "GPU off") is kept under a hidden
`<!-- hpx-id:… -->` comment in its description. HyperProx's own edits and reverts keep it, but editing the
description in the Proxmox UI can delete it. If it is deleted, HyperProx no longer recognises that state as this
guest's: its GPU entries show as hand-written (GPU off leaves them unless ticked) and an open GPU off cannot be
turned back on from the toggle. Nothing in the config changes; the next GPU change writes a new marker.

## Honest caveats

- **The vault admin token is on disk.** `VAULT_ADMIN_TOKEN` in `.env` (its hash is in the vault's
  environment) opens Vaultwarden's `/admin` page on loopback. That page manages **users and settings**: it
  can invite, disable or delete accounts and change server configuration. It cannot read vault contents,
  which are end-to-end encrypted with keys derived from each user's master password. So the zero-knowledge
  property holds, but someone with that token can lock people out or invite an account of their own. It is
  not reachable from the network by default; treat the file as sensitive (it is mode 0600).
- **Two monitoring credentials are on disk, outside the vault.** Prometheus and the PVE exporter are
  containers that read their credentials from files and have no way to ask the vault (the exporter
  keeps reading Proxmox while HyperProx is locked), so these two cannot be vault items:
  - `METRICS_TOKEN`, in `.env` and in `config/prometheus/secrets/metrics_token` (0600, owned by
    Prometheus's user). It is the bearer token for `/api/plugins/metrics`, which serves plug-in metrics
    and nothing else. The installer generates it; it is never rotated automatically. To rotate it,
    delete the `METRICS_TOKEN` line from `.env` and the secret file, run `bash bin/hyperprox-config`,
    then `systemctl restart hyperprox-api` (Prometheus reads the file on every scrape).
  - The PVE exporter's Proxmox token, in `config/pve-exporter/pve.yml` (0600, owned by the exporter's
    user). It is a separate token from HyperProx's own, with privilege separation on and only the
    `PVEAuditor` role on `/`: whoever reads the file can read what Proxmox shows an auditor (nodes,
    guests and their configuration, storage, usage) and can change nothing. HyperProx checks that with
    Proxmox, not by the token's name: it reuses the token only while privilege separation is on and its
    one ACL is PVEAuditor on `/`, and otherwise refuses it as not read-only. To replace it, run
    `hyperprox pve-exporter --fresh`.
  Both files are git-ignored. Treat them, like `.env`, as sensitive.
- **A deploy starts new code with the vault already unlocked.** Because the unlock survives an API
  restart, code that `deploy.sh` ships starts with every unlocked secret, the signing key and the vault
  sessions (refresh tokens included) available to it, without anyone signing in again. Before the
  keyholder, a deploy locked, so new code saw nothing until a person unlocked it. This is the accepted
  price of deploys not locking: only deploy code you trust, or lock (`hyperprox lock`) before deploying.
- **While unlocked, root on the machine can read memory.** Decrypted secrets and the signing key live in the
  API process and in the keyholder. Anyone with root on the HyperProx machine during that time can read them (or change the
  running code). Auto-lock and `hyperprox lock` shorten that window; a tamper check to catch changed code is
  not built yet. While **locked**, there is nothing usable in memory or on disk, apart from the two
  read-only monitoring credentials above.
- **The master password is the key.** It is entered in your browser and passed to HyperProx's API to sign
  in as you; it is never stored or logged, but it does cross that connection, so the connection should be
  one you trust (see the access-modes note above).
- **Back up the vault volume.** `vault_data` holds every account and encrypted item. It is encrypted, so a
  stolen copy is only as safe as the master passwords protecting it, and losing it loses the vault.
- **A vault outage means a HyperProx outage.** That is deliberate. `hyperprox status` says why, and
  `docker logs hyperprox-vault` has the details.
