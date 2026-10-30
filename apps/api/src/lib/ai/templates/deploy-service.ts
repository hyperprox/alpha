// =============================================================================
//  HyperProx — the deploy-service template
//
//  Install one catalogue service in a new container. The model is asked only
//  for what a person says (which service, where, how big, which hostname);
//  everything the cluster knows — the gateway, the bridge, the template — comes
//  from facts, and everything that matters for safety — feature flags,
//  privilege, packages, the step list — is a constant here.
// =============================================================================

import { wizardRecipes, serviceKey, type CatalogueRecipe } from '../../catalogue'
import { DOCKER_PACKAGES, distroOf } from '../../install-script'
import { pickTemplate } from '../../wizard-placement'
import type { NodeFact } from '../facts'
import type { FieldSpec, Fields, FieldValue, StepSpec, TaskTemplate, TemplateFacts, TemplateSettings } from './types'

export interface DeployFields {
  service: string; exposure: 'public' | 'lan'; domain?: string; admin_setup?: 'now' | 'lock'
  node: string; vmid: number; ip: string /* 'dhcp' | a.b.c.d/nn */; gateway?: string; bridge: string; storage: string
  template: string; memory_mb: number; disk_gb: number; cores: number; hostname: string; features: 'nesting=1'; packages: string[]
}

const CONSTANTS = Object.freeze({
  // Proxmox lets only root@pam set any other feature flag, and HyperProx authenticates with an API token.
  // Docker runs in an unprivileged container with nesting only.
  features: 'nesting=1',
  unprivileged: 1,
  // Debian packages Compose v2 as docker-compose, Ubuntu as docker-compose-v2: chosen by the template's
  // distro, never by trying one and falling back to the other.
  packages: DOCKER_PACKAGES,
  // Sizes from the recipe or the model are requests; the floor is applied after them and shown in the
  // preview when it changes a value.
  floors: Object.freeze({ docker: Object.freeze({ memory_mb: 512, disk_gb: 8 }) }),
  // The service is meant to stay up: it comes back after a node reboot, starts once created, and its
  // interface is behind the Proxmox firewall.
  onboot: 1,
  start: 1,
  firewall: 1,
  // Short enough that a corrected record takes effect quickly; the wait is checked against public
  // resolvers, because the local one may answer from its own zone.
  ttl: 600,
  propagationWaitMs: 5 * 60_000,
})

// Higher is a better home for a container rootfs: shared block storage first (a guest on it can
// migrate), then node-local, then network file shares.
const STORAGE_RANK: Record<string, number> = {
  rbd: 5, zfspool: 4, lvmthin: 3, lvm: 3, btrfs: 3, dir: 2, nfs: 1, cifs: 1,
}
const DISK_HEADROOM = 1.2

const STEPS: Record<StepSpec['id'], string> = {
  create_lxc: 'Create the container',
  start_and_verify: 'Start it and check it stays running',
  install_service: 'Install the service',
  health_check: 'Check the service answers',
  complete_guest: 'Finish the guest',
  secure_first_run: 'Secure the first-run setup',
  configure_proxy: 'Add the reverse proxy host',
  create_dns: 'Create the DNS record',
  wait_propagation: 'Wait for DNS to propagate',
  request_ssl: 'Request the certificate',
  verify_url: 'Check the public address',
}

export interface DeployServiceDeps { recipes(): CatalogueRecipe[] }

const val = (f: Fields, k: string): unknown => f[k]?.value
const str = (f: Fields, k: string): string => (typeof f[k]?.value === 'string' ? (f[k].value as string) : '')
const num = (f: Fields, k: string): number | undefined => (typeof f[k]?.value === 'number' ? (f[k].value as number) : undefined)
const isStatic = (f: Fields): boolean => !!str(f, 'ip') && str(f, 'ip') !== 'dhcp'

/** A single RFC 1123 label from a recipe id: lowercase letters, digits and inner hyphens, at most 63. */
function hostLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 63).replace(/-+$/, '')
}

