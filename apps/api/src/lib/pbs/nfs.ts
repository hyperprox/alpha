// =============================================================================
//  HyperProx — Proxmox Backup Server on a NAS: the NFS datastore
//
//  Where the catalogue's backup server keeps its backups when the person picks
//  "On a NAS" (the recommended choice: it is the only one that survives losing
//  the cluster).
//
//  NFS, never SMB/CIFS. Every PBS snapshot is named after its time, which has a
//  ':' in it ("vm/100/2026-01-01T02:00:00Z"). SMB cannot store ':' in a name, so
//  Samba mangles it, and PBS can no longer find its own snapshots: the datastore
//  looks empty or broken. No mount option fixes that, so an SMB share is refused
//  here outright rather than offered with a warning.
//
//  The mount is made on the HOST (the container's node only, never cluster-
//  wide) and handed into the container as a bind mountpoint. The container is
//  unprivileged, and an unprivileged container cannot mount NFS itself. A
//  privileged container could, but it would run PBS as real root on the node,
//  which is a much larger thing to hand a network service; the host mount keeps
//  the container unprivileged.
//
//  The fstab entry: rw,vers=3,hard,timeo=600,retrans=2,_netdev,nofail.
//  `hard` keeps a slow NAS from turning into silently failed writes; `_netdev`
//  waits for the network; `nofail` means a NAS that is off when the node boots
//  does not hang the node's boot (the backup server then simply has no
//  datastore until the NAS is back). Everything the mount script adds is marked
//  with the container's id and removed by the unmount script, so the step is
//  reversible.
//
//  Permissions. PBS runs as the user `backup` (uid 34) inside the container. In
//  an unprivileged container every uid is shifted by 100000 on the host, so on
//  the NAS that same user is uid 100034 (and its group 100034). The export must
//  let uid 100034 create files and directories (or squash every client user to
//  one that can, for example QNAP's "squash all users to admin" or an
//  all_squash with anonuid set to the owner of the share). PBS also needs 0755
//  on the datastore root and 0750 on .chunks and its 65,536 subdirectories,
//  which it sets itself when it creates the datastore, so an export that
//  rewrites modes breaks it. Setup tests a write as `backup` before it creates
//  anything, and stops with this explanation if the write fails.
// =============================================================================

import net from 'node:net'

export const NFS_OPTIONS = 'rw,vers=3,hard,timeo=600,retrans=2,_netdev,nofail'
/** Inside the container: /mnt/datastore/<name>, the path PBS's own GUI uses. */
export const DATASTORE_BASE = '/mnt/datastore'
/** On the node: one folder per container. */
export const HOST_BASE = '/mnt/hyperprox-pbs'

export const UID_NOTE =
  'PBS runs as the user "backup" (uid 34) inside the container. The container is unprivileged, so on the host and on the NAS that user is uid 100034 ' +
  '(34 + 100000), group 100034. Let uid 100034 write to the export (or squash all users to one that can write).'

export const SMB_REFUSAL =
  'A backup server cannot keep its datastore on an SMB/CIFS share: every PBS snapshot name contains ":", which SMB cannot store, so Samba mangles ' +
  'the names and PBS can no longer find its own backups. Turn on NFS for that share on the NAS and use its NFS export instead.'

export class NfsInputError extends Error { constructor(m: string) { super(m); this.name = 'NfsInputError' } }

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const EXPORT_RE = /^\/[A-Za-z0-9._+@-]+(?:\/[A-Za-z0-9._+@-]+)*\/?$|^\/$/
export const DATASTORE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$/

/** Does this look like an SMB/CIFS location rather than an NFS export? */
export function looksLikeSmb(host: string, path: string): boolean {
  const all = `${host} ${path}`.trim()
  return /^(smb|cifs):/i.test(host) || /^\\\\/.test(host) || /^\\\\/.test(path) || /^\/\/[^/]/.test(path) || /^(smb|cifs):/i.test(path) || /\\/.test(all)
}

