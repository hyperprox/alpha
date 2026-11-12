// =============================================================================
//  HyperProx — the "create a website" template
//
//  Four fields, read from the person's words by code: the kind (a static site or
//  WordPress), the public name (or LAN only), the site title and, for WordPress,
//  the admin email. A field that is missing or does not fit is asked for, one
//  question at a time, and the answer is read against that question (a draft per
//  person, held on the server for 15 minutes). No model is asked to fill a field.
//
//  When every field is known, the New website wizard's own planning code makes
//  the plan: lib/sites.ts checks the name against the DNS provider and the proxy
//  (inside previewInstall), and lib/catalogue-installer.ts places it (the same
//  recommendation, next free ID and bridge the wizard's Placement step offers)
//  and holds it as a preview under the person's name. The assistant never
//  installs: the person opens that preview in the New website wizard, reviews
//  it, and Install there asks for the master password, as it does by hand.
// =============================================================================

import { coerceHostname } from './fields'
import { zoneFor } from '../../dns-zones'
import type { CatalogueRecipe } from '../../catalogue'
import type { WizardInput } from '../../catalogue-installer'
import type { Role } from '../../roles'
import { requiredRole, hasRole } from '../../roles'
import type { Choice } from '../clusters'

export type WebsiteKind = 'static-site' | 'wordpress'

export interface WebsiteFields {
  kind?: WebsiteKind
  /** A hostname, or 'lan' for not published. */
  domain?: string
  title?: string
  adminEmail?: string
}

export type WebsiteField = keyof WebsiteFields

export interface WebsiteDraft { fields: WebsiteFields; asking: WebsiteField | null; at: number }

