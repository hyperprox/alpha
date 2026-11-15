// =============================================================================
//  HyperProx — Homepage: from the inventory to services.yaml
//
//  Pure functions, no I/O, so every rule is a unit test:
//
//    buildEntries   the inventory -> one entry per service, grouped, each with
//                   its name, link, icon, description and status check. The
//                   public address when a proxy host serves it, else the LAN
//                   address. Guests tagged hyperprox-ignore, guests on Remote
//                   access's exclusion list and anything on an excluded subnet
//                   are left out, with every address of an excluded guest.
//    mergeServices  the person's file + those entries -> the new file. HyperProx
//                   owns only the groups it wrote (ManagedState); every other
//                   group is kept as it is, and so is every entry the person
//                   added to a HyperProx group or changed in one.
//    mergeWidgets   widgets.yaml gets resources and search when it has neither.
//    lineDiff       what the preview shows before anything is written.
//
//  Generated with js-yaml and parsed back before it is offered: a file that does
//  not read back as exactly what was meant is never written.
// =============================================================================

import { createHash } from 'node:crypto'
import { GROUPS, appFromName, knownApp, type GroupName, type KnownApp } from './catalog'
import { parseCidr, sameSubnet } from '../wizard-placement'
import {
  type Entry, type GenerateOptions, type Inventory, type InvService, type ManagedState, type MergeNotes, type MergeResult, type GuestRef,
} from './types'

// js-yaml ships no types; only load(), dump() and the default schema are used.
// eslint-disable-next-line @typescript-eslint/no-var-requires
export const yaml = require('js-yaml') as { load(src: string, o?: Record<string, unknown>): unknown; dump(v: unknown, o?: Record<string, unknown>): string; DEFAULT_SCHEMA: unknown }

export const IGNORE_TAG = 'hyperprox-ignore'
export const MANAGED_MARK = '# managed by HyperProx'

// ── addresses ────────────────────────────────────────────────────────────────

/** host and port of a URL (default port by scheme); null when it is not one. */
export function hostPort(url: string | null | undefined): { scheme: string; host: string; port: number } | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
    return { scheme: u.protocol.slice(0, -1), host: u.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port }
  } catch { return null }
}

const key = (host: string, port: number) => `${host.toLowerCase()}:${port}`

/** Is this IPv4 address inside one of these CIDRs? Names and malformed CIDRs never match. */
export function inSubnets(host: string, cidrs: string[]): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false
  return cidrs.some(c => { const p = parseCidr(c); return !!p && sameSubnet(host, p.ip, p.prefix) })
}

// ── exclusion ────────────────────────────────────────────────────────────────

export interface Exclusion { guests: Set<number>; addresses: Set<string>; subnets: string[] }

/** Who is left out: tagged guests, Remote access's exclusions, guests on an excluded subnet (and all their addresses). */
export function exclusionOf(inv: Inventory, subnets: string[]): Exclusion {
  const guests = new Set<number>(), addresses = new Set<string>()
  const ids = new Set(inv.excludedMachineIds)
  for (const g of inv.guests) {
    const tagged = g.tags.map(t => t.toLowerCase()).includes(IGNORE_TAG)
    if (tagged || ids.has(g.machineId) || g.addresses.some(a => inSubnets(a, subnets))) {
      guests.add(g.vmid)
      for (const a of g.addresses) addresses.add(a.toLowerCase())
    }
  }
  return { guests, addresses, subnets }
}

function excludedHost(host: string, ex: Exclusion): boolean {
  return ex.addresses.has(host.toLowerCase()) || inSubnets(host, ex.subnets)
}

function excludedGuest(g: GuestRef | null | undefined, ex: Exclusion): boolean {
  return !!g && ex.guests.has(Number(g.vmid))
}

// ── entries ──────────────────────────────────────────────────────────────────

/** A HOMEPAGE_VAR_ name: upper case, digits and underscores only. */
export function varName(entryId: string, field: string): string {
  const s = (x: string) => x.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `HOMEPAGE_VAR_${s(entryId).slice(0, 60)}_${s(field)}`
}

