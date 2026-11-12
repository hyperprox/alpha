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
import type { PluginVisual } from './plugin-visual-types'

export const PLUGIN_CATEGORY = 'plugin'

export interface PluginSetting {
  key:      string
  label:    string
  /** `secret` values are encrypted and never returned to the browser. `toggle` stores "yes" or "no". */
  type:     'text' | 'secret' | 'url' | 'toggle'
  required: boolean
  hint?:    string
  /** A heading the settings form shows above this setting and the ones after it. */
  section?: string
}

/** How the host authenticates this plug-in's HTTP calls on its behalf. */
export type PluginAuth =
  | { kind: 'header'; header: string; fromSetting: string; prefix?: string }
  | { kind: 'basic';  userSetting: string; passSetting: string }
  | { kind: 'query';  param: string;  fromSetting: string }
  | { kind: 'none' }

/**
 * One reachable thing, with its own address and its own credential.
 *
 * Several plug-ins legitimately talk to more than one box — the arr stack is
 * Sonarr and Radarr with different API keys, Unmanic is one worker per node.
 * Declaring them here keeps the credential with the endpoint, so a plug-in can
 * never send Sonarr's key to Radarr, let alone anywhere else.
 */
export interface PluginEndpoint {
  key:            string
  label:          string
  baseUrlSetting: string
  auth:           PluginAuth
  insecureTLS?:   boolean
}

/**
 * A device this plug-in can reach that also takes an interactive login.
 *
 * The address is not repeated here: it is the host in the plug-in's own base
 * URL, so a router configured once is reachable in the terminal without being
 * typed in twice and without the two drifting apart. Credentials deliberately
 * are not shared — a plug-in is told to use a read-only account, and reusing
 * that for a shell would either fail or quietly hand a browser more than the
 * plug-in was given.
 */
export interface PluginConsole {
  defaultPort: number
  label?:      string
  hint?:       string
  /** Most appliances have no tmux, and probing for one wastes a round trip. */
  tmux?:       boolean
}

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
  /**
   * Set up when any one of these groups of settings is complete, rather than when every `required` setting is:
   * Plex works with its own server, or (as installs from before did) with Tautulli alone.
   */
  requiredAny?: string[][]
  /** Additional endpoints beyond the default one above. */
  endpoints?:  PluginEndpoint[]
  /** Ignore TLS errors — routers and media servers routinely use self-signed certs. */
  insecureTLS?: boolean
  /**
   * How often the detail page may re-read this plug-in, in seconds.
   *
   * Opt-in, and declared HERE rather than chosen by the page, because only the
   * plug-in knows what a refresh costs the device it talks to. A router answers
   * a dozen endpoints per detail call, one of them a full connection table; a
   * backup server might walk a datastore. Left unset, the page does not poll at
   * all and the reader refreshes by hand — which is the right default for
   * anything whose answer changes hourly.
   */
  refreshSeconds?: number
  /** Declared when the device also takes an interactive login. */
  consoleAccess?: PluginConsole
  /**
   * The broker must never send this plug-in's credential itself: a core module registers the only transport
   * (setPluginTransport), which applies that device's own address checks and certificate pin. With none
   * registered, every call fails closed. Its address and credential settings cannot be saved through
   * saveSettings either; the core module owns them.
   */
  coreTransport?: boolean
}

/** A core module's checked transport for a coreTransport plug-in. Read-only GETs are all a plug-in gets. */
export type PluginTransport = (method: 'GET' | 'POST', path: string, timeoutMs?: number) => Promise<any>
const transports = new Map<string, PluginTransport>()
export function setPluginTransport(pluginId: string, t: PluginTransport | null): void {
  if (t) transports.set(pluginId, t); else transports.delete(pluginId)
}

