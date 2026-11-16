// =============================================================================
//  HyperProx — 3proxy: the install's last two steps
//
//  In place of the generic "does a web page answer" check (a proxy that
//  answers is not yet a safe one): the helper's
//  self-check, run in the container with the first user's generated password,
//  proves sign-in is required, a signed-in request works, tunnels go only to
//  443, and the proxy reaches neither itself nor your LAN. A failed check fails
//  the install. Then the plug-in connects it (auto-connect, at once).
// =============================================================================

import { parseSelfTest, CHECK_TITLE } from './parse'
import { selfTestScript } from './service'
import { PROXY_NAME, type SelfCheck } from './types'

export const FWDPROXY_SETUP_STEPS = [
  { id: 'verify', label: 'Prove it is locked down' },
  { id: 'wire',   label: 'Connect its plug-in' },
]

type Step = { status: string; detail?: string }

export interface FwdSetupDeps {
  /** A script in the new container (the installer's pct exec from the node). */
  sh(script: string, timeoutMs: number): Promise<{ code: number; output: string; timedOut?: boolean }>
  /** Auto-connect looks now; resolves with whether this container is connected afterwards. */
  connect(vmid: number): Promise<boolean>
}

/** The address an app or the OS is given for the HTTP side: http://ip:3128. */
export function proxyUrl(ip: string): string {
  return `http://${ip}:3128`
}

export async function runFwdProxySetup(
  input: { vmid: number; ip: string; user: string; password: string },
  step: (id: string) => Step,
  d: FwdSetupDeps,
): Promise<{ url: string; checks: SelfCheck[] }> {
  const s1 = step('verify')
  s1.status = 'running'
  const r = await d.sh(selfTestScript(input.user, input.password), 3 * 60_000)
  const checks = parseSelfTest(r.output)
  const failed = checks.filter(c => c.state === 'fail')
  if (r.code !== 0 || !checks.length || failed.length) {
    const why = failed.length ? failed.map(c => `${CHECK_TITLE[c.id] ?? c.id}: ${c.detail}`).join(' ') : 'The self-check did not run.'
    throw new Error(`${PROXY_NAME} is installed but did not pass its safety check, so it is not handed over. ${why}`)
  }
  s1.status = 'done'
  s1.detail = checks.filter(c => c.state === 'ok').map(c => CHECK_TITLE[c.id] ?? c.id).join(' · ')

  const s2 = step('wire')
  s2.status = 'running'
  const ok = await d.connect(input.vmid).catch(() => false)
  s2.status = ok ? 'done' : 'skipped'
  s2.detail = ok
    ? `The ${PROXY_NAME} plug-in is connected to it.`
    : `The ${PROXY_NAME} plug-in connects it on its next look (within five minutes), or press "Look again now" on its page.`
  return { url: proxyUrl(input.ip), checks }
}