/** A value with every {{ and }} taken out (repeatedly, so "{{{" cannot leave one behind). */
export function noBraces(v: string): string {
  let s = String(v ?? '')
  for (let prev = ''; prev !== s;) { prev = s; s = s.replace(/\{\{|\}\}/g, '') }
  return s
}

const isWeb = (u: string | null | undefined) => !!u && /^https?:\/\//i.test(u)

/** An origin (scheme://host:port, default ports written out) for comparing two addresses. */
export function originKey(url: string | null | undefined): string | null {
  const hp = hostPort(url)
  return hp ? `${hp.scheme}://${hp.host}:${hp.port}` : null
}

/**
 * The widget this entry may have. A widget whose key is a plug-in's is offered only on the entry at the address that
 * plug-in is configured for, so a key can never be sent to another host of the same kind (a second Sonarr). The
 * cluster widget's token only on the cluster's own entry.
 */
function offerFor(app: KnownApp | null, id: string, opts: GenerateOptions, lanUrl: string | null, source: string) {
  if (!app?.widget) return undefined
  for (const s of app.widget.secrets) {
    if (s.from.kind === 'plugin') {
      const want = originKey(opts.pluginUrls?.[`${s.from.plugin}:${s.from.urlSetting}`])
      if (!want || want !== originKey(lanUrl)) return undefined
    } else if (source !== 'cluster') return undefined
  }
  const vars: Record<string, string> = {}
  for (const s of app.widget.secrets) vars[s.field] = varName(id, s.field)
  const enabled = opts.widgets.includes(id)
  const ready = Object.values(vars).every(v => opts.exportedVars.includes(v))
  return { type: app.widget.type, vars, enabled, pending: enabled && !ready }
}

function widgetBlock(e: Entry, lanUrl: string | null): Record<string, string> | undefined {
  const o = e.offer
  if (!o || !o.enabled || o.pending) return undefined
  const url = lanUrl ?? e.href
  if (!url) return undefined
  const w: Record<string, string> = { type: o.type, url }
  for (const [field, v] of Object.entries(o.vars)) w[field] = `{{${v}}}`
  return w
}

interface Draft {
  e: Entry; lan: string | null; key: string
  /**
   * Check the public address, not the forward target: a proxy host's target often serves by name (a web server's
   * virtual hosts, an app that redirects to its own name), so asking it by address gets a 404 or a redirect loop.
   */
  monitorPublic?: boolean
}

/** The status check's address: the LAN origin, with the app's no-login path when it has one. */
function monitorUrl(url: string, path?: string): string {
  if (!path) return url
  try { const u = new URL(url); return `${u.protocol}//${u.host}${path}` } catch { return url }
}

/**
 * One entry per service on the dashboard. Order inside a group is by name; groups follow GROUPS. The ids are stable
 * across runs so a hidden entry stays hidden and a widget stays on.
 */
