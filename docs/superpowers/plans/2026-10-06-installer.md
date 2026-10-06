# Installer, Releases and Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A homelabber runs one command on a Proxmox node, answers Default/Advanced menus, and gets a working HyperProx installed from a tested, checksum-verified release, with `hyperprox update | rollback | uninstall` afterwards.

**Architecture:** GitHub Actions builds a release bundle per `v*` tag. `bootstrap.sh` (host) gathers answers through whiptail menus, creates the container and token, and runs `install.sh` (container), which unpacks the bundle into `/opt/hyperprox/releases/<ver>` behind a `current` link with `config/` and `data/` kept outside. Shell logic that can be tested in isolation lives in sourced libraries under `lib/sh/`, tested with bats against stubbed commands; the end-to-end proof is a harness that installs into a throwaway nested Proxmox VM.

**Tech Stack:** bash 5, whiptail, bats-core, shellcheck, GitHub Actions, Node 20 (`node --test` for API code), Fastify, Next.js, Prisma, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-06-installer-design.md`

## Global Constraints

- The repository is public: no real node names, IP addresses, guest IDs or hostnames in code, tests, fixtures or commit messages. Examples use `node-a`, `10.0.0.x`, VMIDs in the 9000s.
- Supported host: Proxmox VE 8 or 9. Container OS: Debian 13. Arch: x86_64 only.
- Minimum free storage for the container: 20 GB.
- Downloads only from GitHub Releases over HTTPS; every bundle is verified against `SHA256SUMS` before unpacking.
- Bundle name: `hyperprox-<version>.tar.gz`; versions are `vMAJOR.MINOR.PATCH`.
- On-disk layout: `/opt/hyperprox/releases/<ver>/`, `/opt/hyperprox/current -> releases/<ver>`, `/opt/hyperprox/config/` (`.env`, `updates.yaml`), `/opt/hyperprox/data/`. A release never writes to `config/` or `data/` except via migrations.
- Keep the two newest releases on disk.
- Update health check: API `http://127.0.0.1:3002/health` returns 200 and frontend `http://127.0.0.1:3000/` returns any 2xx or 3xx (it redirects to login) within 120 seconds, or the update rolls back.
- API token stored in `config/.env`, mode `0600`, never printed in full (show the first 8 characters only).
- The container is privileged with `nesting=1,keyctl=1` and the TUN device; the summary screen says so.
- Never delete a container or an API token automatically; only `--uninstall` after explicit confirmation does.
- Every interactive question has a flag; `-y` accepts defaults non-interactively.

## Review Focus

1. **A half-finished install is re-run** (container exists, `install.sh` died midway): `bootstrap.sh` must reuse the container and resume, not create a second one or fail on "VMID in use". Test in Task 6.
2. **GitHub unreachable or rate-limited** while resolving "latest": a clear error naming the URL, and `--version vX.Y.Z` still works from a pinned URL without the API. Test in Task 3.
3. **Too little free disk for an update:** refuse before downloading or unpacking, leaving `current` untouched. Test in Task 5.
4. **`rollback` with no previous release kept** (first install, or the old one pruned): a clear message, exit non-zero, nothing changed. Test in Task 5.
5. **A static IP that is already in use, or a gateway outside the subnet:** rejected at the menu, before any change. Test in Task 6.

---

### Task 1: Shell test tooling and CI

**Files:**
- Create: `tests/sh/helpers.bash` (stub framework: `stub <cmd> <script>` writes an executable to `$BATS_TEST_TMPDIR/bin` and prepends it to `PATH`; `stub_log <cmd>` returns the calls recorded)
- Create: `tests/sh/smoke.bats`
- Create: `.github/workflows/ci.yml` (on push/PR: `apt-get install -y bats shellcheck`, `shellcheck bootstrap.sh install.sh bin/hyperprox lib/sh/*.sh scripts/*.sh`, `bats tests/sh`)
- Create: `.gitattributes` with `tests/ export-ignore` and `test/ export-ignore`

