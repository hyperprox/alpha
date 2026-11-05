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
