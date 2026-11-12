// =============================================================================
//  HyperProx — where the transcoders find the library
//
//  The same three choices, the same checks and the same layout as the Arr Stack
//  (lib/arr/storage.ts is used as it stands, not copied):
//    disk  a new disk on cluster storage, mounted at /data;
//    nfs   an NFS export on a NAS, mounted on the container's node only, with an
//          fstab line carrying the container's id and removed again by clean-up;
//    path  a folder that already exists on the node.
//  The library inside every container is /data/media: the folder the Arr Stack
//  files finished downloads into, so the two work on the same files at the same
//  paths.
//
//  Unlike the Arr Stack, these apps REPLACE files in place. A library the
//  container's user cannot write is no use, and on an unprivileged container a
//  folder owned by root (the usual state of a media share) cannot be written.
//  The folder check therefore also tries to write one empty file there, as that
//  user, and removes it again.
// =============================================================================

import { PUID, PGID } from '../arr/components'
import {
  layoutOf, probeScript, parseProbe, judgeProbe, hostMountPoint, HOST_UID, safe, sq,
  type Layout, type Probe,
} from '../arr/storage'

export const LIBRARY_DIR = '/data/media'
export const LAYOUT_LINE = 'The library is /data/media inside the container: the same folder the Arr Stack fills, at the same path, so both work on the same files.'

/** The wizard's TC_* options as the Arr Stack's own layout reader takes them. Downloads are never separate here. */
export function layoutFromOptions(v: Record<string, string>): { layout?: Layout; errors: string[] } {
  return layoutOf({
    ARR_MEDIA: v.TC_MEDIA || 'disk', ARR_MEDIA_GB: v.TC_MEDIA_GB ?? '', ARR_NFS_HOST: v.TC_NFS_HOST ?? '', ARR_NFS_EXPORT: v.TC_NFS_EXPORT ?? '',
    ARR_HOST_PATH: v.TC_HOST_PATH ?? '', ARR_DOWNLOADS: 'together',
  })
}

/**
 * The library check run on the node. For a folder it adds the write test, as the container's user on the node
 * (uid 101000 in an unprivileged container), on /data/media if it is there, otherwise on the folder itself.
 */
export function mediaProbeScript(l: Layout, vmid: number): string {
  const base = probeScript(l, vmid)
  if (l.media !== 'path') return base
  return base + [
    'if [ -n "${R:-}" ]; then',
    '  T="$R"; [ -d "$R/media" ] && T="$R/media"',
    `  if setpriv --reuid=${HOST_UID} --regid=${100000 + PGID} --clear-groups sh -c 'f="$1/.hyperprox-write-test"; : > "$f" && rm -f "$f"' sh "$T" 2>/dev/null; then echo "@@arr writable"; else echo "@@arr readonly $T"; fi`,
    'fi',
  ].join('\n') + '\n'
}

export interface MediaVerdict { errors: string[]; warnings: string[]; checks: string[] }

/** What the node's answer means for this layout, including the write test. */
export function judgeMedia(out: string, l: Layout, vmid: number): MediaVerdict {
  const p: Probe = parseProbe(out)
  const j = judgeProbe(p, l, vmid)
  if (l.media === 'path' && !j.errors.length) {
    if (/^@@arr readonly /m.test(out)) {
      j.errors.push(`${l.hostPath} is not writable by the container's user (uid ${PUID} inside, ${HOST_UID} on the node). These apps replace files in place, so let that user write there, for example by giving group ${100000 + PGID} write access, or pick another folder.`)
    } else if (/^@@arr writable$/m.test(out)) j.checks.push(`uid ${HOST_UID} can write there, as these apps need.`)
  }
  return j
}

/**
 * After the create, before Docker is installed, for a container with no library (an Unmanic worker): stop it, give
 * it nesting and keyctl (Docker needs both) and its hardware devices, start it again. The Arr Stack's own script
 * does this with the library on top; the device pairs are checked the same way there.
 */
export function prepareNoLibraryScript(o: { vmid: number; extra: Array<[string, string]> }): string {
  if (!Number.isInteger(o.vmid) || o.vmid < 100) throw new Error('Bad container id.')
  const set = ['--features nesting=1,keyctl=1']
  for (const [flag, value] of o.extra) {
    if (!/^--dev\d{1,2}$/.test(flag)) throw new Error('Refused: only device settings may be added.')
    set.push(`${flag} ${sq(safe(value))}`)
  }
  return [
    'set -eu', `V=${o.vmid}`,
    'if pct status "$V" | grep -q running; then pct stop "$V"; fi',
    `pct set "$V" ${set.join(' ')}`,
    'pct start "$V"', 'echo "@@arr prepared"',
  ].join('\n') + '\n'
}

export { hostMountPoint }
