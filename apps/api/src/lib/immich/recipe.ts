// =============================================================================
//  HyperProx — Immich as a catalogue recipe
//
//  Your own photo and video library, like Google Photos: Immich's server, its machine-learning service (search,
//  faces), PostgreSQL with the vector extension Immich needs, and Valkey, in Docker in one unprivileged container.
//
//  What this file owns is the recipe's shape: the questions, the pinned versions, the compose file and the install
//  script. The wizard's checks of the node's hardware and the library live in preview.ts, the chores after the install
//  (the administrator, HyperProx's API key, hardware transcoding) in setup.ts, the plug-in's reads and fixes in
//  service.ts. Everything is built on what the Unmanic and Tdarr recipes already do: the node's hardware, the library
//  (a new disk, a NAS export or a folder on the node) and the NVIDIA libraries are the same code, not a copy.
// =============================================================================

import { PUID, PGID } from '../arr/components'
import { NVIDIA_RUN_SHA256, NVIDIA_USERLAND_SCRIPT } from '../transcode/compose'
import type { NodeHardware, Accel } from '../transcode/hardware'
import type { CatalogueRecipe, RecipeOption } from '../catalogue'
import { DETECT } from '../catalogue-detect'

export const IMMICH_RECIPE_ID = 'immich'
/** The release this install runs. A newer release is an upgrade the person chooses (the plug-in says when one exists). */
export const IMMICH_VERSION = 'v3.4.2'
export const IMMICH_PORT = 2283
export const IMMICH_DIR = '/opt/immich'
/** Where the photos are inside the container: under the library mount (/data). */
export const IMMICH_UPLOAD_DIR = '/data/immich'

/** Both images are the ones in Immich's own compose file for this release, pinned by digest. */
export const VALKEY_IMAGE = 'docker.io/valkey/valkey:9@sha256:418652cfb58ef879d4978c33553735d7147016032d5aefaa14c828e611eb9dfd'
export const POSTGRES_IMAGE = 'ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23'

/**
 * Exactly what the plug-in calls, and nothing else: server.statistics and server.versionCheck (the numbers and the update),
 * queue.read (the queues), queue.update (pause and resume a queue) and job.create. That last one is the permission Immich asks for
 * on its deprecated PUT /jobs/{name}, the only call that clears FAILED jobs (the newer DELETE /queues/{name}/jobs empties the whole
 * queue, waiting jobs included). It is a pity to hold a scope that can also start jobs, but the plug-in only ever sends clear-failed.
 * Nothing here reads or changes a photo.
 */
export const IMMICH_KEY_PERMISSIONS = ['server.statistics', 'server.versionCheck', 'queue.read', 'queue.update', 'job.create'] as const