export interface PluginContext {
  /** Perform an authenticated request. The plug-in never learns the credential. */
  get(path: string, opts?: { timeoutMs?: number }): Promise<any>
  /**
   * Some read-only facts are only available through a POST — RouterOS exposes
   * live interface throughput as `monitor-traffic`, a command, not a resource.
   * Still brokered: the plug-in supplies a path and a body, never a credential.
   */
  post(path: string, body: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<any>
  /**
   * Read one of the plug-in's own NON-SECRET settings — a WAN interface name,
   * a threshold. Settings declared `secret` are never returned here: those exist
   * only to authenticate a brokered call, and a plug-in has no business holding
   * one.
   */
  option(key: string): string | undefined
  /**
   * Switch to one of this plug-in's other declared endpoints. The plug-in names
   * an endpoint from its own manifest — it cannot supply an address, so a
   * credential can only ever go where its manifest already says it goes.
   */
  from(endpointKey: string): PluginContext
  /** True when that endpoint has an address configured. */
  has(endpointKey: string): boolean
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
  /**
   * Downloads that arrived intact and cannot be filed.
   *
   * Distinct from anything automation will retry: these are finished, correct
   * files sitting on disk that the library refuses because it cannot read the
   * season and episode out of the filename. No amount of waiting fixes one.
   */
  rescueScan?(ctx: PluginContext): Promise<PluginStuckImport[]>
  /** Act on one of them, by the id rescueScan reported. */
  rescueRun?(ctx: PluginContext, id: string): Promise<string>
  /**
   * Live throughput on the links this plug-in can see.
   *
   * Separate from metrics() because the two answer different questions on
   * different clocks: metrics() is scraped on Prometheus's schedule and kept,
   * this is read now and thrown away. A dashboard asking "what is the network
   * doing" cannot wait for the next scrape interval, and does not want a
   * fifteen-second-old number.
   */
  bandwidth?(ctx: PluginContext): Promise<PluginLink[]>
  /**
   * Apps this plug-in knows how to find and update inside guests: things
   * installed with npm under a home directory, a tarball in /opt, anything apt
   * and docker cannot see. See AppUpdateProvider. The Updates feature asks
   * every provider of every bundled plug-in.
   */
  appUpdates?: AppUpdateProvider[]
  /**
   * A few lines a person (or the AI page) can read to learn the current state: "Outside light: on".
   * Read-only, through the same brokered context as load(). Never include a secret, token, password,
   * webhook URL or log text; keep it to what answers "what is the state of this right now".
   * Optional: a plug-in without one is listed to the AI page but cannot be asked about.
   */
  summary?(ctx: PluginContext): Promise<{ title: string; lines: string[] }>
}

// ---------------------------------------------------------------------------
//  App-update providers
//
//  The one place a plug-in is given more than a brokered HTTP call. A provider
//  runs shell scripts as ROOT inside the guest the host hands it — it has to,
//  to stop a service and install a package — so a provider is trusted the way
//  HyperProx itself is trusted, and only bundled plug-ins are asked for one.
//
//  What the boundary still holds:
//    - the host chooses the guest; a provider cannot name another one, and
//      cannot reach a node shell, the Proxmox API or the credential store;
//    - settings arrive through option(), which never returns a secret;
//    - the provider never decides WHEN it runs: the Updates planner does, from
//      the policy and a person's approval, with a snapshot taken first;
//    - a config change is a separate fix with its own approval id, so an
//      update can never edit configuration as a side effect.
//
//  Everything a guest returns is untrusted text: a provider must validate
//  versions, names and paths before they go back into a script, and quote them.
// ---------------------------------------------------------------------------

export interface AppGuestRef { vmid: number; name: string; node: string; type: 'lxc' | 'qemu' }

/** One installation a provider found. */
export interface AppInstall {
  /** Stable id of this install within the guest (the same directory gives the same key). */
  key:       string
  name:      string
  installed: string
  location:  string
  /** The user that owns the install; package commands run as this user, never as root unless it is root. */
  runAs:     string
  /** The systemd unit that runs it. Without one a provider must refuse to update: it cannot be stopped first. */
  service:   string | null
  running:   boolean
  how:       string
  /** The provider's own facts, carried from detect() to its other calls. */
  facts:     Record<string, unknown>
}

export interface AppReleaseNote { version: string; url?: string; text: string }

export interface AppRelease {
  /** Newest stable version, or null when it could not be read. */
  latest:        string | null
  /** Notes for the versions after the installed one, newest first. */
  notes:         AppReleaseNote[]
  isSecurity:    boolean
  securityNote?: string
}

/** A configuration change, shown to a person word for word and applied only when approved by `id`. */
export interface AppFix { id: string; description: string; file: string; change: string }

export interface AppIssue {
  message:  string
  /** Blocking: the update is not planned until this is resolved, by hand or by approving `fix`. */
  blocking: boolean
  fix?:     AppFix
}

export interface AppStepResult { ok: boolean; message: string; output?: string }

export interface AppHttpResult { status: number; headers: Record<string, string>; body: string }

export interface AppWsProbe {
  /** The server answered 101 Switching Protocols. */
  upgraded:     boolean
  status:       number
  /** The first text frame, or a close frame's reason. */
  firstMessage: string | null
  error?:       string
}

/** What the host hands a provider for one guest. */
export interface AppContext {
  guest: AppGuestRef
  /** Run a script as root inside THIS guest. The script travels on stdin, never on a command line. */
  run(script: string, opts?: { timeoutMs?: number }): Promise<{ code: number; output: string; timedOut: boolean }>
  /** One of the plug-in's own non-secret settings. */
  option(key: string): string | undefined
  /** Public release metadata (the npm registry, the GitHub API): https only, cached, JSON. A body makes it a POST. */
  fetchJson(url: string, body?: unknown): Promise<any>
  /** A request from HyperProx itself — used to load a public URL the way a browser would. */
  http(url: string, opts?: { headers?: Record<string, string>; timeoutMs?: number; insecureTLS?: boolean }): Promise<AppHttpResult>
  /** Open a websocket from HyperProx, read the first message, and close it. */
  wsProbe(url: string, opts?: { origin?: string; timeoutMs?: number; insecureTLS?: boolean }): Promise<AppWsProbe>
  /** Public URLs of the proxy hosts HyperProx manages that forward to this guest (on one of `ports`, when given). */
  proxiedUrls(ports?: number[]): Promise<string[]>
  log(line: string): void
  now(): number
  sleep(ms: number): Promise<void>
}

export interface AppUpdateProvider {
  /** Unique across plug-ins; the policy names apps by it (`apps.<id>`). */
  id:   string
  name: string
  /** Read-only: every install of this app in the guest. */
  detect(ctx: AppContext): Promise<AppInstall[]>
  /** The newest version, release notes since `install.installed`, and whether it is a security update. */
  latest(install: AppInstall, ctx: AppContext): Promise<AppRelease>
  /** Read-only: what would go wrong updating to `target` (null: nothing to update, check the install as it is). */
  preflight(install: AppInstall, target: string | null, ctx: AppContext): Promise<AppIssue[]>
  /** Read-only: state verify() compares against (a log's size, say). Taken just before apply(). */
  baseline?(install: AppInstall, ctx: AppContext): Promise<unknown>
  /** Install exactly `version`. Must stop the service before changing anything and start it after. */
  apply(install: AppInstall, version: string, ctx: AppContext): Promise<AppStepResult>
  /** A real functional check, not a health endpoint that answers "ok" regardless. */
  verify(install: AppInstall, version: string, ctx: AppContext, baseline: unknown): Promise<AppStepResult>
  /** Apply the fix whose id is `fixId`, recomputed now; refuse when it no longer matches. */
  applyFix?(install: AppInstall, fixId: string, ctx: AppContext): Promise<AppStepResult>
  /** How to undo an update, in words a person can follow. */
  rollback(install: AppInstall, snapshot: string | null): string
}

export interface RegisteredAppProvider { pluginId: string; provider: AppUpdateProvider }

/** Every provider of these plug-ins. Two providers with one id would make the policy ambiguous: refused. */
export function appUpdateProviders(plugins: Plugin[]): RegisteredAppProvider[] {
  const out: RegisteredAppProvider[] = []
  for (const p of plugins) {
    for (const provider of p.appUpdates ?? []) {
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(provider.id)) throw new Error(`${p.manifest.name}: app provider id "${provider.id}" is not a plain lowercase id`)
      if (out.some(o => o.provider.id === provider.id)) throw new Error(`two plug-ins declare an app provider "${provider.id}"`)
      out.push({ pluginId: p.manifest.id, provider })
    }
  }
  return out
}

