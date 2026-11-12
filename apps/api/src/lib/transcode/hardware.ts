// =============================================================================
//  HyperProx — hardware acceleration for the transcoders (Unmanic, Tdarr)
//
//  A transcoder is only quick with a GPU's video engine. Each node can offer one
//  of three things, found by looking, never assumed:
//
//    vaapi   Intel or AMD graphics: the render node under /dev/dri, shared into
//            the container with Proxmox's own `devN` setting, plus the render
//            group so the app's user may open it.
//    nvidia  An NVIDIA card whose driver is already loaded on the node. HyperProx
//            never installs or changes a driver on a node; it shares the card's
//            device files and puts the matching user-space libraries in the
//            container only (the container's copy must equal the node's
//            version, or the card is unusable from inside).
//    cpu     Nothing to share. Always possible, always slower.
//
//  What is on a node is read with the same read-only probe the Infrastructure
//  page uses (guest-config/devices.ts), so there is one idea of "this node has a
//  GPU" in HyperProx. This file only decides from its answer.
// =============================================================================

import { PROBE_SCRIPT, parseProbe, type Device } from '../guest-config/devices'

export type Accel = 'vaapi' | 'nvidia' | 'cpu'
export type AccelChoice = Accel | 'auto'

export const ACCEL_CHOICES: AccelChoice[] = ['auto', 'vaapi', 'nvidia', 'cpu']

/** The node's own probe, plus the numeric ids of the render and video groups, which differ from node to node. */
export const HARDWARE_SCRIPT = `${PROBE_SCRIPT.replace(/\necho '##end'\n?$/, '\n')}
echo '##tcgroups'; getent group render video 2>/dev/null
echo '##end'
`

export interface NodeHardware {
  vaapi: {
    /** The names the person sees ("Intel UHD Graphics 630"). */
    names: string[]
    /** Render nodes (the ones video encoders open), then the card nodes libva also looks at. */
    renderNodes: string[]
    cardNodes: string[]
    renderGid: number
    videoGid: number
  } | null
  nvidia: {
    names: string[]
    /** The node's loaded driver version, which the container's libraries must equal. */
    driver: string
    nodes: string[]
  } | null
}

const DRIVER_RE = /^\d{3}\.\d{2,3}(\.\d{2})?$/
const RENDER_NODE = /^\/dev\/dri\/renderD\d{3}$/
const CARD_NODE = /^\/dev\/dri\/card\d{1,2}$/
const NVIDIA_NODE = /^\/dev\/nvidia(ctl|-uvm|-uvm-tools|-modeset|\d{1,2})$/

/** What a node can share, from its probe output. Nothing is guessed: no device file, no offer. */
export function parseHardware(node: string, out: string): NodeHardware {
  const inv = parseProbe(node, out)
  const groups = new Map<string, number>()
  const g = /##tcgroups\n([\s\S]*?)(?:\n##|$)/.exec(out)?.[1] ?? ''
  for (const l of g.split('\n')) { const m = /^(render|video):[^:]*:(\d+):/.exec(l.trim()); if (m) groups.set(m[1], Number(m[2])) }

  const gpus = inv.devices.filter((d): d is Device => d.kind === 'gpu')
  const drm = gpus.filter(d => (d.vendor === 'intel' || d.vendor === 'amd') && d.paths.some(p => RENDER_NODE.test(p)))
  const vaapi: NodeHardware['vaapi'] = drm.length && groups.get('render') !== undefined ? {
    names: drm.map(d => d.product),
    renderNodes: [...new Set(drm.flatMap(d => d.paths.filter(p => RENDER_NODE.test(p))))].sort(),
    cardNodes: [...new Set(drm.flatMap(d => d.paths.filter(p => CARD_NODE.test(p))))].sort(),
    renderGid: groups.get('render')!,
    videoGid: groups.get('video') ?? 44,
  } : null

  const nv = gpus.filter(d => d.vendor === 'nvidia')
  const nvNodes = [...new Set(inv.nvidiaNodes.filter(p => NVIDIA_NODE.test(p)))].sort()
  const driver = inv.nvidiaDriver && DRIVER_RE.test(inv.nvidiaDriver) ? inv.nvidiaDriver : null
  const nvidia: NodeHardware['nvidia'] = nv.length && driver && nvNodes.some(p => /\/dev\/nvidia\d/.test(p)) && nvNodes.includes('/dev/nvidiactl')
    ? { names: nv.map(d => d.product), driver, nodes: nvNodes } : null
  return { vaapi, nvidia }
}

