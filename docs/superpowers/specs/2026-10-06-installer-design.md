# Installer, releases and lifecycle — design

Status: design, approved for spec 2026-10-06. Not yet planned or built.

## Why

HyperProx already installs with one command, but three things stand between that command and a homelabber
who has never seen the project:

- **It is unproven.** Nothing shows the full path working on a clean Proxmox install; the in-container
  installer still claims Debian 12 / Ubuntu while the host script creates Debian 13.
- **It installs whatever `main` is at that moment.** There are no releases, so a new user gets work in
  progress, and there is no clean way to update, roll back or uninstall.
- **It is flags or nothing.** Homelabbers want to choose their container ID, storage, size and network,
  and pick extras; today that means reading an options list and retyping a command.

## Goals

- One command on a Proxmox node gives a working HyperProx, with a **Default** path (press Enter) and an
  **Advanced** path that asks for everything a homelabber would want to choose.
- What gets installed is a **versioned, prebuilt, checksum-verified release**, never a live branch.
- `hyperprox update`, `rollback` and `uninstall` work, and a failed update puts the old version back.
- Every release is **proven** by an automated install test on a throwaway Proxmox before it is published.
- Scripted installs keep working: every question has a flag, and `-y` accepts defaults.

## Non-goals (this version)

- A tested install outside Proxmox (plain Debian/Ubuntu). `install.sh` keeps working there, untested.
- ARM hosts. Docker images for the app itself. Multi-node test clusters.

## Components

| Unit | Where | Job |
|---|---|---|
| Release pipeline | `.github/workflows/release.yml` | On a `v*` tag: install, build API and frontend, pack `hyperprox-<ver>.tar.gz` + `SHA256SUMS`, attach `bootstrap.sh` and `install.sh`, publish a GitHub Release. |
| Release helper | `scripts/release.sh` | Bump the version, update `CHANGELOG.md`, tag, push. One command to cut a release. |
| Host installer | `bootstrap.sh` | Runs on a Proxmox node. Checks, whiptail menus (Default / Advanced), summary, then creates the container, mints the API token, installs extras, and runs `install.sh` inside with the answers. Flags + `-y` for scripted use. `--uninstall` removes the container and token. |
| In-container installer | `install.sh` | OS packages, Node, Docker; download the chosen bundle, verify the checksum, unpack, write config, start services, wait for health. No build step. |
| CLI | `/usr/local/bin/hyperprox` | `status`, `version`, `update [ver]`, `rollback`, `uninstall [--purge]`. |
| Browser wizard | `apps/setup` (extended) | First start: admin account, DNS provider, proxy manager, plug-ins (Scan for services), notifications, Updates policy. Skippable; reopenable from Settings. |
| Update notice | API + Settings page | "Update available" with change notes and a button that runs `hyperprox update`. |
| Test harness | `test/install/` (`export-ignore`) | Builds a throwaway Proxmox VM with nested virtualisation and runs every scenario below against a given bundle. |

## Layout on disk (inside the container)

```
/opt/hyperprox/
  releases/v0.9.0/        # unpacked bundle, never edited in place
  releases/v0.10.0/
  current -> releases/v0.10.0
  config/                 # survives updates: .env, updates.yaml, generated configs
  data/                   # survives updates: postgres, grafana, prometheus, backups/
```

Services point at `current`. An update is unpack → migrate → switch the link → restart; a rollback is
switching the link back. The two newest releases are kept.

## Host installer flow

1. **Checks:** root; Proxmox VE 8 or 9 (`pveversion`); `whiptail` present; internet (GitHub reachable);
   a storage that takes `rootdir` content with at least 20 GB free.
2. **Menus.** First screen: *Default install* or *Advanced*. Advanced asks, each with the default filled in
   and validated on entry:
   - container ID (must be free), hostname
   - storage (must take container disks, show free space), CPU cores, RAM, disk size
   - network: bridge; DHCP or static IP + gateway (the address must not already answer); DNS server
   - HyperProx version (newest by default; a list of releases)
   - extras: `node_exporter` on all nodes, RAPL power metrics, Intel GPU metrics (only offered where an
     Intel iGPU is present)
3. **Summary** of every choice, stating plainly that the container is **privileged** because Docker needs
   it. *Install* / *Back* / *Cancel*.
4. **Work**, with a step counter and a log file: template download → container create (privileged,
   nesting, keyctl, TUN device) → API token create + grant → extras on each node → copy the answers into
   the container and run `install.sh` → wait for HyperProx to answer.
5. **Finish:** the URL, and "open it to finish setup in your browser".

Re-running is safe: each step detects that it is already done and skips it.

## Update, rollback, uninstall

- `hyperprox update [ver]`: fetch the release list, show change notes, download, verify the checksum,
  unpack to `releases/<ver>`, **back up the database**, run migrations, switch `current`, restart, health
  check. If the API or frontend does not answer within 2 minutes, or a migration fails: restore the
  database backup, switch `current` back, restart, and say so.
- `hyperprox rollback`: switch to the previous kept release, restoring the database backup taken before
  the update that is being undone.
- `hyperprox uninstall`: stop and remove services and app; keep `config/` and `data/`.
  `--purge` also removes them, after typing `delete`.
- `bootstrap.sh --uninstall` (on the host): names the container and token it will remove, asks for
  confirmation, then destroys the container and deletes the token.

## Failure handling

- **A host step fails:** stop, show the step and the failing command, leave completed work in place;
  re-run resumes. Never delete a container automatically; report a half-made one and how to remove it.
- **No network from the container:** detected before any download, with the gateway and DNS named.
- **Checksum mismatch:** refuse; unpack nothing.
- **Existing API token:** reuse it if it still authenticates, otherwise create a new one alongside;
  never delete an existing token.
- **Unsupported environment** (not Proxmox, too little storage, non-x86): stopped at the checks, before
  any change, with what is needed.

## Security

- Downloads only from GitHub Releases over HTTPS, each verified against `SHA256SUMS`.
- The API token is written to `config/.env` with mode `0600` and never printed in full.
- The privileged container is disclosed on the summary screen rather than hidden.

## Testing

- **Test VM:** `test/install/make-pve-vm.sh <node> …` creates a throwaway Proxmox VE VM (nested
  virtualisation, Proxmox ISO with its automated-installation answer file), static IP, SSH key only.
- **Scenarios**, each scripted with a pass/fail result:
  1. default install
  2. advanced install: static IP, custom size, chosen storage
  3. re-run on a finished install changes nothing
  4. `update` to a newer bundle
  5. an update forced to fail rolls back automatically
  6. `rollback`
  7. `uninstall`, then `--purge`
  8. host `--uninstall`
- **Pass means the outcome:** the URL answers, login works, the dashboard lists the test node, and the API
  token reads the cluster. The installer's own success message is not evidence.
- A release is published only after the scenarios pass against that exact bundle.

## Docs

The README's Install section is rewritten for the release-based command, the Default/Advanced menus, the
`hyperprox` CLI, and update/rollback/uninstall. The dev-only scaffold scripts were removed (2026-10-06).
