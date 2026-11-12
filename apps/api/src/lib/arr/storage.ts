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

// ── A folder on the node ───────────────────────────────────────────────────

/** System folders a library must never be put in. */
const SYSTEM = ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var', '/var/lib', '/var/lib/vz', '/tmp']

export function cleanHostPath(raw: unknown): string {
  const p = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : ''
  if (!/^\/[A-Za-z0-9._+@-]+(?:\/[A-Za-z0-9._+@-]+)*$/.test(p) || p.split('/').some(s => s === '..' || s === '.')) {
    throw new StorageInputError('The folder is a full path on the node, such as /mnt/media, with no "..".')
  }
  if (SYSTEM.includes(p) || p.startsWith('/etc/') || p.startsWith('/proc/') || p.startsWith('/sys/') || p.startsWith('/dev/') || p.startsWith('/boot/') || p.startsWith('/usr/')) {
    throw new StorageInputError(`${p} is a system folder. Pick the folder that holds (or will hold) your media.`)
  }
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
export function mountpointSpec(l: Layout, vmid: number, storage: string): string {
  const mp = mountTarget(l)
  if (l.media === 'disk') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(storage)) throw new StorageInputError('Not a storage name.')
    return `${storage}:${l.mediaGb},mp=${mp},backup=0`
  }
  const src = l.media === 'nfs' ? hostMountPoint(vmid) : l.hostPath!
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
export function probeScript(l: Layout): string {
  if (l.media === 'nfs') {
    return [
      'set -u',
      `S=${sq(safe(l.nfs!.source))}`,
      'command -v mount.nfs >/dev/null 2>&1 || { echo "@@arr nonfs"; exit 0; }',
      'T=$(mktemp -d /tmp/hpx-arr-probe.XXXXXX)',
      'if timeout 20 mount -t nfs -o ro,vers=3,soft,timeo=50,retrans=1 "$S" "$T" 2>/tmp/hpx-arr-probe.err; then',
      '  echo "@@arr reachable"',
      '  df -B1 --output=avail,size "$T" | tail -1 | awk \'{print "@@arr space " $1 " " $2}\'',
      '  umount "$T" || umount -l "$T"',
      'else',
      '  echo "@@arr mountfail $(head -c 200 /tmp/hpx-arr-probe.err | tr \'\\n\' \' \')"',
      'fi',
      'rmdir "$T" 2>/dev/null; rm -f /tmp/hpx-arr-probe.err',
    ].join('\n') + '\n'
  }
  if (l.media === 'path') {
    return [
      'set -u',
      `P=${sq(safe(l.hostPath!))}`,
      'if [ -d "$P" ]; then',
      '  echo "@@arr reachable"',
      '  stat -c "@@arr owner %u:%g" "$P"',
      '  df -B1 --output=avail,size "$P" | tail -1 | awk \'{print "@@arr space " $1 " " $2}\'',
      '  df --output=fstype "$P" | tail -1 | awk \'{print "@@arr fstype " $1}\'',
      'else echo "@@arr missing"; fi',
    ].join('\n') + '\n'
  }
  return 'echo "@@arr reachable"\n'
}

export interface Probe { reachable: boolean; noNfsClient: boolean; missing: boolean; error: string | null; availGb: number | null; owner: string | null; fstype: string | null }

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
  }
}

/** The uid every app writes as, seen from the node: an unprivileged container shifts ids by 100000. */
export const HOST_UID = 100000 + PUID
export const UID_NOTE = `Every app writes as uid ${PUID} inside the container, which is uid ${HOST_UID} (group ${100000 + PGID}) on the node and on a NAS. That user must be able to create folders and files there.`

