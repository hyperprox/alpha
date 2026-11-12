// =============================================================================
//  HyperProx — the Arr Stack's docker-compose.yml and install script
//
//  The compose file is built for exactly the apps the person picked. Each app:
//    * an image pinned to one release (components.ts), never `latest`;
//    * the same PUID/PGID, so every file in /data has one owner;
//    * /data mounted at /data, so every app sees the same paths and a finished
//      download can be hardlinked into the library;
//    * its settings in /opt/arr/config/<app>.
//  With the VPN, qBittorrent shares Gluetun's network, so every byte it sends
//  goes through the tunnel or nowhere: if the tunnel drops, qBittorrent has no
//  network at all (Gluetun's own kill switch). Its web page is published on
//  Gluetun, and the other apps reach it as gluetun:8080.
//
//  Nothing secret is written into the compose file. The VPN's credentials go in
//  /opt/arr/.env (mode 600, root only), which Compose reads for ${...}.
// =============================================================================

import { APPS, GLUETUN_IMAGE, PUID, PGID, has, type ArrAppId, type Selection } from './components'
import { mountTarget, type Layout } from './storage'

export const ARR_DIR = '/opt/arr'

export interface VpnSettings {
  provider: string
  type: 'wireguard' | 'openvpn'
  /** Comma-separated countries Gluetun picks a server in; empty lets it choose. */
  countries?: string
  portForwarding: boolean
}

/** Where qBittorrent answers inside the Docker network: on Gluetun's network when the VPN is on. */
export const qbitHost = (s: Selection) => (s.vpn ? 'gluetun' : 'qbittorrent')

const q = (v: string) => JSON.stringify(v)

function block(id: ArrAppId, s: Selection, layoutMounts: string[]): string[] {
  const a = APPS.find(x => x.id === id)!
  const out = [`  ${id}:`, `    image: ${a.image}`, `    container_name: ${id}`, '    restart: unless-stopped']
  const env = id === 'seerr' || id === 'flaresolverr'
    ? [`TZ=\${TZ:-Etc/UTC}`, 'LOG_LEVEL=info']
    : [`PUID=${PUID}`, `PGID=${PGID}`, `TZ=\${TZ:-Etc/UTC}`, 'UMASK=002', ...(id === 'qbittorrent' ? ['WEBUI_PORT=8080', 'TORRENTING_PORT=6881'] : [])]
  // Seerr and FlareSolverr are not linuxserver images: they take the user from Compose instead of PUID/PGID.
  if (id === 'seerr' || id === 'flaresolverr') out.push(`    user: "${PUID}:${PGID}"`)
  if (id === 'seerr') out.push('    init: true')
  out.push('    environment:', ...env.map(e => `      - ${e}`))
  const vols = [
    ...(id === 'flaresolverr' ? [] : [id === 'seerr' ? `./config/${id}:/app/config` : `./config/${id}:/config`]),
    ...(['sonarr', 'radarr', 'lidarr', 'bazarr', 'qbittorrent', 'sabnzbd'].includes(id) ? layoutMounts : []),
  ]
  if (vols.length) out.push('    volumes:', ...vols.map(v => `      - ${v}`))
  if (id === 'qbittorrent' && s.vpn) {
    out.push('    network_mode: "service:gluetun"', '    depends_on:', '      gluetun:', '        condition: service_healthy')
  } else if (!a.internal) {
    // FlareSolverr is internal: only Prowlarr uses it, over the Docker network, so it gets no port at all.
    const ports = [`${a.hostPort}:${a.port}`, ...(id === 'qbittorrent' ? ['6881:6881', '6881:6881/udp'] : [])]
    out.push('    ports:', ...ports.map(p => `      - ${q(p)}`))
  }
  return out
}