**Interfaces:**
- Produces: `helpers.bash` functions `stub`, `stub_log`, used by every later bats file.

- [ ] **Step 1:** Write `tests/sh/smoke.bats` with `@test "stubbed command is called and logged"`: `stub curl 'echo stubbed'`; `run curl x`; assert `$output == "stubbed"` and `stub_log curl` contains `x`.
- [ ] **Step 2:** Run `bats tests/sh/smoke.bats`. Expected: FAIL (`helpers.bash` missing).
- [ ] **Step 3:** Implement `helpers.bash`; add `ci.yml` and `.gitattributes`.
- [ ] **Step 4:** Run `bats tests/sh` and `shellcheck bootstrap.sh install.sh`. Expected: bats PASS; shellcheck findings recorded but not fixed here (Tasks 4 and 6 rewrite those files).
- [ ] **Step 5:** Commit `test: bats + shellcheck harness and CI`.

### Task 2: Release bundle build and verification

**Files:**
- Create: `scripts/build-bundle.sh <version> <outdir>`: `pnpm install --frozen-lockfile`, build API (`tsc`) and frontend (`next build`), copy the standalone output plus `.next/static` and `public/` (the step `deploy.sh` already does), `pnpm --filter @hyperprox/api deploy --prod` for API runtime deps, Prisma schema + migrations, `docker-compose.yml`, `config/` templates, `bin/hyperprox`, `lib/sh/`, `install.sh`, `apps/setup/`, and a `VERSION` file; tar to `<outdir>/hyperprox-<version>.tar.gz`; append to `<outdir>/SHA256SUMS`.
- Create: `scripts/verify-bundle.sh <tarball>`: lists required paths and fails if any are missing.
- Create: `tests/sh/bundle.bats`

**Interfaces:**
- Produces: bundle layout (inside the tarball, top dir `hyperprox-<version>/`): `VERSION`, `api/dist/index.js`, `api/node_modules/`, `api/prisma/schema.prisma`, `api/prisma/migrations/`, `frontend/server.js`, `frontend/.next/static/`, `frontend/public/`, `setup/setup.js`, `compose/docker-compose.yml`, `templates/env.template`, `bin/hyperprox`, `lib/sh/`, `install.sh`.

- [ ] **Step 1:** Write `bundle.bats`: `@test "verify-bundle rejects a bundle missing api/dist/index.js"` (build a fake tarball with every path but that one; expect exit 1 naming it) and `@test "verify-bundle accepts a complete bundle"`.
- [ ] **Step 2:** Run. Expected: FAIL (script missing).
- [ ] **Step 3:** Implement `verify-bundle.sh` (required-path list exactly as in Interfaces), then `build-bundle.sh`, which calls `verify-bundle.sh` on its own output.
- [ ] **Step 4:** Run `bats tests/sh/bundle.bats` → PASS; run `scripts/build-bundle.sh v0.0.0-dev /tmp/out` on the dev box → tarball + `SHA256SUMS`, `sha256sum -c` passes.
- [ ] **Step 5:** Commit `build: reproducible release bundle`.

### Task 3: Shared installer library

**Files:**
- Create: `lib/sh/common.sh` (sourced by `bootstrap.sh`, `install.sh` and `bin/hyperprox`)
- Create: `tests/sh/common.bats`

**Interfaces:**
- Produces:
  - `hp_log <msg>`, `hp_ok`, `hp_warn`, `hp_die <msg>` (exit 1, names `$HP_LOG`)
  - `hp_resolve_version <requested>` → prints `vX.Y.Z`; `latest` queries `https://api.github.com/repos/hyperprox/alpha/releases/latest`; a concrete version is returned unchanged without any network call
  - `hp_release_url <version> <file>` → `https://github.com/hyperprox/alpha/releases/download/<version>/<file>`
  - `hp_download_verified <version> <destdir>` → downloads the tarball and `SHA256SUMS`, verifies, prints the tarball path; exit 2 on checksum mismatch, leaving nothing in `<destdir>`
  - `hp_free_gb <path>` → integer GB free