/** A plug-in's settings as option() may return them: declared, and not secret. */
export function pluginOptions(manifest: PluginManifest, stored: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of manifest.settings) if (s.type !== 'secret' && stored[s.key]) out[s.key] = stored[s.key]
  return out
}

/**
 * One link, as a meter can render it.
 *
 * Rates are bits per second, because that is what every network device and
 * every ISP quotes, and converting to bytes at the edge is how a 500 Mbps plan
 * starts reading as 62.5.
 *
 * `capacityBps` is what the link is *for*, not what the port negotiated: a
 * gigabit port on a 500/50 plan is a 500/50 link, and only the person paying
 * the bill knows that. Left undefined, the meter scales to what it has seen
 * and says so rather than inventing a denominator.
 */
export interface PluginLink {
  id:            string
  label:         string
  kind:          'wan' | 'lan'
  downBps:       number
  upBps:         number
  downCapacityBps?: number
  upCapacityBps?:   number
}

/**
 * A download that is complete and unfilable, with an honest count of how much
 * of it can be recovered automatically.
 *
 * `mappable` and `unmappable` are reported separately and deliberately: a
 * rescue that silently files 90 of 94 episodes is worse than one that says so,
 * because the four it skipped look identical to episodes that were never in the
 * release.
 */
export interface PluginStuckImport {
  id:         string
  title:      string
  series:     string
  path:       string
  reason:     string
  files:      number
  mappable:   number
  unmappable: string[]
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
  /**
   * How many rows exist in total, when `rows` is deliberately a subset. Without
   * it a truncated table silently contradicts the stat above it — 231 in the
   * queue, 41 in the table, and nothing saying why.
   */
  total?:   number
  /** Shown when there are no rows, in the plug-in's own words. */
  empty?:   string
}

