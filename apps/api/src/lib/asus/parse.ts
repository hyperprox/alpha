// =============================================================================
//  HyperProx — ASUS router: reading the router's answers
//
//  Stock Asuswrt and Asuswrt-Merlin (388.x on the 3.0.0.4 base, 3004.x, and the
//  3.0.0.6 base) answer the same appGet.cgi "hook" calls the ASUS phone app
//  uses. The answers are JSON, mostly: wanlink() answers with JavaScript
//  function text, some builds leave a trailing comma, and a device name can
//  carry a control character. Everything here is pure and tolerant: a part
//  that is missing or malformed becomes null and is named in `missing`, never
//  a throw, so one odd answer costs one panel, not the page.
//
//  Counters (traffic and CPU time) only mean something as a difference between
//  two samples, so rates are worked out from the previous sample the service
//  keeps (ratesFrom), never from a single reading.
// =============================================================================

import crypto from 'node:crypto'

export type HealthLevel = 'good' | 'attention'

export interface AsusBand {
  /** The radio's unit number (wl0, wl1, ...). Clients name it as isWL = unit + 1. */
  unit:     number
  /** "2.4 GHz", "5 GHz", "5 GHz-2", "6 GHz". */
  label:    string
  ssid:     string | null
  /** The channel in use, "auto" when the router picks it and does not say which, null when not reported. */
  channel:  string | null
  widthMhz: number | null
  enabled:  boolean
  clients:  number
}

export interface AsusDevice {
  /** Stable for this process, opaque: never derived reversibly from the MAC. */
  key:        string
  name:       string
  ip:         string | null
  mac:        string | null
  vendor:     string | null
  connection: 'wired' | 'wifi'
  /** The band's label for a wireless client, null for a wired one. */
  band:       string | null
  rssi:       number | null
  /** 0..4 bars from the RSSI, null for wired or unreported. */
  bars:       number | null
  onlineSec:  number | null
  /** The AiMesh unit it is connected to, when the router leads a mesh. */
  node?:      string | null
}

/** One unit of an AiMesh network, as the main unit reports it (get_cfg_clientlist). */
export interface MeshNode {
  key:      string
  name:     string
  model:    string | null
  firmware: string | null
  /** A newer firmware the main unit knows of for this node. */
  update:   string | null
  main:     boolean
  online:   boolean
  /** How a node reaches the mesh: "wired", or the band of its wireless backhaul. Null for the main unit. */
  backhaul: string | null
  rssi:     number | null
  bars:     number | null
  clients:  number
  ip:       string | null
}

/** How the unit is used. Only a router has a WAN of its own; every other mode gets its internet from upstream. */
export type ModeKind = 'router' | 'ap' | 'repeater' | 'bridge' | 'node'

export interface AsusMode {
  kind:   ModeKind | null
  /** "Router", "Access point", "Repeater", "Media bridge", "AiMesh node"; " · AiMesh main" added for a mesh main unit. */
  label:  string | null
  /** The unit's AiMesh role, when it is in a mesh. */
  aimesh: 'main' | 'node' | null
}

export interface AsusReading {
  fetchedAt: string
  /** The unit's own name (AiMesh location, else host name), or null when it has none worth showing. */
  unitName:  string | null
  mode:      AsusMode
  /** Not a router: where its LAN connects upstream. The gateway address is for operators and up. */
  uplink:    { gateway: string | null } | null
  model:     string | null
  firmware:  { version: string | null; flavour: 'merlin' | 'stock' | null }
  update:    { available: boolean | null; version: string | null }
  uptimeSec: number | null
  cpuPct:    number | null
  cpuCores:  number | null
  mem:       { totalKiB: number; usedKiB: number; pct: number } | null
  wan: {
    up:      boolean | null
    status:  string | null
    type:    string | null
    ip:      string | null
    gateway: string | null
    unit:    number | null
    downBps: number | null
    upBps:   number | null
  }
  bands:        AsusBand[]
  /** The AiMesh network when this unit leads one (main first), otherwise empty. */
  mesh:         MeshNode[]
  devices:      AsusDevice[]
  /** Devices the router remembers that are not online now. */
  offlineKnown: number
  health:       { level: HealthLevel; reasons: string[] }
  missing:      string[]
}

// ── the hook calls ───────────────────────────────────────────────────────────

