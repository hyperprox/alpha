// =============================================================================
//  HyperProx — Plug-in host
//
//  Plug-ins never see a credential. They declare, in their manifest, which
//  settings they need and how those settings authenticate an HTTP call; the
//  host resolves them, makes the request, and hands back only the response.
//
//  That boundary is the whole design. This process holds the Proxmox token,
//  the NPM and DNS logins, and an SSH key with root on every container — and
//  HyperProx is an AGPL project people install third-party plug-ins into. A
//  plug-in that could `import { getCredential }` would be a plug-in that could
//  read all of it.
// =============================================================================

import { getCredential, setCredential, listCredentialKeys } from './credentials'

export const PLUGIN_CATEGORY = 'plugin'

export interface PluginSetting {
  key:      string
  label:    string
  /** `secret` values are encrypted and never returned to the browser. */
  type:     'text' | 'secret' | 'url'
  required: boolean
  hint?:    string
}

/** How the host authenticates this plug-in's HTTP calls on its behalf. */
export type PluginAuth =
  | { kind: 'header'; header: string; fromSetting: string; prefix?: string }
  | { kind: 'basic';  userSetting: string; passSetting: string }
  | { kind: 'query';  param: string;  fromSetting: string }
  | { kind: 'none' }

export interface PluginManifest {
  id:          string
  name:        string
  description: string
  /** `tile` renders in a pane; `device` teaches HyperProx to talk to something. */
  kind:        'tile' | 'device'
  /** Emoji or short label shown on the gallery card. */
  icon:        string
  settings:    PluginSetting[]
  /** Setting holding the base URL every request is resolved against. */
  baseUrlSetting: string
  auth:        PluginAuth
  /** Ignore TLS errors — routers and media servers routinely use self-signed certs. */
  insecureTLS?: boolean
}

export interface PluginContext {
  /** Perform an authenticated request. The plug-in never learns the credential. */
  get(path: string): Promise<any>
  /**
   * Some read-only facts are only available through a POST — RouterOS exposes
   * live interface throughput as `monitor-traffic`, a command, not a resource.
   * Still brokered: the plug-in supplies a path and a body, never a credential.
   */
  post(path: string, body: Record<string, unknown>): Promise<any>
  /**
   * Read one of the plug-in's own NON-SECRET settings — a WAN interface name,
   * a threshold. Settings declared `secret` are never returned here: those exist
   * only to authenticate a brokered call, and a plug-in has no business holding
   * one.
   */
  option(key: string): string | undefined
}

export interface Plugin {
  manifest: PluginManifest
  /** Shape the device's response into something a tile can render. */
  load(ctx: PluginContext): Promise<PluginTileData>
  /**
   * The full view. A tile answers "is anything happening"; this answers
   * "show me everything" — the whole device list, the whole session list, the
   * history. Optional, but a plug-in without one is a dead end on screen.
   */
  detail?(ctx: PluginContext): Promise<PluginDetail>
  /**
   * Numbers worth keeping. A tile shows now; Prometheus shows the shape of the
   * week — was the link saturated at 3am, does transcoding pile up on Sundays.
   * Deliberately separate from load(): tile text is for reading, and parsing
   * numbers back out of prose is how a metric quietly becomes wrong.
   */
  metrics?(ctx: PluginContext): Promise<PluginMetric[]>
}

export interface PluginMetric {
  /** Suffix only — exported as hyperprox_plugin_<name>. */
  name:    string
  help:    string
  type:    'gauge' | 'counter'
  value:   number
  labels?: Record<string, string>
}

/** A table of real rows — the thing a summary tile cannot be. */
export interface PluginTable {
  title:    string
  /** Column labels; `align: 'right'` suits counts and rates. */
  columns:  Array<{ key: string; label: string; align?: 'left' | 'right' }>
  rows:     Array<Record<string, string | number>>
  /** Shown when there are no rows, in the plug-in's own words. */
  empty?:   string
}