export interface PluginDetail {
  /**
   * Big figures across the top.
   *
   * `value` is the figure — short, so every card in the row stays one line and
   * the grid does not go ragged. `hint` is the breakdown underneath it, set in
   * smaller type: the place for "which uplink" or "how many of those", which
   * would otherwise either wrap a card to three lines or need a card of its own.
   */
  stats?:  Array<{ label: string; value: string; hint?: string; tone?: 'good' | 'warn' | 'bad' }>
  tables:  PluginTable[]
  /**
   * The same reading as typed numbers, for the page's gauges and maps, so nothing parses a display string back
   * into a figure. Optional: a page without it shows the tables.
   */
  visual?: PluginVisual
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

export class PluginSettingsError extends Error {
  constructor(message: string) { super(message); this.name = 'PluginSettingsError' }
}

/** The credential settings an endpoint's auth sends. */
function authSecrets(auth: PluginAuth): string[] {
  if (auth.kind === 'header' || auth.kind === 'query') return [auth.fromSetting]
  if (auth.kind === 'basic') return [auth.userSetting, auth.passSetting]
  return []
}

const originOf = (v: string) => { try { const u = new URL(v); return `${u.protocol}//${u.host}`.toLowerCase() } catch { return v.trim().toLowerCase() } }

/**
 * Why this save must be refused, or null. A stored credential goes only to the address it was entered for: when
 * an endpoint's address moves to another host or port, every credential that endpoint sends must be entered
 * again in the same save, rather than carried over to the new address.
 */
export function settingsChangeProblem(manifest: PluginManifest, stored: Record<string, string>, values: Record<string, string>): string | null {
  const endpoints = [{ baseUrlSetting: manifest.baseUrlSetting, auth: manifest.auth, label: manifest.name }, ...(manifest.endpoints ?? [])]
  for (const e of endpoints) {
    const next = values[e.baseUrlSetting]
    const prev = stored[e.baseUrlSetting]
    if (next === undefined || !prev || originOf(next) === originOf(prev)) continue
    const missing = authSecrets(e.auth).filter(k => {
      const def = manifest.settings.find(x => x.key === k)
      return def?.type === 'secret' && !(values[k] ?? '').trim()
    })
    if (missing.length) {
      const labels = missing.map(k => manifest.settings.find(x => x.key === k)?.label ?? k)
      return `${e.label}'s address now points somewhere else, so enter ${labels.join(' and ')} again in the same save.`
    }
  }
  return null
}

export async function saveSettings(
  manifest: PluginManifest,
  values: Record<string, string>,
): Promise<void> {
  if (manifest.coreTransport) {
    const owned = [manifest.baseUrlSetting, ...authSecrets(manifest.auth)]
    const hit = owned.filter(k => values[k] !== undefined && values[k] !== '')
    if (hit.length) throw new PluginSettingsError(`${manifest.name}'s ${hit.join(' and ')} are set on its own page, not here.`)
  }
  const problem = settingsChangeProblem(manifest, await getSettings(manifest.id), values)
  if (problem) throw new PluginSettingsError(problem)
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
  const missing = manifest.settings.filter(s => s.required && !stored[s.key]).map(s => s.label)
  const groups = manifest.requiredAny ?? []
  if (groups.length && !groups.some(g => g.every(k => stored[k]))) {
    // Name what the first (preferred) group still needs.
    for (const k of groups[0]) if (!stored[k]) missing.push(manifest.settings.find(x => x.key === k)?.label ?? k)
  }
  return missing
}

// ---------------------------------------------------------------------------
//  The broker
// ---------------------------------------------------------------------------

/**
 * Makes one endpoint's calls: its address and credential, a timeout, no redirects. Never handed to a plug-in.
 * BrokerContext (what a plug-in gets) keeps one in an ES private field and exposes only get and post; the
 * delete, image and other host-only calls exist only on this class, which is not exported.
 */
class Requester {
  readonly endpoint: PluginEndpoint
  constructor(readonly manifest: PluginManifest, private settings: Record<string, string>, endpointKey?: string) {
    this.endpoint = resolveEndpoint(manifest, endpointKey)
  }

