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
  accepts it exactly once (recorded in `data/setup/handed-over`, so a restart does not reopen it), refuses
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