- [ ] **Step 1:** Write `common.bats`:
  - `hp_resolve_version latest` with `curl` stubbed to return `{"tag_name":"v0.9.0"}` → `v0.9.0`
  - `hp_resolve_version v0.8.1` → `v0.8.1` and `stub_log curl` is empty (Review Focus 2)
  - `hp_resolve_version latest` with `curl` stubbed to exit 22 → exit non-zero, output contains `api.github.com` (Review Focus 2)
  - `hp_download_verified` with a stubbed tarball whose sum does not match → exit 2, `<destdir>` empty
  - `hp_download_verified` happy path → prints the tarball path, file exists
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `common.sh`. JSON parsing with `sed`/`grep` (no `jq` dependency on a fresh host).
- [ ] **Step 4:** `bats tests/sh/common.bats` → PASS; `shellcheck lib/sh/common.sh` clean.
- [ ] **Step 5:** Commit `installer: shared library for versions, downloads, checksums`.

### Task 4: `install.sh` installs a release, no build

**Files:**
- Modify: `install.sh` (replace `clone_repo` and `build_app` with release install; keep `detect_environment`, `install_prerequisites`, `disable_apparmor`, `install_docker`, `install_node`, `configure_env`, `write_docker_compose`, `write_monitoring_config`; header comment: Debian 13 only)
- Create: `lib/sh/release.sh`
- Create: `tests/sh/release.bats`

**Interfaces:**
- Consumes: `hp_download_verified`, `hp_resolve_version`, `hp_free_gb` (Task 3); bundle layout (Task 2).
- Produces (`lib/sh/release.sh`, base dir `${HP_ROOT:-/opt/hyperprox}`):
  - `hp_unpack <tarball> <version>` → `releases/<version>/`, idempotent (re-unpacking an existing version is a no-op)
  - `hp_switch <version>` → atomically repoints `current` (`ln -sfn` to a temp name, then `mv -T`)
  - `hp_current_version` → version `current` points to, or empty
  - `hp_previous_version` → newest kept release older than current, or empty
  - `hp_prune` → keeps the two newest releases plus whatever `current` points to
  - `hp_migrate` → `prisma migrate deploy` from `current/api`
  - `hp_wait_healthy [seconds=120]` → 0 when both health URLs answer
  - `hp_check_network` → 0 when `github.com` resolves and answers HTTPS; otherwise exit 1 naming the gateway and DNS in use, before any download
  - `hp_write_env <answers>` → writes `config/.env` with mode `0600`
- `install.sh` reads answers from `${HP_ANSWERS:-/root/hyperprox-answers.env}` (variables `HP_VERSION`, `HP_STATIC_IP`, …), writes `config/.env` mode `0600`, writes systemd units whose `WorkingDirectory`/`ExecStart` use `/opt/hyperprox/current/...` and `EnvironmentFile=/opt/hyperprox/config/.env`, and installs `bin/hyperprox` to `/usr/local/bin/hyperprox`.

- [ ] **Step 1:** Write `release.bats` (with `HP_ROOT=$BATS_TEST_TMPDIR`):
  - `hp_unpack` then `hp_switch v1` → `current` resolves to `releases/v1`
  - `hp_switch v2` then `hp_previous_version` → `v1`
  - after unpacking v1..v4 and switching to v4, `hp_prune` leaves exactly v3 and v4
  - with `current` on v2 and v3, v4 present, `hp_prune` never removes v2 (the current one)
  - `hp_previous_version` with only one release → empty (Review Focus 4)
  - `hp_check_network` with `getent hosts github.com` stubbed to fail → exit 1, output names the gateway and DNS from the answers file, and `stub_log curl` is empty (no download attempted)
  - `hp_write_env` → `config/.env` exists with mode `600` and the token value is not echoed to stdout
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `release.sh`; rewire `install.sh` main to: prerequisites → `hp_check_network` → Docker → Node → resolve version → `hp_download_verified` → `hp_unpack` → config and units → `docker compose up -d` → `hp_switch` → `hp_migrate` → start units → `hp_wait_healthy` → print URL.
- [ ] **Step 4:** `bats tests/sh/release.bats` → PASS; `shellcheck install.sh lib/sh/release.sh` clean.
- [ ] **Step 5:** Commit `install: install a verified release into releases/<ver> behind current`.

