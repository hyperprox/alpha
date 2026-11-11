// =============================================================================
//  HyperProx — GPU Service (nvidia-smi on the node over its pinned login + process → CT mapping)
// =============================================================================

const CACHE_TTL = 5_000

export interface GPUConsumer {
  pid:        number
  vram_mb:    number
  process:    string
  ct_id:      string | null   // LXC CT ID if identifiable
  ct_name:    string | null   // resolved from VM list
  vram_pct:   number
}

export interface GPUInfo {
  name:        string
  vram_total:  number
  vram_used:   number
  vram_free:   number
  gpu_util:    number
  temp:        number
  power_draw:  number
  power_limit: number
  vram_pct:    number
  power_pct:   number
  consumers:   GPUConsumer[]
}

let cache: { data: GPUInfo; ts: number } | null = null

// Friendly name mapping for known process signatures
const PROCESS_NAMES: Record<string, string> = {
  'venv/bin/python': 'Python/AI',
  'python3':         'Python',
  'python':          'Python',
  'ollama':          'Ollama',
  'plex':            'Plex',
  'jellyfin':        'Jellyfin',
  'ffmpeg':          'FFmpeg',
}

function friendlyProcess(raw: string): string {
  const base = raw.split('/').pop() ?? raw
  for (const [key, label] of Object.entries(PROCESS_NAMES)) {
    if (raw.includes(key)) return label
  }
  return base
}

/**
 * One script on the node: the GPU's numbers, then each process using it with the guest its cgroup belongs to.
 * Run over the node login with the pinned host key (lib/node-exec.ts), like every other node command; this used
 * to run the ssh command with host-key checking switched off, which would have talked to any machine answering there.
 */
export const GPU_SCRIPT = [
  "nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits || exit 3",
  "echo '---'",
  "nvidia-smi --query-compute-apps=pid,used_gpu_memory,process_name --format=csv,noheader,nounits 2>/dev/null | while IFS=, read -r pid mem name; do",
  "  pid=$(echo \"$pid\" | tr -dc 0-9); [ -n \"$pid\" ] || continue",
  "  ct=$(grep -oP '(?<=lxc/)\\d+|(?<=qemu/)\\d+' /proc/$pid/cgroup 2>/dev/null | head -1)",
  "  echo \"$pid,$mem,$name,$ct\"",
  "done",
  "true",
].join('\n')

/** The script's output, read into GPUInfo. Null when there is no GPU line. */
export function parseGpuOutput(out: string, vmList?: Array<{ vmid: number; name: string }>): GPUInfo | null {
  const [statsRaw, procsRaw = ''] = out.split(/^---$/m)
  const parts = (statsRaw ?? '').trim().split('\n')[0]?.split(',').map(x => x.trim()) ?? []
  if (parts.length < 8) return null
  const vramTotal = Number(parts[1])
  const consumers: GPUConsumer[] = procsRaw.trim().split('\n').filter(Boolean).flatMap(line => {
    const f = line.split(',').map(x => x.trim())
    const pid = Number(f[0]); if (!pid) return []
    const vram_mb = Number(f[1]) || 0
    const ct_id = f[3] && /^\d+$/.test(f[3]) ? f[3] : null
    const ct_name = ct_id && vmList ? vmList.find(v => String(v.vmid) === ct_id)?.name ?? null : null
    return [{ pid, vram_mb, process: friendlyProcess(f[2] ?? ''), ct_id, ct_name, vram_pct: vramTotal ? Math.round((vram_mb / vramTotal) * 100) : 0 }]
  })
  return {
    name:        parts[0],
    vram_total:  vramTotal,
    vram_used:   Number(parts[2]),
    vram_free:   Number(parts[3]),
    gpu_util:    Number(parts[4]),
    temp:        Number(parts[5]),
    power_draw:  parseFloat(parts[6]),
    power_limit: parseFloat(parts[7]),
    vram_pct:    vramTotal ? Math.round((Number(parts[2]) / vramTotal) * 100) : 0,
    power_pct:   Math.round((parseFloat(parts[6]) / parseFloat(parts[7])) * 100),
    consumers,
  }
}

/** The home node at PROXMOX_HOST, by the address Proxmox records for it (never a DNS name). */
let hostNode: { host: string; node: string } | null = null
async function nodeAtProxmoxHost(): Promise<string | null> {
  const host = process.env.PROXMOX_HOST ?? ''
  if (!host) return null
  if (hostNode?.host === host) return hostNode.node
  const { livePve } = await import('./pve-env')
  const rows = await livePve().fetchStrict<any[]>('/cluster/status', 'GET', undefined, 5_000).catch(() => [])
  const n = (rows ?? []).find(r => r?.type === 'node' && String(r.ip) === host)
  if (!n) return null
  hostNode = { host, node: String(n.name) }
  return hostNode.node
}

const MISS_TTL = 60_000
let missUntil = 0

export async function getGPUInfo(vmList?: Array<{vmid: number; name: string; node: string}>): Promise<GPUInfo | null> {
  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.data
  if (Date.now() < missUntil) return null
  try {
    const host = process.env.PROXMOX_HOST ?? ''
    const node = await nodeAtProxmoxHost()
    const { nodeCredential, execOnNode } = await import('./node-exec')
    const cred = node ? await nodeCredential(node) : null
    if (!node || !cred) { missUntil = Date.now() + MISS_TTL; return null }
    const r = await execOnNode({ host, cred, command: 'bash -s', input: GPU_SCRIPT, timeoutMs: 8_000, maxOutputBytes: 256 * 1024 })
    const info = r.code === 0 ? parseGpuOutput(r.output, vmList) : null
    if (!info) { missUntil = Date.now() + MISS_TTL; return null }
    cache = { data: info, ts: Date.now() }
    return info
  } catch {
    missUntil = Date.now() + MISS_TTL
    return null
  }
}