  /** The address and every credential this endpoint sends are set. */
  ready(): boolean {
    if (!(this.settings[this.endpoint.baseUrlSetting] ?? '').trim()) return false
    return authSecrets(this.endpoint.auth).every(k => (this.settings[k] ?? '').trim())
  }

  /** The address and credential for one call. */
  private prepare(path: string, json: boolean): { url: URL; headers: Record<string, string> } {
    const base = (this.settings[this.endpoint.baseUrlSetting] ?? '').replace(/\/+$/, '')
    if (!base) throw new Error(`${this.manifest.name}: no address configured for ${this.endpoint.label}`)

    const url = new URL(base + (path.startsWith('/') ? path : `/${path}`))
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (json) headers['Content-Type'] = 'application/json'
    const auth = this.endpoint.auth

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
    return { url, headers }
  }

  /** An image's bytes (Plex cover art). Must be an image; reading stops as soon as it passes `maxBytes`. */
  async image(path: string, timeoutMs = 10_000, maxBytes = 4 * 1024 * 1024): Promise<{ contentType: string; body: Buffer }> {
    if (this.manifest.coreTransport) throw new Error(`${this.manifest.name} serves no images.`)
    const { url, headers } = this.prepare(path, false)
    headers.Accept = 'image/*'
    const res = await fetchWithTimeout(url.toString(), headers, this.endpoint.insecureTLS, 'GET', undefined, timeoutMs, maxBytes)
    if (!res.ok) throw new Error(`${this.manifest.name} returned HTTP ${res.status}`)
    const contentType = String(res.contentType ?? '').split(';')[0].trim().toLowerCase()
    if (!/^image\/(jpeg|png|webp|gif)$/.test(contentType)) throw new Error(`${this.manifest.name} did not return an image`)
    return { contentType, body: await res.buffer() }
  }