export function buildEntries(inv: Inventory, given: GenerateOptions): Entry[] {
  const opts: GenerateOptions = { ...given, pluginUrls: given.pluginUrls ?? inv.pluginUrls ?? {} }
  const ex = exclusionOf(inv, opts.excludeSubnets)
  const proxies = inv.proxyHosts.filter(p => !excludedGuest(p.guest, ex) && !excludedHost(p.forward.host, ex) && p.url)
  const byTarget = new Map<string, typeof proxies>()
  for (const p of proxies) {
    const k = key(p.forward.host, p.forward.port)
    byTarget.set(k, [...(byTarget.get(k) ?? []), p])
  }
  const usedProxy = new Set<(typeof proxies)[number]>()
  const publicFor = (host: string, port: number, given?: string | null): string | null => {
    const list = byTarget.get(key(host, port)) ?? []
    if (given) {
      const gp = hostPort(given)
      for (const p of proxies) if (gp && p.domains.includes(gp.host)) usedProxy.add(p)
      return given
    }
    if (!list.length) return null
    for (const p of list) usedProxy.add(p)
    // Several names for one target: the shortest is the one people type.
    return [...list].sort((a, b) => (a.domains[0] ?? '').length - (b.domains[0] ?? '').length)[0].url
  }

  const drafts: Draft[] = []
  const seen = new Set<string>()
  const services = [...inv.services].sort((a, b) => sourceRank(a) - sourceRank(b))
  for (const s of services) {
    const hp = hostPort(s.url)
    if (!hp || excludedGuest(s.guest, ex) || excludedHost(hp.host, ex)) continue
    const app = knownApp(s.key)
    const k = `${app?.key ?? s.key}@${key(hp.host, hp.port)}`
    if (seen.has(k)) continue
    seen.add(k)
    const pub = publicFor(hp.host, hp.port, s.publicUrl ?? null)
    const href = pub ?? s.url
    const e: Entry = {
      id: k, group: app?.group ?? 'Infrastructure', name: s.label ?? app?.name ?? s.key, href, hrefKind: pub ? 'public' : 'lan',
      icon: app?.icon ?? 'mdi-application', description: app?.description ?? '', guest: s.guest ?? null, source: s.source,
    }
    e.offer = offerFor(app, k, opts, s.url, s.source)
    drafts.push({ e, lan: s.url, key: app?.key ?? s.key })
  }

  // HyperProx's own Websites.
  for (const site of inv.sites) {
    const href = site.url ?? site.localUrl ?? null
    const lanHp = hostPort(site.localUrl)
    if (ex.guests.has(Number(site.vmid)) || (lanHp && excludedHost(lanHp.host, ex)) || !href) continue
    const pubHp = hostPort(site.url)
    for (const p of proxies) if (pubHp && p.domains.includes(pubHp.host)) usedProxy.add(p)
    const app = knownApp(site.recipeId) ?? knownApp('website')!
    const id = `site:${site.name}`
    if (seen.has(id)) continue
    seen.add(id)
    drafts.push({ e: { id, group: 'Websites', name: site.name, href, hrefKind: site.url ? 'public' : 'lan', icon: app.icon, description: app.key === 'website' ? 'Website' : app.name, guest: null, source: 'site' }, lan: site.localUrl ?? null, key: app.key })
  }

  // Proxy hosts that match no service already listed: an app their name or guest suggests, else a website.
  for (const p of proxies) {
    if (usedProxy.has(p)) continue
    const domain = p.domains.find(d => !d.includes('*'))
    if (!domain) continue
    const app = appFromName(domain.split('.')[0], p.guest?.name)
    const onGuest = (k: string) => drafts.some(d => d.key === k && (d.e.guest && p.guest ? d.e.guest.vmid === p.guest.vmid : false))
    if (app && app.group !== 'Websites' && app.key !== 'guest' && onGuest(app.key)) continue
    const id = `proxy:${domain}`
    if (seen.has(id)) continue
    seen.add(id)
    const lan = `${p.forward.scheme}://${p.forward.host.includes(':') ? `[${p.forward.host}]` : p.forward.host}:${p.forward.port}`
    const isApp = app && app.key !== 'website' && app.key !== 'guest'
    drafts.push({ e: {
      id, group: isApp ? app!.group : 'Websites', name: isApp && app!.group !== 'Websites' ? app!.name : domain, href: p.url, hrefKind: 'public',
      icon: isApp ? app!.icon : 'mdi-web', description: isApp ? app!.description : (p.guest ? `On ${p.guest.name}` : 'Website'), guest: p.guest, source: 'proxy',
    }, lan, key: isApp ? app!.key : 'website', monitorPublic: true })
  }

  // Running guests with nothing on the dashboard yet: a ping dot, when asked for.
  if (opts.includeBareGuests) {
    const covered = new Set(drafts.map(d => d.e.guest?.vmid).filter((v): v is number => typeof v === 'number'))
    for (const g of inv.guests) {
      if (g.status !== 'running' || ex.guests.has(g.vmid) || covered.has(g.vmid)) continue
      const addr = g.addresses.find(a => !inSubnets(a, ex.subnets))
      const id = `guest:${g.vmid}`
      drafts.push({ e: { id, group: 'Guests', name: g.name, href: null, hrefKind: 'none', icon: g.type === 'qemu' ? 'mdi-monitor' : 'mdi-cube-outline',
        description: `${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid} on ${g.node}`, ...(addr ? { ping: addr } : {}), guest: g, source: 'guest' }, lan: null, key: 'guest' })
    }
  }

  // Two of one app (Unmanic workers, two Plex servers): say which.
  const count = new Map<string, number>()
  for (const d of drafts) count.set(`${d.e.group}/${d.e.name}`, (count.get(`${d.e.group}/${d.e.name}`) ?? 0) + 1)
  const used = new Set<string>()
  for (const d of drafts) {
    if ((count.get(`${d.e.group}/${d.e.name}`) ?? 0) > 1) {
      const host = hostPort(d.lan ?? d.e.href)?.host ?? ''
      d.e.name = `${d.e.name} (${d.e.guest?.name ?? host})`
    }
    let n = d.e.name, i = 2
    while (used.has(`${d.e.group}/${n}`)) n = `${d.e.name} ${i++}`
    d.e.name = n
    used.add(`${d.e.group}/${n}`)
  }

  const out: Entry[] = []
  for (const d of drafts) {
    if (opts.hiddenEntries.includes(d.e.id)) continue
    const target = d.monitorPublic && isWeb(d.e.href) ? d.e.href : (d.lan ?? d.e.href)
    if (isWeb(target) && !d.e.ping) d.e.siteMonitor = monitorUrl(target!, target === d.lan || d.monitorPublic ? knownApp(d.key)?.monitorPath : undefined)
    // Homepage fills {{...}} from its environment anywhere in the file: no value HyperProx writes outside a widget
    // block may carry one, or a name could pull a key into the page.
    d.e.name = noBraces(d.e.name)
    d.e.description = noBraces(d.e.description)
    d.e.icon = noBraces(d.e.icon)
    if (d.e.href) d.e.href = noBraces(d.e.href)
    if (d.e.siteMonitor) d.e.siteMonitor = noBraces(d.e.siteMonitor)
    if (d.e.ping) d.e.ping = noBraces(d.e.ping)
    const w = widgetBlock(d.e, d.lan)
    if (w) d.e.widget = w
    out.push(d.e)
  }
  const gi = (g: string) => GROUPS.indexOf(g as GroupName)
  return out.sort((a, b) => gi(a.group) - gi(b.group) || a.name.localeCompare(b.name))
}

