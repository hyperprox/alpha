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

## 2026-11-18 — Arr Stack: sort the films and shows you already have

### New
- **Sort my library.** On the Sorting tab, Preview applies your saved rules to everything you already have and lists what is not where they would put it, in groups with a count and the reason, such as horror films in your main folder. Nothing is proposed out of a hand-picked folder or into one. Tick whole groups or single titles, confirm, and HyperProx moves exactly those, 20 a minute, with the progress on the page and a Stop button. Each item is checked again just before it moves, every move can be moved back, and a connected Plex server is asked to rescan once at the end.
  - Technical: `POST /router/library/preview` (admin, read-only, single-use, 15 minutes, bound to the person) runs `libraryPlan` (the library test's engine, grouped by from, to and rule; curated folders skipped both ways; leave-alone ids skipped). `POST /router/library/apply` (confirmed, the sentence names the count and groups, audited before anything is queued) stores the queue under `library:<app>` in `ArrRouterSetting`, moves 20 at once and 20 a minute from the timer through the usual move (editor with `moveFiles`, tag, file-move tracking, import wait, read-back), re-checking from and to each time; `POST /router/library/stop` (confirmed). At the end, `/library/sections/<key>/refresh` for each matching Plex library through the Plex plug-in, when connected. Tokens are refused.

## 2026-11-18 — Arr Stack: new requests sorted into your folders

### New
- **New requests go into the right folder by themselves.** Request apps send every film to one folder and every show to another. On the Arr Stack's new Sorting tab you set rules (documentaries, Christmas films, horror, Marvel and DC, family cartoons, live-action family films; animated, ended and running shows), each pointing at one of your own folders, in the order you choose. About a minute after a request is added, HyperProx moves it into the folder its rules pick, files and all. Only new requests are moved: nothing already in your library, and nothing you placed yourself.
  - Technical: `lib/arr-router` (rules, service, store, production) and `routes/arr-router.ts` under `/api/plugins/arrstack/router`; a 60 s timer from `lib/services/bootstrap.ts` (step `arr-router`, skipped while locked) probes the ids after the highest seen and reads the full list at most every 15 minutes; moves via `PUT /api/v3/movie/editor` or `/series/editor` with `rootFolderPath`, `moveFiles` and the `hpx-routed` tag (looked up again and retried once when the tag is stale), audited first with `auditOrThrow`, read back, and the arr's move command followed (`files` pending, moved, failed); items in `importPending` or `importing` wait a minute; folders of a `curated` rule are never a target; 20 a minute per app; items added after switching on and within 24 hours only. New table `ArrRouterSetting` (migration `20261118130000_arr_router`, additive). Optional plug-in settings `seerr_url` and `seerr_key` (endpoint `seerr`, filled by the Arr Stack install when Seerr is connected): the suggested request folder is the default non-4K server's `activeDirectory` from `/api/v1/settings/radarr` and `/sonarr`.
- **Test on my library before you switch it on.** The test runs your rules over everything you already have without moving anything, and shows how much already agrees, each folder now and with the rules, and the biggest disagreements with examples. Sorting is off until you switch it on from a test of exactly those rules, and you confirm it.
  - Technical: `POST /router/test` (admin, read-only, six a minute); `POST /router/settings` needs a test id with the same rule fingerprint from the last 15 minutes to switch on; settings, move and graduate are in `ARR_CONFIRM` with sentences in `lib/confirm-text.ts`; every POST is refused to API tokens.
- **See what was sorted, and move it back.** Recently sorted lists each move with why, and Move to puts an item in another folder; the sorter then leaves it alone.
- **Graduate finished shows.** Optional and off by default: a show that has ended, with every aired episode on disk, moves from your running-shows folder to your ended-shows folder. You see the list first and confirm it.
  - Technical: `POST /router/graduate/preview`, then `POST /router/graduate` with its id queues exactly those shows (20 a minute) and stores only `{ on, from, to }` under `graduate:sonarr`; checked every six hours while the enabled running and ended rules name those folders; graduated ids are never graduated again; saving the rules can only keep it on or switch it off.

## 2026-11-18 — Package cache: updates no longer fail on some guests

### Fixed
- **The Updates check no longer shows days-old results after you update.** When the daily check fell while an update was running it skipped itself and nothing ran it again, so the dashboard kept saying "Security updates on 10 machines" after everything was updated, and listed guests deleted days ago. HyperProx now checks again about half a minute after an update ends, and the dashboard says how old the last full check is and when it is checking again.
  - Technical: `UpdatesChecker.jobEnded()` is called by the runner's `finish()` through `onJobFinished`; the check tick runs one debounced check (`afterJobMs`, 30 s), never while locked or while a job or check runs, and not when a check already started after the job ended. A check skipped with "an Updates job is running" is owed and runs once the job is gone even if no end was announced. `recheck` is added to the check status and cluster rows when read; the overview panel's `checkedAt` is the last full check for a skipped result.
- **Updates failed on guests using the package cache with "ProxyAutoDetect returned an error".** The folder HyperProx writes its cache check into was readable by root only, and apt runs that check as its own restricted user. The folder is now readable by everyone, the check is tested the way apt runs it, and if apt still cannot run it the setting takes itself out so the guest updates directly.
  - Technical: `install -d -m 755` for the detect folder whatever the umask; the reachability check runs via `runuser -u _apt`; a failure removes both files and prints `result=unusable`, recorded as failed.

## 2026-11-17 — Arr Stack: a better copy, and the VPN at a glance

### New
- **Find a better copy of anything in your library.** On the Arr Stack's Upcoming tab, look up a film, show or album and pick the film, album, a season or one episode. You get a ranked list: what your quality profile accepts first, then the better quality, then more seeders, with slow torrents marked. One tap downloads your pick and moves it to the top of qBittorrent's queue; what you have stays until the new copy is imported.
  - Technical: `routes/arr-better.ts` (GET `/better/find`, `/better/episodes`; POST `/better/search`, `/better/grab`, admin, token-forbidden, audited first via `auditOrThrow`; `/better/grab` is in `needsConfirm` and its sentence in `lib/confirm-text.ts` names the release from the server's own search); `lib/arr-better/rank.ts` ranks by approved, `qualityWeight`, seeders; `SLOW_SEEDS = 3`.
- **This download is too slow: find a faster copy.** Each download on the Queue tab has Find a faster copy. The new download starts first; once it is in the queue, the slow one is removed from qBittorrent and blocklisted, and nothing else in the queue is touched. If the new one does not show up, the slow one stays.
  - Technical: target `queue:<app>:d:<downloadId>`; rows resolved from a fresh `readAllQueue` with `resolveDownload` and checked against the item's own ids; removal `DELETE /queue/bulk?removeFromClient=true&blocklist=true&skipRedownload=true` with those row ids only.
- **What your profile refuses stays refused, in plain words.** The one exception is a release the profile only turns down because the slow download is still queued: you can grab it anyway when swapping that download out.
  - Technical: `verdict` ok / anyway / refused per row; `anyway: true` is accepted only with a queue swap.
- **A VPN panel for Arr Stacks behind Gluetun.** The Queue tab shows whether the tunnel is up, where it comes out, the forwarded port beside qBittorrent's port, speeds and uptime. The public address is for admins only, and your VPN login is never read.
  - Technical: `routes/arr-vpn.ts` (GET `/vpn`, POST `/vpn/actions`, in `needsConfirm` with one sentence per fix in `lib/confirm-text.ts`); `lib/arr-vpn` runs a read-only script in the stack's container through the remote executor (guest guard applies): `docker inspect`, `/gluetun/forwarded_port`, control server `/v1/vpn/status`, `/v1/publicip/ip`, `/v1/portforward`; env filtered in the guest to six non-secret keys.
- **Every VPN problem has a fix button.** Put the forwarded port into qBittorrent, reconnect the tunnel (downloads pause for about a minute), or restart qBittorrent when it lost the VPN's network. Each is confirmed and written to the audit log first.
  - Technical: reconnect is `PUT /v1/vpn/status` stopped then running from the guest; if refused, `docker restart gluetun` then `qbittorrent`. Region switching is deliberately not offered.
- **An alert when the VPN stays broken.** If the tunnel is down or the port is wrong for more than ten minutes, you get one message, and one more when it is fixed.
  - Technical: notification types `arr.vpn.down`, `arr.vpn.no-port`, `arr.vpn.mismatch` (fingerprinted, resolved on recovery); watch every 2 minutes from `lib/services/bootstrap.ts` step `arr-vpn`.

### Improved
- **Clearer reason when something is already downloading.** When Sonarr, Radarr or Lidarr turns a release down because a release in the queue already meets the cutoff, the reason now reads "Something as good is already downloading" instead of "Not better than what you already have". This shows in Find a better copy and in See what's available.
  - Technical: the release rows, queue read and grab checks moved to `lib/arr-release/` and are shared by the give-up service and the better-copy service.

## 2026-11-17 — Confirmations instead of the master password

### Before you update
- **Actions now ask you to confirm instead of asking for your master password.** Reboots, updates, guest deletes and moves, plug-in actions (locks, alarms, garage doors, network gear, NAS power, backups and the rest), installs, and settings changes show what will happen in a sentence, with Confirm and Cancel. Your master password is now asked for only to reveal a stored secret and to change who can sign in, and to create network access keys, approve devices, open a site's admin login, or trust a node's SSH host keys. Scripts using API tokens are refused on these actions, as before.
  - Technical: `lib/confirm.ts` (single-use, five-minute token bound to the session, method, path and query, `X-HyperProx-Cluster` and the body; `403 confirm_required` carries `confirm.token` and `confirm.summary`; the retry sends `X-HyperProx-Confirm`), `lib/confirm-text.ts` (the sentences), `lib/roles.ts` `needsConfirm` and `needsPassword` (`needsReconfirm` is now either), the gate's `preValidation` hook, `action.confirmed` audit rows with `confirmed: 'in page'` written before the action (fail closed, 503 `audit_unavailable`), API tokens `403 token_forbidden` on every confirmed route. Updates, self-update and the setup checklist use `requireConfirm`; the assistant's card is the confirmation and is never applied by an API token. `needsPassword` also covers `ACCESS_PASSWORD` in `lib/roles.ts` (Tailscale and NetBird `manual-key`, `login-url`, device `approve`, new WireGuard devices and `wg/peers/:id/rotate`, `sites/:id/admin-login`, `setup-checklist/host-keys/anchor` and `confirm`, `ha/nodes/:node/hostkey/pin`, `clusters/:id/verify-keys`); `replaceInstaller` on the anchor also needs `reconfirmedWithin` 60 s.

### Improved
- **One confirmation, everywhere.** Every page uses the same dialog, drawn above anything else and easy to use on a phone. Where a page already shows a preview with an Apply button, or asks you to type a name, that is the confirmation and nothing more is asked.
  - Technical: `lib/confirm-bus.ts` and the fetch wrapper in `lib/api.ts` answer `confirm_required` once for every page; `IN_PAGE` marks a request the page has just confirmed itself; `components/vault/ConfirmDialog.tsx` and `ConfirmHost.tsx`. The per-page master-password prompts for these actions are gone; `ReconfirmModal` stays for revealing secrets, people and API tokens.
- **Every confirmed action is in the audit log.** The row says it was confirmed on the page and is written before anything runs; if it cannot be written, nothing runs.
- **The package cache's fleet actions are confirmed in the page too.** Repairing every guest's cache setting, removing it from all guests, and Updates' use of the cache show what will happen and ask you to confirm.

## 2026-11-16 — Opening the home cluster

### Fixed
- **Open on your home cluster now takes you to its dials.** On the dashboard and the Command center, Open on the home cluster went back to the dashboard and seemed to do nothing. It now opens the dashboard with More detail unfolded and in view: the cluster dials, the GPU dials and the connected services.
  - Technical: `openHref` in `components/clusters/CommandCenter.tsx` links the home cluster to `/dashboard?more=1`; `app/dashboard/page.tsx` opens `details#more` and scrolls to it once the first numbers arrive.
- **Two layout fixes in More detail.** Nginx Proxy Manager's figures in Connected Services now sit on their own line under its name instead of running into it in a narrow column, and the GPU card's heading shows the whole node name instead of cutting it off.
  - Technical: the service row wraps (`flex-wrap`, figures `w-full order-last`, three columns over two rows); the GPU heading no longer truncates at 200 px.

## 2026-11-16 — K3s (Kubernetes) in the Catalogue, with its own plug-in

### New
- **Install K3s from the Catalogue.** A lightweight Kubernetes server in its own container, pinned to a checked release, with its built-in ingress, load balancer, storage and metrics. It finishes connected: there is nothing to copy or paste.
  - Technical: recipes `k3s` and `k3s-agent` (`lib/k3s/recipe.ts`), K3s v1.37.1+k3s1; the release binary (amd64/arm64) and the tagged `install.sh` are checked against pinned SHA-256 values, then `INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_VERSION=…`. Setup `k3s` in `lib/catalogue-installer.ts` runs `lib/k3s/catalogue.ts`: keyctl from the node (read back), the admin kubeconfig and node token read in the guest into the vault, then the plug-in connected.
- **It stays an unprivileged container.** HyperProx does not use the privileged, AppArmor-off setup most guides use; it was tested working on Proxmox 9 with Debian 13 without it.
  - Technical: `features: nesting=1,keyctl=1`, kubelet `KubeletInUserNamespace`, kube-proxy `conntrack-max-per-core=0`, flannel `host-gw`. No raw `lxc.*` lines, no `/dev/kmsg` bind.
- **Add agents on other nodes.** The finished install offers another worker; the wizard fills in the server, takes the join token from the vault, and recommends a Proxmox node that does not run this cluster yet.
  - Technical: `spreadWith` on a recipe makes placement count against nodes that already hold a guest of those recipes (`spreadNodes`, `PLACEMENT.spreadPenalty`); the agent preview refuses a server HyperProx does not look after or whose join token is not in the vault; the token reaches the guest only in the root-only script and `config.yaml` (`export -n`).
- **A K3s plug-in.** Each cluster's nodes with CPU and memory, the pods in trouble with the reason and their last log lines, workloads with ready against desired, warning events, ingresses and services with their addresses, and whether a newer K3s is out.
  - Technical: `plugins/k3s.ts` (core transport), `lib/k3s/` (parse, transport pinned to the cluster's own CA, service, instances), `routes/k3s.ts` under `/api/plugins/k3s`, page `components/plugins/k3s/`. Reads use the `hyperprox-reader` service account (no secrets or config maps; checked before the cluster is kept).
- **Every problem it shows has a fix.** Roll back a bad image, restart or delete a crashing pod, scale, cordon, uncordon and drain a node (it shows first what moves, what stays and what would be lost), and read the logs. Admins only, with the master password, confirmed in words and written to the audit log.
  - Technical: actions use a second account, `hyperprox-operator` (its token in its own vault item), with RBAC to patch workloads and their scale, delete and evict pods and patch nodes, narrowed by three ValidatingAdmissionPolicies (`hyperprox-operator-workloads`: the pod template's spec and labels unchanged, its annotations unchanged but `kubectl.kubernetes.io/restartedAt`, owner references and finalizers unchanged; `hyperprox-operator-statefulsets`: volume claim retention unchanged; `hyperprox-operator-nodes`: nothing but `spec.unschedulable`); a roll back is sent with the admin login after the confirmation; each target is read again before the action; roles in `lib/roles.ts` (`K3S_ADMIN_READ`, `K3S_RECONFIRM`). The stored kubeconfig is rebuilt from the checked values; YAML anchors and aliases, merge keys, proxy-url, insecure-skip-tls-verify, exec, auth providers and file paths are refused on every entry, and the walk stops at 10,000 values.
- **K3s it finds connects by itself.** The service scan now recognises a Kubernetes API, and HyperProx connects a K3s server it finds on your guests. It asks for a kubeconfig only when it finds an API but no K3s login it may read.
  - Technical: probe `k3s` (port 6443, a 401 `Status`) in `service-probes.js`; auto-connect adapter `k3s` reads `/etc/rancher/k3s/k3s.yaml` through the guarded executor, never in a guest that must be left alone; the Catalogue page opens a recipe's wizard from `?recipe=`.

## 2026-11-16 — Package cache for Updates

### New
- **A package cache in the Catalogue, so Updates downloads each package once instead of once per guest.** It runs apt-cacher-ng in its own container, keeps the packages on a disk of its own (50 GB unless you pick another size), listens only on your network and lets in only the networks you choose. It caches the Debian and Ubuntu archives; HTTPS repositories are still fetched directly by each guest.
  - Technical: recipe `apt-cacher-ng` (`lib/aptcache/recipe.ts`, `setup: 'aptcache'`) installs Debian 13's `apt-cacher-ng` 3.7.5-1, pinned, into an unprivileged container with `mp0` on the chosen storage (`backup=0`) at `/var/cache/apt-cacher-ng`. The in-guest helper `hpx-aptcache` writes `zzz_hyperprox.conf` (BindAddress on the LAN address and loopback, `UseWrap: 1` with the allowed networks in `hosts.allow`, HTTPS passed through to port 443 only) and the admin password (`AdminAuth`, kept in the vault). Allowed networks must be private, masked and no wider than their private block (`lib/aptcache/net.ts`). The install ends with the helper's self-check in place of the web check.
- **Updates points your guests at the cache by itself.** Before apt runs in a guest, Updates adds one apt setting that uses the cache for the Debian and Ubuntu archives only when it answers within three seconds, and goes direct otherwise. A dead cache never stops an update, and a sick one is skipped once HyperProx notices. The setting is on the cache's plug-in page: automatic, on or off, per cluster. Proxmox nodes are left alone unless you include them.
  - Technical: `lib/updates/apt-cache.ts` runs before `apt` and `apt-packages` guest steps and, when the cluster's setting includes nodes, before `node-upgrade` and `node-packages`, through the Updates executor (so the leave-alone rule applies). It writes `/etc/apt/apt.conf.d/01hyperprox-cache` with `Acquire::http::Proxy-Auto-Detect` and a detect script that prints `DIRECT` when the cache does not answer over HTTP; a guest with its own apt proxy is left alone. Off removes it where HyperProx put it. The step never fails an update. Settings: `GET/PUT /api/plugins/apt-cacher-ng/use?cluster=`.
- **The package cache has its own plug-in page, connected by itself after the install.** It shows how much came from the cache as a flow from the internet to your guests, hour by hour, the disk, the busiest packages and repositories, which guests use it (by name, never by address) and the last clean-up. Every problem has a fix button: start it again, run the clean-up, grow its disk, or repair the cache setting on every guest; there is also a button to take it out of every guest.
  - Technical: plug-in `apt-cacher-ng` (`plugins/apt-cache.ts`), service `lib/aptcache/service.ts`, routes `routes/aptcache.ts` under `/api/plugins/apt-cacher-ng`, auto-connect adapter, page `components/plugins/aptcache`. All routes are admin; who may use it, the Updates setting and the guest-wide repair and removal are re-confirmed (`lib/roles.ts`); API tokens are refused every change (`lib/api-tokens.ts` and the service). Every action is audited first and not done when the audit cannot be written. Growing the disk uses the guest config editor's preview and apply.

## 2026-11-16 — Arr Stack: give up after X tries, and see what is available

### New
- A weekly search for everything missing, for TV, films and music separately: on the day and hour you choose (Monday at 08:00 unless you change it), HyperProx asks Sonarr, Radarr or Lidarr to look for everything that is still missing. It is off until you turn it on, never runs while HyperProx is locked, and the panel shows when it last ran and how many it searched.
  - Technical: Sonarr `MissingEpisodeSearch`, Radarr `MissingMoviesSearch`, Lidarr `MissingAlbumSearch`, claimed for the calendar week (local time) before it starts, then the command is read back; audited as `arrstack.giveup.weekly-search`. A week whose moment was missed (HyperProx down) runs once when it is back.
- You choose how many weeks to keep trying, for each of TV, films and music, from 1 to 104: "give up after so many weeks of weekly searches with nothing found". Something is only given up once it has been missing that many weeks and has been searched at least that many times, so nothing new is dropped early. Searches by any other backfill job count too.
  - Technical: the rule is `weeks` (default 8); rows saved with the earlier tries-and-days settings come back switched off, to be previewed again. Weeks count from the later of the release date and when HyperProx first saw it missing; at most one try is counted per calendar week; the search made before tracking began is not a try. A film's release date follows its minimum availability in Radarr.
- Switching the weekly search on asks you to confirm first, saying how many items it will ask your indexers for at once and when the first search runs. Every schedule time on the panel is the server's time, and says so.
  - Technical: the week and day claims are compare-and-set in the database (`claimSetting`), so two ticks or processes start one search; the lock is re-checked just before the command is sent.
- The Arr Stack can now stop chasing things that never arrive. Sonarr, Radarr and Lidarr do not count how often they have searched, so HyperProx counts for them, and you can set, for TV, films and music separately, when to give up. It is off until you turn it on, and turning it on first shows exactly what it would give up on today, with why each one keeps failing.
  - Technical: `lib/arr-giveup` (logic, releases, service, store, production), routes in `routes/arr-giveup.ts` under `/api/plugins/arrstack/give-up`, new tables `ArrGiveUpItem` and `ArrGiveUpSetting` (migration `20261118120000_arr_give_up`, additive), timer step `arr-give-up` in `lib/services/bootstrap.ts`. A try is the item's `lastSearchTime` moving on while it still has no file; history adds grabs, failed downloads and failed imports.
- Giving up means it is no longer searched for, and everything is kept. For films and albums you can choose to remove them from the library instead; no file is ever deleted, and an exclusion stops your lists adding them back. Items that have a file, or are downloading, are never touched, and quality profiles are never changed.
  - Technical: unmonitor through `episode/monitor`, `movie/editor` and `album/monitor`; removal with `deleteFiles=false` and the import-list exclusion, after re-reading that there is no file. Every change is read back. At most 250 items per app a day.
- Giving up is checked once a day. Each run is in the audit log, and you get one short notification when something is given up.
  - Technical: notification type `arr.gaveup` in the media family; audit actions `arrstack.giveup.*`.
- A Given up list shows each item with its tries, how long it has been missing, the reason and what was done, with Try again: it searches again, or adds a removed film or album back with the same profile and folder. A whole old season that is missing shows as one line.
- See what's available: on any missing or given-up item, an admin can run one search and see every release found, best first, with its quality, source, codec, size, seeders or age, indexer, language, and in plain English why it was turned down. Download this grabs that exact release even when it was turned down, and the confirm says when it is below your quality profile. HyperProx then checks the download reached the queue.
  - Technical: one interactive search per item at most every ten minutes (the last answer is reused in between), six new searches a minute per person, admin only and refused to API tokens. The grab sends only the release's guid and indexer; the queue is filtered by HyperProx, never by the query.
- AV1, 3D and 48 fps releases are never offered, torrents with no seeders are hidden unless you ask, and a release with a program file in its name cannot be downloaded. If a downloaded torrent turns out to contain a program file, HyperProx removes it and blocklists it; when its files could not be checked, it says so.
  - Technical: qBittorrent's file list is read when the download appears, then again after 1, 3 and 10 minutes while it has none; a program file is judged by the final extension of each file's own name.
- The Missing panel now shows missing and given-up counts side by side.

## 2026-11-16 — A locked-down forward proxy: 3proxy

### New
- **3proxy in the Catalogue: a forward proxy for the devices on your network, speaking HTTP and SOCKS5.** It is locked down from the start: every request needs a user and password, only the networks you pick may use it (your own network by default), it listens only on its own address on your network, and it cannot be used to reach your other services unless you allow that. It can never reach itself. HyperProx refuses to install it on a public address.
  - Technical: recipe in `lib/fwdproxy/recipes.ts` (category `forward-proxy`, `setup: 'fwdproxy'`); the install script in `lib/fwdproxy/scripts.ts` pins 3proxy 0.9.9.2 (the project's .deb, checked by SHA-256). The in-guest helper `hpx-fwdproxy` generates the config from `/etc/hyperprox/fwdproxy.env` and the user list. Allowed networks are masked by their prefix and must lie inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16, checked in HyperProx and again in the container. HTTPS tunnels only to port 443; SOCKS never to port 25; at most 256 connections at once.
- **The install proves the rules before it hands the proxy over.** It checks, from the proxy itself, that a request without a password is refused, a signed-in one works, a tunnel to another port is refused, and neither localhost nor your own network can be reached. A proxy that fails is not handed over.
  - Technical: `lib/fwdproxy/setup.ts` replaces the generic web check with `hpx-fwdproxy selftest`.
- **3proxy gets its own plug-in page, connected by itself after the install.** It shows how to set the proxy up on Windows, macOS, phones, Firefox and the command line, a shield with the rules in force and a "Prove it now" check, a live traffic trace, connections per protocol, what was refused and why, and who used it (which you can turn off; turning it off also empties the log written so far).
  - Technical: plug-in `3proxy` (`plugins/threeproxy.ts`), service `lib/fwdproxy/service.ts`, routes `routes/fwdproxy.ts` under `/api/plugins/3proxy/proxies`, an auto-connect adapter, page `components/plugins/fwdproxy`. The card and Details carry totals and refusals only.
- **Every problem on that page has a fix button: start it again, block your network again, or give a user a new password.** Users are added and removed there too; each password is made by HyperProx, kept in the vault and shown only through the vault. Adding, removing or resetting a user and changing who may use the proxy ask for your master password.
  - Technical: every `/api/plugins/3proxy/proxies` route and the plug-in's `/detail` are admin; users and settings are re-confirmed (`lib/roles.ts`). Every action is audited first; a password goes to the vault before the guest and is taken back out if the guest refuses it, but kept (and flagged for a new password) if the guest timed out.

## 2026-11-16 — Pi-hole and AdGuard Home

### New
- **Install Pi-hole or AdGuard Home from the Catalogue.** Each blocks ads and trackers for every device on your network, and each is installed finished: the admin password is made for you and kept in the vault, the block lists are loaded, and DNS answers only on the container's own address. Nothing else on your network is changed. The result page tells you how to point your network at it (your router's DHCP DNS setting).
  - Technical: the `pihole` recipe runs the official image `pihole/pihole:2026.10.1` pinned by tag and digest (password as a Compose secret via `WEBPASSWORD_FILE`, ports published on the container's LAN address only, upstreams set through its API so they stay changeable); the `adguard-home` recipe runs the `v0.107.79` release tarball checked against the project's SHA-256 as a systemd service, with its first run on loopback only. New Catalogue category `network` and recipe field `pointNetwork`.
- **Give the blocker's web page a name and a certificate, or leave it on your network only.** The install wizard offers the same DNS record, proxy host and certificate the Websites wizard makes, checked first and shown exactly before anything is created. DNS itself is never published.
  - Technical: the wizard's publish plan is now allowed for the `network` category as well as `web` (`previewInstall` in `lib/catalogue-installer.ts`); the new `PublishBlock` step reuses `/api/sites/address` and `/api/sites/address/options`. Auto-connect always uses the container's own address, never the public name.
- **A Pi-hole plug-in and an AdGuard Home plug-in.** Each shows the queries so far and the share blocked, a 24-hour chart, the domains blocked most, the devices that ask most, whether its upstream DNS servers answer and how fast, how old the block lists are, and whether blocking is on. They connect by themselves to every blocker HyperProx finds, with the password from the vault.
  - Technical: `lib/dns-blocker` (one reading shape for both products, `plugins/dns-blocker.ts`, routes under `/api/plugins/pihole` and `/api/plugins/adguard`), auto-connect adapters `pihole` and `adguard`, and service-scan probes for both. A password-only vault login kind (`password`) was added for Pi-hole.
- **Every problem the blocker pages show has a fix button.** Turn blocking back on, pause it for 5, 30 or 60 minutes, update the block lists now, switch the upstream DNS servers when one stops answering (to the ones that still answer, or to Cloudflare, Quad9 or Google), allow a domain you trust, or restart the blocker. Each one says what it will do first, and HyperProx reads the blocker again afterwards and says it worked only when the blocker agrees.
  - Technical: operator for pause, resume and list updates (`POST .../actions`); admin with the master password for restart, allow, switch upstream and guest DNS (`POST .../secure-actions`; API tokens are refused); allowing a domain needs the typed phrase. Every attempt, refused or not, writes an audit row with no secret in it.
- **Per-device numbers can be hidden.** The blocker page has a setting that stops HyperProx from even asking for which device made which query, and viewers never see them.
- **Use a blocker for the guests HyperProx installs.** One button puts the blocker first in the DNS list HyperProx gives new guests (Settings, Naming), with the old servers behind it. Guests that already exist, and every other machine on your network, are not touched, and one click undoes it.
  - Technical: reads and saves the Catalogue naming settings (`dns`, at most three servers) and keeps the previous list on the instance for the undo.

### Improved
- The plug-in wish list no longer asks for Pi-hole and AdGuard Home: they are real plug-ins now.

## 2026-11-16 — NGINX, Caddy and Envoy

### New
- Install NGINX, Caddy or Envoy from the Catalogue: a pinned version from each project's own source, with its admin page reachable only from inside its container.
  - Technical: recipes in `lib/webproxy/recipes.ts` (NGINX 1.31.8 mainline from nginx.org, Caddy 2.11.7 from its apt repository, Envoy 1.40.2 release binary with its SHA-256); repository keys checked by fingerprint; Caddy and Envoy found by their `Server` header, NGINX by its health answer.
- An NGINX or Caddy you install from the Catalogue appears on the Proxy page by itself, ready to publish apps through.
  - Technical: `registersProxy` on a recipe; the installer generates `HPX_PROXY_SECRET` and calls `registerManagedProxy` (`lib/proxy`).
- Managed Caddy and HAProxy proxies now follow the leave-alone rule like everything else: HyperProx does not reach into a container tagged to be left alone or on Remote access's "never look inside" list, and does nothing at all when it cannot read those lists.
  - Technical: `productionGuestExec` runs through `productionRemoteExecutor().run`, which refuses an excluded guest and fails closed when Proxmox (live tags) or Postgres (the exclusion list) cannot be read.
- The Proxy page can drive NGINX: HyperProx keeps its hosts in a file of its own and checks every change with nginx -t before NGINX reloads.
  - Technical: `lib/proxy/providers/nginx.ts`, managed only; a refused change is put back as it was.
- New NGINX, Caddy and Envoy plug-ins: routes, upstreams and their reach, certificates, traffic and errors, with a fix button on every problem they can fix.
  - Technical: `lib/webproxy` (one service, auto-connect adapters for all three), routes under `/api/plugins/{nginx,caddy,envoy}`; actions are admin, confirmed, offered only by a fresh reading, and audited; API tokens are refused for connecting, actions and disconnecting; a fresh read and the found list are admin-only.

## 2026-11-16 — The assistant answers cluster questions

### Fixed
- **The assistant answers "what's on my cluster" with your actual guests and apps, and no longer gives up on slower plug-ins.** Ask "what's running", "what do I have" or "list my containers" (on any cluster) and you get each node's guests, whether they are running and whether HA looks after them (admins also see what each runs and its address), with stopped guests and templates grouped at the end. "How is everything" now leads with what needs attention, says each area once, gives one cluster health that never contradicts itself (a warning you accepted is called a known warning), and reports every backup job's latest run, not just the newest. A slow NAS or Nextcloud is answered from its last reading with the time it was taken; if its newest read failed, it says since when and why, and that counts as needing attention.
  - Technical: `lib/ai/inventory.ts` (intent + deterministic text) and `lib/ai/inventory-hints.ts` (admins only, via `hintsForRole`: below admin nothing is read; the Homepage inventory from its cache via `peekInventory()` / `homeInventory()`, Websites; no new scans; no address for excluded or `hyperprox-ignore` guests, checked against fresh tags); `lib/ai/rollcall.ts` and `lib/ai/health.ts` (`clusterHealth`, shared by the cluster line, `statusSummary` and the roll-call; a Ceph check is known only when it is a HEALTH_WARN check in the Updates policy's `ceph.accepted_warnings` or muted in Ceph; HEALTH_ERR never is). `loadWithin` in `lib/ai/ask.ts` gives each source a budget (4 s default) and answers a slow one from its last good reading (per role, cluster and source, at most 6 h old; `lib/ai/reading-cache.ts`, cleared on lock and when a cluster, NAS, backup server or Nextcloud is removed) while the read finishes in the background, and joins a read already in flight; failures use `plainReason`; an area with unread parts counts as needing attention. `gatherBackups` groups vzdump tasks into runs, splits runs by job within a start window and matches each to its `/cluster/backup` job by guest selection, storage and mode read from the log header (lock preamble allowed; same-key jobs by time of day), and reads the latest run of every job (8-day window); without the job list it falls back to the newest run. QNAP (`QnapService.peek` / `lastFailure`, held logins respected) and Nextcloud (`/readings/cached`, `NextcloudService.peek` / `lastFailure`, one read in flight per instance) serve kept readings with their time. The internal "Attached:" index is gone from answers; `/api/ai/wizard/plan` returns `sources`, shown behind a "Sources used" disclosure. Sources can opt out of the roll-call (`overview: false`: per-guest placement, hardware scan, site metrics, Plex clear-out, home monitoring).

## 2026-11-16 — HAProxy and proxy load balancing

### New
- **Install HAProxy from the Catalogue.** One exact release from the 3.4 long-term support line, from HAProxy's own repository and checked before it is installed, with a hardened starting configuration. When it finishes it is already on the Proxy page, its plug-in is connected and Prometheus is reading its metrics. Nothing on your network can change it: its controls listen inside its own container only.
  - Technical: recipe `haproxy` (`lib/haproxy/recipe.ts`): `haproxy=3.4.7-1~bpo13+1` from haproxy.debian.net trixie-backports-3.4 (keyring SHA-256 pinned, apt pinned to `3.4.*`), Data Plane API 3.4.6 `.deb` (SHA-256 per arch) on 127.0.0.1:5555 with a SHA-512 crypt password, Runtime API on `/run/haproxy/admin.sock`, stats on 127.0.0.1:8404, Prometheus exporter on :8405 `/metrics` allowed to HyperProx's own addresses only. Setup steps (`lib/haproxy/setup.ts`) register a Managed Proxy instance, connect the plug-in and write `config/prometheus/targets/haproxy.json` (new `haproxy` scrape job).
- **A HAProxy plug-in built around proxy load balancing.** It draws every frontend, backend and server with its live state, weights, sessions, request rate, errors, health check and response time, and every problem it finds has a fix button: a server that is down, a backend with no healthy server left, a configuration that fails its check.
  - Technical: `lib/haproxy` (Runtime API reader and command allow-list, reading model, service, auto-connect adapter), `routes/haproxy.ts` (admin only, every action audited first; API tokens are refused for actions, load-balance and disconnect in `tokenForbidden`), `plugins/haproxy.ts`, page `components/plugins/haproxy`. The gallery card reads each HAProxy at most every 20 s. The metrics allow-list (`hyperprox-scrapers.lst`) follows HyperProx's own addresses: checked on every auto-connect pass and targets sync, rewritten and reloaded only when it differs. A failed publish removes the proxy host and DNS record it made. The service scan and the Catalogue's detection know HAProxy too.
- **Drain, maintenance, weights, health checks, servers and the balance algorithm in a click.** Each change says whether it lasts only until HAProxy restarts or is saved to its configuration, and a saved change is checked before HAProxy reloads, so a bad one is never applied.
  - Technical: runtime changes go to the Runtime API; saved ones are one Data Plane transaction through `HaproxyProvider.configChange`, validated with `haproxy -c` (`only_validate`) before commit and rolled back if the reload fails.
- **Proxy load balancing.** Spread the traffic for one app across several guests: pick two or more guests running the same app and HyperProx puts them behind HAProxy with health checks, by host name if you give one, and can publish that name with a DNS record, a proxy host and a certificate as well. The Load balancing page is a different thing: it moves guests between nodes.
- **Set up proxy load balancing while you install HAProxy.** The install has an optional step with the same form: the guests, the port, a health check page, how to spread visitors (each explained) and, if you like, a web address. The install only counts as finished once HAProxy shows every server and at least one of them healthy, and the web address, if you gave one, is published. Leave it off and the install is exactly as before. Guests HyperProx leaves alone cannot be picked.
  - Technical: the plug-in's checks and its publish are shared functions (`parseLoadBalance` and `pickLoadBalanceServers` in `lib/haproxy/service.ts`, `planLoadBalancePublish` in `lib/haproxy/publish.ts`), so the button and the install cannot disagree. The wizard takes an optional `balance` object in `POST /api/catalogue/wizard/preview`; the preview checks it (guests, leave-alone rule, port, health check path, method, public name, a fixed address when publishing) and holds it in the plan, apply checks it again, and `lib/haproxy/install-balance.ts` runs the `haproxy-balance` step through `HaproxyService.loadBalance`, then reads the backend back (every expected server present, at least one `up`, up to 20 tries 3 s apart) and waits for a publish job to finish.

## 2026-11-16 — Plex Media Server in the Catalogue

### New
- You can now install your own Plex Media Server from the Catalogue. It comes from Plex's official repository, in its own container, on the node you pick.
  - Technical: a fifth entry on the transcode stack (`lib/transcode/recipes.ts`, `lib/transcode/plex.ts`), a package install rather than Docker; build `1.43.5.11079-b3b13e506`, with Plex's signing key and the fallback package pinned by SHA-256.
- Sign in with Plex in the wizard and the new server is claimed to your account for you, so there is nothing to do in Plex afterwards. Your Plex sign-in is only held by HyperProx, in memory, while the install runs. The server's own token, which Plex may make the same as your account's, is kept in the vault.
  - Technical: `POST /api/plugins/plex/signin` takes `claim: true`; `PlexSignin` (`lib/plex-signin.ts`) keeps the account token in memory for 25 minutes at most, asks plex.tv for a claim code at install time, and drops the sign-in on use, expiry, a lock or the end of the install. `lib/plex-signin-shared.ts` is the one shared service.
- The Plex page in HyperProx connects to the new server by itself, with its token kept in the vault, so Now streaming, Clear-out and Library work straight away.
- If the node has Intel or AMD graphics, or an NVIDIA card whose driver HyperProx can match exactly, the container gets it and hardware transcoding is switched on (Plex uses it for accounts with a Plex Pass). Your library folder can be a new disk, a NAS or a folder on the node, and a Movies and a TV Shows library are added for you when those folders exist.
  - Technical: reuses the transcoders' hardware probe, pinned NVIDIA installer checksums and the Arr Stack's storage layout, `shared=1` is never set on the library mount; a read-only library is accepted because Plex only reads.

### Improved
- Finding an existing Plex server on your network now also works through a proxy host.
  - Technical: `DETECT.plex` fingerprints `/identity` (JSON or XML).

## 2026-11-16 — Proxy hosts live on their cards

### Improved
- **The Proxy page no longer has a separate host table; every host card now does the work.** Each card shows its provider, whether it is live or off, its certificate and the days left, and any extra domains, and admins can edit, turn on or off, or delete a host right on the card. Hosts that are off still appear, and the list is no longer cut off after 24 cards.
  - Technical: `components/proxy/HostCard.tsx` replaces the page's `HostTile`, `HostRow` and the collapsible table; the page still sends the same preview request (`hostActionRequest`) and opens the same editor, and the search and filters above the cards are unchanged.

## 2026-11-16 — The dashboard GPU card shows where each GPU is

### Improved
- **The dashboard's GPU card now says which server each graphics card is in, and which guests use it.** The big card names the server next to the card's name, and every other GPU is listed with its server first.
  - Technical: `/api/gpu/all/metrics-status` and `/api/gpu/:node/metrics-status` add `guests` (from each guest's config, via `configGpuKind`, cached 60 s) and `live` to every GPU; `lib/gpu-live.ts`; card in `components/dashboard/GpuCard.tsx`.
- **Built-in graphics now show live figures, not just "monitored".** Intel shows how busy it is, the 3D, video (encode and decode) and enhance engines, the clock speed and the power draw. AMD shows how busy it is, video memory, shared memory, and the temperature. A figure that is not reported shows a dash, and hovering it says why.
  - Technical: Intel from the `igpu_*` series, AMD from `node_drm_*` and the amdgpu hwmon chip, read through `gpuFigures` plus `readGpuLive`; series are tied to a Proxmox node by their `node` label, or by `instance` through the cluster address list. The card re-reads every 15 seconds.

## 2026-11-16 — Removed guests are cleaned up, and plug-ins can be disconnected

### New
- **HyperProx notices when a container or VM is removed from Proxmox, and offers one Clean up.** Before, a plug-in stayed connected to a guest that no longer existed (a Homepage panel waiting to be filled, for example), and nothing said why. Now the dashboard, the Plug-ins page and the affected plug-in's page say which guest went, when, and exactly what HyperProx still keeps for it.
  - Technical: `lib/removed-guests` (detector, holdings, service, production), started from `lib/services/bootstrap.ts`. One `/cluster/resources` read every five minutes while unlocked; the task log is read only when a watched guest is missing. Routes: `GET /api/removed-guests`, `POST /api/removed-guests/look`, `POST /api/removed-guests/:vmid/clean-up` (admin; clean-up re-confirmed, never an API token).
- **A guest only counts as removed when it is really gone.** A failed read of the cluster, a node that is down, a guest being migrated or restored, or a short absence never counts: it must be missing from every node on three good reads over at least ten minutes, and Proxmox must answer that its config does not exist. If several guests vanish at once, HyperProx asks Proxmox about each one: those Proxmox says are gone are counted the usual way, so a real bulk delete is still found. Any it will not answer for are treated as not removed, and one alert names them ("HyperProx can't see N guests it saw before") so you can check its Proxmox token's permissions.
  - Technical: a read where more than 3 seen guests, or two or more and over a fifth of them, are newly missing at once does not count for them, unless a config probe on every node proves a guest gone; proven ones leave the test and are counted normally (event `removed_guests.cannot_see`, naming only the unproven ones, kept while any remain). A guest decided removed is confirmed by reading its config on every node; only "does not exist" everywhere confirms it, a 403 or error does not.
- **Clean up checks the cluster again right before it acts.** If the cluster cannot be read, a node is down or Proxmox does not confirm the guest is gone, nothing is changed. If the guest is back under its own name, there is nothing to clean up. If another guest has taken its ID, only the old guest's own records are removed, never anything that now belongs to the new one.
  - Technical: `lib/removed-guests/detector.ts`. A read counts only when every node is online; migrations, relocations, clones and restores running or ended in the last 15 minutes reset the count, and an unreadable task log holds every count.
- **Clean up removes what HyperProx kept for the guest:** a connected Homepage or Nextcloud, its Catalogue install record and the login it made, its Sites entry, saved addresses and keys pointing at it, its VPN entries, a scheduled balancing move, and auto-connect's memory of it. Its vault items go with them.
  - Technical: `lib/removed-guests/holdings.ts`. Addresses are matched only when the guest itself was seen at them, against a service scan newer than the removal and the newest create or restore task (Clean up takes a fresh one), and never when a current guest is seen at that address or has it in its config; pinned SSH host keys are never forgotten; records made after the removal, and anything keyed by the ID once another guest has it, are left alone. New: `HomepageService.forgetRemoved`, `NextcloudService.forgetRemoved`, `Reconciler.forget`, `forgetInstallRecord`, `WireguardService.forgetMachine`, `ServiceScanCache.peek`.
- **A backup job that still names a removed guest is fixed by taking out only that ID.** Proxmox reports the whole job as failed on every node when one listed guest is gone; Clean up shows each job's guest list before and after, and changes nothing else. A job that would back up nothing is only deleted if you tick it.
  - Technical: written with `PUT /cluster/backup/{id}` (new `vmid` list, read back); HA resources still naming the guest are removed with `purge=1`.
- **A new alert: "A backup job names a guest that no longer exists",** sent once to your notification channels for any guest, including ones HyperProx never knew about, and cleared when the job no longer lists it. Its link opens the dashboard's Clean up.
  - Technical: event `backup.job.dead_guest`, fingerprint per ID, resolved after the clean-up.
- **The proxy host and DNS name an install made are listed separately, unticked.** Leave them to keep the name for a new install, or tick to remove them. HyperProx only offers names its own install recorded making, never ones it guessed from an address.
- **Deleting a guest in HyperProx now cleans up after it too,** with the same choice for its proxy host and DNS name.
  - Technical: `forget` hook on `destroy()` in `lib/clusters/guest-actions.ts`, wired for the cluster page, the assistant and a website's container (home cluster only; a website's own record and names stay with the site delete).
- **Every plug-in set up in its settings now has Disconnect.** It forgets the settings and keys, the plug-in shows as not set up and leaves the dashboard, and auto-connect does not add it straight back. Plug-ins with their own list of devices point to their page, where each one has Remove.
  - Technical: `DELETE /api/plugins/:id/settings` (admin, re-confirmed, never an API token), `lib/plugin-disconnect.ts`. Auto-connect dismissals are recorded before the vault item is deleted. A plug-in that is not set up is no longer listed in the metrics scrape (it used to report as down).

## 2026-11-16 — Internal tidy-up

### Improved
- Internal tidy-up; nothing changes in how HyperProx works.
  - Technical: shared helpers replace per-feature copies: `lib/guest-id.ts` (machine ids, HA service ids, guest paths), `listGuests()` in `lib/pve/guests.ts`, `runningBackups()` in `lib/pve/tasks.ts`, `shq()` / `shqStrict()` in `lib/shell.ts`, `nodeExec()` in `lib/node-exec.ts` and `sightingsOf()` in `lib/catalogue/sightings.ts`. Each feature keeps its own policy for an answer it cannot read; those policies are pinned by new tests.
  - Technical: every route takes who asked from `lib/http/request-actor.ts` (`actorOf`, `contextActor`, `isAdmin`), and every audit row records it through `auditBy`, which adds `tokenName` (never the token itself) whenever an API token acted; the audit writer's secret scrub keeps that one field. Route refusals go through `sendRefusal` / `answerData` (`lib/failure.ts`, `lib/http/answer.ts`), and every JSON failure, 4xx or 5xx, gains `ok: false`, `success: false`, a `code` and the `requestId` (so pages can show a reference on 4xx answers too); `error` is filled from `message` where a body had only that. Existing words, statuses and extra fields are unchanged. Load-balancing audit rows now name the token in `tokenName` (it was `token`, which the audit scrub had been dropping).
  - Technical: background work is built and started in one place, `lib/services/bootstrap.ts`, before the routes are registered: Remote access's exclusion list and the compose owners first, then Nextcloud's resume, Homepage's auto-sync, auto-connect, and on ready the Updates recovery, scheduler and daily check (`lib/updates/runtime.ts`) and the load-balancing scheduler (`lib/placement/production.ts`). Routes only resolve these services, so a route that is skipped or registered twice no longer changes what runs. Homepage and Nextcloud reach auto-connect's dismissal record through a port the composition root sets, which ends an import cycle; a test now fails on any cycle among those three. Nextcloud reads the home cluster by name, as it is home-only.

## 2026-11-16 — Leave-alone rules apply everywhere

### Fixed
- **A guest you told HyperProx to leave alone is now left alone by certificate deployments and plug-in updates too.** Before, those could still reach into it. Now they stop and say why on the item that was refused, and nothing is run inside the guest.
  - Technical: the tag is read live from Proxmox in `guestExec` (`lib/updates/executor.ts`), the one door certificate deploys (`lib/certs/deploy.ts`) and plug-in app steps (`lib/updates/apps.ts`) use, through the shared `liveGuestTags` / `guestLeftAloneReason` in `lib/guest-guard.ts`; a refusal is a `GuestExcludedRefusal` that the deploy records as the target's plain reason. The remote executor uses the same helper.
- **Visitor numbers are no longer collected from a guest you told HyperProx to leave alone.** The site says so, in plain words, instead of silently reading its logs. If HyperProx cannot tell whether to leave the guest alone, it does not collect either.
  - Technical: `lib/site-metrics/collector.ts` asks `leftAlone` (live tag plus the exclusion list, fail closed) before the log pull and WP-CLI, and `realRun` asks again; the reason is stored as the site's last error. The public address check does not enter the guest and still runs.
- **The GPU checks no longer look inside a guest you told HyperProx to leave alone.** The once-a-minute watch skips it quietly; asking for its GPU detail is refused with the reason.
  - Technical: `lib/guest-config/gpu-watch.ts` skips with a note in `seen` and no event; `GuestConfigService.gpuDetail` throws `GuestExcludedRefusal` (409) or `ExclusionsUnknownRefusal` (503) for a running container, and the post-restart device check is skipped for such a guest.
- **If HyperProx cannot read the list of guests to leave alone, the Updates page now says so at the top, and the daily check reports it, instead of looking like there is nothing to update.** The daily check counts as incomplete and sends a warning message of its own.
  - Technical: `UpdatesInventory.notice` and `UpdatesCheckCluster.notice` (both type copies); the per-guest `exclusions-unknown` row reason stays so no guest is read; the check logs at warn, sets the cluster result to partial and notifies even when no update is found.
- **Compose projects that the Nextcloud page manages are now also protected when they are listed by folder in the Updates policy.** An entry that knows its project name but not its folder now covers the whole guest.
  - Technical: `composeOwnerRefusal` in `lib/compose-owners.ts`.
- **A tag that only contains the leave-alone tag in its name (for example one with an extra letter on the end) no longer counts as that tag when one-click setup scans a remote server.**
  - Technical: `IGNORED_TAG` in `lib/clusters/send-simple.ts` now matches a whole entry of the `tags:` line.

### Improved
- **Checking whether a guest should be left alone is faster when many guests are checked at once.** Changes to the list in Remote access take effect immediately.
  - Technical: live tags are reused for 5 s per Proxmox client and the exclusion list for 5 s per process (`GUARD_CACHE_MS`); `setGuestExclusionSource` and `RemoteAccessService.setExclusions` call `invalidateGuardCache()`.

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
- **Updates now respects Remote access's "never look inside" list too.** A guest on that list is shown on the Updates page as excluded, is never read or updated, and is left out of "Update everything". If the list cannot be read, Updates leaves every guest alone until it can; nodes are still updated.
  - Technical: `lib/updates/look-inside.ts`; the home executor's `lookInsideExclusions` and `guestExec` refuse a listed guest (`GuestExcludedRefusal`, `ExclusionsUnknownRefusal`); new unmanaged reasons `remote-excluded` and `exclusions-unknown` in the inventory, tree and plan; the runner reads the list again before each guest, and the daily check skips listed guests. Remote clusters are unchanged.
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