export const WL_KEYS = ['ssid', 'nband', 'radio', 'chanspec', 'bw'] as const
export const FIRMWARE_KEYS = ['productid', 'odmpid', 'firmver', 'buildno', 'extendno', '3rd-party', 'webs_state_flag', 'webs_state_info'] as const
export const MODE_KEYS = ['sw_mode', 're_mode', 'cfg_master', 'wlc_psta', 'lan_gateway'] as const
/** The unit's own name: its AiMesh location (set in the ASUS app), then its host names. */
export const NAME_KEYS = ['cfg_alias', 'computer_name', 'lan_hostname'] as const
/** Other names the firmware gives the model, and the unit's own MACs (to find it in a mesh main's list). Never shown. */
export const ID_KEYS = ['model', 'lan_hwaddr', 'et0macaddr', 'wl0_hwaddr'] as const
export const nv = (k: string) => `nvram_get(${k})`

/** The values that change only when someone reconfigures the unit: read every few minutes, not every reading. */
export function staticHooks(units: number): string[] {
  return [...FIRMWARE_KEYS, ...MODE_KEYS, ...NAME_KEYS, ...ID_KEYS, 'wl_ifnames', ...Array.from({ length: units }, (_, u) => WL_KEYS.map(k => `wl${u}_${k}`)).flat()].map(nv)
}
/** What a reading needs fresh every time. get_wan_unit only means something on a router. */
export const dynamicHooks = (router: boolean) => ['uptime()', 'cpu_usage(appobj)', 'memory_usage(appobj)', 'netdev(appobj)', ...(router ? ['get_wan_unit()'] : [])]

/** How many radios: wl_ifnames lists one interface per radio ("eth4 eth5 eth6"). 4 when it does not say. */
export function radioCount(n: Record<string, unknown>): number {
  const k = String(n.wl_ifnames ?? '').trim().split(/\s+/).filter(Boolean).length
  return k ? Math.min(4, k) : 4
}

/** The key a hook answers under: nvram_get(x) answers as "x", f(...) as "f". */
export function hookKey(h: string): string | null {
  return /^nvram_get\(([^)]+)\)$/.exec(h)?.[1] ?? /^([A-Za-z0-9_]+)\(/.exec(h)?.[1] ?? null
}

/**
 * The calls, by name, as one string each. A reading does not send `system` as one call: Asuswrt 388 builds
 * (stock 3.0.0.4.388_24971, router and access point alike) answer only the FIRST hook of a semicolon list, so
 * the service sends lists, checks every hook was answered, and falls back to one call per hook when they were
 * not (service.ts readHooks). The combined form stays here for the diagnostics read, as evidence.
 */
export const HOOKS = {
  system:   [...staticHooks(4), ...dynamicHooks(true)].join(';'),
  wan:      'wanlink()',
  clients:  'get_clientlist()',
  channels: 'wl_control_channel()',
  counters: 'cpu_usage(appobj);netdev(appobj)',
  mode:     MODE_KEYS.map(nv).join(';'),
  /** AiMesh: the nodes as the main unit knows them, and which clients each one carries. */
  meshNodes:   'get_cfg_clientlist()',
  meshClients: 'get_allclientlist()',
} as const

/**
 * The unit's operation mode. sw_mode: 1 router, 2 repeater, 3 access point, 4 media bridge. AiMesh marks a node
 * with re_mode=1 (whatever its sw_mode says) and the mesh's main unit with cfg_master=1, which may be a router
 * or, on a network where something else routes, an access point.
 */
export function modeOf(n: Record<string, unknown> | null): AsusMode {
  if (!n) return { kind: null, label: null, aimesh: null }
  const sw = str(n.sw_mode, 2), re = str(n.re_mode, 2), master = str(n.cfg_master, 2)
  if (re === '1') return { kind: 'node', label: 'AiMesh node', aimesh: 'node' }
  const kind: ModeKind | null = sw === '1' ? 'router' : sw === '2' ? (str(n.wlc_psta, 2) === '2' ? 'bridge' : 'repeater') : sw === '3' ? 'ap' : sw === '4' ? 'bridge' : null
  const base = kind === 'router' ? 'Router' : kind === 'ap' ? 'Access point' : kind === 'repeater' ? 'Repeater' : kind === 'bridge' ? 'Media bridge' : null
  const main = master === '1'
  return { kind, label: base ? `${base}${main ? ' · AiMesh main' : ''}` : (main ? 'AiMesh main' : null), aimesh: main ? 'main' : null }
}