/** What was installed or configured outranks what a scan guessed: a recipe's own record names it best. */
function sourceRank(s: InvService): number {
  return ({ self: 0, cluster: 0, install: 1, plugin: 2, catalogue: 3, scan: 4 } as Record<string, number>)[s.source] ?? 5
}

/** The entries as Homepage's groups: { group: entries in file order }. Hidden groups left out. */
export function groupsOf(entries: Entry[], hidden: string[] = []): Array<{ group: GroupName; entries: Entry[] }> {
  const out: Array<{ group: GroupName; entries: Entry[] }> = []
  for (const g of GROUPS) {
    if (hidden.includes(g)) continue
    const list = entries.filter(e => e.group === g)
    if (list.length) out.push({ group: g, entries: list })
  }
  return out
}

/** One entry as services.yaml holds it: { name: { href, icon, description, siteMonitor | ping, widget } }. */
export function entryValue(e: Entry): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  if (e.href) v.href = e.href
  v.icon = e.icon
  if (e.description) v.description = e.description
  if (e.siteMonitor) v.siteMonitor = e.siteMonitor
  if (e.ping) v.ping = e.ping
  if (e.widget) v.widget = { ...e.widget }
  return v
}

// ── merge ────────────────────────────────────────────────────────────────────

/** A stable hash of one entry's value, so HyperProx can tell its own unchanged entry from one the person edited. */
export function valueHash(v: unknown): string {
  const stable = (x: unknown): unknown => Array.isArray(x) ? x.map(stable)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x as object).sort().map(k => [k, stable((x as any)[k])])) : x
  return createHash('sha256').update(JSON.stringify(stable(v) ?? null)).digest('hex').slice(0, 16)
}

