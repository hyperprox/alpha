// =============================================================================
//  HyperProx — the transcoders' docker-compose files and install script
//
//  Four shapes, one script:
//    unmanic          Unmanic with the library mounted at /data/media
//    unmanic-worker   an Unmanic that takes work from another one (no library: files travel to it)
//    tdarr            Tdarr's server and one node of its own, library at /data/media
//    tdarr-node       a Tdarr node for a server somewhere else, library at the same path
//
//  Rules every file follows (the same ones the Arr Stack's compose file follows):
//    * images pinned to one release, never `latest`;
//    * the same PUID/PGID as the Arr Stack, so files written here have the owner
//      the Arr Stack's apps expect;
//    * /data mounted at /data: the library is /data/media, the same string the
//      Arr Stack and a media server use. Tdarr compares the server's and node's
//      paths as literal text, so they must be the same everywhere;
//    * scratch space (Unmanic's cache, Tdarr's /temp) on the container's own disk,
//      never in the library: a transcode writes its whole output there first;
//    * nothing secret in the file, no public name, no host networking beyond the
//      one case Tdarr needs (a remote node the server must call back).
// =============================================================================

import { PUID, PGID } from '../arr/components'
import type { Accel } from './hardware'

export type TcKind = 'unmanic' | 'unmanic-worker' | 'tdarr' | 'tdarr-node'

export const UNMANIC_IMAGE = 'josh5/unmanic:0.4.1'
/** Tdarr's server and nodes must be the same version, or the node is refused with no hint. */
export const TDARR_VERSION = '2.86.01'
export const tdarrImages = (v: string) => ({ server: `ghcr.io/haveagitgat/tdarr:${v}`, node: `ghcr.io/haveagitgat/tdarr_node:${v}` })

/**
 * SHA-256 of NVIDIA's driver installer for each version HyperProx may put in a container. The installer runs as root,
 * so it is checked against a hash pinned here, never against a file fetched from the same host. A version is added by
 * a maintainer: download the .run from https://download.nvidia.com/XFree86/Linux-x86_64/<v>/NVIDIA-Linux-x86_64-<v>.run
 * on a trusted machine, run sha256sum on it, and add the line.
 */
export const NVIDIA_RUN_SHA256: Record<string, string> = {
  // Downloaded once by hand from download.nvidia.com and hashed with sha256sum (398312209 bytes), 2026-11-12.
  '580.173.02': '8d8eb9001e05a9a8a663d3d5d304feb64ef2844ee185ccdfd952786820f46e1b',
}

export const UNMANIC_PORT = 8888
export const TDARR_WEB_PORT = 8265
export const TDARR_SERVER_PORT = 8266
export const TDARR_NODE_PORT = 8267

export const APP_DIR: Record<TcKind, string> = {
  unmanic: '/opt/unmanic', 'unmanic-worker': '/opt/unmanic', tdarr: '/opt/tdarr', 'tdarr-node': '/opt/tdarr',
}
/** Folders under the app's directory, owned by the apps' user. `cache` and `temp` are the scratch space. */
export const APP_SUBDIRS: Record<TcKind, string[]> = {
  unmanic: ['config', 'cache'], 'unmanic-worker': ['config', 'cache'],
  tdarr: ['server', 'configs', 'logs', 'temp'], 'tdarr-node': ['configs', 'logs', 'temp'],
}

export interface ComposeInput {
  kind: TcKind
  accel: Accel
  /** Numeric ids added to the app's groups so it may open the GPU's device files. */
  groups?: number[]
  /** tdarr-node: where the server is, and what this node tells the server to call it back on. */
  server?: { host: string; port: number }
  nodeIp?: string
  nodeName?: string
  /** The Tdarr release to run: the server's own, so the two match. */
  version?: string
}

const q = (v: string) => JSON.stringify(v)
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/
const HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/
const VERSION = /^\d{1,2}\.\d{1,3}\.\d{1,3}$/

