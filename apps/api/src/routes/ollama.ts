// =============================================================================
//  HyperProx — Ollama Routes
//  Manages Ollama connection (existing or HyperProx-managed),
//  model library with hardware-aware recommendations, pull/delete models.
// =============================================================================

import { FastifyPluginAsync } from 'fastify'
import { getCredential, setCredential } from '../lib/credentials'

// ── Model catalog ─────────────────────────────────────────────────────────────

interface ModelSpec {
  id:          string   // ollama pull name
  name:        string
  description: string
  params:      string   // e.g. "3B"
  ramGB:       number   // minimum RAM required (CPU-only)
  vramGB:      number   // minimum VRAM for full GPU inference
  sizeGB:      number   // download size at Q4_K_M
  tier:        'nano' | 'small' | 'medium' | 'large'
  strengths:   string[]
  good_for_wizard: boolean  // reliable structured JSON output
  tags:        string[]
}

const MODEL_CATALOG: ModelSpec[] = [
  {
    id:          'llama3.2:1b',
    name:        'Llama 3.2 1B',
    description: 'Meta\'s smallest model. Fits on anything — even a Raspberry Pi. Best for simple Q&A and basic tasks.',
    params:      '1B',
    ramGB:       1.5,
    vramGB:      1.5,
    sizeGB:      0.7,
    tier:        'nano',
    strengths:   ['Ultra low resource', 'Fast responses', 'Simple tasks'],
    good_for_wizard: false,
    tags:        ['cpu-friendly', 'minimal'],
  },
  {
    id:          'llama3.2:3b',
    name:        'Llama 3.2 3B',
    description: 'Meta\'s edge model, built for tool calling and structured outputs. Best CPU-only choice for the deployment wizard.',
    params:      '3B',
    ramGB:       2.5,
    vramGB:      2.5,
    sizeGB:      2.0,
    tier:        'small',
    strengths:   ['Tool calling', 'Structured JSON', 'CPU-friendly', 'Fast'],
    good_for_wizard: true,
    tags:        ['cpu-friendly', 'recommended', 'tool-calling'],
  },
  {
    id:          'phi4-mini',
    name:        'Phi-4 Mini 3.8B',
    description: 'Microsoft\'s compact model. Punches above its weight on reasoning tasks. Great for CPU-only setups.',
    params:      '3.8B',
    ramGB:       3.0,
    vramGB:      3.0,
    sizeGB:      2.3,
    tier:        'small',
    strengths:   ['Reasoning', 'Code', 'Instruction following'],
    good_for_wizard: true,
    tags:        ['cpu-friendly', 'reasoning'],
  },
  {
    id:          'qwen3.5:3b',
    name:        'Qwen 3.5 3B',
    description: 'Alibaba\'s small model with impressive multilingual support and solid JSON output. Runs on minimal hardware.',
    params:      '3B',
    ramGB:       2.5,
    vramGB:      2.5,
    sizeGB:      1.9,
    tier:        'small',
    strengths:   ['Multilingual', 'JSON output', 'Fast'],
    good_for_wizard: true,
    tags:        ['cpu-friendly', 'multilingual'],
  },
  {
    id:          'llama3.1:8b',
    name:        'Llama 3.1 8B',
    description: 'The "Honda Civic" of local LLMs. 111M+ Ollama downloads. Solid all-rounder for conversation and light automation.',
    params:      '8B',
    ramGB:       6.0,
    vramGB:      6.0,
    sizeGB:      4.9,
    tier:        'medium',
    strengths:   ['Versatile', 'Well-tested', 'Good JSON'],
    good_for_wizard: true,
    tags:        ['popular', 'balanced'],
  },
  {
    id:          'qwen3.5:9b',
    name:        'Qwen 3.5 9B',
    description: 'Best quality under 8GB VRAM. Excellent instruction following and structured output. Recommended for GPU installs.',
    params:      '9B',
    ramGB:       7.0,
    vramGB:      6.0,
    sizeGB:      5.5,
    tier:        'medium',
    strengths:   ['Best-in-class 8GB', 'Instruction following', 'JSON'],
    good_for_wizard: true,
    tags:        ['gpu-recommended', 'high-quality'],
  },
  {
    id:          'qwen3.5:14b',
    name:        'Qwen 3.5 14B',
    description: 'Premium quality for the deployment wizard. Handles complex multi-step automation reliably.',
    params:      '14B',
    ramGB:       12.0,
    vramGB:      10.0,
    sizeGB:      9.0,
    tier:        'large',
    strengths:   ['Complex reasoning', 'Multi-step automation', 'High accuracy'],
    good_for_wizard: true,
    tags:        ['high-vram', 'premium'],
  },
  {
    id:          'qwen3.5:35b-a3b',
    name:        'Qwen 3.5 35B (MoE)',
    description: 'Mixture-of-Experts architecture — only 3B parameters active at once. Runs fast on 16GB VRAM despite the 35B label.',
    params:      '35B (3B active)',
    ramGB:       16.0,
    vramGB:      14.0,
    sizeGB:      20.0,
    tier:        'large',
    strengths:   ['Fast inference', 'High quality', 'Efficient MoE'],
    good_for_wizard: true,
    tags:        ['high-vram', 'moe', 'efficient'],
  },
]