### Task 5: `hyperprox` CLI

**Files:**
- Create: `bin/hyperprox`
- Create: `tests/sh/cli.bats`

**Interfaces:**
- Consumes: Task 3 and Task 4 libraries.
- Produces: subcommands `status`, `version`, `update [ver]`, `rollback`, `uninstall [--purge]`; exit 0 on success, 1 on refusal or failure; database backups at `data/backups/pre-<ver>-<UTCstamp>.sql.gz` via `docker compose exec -T postgres pg_dump`.

- [ ] **Step 1:** Write `cli.bats` with `systemctl`, `docker`, `curl` and `hp_wait_healthy` stubbed:
  - `update v2` happy path → backup taken, migrate run, `current` → v2, exit 0
  - `update v2` with `hp_wait_healthy` failing → database restored from the backup, `current` back on v1, output says it rolled back, exit 1
  - `update v2` with `hp_free_gb` reporting 1 GB → refuses before any download, `current` unchanged (Review Focus 3)
  - `rollback` with no previous release → message "no earlier release kept", exit 1, nothing changed (Review Focus 4)
  - `uninstall --purge` without typing `delete` → exit 1, `data/` still exists
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `bin/hyperprox`. Update needs `free ≥ 2 × bundle size + 1` GB on `/opt/hyperprox`. Rollback restores the backup taken before the update being undone (newest `pre-<current>-*.sql.gz`).
- [ ] **Step 4:** `bats tests/sh/cli.bats` → PASS; shellcheck clean.
- [ ] **Step 5:** Commit `cli: hyperprox status, update with automatic rollback, rollback, uninstall`.

### Task 6: Interactive `bootstrap.sh`

**Files:**
- Create: `lib/sh/host.sh` (validation and idempotent host steps; no UI)
- Modify: `bootstrap.sh` (checks, whiptail Default/Advanced menus, summary, then calls `host.sh` steps; `--uninstall`; existing flags kept, `-y` = non-interactive defaults)
- Create: `tests/sh/host.bats`

**Interfaces:**
- Consumes: Task 3 library; `install.sh` answers format (Task 4).
- Produces (`lib/sh/host.sh`):
  - checks: `hp_check_pve` (8 or 9 via `pveversion`), `hp_check_arch`, `hp_storage_ok <storage>` (takes `rootdir` content, ≥ 20 GB free)
  - validation: `hp_vmid_free <id>`, `hp_ip_valid <cidr> <gateway>` (gateway inside the subnet), `hp_ip_unused <ip>` (no ping or ARP reply)
  - steps, each a no-op when already done: `hp_ensure_template`, `hp_ensure_container <answers>`, `hp_ensure_token` (reuses a token that still authenticates, otherwise creates `hyperprox-<UTCdate>`; never deletes one), `hp_ensure_exporters`, `hp_run_install_in_ct <vmid>`
  - `hp_write_answers <file>`; `hp_uninstall <vmid>` (destroy container and token after confirmation)
- Menus write the same answers file the flags do, so both paths share every step.

