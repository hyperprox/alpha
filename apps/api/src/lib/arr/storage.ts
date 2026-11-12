// =============================================================================
//  HyperProx — where the Arr Stack keeps its files
//
//  One folder, /data, laid out the way the TRaSH guides lay it out:
//
//    /data/torrents/{tv,movies,music}     qBittorrent's downloads
//    /data/usenet/{incomplete,complete}   SABnzbd's downloads
//    /data/media/{tv,movies,music}        the library your media server reads
//
//  Every app sees the same /data at the same path. When the downloads and the
//  library are on one filesystem, finishing a download is a hardlink or a
//  rename: instant, and no second copy. Across two filesystems it is a full
//  copy, so a 60 GB film takes 60 GB more and minutes to move.
//
//  Where /data lives is the person's choice:
//    disk  a new disk for the container on cluster storage;
//    nfs   an NFS export on a NAS, mounted on the container's node only (never
//          cluster-wide) and handed in as a mountpoint, because an
//          unprivileged container cannot mount NFS itself;
//    path  a folder that already exists on the node, handed in the same way.
//  Downloads go with the library (recommended), or on the container's own disk
//  when the library is on a slow NAS; the second breaks hardlinks, and the
//  wizard says so.
//
//  The NFS mount: rw,vers=3,hard,timeo=600,retrans=2,_netdev,nofail. `hard`
//  turns a slow NAS into a wait, never a silently failed write; `_netdev` waits
//  for the network; `nofail` means a NAS that is off when the node boots does
//  not hang the node's boot. The fstab line carries the container's id and the
//  clean-up removes it again.
// =============================================================================

import net from 'node:net'
import { PUID, PGID } from './components'

export type MediaKind = 'disk' | 'nfs' | 'path'
export type DownloadsKind = 'together' | 'local'

export interface Layout {
  media: MediaKind
  downloads: DownloadsKind
  /** disk: its size. */
  mediaGb?: number
  /** nfs: host and export. */
  nfs?: { host: string; path: string; source: string }
  /** path: the folder on the node. */
  hostPath?: string
  /** local downloads: how much room on the container's own disk. */
  downloadGb?: number
}

/** Where the mount lands inside the container: all of /data, or only the library when downloads stay local. */
export const mountTarget = (l: Pick<Layout, 'downloads'>) => (l.downloads === 'local' ? '/data/media' : '/data')

export class StorageInputError extends Error { constructor(m: string) { super(m); this.name = 'StorageInputError' } }

// ── NFS ─────────────────────────────────────────────────────────────────────

/** The options for the NAS mount, in a fixed order. `extra` options are added after, each checked. */
export function nfsOptions(extra: string[] = []): string {
  const base = ['rw', 'vers=3', 'hard', 'timeo=600', 'retrans=2', '_netdev', 'nofail']
  for (const e of extra) if (!/^[a-z_][a-z0-9_]*(=[A-Za-z0-9._-]+)?$/.test(e)) throw new StorageInputError(`"${e}" is not an NFS mount option.`)
  return [...base, ...extra.filter(e => !base.includes(e))].join(',')
}
export const NFS_OPTIONS = nfsOptions()

export const SMB_REFUSAL = 'That looks like an SMB/Windows share. HyperProx mounts the library over NFS: turn NFS on for that share on the NAS, then use its NFS export (for example /Media on a QNAP or /volume1/media on a Synology).'

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
const EXPORT_RE = /^\/[A-Za-z0-9._+@-]+(?:\/[A-Za-z0-9._+@-]+)*\/?$/