function gluetun(s: Selection, v: VpnSettings): string[] {
  const env = [
    'VPN_SERVICE_PROVIDER=${VPN_SERVICE_PROVIDER:?the installer sets this}',
    `VPN_TYPE=${v.type}`,
    ...(v.type === 'wireguard'
      ? ['WIREGUARD_PRIVATE_KEY=${WIREGUARD_PRIVATE_KEY:?the installer sets this}', 'WIREGUARD_ADDRESSES=${WIREGUARD_ADDRESSES:-}']
      : ['OPENVPN_USER=${OPENVPN_USER:?the installer sets this}', 'OPENVPN_PASSWORD=${OPENVPN_PASSWORD:?the installer sets this}']),
    ...(v.countries ? ['SERVER_COUNTRIES=${SERVER_COUNTRIES:-}'] : []),
    // The LAN may reach qBittorrent's page through the tunnel's firewall; nothing else gets in.
    'FIREWALL_OUTBOUND_SUBNETS=${LAN_SUBNET:-}',
    `TZ=\${TZ:-Etc/UTC}`,
    ...(v.portForwarding ? [
      'VPN_PORT_FORWARDING=on',
      // Each time the provider hands out a port, qBittorrent is told to listen on it (from inside the shared network).
      'VPN_PORT_FORWARDING_UP_COMMAND=/bin/sh -c \'wget -O- -q --retry-connrefused --post-data "json={\\"listen_port\\":{{PORTS}}}" http://127.0.0.1:8080/api/v2/app/setPreferences\'',
    ] : []),
  ]
  return [
    '  gluetun:', `    image: ${GLUETUN_IMAGE}`, '    container_name: gluetun', '    restart: unless-stopped',
    '    cap_add:', '      - NET_ADMIN', '    devices:', '      - /dev/net/tun:/dev/net/tun',
    '    environment:', ...env.map(e => `      - ${q(e)}`),
    '    volumes:', '      - ./config/gluetun:/gluetun',
    '    ports:', '      - "8080:8080"',
  ]
}

/** The compose file for a selection. `vpn` must be given when the selection has the VPN on. */
export function composeFile(s: Selection, layout: Pick<Layout, 'downloads'>, vpn?: VpnSettings): string {
  if (s.vpn && !vpn) throw new Error('The VPN is on but its settings are missing.')
  if (s.vpn && !has(s, 'qbittorrent')) throw new Error('The VPN only covers qBittorrent.')
  // One mount of /data for every app that touches files. With downloads on the container's own disk, /data is
  // the container's folder and only /data/media is the library's mount; Docker sees the same either way.
  void mountTarget(layout)
  const mounts = ['/data:/data']
  const lines = ['# Written by HyperProx. Images are pinned; change a tag here to upgrade one app.', 'services:']
  if (s.vpn) lines.push(...gluetun(s, vpn!))
  for (const a of APPS) if (has(s, a.id)) lines.push(...block(a.id, s, mounts))
  return lines.join('\n') + '\n'
}

/** The apps the install starts. Seerr waits until setup can sign it in, so nobody else can claim it first. */
export function startServices(s: Selection): string[] {
  return [...(s.vpn ? ['gluetun'] : []), ...s.apps.filter(id => id !== 'seerr')]
}

/** The folders under /data each layout needs, created as PUID so the apps can write them. */
export function dataDirs(s: Selection): string[] {
  const kinds = ['tv', 'movies', 'music']
  const out = ['/data/media', ...kinds.map(k => `/data/media/${k}`)]
  if (has(s, 'qbittorrent')) out.push('/data/torrents', ...kinds.map(k => `/data/torrents/${k}`))
  if (has(s, 'sabnzbd')) out.push('/data/usenet', '/data/usenet/incomplete', '/data/usenet/complete', ...kinds.map(k => `/data/usenet/complete/${k}`))
  return out
}

/**
 * The install script. Every value arrives as an exported variable: the compose file and the folder list base64
 * encoded (so nothing in them is ever read as shell), the VPN's secrets as plain variables that go only into
 * .env. It never prints a secret.
 */
