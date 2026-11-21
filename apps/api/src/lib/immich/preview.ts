// =============================================================================
//  HyperProx — Immich: what the wizard checks before anything is made, and what it sets on the container after
//
//  The same two places the Unmanic and Tdarr recipes hand over (lib/transcode/catalogue.ts), and the same code under
//  them: the node's hardware is looked at and the choice resolved against it (a card the node does not have is an
//  error, never a quiet fallback), the library is looked at from the node (a folder is also written to, as the
//  container's user), and after the create the container gets keyctl, its devices and its library mount over the
//  node's login, read back.
// =============================================================================

import type { ArrDeps } from '../arr/catalogue'
import { HARDWARE_SCRIPT, parseHardware, resolveAccel, type NodeHardware } from '../transcode/hardware'
import { NVIDIA_RUN_SHA256 } from '../transcode/compose'
import { layoutFromOptions, judgeMedia, mediaProbeScript } from '../transcode/media'
import { tcPrepare, type TcPrepareDeps } from '../transcode/catalogue'
import { accelOf, asTranscodeOptions, ffmpegAccel, isIntel } from './recipe'

export interface ImmichPreviewInput {
  node: string; vmid: number; storage: string; diskGb: number
  /** The options after checkOptions. */
  values: Record<string, string>
  storageFreeGb?: number
}

/**
 * The preview's part for Immich. Returns the options the plan keeps: the hardware resolved to what the node really has,
 * the NVIDIA version read from the node (never from the request), and what Immich will be told to use for video. Writes nothing.
 */
export async function immichPreview(i: ImmichPreviewInput, d: { arr?: () => ArrDeps }): Promise<{ errors: string[]; warnings: string[]; checks: string[]; options: Record<string, string> }> {
  const errors: string[] = [], warnings: string[] = [], checks: string[] = []
  const v = i.values
  // Preview-only fields: a request's own value is never used.
  const options: Record<string, string> = { ...v, TC_NVIDIA_VERSION: '', IMMICH_FFMPEG: 'disabled', IMMICH_INTEL: '0' }
  const arr = d.arr?.()
  if (!arr) return { errors: ['HyperProx cannot reach the node to look at it.'], warnings, checks, options }
  const run = (script: string, ms: number) => arr.nodeRun(i.node, script, ms).catch((e: any) => ({ code: -1, output: '', error: e?.message as string }))

  // The node's hardware, and the choice resolved against it (only when one was chosen).
  const want = accelOf(v)
  if (want === 'cpu') checks.push('Hardware acceleration is off: the processor does all the work.')
  else {
    const hr = await run(HARDWARE_SCRIPT, 60_000)
    if (hr.code === -1 || !hr.output) errors.push(`HyperProx could not look at the hardware on ${i.node}.`)
    else {
      const hw: NodeHardware = parseHardware(i.node, hr.output)
      const r = resolveAccel(want, hw, i.node)
      errors.push(...r.errors); warnings.push(...r.warnings.filter(w => !/CPU/.test(w))); checks.push(...r.checks)
      if (!r.errors.length) {
        if (r.accel === 'nvidia' && !NVIDIA_RUN_SHA256[hw.nvidia!.driver]) {
          errors.push(`${i.node}'s NVIDIA driver is ${hw.nvidia!.driver}, and HyperProx has no pinned checksum for that version's installer, so it will not run it in a container. Pick Intel / AMD graphics or no acceleration instead.`)
        } else {
          options.IMMICH_ACCEL = r.accel
          if (r.accel === 'nvidia') options.TC_NVIDIA_VERSION = hw.nvidia!.driver
          options.IMMICH_FFMPEG = ffmpegAccel(r.accel, hw)
          options.IMMICH_INTEL = isIntel(hw) ? '1' : '0'
          if (r.accel === 'vaapi') checks.push(isIntel(hw)
            ? 'Video conversion uses Intel Quick Sync, and face and search recognition runs on the Intel graphics too (OpenVINO).'
            : 'Video conversion uses the graphics through VAAPI. Face and search recognition stays on the processor: its AMD build needs a different device.')
          if (r.accel === 'nvidia') checks.push('Video conversion and recognition both use the NVIDIA card.')
        }
      }
    }
  }

  // The library.
  const lo = layoutFromOptions(asTranscodeOptions(v))
  errors.push(...lo.errors)
  const l = lo.layout
  if (l) {
    if (l.media === 'disk') {
      const need = Math.ceil((l.mediaGb! + i.diskGb) * 1.1)
      if (i.storageFreeGb !== undefined && i.storageFreeGb < need) errors.push(`${i.storage} has ${i.storageFreeGb} GB free: not enough for the ${i.diskGb} GB container and a ${l.mediaGb} GB photo disk.`)
      else checks.push(`The photos get a new ${l.mediaGb} GB disk on ${i.storage}, mounted at /data. It is left out of the container's Proxmox backups: back it up on its own.`)
    } else {
      const r = await run(mediaProbeScript(l, i.vmid), 60_000)
      if (r.code === -1) errors.push(`HyperProx could not run a check on ${i.node}.`)
      else { const j = judgeMedia(r.output, l, i.vmid, true); errors.push(...j.errors); warnings.push(...j.warnings); checks.push(...j.checks) }
    }
    checks.push('Immich keeps its photos in an "immich" folder inside that library, so nothing else there is touched.')
  }
  if (i.diskGb < 16) warnings.push(`${i.diskGb} GB is little room for Immich's database and its search models: the container's own disk holds both.`)
  checks.push('The container gets keyctl as well as nesting (Docker needs both), set on the node through its login.')
  checks.push('Immich gets no public name unless you ask for one below: it is on the container\'s own address only.')
  return { errors, warnings, checks, options }
}

/**
 * After the create: keyctl, the hardware devices and the library mountpoint, over the node's login (an API token cannot set
 * them), read back. The same code the transcoders use, given Immich's choices under their names.
 */
export async function immichPrepare(
  plan: { node: string; vmid: number; storage: string; options?: Record<string, string> }, d: TcPrepareDeps, onMount: () => Promise<void> | void = () => {},
): Promise<{ detail: string; groups: number[] }> {
  const o = plan.options ?? {}
  return tcPrepare({ ...plan, options: { ...o, ...asTranscodeOptions(o) } }, 'unmanic', d, onMount)
}