/** The NAS (an IPv4 address or a name) and its export, checked: what the probe and the mount use. */
export function cleanNfsSource(host: unknown, path: unknown): { host: string; path: string; source: string } {
  const h = typeof host === 'string' ? host.trim() : ''
  const p = typeof path === 'string' ? path.trim() : ''
  if (/^(smb|cifs):/i.test(h) || /^\\\\|^\/\/[^/]/.test(h) || /^\\\\|^\/\/[^/]|^(smb|cifs):/i.test(p) || /\\/.test(`${h}${p}`)) throw new StorageInputError(SMB_REFUSAL)
  if (!h || (!net.isIP(h) && !HOST_RE.test(h))) throw new StorageInputError('The NAS is its IP address or name, such as 10.0.0.20 or nas.example.lan.')
  if (net.isIP(h) === 6) throw new StorageInputError('Use the NAS\'s IPv4 address or name; HyperProx does not mount NFS over IPv6 yet.')
  if (!EXPORT_RE.test(p) || p.split('/').some(s => s === '..' || s === '.')) throw new StorageInputError('The export is the folder the NAS shares over NFS, such as /Media or /volume1/media.')
  const clean = p.replace(/\/+$/, '')
  return { host: h, path: clean, source: `${h}:${clean}` }
}

/** On the node: one folder per container. */
export const HOST_BASE = '/mnt/hyperprox-arr'
export const hostMountPoint = (vmid: number) => `${HOST_BASE}/${vmid}`
const marker = (vmid: number) => `# hyperprox-arr ${vmid}`

export function fstabLine(src: { source: string }, vmid: number): string {
  return `${src.source} ${hostMountPoint(vmid)} nfs ${NFS_OPTIONS} 0 0 ${marker(vmid)}`
}

/** The anchored grep pattern for this container's fstab line: " # hyperprox-arr 101" at the end, so 101 never matches 1010. */
export const markerPattern = (vmid: number) => ` ${marker(vmid)}$`

/**
 * Replace (or remove, with no line) this container's fstab line, atomically, as the PBS recipe does: every other
 * line is copied to a temporary file next to fstab (same filesystem, same mode), the new line added, and the file
 * renamed over fstab. grep exit 2 or more (fstab unreadable) stops it and changes nothing; exit 1 only means no
 * other line was left. `fstab` is a parameter so the tests can run this on a scratch file.
 */
export function fstabEditScript(vmid: number, line: string | null, fstab = '/etc/fstab'): string {
  if (!Number.isInteger(vmid) || vmid < 100 || vmid > 999_999_999) throw new StorageInputError('Bad container id.')
  if (!/^\/[A-Za-z0-9._/-]+$/.test(fstab)) throw new StorageInputError('Bad fstab path.')
  if (line !== null && (/[\r\n]/.test(line) || !line.endsWith(` ${marker(vmid)}`))) throw new StorageInputError('Refused: not this container\'s fstab line.')
  return [
    `FS=${sq(fstab)}; K=${sq(markerPattern(vmid))}`,
    'T=$(mktemp "${FS%/*}/.fstab.hpx-arr.XXXXXX") || { echo "@@arr fstabfail"; exit 4; }',
    'chmod --reference="$FS" "$T" 2>/dev/null || chmod 0644 "$T"',
    'rc=0; grep -v -- "$K" "$FS" > "$T" || rc=$?',
    'if [ "$rc" -ge 2 ]; then rm -f "$T"; echo "@@arr fstabfail"; exit 4; fi',
    ...(line !== null ? [`printf '%s\\n' ${sq(line)} >> "$T" || { rm -f "$T"; echo "@@arr fstabfail"; exit 4; }`] : []),
    'mv -f "$T" "$FS" || { rm -f "$T"; echo "@@arr fstabfail"; exit 4; }',
  ].join('\n')
}

// ── A folder on the node ───────────────────────────────────────────────────

/**
 * Folders a library must never be in, or under: the system, Proxmox's own state, and another container's mount.
 * Checked against the path as the node resolves it (realpath -e), so a symlink to /etc is refused like /etc.
 * The /lib* rule refuses /lib, /lib32, /lib64, /libx32 (and, harmlessly, anything else starting /lib).
 */
export const REFUSED_PREFIXES = ['/etc', '/root', '/boot', '/dev', '/proc', '/sys', '/run', '/var', '/usr', '/bin', '/sbin', '/tmp', '/opt',
  '/var/lib/vz', '/var/lib/ceph', '/var/lib/pve-cluster']