export function buildDeployService(deps: DeployServiceDeps = { recipes: wizardRecipes }): TaskTemplate {
  const recipeOf = (f: Fields): CatalogueRecipe | undefined => {
    const id = str(f, 'service')
    return id ? deps.recipes().find(r => r.id === id) : undefined
  }
  const isPublic = (f: Fields) => val(f, 'exposure') === 'public'

  const fields: FieldSpec[] = [
    { name: 'service', type: 'enum', source: 'user', extract: true, required: true,
      describe: 'The service to install, as one of the listed ids. null if the request names none.' },
    { name: 'exposure', type: 'enum', source: 'user', extract: true, required: true,
      describe: 'public if it should be reachable from the internet, lan if only on the local network. null if not said.' },
    { name: 'domain', type: 'hostname', source: 'user', extract: true, required: isPublic,
      describe: 'The full hostname it should answer on, exactly as written. null if none was given; never invent one.' },
    { name: 'admin_setup', type: 'enum', source: 'user', extract: true,
      required: f => isPublic(f) && recipeOf(f)?.firstRun.kind === 'setup-url',
      describe: 'now to create the admin account during setup, lock to keep it private until then. null if not said.' },
    { name: 'node', type: 'enum', source: 'user', extract: true, required: true,
      describe: 'The node to create it on, if the request names one. null otherwise.' },
    { name: 'vmid', type: 'int', source: 'user', extract: true, required: true,
      describe: 'The container ID, if the request gives one. null otherwise.' },
    { name: 'ip', type: 'ipv4cidr', source: 'user', extract: true, required: true,
      describe: 'The IPv4 address as written (with /prefix only if given), or dhcp. null if not said.' },
    { name: 'memory_mb', type: 'int', source: 'user', extract: true, required: true,
      describe: 'Memory in MB, if the request states it. null otherwise.' },
    { name: 'disk_gb', type: 'int', source: 'user', extract: true, required: true,
      describe: 'Disk size in GB, if the request states it. null otherwise.' },
    { name: 'cores', type: 'int', source: 'user', extract: true, required: true,
      describe: 'CPU cores, if the request states them. null otherwise.' },
    { name: 'gateway', type: 'string', source: 'fact', extract: false, required: isStatic,
      describe: 'The bridge gateway, read from the node.' },
    { name: 'bridge', type: 'string', source: 'fact', extract: false, required: true,
      describe: 'The network bridge on the node.' },
    { name: 'storage', type: 'enum', source: 'derived', extract: false, required: true,
      describe: 'Where the container root disk lives.' },
    { name: 'template', type: 'string', source: 'fact', extract: false, required: true,
      describe: 'The container template, for the node\'s CPU architecture.' },
    { name: 'hostname', type: 'hostname', source: 'derived', extract: false, required: true,
      describe: 'The container hostname.' },
    { name: 'features', type: 'string', source: 'fixed', extract: false, required: true,
      describe: 'Container feature flags.' },
    { name: 'packages', type: 'string', source: 'fixed', extract: false, required: true,
      describe: 'Packages installed before the service.' },
  ]
  const specOf = new Map(fields.map(s => [s.name, s]))

  function derive(input: Fields, facts: TemplateFacts, s: TemplateSettings): Fields {
    const out: Fields = {}
    // Only a value the person gave survives, and only for a field a person may set. A fact or a fixed
    // value arriving from anywhere else (the model, a stale pass) is dropped and recomputed.
    for (const [k, v] of Object.entries(input)) {
      const spec = specOf.get(k)
      if (spec && v?.source === 'user' && (spec.source === 'user' || spec.source === 'derived')) out[k] = { ...v }
    }
    const set = (k: string, v: FieldValue) => { if (!out[k]) out[k] = v }

    // Exact match on the normalised id or display name only; anything looser stays as written for
    // validate to offer as a suggestion. Array.find, so "toString" matches nothing.
    if (out.service && typeof out.service.value === 'string') {
      const key = serviceKey(out.service.value)
      const r = deps.recipes().find(x => x.id === key || serviceKey(x.name) === key)
      if (r) out.service = { ...out.service, value: r.id }
    }
    const recipe = recipeOf(out)

    // Approved decision 3: naming a domain is asking for it to be published.
    if (!out.exposure && str(out, 'domain')) out.exposure = { value: 'public', source: 'derived' }

    if (recipe) {
      const floor = recipe.needsDocker || recipe.install.kind === 'compose' ? CONSTANTS.floors.docker : { memory_mb: 0, disk_gb: 0 }
      const sized = (k: 'memory_mb' | 'disk_gb', dflt: number, unit: string) => {
        if (out[k]) return // a person's figure is left for validate to hold against the floor
        out[k] = dflt < floor[k]
          ? { value: floor[k], source: 'derived', note: `raised to the Docker minimum of ${floor[k]} ${unit}` }
          : { value: dflt, source: 'derived' }
      }
      sized('memory_mb', recipe.defaults.memoryMb, 'MB')
      sized('disk_gb', recipe.defaults.diskGb, 'GB')
      set('cores', { value: recipe.defaults.cores, source: 'derived' })
    }

    if (!out.node) {
      const need = num(out, 'memory_mb') ?? 0
      const best = facts.nodes.filter(n => n.online && n.hasLogin && n.freeMemMb >= need)
        .sort((a, b) => b.freeMemMb - a.freeMemMb)[0]
      if (best) out.node = { value: best.node, source: 'derived' }
    }
    const node: NodeFact | undefined = facts.nodes.find(n => n.node === str(out, 'node'))

    const bridge = node?.bridges.find(b => b.iface === s.bridge)
    if (bridge) out.bridge = { value: bridge.iface, source: 'fact' }

    if (!out.vmid && facts.nextVmid > 0) out.vmid = { value: facts.nextVmid, source: 'derived' }

    if (!out.ip) out.ip = { value: 'dhcp', source: 'derived' }
    else if (bridge && typeof out.ip.value === 'string' && out.ip.value !== 'dhcp' && !out.ip.value.includes('/')) {
      out.ip = { ...out.ip, value: `${out.ip.value}/${bridge.prefix}`, note: `prefix /${bridge.prefix} from ${bridge.iface}` }
    }

    // The gateway is the bridge's, as the node has it configured, and nothing else's.
    if (isStatic(out) && bridge?.gateway) out.gateway = { value: bridge.gateway, source: 'fact' }

    if (!out.storage && node) {
      const need = (num(out, 'disk_gb') ?? 0) * DISK_HEADROOM
      const best = facts.storages
        .filter(x => x.node === node.node && x.active && x.content.includes('rootdir') && x.freeGb >= need)
        .sort((a, b) => (STORAGE_RANK[b.type] ?? 0) - (STORAGE_RANK[a.type] ?? 0) || b.freeGb - a.freeGb)[0]
      if (best) out.storage = { value: best.storage, source: 'derived' }
    }

    if (node) {
      // A template built for another CPU extracts cleanly and then cannot start. A node whose
      // architecture is unknown gets none; validate says why.
      let template: FieldValue = { value: '', source: 'fact' }
      if (node.arch) {
        const local = pickTemplate(facts.templates.filter(t => t.node === node.node && t.arch === node.arch).map(t => t.volid), node.arch)
        const into = facts.storages.find(x => x.node === node.node && x.active && x.content.includes('vztmpl'))
        const dl = !local && into
          ? pickTemplate(facts.downloadable.filter(t => t.node === node.node && t.arch === node.arch).map(t => t.name), node.arch)
          : ''
        if (local) template = { value: local, source: 'fact' }
        else if (dl && into) template = { value: `${into.storage}:vztmpl/${dl}`, source: 'fact', note: 'download' }
      }
      out.template = template
    }

    if (!out.hostname && recipe) {
      const base = hostLabel(recipe.id)
      const taken = new Set(facts.guests.map(g => g.name.toLowerCase()))
      let name = base
      for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 63 - String(i).length - 1)}-${i}`
      out.hostname = { value: name, source: 'derived' }
    }

    out.features = { value: CONSTANTS.features, source: 'fixed' }
    const distro = distroOf(str(out, 'template'))
    if (distro) out.packages = { value: [...CONSTANTS.packages[distro]], source: 'fixed' }

    // Field order is question order; keep the object in it too.
    return Object.fromEntries(fields.filter(x => out[x.name]).map(x => [x.name, out[x.name]]))
  }

  function steps(f: Fields): StepSpec[] {
    const ids: StepSpec['id'][] = ['create_lxc', 'start_and_verify', 'install_service', 'health_check']
    if (isPublic(f)) ids.push('configure_proxy', 'create_dns', 'wait_propagation', 'request_ssl')
    return ids.map(id => ({ id, label: STEPS[id] }))
  }

  return {
    id: 'deploy-service',
    version: 1,
    summary: 'Install a catalogue service in a new container, optionally published on a domain.',
    intents: [
      'deploy Uptime Kuma at status.example.com',
      'set up Gitea on pve2',
      'I want a Grafana container, LAN only',
      'install vaultwarden as container 250 on 10.0.0.50',
    ],
    nearMisses: ['what is Uptime Kuma?', 'is Gitea running?', 'remove the Grafana container'],
    fields,
    constants: CONSTANTS,
    enums: facts => ({
      service: deps.recipes().map(r => r.id),
      node: facts.nodes.filter(n => n.online).map(n => n.node),
      exposure: ['public', 'lan'],
      admin_setup: ['now', 'lock'],
    }),
    derive,
    validate: () => [],
    preflight: async () => [],
    steps,
  }
}

export const deployService: TaskTemplate = buildDeployService()

/** The typed fields the executor reads. Throws naming the first required field that is absent. */
export function toDeployFields(f: Fields, t: TaskTemplate = deployService): DeployFields {
  const out: Record<string, unknown> = {}
  for (const spec of t.fields) {
    const v = f[spec.name]?.value
    const present = v !== undefined && v !== null && v !== ''
    const required = typeof spec.required === 'function' ? spec.required(f) : spec.required
    if (!present) {
      if (required) throw new Error(`deploy-service: ${spec.name} is missing`)
      continue
    }
    out[spec.name] = v
  }
  return out as unknown as DeployFields
}