export interface PluginDetail {
  /** Big figures across the top. */
  stats?:  Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }>
  tables:  PluginTable[]
}

export interface PluginTileData {
  /** Headline value, e.g. "2 watching". */
  headline: string
  /** Optional supporting rows, rendered as label/value pairs. */
  rows?: Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }>
  /** Overall state, so a card can show health at a glance. */
  tone?: 'good' | 'warn' | 'bad'
}

// ---------------------------------------------------------------------------
//  Settings storage — one credential row per setting, so `secret` values get
//  the same AES-256-GCM treatment as every other credential.
// ---------------------------------------------------------------------------

export async function getSettings(pluginId: string): Promise<Record<string, string>> {
  const keys = await listCredentialKeys(PLUGIN_CATEGORY, pluginId)
  const out: Record<string, string> = {}
  for (const { key } of keys) {
    const v = await getCredential(PLUGIN_CATEGORY, pluginId, key)
    if (v !== null) out[key] = v
  }
  return out
}

export async function saveSettings(
  manifest: PluginManifest,
  values: Record<string, string>,
): Promise<void> {
  for (const setting of manifest.settings) {
    const v = values[setting.key]
    // An empty secret means "leave what is already stored" — otherwise every
    // save through a form that masks secrets would blank them.
    if (v === undefined || (setting.type === 'secret' && v === '')) continue
    await setCredential(PLUGIN_CATEGORY, manifest.id, setting.key, v, setting.type === 'secret')
  }
}

/** Settings for the UI: secrets are reported as set or unset, never returned. */
export async function describeSettings(manifest: PluginManifest) {
  const stored = await getSettings(manifest.id)
  return manifest.settings.map(s => ({
    ...s,
    value: s.type === 'secret' ? '' : (stored[s.key] ?? ''),
    isSet: Boolean(stored[s.key]),
  }))
}

export function missingSettings(manifest: PluginManifest, stored: Record<string, string>): string[] {
  return manifest.settings.filter(s => s.required && !stored[s.key]).map(s => s.label)
}

// ---------------------------------------------------------------------------
//  The broker
// ---------------------------------------------------------------------------

class BrokerContext implements PluginContext {
  constructor(
    private manifest: PluginManifest,
    private settings: Record<string, string>,
  ) {}

  option(key: string): string | undefined {
    const declared = this.manifest.settings.find(s => s.key === key)
    if (!declared || declared.type === 'secret') return undefined
    return this.settings[key] || undefined
  }

  get(path: string)  { return this.request('GET', path) }
  post(path: string, body: Record<string, unknown>) { return this.request('POST', path, body) }

  private async request(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<any> {
    const base = (this.settings[this.manifest.baseUrlSetting] ?? '').replace(/\/+$/, '')
    if (!base) throw new Error(`${this.manifest.name} has no base URL configured`)

    const url = new URL(base + (path.startsWith('/') ? path : `/${path}`))
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body) headers['Content-Type'] = 'application/json'
    const auth = this.manifest.auth

    if (auth.kind === 'header') {
      const v = this.settings[auth.fromSetting]
      if (!v) throw new Error(`${this.manifest.name} is missing its credential`)
      headers[auth.header] = (auth.prefix ?? '') + v
    } else if (auth.kind === 'basic') {
      const u = this.settings[auth.userSetting]
      const p = this.settings[auth.passSetting]
      if (!u || !p) throw new Error(`${this.manifest.name} is missing its credential`)
      headers.Authorization = 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64')
    } else if (auth.kind === 'query') {
      const v = this.settings[auth.fromSetting]
      if (!v) throw new Error(`${this.manifest.name} is missing its credential`)
      url.searchParams.set(auth.param, v)
    }

    // Routers and media servers ship self-signed certs. A plug-in cannot turn
    // this on for itself — only its manifest can, and only for its own host.
    const res = await fetchWithTimeout(url.toString(), headers, this.manifest.insecureTLS, method, body)
    if (!res.ok) throw new Error(`${this.manifest.name} returned HTTP ${res.status}`)

    const text = await res.text()
    try { return JSON.parse(text) }
    catch { throw new Error(`${this.manifest.name} did not return JSON`) }
  }
}

