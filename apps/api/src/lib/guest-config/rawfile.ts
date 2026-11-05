// =============================================================================
//  HyperProx — writing raw lxc.* device lines, which the Proxmox API refuses
//
//  The API accepts no lxc.* key from any caller (token or root@pam, measured).
//  The owner decided (2026-11-05) that only these lines may be written by
//  rewriting the guest's whole config file over the node login, and only with
//  these guards:
//    * only device lines: lxc.cgroup2.devices.allow / lxc.cgroup.devices.allow
//      for character devices, and lxc.mount.entry binds of /dev nodes onto the
//      same path inside. Hooks, AppArmor, idmaps, capabilities and every other
//      raw setting are shown and refused: they run as root on the node;
//    * the file's sha256 at preview must be the file's sha256 at apply (compare
//      and swap), checked again inside the node script under Proxmox's own
//      config lock (/run/lock/lxc/pve-config-<vmid>.lock), held to the rename;
//    * never while the cluster is not quorate, never when the file has a
//      [pve:pending] section or a `lock:` key (backup, migrate, snapshot...);
//    * only the main section's lxc.* lines change; snapshot sections and every
//      other line stay byte for byte, CRLF files keep CRLF;
//    * written to a temp file in the same directory and renamed (as Proxmox's
//      file_set_contents does), removed on every failure path; never appended,
//      never edited in place;
//    * read back afterwards and compared byte for byte, then read through the
//      API to prove Proxmox still parses it.
//  Lines are parsed the way Proxmox parses them: keys may hold '-', the
//  separator may be ':' or '=', and whitespace around the value is trimmed.
// =============================================================================

import { createHash } from 'node:crypto'

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/** Proxmox's raw-line grammar (PVE::LXC::Config::parse_pct_config): no leading whitespace, ':' or '=', trimmed. */
const RAW_LINE = /^(lxc\.[a-z0-9_\-.]+)(:|\s*=)\s*(.*?)\s*$/
const PENDING = /^\[pve:pending\]\s*$/i
const SNAPSHOT = /^\[([a-z][a-z0-9_\-]+)\]\s*$/i
const isSection = (l: string) => PENDING.test(l) || SNAPSHOT.test(l)

export function parseRawLine(line: string): [string, string] | null {
  const m = RAW_LINE.exec(line)
  return m ? [m[1], m[3]] : null
}

/** Which raw keys Proxmox keeps in a guest's `lxc` array (is_valid_lxc_conf_key; runtime env goes to `env`). */
const PVE_KEYS = new Set(['lxc.apparmor.profile', 'lxc.apparmor.allow_incomplete', 'lxc.apparmor.allow_nesting', 'lxc.apparmor.raw',
  'lxc.selinux.context', 'lxc.include', 'lxc.arch', 'lxc.uts.name', 'lxc.signal.halt', 'lxc.signal.reboot', 'lxc.signal.stop',
  'lxc.init.cmd', 'lxc.init.cwd', 'lxc.init.uid', 'lxc.init.gid', 'lxc.init.groups', 'lxc.pty.max', 'lxc.console.logfile',
  'lxc.console.path', 'lxc.tty.max', 'lxc.devtty.dir', 'lxc.hook.autodev', 'lxc.autodev', 'lxc.kmsg', 'lxc.mount.fstab',
  'lxc.mount.entry', 'lxc.mount.auto', 'lxc.rootfs.mount', 'lxc.cap.drop', 'lxc.cap.keep', 'lxc.seccomp.profile',
  'lxc.seccomp.notify.proxy', 'lxc.seccomp.notify.cookie', 'lxc.idmap', 'lxc.hook.pre-start', 'lxc.hook.pre-mount',
  'lxc.hook.mount', 'lxc.hook.start', 'lxc.hook.stop', 'lxc.hook.post-stop', 'lxc.hook.clone', 'lxc.hook.destroy',
  'lxc.hook.version', 'lxc.log.level', 'lxc.log.file', 'lxc.start.auto', 'lxc.start.delay', 'lxc.start.order', 'lxc.group',
  'lxc.environment', 'lxc.environment.hooks', 'lxc.sysctl.fs.mqueue', 'lxc.sysctl.kernel.msgmax', 'lxc.sysctl.kernel.msgmnb',
  'lxc.sysctl.kernel.msgmni', 'lxc.sysctl.kernel.sem', 'lxc.sysctl.kernel.shmall', 'lxc.sysctl.kernel.shmmax',
  'lxc.sysctl.kernel.shmmni', 'lxc.sysctl.kernel.shm_rmid_forced'])
