# Updates

HyperProx can bring a whole Proxmox cluster up to date — nodes, containers, VMs and,
where you allow it, Docker images — one step at a time, and stop the moment something
is not right. This page is for the operator: what a run does, the policy file, and
what happens when something fails. The design behind it is in
`docs/superpowers/specs/2026-10-06-updates-design.md`.

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
   the configured `check` URL, fetched from inside the guest → for VMs with
   `reboot: if-required`, a reboot when the guest asks for one. When a guest finishes
   cleanly, its older `hp-upd-*` snapshots are deleted and the newest is kept; snapshots
   with any other name are never touched, and a guest that failed keeps all of them. HA-managed guests are
   stopped and started only through `ha-manager`, never `qm`/`pct`.
4. **Ceph**, only when Ceph packages are pending. The same version is installed on every
   node that has it pending (exact `package=version`, and apt is not allowed to remove
   anything), then daemons restart node by node — all monitors, then all managers, then
   OSDs with `noout` set — and Ceph must be back to the accepted health before the next.
   If nodes would install different Ceph versions, neither the Ceph nor the node phase is
   planned.
5. **Nodes, one at a time**, gates checked before each. `apt-get upgrade` or
   `apt-get dist-upgrade` as the node's policy says → Proxmox services active → holds and
   pin checked again. If a reboot is needed and the policy says `reboot: auto`: wait for
   viewers (below), check quorum, Ceph and HA again (the wait can be hours), set `noout`,
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
   in the job history, and to `notify.webhook_url` if set.

One job runs at a time, enforced in the database. Asking for another while one is
running, awaiting confirmation or paused answers `409` with the id of the active job.

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
| `notify.webhook_url` | none | Receives `{"content": "<summary>"}`, at most 1900 characters. |

Unknown keys fail the load with the path of the bad key (`nodes.gpu-node.requre_pin:
unknown key`), so a typo cannot quietly switch off a safeguard. A policy that fails to
load is reported on the page and treated like no policy at all.

Not managed, and listed so their absence is visible: excluded guests, stopped guests,
Windows VMs, VMs without the QEMU guest agent, and guests without `apt`.

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
| A node does not come back within 15 minutes | The job **fails** and leaves `noout` and HA maintenance **on**, so data does not move and guests do not bounce. Clear them by hand once the node is healthy: `ha-manager crm-command node-maintenance disable <node>` and `ceph osd unset noout`. |
| Old kernel removal would take more than the old kernels with it | Nothing is removed; the step fails and the run continues. |
| HyperProx restarts mid-job | On start, the job is paused ("HyperProx restarted mid-job") — never resumed on its own. A step that was running is marked failed ("interrupted by a HyperProx restart"), so an interrupted guest still holds back the node phase; Resume retries it (every step is safe to run twice). A self-handoff keeps running on its node; its result is collected rather than the step being restarted. |
| Resume or Confirm pressed twice, or Confirm racing Cancel | Status changes are conditional in the database: exactly one wins, the other gets a 409. |
| Cancel | Stops after the step in progress. A job that is paused or awaiting confirmation is cancelled at once. |

A scheduled run that falls while HyperProx is locked is skipped and logged: the Proxmox
token and node logins live in the vault, so a locked HyperProx has nothing to run with.
Missed runs are not caught up later.

## Credentials

Node and guest commands go through the node logins already stored for the Terminal
(`lib/node-exec.ts`); Updates adds no credential. It does widen what those logins are
used for, from deploying guests to upgrading hosts, which is why the feature is
admin-only and audited. The self-handoff reboot relies on Proxmox cluster nodes reaching
each other as root over SSH, which a standard cluster already does.
