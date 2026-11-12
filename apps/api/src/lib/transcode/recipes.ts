// =============================================================================
//  HyperProx — the transcoders' catalogue recipes: Unmanic and Tdarr
//
//  Four recipes, two apps:
//    unmanic          Unmanic, library mounted, GPU picked per node
//    unmanic-worker   another Unmanic that takes work from the first (its
//                     "remote installation"); no library, files travel to it
//    tdarr            Tdarr's server and one node of its own, one container
//    tdarr-node       a Tdarr node for the server on another cluster node
//
//  Kept apart from the install glue (catalogue.ts here), so the catalogue's list
//  of recipes does not load the code that reaches nodes and apps.
// =============================================================================

import type { CatalogueRecipe, RecipeOption } from '../catalogue'
import { DETECT } from '../catalogue-detect'
import { TC_SCRIPT, TDARR_VERSION } from './compose'
import { LAYOUT_LINE } from './media'

export const UNMANIC_ID = 'unmanic'
export const UNMANIC_WORKER_ID = 'unmanic-worker'
export const TDARR_ID = 'tdarr'
export const TDARR_NODE_ID = 'tdarr-node'
export const TRANSCODE_IDS = [UNMANIC_ID, UNMANIC_WORKER_ID, TDARR_ID, TDARR_NODE_ID] as const

const bool = (key: string, label: string, def: boolean, hint?: string): RecipeOption => ({ key, label, kind: 'boolean', default: def ? '1' : '0', ...(hint ? { hint } : {}) })

/** Read by the wizard's own picker (TranscodePicker), not shown as plain settings. Checked again here, whatever sends them. */
export const ACCEL_OPTIONS: RecipeOption[] = [
  { key: 'TC_ACCEL', label: 'Hardware acceleration', kind: 'text', default: 'auto', maxLength: 8,
    hint: 'Automatic looks at the node you pick (step 3) and uses its Intel or AMD graphics, else its NVIDIA card, else the CPU.' },
  // Set by the preview only (a request's own value is dropped): the node's NVIDIA driver version the container must match.
  { key: 'TC_NVIDIA_VERSION', label: 'NVIDIA driver version', kind: 'text', maxLength: 16 },
]

export const MEDIA_OPTIONS: RecipeOption[] = [
  { key: 'TC_MEDIA', label: 'Library location', kind: 'text', default: 'disk', maxLength: 10 },
  { key: 'TC_MEDIA_GB', label: 'Library disk size (GB)', kind: 'number', default: '200', min: 10, max: 100_000 },
  { key: 'TC_NFS_HOST', label: 'NAS address', kind: 'text', maxLength: 253 },
  { key: 'TC_NFS_EXPORT', label: 'NFS export', kind: 'text', maxLength: 300 },
  { key: 'TC_HOST_PATH', label: 'Folder on the node', kind: 'text', maxLength: 300 },
]

const MAIN_URL: RecipeOption = { key: 'TC_MAIN_URL', label: 'Address of the main one', kind: 'text', required: true, maxLength: 100 }

const ONE_APP_NOTE = 'No sign-in: this app has none in this version, so anyone on your network can open it and change what it does to your files. HyperProx gives it no public name and no port forward; keep it that way.'

/** Rules across the options, after each passed its own kind. The library and the node's hardware are checked in the preview. */
export function checkTcOptions(v: Record<string, string>, o: { library: boolean; workers?: boolean; main?: boolean }): string[] {
  const errors: string[] = []
  if (!['auto', 'vaapi', 'nvidia', 'cpu'].includes(v.TC_ACCEL || 'auto')) errors.push('Hardware acceleration is automatic, Intel/AMD, NVIDIA or CPU only.')
  if (o.library && !['disk', 'nfs', 'path'].includes(v.TC_MEDIA || 'disk')) errors.push('Pick where the library goes: a new disk, a NAS, or a folder on the node.')
  if (o.main && !parseMainUrl(v.TC_MAIN_URL ?? '', 8888)) errors.push('The address of the main one is its IP address or name and port, like 10.0.0.30:8888.')
  return errors
}

