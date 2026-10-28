// =============================================================================
//  HyperProx — Updates: apps from plug-in providers
//
//  The third kind of update, next to apt and docker: apps installed some other
//  way, found and updated by plug-in app-update providers (lib/plugin-host.ts).
//
//  This file is the seam between the two. It builds the context a provider is
//  handed for one guest — commands go through the Updates executor, so a
//  provider runs in exactly the guest the planner chose and every test can use
//  the fake cluster — turns what providers report into inventory rows, and runs
//  the two step kinds:
//
//    app-config  a provider's config fix, approved separately by its own id
//    app         baseline → apply (stop, install, start) → verify
//
//  A failed step is never undone behind anyone's back: it fails with the
//  provider's rollback text and the snapshot taken before it, the job pauses,
//  and rolling back is a person's explicit choice.
// =============================================================================

import {
  type AppContext, type AppHttpResult, type AppInstall, type AppUpdateProvider, type AppWsProbe, type RegisteredAppProvider,
  appUpdateProviders, getSettings, pluginOptions,
} from '../plugin-host'
import { PLUGINS } from '../../plugins'
import { fetchJson, httpGet, wsProbe } from '../app-updates/net'
import { getProviderCredentials } from '../credentials'
import { NPMClient } from '../npm-client'
import type { UpdatesApp } from './types'
import type { GuestRef, LineSink, UpdatesExecutor } from './executor'
import { type Policy, appMode } from './policy'
import { compareVersions, isVersion } from '../app-updates/versions'
import { tail } from './commands'

export interface AppProxyHost { domains: string[]; forwardHost: string; forwardPort: number; ssl: boolean; enabled: boolean }

/** Everything app updates need from outside the guest. Production binds it below; tests bind fakes. */
export interface AppEnv {
  providers: RegisteredAppProvider[]
  fetchJson(url: string, body?: unknown): Promise<any>
  http(url: string, opts?: { headers?: Record<string, string>; timeoutMs?: number; insecureTLS?: boolean }): Promise<AppHttpResult>
  wsProbe(url: string, opts?: { origin?: string; timeoutMs?: number; insecureTLS?: boolean }): Promise<AppWsProbe>
  /** A plug-in's non-secret settings. */
  options(pluginId: string): Promise<Record<string, string>>
  proxyHosts(): Promise<AppProxyHost[]>
}

// --- Approval ids ---------------------------------------------------------------------
//
// What a person approves names the exact thing: this install, in this guest, to this version;
// or this exact config change. If any of it differs when the run is planned, the approval
// does not match and nothing is planned.

export const updateApprovalId = (vmid: number, provider: string, key: string, version: string) => `app:${vmid}:${provider}:${key}@${version}`
export const fixApprovalId = (vmid: number, provider: string, key: string, fixId: string) => `fix:${vmid}:${provider}:${key}:${fixId}`

export const APPROVAL_ID = /^(?:app:\d{1,9}:[a-z0-9-]{1,41}:[a-f0-9]{6,64}@[0-9A-Za-z.+-]{1,64}|fix:\d{1,9}:[a-z0-9-]{1,41}:[a-f0-9]{6,64}:[a-f0-9]{6,64})$/

// --- The context a provider gets ------------------------------------------------------------

const ADDRESSES_SCRIPT = 'hostname -I 2>/dev/null; hostname -f 2>/dev/null; hostname 2>/dev/null; true'

export function appContext(env: AppEnv, exec: UpdatesExecutor, guest: GuestRef, options: Record<string, string>, log: LineSink): AppContext {
  let addresses: Promise<Set<string>> | null = null
  const ctx: AppContext = {
    guest: { vmid: guest.vmid, name: guest.name, node: guest.node, type: guest.type },
    run: (script, opts) => exec.guestExec(guest, script, undefined, opts?.timeoutMs ?? 120_000),
    option: key => options[key] || undefined,
    fetchJson: (url, body) => env.fetchJson(url, body),
    http: (url, opts) => env.http(url, opts),
    wsProbe: (url, opts) => env.wsProbe(url, opts),
    async proxiedUrls(ports) {
      addresses ??= ctx.run(ADDRESSES_SCRIPT, { timeoutMs: 30_000 }).then(r => new Set(
        [...r.output.split(/\s+/), guest.name].map(s => s.trim().toLowerCase()).filter(Boolean)))
      const mine = await addresses
      const urls: string[] = []
      for (const h of await env.proxyHosts()) {
        if (!h.enabled || !mine.has(h.forwardHost.toLowerCase())) continue
        if (ports?.length && !ports.includes(h.forwardPort)) continue
        for (const d of h.domains) if (/^[a-z0-9.-]+$/i.test(d) && !d.startsWith('*')) urls.push(`${h.ssl ? 'https' : 'http'}://${d.toLowerCase()}/`)
      }
      return [...new Set(urls)]
    },
    log,
    now: () => exec.now(),
    sleep: ms => exec.sleep(ms),
  }
  return ctx
}

