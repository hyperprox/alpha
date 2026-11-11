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
- **HyperProx's own WebSockets do not.** The live-status feed, a terminal and the update log are each tied
  to the session that opened them: signing out, a lock, or the vault ending that session closes them (close
  code 4401), and a terminal's SSH session goes with it. A deploy job's progress is sent only to the sockets
  of the person who started it.
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
- **Cross-site requests.** The session cookie is `SameSite=Lax`, and on top of that the API refuses (403
  `cross_origin`) any state-changing request or WebSocket upgrade whose `Origin` is not the host the browser
  asked for (nginx passes it on as `X-Forwarded-Host`, which the API believes only from loopback), or that has
  no `Origin` and a `Sec-Fetch-Site` other than `same-origin`. Scripts and the host CLI send neither header and
  are not affected. The API sends no CORS headers at all, so another site's page cannot read an answer.
- **Sign-in limits.** Sign-in, owner creation and re-confirmation allow 10 attempts a minute per client address,
  and an account allows 20 failed sign-ins (10 wrong master passwords at re-confirmation) in 15 minutes from
  any number of addresses. The API believes `X-Forwarded-For` only from nginx on the same machine, so the
  address is the browser's: one client running out of attempts does not lock anyone else out.
- **Re-confirmation.** Revealing or Sending a secret, destroying a guest, changing roles, resetting Grafana's
  admin password, saving or testing a connection under Settings (Proxmox, proxy, DNS, AI, remote access), and
  every change on the Setup checklist (saving a node login, running an item on your nodes, shredding old
  backups, opening or closing built-in graphics) ask for the master password again (valid for five minutes).
  Changing where a connection's secret is sent (its host, port or URL) also needs that secret entered again in
  the same save, so a moved address never inherits the old secret.
