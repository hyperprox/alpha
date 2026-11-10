# Updates

HyperProx can bring a whole Proxmox cluster up to date — nodes, containers, VMs and,
where you allow it, Docker images and apps installed some other way (npm, for one) —
one step at a time, and stop the moment something
is not right. This page is for the operator: what a run does, the policy file, and
what happens when something fails. The design behind it is in
`docs/superpowers/specs/2026-10-06-updates-design.md`.

It works on every cluster HyperProx manages: the home cluster at **Updates**, and each remote server or
cluster at **Updates** on its own page (`/clusters/<id>/updates`, also linked from its Command center
panel). How a remote differs is in [Remote clusters](#remote-clusters) below. A read-only
[daily check](#the-daily-check) looks at every cluster and tells you when something new needs updating.

Everything about Updates is admin-only, reads included: the inventory lists every
pending package and kernel pin on every host. Live progress goes over its own socket,
`/ws/updates`, which only admins can open (the general `/ws` channel is viewer-level, and
these frames carry command output from hosts); a lock closes it. Every job start,
confirmation, resume, cancel and node reboot is written to the audit log.

## Getting started

1. Copy `config/updates.example.yaml` to `config/updates.yaml` and edit it. The file is
   git-ignored. Its location can be changed with `UPDATES_POLICY_PATH`.
2. Open the Updates page and run a **dry run**. It reads what is pending and builds the
   plan; it executes nothing, not even `apt update`.
3. Do a real run with the schedule still off, on a day you are watching.
4. Only then set `schedule.enabled: true`.

Without a policy file the page still shows what is pending and dry runs work, but a real
run is refused. This is deliberate: the built-in defaults are the **safe** ones —
nodes get `apt-get upgrade` and are never rebooted, guests are never rebooted, and no
Docker image is pulled. (The design's example file uses `dist-upgrade` and
`reboot: auto` for nodes; you get those only by writing them into your policy.)

## What a run does

1. **Preflight** (read-only). The cluster is quorate and every node is online and readable;
   every node the policy names exists (a typo would otherwise fall back to
   `nodes.default`); whether the cluster runs Ceph is decided once, from
   `/etc/pve/ceph.conf`, and if it does, Ceph health raises nothing outside
   `ceph.accepted_warnings` — a health read that fails is a failure, never "no Ceph"; HA is settled and no node is in
   maintenance; every node's `/` has at least `min_root_free_mb` free; every node that
   requires package holds or a kernel pin has them. Any failure ends the job before
   anything changes.
2. **Refresh**. `apt update` on every node (through the Proxmox API) and inside every
   managed guest, then the inventory is read again and the plan is built. A **manual**
   run stops here at *awaiting confirmation* so you can read the plan; a **scheduled**
   run carries on.
3. **Guests**, `batch_size` at a time. For each: a snapshot where possible (containers
   with bind-mounted storage cannot be snapshotted; the step says so) →
   `apt-get upgrade` keeping your config files, then `autoremove` → for `docker: auto`,
   `docker compose pull` and `up -d`, then every container running and not unhealthy →
   approved app config changes, then app updates (see [Apps](#apps-installed-outside-apt-and-docker)) →
   the configured `check` URL, fetched from inside the guest → for VMs with
   `reboot: if-required`, a reboot when the guest asks for one. When a guest finishes
   cleanly, its older `hp-upd-*` snapshots are deleted and the newest is kept; snapshots
   with any other name are never touched, and a guest that failed keeps all of them. HA-managed guests are
   stopped and started only through `ha-manager`, never `qm`/`pct`.
4. **Ceph**, only when Ceph packages are pending. The same version is installed on every
   node that has it pending (exact `package=version`, and apt is not allowed to remove
   anything), then daemons restart node by node — all monitors, then all managers, then
   OSDs — and Ceph must be back to the accepted health before the next. Monitors are
   asked `ceph mon ok-to-stop` first. OSDs are restarted **one at a time**, never through
   `ceph-osd.target`, with `noout` set around them and a health gate after each (every
   PG active+clean, or no worse than before the step). See *Ceph restart and reboot
   safety* below. If nodes would install different Ceph versions, neither the Ceph nor
   the node phase is planned.
5. **Nodes, one at a time**, gates checked before each. `apt-get upgrade` or
   `apt-get dist-upgrade` as the node's policy says → Proxmox services active → holds and
   pin checked again. If a reboot is needed and the policy says `reboot: auto`: wait for
   viewers (below), check quorum, Ceph and HA again (the wait can be hours), run the
   Ceph safety check below for every OSD on the node, set `noout`,
   turn on HA maintenance for the node, wait for HA to move its guests, reboot, and wait
   up to 15 minutes for the node to be online **with a new boot id**, every OSD up and
   every PG active+clean, then maintenance off and `noout` cleared. With `reboot: manual`
   the node is marked *reboot pending*. Then old kernels are removed — the running one, a
   pinned one and one fallback are always kept — and the apt cache is cleaned.
6. **HyperProx itself, last.** Upgrading the container HyperProx runs in, and rebooting
   the node under it, would kill the API mid-step. Both run as a detached script on a node
   (the container's own node for the upgrade, another node for the reboot) that writes
   its result to `/var/lib/hyperprox-updates/`; HyperProx reads it when it is back.
   HyperProx's own container is `self.vmid`, or else the one container whose name matches
   this host's hostname. Its own images are updated by deploying HyperProx, not by a run.
7. **Report**: what changed, what was skipped and why, and which reboots are pending —
   in the job history, and as one notification (`updates.job.finished`; `updates.job.paused` when a
   run pauses) to the channels under Settings → Notifications that take Updates events.

One job runs at a time, enforced in the database, across all clusters: a job on a remote and a job at
home never run together. Asking for another while one is running, awaiting confirmation or paused
answers `409` with the id of the active job, and names its cluster when it is another one.

## Remote clusters

A remote server or cluster (added in the Command center) is updated from its own Updates page, which is
amber, with REMOTE and its name on every card, on the plan and in every confirmation. Every request from
that page carries the cluster, and HyperProx keeps a separate runner, policy, inventory and job list for
each cluster, so what you read and what you change are always the same machine. A job planned for one
cluster does not exist for any other: confirming, resuming, cancelling or rolling it back through another
cluster answers "No job". A job is also tied to how HyperProx reached the cluster when it was planned
(its address, certificate and token, kept only as a one-way key); if any of those changed since, the job
is refused and you start a new one.

**What is the same as at home.** Preflight (free space, required holds and kernel pin, Ceph health when
Ceph runs there), `apt update`, the plan, a manual run stopping at *awaiting confirmation*, guests first
with a snapshot where possible, then nodes one at a time, the report and the notifications (which name
the remote and link to its page).

**What is different, and why.**

- **The preview is apt's own simulation.** For each node the inventory runs `apt-get -s` (simulate:
  nothing is installed and no lock is taken) for exactly the upgrade a run would do, and shows the
  packages with their versions, anything that would be **removed**, whether a **kernel**, **firmware**
  or **core Proxmox VE** package changes, which packages are **held** (shown as held, never offered),
  and whether a **reboot will be needed** afterwards. Security fixes are marked. Guests are read the same
  way as at home.
- **Nodes get `apt-get dist-upgrade` by default.** That is the upgrade Proxmox recommends for a Proxmox VE
  node (`apt full-upgrade`). apt never installs or removes a held package this way, and a kernel pin
  (`proxmox-boot-tool kernel pin`) stays: a new kernel is installed but the pinned one keeps booting.
  HyperProx never runs `apt-mark unhold`, `proxmox-boot-tool kernel unpin` or
  `--allow-change-held-packages`, on any cluster. A policy section can set a node to `upgrade` and
  require holds and a pin, exactly as at home.
- **Never an automatic reboot.** A node whose upgrade needs a reboot is marked *reboot pending*. The
  **Reboot** button is a separate action: it first shows which running guests will stop (and which of
  them will not start again on their own, because they are not set to start at boot), the running kernel
  and the one that will boot, then asks for your master password. On a one-node server there is no other
  node to move guests to, so they stop until the server is back. HyperProx waits up to 15 minutes for a
  new boot id, then reports the running kernel and which guests came back; a guest set to start at boot
  that is not running fails the step. On a remote with more than one node, HyperProx does not reboot nodes
  (it has no HA support there yet): reboot by hand after moving the guests.
- **A one-node server has no quorum and no HA.** Those gates are skipped and the preflight says so in
  words ("standalone server: no quorum or HA to check (skipped)"). Every other gate runs.
- **Everything is read back.** After a node upgrade, every package is checked at the version the
  simulation promised, holds and the kernel pin are checked unchanged, and the Proxmox API must answer;
  any difference fails the step with a plain sentence ("openssl is at 3.5.1-1, expected 3.5.4-1", "no
  longer on hold: ..."). After a guest upgrade, apt is asked again what it would still upgrade; anything
  left (other than held or kept-back packages) fails the guest.
- **A guest that cannot be snapshotted** (bind-mounted storage, which is usual for a media container) is
  not updated unless you tick **Update without a snapshot** for it. The tick shows the newest backup
  HyperProx can see on that cluster (from its backup tasks, the same ones the Command center reads), and
  says whether that backup was of this guest or a job that may include it. The tick travels with the run
  like an app approval and is written to the audit log.
- **Master password for every change.** Starting a run, confirming it, resuming, rolling back and
  rebooting on a remote each need the master password re-entered within the last five minutes. An API
  token can never do that, so a token cannot change anything on a remote through Updates. A dry run,
  reading and cancelling do not ask. (At home these actions are admin-only and audited, as before.)
- **Node logins are the remote's own**, saved under **Edit server, Nodes and logins**, and used only once
  an admin has confirmed the node's host key. Each node is reached on the address saved for it, never the
  one the node reports. Every script HyperProx sends passes the remote script guard, which refuses
  anything naming the cluster filesystem, corosync or `/etc/pve` (the services check after an upgrade
  therefore leaves `pve-cluster` out, and the Proxmox API answering stands in for it).
- **Not on a remote:** scheduled runs (a run starts only when you start it), app updates from plug-ins,
  Docker pulls unless the cluster's section turns them on, the Plex viewer wait (the home Plex knows
  nothing of a remote's viewers), and the Ceph phase. If a node upgrade would change Ceph packages and
  Ceph runs on that cluster, the step refuses; on a server without Ceph, the Ceph client libraries Proxmox
  installs move with the node like any other package.

The remote's policy is its own section of the same file; see `clusters.<id or name>` below. A remote
with no section gets the built-in remote defaults described above, even with no policy file at all. A
policy file that exists but does not load stops runs on every cluster, since the broken part may be the
section meant for that remote.

## The daily check

Once a day (default 06:30, local time) and whenever you press **Check now** on the Updates page,
HyperProx checks every cluster, home and each remote, for updates. It is **read-only**: it refreshes
package lists (`apt update`, which installs nothing) on the nodes and in the guests a run would update,
and asks apt to simulate the upgrade; nothing is installed, removed, held, unheld, snapshotted or
restarted. It goes through the same path as a run (each cluster's own connection, pinned remote logins,
the script guard, each cluster's policy, so a home node set to `upgrade` is simulated with `upgrade`),
one machine at a time with a short pause between machines and between clusters.

A cluster is skipped, and the result says why, when it does not answer, while a backup task is running on
it, and while an Updates job is active anywhere. A check that falls while HyperProx is locked is skipped
and logged (the credentials are in the vault). Only one check runs at a time, and a run cannot start while
a check is reading (wait a minute or two).

The result is kept in `data/updates-check.json` (names and counts, no secrets) so the **Daily check**
card on the Updates page and the **Updates** line on each Command center panel show it without reading
any machine when the page opens. Each cluster shows when it was checked, how many machines have updates,
how many packages, how many security fixes, and anything that could not be read. Held packages are
counted as *held or kept back, not offered*, never as updates to apply.

**The message.** When a check finds something **new** since the last message (a package or version not
reported before), one `updates.available` notification goes to the channels under **Settings →
Notifications** that take Updates events. The same list is not sent again; while it stays unapplied, a
reminder goes at most every `check.reminder_days` (default 7). The message is grouped by cluster, with
"(home)" or "(remote)" after each name, security fixes first (package names only), then each node and
guest with its package count and "kernel update" or "reboot needed" where that applies, held packages as
a count, and clusters that could not be checked. It carries a link to the Updates page when
`HYPERPROX_PUBLIC_URL` is set. It never contains versions, addresses, tokens or command output, and
anything in a name that looks like an address is replaced with `[address]`. It is sent as a warning, so
a channel on the default "warnings and critical" setting receives it.

## Ceph restart and reboot safety

Before every OSD restart step and every node reboot, HyperProx reads every pool's
`size` and `min_size`, the CRUSH tree and the PG map, and asks `ceph osd ok-to-stop`
about the node's OSDs. The step does not run when:

- any OSD on the node holds placement groups of a pool with `size=1` (that share of the
  pool has no other copy and would go offline);
- any placement group would be left with fewer than `min_size` copies (its I/O would stop);
- `ceph osd ok-to-stop` does not answer with a clear yes.

Survivors are counted from each placement group's *acting* set: an OSD that is only in the
`up` set is still backfilling and holds no complete copy. Erasure-coded pools are labelled
as such, and a PG left with fewer than `k` shards counts as offline.

**Which OSDs are on the node** comes from three sources that must agree: the CRUSH tree
(the host bucket with the node's name, plus any host bucket holding an OSD that reports
this host, such as a per-device-class bucket), the `hostname` in `ceph osd metadata`, and
the `ceph-osd@` units on the node. If they disagree, if the unit listing fails, or if the
node has OSD units that name no OSD, the layout counts as unreadable. A node counts as
having no OSDs only when all three say so. The layout is also unreadable when the PG map
is not `pg_ready` or a pool has fewer PG rows than its `pg_num` (a freshly restarted
manager can serve a partial map).

Such a step is marked **skipped for safety** with what would go offline — the pool, its
share of placement groups and roughly how many GB — and the report and notification say
so instead of reporting success. A skipped reboot leaves the packages installed and the
node *reboot pending*, for a person to reboot by hand in a maintenance window. If the
layout cannot be read, the step refuses and the job pauses.

**The check is deliberately strict.** It treats every OSD on the node as down at the same
time, for an OSD restart as well as a reboot, even though OSDs are then restarted one by
one. With a CRUSH rule whose failure domain is the OSD rather than the host, a node that
could have been restarted one OSD at a time may be skipped. That is the intended trade:
a skipped restart costs a manual step, a wrong restart can cost data availability.

The same check runs when the plan is built: the plan preview and a dry run show, for each
Ceph restart and node reboot, whether it would run or be skipped for safety and why. It
runs again when the step executes, because the cluster may have changed in between, and
for a reboot once more right before `systemctl reboot`, after HA has moved the guests off.
For HyperProx's own node the handoff script runs that last check itself, against the OSD
set the API checked; a no there is a safety skip with the reboot left pending.

Between OSD restarts the health gate compares by identity, not by count: the restarted OSD
must be up and in with none of its PGs degraded or undersized, every PG must be active,
and no OSD may be down or out, and no PG at risk (`degraded`, `undersized`,
`backfill_toofull`, `recovery_toofull` and the like), that was not already so before the
step. The only OSD map flag that may appear during the step is the `noout` it set; any
other (`pause`, `nodown`…) fails it, whatever `accepted_warnings` says.

If an OSD does not come back, or its restart fails, the step stops and **`noout` is left
set**, so Ceph never marks the OSD out and starts moving data because a restart failed.
A critical notification says that `noout` is still set and why. Only a step in which every
OSD came back clears it.

Outside a step `noout` is never HyperProx's, so a `noout` found at the start of a run, on
Resume, or after HyperProx restarted mid-job was left behind (or set by hand). It is
reported by name, with a critical notification, and nothing restarts or reboots while it
is set. Listing `OSDMAP_FLAGS` in `ceph.accepted_warnings` does not hide it.

**Package scripts.** Node package upgrades and the Ceph install run with a temporary
`/usr/sbin/policy-rc.d` that refuses every start and restart of a Ceph unit, so a
package's `postinst` cannot restart OSDs behind the runner's back or start an OSD a person
stopped on purpose. Any `policy-rc.d` that was already there still decides everything else
and is put back afterwards, also when apt fails. `NEEDRESTART_SUSPEND=1` keeps needrestart
from restarting services after a library upgrade.

## The policy file

| Key | Default | Meaning |
|---|---|---|
| `schedule.enabled` | `false` | Run on the schedule. Needs a policy file that loads. |
| `schedule.cron` | `0 8 * * 3` | Five fields, local time: minute hour day month weekday. `*`, numbers, `a-b`, `*/n`, `a-b/n`, lists. No names (`WED`). |
| `schedule.window_hours` | `4` | How long a reboot may wait for viewers, counted from when the run started executing. |
| `quiet.plex_streams_block_reboots` | `true` | A reboot waits while the Plex plug-in reports active streams. Without the plug-in configured the check passes. |
| `ceph.accepted_warnings` | none | Ceph health codes that do not stop a run. |
| `nodes.default` | `{ upgrade: upgrade, reboot: manual }` | Applies to every node. |
| `nodes.<name>.upgrade` | | `upgrade` (never adds or removes packages) or `dist-upgrade`. A node set to `upgrade` cannot be given anything else. A node that sets `require_holds` or `require_pin` but not `upgrade` gets `upgrade`, never the default's `dist-upgrade`. |
| `nodes.<name>.reboot` | | `auto` or `manual`. |
| `nodes.<name>.order` | | `first` or `last`. Otherwise alphabetical. |
| `nodes.<name>.require_holds` | | Packages that must be on hold (`apt-mark showhold`). |
| `nodes.<name>.require_pin` | | The kernel `proxmox-boot-tool kernel list` must show as pinned. |
| `guests.default` | `{ apt: true, docker: none, reboot: never }` | Applies to every guest. |
| `guests.exclude` | none | VMIDs HyperProx must never touch. |
| `guests.<vmid>.apt` | | Run apt in this guest. |
| `guests.<vmid>.docker` | | `none`, `auto` (pull and restart), or `manual` (report newer images, never pull). |
| `guests.<vmid>.compose_dirs` | | Compose project directories inside the guest; `docker: auto` needs at least one. |
| `guests.<vmid>.reboot` | | `never` or `if-required`. VMs only; containers share the node's kernel. |
| `guests.<vmid>.check` | | A URL fetched from inside the guest after updating. |
| `batch_size` | `3` | Guests updated at once. |
| `min_root_free_mb` | `1024` | Preflight minimum free space on each node's `/`. |
| `self.node_order` | `last` | HyperProx's node goes last. |
| `self.vmid` | detected | HyperProx's own container. |
| `check.enabled` | `true` | Run the daily read-only check on every cluster. |
| `check.cron` | `30 6 * * *` | When, in the same five-field form as `schedule.cron`. |
| `check.reminder_days` | `7` | While the same updates stay unapplied, remind at most this often. |
| `clusters.<id or name>` | built-in remote defaults | One remote cluster's own policy, keyed by its id (`c` and ten hex digits, shown in its page address) or its exact name. Takes `nodes`, `guests`, `ceph.accepted_warnings`, `batch_size` and `min_root_free_mb` with the same meaning as above, except that a remote node accepts only `reboot: manual`. No `schedule`, `self`, `quiet`, `apps` or `notify` (unknown keys fail the load). The home cluster is the top level of the file, never a section. Nothing at the top level applies to a remote, whatever its node names. |
| `notify.webhook_url` | none | **Moved.** Read only until the first Owner sign-in of the notifications release, which turns it into the channel "Updates reports" under Settings → Notifications; ignored after that, removed from the parser in a later release. |
| `apps.enabled` | `true` | Look for apps that plug-in providers know (read-only). `false`: no app is looked for, listed or updated. |
| `apps.default` | `manual` | Mode for every app not named below: `manual` (only when approved for a run), `auto` (every run, scheduled ones included) or `off` (listed, never updated). |
| `apps.<app id>` | | Mode for one app, by its provider id, e.g. `apps.meshcentral: auto`. An id no installed plug-in provides is named in the plan's warnings. |
| `guests.<vmid>.apps` | `true` | `false`: do not look for apps in this guest. |

Unknown keys fail the load with the path of the bad key (`nodes.gpu-node.requre_pin:
unknown key`), so a typo cannot quietly switch off a safeguard. A policy that fails to
load is reported on the page and treated like no policy at all.

Not managed, and listed so their absence is visible: excluded guests, stopped guests,
Windows VMs, VMs without the QEMU guest agent, and guests without `apt`.

## Apps installed outside apt and docker

apt and docker only see what they installed. An app installed with `npm install` into a
directory and run by a systemd unit — MeshCentral is the usual example — looks current to
both while it sits a year behind, security releases included. Plug-ins can contribute an
**app-update provider** that finds such an app in a guest and updates it; the Updates
feature treats it as a third kind of update, with the same run order, snapshot, gates,
policy excludes, dry run and one-job-at-a-time lock as apt and docker. Bundled today:
**MeshCentral**.

**What the Updates page shows.** An **Apps** panel lists every install a provider found:
guest, app, installed → latest version, a red **security update** badge when the update is
one, the mode (`auto`, `manual`, `off`), and a **pre-flight** badge when something would
go wrong. *Details* shows how it is installed and run (directory, owner, systemd unit), the
release notes for every version since the installed one, any pre-flight issue with the
exact config change offered for it, and how to undo the update. An update waiting for
approval also appears in the plan's warnings, marked **SECURITY UPDATE** when it is one.

**Approving.** In the default `manual` mode an app update is planned only when you tick
*approve* for it. The approval names one install, in one guest, to one version
(`app:<vmid>:<app>:<install>@<version>`); it travels with the run you start, is written to
the audit log, and is shown in the plan (`approved`). If the version or install has changed
by the time the plan is built, it matches nothing and the plan says so. Scheduled runs carry
no approvals: they apply `auto` apps only. Dry runs take approvals too and execute nothing.

**Security flag.** An update is a security update when an advisory affects the installed
version and not the latest (npm's advisory database, and the project's GitHub security
advisories where the provider names the repository), or when the release notes in between
say so (security, vulnerability, CVE, exploit and the like). The line that decided it is
shown with the badge.

**Pre-flight and config changes.** A provider checks, read-only, what would go wrong before
anything changes. A *blocking* issue keeps the update out of the plan — even in `auto`
mode — until it is resolved. When the provider can resolve it, it offers the exact config
change, word for word, with its own approval (`fix:...`): approve that too and it runs as a
separate **App config change** step before the update, after checking the file is still the
one you approved (otherwise it refuses and asks again). It is written as the file's owner,
never as root into a directory the app's user can write, and the previous file is kept
beside it as `<name>.hp-bak-XXXXXX`. Config is never changed as a side effect of an update, and never
without that approval.

**How an npm app is updated** (the shared npm-app helper, `lib/app-updates/npm-app.ts`):

1. the guest's snapshot is taken (the guest phase's usual first step);
2. its systemd unit is **stopped**, and the step waits until it is — an app that restarts
   itself while npm is still installing crashes on the first request that needs a
   half-installed module;
3. `npm install <package>@<exact version>` runs **as the user that owns the install** and is
   waited for; the pin style in `package.json` is kept;
4. `npm ls` must resolve cleanly at that version (missing or invalid modules fail it);
5. the unit is started;
6. the provider's **verify** runs — a real functional check, not a health endpoint.

Only installs that a **system unit file** declares are updated, by their real (symlink-free)
path, with the node binary that unit's `ExecStart` names. A process alone never makes an
install updatable — any user can start one, and a cron job runs inside `cron.service` —
so one started by hand, from cron or by a user service is listed with the reason. npm
runs as the install's owner, and HyperProx refuses when that is not the user the unit runs
as. node and npm are resolved once and run by their real paths; as root, only when they and
every directory above them are root-owned and writable by nobody else. The approval id
covers the install's real path, unit, owner and node binary, so if any of them changes
before the run, the approval matches nothing.

**When it fails.** The step fails with the provider's reason and its rollback, naming the
snapshot; **nothing is rolled back on its own**, and a service that failed mid-install is
left stopped rather than started half-installed. The job pauses like any guest failure.
On the failed step, **Roll back** restores the guest to the snapshot this run took and starts
it again — only on your request, only while the job is paused, and never for an HA-managed
guest (the step says how to do it through `ha-manager`). The step is then marked rolled
back, and Resume carries on with the rest of the run without updating that guest again.
Rolling back undoes everything the run did to the guest, apt packages included.

**MeshCentral specifics.** Found by its systemd unit and process command line
(`node …/node_modules/meshcentral`), `meshcentral-data/config.json` and `package.json`.
Config keys are read case-insensitively, as MeshCentral does; `config.json` is read from
`--datapath` when the unit passes one. Its files are read as the unit's user, never through
a link. From 1.2.1 MeshCentral refuses
browser sessions whose Origin hostname is not the certificate name, the domain's `dns` or in
`allowedOrigin`; behind a reverse proxy on another hostname every sign-in then fails with
"Invalid origin in HTTP request" while `/health.ashx` still says "ok". So the pre-flight
replays that check for the public hostnames and, if one would be refused, offers
`domains[""].allowedOrigin` with the public hostnames and the certificate name (once the
list exists, MeshCentral checks only the list), keeping every entry already there. A
hostname served by a named domain (its `dns`) is judged by that domain and gets no
automatic fix. Verify then: the installed version is the
planned one; the unit is active on one pid with no npm still running behind it; the login
page loads through the **public URL**; `control.ashx` opens as a websocket with that
URL's Origin and does not answer `invalidorigin`; the service is still up on the same pid
afterwards; and `mesherrors.txt` gained nothing since the update started. The public URL is
the plug-in's `public_url` setting, or else the proxy hosts HyperProx manages that forward to
the guest's MeshCentral port (matched against the addresses the guest reports for itself, so
set `public_url` where that matters). The page check follows redirects on the same host only.

## When something fails

| What | What HyperProx does |
|---|---|
| Preflight fails | The job fails. Nothing was changed. |
| A gate fails between steps (quorum, Ceph, HA) | The job **pauses** with the reason. Nothing runs until you press Resume; a health failure is never retried on its own. |
| A guest fails (apt, unhealthy container, failed check) | That guest's remaining steps are skipped and the step names its snapshot. Other guests carry on. The Ceph and node phases do not start: the job pauses. Resume retries the failed guest. |
| A node upgrade fails, or holds/pin are missing before or after it | The job pauses. Holds and pins are never repaired automatically. |
| Viewers are watching when a reboot is due | Re-checked every 5 minutes until `window_hours`; then that reboot is skipped, the node is marked *reboot pending*, and the run continues. If the Plex source does not answer, that counts as viewers. |
| HA cannot move every guest off a node | Maintenance and `noout` are cleared (the node never went down), the node is not rebooted, and the job pauses. |
| A node stays up but its boot id never changes, or refuses the reboot | It did not reboot: both flags are cleared and the job pauses. |
| A flag cannot be cleared | The job pauses and names the flag that is LEFT ON. |
| A Ceph restart or reboot would take data offline (size=1 pool, below min_size, or `ok-to-stop` says no) | Nothing is restarted or rebooted: the step is **skipped for safety** with the pool, its share and roughly how many GB; a reboot is left *pending*. The run carries on and the report says so. |
| The Ceph pool layout cannot be read before a restart or reboot | The step refuses and the job pauses. Nothing was restarted. |
| An OSD does not come back after its restart, or the restart fails | The job pauses with **`noout` LEFT SET** and a critical notification. Bring the OSD back, `ceph osd unset noout`, then Resume or Cancel. |
| A node does not come back within 15 minutes | The job **fails** and leaves `noout` and HA maintenance **on**, so data does not move and guests do not bounce. Clear them by hand once the node is healthy: `ha-manager crm-command node-maintenance disable <node>` and `ceph osd unset noout`. |
| Old kernel removal would take more than the old kernels with it | Nothing is removed; the step fails and the run continues. |
| HyperProx restarts mid-job | On start, the job is paused ("HyperProx restarted mid-job") — never resumed on its own. A step that was running is marked failed ("interrupted by a HyperProx restart"), so an interrupted guest still holds back the node phase; Resume retries it (every step is safe to run twice). A self-handoff keeps running on its node; its result is collected rather than the step being restarted. |
| Resume or Confirm pressed twice, or Confirm racing Cancel | Status changes are conditional in the database: exactly one wins, the other gets a 409. |
| Cancel | Stops after the step in progress. A job that is paused or awaiting confirmation is cancelled at once. |
| An app update or its check fails | The step fails with the reason, the snapshot and how to undo it; nothing is rolled back on its own, and a service stopped for a failed install stays stopped. The job pauses. **Roll back** on the step restores the snapshot (not for HA guests). |
| An app's pre-flight finds a blocking issue | The update is not planned; the plan says why. If it was planned and the issue appears by execution time, the step fails before anything changes. |
| An approved config change no longer matches the file | Nothing is written; the step fails and asks for a fresh approval. |

A scheduled run that falls while HyperProx is locked is skipped and logged: the Proxmox
token and node logins live in the vault, so a locked HyperProx has nothing to run with.
Missed runs are not caught up later.

## Credentials

Node and guest commands go through the node logins already stored in the vault: at home the ones the
Terminal uses, on a remote that server's own logins (**Edit server, Nodes and logins**), used only with a
host key an admin confirmed (`lib/node-exec.ts`). The Proxmox API is reached with each cluster's own
token, also in the vault. Updates adds no credential. It does widen what those logins are
used for, from deploying guests to upgrading hosts, which is why the feature is
admin-only and audited. The self-handoff reboot relies on Proxmox cluster nodes reaching
each other as root over SSH, which a standard cluster already does.

App-update providers run their scripts in guests through the same path (as root, the script
on stdin), and read release metadata from the npm registry and the GitHub API anonymously.
They never see a credential: settings reach them through `option()`, which returns no secret.