/**
 * One request, with a timeout, and an escape hatch for self-signed TLS.
 *
 * Uses node:https directly for the insecure case rather than pulling in a
 * dispatcher library — and never touches NODE_TLS_REJECT_UNAUTHORIZED, which
 * would disable verification for the whole process, including the Proxmox and
 * NPM clients.
 */
function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  insecure?: boolean,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> {
  const payload = body ? JSON.stringify(body) : undefined

  if (!insecure || !url.startsWith('https:')) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    return fetch(url, { method, headers, body: payload, signal: controller.signal })
      .finally(() => clearTimeout(timer)) as any
  }

  return new Promise((resolve, reject) => {
    import('node:https').then(https => {
      const req = https.request(url, { method, headers, rejectUnauthorized: false, timeout: 8000 }, res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', c => { body += c })
        res.on('end', () => resolve({
          ok:     (res.statusCode ?? 500) < 400,
          status: res.statusCode ?? 500,
          text:   async () => body,
        }))
      })
      req.on('timeout', () => { req.destroy(new Error('timed out after 8s')) })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    }).catch(reject)
  })
}

async function contextFor(plugin: Plugin): Promise<BrokerContext> {
  const settings = await getSettings(plugin.manifest.id)
  const missing  = missingSettings(plugin.manifest, settings)
  if (missing.length) {
    throw new Error(`Not configured yet — ${missing.join(' and ')} still needed.`)
  }
  return new BrokerContext(plugin.manifest, settings)
}

/** Run a plug-in. Returns its tile data, or throws with a readable reason. */
export async function runPlugin(plugin: Plugin): Promise<PluginTileData> {
  return plugin.load(await contextFor(plugin))
}

export async function runPluginDetail(plugin: Plugin): Promise<PluginDetail> {
  if (!plugin.detail) throw new Error(`${plugin.manifest.name} has no detailed view.`)
  return plugin.detail(await contextFor(plugin))
}

export async function runPluginMetrics(plugin: Plugin): Promise<PluginMetric[]> {
  if (!plugin.metrics) return []
  return plugin.metrics(await contextFor(plugin))
}

/** Prometheus text exposition. Escaping matters: device names contain anything. */
export function renderExposition(
  samples: Array<{ plugin: string; metric: PluginMetric }>,
  up: Record<string, boolean>,
): string {
  const lines: string[] = []
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')

  lines.push('# HELP hyperprox_plugin_up Whether the plug-in answered its device on the last scrape.')
  lines.push('# TYPE hyperprox_plugin_up gauge')
  for (const [id, ok] of Object.entries(up)) {
    lines.push(`hyperprox_plugin_up{plugin="${esc(id)}"} ${ok ? 1 : 0}`)
  }

  // One HELP/TYPE per metric name, then every series under it — Prometheus
  // rejects a repeated TYPE for the same name.
  const byName = new Map<string, Array<{ plugin: string; metric: PluginMetric }>>()
  for (const s of samples) {
    const key = `hyperprox_plugin_${s.metric.name}`
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key)!.push(s)
  }

  for (const [name, group] of byName) {
    lines.push(`# HELP ${name} ${esc(group[0].metric.help)}`)
    lines.push(`# TYPE ${name} ${group[0].metric.type}`)
    for (const { plugin, metric } of group) {
      const labels = { plugin, ...(metric.labels ?? {}) }
      const rendered = Object.entries(labels)
        .map(([k, v]) => `${k}="${esc(String(v))}"`)
        .join(',')
      lines.push(`${name}{${rendered}} ${Number.isFinite(metric.value) ? metric.value : 0}`)
    }
  }

  return lines.join('\n') + '\n'
}