- **Secrets page** (Settings, Secrets): names only. Owners and admins can reveal a value (with
  re-confirmation), **Send** it (also re-confirmed) to a person as an expiring, view-limited, encrypted link (a Bitwarden Send,
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
| `SETUP_SECRET` | Until the owner account exists. Creating the owner (`POST /api/auth/bootstrap` and `/bootstrap/confirm`, public because nobody can sign in yet) needs it in `X-Setup-Key` while the vault has no owner, so whoever reaches `/login` first cannot claim the install. The wizard keeps it when it finishes and its last button carries it to `/login` (in the URL fragment, which is never sent to a server); the owner's first sign-in removes it. `bin/hyperprox-config` (on the next `deploy.sh`) also removes it once the vault has an owner, and never adds it back. Re-running `install.sh` makes a new one only if setup has not finished. |
| `GRAFANA_ADMIN_PASSWORD` | Grafana reads it only when it first sets up its database. The first owner sign-in moves it to the vault item `hyperprox:system/grafana` and blanks it; `bin/hyperprox-config` then removes the empty line. Grafana recreated without it keeps its admin password (`scripts/test-grafana-admin-absent.sh` proves it against the pinned image). A Grafana that starts on a new database without it would otherwise keep its default admin/admin, so on every owner or admin sign-in, and after the charts are started, HyperProx sets Grafana's admin password to the vault's (making and storing one first if the vault has none). Its login form and basic auth are off, so the password is only for `grafana cli` work: reveal it on the Secrets page, or press reset (`POST /api/monitoring/grafana-admin/reset`), which writes a new one to the vault, reads it back, then sets it in Grafana over stdin; if Grafana refuses it, the vault is put back. |
| `PROXMOX_TOKEN_SECRET` (and the rest of the Proxmox connection) | Until the first owner sign-in. Setup runs before the vault exists, so the access key HyperProx makes for itself waits here; the first sign-in writes it to the vault, reads it back, and only then blanks it. No copy is kept. |

## The home Proxmox API's certificate

HyperProx never talks to your Proxmox API without checking its certificate (lib/home-tls.ts). A certificate that
verifies normally (a public CA, the right name, such as a Let's Encrypt one) is accepted and recorded. A
self-signed one is pinned the first time HyperProx connects (an install that predates this pins its current
certificate on the first connection after the update), and from then on only that certificate is accepted: a
different one is refused before anything, the API token included, is sent, with both fingerprints in the error.
The pins are in `data/home-tls-pins.json` in the install folder (root only). If you replace the certificate on
purpose, check the new fingerprint on the node (Node, System, Certificates), remove that address's entry from
the file, and the next connection pins the new one.

## The node login

Setting things up on your nodes (Settings → Setup checklist, the setup wizard, Catalogue installs, the
assistant) needs a login to each node. It is asked for once, in plain words, and tested on every node
with `pveversion` (read-only, and proof the host is a Proxmox node) before it is kept. It is kept only
where the test passed.

- **Where it lives.** In the vault, in the `hyperprox:deck/ssh` item, one hidden field per node. Never in
  `.env`, a file, Postgres, a log or the browser: the page sends it once and gets back only which nodes
  accepted it.
- **Not a Terminal login.** The Terminal's saved logins live in the same item, but no Terminal route or socket
  reads, lists, replaces or removes a `node-<name>` field (403), so an operator who may open guest panes can
  never open one with a node's root login. The Terminal works out where any login is sent from the pane's id
  (the guest's Proxmox config or the address saved with it, the hand-added host, the plug-in's settings) and
  ignores the address the browser sends. Its shared login applies to cluster guests only, and its one-off
  commands (install tmux, list sessions) refuse a host whose key is not pinned before sending the login.
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
- **Where a pin came from.** Each pin records its source:

  | Source | How it got there | Counts as confirmed |
  |---|---|---|
  | `verified` | HyperProx checked it itself, with evidence (below), and recorded which | yes |
  | `confirmed` | An admin compared the fingerprint and pressed confirm (Setup checklist, Remote access, HA, a node login on Edit server) | yes |
  | `terminal` | A person accepted the fingerprint in the Terminal (reserved; the Terminal does not ask yet) | yes |
  | `terminal-auto` | Learned when the host was first opened in the Terminal; shown, but nobody accepted it | no |
  | `wizard` | Learned by the setup wizard on its first connection | no |
  | `api` | Learned by HyperProx's own node runner on first use | no |

  Calls that require a pin (Remote access scripts, HA maintenance mode, file copies, logins on a remote
  server) accept only the first three. A pin from before sources were kept has no source and does not count.
- **How a key is verified without you.** A `verified` pin stores its evidence next to it in the vault
  (`hyperprox:deck/hostkey-evidence`: node names, a tailnet device id and owner, or an interface name; nothing
  secret). Verification always starts from an *anchor*, something trusted before the check began, never from
  nodes vouching for each other. The code is `apps/api/src/lib/hostkey-verify.ts`.
  - *Setup-local (the anchor).* A Proxmox cluster keeps every node's SSH host key in its own replicated files
    (`/etc/pve/nodes/<node>/ssh_known_hosts`, and the older `/etc/pve/priv/known_hosts`). When HyperProx is
    installed with `bootstrap.sh`, which runs as root on a node, it reads those files and that node's own
    `/etc/ssh/ssh_host_*_key.pub` right there and hands them to the API through the same one-time setup
    hand-over the node login uses (loopback only, setup key, accepted once, before any owner exists). They are
    kept as the anchor (`hyperprox:deck/hostkey-anchor`) when the owner first signs in. If HyperProx was
    installed some other way, the Setup checklist (or a server's Edit page) shows one command to run on any
    node; you paste what it prints. Run it on the node's own console (its screen, IPMI or iKVM, or an SSH
    session whose key you already checked), not in HyperProx's Terminal on a key that is not verified yet: the
    output is only as trustworthy as the session it came through. It prints public keys only, and they are
    compared for equality. Pasting keys different from an anchor already kept is audited
    (`host_key.anchor.replace`) and raises an alert; replacing what the installer read on the node itself is
    refused unless you confirm it, and then asks for your master password once more.
  - *Cluster record, growth.* Once at least one node is trusted (confirmed by you, or verified from an
    anchor), more nodes are verified from the same record read through trusted nodes only: two trusted nodes
    that agree, or one plus proof that the new node holds the recorded key. A node verified in a check only
    vouches for others in the next round of it, never in the same one.
  - *Proof of a key.* When the key a node offers first is of a type the trusted record does not hold (the
    record often keeps only RSA), HyperProx connects asking for the recorded type only, so the node must sign
    the SSH handshake with the recorded key. With the same type no login is sent at all; to read the node's
    own key files a login is sent only after that signature checked out. A key of a type HyperProx cannot ask
    for (DSA, security-key types) gives no evidence, and is not treated as a mismatch.
  - *Tailscale.* The address itself (the one you typed, or one the server's own cluster status reports;
    never a name) is a Tailscale IP, and `tailscale whois` on the HyperProx machine says it is an online
    device in your tailnet owned by the same user HyperProx's machine is signed in as: not shared in from
    another tailnet, and not tagged (a tagged device is owned by a tag policy, not by you). The tunnel must
    really carry the traffic: `tailscaled` must run with a kernel interface (in userspace networking this
    machine's own connections to 100.x addresses leave by the default route), and `ip route get` must name the
    tailscale interface before the key or certificate is read, after it, and before a token is sent. The
    connection goes to exactly that IP, and the device id and owner are recorded.
  - *WireGuard (home nodes only).* A peer address on an interface HyperProx set up, up on this machine, whose
    peer HyperProx made for exactly that node. A peer's name proves nothing, and remote servers never use it.
  - *Trusted session.* The key is read from the machine over a session to it that is already trusted (the
    same node reached by another address).

  With no anchor and no private link there is no evidence: the pin stays learned and the Setup checklist
  offers the manual compare (or the one-line command).
- **No login to an untrusted host.** While HyperProx gathers evidence it signs in only to nodes that were
  trusted before the check began, and to a node that has just signed its SSH handshake with an anchored or
  recorded key. A learned key never gets a login from this code.
- **Remote servers' pins are their own.** A remote server's pins are kept under that server's id, so a remote
  node whose address happens to equal a home node's (two private networks both using 10.0.0.x) never inherits
  the home node's pin. A pin kept before this was copied (never moved) to the remote the first time it was
  needed, so a home machine on the same address keeps its own. Adding a server never fills in the other nodes' cluster-network addresses.
- **Adding a server.** Before any token is sent, the private link must vouch for exactly the address you
  typed and the server's certificate must be for the device the link names; after the token, the server's own
  API must name itself as a node that certificate is for. The add form shows, before your one master
  password, "Connecting to <device> owned by <owner>" and what monitoring would install; Connect carries a
  hash of that, and if anything changed in between nothing is done. Monitoring is applied only with the exact
  script that was shown. The add runs as a background job; asking again for the same server joins it, and
  after a stop part way picks up the saved server instead of failing as a duplicate.
- **When it happens.** For home nodes: after each owner sign-in (only if some home pin is not yet verified or
  confirmed), about twenty seconds after HyperProx first learns a home node's key, and when you press
  **Verify automatically** on the Setup checklist. The two background runs are HyperProx's own (the audit
  log names the trigger, such as `system: owner sign-in`); they need the vault unlocked, which a sign-in does,
  and write through that session. A key learned during a request made with an API token does not start one.
  For a remote server: while it is added, and from **Verify keys** on its Edit page. Both ask for the master
  password, so an API token cannot start them, and the code refuses a token's session as well. Checks run one
  at a time.
- **What never changes.** A key that differs from its pin is refused, here as everywhere: verification only
  ever turns a learned pin into a verified one, or pins a host that had none. Any mismatch in a check (trusted
  copies of the record that disagree, a record or anchor that contradicts the key a node presents, a node that
  cannot prove the recorded key, a pin that changed) blocks the whole check, writes `host_key.verify.blocked` to
  the audit log and sends a critical notification that says to check the key on the node's own console before
  anything else. Each key that is verified writes `host_key.verify` with who, the node, the fingerprint and the
  kind of evidence; saving an anchor writes `host_key.anchor.save`. Every script used passes the same script
  guard as remote scripts, for home nodes too, checked as bash reads it (continued lines joined): a script that
  reads the record files is nothing but whole lines of exactly `cat -- <path> 2>/dev/null`, its
  `echo "@@hpx ..."` markers and `true`, so no line can redefine `cat`.
- **What this cannot protect against.** Root on any one node of a cluster can rewrite the shared record
  (`/etc/pve` is the cluster's own replicated filesystem), but root there already controls the whole cluster.
  A Tailscale address can be reused: if a device is removed from your tailnet and its IP is later given to
  another device you own, that device's key would be accepted for the old address on first use; a key already
  pinned for that address is still refused if it changes.
- **What still needs a person, and why.** Without an install from a node and without a private link, nothing
  is trusted yet, so you run the one-line command once (or compare one fingerprint). A remote server reached
  over a plain address needs the same command run on one of its nodes (Edit page), or its certificate compared
  once. Guests and hand-added hosts have no cluster record and are confirmed by hand. A key that changed (a
  rebuilt node) is cleared in the Terminal first, then verified again from the anchor or trusted nodes.
- **Host keys.** Pinned on first use, then required. The setup wizard pins each node's key the first
  time it connects, refuses any other key for the rest of its run (before it sends a password), and hands
  the keys to the API with the login, which pins them in the vault and verifies them (against the installer's
  anchor, when there is one) right after the owner signs in. After that, and for any node first reached later, the API does the same as the Deck terminal:
  the first key is pinned (and then verified as above), and a key that changes is always refused.
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
- **It never writes to the vault.** A token does not borrow a signed-in person's vault session, so anything that
  would store a credential, a setting or a host-key pin during a token request (or in work it starts) is refused
  with 403 `token_forbidden`. Reads, from the unlock cache, work as before.
- **Audit.** Creating and revoking a token, and every request with a token that changes something, are
  written to the audit log with the token's name. The token itself is never logged.
- **Revoking** takes effect at once from Settings; from `hyperprox token revoke`, within 10 seconds. A revoked
  token keeps its name, so pick a new name for its replacement. A bad, revoked or expired token gets 401.

## Home Assistant control

The Home Assistant plug-in can switch real things: lights and heating, but also locks, alarm panels and
garage doors. So control is not done by the plug-in (a plug-in never holds a credential and never writes);
HyperProx does it, with these rules:

- **An allow-list, not a passthrough.** Each control is one row in `apps/api/src/lib/ha-control/catalog.ts`:
  a kind of device, an action, the one Home Assistant service it calls, and the values it may send, each
  checked against a range or a list taken from the device itself (a thermostat's own minimum and maximum, its
  own list of modes). No route accepts a service name, and there is no way to send an arbitrary request to
  Home Assistant through HyperProx.
- **The device must exist.** The entity is read from that house at the moment of the action (never from a
  cache), must be of a kind HyperProx controls, and must not be unavailable. Its tier is decided from what it
  says then, so a device reclassified in Home Assistant a second ago is treated as it is now.
- **Two tiers, security by default.** Everyday controls (`POST .../instances/<id>/actions`) need the operator
  role, or admin if the house is set that way. Security controls (`POST .../instances/<id>/secure-actions`)
  need the admin role, the master password re-entered within 5 minutes, a confirm phrase naming the action
  (with the value as checked and rounded), the device and the house, and the device's name typed by the
  person; the server compares both and its refusal never says what the phrase should have been. Each tier has
  exactly one route: the everyday route refuses a security device and the secure route refuses everything else.
  - Always security: locks, alarm panels, sirens, anything whose device class is siren, covers whose class is
    garage, gate or door, and any switch, input boolean, cover, script, scene or button whose id or name has a
    door, gate, lock or alarm word in it. Names are folded first (Unicode NFKC, accents removed, lower case).
    Long words match inside a longer one: garage, garaje, alarm, siren, opener, unlock, disarm, portail, puerta,
    porton, cancello, serrure, cerradura, schloss, lucchetto. Short ones only as a whole word: arm, door, gate,
    lock, entry, porte, tur, tor, deur, poort, slot. So "Garagentor" and "Tür vorne" match, "Motor" and "Warm
    water" do not; a compound such as "Haustür" is not caught by the short word, so it is security only by the switch rule below (not if it is an outlet).
  - Security until a house moves the device to everyday: covers of any other class or none (only blind,
    curtain, shade, shutter, awning and damper are everyday), scripts, scenes and buttons, every input boolean,
    and every switch except one whose device class is outlet.
  - A house's settings can promote devices and whole kinds freely. Moving a device to everyday is admin,
    re-confirmed, and written to the audit log as its own row naming each entity; so is letting operators use
    everyday controls where only admins could. HyperProx records each everyday device as Home Assistant
    describes it at that moment (entity id, kind, device class and name), from the house itself, never from the
    request. If any of those later change, the mark no longer applies, the device needs the confirm step again,
    and the Devices view says so; a later save does not renew it. Protected wins over everyday. The Devices view
    also warns when a protected or everyday id no longer exists (a renamed device).
- **API tokens** can use everyday controls when the token's role allows it. They can never use a security
  control: the secure route needs a re-confirmation, which a token cannot give, and the service refuses a
  token there by name as well.
- **Rate limit.** 30 everyday and 5 security actions a minute per signed-in session (or token), counted before
  any role or confirm check, so repeated tries at a lock (an operator's on the everyday route included) are
  limited; and 60 attempts a minute of any kind, since each one reads the house. Answered 429 beyond that.
  Refreshing the Devices view is limited to 40 a minute per session, and one house's list is read at most every
  2 seconds however many pages are open. Health and status reads are limited to 30 a minute per session and
  read each house at most every 10 seconds. Certificate probes are limited to 10 a minute per session and are
  refused to API tokens.
- **One house at a time.** Each request names its house, and the connection is built from that house's own
  address and token, so an action for one house cannot reach another or carry its token. On a remote
  server's page, only the houses linked to that server answer.
- **Audit.** Every action, refused ones included (an unknown house, the wrong cluster, and the gate's own
  refusals of a signed-in person or token for role or re-confirmation), writes a row: who, through a session or which API token, the
  house, the entity, the action, the tier and the result (done, unconfirmed, failed or the refusal reason), and
  for a call that went through, the state before and after. Never the token. A gate refusal is recorded before
  the request body is read, so it names the house but not the entity. A security action can send the
  `ha.security.action` notification, and a refused one `ha.security.refused`, at most once per house every
  10 minutes. Requests with no valid session (401) or made while HyperProx is locked (423) are not given a row
  each, since anyone can send them: they are counted, and one `ha.action.anonymous` row per 10 minutes gives the
  counts.
- **Where an address may point.** A house's address is checked when it is saved and every time it is used,
  against every address its name resolves to then, and the request goes to the checked address (Host and TLS
  name unchanged), so a name that later resolves elsewhere gets nowhere. Loopback, link-local (cloud metadata
  included), multicast, HyperProx's own container networks and its own service ports on this machine are
  refused; `http://` is allowed only to a private address (RFC 1918, the CGNAT range Tailscale uses, IPv6 ULA).
  Certificates are verified for every house by default. A self-signed one can be pinned by its SHA-256
  fingerprint, read through `POST .../instances/probe-certificate` (admin): only that certificate is then
  accepted, and the token is not sent until the handshake has matched. The house's name is sent as the TLS
  name (SNI) even though the connection goes to the checked address. Changing the host or port drops the pin
  and needs the token again in the same save.
- **Bounded reads.** Each request to Home Assistant has a wall-clock deadline for the whole of it, and at most
  16 MB of any answer (WebSocket messages included) is read.
- **Viewers** see houses by name and devices by name, but not house addresses, pins, protected or everyday
  lists, whether the token is a Home Assistant admin, or the state and controls of security devices. Their
  health view (the house's Health tab and the plug-in's own detail page) leaves out security devices entirely,
  shows no automation times (when an automation last ran says when the house is empty) and no error log
  (it names devices' addresses and hostnames).
- **One way out for the token.** The read-only plug-in (card, detail page, metrics, the assistant's summary)
  reads the first house through the same checked client as the controls (`lib/ha-control/broker.ts`), GET only
  and only `/api/`, `/api/states`, `/api/config` and `/api/error_log`. The generic plug-in broker never sends a
  Home Assistant token: the plug-in declares `coreTransport`, and without that transport its calls fail closed.
  The catalogue's install wiring no longer passes stored secrets back when it sets a plug-in's address.
- **Tokens.** Each house's long-lived token is a vault item (`hyperprox:plugin/home-assistant` for the first
  house, `hyperprox:plugin/home-assistant.<id>` for the others). It is never returned to the browser, never
  logged, and kept out of error messages. Adding or changing a house is admin and asks for the master password.
  The generic plug-in settings route (`PUT /api/plugins/<id>/settings`) no longer accepts Home Assistant's
  address or token. For every plug-in it is now admin and re-confirmed (so API tokens cannot use it), and an
  address moved to another host or port must be given its credential again in the same save.
- **What a token can do.** A Home Assistant long-lived token carries every right of the user that made it,
  whatever HyperProx limits itself to. Make a dedicated Home Assistant user with administrator off and use its
  token. HyperProx asks Home Assistant which user a token belongs to and warns when it is an administrator.
- **Not covered.** Locks and alarm panels that need a code are not supported. The AI assistant has no
  control over Home Assistant: it can read the first house's state only.

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

## Send files: what runs on your nodes

Send files (the simple way) runs short, read-only commands on nodes over HyperProx's saved node logins, and
writes only when you confirm setup with your master password.

- **Looking for libraries** (each time the dialog opens, at most three times a minute): on every online node
  of both servers it reads the mount table, free space, the node's own addresses, the Proxmox storage list
  (`pvesh get /storage`), and `pct list` / `pct config` for running containers. On each running container that
  has shared folders it runs `pct exec <id> -- sh -c` to print Plex's `Preferences.xml` if there is one, and
  `pct exec <id> -- curl` to Plex on 127.0.0.1 for its library list. Each `pct exec` has 15 seconds and at
  most 2 MB of output. The Plex token is read into a shell variable on the node, handed to curl on standard
  input (`-H @-`), cut out of anything printed, and never leaves the node or reaches HyperProx.
- **Never look inside**: containers listed under Edit server, "Never look inside" (per server), containers on
  the Remote access exclusions (home), and containers tagged `hyperprox-ignore` are never entered. If the list
  cannot be read, no container is entered at all. The same check is made again before a scan after a copy.
- **Folders found** are checked on their node with `realpath -e`: a folder whose real path is not the path
  written (a link), or is a system folder, is dropped. Without Plex naming exactly that folder, Proxmox storage
  folders (`/mnt/pve/...` and any storage path) are never offered. Every copy root is also checked with links
  resolved at preview, at start, at resume and in the run script, and a root that resolves to the whole disk
  or a system folder is refused there too.
- **Finding the sender**: from each home node, a TCP connection to port 22 of the other node's private
  addresses (at most 16; never public, loopback or link-local).
- **Preview**: `find` in the picked items at home and under the same names in the library there (at most
  50,000 files per item).
- **Setup** (re-confirmed; never for an API token; bound to the preview it was shown with): allows the home
  libraries that hold the picked items and the one picked library, confirms an identity key you ticked, and
  installs one sending key for that library.
- **After a copy**: `pct exec <id> -- curl` to that Plex's refresh address for the one copied folder; only the
  answer code comes back.

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