/** The NAS host (an IP or a DNS name) and its export path, checked: what the mount and the probe use. */
export function cleanNfsSource(host: unknown, path: unknown): { host: string; path: string; source: string } {
  const h = typeof host === 'string' ? host.trim() : ''
  const p = typeof path === 'string' ? path.trim() : ''
  if (looksLikeSmb(h, p)) throw new NfsInputError(SMB_REFUSAL)
  const bare = h.replace(/^\[|\]$/g, '')
  if (!bare || (!net.isIP(bare) && !HOST_RE.test(bare))) throw new NfsInputError('The NAS is its IP address or name, such as 10.0.0.20 or nas.example.lan.')
  if (net.isIP(bare) === 6) throw new NfsInputError('Use the NAS\'s IPv4 address or name; HyperProx does not mount NFS over IPv6 yet.')
  if (!EXPORT_RE.test(p) || p.split('/').some(s => s === '..' || s === '.')) throw new NfsInputError('The export is the NFS path the NAS shares, such as /Backups (QNAP) or /volume1/backups (Synology).')
  const clean = p.length > 1 ? p.replace(/\/+$/, '') : p
  return { host: bare, path: clean, source: `${bare}:${clean}` }
}

export const hostMountPoint = (vmid: number) => `${HOST_BASE}/${vmid}`
const marker = (vmid: number) => `# hyperprox-pbs ${vmid}`

/** The fstab line for one container's datastore mount. */
export function fstabLine(src: { source: string }, vmid: number): string {
  return `${src.source} ${hostMountPoint(vmid)} nfs ${NFS_OPTIONS} 0 0 ${marker(vmid)}`
}

/** The container's mountpoint: a bind of the host mount, at /mnt/datastore/<name>. Not in vzdump (backups of backups). */
export function bindMountpoint(vmid: number, datastore: string): string {
  if (!DATASTORE_RE.test(datastore)) throw new NfsInputError('Datastore names are 2 to 32 letters, digits, dash or underscore.')
  return `${hostMountPoint(vmid)},mp=${DATASTORE_BASE}/${datastore},backup=0`
}