export class YamlProblem extends Error {
  constructor(message: string, readonly code: 'yaml_invalid' | 'not_a_list' | 'roundtrip') { super(message); this.name = 'YamlProblem' }
}

type Item = Record<string, unknown>

/** The file's groups: a list of one-key maps. Empty or comment-only is an empty list. */
export function parseServices(text: string): Item[] {
  let doc: unknown
  try { doc = yaml.load(text ?? '', { schema: yaml.DEFAULT_SCHEMA }) } catch (e: any) {
    throw new YamlProblem(`services.yaml does not read as YAML: ${String(e?.reason ?? e?.message ?? e).slice(0, 200)}${e?.mark ? ` (line ${e.mark.line + 1})` : ''}`, 'yaml_invalid')
  }
  if (doc === undefined || doc === null) return []
  if (!Array.isArray(doc)) throw new YamlProblem('services.yaml is not a list of groups, so HyperProx cannot tell its groups from yours.', 'not_a_list')
  for (const it of doc) {
    if (!it || typeof it !== 'object' || Array.isArray(it) || Object.keys(it).length !== 1) {
      throw new YamlProblem('services.yaml has an item that is not one named group.', 'not_a_list')
    }
  }
  return doc as Item[]
}

const nameOf = (it: Item) => Object.keys(it)[0]
const entryNames = (list: unknown): string[] => (Array.isArray(list) ? list : [])
  .filter(x => x && typeof x === 'object' && !Array.isArray(x)).map(x => Object.keys(x as object)[0])

/** Homepage's own example groups, exactly as a fresh install writes them: safe to replace. */
export function isSampleConfig(items: Item[]): boolean {
  if (items.length !== 3) return false
  const names = ['My First Group', 'My Second Group', 'My Third Group']
  return items.every((it, i) => {
    if (nameOf(it) !== names[i]) return false
    const list = it[names[i]]
    if (!Array.isArray(list) || list.length !== 1) return false
    const svc = list[0] as Item
    const v = svc && typeof svc === 'object' ? (svc as any)[Object.keys(svc)[0]] : null
    return /^My (First|Second|Third) Service$/.test(Object.keys(svc ?? {})[0] ?? '') && v && v.href === 'http://localhost/'
  })
}

/** The header that says which groups are HyperProx's. Comments are not data, so it is rewritten each time. */
export function header(managed: string[]): string {
  return [
    MANAGED_MARK,
    `# HyperProx keeps these groups up to date: ${managed.join(', ') || '(none yet)'}.`,
    '# It never changes any other group, keeps entries you add to its groups, and leaves an entry you edit as you edited it.',
    '# Comments elsewhere in this file are not kept when HyperProx rewrites it; each write leaves a dated backup beside it.',
    '',
  ].join('\n')
}

/** A group's base name: HyperProx's twin of a group the person already had is "X (HyperProx)". */
export const baseGroup = (g: string) => g.replace(/ \(HyperProx\)$/, '')

/**
 * HyperProx has no record of this file (its database was reset, or another HyperProx wrote it) but the file's
 * header names HyperProx's groups: take those groups back. An entry is HyperProx's only when it is exactly what
 * HyperProx would write there now (same name, same value); anything else is the person's (an edit or their own) and
 * is kept. A listed group with no such entry is not taken: the header alone never lets HyperProx overwrite a group.
 */