export const ARR_SCRIPT = String.raw`umask 022
# The generated sign-in is set through each app's own API after it starts; the script does not need it.
unset ARR_ADMIN_PASSWORD
. /etc/os-release
if [ "$ID" = ubuntu ]; then COMPOSE_PKG=docker-compose-v2; else COMPOSE_PKG=docker-compose; fi
apt-get update -qq
apt-get install -y -qq ca-certificates curl docker.io "$COMPOSE_PKG"
systemctl enable --now docker

as_puid() { setpriv --reuid=$ARR_PUID --regid=$ARR_PGID --clear-groups "$@"; }

# /data and its folders. On a NAS root may not be allowed to write (root squash), so each folder is made as the
# apps' own user first, and only made by root and handed over when that fails.
mkdir -p /data
chown $ARR_PUID:$ARR_PGID /data 2>/dev/null || true
for d in $(printf '%s' "$ARR_DIRS_B64" | base64 -d); do
  [ -d "$d" ] && continue
  as_puid mkdir -p "$d" 2>/dev/null || { mkdir -p "$d" && chown $ARR_PUID:$ARR_PGID "$d"; }
done
for d in /data /data/media; do
  if ! as_puid sh -c "f=$d/.hyperprox-write-test && : > \"\$f\" && rm -f \"\$f\""; then
    echo "The apps' user (uid $ARR_PUID) cannot write to $d. On a NAS or a host folder, let uid $((100000 + ARR_PUID)) write there." >&2
    exit 4
  fi
done

mkdir -p /opt/arr && cd /opt/arr
for a in $ARR_CONFIG_DIRS; do mkdir -p "config/$a"; done
chown -R $ARR_PUID:$ARR_PGID config
# Gluetun runs as root (it changes the network), and keeps its own folder.
[ -d config/gluetun ] && chown -R root:root config/gluetun

printf '%s' "$ARR_COMPOSE_B64" | base64 -d > docker-compose.yml
umask 077
# Every value single-quoted, so Compose takes it literally ($ stays $); a ' inside is written as \' .
envq() { printf "%s='%s'\n" "$1" "$(printf '%s' "$2" | sed "s/'/\\\\'/g")"; }
{
  envq TZ "$(cat /etc/timezone 2>/dev/null || echo Etc/UTC)"
  if [ "$ARR_VPN" = 1 ]; then
    envq LAN_SUBNET "$(ip -4 -o route show dev eth0 scope link | awk '{print $1}' | head -n1)"
    envq VPN_SERVICE_PROVIDER "$ARR_VPN_PROVIDER"
    [ -n "$ARR_VPN_COUNTRIES" ] && envq SERVER_COUNTRIES "$ARR_VPN_COUNTRIES"
    [ -n "$VPN_WIREGUARD_PRIVATE_KEY" ] && envq WIREGUARD_PRIVATE_KEY "$VPN_WIREGUARD_PRIVATE_KEY"
    [ -n "$VPN_WIREGUARD_ADDRESSES" ] && envq WIREGUARD_ADDRESSES "$VPN_WIREGUARD_ADDRESSES"
    [ -n "$VPN_OPENVPN_USER" ] && envq OPENVPN_USER "$VPN_OPENVPN_USER"
    [ -n "$VPN_OPENVPN_PASSWORD" ] && envq OPENVPN_PASSWORD "$VPN_OPENVPN_PASSWORD"
  fi
  # A false test above must not end the group with a failure (set -e).
  :
} > .env
umask 022
unset VPN_WIREGUARD_PRIVATE_KEY VPN_OPENVPN_PASSWORD

# One image at a time, each retried: registries turn away a burst of parallel pulls ("toomanyrequests").
for s in $(docker compose config --services); do
  n=0
  until docker compose pull --quiet "$s"; do
    n=$((n + 1)); [ "$n" -ge 5 ] && { echo "Could not download the image for $s." >&2; exit 6; }
    sleep $((n * 15))
  done
done
docker compose up -d $ARR_START
echo "The Arr Stack is starting: $ARR_START."`

/** The variables ARR_SCRIPT reads, apart from the VPN secrets (vpnEnv) and the options. */
export function scriptEnv(s: Selection, layout: Pick<Layout, 'downloads'>, vpn?: VpnSettings): Record<string, string> {
  const b64 = (v: string) => Buffer.from(v, 'utf8').toString('base64')
  return {
    ARR_PUID: String(PUID), ARR_PGID: String(PGID),
    ARR_COMPOSE_B64: b64(composeFile(s, layout, vpn)),
    ARR_DIRS_B64: b64(dataDirs(s).join('\n')),
    ARR_CONFIG_DIRS: [...s.apps.filter(a => a !== 'flaresolverr'), ...(s.vpn ? ['gluetun'] : [])].join(' '),
    ARR_START: startServices(s).join(' '),
  }
}

/** The VPN's secrets as the script reads them. Values are one line each; a newline would end the .env entry. */
export function vpnEnv(secrets: Record<string, string>): Record<string, string> {
  const one = (k: string) => String(secrets[k] ?? '').replace(/[\r\n]/g, '')
  return {
    VPN_WIREGUARD_PRIVATE_KEY: one('wireguard_private_key'), VPN_WIREGUARD_ADDRESSES: one('wireguard_addresses'),
    VPN_OPENVPN_USER: one('openvpn_user'), VPN_OPENVPN_PASSWORD: one('openvpn_password'),
  }
}