/** Why this (resolved) node path cannot hold a library, or null. `vmid`: the container's own NAS mount is allowed. */
export function hostPathRefusal(p: string, vmid?: number): string | null {
  const own = vmid ? hostMountPoint(vmid) : null
  const under = (x: string) => p === x || p.startsWith(`${x}/`)
  if (own && under(own)) return null
  if (p === '/' || !p.startsWith('/')) return `${p || 'That'} is not a folder a library can go in.`
  if (REFUSED_PREFIXES.some(under) || /^\/lib[^/]*(\/|$)/.test(p)) return `${p} is a system folder. Pick the folder that holds (or will hold) your media.`
  if (/^\/mnt\/hyperprox-[^/]*(\/|$)/.test(p)) return `${p} is a mount HyperProx made for another container.`
  return null
}

/** The same rule in the node's shell, as `case` patterns, so it is checked again where the path is resolved. */
function refusalCase(vmid: number): string {
  const own = hostMountPoint(vmid)
  // Literal parts quoted, the glob star left bare: '/etc' | '/etc/'* | '/lib'* ...
  const pats = ["'/'", ...REFUSED_PREFIXES.flatMap(x => [sq(x), `${sq(`${x}/`)}*`]), `${sq('/lib')}*`, `${sq('/mnt/hyperprox-')}*`]
  return [
    'case "$R" in',
    `  ${sq(own)}|${sq(`${own}/`)}*) ;;`,
    `  ${pats.join('|')}) echo "@@arr refused $R"; exit 5 ;;`,
    'esac',
    'case "$R" in *[!A-Za-z0-9._+@/-]*) echo "@@arr refused $R"; exit 5 ;; esac',
  ].join('\n')
}

export function cleanHostPath(raw: unknown): string {
  const p = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : ''
  if (!/^\/[A-Za-z0-9._+@-]+(?:\/[A-Za-z0-9._+@-]+)*$/.test(p) || p.split('/').some(s => s === '..' || s === '.')) {
    throw new StorageInputError('The folder is a full path on the node, such as /mnt/media, with no "..".')
  }
  const bad = hostPathRefusal(p)
  if (bad) throw new StorageInputError(bad)
  return p
}

// ── The layout from the wizard's options ───────────────────────────────────

/** The layout an option set describes, or the reasons it cannot be used. */
export function layoutOf(v: Record<string, string>): { layout?: Layout; errors: string[] } {
  const errors: string[] = []
  const media = (v.ARR_MEDIA || 'disk') as MediaKind
  const downloads = (v.ARR_DOWNLOADS || 'together') as DownloadsKind
  if (!['disk', 'nfs', 'path'].includes(media)) errors.push('Pick where the library goes: a new disk, a NAS, or a folder on the node.')
  if (!['together', 'local'].includes(downloads)) errors.push('Downloads go with the library, or on the container\'s own disk.')
  const l: Layout = { media, downloads }
  try {
    if (media === 'disk') {
      const gb = Number(v.ARR_MEDIA_GB || 0)
      if (!Number.isInteger(gb) || gb < 10) errors.push('The new library disk needs a size of at least 10 GB.')
      else l.mediaGb = gb
    } else if (media === 'nfs') l.nfs = cleanNfsSource(v.ARR_NFS_HOST, v.ARR_NFS_EXPORT)
    else if (media === 'path') l.hostPath = cleanHostPath(v.ARR_HOST_PATH)
  } catch (e: any) { errors.push(e.message) }
  if (downloads === 'local') {
    const gb = Number(v.ARR_DOWNLOAD_GB || 0)
    if (!Number.isInteger(gb) || gb < 10) errors.push('Downloads on the container\'s own disk need at least 10 GB of room.')
    else l.downloadGb = gb
  }
  return errors.length ? { errors } : { layout: l, errors }
}

/**
 * Are the downloads and the library on one filesystem? With downloads together on the library's mount they are,
 * whatever the mount is. With downloads on the container's own disk they are not, and every finished download is
 * copied instead of moved.
 */