const PVE_DEPRECATED = /^lxc\.(aa_profile|aa_allow_incomplete|console|devttydir|haltsignal|rebootsignal|stopsignal|id_map|init_cmd|loglevel|logfile|mount|network\.(type|flags|link|mtu|name|hwaddr|ipv4|ipv4\.gateway|ipv6|ipv6\.gateway|script\.up|script\.down)|pts|se_context|seccomp|tty|utsname)$/
export function pveKeepsRawKey(k: string): boolean {
  if (k === 'lxc.environment.runtime' || k === 'lxc.rootfs.path' || k === 'lxc.rootfs.options') return false
  return /^lxc\.limit\./.test(k) || PVE_DEPRECATED.test(k) || PVE_KEYS.has(k) || /^lxc\.(cgroup|cgroup2|prlimit|net)\./.test(k)
}

// ── what may be written ───────────────────────────────────────────────────────

export const ALLOWED_KEYS = ['lxc.cgroup2.devices.allow', 'lxc.cgroup.devices.allow', 'lxc.mount.entry'] as const
const MOUNT_OPTS = /^bind(,(optional|create=(file|dir)|ro|rw|nosuid|noexec|nodev|mode=0?[0-7]{3,4}|uid=\d{1,5}|gid=\d{1,5}))*$/
const CGROUP_FORM = /^(a|[cb] (\d+|\*):(\d+|\*) [rwm]{1,3})$/
export const NOT_A_DEVICE_LINE = 'HyperProx only edits device lines; hooks and other raw settings run as root on the node.'
/** The only directories that may be bound: the GPU device directories. */
export const DEVICE_DIRS = ['/dev/dri', '/dev/nvidia-caps']

/** What the node actually has: character device nodes (not symlinks) from its inventory, and their majors. */
export interface RawAllow { devices: Set<string>; majors: Set<number> }

/**
 * The form of a device line: the key is one of the three device keys, and the value has the device-line shape.
 * Enough to remove a line; adding one also needs rawLineAllowed().
 */
export function rawLineForm([k, v]: [string, string]): string | null {
  if (!(ALLOWED_KEYS as readonly string[]).includes(k)) return `${k}: ${NOT_A_DEVICE_LINE}`
  if (/[\r\n\0]/.test(v)) return 'A raw line must be one line.'
  if (k === 'lxc.mount.entry') {
    const parts = v.trim().split(/\s+/)
    if (parts.length < 4 || parts.length > 6) return `${k}: not the device bind form “/dev/X dev/X none bind,optional,create=file”.`
    const [src, dst, fstype, opts] = parts
    if (!src.startsWith('/dev/')) return `${k}: only /dev device nodes are bound (${src} is not one).`
    if (dst !== src.slice(1)) return `${k}: a device is bound onto the same path inside (${src.slice(1)}), not ${dst}.`
    if (fstype !== 'none' || !MOUNT_OPTS.test(opts) || parts.slice(4).some(x => !/^\d+$/.test(x))) return `${k}: not the device bind form “/dev/X dev/X none bind,optional,create=file”.`
    return null
  }
  if (!CGROUP_FORM.test(v.trim())) return `${k}: not a device allow of the form “c MAJOR:MINOR rwm”.`
  return null
}

const HOST_MEMORY = /^\/dev\/(mem|kmem|port)$/
const NOT_DEVICES = /^\/dev\/(shm|pts|fd|mqueue|hugepages|core|stdin|stdout|stderr|net|serial|v4l|block|char|bsg|mapper|vfio|cpu|input|bus)(\/|$)/

