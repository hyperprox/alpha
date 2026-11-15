// Demo fixtures: POST previews that show what a change would do before anything is applied. Applying is refused.
import type { FixtureRoute } from './types'
import { iso, MIN } from './data'

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

export const PREVIEW_ROUTES: FixtureRoute[] = [
  { path: '/api/ha/preview', post: () => haPreview() },
]
