// =============================================================================
//  HyperProx — the Arr Stack as a catalogue recipe
//
//  The recipe, its options, and the four places the install wizard hands over
//  to it:
//    preview  the picked apps and the library location are checked (the NAS or
//             folder is looked at from the node), the VPN's login goes into the
//             vault, and any public names are planned;
//    create   after Proxmox makes the container: keyctl, the VPN's tun device
//             and the library mountpoint, set over the node's login (an API
//             token cannot set them), then read back;
//    install  the compose file and folders, through the generic script runner;
//    setup    the chores in setup.ts, then any public names.
//  Clean-up undoes the NAS mount and the public names this install made.
// =============================================================================

import { createHash } from 'node:crypto'
import type { CatalogueRecipe } from '../catalogue'
import type { PublishDeps, PublishLedger, PublishPlan } from '../sites'
import { planPublish, runPublish, cleanupPublish } from '../sites'
import {
  APPS, BASE_COST, VPN_COST, VPN_PROVIDERS, appById, has, selectionOf, selectionProblems, totals, type ArrAppId, type Selection,
} from './components'
import { scriptEnv, vpnEnv, type VpnSettings } from './compose'
import { configProblems, judgeProbe, layoutOf, parseProbe, prepareScript, probeScript, sameFilesystem, unmountScript, type Layout, LAYOUT_LINE } from './storage'
import { runArrSetup, setupSteps, type ArrSetupDeps, type Http, type StepRef } from './setup'

export { ARR_RECIPE_ID, ARR_OPTIONS, ARR_RECIPE } from './recipe'
export { realHttp, localAddressTo } from './net'

// ── What the wizard sends beyond the options ────────────────────────────────

/** The VPN's login: never an option (options are kept in the plan); it goes straight to the vault. */
export interface ArrVpnSecrets { wireguard_private_key?: string; wireguard_addresses?: string; openvpn_user?: string; openvpn_password?: string }
/** Public names, one per app, under one zone and one proxy. Off unless names are given. */
export interface ArrPublishInput { zone: string; instanceId: string; names: Partial<Record<ArrAppId, string>> }
export interface ArrPublishPlan { app: ArrAppId; plan: PublishPlan }

/** The deps the Arr Stack reaches for beyond the generic installer's. */
export interface ArrDeps {
  http: Http
  /** A script on a node, as root, over its saved login. */
  nodeRun(node: string, script: string, timeoutMs: number): Promise<{ code: number; output: string }>
  pluginSettings: ArrSetupDeps['pluginSettings']
  savePluginSettings: ArrSetupDeps['savePluginSettings']
  localAddressTo: ArrSetupDeps['localAddressTo']
  mediaServer: ArrSetupDeps['mediaServer']
}

const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/
const CIDR_LIST = /^\s*[0-9a-fA-F:.]+\/\d{1,3}(\s*,\s*[0-9a-fA-F:.]+\/\d{1,3})*\s*$/
const ONE_LINE = /^[^\u0000-\u001f\u007f]+$/

/** Every rule across the options, after each passed its own kind. */
export function checkArrOptions(v: Record<string, string>): { errors: string[]; warnings: string[]; selection: Selection; layout?: Layout; vpn?: VpnSettings } {
  const selection = selectionOf(v)
  const sp = selectionProblems(selection)
  const errors = [...sp.errors], warnings = [...sp.warnings]
  const lo = layoutOf(v)
  errors.push(...lo.errors)
  let vpn: VpnSettings | undefined
  if (selection.vpn) {
    const p = VPN_PROVIDERS.find(x => x.id === (v.ARR_VPN_PROVIDER ?? '').toLowerCase())
    if (!p) errors.push('Pick your VPN provider from the list.')
    const type = v.ARR_VPN_TYPE === 'openvpn' ? 'openvpn' : v.ARR_VPN_TYPE === 'wireguard' || !v.ARR_VPN_TYPE ? 'wireguard' : null
    if (!type) errors.push('The VPN type is WireGuard or OpenVPN.')
    if (v.ARR_VPN_COUNTRIES && !/^[A-Za-z][A-Za-z .'-]*(,\s*[A-Za-z][A-Za-z .'-]*)*$/.test(v.ARR_VPN_COUNTRIES)) errors.push('Countries are names separated by commas, like Netherlands, Switzerland.')
    if (p && type) {
      vpn = { provider: p.id, type, countries: v.ARR_VPN_COUNTRIES || undefined, portForwarding: p.portForwarding }
      if (!p.portForwarding) warnings.push(`${p.name} does not offer port forwarding through Gluetun, so other people cannot connect to you: downloads still work, but many torrents will be slow. Providers with port forwarding include Proton VPN and Private Internet Access.`)
    }
  }
  if (lo.layout) { const fs = sameFilesystem(lo.layout); if (fs.warning) warnings.push(fs.warning) }
  return { errors, warnings, selection, layout: lo.layout, vpn }
}

