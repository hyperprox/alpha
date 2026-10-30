// =============================================================================
//  HyperProx — the deployment plan contract
//
//  One schema, used three ways: to constrain the model's output natively where
//  the provider supports it, to validate whatever comes back, and to describe
//  the shape in the prompt. Keeping them in one place is what stops the three
//  drifting apart — which is how a wizard starts emitting plans the executor
//  cannot run.
// =============================================================================

// zod/v4, not 'zod'. The repo is on zod 3.25, which ships v4 under this
// subpath, and @anthropic-ai/sdk/helpers/zod is typed against v4 — importing
// the classic entry point compiles everywhere except zodOutputFormat().
import * as z from 'zod/v4'
import { findRecipe } from '../service-recipes'
import { parseCidr, sameSubnet } from '../wizard-placement'

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
    vmid:       z.number().int().describe('Container ID the user asked for, 0 if they did not give one'),
    ip:         z.string().describe('Fixed address in CIDR form, e.g. 10.0.0.5/24, only if the user gave one. Empty string if not given; never invent one.'),
    gateway:    z.string().describe('Only when a fixed ip is given: the gateway copied exactly from the cluster facts. Empty string otherwise; never choose one yourself.'),
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
        required: ['hostname', 'node', 'storage', 'cores', 'memory_mb', 'disk_gb', 'port', 'vmid', 'ip', 'gateway'],
        properties: {
          hostname: { type: 'string' }, node: { type: 'string' }, storage: { type: 'string' },
          cores: { type: 'integer' }, memory_mb: { type: 'integer' },
          disk_gb: { type: 'integer' }, port: { type: 'integer' },
          vmid: { type: 'integer' }, ip: { type: 'string' }, gateway: { type: 'string' },
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

  // A service with no install recipe cannot be deployed: the container would be created empty and then
  // given a proxy host, a DNS record and a certificate. Say so before anything is created.
  if (plan.service && !findRecipe(plan.service)) {
    problems.push(
      `HyperProx has no install recipe for "${plan.service}", so it cannot install it. ` +
      `The container would be created empty. Pick a service it supports, or install this one by hand.`)
  }

  // Container ID and address, when the user asked for them. The executor checks that they are free; this
  // catches the ones that could never be valid.
  for (const step of plan.steps.filter(s => s.type === 'create_lxc')) {
    const { vmid, ip, gateway } = step.params
    if (vmid && (vmid < 100 || vmid > 999_999_999)) {
      problems.push(`Container ID ${vmid} is not valid; Proxmox allows 100 to 999999999.`)
    }
    if (vmid && facts.usedVmids?.includes(vmid)) {
      problems.push(`Container ID ${vmid} is already used by another guest.`)
    }
    if (ip) {
      const cidr = parseCidr(ip)
      if (!cidr) {
        problems.push(`The address "${ip}" is not an IPv4 address in CIDR form (for example 10.0.0.5/24).`)
      } else if (!facts.gateway) {
        problems.push('A fixed address was asked for, but the cluster reports no gateway on vmbr0 to check it against.')
      } else if (!sameSubnet(cidr.ip, facts.gateway, cidr.prefix)) {
        problems.push(`The address ${ip} is not on the same network as the cluster gateway ${facts.gateway}.`)
      }
    }
    if (gateway && gateway !== facts.gateway) {
      problems.push(`The plan names gateway ${gateway}, which is not the cluster's (${facts.gateway || 'unknown'}). It will be ignored.`)
    }
  }

  const types = plan.steps.map(s => s.type)
  if (plan.domain && !types.includes('create_dns')) {
    problems.push('A domain was given but the plan has no DNS step.')
  }
  if (!types.includes('create_lxc')) {
    problems.push('The plan never creates a container.')
  }

  // Capability checks. These are the ones that used to surface as a working
  // certificate in front of an empty container — a failure the plan itself
  // looked perfectly correct about.
  const caps = facts.capabilities
  if (!caps?.hasReverseProxy && (types.includes('configure_proxy') || types.includes('request_ssl'))) {
    problems.push(
      'No reverse proxy is configured, so the proxy and certificate steps cannot run. ' +
      'Install one from the service catalogue first.')
  }
  if (types.includes('install_service') && !caps?.nodesWithLogin?.length) {
    problems.push(
      'No node has an SSH login stored, so the service cannot be installed automatically — ' +
      'the container will be created and the commands shown for you to run. ' +
      'Add a node login under Settings to have HyperProx do it.')
  }
  const placed = plan.steps.map(s => s.params.node).filter(Boolean)
  for (const n of new Set(placed)) {
    if (caps?.nodesWithLogin?.length && !caps.nodesWithLogin.includes(n) && types.includes('install_service')) {
      problems.push(`Node ${n} has no SSH login stored, so the install step cannot run there.`)
    }
  }

  return problems
}

export interface ClusterFacts {
  nodes:     Array<{ node: string; cores: number; freeMemMb: number; totalMemMb: number }>
  storages:  Array<{ storage: string; type: string; freeGb: number; shared: boolean }>
  domains:   string[]
  proxyHosts: string[]
  nextVmid:  number
  /** Container IDs already taken by a VM or container anywhere in the cluster. */
  usedVmids?: number[]
  /** The vmbr0 gateway, read from a node's network config. '' when none is set. */
  gateway:   string
  /**
   * What this install can actually carry out, as opposed to plan.
   *
   * The model was previously told a flat, permanent rule about what the
   * executor could not do. That rule is now conditional — installs run where a
   * node login is stored — and a prompt that states a stale limitation teaches
   * the model to write warnings that are simply untrue.
   */
  capabilities: {
    /** Nodes with an SSH login stored, so `pct exec` installs can run there. */
    nodesWithLogin:  string[]
    /** A reverse proxy is configured, so proxy, DNS and certificate steps can run. */
    hasReverseProxy: boolean
    /** Services HyperProx can install unattended if one is missing. */
    installable:     string[]
  }
}
