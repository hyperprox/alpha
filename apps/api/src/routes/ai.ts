// =============================================================================
//  HyperProx — AI Deployment Wizard Routes
//  Natural language → structured action plan → execute
// =============================================================================

import { FastifyPluginAsync } from 'fastify'
import { getCredential } from '../lib/credentials'

const WIZARD_SYSTEM_PROMPT = `You are HyperProx's deployment wizard. 
The user will describe a service they want to deploy on their Proxmox cluster.
You must respond ONLY with a valid JSON object — no markdown, no explanation, no preamble.

IMPORTANT RULES:
- If no domain is provided, set domain to empty string "" and add a warning asking the user to specify a domain
- NEVER invent or hallucinate a domain name
- NEVER use example.com or placeholder domains
- If the request is missing critical information (domain, service name), set the relevant field to "" and explain in warnings

The JSON must follow this exact schema:
{
  "service": "string — the service name (e.g. Nextcloud, Jellyfin)",
  "domain": "string — the full domain (e.g. cloud.example.com)",
  "understood": "string — one sentence confirming what you understood",
  "steps": [
    {
      "id": "string",
      "type": "create_lxc | configure_proxy | create_dns | request_ssl | wait_propagation | install_service",
      "label": "string — human readable label",
      "description": "string — what this step does",
      "params": {}
    }
  ],
  "requirements": {
    "ram_mb": number,
    "disk_gb": number,
    "cpu_cores": number
  },
  "warnings": ["string"] 
}

Common service resource requirements:
- Nextcloud: 1024MB RAM, 20GB disk, 2 cores
- Jellyfin: 2048MB RAM, 20GB disk, 4 cores  
- Vaultwarden: 256MB RAM, 1GB disk, 1 core
- Gitea: 512MB RAM, 10GB disk, 2 cores
- Homepage: 256MB RAM, 1GB disk, 1 core
- Uptime Kuma: 256MB RAM, 2GB disk, 1 core
- Grafana: 512MB RAM, 5GB disk, 2 cores

Always include all steps in order: create_lxc → install_service → configure_proxy → create_dns → wait_propagation → request_ssl`

async function getOllamaUrl(): Promise<string | null> {
  const stored = await getCredential('ai', 'ollama', 'url')
  return stored || process.env.OLLAMA_URL || null
}

async function getActiveModel(): Promise<string> {
  const stored = await getCredential('ai', 'ollama', 'model')
  return stored || process.env.OLLAMA_MODEL || 'llama3.2:3b'
}

export const aiRoutes: FastifyPluginAsync = async (fastify) => {

  // POST /api/ai/wizard/plan — natural language → action plan
  fastify.post<{ Body: { prompt: string } }>('/wizard/plan', async (req, reply) => {
    const { prompt } = req.body
    if (!prompt) return reply.status(400).send({ error: 'prompt is required' })

    const ollamaUrl = await getOllamaUrl()
    if (!ollamaUrl) {
      return reply.status(400).send({
        ok: false,
        error: 'Ollama is not configured. Connect an Ollama instance in the AI settings first.'
      })
    }

    const model = await getActiveModel()

    try {
      const res = await fetch(`${ollamaUrl}/api/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream:   false,
          messages: [
            { role: 'system', content: WIZARD_SYSTEM_PROMPT },
            { role: 'user',   content: prompt },
          ],
          options: { temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(60000),
      })

      const data = await res.json() as { message?: { content: string }; error?: string }
      if (data.error) throw new Error(data.error)

      const raw = data.message?.content ?? ''

      // Parse JSON — strip any accidental markdown fences
      let clean = raw.replace(/```json|```/g, '').trim()

      // Fix truncated JSON — count braces and close if needed
      const opens  = (clean.match(/{/g) || []).length
      const closes = (clean.match(/}/g) || []).length
      if (opens > closes) clean += '}'.repeat(opens - closes)
      let plan: any
      try {
        plan = JSON.parse(clean)
      } catch {
        return reply.status(500).send({
          ok:    false,
          error: 'AI returned malformed JSON. Try a different model or rephrase your request.',
          raw,
        })
      }

      // Detect non-deployment intent — empty service or domain means conversational question
      if (!plan.service || !plan.domain) {
        return reply.send({
          ok:             true,
          conversational: true,
          message:        plan.understood || 'Please describe a service to deploy, e.g. "Deploy Nextcloud at cloud.mydomain.com"',
        })
      }

      // Strip markdown from string fields
      const stripMd = (s: any) => typeof s === 'string' ? s.replace(/\*\*/g, '') : s
      plan.service    = stripMd(plan.service)
      plan.domain     = stripMd(plan.domain)
      plan.understood = stripMd(plan.understood)

      return reply.send({ ok: true, plan, model })

    } catch (err: any) {
      return reply.status(500).send({ ok: false, error: err.message })
    }
  })

  // POST /api/ai/wizard/execute — execute a confirmed action plan
  fastify.post<{ Body: { plan: any } }>('/wizard/execute', async (req, reply) => {
    const { plan } = req.body
    if (!plan?.steps) return reply.status(400).send({ error: 'Invalid plan' })

    // For now return a job ID — full execution engine is the next build
    const jobId = `job_${Date.now()}`

    // TODO: Push to BullMQ queue for step-by-step execution
    // Each step type maps to a handler:
    // create_lxc      → ProxmoxClient.createLXC()
    // configure_proxy → NPMClient.createHost()
    // create_dns      → GoDaddyClient.createRecord()
    // wait_propagation → poll DNS until resolved
    // request_ssl     → NPMClient.requestCertificate()
    // install_service → run install script in LXC via Proxmox exec

    return reply.send({
      ok:    true,
      jobId,
      message: 'Execution queued. Track progress via WebSocket.',
      steps:   plan.steps.length,
    })
  })

  // GET /api/ai/wizard/jobs/:jobId — get execution status
  fastify.get<{ Params: { jobId: string } }>('/wizard/jobs/:jobId', async (req, reply) => {
    // TODO: Query BullMQ for job status
    return reply.send({
      ok:     true,
      jobId:  req.params.jobId,
      status: 'queued',
      steps:  [],
    })
  })

  // POST /api/ai/model/select — set the active model
  fastify.post<{ Body: { model: string } }>('/model/select', async (req, reply) => {
    const { model } = req.body
    if (!model) return reply.status(400).send({ error: 'model is required' })
    const { setCredential } = await import('../lib/credentials')
    await setCredential('ai', 'ollama', 'model', model, false)
    return reply.send({ ok: true, model })
  })
}
