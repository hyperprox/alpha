// =============================================================================
//  HyperProx — the background services, built and started in one place
//
//  The composition root for work that runs on its own (timers, a resumed job,
//  a scheduler) rather than in answer to a request. index.ts calls
//  bootstrapServices() once, after the database plug-in and the notification
//  sender are in place and before any route is registered; the routes then
//  only resolve what was built here. A route that is not registered (a test
//  harness, the demo build) no longer decides whether a scheduler runs, and a
//  route registered twice starts nothing twice.
//
//  The demo server (src/demo) and the self-update child
//  (lib/self-update/updater-main.ts) never import this file, so neither runs
//  any of it (test/services-bootstrap.test.ts checks their import graphs).
//
//  START-UP ORDER (kept by the code below; the test asserts it):
//
//   Sources first. Nothing below may enter a guest before these are set: a
//   guest command with no exclusion list fails closed (exclusions_unknown),
//   and Updates refuses every compose project while an owner is unknown.
//    1. exclusions     Remote access's "never look inside" list, given to the
//                      guest guard (lib/guest-guard.ts) and to the features
//                      that keep their own copy: auto-connect, Homepage, Send
//                      files. Only with the database (it lives there); without
//                      it nothing is set and every guest command is refused.
//    2. compose-owners Nextcloud's compose projects, so Updates leaves them to
//                      its guarded update (lib/compose-owners.ts).
//    3. dismissed      Homepage's and Nextcloud's port to auto-connect's
//                      record of what a person disconnected (given here so
//                      neither imports lib/auto-connect: no import cycle).
//    4. updates        The Updates runtime (lib/updates/runtime.ts) is built,
//                      and its read-only sources installed: the assistant's
//                      targets, the check summary, the cluster-rename guard.
//    5. install-hook   A finished Catalogue install makes Homepage look again.
//
//   Then what runs, in the order the routes used to start it:
//    6. nextcloud      Built, and (with the database) an update that was
//                      running when the API stopped is watched again.
//    7. homepage       Auto-sync's timer (each pass skips while locked).
//    8. auto-connect   Its timer, plus a pass on every unlock; each pass
//                      needs an unlocked vault.
//
//   When the server is ready (onReady), as before:
//    9. updates-recover   A job cut off by a restart is paused (the database
//                         needs no vault).
//   10. updates-timers    The home scheduler and the daily check (each tick
//                         skips while locked).
//   11. placement         Load balancing's scheduler: one pass, then every
//                         minute (a pass does nothing while locked).
//
//  On close, everything started here is stopped, in reverse.
//
//  Left where they are for now (each still starts with its route): Remote
//  access's sweep, the VPN rotation sweep and install hand-off, Certificates'
//  recovery and scheduler, self-update's check timer, the guest-config GPU
//  watcher, Send files' copy runner, the QNAP alert poller and the Plex
//  new-items watcher. Their production wiring is still built inside the route
//  files; moving them is the same change, one service at a time.
// =============================================================================

import type { FastifyInstance } from 'fastify'
import { setGuestExclusionSource } from '../guest-guard'
import { PrismaRemoteStore } from '../remote/store'
import { setExclusionSource as setSendExclusionSource } from '../clusters/send-simple'
import { autoConnect, onUnlock, rememberDismissed, setAutoConnectExclusionSource } from '../auto-connect'
import { homepageService, homepageInventoryChanged, setHomepageDismissedPort, setHomepageExclusionSource } from '../homepage'
import { nextcloudService, registerNextcloudComposeOwner, setNextcloudDismissedPort } from '../nextcloud'
import { setDnsBlockerDismissedPort } from '../dns-blocker'
import { onInstallCompleted } from '../catalogue-installer'
import { placementService } from '../placement/production'
import { PrismaStore } from '../updates/store'
import { UpdatesRuntime, setUpdatesRuntime } from '../updates/runtime'
import { broadcast } from '../updates/broadcast'
import { jobLog, type LogLike } from '../log-once'

/** The steps, by name, in the order they run (the list above). */
export type BootStep =
  | 'exclusions' | 'compose-owners' | 'dismissed' | 'updates' | 'install-hook'
  | 'nextcloud' | 'homepage' | 'auto-connect'
  | 'updates-recover' | 'updates-timers' | 'placement'

/**
 * What is built. Production leaves every field out; a test passes fakes (with the same start methods) to boot the
 * same composition without a database, a vault or a cluster.
 */
