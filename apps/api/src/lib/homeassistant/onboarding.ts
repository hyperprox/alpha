// =============================================================================
//  HyperProx — Home Assistant: the first-run chores, through Home Assistant's own onboarding API
//
//  A fresh Home Assistant waits for its first visitor to make the owner. HyperProx is that visitor: it makes the owner
//  with a generated password (already in the vault: the installer saves it before anything runs), finishes the
//  onboarding steps, sets the home's name, time zone and units (from the node and the wizard), and makes a long-lived
//  access token for HyperProx. The sign-in token used for those requests is not kept. Every request goes to the
//  machine's own address through an injected http and socket factory, so the tests stand in for Home Assistant.
// =============================================================================

import type { Http } from '../arr/setup'
import type { HaSocket } from './ws'
import { HA_PORT } from './recipe'

export const haUrl = (ip: string) => `http://${ip}:${HA_PORT}`
const j = (body: string): any => { try { return JSON.parse(body) } catch { return null } }

export interface OnboardInput {
  ip: string
  name: string
  owner: { name: string; username: string; password: string }
  timeZone: string
  units: 'metric' | 'us_customary'
}

export interface OnboardDeps {
  http: Http
  socket(ip: string, accessToken: string): Promise<HaSocket>
}

/** Is Home Assistant waiting at its first-run page? Its onboarding list answers 200 only until it is finished. */
export async function onboardingState(ip: string, http: Http): Promise<'waiting' | 'finished' | 'down'> {
  const r = await http({ method: 'GET', url: `${haUrl(ip)}/api/onboarding`, timeoutMs: 8000 }).catch(() => null)
  if (!r) return 'down'
  if (r.status === 404) return 'finished'
  if (r.status !== 200) return 'down'
  const steps = j(r.body)
  return Array.isArray(steps) && steps.length && steps.every((s: any) => s?.done === true) ? 'finished' : 'waiting'
}

/** Wait for the first start. Home Assistant OS downloads Home Assistant itself first, so this is long. */
export async function waitForHomeAssistant(ip: string, d: { http: Http; wait(ms: number): Promise<unknown> }, tries = 180): Promise<'waiting' | 'finished' | null> {
  for (let n = 0; n < tries; n++) {
    const s = await onboardingState(ip, d.http)
    if (s !== 'down') return s
    await d.wait(10_000)
  }
  return null
}

/** The owner, the onboarding steps, the home's details, and the token. Returns the token: it goes to the vault and the plug-in at once. */
export async function onboard(i: OnboardInput, d: OnboardDeps): Promise<{ accessToken: string }> {
  const base = haUrl(i.ip)
  const client = `${base}/`
  const u = await d.http({ method: 'POST', url: `${base}/api/onboarding/users`, json: { client_id: client, name: i.owner.name, username: i.owner.username, password: i.owner.password, language: 'en' }, timeoutMs: 30_000 })
  const code = u.status === 200 ? j(u.body)?.auth_code : null
  if (typeof code !== 'string' || !code) {
    throw new Error(u.status === 403 ? 'Home Assistant is already set up (someone made its owner first), so HyperProx did not make one. Sign in to it, or remove this install and start again.'
      : `Home Assistant would not make the owner account (it answered ${u.status}).`)
  }
  const t = await d.http({ method: 'POST', url: `${base}/auth/token`, form: { grant_type: 'authorization_code', code, client_id: client }, timeoutMs: 30_000 })
  const access = t.status === 200 ? j(t.body)?.access_token : null
  if (typeof access !== 'string' || !access) throw new Error(`The new owner could not sign in (Home Assistant answered ${t.status}).`)
  const auth = { authorization: `Bearer ${access}` }

  // The home's details first, so the onboarding step that follows records what is set.
  const sock = await d.socket(i.ip, access)
  try {
    await sock.call({ type: 'config/core/update', location_name: i.name, time_zone: i.timeZone, unit_system: i.units, language: 'en' })
    const cfg = await d.http({ method: 'GET', url: `${base}/api/config`, headers: auth, timeoutMs: 20_000 })
    const c = j(cfg.body)
    if (c?.location_name !== i.name || c?.time_zone !== i.timeZone) throw new Error('Home Assistant did not keep the home\'s name and time zone: they read back as something else.')
    for (const step of ['core_config', 'analytics']) {
      const r = await d.http({ method: 'POST', url: `${base}/api/onboarding/${step}`, headers: auth, json: {}, timeoutMs: 30_000 })
      if (r.status !== 200) throw new Error(`Home Assistant refused the "${step.replace('_', ' ')}" step of its first-run (it answered ${r.status}).`)
    }
    const integ = await d.http({ method: 'POST', url: `${base}/api/onboarding/integration`, headers: auth, json: { client_id: client, redirect_uri: client }, timeoutMs: 30_000 })
    if (integ.status !== 200) throw new Error(`Home Assistant refused the last step of its first-run (it answered ${integ.status}).`)
    // HyperProx's token: ten years, named for what it is, so it shows in Home Assistant's profile.
    const token = await sock.call({ type: 'auth/long_lived_access_token', client_name: 'HyperProx', lifespan: 3650 })
    if (typeof token !== 'string' || token.length < 20) throw new Error('Home Assistant did not make the access token.')
    // Proof with the token itself, not the sign-in.
    const proof = await d.http({ method: 'GET', url: `${base}/api/`, headers: { authorization: `Bearer ${token}` }, timeoutMs: 20_000 })
    if (proof.status !== 200) throw new Error(`HyperProx's new token was refused when it was used (Home Assistant answered ${proof.status}).`)
    return { accessToken: token }
  } finally { sock.close() }
}

/**
 * A fixed address, through Home Assistant's own network settings (the supervisor's API, over the WebSocket). The machine
 * keeps its DHCP address until this is applied; the caller then waits for it to answer at the new one.
 */
export async function setStaticAddress(sock: HaSocket, o: { address: string; gateway?: string; dns?: string[] }): Promise<void> {
  const info = await sock.call({ type: 'supervisor/api', endpoint: '/network/info', method: 'get' })
  const iface = (info?.interfaces ?? []).find((x: any) => x?.primary && x?.enabled) ?? (info?.interfaces ?? [])[0]
  if (!iface?.interface || !/^[A-Za-z0-9._-]{1,20}$/.test(iface.interface)) throw new Error('Home Assistant did not say which network interface to change.')
  await sock.call({
    type: 'supervisor/api', endpoint: `/network/interface/${iface.interface}/update`, method: 'post',
    data: { ipv4: { method: 'static', address: [o.address], ...(o.gateway ? { gateway: o.gateway } : {}), nameservers: o.dns?.length ? o.dns : o.gateway ? [o.gateway] : [] } },
  }, 30_000)
}

/** The lines Home Assistant needs to trust a reverse proxy. `network` is a CIDR the proxy's address is inside. */
export const trustBlock = (network: string) => `http:\n  use_x_forwarded_for: true\n  trusted_proxies:\n    - ${network}\n`

/** Does the configuration already have an http: section? Then it is not edited (two would break it). */
export const hasHttpSection = (yaml: string) => /^http:/m.test(yaml)

/** Appends HyperProx's block to a configuration.yaml, leaving everything else as it is. */
export function withTrust(yaml: string, network: string): string {
  const body = yaml.endsWith('\n') || !yaml ? yaml : yaml + '\n'
  return `${body}\n# Added by HyperProx so the reverse proxy can forward visitors' addresses.\n${trustBlock(network)}`
}
