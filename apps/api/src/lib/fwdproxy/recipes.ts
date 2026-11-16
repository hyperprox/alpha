// =============================================================================
//  HyperProx — 3proxy, a forward proxy for the Catalogue
//
//  An open forward proxy is an abuse magnet, so it starts shut:
//    - it listens only on the container's own LAN address, and the install is
//      refused when that address is not a private one;
//    - only the networks picked at install may use it (default: the network the
//      container is on), and only private networks can be picked;
//    - every request needs a user and password; the first user's password is
//      generated, kept in the vault and shown once through the vault;
//    - the proxy itself, loopback, link-local and multicast are never reachable,
//      and neither is your own LAN unless you say so;
//    - its HTTP side tunnels only to port 443, SOCKS never to port 25, and at
//      most 256 connections are open at once.
//  The install finishes with a self-check that proves each of those from the
//  proxy itself, then the plug-in connects by itself (lib/fwdproxy/setup.ts).
// =============================================================================

import type { CatalogueRecipe } from '../catalogue'
import { checkNetworks, userProblem } from './net'
import { proxyScript, THREEPROXY_VERSION } from './scripts'

export { THREEPROXY_VERSION }

/** Checks across the options, after each passed its own kind. */
function checkProxyOptions(values: Record<string, string>): string[] {
  const out: string[] = []
  const u = userProblem(values.FP_USER ?? '')
  if (u) out.push(`First proxy user: ${u}`)
  const nets = checkNetworks(values.FP_ALLOW, { allowEmpty: true })
  out.push(...nets.problems.map(p => `Who may use it: ${p}`))
  if (!nets.problems.length) values.FP_ALLOW = nets.value
  if (values.FP_HTTP !== '1' && values.FP_SOCKS !== '1') out.push('Turn on at least one of the HTTP proxy and the SOCKS5 proxy.')
  return out
}

export const THREEPROXY_RECIPE: CatalogueRecipe = {
  id: '3proxy',
  name: '3proxy',
  summary: 'A forward proxy for the devices on your network: HTTP and SOCKS5 from one small container, with sign-in and allowed networks. Its plug-in shows connections per protocol, traffic, refusals and users.',
  category: 'forward-proxy',
  port: 3128,
  healthPath: '/',
  expectStatus: [407],
  needsDocker: false,
  defaults: { cores: 1, memoryMb: 256, diskGb: 3, swapMb: 256 },
  minimum: { cores: 1, memoryMb: 128, diskGb: 2 },
  firstRun: { kind: 'env-admin', user: 'proxyuser', userOption: 'FP_USER', passwordEnv: 'FP_PASSWORD' },
  firstLogin: 'HTTP proxy: this container\'s address, port 3128. SOCKS5: the same address, port 1080 (with "proxy DNS" on where the app offers it). Sign in as the first user; its password is generated, kept in the vault and shown once after the install.',
  notes: [
    `3proxy ${THREEPROXY_VERSION} (the long-term 0.9 line) from the project's own Debian package, checked against its published SHA-256. It runs as an unprivileged user.`,
    'The HTTP side tunnels HTTPS only to port 443; SOCKS never connects to port 25 (mail), the usual abuse. At most 256 connections are open at once.',
    'Sign-in is always required. The first user\'s password is generated and kept in the vault; reveal it there, or on the plug-in page.',
    'It listens only on the container\'s own LAN address. HyperProx refuses to install it on a public address.',
    'Your own network, the proxy itself, loopback and link-local addresses are refused unless you allow your network.',
    'Do not forward a port to it from your router: a proxy reachable from the internet is found and abused within hours.',
  ],
  wizard: false,
  setup: 'fwdproxy',
  options: [
    { key: 'FP_USER', label: 'First proxy user', kind: 'username', required: true, default: 'proxyuser', maxLength: 32,
      hint: 'Lowercase letters, digits, dots, dashes and underscores. Its password is generated and kept in the vault. Add more users on the plug-in page.' },
    { key: 'FP_ALLOW', label: 'Who may use it (networks)', kind: 'text', maxLength: 600, placeholder: '10.0.5.0/24',
      hint: 'Blank: only the network this container is on. Private networks only (inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16), separated by commas.' },
    { key: 'FP_LAN_TARGETS', label: 'Let it reach your own network', kind: 'boolean', default: '0',
      hint: 'Off (recommended): addresses on your LAN are refused, so the proxy cannot be used to get at your other services. The proxy itself, loopback and link-local are always refused.' },
    { key: 'FP_PER_CLIENT', label: 'Figures per user and device', kind: 'boolean', default: '1',
      hint: 'Off: HyperProx shows only totals, 3proxy keeps no client address or user name in its log, and the log written so far is emptied.' },
    { key: 'FP_HTTP', label: 'HTTP proxy on port 3128', kind: 'boolean', default: '1' },
    { key: 'FP_SOCKS', label: 'SOCKS5 proxy on port 1080', kind: 'boolean', default: '1' },
  ],
  checkOptions: checkProxyOptions,
  install: { kind: 'script', script: proxyScript() },
}
