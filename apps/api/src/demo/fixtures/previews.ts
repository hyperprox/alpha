// Demo fixtures: POST previews that show what a change would do before anything is applied. Applying is refused.
import type { FixtureRoute } from './types'
import { iso, MIN, NODES, GUESTS } from './data'

const ok = (data: unknown) => ({ success: true, data })

/** The HA rule editor's preview: the plan, the effects and the exact calls, as the real dialog shows them. */
function haPreview() {
  return ok({
    id: 'demo-ha-plan', action: 'rule', title: 'Keep plex on pve-c, fall back to pve-b',
    changes: ['Add the rule "plex-home": plex prefers pve-c, then pve-b.'],
    effects: ['plex stays where it is now.', 'If pve-c goes down, plex starts on pve-b within about two minutes.', 'plex will not start on pve-a: it has no GPU plex can use.'],
    warnings: ['pve-b has an Intel GPU: Plex transcodes there with Quick Sync instead of NVENC.'],
    strict: false, critical: [], existing: [],
    calls: ['pvesh create /cluster/ha/rules --type node-affinity --rule plex-home --resources ct:301 --nodes pve-c:5,pve-b:1'],
    expiresAt: iso(-10 * MIN),
  })
}

/** Settings > Naming & addresses reads the cluster's numbering when it opens. */
function namingDetect() {
  const running = GUESTS.filter(g => g.status === 'running')
  return ok({
    verdict: 'mixed', matching: 14, considered: running.length, total: GUESTS.length,
    examples: running.slice(0, 4).map(g => ({ vmid: g.vmid, node: g.node, ip: g.ip })),
    nodes: NODES.map(n => ({ node: n.node, address: n.ip })),
  })
}

export const PREVIEW_ROUTES: FixtureRoute[] = [
  { path: '/api/catalogue/wizard/naming/detect', post: () => namingDetect() },
  { path: '/api/ha/preview', post: () => haPreview() },
]