// ── Ollama client helpers ─────────────────────────────────────────────────────

async function getOllamaUrl(): Promise<string | null> {
  const stored = await getCredential('ai', 'ollama', 'url')
  return stored || process.env.OLLAMA_URL || null
}

async function ollamaFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const url = await getOllamaUrl()
  if (!url) throw new Error('Ollama is not configured. Connect an instance in AI Settings.')
  const res = await fetch(`${url}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Ollama API ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

// ── Hardware detection ────────────────────────────────────────────────────────

async function getSystemHardware() {
  try {
    const { ProxmoxClient } = await import('../lib/proxmox-client')
    const host   = process.env.PROXMOX_HOST ?? ''
    const port   = Number(process.env.PROXMOX_PORT ?? 8006)
    const token  = `${process.env.PROXMOX_USER ?? 'root@pam'}!${process.env.PROXMOX_TOKEN_ID ?? ''}`
    const secret = process.env.PROXMOX_TOKEN_SECRET ?? ''

    if (!host || !secret) return null

    const client = new ProxmoxClient(host, port, token, secret)
    const nodes  = await client.getNodes()

    let totalRamGB  = 0
    let maxVramGB   = 0
    let totalCores  = 0

    for (const node of nodes) {
      const status = await client.getNodeStatus(node.node).catch(() => null)
      if (!status) continue
      totalRamGB += (status.memory?.total ?? 0) / 1073741824
      totalCores += status.cpuinfo?.cpus ?? 0
    }

    // Check Prometheus for GPU VRAM if available
    try {
      const vramRes = await fetch(
        `http://localhost:9090/api/v1/query?query=nvidia_smi_memory_total_bytes`,
        { signal: AbortSignal.timeout(2000) }
      )
      const vramJson = await vramRes.json() as any
      const vramBytes = parseFloat(vramJson?.data?.result?.[0]?.value?.[1] ?? '0')
      maxVramGB = vramBytes / 1073741824
    } catch { /* no GPU data */ }

    return { totalRamGB, maxVramGB, totalCores }
  } catch {
    return null
  }
}

function recommendModels(hw: { totalRamGB: number; maxVramGB: number } | null): string[] {
  if (!hw) return ['llama3.2:3b']

  const hasGpu  = hw.maxVramGB > 2
  const ramGB   = hw.totalRamGB
  const vramGB  = hw.maxVramGB

  if (hasGpu && vramGB >= 14) return ['qwen3.5:35b-a3b', 'qwen3.5:14b', 'qwen3.5:9b']
  if (hasGpu && vramGB >= 8)  return ['qwen3.5:9b', 'llama3.1:8b', 'qwen3.5:14b']
  if (hasGpu && vramGB >= 4)  return ['llama3.2:3b', 'phi4-mini', 'qwen3.5:3b']
  if (ramGB >= 8)             return ['llama3.2:3b', 'phi4-mini', 'qwen3.5:3b']
  if (ramGB >= 4)             return ['llama3.2:3b', 'phi4-mini']
  return ['llama3.2:1b', 'llama3.2:3b']
}