export function sameFilesystem(l: Pick<Layout, 'downloads'>): { same: boolean; warning?: string } {
  if (l.downloads === 'together') return { same: true }
  return {
    same: false,
    warning: 'Downloads and the library are on different filesystems, so hardlinks and instant moves will not work: every finished download is copied into the library, taking twice the space until the torrent is removed, and moves take minutes, not a moment.',
  }
}

export const LAYOUT_LINE = 'Downloads and the library share one /data folder, so a finished download moves into the library instantly, with no second copy.'

/** The container's mountpoint for the library: a new volume, or a bind of the node's folder. Not in vzdump. */
export function mountpointSpec(l: Layout, vmid: number, storage: string, resolved?: string): string {
  const mp = mountTarget(l)
  if (l.media === 'disk') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(storage)) throw new StorageInputError('Not a storage name.')
    return `${storage}:${l.mediaGb},mp=${mp},backup=0`
  }
  const src = l.media === 'nfs' ? hostMountPoint(vmid) : resolved ?? l.hostPath!
  if (/[,=]/.test(src)) throw new StorageInputError('The folder cannot have a comma or "=" in its path.')
  return `${src},mp=${mp},backup=0`
}

// ── Scripts run on the node, as root, over its saved login ─────────────────

const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`
const safe = (v: string) => { if (!/^[A-Za-z0-9.:/_+@,= -]+$/.test(v)) throw new StorageInputError('Refused: a value would not be safe in a node script.'); return v }

/**
 * Before anything is created: can the node reach the library? A NAS export is mounted read-only in a fresh temp
 * folder and unmounted again; a folder is checked to exist and be a folder. Nothing is written. Markers carry the
 * answers back.
 */
export function probeScript(l: Layout, vmid = 100): string {
  if (l.media === 'nfs') {
    return [
      'set -u',
      `S=${sq(safe(l.nfs!.source))}`,
      'command -v mount.nfs >/dev/null 2>&1 || { echo "@@arr nonfs"; exit 0; }',
      'T=$(mktemp -d /tmp/hpx-arr-probe.XXXXXX); E=$(mktemp /tmp/hpx-arr-probe-err.XXXXXX)',
      'if timeout 20 mount -t nfs -o ro,vers=3,soft,timeo=50,retrans=1 "$S" "$T" 2>"$E"; then',
      '  echo "@@arr reachable"',
      '  df -B1 --output=avail,size "$T" | tail -1 | awk \'{print "@@arr space " $1 " " $2}\'',
      '  umount "$T" || umount -l "$T"',
      'else',
      '  echo "@@arr mountfail $(head -c 200 "$E" | tr \'\\n\' \' \')"',
      'fi',
      'rmdir "$T" 2>/dev/null; rm -f "$E"',
    ].join('\n') + '\n'
  }
  if (l.media === 'path') {
    return [
      'set -u',
      `P=${sq(safe(l.hostPath!))}`,
      // Resolved as the node sees it: a symlink to /etc is /etc.
      'R=$(realpath -e -- "$P" 2>/dev/null) && [ -d "$R" ] || { echo "@@arr missing"; exit 0; }',
      refusalCase(vmid).replace(/exit 5/g, 'exit 0'),
      'echo "@@arr resolved $R"',
      'echo "@@arr reachable"',
      'stat -c "@@arr owner %u:%g" "$R"',
      'df -B1 --output=avail,size "$R" | tail -1 | awk \'{print "@@arr space " $1 " " $2}\'',
      'df --output=fstype "$R" | tail -1 | awk \'{print "@@arr fstype " $1}\'',
    ].join('\n') + '\n'
  }
  return 'echo "@@arr reachable"\n'
}

export interface Probe {
  reachable: boolean; noNfsClient: boolean; missing: boolean; error: string | null; availGb: number | null; owner: string | null; fstype: string | null
  /** A node folder as the node resolves it, and the resolved path the node itself refused. */
  resolved: string | null; refused: string | null
}

export function parseProbe(out: string): Probe {
  const lines = String(out ?? '').split('\n').map(l => l.trim())
  const has = (m: string) => lines.includes(`@@arr ${m}`)
  const space = lines.map(l => /^@@arr space (\d+) (\d+)/.exec(l)).find(Boolean)
  const fail = lines.map(l => /^@@arr mountfail ?(.*)$/.exec(l)).find(Boolean)
  return {
    reachable: has('reachable'), noNfsClient: has('nonfs'), missing: has('missing'),
    error: fail ? (fail[1] || 'the mount failed').replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 200) : null,
    availGb: space ? Math.floor(Number(space[1]) / 1024 ** 3) : null,
    owner: lines.map(l => /^@@arr owner (\d+:\d+)/.exec(l)?.[1]).find(Boolean) ?? null,
    fstype: lines.map(l => /^@@arr fstype (\S+)/.exec(l)?.[1]).find(Boolean) ?? null,
    resolved: lines.map(l => /^@@arr resolved (\/\S*)$/.exec(l)?.[1]).find(Boolean) ?? null,
    refused: lines.map(l => /^@@arr refused (.*)$/.exec(l)?.[1]).find(Boolean) ?? null,
  }
}

/** The uid every app writes as, seen from the node: an unprivileged container shifts ids by 100000. */
export const HOST_UID = 100000 + PUID
export const UID_NOTE = `Every app writes as uid ${PUID} inside the container, which is uid ${HOST_UID} (group ${100000 + PGID}) on the node and on a NAS. That user must be able to create folders and files there.`

export function judgeProbe(p: Probe, l: Layout, vmid?: number): { errors: string[]; warnings: string[]; checks: string[] } {
  const errors: string[] = [], warnings: string[] = [], checks: string[] = []
  if (l.media === 'nfs') {
    if (p.noNfsClient) errors.push('The chosen node has no NFS client (mount.nfs). Install nfs-common on it, or pick another node.')
    else if (!p.reachable) errors.push(`${l.nfs!.source} could not be mounted from the node${p.error ? `: ${p.error}` : ''}. Check that NFS is on for that share and that the node may mount it.`)
    else {
      checks.push(`${l.nfs!.source} is reachable over NFS from the node${p.availGb !== null ? `, with ${p.availGb} GB free` : ''}.`)
      warnings.push(`The NAS is mounted on this node only, so the container cannot be moved to another node while it uses it. ${UID_NOTE}`)
    }
  } else if (l.media === 'path') {
    const bad = p.refused !== null ? (hostPathRefusal(p.refused, vmid) ?? `${p.refused} cannot be used.`) : p.resolved ? hostPathRefusal(p.resolved, vmid) : null
    const res = p.refused ?? p.resolved
    if (bad) errors.push(res && res !== l.hostPath ? `${l.hostPath} is ${res} on the node. ${bad}` : bad)
    else if (p.missing || !p.reachable || !p.resolved) errors.push(`${l.hostPath} is not a folder on the chosen node.`)
    else {
      checks.push(`${l.hostPath} is a folder on the node${p.fstype ? ` (${p.fstype})` : ''}${p.availGb !== null ? `, with ${p.availGb} GB free` : ''}.`)
      warnings.push(`${l.hostPath} exists only on this node, so the container cannot be moved to another node. ${UID_NOTE}${p.owner && p.owner !== `${HOST_UID}:${100000 + PGID}` ? ` It is owned by ${p.owner} now.` : ''}`)
    }
  }
  return { errors, warnings, checks }
}

/**
 * After the create, before Docker is installed: stop the new container, mount the NAS on its node (NFS only),
 * give it keyctl (Docker in an unprivileged container wants it), the VPN's tun device when there is one, and the
 * library mountpoint, then start it again. Every change here is undone by removing the container, except the NFS
 * line, which `unmountScript` removes.
 */
export function prepareScript(o: { vmid: number; layout: Layout; storage: string; tun: boolean }): string {
  const { vmid, layout } = o
  if (!Number.isInteger(vmid) || vmid < 100) throw new StorageInputError('Bad container id.')
  const lines = ['set -eu', `V=${vmid}`]
  const stop = 'if pct status "$V" | grep -q running; then pct stop "$V"; fi'
  if (layout.media !== 'path') lines.push(stop)
  if (layout.media === 'nfs') {
    const mp = hostMountPoint(vmid)
    // The marker has a '#', which `safe` refuses on purpose; it is fixed text, so only the rest is checked.
    const line = `${safe(`${layout.nfs!.source} ${mp} nfs ${NFS_OPTIONS} 0 0`)} ${marker(vmid)}`
    if (line !== fstabLine(layout.nfs!, vmid)) throw new StorageInputError('The fstab line did not build as expected.')
    lines.push(
      `M=${sq(safe(mp))}`,
      'mkdir -p "$M"',
      // Once only: a line already marked for this container is replaced, never doubled; fstab is renamed into place.
      'set +e',
      fstabEditScript(vmid, line),
      'set -e',
      'mountpoint -q "$M" || mount "$M"',
      'mountpoint -q "$M" || { echo "@@arr mountfail"; exit 3; }',
      'echo "@@arr mounted"',
    )
  }
  let mp0 = sq(safe(mountpointSpec(layout, vmid, o.storage)))
  if (layout.media === 'path') {
    // Resolved again here, at the moment it is handed in, and refused again by the same rule; mp0 gets the resolved path.
    lines.push(
      `P=${sq(safe(layout.hostPath!))}`,
      'R=$(realpath -e -- "$P" 2>/dev/null) && [ -d "$R" ] || { echo "@@arr missing"; exit 5; }',
      refusalCase(vmid),
      'echo "@@arr resolved $R"',
      stop,
    )
    mp0 = `"$R"${sq(`,mp=${mountTarget(layout)},backup=0`)}`
  }
  const set = [`--features nesting=1,keyctl=1`, `-mp0 ${mp0}`]
  if (o.tun) set.push('--dev0 /dev/net/tun')
  lines.push(`pct set "$V" ${set.join(' ')}`)
  lines.push('pct start "$V"', 'echo "@@arr prepared"')
  return lines.join('\n') + '\n'
}

/** The reversal for a NAS mount: the mount off the node, its fstab line and folder gone. The NAS is not touched. */
export function unmountScript(vmid: number, fstab = '/etc/fstab'): string {
  if (!Number.isInteger(vmid) || vmid < 100) throw new StorageInputError('Bad container id.')
  const mp = hostMountPoint(vmid)
  return [
    'set -u',
    `M=${sq(safe(mp))}`,
    'if mountpoint -q "$M"; then umount "$M" 2>/dev/null || umount -l "$M"; fi',
    fstabEditScript(vmid, null, fstab),
    'rmdir "$M" 2>/dev/null || true',
    'echo "@@arr unmounted"',
  ].join('\n') + '\n'
}

/** What the container's config must say after prepareScript, as read back through the API. */
export function configProblems(cfg: Record<string, unknown> | null, o: { layout: Layout; storage: string; vmid: number; tun: boolean; resolved?: string }): string[] {
  const out: string[] = []
  const features = String(cfg?.features ?? '')
  if (!/(^|,)nesting=1(,|$)/.test(features) || !/(^|,)keyctl=1(,|$)/.test(features)) out.push(`features read back as "${features || 'none'}", not nesting=1,keyctl=1.`)
  const mp0 = String(cfg?.mp0 ?? '')
  const target = `mp=${mountTarget(o.layout)}`
  if (!mp0.split(',').includes(target)) out.push(`mp0 read back as "${mp0 || 'nothing'}", not mounted at ${mountTarget(o.layout)}.`)
  else if (o.layout.media === 'disk' && !mp0.startsWith(`${o.storage}:`)) out.push(`mp0 is not on ${o.storage}.`)
  else if (o.layout.media !== 'disk' && mp0.split(',')[0] !== (o.layout.media === 'nfs' ? hostMountPoint(o.vmid) : o.resolved ?? o.layout.hostPath)) out.push(`mp0 read back as "${mp0}".`)
  if (o.tun && !Object.entries(cfg ?? {}).some(([k, v]) => /^dev\d+$/.test(k) && String(v).split(',')[0] === '/dev/net/tun')) out.push('The VPN\'s /dev/net/tun device did not read back.')
  return out
}
