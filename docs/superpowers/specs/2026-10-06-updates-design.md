# Updates — design

Status: design, approved for spec 2026-10-06. Not yet planned or built.

## Why

A Proxmox cluster drifts. Nodes, containers and VMs each want `apt` runs, Docker images age, and every
manual round is a sequence of judgement calls: which node first, is Ceph healthy enough to take a node
down, is anyone watching something right now, does this node have a kernel pin that a `dist-upgrade`
would break. Doing it by hand takes an evening; skipping it leaves a cluster weeks behind on security
fixes. HyperProx already holds every piece needed to make those calls (the Proxmox API, node and guest
execution, Ceph health, HA, Plex activity), so it should run the whole round itself, on demand and on a
schedule, and stop the moment something is not right.

## Goals

- One page that shows what is pending on every node, container and VM, and the plan to bring them current.
- Run that plan on demand, or unattended on a weekly schedule, with live progress and a written report.
- Never take more than one node down at a time; never proceed past a failed health check.
- Respect per-node and per-guest policy kept in a local config file, never in code.

## Non-goals

- Proxmox major version upgrades and Ceph major releases. Those are their own wizards.
- Windows guests, appliances that update themselves (Home Assistant OS, PBS's own updater UI), and guests
  without `apt`. They are listed as "not managed" so their absence is visible, not silent.
- Unattended Docker image updates for every project. Images update only where policy says so.

## Policy (`config/updates.yaml`, local, git-ignored)

Everything cluster-specific lives here. A commented `config/updates.example.yaml` ships in the repo.

```yaml
schedule:
  enabled: true
  cron: "0 8 * * 3"            # Wednesday 08:00, local time
  window_hours: 4              # reboots still waiting after this are skipped, not forced
quiet:
  plex_streams_block_reboots: true
ceph:
  accepted_warnings:           # health codes that do not stop a run; anything else does
    - POOL_NO_REDUNDANCY
nodes:
  default:   { upgrade: dist-upgrade, reboot: auto }
  node-a:    { upgrade: dist-upgrade, reboot: manual, order: last }   # hosts something you are using
  gpu-node:
    upgrade: upgrade           # never dist-upgrade
    reboot: manual
    require_holds: [proxmox-default-kernel, proxmox-kernel-7.0, proxmox-headers-7.0]
    require_pin: 7.0.14-14-pve
guests:
  default:   { apt: true, docker: none, reboot: if-required }
  exclude:   [110, 147]        # by VMID: guests HyperProx must never touch
  "205":     { docker: auto, compose_dirs: [/opt/stack] }
  "225":     { docker: manual }                  # report new images, never pull
  "301":     { check: "http://127.0.0.1:32400/identity" }
batch_size: 3
self:
  node_order: last             # HyperProx's own node and its own image update after everything else
```

Unknown keys fail validation at load, so a typo cannot silently disable a safeguard.

## Components

| Unit | File | Job |
|---|---|---|
| Policy | `lib/updates/policy.ts` | Load, validate and default `updates.yaml`; answer "what may I do to X". |
| Inventory | `lib/updates/inventory.ts` | Per node: `apt` pending list via the Proxmox API, reboot-required, Ceph packages involved. Per guest: `apt list --upgradable` via `pct exec` (containers) or the QEMU guest agent (VMs); Docker image digests where policy names compose dirs. Read-only. |
| Planner | `lib/updates/planner.ts` | Pure function: inventory + policy → ordered plan of steps. Executes nothing; the plan is shown before a manual run. |
| Gates | `lib/updates/gates.ts` | Quorum, Ceph health vs accepted warnings, node root free space, holds/pin present, active streams, HA state settled. Each gate returns pass/fail with a reason. |
| Runner | `lib/updates/runner.ts` | Executes steps in order, checks gates between them, persists every state change, resumes after restart. One job at a time (DB lock). |
| Self handoff | `lib/updates/handoff.ts` | For steps that would stop HyperProx (its own node's reboot, its own image): writes a detached script to another node, runs it, reads the result when the API is back. |
| Scheduler | `lib/updates/scheduler.ts` | Starts the weekly run from `schedule.cron`. |
| API | `routes/updates.ts` | Inventory, plan, start (manual or dry-run), job status, history, resume, per-node reboot. |
| UI | `app/updates/page.tsx` | Pending table, plan preview, Run / Dry run, live log over the existing WebSocket, history, Reboot per node. |
| Report | in `runner.ts` | Summary to the UI history and to the configured notification webhook. |

Existing pieces reused: `proxmox-client.ts` (apt list, HA maintenance, guest agent, snapshots),
`node-exec.ts` (`execOnNode`, `execInGuest`), `ceph.ts`, the Plex plug-in's session count,
`ws-broadcast.ts`, Prisma.

## Data

```prisma
model UpdateJob {
  id         String   @id @default(cuid())
  trigger    String   // manual | schedule | dry-run
  status     String   // planned | running | paused | failed | done
  plan       Json
  report     Json?
  startedAt  DateTime @default(now())
  finishedAt DateTime?
  steps      UpdateStep[]
}
model UpdateStep {
  id        String   @id @default(cuid())
  jobId     String
  job       UpdateJob @relation(fields: [jobId], references: [id])
  seq       Int
  target    String   // node name or vmid
  action    String   // preflight | snapshot | apt | docker | check | ceph | node-upgrade | node-reboot | kernel-cleanup | self
  status    String   // pending | running | ok | failed | skipped
  reason    String?
  output    String?  // tail of captured output
  startedAt DateTime?
  endedAt   DateTime?
}
```

## A run, in order

1. **Preflight (read-only).** Quorum; Ceph health against `accepted_warnings`; every node reachable; root
   free space on every node enough for the pending downloads; required holds and pin present; no other job.
   Any failure ends the job before anything changes.
2. **Refresh + inventory + plan.** `apt update` everywhere, then the plan. A manual run waits for
   confirmation; a scheduled run proceeds.
3. **Guests**, `batch_size` at a time:
   snapshot where the guest supports one (bind-mounted containers cannot; the step records that) →
   `apt-get -y upgrade` with `--force-confold`, then `autoremove` →
   Docker for `docker: auto` guests: `compose pull` + `up -d`, then every container running/healthy →
   configured `check` →
   VM reboot only if `reboot: if-required` and the VM reports one; HA-managed guests through `ha-manager`.
4. **Ceph**, only when Ceph packages are pending anywhere: install the same version on every node, then
   restart daemons node by node (mon → mgr → osd), health back to the accepted set before the next.
5. **Nodes, one at a time**, gates clean before each:
   `upgrade` or `dist-upgrade` per policy → Proxmox services active → holds and pin re-checked →
   if a new kernel was installed and `reboot: auto` and no streams: `noout`, HA maintenance on, reboot,
   wait (quorum, all OSDs up, PGs active+clean), maintenance off, `noout` cleared; with `reboot: manual`,
   mark "reboot pending" →
   remove old kernels, keeping the running one and one fallback; `apt clean`.
6. **HyperProx itself, last**, through the handoff.
7. **Report**: per machine what changed, what was skipped and why, reboots pending.

## Failure handling

- **Gate fails between steps:** the job pauses, nothing further runs, the reason is shown and sent. Resume
  is a button; there is no automatic retry of a health failure.
- **A guest fails** (apt error, unhealthy container, failed check): that guest is marked failed with its
  snapshot name; other guests continue; the Ceph and node phases do not start while any guest failed.
- **A node does not come back** within 15 minutes: the job stops and **leaves `noout` and HA maintenance
  on**, so data does not move and guests do not bounce. Clearing them is a human decision.
- **Holds or pin missing on a node that requires them:** stop before installing; never repair silently.
- **Streams active when a reboot is due:** re-check every 5 minutes until `window_hours` ends, then skip
  that reboot, mark the node "reboot pending", and continue.
- **HyperProx restarts mid-job:** on boot, find the unfinished job, collect any handoff result, resume from
  the last finished step. Every step is idempotent.
- **Second job requested while one runs:** refused with the running job's id.

## Testing

- **Planner unit tests** on fixed inventories: ordering, exclusions, upgrade vs dist-upgrade, pinned node,
  Ceph levelling, reboot decisions, self last.
- **Runner tests** with a fake executor: a failure injected at every action type, resume after restart,
  stream waits, the node-does-not-return path leaving `noout` set.
- **Policy tests:** unknown keys rejected, defaults applied.
- **Rollout:** dry run (inventory + plan, executes nothing) → a guest-only run on low-stakes guests → one
  node with `reboot: manual` → enable the schedule.

## Security

Node and guest execution already goes through the stored node credential (`node-exec.ts`); this feature
adds no new credential. It does widen what that credential is used for, from deploying guests to
upgrading hosts, so the Updates page and its routes are admin-only and every job is written to the
audit log.