export function checkVpnSecrets(type: 'wireguard' | 'openvpn', raw: unknown): { secrets?: ArrVpnSecrets; errors: string[] } {
  const g = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (k: string) => (typeof g[k] === 'string' ? (g[k] as string).trim() : '')
  if (type === 'wireguard') {
    const key = str('wireguard_private_key'), addr = str('wireguard_addresses')
    const errors: string[] = []
    if (!WG_KEY.test(key)) errors.push('The WireGuard private key is the 44-character key from your provider\'s WireGuard file (PrivateKey = ...).')
    if (addr && !CIDR_LIST.test(addr)) errors.push('The WireGuard address is the Address line from that file, like 10.2.0.2/32.')
    return errors.length ? { errors } : { secrets: { wireguard_private_key: key, ...(addr ? { wireguard_addresses: addr } : {}) }, errors }
  }
  const user = str('openvpn_user'), pw = str('openvpn_password')
  const errors: string[] = []
  if (!user || !ONE_LINE.test(user) || user.length > 200) errors.push('Enter your VPN provider\'s OpenVPN user name (often not your account email: look for "OpenVPN / IKEv2 credentials").')
  if (!pw || !ONE_LINE.test(pw) || pw.length > 200) errors.push('Enter your VPN provider\'s OpenVPN password.')
  return errors.length ? { errors } : { secrets: { openvpn_user: user, openvpn_password: pw }, errors }
}

/** Where a preview keeps the VPN's login until the install reads it: one vault item per person, replaced each time. */
export const pendingVpnItem = (owner: string) => ({ category: 'apps', provider: `arr-vpn-pending-${createHash('sha256').update(owner).digest('hex').slice(0, 16)}` })

/** A sign-in name when the person leaves it blank: not "admin", which is the first name anyone tries. */
export const makeUserName = (rand: () => string) => `media-${rand().replace(/[^a-z0-9]/g, '').slice(0, 6) || 'admin'}`

// ── Preview ─────────────────────────────────────────────────────────────────

export interface ArrPreviewDeps {
  arr?: () => ArrDeps
  publish: PublishDeps
  saveSecrets(category: string, provider: string, values: Record<string, string>): Promise<void>
}

/**
 * The Arr Stack's part of the preview. `values` are the options after checkOptions. Fills in a sign-in name
 * when none was given (returned in `options`, which the preview keeps), looks at the library from the node,
 * keeps the VPN login in the vault, and plans public names. Writes nothing else.
 */