/** null when HyperProx may add this line on a node with `allow`; otherwise the reason, in words. */
export function rawLineAllowed(l: [string, string], allow: RawAllow | null): string | null {
  const form = rawLineForm(l)
  if (form) return form
  const [k, v] = l
  if (k === 'lxc.mount.entry') {
    const parts = v.trim().split(/\s+/)
    const src = parts[0], opts = parts[3]
    if (src.split('/').some(seg => seg === '.' || seg === '..')) return `${k}: a path with “.” or “..” segments is refused (${src}).`
    if (HOST_MEMORY.test(src)) return `${k}: ${src} is host memory or I/O ports; it is never passed to a container.`
    if (/^\/dev\/disk(\/|$)/.test(src) || /^\/dev\/(sd|nvme|vd|hd|xvd|md|dm-|loop|nbd|zd|rbd)/.test(src)) return `${k}: disks are out of scope; ${src} is never bound.`
    if (DEVICE_DIRS.includes(src)) {
      if (!/create=dir/.test(opts)) return `${k}: a device directory is bound with create=dir.`
      return null
    }
    if (NOT_DEVICES.test(src) && !(allow?.devices.has(src))) return `${k}: ${src} is not a device node (it is a directory or a link), so it is refused.`
    if (!allow) return `${k}: there is no device inventory for this node to check ${src} against.`
    if (!allow.devices.has(src)) return `${k}: ${src} is not in the node’s device inventory as a character device, so it is refused.`
    if (/create=dir/.test(opts)) return `${k}: a device node is bound with create=file, not create=dir.`
    return null
  }
  const t = v.trim()
  if (t === 'a' || /^[cb] \*:/.test(t)) return `${k}: “${t}” allows every device; only one device major is allowed at a time.`
  if (t.startsWith('b ')) return `${k}: block devices are refused (“${t}”).`
  const m = /^c (\d+):(\d+|\*) ([rwm]+)$/.exec(t)
  if (!m) return `${k}: not a device allow of the form “c MAJOR:MINOR rwm”.`
  if (m[3] !== 'rwm') return `${k}: device allows are written as rwm (“${t}”).`
  if (!allow) return `${k}: there is no device inventory for this node to check major ${m[1]} against.`
  if (!allow.majors.has(Number(m[1]))) return `${k}: major ${m[1]} is not a GPU or inventory device on this node, so it is refused.`
  return null
}

// ── the file ──────────────────────────────────────────────────────────────────

export interface ConfSplit {
  /** Raw lxc.* lines of the main section, in order, exactly as Proxmox's API returns them. */
  rawMain: Array<[string, string]>
  /** Snapshot (and other) section names, in order. */
  sections: string[]
  /** A [pve:pending] section, matched case-insensitively as Proxmox does. */
  hasPending: boolean
  /** The main section's `lock:` value (backup, migrate, snapshot...), if any. */
  lock: string | null
}

/** Split on "\n" as Proxmox does; a line keeps its own "\r" when it had one, so mixed endings survive. */
const lines = (text: string) => text.split('\n')
const content = (l: string) => l.replace(/\r$/, '')

function mainEnd(ls: string[]): number {
  const i = ls.findIndex(l => isSection(content(l)))
  return i < 0 ? ls.length : i
}

export function splitConf(text: string): ConfSplit {
  const ls = lines(text)
  const end = mainEnd(ls)
  const rawMain: Array<[string, string]> = []
  let lock: string | null = null
  for (const l of ls.slice(0, end)) {
    const r = parseRawLine(l)
    if (r && pveKeepsRawKey(r[0])) rawMain.push(r)
    const m = /^lock:\s*(\S+)/.exec(content(l))
    if (m) lock = m[1]
  }
  const sections = ls.map(content).filter(isSection).map(l => (PENDING.test(l) ? 'pve:pending' : SNAPSHOT.exec(l)![1]))
  return { rawMain, sections, hasPending: ls.some(l => PENDING.test(content(l))), lock }
}

export interface RawChange { remove?: Array<[string, string]>; add?: Array<[string, string]> }

/**
 * The file with exactly these raw lines removed from and added to its main section. A line is matched by its
 * parsed key and value (however it is written); every other byte is kept. New lines go after the main section's
 * last line and take that line's ending. Adds must have passed rawLineAllowed() against the node's inventory;
 * this checks the device-line form again for both.
 */