/**
 * Flat `"key":"value"` pairs, for when an answer is not valid JSON as a whole (one value with an unescaped
 * quote, say): every pair that does parse is kept, so one bad value costs one value, not the whole answer.
 */
export function loosePairs(text: string | null | undefined): Record<string, string> | null {
  if (!text) return null
  const out: Record<string, string> = {}
  const re = /"([A-Za-z0-9_.\-]{1,64})"\s*:\s*"((?:[^"\\\n]|\\.){0,512})"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) { try { out[m[1]] = JSON.parse(`"${m[2]}"`) } catch { out[m[1]] = m[2] } }
  return Object.keys(out).length ? out : null
}

// ── tolerant JSON ────────────────────────────────────────────────────────────

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g

/** JSON, or the same with the usual Asuswrt slips fixed (trailing commas, control characters). Null when neither parses. */
export function looseJson(text: string | null | undefined): Record<string, any> | null {
  if (!text) return null
  const tries = [text, text.replace(CONTROL, ''), text.replace(CONTROL, '').replace(/,\s*([}\]])/g, '$1')]
  for (const t of tries) {
    try {
      const v = JSON.parse(t)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    } catch { /* next */ }
  }
  return null
}

const str = (v: unknown, max = 80): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).replace(CONTROL, '').trim()
  return s ? s.slice(0, max) : null
}
const int = (v: unknown): number | null => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''
  if (!/^-?\d{1,15}$/.test(s)) return null
  return Number(s)
}

/** A counter as the router writes it: "0x1a2b" hex (netdev) or decimal. BigInt so a 64-bit counter keeps every byte. */
export function counter(v: unknown): bigint | null {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
  if (/^0x[0-9a-f]{1,16}$/i.test(s)) return BigInt(s)
  if (/^[0-9a-f]{1,16}$/i.test(s) && /[a-f]/i.test(s)) return BigInt('0x' + s)
  if (/^\d{1,20}$/.test(s)) return BigInt(s)
  return null
}

// ── wanlink() ────────────────────────────────────────────────────────────────

/**
 * wanlink() answers with JavaScript, not JSON: `function wanlink_status() { return 1;}` per field, inside or outside
 * a JSON wrapper depending on the build. Read every `wanlink_<name>() { return <value>; }` pair.
 */
export function parseWanlink(text: string | null | undefined): Record<string, string> | null {
  if (!text) return null
  const out: Record<string, string> = {}
  const re = /wanlink_([a-z0-9_]+)\s*\(\s*\)\s*\{\s*return\s+(?:'([^'\n]*)'|"([^"\n]*)"|([^;}\s]*))\s*;?\s*\}/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').trim()
  return Object.keys(out).length ? out : null
}

// ── firmware ─────────────────────────────────────────────────────────────────

/**
 * The firmware's own version, the way its web page writes it.
 *   stock    firmver 3.0.0.4, buildno 388, extendno 24198-gabc123   ->  3.0.0.4.388_24198
 *   Merlin   firmver 3.0.0.4, buildno 388.8, extendno 2             ->  388.8_2
 * Merlin also sets nvram `3rd-party` to "merlin"; a dotted build number is the fallback tell.
 */
export function firmwareOf(n: Record<string, unknown>): AsusReading['firmware'] {
  const firmver = str(n.firmver, 20), buildno = str(n.buildno, 20), extendno = str(n.extendno, 40)
  const third = str(n['3rd-party'], 20)?.toLowerCase() ?? null
  if (!firmver && !buildno) return { version: null, flavour: null }
  const merlin = third === 'merlin' || /^\d+\.\d+/.test(buildno ?? '')
  if (merlin) {
    const ext = extendno ? extendno.replace(/-g[0-9a-f]+$/i, '') : ''
    return { version: `${buildno ?? firmver}${ext ? `_${ext}` : ''}`, flavour: 'merlin' }
  }
  const ext = extendno ? extendno.split('-')[0] : ''
  return { version: [firmver, buildno].filter(Boolean).join('.') + (ext ? `_${ext}` : ''), flavour: 'stock' }
}