const EMAIL = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+\b/
const HOST = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})\b/i
const LAN = /\b(lan only|lan|local only|not published|no domain|don'?t publish|do not publish|on my network only|internal only|private)\b/i
// Double quotes only: an apostrophe ("Grandma's Kitchen") is part of a title, not a quote around one.
const TITLE_QUOTED = /["“]([^"”]{1,100})["”]/
const TITLE_CALLED = /\b(?:called|titled|named|title)\s*:?\s+(.+?)(?=\s+(?:at|on|with|and|for|using|under)\b|[,.;!?]|$)/i
const CONTROL = /[\u0000-\u001f\u007f]/

const WEB_WORD = /\b(websites?|web\s*sites?|wordpress|wp|blog|static\s+(web)?site|landing\s+page|site)\b/i
const MAKE_VERB = /\b(create|make|build|set\s*up|start|launch|new|host|publish|spin\s*up|add|want|need|like|get|install|deploy|give\s+me)\b/i

/**
 * True when the request is for a new website. "Homepage" is never a website word here: it is a catalogue recipe. "Deploy a static site …" keeps going to the deploy planner as it
 * always has (it is one of its recipes); WordPress, and "create/make/new … website", come here.
 */
export function isWebsiteRequest(prompt: string): boolean {
  const p = prompt.toLowerCase()
  if (!WEB_WORD.test(p) || !MAKE_VERB.test(p)) return false
  if (/^\s*(what|how|why|which|is|are|does|do|when|where|who)\b/.test(p) && !/\b(can|could)\s+(i|you|we)\b/.test(p)) return false
  if (/\b(pull|metrics|visitors?|health|certificate|expire|sign\s*in|log\s*in|wp-admin)\b/.test(p) || /\b(is|are)\b.*\b(up|down)\b/.test(p)) return false
  if (/\b(wordpress|wp)\b/.test(p)) return true
  if (/^\s*(please\s+)?(deploy|install)\b/.test(p) && /\bstatic\s+site\b/.test(p) && !/\bwebsite\b/.test(p)) return false
  return /\b(websites?|web\s*sites?|blog|landing\s+page)\b/.test(p) || /\b(create|make|build|new|set\s*up|start|launch|host)\b.*\bsite\b/.test(p)
}

export const isCancel = (prompt: string) => /^\s*(cancel|stop|never\s*mind|forget\s+it|no\s+thanks|abort)\b/i.test(prompt)

function kindIn(text: string): WebsiteKind | undefined {
  const p = text.toLowerCase()
  if (/\b(wordpress|wp)\b/.test(p)) return 'wordpress'
  if (/\b(static|plain\s+html|html|landing\s+page|git)\b/.test(p)) return 'static-site'
  return undefined
}

/**
 * Fields read from `text`. With `asking` set the whole reply is read as the answer to that question first (a
 * title is free text), and anything else it also says is read too.
 */
export function extractWebsite(text: string, asking: WebsiteField | null = null): WebsiteFields {
  const out: WebsiteFields = {}
  const t = text.trim()
  const kind = kindIn(t)
  if (kind) out.kind = kind
  const email = EMAIL.exec(t)?.[0]
  if (email) out.adminEmail = email.toLowerCase()
  const withoutEmail = email ? t.replace(email, ' ') : t
  if (LAN.test(withoutEmail)) out.domain = 'lan'
  else {
    const h = HOST.exec(withoutEmail)?.[1]
    if (h) out.domain = h.toLowerCase().replace(/\.$/, '')
  }
  const quoted = TITLE_QUOTED.exec(t)?.[1] ?? TITLE_CALLED.exec(withoutEmail)?.[1]
  if (quoted && !CONTROL.test(quoted)) out.title = quoted.trim().slice(0, 100)
  if (asking === 'title' && !out.title) {
    const whole = t.replace(/^["“]|["”]$/g, '').trim()
    if (whole && whole.length <= 100 && !CONTROL.test(whole)) out.title = whole
  }
  if (asking === 'kind' && !out.kind && /\b(static|plain)\b/i.test(t)) out.kind = 'static-site'
  return out
}

export function mergeWebsite(a: WebsiteFields, b: WebsiteFields): WebsiteFields {
  const out: WebsiteFields = { ...a }
  for (const [k, v] of Object.entries(b)) if (v !== undefined && v !== '') (out as any)[k] = v
  return out
}

export interface Question { field: WebsiteField; question: string; choices: string[] }

/** The first missing or unusable field, as a question with its real choices; null when every field is known. */
export function nextQuestion(f: WebsiteFields, ctx: { domains: string[] | null }): Question | null {
  if (!f.kind) return { field: 'kind', question: 'What kind of website: a static site (plain HTML, optionally pulled from git) or WordPress?', choices: ['A static site', 'WordPress'] }
  if (!f.domain) {
    if (!ctx.domains || !ctx.domains.length) return { field: 'domain', question: 'No DNS provider is set up, so the site can only be reached on your network. Say "LAN only" to go on, or add a DNS provider in Settings first.', choices: ['LAN only'] }
    const sub = f.kind === 'wordpress' ? 'blog' : 'www'
    return { field: 'domain', question: `What name should it answer on? It must be under one of your domains: ${ctx.domains.join(', ')}. Or say "LAN only".`, choices: [...ctx.domains.slice(0, 4).map(z => `${sub}.${z}`), 'LAN only'] }
  }
  if (f.domain !== 'lan') {
    const h = coerceHostname('domain', f.domain)
    if (!h.ok) return { field: 'domain', question: `${f.domain} is not a name a website can answer on. Which name should it use?`, choices: [] }
    if (!ctx.domains || !zoneFor(String(h.value), ctx.domains)) {
      return { field: 'domain', question: `${f.domain} is not under a domain your DNS provider lists${ctx.domains?.length ? ` (${ctx.domains.join(', ')})` : ''}. Which name should it use, or "LAN only"?`, choices: [...(ctx.domains ?? []).slice(0, 4).map(z => `www.${z}`), 'LAN only'] }
    }
  }
  if (!f.title) return { field: 'title', question: 'What is the site\'s title?', choices: [] }
  if (f.kind === 'wordpress' && !f.adminEmail) return { field: 'adminEmail', question: 'Which email address should the WordPress admin account use?', choices: [] }
  return null
}

/** The WordPress admin user, from the email's local part: the recipe's user rule, and never plain "admin". */
export function adminUserFrom(email: string): string {
  const u = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[^a-z0-9]+/, '').slice(0, 60)
  return !u || u === 'admin' ? 'site-admin' : u
}

// ---------------------------------------------------------------------------
//  The plan, from the wizard's own code
// ---------------------------------------------------------------------------

export interface ProxyOption { id: string; name: string; kind: string; status?: string; certificates: 'request' | 'provider' | 'none' }
export interface Placed {
  node: string; storage: string; bridge: string; vmid: number; reason: string
  /** From the naming settings (or the numbering the guests follow): a fixed address, or 'dhcp' when none could be picked. */
  ip?: string; gateway?: string; dns?: string[]; vlan?: number
  /** "CT 3xx ↔ 192.0.2.2xx (your numbering)", shown in the plan. */
  numbering?: string
}