function hardwareLines(accel: Accel, groups: number[]): { lines: string[]; env: string[] } {
  if (accel === 'vaapi') {
    return {
      // The whole directory: the container holds only the render node(s) it was given.
      lines: ['    devices:', '      - /dev/dri:/dev/dri', ...(groups.length ? ['    group_add:', ...groups.map(g => `      - ${q(String(g))}`)] : [])],
      env: [],
    }
  }
  if (accel === 'nvidia') {
    return { lines: ['    runtime: nvidia'], env: ['NVIDIA_VISIBLE_DEVICES=all', 'NVIDIA_DRIVER_CAPABILITIES=compute,video,utility'] }
  }
  return { lines: [], env: [] }
}

const LOGGING = ['    logging:', '      driver: json-file', '      options:', '        max-size: "10m"', '        max-file: "3"']

function unmanic(i: ComposeInput): string[] {
  const hw = hardwareLines(i.accel, i.groups ?? [])
  const env = [`PUID=${PUID}`, `PGID=${PGID}`, 'TZ=${TZ:-Etc/UTC}', ...hw.env]
  return [
    '  unmanic:', `    image: ${UNMANIC_IMAGE}`, '    container_name: unmanic', '    restart: unless-stopped',
    '    ports:', `      - "${UNMANIC_PORT}:${UNMANIC_PORT}"`,
    '    environment:', ...env.map(e => `      - ${q(e)}`),
    '    volumes:', '      - ./config:/config', '      - ./cache:/tmp/unmanic', ...(i.kind === 'unmanic' ? ['      - /data:/data'] : []),
    ...hw.lines, ...LOGGING,
  ]
}

function tdarrServer(v: string): string[] {
  const env = [`PUID=${PUID}`, `PGID=${PGID}`, 'UMASK_SET=002', 'TZ=${TZ:-Etc/UTC}', 'serverIP=0.0.0.0', `serverPort=${TDARR_SERVER_PORT}`,
    `webUIPort=${TDARR_WEB_PORT}`, 'internalNode=false', 'inContainer=true']
  return [
    '  tdarr:', `    image: ${tdarrImages(v).server}`, '    container_name: tdarr', '    restart: unless-stopped',
    '    ports:', `      - "${TDARR_WEB_PORT}:${TDARR_WEB_PORT}"`, `      - "${TDARR_SERVER_PORT}:${TDARR_SERVER_PORT}"`,
    '    environment:', ...env.map(e => `      - ${q(e)}`),
    // The library at /data (read-write: Tdarr replaces files in place), and the scratch folder the node shares.
    '    volumes:', '      - ./server:/app/server', '      - ./configs:/app/configs', '      - ./logs:/app/logs', '      - /data:/data', '      - ./temp:/temp',
    ...LOGGING,
  ]
}

function tdarrNode(i: ComposeInput, v: string, local: boolean): string[] {
  const hw = hardwareLines(i.accel, i.groups ?? [])
  const name = i.nodeName ?? 'node'
  const env = [`PUID=${PUID}`, `PGID=${PGID}`, 'UMASK_SET=002', 'TZ=${TZ:-Etc/UTC}', `nodeName=${name}`, 'inContainer=true',
    `serverIP=${local ? 'tdarr' : i.server!.host}`, `serverPort=${local ? TDARR_SERVER_PORT : i.server!.port}`,
    ...(local ? [] : [`nodeIP=${i.nodeIp}`, `nodePort=${TDARR_NODE_PORT}`]), ...hw.env]
  return [
    '  tdarr-node:', `    image: ${tdarrImages(v).node}`, '    container_name: tdarr-node', '    restart: unless-stopped',
    // A remote node answers the server on its own address, so it needs the container's network, not a Docker one.
    ...(local ? ['    depends_on:', '      - tdarr'] : ['    network_mode: host']),
    '    environment:', ...env.map(e => `      - ${q(e)}`),
    '    volumes:', '      - ./configs:/app/configs', '      - ./logs:/app/logs',
    '      - /data:/data', '      - ./temp:/temp',
    ...hw.lines, ...LOGGING,
  ]
}

