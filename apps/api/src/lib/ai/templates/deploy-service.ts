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
import { isHostAddress, parseCidr, pickTemplate } from '../../wizard-placement'
import { zoneFor } from '../../dns-zones'
import type { NodeFact } from '../facts'
import type { FieldIssue, FieldSpec, Fields, FieldValue, StepSpec, TaskTemplate, TemplateFacts, TemplateSettings } from './types'

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
const VMID_MIN = 100
const VMID_MAX = 999_999_999
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const AGAIN = 'Try again in a moment.'
const LOCK_REFUSED = 'Keeping it LAN-only until setup needs proxy access lists, which HyperProx does not support yet. Choose now, or make it LAN-only.'

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

  /** The floor that applies to a recipe: Docker's when it runs under Docker, none otherwise. */
  const floorOf = (r: CatalogueRecipe | undefined) =>
    r && (r.needsDocker || r.install.kind === 'compose') ? CONSTANTS.floors.docker : { memory_mb: 1, disk_gb: 1 }

  function validate(f: Fields, facts: TemplateFacts): FieldIssue[] {
    const issues: FieldIssue[] = []
    const failed = (p: string) => facts.partial.includes(p)
    const failedPrefix = (p: string) => facts.partial.some(x => x.startsWith(p))
    const missing = (field: string, message: string, choices?: string[]) =>
      ({ field, kind: 'missing' as const, message, ...(choices ? { choices } : {}) })
    const invalid = (field: string, message: string, choices?: string[]) =>
      ({ field, kind: 'invalid' as const, message, ...(choices ? { choices } : {}) })

    const recipes = deps.recipes()
    const recipe = recipeOf(f)
    const nodeName = str(f, 'node')
    const node = facts.nodes.find(n => n.node === nodeName)
    const bridge = node?.bridges.find(b => b.iface === str(f, 'bridge'))
    const pub = isPublic(f)
    const zones = facts.zones.join(', ')
    const domainQuestion = `Which hostname should it answer on? Zones I manage: ${zones}`
    const usedIds = new Set(facts.guests.map(g => g.vmid))
    const nextFree = (): number => {
      let n = Math.max(VMID_MIN, facts.nextVmid || VMID_MIN)
      while (usedIds.has(n)) n++
      return n
    }
    const mem = num(f, 'memory_mb')
    const fits = (n: NodeFact) => n.online && n.hasLogin && !!n.arch && n.freeMemMb >= (mem ?? 0)

    const check: Record<string, () => FieldIssue | null> = {
      service: () => {
        if (recipe) return null
        const key = serviceKey(str(f, 'service'))
        const suggestions = key ? recipes.filter(r => r.id.includes(key) || serviceKey(r.name).includes(key)) : []
        const choices = [...new Set([...suggestions, ...recipes].map(r => r.id))]
        const message = `Which service? I can install: ${recipes.map(r => r.name).join(', ')}`
        return f.service ? invalid('service', message, choices) : missing('service', message, choices)
      },

      exposure: () => {
        const e = val(f, 'exposure')
        if (e !== 'public' && e !== 'lan') {
          return missing('exposure', 'Should this be reachable from the internet, or only on your network?', ['public', 'lan'])
        }
        if (e === 'lan') return null
        if (!facts.hasReverseProxy) {
          return invalid('exposure', 'Publishing it needs a reverse proxy, and HyperProx has none configured. Make it LAN-only?', ['lan'])
        }
        if (!failed('zones') && !facts.zones.length) {
          return invalid('exposure', 'Publishing it needs a DNS zone HyperProx manages, and none is configured. Make it LAN-only?', ['lan'])
        }
        return null
      },

      domain: () => {
        if (!pub) return null
        if (failed('zones')) return invalid('domain', `I could not read the DNS zones, so the hostname cannot be checked. ${AGAIN}`)
        const d = str(f, 'domain').toLowerCase()
        if (!d) return missing('domain', domainQuestion)
        if (!zoneFor(d, facts.zones)) return invalid('domain', domainQuestion)
        if (failed('proxy')) return invalid('domain', `I could not read the proxy hosts, so ${d} cannot be checked as free. ${AGAIN}`)
        if (facts.proxyHosts.some(h => h.toLowerCase() === d)) {
          return invalid('domain', `${d} is already a proxy host. ${domainQuestion}`)
        }
        return null
      },

      admin_setup: () => {
        if (!(pub && recipe?.firstRun.kind === 'setup-url')) return null
        const a = val(f, 'admin_setup')
        if (a === 'now') return null
        // Approved decision 7: lock needs proxy access lists; until then only 'now' is offered.
        if (a === 'lock') return invalid('admin_setup', LOCK_REFUSED, ['now'])
        const q = "This app's first visitor becomes its admin. Create the admin account now, or keep it LAN-only until you do?"
        return a === undefined ? missing('admin_setup', q, ['now']) : invalid('admin_setup', q, ['now'])
      },

      node: () => {
        const others = facts.nodes.filter(fits).map(n => n.node)
        if (failed('nodes')) return invalid('node', `I could not read the cluster's nodes. ${AGAIN}`)
        if (!nodeName) {
          return missing('node', `No online node with a stored login has ${mem ?? 0} MB free for this. Which node, or how much memory?`,
            others.length ? others : undefined)
        }
        const which = others.length ? others : undefined
        if (!node) return invalid('node', `${nodeName} is not a node in this cluster. Which node?`, which)
        if (!node.online) return invalid('node', `${nodeName} is not online. Which node?`, which)
        if (failed(`status:${nodeName}`)) return invalid('node', `I could not read the status of ${nodeName}, so its CPU type is unknown. ${AGAIN}`)
        if (failed(`login:${nodeName}`)) return invalid('node', `I could not check the stored login for ${nodeName}. ${AGAIN}`)
        if (!node.hasLogin) return invalid('node', `${nodeName} has no stored login, so HyperProx cannot install on it. Which node?`, which)
        if (!node.arch) return invalid('node', `HyperProx has no container templates for the CPU of ${nodeName}. Which node?`, which)
        if (mem !== undefined && node.freeMemMb < mem) {
          return invalid('node', `${nodeName} has ${node.freeMemMb} MB free, less than the ${mem} MB this needs. Which node?`, which)
        }
        return null
      },

      vmid: () => {
        if (failed('resources')) return invalid('vmid', `I could not read which IDs are in use, so the container ID cannot be checked. ${AGAIN}`)
        const id = num(f, 'vmid')
        if (id === undefined) return missing('vmid', 'Which container ID should it use?')
        if (!Number.isSafeInteger(id) || id < VMID_MIN || id > VMID_MAX) {
          const n = nextFree()
          return invalid('vmid', `Container ID ${id} is not valid (Proxmox allows ${VMID_MIN} to ${VMID_MAX}). Use ${n} instead?`, [String(n)])
        }
        if (usedIds.has(id)) {
          const n = nextFree()
          return invalid('vmid', `Container ID ${id} is taken by another guest. Use ${n} instead?`, [String(n)])
        }
        return null
      },

      ip: () => {
        const ip = str(f, 'ip')
        if (!ip) return missing('ip', 'Which address, or DHCP?', ['dhcp'])
        if (ip === 'dhcp' || !bridge) return null // no bridge is the bridge's issue
        if (!bridge.gateway) {
          return invalid('ip', `${bridge.iface} on ${nodeName} has no gateway, so a static address cannot be routed. Use DHCP?`, ['dhcp'])
        }
        const c = parseCidr(ip)
        if (!c || c.prefix !== bridge.prefix || !isHostAddress(c.ip, bridge.gateway, c.prefix)) {
          return invalid('ip', `${ip} is not a usable address on ${bridge.iface} (a /${bridge.prefix} network with gateway ${bridge.gateway}). Which address, or DHCP?`, ['dhcp'])
        }
        if (failed('resources') || failedPrefix('config:')) {
          return invalid('ip', `I could not read every guest's configuration, so ${c.ip} cannot be shown unused. ${AGAIN}`, ['dhcp'])
        }
        const user = facts.guests.find(g => g.addresses.includes(c.ip))
        if (user) return invalid('ip', `${c.ip} is already used by guest ${user.vmid}. Which address, or DHCP?`, ['dhcp'])
        return null
      },

      memory_mb: () => size('memory_mb', 'MB', 'How much memory should it have, in MB?'),
      disk_gb: () => size('disk_gb', 'GB', 'How large should its disk be, in GB?'),
      cores: () => {
        const c = num(f, 'cores')
        if (c === undefined) return recipe ? missing('cores', 'How many CPU cores should it have?') : null
        if (c < 1) return invalid('cores', 'A container needs at least 1 core. Use 1?', ['1'])
        if (node && node.cores > 0 && c > node.cores) {
          return invalid('cores', `${nodeName} has ${node.cores} cores. Use ${node.cores}?`, [String(node.cores)])
        }
        return null
      },

      gateway: () => null, // read from the bridge; its absence is the ip's issue

      bridge: () => {
        if (!node?.online) return null
        if (failed(`network:${nodeName}`)) return invalid('bridge', `I could not read the network of ${nodeName}. ${AGAIN}`)
        if (!bridge) return missing('bridge', `${nodeName} does not have the network bridge HyperProx is set to use. Which node?`,
          facts.nodes.filter(n => n.node !== nodeName && fits(n)).map(n => n.node))
        return null
      },

      storage: () => {
        if (!node?.online) return null
        if (failed(`storage:${nodeName}`)) return invalid('storage', `I could not read the storage of ${nodeName}. ${AGAIN}`)
        const disk = num(f, 'disk_gb') ?? 0
        const need = Math.ceil(disk * DISK_HEADROOM)
        const id = str(f, 'storage')
        if (!id) return missing('storage', `No storage on ${nodeName} can hold this container: it needs ${need} GB free on storage that holds containers.`)
        const s = facts.storages.find(x => x.node === nodeName && x.storage === id)
        if (!s || !s.active || !s.content.includes('rootdir')) {
          return invalid('storage', `${id} on ${nodeName} cannot hold containers. Which storage?`)
        }
        if (s.freeGb < disk * DISK_HEADROOM) return invalid('storage', `${id} has ${s.freeGb} GB free; this needs ${need} GB. Which storage?`)
        return null
      },

      template: () => {
        if (!node?.online || !node.arch) return null
        const t = f.template
        const fromDownload = !t?.value || t.note === 'download'
        if (failedPrefix(`templates:${nodeName}/`) || (fromDownload && failed(`aplinfo:${nodeName}`))) {
          return invalid('template', `I could not read the container templates on ${nodeName}. ${AGAIN}`)
        }
        // A missing template is a pre-flight failure, never a question. One for another CPU is refused here.
        const v = str(f, 'template')
        const arch = /_([a-z0-9]+)\.tar\./.exec(v)?.[1]
        if (v && arch && arch !== node.arch) {
          return invalid('template', `${v} is built for ${arch}, and ${nodeName} is ${node.arch}.`)
        }
        return null
      },

      hostname: () => {
        if (failed('resources')) return invalid('hostname', `I could not read the guests' names, so the hostname cannot be checked. ${AGAIN}`)
        const h = str(f, 'hostname')
        if (!h) return recipe ? missing('hostname', 'Which hostname should the container have?') : null
        const fallback = recipe ? hostLabel(recipe.id) : ''
        if (!LABEL.test(h)) {
          return invalid('hostname', `${h} is not a valid container hostname: one label of letters, digits and hyphens, at most 63.`
            + (fallback && fallback !== h ? ` Use ${fallback}?` : ''), fallback && fallback !== h ? [fallback] : undefined)
        }
        const other = facts.guests.find(g => g.name.toLowerCase() === h)
        if (other) return invalid('hostname', `${h} is already the name of guest ${other.vmid}. Which hostname should it have?`)
        return null
      },
    }

    function size(k: 'memory_mb' | 'disk_gb', unit: string, question: string): FieldIssue | null {
      const n = num(f, k)
      if (n === undefined) return recipe ? missing(k, question) : null
      const floor = floorOf(recipe)[k]
      if (n < floor) {
        const message = floor === CONSTANTS.floors.docker[k]
          ? `Docker needs at least ${floor} ${unit}. Use ${floor}?`
          : `It needs at least ${floor} ${unit}. Use ${floor}?`
        return invalid(k, message, [String(floor)])
      }
      return null
    }

    for (const spec of fields) {
      const i = check[spec.name]?.()
      if (i) issues.push(i)
    }
    return issues
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
    validate,
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