export const IMMICH_OPTIONS: RecipeOption[] = [
  { key: 'IMMICH_ADMIN_EMAIL', label: 'Administrator email', kind: 'email', required: true, placeholder: 'you@example.com',
    hint: 'The first account, and the administrator. Immich signs in with an email address. The password is generated and kept in the vault.' },
  { key: 'IMMICH_ADMIN_NAME', label: 'Administrator name', kind: 'text', default: 'Administrator', maxLength: 60 },
  { key: 'IMMICH_LIBRARY', label: 'Where the photos live', kind: 'text', default: 'disk',
    choices: [
      { value: 'disk', label: 'A new disk for photos, on the cluster storage' },
      { value: 'nfs', label: 'A folder on a NAS (NFS)' },
      { value: 'path', label: 'A folder that already exists on the node (a mounted share, CephFS or a CIFS share)' },
    ],
    hint: 'A new disk is the simplest. A NAS or an existing share keeps your photos off the cluster storage; HyperProx checks it from the node before anything is made.' },
  { key: 'IMMICH_LIBRARY_GB', label: 'New photo disk size (GB)', kind: 'number', showWhen: { key: 'IMMICH_LIBRARY', value: 'disk' }, default: '200', min: 10, max: 100000, hint: 'Only for a new disk. Photos and videos are the big part: plan for what you have and then some. It can be grown later.' },
  { key: 'IMMICH_NFS_HOST', label: 'NAS address', kind: 'text', showWhen: { key: 'IMMICH_LIBRARY', value: 'nfs' }, maxLength: 253, placeholder: 'nas.example.lan', hint: 'Only for a NAS folder.' },
  { key: 'IMMICH_NFS_EXPORT', label: 'NAS export', kind: 'text', showWhen: { key: 'IMMICH_LIBRARY', value: 'nfs' }, maxLength: 253, placeholder: '/photos', hint: 'Only for a NAS folder. Immich writes to an "immich" folder inside it.' },
  { key: 'IMMICH_HOST_PATH', label: 'Folder on the node', kind: 'text', showWhen: { key: 'IMMICH_LIBRARY', value: 'path' }, maxLength: 253, placeholder: '/mnt/shares/photos', hint: 'Only for an existing folder. Immich writes to an "immich" folder inside it.' },
  { key: 'TC_NVIDIA_VERSION', label: 'NVIDIA driver version', kind: 'text', maxLength: 16, hidden: true },
  { key: 'IMMICH_FFMPEG', label: 'Video conversion', kind: 'text', maxLength: 16, hidden: true },
  { key: 'IMMICH_INTEL', label: 'Intel graphics', kind: 'boolean', default: '0', hidden: true },
  { key: 'IMMICH_ACCEL', label: 'Hardware acceleration', kind: 'text', default: 'cpu',
    choices: [
      { value: 'cpu', label: 'None (the processor does it all)' },
      { value: 'vaapi', label: 'Intel or AMD graphics on the node' },
      { value: 'nvidia', label: 'An NVIDIA card on the node' },
    ],
    hint: 'Speeds up video conversion and face and search recognition. Only the hardware the chosen node really has is accepted.' },
]

/** The accelerations as the transcoders name them. 'cpu' stays 'cpu'. */
export const accelOf = (v: Record<string, string>): Accel => (v.IMMICH_ACCEL === 'vaapi' || v.IMMICH_ACCEL === 'nvidia' ? v.IMMICH_ACCEL : 'cpu')

/** The transcoders' own option names for the library, so their layout and probe code is used as it stands. */
export function asTranscodeOptions(v: Record<string, string>): Record<string, string> {
  return {
    TC_MEDIA: v.IMMICH_LIBRARY || 'disk', TC_MEDIA_GB: v.IMMICH_LIBRARY_GB ?? '', TC_NFS_HOST: v.IMMICH_NFS_HOST ?? '',
    TC_NFS_EXPORT: v.IMMICH_NFS_EXPORT ?? '', TC_HOST_PATH: v.IMMICH_HOST_PATH ?? '',
    TC_ACCEL: v.IMMICH_ACCEL || 'cpu', TC_NVIDIA_VERSION: v.TC_NVIDIA_VERSION ?? '',
  }
}

/** Cross-option rules, after each option passed its own kind. */
export function checkImmichOptions(v: Record<string, string>): string[] {
  const out: string[] = []
  if (v.IMMICH_LIBRARY === 'nfs' && (!v.IMMICH_NFS_HOST || !v.IMMICH_NFS_EXPORT)) out.push('A NAS folder needs the NAS address and the export.')
  if (v.IMMICH_LIBRARY === 'path' && !v.IMMICH_HOST_PATH) out.push('An existing folder needs its path on the node.')
  return out
}

/** Does the node's graphics look like Intel's? Immich's recognition and conversion each have an Intel and an AMD way. */
export const isIntel = (hw: Pick<NodeHardware, 'vaapi'>) => !!hw.vaapi?.names.some(n => /intel/i.test(n))