export async function arrPreview(input: {
  node: string; owner: string; storage: string; values: Record<string, string>; diskGb: number
  vpnSecrets?: unknown; publish?: unknown; storageFreeGb?: number
}, d: ArrPreviewDeps, rand: () => string): Promise<{ errors: string[]; warnings: string[]; checks: string[]; options: Record<string, string>; publish?: ArrPublishPlan[] }> {
  const c = checkArrOptions(input.values)
  const errors = [...c.errors], warnings = [...c.warnings], checks: string[] = []
  const options = { ...input.values }
  if (!options.ARR_ADMIN_USER) options.ARR_ADMIN_USER = makeUserName(rand)
  if (errors.length || !c.layout) return { errors, warnings, checks, options }
  const s = c.selection, l = c.layout
  checks.push(`Apps: ${s.apps.map(id => appById(id)!.name).join(', ')}${s.vpn ? ', with qBittorrent behind the VPN' : ''}.`)
  checks.push(`One sign-in for every app: ${options.ARR_ADMIN_USER}, with a generated password.`)

  const need = totals(s, l.downloads === 'local' ? l.downloadGb : 0)
  if (input.diskGb < need.diskGb) warnings.push(`${input.diskGb} GB is less than the ${need.diskGb} GB these apps${l.downloads === 'local' ? ' and their downloads' : ''} need on the container's own disk.`)

  // The library.
  if (l.media === 'disk') {
    if (input.storageFreeGb !== undefined && input.storageFreeGb < Math.ceil((l.mediaGb! + input.diskGb) * 1.1)) {
      errors.push(`${input.storage} has ${input.storageFreeGb} GB free: not enough for the ${input.diskGb} GB container and a ${l.mediaGb} GB library disk.`)
    } else checks.push(`The library gets a new ${l.mediaGb} GB disk on ${input.storage}, mounted at ${l.downloads === 'local' ? '/data/media' : '/data'}. It is left out of Proxmox backups (media is too big to back up nightly).`)
  } else {
    const arr = d.arr?.()
    if (!arr) errors.push('HyperProx cannot reach the node to look at the library.')
    else {
      const r = await arr.nodeRun(input.node, probeScript(l), 45_000).catch((e: any) => ({ code: -1, output: '', error: e?.message }))
      if (r.code === -1) errors.push(`HyperProx could not run a check on ${input.node}.`)
      else { const j = judgeProbe(parseProbe(r.output), l); errors.push(...j.errors); warnings.push(...j.warnings); checks.push(...j.checks) }
    }
  }
  if (sameFilesystem(l).same) checks.push(LAYOUT_LINE)
  checks.push('The container gets keyctl as well as nesting (Docker needs it), set on the node through its login.')

  // The VPN's login, straight into the vault.
  if (s.vpn && c.vpn) {
    const v = checkVpnSecrets(c.vpn.type, input.vpnSecrets)
    errors.push(...v.errors)
    if (!v.errors.length && !errors.length) {
      const item = pendingVpnItem(input.owner)
      await d.saveSecrets(item.category, item.provider, { ...v.secrets, type: c.vpn.type } as Record<string, string>)
      checks.push(`The ${VPN_PROVIDERS.find(p => p.id === c.vpn!.provider)!.name} login is in the vault; the install reads it from there.`)
      if (c.vpn.portForwarding) checks.push('Port forwarding is on: each port the VPN hands out is given to qBittorrent.')
    }
  }

  // Public names.
  let publish: ArrPublishPlan[] | undefined
  const p = input.publish as ArrPublishInput | undefined
  const names = p && typeof p === 'object' && p.names && typeof p.names === 'object' ? Object.entries(p.names).filter(([, n]) => typeof n === 'string' && n.trim()) : []
  if (names.length) {
    publish = []
    const seen = new Set<string>()
    for (const [id, name] of names) {
      const app = appById(id)
      if (!app || !has(s, app.id)) { errors.push(`${id} is not one of the picked apps.`); continue }
      if (app.private) { errors.push(`${app.name} is never given a public name: a download client stays on your own network.`); continue }
      const n = String(name).trim().toLowerCase()
      if (seen.has(n)) { errors.push(`${n} is given to two apps.`); continue }
      seen.add(n)
      const pp = await planPublish({ zone: p!.zone, name: n, instanceId: p!.instanceId }, d.publish)
      errors.push(...pp.errors.map(e => `${app.name}: ${e}`)); warnings.push(...pp.warnings); checks.push(...pp.checks)
      if (pp.plan) publish.push({ app: app.id, plan: pp.plan })
    }
    if (publish.length) warnings.push('Published apps can be reached from the internet. Each keeps its own sign-in; publish only what you need away from home.')
  }
  return { errors, warnings, checks, options, publish }
}

// ── After the create ────────────────────────────────────────────────────────

