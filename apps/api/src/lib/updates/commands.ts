// =============================================================================
//  HyperProx — Updates: the exact commands, and how their output is read
//
//  Every shell line this feature sends to a node or a guest is built here, so
//  there is one file to read to know what an update run can do to a machine,
//  and the parsers sit next to the commands whose output they read.
// =============================================================================

import type { UpdatesPkgChange } from './types'

// NEEDRESTART_SUSPEND: needrestart must not restart services (every ceph-osd at once, on a node set to
// restart automatically) after a library upgrade.
const APT_ENV = 'export DEBIAN_FRONTEND=noninteractive LC_ALL=C NEEDRESTART_SUSPEND=1'
// Keep the local version of any config file the admin changed; never stop to ask.
const CONFOLD = '-o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef'

// --- Packages that change how a run must treat a node ------------------------------

// By prefix: a fixed list misses packages (cephadm, cephfs-shell, the -dev libraries, the sqlite VFS). A false
// positive only means a package waits for the Ceph phase; a miss would let a node upgrade move Ceph.
const CEPH_PKG   = /^(ceph|libceph|librados|librbd|librgw|libradosstriper|libsqlite3-mod-ceph|python3-(ceph|rados|rbd|rgw)|radosgw|rbd-)/
const KERNEL_PKG = /^(proxmox-kernel-|pve-kernel-|proxmox-default-kernel$)/

export const isCephPackage   = (name: string) => CEPH_PKG.test(name)
export const isKernelPackage = (name: string) => KERNEL_PKG.test(name)