  /** A GET whose answer is not read (Plex's partial library scan answers with an empty body). */
  async trigger(path: string, timeoutMs?: number): Promise<void> {
    if (this.manifest.coreTransport) throw new Error(`${this.manifest.name} takes no triggers.`)
    const { url, headers } = this.prepare(path, false)
    const res = await fetchWithTimeout(url.toString(), headers, this.endpoint.insecureTLS, 'GET', undefined, timeoutMs)
    if (!res.ok) throw new Error(`${this.manifest.name} returned HTTP ${res.status}`)
  }

  async request(
    method: 'GET' | 'POST' | 'DELETE' | 'PUT',
    path: string,
    body?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<any> {
    if (this.manifest.coreTransport) {
      const t = transports.get(this.manifest.id)
      if (!t) throw new Error(`${this.manifest.name} is not connected yet.`)
      if (method === 'DELETE' || method === 'PUT') throw new Error(`${this.manifest.name} takes no ${method === 'PUT' ? 'edits' : 'deletes'}.`)
      return t(method, path, timeoutMs)
    }
    const { url, headers } = this.prepare(path, !!body)

    // Routers and media servers ship self-signed certs. A plug-in cannot turn
    // this on for itself — only its manifest can, and only for its own host.
    const res = await fetchWithTimeout(url.toString(), headers, this.endpoint.insecureTLS, method, body, timeoutMs)
    if (!res.ok) throw new Error(`${this.manifest.name} returned HTTP ${res.status}`)

    const text = await res.text()
    // Sonarr, Radarr and Plex answer a delete (and some edits) with 200 or 202 and no body.
    if ((method === 'DELETE' || method === 'PUT') && !text.trim()) return null
    try { return JSON.parse(text) }
    catch { throw new Error(`${this.manifest.name} did not return JSON`) }
  }
}

/** True when that endpoint has its address and every credential it sends (a half-entered one is not set). */
export function endpointReady(manifest: PluginManifest, settings: Record<string, string>, endpointKey = 'default'): boolean {
  try { return new Requester(manifest, settings, endpointKey).ready() } catch { return false }
}

/** What a plug-in is handed: get and post through its own endpoints, its non-secret options, and nothing else. */
class BrokerContext implements PluginContext {
  readonly #req: Requester
  readonly #manifest: PluginManifest
  readonly #settings: Record<string, string>

  constructor(manifest: PluginManifest, settings: Record<string, string>, endpointKey?: string) {
    this.#manifest = manifest
    this.#settings = settings
    this.#req = new Requester(manifest, settings, endpointKey)
  }