/** Steps for the job: the generic check and wiring give way to the setup chores, then any public names. */
export function arrJobSteps<T extends { id: string; label: string; status: string }>(steps: T[], options: Record<string, string>, publish: ArrPublishPlan[] = []): T[] {
  const s = selectionOf(options)
  const at = steps.findIndex(x => x.id === 'install')
  const mine = [
    ...setupSteps(s),
    ...publish.map(p => ({ id: `arr-publish-${p.app}`, label: `Publish ${appById(p.app)!.name} at ${p.plan.domain}` })),
  ].map(x => ({ ...x, status: 'pending' }) as T)
  const rest = steps.slice(at + 1).filter(x => x.id !== 'verify' && x.id !== 'wire')
  return [...steps.slice(0, at + 1), ...mine, ...rest]
}

export interface ArrPrepareDeps {
  arr?: () => ArrDeps
  client: { fetchStrict<T>(path: string, method?: string, body?: string): Promise<T> }
}

/**
 * Set what an API token cannot: keyctl, the tun device for the VPN, and the library mountpoint (a NAS mounted
 * on this node first). The container is stopped, changed and started again, and its config is read back.
 * `onMount` fires before a NAS is mounted, so a clean-up knows to undo it.
 */
export async function arrPrepare(plan: { node: string; vmid: number; storage: string; options?: Record<string, string> }, d: ArrPrepareDeps, onMount: () => Promise<void> | void = () => {}): Promise<string> {
  const c = checkArrOptions(plan.options ?? {})
  if (!c.layout) throw new Error(`The Arr Stack's settings are not usable: ${c.errors.join(' ')}`)
  const arr = d.arr?.()
  if (!arr) throw new Error('HyperProx cannot reach the node to finish the container.')
  if (c.layout.media === 'nfs') await onMount()
  const o = { vmid: plan.vmid, layout: c.layout, storage: plan.storage, tun: c.selection.vpn }
  const r = await arr.nodeRun(plan.node, prepareScript(o), 5 * 60_000)
  if (c.layout.media === 'nfs' && !/@@arr mounted/.test(r.output)) throw new Error(`${c.layout.nfs!.source} could not be mounted on ${plan.node}.`)
  if (r.code !== 0 || !/@@arr prepared/.test(r.output)) throw new Error(`The container could not be given its library and keyctl on ${plan.node} (exit ${r.code}).`)
  const cfg = await d.client.fetchStrict<Record<string, unknown>>(`/nodes/${encodeURIComponent(plan.node)}/lxc/${plan.vmid}/config`)
  const bad = configProblems(cfg, o)
  if (bad.length) throw new Error(`CT ${plan.vmid}'s settings did not read back: ${bad.join(' ')}`)
  const where = c.layout.media === 'disk' ? `a new ${c.layout.mediaGb} GB disk on ${plan.storage}` : c.layout.media === 'nfs' ? `${c.layout.nfs!.source} (mounted on ${plan.node})` : c.layout.hostPath
  return `nesting and keyctl on${o.tun ? ', /dev/net/tun for the VPN' : ''}; library on ${where} at ${c.layout.downloads === 'local' ? '/data/media' : '/data'}`
}

/** The install script's variables: the compose file, the folders, the VPN's login (read from the vault and moved to the stack's own item). */
export async function arrInstallEnv(o: { owner: string; options: Record<string, string>; vault?: { category: string; provider: string } }, d: {
  readSecrets(c: string, p: string): Promise<Record<string, string>>
  saveSecrets(c: string, p: string, v: Record<string, string>): Promise<void>
  deleteSecrets(c: string, p: string): Promise<void>
}): Promise<Record<string, string>> {
  const c = checkArrOptions(o.options)
  if (!c.layout || c.errors.length) throw new Error(`The Arr Stack's settings are not usable: ${c.errors.join(' ')}`)
  const env = scriptEnv(c.selection, c.layout, c.vpn)
  if (!c.selection.vpn) return env
  const pending = pendingVpnItem(o.owner)
  const v = await d.readSecrets(pending.category, pending.provider).catch(() => ({} as Record<string, string>))
  if (!v.wireguard_private_key && !v.openvpn_user) throw new Error('The VPN login is no longer in the vault. Check the plan again and re-enter it.')
  if (o.vault) {
    const keep = Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'type').map(([k, x]) => [`vpn_${k}`, x]))
    await d.saveSecrets(o.vault.category, o.vault.provider, { ...keep, vpn_provider: c.vpn!.provider })
  }
  await d.deleteSecrets(pending.category, pending.provider).catch(() => {})
  return { ...env, ...vpnEnv(v) }
}