/** What Immich is told to use for video conversion, by what the node has. */
export function ffmpegAccel(accel: Accel, hw: Pick<NodeHardware, 'vaapi'>): 'disabled' | 'nvenc' | 'qsv' | 'vaapi' {
  return accel === 'nvidia' ? 'nvenc' : accel === 'vaapi' ? (isIntel(hw) ? 'qsv' : 'vaapi') : 'disabled'
}

const q = (v: string) => JSON.stringify(v)

export interface ComposeInput {
  accel: Accel
  /** The render group's number, so the apps may open the graphics device. */
  groups?: number[]
  /** Intel graphics: recognition runs on it too (OpenVINO). AMD's recognition build needs a different device, so it stays on the CPU. */
  intel?: boolean
}

/** Immich's compose file. Every secret is read from the private .env beside it, never written into this file. */
export function composeFile(i: ComposeInput): string {
  for (const g of i.groups ?? []) if (!Number.isInteger(g) || g < 0 || g > 65535) throw new Error('Bad group id.')
  const vaapi = i.accel === 'vaapi', nvidia = i.accel === 'nvidia'
  const mlTag = nvidia ? `${IMMICH_VERSION}-cuda` : vaapi && i.intel ? `${IMMICH_VERSION}-openvino` : IMMICH_VERSION
  const groups = i.groups?.length ? ['    group_add:', ...i.groups.map(g => `      - ${q(String(g))}`)] : []
  const dri = ['    devices:', '      - /dev/dri:/dev/dri', ...groups]
  const hwServer = vaapi ? dri : nvidia ? ['    runtime: nvidia'] : []
  const hwMl = (vaapi && i.intel) ? dri : nvidia ? ['    runtime: nvidia'] : []
  const nvEnv = (caps: string) => nvidia ? ['      NVIDIA_VISIBLE_DEVICES: all', `      NVIDIA_DRIVER_CAPABILITIES: ${caps}`] : []
  const logging = ['    logging:', '      driver: json-file', '      options:', '        max-size: "10m"', '        max-file: "3"']
  return [
    '# Written by HyperProx. Immich\'s server and machine-learning images are pinned by version tag (IMMICH_VERSION in .env); PostgreSQL and Valkey by digest. To upgrade, change the version in .env, then `docker compose pull && docker compose up -d`.',
    'name: immich', 'services:',
    '  immich-server:', '    container_name: immich_server', `    image: ghcr.io/immich-app/immich-server:\${IMMICH_VERSION}`,
    // The same user as the other library apps (uid 1000 in the container), so a NAS or a folder is written as one owner.
    `    user: "${PUID}:${PGID}"`,
    '    volumes:', `      - ${IMMICH_UPLOAD_DIR}:/data`, '      - /etc/localtime:/etc/localtime:ro',
    '    environment:', '      DB_HOSTNAME: database', '      DB_USERNAME: postgres', '      DB_PASSWORD: ${DB_PASSWORD}', '      DB_DATABASE_NAME: immich', '      REDIS_HOSTNAME: redis',
    ...nvEnv('compute,video,utility'),
    '    ports:', `      - "${IMMICH_PORT}:${IMMICH_PORT}"`,
    '    depends_on:', '      - redis', '      - database', '    restart: always', ...hwServer, ...logging,
    '  immich-machine-learning:', '    container_name: immich_machine_learning', `    image: ghcr.io/immich-app/immich-machine-learning:${mlTag.replace(IMMICH_VERSION, '${IMMICH_VERSION}')}`,
    `    user: "${PUID}:${PGID}"`,
    '    volumes:', '      - ./model-cache:/cache',
    '    environment:', '      MACHINE_LEARNING_MODEL_REVISION: v2', '      MPLCONFIGDIR: /cache/matplotlib', '      HF_XET_CACHE: /cache/huggingface-xet', ...nvEnv('compute,utility'),
    '    restart: always', ...hwMl, ...logging,
    '  redis:', '    container_name: immich_redis', `    image: ${VALKEY_IMAGE}`,
    '    healthcheck:', '      test: redis-cli ping | grep -q PONG || exit 1', '    restart: always', ...logging,
    '  database:', '    container_name: immich_postgres', `    image: ${POSTGRES_IMAGE}`,
    '    environment:', '      POSTGRES_PASSWORD: ${DB_PASSWORD}', '      POSTGRES_USER: postgres', '      POSTGRES_DB: immich', "      POSTGRES_INITDB_ARGS: '--data-checksums'",
    '    volumes:', '      - ./postgres:/var/lib/postgresql/data',
    '    shm_size: 128mb', '    restart: always', ...logging,
  ].join('\n') + '\n'
}