/** webs_state_flag: 0 nothing new, 1 an update, 2 an important one. webs_state_info names it ("3004_388_8_4"). */
export function updateOf(n: Record<string, unknown>, flavour: 'merlin' | 'stock' | null): AsusReading['update'] {
  const flag = str(n.webs_state_flag, 4)
  if (flag === null) return { available: null, version: null }
  const available = flag === '1' || flag === '2'
  let version = available ? str(n.webs_state_info, 40) : null
  if (version && flavour === 'stock') version = version.replace(/^(\d)(\d)(\d)(\d)_/, '$1.$2.$3.$4.')
  return { available, version }
}

// ── radios ───────────────────────────────────────────────────────────────────

/** nband: 2 = 2.4 GHz, 1 = 5 GHz, 4 = 6 GHz (Broadcom's numbering, which every Asuswrt model uses). */
const NBAND: Record<string, string> = { '2': '2.4 GHz', '1': '5 GHz', '4': '6 GHz' }

export function bandsOf(n: Record<string, unknown>, control: string[] | null): Array<Omit<AsusBand, 'clients'>> {
  const raw: Array<Omit<AsusBand, 'clients'>> = []
  for (let u = 0; u < 4; u++) {
    const g = (k: string) => n[`wl${u}_${k}`]
    const nband = str(g('nband'), 2)
    const ssid = str(g('ssid'), 64)
    if (!nband && !ssid) continue
    const live = control?.[u] && /^\d{1,3}$/.test(control[u]) && control[u] !== '0' ? control[u] : null
    const spec = str(g('chanspec'), 20) ?? str(g('channel'), 8)
    const fromSpec = spec ? /^(?:6g)?(\d{1,3})/i.exec(spec)?.[1] ?? null : null
    const channel = live ?? (fromSpec && fromSpec !== '0' ? fromSpec : spec ? 'auto' : null)
    const width = spec ? Number(/\/(\d{2,3})/.exec(spec)?.[1] ?? NaN) : NaN
    const bw = int(g('bw'))
    raw.push({
      unit: u, label: NBAND[nband ?? ''] ?? `Radio ${u + 1}`, ssid, channel,
      widthMhz: Number.isFinite(width) ? width : bw === 1 ? 20 : bw === 2 ? 40 : bw === 3 ? 80 : bw === 5 ? 160 : null,
      enabled: str(g('radio'), 2) !== '0',
    })
  }
  // Two 5 GHz radios (tri-band models) are told apart the way the router's own page does.
  const counts = new Map<string, number>()
  for (const b of raw) counts.set(b.label, (counts.get(b.label) ?? 0) + 1)
  const seen = new Map<string, number>()
  return raw.map(b => {
    if ((counts.get(b.label) ?? 0) < 2) return b
    const i = (seen.get(b.label) ?? 0) + 1
    seen.set(b.label, i)
    return { ...b, label: `${b.label}-${i}` }
  })
}

/** wl_control_channel() answers ["6","149","0"], one per radio. */
export function controlChannels(v: unknown): string[] | null {
  return Array.isArray(v) ? v.map(x => String(x ?? '').trim()) : null
}

// ── clients ──────────────────────────────────────────────────────────────────

/** Per process, so a device's key is stable while HyperProx runs and says nothing about its MAC. */
const KEY_SALT = crypto.randomBytes(16)
export const deviceKey = (instanceId: string, mac: string) =>
  'd' + crypto.createHmac('sha256', KEY_SALT).update(`${instanceId}|${mac.toUpperCase()}`).digest('hex').slice(0, 16)

const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

/** "01:02:03" or "1:01:02:03" (days first) as seconds. */
export function connectSeconds(v: unknown): number | null {
  const s = str(v, 20)
  if (!s || !/^\d{1,4}(:\d{1,2}){1,3}$/.test(s)) return null
  const p = s.split(':').map(Number)
  const mult = [1, 60, 3600, 86400]
  return p.reverse().reduce((t, n, i) => t + n * mult[i], 0)
}

export function barsOf(rssi: number | null): number | null {
  if (rssi === null || rssi >= 0) return null
  return rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : rssi >= -85 ? 1 : 0
}

/**
 * get_clientlist(): one object per MAC (plus "maclist" and "ClientAPILevel"), every value a string.
 * isWL is 0 for wired, otherwise the radio's unit + 1; isOnline is "1" for a device on the network now.
 */