/** The pick for 'auto': the integrated or AMD engine first (cheap, always on), then NVIDIA, then the CPU. */
export function autoAccel(h: NodeHardware): Accel {
  return h.vaapi ? 'vaapi' : h.nvidia ? 'nvidia' : 'cpu'
}

export interface AccelVerdict { accel: Accel; errors: string[]; checks: string[]; warnings: string[] }

/** Resolve a choice against what the node has. A choice the node cannot honour is an error, never a quiet fallback. */
export function resolveAccel(choice: string, h: NodeHardware, node: string): AccelVerdict {
  const errors: string[] = [], checks: string[] = [], warnings: string[] = []
  const c = (ACCEL_CHOICES as string[]).includes(choice) ? (choice as AccelChoice) : 'auto'
  const accel: Accel = c === 'auto' ? autoAccel(h) : c
  if (accel === 'vaapi') {
    if (!h.vaapi) errors.push(`${node} has no Intel or AMD graphics to share (no render node under /dev/dri). Pick another node, NVIDIA or CPU only.`)
    else checks.push(`Hardware: ${h.vaapi.names.join(', ')} on ${node}, shared as ${h.vaapi.renderNodes.join(', ')} (VAAPI), with the render group (${h.vaapi.renderGid}).`)
  } else if (accel === 'nvidia') {
    if (!h.nvidia) errors.push(`${node} has no NVIDIA card with a loaded driver. HyperProx shares a driver that is already on the node and never installs one there.`)
    else {
      checks.push(`Hardware: ${h.nvidia.names.join(', ')} on ${node}, driver ${h.nvidia.driver}; the container gets the same version of the user-space libraries.`)
      warnings.push(`The container's NVIDIA libraries are downloaded from NVIDIA at exactly version ${h.nvidia.driver} so they equal the node's driver. If the node's driver changes later, the container's copy must be updated to match or the card stops working inside it.`)
    }
  } else {
    checks.push(c === 'auto' ? `${node} has nothing to share, so this one transcodes on the CPU.` : 'CPU only, as chosen.')
    warnings.push('Transcoding on the CPU works but is several times slower than a GPU and keeps every core busy; the node\'s other guests will feel it.')
  }
  return { accel, errors, checks, warnings }
}

/** The container settings that give the container its hardware, as `--devN` pairs for `pct set`. */
export function deviceSettings(accel: Accel, h: NodeHardware): Array<[string, string]> {
  const out: Array<[string, string]> = []
  if (accel === 'vaapi' && h.vaapi) {
    const paths = [...h.vaapi.renderNodes.map(p => `${p},gid=${h.vaapi!.renderGid}`), ...h.vaapi.cardNodes.map(p => `${p},gid=${h.vaapi!.videoGid}`)]
    paths.forEach((v, i) => out.push([`--dev${i}`, v]))
  } else if (accel === 'nvidia' && h.nvidia) {
    h.nvidia.nodes.forEach((p, i) => out.push([`--dev${i}`, p]))
  }
  return out
}

/** The ids the compose file adds to the app's groups so its user may open the render and card nodes. */
export function groupAdd(accel: Accel, h: NodeHardware): number[] {
  return accel === 'vaapi' && h.vaapi ? [...new Set([h.vaapi.renderGid, h.vaapi.videoGid])] : []
}

/** Facts for the wizard's picker: what this node offers, in words. */
export function hardwareFacts(h: NodeHardware) {
  return {
    vaapi: h.vaapi ? { names: h.vaapi.names } : null,
    nvidia: h.nvidia ? { names: h.nvidia.names, driver: h.nvidia.driver } : null,
    auto: autoAccel(h),
  }
}