/** `10.0.0.30`, `10.0.0.30:8888` or `http://nas.lan:8888/`, as `{ host, port }`. Anything else is not an address. */
export function parseMainUrl(raw: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(?:http:\/\/)?((?:\d{1,3}(?:\.\d{1,3}){3})|(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*))(?::(\d{1,5}))?\/?$/.exec(String(raw ?? '').trim())
  if (!m) return null
  const port = m[2] ? Number(m[2]) : defaultPort
  if (port < 1 || port > 65535) return null
  // Never HyperProx's own machine or an address that is not a real peer: this address is requested by HyperProx.
  if (/^(localhost|localhost\.localdomain|ip6-localhost)$/i.test(m[1])) return null
  if (/^\d+(\.\d+){3}$/.test(m[1])) { const [a, b] = m[1].split('.').map(Number); if (a === 127 || a === 0 || (a === 169 && b === 254)) return null }
  if (/^\d+(\.\d+){3}$/.test(m[1]) && m[1].split('.').some(x => Number(x) > 255)) return null
  return { host: m[1], port }
}

export const UNMANIC_OPTIONS: RecipeOption[] = [
  ...ACCEL_OPTIONS, ...MEDIA_OPTIONS,
  { key: 'UNMANIC_WORKERS', label: 'Workers', kind: 'number', default: '2', min: 1, max: 16,
    hint: 'How many files are converted at once. Two suits a GPU; on the CPU one worker already uses every core.' },
  bool('UNMANIC_SCAN', 'Scan the library on a schedule', true, 'Looks for new files once a day. Nothing is changed until you enable a plug-in in Unmanic.'),
]

export const UNMANIC_RECIPE: CatalogueRecipe = {
  id: UNMANIC_ID,
  detect: DETECT[UNMANIC_ID],
  name: 'Unmanic',
  summary: 'Converts your video library to a smaller format (for example HEVC) in the background, using your GPU, one file at a time.',
  category: 'media',
  satisfies: { kind: 'plugin', id: 'unmanic', setting: 'url' },
  port: 8888,
  healthPath: '/unmanic/api/v2/workers/status',
  expectStatus: [200],
  needsDocker: true,
  wantsGpu: true,
  defaults: { cores: 4, memoryMb: 4096, diskGb: 40, swapMb: 512 },
  minimum: { cores: 2, memoryMb: 2048, diskGb: 16 },
  firstRun: { kind: 'none' },
  firstLogin: 'No sign-in: Unmanic has none. It is open to your network only; HyperProx gives it no public name.',
  notes: [
    LAYOUT_LINE,
    'Hardware is looked at on the node you pick: Intel or AMD graphics (VAAPI), an NVIDIA card whose driver is already on the node, or the CPU. HyperProx never installs or changes a driver on a node.',
    'The scratch space for conversions is on the container\'s own disk (step 2), never in your library: size it to at least twice your largest file.',
    'Unmanic replaces files in place, so the library must be writable by the container\'s user (uid 1000 inside; 101000 on the node and on a NAS). The preview tests this on a folder and the install tests it again.',
    'A first library called Media points at /data/media with no plug-in enabled, so nothing about your files changes until you choose a plug-in in Unmanic. Its free tier allows two libraries.',
    'More workers on other nodes are the Unmanic worker entry: the files travel over the network to them and back.',
    ONE_APP_NOTE,
  ],
  wizard: false,
  options: UNMANIC_OPTIONS,
  install: { kind: 'script', script: TC_SCRIPT },
  stack: 'transcode',
  checkOptions: v => checkTcOptions(v, { library: true }),
}

export const UNMANIC_WORKER_RECIPE: CatalogueRecipe = {
  id: UNMANIC_WORKER_ID,
  name: 'Unmanic worker',
  summary: 'An extra Unmanic on another node that takes conversion jobs from your main Unmanic, using that node\'s own GPU.',
  category: 'media',
  satisfies: { kind: 'plugin', id: 'unmanic', setting: 'url' },
  port: 8888,
  healthPath: '/unmanic/api/v2/workers/status',
  expectStatus: [200],
  needsDocker: true,
  wantsGpu: true,
  defaults: { cores: 4, memoryMb: 4096, diskGb: 40, swapMb: 512 },
  minimum: { cores: 2, memoryMb: 2048, diskGb: 16 },
  firstRun: { kind: 'none' },
  firstLogin: 'No sign-in: Unmanic has none. It is open to your network only.',
  notes: [
    'This is what Unmanic calls a remote installation. Your main Unmanic sends a file to the worker, the worker converts it on its own hardware, and the result comes back and replaces the original. So the worker needs no library of its own, but every file crosses the network twice: on a 1 Gb network that can be the limit, and it shares the link with anything else on the node.',
    'Pick a node with a GPU you are not using for anything else. HyperProx links both sides for you: the main one sends, this one receives.',
    'The main one is changed once, to add this worker. If the install fails and you clean it up, only that one link is removed, and only if this install made it. Removing a worker later does not remove its link on the main Unmanic: delete it there, under Settings, Link remote installation.',
    ONE_APP_NOTE,
  ],
  wizard: false,
  options: [
    ...ACCEL_OPTIONS, MAIN_URL,
    { key: 'UNMANIC_WORKERS', label: 'Workers', kind: 'number', default: '2', min: 1, max: 16 },
  ],
  install: { kind: 'script', script: TC_SCRIPT },
  stack: 'transcode',
  checkOptions: v => checkTcOptions(v, { library: false, main: true }),
}