export function adoptFromHeader(text: string, items: Item[], entries: Entry[]): ManagedState {
  const m = /^# HyperProx keeps these groups up to date: (.*)\.$/m.exec(text ?? '')
  if (!m || m[1] === '(none yet)') return { managedGroups: [], written: {}, released: [] }
  const listed = m[1].split(',').map(x => x.trim()).filter(Boolean)
  const managedGroups: string[] = [], written: ManagedState['written'] = {}
  for (const it of items) {
    const g = nameOf(it)
    if (!listed.includes(g)) continue
    const ours = new Map(entries.filter(e => e.group === baseGroup(g)).map(e => [e.name, valueHash(entryValue(e))]))
    const claimed: Record<string, string> = {}
    for (const raw of Array.isArray(it[g]) ? it[g] as unknown[] : []) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const n = Object.keys(raw)[0]
      const h = valueHash((raw as Item)[n])
      if (ours.get(n) === h) claimed[n] = h
    }
    if (!Object.keys(claimed).length) continue
    managedGroups.push(g)
    written[g] = claimed
  }
  return { managedGroups, written, released: [] }
}

/** One top-level item as YAML, marked when HyperProx owns it. */
function dumpItem(it: Item, managed: boolean): string {
  const body = yaml.dump([it], { lineWidth: -1, noRefs: true, quotingType: '"' })
  return (managed ? `${MANAGED_MARK}\n` : '') + body
}

/**
 * The new services.yaml. Walks the person's file in order: their groups stay where they are, untouched; each
 * HyperProx group is rebuilt from the entries, keeping what the person added or changed inside it. New HyperProx
 * groups go at the end. A HyperProx group the person deleted is not put back (it is listed in the notes).
 */
