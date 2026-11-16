// =============================================================================
//  HyperProx — auto-connect: the live wiring
//
//  Which plug-ins take part (their adapters), where the remembered state lives
//  (the Catalogue's small table, one row), and what the pass reads: the vault's
//  lock state and its unlock cache, Remote access's exclusion list (failing
//  closed), the shared service scan.
// =============================================================================

import { lookup } from 'node:dns/promises'
import { wizardStore } from '../catalogue-store'
import { auditOrThrow } from '../audit'
import { isUnlocked, cachedSecrets, onUnlock } from '../vault/state'
import { getSettings, saveSettings } from '../plugin-host'
import { sharedServiceScan } from '../service-scan'
import { homePve } from '../pve-env'
import { EMPTY, Reconciler, envExcludedSubnets, type AdapterContext, type AutoConnectAdapter, type AutoConnectState, type StateStore } from './core'
import { settingsAdapter } from './settings-adapter'
import { appLog } from '../log-once'
import { machineId } from '../guest-id'
import { listGuests } from '../pve/guests'

export * from './core'

const ROW = 'autoconnect:state'

export const wizardStateStore = (): StateStore => ({
  async get() {
    const r = await wizardStore().get(ROW)
    const d = r && r.kind === 'setting' ? (r.data as Partial<AutoConnectState>) : null
    return { ...structuredClone(EMPTY), ...(d ?? {}) } as AutoConnectState
  },
  async put(s) { await wizardStore().put({ id: ROW, kind: 'setting', owner: 'system', data: s, expiresAt: null }) },
})

let exclusionSource: (() => Promise<string[]>) | null = null
/** Remote access's "never look inside" list; lib/services/bootstrap.ts sets it (it lives in Postgres). */
export function setAutoConnectExclusionSource(fn: (() => Promise<string[]>) | null): void { exclusionSource = fn }

const lazy = {
  homepage: async () => (await import('../homepage')).homepageService(),
  nextcloud: async () => (await import('../nextcloud')).nextcloudService(),
  haproxy: async () => (await import('../haproxy')).haproxyService(),
  webproxy: async () => (await import('../webproxy')).webProxyService(),
  dns: async (kind: 'pihole' | 'adguard') => (await import('../dns-blocker')).dnsBlockerService(kind),
  fwdproxy: async () => (await import('../fwdproxy')).fwdProxyService(),
  k3s: async () => (await import('../k3s')).k3sService(),
  plugins: async () => (await import('../../plugins')).PLUGINS,
}

let manifests: Map<string, any> | null = null

function adapters(): AutoConnectAdapter[] {
  const settingsDeps = {
    findings: async () => (await sharedServiceScan().result(false)).findings
      .filter(f => f.address)
      .map(f => ({ key: f.key, address: f.address, guest: f.guest ? { vmid: Number(f.guest.vmid), type: f.guest.type, name: f.guest.name } : null })),
    tags: async () => {
      const rows = await listGuests(homePve(), { strict: false })
      return new Map(rows.map(r => [machineId(r), r.tags]))
    },
    manifest: (id: string) => manifests?.get(id),
    settings: (id: string) => getSettings(id),
    save: (m: any, values: Record<string, string>) => saveSettings(m, values),
    resolve: async (host: string) => (await lookup(host, { family: 4 }).catch(() => null))?.address ?? null,
  }
  return [
    { plugin: 'homepage', reconcile: async ctx => (await lazy.homepage()).autoConnect(ctx), pick: async (key, choice, ctx) => (await lazy.homepage()).autoPick(key, choice, ctx) },
    { plugin: 'nextcloud', reconcile: async ctx => (await lazy.nextcloud()).autoConnect(ctx), pick: async (key, choice, ctx) => (await lazy.nextcloud()).autoPick(key, choice, ctx) },
    { plugin: 'haproxy', reconcile: async ctx => {
        const svc = await lazy.haproxy()
        const out = await svc.autoConnect(ctx)
        // A newly connected HAProxy with the metrics frontend joins Prometheus's list.
        if (out.some(o => o.did === 'connected' || o.did === 'filled')) await (await import('../haproxy')).syncHaproxyTargets(svc).catch(() => false)
        // HyperProx's own addresses may have changed since the last pass: the metrics allow-lists follow them.
        else await (await import('../haproxy')).keepScrapersCurrent(svc, { log: m => appLog.warn(m) }).catch(() => ({}))
        return out
      }, pick: async (key, choice, ctx) => (await lazy.haproxy()).autoPick(key, choice, ctx) },
    // NGINX, Caddy and Envoy: one service, an adapter per plug-in. Each guest is found once, so there is no choice to pick.
    ...(['nginx', 'caddy', 'envoy'] as const).map(kind => ({ plugin: kind, reconcile: async (ctx: AdapterContext) => (await lazy.webproxy()).autoConnect(kind, ctx) })),
    { plugin: 'pihole', reconcile: async ctx => (await lazy.dns('pihole')).autoConnect(ctx), pick: async (key, choice, ctx) => (await lazy.dns('pihole')).autoPick(key, choice, ctx) },
    { plugin: 'adguard', reconcile: async ctx => (await lazy.dns('adguard')).autoConnect(ctx), pick: async (key, choice, ctx) => (await lazy.dns('adguard')).autoPick(key, choice, ctx) },
    // 3proxy: a finished Catalogue install, its helper confirmed read-only, connected (lib/fwdproxy).
    { plugin: '3proxy', reconcile: async ctx => (await lazy.fwdproxy()).autoConnect(ctx) },
    { plugin: 'k3s', reconcile: async ctx => (await lazy.k3s()).autoConnect(ctx) },
    settingsAdapter('unmanic', settingsDeps),
    settingsAdapter('arrstack', settingsDeps),
    settingsAdapter('plex', settingsDeps),
  ]
}

let reconciler: Reconciler | null = null

export function autoConnect(): Reconciler {
  if (reconciler) return reconciler
  reconciler = new Reconciler({
    store: wizardStateStore(),
    adapters: adapters(),
    unlocked: () => isUnlocked(),
    excluded: async () => {
      if (!exclusionSource) throw new Error('Remote access\'s exclusion list is not available.')
      if (!manifests) manifests = new Map((await lazy.plugins()).map(p => [p.manifest.id, p.manifest]))
      return exclusionSource()
    },
    // Throws on an unreadable entry: the pass then does not run at all (fail closed, logged loudly).
    excludedSubnets: () => envExcludedSubnets(),
    vaultItems: () => cachedSecrets(),
    audit: (a, r, d) => auditOrThrow(a, r, d),
    log: m => appLog.warn(m),
    logError: (m, err, level = 'warn') => appLog[level]({ err }, m),
  })
  return reconciler
}

export function setAutoConnect(r: Reconciler | null): void { reconciler = r }

/** A person disconnected or removed something a plug-in had: remembered, so it is never added back by itself. */
export async function rememberDismissed(plugin: string, key: string, label: string, by: string): Promise<void> {
  await autoConnect().dismiss(plugin, key, label, by)
}

export { onUnlock }
