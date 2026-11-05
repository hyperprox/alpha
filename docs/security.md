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
- **Re-confirmation.** Revealing a secret, destroying a guest and changing roles ask for the master
  password again (valid for five minutes).
- **Secrets page** (Settings, Secrets): names only. Owners and admins can reveal a value (with
  re-confirmation), **Send** it to a person as an expiring, view-limited, encrypted link (a Bitwarden Send,
  24 hours and one view by default), or **generate** a strong password that is saved straight to the vault.
- **Existing installs migrate.** On the first owner unlock, credentials from the old encrypted table and
  `.env` are written to the vault and verified; then the old rows are deleted and `ENCRYPTION_KEY` and
  `JWT_SECRET` are blanked, with a copy kept in `.env.pre-vault` (mode 0600). Delete that file once you
  have checked your credentials.

Deleting a secret from the Secrets page moves it to the vault's trash, so it can be recovered from the vault
until the trash is emptied. Signing in takes about a second: HyperProx talks to Vaultwarden's API directly. An account set to Argon2id
in the vault signs in through the Bitwarden CLI instead, which takes 15 to 20 seconds. Setting
`VAULT_FAST_SIGNIN=0` in `.env` sends every sign-in through the CLI.

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