const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`
const ok = (v: string) => { if (!/^[A-Za-z0-9.:/_+@,=-]+$/.test(v)) throw new NfsInputError('Refused: a value would not be safe in a node script.'); return v }

/**
 * The read-only look at an export before anything is created, run on the chosen node: is it there, how much is
 * free, and is it already a PBS datastore. A temporary read-only mount in a fresh folder, unmounted again, and
 * nothing written. Markers carry the answers back.
 */
export function probeScript(src: { host: string; path: string; source: string }): string {
  return [
    'set -u',
    `S=${sq(ok(src.source))}; H=${sq(ok(src.host))}`,
    'command -v mount.nfs >/dev/null 2>&1 || { echo "@@pbs nonfs"; exit 0; }',
    'if command -v showmount >/dev/null 2>&1; then showmount -e --no-headers "$H" 2>/dev/null | awk \'{print "@@pbs export " $1}\'; fi',
    'T=$(mktemp -d /tmp/hpx-pbs-probe.XXXXXX)',
    'if timeout 20 mount -t nfs -o ro,vers=3,soft,timeo=50,retrans=1 "$S" "$T" 2>/tmp/hpx-pbs-probe.err; then',
    '  echo "@@pbs mounted"',
    '  df -B1 --output=avail,size "$T" | tail -1 | awk \'{print "@@pbs space " $1 " " $2}\'',
    '  [ -d "$T/.chunks" ] && echo "@@pbs existing root"',
    '  [ -n "$(ls -A "$T" 2>/dev/null | grep -v "^lost+found$" | head -1)" ] && echo "@@pbs notempty"',
    '  umount "$T" || umount -l "$T"',
    'else',
    '  echo "@@pbs mountfail $(head -c 200 /tmp/hpx-pbs-probe.err | tr \'\\n\' \' \')"',
    'fi',
    'rmdir "$T" 2>/dev/null; rm -f /tmp/hpx-pbs-probe.err',
  ].join('\n') + '\n'
}

export interface ExportProbe {
  nfsClient: boolean
  exports: string[]
  reachable: boolean
  mountError: string | null
  availBytes: number | null
  sizeBytes: number | null
  /** A PBS datastore is already there (a .chunks folder at the export root). */
  existing: boolean
  /** The export has other files in it. */
  notEmpty: boolean
}

export function parseProbe(out: string): ExportProbe {
  const lines = String(out ?? '').split('\n')
  const has = (m: string) => lines.some(l => l.trim() === `@@pbs ${m}`)
  const space = lines.map(l => /^@@pbs space (\d+) (\d+)/.exec(l.trim())).find(Boolean)
  const fail = lines.map(l => /^@@pbs mountfail ?(.*)$/.exec(l.trim())).find(Boolean)
  return {
    nfsClient: !has('nonfs'),
    exports: lines.map(l => /^@@pbs export (\S+)/.exec(l.trim())?.[1]).filter((x): x is string => !!x && EXPORT_RE.test(x)),
    reachable: has('mounted'),
    mountError: fail ? (fail[1] || 'the mount failed').replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 200) : null,
    availBytes: space ? Number(space[1]) : null,
    sizeBytes: space ? Number(space[2]) : null,
    existing: has('existing root'),
    notEmpty: has('notempty'),
  }
}

export interface ProbeVerdict { errors: string[]; warnings: string[]; checks: string[]; existing: boolean }

/** What the probe means for the plan: refuse, warn, or go on. `minFreeGb` is the space the person wants. */
export function judgeProbe(p: ExportProbe, src: { source: string }, o: { minFreeGb: number; reattach: boolean }): ProbeVerdict {
  const errors: string[] = [], warnings: string[] = [], checks: string[] = []
  if (!p.nfsClient) { errors.push('The chosen node has no NFS client (mount.nfs). Install nfs-common on it, or pick another node.'); return { errors, warnings, checks, existing: false } }
  if (!p.reachable) {
    errors.push(`${src.source} could not be mounted from the node${p.mountError ? `: ${p.mountError}` : ''}. Check that NFS is on for that share and that the node's address may mount it.`)
    return { errors, warnings, checks, existing: false }
  }
  checks.push(`${src.source} is reachable over NFS from the node.`)
  const gb = (b: number) => Math.floor(b / 1024 ** 3)
  if (p.availBytes !== null) {
    if (gb(p.availBytes) < o.minFreeGb) errors.push(`${src.source} has ${gb(p.availBytes)} GB free, less than the ${o.minFreeGb} GB asked for.`)
    else checks.push(`${gb(p.availBytes)} GB free of ${gb(p.sizeBytes ?? 0)} GB.`)
  }
  if (p.existing) {
    if (!o.reattach) errors.push(`${src.source} already holds a PBS datastore. HyperProx never wipes one: tick "Re-attach the existing datastore" to use it as it is (its backups stay), or choose an empty export.`)
    else warnings.push(`${src.source} already holds a PBS datastore. It is re-attached as it is; nothing in it is deleted or re-initialised.`)
  } else if (p.notEmpty) {
    errors.push(`${src.source} has other files in it. A new datastore needs an empty export (or a PBS datastore to re-attach).`)
  }
  return { errors, warnings, checks, existing: p.existing }
}

/** The anchored grep pattern for this container's fstab line: " # hyperprox-pbs 100" at the end, so 100 never matches 1000. */
export const markerPattern = (vmid: number) => ` ${marker(vmid)}$`

/**
 * Replace (or remove, with no line) this container's fstab line, atomically: everything except its own marked
 * line is copied to a temporary file next to fstab (same filesystem, same mode), the new line is added, and the
 * file is renamed over fstab. grep failing (exit 2 or more: unreadable fstab) stops it and changes nothing; exit 1
 * only means no other line was left. `fstab` is a parameter so the tests can run this on a scratch file.
 */