/**
 * The install script. The compose file arrives base64 encoded (nothing in it is read as shell); the database password
 * goes into a private .env, never a command line. The photo folder is made as the apps' own user first (a NAS may
 * squash root). No secret is printed.
 */
export const IMMICH_SCRIPT = String.raw`umask 022
. /etc/os-release
if [ "$ID" = ubuntu ]; then COMPOSE_PKG=docker-compose-v2; else COMPOSE_PKG=docker-compose; fi
apt-get update -qq
apt-get install -y -qq ca-certificates curl docker.io "$COMPOSE_PKG"
systemctl enable --now docker

as_puid() { setpriv --reuid=$TC_PUID --regid=$TC_PGID --clear-groups "$@"; }

if [ ! -d /data ]; then mkdir -p /data; chown $TC_PUID:$TC_PGID /data 2>/dev/null || true; fi
[ -d /data/immich ] || as_puid mkdir -p /data/immich 2>/dev/null || { mkdir -p /data/immich && chown $TC_PUID:$TC_PGID /data/immich; }
if ! as_puid sh -c 'f=/data/immich/.hyperprox-write-test && : > "$f" && rm -f "$f"'; then
  echo "The photo folder is not writable by uid $TC_PUID. On a NAS or a node folder, let uid $((100000 + TC_PUID)) write there." >&2
  exit 4
fi

mkdir -p ${IMMICH_DIR} && cd ${IMMICH_DIR}
mkdir -p postgres model-cache
chown $TC_PUID:$TC_PGID model-cache

${NVIDIA_USERLAND_SCRIPT}

printf '%s' "$IMMICH_COMPOSE_B64" | base64 -d > docker-compose.yml
( umask 077; { printf 'IMMICH_VERSION=%s\n' "$IMMICH_TAG"; printf 'DB_PASSWORD=%s\n' "$IMMICH_DB_PASSWORD"; } > .env )

# One image at a time, each retried: registries turn away a burst of parallel pulls ("toomanyrequests").
for s in $(docker compose config --services); do
  n=0
  until docker compose pull --quiet "$s"; do
    n=$((n + 1)); [ "$n" -ge 5 ] && { echo "Could not download the image for $s." >&2; exit 6; }
    sleep $((n * 15))
  done
done
docker compose up -d
echo "Immich is starting. The first start builds its database and can take a few minutes."`

/** The variables the script reads, given the node's resolved hardware. The database password comes from the installer's own secrets. */
export function immichScriptEnv(i: ComposeInput & { nvidiaVersion?: string }): Record<string, string> {
  if (i.accel === 'nvidia' && !/^\d{3}\.\d{2,3}(\.\d{2})?$/.test(i.nvidiaVersion ?? '')) throw new Error('The NVIDIA driver version is missing or not a version.')
  const sha = i.accel === 'nvidia' ? NVIDIA_RUN_SHA256[i.nvidiaVersion!] : ''
  if (i.accel === 'nvidia' && !/^[0-9a-f]{64}$/.test(sha ?? '')) throw new Error(`NVIDIA driver ${i.nvidiaVersion} has no pinned checksum, so its installer is not run.`)
  return {
    TC_PUID: String(PUID), TC_PGID: String(PGID), TC_ACCEL: i.accel,
    TC_NVIDIA_VERSION: i.accel === 'nvidia' ? i.nvidiaVersion! : '', TC_NVIDIA_SHA256: sha ?? '',
    IMMICH_TAG: IMMICH_VERSION,
    IMMICH_COMPOSE_B64: Buffer.from(composeFile(i), 'utf8').toString('base64'),
  }
}