export function rewriteRawLines(text: string, ch: RawChange): string {
  const remove = ch.remove ?? [], add = ch.add ?? []
  if (!remove.length && !add.length) return text
  const sp = splitConf(text)
  if (sp.hasPending) throw new Error('The file has a [pve:pending] section; HyperProx does not rewrite it. Restart the guest (or apply its pending changes) first.')
  if (sp.lock) throw new Error(`The guest is locked (${sp.lock}); HyperProx does not rewrite its file until that finishes.`)
  for (const l of [...remove, ...add]) {
    if (!/^lxc\./.test(l[0])) throw new Error(`Only lxc.* lines are written this way (not ${l[0]}).`)
    if (/[\r\n\0]/.test(l[1]) || /[\r\n\0]/.test(l[0])) throw new Error('A raw line must be one line.')
    const why = rawLineForm(l)
    if (why) throw new Error(why)
  }
  const ls = lines(text)
  const end = mainEnd(ls)
  const main = ls.slice(0, end), rest = ls.slice(end)
  for (const [k, v] of remove) {
    const i = main.findIndex(l => { const r = parseRawLine(l); return !!r && r[0] === k && r[1] === v })
    if (i < 0) throw new Error(`${k}: ${v} is not in the main section.`)
    main.splice(i, 1)
  }
  let at = main.length
  while (at > 0 && /^\s*$/.test(main[at - 1])) at--
  const cr = at > 0 && main[at - 1].endsWith('\r') ? '\r' : ''
  main.splice(at, 0, ...add.map(([k, v]) => `${k}: ${v}${cr}`))
  return [...main, ...rest].join('\n')
}

/** Mount sources of the lines being added: what the node must verify itself. */
export function addedSources(add: Array<[string, string]>): string[] {
  return [...new Set(add.filter(([k]) => k === 'lxc.mount.entry').map(([, v]) => v.trim().split(/\s+/)[0]))]
}

// ── the node scripts ──────────────────────────────────────────────────────────

const NODE = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/
function confPath(node: string, vmid: number): string {
  if (!NODE.test(node) || !Number.isInteger(vmid) || vmid < 100 || vmid > 999999999) throw new Error('Not a guest this writer can address.')
  return `/etc/pve/nodes/${node}/lxc/${vmid}.conf`
}
const lockFile = (vmid: number) => `/run/lock/lxc/pve-config-${vmid}.lock`
/** Proxmox's own config lock for this guest, waited for up to 10 s. Held until the script exits. */
const takeLock = (vmid: number) => [
  'mkdir -p /run/lock/lxc',
  `exec 9>'${lockFile(vmid)}'`,
  `flock -w 10 9 || { echo HPX-LOCK-TIMEOUT; exit 4; }`,
]

const SAFE_DEV = /^\/dev\/[A-Za-z0-9_.:+\/-]+$/

/** For each path: L (symlink), C (character device: hex major, realpath), D (directory, realpath), O (other), M (missing). */
export function verifyScript(paths: string[]): string {
  for (const p of paths) if (!SAFE_DEV.test(p)) throw new Error(`Not a device path HyperProx checks: ${p}`)
  return [
    'set -u', '# HPX verify devices',
    `for p in ${paths.map(p => `'${p}'`).join(' ')}; do`,
    '  if [ -L "$p" ]; then echo "L $p"',
    `  elif [ -c "$p" ]; then echo "C $p $(stat -c %t "$p") $(realpath -e -- "$p")"`,
    '  elif [ -d "$p" ]; then echo "D $p $(realpath -e -- "$p")"',
    '  elif [ -e "$p" ]; then echo "O $p"',
    '  else echo "M $p"; fi',
    'done', '',
  ].join('\n')
}

export type Verified = { kind: 'char'; major: number; real: string } | { kind: 'dir'; real: string } | { kind: 'symlink' } | { kind: 'other' } | { kind: 'missing' }
export function parseVerify(out: string): Record<string, Verified> {
  const r: Record<string, Verified> = {}
  for (const l of out.split('\n')) {
    const [t, p, a, b] = l.trim().split(/\s+/)
    if (!p) continue
    if (t === 'C') r[p] = { kind: 'char', major: parseInt(a, 16), real: b }
    else if (t === 'D') r[p] = { kind: 'dir', real: a }
    else if (t === 'L') r[p] = { kind: 'symlink' }
    else if (t === 'O') r[p] = { kind: 'other' }
    else if (t === 'M') r[p] = { kind: 'missing' }
  }
  return r
}

/**
 * Read the file and its hash (base64, so no byte is lost), and list temp files an earlier run left behind.
 * `locked`: take the config lock first, so a write still in flight finishes before the read (after a dropped session).
 */