- [ ] **Step 1:** Write `host.bats` with `pveversion`, `pvesh`, `pvesm`, `pct`, `pveum` and `ping` stubbed:
  - `hp_vmid_free 9001` true when `pvesh get /cluster/nextid -vmid 9001` succeeds; false otherwise
  - `hp_ip_valid 10.0.0.50/24 10.0.1.1` → false (gateway outside subnet) (Review Focus 5)
  - `hp_ip_unused 10.0.0.50` false when `ping` answers (Review Focus 5)
  - `hp_storage_ok` false for a storage without `rootdir` content, and for one with 10 GB free
  - `hp_ensure_container` when `pct status 9001` reports an existing container whose hostname matches the answers → no `pct create` in `stub_log`, exit 0 (Review Focus 1)
  - `hp_ensure_container` when VMID 9001 exists with a different hostname → exit 1 with "VMID 9001 is in use by '<name>'" and no create
  - `hp_ensure_token` with a working existing token → no `pveum user token add` call
  - `hp_uninstall 9001` with stdin `no` → exit 1, and no `pct destroy` or `pveum user token remove` in `stub_log`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `host.sh`; then rewrite `bootstrap.sh`: checks → first screen Default/Advanced → Advanced asks container ID, hostname, storage (menu of storages showing free GB), cores, RAM, disk, bridge, DHCP or static IP + gateway + DNS, version (menu from the releases API, newest first), extras (node_exporter, RAPL, Intel GPU only when `lspci` shows an Intel VGA device), each re-asked on a failed validation → summary (states "privileged container — required by Docker") with Install/Back/Cancel → steps with `[n/6]` progress → URL. `--uninstall [--vmid N]` names the container and token and needs `yes` typed.
- [ ] **Step 4:** `bats tests/sh/host.bats` → PASS; shellcheck clean; `bash bootstrap.sh --help` lists every flag.
- [ ] **Step 5:** Commit `bootstrap: Default/Advanced menus, validated answers, idempotent host steps, --uninstall`.

### Task 7: Browser wizard additions and update notice

**Files:**
- Modify: `apps/setup/setup.js` (add steps: notifications webhook URL with a test message; Updates policy defaults written to `config/updates.yaml` from a template; a "Reopen setup" entry point gated on an admin session instead of bailing when already set up)
- Create: `apps/api/src/routes/system.ts` (`GET /api/system/version` → `{ current, latest, notes, updateAvailable }`, cached 6 h; `POST /api/system/update` → starts `systemd-run --unit hyperprox-update --collect /usr/local/bin/hyperprox update <ver>`, admin only, returns 202)
- Create: `apps/api/src/routes/system.test.ts` (`node --test` via `tsx`)
- Modify: `apps/api/src/index.ts` (register the route); the frontend Settings page (banner + button + live status poll of `GET /api/system/update/status`)

**Interfaces:**
- Consumes: `bin/hyperprox` (Task 5); `VERSION` file in the bundle (Task 2) as the source of `current`.
- Produces: `GET /api/system/version`, `POST /api/system/update`, `GET /api/system/update/status` → `{ state: "idle"|"running"|"ok"|"rolled-back", log }` from `journalctl -u hyperprox-update`.

- [ ] **Step 1:** Write `system.test.ts`: `updateAvailable` true when latest `v0.10.0` > current `v0.9.0`; false when equal; `latest` null and `updateAvailable` false when GitHub fails (no throw); `POST /api/system/update` without an admin session → 403.
- [ ] **Step 2:** Run `node --import tsx --test apps/api/src/routes/system.test.ts` → FAIL.
- [ ] **Step 3:** Implement the route, the Settings banner, and the `setup.js` additions.
- [ ] **Step 4:** Tests PASS; API typecheck (`pnpm --filter @hyperprox/api typecheck`) clean.
- [ ] **Step 5:** Commit `setup + settings: notifications and update policy steps, update notice with one-click update`.

### Task 8: Release pipeline and helper