export const IMMICH_SETUP_STEPS = [
  { id: 'immich-ready', label: 'Wait for Immich to answer' },
  { id: 'immich-admin', label: 'Make the administrator account' },
  { id: 'immich-key', label: 'Make HyperProx\'s API key and connect the Immich plug-in' },
  { id: 'immich-hw', label: 'Turn on hardware video conversion' },
] as const

export const IMMICH_RECIPE: CatalogueRecipe = {
  id: IMMICH_RECIPE_ID,
  detect: DETECT[IMMICH_RECIPE_ID],
  name: 'Immich',
  summary: 'Your own photo and video library, like Google Photos: backs up your phones, finds people and things in them, and keeps them on your own storage.',
  keywords: ['photos', 'google photos', 'icloud photos', 'pictures', 'videos', 'gallery', 'camera backup', 'phone backup', 'photo backup', 'album', 'faces'],
  category: 'media',
  port: IMMICH_PORT,
  healthPath: '/api/server/ping',
  expectStatus: [200],
  healthBody: { contains: ['pong'] },
  needsDocker: true,
  wantsGpu: true,
  publishable: true,
  // Photos and videos are large and uploads are slow on a phone: no body limit and long timeouts at the proxy.
  proxyAdvanced: 'client_max_body_size 0;\nproxy_read_timeout 600s;\nproxy_send_timeout 600s;\nsend_timeout 600s;\nproxy_request_buffering off;',
  defaults: { cores: 4, memoryMb: 6144, diskGb: 24, swapMb: 1024 },
  minimum: { cores: 2, memoryMb: 4096, diskGb: 16 },
  sizes: { small: { cores: 2, memoryMb: 4096, diskGb: 16 }, medium: { cores: 4, memoryMb: 6144, diskGb: 24 }, large: { cores: 6, memoryMb: 12288, diskGb: 40 } },
  firstRun: {
    kind: 'env-admin', passwordEnv: 'IMMICH_ADMIN_PASSWORD', userEnv: 'IMMICH_ADMIN_USER', user: 'admin', userOption: 'IMMICH_ADMIN_EMAIL',
    secrets: [{ env: 'IMMICH_DB_PASSWORD', vaultKey: 'db_password' }],
  },
  wizard: false,
  firstLogin: 'Sign in with the administrator email you gave. Its password is generated, kept in the vault and shown once after the install. Then install the Immich app on your phone and point it at this address.',
  notes: [
    `Pinned: Immich ${IMMICH_VERSION}, with its own PostgreSQL (the vector extension Immich needs) and Valkey, in ${IMMICH_DIR}. An upgrade is a changed version there, then \`docker compose pull && docker compose up -d\`. The Immich plug-in says when a newer release exists.`,
    'Needs about 4 GB of RAM to run well while it recognises faces and builds search for a large library; the first scan of an existing library can take hours.',
    'The photos are in their own folder (a new disk, a NAS folder or a node folder, as you choose) and are not in the container\'s Proxmox backup when it is a new disk: back the photo disk up on its own.',
    'A public name gets no upload limit and ten-minute timeouts at the proxy, so large videos from a phone go through.',
    'Hardware: video conversion uses the Intel or AMD graphics (or NVIDIA) you pick; face and search recognition uses Intel graphics or NVIDIA. AMD graphics speed up video only.',
  ],
  options: IMMICH_OPTIONS,
  checkOptions: checkImmichOptions,
  setup: 'immich',
  install: { kind: 'script', script: IMMICH_SCRIPT },
}