// ── Routes ────────────────────────────────────────────────────────────────────

export const ollamaRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /api/ai/status — connection status + installed models
  fastify.get('/status', async (_req, reply) => {
    const url = await getOllamaUrl()
    if (!url) {
      return reply.send({ connected: false, url: null, models: [], managed: false })
    }

    try {
      const data = await ollamaFetch<{ models: Array<{ name: string; size: number; digest: string }> }>('/api/tags')
      return reply.send({
        connected: true,
        url,
        models:  data.models ?? [],
        managed: url.includes('localhost') || url.includes('127.0.0.1'),
      })
    } catch (err: any) {
      return reply.send({ connected: false, url, error: err.message, models: [] })
    }
  })

  // GET /api/ai/detect — scan cluster for running Ollama instances
  fastify.get('/detect', async (_req, reply) => {
    try {
      const { ProxmoxClient } = await import('../lib/proxmox-client')
      const host   = process.env.PROXMOX_HOST ?? ''
      const port   = Number(process.env.PROXMOX_PORT ?? 8006)
      const token  = `${process.env.PROXMOX_USER ?? 'root@pam'}!${process.env.PROXMOX_TOKEN_ID ?? ''}`
      const secret = process.env.PROXMOX_TOKEN_SECRET ?? ''

      if (!host || !secret) return reply.send({ ok: true, found: [] })

      const client    = new ProxmoxClient(host, port, token, secret)
      const resources = await client.getClusterResources('vm')
      const found: Array<{ url: string; name: string; vmid: number }> = []

      // Probe each running CT/VM for Ollama on port 11434
      const probes = (resources as any[])
        .filter(r => r.status === 'running' && (r.type === 'lxc' || r.type === 'qemu'))
        .map(async r => {
          // Get CT config to find IP
          try {
            const path    = r.type === 'lxc' ? `/nodes/${r.node}/lxc/${r.vmid}/config` : `/nodes/${r.node}/qemu/${r.vmid}/config`
            const config  = await (client as any).fetchNode(path)
            const cfgStr  = JSON.stringify(config ?? '')
            // Extract IP from net config (e.g. "ip=192.168.2.244/24")
            const ipMatch = cfgStr.match(/ip=(\d+\.\d+\.\d+\.\d+)/)
            if (!ipMatch) return

            const ip  = ipMatch[1]
            const url = `http://${ip}:11434`
            const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) })
            if (res.ok) {
              found.push({ url, name: r.name ?? `CT ${r.vmid}`, vmid: r.vmid })
            }
          } catch { /* not running Ollama */ }
        })

      await Promise.all(probes)
      return reply.send({ ok: true, found })
    } catch (err: any) {
      return reply.send({ ok: true, found: [], error: err.message })
    }
  })

  // DELETE /api/ai/disconnect — remove Ollama connection
  fastify.delete('/disconnect', async (_req, reply) => {
    const { PrismaClient } = await import('@prisma/client')
    const prisma = new PrismaClient()
    await prisma.credential.deleteMany({ where: { category: 'ai', provider: 'ollama' } })
    await prisma.$disconnect()
    return reply.send({ ok: true })
  })

  // GET /api/ai/catalog — model library with hardware recommendations
  fastify.get('/catalog', async (_req, reply) => {
    const hw           = await getSystemHardware()
    const recommended  = recommendModels(hw)

    // Get currently installed models
    let installed: string[] = []
    try {
      const data = await ollamaFetch<{ models: Array<{ name: string }> }>('/api/tags')
      installed  = (data.models ?? []).map(m => m.name.split(':')[0] + ':' + (m.name.split(':')[1] ?? 'latest'))
    } catch { /* ollama not connected yet */ }

    // Add any installed models not in our catalog
    const catalogIds = new Set(MODEL_CATALOG.map(m => m.id.split(':')[0]))
    const extraModels: ModelSpec[] = installed
      .filter(name => !catalogIds.has(name.split(':')[0]))
      .map(name => ({
        id:              name,
        name:            name,
        description:     'Installed on your Ollama instance.',
        params:          '?',
        ramGB:           0,
        vramGB:          0,
        sizeGB:          0,
        tier:            'medium' as const,
        strengths:       [],
        good_for_wizard: true,
        tags:            ['installed'],
        recommended:     false,
        installed:       true,
        fits_gpu:        true,
        fits_cpu:        true,
      }))

    const catalog = [...MODEL_CATALOG.map(m => ({
      ...m,
      recommended:  recommended.includes(m.id),
      installed:    installed.some(i => i === m.id || i.startsWith(m.id.split(':')[0])),
      fits_gpu:     hw ? hw.maxVramGB >= m.vramGB : false,
      fits_cpu:     hw ? hw.totalRamGB >= m.ramGB : true,
    })), ...extraModels]

    return reply.send({
      ok:          true,
      catalog,
      hardware:    hw,
      recommended,
    })
  })

  // POST /api/ai/connect — save Ollama URL
  fastify.post<{ Body: { url: string } }>('/connect', async (req, reply) => {
    const { url } = req.body
    if (!url) return reply.status(400).send({ error: 'url is required' })

    // Test connection
    try {
      const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err: any) {
      return reply.status(400).send({ ok: false, error: `Cannot reach Ollama at ${url}: ${err.message}` })
    }

    await setCredential('ai', 'ollama', 'url', url, false)
    return reply.send({ ok: true })
  })

  // POST /api/ai/pull — start pulling a model (streaming progress via WebSocket recommended, falls back to SSE)
  fastify.post<{ Body: { model: string } }>('/pull', async (req, reply) => {
    const { model } = req.body
    if (!model) return reply.status(400).send({ error: 'model is required' })

    const url = await getOllamaUrl()
    if (!url) return reply.status(400).send({ error: 'Ollama not configured' })

    // Fire-and-forget pull — client polls /api/ai/status for installed models
    fetch(`${url}/api/pull`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: model, stream: false }),
    }).catch(err => fastify.log.error(`Model pull failed: ${err.message}`))

    return reply.send({ ok: true, message: `Pulling ${model} in background. Check status to monitor progress.` })
  })

  // DELETE /api/ai/models/:model — delete an installed model
  fastify.delete<{ Params: { model: string } }>('/models/:model', async (req, reply) => {
    const { model } = req.params
    try {
      await ollamaFetch('/api/delete', {
        method: 'DELETE',
        body:   JSON.stringify({ name: model }),
      })
      return reply.send({ ok: true })
    } catch (err: any) {
      return reply.status(400).send({ ok: false, error: err.message })
    }
  })

  // POST /api/ai/generate — raw generation for the deployment wizard
  fastify.post<{ Body: { prompt: string; model?: string; system?: string } }>('/generate', async (req, reply) => {
    const { prompt, model, system } = req.body
    if (!prompt) return reply.status(400).send({ error: 'prompt is required' })

    const url = await getOllamaUrl()
    if (!url) return reply.status(400).send({ error: 'Ollama not configured' })

    try {
      const res = await fetch(`${url}/api/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:    model ?? 'llama3.2:3b',
          stream:   false,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: prompt },
          ],
          options: { temperature: 0.1 },  // low temp for deterministic JSON
        }),
        signal: AbortSignal.timeout(60000),
      })
      const data = await res.json() as { message?: { content: string }; error?: string }
      if (data.error) throw new Error(data.error)
      return reply.send({ ok: true, content: data.message?.content ?? '' })
    } catch (err: any) {
      return reply.status(500).send({ ok: false, error: err.message })
    }
  })
}
