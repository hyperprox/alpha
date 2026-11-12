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
import {
  isHostAddress, parseCidr, pickTemplate, scoreNodes, nextFreeVmid, rootStorages as rankRootStorages, PLACEMENT, ROOTFS_EXCLUDED,
} from '../../wizard-placement'
import { zoneFor } from '../../dns-zones'
import { firstCandidate, namingPolicy, schemeLabel, takenAddresses, DHCP_CONFIRM } from '../../naming'
import { archOfTemplate, type NodeFact, type StorageFact } from '../facts'
import { isWildcard, publishableHostname } from './fields'
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

// Storage ranking, headroom and node scoring are the Catalogue wizard's (wizard-placement), so the two
// recommend the same node and storage for the same request.
const DISK_HEADROOM = PLACEMENT.diskHeadroom
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

/**
 * One rule for derive and validate: a node HyperProx can read, sign in to, connect to the bridge and
 * fit this container on. A node whose status, login or network could not be read is not a candidate,
 * however much room it seems to have.
 */
function nodeFits(n: NodeFact, facts: TemplateFacts, bridge: string, memMb: number): boolean {
  const unread = ['status', 'login', 'network'].some(k => facts.partial.includes(`${k}:${n.node}`))
  return n.online && !unread && n.hasLogin && !!n.arch && n.bridges.some(b => b.iface === bridge) && n.freeMemMb >= memMb
}

/** Storages on `node` that can hold a container root disk, best first: shared, then block, then room. */
function rootStorages(facts: TemplateFacts, node: string): StorageFact[] {
  return rankRootStorages(facts.storages, node) as StorageFact[]
}