export function parseClients(v: unknown, instanceId: string, bands: Array<Pick<AsusBand, 'unit' | 'label'>>, nodeByMac: Map<string, string> = new Map(), mainNode: string | null = null): { online: AsusDevice[]; offline: number } {
  if (!v || typeof v !== 'object') return { online: [], offline: 0 }
  const online: AsusDevice[] = []
  let offline = 0
  for (const [k, c] of Object.entries(v as Record<string, any>)) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue
    const mac = str(c.mac, 17) ?? (MAC_RE.test(k) ? k : null)
    if (!mac || !MAC_RE.test(mac)) continue
    if (str(c.isOnline, 2) !== '1') { offline++; continue }
    const wl = int(c.isWL) ?? 0
    const band = wl > 0 ? bands.find(b => b.unit === wl - 1)?.label ?? `Radio ${wl}` : null
    const rssi = wl > 0 ? int(c.rssi) : null
    const ip = str(c.ip, 45)
    online.push({
      key: deviceKey(instanceId, mac),
      name: str(c.nickName, 60) ?? str(c.name, 60) ?? str(c.vendor, 60) ?? 'Unknown device',
      ip: ip && (IPV4_RE.test(ip) || ip.includes(':')) ? ip : null,
      mac: mac.toUpperCase(),
      vendor: str(c.vendor, 60),
      connection: wl > 0 ? 'wifi' : 'wired',
      band, rssi: rssi !== null && rssi < 0 ? rssi : null,
      bars: barsOf(rssi),
      onlineSec: wl > 0 ? connectSeconds(c.wlConnectTime) : null,
      ...(nodeByMac.size ? { node: nodeByMac.get(String(c.amesh_papMac ?? '').toUpperCase()) ?? mainNode } : {}),
    })
  }
  online.sort((a, b) => a.name.localeCompare(b.name))
  return { online, offline }
}

// ── AiMesh ───────────────────────────────────────────────────────────────────

/** re_path, a bit per way a node can reach the mesh, and the RSSI field that goes with each band. */
const RE_PATH: Array<[number, string, string | null]> = [[1, 'wired', null], [2, '2.4 GHz', 'rssi2g'], [4, '5 GHz', 'rssi5g'], [8, '5 GHz-2', 'rssi5g1'], [16, '6 GHz', 'rssi6g'], [32, '6 GHz-2', 'rssi6g1']]

const fwOf = (v: unknown) => { const s = str(v, 40); return s ? s.replace(/-g[0-9a-f]+$/i, '') : null }

/**
 * get_cfg_clientlist(): one object per unit (level 0 is the main unit), and get_allclientlist(): per unit MAC,
 * per band ("2G", "5G", "6G", "6G_4", "wired_mac"), the clients on it. Pure; an empty or missing list is no mesh.
 */
export interface MeshParse {
  nodes: MeshNode[]
  byMac: Map<string, string>
  main: string | null
  mainAlias: string | null
  /** The main unit's model ids (model_name, ui_model_name, product_id). */
  mainModels: string[]
  /** Each unit's AiMesh location by every MAC it is known by (mac, ap2g, ap5g, ap6g). Internal only. */
  aliasByMac: Map<string, string>
}

