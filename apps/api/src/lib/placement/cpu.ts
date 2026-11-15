// =============================================================================
//  HyperProx — placement advisor: can a running VM live-migrate to that CPU?
//
//  A VM sees the CPU model in its config. "host" passes the node's own CPU
//  through, so a live migration to a different model can crash the guest the
//  moment it uses an instruction the new CPU lacks. The x86-64 levels and
//  named models need their flags on the target. A stopped VM moves offline and
//  starts fresh, so none of this applies to it.
// =============================================================================

import type { Reason } from './types'

export interface NodeCpu { model: string | null; vendor: string | null; flags: string[] | null }

/** The flags each x86-64 level (as PVE names them) needs beyond the baseline every 64-bit CPU has. */
const LEVELS: Record<string, string[]> = {
  'x86-64-v2': ['cx16', 'lahf_lm', 'popcnt', 'sse4_1', 'sse4_2', 'ssse3'],
  'x86-64-v2-aes': ['cx16', 'lahf_lm', 'popcnt', 'sse4_1', 'sse4_2', 'ssse3', 'aes'],
  'x86-64-v3': ['cx16', 'lahf_lm', 'popcnt', 'sse4_1', 'sse4_2', 'ssse3', 'avx', 'avx2', 'bmi1', 'bmi2', 'f16c', 'fma', 'movbe', 'xsave'],
  'x86-64-v4': ['cx16', 'lahf_lm', 'popcnt', 'sse4_1', 'sse4_2', 'ssse3', 'avx', 'avx2', 'bmi1', 'bmi2', 'f16c', 'fma', 'movbe', 'xsave',
    'avx512f', 'avx512bw', 'avx512cd', 'avx512dq', 'avx512vl'],
}

/** Generic models every x86-64 node runs. */
const GENERIC = new Set(['kvm64', 'qemu64', 'kvm32', 'qemu32', 'x86-64-v1'])

/** QEMU's named models are one vendor's: an AMD model will not run on an Intel node, and the other way round. */
function vendorOfModel(model: string): 'AuthenticAMD' | 'GenuineIntel' | null {
  const m = model.toLowerCase()
  if (/^(epyc|opteron|phenom|athlon)/.test(m)) return 'AuthenticAMD'
  if (/^(skylake|cascadelake|icelake|sapphirerapids|broadwell|haswell|ivybridge|sandybridge|westmere|nehalem|penryn|conroe|cooperlake|snowridge|denverton|kabylake|coffeelake|granite)/.test(m)) return 'GenuineIntel'
  return null
}

/** The `cpu` line of a VM config: "host", "x86-64-v2-AES", "cputype=host,flags=+aes". Unset is kvm64. */
export function cpuTypeOf(config: Record<string, unknown> | null | undefined): string {
  const raw = String(config?.cpu ?? '').trim()
  if (!raw) return 'kvm64'
  const first = raw.split(',')[0]
  const v = first.includes('=') ? (/(?:^|,)cputype=([^,]+)/.exec(raw)?.[1] ?? 'kvm64') : first
  return v.trim()
}

export const parseFlags = (s: unknown): string[] | null => {
  const t = String(s ?? '').trim()
  return t ? t.split(/\s+/) : null
}

/**
 * One reason (or none) about the target's CPU for a running VM. Stopped guests and containers: none.
 * `type` is the VM's cpu type from cpuTypeOf.
 */
export function cpuReason(type: string, running: boolean, from: NodeCpu, to: NodeCpu, toNode: string): Reason | null {
  if (!running) return null
  const t = type.toLowerCase()
  if (GENERIC.has(t)) return null
  if (t === 'host' || t === 'max') {
    if (!from.model || !to.model) return { code: 'cpu-type', level: 'unknown', words: `Its CPU type is "${type}" (the node's own CPU passed through), and the CPU model of ${toNode} could not be read.` }
    if (from.model === to.model) return null
    return { code: 'cpu-type', level: 'block', words: `Its CPU type is "${type}": a live move from ${from.model} to ${to.model} on ${toNode} can crash it. Move it stopped, or set a CPU type both nodes support (such as x86-64-v2-AES).` }
  }
  const level = LEVELS[t]
  if (level) {
    if (!to.flags) return { code: 'cpu-type', level: 'unknown', words: `Its CPU type is ${type}, and the CPU flags of ${toNode} could not be read.` }
    const missing = level.filter(f => !to.flags!.includes(f))
    if (!missing.length) return null
    return { code: 'cpu-type', level: 'block', words: `Its CPU type is ${type}, which needs ${missing.join(', ')}: the CPU on ${toNode} does not have ${missing.length === 1 ? 'it' : 'them'}.` }
  }
  const vendor = vendorOfModel(t)
  if (vendor) {
    if (!to.vendor) return { code: 'cpu-type', level: 'unknown', words: `Its CPU type is ${type}, and the CPU vendor of ${toNode} could not be read.` }
    if (to.vendor !== vendor) return { code: 'cpu-type', level: 'block', words: `Its CPU type is ${type}, a model ${toNode}'s CPU (${to.model ?? to.vendor}) cannot provide.` }
    return null
  }
  return { code: 'cpu-type', level: 'unknown', words: `Its CPU type is ${type}; HyperProx cannot tell whether ${toNode}'s CPU supports it.` }
}
