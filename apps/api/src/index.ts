import 'dotenv/config'
import Fastify from 'fastify'
import cors       from '@fastify/cors'
import helmet     from '@fastify/helmet'
import rateLimit  from '@fastify/rate-limit'
import websocket  from '@fastify/websocket'
import { serverOptions } from './lib/server-options'

import { healthRoute }          from './routes/health'
import { proxmoxRoutes }        from './routes/proxmox'
import { proxyService } from './lib/proxy'
import { proxyRoutes }          from './routes/proxy'
import { dnsRoutes }            from './routes/dns'
import { wsRoutes }             from './routes/ws'
import { settingsRoutes }       from './routes/settings'
import { infrastructureRoutes } from './routes/infrastructure'
import { guestConfigRoutes }    from './routes/guest-config'
import { serviceRoutes }         from './routes/services'
import { networkRoutes }         from './routes/network'
import { prometheusRoutes } from './routes/prometheus'
import { storageRoutes }         from './routes/storage'
import { ollamaRoutes }          from './routes/ollama'
import { aiRoutes }              from './routes/ai'
import { gpuRoutes }             from './routes/gpu'
import { targetsRoutes }         from './routes/targets'
import { setupChecklistRoutes }  from './routes/setup-checklist'
import { setAuditSink, prismaAuditSink } from './lib/audit'
import { watchTargets }          from './lib/targets'
import { enableGrafanaAdminSync } from './lib/grafana-admin'
import { authRoutes }             from './routes/auth'
import { apiTokenRoutes }         from './routes/api-tokens'
import { secretsRoutes }          from './routes/secrets'
import { terminalRoutes }             from './routes/terminal'
import { pluginRoutes }           from './routes/plugins'
import { haControlRoutes }      from './routes/ha-control'
import { qnapRoutes }           from './routes/qnap'
import { catalogueRoutes } from './routes/catalogue'
import { siteRoutes } from './routes/sites'
import { setWizardStore, PrismaWizardStore } from './lib/catalogue-store'
import { restoreWizardState } from './lib/catalogue-installer'
import { terminalWsRoutes }           from './routes/terminal-ws'
import { updatesRoutes, updatesWsRoutes } from './routes/updates'
import { certsRoutes }            from './routes/certs'
import { haRoutes }               from './routes/ha'
import { notifyRoutes }           from './routes/notify'
import { remoteRoutes }           from './routes/remote'
import { vpnRoutes }              from './routes/vpn'
import { monitoringRoutes }       from './routes/monitoring'
import { clusterRoutes }          from './routes/clusters'
import { installClusterContext }  from './lib/clusters/context'
import { setClusterStore, loadClusters } from './lib/clusters/registry'
import { PrismaClusterStore }     from './lib/clusters/store'
import { setJobStore, PrismaJobStore } from './lib/clusters/files'
import { setHomeVerifier }      from './lib/hostkey-verify'
import { verifyHomeHostKeys }   from './lib/setup-checklist'
import { prismaPlugin }         from './plugins/prisma'
import { redisPlugin }          from './plugins/redis'
import { registerGate }         from './lib/gate'
import { attachUnlockState, setStateLogger } from './lib/vault/state'
import { installLockAlerts }    from './lib/vault/lock-alert'
import { setApiTokenStore, PrismaApiTokenStore } from './lib/api-tokens'
import { setNotifyService } from './lib/notify'
import { productionNotifyService } from './lib/notify/service'
import { migrationSettled } from './lib/credentials'
import { loadPolicy as loadUpdatesPolicy } from './lib/updates/policy'
import { loadCertsPolicy } from './lib/certs/policy'
import { productionAlertForwarder } from './lib/alerts/forwarder'

const server = Fastify(serverOptions({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
}))

