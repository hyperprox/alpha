// Every GET the demo answers. Order matters only where two paths could match the same URL: the first wins.
import type { FixtureRoute, FixtureContext } from './types'
import { CORE, guestOverview, haBadges } from './core'
import { CLUSTERS, isRemote, remoteNodes, remoteGuestOverview, remoteStorage } from './clusters'
import { PLUGIN_ROUTES } from './plugins'
import { NETWORK } from './network'
import { APPS } from './apps'
import { QNAP_ROUTES } from './qnap'
import { SITE_ROUTES } from './sites'
import { PLACEMENT_ROUTES } from './placement'
import { PLUGIN_EXTRA_ROUTES } from './plugins-extra'
import { MEDIA_ROUTES } from './media'
import { UPDATE_ROUTES } from './updates'
import { MISC_ROUTES } from './misc'
import { pveNodes, pveStorage } from './data'

import { PREVIEW_ROUTES } from './previews'

export type { FixtureRoute, FixtureContext }

const ok = (data: unknown) => ({ success: true, data })

/** A remote cluster's page asks the same paths as the home pages, naming the cluster in a header. */
const PER_CLUSTER: FixtureRoute[] = [
  { path: '/api/proxmox/nodes', get: (_p, _q, ctx) => ok(isRemote(ctx) ? remoteNodes() : pveNodes()) },
  { path: '/api/proxmox/storage', get: (_p, _q, ctx) => ok(isRemote(ctx) ? remoteStorage() : pveStorage()) },
  { path: '/api/infra/guest-config/overview', get: (_p, _q, ctx) => ok(isRemote(ctx) ? remoteGuestOverview() : guestOverview()) },
  { path: '/api/ha/badges', get: (_p, _q, ctx) => ok(isRemote(ctx) ? {} : haBadges()) },
]

export const FIXTURES: FixtureRoute[] = [...PREVIEW_ROUTES, ...PER_CLUSTER, ...CORE, ...CLUSTERS, ...QNAP_ROUTES, ...MEDIA_ROUTES, ...PLUGIN_EXTRA_ROUTES, ...PLUGIN_ROUTES, ...PLACEMENT_ROUTES, ...UPDATE_ROUTES, ...MISC_ROUTES, ...NETWORK, ...APPS, ...SITE_ROUTES]
