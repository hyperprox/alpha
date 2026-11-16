// =============================================================================
//  HyperProx — the package cache: the install's last two steps
//
//  In place of the generic "does a web page answer" check: the helper's
//  self-check, run in the container. It proves apt-cacher-ng runs, listens
//  only on its LAN address, refuses networks that are not allowed, fetches a
//  Debian index through itself, tunnels HTTPS and keeps its admin actions
//  behind the password. A failed check fails the install. Then the plug-in
//  connects it (auto-connect, at once), which also turns Updates' "Use the
//  package cache" on by itself (its default is automatic).
// =============================================================================

import { CHECK_TITLE, parseSelfTest } from './parse'
import { HELPER, PORT, type SelfCheck } from './types'

export const APTCACHE_SETUP_STEPS = [
  { id: 'verify', label: 'Prove it works and is locked down' },
  { id: 'wire',   label: 'Connect its plug-in and Updates' },
]

type Step = { status: string; detail?: string }

export interface AptCacheSetupDeps {
  /** A script in the new container (the installer's pct exec from the node). */
  sh(script: string, timeoutMs: number): Promise<{ code: number; output: string; timedOut?: boolean }>
  /** Auto-connect looks now; resolves with whether this container is connected afterwards. */
  connect(vmid: number): Promise<boolean>
}

export const cacheUrl = (ip: string) => `http://${ip}:${PORT}`

export async function runAptCacheSetup(
  input: { vmid: number; ip: string },
  step: (id: string) => Step,
  d: AptCacheSetupDeps,
): Promise<{ url: string; checks: SelfCheck[] }> {
  const s1 = step('verify')
  s1.status = 'running'
  const r = await d.sh(`${HELPER} selftest`, 3 * 60_000)
  const checks = parseSelfTest(r.output)
  const failed = checks.filter(c => c.state === 'fail')
  if (r.code !== 0 || !checks.length || failed.length) {
    const why = failed.length ? failed.map(c => `${CHECK_TITLE[c.id] ?? c.id}: ${c.detail}`).join(' ') : 'The self-check did not run.'
    throw new Error(`The package cache is installed but did not pass its check, so it is not handed over. ${why}`)
  }
  s1.status = 'done'
  s1.detail = checks.filter(c => c.state === 'ok').map(c => CHECK_TITLE[c.id] ?? c.id).join(' · ')

  const s2 = step('wire')
  s2.status = 'running'
  const ok = await d.connect(input.vmid).catch(() => false)
  s2.status = ok ? 'done' : 'skipped'
  s2.detail = ok
    ? 'Its plug-in is connected, and Updates now points guests at it (with a fallback to going direct).'
    : 'Its plug-in connects it on its next look (within five minutes), or press "Look again now" on its page.'
  return { url: cacheUrl(input.ip), checks }
}
