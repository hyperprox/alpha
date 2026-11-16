// =============================================================================
//  HyperProx — the package cache's Catalogue recipe (apt-cacher-ng)
//
//  One container that keeps a copy of every Debian and Ubuntu package your
//  guests download, so a package is fetched from the internet once, not once
//  per guest. The Updates feature points guests at it by itself (with a
//  fallback to going direct whenever it does not answer).
//
//    - apt-cacher-ng from Debian 13's own archive, at a pinned version;
//    - unprivileged, listening only on its own LAN address, port 3142;
//    - only the networks picked at install may use it (default: the network the
//      container is on); private networks only, never wider than their block;
//    - the cache on a disk of its own, sized at install (default 50 GB), left out
//      of backups (everything on it can be fetched again);
//    - the admin page's actions need a generated password, kept in the vault.
//  The install finishes with a self-check run in the container, then the
//  plug-in connects by itself (lib/aptcache/setup.ts).
// =============================================================================

import type { CatalogueRecipe } from '../catalogue'
import { checkNetworks } from './net'
import { INSTALL_SCRIPT } from './scripts'
import { ACNG_VERSION, PORT, RECIPE_ID } from './types'

export const DEFAULT_CACHE_GB = 50

/** Checks across the options, after each passed its own kind. */
export function checkAptCacheOptions(values: Record<string, string>): string[] {
  const out: string[] = []
  const nets = checkNetworks(values.ACNG_ALLOW, { allowEmpty: true })
  out.push(...nets.problems.map(p => `Who may use it: ${p}`))
  if (!nets.problems.length) values.ACNG_ALLOW = nets.value
  const gb = Number(values.ACNG_CACHE_GB || DEFAULT_CACHE_GB)
  if (!Number.isInteger(gb) || gb < 5 || gb > 4000) out.push('Cache disk: a whole number of GB between 5 and 4000.')
  return out
}

export const APTCACHE_RECIPE: CatalogueRecipe = {
  id: RECIPE_ID,
  name: 'Package cache (apt-cacher-ng)',
  summary: 'Keeps a copy of every Debian and Ubuntu package your guests download, so when Updates runs each package comes from the internet once, not once per guest. Its plug-in shows how much it saves.',
  category: 'apps',
  port: PORT,
  healthPath: '/',
  // apt-cacher-ng answers its own address with a usage page and status 406: that is it serving.
  expectStatus: [406],
  needsDocker: false,
  defaults: { cores: 1, memoryMb: 512, diskGb: 4, swapMb: 256 },
  minimum: { cores: 1, memoryMb: 256, diskGb: 3 },
  firstRun: { kind: 'env-admin', user: 'admin', passwordEnv: 'ACNG_ADMIN_PASSWORD' },
  firstLogin: 'Nothing to set up: Updates points your guests at it by itself. Its plug-in page shows what it saves.',
  notes: [
    `apt-cacher-ng ${ACNG_VERSION} from Debian 13's own archive.`,
    'Cached: the plain-HTTP Debian and Ubuntu archives, which is what a stock Debian or Ubuntu guest uses (deb.debian.org, security updates, archive.ubuntu.com and their mirrors). Any other plain-HTTP repository is fetched directly by each guest.',
    'Not cached: HTTPS repositories (Docker, NodeSource and the like). Guests keep fetching those directly; a client that sends one through the cache gets a tunnel to port 443 instead.',
    'It listens only on its own LAN address, and only the networks you pick can use it. HyperProx refuses to install it on a public address.',
    'The cache sits on a disk of its own, left out of backups: everything on it can be downloaded again.',
    'Updates uses it only for the Debian and Ubuntu archives and only when it answers: a dead cache never stops an update, and a sick one (full, failing its check) is skipped once HyperProx notices.',
    'Through the cache, guests reach only the package archives it knows. An HTTPS tunnel goes only to a host name on port 443, never to an address written as numbers; a name that resolves to an address on your network is not refused by apt-cacher-ng, but only your allowed networks can ask.',
  ],
  wizard: false,
  setup: 'aptcache',
  options: [
    { key: 'ACNG_CACHE_GB', label: 'Cache disk (GB)', kind: 'number', default: String(DEFAULT_CACHE_GB), min: 5, max: 4000,
      hint: 'A disk of its own for the cached packages. 50 GB holds a few releases of Debian and Ubuntu updates; grow it later from the plug-in page.' },
    { key: 'ACNG_ALLOW', label: 'Who may use it (networks)', kind: 'text', maxLength: 600, placeholder: '10.0.5.0/24',
      hint: 'Blank: only the network this container is on. Private networks only, written as the network (10.0.5.0/24, not 10.0.5.7/24), separated by commas.' },
    { key: 'ACNG_REPORT', label: 'Admin page on your network', kind: 'boolean', default: '1',
      hint: 'apt-cacher-ng\'s own statistics page, for the networks above. Its actions always need the password, which is kept in the vault. Off: only HyperProx\'s helper can reach it.' },
  ],
  checkOptions: checkAptCacheOptions,
  install: { kind: 'script', script: INSTALL_SCRIPT },
}