export const TDARR_OPTIONS: RecipeOption[] = [...ACCEL_OPTIONS, ...MEDIA_OPTIONS]

export const TDARR_RECIPE: CatalogueRecipe = {
  id: TDARR_ID,
  detect: DETECT[TDARR_ID],
  name: 'Tdarr',
  summary: 'Converts and tidies your video library on a schedule you control: a server that hands jobs to nodes, with one node set up beside it.',
  category: 'media',
  port: 8265,
  healthPath: '/',
  expectStatus: [200],
  healthBody: { contains: ['Tdarr'] },
  needsDocker: true,
  wantsGpu: true,
  defaults: { cores: 4, memoryMb: 6144, diskGb: 40, swapMb: 512 },
  minimum: { cores: 2, memoryMb: 3072, diskGb: 16 },
  firstRun: { kind: 'none' },
  firstLogin: 'No sign-in: Tdarr has none by default. It is open to your network only; HyperProx gives it no public name.',
  notes: [
    'One container, two apps: the Tdarr server (web page on 8265, nodes connect on 8266) and a node that does the work, with the GPU. The server itself does no encoding.',
    LAYOUT_LINE,
    'Tdarr compares the server\'s and a node\'s paths as plain text, so every node must see the library at exactly /data/media. Extra nodes (the Tdarr node entry) are given the same path and the same Tdarr version.',
    'The transcode cache (/temp) is shared by the server and its node and lives on the container\'s own disk, never in your library: size the disk (step 2) to at least twice your largest file.',
    'HyperProx has no Tdarr plug-in yet, so this entry only installs and links to it. Add your library folders (for example /data/media/tv) in Tdarr itself, under Libraries.',
    'Tdarr replaces files in place, so the library must be writable by the container\'s user (uid 1000 inside; 101000 on the node and on a NAS). The preview tests this on a folder and the install tests it again.',
    ONE_APP_NOTE,
  ],
  wizard: false,
  options: TDARR_OPTIONS,
  install: { kind: 'script', script: TC_SCRIPT },
  stack: 'transcode',
  checkOptions: v => checkTcOptions(v, { library: true }),
}

export const TDARR_NODE_RECIPE: CatalogueRecipe = {
  id: TDARR_NODE_ID,
  name: 'Tdarr node',
  summary: 'An extra Tdarr node on another cluster node, using that node\'s own GPU, for the Tdarr server you already run.',
  category: 'media',
  port: 8267,
  healthPath: '/',
  expectStatus: [200, 404],
  needsDocker: true,
  wantsGpu: true,
  defaults: { cores: 4, memoryMb: 4096, diskGb: 40, swapMb: 512 },
  minimum: { cores: 2, memoryMb: 2048, diskGb: 16 },
  firstRun: { kind: 'none' },
  firstLogin: 'No sign-in: nothing to set up. The node registers itself with your Tdarr server.',
  notes: [
    'The node must see the library at exactly /data/media, the same text the server uses. Use the same source for the library as the server\'s: the same NAS export, or a folder that exists on this node at the path you give.',
    `The node runs the server's own Tdarr version (read from the server when it says, otherwise ${TDARR_VERSION}); Tdarr refuses a node of another version without saying why.`,
    'The scratch space (/temp) is on this container\'s own disk, so only the node that does the job writes it.',
    'The node is reached by the server on this container\'s own address, so it uses the container\'s network directly. Nothing else is published.',
    ONE_APP_NOTE,
  ],
  wizard: false,
  options: [...ACCEL_OPTIONS, ...MEDIA_OPTIONS, MAIN_URL, { key: 'TC_VERSION', label: 'Tdarr version', kind: 'text', maxLength: 12 }],
  install: { kind: 'script', script: TC_SCRIPT },
  stack: 'transcode',
  checkOptions: v => checkTcOptions(v, { library: true, main: true }),
}

export const TRANSCODE_RECIPES: CatalogueRecipe[] = [UNMANIC_RECIPE, UNMANIC_WORKER_RECIPE, TDARR_RECIPE, TDARR_NODE_RECIPE]
