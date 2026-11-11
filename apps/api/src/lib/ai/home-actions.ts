// =============================================================================
//  HyperProx — actions the assistant prepares on what is attached to home
//
//  Two, read by code from the request: pull a static site from its git
//  repository now, and run a quick SMART test on one disk of a NAS. Each is only
//  prepared: the server keeps the plan (PreparedStore) and the browser holds its
//  id, and nothing runs until the person confirms the card. Applying is checked
//  in the same order as lib/ai/actions.ts: unlocked, the plan is this person's,
//  never an API token, the role the same action has by hand (lib/roles.ts for
//  its UI route), the master password when that route asks for it, then the
//  thing itself read again (the site still exists and is a static site; the NAS
//  still reports a disk in that bay, which lib/qnap checks once more itself).
//
//  Some things are never prepared here, and the assistant says so plainly:
//  restarting or shutting down a NAS, signing in to WordPress admin, and Home
//  Assistant devices (security ones above all). Those are done by hand, on their
//  own pages, with their own confirm steps.
// =============================================================================

import type { Role } from '../roles'
import { requiredRole, needsReconfirm, hasRole } from '../roles'
import type { PreparedStore } from './prepared'
import type { ActionCard } from './actions'
import type { Choice, ClusterRef } from './clusters'
import { stripAddresses } from '../redact-addresses'

export type HomeActionKind = 'site-pull' | 'qnap-smart'

export interface HomePlan {
  kind: HomeActionKind
  owner: string
  siteId?: string
  siteName?: string
  nasId?: string
  nasName?: string
  bay?: number
}

export type HomeParsed =
  | { kind: 'site-pull' }
  | { kind: 'qnap-smart'; bay: number | null }
  | { kind: 'by-hand'; message: string }

// ---------------------------------------------------------------------------
//  What is done by hand, and why: said plainly, nothing prepared
// ---------------------------------------------------------------------------

export const BY_HAND = {
  nasPower: 'Restarting or shutting down a NAS is done by hand, on its QNAP page: it asks for the admin role, your master password, a confirm phrase and the NAS\'s name typed. The assistant never prepares it.',
  wpLogin: 'Signing in to WordPress admin is done by hand: Sites, then the site, then Open WordPress admin. It asks for your master password and makes a sign-in link that works once, for 60 seconds. The assistant never makes one.',
  haSecurity: 'Locks, alarms, garage doors and other security devices are controlled by hand on the Home Assistant page, with the admin role, your master password and the device\'s name typed. The assistant only reads their state.',
  haDevice: 'The assistant reads Home Assistant but does not switch devices. Use the Home Assistant page\'s Devices view.',
}

const ASKS = /\?\s*$/
const POLITE = /^\s*(please\s+)?(can|could|would|will)\s+you\b/i
const HA_SECURITY = /\b(lock|unlock|locks|door|doors|garage|gate|alarm|siren|disarm|arm)\b/i
const HA_DEVICE = /\b(lights?|lamps?|switch(es)?|plugs?|outlets?|thermostat|heating|heater|blinds?|curtains?|shades?|scenes?|fans?)\b/i
const HA_VERB = /^\s*(please\s+)?(can you\s+|could you\s+)?(turn|switch|set|open|close|shut|lock|unlock|arm|disarm|dim|raise|lower|activate|run|start|toggle)\b/i
const POWER = /^\s*(please\s+)?(can you\s+|could you\s+)?(restart|reboot|shut\s*down|shutdown|power\s*(off|down|cycle)|turn\s+off|halt)\b/i

/**
 * A request this module is for, or null. `nas` and `sites` are the names (and domains) people use for them, so
 * "restart nas1" is the NAS and never a guest called nas1.
 */