export function parseMesh(nodesRaw: unknown, clientsRaw: unknown, instanceId: string): MeshParse {
  const byMac = new Map<string, string>()
  const aliasByMac = new Map<string, string>()
  let mainAlias: string | null = null
  const mainModels: string[] = []
  if (!Array.isArray(nodesRaw) || !nodesRaw.length) return { nodes: [], byMac, main: null, mainAlias, mainModels, aliasByMac }
  const per = clientsRaw && typeof clientsRaw === 'object' ? clientsRaw as Record<string, any> : {}
  const nodes: MeshNode[] = []
  for (const n of nodesRaw.slice(0, 32)) {
    if (!n || typeof n !== 'object') continue
    const mac = String(n.mac ?? '').toUpperCase()
    if (!MAC_RE.test(mac)) continue
    const main = str(n.level, 3) === '0'
    const path = int(n.re_path) ?? 0
    const hop = main ? null : RE_PATH.find(([bit]) => path & bit) ?? null
    const rssi = hop?.[2] ? int(n[hop[2]]) : null
    const bucket = per[mac] ?? per[mac.toLowerCase()] ?? {}
    const clients = Object.values(bucket && typeof bucket === 'object' ? bucket : {}).reduce((t: number, v: any) => t + (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0), 0)
    const name = str(n.alias, 40) ?? str(n.ui_model_name, 40) ?? 'AiMesh node'
    if (main) {
      mainAlias = str(n.alias, 40)
      for (const k of ['model_name', 'ui_model_name', 'product_id']) { const v = str(n[k], 40); if (v) mainModels.push(v) }
    }
    const alias = str(n.alias, 40)
    if (alias && !addressLike(alias)) for (const k of ['mac', 'ap2g', 'ap5g', 'ap6g']) { const v = String(n[k] ?? '').toUpperCase(); if (MAC_RE.test(v)) aliasByMac.set(v, alias) }
    const ip = str(n.ip, 45)
    nodes.push({
      key: deviceKey(instanceId, mac), name,
      model: str(n.ui_model_name, 40) ?? str(n.model_name, 40) ?? str(n.product_id, 40),
      firmware: fwOf(n.fwver), update: fwOf(n.newfwver), main,
      online: str(n.online, 2) !== '0',
      backhaul: hop ? hop[1] : main ? null : (path ? 'unknown' : null),
      rssi: rssi !== null && rssi < 0 ? rssi : null, bars: barsOf(rssi !== null && rssi < 0 ? rssi : null),
      clients, ip: ip && IPV4_RE.test(ip) ? ip : null,
    })
    byMac.set(mac, name)
  }
  nodes.sort((a, b) => Number(b.main) - Number(a.main) || a.name.localeCompare(b.name))
  return { nodes, byMac, main: nodes.find(x => x.main)?.name ?? null, mainAlias, mainModels, aliasByMac }
}

/** Every id the firmware reports for the model (productid, odmpid, model), plus the mesh list's for this unit. */
export function modelIdsOf(n: Record<string, unknown>, extra: string[] = []): string[] {
  return [...new Set([n.productid, n.odmpid, n.model, ...extra].map(v => str(v, 40)).filter((v): v is string => !!v))]
}

/** The unit's own MACs, upper case, for matching it in a mesh main's list. */
export function ownMacsOf(n: Record<string, unknown>): string[] {
  return ['lan_hwaddr', 'et0macaddr', 'wl0_hwaddr'].map(k => String(n[k] ?? '').toUpperCase()).filter(v => MAC_RE.test(v))
}

/**
 * The unit's own name, in order: its AiMesh location (cfg_alias, or its own entry in the mesh list), then
 * computer_name, then lan_hostname. A name that is only the model, or looks like an address, is no name.
 */
export function unitNameOf(n: Record<string, unknown>, meshMain: string | null, model: string | string[] | null): string | null {
  const flat = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '')
  const ids = [...(Array.isArray(model) ? model : model ? [model] : []), ...modelIdsOf(n)].map(flat)
  for (const v of [n.cfg_alias, meshMain, n.computer_name, n.lan_hostname]) {
    const s = str(v, 40)
    if (!s || addressLike(s)) continue
    if (ids.includes(flat(s))) continue
    return s
  }
  return null
}

// ── counters and rates ───────────────────────────────────────────────────────

export interface CounterSample { at: number; rx: bigint | null; tx: bigint | null; cpuUsed: number | null; cpuTotal: number | null; cores: number | null }

/** The INTERNET counters and the summed CPU counters from one answer. */
export function sampleOf(answer: Record<string, any> | null, at: number): CounterSample {
  const nd = answer?.netdev ?? {}
  const cpu = answer?.cpu_usage ?? {}
  let used = 0, total = 0, cores = 0
  for (let i = 1; i <= 64; i++) {
    const t = int(cpu[`cpu${i}_total`]), u = int(cpu[`cpu${i}_usage`])
    if (t === null || u === null) break
    total += t; used += u; cores++
  }
  return {
    at, rx: counter(nd.INTERNET_rx), tx: counter(nd.INTERNET_tx),
    cpuUsed: cores ? used : null, cpuTotal: cores ? total : null, cores: cores || null,
  }
}

/**
 * Bits per second and CPU percent between two samples. Null where it cannot be said honestly: no earlier sample,
 * one too close or too old to mean "now", or a counter that went backwards (a reboot, or a 32-bit counter wrapping).
 */
