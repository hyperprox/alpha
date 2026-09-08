// =============================================================================
//  HyperProx — the deployment plan contract
//
//  One schema, used three ways: to constrain the model's output natively where
//  the provider supports it, to validate whatever comes back, and to describe
//  the shape in the prompt. Keeping them in one place is what stops the three
//  drifting apart — which is how a wizard starts emitting plans the executor
//  cannot run.
// =============================================================================

import * as z from 'zod/v4'

export const STEP_TYPES = [
  'create_lxc',
  'install_service',
  'configure_proxy',
  'create_dns',
  'wait_propagation',
  'request_ssl',
] as const

export const PlanStepSchema = z.object({
  id:          z.string().describe('Short stable id, e.g. "create_lxc"'),
  type:        z.enum(STEP_TYPES),
  label:       z.string().describe('Short human label, e.g. "Create the container"'),
  description: z.string().describe('One sentence saying what this step does, in plain language'),
  params:      z.object({
    hostname:   z.string().describe('Container hostname, lowercase, no spaces. Empty string if not applicable.'),
    node:       z.string().describe('Proxmox node to place it on, chosen from the cluster facts. Empty string if not applicable.'),
    storage:    z.string().describe('Storage id from the cluster facts. Empty string if not applicable.'),
    cores:      z.number().int().describe('CPU cores for this step, 0 if not applicable'),
    memory_mb:  z.number().int().describe('Memory in MB, 0 if not applicable'),
    disk_gb:    z.number().int().describe('Disk in GB, 0 if not applicable'),
    port:       z.number().int().describe('Service port, 0 if not applicable'),
  }),
})

export const PlanSchema = z.object({
  service:    z.string().describe('The service being deployed, e.g. "Nextcloud". Empty string if the request did not name one.'),
  domain:     z.string().describe('Full domain, e.g. cloud.example.com. EMPTY STRING if the user did not give one — never invent one.'),
  understood: z.string().describe('One sentence restating what you understood the user to want'),
  steps:      z.array(PlanStepSchema),
  requirements: z.object({
    ram_mb:    z.number().int(),
    disk_gb:   z.number().int(),
    cpu_cores: z.number().int(),
  }),
  warnings: z.array(z.string()).describe(
    'Anything the user must resolve before this can run: a missing domain, a service you do not recognise, ' +
    'a node with not enough memory. Empty array if there is nothing to flag.'),
})

export type Plan = z.infer<typeof PlanSchema>

/** The JSON Schema form, for providers that take one directly. */
export function planJsonSchema(): Record<string, unknown> {
  const step = {
    type: 'object', additionalProperties: false,
    required: ['id', 'type', 'label', 'description', 'params'],
    properties: {
      id: { type: 'string' }, type: { type: 'string', enum: [...STEP_TYPES] },
      label: { type: 'string' }, description: { type: 'string' },
      params: {
        type: 'object', additionalProperties: false,
        required: ['hostname', 'node', 'storage', 'cores', 'memory_mb', 'disk_gb', 'port'],
        properties: {
          hostname: { type: 'string' }, node: { type: 'string' }, storage: { type: 'string' },
          cores: { type: 'integer' }, memory_mb: { type: 'integer' },
          disk_gb: { type: 'integer' }, port: { type: 'integer' },
        },
      },
    },
  }
  return {
    type: 'object', additionalProperties: false,
    required: ['service', 'domain', 'understood', 'steps', 'requirements', 'warnings'],
    properties: {
      service: { type: 'string' }, domain: { type: 'string' }, understood: { type: 'string' },
      steps: { type: 'array', items: step },
      requirements: {
        type: 'object', additionalProperties: false,
        required: ['ram_mb', 'disk_gb', 'cpu_cores'],
        properties: {
          ram_mb: { type: 'integer' }, disk_gb: { type: 'integer' }, cpu_cores: { type: 'integer' },
        },
      },
      warnings: { type: 'array', items: { type: 'string' } },
    },
  }
}

/**
 * Checks a plan against what the cluster can actually do.
 *
 * A schema-valid plan can still be undeployable — a node that cannot fit it, a
 * storage that does not exist, a domain that was invented. Catching that here
 * turns a failure three steps into execution into a warning before anything is
 * created.
 */
export function auditPlan(plan: Plan, facts: ClusterFacts): string[] {
  const problems: string[] = []

  if (!plan.domain) {
    problems.push('No domain was given, so the proxy, DNS and certificate steps cannot run.')
  } else if (facts.domains.length && !facts.domains.some(d => plan.domain.endsWith(d))) {
    problems.push(
      `The domain ${plan.domain} is not under a zone this cluster manages (${facts.domains.join(', ')}).`)
  }

  const nodes = new Set(facts.nodes.map(n => n.node))
  const stores = new Set(facts.storages.map(s => s.storage))
  for (const step of plan.steps) {
    if (step.params.node && !nodes.has(step.params.node)) {
      problems.push(`Step "${step.label}" names node "${step.params.node}", which is not in this cluster.`)
    }
    if (step.params.storage && !stores.has(step.params.storage)) {
      problems.push(`Step "${step.label}" names storage "${step.params.storage}", which does not exist here.`)
    }
  }

  const need = plan.requirements
  const fits = facts.nodes.some(n => n.freeMemMb >= need.ram_mb && n.cores >= need.cpu_cores)
  if (need.ram_mb && !fits) {
    problems.push(
      `No node has ${need.ram_mb} MB free and ${need.cpu_cores} cores available right now.`)
  }

  const types = plan.steps.map(s => s.type)
  if (plan.domain && !types.includes('create_dns')) {
    problems.push('A domain was given but the plan has no DNS step.')
  }
  if (!types.includes('create_lxc')) {
    problems.push('The plan never creates a container.')
  }

  return problems
}

export interface ClusterFacts {
  nodes:     Array<{ node: string; cores: number; freeMemMb: number; totalMemMb: number }>
  storages:  Array<{ storage: string; type: string; freeGb: number; shared: boolean }>
  domains:   string[]
  proxyHosts: string[]
  nextVmid:  number
  gateway:   string
}
