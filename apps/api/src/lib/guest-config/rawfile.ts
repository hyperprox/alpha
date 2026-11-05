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

/** Proxmox's raw-line grammar (PVE::LXC::Config::parse_pct_config). */
const RAW_LINE = /^\s*(lxc\.[a-z0-9_\-.]+)(:|\s*=)\s*(.*?)\s*$/
const SECTION = /^\[([^\]]+)\]\s*$/

export function parseRawLine(line: string): [string, string] | null {
  const m = RAW_LINE.exec(line.replace(/\r$/, ''))
  return m ? [m[1], m[3]] : null
}

// ── what may be written ───────────────────────────────────────────────────────

export const ALLOWED_KEYS = ['lxc.cgroup2.devices.allow', 'lxc.cgroup.devices.allow', 'lxc.mount.entry'] as const
const DEV_PATH = /^\/dev\/(?!.*\.\.)[A-Za-z0-9_.:+-]+(\/[A-Za-z0-9_.:+-]+)*$/
const CGROUP = /^c (\d+|\*):(\d+|\*) [rwm]{1,3}$/
const MOUNT_OPTS = /^bind(,(optional|create=(file|dir)|ro|rw|nosuid|noexec|nodev|mode=0?[0-7]{3,4}|uid=\d{1,5}|gid=\d{1,5}))*$/
export const NOT_A_DEVICE_LINE = 'HyperProx only edits device lines; hooks and other raw settings run as root on the node.'

/** null when HyperProx may write this line; otherwise the reason, in words. */
export function rawLineAllowed([k, v]: [string, string]): string | null {
  if (!(ALLOWED_KEYS as readonly string[]).includes(k)) return `${k}: ${NOT_A_DEVICE_LINE}`
  if (/[\r\n\0]/.test(v)) return 'A raw line must be one line.'
  if (k === 'lxc.mount.entry') {
    const parts = v.trim().split(/\s+/)
    if (parts.length < 4 || parts.length > 6) return `${k}: not the device bind form “/dev/X dev/X none bind,optional,create=file”.`
    const [src, dst, fstype, opts] = parts
    if (!DEV_PATH.test(src)) return `${k}: only /dev device nodes are bound (${src} is not one).`
    if (dst !== src.slice(1)) return `${k}: a device is bound onto the same path inside (${src.slice(1)}), not ${dst}.`
    if (fstype !== 'none' || !MOUNT_OPTS.test(opts)) return `${k}: not the device bind form “/dev/X dev/X none bind,optional,create=file”.`
    if (parts.slice(4).some(x => !/^\d+$/.test(x))) return `${k}: not the device bind form.`
    return null
  }
  if (!CGROUP.test(v.trim())) return `${k}: only character-device allows of the form “c MAJOR:MINOR rwm”.`
  return null
}

// ── the file ──────────────────────────────────────────────────────────────────

export interface ConfSplit {
  /** Raw lxc.* lines of the main section, in order, as Proxmox parses them. */
  rawMain: Array<[string, string]>
  /** Snapshot (and other) section names, in order. */
  sections: string[]
  hasPending: boolean
  /** The main section's `lock:` value (backup, migrate, snapshot...), if any. */
  lock: string | null
  eol: '\n' | '\r\n'
}

function lines(text: string): { ls: string[]; eol: '\n' | '\r\n' } {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n'
  return { ls: text.split(eol), eol }
}

function mainEnd(ls: string[]): number {
  const i = ls.findIndex(l => SECTION.test(l))
  return i < 0 ? ls.length : i
}

export function splitConf(text: string): ConfSplit {
  const { ls, eol } = lines(text)
  const end = mainEnd(ls)
  const rawMain: Array<[string, string]> = []
  let lock: string | null = null
  for (const l of ls.slice(0, end)) {
    const r = parseRawLine(l)
    if (r) rawMain.push(r)
    const m = /^lock:\s*(\S+)/.exec(l)
    if (m) lock = m[1]
  }
  const sections = ls.filter(l => SECTION.test(l)).map(l => SECTION.exec(l)![1])
  return { rawMain, sections, hasPending: sections.includes('pve:pending'), lock, eol }
}

export interface RawChange { remove?: Array<[string, string]>; add?: Array<[string, string]> }

/**
 * The file with exactly these raw lines removed from and added to its main section. A line is matched by its
 * parsed key and value (however it is written); every other byte is kept. New lines go after the main section's
 * last line, with the file's own line ending.
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
    const why = rawLineAllowed(l)
    if (why) throw new Error(why)
  }
  const { ls, eol } = lines(text)
  const end = mainEnd(ls)
  const main = ls.slice(0, end), rest = ls.slice(end)
  for (const [k, v] of remove) {
    const i = main.findIndex(l => { const r = parseRawLine(l); return !!r && r[0] === k && r[1] === v })
    if (i < 0) throw new Error(`${k}: ${v} is not in the main section.`)
    main.splice(i, 1)
  }
  let at = main.length
  while (at > 0 && main[at - 1] === '') at--
  main.splice(at, 0, ...add.map(([k, v]) => `${k}: ${v}`))
  return [...main, ...rest].join(eol)
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

/** Read the file and its hash (base64, so no byte is lost), and list temp files an earlier run left behind. */
export function readScript(node: string, vmid: number): string {
  const f = confPath(node, vmid)
  return [
    'set -eu', `f='${f}'`, '# HPX read config file',
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
export function writeScript(node: string, vmid: number, expectSha: string, content: string): string {
  const f = confPath(node, vmid)
  if (!/^[0-9a-f]{64}$/.test(expectSha)) throw new Error('Bad hash.')
  const b64 = Buffer.from(content, 'utf8').toString('base64')
  return [
    'set -eu',
    `f='${f}'`,
    '# HPX write config file',
    ...takeLock(vmid),
    `cur=$(sha256sum "$f" | cut -d' ' -f1)`,
    `if [ "$cur" != '${expectSha}' ]; then echo "HPX-CAS-MISMATCH $cur"; exit 3; fi`,
    `if sed -n '/^\\[/q;p' "$f" | grep -q '^lock:'; then echo HPX-GUEST-LOCKED; exit 5; fi`,
    `t="$f.tmp.hpx.$$"`,
    `trap 'rm -f "$t"' EXIT`,
    `printf '%s' '${b64}' | base64 -d > "$t"`,
    `mv -f "$t" "$f"`,
    'base64 -w0 "$f"; echo',
    `sha256sum "$f" | cut -d' ' -f1`,
    '',
  ].join('\n')
}