/** The best node for this size among those that fit, by the Catalogue wizard's scoring. */
function bestNode(
  facts: TemplateFacts, candidates: NodeFact[], need: { memoryMb: number; diskGb: number; cores: number; wantsGpu?: boolean; needsGpu?: boolean },
): NodeFact | undefined {
  const verdicts = scoreNodes(candidates.map(n => ({
    node: n.node, online: n.online, cores: n.cores, cpuLoad: n.cpuLoad, memTotalMb: n.totalMemMb,
    memUsedMb: n.totalMemMb - n.freeMemMb, memCommittedMb: n.committedMemMb, runningGuests: n.runningGuests,
    hasGpu: n.hasGpu, hasIgpu: n.hasIgpu, hasLogin: n.hasLogin,
  })), facts.storages, need)
  const top = verdicts.find(v => v.eligible)
  return top ? candidates.find(n => n.node === top.node) : undefined
}
const storageFor = (facts: TemplateFacts, node: string, diskGb: number) =>
  rootStorages(facts, node).find(x => x.freeGb >= diskGb * DISK_HEADROOM)

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
      const best = bestNode(facts, facts.nodes.filter(n => nodeFits(n, facts, s.bridge, need)),
        { memoryMb: need, diskGb: num(out, 'disk_gb') ?? 0, cores: num(out, 'cores') ?? 1, wantsGpu: recipe?.wantsGpu, needsGpu: recipe?.needsGpu })
      if (best) out.node = { value: best.node, source: 'derived' }
    }
    const node: NodeFact | undefined = facts.nodes.find(n => n.node === str(out, 'node'))

    const bridge = node?.bridges.find(b => b.iface === s.bridge)
    // With no such bridge the value is empty (so the field counts as missing) and the note keeps the
    // bridge that was wanted, which validate has no settings to read from.
    out.bridge = bridge ? { value: bridge.iface, source: 'fact' } : { value: '', source: 'fact', note: s.bridge }

    // Settings → Naming & addresses: the next ID and address in the range that fit the scheme, as the wizard
    // offers them. Only when the person named neither; the address is pinged again before anything is created.
    const nm = facts.naming
    if (nm && node && !out.ip && !facts.partial.includes('resources') && !facts.partial.some(p => p.startsWith('config:'))) {
      const taken = takenAddresses({ configs: [], nodes: Object.values(facts.nodeAddresses ?? {}).map(address => ({ address })) })
      for (const g of facts.guests) for (const a of g.addresses) taken.add(a)
      const c = firstCandidate(nm, { node: node.node, usedIds: facts.guests.map(g => g.vmid), nextId: facts.nextVmid || VMID_MIN, taken })
      if (c) {
        out.ip = { value: c.ip, source: 'derived', note: `${schemeLabel(nm, node.node)} (your numbering)` }
        if (!out.vmid) out.vmid = { value: c.vmid, source: 'derived', note: 'your numbering' }
      }
    }

    // The next ID no CT or VM has, the same answer the Catalogue wizard gives.
    if (!out.vmid && !facts.partial.includes('resources')) {
      out.vmid = { value: nextFreeVmid(facts.guests.map(g => g.vmid), facts.nextVmid || VMID_MIN), source: 'derived' }
    }

    if (!out.ip) out.ip = { value: 'dhcp', source: 'derived' }
    else if (bridge && typeof out.ip.value === 'string' && out.ip.value !== 'dhcp' && !out.ip.value.includes('/')) {
      out.ip = { ...out.ip, value: `${out.ip.value}/${bridge.prefix}`, note: `prefix /${bridge.prefix} from ${bridge.iface}` }
    }

    // The gateway is the bridge's, as the node has it configured, and nothing else's.
    if (isStatic(out) && bridge?.gateway) out.gateway = { value: bridge.gateway, source: 'fact' }

    if (!out.storage && node) {
      const best = storageFor(facts, node.node, num(out, 'disk_gb') ?? 0)
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
    const nextFree = (): number => nextFreeVmid(usedIds, facts.nextVmid || VMID_MIN)
    const mem = num(f, 'memory_mb')
    const wantedBridge = str(f, 'bridge') || f.bridge?.note || ''
    const fits = (n: NodeFact) => nodeFits(n, facts, wantedBridge, mem ?? 0)
    const unreachable = (n: string) => `HyperProx couldn't reach node ${n} to check it. ${AGAIN}`
    const label = str(f, 'hostname') || (recipe ? hostLabel(recipe.id) : '')

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
        const named = str(f, 'domain').trim()
        if (e === 'lan' && named) {
          return invalid('exposure', `You gave ${named} but asked for LAN only. Should it be reachable from the internet at that name, or LAN only without a name?`, ['public', 'lan'])
        }
        if (e === 'lan') return null
        if (failed('proxy')) return invalid('exposure', `HyperProx couldn't reach the reverse proxy to check it. ${AGAIN}`)
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
        if (failed('zones')) return invalid('domain', `HyperProx couldn't read the DNS zones to check the name. ${AGAIN}`)
        const raw = val(f, 'domain')
        if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return missing('domain', domainQuestion)
        // A value that did not coerce is kept by the loop so it can be asked about here; it is never
        // carried on into a plan.
        const ok = publishableHostname(raw)
        if (!ok.ok) {
          const shown = String(raw).trim()
          return invalid('domain', isWildcard(raw)
            ? `${shown} is a wildcard name, and HyperProx publishes one hostname at a time. ${domainQuestion}`
            : `${shown} is not a valid hostname. ${domainQuestion}`)
        }
        const d = ok.value as string
        const z = zoneFor(d, facts.zones)
        if (!z) return invalid('domain', domainQuestion)
        // Never overwrite a record that is already there: not the zone's own address, not any name
        // that already resolves, and not a name whose records could not be read.
        const records = Object.prototype.hasOwnProperty.call(facts.records ?? {}, z.zone) ? facts.records[z.zone] : null
        const proxied = (h: string) => facts.proxyHosts.some(x => x.toLowerCase() === h)
        const suggest = label ? `${label}.${z.zone}` : ''
        const offer = suggest && suggest !== d && !proxied(suggest) && records && !records.includes(label) ? [suggest] : undefined
        const like = offer ? `, like ${suggest}` : ''
        if (z.name === '@') return invalid('domain', `That would replace the main address of ${z.zone}. Pick a name under it${like}?`, offer)
        if (failed('proxy')) return invalid('domain', `HyperProx couldn't reach the reverse proxy to check ${d}. ${AGAIN}`)
        if (proxied(d)) return invalid('domain', `${d} is already a proxy host. ${domainQuestion}`)
        if (!records) return invalid('domain', `HyperProx couldn't read the DNS records of ${z.zone} to check ${d}. ${AGAIN}`)
        if (records.includes(z.name)) {
          return invalid('domain', `${d} already has a DNS record. Pick another name under ${z.zone}${like}?`, offer)
        }
        return null
      },

      admin_setup: () => {
        if (!(pub && recipe?.firstRun.kind === 'setup-url')) return null
        const a = val(f, 'admin_setup')
        if (a === 'now') return null
        // Approved decision 7: lock needs proxy access lists, so answering it explains why and offers now.
        if (a === 'lock') return invalid('admin_setup', LOCK_REFUSED, ['now'])
        const q = "This app's first visitor becomes its admin. Create the admin account now, or keep it LAN-only until you do?"
        return a === undefined ? missing('admin_setup', q, ['now', 'lock']) : invalid('admin_setup', q, ['now', 'lock'])
      },

      node: () => {
        const others = facts.nodes.filter(fits).map(n => n.node)
        if (failed('nodes')) return invalid('node', `HyperProx couldn't read the cluster's nodes. ${AGAIN}`)
        if (!nodeName) {
          return missing('node', mem !== undefined
            ? `No node HyperProx can use has ${mem} MB free right now. Which node, or how much memory?`
            : 'No node HyperProx can use is ready for this right now. Which node?',
          others.length ? others : undefined)
        }
        const which = others.length ? others : undefined
        if (!node) return invalid('node', `${nodeName} is not a node in this cluster. Which node?`, which)
        if (!node.online) return invalid('node', `${nodeName} is not online. Which node?`, which)
        if (failed(`status:${nodeName}`) || failed(`login:${nodeName}`)) return invalid('node', unreachable(nodeName))
        if (!node.hasLogin) return invalid('node', `HyperProx can't sign in to ${nodeName} to install on it. Which node?`, which)
        if (!node.arch) return invalid('node', `HyperProx has no container templates for the CPU of ${nodeName}. Which node?`, which)
        if (mem !== undefined && node.freeMemMb < mem) {
          return invalid('node', `${nodeName} has ${node.freeMemMb} MB free, less than the ${mem} MB this needs. Which node?`, which)
        }
        return null
      },

      vmid: () => {
        if (failed('resources')) return invalid('vmid', `HyperProx couldn't read which container IDs are in use. ${AGAIN}`)
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
        if (failed('naming')) return invalid('ip', `HyperProx couldn't read your naming settings, so it can't tell which addresses are allowed. ${AGAIN}`)
        // Going against the naming settings (DHCP when they say never, an address outside the range) needs a typed
        // confirmation, which only the wizards ask for; here it is refused with the address that fits.
        const pol = namingPolicy(facts.naming ?? null, { node: nodeName, vmid: num(f, 'vmid') ?? 0, ip }, undefined)
        if (pol.errors.length) {
          const nm = facts.naming!
          const taken = takenAddresses({ configs: [], nodes: Object.values(facts.nodeAddresses ?? {}).map(address => ({ address })) })
          for (const g of facts.guests) for (const a of g.addresses) taken.add(a)
          const c = node ? firstCandidate(nm, { node: node.node, usedIds: facts.guests.map(g => g.vmid), nextId: facts.nextVmid || VMID_MIN, taken }) : null
          const msg = ip === 'dhcp'
            ? `Your naming settings never allow DHCP${c ? `. Use ${c.ip}?` : ', and no free address is left in the range.'} (To use DHCP anyway, use the wizard and type ${DHCP_CONFIRM}.)`
            : `${ip.split('/')[0]} is outside your range ${nm.rangeStart}–${nm.rangeEnd}${c ? `. Use ${c.ip}?` : '.'} (To use it anyway, use the wizard, which asks you to confirm it.)`
          return invalid('ip', msg, c ? [c.ip] : [])
        }
        const nodeIp = Object.entries(facts.nodeAddresses ?? {}).find(([, a]) => a === ip.split('/')[0])
        if (nodeIp) return invalid('ip', `${ip.split('/')[0]} is the address of node ${nodeIp[0]}. Which address, or DHCP?`, ['dhcp'])
        if (ip === 'dhcp' || !bridge) return null // no bridge is the bridge's issue
        if (!bridge.gateway) {
          return invalid('ip', `${bridge.iface} on ${nodeName} has no gateway, so a static address cannot be routed. Use DHCP?`, ['dhcp'])
        }
        const c = parseCidr(ip)
        if (!c || c.prefix !== bridge.prefix || !isHostAddress(c.ip, bridge.gateway, c.prefix)) {
          return invalid('ip', `${ip} is not a usable address on ${bridge.iface} (a /${bridge.prefix} network with gateway ${bridge.gateway}). Which address, or DHCP?`, ['dhcp'])
        }
        if (failed('resources') || failedPrefix('config:')) {
          return invalid('ip', `HyperProx couldn't read every guest's settings to check that ${c.ip} is free. ${AGAIN}`, ['dhcp'])
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
        if (failed(`network:${nodeName}`)) return invalid('bridge', unreachable(nodeName))
        if (!bridge) return missing('bridge', `${nodeName} does not have the network bridge HyperProx is set to use. Which node?`,
          facts.nodes.filter(n => n.node !== nodeName && fits(n)).map(n => n.node))
        return null
      },

      storage: () => {
        if (!node?.online) return null
        if (failed(`storage:${nodeName}`)) return invalid('storage', unreachable(nodeName))
        const disk = num(f, 'disk_gb') ?? 0
        const need = Math.ceil(disk * DISK_HEADROOM)
        const id = str(f, 'storage')
        if (!id) {
          // Asked as the answer that would fix it: another node with room, else the largest disk that fits here.
          const short = `No storage on ${nodeName} has the ${need} GB free this container needs.`
          const elsewhere = facts.nodes.filter(n => n.node !== nodeName && fits(n) && storageFor(facts, n.node, disk)).map(n => n.node)
          if (elsewhere.length) return invalid('node', `${short} Put it on another node?`, elsewhere)
          const most = Math.floor(Math.max(0, ...rootStorages(facts, nodeName).map(x => x.freeGb)) / DISK_HEADROOM)
          if (most >= floorOf(recipe).disk_gb) return invalid('disk_gb', `${short} Use a ${most} GB disk instead?`, [String(most)])
          return missing('storage', `${short} Free up some space on it, or choose another node?`,
            facts.nodes.filter(n => n.node !== nodeName && fits(n)).map(n => n.node))
        }
        const s = facts.storages.find(x => x.node === nodeName && x.storage === id)
        if (!s || !s.active || !s.content.includes('rootdir')) {
          return invalid('storage', `${id} on ${nodeName} cannot hold containers. Which storage?`)
        }
        if (ROOTFS_EXCLUDED[s.type]) return invalid('storage', `${id}: ${ROOTFS_EXCLUDED[s.type]} Which storage?`)
        if (s.freeGb < disk * DISK_HEADROOM) return invalid('storage', `${id} has ${s.freeGb} GB free; this needs ${need} GB. Which storage?`)
        return null
      },

      template: () => {
        if (!node?.online || !node.arch) return null
        const t = f.template
        const fromDownload = !t?.value || t.note === 'download'
        if (failedPrefix(`templates:${nodeName}/`) || (fromDownload && failed(`aplinfo:${nodeName}`))) {
          return invalid('template', `HyperProx couldn't read the container templates on ${nodeName}. ${AGAIN}`)
        }
        // A missing template is a pre-flight failure, never a question. One for another CPU is refused here.
        const v = str(f, 'template')
        const arch = v ? archOfTemplate(v) : ''
        if (v && arch !== node.arch) {
          return invalid('template', `${v} is built for ${arch}, and ${nodeName} is ${node.arch}.`)
        }
        return null
      },

      hostname: () => {
        if (failed('resources')) return invalid('hostname', `HyperProx couldn't read the guests' names to check the hostname. ${AGAIN}`)
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
