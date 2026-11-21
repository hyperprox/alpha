// =============================================================================
//  HyperProx — Open WebUI: what the plug-in reads, and what its fix buttons do
//
//  Reads (through the plug-in's own connection, HyperProx's API key): the version, the models available, the Ollama
//  Open WebUI is pointed at and whether it answers, and whether open sign-up is off. Two problems have a fix: an
//  Ollama that does not answer (Reconnect: point Open WebUI at the Ollama HyperProx knows, checked first and read back
//  after) and sign-up left open (Close it). Both are audited before they run. Neither touches a chat or an account.
// =============================================================================

import { stripAddresses } from '../redact-addresses'

export interface OpenWebuiClient {
  get(path: string, timeoutMs?: number): Promise<any>
  post(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<any>
}

export interface ModelView { name: string; sizeBytes: number | null }
/** What the page sees of the Ollama connection: whether there is one and whether it answers. Its address is not sent to the browser. */
export interface OllamaView { enabled: boolean; connected: boolean; answering: boolean | null; error: string | null }
/** The same, with the address, for the problem rules and the fixes (server side only). */
interface OllamaRead extends OllamaView { urls: string[] }
export interface OpenWebuiProblem { id: string; severity: 'bad' | 'warn'; title: string; detail: string; fix: { action: OpenWebuiAction; label: string; confirm: string } | null }
export interface OpenWebuiOverview {
  version: string | null
  models: ModelView[]
  ollama: OllamaView
  signupOpen: boolean | null
  problems: OpenWebuiProblem[]
}

export const ACTIONS = ['reconnect-ollama', 'close-signup'] as const
export type OpenWebuiAction = typeof ACTIONS[number]

const text = (e: any) => stripAddresses(String(e?.message ?? e).replace(/[\u0000-\u001f]/g, ' ')).slice(0, 160)

/** The address as Open WebUI keeps it, with the trailing slash dropped. */
const bare = (u: unknown) => String(u ?? '').replace(/\/+$/, '')

export function problemsOf(o: { ollama: Pick<OllamaRead, 'enabled' | 'urls' | 'answering' | 'error'>; signupOpen: boolean | null }, known: string | null): OpenWebuiProblem[] {
  const out: OpenWebuiProblem[] = []
  if (!o.ollama.enabled || !o.ollama.urls.length) {
    out.push({ id: 'ollama-off', severity: 'warn', title: 'No Ollama is connected', detail: 'Open WebUI has no model server, so there are no models to chat with.',
      fix: known ? { action: 'reconnect-ollama', label: 'Connect the Ollama HyperProx knows', confirm: 'Point Open WebUI at the Ollama HyperProx knows and turn the Ollama connection on? Open WebUI\'s connection settings are changed; no chat or account is.' } : null })
  } else if (o.ollama.answering === false) {
    out.push({ id: 'ollama-down', severity: 'bad', title: 'The Ollama does not answer', detail: `Open WebUI cannot reach ${o.ollama.urls[0] ? 'its Ollama' : 'an Ollama'}${o.ollama.error ? ` (${o.ollama.error})` : ''}. Check that the Ollama is running and listens on the network.`,
      fix: known ? { action: 'reconnect-ollama', label: 'Reconnect', confirm: 'Reconnect Open WebUI to the Ollama HyperProx knows? Open WebUI\'s connection settings are changed to that address, checked first; no chat or account is changed.' } : null })
  } else if (known && o.ollama.urls.length && !o.ollama.urls.map(bare).includes(bare(known))) {
    out.push({ id: 'ollama-other', severity: 'warn', title: 'Open WebUI uses a different Ollama than HyperProx knows', detail: 'This is fine if you chose it. Reconnect points it at the one HyperProx knows.',
      fix: { action: 'reconnect-ollama', label: 'Use the one HyperProx knows', confirm: 'Point Open WebUI at the Ollama HyperProx knows instead of the one it uses now?' } })
  }
  if (o.signupOpen === true) {
    out.push({ id: 'signup-open', severity: 'bad', title: 'Open sign-up is on', detail: 'Anyone who can reach Open WebUI can make an account. New accounts start as pending, but turning sign-up off is safer.',
      fix: { action: 'close-signup', label: 'Close sign-up', confirm: 'Turn off open sign-up in Open WebUI? People can then only be added by an administrator.' } })
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'bad' ? -1 : 1))
}