export interface WebsitePlanDeps {
  recipe(id: WebsiteKind): CatalogueRecipe | undefined
  /** The domains the DNS provider lists (active ones), or null with no provider. */
  domains(): Promise<string[] | null>
  proxies(): Promise<ProxyOption[]>
  /** The wizard's placement for this recipe and size (catalogue-installer placementFor + nextIdOf). */
  place(recipe: CatalogueRecipe, need: { cores: number; memoryMb: number; diskGb: number }): Promise<Placed | { error: string }>
  /** catalogue-installer previewInstall: checks it all against the cluster and holds it under `owner`. */
  preview(input: WizardInput, owner: string): Promise<{ preview?: { id: string; plan: any; checks: string[]; warnings: string[]; expiresAt: number }; errors: string[]; warnings: string[] }>
}

export interface WebsiteCard {
  previewId: string
  title: string
  steps: string[]
  checks: string[]
  warnings: string[]
  /** The New website wizard, opened on this preview. */
  link: string
  expiresAt: number
}

export type WebsiteResult = { kind: 'card'; card: WebsiteCard } | { kind: 'say'; message: string; choices?: string[] }

/** The role the wizard's preview needs by hand (admin). */
export const websiteRole = (): Role => requiredRole('POST', '/api/catalogue/wizard/preview') ?? 'admin'

export async function planWebsite(f: Required<Pick<WebsiteFields, 'kind' | 'domain' | 'title'>> & WebsiteFields, owner: string, domains: string[] | null, d: WebsitePlanDeps): Promise<WebsiteResult> {
  const recipe = d.recipe(f.kind)
  if (!recipe) return { kind: 'say', message: `This HyperProx has no ${f.kind} recipe.` }
  const publish = f.domain !== 'lan'
  let pub: WizardInput['publish'] | undefined
  if (publish) {
    const z = zoneFor(f.domain, domains ?? [])!
    const proxies = await d.proxies().catch(() => [] as ProxyOption[])
    // The proxy the wizard's Address step picks first: one that can get a certificate and is not locked.
    const proxy = proxies.find(p => p.certificates !== 'none' && p.status !== 'locked')
    if (!proxy) return { kind: 'say', message: proxies.length ? 'None of your proxies can get a certificate for the site right now (each is locked or has no certificates). Unlock one or add one, or say "LAN only".' : 'No proxy is set up to serve the site. Add one on the Proxy page, or say "LAN only".', choices: ['LAN only'] }
    pub = { zone: z.zone, name: z.name === '@' || z.name === '' ? '@' : z.name, instanceId: proxy.id }
  }
  // The wizard's default size is medium.
  const size = recipe.sizes?.medium ?? recipe.defaults
  const placed = await d.place(recipe, { cores: size.cores, memoryMb: size.memoryMb, diskGb: size.diskGb })
  if ('error' in placed) return { kind: 'say', message: `${placed.error} Nothing was planned.` }
  const hostname = ((publish ? f.domain.split('.')[0] : '') || recipe.id).replace(/[^a-z0-9-]/g, '-').slice(0, 63)
  const options: Record<string, string> = f.kind === 'wordpress'
    ? { WP_TITLE: f.title, WP_ADMIN_USER: adminUserFrom(f.adminEmail!), WP_ADMIN_EMAIL: f.adminEmail!, ...(publish ? { WP_URL: `https://${f.domain}` } : {}) }
    : { SITE_TITLE: f.title }
  const input: WizardInput = {
    recipeId: recipe.id, node: placed.node, vmid: placed.vmid, hostname,
    cores: size.cores, memoryMb: size.memoryMb, swapMb: Math.min(512, size.memoryMb), diskGb: size.diskGb,
    storage: placed.storage, bridge: placed.bridge, ip: placed.ip ?? 'dhcp',
    ...(placed.ip && placed.ip !== 'dhcp' && placed.gateway ? { gateway: placed.gateway } : {}),
    ...(placed.ip && placed.ip !== 'dhcp' && placed.dns?.length ? { dns: placed.dns.join(' ') } : {}),
    ...(placed.vlan ? { vlan: placed.vlan } : {}),
    options, ...(pub ? { publish: pub } : {}),
  }
  const r = await d.preview(input, owner)
  if (!r.preview) return { kind: 'say', message: `The New website wizard refused this plan: ${r.errors.join(' ')} Nothing was planned.` }
  const pv = r.preview
  const where = publish ? `https://${f.domain}` : 'your network only'
  const steps = [
    `${recipe.name} "${f.title}" at ${where}.`,
    `Container ${pv.plan.vmid} (${pv.plan.hostname}) on ${pv.plan.node}, ${pv.plan.cores} core${pv.plan.cores === 1 ? '' : 's'}, ${pv.plan.memoryMb} MB, ${pv.plan.diskGb} GB on ${pv.plan.storage}, ${pv.plan.ip === 'dhcp' ? 'DHCP (no fixed address could be picked; the wizard can set one)' : `${String(pv.plan.ip).split('/')[0]}${placed.numbering ? `, ${placed.numbering}` : ''}`}. ${placed.reason}`,
    ...(pv.plan.publish ? [`DNS ${pv.plan.publish.record.type} ${pv.plan.publish.record.name} in ${pv.plan.publish.zone}, a proxy host on ${pv.plan.publish.instanceName} and its certificate.`] : []),
    ...(f.kind === 'wordpress' ? [`WordPress admin ${options.WP_ADMIN_USER} (${f.adminEmail}); its password is generated into the vault. Change the user name in the wizard if you want another.`] : []),
    'Open it in the New website wizard to review every step. Install there asks for your master password.',
  ]
  return { kind: 'card', card: { previewId: pv.id, title: `New website: ${recipe.name} at ${publish ? f.domain : 'LAN only'}`, steps, checks: pv.checks, warnings: pv.warnings, link: `/sites?preview=${encodeURIComponent(pv.id)}`, expiresAt: pv.expiresAt } }
}

