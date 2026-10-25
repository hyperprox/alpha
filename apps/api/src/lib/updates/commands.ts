// =============================================================================
//  HyperProx — Updates: the exact commands, and how their output is read
//
//  Every shell line this feature sends to a node or a guest is built here, so
//  there is one file to read to know what an update run can do to a machine,
//  and the parsers sit next to the commands whose output they read.
// =============================================================================

import type { UpdatesPkgChange } from './types'

const APT_ENV = 'export DEBIAN_FRONTEND=noninteractive LC_ALL=C'
// Keep the local version of any config file the admin changed; never stop to ask.
const CONFOLD = '-o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef'

// --- Packages that change how a run must treat a node ------------------------------

const CEPH_PKG   = /^(ceph(-[a-z0-9-]+)?|librados2|librbd1|libcephfs2|libradosstriper1|librgw2|python3-(ceph[a-z0-9-]*|rados|rbd|cephfs|rgw)|radosgw|rbd-(nbd|fuse|mirror))$/
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
const APT_LINE = /^([^\s/]+)\/\S+\s+(\S+)\s+\S+(?:\s+\[upgradable from:\s*([^\]]+)\])?/

export function parseGuestPending(output: string): GuestPendingResult {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.includes('HP_NO_APT')) return { noApt: true, pending: [], keptBack: [], rebootRequired: false }
  const pending: UpdatesPkgChange[] = []
  const keptBack: string[] = []
  for (const l of lines) {
    if (l.startsWith('HP_KEPT ')) { keptBack.push(l.slice(8).trim()); continue }
    const m = APT_LINE.exec(l)
    if (m) pending.push({ name: m[1], from: m[3]?.trim() ?? null, to: m[2] })
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
].join('; ')

export interface NodeFacts {
  rootFreeMb:     number | null
  runningKernel:  string | null
  rebootRequired: boolean
  holds:          string[]
  pinned:         string | null
  /** Versioned kernel packages that are installed, e.g. proxmox-kernel-7.0.14-14-pve-signed. */
  kernelPackages: string[]
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
  }
}

/**
 * The node upgrade line. The only place `dist-upgrade` can come from, and it
 * takes the NODE'S POLICY, not a plan step: a node whose policy says `upgrade`
 * cannot be given anything else, whatever a stored plan claims.
 */
export function nodeUpgradeCommand(policyUpgrade: 'upgrade' | 'dist-upgrade'): string {
  const verb = policyUpgrade === 'dist-upgrade' ? 'dist-upgrade' : 'upgrade'
  return `${APT_ENV}; apt-get -y -q ${CONFOLD} ${verb}`
}

export const NODE_SERVICES_COMMAND = 'systemctl is-active pve-cluster pvedaemon pveproxy pvestatd'

/** Install exact versions so every node lands on the same Ceph; refuse anything that would remove a package. */
export function cephInstallCommand(pkgs: { name: string; to: string }[]): string {
  const spec = pkgs.map(p => shq(`${p.name}=${p.to}`)).join(' ')
  return `${APT_ENV}; apt-get -y -q ${CONFOLD} --no-remove --only-upgrade install ${spec}`
}

export function cephRestartCommand(daemon: 'mon' | 'mgr' | 'osd'): string {
  return `if systemctl list-unit-files ceph-${daemon}.target >/dev/null 2>&1; then systemctl restart ceph-${daemon}.target; else echo "no ceph-${daemon} on this node"; fi`
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