export function mergeServices(currentText: string, entries: Entry[], prev: ManagedState, opts: Pick<GenerateOptions, 'hiddenGroups'> = { hiddenGroups: [] }): MergeResult {
  let items = parseServices(currentText)
  const notes: MergeNotes = { keptUserGroups: [], keptUserEntries: [], keptEdits: [], userRemovedGroups: [], renamed: [], droppedSamples: false, adopted: [], handedOver: [] }
  if (isSampleConfig(items)) { items = []; notes.droppedSamples = true }
  if (!prev.managedGroups.length && !(prev.released ?? []).length) {
    prev = adoptFromHeader(currentText, items, entries)
    notes.adopted = prev.managedGroups
  }
  const released = new Set(prev.released ?? [])

  const present = new Set(items.map(nameOf))
  const managedBefore = new Set(prev.managedGroups)
  for (const g of prev.managedGroups) if (!present.has(g) && !opts.hiddenGroups.includes(baseGroup(g))) notes.userRemovedGroups.push(g)
  const removed = new Set(notes.userRemovedGroups)

  // Our group's name in the file: the plain name, unless the person already has a group called that.
  const userNames = new Set(items.map(nameOf).filter(n => !managedBefore.has(n)))
  const fileName = (g: string): string => {
    if (managedBefore.has(g) || !userNames.has(g)) return g
    const alt = `${g} (HyperProx)`
    notes.renamed.push({ from: g, to: alt })
    return alt
  }

  const want = new Map<string, Entry[]>()
  for (const { group, entries: list } of groupsOf(entries, opts.hiddenGroups)) {
    // A group handed to the person is theirs: HyperProx writes it neither under its name nor as a twin.
    if (released.has(group)) continue
    const name = fileName(group)
    if (removed.has(name) || removed.has(group)) continue
    // A twin beside the person's own group never repeats an entry they already have there.
    const theirs = name !== group ? new Set(entryNames(items.find(it => nameOf(it) === group)?.[group])) : new Set<string>()
    want.set(name, list.filter(e => !theirs.has(e.name)))
  }

  const written: ManagedState['written'] = {}
  const managed: string[] = []
  const out: Array<{ item: Item; managed: boolean }> = []

  const userAdded = new Map<string, number>()
  const build = (name: string, existing: unknown[]): Item | null => {
    const mine = want.get(name) ?? []
    const before = prev.written[name] ?? {}
    const keep: unknown[] = []
    const edited = new Set<string>()
    for (const raw of existing) {
      const n = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 1 ? Object.keys(raw)[0] : null
      if (n === null) { keep.push(raw); continue }
      const val = (raw as Item)[n]
      if (before[n] === undefined) { keep.push(raw); notes.keptUserEntries.push(`${name} / ${n}`); userAdded.set(name, (userAdded.get(name) ?? 0) + 1); continue }
      if (valueHash(val) !== before[n]) { keep.push(raw); edited.add(n); notes.keptEdits.push(`${name} / ${n}`) }
      // Otherwise it is HyperProx's own, unchanged: rebuilt below (or dropped when it is gone).
    }
    const ours = mine.filter(e => !edited.has(e.name) && !keep.some(k => k && typeof k === 'object' && Object.keys(k as object)[0] === e.name))
    const list = [...ours.map(e => ({ [e.name]: entryValue(e) })), ...keep]
    if (!list.length) return null
    written[name] = Object.fromEntries(ours.map(e => [e.name, valueHash(entryValue(e))]))
    return { [name]: list }
  }

  for (const it of items) {
    const n = nameOf(it)
    if (!managedBefore.has(n)) { out.push({ item: it, managed: false }); notes.keptUserGroups.push(n); continue }
    const existing = Array.isArray(it[n]) ? it[n] as unknown[] : []
    const rebuilt = build(n, existing)
    want.delete(n)
    if (!rebuilt) continue
    // Left holding none of HyperProx's entries but some the person added: it is theirs now, for good (released, so
    // no "X (HyperProx)" twin is made next time). Holding only the person's edits of HyperProx's entries, it stays
    // HyperProx's group and nothing in it is written over.
    if (!Object.keys(written[n] ?? {}).length && (userAdded.get(n) ?? 0) > 0) {
      delete written[n]
      released.add(baseGroup(n))
      notes.handedOver.push(n)
      out.push({ item: rebuilt, managed: false })
      continue
    }
    written[n] ??= {}
    managed.push(n)
    out.push({ item: rebuilt, managed: true })
  }
  for (const [n] of want) {
    const rebuilt = build(n, [])
    if (!rebuilt) continue
    managed.push(n)
    out.push({ item: rebuilt, managed: true })
  }

  const body = out.map(o => dumpItem(o.item, o.managed)).join('\n')
  const text = `${header(managed)}${body.length ? `\n${body}` : '[]\n'}`
  // Read back exactly what was meant, or nothing is offered.
  const back = parseServices(text)
  if (JSON.stringify(back) !== JSON.stringify(out.map(o => o.item))) throw new YamlProblem('The generated services.yaml did not read back as written.', 'roundtrip')
  const state: ManagedState = { managedGroups: managed, written, released: [...released] }
  return { text, state, notes, changed: text !== currentText }
}

// ── widgets.yaml ─────────────────────────────────────────────────────────────

export const BASIC_WIDGETS: Item[] = [
  { resources: { cpu: true, memory: true, disk: '/' } },
  { search: { provider: 'duckduckgo', target: '_blank' } },
]

/** widgets.yaml with resources and search added when missing. Unchanged (same text) when both are there. */
export function mergeWidgets(currentText: string): { text: string; changed: boolean; added: string[] } {
  let doc: unknown
  try { doc = yaml.load(currentText ?? '') } catch (e: any) {
    throw new YamlProblem(`widgets.yaml does not read as YAML: ${String(e?.reason ?? e?.message ?? e).slice(0, 200)}`, 'yaml_invalid')
  }
  const list = doc === null || doc === undefined ? [] : doc
  if (!Array.isArray(list)) throw new YamlProblem('widgets.yaml is not a list of widgets.', 'not_a_list')
  const have = new Set(list.filter(x => x && typeof x === 'object').map(x => Object.keys(x)[0]))
  const add = BASIC_WIDGETS.filter(w => !have.has(nameOf(w)))
  if (!add.length) return { text: currentText, changed: false, added: [] }
  const next = [...list, ...add]
  const text = `---\n# Info widgets. HyperProx added: ${add.map(nameOf).join(', ')}. It never changes the ones you add.\n\n${yaml.dump(next, { lineWidth: -1, noRefs: true })}`
  if (JSON.stringify(yaml.load(text)) !== JSON.stringify(next)) throw new YamlProblem('The generated widgets.yaml did not read back as written.', 'roundtrip')
  return { text, changed: true, added: add.map(nameOf) }
}