/** The compose file for a shape. Every value that is not fixed text is checked first. */
export function composeFile(i: ComposeInput): string {
  const v = i.version ?? TDARR_VERSION
  if (!VERSION.test(v)) throw new Error('Bad Tdarr version.')
  for (const g of i.groups ?? []) if (!Number.isInteger(g) || g < 0 || g > 65535) throw new Error('Bad group id.')
  if (i.nodeName !== undefined && !IDENT.test(i.nodeName)) throw new Error('Bad node name.')
  if (i.kind === 'tdarr-node') {
    if (!i.server || !HOST.test(i.server.host) || !Number.isInteger(i.server.port) || i.server.port < 1 || i.server.port > 65535) throw new Error('A Tdarr node needs its server\'s address.')
    if (!i.nodeIp || !HOST.test(i.nodeIp)) throw new Error('A Tdarr node needs its own address to give the server.')
  }
  const body = i.kind === 'tdarr' ? [...tdarrServer(v), ...tdarrNode({ ...i, nodeName: i.nodeName ?? 'local' }, v, true)]
    : i.kind === 'tdarr-node' ? tdarrNode(i, v, false) : unmanic(i)
  return ['# Written by HyperProx. Images are pinned; change a tag here to upgrade one app.', 'services:', ...body].join('\n') + '\n'
}

/**
 * The install script. Every value arrives as an exported variable: the compose file base64 encoded (so nothing in
 * it is ever read as shell). It prints no secret because there is none: neither app takes a login here.
 */
export const TC_SCRIPT = String.raw`umask 022
. /etc/os-release
if [ "$ID" = ubuntu ]; then COMPOSE_PKG=docker-compose-v2; else COMPOSE_PKG=docker-compose; fi
apt-get update -qq
apt-get install -y -qq ca-certificates curl docker.io "$COMPOSE_PKG"
systemctl enable --now docker

as_puid() { setpriv --reuid=$TC_PUID --regid=$TC_PGID --clear-groups "$@"; }

# The library: made as the apps' own user first (a NAS may squash root), and only made by root when that fails.
# Nothing is ever deleted here, and a folder that exists is left alone.
if [ "$TC_LIBRARY" = 1 ]; then
  # A folder that was already there (a NAS, a folder the person chose) is never re-owned.
  if [ ! -d /data ]; then mkdir -p /data; chown $TC_PUID:$TC_PGID /data 2>/dev/null || true; fi
  for d in /data/media; do
    [ -d "$d" ] && continue
    as_puid mkdir -p "$d" 2>/dev/null || { mkdir -p "$d" && chown $TC_PUID:$TC_PGID "$d"; }
  done
  # These apps replace files in place, so a library they cannot write is no use: say so now, not after the first job.
  if ! as_puid sh -c 'f=/data/media/.hyperprox-write-test && : > "$f" && rm -f "$f"'; then
    echo "The apps' user (uid $TC_PUID) cannot write to /data/media. On a NAS or a host folder, let uid $((100000 + TC_PUID)) write there." >&2
    exit 4
  fi
fi

mkdir -p "$TC_APP_DIR" && cd "$TC_APP_DIR"
for d in $TC_SUBDIRS; do mkdir -p "$d"; done
chown -R $TC_PUID:$TC_PGID $TC_SUBDIRS

# NVIDIA: the node's driver is the node's. Only the user-space libraries are matched here, to exactly its version.
if [ "$TC_ACCEL" = nvidia ]; then
  apt-get install -y -qq gnupg kmod
  if ! nvidia-smi -L >/dev/null 2>&1; then
    n=0
    until curl -fsSL -o /tmp/nvidia.run "https://download.nvidia.com/XFree86/Linux-x86_64/$TC_NVIDIA_VERSION/NVIDIA-Linux-x86_64-$TC_NVIDIA_VERSION.run"; do
      n=$((n + 1)); [ "$n" -ge 3 ] && { echo "Could not download NVIDIA's libraries for version $TC_NVIDIA_VERSION." >&2; exit 7; }
      sleep 10
    done
    # The installer runs as root: only the exact file whose hash is pinned in HyperProx is run.
    echo "$TC_NVIDIA_SHA256  /tmp/nvidia.run" | sha256sum -c - || { rm -f /tmp/nvidia.run; echo "checksum mismatch" >&2; exit 7; }
    sh /tmp/nvidia.run --silent --no-kernel-module --no-kernel-module-source --no-drm --no-x-check --no-nouveau-check --no-install-compat32-libs || { echo "NVIDIA's libraries did not install." >&2; exit 7; }
    rm -f /tmp/nvidia.run
  fi
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update -qq
  apt-get install -y -qq nvidia-container-toolkit
  nvidia-ctk runtime configure --runtime=docker
  # In a container the device cgroups belong to the node, not to Docker.
  sed -i 's/^#\?no-cgroups *=.*/no-cgroups = true/' /etc/nvidia-container-runtime/config.toml
  systemctl restart docker
  nvidia-smi -L >/dev/null || { echo "The NVIDIA card does not answer inside the container (driver $TC_NVIDIA_VERSION)." >&2; exit 7; }
fi

printf '%s' "$TC_COMPOSE_B64" | base64 -d > docker-compose.yml
{ printf "TZ='%s'\n" "$(cat /etc/timezone 2>/dev/null || echo Etc/UTC)"; } > .env

# One image at a time, each retried: registries turn away a burst of parallel pulls ("toomanyrequests").
for s in $(docker compose config --services); do
  n=0
  until docker compose pull --quiet "$s"; do
    n=$((n + 1)); [ "$n" -ge 5 ] && { echo "Could not download the image for $s." >&2; exit 6; }
    sleep $((n * 15))
  done
done
docker compose up -d
echo "$TC_NAME is starting."`

