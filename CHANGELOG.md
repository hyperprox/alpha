# Changelog

What's new in HyperProx, newest first. Each entry is dated; HyperProx is in alpha, and the alpha channel
follows `main`, so most entries cover a few days of work rather than a numbered release.

The same entries are on [hyperprox.dev/changelog.html](https://hyperprox.dev/changelog.html), with an RSS feed at
[hyperprox.dev/feed.xml](https://hyperprox.dev/feed.xml), and HyperProx shows the ones that are new to you on
Updates → HyperProx before you install an update.

<!--
How to write an entry (read this before adding one):

  ## YYYY-MM-DD — Short title
  ### New | Improved | Fixed | Before you update
  - One plain-English line: what changed for the person using HyperProx, and why it matters.
    No file names, routes, settings keys or jargon. The website and the app show only these lines.
    - Technical: optional, indented one level under its line. Routes, files, migrations, flags.
      Shown on GitHub only; the website, the RSS feed and the app's update screen leave these out.

Write it by hand. Never paste commit messages. Keep "Before you update" for things a person must
know or do before they install. Newest entry at the top.
-->

## 2026-11-15 — Security updates to the software HyperProx is built on

### Fixed
- **Security fixes in the software HyperProx is built on.** Several libraries were updated to versions that close known weaknesses, and a feature HyperProx never used was switched off.
  - Technical: axios 1.21.1, js-yaml 4.3.2; overrides for node-forge 1.4.3, ws 8.21.0, multer 2.5.0, uuid 11.1.1, follow-redirects 1.16.2, form-data 4.0.6, fast-uri 2.4.8 / 3.1.9, and fast-jwt pinned exactly at 6.3.6. The Next.js image optimizer is off (`images.unoptimized`), as nothing uses `next/image`, so `/_next/image` no longer exists. pnpm is pinned (`packageManager`, and `install.sh` installs that exact version), and the optional Ollama image is pinned to its digest.
- **When something breaks, HyperProx now tells you what and why in plain words, with a reference number, instead of showing error codes or waiting forever.** Pages that could not load say so, rather than showing an empty list, and a page that fails to draw offers a reload.
  - Technical: one failure path for every route (`lib/failure.ts` `sendFailure` and the global error handler): `{ ok:false, error, code, requestId }`, the error with its stack, route, user and request id logged at error, never `err.message` for a 5xx. Prisma P1001/P1017/P2024 → 503, invalid JSON → 400, too large → 413, wrong media type → 415, zod → 400 with fields. Request ids are random UUIDs (nginx's `$request_id` trusted from loopback only), sent as `X-Request-Id`. About 30 catch-alls that sent `e.message` now use it. Frontend: `ErrorNotice` with "Reference: …", `errorText`/`failureText`, `app/error.tsx` and `app/global-error.tsx`; the sites, API tokens and notifications pages show load failures instead of empty states.
- **Signing in while the vault is down no longer says your 2FA code is wrong.** HyperProx now says the vault is not running, and those attempts no longer count towards the limit that locks an account for a while.
  - Technical: connection errors (refused, timed out, no such host, fetch failed, socket hang up) map to `vault_unreachable` (503) in the broker, the fast path no longer falls back to the CLI on them, and sign-in checks the vault's health first. Only wrong passwords and codes count in `signInLimiter`. Sign-in input caps: email 254, password 1024, code 6–8 digits.
- **A wrong Proxmox access key no longer stops HyperProx.** The dashboard says Proxmox refused the key and where to fix it, and tells that apart from Proxmox not answering and from HyperProx's own server not answering.
  - Technical: `getNodes`/`getAllVMs` reject with `ProxmoxAuthError` (401/403) or `ProxmoxUnreachableError` instead of resolving null; `/api/proxmox/summary` and the Proxmox connection test answer 502 `proxmox_auth`. The live feed sends `feed-problem` (or `problem` on a stale tick). A certificate that is not the pinned one is `proxmox_cert_changed` with its own message (never shown as an outage), and a refused token is no longer reported as "CEPH unavailable". `unhandledRejection` is logged and no longer ends the process; `uncaughtException` is logged, then exits.
- **An unreachable Proxmox now gives up after 20 seconds instead of about two minutes.**
  - Technical: `HomePinAgent` arms a 20 s connect-and-handshake timer ("Proxmox did not answer within 20 seconds"). The live feed's NPM read is one 10 s try; a tick released by the watchdog no longer broadcasts its late numbers as fresh. The update check gives `git ls-remote` 20 s.
- **When HyperProx's server is restarting, pages say so and reconnect by themselves.**
  - Technical: nginx answers 502/503 under `/api` with a JSON `api_down` body and 504 (the API too slow) with `api_timeout`, and passes `$request_id` to `/api`, `/ws` and the session check. `/health` reports `db: ok|down` (SELECT 1, 2 s). Security events (refused sign-ins, wrong master password at re-confirmation, setup-key refusals, bad or out-of-scope API tokens, role denials, failed unlocks) are logged and audited without any secret, at most once a minute per who, address and reason, with a count of the rest. Settings credential values are capped at 4096 characters with no control characters. The unused Redis connection and the ioredis and bullmq dependencies are removed; the `redis` service in `docker-compose.yml` and the installer is no longer used by anything (left in place for now). The setup wizard explains a token that cannot create the monitoring account instead of showing Proxmox's raw answer.
- **A guest you told HyperProx to leave alone is now left alone by every feature.** The ignore tag, the Remote access "never look inside" list and excluded subnets are one rule, checked again at the single place every command into a guest passes, so no page can enter an excluded guest. Before, adding or detecting a Nextcloud could still look inside a guest on that list. If the list cannot be read, HyperProx enters no guest until it can.
  - Technical: `lib/guest-guard.ts` (`IGNORE_TAG`, `parseTags`, `guestExcluded`, `setGuestExclusionSource`, `GuestExcludedRefusal`, `ExclusionsUnknownRefusal`) and `lib/net/ip.ts` (IPv4 and IPv6, IPv4-mapped addresses, host:port and URLs, `inCidrs`, `validCidr`, `hostPort`, `originParts`) replace the copies in auto-connect, Homepage, Remote access, load balancing, Updates, Send files and the infrastructure routes. `productionRemoteExecutor().run` refuses an excluded guest (tags read live from Proxmox) before any login is used. The Nextcloud plug-in's script runner reads the list every time and fails closed.
- **The Updates page no longer updates a Nextcloud behind the Nextcloud page's back.** Its compose project shows as managed by the Nextcloud page, with a pointer to update it there, and cannot be chosen; Nextcloud's own update keeps its database dump, maintenance mode and one-major-version rule. Updates also leaves a guest alone while a long Nextcloud job runs in it.
  - Technical: `lib/compose-owners.ts` registry (Nextcloud registers its app and signaling projects; an instance not detected yet covers its guest; an unreadable owner refuses every compose project). Long-job markers carry the guest (`lib/long-jobs.ts`). `lib/updates/guards.ts` feeds the tree, the plan and the runner, which checks again before each guest and each pull.
- **An owner who approved a scheduled move or balancing plan is no longer treated as "no longer an admin".** Promoting someone to owner no longer reads as a demotion either.
  - Technical: `approverChanged` moved to `lib/users/approvals.ts` and uses `hasRole(…, 'admin')`.
- **Looking for compose projects in every guest is now an admin action of its own.** A page read can no longer cause commands to run inside every guest.
  - Technical: `POST /api/updates/targets/discover` replaces `GET /api/updates/targets?discover=1`, which now answers 400. Allowed on remote clusters as before.
- **Actions taken with an API token now say which token in the audit log** on the Load balancing, Nextcloud, Homepage and auto-connect pages, not only the person who made the token.
  - Technical: `lib/http/request-actor.ts` (`actorOf`, `isAdmin`, `auditBy`, `actorWords`); placement audit rows carry `token` for settings, path checks, moves, plan create and stop, cancel, resolve, corosync reads and automatic balancing.

## 2026-11-15 — Plug-ins connect what they find by themselves

### New
- **Plug-ins connect what HyperProx finds, with no Connect button to press.** A Homepage or Nextcloud on your cluster is connected within a few minutes of being found, and again right after you unlock HyperProx. Unmanic workers and qBittorrent get their address filled in, and the Arr apps, Plex and Tautulli too when the vault holds their key for that same server.
  - Technical: `lib/auto-connect` runs every 5 minutes, after an unlock and after "Scan for services"; `/api/auto-connect` (admin; API tokens cannot pick). Never a `hyperprox-ignore` guest, a guest on Remote access's exclusion list, or an address in `HYPERPROX_AUTOCONNECT_EXCLUDE_SUBNETS` (an unreadable entry stops auto-connect altogether). Every connection is audited as the system, with how it was found and the vault item's id and name, never its value.
- **A new Homepage gets filled by itself.** When the dashboard is still Homepage's sample (or empty, or exactly what HyperProx wrote before), HyperProx fills it with your apps straight away, after backing up the old file. A dashboard with your own groups is never changed without your Apply, and auto-sync stays off.
- **Nextcloud's web login sets itself up when it safely can.** HyperProx uses an app password from a vault login saved for that same address. Otherwise it makes its own app password for the admin the Catalogue made, or for the only admin, keeps it in the vault, and revokes it when you remove the Nextcloud.
  - Technical: Nextcloud is added over `occ` through the node login, so health and setup checks need no password. Vault logins are matched only against addresses HyperProx saw itself (the service scan, Catalogue installs), never against the guest's own `overwrite.cli.url`. An ordinary password is never sent anywhere; only its user name is used. A failing web login is retried with a back-off (at most once a day) that survives a restart. An app password HyperProx made but could not revoke is recorded on the instance and sent as a vault alert; one it cannot identify is revoked by name and the retries stop.

### Improved
- **Nothing is guessed, and what you undo stays undone.** When there are two candidates (two containers, two servers, or two vault logins), the page asks you to pick one. Something you disconnect, remove or clear is remembered, and only **Connect again** brings it back.
  - Technical: a vault login matches only the same host, scheme and port; a URI without a port means its scheme's default port. State changes are serialised and merged key by key, so a disconnect, pick or connect-again made during a pass is never lost.
- **The Plug-ins page shows "connecting automatically…" or the pick waiting** instead of "needs a device added on its page" for a plug-in HyperProx is connecting by itself.

### Fixed
- **The web interface runs on a newer, supported version of the framework it is built on.** The old version had known security weaknesses that will not be fixed, so HyperProx moved to a supported one. Pages look and work as before.
  - Technical: Next.js 14.2.35 to 15.5.29 and React 18 to 19.2.9 (exact pins, with eslint-config-next and the React types). Dynamic page params are now read with React `use()`, a few React 19 type changes are fixed, and the image optimizer is switched off (`images.unoptimized`), so `/_next/image` answers 404. Nothing else in `next.config.js` changed: the version baking, local plug-in list, redirects and `/api` rewrite work as before.
- **Security fixes in the web server the HyperProx API runs on.** It moves to a new major version that closes several published weaknesses, which could let a request reach a route by an oddly written address, change its own body, skip input checks or slow the server down. HyperProx's own sign-in and role checks now also refuse a request whose address names the whole server instead of starting with a path, and check every request against both the address as sent and the page it reached. Before this fix, a signed-in user who could reach the API port directly, without going through HyperProx's own web server, could use such an address to get past role and master-password checks. Nothing changes in how HyperProx looks or works.
  - Technical: Fastify 4.29.1 → 5.12.8 (GHSA-p68q-wchp-6fh7, GHSA-667r-xxjv-c9mm and the other 4.x advisories), with @fastify/cors 11.4.2, @fastify/helmet 13.2.0, @fastify/jwt 10.2.7, @fastify/rate-limit 11.2.2, @fastify/websocket 11.3.7 and fastify-plugin 6.0.1, all pinned exactly. @fastify/jwt 10 brings fast-jwt 6.3.6 itself, so the `fast-jwt` override is gone. Router options now sit under `routerOptions`; the `;` delimiter stays off and paths with `;` are still refused by the gate. Helmet 8's defaults apply (HSTS `max-age` one year instead of 180 days). The gate answers 400 `bad_path` to any request target that does not start with `/` (absolute-form), and takes the stricter role and re-confirmation of the normalised raw path and the path the router served (the matched route with its parameter values filled in) (`lib/gate.ts`; tests in `gate-encoded-paths.test.ts` over a raw socket). The unused `proxy-addr` override is removed: Fastify 5 uses `@fastify/proxy-addr`. No route used shorthand schemas, `reply.redirect`, `request.connection` or `getResponseTime`, and the WebSocket handlers already took the socket first.
- **Background jobs now record problems in the log instead of failing silently, and the dashboard shows when its numbers are out of date.** Load balancing, notifications, the installer, Auto-connect and the live status feed used to hide their failures; they now log each new problem once, and a live number that could not be refreshed is marked as stale.
  - Technical: `lib/log-once.ts` (log once per distinct message, per phase); placement, notify, auto-connect, catalogue installer (a failed progress save is logged once and noted on the job), WireGuard rotation sweep and Homepage auto-sync log their caught errors; `ws-broadcast` skips a tick while the last is running and adds `stale` to the `fast` and `slow` payloads; job loggers take an explicit warn/error level; the same problem is logged again after an hour with a count, at most once a minute per phase; the remaining `console.*` calls in `lib/` go through the server logger.
- **The dashboard says so when its live numbers are paused.** If HyperProx cannot reach Proxmox, the numbers stop looking live: a notice appears and the charts stop adding points until the connection is back.
  - Technical: `fast` messages with `stale: true` are not stamped as synced and add no history.
- **Secrets stay out of the log.** Errors are logged as type, message, stack, code and status only, and credentials, tokens and cookies are redacted from logged objects.
  - Technical: pino `err` serializer and `redact` paths in `serverOptions`.
- **A hung connection can no longer stall HyperProx.** Reads from Proxmox for the live feed, GoDaddy, Nginx Proxy Manager, Grafana's admin password and Prometheus reloads now give up after a time limit instead of waiting forever.
  - Technical: 10 s on the Proxmox network read and the Prometheus reload, 15 s on GoDaddy, NPM per try (reads 15 s, writes 60 s, certificate requests 180 s; the retry loop is kept), a stuck feed tick is released after 60 s, 30 s on the Grafana `docker` calls.

## 2026-11-15 — Load balancing, choose exactly what to update, Nextcloud and Homepage plug-ins

### New
- **Load balancing** replaces Placement. It shows how evenly your nodes are loaded as a single score, and builds a plan that evens them out with as few moves as possible. You approve the plan once and it moves one guest at a time, stopping if anything about the cluster changes.
  - Technical: `/balance`; `/placement` and `/settings/placement` redirect. Per-node CPU and RAM at p95 of the window as a share of capacity; score = 100 minus the busiest/least-busy spread. Plans are admin-only with the master password (never an API token), audited at creation and per move, and re-check quorum, online nodes, Ceph against its state at approval and the guest's location before each move. New table `PlacementPlan` (additive migration, one running plan).
- **Automatic balancing**, off unless you turn it on. It can tell you when the cluster has been uneven for a while, or, if you allow it, move one guest at a time within limits you set. An emergency stop turns it off.
  - Technical: moves only non-HA guests with no disks to copy, under a moves-per-day and hours-between-moves limit and the bandwidth limit on a shared network. HA guests held by their own rule get a rule-change suggestion instead.
- **"Why is it here?"** for every guest: the reason each guest sits on its node, and a safe single move on request.
- **Updates: choose exactly what to update.** The Updates page lists everything as a tree (Ceph, each node and its packages, each guest with its packages, Compose projects and apps). Tick any mix, or press Update this on one row. HyperProx shows the order before you confirm, and one failed item no longer stops the rest.
  - Technical: guests run before their node, Ceph before nodes, nodes one at a time, HyperProx itself last. Single packages use `apt-get install --only-upgrade --no-remove` after a simulation; refused for held, Ceph and kernel packages on a node that holds or pins its kernel. Unknown holds or pin are refused. Guests tagged `hyperprox-ignore` are never read or touched. Starting, confirming and resuming a chosen run re-asks for the master password.
- **Nextcloud plug-in.** A page for each Nextcloud showing its version, every warning from its admin page, Talk, background jobs and the log. Every warning comes with a one-tap fix or a guided step, and a Docker Nextcloud can be updated safely: the database is saved first, and the update is refused while people are using it.
  - Technical: `occ` runs in the guest through the node login from a fixed allow-list with quoted arguments. Compose updates: maintenance mode, a database dump read back, the old image tagged, `build --pull` for Dockerfile builds, recreate, upgrade wait. Admin only; secure actions need the master password; API tokens are refused.
- **Homepage plug-in.** Fills a Homepage dashboard with every app on your cluster, grouped and linked, with live up/down checks, and keeps it in sync. Your own groups and edits are never touched, and every change is previewed and backed up first.
  - Technical: builds `services.yaml` from the service scan, Catalogue installs, plug-ins, proxy hosts and Websites. HyperProx owns only the groups it wrote (marked in the file, hashed per entry). Writes are diffed, audited, backed up, refused if the file changed since the preview, parsed back and checked on Homepage's `/api/services`. Auto-sync is off by default. Widget keys go from the vault into a `0600` `.env` as `HOMEPAGE_VAR` values.
- **The installer asks better questions and looks the part.** It asks which container ID and network address to use (and suggests one), and offers to set up remote access with Tailscale or WireGuard as part of the install. It now shows numbered steps, progress spinners, a summary to check before it starts, and a clear success or failure card at the end.
  - Technical: `bootstrap.sh` checks the ID against every guest config and the cluster resource list; DHCP or static with gateway. Tailscale goes into HyperProx's own container (sign-in link and QR, or `TS_AUTHKEY` / `--tailscale-authkey`); WireGuard gets a small unprivileged container of its own. Nothing is installed on a Proxmox node. The VPN page adopts what was set up (`data/setup/vpn-pending.json`) on the owner's first sign-in. Plain output with `NO_COLOR`, on dumb or narrow terminals, or with no terminal.
- **Users and invites.** Invite people with a one-time link (no email server needed), choose their role, change it later, or remove them. A change takes effect straight away.
  - Technical: confirm by key fingerprint; roles are decided by the vault, and a role change or removal ends that person's live sessions. Inviting or managing operators and admins needs the owner.
- **A public health check**, so uptime monitors can tell HyperProx is running without signing in. It says only "ok" and gives nothing else away.
  - Technical: `GET /api/health` → `{"status":"ok"}`, no session needed, answers while the vault is locked; nothing else is exposed.
- **A troubleshooting script** for an install that only half works. It reads, and changes nothing.
  - Technical: `scripts/diagnose.sh`; when started on the Proxmox host it runs inside the HyperProx container.

### Improved
- Long installs now show a **progress checklist** instead of a row of overlapping circles: each step with its state and time, what is happening now, and any error kept in view.
  - Technical: new `RunSteps` component; six steps or fewer keep the row, more become a scrolling checklist. Used by the New website wizard and Catalogue installs.
- Updating HyperProx, or redeploying it, now **waits for long plug-in jobs** (such as a Nextcloud update) to finish instead of interrupting them.
  - Technical: jobs register in `/run/hyperprox-busy`; `deploy.sh` and the in-app updater refuse while one is live. `HYPERPROX_IGNORE_BUSY=1` overrides.
- After the owner signs in for the first time, HyperProx **checks every node's identity by itself**, with no extra login.
- The **setup wizard** fits on a phone, follows your light or dark theme, and can be used fully from the keyboard. Windows that pop up behave as real dialogs.
- **WireGuard** is offered only on nodes that can run it, with the fix shown for those that cannot.
- Guest actions now finish when Proxmox says the task finished, so the page no longer says "started" for something that failed.
- Service detection finds Nextcloud, Vaultwarden and Proxmox Backup Server more reliably, and plug-ins stop polling until they are set up.

### Fixed
- **Typing in a dialog no longer jumps to the close button.**
- **The setup key stays removed** after the owner first signs in. Before, it could come back.
  - Technical: the owner's first sign-in ran a credential migration that wrote an old copy of `.env` back over `markSetupDone`, restoring `SETUP_SECRET`. Every `.env` writer now goes through one helper under one lock.
- **Charts work on a fresh install.** Prometheus no longer fails to start because of a folder permission, and the install now checks that it really answers.
  - Technical: `bin/hyperprox-config` creates `data/prometheus` owned by the Prometheus user (65534) and fixes an existing root-owned one on every install and update. `install.sh` fails if a container is restarting or unhealthy.
- Only one monitoring token is created, and removing a token also removes its permissions.
  - Technical: the exporter token is always `<token>-exporter`; every token delete removes its ACL lines first, since Proxmox keeps them.
- Self-update never offers an older version than the one you run, and follows the place you installed from.
- Updates never upgrade a node whose package holds or kernel pin cannot be read.
- **Updates on a remote server work like on your home cluster.** The list of what can be updated, the order preview, finding Compose projects in every guest and updating a single Compose project now all work for a remote server, with the same protections. HyperProx's own update is no longer shown on a remote server's page, since it updates this HyperProx and nothing on the remote, and "Add node login" there now opens that server's own logins.
  - Technical: `GET /api/updates/targets` (with `discover=1`) and `POST /api/updates/preview` are allowed for a remote cluster. Compose projects are read through the remote's executor (pinned logins, the script guard): where its policy section turns docker on, or in every guest when asked, never in excluded guests, guests with `docker: none` or guests tagged `hyperprox-ignore`. A run re-lists the chosen project with `docker compose ls` and uses its `-p` name and every `-f` file from then, with the master password re-entered, audited, and a failed item leaving the others alone. Plug-in app updates stay home-only: they use plug-in settings and proxy hosts kept for the home cluster.
- Many small fixes from the first round of fresh-install tests: layouts at phone width, clearer "found" versus "connected" in the wizard, the setup link can be copied, and the container form puts block storage first.

### Before you update
- **Placement is now Load balancing.** Old links and bookmarks still work and take you to the new page. Automatic balancing stays off until you turn it on.
- Running a chosen set of updates asks for your master password again before it starts.

## 2026-11-12 — Websites, self-update, new plug-ins and a fresh look

### New
- **HyperProx updates itself.** Updates → HyperProx shows your version and whether a newer one is out, with what changed in plain words. Installing makes a database backup first, checks the new version, and rolls back by itself if anything fails.
  - Technical: stable channel follows GitHub Releases (pre-releases included by default while every release is `-alpha`); alpha follows `main`. Admin only, master password re-entered, never an API token. Backup to `/root/hyperprox-backups/`, verified checkout from a staging copy, `deploy.sh` from the new version, then API/web/nginx checks. Optional GitLab mirror. See README, "Updating HyperProx".
- **Websites**, a section of its own. Start a new static site, WordPress or Ghost site from a wizard, add a site you already run, or delete one with a preview of exactly what goes.
- **Site metrics**: privacy-friendly visitor counts from each site's own log, telling real people apart from bots, with a security card and a Websites card on the dashboard.
  - Technical: read from each site's nginx log (and LiteSpeed sites, read-only); HyperProx's own requests identify themselves as `HyperProx-<what>/1`.
- **A brand new look** for the whole app, with designed dark and light themes.
- **Proxmox Backup Server plug-in** and Catalogue app: datastores, each guest's newest backup, job health, and which guests have no backup. Read-only unless you turn on backup management.
  - Technical: sign in once and HyperProx makes its own read-only token; the server certificate is pinned first. Opt-in delete, prune and clean-up need the master password; protected snapshots are never touched.
- **QNAP plug-in**: drive bays with disk health, volumes, shares, temperatures and alerts for each NAS, including one on another network.
- **ASUS routers plug-in** for stock and Merlin firmware, with AiMesh, no Home Assistant needed.
- **Home Assistant control**: your house as tiles by room, for one home or several. Locks, alarms and sirens sit behind an extra confirm.
- **Plex plug-in**: sign in with Plex, see what is streaming, a Library view, and Clear-out to find and safely remove what nobody watches.
- **Arr Stack**: a live queue grouped by show and season with one-tap fixes (find another, retry import, swap for a season pack, fix all stalled), an Upcoming view, Lidarr for music, and a Catalogue install that wires the apps together for you.
- **Unmanic and Tdarr** in the Catalogue, with extra worker and node entries to use the GPUs on other nodes.
- **Cloudflare DNS** beside GoDaddy, each domain handled by the provider that holds it.
- **Alerts**: hardware warnings (disks, temperatures and more) are sent to your notification channels in plain English.
- **Naming and addresses** setting, so new guests follow your own numbering.
- **Demo mode** with invented data, for screenshots and a public demo.

### Improved
- The dashboard is now a glance: one verdict, a chip per plug-in and a row for your websites, with node detail moved to Infrastructure.
- The AI assistant can read your NAS, storage, alerts, notifications, homes, websites and plug-ins, and plan a new website through the wizard.
- An API token can be allowed to save plug-in settings without your master password, if you choose.
- The terminal checks a changed server key with Proxmox before trusting it.
- Wizards fit the screen, and plug-in pages scroll properly on phones.

### Fixed
- A long list of security hardening: sign-in rate limits, safer cookies and headers, stricter checks on every remote command, and pinned certificates.
  - Technical: cross-site writes and WebSocket upgrades refused, no CORS, rate limits per address and per account, `frame-ancestors`/`X-Frame-Options`/`nosniff`/`Referrer-Policy`, the home Proxmox API certificate pinned, no trust on first use for home node keys, redirects never followed by the plug-in broker or probes.
- Signed-out pages send you to sign-in again, using the address your browser used.
- Proxy certificate requests work on newer Nginx Proxy Manager versions.

## 2026-11-10 — The Command center: more than one cluster

### New
- **Command center**: add other Proxmox servers and clusters (a family member's, say) and see them all on one page, with full control of each.
- **Send files** between clusters: copy a folder from one node to another with a key that can reach only that one folder.
  - Technical: rsync over a forced-command key scoped to one folder; both ends re-checked at launch, resume and just before the copy; system folders refused as roots.
- **Every GPU on every node** in the Command center, including Intel and AMD figures.
- **The AI assistant works across clusters**, answering about and acting on any connected one, with a confirm card per cluster.
- **Updates on remote clusters**, with a daily check that tells you what is waiting.

### Improved
- Adding a server checks its certificate and node keys automatically, in one step.
- Removing a cluster also removes HyperProx's access to it.

### Fixed
- High availability actions stay on your home cluster only, and remote node logins need a confirmed server key.

## 2026-11-06 — Remote access, high availability and a Catalogue install wizard

### New
- **Remote access and VPN**: Tailscale and NetBird with one-click installs per machine, sign-in links, and a list of machines and their state. HyperProx also finds VPN clients you already run.
- **WireGuard** servers and phones from the VPN page.
- **High availability page**: rules in plain words, a preview of what happens if a node fails, maintenance mode, and protection lists.
- **Catalogue install wizard**: five steps, with node, address and ID suggested for you and checked before anything is created.
- **Reverse proxy providers**: Nginx Proxy Manager, Traefik, Caddy, HAProxy and Pangolin in one table, with a preview before every change.
- **Infrastructure** refresh: edit a guest's settings with a preview, a GPU and device editor, built-in graphics for containers, and a devices view per node.
- **Setup checklist** under Settings, so nothing from setup is left for you to remember.

### Improved
- **Ceph-safe updates**: node reboots and restarts wait until Ceph is safe, never upgrade Ceph packages on their own, and show the decision in the plan.
- Monitoring now uses its own read-only Proxmox token, and Grafana is only reachable after you sign in.

### Before you update
- The bundled Nginx Proxy Manager option has been removed (it could never start beside HyperProx's own web server). Install Nginx Proxy Manager from the Catalogue instead, where it gets a container of its own.
  - Technical: `npm` is dropped from `COMPOSE_PROFILES` by the upgrade step. Prometheus and Grafana are bound to loopback; Grafana is at `/grafana/` behind the session.

## 2026-11-01 — Certificates, notifications, API tokens and app updates

### New
- **Certificates**: every certificate HyperProx can find, when each expires, automatic renewal through your DNS provider, and alerts before anything runs out.
  - Technical: ACME over DNS-01 with ARI renewal windows; probes over TLS and STARTTLS; policy in `config/certs.yaml`; admin-only `/api/certs`.
- **Notifications**: one place to send alerts to Discord, Teams, ntfy, Gotify or a webhook, for updates, certificates, locks and more.
- **API tokens** for scripts and automation, which can never do the things that need your master password.
- **App updates**: the Updates page can update apps inside guests too, starting with MeshCentral.
- **Deploy by asking**: tell the AI assistant what you want installed in plain words, and it asks only for what it needs, then creates the container.
- An optional local AI (Ollama) that runs on your own hardware.

### Improved
- **Restarting HyperProx no longer locks it.** A small helper holds the unlocked state, and if HyperProx does lock by itself it sends you a message with a link to sign in.
- The AI assistant answers questions about your cluster and everything attached to it.

## 2026-10-25 — The vault gate, Updates, and HTTPS by default

### New
- **Vault gate**: HyperProx is secured by a built-in password vault. You sign in with your vault account, and every saved password and token lives in the vault instead of a settings file.
  - Technical: Vaultwarden pinned by digest on loopback, sign-ups off; roles from the vault; credentials migrated out of `.env` on first unlock. See `docs/security.md`.
- **Updates**: update nodes and guests from one page, with a preview of the plan, live progress and history.
- **HTTPS by default**, with a self-signed certificate until you add your own.
- **Grafana** inside the app, on the Monitoring page.

### Improved
- Signing in to the vault is much faster (well under a second).
- The dashboard shows sparklines, HA, power, storage, GPUs and service status.
- A version number, 0.2.0-alpha, shown in the app.

### Before you update
- From this version you sign in with your vault account; the owner is created from the sign-in page. Your browser will warn about the self-signed certificate until you add your own.

## 2026-10-14 — A new look and an easier first run

### New
- The HyperProx look across the whole app: new fonts and navy and teal colours.
- The setup wizard connects with your Proxmox login and makes its own token, so you no longer create one by hand.

### Improved
- Installs on Debian 13, with a visible progress spinner and timer.
- Nginx Proxy Manager and Proxmox Backup Server are recognised more reliably during setup.