export function ratesFrom(prev: CounterSample | null, cur: CounterSample): { downBps: number | null; upBps: number | null; cpuPct: number | null } {
  const none = { downBps: null, upBps: null, cpuPct: null }
  if (!prev) return none
  const dt = (cur.at - prev.at) / 1000
  if (!(dt >= 0.5) || dt > 300) return none
  const rate = (a: bigint | null, b: bigint | null) => (a === null || b === null || b < a ? null : Math.round(Number(b - a) * 8 / dt))
  let cpuPct: number | null = null
  if (prev.cpuUsed !== null && prev.cpuTotal !== null && cur.cpuUsed !== null && cur.cpuTotal !== null && cur.cores === prev.cores) {
    const du = cur.cpuUsed - prev.cpuUsed, dtot = cur.cpuTotal - prev.cpuTotal
    if (dtot > 0 && du >= 0) cpuPct = Math.min(100, Math.round((du / dtot) * 1000) / 10)
  }
  return { downBps: rate(prev.rx, cur.rx), upBps: rate(prev.tx, cur.tx), cpuPct }
}

// ── health ───────────────────────────────────────────────────────────────────

export const CPU_HIGH_PCT = 90
/** Asuswrt keeps most of its memory in use as cache, so "high" sits well above where a PC would worry. */
export const MEM_HIGH_PCT = 92

export function healthOf(r: Pick<AsusReading, 'wan' | 'cpuPct' | 'mem' | 'update'> & { mode?: AsusMode }): AsusReading['health'] {
  const reasons: string[] = []
  // Only a router has a WAN of its own. An access point, repeater, bridge or mesh node reports its unused WAN
  // as "Disconnected", which is normal, never an alarm.
  const routes = !r.mode || r.mode.kind === null || r.mode.kind === 'router'
  if (routes && r.wan.up === false) reasons.push(`The internet connection is down${r.wan.status ? ` (${r.wan.status})` : ''}.`)
  if (r.cpuPct !== null && r.cpuPct >= CPU_HIGH_PCT) reasons.push(`CPU is at ${Math.round(r.cpuPct)}%.`)
  if (r.mem && r.mem.pct >= MEM_HIGH_PCT) reasons.push(`Memory is at ${r.mem.pct}%.`)
  if (r.update.available) reasons.push(`A firmware update is available${r.update.version ? ` (${r.update.version})` : ''}.`)
  return { level: reasons.length ? 'attention' : 'good', reasons }
}

// ── the reading ──────────────────────────────────────────────────────────────

export interface RawAnswers {
  system:   string | null
  wan:      string | null
  clients:  string | null
  channels: string | null
  /** HOOKS.mode. Optional so an answer set from before it existed still builds a reading. */
  mode?:    string | null
  /** HOOKS.meshNodes and HOOKS.meshClients, when the unit leads a mesh. */
  meshNodes?:   string | null
  meshClients?: string | null
}

export function uptimeSeconds(v: unknown): number | null {
  const m = /\((\d{1,10})\s*secs? since boot\)/i.exec(String(v ?? ''))
  return m ? Number(m[1]) : null
}