  from(endpointKey: string): PluginContext {
    return new BrokerContext(this.#manifest, this.#settings, endpointKey)
  }

  /** The endpoint has its address AND every credential it sends: a half-entered one is not "set". */
  has(endpointKey: string): boolean {
    return endpointReady(this.#manifest, this.#settings, endpointKey)
  }

  option(key: string): string | undefined {
    const declared = this.#manifest.settings.find(s => s.key === key)
    if (!declared || declared.type === 'secret') return undefined
    return this.#settings[key] || undefined
  }

  get(path: string, opts?: { timeoutMs?: number }) {
    return this.#req.request('GET', path, undefined, opts?.timeoutMs)
  }
  post(path: string, body: Record<string, unknown>, opts?: { timeoutMs?: number }) {
    return this.#req.request('POST', path, body, opts?.timeoutMs)
  }
}

/** A plug-in's device answered with a redirect, which the broker never follows (it would carry the credential). */
export class PluginRedirectError extends Error {
  constructor(readonly status: number) {
    super(`The device answered with a redirect (HTTP ${status}). HyperProx does not follow redirects for a plug-in, so its login is only ever sent to the address in its settings: set that address to the one the device redirects to.`)
    this.name = 'PluginRedirectError'
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
export function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  insecure?: boolean,
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' = 'GET',
  body?: Record<string, unknown>,
  // Eight seconds is right for a tile and far too short for a search that fans
  // out to a dozen indexers, several of them behind FlareSolverr.
  timeoutMs = 8000,
  /** Stop reading (and fail) once the body passes this many bytes. */
  maxBytes?: number,
): Promise<{ ok: boolean; status: number; contentType?: string | null; text: () => Promise<string>; buffer: () => Promise<Buffer> }> {
  const tooBig = () => new Error('The answer is larger than allowed.')
  const payload = body ? JSON.stringify(body) : undefined

  // Never followed: a redirect would carry the plug-in's credential (its headers) to wherever the device, or
  // anyone answering in its place, points. The address in its settings is the only place the credential goes.
  if (!insecure || !url.startsWith('https:')) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    return fetch(url, { method, headers, body: payload, signal: controller.signal, redirect: 'manual' })
      .then(res => {
        if (res.status >= 300 && res.status < 400) throw new PluginRedirectError(res.status)
        return {
          ok: res.ok, status: res.status, contentType: res.headers.get('content-type'),
          text: () => res.text(),
          buffer: async () => {
            if (!maxBytes || !res.body) return Buffer.from(await res.arrayBuffer())
            if (Number(res.headers.get('content-length') ?? 0) > maxBytes) { await res.body.cancel().catch(() => {}); throw tooBig() }
            const reader = res.body.getReader()
            const chunks: Buffer[] = []
            let n = 0
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              n += value.length
              if (n > maxBytes) { await reader.cancel().catch(() => {}); throw tooBig() }
              chunks.push(Buffer.from(value))
            }
            return Buffer.concat(chunks)
          },
        }
      })
      .finally(() => clearTimeout(timer)) as any
  }

  return new Promise((resolve, reject) => {
    import('node:https').then(https => {
      const req = https.request(url, { method, headers, rejectUnauthorized: false, timeout: timeoutMs }, res => {
        const code = res.statusCode ?? 500
        if (code >= 300 && code < 400) { res.resume(); return reject(new PluginRedirectError(code)) }
        const chunks: Buffer[] = []
        let n = 0
        res.on('data', (c: Buffer) => {
          n += c.length
          if (maxBytes && n > maxBytes) { req.destroy(tooBig()); return }
          chunks.push(c)
        })
        res.on('end', () => {
          const all = Buffer.concat(chunks)
          resolve({
            ok:     (res.statusCode ?? 500) < 400,
            status: res.statusCode ?? 500,
            contentType: (res.headers['content-type'] as string | undefined) ?? null,
            text:   async () => all.toString('utf8'),
            buffer: async () => all,
          })
        })
      })
      req.on('timeout', () => { req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)) })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    }).catch(reject)
  })
}

function resolveEndpoint(manifest: PluginManifest, key?: string): PluginEndpoint {
  const primary: PluginEndpoint = {
    key: 'default', label: manifest.name,
    baseUrlSetting: manifest.baseUrlSetting,
    auth: manifest.auth, insecureTLS: manifest.insecureTLS,
  }
  if (!key || key === 'default') return primary
  const found = (manifest.endpoints ?? []).find(e => e.key === key)
  if (!found) throw new Error(`${manifest.name} declares no endpoint "${key}"`)
  return found
}

async function contextFor(plugin: Plugin): Promise<BrokerContext> {
  const settings = await getSettings(plugin.manifest.id)
  const missing  = missingSettings(plugin.manifest, settings)
  if (missing.length) {
    throw new Error(`Not configured yet — ${missing.join(' and ')} still needed.`)
  }
  return new BrokerContext(plugin.manifest, settings)
}

/**
 * A read through a plug-in's own connection, for a core feature that builds on it (the VPN page lists the
 * MikroTik's WireGuard peers this way). GET only, and the plug-in's credential stays inside this module.
 */
export async function pluginRead(plugin: Plugin, path: string, timeoutMs?: number): Promise<any> {
  return (await contextFor(plugin)).get(path, { timeoutMs })
}

/** One endpoint of a plug-in, as a core feature uses it. The credential stays inside this module. */
export interface CoreEndpointClient {
  get(path: string, timeoutMs?: number): Promise<any>
  delete(path: string, timeoutMs?: number): Promise<any>
  /** An image's bytes and type (Plex cover art); refuses anything that is not an image. */
  image(path: string, timeoutMs?: number): Promise<{ contentType: string; body: Buffer }>
  /** A JSON PUT (Sonarr: unmonitor episodes, edit a series). */
  put(path: string, body: unknown, timeoutMs?: number): Promise<any>
  /** A GET whose answer is not read (Plex: scan one folder). */
  trigger(path: string, timeoutMs?: number): Promise<void>
}

/**
 * A core feature building on a plug-in's connection, with delete as well as read (the Plex clear-out removes a
 * show through the Arr Stack's Sonarr). Null when the plug-in is not set up or that endpoint has no address.
 * Never handed to a plug-in: PluginContext stays read-only.
 */
export async function pluginEndpointClient(plugin: Plugin, endpointKey = 'default'): Promise<CoreEndpointClient | null> {
  const settings = await getSettings(plugin.manifest.id).catch(() => null)
  if (!settings || missingSettings(plugin.manifest, settings).length) return null
  let r: Requester
  try { r = new Requester(plugin.manifest, settings, endpointKey) } catch { return null }
  if (!r.ready()) return null
  return {
    get:    (path, timeoutMs) => r.request('GET', path, undefined, timeoutMs),
    delete: (path, timeoutMs) => r.request('DELETE', path, undefined, timeoutMs),
    image:  (path, timeoutMs) => r.image(path, timeoutMs),
    put:    (path, body, timeoutMs) => r.request('PUT', path, body as Record<string, unknown>, timeoutMs),
    trigger: (path, timeoutMs) => r.trigger(path, timeoutMs),
  }
}

/** A plug-in's address and TLS rule (both non-secret), for a write client that brings its own credential. */
export async function pluginAddress(plugin: Plugin): Promise<{ url: string; insecureTLS: boolean } | null> {
  const url = (await getSettings(plugin.manifest.id).catch(() => ({} as Record<string, string>)))[plugin.manifest.baseUrlSetting]
  return url ? { url: url.replace(/\/+$/, ''), insecureTLS: !!plugin.manifest.insecureTLS } : null
}

/** Run a plug-in. Returns its tile data, or throws with a readable reason. */
export async function runPlugin(plugin: Plugin): Promise<PluginTileData> {
  return plugin.load(await contextFor(plugin))
}

export async function runPluginDetail(plugin: Plugin): Promise<PluginDetail> {
  if (!plugin.detail) throw new Error(`${plugin.manifest.name} has no detailed view.`)
  return plugin.detail(await contextFor(plugin))
}

export async function runPluginSummary(plugin: Plugin): Promise<{ title: string; lines: string[] }> {
  if (!plugin.summary) return { title: plugin.manifest.name, lines: [] }
  return plugin.summary(await contextFor(plugin))
}

export async function runPluginMetrics(plugin: Plugin): Promise<PluginMetric[]> {
  if (!plugin.metrics) return []
  return plugin.metrics(await contextFor(plugin))
}

export async function runPluginRescueScan(plugin: Plugin): Promise<PluginStuckImport[]> {
  if (!plugin.rescueScan) return []
  return plugin.rescueScan(await contextFor(plugin))
}

export async function runPluginRescueRun(plugin: Plugin, id: string): Promise<string> {
  if (!plugin.rescueRun) throw new Error(`${plugin.manifest.name} cannot rescue imports.`)
  return plugin.rescueRun(await contextFor(plugin), id)
}

export async function runPluginBandwidth(plugin: Plugin): Promise<PluginLink[]> {
  if (!plugin.bandwidth) return []
  return plugin.bandwidth(await contextFor(plugin))
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