export interface ScriptInput extends ComposeInput {
  /** Whether /data/media is mounted here, so the write test runs. */
  library: boolean
  nvidiaVersion?: string
  name: string
}

/** The variables TC_SCRIPT reads. */
export function scriptEnv(i: ScriptInput): Record<string, string> {
  if (i.accel === 'nvidia' && !/^\d{3}\.\d{2,3}(\.\d{2})?$/.test(i.nvidiaVersion ?? '')) throw new Error('The NVIDIA driver version is missing or not a version.')
  const sha = i.accel === 'nvidia' ? NVIDIA_RUN_SHA256[i.nvidiaVersion!] : ''
  if (i.accel === 'nvidia' && !/^[0-9a-f]{64}$/.test(sha ?? '')) throw new Error(`NVIDIA driver ${i.nvidiaVersion} has no pinned checksum, so its installer is not run.`)
  if (!/^[A-Za-z][A-Za-z ]{0,30}$/.test(i.name)) throw new Error('Bad app name.')
  const b64 = (v: string) => Buffer.from(v, 'utf8').toString('base64')
  return {
    TC_PUID: String(PUID), TC_PGID: String(PGID), TC_NAME: i.name, TC_LIBRARY: i.library ? '1' : '0',
    TC_ACCEL: i.accel, TC_NVIDIA_VERSION: i.accel === 'nvidia' ? i.nvidiaVersion! : '', TC_NVIDIA_SHA256: sha ?? '',
    TC_APP_DIR: APP_DIR[i.kind], TC_SUBDIRS: APP_SUBDIRS[i.kind].join(' '),
    TC_COMPOSE_B64: b64(composeFile(i)),
  }
}

export const STOP_SCRIPT = (kind: TcKind) => `cd ${APP_DIR[kind]} && docker compose stop >/dev/null 2>&1 && echo "@@stopped apps"\n`