export function parseHomeAction(prompt: string, ctx: { nas: string[]; sites: string[] }): HomeParsed | null {
  const t = prompt.trim()
  const p = t.toLowerCase()
  if (ASKS.test(t) && !POLITE.test(t)) return null            // "is the front door locked?" is a question
  const nasNamed = /\b(nas|qnap)\b/.test(p) || ctx.nas.some(n => n && new RegExp(`(^|[^a-z0-9])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(p))

  if (/\bsmart\b/.test(p) && /\b(test|check|scan)\b/.test(p) && (nasNamed || /\b(disk|drive|bay)\b/.test(p))) {
    const bay = /\b(?:disk|bay|drive|hdd|ssd)\s*(?:#|number\s+)?(\d{1,3})\b/.exec(p)
    return { kind: 'qnap-smart', bay: bay ? Number(bay[1]) : null }
  }
  if (POWER.test(t) && nasNamed) return { kind: 'by-hand', message: BY_HAND.nasPower }
  if (/\b(sign|log)\s*(me\s+)?(in|into|on)\b/.test(p) && /\b(wordpress|wp|wp-admin|admin)\b/.test(p) || /\b(open|give me)\b.*\b(wp-admin|wordpress admin)\b/.test(p)) {
    return { kind: 'by-hand', message: BY_HAND.wpLogin }
  }
  if (HA_VERB.test(t) && (HA_SECURITY.test(p) || HA_DEVICE.test(p)) && !/\b(guest|container|vm|ct|lxc)\b/.test(p)) {
    return { kind: 'by-hand', message: HA_SECURITY.test(p) ? BY_HAND.haSecurity : BY_HAND.haDevice }
  }
  const siteNamed = /\b(static\s+)?(web)?sites?\b/.test(p) || ctx.sites.some(s => s && p.includes(s.toLowerCase()))
  if (/^\s*(please\s+)?(can you\s+|could you\s+)?(pull|re-?pull|redeploy|refresh|sync|update)\b/i.test(t) && siteNamed && !/\bmonitoring\b/.test(p)) return { kind: 'site-pull' }
  return null
}

// ---------------------------------------------------------------------------
//  Preparing
// ---------------------------------------------------------------------------

export interface HomeSite { id: string; name: string; recipeId: string; domain: string | null }
export interface HomeNas { id: string; name: string; disks: Array<{ bay: number; model: string | null }> | null }

export interface HomePrepareDeps {
  unlocked(): boolean
  sites(): Promise<HomeSite[]>
  nas(): Promise<HomeNas[]>
  prepared: PreparedStore<HomePlan>
}

export interface HomeWho { owner: string; role: Role | undefined; token: boolean; home: ClusterRef }

export type HomePrepareResult = { kind: 'card'; card: ActionCard } | { kind: 'say'; message: string; choices?: Choice[] }

export const TOKEN_SAY = 'An API token cannot do this from the assistant. A person signs in and confirms it on the page.'
export const LOCKED_HOME = 'HyperProx is locked, so I did nothing. Sign in to unlock it, then ask again.'

const enc = encodeURIComponent
/** The route the same action has by hand: lib/roles.ts decides its role and re-confirmation from it. */
export function homeRoute(plan: Pick<HomePlan, 'kind' | 'siteId' | 'nasId'>): string {
  return plan.kind === 'site-pull' ? `/api/sites/${enc(plan.siteId!)}/pull` : `/api/plugins/qnap/instances/${enc(plan.nasId!)}/actions`
}
export const homeRole = (plan: Pick<HomePlan, 'kind' | 'siteId' | 'nasId'>): Role => requiredRole('POST', homeRoute(plan)) ?? 'admin'
export const homeReconfirm = (plan: Pick<HomePlan, 'kind' | 'siteId' | 'nasId'>) => needsReconfirm('POST', homeRoute(plan))

const say = (message: string, choices?: Choice[]): HomePrepareResult => ({ kind: 'say', message, ...(choices?.length ? { choices } : {}) })

export async function prepareHomeAction(prompt: string, a: HomeParsed, who: HomeWho, d: HomePrepareDeps): Promise<HomePrepareResult> {
  if (a.kind === 'by-hand') return say(a.message)
  if (!d.unlocked()) return say(LOCKED_HOME)
  if (who.token) return say(TOKEN_SAY)
  const p = prompt.toLowerCase()
  const choice = (label: string, prompt: string): Choice => ({ label, prompt, cluster: who.home.id })

  if (a.kind === 'site-pull') {
    const all = await d.sites()
    const statics = all.filter(s => s.recipeId === 'static-site')
    if (!statics.length) return say(all.length ? 'Only a static site is pulled from git, and none of your sites is one.' : 'HyperProx has made no website yet, so there is nothing to pull.')
    const named = all.filter(s => (s.domain && p.includes(s.domain.toLowerCase())) || p.includes(s.name.toLowerCase()))
    if (named.length === 1 && named[0].recipeId !== 'static-site') return say(`${named[0].name} is a WordPress site. Only a static site is pulled from git.`)
    const hits = named.filter(s => s.recipeId === 'static-site')
    const pick = hits.length === 1 ? hits : !named.length && statics.length === 1 ? statics : null
    if (!pick) return say('Which static site should I pull?', statics.slice(0, 8).map(s => choice(`pull ${s.domain ?? s.name}`, `pull ${s.domain ?? s.name} now`)))
    const s = pick[0]
    const plan: HomePlan = { kind: 'site-pull', owner: who.owner, siteId: s.id, siteName: s.domain ?? s.name }
    return card(plan, who, d, `Pull ${plan.siteName} now`, [
      `${plan.siteName} (static site) pulls its git repository now, the same as Pull now on the Sites page.`,
      'Only the files change; the container, its address and the proxy are left alone.',
    ])
  }

  // qnap-smart
  const nas = await d.nas()
  if (!nas.length) return say('No QNAP NAS is added to HyperProx.')
  const named = nas.filter(n => new RegExp(`(^|[^a-z0-9])${n.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(p))
  const one = named.length === 1 ? named[0] : nas.length === 1 && !named.length ? nas[0] : null
  const bayWord = a.bay ? `disk ${a.bay}` : 'a disk'
  if (!one) return say(`Which NAS should run the SMART test on ${bayWord}?`, (named.length ? named : nas).slice(0, 8).map(n => choice(n.name, `run a quick SMART test on ${bayWord} of ${n.name}`)))
  if (!a.bay) {
    if (!one.disks) return say(`${one.name} could not be read, so I cannot list its disks. Name the bay ("disk 2").`)
    return say(`Which disk of ${one.name}?`, one.disks.slice(0, 12).map(x => choice(`disk ${x.bay}${x.model ? ` (${x.model})` : ''}`, `run a quick SMART test on disk ${x.bay} of ${one.name}`)))
  }
  if (one.disks && !one.disks.some(x => x.bay === a.bay)) return say(`${one.name} reports no disk in bay ${a.bay}. Its disks are in bays ${one.disks.map(x => x.bay).join(', ') || 'none'}.`)
  const plan: HomePlan = { kind: 'qnap-smart', owner: who.owner, nasId: one.id, nasName: one.name, bay: a.bay }
  return card(plan, who, d, `Quick SMART test on disk ${a.bay} of ${one.name}`, [
    `${one.name} is asked to run a quick SMART test on disk ${a.bay}, the same as the button on its QNAP page.`,
    'It takes a few minutes; the disk keeps working meanwhile. Nothing is changed or deleted.',
  ])
}

function card(plan: HomePlan, who: HomeWho, d: HomePrepareDeps, title: string, steps: string[]): HomePrepareResult {
  const need = homeRole(plan)
  if (!who.role || !hasRole(who.role, need)) return say(`That needs the ${need} role${who.role ? `, and you are signed in as ${who.role}` : ''}, so I did not prepare it.`)
  const planId = d.prepared.put(who.owner, plan)
  return { kind: 'card', card: { planId, action: plan.kind, cluster: who.home, title, words: `${title}. ${steps[0]}`, steps, needsReconfirm: homeReconfirm(plan), typedName: null, role: need } }
}

// ---------------------------------------------------------------------------
//  Applying
// ---------------------------------------------------------------------------

export interface HomeApplyDeps {
  prepared: PreparedStore<HomePlan>
  owner: string
  ctx: { sid: string; role: Role; email?: string } | undefined
  /** The cluster this apply request is for: these plans are home's. */
  requestCluster: string
  homeId: string
  unlocked(): boolean
  reconfirmed(sid: string): boolean
  site(id: string): Promise<HomeSite | undefined>
  /** Runs site-pull in the site's container (routes/sites.ts realRun). */
  pull(id: string): Promise<{ code: number | null; output: string }>
  /** lib/qnap's own action: it checks the role and the bay again and audits the attempt. */
  smart(nasId: string, bay: number, actor: { sid: string; email: string; role: Role }): Promise<{ message: string }>
  audit(action: string, resource: string, details: Record<string, unknown>): Promise<void>
}

const refuse = (status: number, code: string, error: string) => ({ status, body: { ok: false, code, error } as Record<string, unknown> })

export const isTokenSid = (sid: string | undefined) => !!sid && sid.startsWith('token:')

export async function applyHomeAction(planId: unknown, d: HomeApplyDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  let plan: HomePlan | null = null
  let answer = refuse(500, 'failed', 'Something went wrong. Nothing may have been done.')
  let audited = false
  try {
    if (!d.unlocked()) return (answer = { status: 423, body: { ok: false, code: 'locked', locked: true, error: 'HyperProx is locked. Sign in to unlock it, then try again. Nothing was done.' } })
    if (typeof planId !== 'string' || !planId) return (answer = refuse(400, 'invalid', 'planId is required.'))
    const held = d.prepared.peek(planId, d.owner)
    if (!held) return (answer = refuse(404, 'not_found', 'That plan has expired or was already used. Ask again.'))
    plan = held.payload
    const burn = () => d.prepared.take(planId, d.owner)
    // Never an API token, whatever its role: a person confirms what the assistant prepared.
    if (!d.ctx || isTokenSid(d.ctx.sid)) { burn(); return (answer = refuse(403, 'token_forbidden', 'API tokens can never apply what the assistant prepared. Nothing was done.')) }
    if (d.requestCluster !== d.homeId) { burn(); return (answer = refuse(409, 'wrong_cluster', 'This was prepared for the home cluster. Nothing was done. Ask again with the home cluster selected.')) }
    const need = homeRole(plan)
    if (!hasRole(d.ctx.role, need)) { burn(); return (answer = { status: 403, body: { ok: false, code: 'forbidden', required: need, error: `This needs the ${need} role. Nothing was done.` } }) }
    if (homeReconfirm(plan) && !d.reconfirmed(d.ctx.sid)) return (answer = refuse(403, 'reconfirm_required', 'Re-enter your master password to continue'))

    if (plan.kind === 'site-pull') {
      const s = await d.site(plan.siteId!)
      if (!s) { burn(); return (answer = refuse(404, 'changed', `${plan.siteName} is no longer one of your sites. Nothing was done.`)) }
      if (s.recipeId !== 'static-site') { burn(); return (answer = refuse(409, 'changed', `${plan.siteName} is not a static site. Nothing was done.`)) }
      if (!d.prepared.take(planId, d.owner)) return (answer = refuse(404, 'not_found', 'That plan has expired or was already used. Ask again.'))
      const r = await d.pull(s.id)
      const ok = r.code === 0
      await d.audit('site.pull', `site:${s.id}`, { by: d.owner, via: 'assistant', ok, ...(ok ? {} : { code: `exit ${r.code}` }) })
      audited = true
      const tail = stripAddresses(r.output.trim().split('\n').slice(-2).join(' ')).slice(0, 200)
      return (answer = { status: ok ? 200 : 502, body: { ok, words: ok ? `Pulled ${plan.siteName}.${tail ? ` ${tail}` : ''}` : `site-pull exited ${r.code}.`, ...(ok ? {} : { code: 'failed', error: `site-pull exited ${r.code}.` }) } })
    }

    if (!d.prepared.take(planId, d.owner)) return (answer = refuse(404, 'not_found', 'That plan has expired or was already used. Ask again.'))
    audited = true                    // lib/qnap audits every attempt, refusals included
    const r = await d.smart(plan.nasId!, plan.bay!, { sid: d.ctx.sid, email: d.ctx.email ?? d.owner, role: d.ctx.role })
    return (answer = { status: 200, body: { ok: true, words: r.message } })
  } catch (e: any) {
    const status = typeof e?.status === 'number' ? e.status : 502
    answer = refuse(status, String(e?.code ?? 'failed'), stripAddresses(String(e?.message ?? 'The action failed.')).slice(0, 300))
    return answer
  } finally {
    if (!audited && answer.body.ok !== true) {
      await d.audit(plan?.kind === 'site-pull' ? 'site.pull' : plan?.kind === 'qnap-smart' ? 'qnap.action' : 'assistant.apply', plan?.siteId ? `site:${plan.siteId}` : plan?.nasId ? `qnap:${plan.nasId}` : 'assistant',
        { by: d.owner, via: 'assistant', ok: false, code: String(answer.body.code ?? 'failed') }).catch(() => undefined)
    }
  }
}