export function judgeProbe(p: Probe, l: Layout): { errors: string[]; warnings: string[]; checks: string[] } {
  const errors: string[] = [], warnings: string[] = [], checks: string[] = []
  if (l.media === 'nfs') {
    if (p.noNfsClient) errors.push('The chosen node has no NFS client (mount.nfs). Install nfs-common on it, or pick another node.')
    else if (!p.reachable) errors.push(`${l.nfs!.source} could not be mounted from the node${p.error ? `: ${p.error}` : ''}. Check that NFS is on for that share and that the node may mount it.`)
    else {
      checks.push(`${l.nfs!.source} is reachable over NFS from the node${p.availGb !== null ? `, with ${p.availGb} GB free` : ''}.`)
      warnings.push(`The NAS is mounted on this node only, so the container cannot be moved to another node while it uses it. ${UID_NOTE}`)
    }
  } else if (l.media === 'path') {
    if (p.missing || !p.reachable) errors.push(`${l.hostPath} is not a folder on the chosen node.`)
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
  lines.push('if pct status "$V" | grep -q running; then pct stop "$V"; fi')
  if (layout.media === 'nfs') {
    const mp = hostMountPoint(vmid)
    // The marker has a '#', which `safe` refuses on purpose; it is fixed text, so only the rest is checked.
    const line = `${safe(`${layout.nfs!.source} ${mp} nfs ${NFS_OPTIONS} 0 0`)} ${marker(vmid)}`
    if (line !== fstabLine(layout.nfs!, vmid)) throw new StorageInputError('The fstab line did not build as expected.')
    lines.push(
      `M=${sq(safe(mp))}; L=${sq(line)}; K=${sq(marker(vmid))}`,
      'mkdir -p "$M"',
      // Once only: a line already marked for this container is replaced, never doubled. Written whole, never appended in place.
      'grep -vF "$K" /etc/fstab > /etc/fstab.hpx-arr.tmp || true',
      'printf "%s\\n" "$L" >> /etc/fstab.hpx-arr.tmp',
      'cat /etc/fstab.hpx-arr.tmp > /etc/fstab && rm -f /etc/fstab.hpx-arr.tmp',
      'mountpoint -q "$M" || mount "$M"',
      'mountpoint -q "$M" || { echo "@@arr mountfail"; exit 3; }',
      'echo "@@arr mounted"',
    )
  }
  const set = [`--features nesting=1,keyctl=1`, `-mp0 ${sq(safe(mountpointSpec(layout, vmid, o.storage)))}`]
  if (o.tun) set.push('--dev0 /dev/net/tun')
  lines.push(`pct set "$V" ${set.join(' ')}`)
  lines.push('pct start "$V"', 'echo "@@arr prepared"')
  return lines.join('\n') + '\n'
}

/** The reversal for a NAS mount: the mount off the node, its fstab line and folder gone. The NAS is not touched. */
export function unmountScript(vmid: number): string {
  if (!Number.isInteger(vmid) || vmid < 100) throw new StorageInputError('Bad container id.')
  const mp = hostMountPoint(vmid)
  return [
    'set -u',
    `M=${sq(safe(mp))}; K=${sq(marker(vmid))}`,
    'if mountpoint -q "$M"; then umount "$M" 2>/dev/null || umount -l "$M"; fi',
    'grep -vF "$K" /etc/fstab > /etc/fstab.hpx-arr.tmp && cat /etc/fstab.hpx-arr.tmp > /etc/fstab; rm -f /etc/fstab.hpx-arr.tmp',
    'rmdir "$M" 2>/dev/null || true',
    'echo "@@arr unmounted"',
  ].join('\n') + '\n'
}

/** What the container's config must say after prepareScript, as read back through the API. */
export function configProblems(cfg: Record<string, unknown> | null, o: { layout: Layout; storage: string; vmid: number; tun: boolean }): string[] {
  const out: string[] = []
  const features = String(cfg?.features ?? '')
  if (!/(^|,)nesting=1(,|$)/.test(features) || !/(^|,)keyctl=1(,|$)/.test(features)) out.push(`features read back as "${features || 'none'}", not nesting=1,keyctl=1.`)
  const mp0 = String(cfg?.mp0 ?? '')
  const target = `mp=${mountTarget(o.layout)}`
  if (!mp0.split(',').includes(target)) out.push(`mp0 read back as "${mp0 || 'nothing'}", not mounted at ${mountTarget(o.layout)}.`)
  else if (o.layout.media === 'disk' && !mp0.startsWith(`${o.storage}:`)) out.push(`mp0 is not on ${o.storage}.`)
  else if (o.layout.media !== 'disk' && mp0.split(',')[0] !== (o.layout.media === 'nfs' ? hostMountPoint(o.vmid) : o.layout.hostPath)) out.push(`mp0 read back as "${mp0}".`)
  if (o.tun && !Object.entries(cfg ?? {}).some(([k, v]) => /^dev\d+$/.test(k) && String(v).split(',')[0] === '/dev/net/tun')) out.push('The VPN\'s /dev/net/tun device did not read back.')
  return out
}