export function fstabEditScript(vmid: number, line: string | null, fstab = '/etc/fstab'): string {
  if (!Number.isInteger(vmid) || vmid < 100 || vmid > 999_999_999) throw new NfsInputError('Bad container id.')
  if (!/^\/[A-Za-z0-9._/-]+$/.test(fstab)) throw new NfsInputError('Bad fstab path.')
  if (line !== null && (/[\r\n]/.test(line) || !line.endsWith(` ${marker(vmid)}`))) throw new NfsInputError('Refused: not this container\'s fstab line.')
  return [
    `FS=${sq(fstab)}; K=${sq(markerPattern(vmid))}`,
    'T=$(mktemp "${FS%/*}/.fstab.hpx-pbs.XXXXXX") || { echo "@@pbs fstabfail"; exit 4; }',
    'chmod --reference="$FS" "$T" 2>/dev/null || chmod 0644 "$T"',
    'rc=0; grep -v -- "$K" "$FS" > "$T" || rc=$?',
    'if [ "$rc" -ge 2 ]; then rm -f "$T"; echo "@@pbs fstabfail"; exit 4; fi',
    ...(line !== null ? [`printf '%s\\n' ${sq(line)} >> "$T" || { rm -f "$T"; echo "@@pbs fstabfail"; exit 4; }`] : []),
    'mv -f "$T" "$FS" || { rm -f "$T"; echo "@@pbs fstabfail"; exit 4; }',
  ].join('\n')
}

/** Mount on the node, add the fstab line (once), and give the container its bind mountpoint. Reversible. */
export function mountScript(src: { source: string }, vmid: number, datastore: string): string {
  if (!Number.isInteger(vmid) || vmid < 100) throw new NfsInputError('Bad container id.')
  const mp = hostMountPoint(vmid)
  return [
    'set -eu',
    `M=${sq(ok(mp))}`,
    'mkdir -p "$M"',
    // Once only: a line already marked for this container is replaced, not doubled.
    'set +e',
    fstabEditScript(vmid, fstabLine(src, vmid)),
    'set -e',
    'mountpoint -q "$M" || mount "$M"',
    'mountpoint -q "$M" || { echo "@@pbs mountfail"; exit 3; }',
    `pct set ${vmid} -mp0 ${sq(ok(bindMountpoint(vmid, datastore)))}`,
    'echo "@@pbs mounted"',
  ].join('\n') + '\n'
}

/**
 * The reversal: the mount off the node, its fstab line and its (empty) folder gone. `detach` also takes the
 * mountpoint off the container (a failed install's clean-up); after the container was destroyed it is left out,
 * so a later container with the same id is never touched. With no marked line in fstab it does nothing.
 */
export function unmountScript(vmid: number, o: { detach?: boolean; fstab?: string } = {}): string {
  const mp = hostMountPoint(vmid)
  const fstab = o.fstab ?? '/etc/fstab'
  return [
    'set -u',
    `M=${sq(ok(mp))}`,
    `if ! grep -q -- ${sq(markerPattern(vmid))} ${sq(fstab)} && ! mountpoint -q "$M"; then echo "@@pbs nomount"; exit 0; fi`,
    ...(o.detach !== false ? [`pct set ${vmid} -delete mp0 2>/dev/null || true`] : []),
    'if mountpoint -q "$M"; then umount "$M" || umount -l "$M"; fi',
    fstabEditScript(vmid, null, fstab),
    'rmdir "$M" 2>/dev/null || true',
    'echo "@@pbs unmounted"',
  ].join('\n') + '\n'
}

/** The NFS exports a NAS offers, read from the node with showmount. */
export function exportsScript(host: string): string {
  const h = cleanNfsSource(host, '/').host
  return ['set -u', `H=${sq(ok(h))}`, 'command -v showmount >/dev/null 2>&1 || { echo "@@pbs noshowmount"; exit 0; }',
    'timeout 10 showmount -e --no-headers "$H" 2>/dev/null | awk \'{print "@@pbs export " $1}\''].join('\n') + '\n'
}