**Files:**
- Create: `.github/workflows/release.yml` (on tag `v*`: checkout, Node 20, pnpm, `scripts/build-bundle.sh "$GITHUB_REF_NAME" dist/`, then `gh release create "$GITHUB_REF_NAME" dist/* bootstrap.sh install.sh --notes-file <CHANGELOG section>`; marked prerelease until the install harness has passed, see Task 9)
- Create: `scripts/release.sh <version>` (refuses a dirty tree or an existing tag; bumps `version` in the three `package.json` files; moves `CHANGELOG.md`'s "Unreleased" section under the version; commits, tags, pushes)
- Create: `CHANGELOG.md`
- Create: `tests/sh/release-helper.bats`

**Interfaces:**
- Consumes: `scripts/build-bundle.sh` (Task 2).
- Produces: GitHub Releases containing `hyperprox-<ver>.tar.gz`, `SHA256SUMS`, `bootstrap.sh`, `install.sh`.

- [ ] **Step 1:** Write `release-helper.bats` (in a temp git repo): refuses `0.9` (no `v`), refuses an existing tag, refuses a dirty tree; happy path → three `package.json` files at `0.9.0`, a tag `v0.9.0`, CHANGELOG section renamed (with `git push` stubbed).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `release.sh` and `release.yml`.
- [ ] **Step 4:** bats PASS; `actionlint .github/workflows/*.yml` clean (installed in CI).
- [ ] **Step 5:** Commit `release: tag-driven bundle builds on GitHub Actions and a one-command release helper`.

### Task 9: Install test harness on a throwaway nested Proxmox

**Files:**
- Create: `test/install/make-pve-vm.sh` (run on a Proxmox node: `--vmid --ip --gw --storage --iso-storage --pve-iso --ssh-key`; builds the answer file (`answer.toml`), runs `proxmox-auto-install-assistant prepare-iso`, creates a VM with `cpu: host` and a 64 GB disk, boots it, waits for SSH)
- Create: `test/install/scenarios.sh <test-host-ip> <bundle-url-or-path>` (runs the eight spec scenarios in order, each printing `PASS` or `FAIL: <reason>`, non-zero exit if any fail)
- Create: `test/install/checks.sh` (outcome checks: URL answers 200, login with the admin created via the wizard API, `/api/proxmox/nodes` lists the test node, token reads `/cluster/resources`)
- Create: `test/install/README.md` (how to run; how to remove the VM)

**Interfaces:**
- Consumes: `bootstrap.sh` flags (Task 6), `hyperprox` CLI (Task 5), release bundles (Task 8). Flag `--bundle <path>` on `bootstrap.sh`/`install.sh` installs from a local tarball + `SHA256SUMS` so unreleased bundles can be tested (add it in this task).

- [ ] **Step 1:** Write `scenarios.sh` with all eight scenarios as functions, and checks that fail before the installer pieces exist. Run against a freshly built test VM → expect FAIL on scenario 1 if run before Tasks 4–6 are merged; on the finished branch, every scenario must PASS.
- [ ] **Step 2:** Add `--bundle` to the installers; build a bundle (Task 2); run `scenarios.sh`. Expected: `8/8 PASS`. Scenario 5 forces a failed update by installing a bundle whose API exits at startup, and must end with `current` on the old version.
- [ ] **Step 3:** In `release.yml`, keep releases as prerelease; document in `test/install/README.md` that a release is promoted (`gh release edit --prerelease=false`) only after `scenarios.sh` passes against that exact bundle.
- [ ] **Step 4:** Commit `test: end-to-end install scenarios on a throwaway nested Proxmox`.

### Task 10: README and first release

**Files:**
- Modify: `README.md` Install section (the release URL one-liner, the Default/Advanced menus, the flags table, `hyperprox` CLI usage, update/rollback/uninstall, "the container is privileged and why")
- Modify: `CHANGELOG.md` (Unreleased → everything above)

- [ ] **Step 1:** Rewrite the Install section; check every command and flag in it exists (`bash bootstrap.sh --help`, `hyperprox --help`).
- [ ] **Step 2:** `scripts/release.sh v0.9.0`; wait for the Actions build; run `test/install/scenarios.sh` against the published bundle → `8/8 PASS`; promote the release.
- [ ] **Step 3:** Commit README changes before tagging (part of Step 2's tree).