/** /nodes/{node}/apt/update as Proxmox returns it. */
export function parsePveAptList(rows: unknown): UpdatesPkgChange[] {
  if (!Array.isArray(rows)) return []
  return rows
    .filter((r: any) => r && typeof r.Package === 'string' && typeof r.Version === 'string')
    .map((r: any) => ({ name: r.Package, from: typeof r.OldVersion === 'string' && r.OldVersion ? r.OldVersion : null, to: r.Version }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// --- Guests -----------------------------------------------------------------------

/**
 * Read-only: what `apt-get upgrade` would actually install, and whether the guest wants a reboot.
 *
 * `apt list --upgradable` also lists held packages and ones `upgrade` keeps back (a new kernel that pulls in
 * a new package), which a run can never install, so the guest was planned again on every run. A simulated
 * upgrade decides; the rest come back as HP_KEPT. If the simulation itself fails, every line counts as
 * pending, so an update is never hidden.
 */
export const GUEST_PENDING_SCRIPT = [
  'command -v apt-get >/dev/null 2>&1 || { echo HP_NO_APT; exit 0; }',
  'if sim=$(LC_ALL=C apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null); then',
  '  inst=" $(printf \'%s\\n\' "$sim" | awk \'/^Inst /{n=$2; sub(/:.*/, "", n); printf "%s ", n}\') "',
  'else inst=ALL; fi',
  'LC_ALL=C apt list --upgradable 2>/dev/null | grep -v "^Listing" | while IFS= read -r l; do',
  '  p=${l%%/*}',
  '  if [ "$inst" = ALL ]; then echo "$l"; else case "$inst" in *" $p "*) echo "$l" ;; *) echo "HP_KEPT $p" ;; esac; fi',
  'done',
  '[ -f /var/run/reboot-required ] && echo HP_REBOOT_REQUIRED || true',
].join('\n')

export interface GuestPendingResult { noApt: boolean; pending: UpdatesPkgChange[]; keptBack: string[]; rebootRequired: boolean }

// `curl/stable-security 8.14.1-2+deb13u2 amd64 [upgradable from: 8.14.1-2+deb13u1]`
const APT_LINE = /^([^\s/]+)\/(\S+)\s+(\S+)\s+\S+(?:\s+\[upgradable from:\s*([^\]]+)\])?/
/** A suite list such as `stable-security,stable` or an origin such as `Debian-Security:13/stable-security`. */
const SECURITY_SUITE = /(^|[\s,:/(])[\w.-]*-security\b|Debian-Security|Ubuntu:[\d.]+\/[\w-]+-security/i

export function parseGuestPending(output: string): GuestPendingResult {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.includes('HP_NO_APT')) return { noApt: true, pending: [], keptBack: [], rebootRequired: false }
  const pending: UpdatesPkgChange[] = []
  const keptBack: string[] = []
  for (const l of lines) {
    if (l.startsWith('HP_KEPT ')) { keptBack.push(l.slice(8).trim()); continue }
    const m = APT_LINE.exec(l)
    if (m) {
      const p: UpdatesPkgChange = { name: m[1], from: m[4]?.trim() ?? null, to: m[3] }
      if (SECURITY_SUITE.test(m[2])) p.security = true
      pending.push(p)
    }
  }
  return { noApt: false, pending, keptBack, rebootRequired: lines.includes('HP_REBOOT_REQUIRED') }
}

export const GUEST_REFRESH_SCRIPT = `${APT_ENV}\napt-get update -q`

/** Guests always get `upgrade`, never `dist-upgrade`: a guest that needs more is a human's call. */
export const GUEST_UPGRADE_SCRIPT = [
  APT_ENV,
  'set -e',
  `apt-get -y -q ${CONFOLD} upgrade`,
  'apt-get -y -q autoremove',
  '[ -f /var/run/reboot-required ] && echo HP_REBOOT_REQUIRED || true',
].join('\n')

function shq(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'` }

/**
 * Pull and restart a compose project, then require every container running and
 * not unhealthy. Containers still `starting` get a minute to settle.
 */
export function guestDockerScript(dirs: string[]): string {
  const lines = ['set -e']
  for (const d of dirs) {
    lines.push(`cd ${shq(d)}`, 'docker compose pull -q', 'docker compose up -d --remove-orphans')
  }
  lines.push(
    'for i in $(seq 1 12); do',
    '  bad=""; starting=""',
    ...dirs.map(d => `  out=$(cd ${shq(d)} && docker compose ps -a --format '{{.Name}} {{.State}} {{.Health}}')
  while read -r n s h; do [ -z "$n" ] && continue
    [ "$s" != "running" ] && bad="$bad $n:$s"
    [ "$h" = "unhealthy" ] && bad="$bad $n:unhealthy"
    [ "$h" = "starting" ] && starting="$starting $n"
  done <<< "$out"`),
    '  [ -n "$bad" ] && { echo "not healthy:$bad"; exit 1; }',
    '  [ -z "$starting" ] && { echo "all containers running"; exit 0; }',
    '  sleep 5',
    'done',
    'echo "still starting after 60s:$starting"; exit 1',
  )
  return lines.join('\n')
}

/** Read-only: the image each compose service runs, the digest it is on, and the registry's current one. */
export function guestDockerImagesScript(dirs: string[]): string {
  return [
    'command -v docker >/dev/null 2>&1 || { echo HP_NO_DOCKER; exit 0; }',
    '{',
    ...dirs.map(d => `  (cd ${shq(d)} && docker compose config --images 2>/dev/null) || true`),
    '} | sort -u | while read -r img; do [ -z "$img" ] && continue',
    `  cur=$(docker image inspect --format '{{index .RepoDigests 0}}' "$img" 2>/dev/null | sed 's/.*@//')`,
    `  new=$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$img" 2>/dev/null || true)`,
    '  echo "HP_IMG $img ${cur:--} ${new:--}"',
    'done',
  ].join('\n')
}

export function parseDockerImages(output: string): { image: string; current: string; latest: string | null }[] {
  return output.split('\n')
    .map(l => /^HP_IMG (\S+) (\S+) (\S+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map(m => ({ image: m[1], current: m[2], latest: m[3] === '-' ? null : m[3] }))
}

/** Run inside the guest, so 127.0.0.1 means the guest itself. */
export function guestCheckScript(url: string): string {
  return [
    `u=${shq(url)}`,
    'if command -v curl >/dev/null 2>&1; then curl -fsS -m 15 -o /dev/null "$u"',
    'elif command -v wget >/dev/null 2>&1; then wget -q -T 15 -O /dev/null "$u"',
    'else echo "neither curl nor wget in the guest"; exit 2; fi',
    'echo "check answered: $u"',
  ].join('\n')
}

// --- Nodes ------------------------------------------------------------------------

/** One read-only round trip for everything the gates need from a node's shell. */
export const NODE_FACTS_COMMAND = [
  'echo "HP_FREE $(df -Pm / | awk \'NR==2{print $4}\')"',
  'echo "HP_KERNEL $(uname -r)"',
  '[ -f /var/run/reboot-required ] && echo HP_REBOOT_REQUIRED || true',
  'echo HP_HOLDS_BEGIN; apt-mark showhold 2>/dev/null || true; echo HP_HOLDS_END',
  'echo HP_PIN_BEGIN; proxmox-boot-tool kernel list 2>/dev/null || true; echo HP_PIN_END',
  'echo HP_KPKG_BEGIN; dpkg-query -W -f=\'${Package} ${Status}\\n\' \'proxmox-kernel-*\' \'pve-kernel-*\' 2>/dev/null || true; echo HP_KPKG_END',
  // A Ceph start fence (withCephStartGuard) that a killed run left behind.
  'if grep -qsF "HyperProx: no Ceph daemon starts" /usr/sbin/policy-rc.d; then echo HP_FENCE_LEFT; elif [ -e /usr/sbin/policy-rc.d.hyperprox-saved ]; then echo HP_FENCE_SAVED; fi',
].join('; ')

export interface NodeFacts {
  rootFreeMb:     number | null
  runningKernel:  string | null
  rebootRequired: boolean
  holds:          string[]
  pinned:         string | null
  /** Versioned kernel packages that are installed, e.g. proxmox-kernel-7.0.14-14-pve-signed. */
  kernelPackages: string[]
  /** A Ceph start fence left by an interrupted run: our policy-rc.d still in place, or only its saved original. */
  fence?:         'ours' | 'saved' | null
}

function between(lines: string[], begin: string, end: string): string[] {
  const a = lines.indexOf(begin), b = lines.indexOf(end)
  return a >= 0 && b > a ? lines.slice(a + 1, b) : []
}

export function parseNodeFacts(output: string): NodeFacts {
  const lines = output.split('\n').map(l => l.trim())
  const free = lines.find(l => l.startsWith('HP_FREE '))?.slice(8).trim()
  const kern = lines.find(l => l.startsWith('HP_KERNEL '))?.slice(10).trim()

  // `proxmox-boot-tool kernel list` prints "Pinned kernel:" followed by the version on the next line.
  const pinBlock = between(lines, 'HP_PIN_BEGIN', 'HP_PIN_END')
  let pinned: string | null = null
  const pi = pinBlock.findIndex(l => /^Pinned kernel:/i.test(l))
  if (pi >= 0) {
    const same = pinBlock[pi].replace(/^Pinned kernel:\s*/i, '').trim()
    pinned = same || (pinBlock[pi + 1] ?? '').trim() || null
  }

  const kernelPackages = between(lines, 'HP_KPKG_BEGIN', 'HP_KPKG_END')
    .filter(l => / install ok installed$/.test(l))
    .map(l => l.split(' ')[0])
    .filter(n => /^(proxmox|pve)-kernel-\d+\.\d+\.\d+-\d+-pve(-signed)?$/.test(n))

  return {
    rootFreeMb:     free && /^\d+$/.test(free) ? Number(free) : null,
    runningKernel:  kern || null,
    rebootRequired: lines.includes('HP_REBOOT_REQUIRED'),
    holds:          between(lines, 'HP_HOLDS_BEGIN', 'HP_HOLDS_END').filter(Boolean),
    pinned,
    kernelPackages,
    fence: lines.includes('HP_FENCE_LEFT') ? 'ours' : lines.includes('HP_FENCE_SAVED') ? 'saved' : null,
  }
}

/**
 * The node upgrade line. The only place `dist-upgrade` can come from, and it
 * takes the NODE'S POLICY, not a plan step: a node whose policy says `upgrade`
 * cannot be given anything else, whatever a stored plan claims.
 */
export function nodeUpgradeCommand(policyUpgrade: 'upgrade' | 'dist-upgrade'): string {
  const verb = policyUpgrade === 'dist-upgrade' ? 'dist-upgrade' : 'upgrade'
  return withCephStartGuard(`apt-get -y -q ${CONFOLD} ${verb}`)
}

/**
 * Read-only: what the node upgrade would do, without doing it. The end marker proves the simulation finished;
 * the line ends with it so that nothing matching the real upgrade line can be mistaken for it.
 */
export function nodeSimulateCommand(policyUpgrade: 'upgrade' | 'dist-upgrade'): string {
  const verb = policyUpgrade === 'dist-upgrade' ? 'dist-upgrade' : 'upgrade'
  return `${APT_ENV}; apt-get -s -q -o Debug::NoLocking=1 ${CONFOLD} ${verb} 2>&1; echo "HP_SIM_END $?"`
}

export interface AptSimChange {
  name: string; from: string | null; to: string | null; action: 'install' | 'upgrade' | 'remove'
  /** The new version comes from a -security suite. */
  security?: boolean
}

/**
 * `Inst`/`Remv`/`Purg` lines of `apt-get -s`. The shell exits 0 whatever apt did (echo runs last), so apt's own
 * status is the number after the marker: anything but 0, or no marker at all, is an error quoting apt's E: lines.
 */
export function parseAptSimulation(output: string): { changes: AptSimChange[]; error?: undefined } | { changes: null; error: string } {
  const lines = output.split('\n').map(l => l.trim())
  const marker = lines.map(l => /^HP_SIM_END (\d+)$/.exec(l)).find(Boolean)
  const errors = lines.filter(l => /^E: /.test(l)).join('; ')
  if (!marker) return { changes: null, error: `the simulation did not finish${errors ? `: ${errors}` : ''}` }
  if (marker[1] !== '0') return { changes: null, error: `apt-get exited ${marker[1]}${errors ? `: ${errors}` : ''}` }
  const out: AptSimChange[] = []
  for (const l of lines) {
    let m = /^Inst (\S+)(?: \[([^\]]+)\])? \((\S+)([^)]*)\)?/.exec(l)
    if (m) {
      const c: AptSimChange = { name: m[1].replace(/:.*/, ''), from: m[2] ?? null, to: m[3], action: m[2] ? 'upgrade' : 'install' }
      if (SECURITY_SUITE.test(m[4] ?? '')) c.security = true
      out.push(c)
      continue
    }
    m = /^(?:Remv|Purg) (\S+)(?: \[([^\]]+)\])?/.exec(l)
    if (m) out.push({ name: m[1].replace(/:.*/, ''), from: m[2] ?? null, to: null, action: 'remove' })
  }
  return { changes: out }
}

/** Marks the policy-rc.d HyperProx writes, so a copy left by a killed run is recognised and replaced. */
export const POLICY_RC_MARK = '# HyperProx: no Ceph daemon starts or restarts during a package upgrade'

/**
 * Run an apt command on a node with Ceph daemons fenced off from package scripts. A temporary
 * /usr/sbin/policy-rc.d refuses (101) every start and restart of a ceph unit — so a postinst
 * `deb-systemd-invoke start ceph-osd.target` cannot revive an OSD a person stopped on purpose, and nothing
 * restarts OSDs behind the runner's back — and defers to any policy-rc.d that was already there for
 * everything else. NEEDRESTART_SUSPEND keeps needrestart from restarting services. The previous
 * policy-rc.d is put back when the command ends, fails, or the shell is killed.
 */
export function withCephStartGuard(aptLine: string, sbin = '/usr/sbin'): string {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(sbin)) throw new Error(`not a directory path: ${sbin}`)
  return [
    APT_ENV,
    `P=${sbin}/policy-rc.d; B=${sbin}/policy-rc.d.hyperprox-saved`,
    // A copy of ours left by a run that was killed is replaced; a saved original is restored first.
    `if [ -e "$P" ] && grep -qF '${POLICY_RC_MARK}' "$P"; then rm -f "$P"; [ -e "$B" ] && mv "$B" "$P"; fi`,
    '[ -e "$B" ] && { echo "refusing: $B exists and is not ours to remove"; exit 1; }',
    '[ -e "$P" ] && mv "$P" "$B"',
    `printf '%s\\n' '#!/bin/sh' '${POLICY_RC_MARK}' 'for a in "$@"; do case "$a" in -*) ;; *) id="$a"; break ;; esac; done' 'case "$id" in ceph*) exit 101 ;; esac' '[ -x ${sbin}/policy-rc.d.hyperprox-saved ] && exec ${sbin}/policy-rc.d.hyperprox-saved "$@"' 'exit 0' > "$P"`,
    'chmod 755 "$P"',
    'unguard() { rm -f "$P"; [ -e "$B" ] && mv "$B" "$P"; }',
    'trap unguard EXIT',
    "trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM",
    aptLine,
  ].join('\n')
}

export const NODE_SERVICES_COMMAND = 'systemctl is-active pve-cluster pvedaemon pveproxy pvestatd'

/**
 * The same check on a remote cluster's node. The script guard (lib/clusters/script-guard.ts) refuses any script
 * that names the cluster filesystem service, so it is left out here; the Proxmox API answering afterwards (the
 * read-back) shows it is up, since nothing in the API works without it.
 */
export const REMOTE_NODE_SERVICES_COMMAND = 'systemctl is-active pvedaemon pveproxy pvestatd'

// --- What a node upgrade means, from apt's simulation -----------------------------

const NODE_KERNEL = /^(proxmox-kernel-|pve-kernel-|proxmox-default-kernel$|linux-image-)/
const NODE_FIRMWARE = /^(pve-firmware|proxmox-firmware|firmware-|intel-microcode$|amd64-microcode$)/
const NODE_PVE_CORE = /^(proxmox-ve|pve-manager|pve-cluster|pve-container|qemu-server|pve-qemu-kvm|proxmox-backup-client|libpve-)/

export interface NodeChangeSummary { kernel: boolean; firmware: boolean; proxmoxVe: boolean; rebootAfter: boolean; removals: string[] }

/** Whether the simulated changes bring a kernel, firmware or core Proxmox package, and so need a reboot after. */
export function summariseNodeChanges(changes: AptSimChange[]): NodeChangeSummary {
  const moved = changes.filter(c => c.action !== 'remove')
  const kernel = moved.some(c => NODE_KERNEL.test(c.name))
  const firmware = moved.some(c => NODE_FIRMWARE.test(c.name))
  return {
    kernel, firmware,
    proxmoxVe: changes.some(c => NODE_PVE_CORE.test(c.name)),
    rebootAfter: kernel || firmware,
    removals: changes.filter(c => c.action === 'remove').map(c => c.name).sort(),
  }
}

/** Read-only: the installed version of each package, for the read-back after an upgrade. */
export function installedVersionsCommand(names: string[]): string {
  const ok = names.filter(n => /^[a-z0-9][a-z0-9+.-]*$/.test(n))
  if (!ok.length) return 'echo HP_VERSIONS_BEGIN; echo HP_VERSIONS_END'
  return `echo HP_VERSIONS_BEGIN; dpkg-query -W -f='\${Package} \${Version} \${db:Status-Abbrev}\n' ${ok.map(shq).join(' ')} 2>/dev/null; echo HP_VERSIONS_END`
}

/** Package -> installed version (only packages dpkg reports as installed, `ii`). */
export function parseInstalledVersions(output: string): Record<string, string> {
  const lines = output.split('\n').map(l => l.trim())
  const out: Record<string, string> = {}
  for (const l of between(lines, 'HP_VERSIONS_BEGIN', 'HP_VERSIONS_END')) {
    const m = /^(\S+) (\S+) ii\s*$/.exec(l)
    if (m) out[m[1].replace(/:.*/, '')] = m[2]
  }
  return out
}

/**
 * Compare what apt said it would do with what dpkg now reports. Plain sentences, one per package that did not
 * land where the simulation said it would.
 */
export function readBackProblems(planned: AptSimChange[], installed: Record<string, string>): string[] {
  const out: string[] = []
  for (const c of planned) {
    if (c.action === 'remove') { if (installed[c.name]) out.push(`${c.name} was to be removed and is still installed (${installed[c.name]})`); continue }
    const now = installed[c.name]
    if (!now) out.push(`${c.name} is not installed (expected ${c.to})`)
    else if (now !== c.to) out.push(`${c.name} is at ${now}, expected ${c.to}`)
  }
  return out
}

/** Install exact versions so every node lands on the same Ceph; refuse anything that would remove a package. */
export function cephInstallCommand(pkgs: { name: string; to: string }[]): string {
  const spec = pkgs.map(p => shq(`${p.name}=${p.to}`)).join(' ')
  return withCephStartGuard(`apt-get -y -q ${CONFOLD} --no-remove --only-upgrade install ${spec}`)
}

/** Mons and mgrs only. OSDs are never restarted by target: that takes every OSD on the node down at once. */
export function cephRestartCommand(daemon: 'mon' | 'mgr'): string {
  return `if systemctl list-unit-files ceph-${daemon}.target >/dev/null 2>&1; then systemctl restart ceph-${daemon}.target; else echo "no ceph-${daemon} on this node"; fi`
}

/** One OSD. The id is a number by construction; anything else is refused before it reaches a shell. */
export function cephOsdRestartCommand(id: number): string {
  if (!Number.isInteger(id) || id < 0) throw new Error(`not an OSD id: ${id}`)
  return `systemctl restart ceph-osd@${id}.service`
}

/** Read-only: pools (size, min_size), the CRUSH tree, every PG's OSDs, and per-pool usage. Parsed by parseCephLayout. */
export const CEPH_LAYOUT_COMMAND = [
  'echo HP_POOLS; ceph osd pool ls detail -f json 2>/dev/null; echo',
  'echo HP_TREE; ceph osd tree -f json 2>/dev/null; echo',
  'echo HP_PGS; ceph pg dump pgs_brief -f json 2>/dev/null; echo',
  'echo HP_DF; ceph df -f json 2>/dev/null; echo',
  'echo HP_META; ceph osd metadata -f json 2>/dev/null; echo',
  'echo HP_EC; for p in $(ceph osd erasure-code-profile ls 2>/dev/null); do echo "$p $(ceph osd erasure-code-profile get "$p" -f json 2>/dev/null)"; done',
  'echo HP_END',
].join('; ')

/** Read-only: the instances of a Ceph daemon that exist on this node, e.g. ceph-osd@3.service. */
export function cephUnitsCommand(daemon: 'mon' | 'mgr' | 'osd' | 'mds'): string {
  // No pipe: the listing's own exit status is what HP_RC reports (parseUnitListing).
  return `systemctl list-units 'ceph-${daemon}@*' --all --plain --no-legend; echo "HP_RC $?"`
}

/** Read-only: OSD up/in and flags, and every PG's state and OSDs. Parsed by parseCephState. */
export const CEPH_STATE_COMMAND = [
  'echo HP_OSDS; ceph osd dump -f json 2>/dev/null; echo',
  'echo HP_PGS; ceph pg dump pgs_brief -f json 2>/dev/null; echo',
  'echo HP_END',
].join('; ')

/** Read-only: the OSD map, for its flags (noout above all). */
export const CEPH_OSD_DUMP_COMMAND = 'ceph osd dump -f json 2>/dev/null'

/** Read-only. stdout is JSON; the exit code is not 0 when Ceph says no. */
export function cephOsdOkToStopCommand(ids: number[]): string {
  if (!ids.length || ids.some(id => !Number.isInteger(id) || id < 0)) throw new Error(`not OSD ids: ${ids.join(',')}`)
  return `ceph osd ok-to-stop ${ids.join(' ')} -f json 2>/dev/null; echo "HP_RC $?"`
}

/** Read-only. Mons and MDSs answer in words; mgrs have no such check. */
export function cephDaemonOkToStopCommand(daemon: 'mon' | 'mds', ids: string[]): string {
  return `ceph ${daemon} ok-to-stop ${ids.map(shq).join(' ')} 2>&1; echo "HP_RC $?"`
}

export const CEPH_NOOUT_SET   = 'ceph osd set noout'
export const CEPH_NOOUT_UNSET = 'ceph osd unset noout'
export const haMaintenance = (node: string, on: boolean) =>
  `ha-manager crm-command node-maintenance ${on ? 'enable' : 'disable'} ${shq(node)}`
export const NODE_REBOOT_COMMAND = 'systemctl reboot'

export function haSetState(sid: string, state: 'started' | 'stopped'): string {
  return `ha-manager set ${shq(sid)} --state ${state}`
}

export function guestRebootCommand(type: 'lxc' | 'qemu', vmid: number): string {
  return `${type === 'qemu' ? 'qm' : 'pct'} reboot ${vmid}`
}

function kernelVersion(pkg: string): string {
  return pkg.replace(/^(proxmox|pve)-kernel-/, '').replace(/-signed$/, '')
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(n => Number(n) || 0)
  const pb = b.split(/[.-]/).map(n => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/**
 * Kernel packages to purge: everything except the running kernel, the pinned one,
 * the newest other (the one fallback, or the new kernel not yet booted), and
 * anything held.
 */
export function kernelsToRemove(facts: NodeFacts): string[] {
  // Without knowing what runs, removing anything is a guess.
  if (!facts.runningKernel) return []
  const keep = new Set<string>([facts.runningKernel])
  if (facts.pinned) keep.add(facts.pinned)
  const others = [...new Set(facts.kernelPackages.map(kernelVersion))]
    .filter(v => !keep.has(v))
    .sort((a, b) => compareVersions(b, a))
  if (others.length) keep.add(others[0])
  return facts.kernelPackages
    .filter(p => !keep.has(kernelVersion(p)) && !facts.holds.includes(p))
    .sort()
}

/**
 * Purge exactly those packages and clean the cache. apt is asked first what the
 * purge would take with it; if that is anything beyond the listed kernels (a
 * metapackage that depends on one, say), nothing is removed.
 */
export function kernelPurgeCommand(pkgs: string[]): string {
  if (!pkgs.length) return `${APT_ENV}; apt-get clean; echo "no old kernels to remove"`
  const list = pkgs.map(shq).join(' ')
  return [
    APT_ENV,
    `sim=$(apt-get -s purge ${list} | awk '/^Purg /{print $2}' | sort)`,
    `want=$(printf '%s\\n' ${list} | sort)`,
    '[ "$sim" = "$want" ] || { echo "refusing: the purge would also remove: $(comm -23 <(echo "$sim") <(echo "$want") | tr "\\n" " ")"; exit 1; }',
    `apt-get -y -q purge ${list}`,
    'apt-get clean',
  ].join('; ')
}

export function tail(text: string, max = 4000): string {
  return text.length <= max ? text : '…' + text.slice(-max)
}