export async function readOverview(c: Pick<OpenWebuiClient, 'get' | 'post'>, known: string | null = null): Promise<OpenWebuiOverview> {
  const [ver, cfg, tags, admin] = await Promise.all([
    c.get('/api/version', 15_000).catch(() => null),
    c.get('/ollama/config', 15_000).catch(() => null),
    c.get('/ollama/api/tags', 25_000).catch(() => null),
    c.get('/api/v1/auths/admin/config', 15_000).catch(() => null),
  ])
  if (!ver && !cfg && !admin) throw new Error('Open WebUI did not answer.')
  const urls: string[] = Array.isArray(cfg?.OLLAMA_BASE_URLS) ? cfg.OLLAMA_BASE_URLS.map(bare).filter(Boolean) : []
  const enabled = cfg?.ENABLE_OLLAMA_API === true
  // A model list that is empty may be an Ollama with none or one that is not there: ask the first address itself.
  let answering: boolean | null = null, error: string | null = null
  if (enabled && urls.length) {
    try { await c.post('/ollama/verify', { url: urls[0], key: '' }, 15_000); answering = true }
    catch (e) { answering = false; error = text(e) }
  }
  const models: ModelView[] = (Array.isArray(tags?.models) ? tags.models : []).map((m: any) => ({ name: String(m?.name ?? m?.model ?? '?').slice(0, 120), sizeBytes: Number.isFinite(m?.size) ? m.size : null }))
  const ollama: OllamaRead = { enabled, connected: enabled && urls.length > 0, urls: urls.length ? [urls[0]] : [], answering, error }
  const signupOpen = typeof admin?.ENABLE_SIGNUP === 'boolean' ? admin.ENABLE_SIGNUP : null
  const { urls: _kept, ...shown } = ollama
  return { version: typeof ver?.version === 'string' ? ver.version.slice(0, 20) : null, models, ollama: shown, signupOpen, problems: problemsOf({ ollama, signupOpen }, known) }
}

export class OpenWebuiRefusal extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'OpenWebuiRefusal' }
}

export function parseAction(b: unknown): { action: OpenWebuiAction } {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new OpenWebuiRefusal('bad_request', 'Send a JSON body.')
  const a = (b as Record<string, unknown>).action
  if (!(ACTIONS as readonly string[]).includes(a as string)) throw new OpenWebuiRefusal('bad_request', 'Unknown action.')
  return { action: a as OpenWebuiAction }
}

export interface ActionDeps {
  client: OpenWebuiClient
  /** The Ollama address HyperProx knows (the AI page's), or null. */
  known(): Promise<string | null>
  audit(action: string, details: Record<string, unknown>): Promise<void>
}

/** Run one fix, audited first, read back after. */
export async function runAction(raw: unknown, actor: string, d: ActionDeps): Promise<{ message: string; overview: OpenWebuiOverview }> {
  const { action } = parseAction(raw)
  const { client: c } = d
  const known = await d.known().catch(() => null)
  if (action === 'reconnect-ollama') {
    const target = known ? bare(known) : null
    if (!target) throw new OpenWebuiRefusal('no_ollama', 'HyperProx does not know an Ollama to connect to. Install one from the Catalogue first.', 409)
    // Checked by Open WebUI itself, from where it runs: an address it cannot reach is never saved.
    try { await c.post('/ollama/verify', { url: target, key: '' }, 20_000) }
    catch (e) { throw new OpenWebuiRefusal('unreachable', `Open WebUI cannot reach the Ollama HyperProx knows (${text(e)}). Nothing was changed.`, 409) }
    await d.audit('openwebui.reconnect-ollama', { by: actor, target })
    await c.post('/ollama/config/update', { ENABLE_OLLAMA_API: true, OLLAMA_BASE_URLS: [target], OLLAMA_API_CONFIGS: {} }, 30_000)
    const back = await c.get('/ollama/config', 15_000)
    if (back?.ENABLE_OLLAMA_API !== true || !Array.isArray(back?.OLLAMA_BASE_URLS) || bare(back.OLLAMA_BASE_URLS[0]) !== target) throw new OpenWebuiRefusal('not_applied', 'Open WebUI did not keep the new connection: it reads back as something else.', 502)
    const o = await readOverview(c, known)
    return { message: `Open WebUI is connected to the Ollama HyperProx knows${o.models.length ? ` and lists ${o.models.length} model${o.models.length === 1 ? '' : 's'}` : ''}.`, overview: o }
  }
  const cfg = await c.get('/api/v1/auths/admin/config', 15_000)
  if (!cfg || typeof cfg !== 'object' || typeof cfg.ENABLE_SIGNUP !== 'boolean') throw new OpenWebuiRefusal('unexpected', 'Open WebUI did not answer like itself about its settings.', 502)
  await d.audit('openwebui.close-signup', { by: actor })
  await c.post('/api/v1/auths/admin/config', { ...cfg, ENABLE_SIGNUP: false }, 30_000)
  const back = await c.get('/api/v1/auths/admin/config', 15_000)
  if (back?.ENABLE_SIGNUP !== false) throw new OpenWebuiRefusal('not_applied', 'Open WebUI still shows sign-up as on.', 502)
  return { message: 'Open sign-up is off.', overview: await readOverview(c, known) }
}