// ---------------------------------------------------------------------------
//  The turn: read, ask for what is missing, plan
// ---------------------------------------------------------------------------

export class WebsiteDrafts {
  private m = new Map<string, WebsiteDraft>()
  constructor(private ttlMs = 15 * 60_000, private now: () => number = Date.now) {}
  get(owner: string): WebsiteDraft | null {
    const d = this.m.get(owner)
    if (!d) return null
    if (this.now() - d.at > this.ttlMs) { this.m.delete(owner); return null }
    return d
  }
  set(owner: string, fields: WebsiteFields, asking: WebsiteField | null): void { this.m.set(owner, { fields, asking, at: this.now() }) }
  drop(owner: string): void { this.m.delete(owner) }
}

export interface WebsiteTurnWho { owner: string; role: Role | undefined; token: boolean; unlocked: boolean }

export const WEBSITE_LOCKED = 'HyperProx is locked, so I did nothing. Sign in to unlock it, then ask again.'
export const WEBSITE_TOKEN = 'An API token cannot plan a website. A person signs in, asks, and confirms it in the New website wizard.'

export async function websiteTurn(prompt: string, who: WebsiteTurnWho, drafts: WebsiteDrafts, d: WebsitePlanDeps): Promise<WebsiteResult> {
  if (!who.unlocked) return { kind: 'say', message: WEBSITE_LOCKED }
  if (who.token) return { kind: 'say', message: WEBSITE_TOKEN }
  const need = websiteRole()
  if (!who.role || !hasRole(who.role, need)) return { kind: 'say', message: `Making a website needs the ${need} role${who.role ? `, and you are signed in as ${who.role}` : ''}, so I did not plan it.` }
  const draft = drafts.get(who.owner)
  if (draft && isCancel(prompt)) { drafts.drop(who.owner); return { kind: 'say', message: 'Cancelled. Nothing was planned.' } }
  const fields = mergeWebsite(isWebsiteRequest(prompt) ? {} : draft?.fields ?? {}, extractWebsite(prompt, isWebsiteRequest(prompt) ? null : draft?.asking ?? null))
  const domains = await d.domains().catch(() => null)
  const q = nextQuestion(fields, { domains })
  if (q) {
    // An answer that does not fit is not kept, so the same question is asked again with its reason.
    const kept = q.field === 'domain' ? { ...fields, domain: undefined } : fields
    drafts.set(who.owner, kept, q.field)
    return { kind: 'say', message: q.question, choices: q.choices }
  }
  drafts.drop(who.owner)
  return planWebsite(fields as any, who.owner, domains, d)
}

/** Choices for the page: each one sends its own words as the next answer. */
export const asChoices = (choices: string[] | undefined, cluster: string): Choice[] => (choices ?? []).map(c => ({ label: c, prompt: c, cluster }))