/** One reading from the answers. `prev` is the last counter sample (from this or an earlier reading), `cur` this one's. */
export function buildReading(raw: RawAnswers, o: { instanceId: string; prev: CounterSample | null; cur: CounterSample; now?: Date }): AsusReading {
  const missing: string[] = []
  const sysJson = looseJson(raw.system)
  // Not valid JSON as a whole: keep every flat value that does parse (firmware, radios), and say so.
  const sys: Record<string, any> | null = sysJson ?? loosePairs(raw.system)
  if (!sysJson) missing.push('system')
  const n: Record<string, unknown> = sys ?? {}
  const modeAnswer = looseJson(raw.mode) ?? loosePairs(raw.mode)
  const mode = modeOf(modeAnswer ?? (n.sw_mode !== undefined ? n : null))
  const routes = mode.kind === null || mode.kind === 'router'

  const firmware = firmwareOf(n)
  const update = updateOf(n, firmware.flavour)

  const memRaw = (sys?.memory_usage ?? {}) as Record<string, unknown>
  const total = int(memRaw.mem_total), free = int(memRaw.mem_free)
  let used = int(memRaw.mem_used)
  if (used === null && total !== null && free !== null) used = total - free
  const mem = total && used !== null && total > 0 ? { totalKiB: total, usedKiB: used, pct: Math.round((used / total) * 100) } : null

  const wl = parseWanlink(raw.wan)
  if (!wl) missing.push('wan')
  const link = str(n.link_internet, 2)
  const wanUp = wl?.status !== undefined && wl.status !== '' ? wl.status === '1' : link === '2' ? true : link === '1' || link === '0' ? false : null
  const unit = int(sys?.get_wan_unit)
  // The INTERNET counters only mean the internet on a router; elsewhere they count an unused port.
  const rates = routes ? ratesFrom(o.prev, o.cur) : { ...ratesFrom(o.prev, o.cur), downBps: null, upBps: null }
  const ipOk = (v?: string) => (v && v !== '0.0.0.0' && (IPV4_RE.test(v) || v.includes(':')) ? v.slice(0, 45) : null)
  const wan: AsusReading['wan'] = routes ? {
    up: wanUp, status: str(wl?.statusstr, 40), type: str(wl?.type, 20),
    ip: ipOk(wl?.ipaddr), gateway: ipOk(wl?.gateway), unit,
    downBps: rates.downBps, upBps: rates.upBps,
  } : { up: null, status: null, type: null, ip: null, gateway: null, unit: null, downBps: null, upBps: null }
  if (!wl && !routes) missing.splice(missing.indexOf('wan'), 1)
  const uplink = routes ? null : { gateway: ipOk(str((modeAnswer ?? n).lan_gateway, 45) ?? undefined) }

  const chJson = looseJson(raw.channels)
  const radio = bandsOf(n, controlChannels(chJson?.wl_control_channel))
  const cl = looseJson(raw.clients)
  if (!cl) missing.push('clients')
  const list = cl?.get_clientlist ?? cl?.get_clientlist_from_json_database ?? null
  const meshAnswer = looseJson(raw.meshNodes)
  const mesh = parseMesh(meshAnswer?.get_cfg_clientlist, looseJson(raw.meshClients)?.get_allclientlist, o.instanceId)
  const { online, offline } = parseClients(list, o.instanceId, radio, mesh.byMac, mesh.main)
  const bands: AsusBand[] = radio.map(b => ({ ...b, clients: online.filter(d => d.band === b.label).length }))

  const model = str(n.odmpid, 40) ?? str(n.productid, 40)
  const base = { wan, cpuPct: rates.cpuPct, mem, update, mode }
  return {
    fetchedAt: (o.now ?? new Date()).toISOString(),
    unitName: unitNameOf(n, mesh.mainAlias, mesh.mainModels),
    mode, uplink,
    model, firmware, update,
    uptimeSec: uptimeSeconds(sys?.uptime),
    cpuPct: rates.cpuPct, cpuCores: o.cur.cores,
    mem, wan, bands, mesh: mesh.nodes, devices: online, offlineKnown: offline,
    health: healthOf(base),
    missing,
  }
}

// ── what each role sees ──────────────────────────────────────────────────────

/**
 * Below operator: no MAC addresses, no client addresses, and not the WAN address or gateway. Device names,
 * connection type, signal and online time stay: they are what a household reads the page for.
 */
export function viewerReading(r: AsusReading): AsusReading {
  return {
    ...r,
    wan: { ...r.wan, ip: null, gateway: null },
    uplink: r.uplink ? { gateway: null } : null,
    mesh: r.mesh.map(m => ({ ...m, ip: null, name: addressLike(m.name) ? 'AiMesh node' : m.name })),
    devices: r.devices.map(d => ({ ...d, name: addressLike(d.name) ? 'Unnamed device' : d.name, ...(d.node !== undefined ? { node: d.node && addressLike(d.node) ? 'AiMesh node' : d.node } : {}), vendor: d.vendor && addressLike(d.vendor) ? null : d.vendor, ip: null, mac: null })),
  }
}

/**
 * A device "name" that is really an address: Asuswrt falls back to the MAC or the IP for a device with no
 * hostname, and a viewer must not get one back that way. MACs with any separator (or none), IPv4, and anything
 * IPv6-shaped.
 */
export function addressLike(name: string): boolean {
  const s = name.trim()
  if (/^[0-9a-f]{2}([:\-. ]?[0-9a-f]{2}){5}$/i.test(s)) return true
  if (/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(s)) return true
  if (/\b\d{1,3}(\.\d{1,3}){3}\b/.test(s)) return true
  if (/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i.test(s)) return true
  if (/^[0-9a-f:]+$/i.test(s) && s.includes('::')) return true
  if ((s.match(/:/g) ?? []).length >= 2 && /^[0-9a-f:.%]+$/i.test(s)) return true
  return false
}