export function readScript(node: string, vmid: number, opts: { locked?: boolean } = {}): string {
  const f = confPath(node, vmid)
  return [
    'set -eu', `f='${f}'`, '# HPX read config file', ...(opts.locked ? takeLock(vmid) : []),
    'base64 -w0 "$f"; echo', `sha256sum "$f" | cut -d' ' -f1`,
    'for x in "$f".tmp.hpx.*; do [ -e "$x" ] && echo "HPX-LEFTOVER $x"; done; true', '',
  ].join('\n')
}

export function parseRead(out: string): { text: string; sha: string; leftovers: string[] } {
  const ls = out.trim().split('\n')
  const [b64, sha] = ls
  const text = Buffer.from(b64 ?? '', 'base64').toString('utf8')
  if (!sha || sha.trim() !== sha256(text)) throw new Error('The config file could not be read intact from the node.')
  const leftovers = ls.slice(2).map(l => /^HPX-LEFTOVER (\S+)$/.exec(l.trim())?.[1]).filter((x): x is string => !!x)
  return { text, sha: sha.trim(), leftovers }
}

/** Remove temp files an earlier, interrupted write left behind (exact names only, under the config lock). */
export function cleanupScript(node: string, vmid: number, files: string[]): string {
  const f = confPath(node, vmid)
  for (const x of files) if (!x.startsWith(`${f}.tmp.hpx.`) || !/^[A-Za-z0-9_./:-]+$/.test(x)) throw new Error('Only HyperProx temp files are removed.')
  return ['set -eu', `f='${f}'`, '# HPX clean config temp files', ...takeLock(vmid), ...files.map(x => `rm -f '${x}'`), 'echo HPX-CLEANED', ''].join('\n')
}

/**
 * Compare and swap under the config lock: refuse unless the file still has `expectSha` and carries no `lock:`,
 * write the new bytes to a temp file beside it (removed on any exit), rename over it, and print the new file
 * (base64) and its hash for the caller to compare.
 */
export function writeScript(node: string, vmid: number, expectSha: string, content: string, sources: string[] = []): string {
  const f = confPath(node, vmid)
  if (!/^[0-9a-f]{64}$/.test(expectSha)) throw new Error('Bad hash.')
  for (const p of sources) if (!SAFE_DEV.test(p)) throw new Error(`Not a device path HyperProx writes: ${p}`)
  // Every added source is checked again here, under the lock: never a symlink; if present, its realpath is itself
  // and it is a character device (or one of the GPU device directories). A missing one is an optional entry.
  const check = sources.length ? [
    `for p in ${sources.map(p => `'${p}'`).join(' ')}; do`,
    '  if [ -L "$p" ]; then echo "HPX-BAD-DEVICE $p"; exit 6; fi',
    '  if [ -e "$p" ]; then',
    '    [ "$(realpath -e -- "$p")" = "$p" ] || { echo "HPX-BAD-DEVICE $p"; exit 6; }',
    `    if [ -c "$p" ] || [ "$p" = /dev/dri ] || [ "$p" = /dev/nvidia-caps ]; then :; else echo "HPX-BAD-DEVICE $p"; exit 6; fi`,
    '  fi',
    'done',
  ] : []
  const b64 = Buffer.from(content, 'utf8').toString('base64')
  return [
    'set -eu',
    `f='${f}'`,
    '# HPX write config file',
    ...takeLock(vmid),
    `cur=$(sha256sum "$f" | cut -d' ' -f1)`,
    `if [ "$cur" != '${expectSha}' ]; then echo "HPX-CAS-MISMATCH $cur"; exit 3; fi`,
    `if sed -n '/^\\[/q;p' "$f" | grep -q '^lock:'; then echo HPX-GUEST-LOCKED; exit 5; fi`,
    `if grep -qi '^\\[pve:pending\\]' "$f"; then echo HPX-PENDING; exit 7; fi`,
    ...check,
    `t="$f.tmp.hpx.$$"`,
    `trap 'rm -f "$t"' EXIT`,
    `printf '%s' '${b64}' | base64 -d > "$t"`,
    `mv -f "$t" "$f"`,
    'base64 -w0 "$f"; echo',
    `sha256sum "$f" | cut -d' ' -f1`,
    '',
  ].join('\n')
}
