// =============================================================================
//  HyperProx — the Arr Stack recipe for the catalogue
//
//  Kept apart from the install glue (catalogue.ts here), so the catalogue's list
//  of recipes does not load the publishing code it uses.
// =============================================================================

import type { CatalogueRecipe, RecipeOption } from '../catalogue'
import { DETECT } from '../catalogue-detect'
import { APPS, DEFAULT_SELECTION, totals } from './components'
import { ARR_SCRIPT } from './compose'
import { LAYOUT_LINE } from './storage'

export const ARR_RECIPE_ID = 'arr-stack'

const bool = (key: string, label: string, def: boolean): RecipeOption => ({ key, label, kind: 'boolean', default: def ? '1' : '0' })

/** Read by the wizard's own picker (ArrPicker), not shown as plain settings. Checked again here, whatever sends them. */
export const ARR_OPTIONS: RecipeOption[] = [
  ...APPS.map(a => bool(a.option, a.name, a.default)),
  bool('ARR_VPN', 'Send qBittorrent through a VPN', false),
  { key: 'ARR_VPN_PROVIDER', label: 'VPN provider', kind: 'text', maxLength: 40 },
  { key: 'ARR_VPN_TYPE', label: 'VPN type', kind: 'text', default: 'wireguard', maxLength: 10 },
  { key: 'ARR_VPN_COUNTRIES', label: 'VPN countries', kind: 'text', maxLength: 200 },
  { key: 'ARR_MEDIA', label: 'Library location', kind: 'text', default: 'disk', maxLength: 10 },
  { key: 'ARR_MEDIA_GB', label: 'Library disk size (GB)', kind: 'number', default: '200', min: 10, max: 100_000 },
  { key: 'ARR_NFS_HOST', label: 'NAS address', kind: 'text', maxLength: 253 },
  { key: 'ARR_NFS_EXPORT', label: 'NFS export', kind: 'text', maxLength: 300 },
  { key: 'ARR_HOST_PATH', label: 'Folder on the node', kind: 'text', maxLength: 300 },
  { key: 'ARR_DOWNLOADS', label: 'Downloads', kind: 'text', default: 'together', maxLength: 10 },
  { key: 'ARR_DOWNLOAD_GB', label: 'Room for downloads (GB)', kind: 'number', default: '100', min: 10, max: 100_000 },
  { key: 'ARR_ADMIN_USER', label: 'Sign-in name', kind: 'username', maxLength: 32,
    hint: 'One sign-in for every app. Blank makes one up; the password is always generated.' },
]

export const ARR_RECIPE: CatalogueRecipe = {
  id: ARR_RECIPE_ID,
  detect: DETECT[ARR_RECIPE_ID],
  name: 'Arr Stack',
  summary: 'Sonarr, Radarr, Prowlarr and qBittorrent (and more if you want), in one container, set up and connected to each other for you.',
  category: 'media',
  satisfies: { kind: 'plugin', id: 'arrstack', setting: 'sonarr_url' },
  port: 8989,
  healthPath: '/ping',
  expectStatus: [200],
  needsDocker: true,
  defaults: { ...totals(DEFAULT_SELECTION), swapMb: 512 },
  minimum: { cores: 1, memoryMb: 1024, diskGb: 10 },
  firstRun: { kind: 'env-admin', passwordEnv: 'ARR_ADMIN_PASSWORD', user: 'admin', userOption: 'ARR_ADMIN_USER' },
  firstLogin: 'One sign-in for every app, made up for you: the password is generated, kept in the vault and shown once after the install. The API keys are in the same vault item.',
  notes: [
    LAYOUT_LINE,
    'Not automatic, because only you have them: your indexers (add them once in Prowlarr), a Usenet provider\'s login for SABnzbd, and Bazarr\'s subtitle languages.',
    'The container is unprivileged, with nesting and keyctl for Docker, set on its node through the node login.',
  ],
  wizard: false,
  options: ARR_OPTIONS,
  install: { kind: 'script', script: ARR_SCRIPT },
  stack: 'arr',
}