/** The setup chores, then the public names. Returns the address to show and the apps' own addresses. */
export async function arrRunSetup(o: {
  ip: string; owner: string; options: Record<string, string>; admin: { user: string; password: string }
  vault: { category: string; provider: string }; publish?: ArrPublishPlan[]; recipe: CatalogueRecipe
  ledgers: Record<string, PublishLedger>; save: () => void
}, step: (id: string) => StepRef, d: {
  arr?: () => ArrDeps; sh: ArrSetupDeps['sh']; wait(ms: number): Promise<unknown>; publish: PublishDeps
  saveSecrets: ArrSetupDeps['saveSecrets']; readSecrets: ArrSetupDeps['readSecrets']
}): Promise<{ url: string; apps: Array<{ id: ArrAppId; name: string; url: string }>; notes: string[] }> {
  const c = checkArrOptions(o.options)
  const arr = d.arr?.()
  if (!arr) throw new Error('The Arr Stack\'s setup is not available here.')
  const out = await runArrSetup({
    ip: o.ip, selection: c.selection, admin: o.admin, vault: o.vault, vpnPortForwarding: Boolean(c.vpn?.portForwarding),
  }, step, { ...arr, sh: d.sh, wait: d.wait, saveSecrets: d.saveSecrets, readSecrets: d.readSecrets })
  for (const p of o.publish ?? []) {
    const app = appById(p.app)!
    const st = step(`arr-publish-${p.app}`)
    const ledger = (o.ledgers[p.app] ??= {})
    const as: CatalogueRecipe = { ...o.recipe, name: app.name, port: app.hostPort, healthPath: app.health, expectStatus: app.healthOk, healthBody: undefined }
    const url = await runPublish(p.plan, as, o.ip, o.owner, ledger, {
      step: id => { st.detail = `${app.name}: ${id}`; return { status: 'running' } },
      save: o.save,
    }, d.publish)
    st.status = 'done'; st.detail = `${url} → ${app.name}`
    const row = out.apps.find(a => a.id === p.app)
    if (row) row.url = url
  }
  return out
}

/** Undo what an Arr Stack install made outside its container: public names, then the NAS mount on its node. */
export async function arrCleanup(job: { owner: string; node?: string; vmid?: number; arrLedgers?: Record<string, PublishLedger>; arrHostMount?: { node: string; vmid: number } },
  d: { arr?: () => ArrDeps; publish: PublishDeps }): Promise<string[]> {
  const out: string[] = []
  for (const [app, ledger] of Object.entries(job.arrLedgers ?? {})) {
    const lines = await cleanupPublish(ledger, job.owner, d.publish).catch((e: any) => [`Publishing clean-up for ${app} failed: ${e.message}`])
    out.push(...lines.map(l => `${appById(app)?.name ?? app}: ${l}`))
  }
  if (job.arrHostMount) {
    const m = job.arrHostMount
    const r = await d.arr?.().nodeRun(m.node, unmountScript(m.vmid), 60_000).catch(() => null)
    if (!r || !/@@arr unmounted/.test(r.output)) out.push(`The NAS mount for CT ${m.vmid} on ${m.node} could not be undone; remove its "# hyperprox-arr ${m.vmid}" line from /etc/fstab there.`)
    else { out.push(`The NAS mount on ${m.node} was undone (the NAS's files were not touched).`); job.arrHostMount = undefined }
  }
  return out
}

// ── The real deps ───────────────────────────────────────────────────────────

/** The apps' public facts, for the wizard's picker. */
export function pickerFacts() {
  return {
    apps: APPS.map(a => ({ id: a.id, name: a.name, blurb: a.blurb, option: a.option, default: a.default, image: a.image, port: a.hostPort, cost: a.cost, private: Boolean(a.private) })),
    vpnProviders: VPN_PROVIDERS,
    base: BASE_COST, vpnCost: VPN_COST,
    layoutLine: LAYOUT_LINE,
    splitWarning: sameFilesystem({ downloads: 'local' }).warning!,
  }
}