async function contextFor(env: AppEnv, exec: UpdatesExecutor, guest: GuestRef, reg: RegisteredAppProvider, log: LineSink): Promise<AppContext> {
  const options = await env.options(reg.pluginId).catch(() => ({} as Record<string, string>))
  return appContext(env, exec, guest, options, log)
}

// --- Inventory --------------------------------------------------------------------------

export interface GuestAppsResult { apps: UpdatesApp[]; errors: string[] }

/** Read-only: every app every provider finds in this guest, with its latest version and pre-flight. */
export async function readGuestApps(env: AppEnv, exec: UpdatesExecutor, policy: Policy, guest: GuestRef, snapshotCapable: boolean): Promise<GuestAppsResult> {
  const apps: UpdatesApp[] = []
  const errors: string[] = []
  for (const reg of env.providers) {
    const p = reg.provider
    const ctx = await contextFor(env, exec, guest, reg, () => {})
    let installs: AppInstall[]
    try { installs = await p.detect(ctx) }
    catch (e: any) { errors.push(`${p.name}: ${e.message}`); continue }
    for (const install of installs) {
      const mode = appMode(policy, p.id)
      const row: UpdatesApp = {
        provider: p.id, name: install.name, key: install.key, installed: install.installed, latest: null,
        location: install.location, runAs: install.runAs, service: install.service, running: install.running, how: install.how,
        mode, isSecurity: false, notes: [], issues: [],
        rollback: p.rollback(install, snapshotCapable ? 'hp-upd-* (taken just before the update)' : null),
        approvalId: null,
      }
      let target: string | null = null
      try {
        const rel = await p.latest(install, ctx)
        row.latest = rel.latest
        row.notes = rel.notes.slice(0, 15)
        row.isSecurity = rel.isSecurity
        if (rel.securityNote) row.securityNote = rel.securityNote
        if (rel.latest && isVersion(rel.latest) && isVersion(install.installed) && compareVersions(rel.latest, install.installed) > 0) target = rel.latest
      } catch (e: any) { row.error = `latest version could not be read: ${e.message}` }
      try {
        row.issues = (await p.preflight(install, target, ctx)).map(i => ({
          message: i.message, blocking: i.blocking,
          ...(i.fix ? { fix: { ...i.fix, id: fixApprovalId(guest.vmid, p.id, install.key, i.fix.id) } } : {}),
        }))
      } catch (e: any) { row.issues = [{ message: `pre-flight could not run: ${e.message}`, blocking: true }] }
      if (target && mode !== 'off') row.approvalId = updateApprovalId(guest.vmid, p.id, install.key, target)
      apps.push(row)
    }
  }
  return { apps, errors }
}

// --- Step details ----------------------------------------------------------------------------
//
// `app`:        "<provider> <version> <key> — words"
// `app-config`: "<provider> <fixId> <key> — words"
// The first three words are what the runner reads; the rest is for people.

export function appStepDetail(provider: string, version: string, key: string, words: string): string {
  return `${provider} ${version} ${key} — ${words}`
}

export function parseAppDetail(detail: string | null | undefined): { provider: string; arg: string; key: string } | null {
  const m = /^([a-z0-9][a-z0-9-]{0,40}) (\S{1,64}) ([a-f0-9]{6,64})(?: |$)/.exec(detail ?? '')
  return m ? { provider: m[1], arg: m[2], key: m[3] } : null
}

// --- Running a step -----------------------------------------------------------------------------

export type AppOutcome = { status: 'ok'; output?: string } | { status: 'failed'; reason: string; output?: string }

function withRollback(p: AppUpdateProvider, install: AppInstall, snapshot: string | null, message: string): string {
  return `${message}. Nothing was rolled back. ${p.rollback(install, snapshot)}`
}

/**
 * One `app` or `app-config` step. Safe to run twice: an install already at the planned version
 * is verified, not reinstalled, and a fix that is already in place reports so.
 */
