// =============================================================================
//  HyperProx — cluster power
//
//  The dashboard used to ask Prometheus for
//  `sum(rate(node_rapl_package_joules_total[2m]))` and print the answer as the
//  cluster's wattage. Two things were wrong with that.
//
//  It is not the cluster. RAPL only reports on hosts whose CPU exposes it —
//  here that is two of five nodes — and `sum()` over a partial set looks
//  exactly like a complete one. A node contributing nothing and a node drawing
//  nothing are indistinguishable in a single number.
//
//  It is not the machine, either. RAPL is the CPU package: no discrete GPU, no
//  drives, no fans, no PSU loss. On a node with a 1070 Ti and six spinning
//  disks that is a minority of the draw.
//
//  So this reads every source that exists, per node, picks one CPU figure per
//  node rather than adding overlapping domains, adds discrete GPUs on top, and
//  says plainly which nodes reported nothing and what is not counted. A number
//  with its own caveats attached is worth more than a confident wrong one.
// =============================================================================

import axios from 'axios'

const PROMETHEUS = process.env.PROMETHEUS_URL ?? `http://${process.env.HOST_IP ?? 'localhost'}:9090`

/** Smoothing window. Long enough that a fan ramp does not swing the reading. */
const WINDOW = '3m'

export interface NodePower {
  node:   string
  /** CPU package watts, from whichever source this host actually has. */
  cpu:    number | null
  /** Discrete GPU watts. Integrated GPUs are inside the CPU package already. */
  gpu:    number | null
  total:  number | null
  source: 'rapl' | 'intel-gpu-exporter' | 'gpu-only' | 'none'
}

export interface ClusterPower {
  /** Watts across every node that reported something. */
  total:     number
  nodes:     NodePower[]
  /** Nodes present in the cluster that reported no power source at all. */
  silent:    string[]
  reporting: number
  of:        number
  /** What this figure is, in the caller's own words to the reader. */
  covers:    string
}

async function query(expr: string): Promise<Array<{ node: string; value: number }>> {
  try {
    const { data } = await axios.get(`${PROMETHEUS}/api/v1/query`, {
      params: { query: expr }, timeout: 8000,
    })
    if (data?.status !== 'success') return []
    return (data.data?.result ?? [])
      .map((r: any) => ({ node: r.metric?.node ?? r.metric?.instance ?? '', value: Number(r.value?.[1]) }))
      .filter((r: any) => r.node && Number.isFinite(r.value))
  } catch {
    return []
  }
}

/** Sum series that share a node — a host can have two GPUs. */
function byNode(rows: Array<{ node: string; value: number }>): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) out.set(r.node, (out.get(r.node) ?? 0) + r.value)
  return out
}

export async function clusterPower(nodeNames: string[]): Promise<ClusterPower> {
  const [rapl, igpuPackage, nvidia] = await Promise.all([
    // Joules are a counter; rate() turns them into watts and survives the wrap.
    query(`rate(node_rapl_package_joules_total[${WINDOW}])`),
    // intel_gpu_top's "package" is the same RAPL package domain read a different
    // way, so it stands in where node_exporter has no RAPL — never in addition.
    // Its companion `igpu_power_gpu` is a slice of that package and is
    // deliberately not read here; adding it would count the same watts twice.
    query(`avg_over_time(igpu_power_package[${WINDOW}])`),
    query(`avg_over_time(nvidia_smi_power_draw_watts[${WINDOW}])`),
  ])

  const cpuRapl = byNode(rapl)
  const cpuIgpu = byNode(igpuPackage)
  const gpu     = byNode(nvidia)

  // Any node Prometheus knows about counts, even if Proxmox did not name it.
  const names = new Set([...nodeNames, ...cpuRapl.keys(), ...cpuIgpu.keys(), ...gpu.keys()])

  const nodes: NodePower[] = [...names].sort().map(node => {
    const cpu = cpuRapl.get(node) ?? cpuIgpu.get(node) ?? null
    const g   = gpu.get(node) ?? null
    const source: NodePower['source'] =
      cpuRapl.has(node) ? 'rapl'
      : cpuIgpu.has(node) ? 'intel-gpu-exporter'
      : g !== null ? 'gpu-only'
      : 'none'
    const total = cpu === null && g === null ? null : (cpu ?? 0) + (g ?? 0)
    return { node, cpu, gpu: g, total, source }
  })

  const reporting = nodes.filter(n => n.total !== null)

  return {
    total:     Math.round(reporting.reduce((a, n) => a + (n.total ?? 0), 0)),
    nodes,
    silent:    nodes.filter(n => n.total === null).map(n => n.node),
    reporting: reporting.length,
    of:        nodes.length,
    covers:    'CPU package and discrete GPU only — drives, fans, memory and PSU losses are not instrumented.',
  }
}
