// =============================================================================
//  HyperProx — GPU Service (nvidia-smi via SSH + process → CT mapping)
// =============================================================================

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
const SSH = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 root@${process.env.PROXMOX_HOST ?? 'localhost'}`
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

export async function getGPUInfo(vmList?: Array<{vmid: number; name: string; node: string}>): Promise<GPUInfo | null> {
  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.data

  try {
    // Step 1 — GPU stats
    const statsQuery = 'name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw,power.limit'
    const { stdout: statsRaw } = await execAsync(
      `${SSH} "nvidia-smi --query-gpu=${statsQuery} --format=csv,noheader,nounits"`,
      { timeout: 5000 }
    )
    const parts = statsRaw.trim().split(',').map(s => s.trim())
    if (parts.length < 8) return null

    // Step 2 — GPU consumers (processes using GPU)
    const { stdout: procsRaw } = await execAsync(
      `${SSH} "nvidia-smi --query-compute-apps=pid,used_gpu_memory,process_name --format=csv,noheader,nounits 2>/dev/null || echo ''"`,
      { timeout: 5000 }
    )

    const consumers: GPUConsumer[] = []
    const vramTotal = Number(parts[1])

    if (procsRaw.trim()) {
      // Step 3 — Map each PID to a CT/VM via cgroup
      const pids = procsRaw.trim().split('\n').map(l => {
        const [pid, vram, proc] = l.split(',').map(s => s.trim())
        return { pid: Number(pid), vram_mb: Number(vram), process: proc }
      }).filter(p => p.pid)

      await Promise.all(pids.map(async ({ pid, vram_mb, process }) => {
        let ct_id: string | null = null
        let ct_name: string | null = null

        try {
          const { stdout: cgroup } = await execAsync(
            `${SSH} "cat /proc/${pid}/cgroup 2>/dev/null | grep -oP '(?<=lxc/)\\d+|(?<=qemu/)\\d+' | head -1"`,
            { timeout: 3000 }
          )
          ct_id = cgroup.trim() || null

          // Resolve CT ID to name from VM list
          if (ct_id && vmList) {
            const match = vmList.find(v => String(v.vmid) === ct_id)
            ct_name = match?.name ?? null
          }
        } catch { /* cgroup not found — host process */ }

        consumers.push({
          pid,
          vram_mb,
          process: friendlyProcess(process),
          ct_id,
          ct_name,
          vram_pct: vramTotal ? Math.round((vram_mb / vramTotal) * 100) : 0,
        })
      }))
    }

    const info: GPUInfo = {
      name:        parts[0],
      vram_total:  vramTotal,
      vram_used:   Number(parts[2]),
      vram_free:   Number(parts[3]),
      gpu_util:    Number(parts[4]),
      temp:        Number(parts[5]),
      power_draw:  parseFloat(parts[6]),
      power_limit: parseFloat(parts[7]),
      vram_pct:    Math.round((Number(parts[2]) / vramTotal) * 100),
      power_pct:   Math.round((parseFloat(parts[6]) / parseFloat(parts[7])) * 100),
      consumers,
    }

    cache = { data: info, ts: Date.now() }
    return info
  } catch {
    return null
  }
}
