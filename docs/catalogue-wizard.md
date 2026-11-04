# Catalogue install wizard

Every Catalogue app now installs through a five-step wizard: the app, its size, where it goes, its ID and
network, and a review of the exact plan. This page records why, and how the pieces fit.

## Why: the old install chose for you

Before the wizard, `POST /api/catalogue/install` with no container ID ran `createContainer` in
`apps/api/src/lib/catalogue-installer.ts`, which:

- took the ID from `GET /cluster/nextid`. Proxmox answers the lowest free ID at or above 100, so on a cluster
  that does not use 100 every install became **CT 100**;
- took the node from `preflight`: of the online nodes with a stored login, the one with the most free memory
  (`maxmem - mem`). That is nearly always the biggest node, whatever else it is doing (a GPU node included);
- put the rootfs on the first storage by a fixed type ranking, on `vmbr0` with DHCP.

The page sent only `{ recipeId }` and showed a confirm box with the size, so none of those choices were
shown or could be changed.

## How it works now

| Step | What the person sees | Where it is decided |
|---|---|---|
| 1. App | what it is, what it needs, its first login | `catalogue.ts` (recipes now carry `minimum` and recommended `swapMb`) |
| 2. Size | cores, RAM, swap, disk, pre-filled; warns below the minimum | the recipe |
| 3. Where | every node: online, CPU and load, RAM, container storage (shared or local), guests, GPU and HA; the recommendation with a one-line reason; ineligible nodes greyed with the reason | `wizard-placement.ts` `scoreNodes` / `recommend`, fed by `readCluster` |
| 4. Name and network | ID (next free, or the ID rule), hostname, bridge, DHCP or static IP with gateway and DNS, checked as typed | `checkIdentity` |
| 5. Review | the server-held plan, every value, and what was checked | `previewInstall` |

`POST /wizard/apply` takes only `{ previewId }`. It reads the cluster again and refuses with 409, before
anything is created, if the ID, the address or the room has gone since the preview. A preview is single-use,
owner-only and expires after ten minutes. `/install` now only installs into an existing container.

### Scoring

Per eligible node: RAM left after the install (as a share and in absolute terms) with a heavy penalty below
20% free, CPU headroom, room on the chosen storage, a bonus for shared storage (HA can start the guest
elsewhere), a penalty for a node with a discrete GPU unless the app needs one, and a small capped penalty per
running guest. Ineligible: offline, no node login, not enough RAM, too few cores, no container storage with
room (disk x 1.2). The AI deploy template uses the same scorer and the same next-free ID.

A node "has a GPU" when its PCI bus shows an NVIDIA display controller, or a guest on it has `hostpciN`,
NVIDIA device nodes or a cgroup allow for major 195. `/dev/dri` alone does not count.

### Container ID rule

Settings → Container ID rule. **Next free** (default) or **Pattern**, built from `{node_digit}` (the trailing
number in the node name), `{ip_last2}` or `{ip_last3}` (the final octet's last two or three digits) and
literal digits. With a pattern, choosing the node and IP fills in the ID, typing an ID fills in the node and
the address digits, and a derived ID that is taken is reported, not used.

### Address checks

A static address is refused when it is in any guest config (`netN`/`ipconfigN`), reported live by a running
guest (LXC interfaces, or the QEMU guest agent where enabled), is a node's own address, or answers a ping
sent from the chosen node. No answer to a ping is not proof (firewalls drop it); the review says which
checks ran.

### Safety

- Creates go through the Proxmox API (`POST /nodes/{node}/lxc`), unprivileged with `nesting=1` only, never
  by writing a config file.
- Every wizard route is admin-only, reads included. Apply and clean-up also need the master password
  re-entered (`roles.ts`).
- A failed install can remove its own container: only when the job created it, the container still carries
  the job's mark in its description, and it is not under HA.