// ── .env ─────────────────────────────────────────────────────────────────────

const ENV_NAME = /^HOMEPAGE_VAR_[A-Z0-9_]{1,100}$/

/**
 * The compose .env with these HOMEPAGE_VAR_ values set. Every other line is kept as it is. A value is written in
 * single quotes (compose reads it literally); one that holds a quote or a line break is refused, never escaped.
 */
export function mergeEnv(currentText: string, values: Record<string, string>): string {
  for (const [k, v] of Object.entries(values)) {
    if (!ENV_NAME.test(k)) throw new Error(`Not a Homepage variable name: ${k}`)
    if (!safeSecret(v)) throw new Error(`The value for ${k} holds a quote, a backslash, {{ or a line break, which cannot be carried safely into the .env and Homepage's YAML.`)
  }
  const lines = (currentText ?? '').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const done = new Set<string>()
  const out = lines.map(l => {
    const m = /^([A-Z0-9_]+)=/.exec(l)
    if (m && values[m[1]] !== undefined) { done.add(m[1]); return `${m[1]}='${values[m[1]]}'` }
    return l
  })
  for (const [k, v] of Object.entries(values)) if (!done.has(k)) out.push(`${k}='${v}'`)
  return out.join('\n') + '\n'
}

/**
 * A key HyperProx will write: no quote of either kind, no backslash, no {{ or }}, no line break or NUL. Homepage puts
 * the value into a double-quoted YAML string, and compose reads the .env line in single quotes; any of these could
 * end either one early.
 */
export function safeSecret(v: string): boolean {
  return typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/["'\\\r\n\0]|\{\{|\}\}/.test(v)
}

/** The .env with every HOMEPAGE_VAR_ line not in `keep` taken out; every other line kept. */
export function pruneEnv(currentText: string, keep: string[]): { text: string; removed: string[] } {
  const removed: string[] = []
  const lines = (currentText ?? '').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const out = lines.filter(l => {
    const m = /^(HOMEPAGE_VAR_[A-Z0-9_]+)=/.exec(l)
    if (m && !keep.includes(m[1])) { removed.push(m[1]); return false }
    return true
  })
  return { text: out.length ? out.join('\n') + '\n' : '', removed }
}

/** The HOMEPAGE_VAR_ names a .env sets (values never leave this function). */
export function envNames(text: string): string[] {
  return (text ?? '').split('\n').map(l => /^(HOMEPAGE_VAR_[A-Z0-9_]+)=./.exec(l)?.[1]).filter((x): x is string => !!x)
}

// ── diff ─────────────────────────────────────────────────────────────────────

export interface DiffLine { op: ' ' | '+' | '-'; text: string }

/** A line diff (longest common subsequence). Files over 2,000 lines are shown whole, as removed and added. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = (a ?? '').split('\n'), y = (b ?? '').split('\n')
  if (x.length > 2000 || y.length > 2000) return [...x.map(text => ({ op: '-' as const, text })), ...y.map(text => ({ op: '+' as const, text }))]
  const n = x.length, m = y.length
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: ' ', text: x[i] }); i++; j++ }
    else if (t[i + 1][j] >= t[i][j + 1]) out.push({ op: '-', text: x[i++] })
    else out.push({ op: '+', text: y[j++] })
  }
  while (i < n) out.push({ op: '-', text: x[i++] })
  while (j < m) out.push({ op: '+', text: y[j++] })
  return out
}

