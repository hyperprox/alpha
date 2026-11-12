// =============================================================================
//  HyperProx — deleting a website: the real connections
//
//  DNS through the provider router (the zone's own provider), proxy hosts read
//  fresh from every instance and deleted through the proxy planner, NPM
//  certificates through that instance's NPM login, and the container through
//  the home cluster's guest delete path with the PBS mount clean-up hook.
// =============================================================================

import { homePve } from './pve-env'
import type { ProxmoxClient } from './proxmox-client'
import { pbsMountCleanup, homeNodeRunner } from './pbs/setup-deps'
import { proxyService } from './proxy'
import type { NpmProvider } from './proxy/providers/npm'
import type { ProxyHostView } from './proxy/types'
import { wizardStore } from './catalogue-store'
import { installMark } from './catalogue-installer'
import { auditOrThrow } from './audit'
import { getProviderCredentials, deleteProviderCredentials, itemName } from './credentials'
import { getSite, forgetSite, realPublishDeps, type PublishLedger, type SiteRecord } from './sites'
import { metricsStore } from './site-metrics/store'
import type { ProxyHostInfo, SiteDeleteDeps } from './site-delete'

const info = (h: ProxyHostView): ProxyHostInfo => ({
  instanceId: h.instanceId, instanceName: h.instanceName, kind: h.kind, id: String(h.id), domains: h.domains,
  ...(h.tls?.kind === 'certificate' && h.tls.certificateId ? { certificateId: String(h.tls.certificateId) } : {}),
  readOnly: h.readOnly, ...(h.readOnlyReason ? { readOnlyReason: h.readOnlyReason } : {}),
})

async function npmOf(instanceId: string): Promise<NpmProvider['client']> {
  const { provider } = await proxyService().provider(instanceId)
  if (provider.kind !== 'npm') throw new Error('Only Nginx Proxy Manager certificates are removed here.')
  return (provider as NpmProvider).client
}

const certNum = (v: unknown): string | null => (typeof v === 'number' && v > 0 ? String(v) : null)

async function jobRow(site: SiteRecord): Promise<any | null> {
  if (!site.jobId || site.jobId === 'adopted') return null
  const r = await wizardStore().get(site.jobId).catch(() => null)
  return r?.kind === 'job' ? r.data : null
}

export function realSiteDeleteDeps(): SiteDeleteDeps {
  const publish = realPublishDeps()
  return {
    dns: publish.dns,
    proxy: {
      async hosts() {
        const svc = proxyService()
        // Fresh: a host made or removed in the last twenty seconds must not be missed or shown.
        for (const i of await svc.listInstances()) svc.invalidate(i.id)
        const r = await svc.allHosts()
        return { hosts: r.hosts.map(info), errors: r.errors.map(e => ({ instanceName: e.instanceName, error: e.error })) }
      },
      async instanceHosts(instanceId) {
        const svc = proxyService()
        svc.invalidate(instanceId)
        return (await svc.hosts(instanceId)).map(info)
      },
      async deleteHost(instanceId, hostId, actor) {
        await publish.proxy.deleteHost(instanceId, hostId, actor)
        proxyService().invalidate(instanceId)
      },
      async certificateUsers(instanceId) {
        const npm = await npmOf(instanceId)
        // All four or nothing: a list that cannot be read must not look like "unused".
        const [proxy, redirect, dead, streams] = await Promise.all([npm.getProxyHosts(), npm.getRedirectionHosts(), npm.getDeadHosts(), npm.getStreams()])
        return [
          ...proxy.map(h => ({ hostKind: 'proxy', id: String(h.id), certificateId: certNum((h as any).certificate_id) })),
          ...redirect.map(h => ({ hostKind: 'redirection', id: String(h.id), certificateId: certNum(h.certificate_id) })),
          ...dead.map(h => ({ hostKind: '404', id: String(h.id), certificateId: certNum(h.certificate_id) })),
          ...streams.map(h => ({ hostKind: 'stream', id: String(h.id), certificateId: certNum(h.certificate_id) })),
        ]
      },
      async certificates(instanceId) {
        const npm = await npmOf(instanceId)
        return (await npm.getCertificates()).map(c => ({ id: String(c.id), names: c.domain_names }))
      },
      async deleteCertificate(instanceId, certId) {
        if (!/^\d+$/.test(certId)) throw new Error('That is not a certificate id.')
        await (await npmOf(instanceId)).deleteCertificate(Number(certId))
        await proxyService().audit('proxy.certificate.delete', `proxy:${instanceId}`, { id: certId }).catch(() => {})
      },
    },
    // Sites live on the home cluster, whichever cluster the page is showing; the client is fetched per call, so a
    // lock (which clears the token) or a changed setting is never served from a stale one.
    guest: {
      pve: {
        fetchStrict: (path: string, method?: string, body?: string, timeoutMs?: number) => homePve().fetchStrict(path, method, body, timeoutMs),
        waitForTask: (node: string, upid: string, opts?: Parameters<ProxmoxClient['waitForTask']>[2]) => homePve().waitForTask(node, upid, opts),
      } as unknown as ProxmoxClient,
      // The NAS mount clean-up finds the node on the home cluster, with the home login and a pinned key only.
      afterDestroy: g => pbsMountCleanup(g, homeNodeRunner({ pve: homePve() })),
    },
    async ledger(site) {
      if (site.published) return site.published
      return ((await jobRow(site))?.ledger as PublishLedger | undefined) ?? null
    },
    async hostname(site) {
      if (site.hostname) return site.hostname
      const job = await jobRow(site)
      if (job?.hostname) return String(job.hostname)
      // Installs from before the hostname was kept on the job still name it in their first step.
      for (const st of Array.isArray(job?.steps) ? job.steps : []) {
        const m = /^Create CT \d+ \(([a-z0-9-]{1,63})\) on /.exec(String(st?.label ?? ''))
        if (m) return m[1]
      }
      return null
    },
    installMark,
    async vaultCreatedByInstall(site) {
      const v = (await jobRow(site))?.vaultItem
      return v && typeof v.createdByJob === 'boolean' ? v.createdByJob : null
    },
    vaultKeys: async (category, provider) => {
      const f = await getProviderCredentials(category, provider)
      return Object.keys(f).filter(k => f[k]).sort()
    },
    deleteVault: (category, provider) => deleteProviderCredentials(category, provider),
    vaultName: itemName,
    site: getSite,
    forget: forgetSite,
    deleteMetrics: id => metricsStore().deleteSite(id),
    metricsLeft: async id => (await metricsStore().getState(id)) !== null,
    audit: auditOrThrow,
    now: Date.now,
  }
}