export interface BootstrapDeps {
  prisma?: unknown
  log: LogLike
  /** Remote access's list. Default: read from the database (no database: none, so every guest command is refused). */
  exclusions?: (() => Promise<string[]>) | null
  /** Registers the plug-ins' compose projects with Updates; returns the undo. Default: Nextcloud's. */
  composeOwners?: () => () => void
  /** Auto-connect's dismissal record. Default: lib/auto-connect rememberDismissed. */
  dismissed?: (plugin: string, key: string, label: string, by: string) => Promise<void>
  updates?: Pick<UpdatesRuntime, 'installSources' | 'recover' | 'start'>
  nextcloud?: { resume(): Promise<void> }
  homepage?: { start(): () => void }
  autoConnect?: { start(onUnlock: (cb: () => void) => void): () => void }
  placement?: { start(): Promise<() => void> }
  /** Registers a callback for every unlock. Default: the vault's. */
  onUnlock?: (cb: () => void) => void
}

export interface BootedServices {
  /** The steps that ran, in order. */
  readonly steps: BootStep[]
}

let booted: { app: FastifyInstance; handle: BootedServices } | null = null

/**
 * Build every background service, set the sources they read, and start them (the timers that ran when the server
 * was ready still start then). Once per process: a second call, from any app, returns the first one's handle and
 * starts nothing. Closing the app that booted stops it all, and a later call boots again.
 */
export function bootstrapServices(app: FastifyInstance, deps: BootstrapDeps): BootedServices {
  if (booted) return booted.handle
  const steps: BootStep[] = []
  const handle: BootedServices = { steps }
  booted = { app, handle }
  const stops: Array<() => void> = []
  const prisma = deps.prisma
  const log = jobLog(deps.log)

  // 1. The exclusion list, before anything that can run a command in a guest.
  steps.push('exclusions')
  const exclusions = deps.exclusions !== undefined
    ? deps.exclusions
    : prisma ? () => new PrismaRemoteStore(prisma as any).listExclusions() : null
  if (exclusions) {
    setGuestExclusionSource(exclusions)
    setAutoConnectExclusionSource(exclusions)
    setHomepageExclusionSource(exclusions)
    setSendExclusionSource(exclusions)
  }

  // 2. Which compose projects belong to a plug-in's own update, before the daily check or a scheduled run reads them.
  steps.push('compose-owners')
  stops.push((deps.composeOwners ?? registerNextcloudComposeOwner)())

  // 3. Auto-connect's dismissal record, for Homepage and Nextcloud.
  steps.push('dismissed')
  const dismissed = deps.dismissed ?? rememberDismissed
  setHomepageDismissedPort((key, label, by) => dismissed('homepage', key, label, by))
  setNextcloudDismissedPort((key, label, by) => dismissed('nextcloud', key, label, by))
  setDnsBlockerDismissedPort((kind, key, label, by) => dismissed(kind, key, label, by))

  // 4. Updates: built, its read-only sources installed; started when the server is ready (below).
  steps.push('updates')
  let updates = deps.updates
  if (!updates) {
    const rt = new UpdatesRuntime({ store: new PrismaStore(prisma as any), emit: broadcast, log })
    setUpdatesRuntime(rt)
    updates = rt
  }
  updates.installSources()

  // 5. A finished Catalogue install changes what is on the cluster: Homepage's auto-sync (when on) looks again.
  steps.push('install-hook')
  stops.push(onInstallCompleted(() => homepageInventoryChanged()))

  // 6. Nextcloud: a detached update from before a restart is watched again at once. Only with the database (or a
  //    test's service): without it there is nothing to resume.
  steps.push('nextcloud')
  const nextcloud = deps.nextcloud ?? (prisma ? nextcloudService(prisma) : null)
  if (nextcloud) void nextcloud.resume().catch(() => {})

  // 7. Homepage's auto-sync timer.
  steps.push('homepage')
  stops.push((deps.homepage ?? homepageService()).start())

  // 8. Auto-connect: its timer, and a pass after every unlock.
  steps.push('auto-connect')
  const unlock = deps.onUnlock ?? onUnlock
  stops.push((deps.autoConnect ?? autoConnect()).start(cb => unlock(() => cb())))

  // 9–11. When the server is ready, as the routes did it: Updates' recovery, then its timers, then load balancing.
  const u = updates
  app.addHook('onReady', async () => {
    steps.push('updates-recover')
    await u.recover()
    steps.push('updates-timers')
    stops.push(u.start())
    steps.push('placement')
    const stopPlacement = await (deps.placement ?? placementService(prisma, deps.log)).start().catch(() => null)
    if (stopPlacement) stops.push(stopPlacement)
  })

  app.addHook('onClose', async () => {
    for (const stop of stops.reverse()) { try { stop() } catch { /* already stopped */ } }
    if (!deps.updates) setUpdatesRuntime(null)
    if (booted?.app === app) booted = null
  })
  return handle
}