async function main() {
  await server.register(helmet, { contentSecurityPolicy: false })
  await server.register(cors,   { origin: true })
  await server.register(rateLimit, { max: 200, timeWindow: '1 minute' })
  await server.register(websocket)
  await server.register(prismaPlugin)
  await server.register(redisPlugin)

  // -- Vault gate ---------------------------------------------------------------
  // Replaces the old password guard. Starts locked: every route except /health*
  // and /api/auth/* answers 423 until a vault user signs in. Then 401 without a
  // valid session, 403 below the route's role (lib/roles.ts). There is no
  // switch to turn it off.
  // API tokens (lib/api-tokens.ts) are looked up in the database the rest of the API uses.
  setApiTokenStore(new PrismaApiTokenStore(server.prisma))
  // Credential use (node logins, DNS keys) is audited in the same database: names and outcomes, never values.
  setAuditSink(prismaAuditSink(server.prisma))
  // Grafana's admin password follows the vault (lib/grafana-admin.ts): set on owner/admin sign-in.
  enableGrafanaAdminSync()
  // Proxy instances (lib/proxy): the registry the Proxy page, the wizard and Certificates read through.
  proxyService(server.prisma)
  await registerGate(server)
  // -- Clusters (Command center) ------------------------------------------------
  // The registry is read into memory once; a page for a remote cluster names it per request and the rest of
  // that request runs in its context (lib/clusters/context.ts). After the gate, so locked and signed-out
  // requests are already answered. With no remote cluster added, nothing here changes any request.
  setClusterStore(new PrismaClusterStore(server.prisma))
  await loadClusters().catch(e => server.log.error({ err: e?.message }, '[clusters] could not read the cluster list; only the home cluster is available'))
  installClusterContext(server)
  setJobStore(new PrismaJobStore(server.prisma))
  // A home node's key learned on first use is verified in the background soon after (lib/hostkey-verify.ts).
  setHomeVerifier(by => verifyHomeHostKeys(by, { onlyIfNeeded: true }))

  // -- Catalogue install wizard: previews, jobs and create marks survive a restart -------------
  // A job that was mid-install is marked interrupted, so its half-made container can be cleaned up.
  setWizardStore(new PrismaWizardStore(server.prisma))
  await restoreWizardState().then(
    r => { if (r.interrupted) server.log.warn({ interrupted: r.interrupted }, 'catalogue installs were interrupted by a restart') },
    e => server.log.error({ err: e }, 'could not restore catalogue install state'))

  // -- Notifications (lib/notify) ---------------------------------------------
  // The one sender: channels under Settings → Notifications, an outbox in Postgres. Installed before the
  // routes so Updates and Certificates publish to it from their first job. The old YAML webhooks are still
  // read (as the legacy fallback) until the first Owner sign-in moves them onto channels.
  const notify = productionNotifyService(server.prisma, {
    updatesUrl: () => loadUpdatesPolicy().policy.webhookUrl,
    certsUrl: () => loadCertsPolicy().policy.alerts.webhookUrl ?? undefined,
  }, m => server.log.info(m), () => migrationSettled())
  setNotifyService(notify)
  server.addHook('onClose', async () => notify.stop())

  await server.register(authRoutes,           { prefix: '/api/auth' })
  await server.register(apiTokenRoutes,       { prefix: '/api/auth/tokens' })
  await server.register(secretsRoutes,        { prefix: '/api/secrets' })
  await server.register(healthRoute,          { prefix: '/health' })
  await server.register(proxmoxRoutes,        { prefix: '/api/proxmox' })
  await server.register(proxyRoutes,          { prefix: '/api/proxy' })
  await server.register(dnsRoutes,            { prefix: '/api/dns' })
  await server.register(settingsRoutes,       { prefix: '/api/settings' })
  await server.register(infrastructureRoutes, { prefix: '/api/infra' })
  await server.register(guestConfigRoutes,    { prefix: '/api/infra/guest-config' })
  await server.register(serviceRoutes,         { prefix: '/api/services' })
  await server.register(networkRoutes,         { prefix: '/api/network' })
  await server.register(storageRoutes,         { prefix: '/api/storage' })
  await server.register(prometheusRoutes)
  await server.register(ollamaRoutes, { prefix: '/api/ai' })
  await server.register(aiRoutes,    { prefix: '/api/ai' })
  await server.register(gpuRoutes,   { prefix: '/api/gpu' })
  await server.register(targetsRoutes, { prefix: '/api/targets' })
  await server.register(setupChecklistRoutes, { prefix: '/api/setup-checklist' })
  await server.register(monitoringRoutes, { prefix: '/api/monitoring' })
  await server.register(clusterRoutes,    { prefix: '/api/clusters' })
  await server.register(terminalRoutes,           { prefix: '/api/terminal' })
  await server.register(pluginRoutes,          { prefix: '/api/plugins' })
  await server.register(haControlRoutes,       { prefix: '/api/plugins/home-assistant' })
  await server.register(qnapRoutes,            { prefix: '/api/plugins/qnap' })
  await server.register(catalogueRoutes,      { prefix: '/api/catalogue' })
  await server.register(siteRoutes,           { prefix: '/api/sites' })
  await server.register(updatesRoutes,        { prefix: '/api/updates' })
  await server.register(updatesWsRoutes,      { prefix: '/ws/updates' })
  await server.register(certsRoutes,          { prefix: '/api/certs' })
  await server.register(haRoutes,             { prefix: '/api/ha' })
  await server.register(notifyRoutes,         { prefix: '/api/settings/notifications' })
  await server.register(remoteRoutes,         { prefix: '/api/remote' })
  await server.register(vpnRoutes,            { prefix: '/api/vpn' })
  await server.register(wsRoutes,             { prefix: '/ws' })
  // Terminal sockets live under /ws because nginx proxies upgrades only there.
  await server.register(terminalWsRoutes,         { prefix: '/ws/terminal' })

  // Without a keyholder: always start locked, and clear CLI session dirs a previous process left in
  // /dev/shm. With one (VAULT_KEYHOLDER_SOCKET, set by the hyperprox-api drop-in): carry on unlocked if
  // it holds the state, so a deploy does not lock HyperProx. Then alert if a lock happened while down.
  const vaultLog = { info: (m: string) => server.log.info(m), warn: (m: string) => server.log.warn(m) }
  setStateLogger(vaultLog)
  const alerts = installLockAlerts({ log: vaultLog })
  const attached = await attachUnlockState()
  server.log.info(`[vault] unlock state: ${attached.mode}${attached.mode === 'keyholder' ? (attached.reachable ? ', keyholder reachable' : ', keyholder NOT reachable') : ' (a restart locks)'}`)
  // Seeds the lock channel from LOCK_ALERT_* (file only: no vault, no Postgres needed) before the
  // start-up lock alert below, then starts working the outbox.
  await notify.start()
  await alerts.startupCheck()

  // Prometheus alerts become notifications (lib/alerts/forwarder.ts): once when one fires, once when it clears,
  // and a warning if Prometheus stops answering. Needs no vault secret, so it runs while locked too.
  const alertForwarder = productionAlertForwarder(m => server.log.info(m))
  alertForwarder.start()
  server.addHook('onClose', async () => alertForwarder.stop())

  // Prometheus's node, GPU and Ceph lists keep themselves current: on unlock, then whenever a node joins.
  const stopTargets = watchTargets({ log: m => server.log.info(m) })
  server.addHook('onClose', async () => stopTargets())

  // Credentials move into the vault on the first Owner sign-in (lib/credentials.ts seedFromEnv),
  // not here: while locked there is no vault session to write with.

  const port = Number(process.env.PORT ?? 3002)
  // The installer sets API_BIND=127.0.0.1 so only nginx reaches the API; older installs keep listening everywhere.
  await server.listen({ port, host: process.env.API_BIND || '0.0.0.0' })
  server.log.info(`HyperProx API running on port ${port}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