export async function runAppStep(
  env: AppEnv, exec: UpdatesExecutor, guest: GuestRef, action: 'app' | 'app-config', detail: string | null,
  snapshot: string | null, log: LineSink,
): Promise<AppOutcome> {
  const d = parseAppDetail(detail)
  if (!d) return { status: 'failed', reason: `unreadable app step "${detail}"` }
  const reg = env.providers.find(r => r.provider.id === d.provider)
  if (!reg) return { status: 'failed', reason: `no plug-in provides app updates for "${d.provider}" any more` }
  const p = reg.provider
  const out: string[] = []
  const say: LineSink = line => { out.push(line); log(line) }
  const ctx = await contextFor(env, exec, guest, reg, say)

  const install = (await p.detect(ctx)).find(i => i.key === d.key)
  if (!install) return { status: 'failed', reason: `${p.name} is no longer found in ${guest.vmid} where it was planned` }
  say(`${p.name} ${install.installed} at ${install.location}`)

  if (action === 'app-config') {
    if (!p.applyFix) return { status: 'failed', reason: `${p.name} offers no config fixes` }
    const baseline = await p.baseline?.(install, ctx)
    const fixed = await p.applyFix(install, d.arg, ctx)
    say(fixed.message)
    if (!fixed.ok) return { status: 'failed', reason: withRollback(p, install, snapshot, `config change failed: ${fixed.message}`), output: tail(fixed.output ?? '') }
    // Read it again: the service restarted with the new config, and the facts verify uses changed.
    const now = (await p.detect(ctx)).find(i => i.key === d.key) ?? install
    const v = await p.verify(now, now.installed, ctx, baseline)
    say(v.message)
    if (!v.ok) return { status: 'failed', reason: withRollback(p, install, snapshot, `config changed, then the check failed: ${v.message}`), output: tail([out.join('\n'), v.output ?? ''].join('\n')) }
    return { status: 'ok', output: tail([out.join('\n'), v.output ?? ''].filter(Boolean).join('\n')) }
  }

  const version = d.arg
  if (!isVersion(version) || !isVersion(install.installed)) return { status: 'failed', reason: `not a version: ${isVersion(version) ? install.installed : version}` }
  const cmp = compareVersions(install.installed, version)
  if (cmp > 0) return { status: 'failed', reason: `${p.name} is already at ${install.installed}, newer than the planned ${version}; refusing to downgrade` }
  if (cmp === 0) {
    // A resumed step whose install finished: check it, do not install again.
    const v = await p.verify(install, version, ctx, null)
    say(v.message)
    return v.ok ? { status: 'ok', output: tail([out.join('\n'), v.output ?? ''].join('\n')) }
      : { status: 'failed', reason: withRollback(p, install, snapshot, `already at ${version}, but the check failed: ${v.message}`), output: tail(v.output ?? '') }
  }

  const blocking = (await p.preflight(install, version, ctx)).filter(i => i.blocking)
  if (blocking.length) {
    return { status: 'failed', reason: `pre-flight stopped it before anything changed: ${blocking.map(i => i.message + (i.fix ? ' (a config fix is offered on the Updates page)' : '')).join('; ')}` }
  }

  const baseline = await p.baseline?.(install, ctx)
  say(`updating ${p.name} ${install.installed} → ${version}`)
  const applied = await p.apply(install, version, ctx)
  say(applied.message)
  if (!applied.ok) return { status: 'failed', reason: withRollback(p, install, snapshot, `update failed: ${applied.message}`), output: tail([out.join('\n'), applied.output ?? ''].join('\n')) }

  const now = (await p.detect(ctx)).find(i => i.key === d.key) ?? install
  const v = await p.verify(now, version, ctx, baseline)
  say(v.message)
  if (!v.ok) return { status: 'failed', reason: withRollback(p, install, snapshot, `updated to ${version}, but the check failed: ${v.message}`), output: tail([out.join('\n'), v.output ?? ''].join('\n')) }
  return { status: 'ok', output: tail([out.join('\n'), v.output ?? ''].filter(Boolean).join('\n')) }
}

// --- Production -----------------------------------------------------------------------------------

export function productionAppEnv(): AppEnv {
  return {
    providers: appUpdateProviders(PLUGINS),
    fetchJson,
    http: httpGet,
    wsProbe,
    async options(pluginId) {
      const plugin = PLUGINS.find(p => p.manifest.id === pluginId)
      return plugin ? pluginOptions(plugin.manifest, await getSettings(pluginId)) : {}
    },
    async proxyHosts() {
      const c = await getProviderCredentials('proxy', 'npm')
      if (!c?.url || !c?.email || !c?.password) return []
      return (await new NPMClient(c.url, c.email, c.password).getProxyHosts()).map(h => ({
        domains: h.domain_names, forwardHost: String(h.forward_host), forwardPort: Number(h.forward_port),
        ssl: typeof h.certificate_id === 'number' && h.certificate_id > 0, enabled: Boolean(h.enabled),
      }))
    },
  }
}
