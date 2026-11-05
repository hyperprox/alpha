// =============================================================================
//  HyperProx — WireGuard server: a Catalogue recipe (not registered here)
//
//  Recipe only: the Catalogue wizard's integrator adds it to CATALOGUE and,
//  after the install, calls WireguardService.adoptServer({ machineId, address,
//  endpoint }) so the VPN page manages it. The server key is made inside the
//  container by `wg genkey` and never leaves it; HyperProx reads only the
//  public half. WireGuard speaks UDP, so there is no HTTP health check: the
//  adopt step (which reads `wg show`) is the check.
// =============================================================================

import type { CatalogueRecipe } from '../../catalogue'

export const WIREGUARD_SERVER_RECIPE: CatalogueRecipe = {
  id: 'wireguard-server',
  name: 'WireGuard server',
  summary: 'A small WireGuard VPN server for phones, laptops and other machines, managed from the VPN page.',
  category: 'apps',
  port: 51820,
  healthPath: '',
  expectStatus: [],
  needsDocker: false,
  defaults: { cores: 1, memoryMb: 256, diskGb: 2 },
  minimum: { cores: 1, memoryMb: 128, diskGb: 1 },
  firstLogin: 'Nothing to sign in to: add peers on the VPN page, which shows a QR code for each phone or laptop.',
  notes: [
    'Forward UDP 51820 on your router to this container, or choose another port with WG_PORT.',
    'Set WG_ADDRESS to the tunnel network for this server (for example 100.64.13.1/24); it must not overlap your LAN or cluster networks.',
    'The container\'s key is made inside it and never leaves it.',
  ],
  firstRun: { kind: 'none' },
  wizard: false,
  packages: { debian: ['wireguard-tools', 'iproute2'], ubuntu: ['wireguard-tools', 'iproute2'] },
  install: {
    kind: 'script',
    script: [
      'set -e',
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update -qq && apt-get install -y -qq wireguard-tools iproute2',
      ': "${WG_ADDRESS:?set WG_ADDRESS, e.g. 100.64.13.1/24}"',
      'WG_PORT="${WG_PORT:-51820}"',
      'case "$WG_ADDRESS$WG_PORT" in *[!0-9./]*) echo "WG_ADDRESS or WG_PORT is not valid" >&2; exit 2 ;; esac',
      'umask 077 && mkdir -p /etc/wireguard',
      '[ -s /etc/wireguard/hp-wg0.key ] || wg genkey > /etc/wireguard/hp-wg0.key',
      'printf "# Managed by HyperProx. Changes here are overwritten.\\n[Interface]\\nAddress = %s\\nListenPort = %s\\nPostUp = wg set %%i private-key /etc/wireguard/hp-wg0.key\\n" "$WG_ADDRESS" "$WG_PORT" > /etc/wireguard/hp-wg0.conf',
      'mkdir -p /etc/sysctl.d && printf "net.ipv4.ip_forward = 1\\n" > /etc/sysctl.d/99-hyperprox-hp-wg0.conf && sysctl -q -p /etc/sysctl.d/99-hyperprox-hp-wg0.conf || true',
      'systemctl enable --now wg-quick@hp-wg0',
      'echo "HP_WG_PUB=$(wg show hp-wg0 public-key)"',
    ].join('\n'),
  },
}
